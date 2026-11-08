import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "./db";
import {
  eventBookings,
  hostEarningsLedger,
  hostPayoutRequests,
} from "@shared/schema";

// Available-balance formula. Payouts are carried by the LEDGER: a paid
// payout writes exactly one negative `payout` row into hostEarningsLedger
// (inside accruedCents) in the same transaction that marks the request
// paid. Requests in flight (pending / approved / processing) are reserved
// through pendingPayoutCents. paidOutCents is computed and returned for
// display only and must NOT be subtracted here — subtracting it as well
// counted every payout twice (once via its ledger row, once via the paid
// request sum), permanently understating every host's available balance
// by the total of everything they had ever been paid.
//
// Existing data needs no migration for this correction: every historical
// paid payout already has its negative ledger row (the old mark-paid path
// always inserted one), so counting the ledger alone counts each of them
// exactly once.
//
// Destination-charge guard (gaps map entry 9): when a host was Connect-ready
// at booking time, Stripe already moved the host's share into the host's own
// Stripe balance at charge time (transfer_data.destination on the booking).
// Settlement still writes the `booking_earned` ledger row for those bookings
// — it is the earnings RECORD — but that money is not payable a second time
// through a payout request. getHostEarningsSummary therefore computes
// destinationSettledCents (booking_earned rows whose booking carries a
// transfer destination) and excludes it from the amount a new payout request
// may draw on. accruedCents stays the gross record; only availability is
// guarded. Because the exclusion is computed from the ledger + bookings at
// read time, it applies to every historical row and every settlement writer
// with no migration and no write-path change.
export function computeHostAvailableCents(
  accruedCents: number,
  pendingPayoutCents: number,
) {
  return Math.max(0, accruedCents - pendingPayoutCents);
}

// Accepts an optional transaction client so callers that need an atomic
// read-check-write (e.g. validating a payout request against the balance
// before inserting it) can run this inside the same locked transaction
// instead of a separate connection that wouldn't see uncommitted rows or
// be serialized by the caller's advisory lock.
export async function getHostEarningsSummary(hostId: string, dbClient: any = db) {
  const [earnedRow] = await dbClient
    .select({
      total: sql<number>`coalesce(sum(${hostEarningsLedger.amountCents}), 0)`,
    })
    .from(hostEarningsLedger)
    .where(eq(hostEarningsLedger.hostId, hostId));

  // Earnings Stripe already paid the host directly at charge time, via the
  // booking's destination charge. These booking_earned rows are the record
  // of that money, never a second payable balance (see header note).
  const [destinationRow] = await dbClient
    .select({
      total: sql<number>`coalesce(sum(${hostEarningsLedger.amountCents}), 0)`,
    })
    .from(hostEarningsLedger)
    .innerJoin(
      eventBookings,
      eq(hostEarningsLedger.bookingId, eventBookings.id),
    )
    .where(
      and(
        eq(hostEarningsLedger.hostId, hostId),
        eq(hostEarningsLedger.entryType, "booking_earned"),
        isNotNull(eventBookings.stripeTransferDestination),
      ),
    );

  const [pendingRow] = await dbClient
    .select({
      total: sql<number>`coalesce(sum(${hostPayoutRequests.amountCents}), 0)`,
    })
    .from(hostPayoutRequests)
    .where(
      and(
        eq(hostPayoutRequests.hostId, hostId),
        // "processing" stays reserved: the payout's money may be moving,
        // so it must not free up for a new request until it resolves.
        inArray(hostPayoutRequests.status, [
          "pending",
          "approved",
          "processing",
        ]),
      ),
    );

  const [paidRow] = await dbClient
    .select({
      total: sql<number>`coalesce(sum(${hostPayoutRequests.amountCents}), 0)`,
    })
    .from(hostPayoutRequests)
    .where(
      and(
        eq(hostPayoutRequests.hostId, hostId),
        eq(hostPayoutRequests.status, "paid"),
      ),
    );

  const [latestEarning] = await dbClient
    .select({ createdAt: hostEarningsLedger.createdAt })
    .from(hostEarningsLedger)
    .where(eq(hostEarningsLedger.hostId, hostId))
    .orderBy(sql`${hostEarningsLedger.createdAt} desc`)
    .limit(1);

  const accruedCents = Number(earnedRow?.total || 0);
  const destinationSettledCents = Number(destinationRow?.total || 0);
  const pendingPayoutCents = Number(pendingRow?.total || 0);
  // Display figure only — payouts are already subtracted inside
  // accruedCents via their ledger rows. See computeHostAvailableCents.
  const paidOutCents = Number(paidRow?.total || 0);
  // Availability is checked against earnings the platform still holds:
  // gross accrual minus what Stripe already settled to the host directly.
  const availableCents = computeHostAvailableCents(
    accruedCents - destinationSettledCents,
    pendingPayoutCents,
  );

  return {
    accruedCents,
    destinationSettledCents,
    pendingPayoutCents,
    paidOutCents,
    availableCents,
    lastEarningAt: latestEarning?.createdAt || null,
  };
}

export async function recordHostBookingEarnings(
  entries: Array<{
    hostId: string;
    bookingId: string;
    stripePaymentIntentId?: string | null;
    amountCents: number;
    description?: string;
  }>,
) {
  if (!entries.length) return;

  const rows = entries
    .filter((entry) => entry.hostId && entry.bookingId && entry.amountCents > 0)
    .map((entry) => ({
      hostId: entry.hostId,
      bookingId: entry.bookingId,
      stripePaymentIntentId: entry.stripePaymentIntentId || null,
      entryType: "booking_earned",
      sourceType: "parking_pass_booking",
      amountCents: Math.floor(entry.amountCents),
      description: entry.description || "Parking pass booking earnings",
    }));

  if (!rows.length) return;

  await db
    .insert(hostEarningsLedger)
    .values(rows)
    // Migration 074 installs this guarantee as a partial unique index
    // (booking_id IS NOT NULL). PostgreSQL cannot infer that index from a
    // bare column conflict target, so use target-free DO NOTHING and let the
    // database enforce every applicable unique constraint.
    .onConflictDoNothing();
}
