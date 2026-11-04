import Stripe from "stripe";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";

import { pickupOrderItems, pickupOrders } from "@shared/schema";
import { db } from "../db";
import {
  reconcileCancelledPickupOrderPayoutReversal,
  requestAndFinalizeCardPickupOrderCancellation,
} from "./pickupOrderCancellationService";
import { reconcileCompletedPickupOrderRefund } from "./pickupOrderCompletedRefundService";
import { reconcilePickupOrderDispute } from "./pickupOrderDisputeService";
import { sendPickupOrderCancelledNotification } from "./pickupOrderNotificationService";
import {
  PICKUP_ORDER_ACKNOWLEDGEMENT_EXPIRED_REASON,
  PICKUP_ORDER_CONTRACT_VERSION,
  PICKUP_ORDER_PAYMENT_EXPIRED_REASON,
  PICKUP_ORDER_PAYMENT_WINDOW_MS,
  isPickupPaymentSettlementWithinGrace,
  isPickupPaymentSuccessEventWithinWindow,
} from "./pickupOrderPaymentReconciliation";

export type ExpiredPickupPaymentReconciliationResult = {
  examined: number;
  cancelled: number;
  pending: number;
  conflicted: number;
  failed: number;
  financiallyReconciled: number;
  acknowledgementExpired: number;
  legacyPendingExamined: number;
  legacyCancellationPendingExamined: number;
  legacyInventoryAuditRequired: number;
};

function configuredStripeClient(): Stripe | null {
  return process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null;
}

export async function reconcileExpiredPickupOrderPayments(input?: {
  stripe?: Stripe | null;
  now?: Date;
  limit?: number;
}): Promise<ExpiredPickupPaymentReconciliationResult> {
  const now = input?.now || new Date();
  const limit = Math.min(100, Math.max(1, Math.floor(input?.limit || 50)));
  const cutoff = new Date(now.getTime() - PICKUP_ORDER_PAYMENT_WINDOW_MS);
  const reconciliationRetryBefore = new Date(now.getTime() - 5 * 60 * 1000);
  const stripe =
    input && Object.prototype.hasOwnProperty.call(input, "stripe")
      ? input.stripe || null
      : configuredStripeClient();
  // Query recovery cohorts independently. A backlog in one money or inventory
  // path must never consume the entire batch and starve the others.
  const expiredPendingCandidates = await db
    .select({
      id: pickupOrders.id,
      status: pickupOrders.status,
      stripePaymentIntentId: pickupOrders.stripePaymentIntentId,
      createdAt: pickupOrders.createdAt,
      stripeRefundStatus: pickupOrders.stripeRefundStatus,
      refundAttemptCount: pickupOrders.refundAttemptCount,
      payoutStatus: pickupOrders.payoutStatus,
    })
    .from(pickupOrders)
    .where(
      and(
        eq(pickupOrders.paymentMethod, "card"),
        eq(pickupOrders.orderingContractVersion, PICKUP_ORDER_CONTRACT_VERSION),
        eq(pickupOrders.status, "pending"),
        lt(pickupOrders.createdAt, cutoff),
      ),
    )
    .orderBy(asc(pickupOrders.createdAt))
    .limit(limit);
  const legacyPendingCandidates = await db
    .select({
      id: pickupOrders.id,
      status: pickupOrders.status,
      stripePaymentIntentId: pickupOrders.stripePaymentIntentId,
      createdAt: pickupOrders.createdAt,
      stripeRefundStatus: pickupOrders.stripeRefundStatus,
      refundAttemptCount: pickupOrders.refundAttemptCount,
      payoutStatus: pickupOrders.payoutStatus,
      unknownInventoryLineCount: sql<number>`(
        select count(*)::int
          from ${pickupOrderItems}
         where ${pickupOrderItems.orderId} = ${pickupOrders.id}
           and ${pickupOrderItems.inventoryReservedQuantity} is null
      )`,
    })
    .from(pickupOrders)
    .where(
      and(
        eq(pickupOrders.paymentMethod, "card"),
        isNull(pickupOrders.orderingContractVersion),
        eq(pickupOrders.status, "pending"),
        lt(pickupOrders.createdAt, cutoff),
      ),
    )
    .orderBy(asc(pickupOrders.createdAt))
    .limit(limit);
  const legacyCancellationPendingCandidates = await db
    .select({
      id: pickupOrders.id,
      status: pickupOrders.status,
      stripePaymentIntentId: pickupOrders.stripePaymentIntentId,
      createdAt: pickupOrders.createdAt,
      stripeRefundStatus: pickupOrders.stripeRefundStatus,
      refundAttemptCount: pickupOrders.refundAttemptCount,
      payoutStatus: pickupOrders.payoutStatus,
      unknownInventoryLineCount: sql<number>`(
        select count(*)::int
          from ${pickupOrderItems}
         where ${pickupOrderItems.orderId} = ${pickupOrders.id}
           and ${pickupOrderItems.inventoryReservedQuantity} is null
      )`,
    })
    .from(pickupOrders)
    .where(
      and(
        eq(pickupOrders.paymentMethod, "card"),
        isNull(pickupOrders.orderingContractVersion),
        eq(pickupOrders.status, "cancellation_pending"),
        or(
          isNull(pickupOrders.refundUpdatedAt),
          lt(pickupOrders.refundUpdatedAt, reconciliationRetryBefore),
        ),
      ),
    )
    .orderBy(asc(pickupOrders.refundUpdatedAt), asc(pickupOrders.createdAt))
    .limit(limit);
  const refundReconciliationCandidates = await db
    .select({
      id: pickupOrders.id,
      status: pickupOrders.status,
      stripeRefundStatus: pickupOrders.stripeRefundStatus,
      refundAttemptCount: pickupOrders.refundAttemptCount,
    })
    .from(pickupOrders)
    .where(
      and(
        eq(pickupOrders.paymentMethod, "card"),
        eq(pickupOrders.orderingContractVersion, PICKUP_ORDER_CONTRACT_VERSION),
        eq(pickupOrders.status, "cancellation_pending"),
        or(
          isNull(pickupOrders.stripeRefundStatus),
          inArray(pickupOrders.stripeRefundStatus, [
            "pending",
            "requires_action",
          ]),
          and(
            inArray(pickupOrders.stripeRefundStatus, [
              "reconciliation_required",
              "failed",
              "canceled",
            ]),
            lt(pickupOrders.refundAttemptCount, 3),
            or(
              isNull(pickupOrders.refundUpdatedAt),
              lt(pickupOrders.refundUpdatedAt, reconciliationRetryBefore),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(pickupOrders.refundUpdatedAt), asc(pickupOrders.createdAt))
    .limit(limit);
  const acknowledgementDeadlineCandidates = await db
    .select({
      id: pickupOrders.id,
      status: pickupOrders.status,
      stripeRefundStatus: pickupOrders.stripeRefundStatus,
      refundAttemptCount: pickupOrders.refundAttemptCount,
    })
    .from(pickupOrders)
    .where(
      and(
        eq(pickupOrders.paymentMethod, "card"),
        eq(pickupOrders.orderingContractVersion, PICKUP_ORDER_CONTRACT_VERSION),
        eq(pickupOrders.status, "confirmed"),
        or(
          isNull(pickupOrders.merchantAcknowledgementDueAt),
          lt(pickupOrders.merchantAcknowledgementDueAt, now),
        ),
      ),
    )
    .orderBy(
      asc(pickupOrders.merchantAcknowledgementDueAt),
      asc(pickupOrders.confirmedAt),
    )
    .limit(limit);
  const completedRefundCandidates = await db
    .select({ id: pickupOrders.id })
    .from(pickupOrders)
    .where(
      and(
        eq(pickupOrders.paymentMethod, "card"),
        eq(pickupOrders.status, "completed"),
        isNotNull(pickupOrders.stripeRefundId),
        or(
          and(
            inArray(pickupOrders.stripeRefundStatus, [
              "succeeded",
              "partially_refunded",
            ]),
            or(
              isNull(pickupOrders.payoutReversalUpdatedAt),
              and(
                inArray(pickupOrders.payoutStatus, [
                  "reversal_pending",
                  "failed",
                ]),
                lt(
                  pickupOrders.payoutReversalUpdatedAt,
                  reconciliationRetryBefore,
                ),
              ),
            ),
          ),
          and(
            inArray(pickupOrders.stripeRefundStatus, [
              "pending",
              "requires_action",
              "reconciliation_required",
            ]),
            or(
              isNull(pickupOrders.refundUpdatedAt),
              lt(pickupOrders.refundUpdatedAt, reconciliationRetryBefore),
            ),
          ),
        ),
      ),
    )
    .orderBy(
      asc(pickupOrders.payoutReversalUpdatedAt),
      asc(pickupOrders.refundUpdatedAt),
      asc(pickupOrders.createdAt),
    )
    .limit(limit);
  const payoutReversalCandidates = await db
    .select({ id: pickupOrders.id })
    .from(pickupOrders)
    .where(
      and(
        eq(pickupOrders.paymentMethod, "card"),
        eq(pickupOrders.status, "cancelled"),
        or(
          and(
            eq(pickupOrders.stripeRefundStatus, "succeeded"),
            sql`${pickupOrders.stripeRefundAmountCents} = ${pickupOrders.totalCents}`,
          ),
          and(
            eq(pickupOrders.stripeDisputeStatus, "lost"),
            sql`coalesce(${pickupOrders.stripeRefundAmountCents}, 0) + coalesce(${pickupOrders.stripeDisputeAmountCents}, 0) >= ${pickupOrders.totalCents}`,
          ),
        ),
        or(
          sql`${pickupOrders.payoutStatus} <> 'reversed'`,
          and(
            eq(pickupOrders.payoutStatus, "reversed"),
            isNull(pickupOrders.payoutReversalUpdatedAt),
          ),
        ),
        or(
          isNull(pickupOrders.payoutReversalUpdatedAt),
          lt(pickupOrders.payoutReversalUpdatedAt, reconciliationRetryBefore),
        ),
      ),
    )
    .orderBy(
      asc(pickupOrders.payoutReversalUpdatedAt),
      asc(pickupOrders.createdAt),
    )
    .limit(limit);
  const disputeReconciliationCandidates = await db
    .select({
      id: pickupOrders.id,
      stripeDisputeId: pickupOrders.stripeDisputeId,
    })
    .from(pickupOrders)
    .where(
      and(
        eq(pickupOrders.paymentMethod, "card"),
        isNotNull(pickupOrders.stripeDisputeId),
        inArray(pickupOrders.stripeDisputeStatus, [
          "warning_needs_response",
          "warning_under_review",
          "needs_response",
          "under_review",
          "lost",
          "won",
          "prevented",
          "warning_closed",
        ]),
        inArray(pickupOrders.payoutStatus, [
          "dispute_reversal_pending",
          "dispute_reinstatement_pending",
          "failed",
          "disputed",
        ]),
        or(
          isNull(pickupOrders.disputeUpdatedAt),
          lt(pickupOrders.disputeUpdatedAt, reconciliationRetryBefore),
        ),
      ),
    )
    .orderBy(asc(pickupOrders.disputeUpdatedAt), asc(pickupOrders.createdAt))
    .limit(limit);
  const candidates = [
    ...expiredPendingCandidates.map((candidate: any) => ({
      ...candidate,
      kind: "cancellation" as const,
    })),
    ...legacyPendingCandidates.map((candidate: any) => ({
      ...candidate,
      kind: "cancellation" as const,
      legacyPending: true as const,
    })),
    ...legacyCancellationPendingCandidates.map((candidate: any) => ({
      ...candidate,
      kind: "cancellation" as const,
      legacyCancellationPending: true as const,
    })),
    ...acknowledgementDeadlineCandidates.map((candidate: any) => ({
      ...candidate,
      kind: "acknowledgement_timeout" as const,
    })),
    ...refundReconciliationCandidates.map((candidate: any) => ({
      ...candidate,
      kind: "cancellation" as const,
    })),
    ...completedRefundCandidates.map((candidate: any) => ({
      ...candidate,
      kind: "completed_refund" as const,
    })),
    ...payoutReversalCandidates.map((candidate: any) => ({
      ...candidate,
      kind: "payout_reversal" as const,
    })),
    ...disputeReconciliationCandidates.map((candidate: any) => ({
      ...candidate,
      kind: "dispute" as const,
    })),
  ];

  const result: ExpiredPickupPaymentReconciliationResult = {
    examined: candidates.length,
    cancelled: 0,
    pending: 0,
    conflicted: 0,
    failed: 0,
    financiallyReconciled: 0,
    acknowledgementExpired: 0,
    legacyPendingExamined: legacyPendingCandidates.length,
    legacyCancellationPendingExamined:
      legacyCancellationPendingCandidates.length,
    legacyInventoryAuditRequired: [
      ...legacyPendingCandidates,
      ...legacyCancellationPendingCandidates,
    ].filter(
      (candidate: any) => Number(candidate.unknownInventoryLineCount || 0) > 0,
    ).length,
  };
  for (const candidate of candidates) {
    try {
      if (candidate.kind === "payout_reversal") {
        const reconciled = await reconcileCancelledPickupOrderPayoutReversal({
          orderId: candidate.id,
          stripe,
        });
        if (reconciled?.payoutStatus === "reversed") {
          result.financiallyReconciled += 1;
        } else {
          result.pending += 1;
        }
        continue;
      }
      if (candidate.kind === "completed_refund") {
        const reconciled = await reconcileCompletedPickupOrderRefund({
          orderId: candidate.id,
          stripe,
        });
        const completedRefundConverged = Boolean(
          reconciled &&
          ["succeeded", "partially_refunded"].includes(
            String(reconciled.stripeRefundStatus || ""),
          ) &&
          !["reversal_pending", "failed"].includes(
            String(reconciled.payoutStatus || ""),
          ),
        );
        if (completedRefundConverged) result.financiallyReconciled += 1;
        else result.pending += 1;
        continue;
      }
      if (candidate.kind === "dispute") {
        if (!stripe || !candidate.stripeDisputeId) {
          result.pending += 1;
          continue;
        }
        const dispute = await stripe.disputes.retrieve(
          candidate.stripeDisputeId,
        );
        const reconciled = await reconcilePickupOrderDispute({
          orderId: candidate.id,
          dispute,
          stripe,
        });
        if (reconciled.payoutStatus === "failed") {
          result.pending += 1;
        } else {
          result.financiallyReconciled += 1;
        }
        continue;
      }
      if (candidate.kind === "acknowledgement_timeout") {
        result.acknowledgementExpired += 1;
      }
      const reconciliation =
        candidate.status === "pending" &&
        stripe &&
        candidate.stripePaymentIntentId
          ? await (async () => {
              const paymentIntent = await stripe.paymentIntents.retrieve(
                candidate.stripePaymentIntentId,
                { expand: ["latest_charge"] },
              );
              const latestCharge = paymentIntent.latest_charge;
              const chargeCreatedSeconds =
                latestCharge && typeof latestCharge !== "string"
                  ? latestCharge.created
                  : null;
              if (
                paymentIntent.status === "succeeded" &&
                isPickupPaymentSuccessEventWithinWindow({
                  orderCreatedAt: candidate.createdAt,
                  eventCreatedSeconds: chargeCreatedSeconds,
                  now,
                }) &&
                isPickupPaymentSettlementWithinGrace({
                  orderCreatedAt: candidate.createdAt,
                  now,
                })
              ) {
                return null;
              }
              return requestAndFinalizeCardPickupOrderCancellation({
                orderId: candidate.id,
                expectedStatuses: ["pending", "cancellation_pending"],
                cancellationReason: PICKUP_ORDER_PAYMENT_EXPIRED_REASON,
                stripe,
                stripeCancellationReason: "abandoned",
              });
            })()
          : await requestAndFinalizeCardPickupOrderCancellation({
              orderId: candidate.id,
              expectedStatuses:
                candidate.kind === "acknowledgement_timeout"
                  ? ["confirmed", "cancellation_pending"]
                  : ["pending", "cancellation_pending"],
              cancellationReason:
                candidate.kind === "acknowledgement_timeout"
                  ? PICKUP_ORDER_ACKNOWLEDGEMENT_EXPIRED_REASON
                  : candidate.status === "pending"
                    ? PICKUP_ORDER_PAYMENT_EXPIRED_REASON
                    : "Cancellation refund is still being reconciled",
              stripe,
              stripeCancellationReason: "abandoned",
              allowFailedRefundRetry: ["failed", "canceled"].includes(
                String(candidate.stripeRefundStatus || ""),
              ),
            });
      if (!reconciliation) {
        // A signed Stripe success/charge timestamp proves that payment
        // completed inside the window; leave a bounded grace period for
        // webhook settlement replay before the next run cancels and refunds.
        result.pending += 1;
        continue;
      }
      if (reconciliation.outcome === "cancelled") {
        result.cancelled += 1;
        await sendPickupOrderCancelledNotification(reconciliation.order);
      } else if (reconciliation.outcome === "pending") result.pending += 1;
      else result.conflicted += 1;
    } catch (error) {
      result.failed += 1;
      console.error(
        `[pickup-order-expiry] ${candidate.id} reconciliation failed`,
        error,
      );
    }
  }
  return result;
}
