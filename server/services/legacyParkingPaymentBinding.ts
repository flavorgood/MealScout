type LegacyParkingBookingBinding = {
  id: string;
  eventId: string;
  truckId: string;
  hostId: string;
  hostPriceCents: number;
  platformFeeCents: number;
  totalCents: number;
  stripePaymentIntentId: string | null;
  stripeApplicationFeeAmount?: number | null;
  stripeTransferDestination?: string | null;
};

type LegacyParkingIntentBinding = {
  id: string;
  status: string;
  currency: string;
  amount: number;
  amount_received: number;
  metadata?: Record<string, string> | null;
  application_fee_amount?: number | null;
  transfer_data?: {
    destination: string | { id: string };
    amount?: number | null;
  } | null;
};

/**
 * Match a legacy receipt to its immutable booking split and payment owner.
 * providerAccount comes only from successful scoped retrieval or a signed event.
 */
export function isLegacyParkingPaymentBound(
  booking: LegacyParkingBookingBinding,
  intent: LegacyParkingIntentBinding,
  providerAccount: string | null = null,
): boolean {
  if (
    ![booking.id, booking.eventId, booking.truckId, booking.hostId,
      booking.stripePaymentIntentId].every(
      (value) => typeof value === "string" && value.trim().length > 0,
    ) ||
    !Number.isSafeInteger(booking.hostPriceCents) || booking.hostPriceCents < 0 ||
    !Number.isSafeInteger(booking.platformFeeCents) || booking.platformFeeCents < 0 ||
    !Number.isSafeInteger(booking.totalCents) || booking.totalCents <= 0 ||
    booking.hostPriceCents + booking.platformFeeCents !== booking.totalCents ||
    intent.id !== booking.stripePaymentIntentId || intent.status !== "succeeded" ||
    intent.currency !== "usd" || intent.amount !== booking.totalCents ||
    !Number.isSafeInteger(intent.amount_received) || intent.amount_received < booking.totalCents ||
    intent.metadata?.bookingId !== booking.id ||
    intent.metadata?.eventId !== booking.eventId ||
    intent.metadata?.truckId !== booking.truckId ||
    intent.metadata?.hostId !== booking.hostId ||
    intent.metadata?.bookingRequestKey || intent.metadata?.passId
  ) {
    return false;
  }

  // A missing stored snapshot is not evidence for a platform-held payment.
  if (booking.stripeTransferDestination === null) {
    return booking.stripeApplicationFeeAmount === null &&
      providerAccount === null && intent.transfer_data == null &&
      intent.application_fee_amount == null;
  }
  if (
    typeof booking.stripeTransferDestination !== "string" ||
    !booking.stripeTransferDestination.trim() ||
    !Number.isSafeInteger(booking.stripeApplicationFeeAmount) ||
    booking.stripeApplicationFeeAmount !== booking.platformFeeCents ||
    intent.application_fee_amount !== booking.stripeApplicationFeeAmount
  ) {
    return false;
  }

  if (providerAccount !== null) {
    // Older direct charges belong to the verified connected-account scope.
    return providerAccount === booking.stripeTransferDestination &&
      intent.transfer_data == null;
  }

  // Legacy destination charges never requested an explicit transfer override.
  // Unsupported splits require reconciliation instead of inferred host earnings.
  const transfer = intent.transfer_data;
  const destination = typeof transfer?.destination === "string"
    ? transfer.destination
    : transfer?.destination?.id;
  return destination === booking.stripeTransferDestination &&
    transfer?.amount == null;
}
