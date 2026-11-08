import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableColumns } from "drizzle-orm";
import {
  eventBookings,
  hostEarningsLedger,
  hostPayoutRequests,
} from "../shared/schema";

// Behavior test for the parking-host DOUBLE-PAY guard (ecosystem gaps map
// entry 9; money-path map Alert 2).
//
// The gap: when a host is Connect-ready at booking time, the booking pays
// the host by destination charge — Stripe moves the host's share into the
// host's own Stripe balance at charge time. Settlement ALSO writes a
// `booking_earned` row into hostEarningsLedger, and the available-balance
// formula counted every such row as requestable. A payout request could
// therefore draw the same money a second time, and an admin mark-paid
// would transfer it again.
//
// The staged reject-vs-pay race fix (entry 10) does NOT close this: it
// guards the admin write path, but the money should never have been
// requestable in the first place.
//
// The guard: getHostEarningsSummary — the single summary every payout
// decision reads (host payout-request creation validates against it inside
// an advisory-locked transaction; admin responses report it) — now computes
// destinationSettledCents: booking_earned rows whose booking carries a
// stripeTransferDestination. Availability is checked against
// accrued - destinationSettled - pendingRequests, so destination-charge
// money can never be requested, while platform-hold earnings stay payable
// and accruedCents keeps reporting the gross record.
//
// The control scenario runs the PRE-FIX availability formula
// (computeHostAvailableCents over the gross accrual) on the same fixtures
// and shows the destination money WAS requestable — proving this harness
// detects the original gap.

process.env.NODE_ENV = "development";
delete process.env.DATABASE_URL;

const { getHostEarningsSummary, computeHostAvailableCents } = await import(
  "../server/hostEarningsService"
);

const engine = new PGlite();
for (const [name, table] of Object.entries({
  event_bookings: eventBookings,
  host_earnings_ledger: hostEarningsLedger,
  host_payout_requests: hostPayoutRequests,
})) {
  const columns = Object.values(getTableColumns(table as any));
  await engine.exec(
    `create table ${name} (${columns
      .map(
        (c) =>
          `"${c.name}" ${
            /^(varchar|text|boolean|timestamp|integer|numeric|json|serial|double|real|bigint)/.test(
              c.getSQLType(),
            )
              ? c.getSQLType()
              : "text"
          } ${c.name === "id" ? "primary key default gen_random_uuid()" : ""}`,
      )
      .join(",")})`,
  );
}
const database = drizzle(engine);

const HOST = "host-1";
const OTHER_HOST = "host-2";

// Bookings: one paid by destination charge (host was Connect-ready), one
// platform-hold (host not ready; platform still holds the money).
await engine.query(
  `insert into event_bookings (id, stripe_transfer_destination) values ($1, $2), ($3, $4)`,
  ["booking-dest", "acct_host1", "booking-hold", null],
);
// Earnings rows exactly as settlement writes them: one per booking.
await engine.query(
  `insert into host_earnings_ledger (host_id, booking_id, stripe_payment_intent_id, entry_type, source_type, amount_cents, description)
   values ($1, $2, 'pi_dest', 'booking_earned', 'parking_pass_booking', 5000, 'Parking pass booking earnings'),
          ($1, $3, 'pi_hold', 'booking_earned', 'parking_pass_booking', 3000, 'Parking pass booking earnings')`,
  [HOST, "booking-dest", "booking-hold"],
);

// -- Scenario 1: destination money is recorded but NOT requestable ---------
const s1 = await getHostEarningsSummary(HOST, database);
assert.equal(s1.accruedCents, 8000, "gross record keeps both earnings");
assert.equal(
  s1.destinationSettledCents,
  5000,
  "destination-charge earnings are identified",
);
assert.equal(
  s1.availableCents,
  3000,
  "only the platform-hold share is requestable",
);

// Control: the pre-fix formula over the same fixtures makes the full 8000
// requestable — the destination 5000 could be paid a second time.
const preFixAvailable = computeHostAvailableCents(s1.accruedCents, 0);
assert.equal(preFixAvailable, 8000, "control: pre-fix math exposes 8000");
assert.notEqual(
  preFixAvailable,
  s1.availableCents,
  "the guard changes the outcome on identical fixtures",
);

// -- Scenario 2: an in-flight request reserves against the guarded balance -
await engine.query(
  `insert into host_payout_requests (host_id, user_id, amount_cents, status) values ($1, 'user-1', 2000, 'pending')`,
  [HOST],
);
const s2 = await getHostEarningsSummary(HOST, database);
assert.equal(s2.pendingPayoutCents, 2000);
assert.equal(s2.availableCents, 1000, "3000 held - 2000 reserved = 1000");

// -- Scenario 3: a completed platform-hold payout nets through the ledger --
await engine.query(
  `insert into host_earnings_ledger (host_id, booking_id, entry_type, source_type, amount_cents, description)
   values ($1, null, 'payout', 'host_payout', -3000, 'Host payout')`,
  [HOST],
);
const s3 = await getHostEarningsSummary(HOST, database);
assert.equal(s3.accruedCents, 5000, "payout row nets inside the accrual");
assert.equal(
  s3.availableCents,
  0,
  "5000 accrued - 5000 destination - 2000 reserved floors at 0",
);

// -- Scenario 4: unproven rows stay payable --------------------------------
// A booking_earned row whose booking is gone (booking_id set null on delete)
// cannot be proven destination-paid, so it must remain requestable.
await engine.query(
  `insert into host_earnings_ledger (host_id, booking_id, entry_type, source_type, amount_cents, description)
   values ($1, null, 'booking_earned', 'parking_pass_booking', 4000, 'Parking pass booking earnings')`,
  [OTHER_HOST],
);
const s4 = await getHostEarningsSummary(OTHER_HOST, database);
assert.equal(s4.destinationSettledCents, 0);
assert.equal(
  s4.availableCents,
  4000,
  "rows without a destination-carrying booking stay payable",
);

// -- Structural pins: the guard cannot silently drift from the payout path --
const serviceSource = readFileSync(
  new URL("../server/hostEarningsService.ts", import.meta.url),
  "utf8",
);
assert.match(serviceSource, /isNotNull\(eventBookings\.stripeTransferDestination\)/);
assert.match(serviceSource, /eq\(hostEarningsLedger\.entryType, "booking_earned"\)/);
assert.match(
  serviceSource,
  /computeHostAvailableCents\(\s*accruedCents - destinationSettledCents,/,
);
const hostRoutesSource = readFileSync(
  new URL("../server/routes/hostRoutes.ts", import.meta.url),
  "utf8",
);
assert.match(
  hostRoutesSource,
  /requestedAmountCents > summary\.availableCents/,
  "payout-request creation still validates against the guarded summary",
);

await engine.close();
console.log("mealscout-host-earnings-destination-guard: PASS");
