// Host payout execution — the money-moving half of the admin host-payout
// workflow (PATCH /api/admin/host-payout-requests/:requestId, status "paid").
//
// This ports the affiliate payout execution pattern
// (server/routes/admin/affiliateAdminRoutes.ts) to host payouts, which used
// to set status "paid" BEFORE attempting the Stripe transfer, swallow
// transfer failures, and write the payout ledger row either way — so a
// failed or never-attempted transfer still showed as a completed payout,
// and two simultaneous mark-paid calls could each send a real transfer.
//
// The pattern, as applied here:
//  1. Atomically claim the row approved -> processing with a conditional
//     update (WHERE status = 'approved'). A second execution loses the
//     claim and stops — money can never be sent twice from this action.
//  2. Send the transfer with a deterministic idempotency key
//     (host_payout_<requestId>). If a previous attempt created the transfer
//     but crashed before finalizing, Stripe replays that same transfer on
//     retry instead of paying twice.
//  3. A provider failure leaves the row in "processing" and surfaces an
//     error — never "paid", and no ledger row is written.
//  4. Only after the transfer succeeds, finalize in ONE transaction:
//     status "paid" + paidAt + the transfer reference in notes + the
//     negative payout ledger row, gated on the row still being
//     "processing".
//
// No execution-claim column is needed (unlike the affiliate path, which
// snapshots an unverified, mutable payout destination at approval time):
// every execution input here is derived deterministically from the payout
// row itself — amount from the row, currency "usd", destination from the
// host's connected Stripe account, idempotency key from the request id —
// and the claim is the status transition itself. A transfer reference
// already recorded in the row's notes means the money was already sent;
// execution reconciles from the record and never sends again.
//
// Manual (out-of-band) payouts: when the host has no Stripe destination,
// marking paid records a payment made outside Stripe. That used to happen
// silently — including when a Stripe transfer had merely FAILED. Now it
// requires the admin's explicit manualPayoutConfirmed assertion, and the
// ledger row says so. A transfer failure can no longer become a "manual"
// payout by falling through.

export interface HostPayoutExecutionRow {
  id: string;
  hostId: string;
  userId: string;
  amountCents: number;
  status: string;
  notes: string | null;
}

export interface HostPayoutDestination {
  stripeConnectAccountId: string | null;
  stripePayoutsEnabled: boolean | null;
}

export interface HostPayoutClaimInput {
  requestId: string;
  adminUserId: string;
  notes: string | null;
}

export interface HostPayoutFinalizeInput {
  requestId: string;
  hostId: string;
  amountCents: number;
  transferId: string | null;
  manual: boolean;
  description: string;
  notes: string | null;
  paidAt: Date;
  adminUserId: string;
}

export interface HostPayoutStore {
  // Conditional claim: moves the row approved -> processing ONLY if it is
  // still approved. Returns the claimed row, or null when the claim did
  // not land (another execution claimed it, or it changed state).
  claimProcessing(
    input: HostPayoutClaimInput,
  ): Promise<HostPayoutExecutionRow | null>;
  // Single transaction, gated on the row still being "processing": set
  // status "paid" + paidAt + notes, and insert the negative payout ledger
  // row. Returns the finalized row, or null when the row was no longer
  // processing (nothing is written in that case).
  finalizePaid(
    input: HostPayoutFinalizeInput,
  ): Promise<HostPayoutExecutionRow | null>;
}

export interface HostPayoutTransferRequest {
  amountCents: number;
  destination: string;
  description: string;
  metadata: Record<string, string>;
}

export interface HostPayoutTransferClient {
  createTransfer(
    request: HostPayoutTransferRequest,
    idempotencyKey: string,
  ): Promise<{ id: string }>;
}

export type HostPayoutExecutionResult =
  | {
      outcome: "paid";
      request: HostPayoutExecutionRow;
      transferId: string | null;
      manual: boolean;
    }
  | { outcome: "claim_conflict" }
  | { outcome: "finalize_conflict"; transferId: string | null }
  | { outcome: "transfer_failed"; message: string }
  | { outcome: "stripe_unconfigured" }
  | { outcome: "manual_confirmation_required" }
  | { outcome: "invalid_amount" };

export interface HostPayoutExecutionInput {
  request: HostPayoutExecutionRow;
  destination: HostPayoutDestination;
  stripeConfigured: boolean;
  adminUserId: string;
  // Admin-supplied notes for this action, already resolved against the
  // row's existing notes by the caller (body notes ?? existing notes).
  notes: string | null;
  // The admin's explicit assertion that the host was paid outside Stripe.
  // Required before a destination-less payout can be recorded as paid.
  manualPayoutConfirmed: boolean;
}

const HOST_PAYOUT_TRANSFER_REF_PATTERN = /stripe_transfer:(tr_[A-Za-z0-9]+)/;

export function extractHostPayoutTransferId(
  notes: string | null | undefined,
): string | null {
  if (!notes) return null;
  const match = String(notes).match(HOST_PAYOUT_TRANSFER_REF_PATTERN);
  return match ? match[1] : null;
}

export function appendHostPayoutTransferRef(
  notes: string | null | undefined,
  transferId: string,
): string {
  const ref = `stripe_transfer:${transferId}`;
  const base = String(notes || "").trim();
  if (base.includes(ref)) return base;
  return base ? `${base} ${ref}` : ref;
}

export function hostPayoutIdempotencyKey(requestId: string): string {
  return `host_payout_${requestId}`;
}

export async function executeHostPayout(
  store: HostPayoutStore,
  transferClient: HostPayoutTransferClient | null,
  input: HostPayoutExecutionInput,
): Promise<HostPayoutExecutionResult> {
  const { request, destination } = input;
  const amountCents = Math.abs(Number(request.amountCents || 0));
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { outcome: "invalid_amount" };
  }

  // A transfer reference already recorded on the row means the money was
  // already sent (a previous attempt crashed between the provider call
  // and finalizing). Finalize from the record — never send again.
  const recordedTransferId = extractHostPayoutTransferId(request.notes);
  const hasDestination = Boolean(
    destination.stripeConnectAccountId && destination.stripePayoutsEnabled,
  );
  const stripeMode = !recordedTransferId && input.stripeConfigured && hasDestination;

  if (!recordedTransferId && !stripeMode) {
    // No transfer will be attempted on this call. Refuse to fall through
    // to a silent "manual" paid:
    //  - Stripe is down but the host HAS a destination: error, retry later.
    //  - The host has no destination: paid here means an out-of-band
    //    manual payment, which the admin must explicitly confirm.
    if (!input.stripeConfigured && hasDestination) {
      return { outcome: "stripe_unconfigured" };
    }
    if (!input.manualPayoutConfirmed) {
      return { outcome: "manual_confirmation_required" };
    }
  }

  // Claim before any provider call. On a retry the row is already
  // processing (claimed by the earlier attempt) and execution reconciles
  // against it; any other state means this action should not run.
  if (request.status === "approved") {
    const claimed = await store.claimProcessing({
      requestId: request.id,
      adminUserId: input.adminUserId,
      notes: input.notes,
    });
    if (!claimed) {
      return { outcome: "claim_conflict" };
    }
  } else if (request.status !== "processing") {
    return { outcome: "claim_conflict" };
  }

  let transferId = recordedTransferId;
  if (!transferId && stripeMode) {
    if (!transferClient) {
      return { outcome: "stripe_unconfigured" };
    }
    try {
      const transfer = await transferClient.createTransfer(
        {
          amountCents,
          destination: String(destination.stripeConnectAccountId),
          description: `MealScout host payout — request ${request.id}`,
          metadata: {
            payoutRequestId: request.id,
            hostId: request.hostId,
            adminUserId: input.adminUserId,
          },
        },
        hostPayoutIdempotencyKey(request.id),
      );
      transferId = transfer.id;
    } catch (transferErr: unknown) {
      // The row stays "processing" (outcome uncertain until reconciled),
      // no ledger row is written, and the caller surfaces the error. The
      // payout is never silently "paid".
      return {
        outcome: "transfer_failed",
        message:
          transferErr instanceof Error
            ? transferErr.message
            : String(transferErr),
      };
    }
  }

  const manual = !transferId;
  const paidAt = new Date();
  const finalNotes = transferId
    ? appendHostPayoutTransferRef(input.notes, transferId)
    : input.notes;
  const description = transferId
    ? `Host payout via Stripe Connect transfer ${transferId} (${request.id})`
    : `Host payout processed manually — confirmed by admin (${request.id})`;

  const finalized = await store.finalizePaid({
    requestId: request.id,
    hostId: request.hostId,
    amountCents,
    transferId,
    manual,
    description,
    notes: finalNotes,
    paidAt,
    adminUserId: input.adminUserId,
  });

  if (!finalized) {
    // The money may have moved but the row is no longer processing.
    // Surface it loudly rather than pretending success or failure — a
    // human reconciles this row against Stripe.
    return { outcome: "finalize_conflict", transferId };
  }

  return { outcome: "paid", request: finalized, transferId, manual };
}
