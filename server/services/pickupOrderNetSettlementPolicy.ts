export function doesPickupDisputeRequireMerchantRecovery(status: unknown) {
  const normalized = String(status || "")
    .trim()
    .toLowerCase();
  return Boolean(
    normalized && !["won", "prevented", "warning_closed"].includes(normalized),
  );
}

export function pickupOrderCustomerFinancialLossCents(input: {
  totalCents: unknown;
  succeededRefundAmountCents?: unknown;
  stripeDisputeStatus?: unknown;
  stripeDisputeAmountCents?: unknown;
}) {
  const totalCents = Number(input.totalCents);
  const refundCents = Number(input.succeededRefundAmountCents || 0);
  const disputeCents = doesPickupDisputeRequireMerchantRecovery(
    input.stripeDisputeStatus,
  )
    ? Number(input.stripeDisputeAmountCents || 0)
    : 0;
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
    throw new Error("Pickup order total is invalid for net settlement.");
  }
  if (
    !Number.isSafeInteger(refundCents) ||
    refundCents < 0 ||
    !Number.isSafeInteger(disputeCents) ||
    disputeCents < 0
  ) {
    throw new Error(
      "Pickup order customer loss is invalid for net settlement.",
    );
  }
  return Math.min(totalCents, refundCents + disputeCents);
}

const TERMINAL_PICKUP_DISPUTE_STATUSES = new Set([
  "won",
  "prevented",
  "warning_closed",
  "lost",
]);

export function isTerminalPickupDisputeStatus(status: unknown) {
  return TERMINAL_PICKUP_DISPUTE_STATUSES.has(
    String(status || "")
      .trim()
      .toLowerCase(),
  );
}

/**
 * The dispute object a reconcile runs with was retrieved before the
 * per-order advisory lock is taken, so it can be a snapshot from just
 * before the dispute closed. A terminal stored status is the final
 * outcome for that dispute: a stale non-terminal snapshot must never
 * move it backwards, so the reconcile converges on the stored terminal
 * status instead. Every other transition follows the incoming status,
 * including terminal-to-terminal re-decisions.
 */
export function resolveConvergedPickupDisputeStatus(input: {
  storedStatus: unknown;
  incomingStatus: unknown;
}) {
  const storedStatus = String(input.storedStatus || "").trim();
  const incomingStatus = String(input.incomingStatus || "unknown");
  if (
    isTerminalPickupDisputeStatus(storedStatus) &&
    !isTerminalPickupDisputeStatus(incomingStatus)
  ) {
    return storedStatus;
  }
  return incomingStatus;
}

export function pickupOrderReconciledPayoutStatus(input: {
  totalCents: unknown;
  succeededRefundAmountCents?: unknown;
  stripeDisputeStatus?: unknown;
}) {
  const totalCents = Number(input.totalCents);
  const refundCents = Number(input.succeededRefundAmountCents || 0);
  if (doesPickupDisputeRequireMerchantRecovery(input.stripeDisputeStatus)) {
    return "disputed";
  }
  if (refundCents >= totalCents && totalCents > 0) return "reversed";
  if (refundCents > 0) return "partially_reversed";
  return "transferred";
}
