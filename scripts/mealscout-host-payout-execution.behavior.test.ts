import assert from "node:assert/strict";

// hostEarningsService imports server/db, which refuses to load without a
// DATABASE_URL outside development. Only its pure formula helper is used
// here, so load it in development mode and never call the DB-backed path.
process.env.NODE_ENV = process.env.NODE_ENV || "development";

import {
  executeHostPayout,
  extractHostPayoutTransferId,
  hostPayoutIdempotencyKey,
  type HostPayoutExecutionRow,
  type HostPayoutStore,
  type HostPayoutTransferClient,
} from "../server/hostPayoutExecutionService";

const { computeHostAvailableCents } = await import(
  "../server/hostEarningsService"
);

// ---------------------------------------------------------------------------
// Fakes. The store implements the same conditional semantics as the real
// drizzle-backed store in hostPayoutAdminRoutes: the claim lands only from
// "approved", finalize lands only from "processing" and writes the ledger
// row in the same step.
// ---------------------------------------------------------------------------

type LedgerRow = {
  amountCents: number;
  transferId: string | null;
  description: string;
};

class FakeStore implements HostPayoutStore {
  row: HostPayoutExecutionRow;
  ledger: LedgerRow[] = [];
  failNextFinalize = false;

  constructor(row: HostPayoutExecutionRow) {
    this.row = { ...row };
  }

  async claimProcessing(input: {
    requestId: string;
    adminUserId: string;
    notes: string | null;
  }) {
    if (this.row.id !== input.requestId) return null;
    if (this.row.status !== "approved") return null;
    this.row = { ...this.row, status: "processing", notes: input.notes };
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
    if (this.failNextFinalize) {
      this.failNextFinalize = false;
      throw new Error("simulated finalize crash");
    }
    if (this.row.id !== input.requestId) return null;
    if (this.row.status !== "processing") return null;
    this.row = { ...this.row, status: "paid", notes: input.notes };
    this.ledger.push({
      amountCents: -Math.abs(input.amountCents),
      transferId: input.transferId,
      description: input.description,
    });
    return { ...this.row };
  }
}

class FakeTransfers implements HostPayoutTransferClient {
  calls = 0;
  findCalls = 0;
  failAll = false;
  failFind = false;
  private byKey = new Map<string, string>();
  private seq = 0;

  async createTransfer(
    _request: {
      amountCents: number;
      destination: string;
      description: string;
      metadata: Record<string, string>;
    },
    idempotencyKey: string,
  ) {
    this.calls += 1;
    if (this.failAll) {
      throw new Error("connected account is temporarily unavailable");
    }
    // Stripe replays the original transfer for a repeated idempotency key.
    const existing = this.byKey.get(idempotencyKey);
    if (existing) return { id: existing };
    const id = `tr_${++this.seq}`;
    this.byKey.set(idempotencyKey, id);
    return { id };
  }

  async verifyRecordedTransfer(id: string) {
    if (id !== "tr_recorded") throw new Error("unknown transfer");
    return { id };
  }

  async findTransferByPayoutRequestId(requestId: string) {
    this.findCalls += 1;
    if (this.failFind) {
      throw new Error("stripe search unavailable");
    }
    // The fake keys transfers by idempotency key (host_payout_<requestId>),
    // which is the same one-to-one identity the real metadata search uses.
    const existing = this.byKey.get(`host_payout_${requestId}`);
    return existing ? { id: existing } : null;
  }

  get uniqueTransfers() {
    return this.byKey.size;
  }
}

const baseRequest: HostPayoutExecutionRow = {
  id: "payout-1",
  hostId: "host-1",
  userId: "user-1",
  amountCents: 3000,
  status: "approved",
  notes: null,
};

const stripeDestination = {
  stripeConnectAccountId: "acct_host_1",
  stripePayoutsEnabled: true,
};

const noDestination = {
  stripeConnectAccountId: null,
  stripePayoutsEnabled: null,
};

function execInput(
  store: FakeStore,
  overrides: Record<string, unknown> = {},
) {
  return {
    request: { ...store.row },
    destination: stripeDestination,
    stripeConfigured: true,
    adminUserId: "admin-1",
    notes: store.row.notes,
    manualPayoutConfirmed: false,
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// 1. Transfer failure: NOT paid, NO ledger row, error outcome, row stays
//    processing (retryable) — never silently "paid".
// ---------------------------------------------------------------------------
{
  const store = new FakeStore(baseRequest);
  const transfers = new FakeTransfers();
  transfers.failAll = true;

  const result = await executeHostPayout(
    store,
    transfers,
    execInput(store),
  );

  assert.equal(result.outcome, "transfer_failed");
  assert.equal(store.row.status, "processing");
  assert.equal(store.ledger.length, 0);
  assert.equal(transfers.calls, 1);
}

// ---------------------------------------------------------------------------
// 2. Double execution: two mark-paid calls racing on the same approved
//    request. Exactly one wins the claim and sends exactly one transfer;
//    the other gets the claim conflict and sends nothing.
// ---------------------------------------------------------------------------
{
  const store = new FakeStore(baseRequest);
  const transfers = new FakeTransfers();

  // Both calls read the request as "approved" before either claims —
  // the real race between two simultaneous mark-paid PATCHes, each of
  // which loaded the row at the start of its handler.
  const inputA = execInput(store);
  const inputB = execInput(store);
  const [first, second] = await Promise.all([
    executeHostPayout(store, transfers, inputA),
    executeHostPayout(store, transfers, inputB),
  ]);

  const outcomes = [first.outcome, second.outcome].sort();
  assert.deepEqual(outcomes, ["claim_conflict", "paid"]);
  assert.equal(transfers.calls, 1);
  assert.equal(transfers.uniqueTransfers, 1);
  assert.equal(store.ledger.length, 1);
  assert.equal(store.row.status, "paid");
}

// ---------------------------------------------------------------------------
// 3. Crash between transfer and finalize, then retry: the retry does NOT
//    re-send. It reconciles against Stripe by the payout's metadata and
//    finalizes from the transfer the first attempt already created —
//    one real transfer, one ledger row, paid once. (Stripe prunes
//    idempotency keys after 24 hours, so replay-by-key alone cannot be
//    the guard for a late retry.)
// ---------------------------------------------------------------------------
{
  const store = new FakeStore(baseRequest);
  const transfers = new FakeTransfers();
  store.failNextFinalize = true;

  await assert.rejects(
    executeHostPayout(store, transfers, execInput(store)),
    /simulated finalize crash/,
  );
  assert.equal(store.row.status, "processing");
  assert.equal(store.ledger.length, 0);
  assert.equal(transfers.uniqueTransfers, 1);

  const retry = await executeHostPayout(
    store,
    transfers,
    execInput(store), // fresh read: row is now "processing"
  );
  assert.equal(retry.outcome, "paid");
  assert.equal(transfers.findCalls, 1);
  assert.equal(transfers.calls, 1); // reconciled — no second send
  assert.equal(transfers.uniqueTransfers, 1);
  assert.equal(store.ledger.length, 1);
  assert.equal(
    extractHostPayoutTransferId(store.row.notes),
    retry.outcome === "paid" ? retry.transferId : null,
  );
  assert.equal(
    hostPayoutIdempotencyKey(baseRequest.id),
    "host_payout_payout-1",
  );
}

// ---------------------------------------------------------------------------
// 3b. Processing retry where Stripe has NO transfer for the payout (the
//     earlier attempt failed before creating one): the uncertain retry stays held; absence is not proof of failure.
// ---------------------------------------------------------------------------
{
  const store = new FakeStore({ ...baseRequest, status: "processing" });
  const transfers = new FakeTransfers();

  const result = await executeHostPayout(
    store,
    transfers,
    execInput(store),
  );
  assert.equal(result.outcome, "transfer_failed");
  assert.equal(transfers.findCalls, 1);
  assert.equal(transfers.calls, 0);
  assert.equal(transfers.uniqueTransfers, 0);
  assert.equal(store.ledger.length, 0);
}

// ---------------------------------------------------------------------------
// 3c. Processing retry where the reconciliation search itself fails:
//     refuse with transfer_failed and send NOTHING — never re-send blind.
// ---------------------------------------------------------------------------
{
  const store = new FakeStore({ ...baseRequest, status: "processing" });
  const transfers = new FakeTransfers();
  transfers.failFind = true;

  const result = await executeHostPayout(
    store,
    transfers,
    execInput(store),
  );
  assert.equal(result.outcome, "transfer_failed");
  assert.equal(transfers.calls, 0);
  assert.equal(store.row.status, "processing");
  assert.equal(store.ledger.length, 0);
}

// ---------------------------------------------------------------------------
// 4. Recorded transfer reference: a processing row whose notes already
//    carry a transfer finalizes only after provider verification, no resend.
// ---------------------------------------------------------------------------
{
  const store = new FakeStore({
    ...baseRequest,
    status: "processing",
    notes: "admin note stripe_transfer:tr_recorded",
  });
  const transfers = new FakeTransfers();

  const result = await executeHostPayout(
    store,
    transfers,
    execInput(store),
  );

  assert.equal(result.outcome, "paid");
  assert.equal(transfers.calls, 0);
  assert.equal(store.ledger.length, 1);
  assert.equal(store.ledger[0].transferId, "tr_recorded");
}

// ---------------------------------------------------------------------------
// 5. Manual payout: no destination and no explicit confirmation refuses
//    WITHOUT claiming (the old silent phantom-paid path). With the
//    admin's explicit confirmation it finalizes paid + one ledger row
//    and sends no transfer.
// ---------------------------------------------------------------------------
{
  const store = new FakeStore(baseRequest);
  const transfers = new FakeTransfers();

  const refused = await executeHostPayout(
    store,
    transfers,
    execInput(store, { destination: noDestination }),
  );
  assert.equal(refused.outcome, "manual_confirmation_required");
  assert.equal(store.row.status, "approved");
  assert.equal(store.ledger.length, 0);
  assert.equal(transfers.calls, 0);

  const confirmed = await executeHostPayout(
    store,
    transfers,
    execInput(store, {
      destination: noDestination,
      manualPayoutConfirmed: true,
    }),
  );
  assert.equal(confirmed.outcome, "paid");
  assert.equal(confirmed.outcome === "paid" && confirmed.manual, true);
  assert.equal(store.ledger.length, 1);
  assert.equal(store.ledger[0].transferId, null);
  assert.equal(transfers.calls, 0);
}

// ---------------------------------------------------------------------------
// 6. Stripe unconfigured with a destination on file: error, row
//    untouched — never a silent manual payout.
// ---------------------------------------------------------------------------
{
  const store = new FakeStore(baseRequest);
  const transfers = new FakeTransfers();

  const result = await executeHostPayout(
    store,
    null,
    execInput(store, { stripeConfigured: false }),
  );

  assert.equal(result.outcome, "stripe_unconfigured");
  assert.equal(store.row.status, "approved");
  assert.equal(store.ledger.length, 0);
}

// ---------------------------------------------------------------------------
// 7. Balance math: one payout of A reduces available by exactly A across
//    its whole life, and a historical paid payout (negative ledger row +
//    paid request, as existing hosts already have) is counted once.
// ---------------------------------------------------------------------------
{
  const earnings = 10_000;
  const payout = 3_000;

  // Before any request: available is the earnings.
  assert.equal(computeHostAvailableCents(earnings, 0), earnings);

  // Request pending/approved: reserved once.
  assert.equal(computeHostAvailableCents(earnings, payout), earnings - payout);

  // After the payout finalizes: the ledger carries −payout inside accrued
  // (10_000 − 3_000) and the paid request is no longer pending. Available
  // must be earnings − payout — NOT earnings − 2×payout (the old formula
  // also subtracted the paid request sum: 10_000 − 3_000 − 3_000 = 4_000).
  const accruedAfterPayout = earnings - payout;
  const availableAfterPayout = computeHostAvailableCents(
    accruedAfterPayout,
    0,
  );
  assert.equal(availableAfterPayout, earnings - payout);
  assert.notEqual(availableAfterPayout, earnings - 2 * payout);

  // A payout stuck in "processing" stays reserved at exactly A.
  assert.equal(
    computeHostAvailableCents(accruedAfterPayout, 0) -
      computeHostAvailableCents(earnings, payout),
    0,
  );
}

console.log("MealScout host payout execution behavior: PASS");
