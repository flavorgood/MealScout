import type Stripe from "stripe";

export interface PayoutTransferExpectation {
  metadataKey: string; payoutId: string; amount: number; currency: string; destination: string;
  ownerMetadataKey?: string; ownerId?: string;
}

function assertTransferMatches(transfer: Stripe.Transfer, expected: PayoutTransferExpectation): { id: string } {
  const destination = typeof transfer.destination === "string" ? transfer.destination : transfer.destination?.id;
  if (transfer.metadata?.[expected.metadataKey] !== expected.payoutId ||
      (expected.ownerMetadataKey && transfer.metadata?.[expected.ownerMetadataKey] !== expected.ownerId) ||
      transfer.amount !== expected.amount || transfer.currency !== expected.currency ||
      !expected.destination || destination !== expected.destination || transfer.reversed || transfer.amount_reversed !== 0) {
    throw new Error("Transfer does not match payout or was reversed; manual reconciliation required");
  }
  return { id: transfer.id };
}

// Notes are a lookup hint, never evidence that money moved.
export async function verifyRecordedPayoutTransfer(
  stripe: Pick<Stripe, "transfers">, transferId: string, expected: PayoutTransferExpectation,
): Promise<{ id: string }> {
  const transfer = await stripe.transfers.retrieve(transferId);
  if (transfer.id !== transferId) throw new Error("Transfer identity mismatch");
  return assertTransferMatches(transfer, expected);
}

// Read-only, bounded reconciliation. An absent result is NOT evidence that
// an uncertain send failed. Never authorize a new send from this helper.
export async function reconcilePayoutTransfer(
  stripe: Pick<Stripe, "transfers">,
  expected: PayoutTransferExpectation,
): Promise<{ id: string }> {
  let cursor: string | undefined;
  const matches: Stripe.Transfer[] = [];
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = await stripe.transfers.list({ limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
    for (const transfer of page.data) {
      if (seen.has(transfer.id)) throw new Error("Ambiguous transfer pagination; manual reconciliation required");
      seen.add(transfer.id);
      if (transfer.metadata?.[expected.metadataKey] === expected.payoutId) matches.push(transfer);
    }
    if (!page.has_more) {
      if (matches.length !== 1) throw new Error("No unique transfer proof; manual reconciliation required (no resend)");
      return assertTransferMatches(matches[0], expected);
    }
    const next = page.data.at(-1)?.id;
    if (!next || next === cursor) throw new Error("Incomplete transfer pagination; manual reconciliation required");
    cursor = next;
  }
  throw new Error("Transfer scan bound reached; manual reconciliation required (no resend)");
}
