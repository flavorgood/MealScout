import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { hostEarningsLedger, hostPayoutRequests } from "@shared/schema";

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
  const pendingPayoutCents = Number(pendingRow?.total || 0);
  // Display figure only — payouts are already subtracted inside
  // accruedCents via their ledger rows. See computeHostAvailableCents.
  const paidOutCents = Number(paidRow?.total || 0);
  const availableCents = computeHostAvailableCents(
    accruedCents,
    pendingPayoutCents,
  );

  return {
    accruedCents,
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
