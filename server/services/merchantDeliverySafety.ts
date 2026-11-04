import { createHash, timingSafeEqual } from "node:crypto";

export type MerchantDeliveryConfiguration = {
  enabled?: boolean | null;
  feeCents?: number | null;
  minimumOrderCents?: number | null;
  estimatedMinutes?: number | null;
  maxConcurrentOrders?: number | null;
  postalCodes?: unknown;
};

export function hasValidMerchantDeliveryConfiguration(
  settings: MerchantDeliveryConfiguration | null | undefined,
) {
  if (!settings?.enabled) return false;
  const postalCodes = Array.isArray(settings.postalCodes)
    ? settings.postalCodes.map((value) => String(value).trim()).filter(Boolean)
    : [];
  return (
    postalCodes.length > 0 &&
    Number.isInteger(settings.feeCents) &&
    Number(settings.feeCents) >= 0 &&
    Number.isInteger(settings.minimumOrderCents) &&
    Number(settings.minimumOrderCents) >= 0 &&
    Number.isInteger(settings.estimatedMinutes) &&
    Number(settings.estimatedMinutes) >= 10 &&
    Number.isInteger(settings.maxConcurrentOrders) &&
    Number(settings.maxConcurrentOrders) >= 1
  );
}

export function calculateAuthoritativeMerchantDeliveryTotals(input: {
  subtotalCents: number;
  platformFeeCents: number;
  deliveryFeeCents: number;
  taxCents?: number;
  tipCents?: number;
  discountCents?: number;
}) {
  const values = {
    subtotalCents: input.subtotalCents,
    platformFeeCents: input.platformFeeCents,
    deliveryFeeCents: input.deliveryFeeCents,
    taxCents: input.taxCents ?? 0,
    tipCents: input.tipCents ?? 0,
    discountCents: input.discountCents ?? 0,
  };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer`);
    }
  }
  if (values.discountCents > values.subtotalCents) {
    throw new Error("discountCents cannot exceed subtotalCents");
  }
  return {
    ...values,
    totalCents:
      values.subtotalCents - values.discountCents + values.taxCents +
      values.tipCents + values.platformFeeCents + values.deliveryFeeCents,
  };
}

export function hashCustomerAccessToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function customerAccessTokenMatches(
  token: string | null | undefined,
  expectedHash: string | null | undefined,
) {
  if (!token || !expectedHash) return false;
  const actual = Buffer.from(hashCustomerAccessToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function projectOrderForCustomer(
  order: Record<string, any>,
  canViewPrivateFulfillment: boolean,
) {
  const {
    stripePaymentIntentId: _stripePaymentIntentId,
    stripeTransferGroupId: _stripeTransferGroupId,
    merchantOwnerIdSnapshot: _merchantOwnerIdSnapshot,
    stripeConnectAccountIdSnapshot: _stripeConnectAccountIdSnapshot,
    stripeRefundId: _stripeRefundId,
    refundFailureReason: _refundFailureReason,
    payoutReversalFailureReason: _payoutReversalFailureReason,
    stripeDisputeId: _stripeDisputeId,
    disputeFailureReason: _disputeFailureReason,
    customerAccessTokenHash: _customerAccessTokenHash,
    checkoutRequestId: _checkoutRequestId,
    ...withoutSecrets
  } = order;
  if (canViewPrivateFulfillment) return withoutSecrets;
  const {
    customerName: _customerName,
    customerEmail: _customerEmail,
    customerPhone: _customerPhone,
    deliveryAddress: _deliveryAddress,
    deliveryCity: _deliveryCity,
    deliveryState: _deliveryState,
    deliveryPostalCode: _deliveryPostalCode,
    deliveryInstructions: _deliveryInstructions,
    specialInstructions: _specialInstructions,
    ...publicOrder
  } = withoutSecrets;
  return publicOrder;
}

export function projectPickupOrderItemsForCustomer(
  items: Array<Record<string, any>>,
  canViewPrivateFulfillment: boolean,
) {
  return items.map((item) => ({
    id: item.id,
    itemName: item.itemName,
    quantity: item.quantity,
    variantLabel:
      item.variantLabel || item.selectedVariant?.label || null,
    modifierLabels: Array.isArray(item.modifierLabels)
      ? item.modifierLabels
      : Array.isArray(item.selectedModifiers)
        ? item.selectedModifiers
            .map((modifier: any) => modifier?.label)
            .filter(Boolean)
        : [],
    lineSubtotalCents: item.lineSubtotalCents,
    lineTotalCents: item.lineTotalCents,
    ...(canViewPrivateFulfillment
      ? { specialInstructions: item.specialInstructions || null }
      : {}),
  }));
}
