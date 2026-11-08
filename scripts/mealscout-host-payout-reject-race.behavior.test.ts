import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Behavior test for the host-payout REJECT-vs-PAY race fix in
// server/routes/hostPayoutAdminRoutes.ts (PATCH
// /api/admin/host-payout-requests/:requestId).
//
// The bug (pre-fix): the pay side was hardened — mark-paid claims the row
// approved -> processing with a conditional update, sends the Stripe
// transfer while processing, and finalizes gated on status='processing'.
// But the approve/reject/cancel write at the end of the same handler was a
// BLIND update (WHERE id only) that also wrote paidAt back from the
// handler's stale read. A reject that read the row as "approved" could
// therefore land AFTER mark-paid claimed (or even finalized) the row:
// money sent, row ends "rejected", paidAt overwritten back to null.
//
// The fix makes that final write a guarded conditional update — it may
// only land from the source states the action is allowed to leave
// (approved <- pending; rejected/cancelled <- pending|approved) — answers
// 409 when it matches 0 rows, and refuses reject/cancel outright when a
// Stripe transfer id is already recorded on the request. This mirrors the
// affiliate payout rejection in server/routes/admin/affiliateAdminRoutes.ts.
//
// Harness pattern (same as scripts/mealscout-host-payout-execution
// .behavior.test.ts): the REAL executeHostPayout from
// server/hostPayoutExecutionService drives the pay side against a fake
// store whose claim/finalize implement exactly the conditional semantics
// of the drizzle-backed store in hostPayoutAdminRoutes (claim only from
// "approved"; finalize only from "processing", writing paidAt + the
// ledger row in the same step). The admin reject/approve side is modelled
// by stagedAdminUpdate below, which reproduces the staged route's logic
// step for step: read-time transfer-id refusal, then ONE atomic
// conditional update evaluated against the row's CURRENT state (not the
// handler's stale snapshot). Structural assertions at the end pin the
// staged route source to that model, so the model cannot silently drift
// from the code it stands in for. A control scenario runs the same race
// through the pre-fix BLIND update and asserts the corruption signature,
// proving the harness detects the original bug.

import {
  appendHostPayoutTransferRef,
  executeHostPayout,
  extractHostPayoutTransferId,
  type HostPayoutExecutionRow,
  type HostPayoutStore,
  type HostPayoutTransferClient,
} from "../server/hostPayoutExecutionService";

// ---------------------------------------------------------------------------
// Fakes and the staged-route model
// ---------------------------------------------------------------------------

type Row = HostPayoutExecutionRow & { paidAt: Date | null };

type LedgerRow = { amountCents: number; transferId: string | null };

const baseRow: Row = {
  id: "payout-1",
  hostId: "host-1",
  userId: "user-1",
  amountCents: 5000,
  status: "approved",
  notes: null,
  paidAt: null,
};

// The store adapters from hostPayoutAdminRoutes, with their conditional
// semantics: claim lands only from "approved"; finalize lands only from
// "processing" and writes the negative payout ledger row in the same step.
class RouteStore implements HostPayoutStore {
  row: Row;
  ledger: LedgerRow[] = [];

  constructor(row: Row) {
    this.row = row;
  }

  async claimProcessing(input: {
    requestId: string;
    adminUserId: string;
    notes: string | null;
  }) {
    if (this.row.id !== input.requestId) return null;
    if (this.row.status !== "approved") return null;
    this.row.status = "processing";
    this.row.notes = input.notes;
    return { ...this.row };
  }

  async finalizePaid(input: {
    requestId: string;
    hostId: string;
    amountCents: number;
    transferId: string | null;
    manual: boolean;
    description: string;
    notes: string | null;
    paidAt: Date;
    adminUserId: string;
  }) {
    if (this.row.id !== input.requestId) return null;
    if (this.row.status !== "processing") return null;
    this.row.status = "paid";
    this.row.paidAt = input.paidAt;
    this.row.notes = input.notes;
    this.ledger.push({
      amountCents: -Math.abs(input.amountCents),
      transferId: input.transferId,
    });
    return { ...this.row };
  }
}

// A transfer client whose transfer stays in flight until the test
// completes it — this is what lets a reject be issued mid-payment.
class DeferredTransfers implements HostPayoutTransferClient {
  calls = 0;
  private startedResolve!: () => void;
  started: Promise<void>;
  private completeResolve!: (value: { id: string }) => void;
  private transferPromise: Promise<{ id: string }>;

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.startedResolve = resolve;
    });
    this.transferPromise = new Promise<{ id: string }>((resolve) => {
      this.completeResolve = resolve;
    });
  }

  async createTransfer() {
    this.calls += 1;
    this.startedResolve();
    return this.transferPromise;
  }

  complete(id: string) {
    this.completeResolve({ id });
  }
}

type AdminUpdateResult =
  | { http: 200; outcome: "landed" }
  | { http: 409; outcome: "conflict" }
  | { http: 409; outcome: "refused_transfer"; transferId: string };

// The staged handler's non-paid status write, step for step:
//  1. reject/cancel refuse when a Stripe transfer id is already recorded
//     on the request (checked against what the handler read);
//  2. the write itself is ONE conditional update: it lands only while the
//     row's CURRENT status is in the action's allowed source states
//     (approved <- pending; rejected/cancelled <- pending|approved) and
//     otherwise matches 0 rows -> the handler answers 409;
//  3. a landed write sets status and writes paidAt back from the
//     handler's snapshot — safe now, because a row still in an allowed
//     source state has never been finalized (paidAt is still null).
function stagedAdminUpdate(
  row: Row,
  snapshot: Row,
  nextStatus: "approved" | "rejected" | "cancelled",
): AdminUpdateResult {
  if (nextStatus === "rejected" || nextStatus === "cancelled") {
    const recordedTransferId = extractHostPayoutTransferId(snapshot.notes);
    if (recordedTransferId) {
      return { http: 409, outcome: "refused_transfer", transferId: recordedTransferId };
    }
  }
  const allowedSourceStatuses =
    nextStatus === "approved" ? ["pending"] : ["pending", "approved"];
  if (!allowedSourceStatuses.includes(row.status)) {
    return { http: 409, outcome: "conflict" };
  }
  row.status = nextStatus;
  row.paidAt = snapshot.paidAt;
  row.notes = snapshot.notes;
  return { http: 200, outcome: "landed" };
}

// The pre-fix write, for the control scenario: unconditional — it lands
// whatever the row's current state is, and writes paidAt back from the
// stale snapshot.
function blindAdminUpdate(
  row: Row,
  snapshot: Row,
  nextStatus: "approved" | "rejected" | "cancelled",
): AdminUpdateResult {
  row.status = nextStatus;
  row.paidAt = snapshot.paidAt;
  row.notes = snapshot.notes;
  return { http: 200, outcome: "landed" };
}

const stripeDestination = {
  stripeConnectAccountId: "acct_host_1",
  stripePayoutsEnabled: true,
};

function payInput(row: Row) {
  return {
    request: { ...row },
    destination: stripeDestination,
    stripeConfigured: true,
    adminUserId: "admin-1",
    notes: row.notes,
    manualPayoutConfirmed: false,
  } as any;
}

// ---------------------------------------------------------------------------
// 1. THE RACE (staged code): reject reads "approved"; mark-paid claims the
//    row to "processing" and its transfer goes in flight; the reject's
//    guarded update now matches 0 rows -> 409, the row stays "processing",
//    and when the transfer completes the finalize lands: "paid", paidAt
//    intact, exactly one transfer, exactly one ledger row. A second stale
//    reject after payment is likewise refused and overwrites nothing.
// ---------------------------------------------------------------------------
{
  const row: Row = { ...baseRow };
  const store = new RouteStore(row);
  const transfers = new DeferredTransfers();

  // The reject handler's read — taken BEFORE mark-paid runs.
  const rejectSnapshot: Row = { ...row };

  const payPromise = executeHostPayout(store, transfers, payInput(row));
  await transfers.started; // claim landed, transfer in flight
  assert.equal(row.status, "processing");

  const rejected = stagedAdminUpdate(row, rejectSnapshot, "rejected");
  assert.equal(rejected.http, 409);
  assert.equal(rejected.outcome, "conflict");
  assert.equal(row.status, "processing"); // untouched by the reject
  assert.equal(row.paidAt, null); // not yet paid, not corrupted

  transfers.complete("tr_race1");
  const paid = await payPromise;
  assert.equal(paid.outcome, "paid");
  assert.equal(row.status, "paid");
  assert.ok(row.paidAt instanceof Date); // paidAt intact
  assert.equal(transfers.calls, 1);
  assert.equal(store.ledger.length, 1);
  assert.equal(store.ledger[0].transferId, "tr_race1");
  const paidAtAfterPayment = row.paidAt;

  // The same stale reject retried after payment: still refused, and the
  // paid row — status and paidAt — is exactly as the payment left it.
  const rejectedAfterPaid = stagedAdminUpdate(row, rejectSnapshot, "rejected");
  assert.equal(rejectedAfterPaid.http, 409);
  assert.equal(row.status, "paid");
  assert.equal(row.paidAt, paidAtAfterPayment);
  assert.equal(store.ledger.length, 1);
}

// ---------------------------------------------------------------------------
// 2. Reject on "approved" (not yet claimed) lands — and a later mark-paid
//    refuses: the execution claim (approved-only) cannot take a rejected
//    row, no transfer is sent, no ledger row is written.
// ---------------------------------------------------------------------------
{
  const row: Row = { ...baseRow };
  const store = new RouteStore(row);
  const transfers = new DeferredTransfers();

  const rejected = stagedAdminUpdate(row, { ...row }, "rejected");
  assert.equal(rejected.http, 200);
  assert.equal(rejected.outcome, "landed");
  assert.equal(row.status, "rejected");

  const paid = await executeHostPayout(store, transfers, payInput(row));
  assert.equal(paid.outcome, "claim_conflict");
  assert.equal(transfers.calls, 0);
  assert.equal(store.ledger.length, 0);
  assert.equal(row.status, "rejected");
  assert.equal(row.paidAt, null);
}

// ---------------------------------------------------------------------------
// 3. A request with a Stripe transfer id already recorded in its notes
//    cannot be rejected or cancelled at all (the affiliate rule): the
//    money was already sent, so restoring the amount to the host's
//    requestable balance would pay the host twice.
// ---------------------------------------------------------------------------
{
  const recordedNotes = appendHostPayoutTransferRef("reviewed", "tr_recorded9");
  const row: Row = { ...baseRow, notes: recordedNotes };

  const rejected = stagedAdminUpdate(row, { ...row }, "rejected");
  assert.equal(rejected.http, 409);
  assert.equal(rejected.outcome, "refused_transfer");
  assert.equal(
    rejected.outcome === "refused_transfer" ? rejected.transferId : null,
    "tr_recorded9",
  );
  assert.equal(row.status, "approved");
  assert.equal(row.notes, recordedNotes);
  assert.equal(row.paidAt, null);

  const cancelled = stagedAdminUpdate(row, { ...row }, "cancelled");
  assert.equal(cancelled.http, 409);
  assert.equal(cancelled.outcome, "refused_transfer");
  assert.equal(row.status, "approved");
}

// ---------------------------------------------------------------------------
// 4. Approve shares the same guarded write: it lands only from "pending".
//    An approve carrying a stale "pending" snapshot loses to a reject that
//    landed first, and an approve of an already-approved row conflicts.
// ---------------------------------------------------------------------------
{
  const row: Row = { ...baseRow, status: "pending" };
  const approveSnapshot: Row = { ...row };

  const rejected = stagedAdminUpdate(row, { ...row }, "rejected");
  assert.equal(rejected.outcome, "landed");
  assert.equal(row.status, "rejected");

  const approved = stagedAdminUpdate(row, approveSnapshot, "approved");
  assert.equal(approved.http, 409);
  assert.equal(approved.outcome, "conflict");
  assert.equal(row.status, "rejected");

  const row2: Row = { ...baseRow, status: "pending" };
  const approved2 = stagedAdminUpdate(row2, { ...row2 }, "approved");
  assert.equal(approved2.outcome, "landed");
  assert.equal(row2.status, "approved");

  const approved3 = stagedAdminUpdate(row2, { ...row2 }, "approved");
  assert.equal(approved3.http, 409);
  assert.equal(row2.status, "approved");

  // Cancel from "approved" still lands when nothing else has moved.
  const row3: Row = { ...baseRow };
  const cancelled = stagedAdminUpdate(row3, { ...row3 }, "cancelled");
  assert.equal(cancelled.outcome, "landed");
  assert.equal(row3.status, "cancelled");
}

// ---------------------------------------------------------------------------
// 5. CONTROL — the same race through the pre-fix BLIND write corrupts the
//    row, exactly as the original finding described: the reject lands on
//    top of the claimed row, the transfer still completes (money sent),
//    but the gated finalize can no longer land — the row ends "rejected"
//    with paidAt null and no ledger row, while a real transfer is out.
//    (If this scenario ever stops corrupting, the harness above is no
//    longer capable of detecting the bug it guards.)
// ---------------------------------------------------------------------------
{
  const row: Row = { ...baseRow };
  const store = new RouteStore(row);
  const transfers = new DeferredTransfers();
  const rejectSnapshot: Row = { ...row };

  const payPromise = executeHostPayout(store, transfers, payInput(row));
  await transfers.started;
  assert.equal(row.status, "processing");

  const rejected = blindAdminUpdate(row, rejectSnapshot, "rejected");
  assert.equal(rejected.outcome, "landed");
  assert.equal(row.status, "rejected");

  transfers.complete("tr_control1");
  const paid = await payPromise;
  assert.equal(paid.outcome, "finalize_conflict"); // money sent, row lost
  assert.equal(transfers.calls, 1);
  assert.equal(row.status, "rejected");
  assert.equal(row.paidAt, null);
  assert.equal(store.ledger.length, 0);
}

// ---------------------------------------------------------------------------
// 6. Structural pins: the staged route source must actually contain the
//    logic modelled above — and must keep the snippets pinned by
//    scripts/mealscout-payment-webhook-safety-map.contract.test.ts.
// ---------------------------------------------------------------------------
{
  const routeSource = readFileSync(
    new URL("../server/routes/hostPayoutAdminRoutes.ts", import.meta.url),
    "utf8",
  );

  // Pins from the payment/webhook safety-map contract test for this file.
  for (const pin of [
    '"/api/admin/host-payout-requests"',
    '"/api/admin/host-payout-requests/:requestId"',
    "stripe.transfers.create",
    "isAdmin",
  ]) {
    assert.ok(routeSource.includes(pin), `contract pin missing: ${pin}`);
  }

  // The blind write is gone: no update in this file may be keyed on the
  // request id alone.
  assert.ok(
    !/\.where\(eq\(hostPayoutRequests\.id, requestId\)\)\s*\.returning\(\)/.test(
      routeSource,
    ),
    "blind id-only update still present",
  );
  // Sensitivity control: that same pattern DOES match the pre-fix shape.
  assert.ok(
    /\.where\(eq\(hostPayoutRequests\.id, requestId\)\)\s*\.returning\(\)/.test(
      ".where(eq(hostPayoutRequests.id, requestId))\n          .returning()",
    ),
    "blind-write detector is vacuous",
  );

  // The guarded write: allowed source states per action, evaluated in the
  // update's own WHERE clause, with a 409 when nothing matched.
  const guardStart = routeSource.indexOf("const allowedSourceStatuses");
  assert.ok(guardStart >= 0, "allowedSourceStatuses missing");
  const guardBlock = routeSource.slice(guardStart, guardStart + 2200);
  assert.ok(
    guardBlock.includes(
      'nextStatus === "approved" ? ["pending"] : ["pending", "approved"]',
    ),
    "allowed source states changed",
  );
  assert.ok(
    guardBlock.includes("inArray(hostPayoutRequests.status, allowedSourceStatuses)"),
    "conditional status predicate missing from the update",
  );
  assert.ok(guardBlock.includes("if (!updated)"), "0-row handling missing");
  assert.ok(guardBlock.includes("409"), "0-row path must answer 409");

  // The transfer-id refusal for reject/cancel, using the execution
  // service's own extractor, ahead of the paid branch.
  const refusalAt = routeSource.indexOf("extractHostPayoutTransferId(");
  const paidBranchAt = routeSource.indexOf('if (nextStatus === "paid")');
  assert.ok(refusalAt >= 0, "transfer-id refusal missing");
  assert.ok(paidBranchAt >= 0 && refusalAt < paidBranchAt);
  assert.ok(
    routeSource.includes(
      'nextStatus === "rejected" || nextStatus === "cancelled"',
    ),
    "transfer-id refusal must cover reject and cancel",
  );
}

console.log("mealscout-host-payout-reject-race.behavior: PASS");
