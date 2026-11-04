import type Stripe from "stripe";
import { and, eq, sql } from "drizzle-orm";

import { ORDER_STATUS, pickupOrders, type PickupOrder } from "@shared/schema";
import { db } from "../db";
import { pickupOrderFinancialLockKey } from "../utils/pickupOrderFinancialLock";
import { restoreTrackedInventoryForPickupOrderByOrderId } from "./pickupInventoryService";
import {
  describePickupOrderReconciliationFailure,
  derivePickupOrderAggregateRefundStatus,
  isPickupDisputeBoundToOrder,
  isPickupPaymentIntentAmountBound,
  isPickupPaymentIntentOrderIdentityBound,
  summarizePickupOrderRefunds,
} from "./pickupOrderPaymentReconciliation";
import {
  reinstatePickupOrderDisputeTransfers,
  reversePickupOrderTransfers,
} from "./pickupOrderTransferReversalService";
import {
  pickupOrderCustomerFinancialLossCents,
  pickupOrderReconciledPayoutStatus,
  resolveConvergedPickupDisputeStatus,
} from "./pickupOrderNetSettlementPolicy";

const ACTIVE_FULFILLMENT_STATUSES = new Set<string>([
  ORDER_STATUS.PENDING,
  ORDER_STATUS.CONFIRMED,
  ORDER_STATUS.PREPARING,
  ORDER_STATUS.READY,
]);

export function doesPickupDisputeRequireTransferReversal(status: unknown) {
  return !["won", "prevented", "warning_closed"].includes(
    String(status || "")
      .trim()
      .toLowerCase(),
  );
}

export function isPickupDisputeResolvedForMerchant(status: unknown) {
  return ["won", "prevented", "warning_closed"].includes(
    String(status || "")
      .trim()
      .toLowerCase(),
  );
}

export async function reconcilePickupOrderDispute(input: {
  orderId: string;
  dispute: Stripe.Dispute;
  stripe: Stripe;
}): Promise<PickupOrder> {
  const disputeStatus = String(input.dispute.status || "unknown");
  // The dispute object was retrieved before the advisory lock below is
  // taken, so it can be a snapshot from just before the dispute closed.
  // Under the lock, a terminal stored status wins over a stale
  // non-terminal snapshot; every status write and payout decision in
  // this reconcile uses the converged status.
  let effectiveDisputeStatus = disputeStatus;
  const recorded = await db.transaction(async (tx: any) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${pickupOrderFinancialLockKey(input.orderId)}))`,
    );
    const [current] = await tx
      .select()
      .from(pickupOrders)
      .where(eq(pickupOrders.id, input.orderId))
      .limit(1);
    if (!current) throw new Error(`Pickup order ${input.orderId} not found.`);
    if (
      current.stripeDisputeId &&
      current.stripeDisputeId !== input.dispute.id
    ) {
      throw new Error(
        `Pickup order ${current.id} is already bound to dispute ${current.stripeDisputeId}.`,
      );
    }
    if (
      !isPickupDisputeBoundToOrder(
        input.dispute,
        current.stripePaymentIntentId,
        current.totalCents,
      )
    ) {
      throw new Error(
        `Stripe dispute ${input.dispute.id} does not match pickup order ${current.id}.`,
      );
    }

    effectiveDisputeStatus = resolveConvergedPickupDisputeStatus({
      storedStatus: current.stripeDisputeStatus,
      incomingStatus: disputeStatus,
    });
    const requiresTransferReversal =
      doesPickupDisputeRequireTransferReversal(effectiveDisputeStatus);
    const resolvedForMerchant =
      isPickupDisputeResolvedForMerchant(effectiveDisputeStatus);
    const disputeLost = effectiveDisputeStatus.toLowerCase() === "lost";

    const fulfillmentWasActive = ACTIVE_FULFILLMENT_STATUSES.has(
      String(current.status || ""),
    );
    const wasOnDisputeHold = current.status === ORDER_STATUS.PAYMENT_DISPUTED;
    const disputeIsTerminal = resolvedForMerchant || disputeLost;
    const nextStatus =
      disputeIsTerminal && (fulfillmentWasActive || wasOnDisputeHold)
        ? ORDER_STATUS.CANCELLATION_PENDING
        : fulfillmentWasActive
          ? ORDER_STATUS.PAYMENT_DISPUTED
          : current.status;
    const cancellationReason =
      resolvedForMerchant && (fulfillmentWasActive || wasOnDisputeHold)
        ? "Card dispute resolved after fulfillment was paused; the order must be cancelled and refunded"
        : disputeLost && (fulfillmentWasActive || wasOnDisputeHold)
          ? "Card dispute was decided through the card issuer; fulfillment is cancelled and any undisputed remainder must be refunded"
          : fulfillmentWasActive
            ? "Card payment is disputed; fulfillment is blocked pending support review"
            : current.cancellationReason;
    const nextPayoutStatus =
      resolvedForMerchant && current.status === ORDER_STATUS.COMPLETED
        ? "dispute_reinstatement_pending"
        : requiresTransferReversal && current.payoutStatus !== "reversed"
          ? "dispute_reversal_pending"
          : current.payoutStatus;
    const [updated] = await tx
      .update(pickupOrders)
      .set({
        status: nextStatus,
        cancellationReason,
        cancelledAt: current.cancelledAt,
        stripeDisputeId: input.dispute.id,
        stripeDisputeStatus: effectiveDisputeStatus,
        stripeDisputeAmountCents: input.dispute.amount,
        stripeDisputeReason: input.dispute.reason,
        disputeFailureReason: null,
        disputeUpdatedAt: new Date(),
        payoutStatus: nextPayoutStatus,
        updatedAt: new Date(),
      })
      .where(eq(pickupOrders.id, current.id))
      .returning();
    if (!updated) {
      throw new Error(`Pickup order ${current.id} dispute write failed.`);
    }
    if (fulfillmentWasActive) {
      await restoreTrackedInventoryForPickupOrderByOrderId(tx, current.id, [
        ORDER_STATUS.PAYMENT_DISPUTED,
        ORDER_STATUS.CANCELLATION_PENDING,
        ORDER_STATUS.CANCELLED,
      ]);
    }
    return updated;
  });

  const requiresTransferReversal =
    doesPickupDisputeRequireTransferReversal(effectiveDisputeStatus);
  const resolvedForMerchant =
    isPickupDisputeResolvedForMerchant(effectiveDisputeStatus);
  const needsCompletedSettlementReconciliation =
    resolvedForMerchant && recorded.status === ORDER_STATUS.COMPLETED;
  if (
    (!requiresTransferReversal || recorded.payoutStatus === "reversed") &&
    !needsCompletedSettlementReconciliation
  ) {
    return recorded;
  }

  try {
    return await db.transaction(async (tx: any) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${pickupOrderFinancialLockKey(input.orderId)}))`,
      );
      const [current] = await tx
        .select()
        .from(pickupOrders)
        .where(eq(pickupOrders.id, input.orderId))
        .limit(1);
      if (!current || current.stripeDisputeId !== input.dispute.id) {
        throw new Error(
          `Pickup order ${input.orderId} dispute binding changed during reconciliation.`,
        );
      }
      if (!current.stripePaymentIntentId) {
        throw new Error(
          `Pickup order ${current.id} has no bound Stripe PaymentIntent.`,
        );
      }
      const paymentIntent = await input.stripe.paymentIntents.retrieve(
        current.stripePaymentIntentId,
      );
      if (
        !isPickupPaymentIntentAmountBound(paymentIntent, current.totalCents) ||
        !isPickupPaymentIntentOrderIdentityBound(paymentIntent, current)
      ) {
        throw new Error(
          `Stripe payment ${current.stripePaymentIntentId} does not match pickup order ${current.id}.`,
        );
      }
      const paymentIntentTransferGroup =
        String(paymentIntent.transfer_group || "").trim() || null;
      const localTransferGroup =
        String(current.stripeTransferGroupId || "").trim() || null;
      const refundSummary = await summarizePickupOrderRefunds({
        stripe: input.stripe,
        paymentIntentId: current.stripePaymentIntentId,
        totalCents: current.totalCents,
      });
      const latestRefund = refundSummary.latestRefund;
      const customerFinancialLossCents = pickupOrderCustomerFinancialLossCents({
        totalCents: current.totalCents,
        succeededRefundAmountCents: refundSummary.succeededAmountCents,
        stripeDisputeStatus: effectiveDisputeStatus,
        stripeDisputeAmountCents: input.dispute.amount,
      });
      if (needsCompletedSettlementReconciliation) {
        await reinstatePickupOrderDisputeTransfers({
          stripe: input.stripe,
          orderId: current.id,
          disputeId: input.dispute.id,
          transferGroups: [paymentIntentTransferGroup, localTransferGroup],
          customerFinancialLossCents,
          orderTotalCents: current.totalCents,
        });
        // Reinstatement moves net settlement upward after a merchant win. A
        // refund can settle out of order before this webhook, so converge in
        // the opposite direction too before recording the payout state.
        await reversePickupOrderTransfers({
          stripe: input.stripe,
          orderId: current.id,
          paymentIntentTransferGroup,
          localTransferGroup,
          customerFinancialLossCents,
          orderTotalCents: current.totalCents,
          idempotencyScope: `dispute:${input.dispute.id}:net:${customerFinancialLossCents}`,
          reversalMetadata: { stripeDisputeId: input.dispute.id },
        });
      } else {
        await reversePickupOrderTransfers({
          stripe: input.stripe,
          orderId: current.id,
          paymentIntentTransferGroup,
          localTransferGroup,
          customerFinancialLossCents,
          orderTotalCents: current.totalCents,
          idempotencyScope: `dispute:${input.dispute.id}:loss:${customerFinancialLossCents}`,
          reversalMetadata: { stripeDisputeId: input.dispute.id },
        });
      }

      const [reconciled] = await tx
        .update(pickupOrders)
        .set({
          payoutStatus: pickupOrderReconciledPayoutStatus({
            totalCents: current.totalCents,
            succeededRefundAmountCents: refundSummary.succeededAmountCents,
            stripeDisputeStatus: effectiveDisputeStatus,
          }),
          stripeTransferGroupId:
            paymentIntentTransferGroup || localTransferGroup,
          ...(latestRefund
            ? {
                stripeRefundId: latestRefund.id,
                stripeRefundStatus: derivePickupOrderAggregateRefundStatus({
                  totalCents: current.totalCents,
                  succeededAmountCents: refundSummary.succeededAmountCents,
                  pendingAmountCents: refundSummary.pendingAmountCents,
                  latestRefundStatus: latestRefund.status,
                }),
                stripeRefundAmountCents: refundSummary.succeededAmountCents,
                refundUpdatedAt: new Date(),
              }
            : {}),
          disputeFailureReason: null,
          disputeUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(pickupOrders.id, current.id),
            eq(pickupOrders.stripeDisputeId, input.dispute.id),
          ),
        )
        .returning();
      if (!reconciled) {
        throw new Error(
          `Pickup order ${current.id} changed during dispute reconciliation.`,
        );
      }
      return reconciled;
    });
  } catch (error) {
    const failed = await db.transaction(async (tx: any) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${pickupOrderFinancialLockKey(input.orderId)}))`,
      );
      const [updated] = await tx
        .update(pickupOrders)
        .set({
          payoutStatus: "failed",
          disputeFailureReason: describePickupOrderReconciliationFailure(error),
          disputeUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(pickupOrders.id, input.orderId),
            eq(pickupOrders.stripeDisputeId, input.dispute.id),
          ),
        )
        .returning();
      return updated || null;
    });
    console.error(
      `[pickup-order-dispute] ${input.orderId} merchant transfer reconciliation failed; customer fulfillment/refund state remains authoritative`,
      error,
    );
    return failed || recorded;
  }
}
