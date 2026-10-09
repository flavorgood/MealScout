import type { Express } from "express";
import Stripe from "stripe";
import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  PARKING_PASS_BOOKING_DAYS,
  PARKING_PASS_SLOT_TYPES,
  isSlotWithinHours,
} from "@shared/parkingPassSlots";
import {
  creditLedger,
  hosts,
  suppliers,
  restaurantSubscriptions,
  restaurants,
  users,
} from "@shared/schema";
import { db } from "../db";
import { emailService } from "../emailService";
import { resolveCityTimeZoneSync } from "../services/cityTimeZone";
import {
  addDaysToDateKey,
  dateKeyInZone,
  utcDateFromDateKey,
} from "../services/dateKeys";
import { storage } from "../storage";
import {
  resolvePickupPayoutSourceTransaction,
  shouldAttemptPickupWebhookPayoutTransfer,
} from "../utils/pickupWebhookPayout";
import { pickupOrderFinancialLockKey } from "../utils/pickupOrderFinancialLock";
import { isRestaurantOrderingAuthorityVersionCurrent } from "../services/restaurantOrderingAuthorityVersion";
import { shouldRevokeUserSubscriptionEntitlements } from "../utils/stripeSubscriptionEntitlements";
import { decideStripeWebhookVerificationMode } from "../utils/stripeWebhookVerification";
import { restoreTrackedInventoryForPickupOrderByOrderId } from "../services/pickupInventoryService";
import {
  PICKUP_ORDER_PAYOUT_REVERSAL_PENDING,
  requestAndFinalizeCardPickupOrderCancellation,
} from "../services/pickupOrderCancellationService";
import { reconcileCompletedPickupOrderRefund } from "../services/pickupOrderCompletedRefundService";
import { reconcilePickupOrderDispute } from "../services/pickupOrderDisputeService";
import { isLegacyParkingPaymentBound } from "../services/legacyParkingPaymentBinding";
import {
  pickupDisputePaymentIntentId,
  retrieveAuthoritativePickupOrderDispute,
} from "../services/pickupOrderDisputeTruth";
import {
  PICKUP_ORDER_PAYMENT_EVENT_OUTSIDE_WINDOW_REASON,
  PICKUP_ORDER_SETTLEMENT_GRACE_EXPIRED_REASON,
  derivePickupOrderAggregateRefundStatus,
  isPickupPaymentIntentAmountBound,
  isPickupPaymentIntentOrderIdentityBound,
  isPickupPaymentIntentSettlementBound,
  isPickupPaymentSettlementWithinGrace,
  isPickupPaymentSuccessEventWithinWindow,
  isPickupRefundFromOrder,
  shouldPickupRefundEnterCancellation,
  summarizePickupOrderRefunds,
} from "../services/pickupOrderPaymentReconciliation";
const configuredStripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;
type NotifyHostCapacityWarningParams = {
  hostId: string;
  eventId: string;
  eventStartDate: Date | null;
  confirmedCount: number;
  maxTrucks: number;
};
type StripeWebhookRouteDependencies = {
  notifyHostCapacityWarning: (
    params: NotifyHostCapacityWarningParams,
  ) => Promise<void>;
  stripeClient?: Stripe | null;
};

function getSubscriptionCustomerId(
  customer: Stripe.Subscription["customer"],
): string | null {
  if (typeof customer === "string") return customer;
  return customer?.id || null;
}

async function deactivateSubscriptionEntitlements(params: {
  userId: string;
  subscriptionId: string;
  eventId: string;
  eventCreatedAt: Date;
}) {
  await db.transaction(async (tx: any) => {
    const [lockedSubscription] = await tx
      .select({
        id: restaurantSubscriptions.id,
        stripeEventCreatedAt: restaurantSubscriptions.stripeEventCreatedAt,
      })
      .from(restaurantSubscriptions)
      .where(
        eq(restaurantSubscriptions.stripeSubscriptionId, params.subscriptionId),
      )
      .limit(1)
      .for("update");

    if (!lockedSubscription) return;
    if (
      lockedSubscription.stripeEventCreatedAt &&
      lockedSubscription.stripeEventCreatedAt.getTime() >=
        params.eventCreatedAt.getTime()
    ) {
      return;
    }

    // Serialize delayed cancellation A against activation of replacement B.
    // The second event observes the committed current subscription before it
    // can change user-level access.
    const [lockedUser] = await tx
      .select({ stripeSubscriptionId: users.stripeSubscriptionId })
      .from(users)
      .where(eq(users.id, params.userId))
      .limit(1)
      .for("update");

    // Retire legacy billing records without changing profile tools or public
    // content. Profile access no longer derives from subscription state.
    await tx
      .update(restaurantSubscriptions)
      .set({
        status: "canceled",
        canceledAt: new Date(),
        stripeEventId: params.eventId,
        stripeEventCreatedAt: params.eventCreatedAt,
        updatedAt: new Date(),
      })
      .where(eq(restaurantSubscriptions.id, lockedSubscription.id));

    if (
      !lockedUser ||
      !shouldRevokeUserSubscriptionEntitlements({
        currentSubscriptionId: lockedUser.stripeSubscriptionId,
        eventSubscriptionId: params.subscriptionId,
      })
    ) {
      return;
    }

    const clearedUsers = await tx
      .update(users)
      .set({
        stripeSubscriptionId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(users.id, params.userId),
          or(
            isNull(users.stripeSubscriptionId),
            eq(users.stripeSubscriptionId, params.subscriptionId),
          ),
        ),
      )
      .returning({ id: users.id });
    if (clearedUsers.length !== 1) {
      throw new Error(
        `Subscription changed while revoking ${params.subscriptionId}`,
      );
    }
  });
}

async function retireLegacyProfileSubscription(
  subscriptionId: string,
  eventId: string,
  eventCreatedAt: Date,
  customerId?: string | null,
) {
  let user = await storage.getUserByStripeSubscriptionId(subscriptionId);
  if (!user && customerId) {
    user = await storage.getUserByStripeCustomerId(customerId);
  }
  if (!user) return;

  await deactivateSubscriptionEntitlements({
    userId: user.id,
    subscriptionId,
    eventId,
    eventCreatedAt,
  });
}

async function recordLegacyProfileSubscriptionEvent(params: {
  subscriptionId: string;
  eventId: string;
  eventCreatedAt: Date;
}) {
  await db.transaction(async (tx: any) => {
    const [lockedSubscription] = await tx
      .select({
        id: restaurantSubscriptions.id,
        stripeEventCreatedAt: restaurantSubscriptions.stripeEventCreatedAt,
      })
      .from(restaurantSubscriptions)
      .where(
        eq(restaurantSubscriptions.stripeSubscriptionId, params.subscriptionId),
      )
      .limit(1)
      .for("update");

    if (!lockedSubscription) return;
    if (
      lockedSubscription.stripeEventCreatedAt &&
      lockedSubscription.stripeEventCreatedAt.getTime() >=
        params.eventCreatedAt.getTime()
    ) {
      return;
    }

    await tx
      .update(restaurantSubscriptions)
      .set({
        stripeEventId: params.eventId,
        stripeEventCreatedAt: params.eventCreatedAt,
        updatedAt: new Date(),
      })
      .where(eq(restaurantSubscriptions.id, lockedSubscription.id));
  });
}

export function registerStripeWebhookRoutes(
  app: Express,
  dependencies: StripeWebhookRouteDependencies,
) {
  const { notifyHostCapacityWarning } = dependencies;
  const stripe = Object.prototype.hasOwnProperty.call(
    dependencies,
    "stripeClient",
  )
    ? dependencies.stripeClient || null
    : configuredStripe;
  // Stripe Webhook Handler
  app.post("/api/stripe/webhook", async (req, res) => {
    const sig = req.headers["stripe-signature"] as string;
    let event;

    try {
      const payload = Buffer.isBuffer(req.body)
        ? req.body.toString("utf8")
        : req.body;
      const forceVerify =
        String(process.env.STRIPE_WEBHOOK_FORCE_VERIFY || "")
          .trim()
          .toLowerCase() === "true";
      const allowUnsignedDev =
        String(process.env.STRIPE_WEBHOOK_DEV_ALLOW_UNSIGNED || "")
          .trim()
          .toLowerCase() === "true";

      const verificationMode = decideStripeWebhookVerificationMode({
        nodeEnv: process.env.NODE_ENV,
        forceVerify,
        allowUnsignedDev,
      });
      if (verificationMode === "accept_unsigned_dev") {
        event = typeof payload === "string" ? JSON.parse(payload) : payload;
      } else {
        const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
        if (!stripe || !endpointSecret) {
          return res
            .status(503)
            .send("Webhook signature verification unavailable");
        }
        if (!Buffer.isBuffer(req.body)) {
          throw new Error("Stripe webhook request body was not raw bytes");
        }
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`Webhook signature verification failed:`, errMsg);
      return res
        .status(400)
        .send("Webhook Error: signature verification failed");
    }

    console.log(`[WEBHOOK] Received event: ${event.type}`);

    try {
      switch (event.type) {
        case "invoice.payment_succeeded": {
          const invoice = event.data.object;
          console.log(`[WEBHOOK] Invoice ${invoice.id} payment succeeded`);

          if (invoice.subscription) {
            const subscriptionId = String(invoice.subscription);
            console.warn(
              `[WEBHOOK] Legacy profile subscription ${subscriptionId} received a payment; no automatic cancellation or access change was made`,
            );
          }
          break;
        }
        case "invoice.payment_failed": {
          const failedInvoice = event.data.object;
          console.log(`[WEBHOOK] Invoice ${failedInvoice.id} payment failed`);

          if (failedInvoice.subscription) {
            const subscriptionId = String(failedInvoice.subscription);
            console.warn(
              `[WEBHOOK] Legacy profile subscription ${subscriptionId} reported a failed payment; no automatic cancellation or access change was made`,
            );
          }
          break;
        }
        case "payment_intent.succeeded":
          const paymentIntent = event.data.object;
          console.log(`[WEBHOOK] PaymentIntent ${paymentIntent.id} succeeded`);

          try {
            const { eventBookings, events, restaurants, hosts } =
              await import("@shared/schema");
            const metadata = paymentIntent.metadata || {};

            // Pickup order payment. Older intents used orderId; newer callers may
            // send pickupOrderId. Accept both so paid orders do not stay pending.
            const pickupOrderId = metadata.pickupOrderId || metadata.orderId;
            if (pickupOrderId) {
              try {
                const {
                  pickupOrders,
                  pickupOrderItems,
                  menuCategories,
                  menuItems,
                } = await import("@shared/schema");
                const { getWebSocketServer } = await import("../websocket");
                const {
                  sendPickupOrderCancelledNotification,
                  sendPickupOrderConfirmedNotifications,
                } = await import("../services/pickupOrderNotificationService");
                const { buildOrderingReadiness } = await import("./menuRoutes");
                const {
                  isMenuItemCategoryOrderable,
                  isPickupOrderItemAvailableForExistingReservation,
                } = await import("../services/restaurantOrderingEligibility");
                const payoutResult = await db.transaction(async (tx: any) => {
                  const [candidate] = await tx
                    .select({ id: pickupOrders.id })
                    .from(pickupOrders)
                    .where(
                      or(
                        eq(
                          pickupOrders.stripePaymentIntentId,
                          paymentIntent.id,
                        ),
                        and(
                          eq(pickupOrders.id, String(pickupOrderId)),
                          isNull(pickupOrders.stripePaymentIntentId),
                        ),
                      ),
                    )
                    .limit(1);
                  if (!candidate) {
                    throw new Error(
                      `Pickup order not found for PaymentIntent ${paymentIntent.id}`,
                    );
                  }
                  await tx.execute(
                    sql`select pg_advisory_xact_lock(hashtext(${pickupOrderFinancialLockKey(candidate.id)}))`,
                  );
                  let [order] = await tx
                    .select()
                    .from(pickupOrders)
                    .where(eq(pickupOrders.id, candidate.id))
                    .limit(1);
                  if (!order) {
                    throw new Error(
                      `Pickup order disappeared for PaymentIntent ${paymentIntent.id}`,
                    );
                  }
                  if (!order.stripePaymentIntentId) {
                    const metadataRestaurantId = String(
                      paymentIntent.metadata?.restaurantId || "",
                    ).trim();
                    const mayAttachLegacyCancelledPayment = Boolean(
                      order.status === "cancelled" &&
                      isPickupPaymentIntentOrderIdentityBound(
                        paymentIntent,
                        order,
                      ),
                    );
                    if (
                      !metadataRestaurantId ||
                      metadataRestaurantId !== order.restaurantId ||
                      (!isPickupPaymentIntentSettlementBound(
                        paymentIntent,
                        order,
                      ) &&
                        !mayAttachLegacyCancelledPayment)
                    ) {
                      throw new Error(
                        `Pickup order ${order.id} cannot bind PaymentIntent ${paymentIntent.id}`,
                      );
                    }
                    const [attached] = await tx
                      .update(pickupOrders)
                      .set({
                        stripePaymentIntentId: paymentIntent.id,
                        stripeTransferGroupId:
                          String(paymentIntent.transfer_group || "").trim() ||
                          order.stripeTransferGroupId,
                        updatedAt: new Date(),
                      })
                      .where(
                        and(
                          eq(pickupOrders.id, order.id),
                          isNull(pickupOrders.stripePaymentIntentId),
                        ),
                      )
                      .returning();
                    if (!attached) {
                      throw new Error(
                        `Pickup order ${order.id} PaymentIntent attachment raced`,
                      );
                    }
                    order = attached;
                  }

                  const paymentAmountMatches = isPickupPaymentIntentAmountBound(
                    paymentIntent,
                    order.totalCents,
                  );
                  const paymentSettlementMatches =
                    isPickupPaymentIntentSettlementBound(paymentIntent, order);
                  const terminalCancellationBindingMatches = Boolean(
                    isPickupPaymentIntentOrderIdentityBound(
                      paymentIntent,
                      order,
                    ),
                  );

                  const statusBeforeWebhook = String(order.status || "")
                    .trim()
                    .toLowerCase();
                  if (statusBeforeWebhook === "cancellation_pending") {
                    if (
                      !paymentAmountMatches ||
                      !terminalCancellationBindingMatches
                    ) {
                      return {
                        orderId: order.id,
                        restaurantId: order.restaurantId,
                        notificationOrder: null,
                        cancellationRequired: false,
                        cancellationOrder: null,
                        cancellationReason: null,
                        error: new Error(
                          `Succeeded PaymentIntent ${paymentIntent.id} does not match cancelling pickup order ${order.id}`,
                        ),
                      };
                    }
                    return {
                      orderId: order.id,
                      restaurantId: order.restaurantId,
                      notificationOrder: null,
                      cancellationRequired: true,
                      cancellationOrder: null,
                      cancellationReason:
                        order.cancellationReason ||
                        "Ordering eligibility changed before payment completed",
                      error: null,
                    };
                  }
                  if (statusBeforeWebhook === "cancelled") {
                    if (
                      !paymentAmountMatches ||
                      !terminalCancellationBindingMatches
                    ) {
                      return {
                        orderId: order.id,
                        restaurantId: order.restaurantId,
                        notificationOrder: null,
                        cancellationRequired: false,
                        cancellationOrder: null,
                        cancellationReason: null,
                        error: new Error(
                          `Succeeded PaymentIntent ${paymentIntent.id} does not match cancelled pickup order ${order.id}`,
                        ),
                      };
                    }
                    return {
                      orderId: order.id,
                      restaurantId: order.restaurantId,
                      notificationOrder: null,
                      cancellationRequired: true,
                      cancellationOrder: null,
                      cancellationReason:
                        order.cancellationReason ||
                        "A card payment completed after the order was cancelled",
                      error: null,
                    };
                  }

                  const payoutMayNeedFirstSettlement = Boolean(
                    order.payoutStatus !== "transferred" &&
                      ["pending", "confirmed"].includes(statusBeforeWebhook),
                  );
                  let lockedOrderingRestaurant:
                    | {
                        ownerId: string;
                        stripeConnectAccountId: string | null;
                        orderingAuthorityVersion: number;
                      }
                    | undefined;
                  if (
                    statusBeforeWebhook === "pending" ||
                    payoutMayNeedFirstSettlement
                  ) {
                    [lockedOrderingRestaurant] = await tx
                      .select({
                        ownerId: restaurants.ownerId,
                        stripeConnectAccountId:
                          restaurants.stripeConnectAccountId,
                        orderingAuthorityVersion:
                          restaurants.orderingAuthorityVersion,
                      })
                      .from(restaurants)
                      .where(eq(restaurants.id, order.restaurantId))
                      .limit(1)
                      .for("update", { of: restaurants });
                  }

                  // A client secret can outlive the page that issued it. Before
                  // the first confirmation, re-check the exact menu, every ordered
                  // item, current pickup location, hours, verification, payment
                  // readiness, and a bounded payment window. A failed check commits
                  // cancellation_pending before any Stripe refund side effect.
                  if (
                    statusBeforeWebhook === "pending" ||
                    payoutMayNeedFirstSettlement
                  ) {
                    const orderLines = await tx
                      .select({
                        menuItemId: menuItems.id,
                        menuId: menuItems.menuId,
                        categoryId: menuItems.categoryId,
                        categoryActive: menuCategories.isActive,
                        isAvailable: menuItems.isAvailable,
                        trackInventory: menuItems.trackInventory,
                        inventoryQty: menuItems.inventoryQty,
                        inventoryAutoUnavailable:
                          menuItems.inventoryAutoUnavailable,
                        inventoryReservedQuantity:
                          pickupOrderItems.inventoryReservedQuantity,
                        priceCents: menuItems.priceCents,
                        availableFrom: menuItems.availableFrom,
                        availableTo: menuItems.availableTo,
                      })
                      .from(pickupOrderItems)
                      .leftJoin(
                        menuItems,
                        eq(menuItems.id, pickupOrderItems.menuItemId),
                      )
                      .leftJoin(
                        menuCategories,
                        and(
                          eq(menuCategories.id, menuItems.categoryId),
                          eq(menuCategories.menuId, menuItems.menuId),
                          eq(
                            menuCategories.restaurantId,
                            menuItems.restaurantId,
                          ),
                        ),
                      )
                      .where(eq(pickupOrderItems.orderId, order.id));
                    const menuIds = new Set<string>(
                      orderLines.map((line: any) => String(line.menuId || "")),
                    );
                    const exactMenuId: string | null =
                      menuIds.size === 1 ? [...menuIds][0] : null;
                    const allItemsStillAvailable = Boolean(
                      orderLines.length > 0 &&
                      orderLines.every(
                        (line: any) =>
                          isPickupOrderItemAvailableForExistingReservation(
                            line,
                          ) &&
                          Number.isInteger(line.priceCents) &&
                          line.priceCents >= 0 &&
                          !String(line.availableFrom || "").trim() &&
                          !String(line.availableTo || "").trim() &&
                          isMenuItemCategoryOrderable(line),
                      ),
                    );
                    // Webhook delivery/replay can be delayed. Eligibility is
                    // bound to Stripe's signed success-event time, not the time
                    // this process happened to receive the event.
                    const paymentEventWithinWindow =
                      isPickupPaymentSuccessEventWithinWindow({
                        orderCreatedAt: order.createdAt,
                        eventCreatedSeconds: event.created,
                      });
                    const paymentSettlementWithinGrace =
                      isPickupPaymentSettlementWithinGrace({
                        orderCreatedAt: order.createdAt,
                      });
                    let readinessStillValid = false;
                    if (exactMenuId && allItemsStillAvailable) {
                      try {
                        const readiness = await buildOrderingReadiness(
                          order.restaurantId,
                          exactMenuId,
                          {
                            includeSettlementIdentity: true,
                            existingReservedMenuItemIds: orderLines
                              .filter(
                                (line: any) =>
                                  Number.isInteger(
                                    Number(line.inventoryReservedQuantity),
                                  ) &&
                                  Number(line.inventoryReservedQuantity) > 0,
                              )
                              .map((line: any) =>
                                String(line.menuItemId || "").trim(),
                              )
                              .filter(Boolean),
                            database: tx,
                          },
                        );
                        readinessStillValid = Boolean(
                          lockedOrderingRestaurant &&
                          readiness.orderingEnabled &&
                          readiness.paymentMethods.card &&
                          isRestaurantOrderingAuthorityVersionCurrent({
                            preflightVersion:
                              lockedOrderingRestaurant.orderingAuthorityVersion,
                            lockedVersion: readiness.orderingAuthorityVersion,
                          }) &&
                          order.pricesIncludeTax === true &&
                          String(readiness.restaurantName || "").trim() ===
                            String(order.merchantNameSnapshot || "").trim() &&
                          String(
                            readiness.settlementIdentity?.merchantOwnerId || "",
                          ).trim() ===
                            String(
                              order.merchantOwnerIdSnapshot || "",
                            ).trim() &&
                          String(
                            readiness.settlementIdentity
                              ?.stripeConnectAccountId || "",
                          ).trim() ===
                            String(
                              order.stripeConnectAccountIdSnapshot || "",
                            ).trim() &&
                          String(readiness.pickupAddressLabel || "").trim() ===
                            String(order.pickupAddressSnapshot || "").trim() &&
                          String(readiness.pickupDirectionsUrl || "").trim() ===
                            String(
                              order.pickupDirectionsUrlSnapshot || "",
                            ).trim() &&
                          Number(readiness.merchantAcknowledgementMinutes) ===
                            Number(
                              order.merchantAcknowledgementMinutesSnapshot,
                            ),
                        );
                      } catch (readinessError) {
                        console.error(
                          `[WEBHOOK] Pickup order ${order.id} eligibility recheck failed closed`,
                          readinessError,
                        );
                      }
                    }
                    if (
                      !paymentEventWithinWindow ||
                      !paymentSettlementWithinGrace ||
                      !paymentAmountMatches ||
                      !paymentSettlementMatches ||
                      !readinessStillValid
                    ) {
                      const cancellationReason = !paymentEventWithinWindow
                        ? PICKUP_ORDER_PAYMENT_EVENT_OUTSIDE_WINDOW_REASON
                        : !paymentSettlementWithinGrace
                          ? PICKUP_ORDER_SETTLEMENT_GRACE_EXPIRED_REASON
                          : !paymentAmountMatches
                            ? "Card payment did not match the authoritative order total"
                            : !paymentSettlementMatches
                              ? "Card payment did not match the authorized merchant payout identity"
                              : "Ordering eligibility changed before payment completed";
                      if (statusBeforeWebhook !== "pending") {
                        await tx
                          .update(pickupOrders)
                          .set({
                            payoutStatus: "failed",
                            updatedAt: new Date(),
                          })
                          .where(eq(pickupOrders.id, order.id));
                        return {
                          orderId: order.id,
                          restaurantId: order.restaurantId,
                          notificationOrder: null,
                          cancellationRequired: false,
                          cancellationOrder: null,
                          cancellationReason: null,
                          error: new Error(
                            `Ordering eligibility changed before first payout for confirmed pickup order ${order.id}`,
                          ),
                        };
                      }
                      const [cancellationPending] = await tx
                        .update(pickupOrders)
                        .set({
                          status: "cancellation_pending",
                          payoutStatus: PICKUP_ORDER_PAYOUT_REVERSAL_PENDING,
                          cancellationReason,
                          updatedAt: new Date(),
                        })
                        .where(
                          and(
                            eq(pickupOrders.id, order.id),
                            eq(pickupOrders.status, "pending"),
                          ),
                        )
                        .returning();
                      if (!cancellationPending) {
                        throw new Error(
                          `Pickup order ${order.id} changed during eligibility cancellation`,
                        );
                      }
                      return {
                        orderId: order.id,
                        restaurantId: order.restaurantId,
                        notificationOrder: null,
                        cancellationRequired: true,
                        cancellationOrder: null,
                        cancellationReason,
                        error: null,
                      };
                    }
                  }

                  const acknowledgementMinutes = Number(
                    order.merchantAcknowledgementMinutesSnapshot,
                  );
                  const failPayout = async (error: unknown) => {
                    await tx
                      .update(pickupOrders)
                      .set({ payoutStatus: "failed", updatedAt: new Date() })
                      .where(eq(pickupOrders.id, order.id));
                    return {
                      orderId: order.id,
                      restaurantId: order.restaurantId,
                      notificationOrder: null,
                      cancellationRequired: false,
                      cancellationOrder: null,
                      cancellationReason: null,
                      error,
                    };
                  };

                  if (!paymentAmountMatches) {
                    return {
                      orderId: order.id,
                      restaurantId: order.restaurantId,
                      notificationOrder: null,
                      cancellationRequired: false,
                      cancellationOrder: null,
                      cancellationReason: null,
                      error: new Error(
                        `PaymentIntent ${paymentIntent.id} amount or currency does not match pickup order ${order.id}`,
                      ),
                    };
                  }

                  // A Stripe transfer can succeed while the following database
                  // update fails. Settle before confirming the order, and give
                  // Stripe a stable idempotency key so a webhook replay can safely
                  // reconcile either side of that boundary.
                  const transferGroupId = String(
                    order.stripeTransferGroupId || "",
                  ).trim();
                  const payoutNeedsSettlement =
                    order.payoutStatus !== "transferred" &&
                    ["pending", "confirmed"].includes(statusBeforeWebhook);
                  if (payoutNeedsSettlement && !transferGroupId) {
                    return failPayout(
                      new Error(
                        `Stripe transfer group missing for pickup order ${order.id}`,
                      ),
                    );
                  }
                  const shouldTransferPayout =
                    shouldAttemptPickupWebhookPayoutTransfer({
                      statusBeforeWebhook: order.status,
                      paymentSucceeded: paymentIntent.status === "succeeded",
                      stripeTransferGroupId: transferGroupId,
                      payoutStatus: order.payoutStatus,
                    });
                  let payoutReconciledThisAttempt = false;
                  if (shouldTransferPayout) {
                    if (!stripe) {
                      return failPayout(
                        new Error(
                          "Stripe client unavailable for pickup order transfer",
                        ),
                      );
                    }
                    const restaurant = lockedOrderingRestaurant;
                    const connectAccountId = String(
                      order.stripeConnectAccountIdSnapshot || "",
                    ).trim();
                    if (
                      !restaurant ||
                      !connectAccountId ||
                      String(restaurant.ownerId || "").trim() !==
                        String(order.merchantOwnerIdSnapshot || "").trim() ||
                      String(restaurant.stripeConnectAccountId || "").trim() !==
                        connectAccountId ||
                      !paymentSettlementMatches
                    ) {
                      return failPayout(
                        new Error(
                          `Merchant payout identity changed for pickup order ${order.id}`,
                        ),
                      );
                    }

                    const merchantGrossCents =
                      order.subtotalCents +
                      Math.max(0, Number(order.deliveryFeeCents || 0) || 0);
                    const transferAmount = Math.max(
                      0,
                      order.feePaidByBusiness
                        ? merchantGrossCents -
                            Math.max(
                              0,
                              Number(order.platformFeeCents || 0) || 0,
                            )
                        : merchantGrossCents,
                    );
                    const sourceTransactionId =
                      resolvePickupPayoutSourceTransaction(
                        paymentIntent.latest_charge,
                      );
                    if (transferAmount > 0 && !sourceTransactionId) {
                      return failPayout(
                        new Error(
                          `Stripe source charge missing for pickup order ${order.id}`,
                        ),
                      );
                    }
                    try {
                      if (transferAmount > 0) {
                        await stripe.transfers.create(
                          {
                            amount: transferAmount,
                            currency: "usd",
                            destination: connectAccountId,
                            source_transaction: sourceTransactionId!,
                            transfer_group: transferGroupId,
                            metadata: { pickupOrderId: order.id },
                          },
                          {
                            idempotencyKey: `pickup-order:${order.id}:transfer`,
                          },
                        );
                      }
                      await tx
                        .update(pickupOrders)
                        .set({
                          payoutStatus: "transferred",
                          updatedAt: new Date(),
                        })
                        .where(eq(pickupOrders.id, order.id));
                      payoutReconciledThisAttempt = true;
                    } catch (error) {
                      return failPayout(error);
                    }
                  }

                  const payoutReady = Boolean(
                    order.payoutStatus === "transferred" ||
                    payoutReconciledThisAttempt,
                  );
                  let updated: typeof order | undefined;
                  if (order.status === "pending" && payoutReady) {
                    const confirmedAt = new Date();
                    [updated] = await tx
                      .update(pickupOrders)
                      .set({
                        status: "confirmed",
                        confirmedAt,
                        merchantAcknowledgementDueAt: new Date(
                          confirmedAt.getTime() +
                            acknowledgementMinutes * 60 * 1000,
                        ),
                        updatedAt: confirmedAt,
                      })
                      .where(
                        and(
                          eq(pickupOrders.id, order.id),
                          eq(pickupOrders.status, "pending"),
                        ),
                      )
                      .returning();
                  }

                  // Re-fetch every confirmed + settled replay, including a process
                  // crash after the transaction commit but before notifications.
                  // Notification claims are deduped and failed/stale claims can be
                  // reclaimed, so replay closes that crash window without duplicates.
                  let reconciledConfirmedOrder: typeof order | undefined;
                  if (!updated && order.status === "confirmed" && payoutReady) {
                    [reconciledConfirmedOrder] = await tx
                      .select()
                      .from(pickupOrders)
                      .where(eq(pickupOrders.id, order.id))
                      .limit(1);
                  }
                  return {
                    orderId: order.id,
                    restaurantId: order.restaurantId,
                    notificationOrder:
                      updated || reconciledConfirmedOrder || null,
                    cancellationRequired: false,
                    cancellationOrder: null,
                    cancellationReason: null,
                    error: null,
                  };
                });
                if (payoutResult.error) throw payoutResult.error;
                if (payoutResult.cancellationRequired) {
                  const cancellationResult =
                    await requestAndFinalizeCardPickupOrderCancellation({
                      orderId: payoutResult.orderId,
                      expectedStatuses: ["cancellation_pending", "cancelled"],
                      cancellationReason:
                        payoutResult.cancellationReason ||
                        "Ordering eligibility changed before payment completed",
                      stripe,
                    });
                  if (cancellationResult.outcome === "conflict") {
                    throw new Error(
                      `Pickup order ${pickupOrderId} cancellation reconciliation conflicted`,
                    );
                  }
                  const cancelledOrder = cancellationResult.order;
                  const wsIo = getWebSocketServer();
                  if (wsIo) {
                    wsIo
                      .to(`kitchen:${cancelledOrder.restaurantId}`)
                      .emit("kitchen:order_update", {
                        order: cancelledOrder as Record<string, unknown>,
                      });
                  }
                  if (cancellationResult.outcome === "cancelled") {
                    await sendPickupOrderCancelledNotification(cancelledOrder);
                  }
                  break;
                }
                if (payoutResult.cancellationOrder) {
                  await sendPickupOrderCancelledNotification(
                    payoutResult.cancellationOrder,
                  );
                  break;
                }
                const notificationOrder = payoutResult.notificationOrder;
                const wsIo = getWebSocketServer();
                if (wsIo && notificationOrder) {
                  wsIo
                    .to(`kitchen:${payoutResult.restaurantId}`)
                    .emit("kitchen:order_update", {
                      order: notificationOrder as Record<string, unknown>,
                    });
                }
                if (notificationOrder) {
                  await sendPickupOrderConfirmedNotifications(
                    notificationOrder,
                  );
                }
              } catch (pickupError) {
                console.error(
                  "[WEBHOOK] Pickup order payment confirmation failed:",
                  pickupError,
                );
                throw pickupError;
              }
              break;
            }

            // Supplier marketplace order payment
            const supplierOrderId = metadata.supplierOrderId;
            if (supplierOrderId) {
              try {
                const { supplierOrders } = await import("@shared/schema");
                const [order] = await db
                  .select()
                  .from(supplierOrders)
                  .where(eq(supplierOrders.id, String(supplierOrderId)))
                  .limit(1);
                if (order) {
                  const storedIntentId = String(
                    (order as any).stripePaymentIntentId || "",
                  ).trim();
                  if (storedIntentId && storedIntentId !== paymentIntent.id) {
                    console.warn(
                      `[WEBHOOK] Supplier order ${supplierOrderId} ignored PaymentIntent ${paymentIntent.id}; expected ${storedIntentId}`,
                    );
                    break;
                  }
                  // Idempotent: only mark paid if not already.
                  if (String((order as any).paymentStatus || "") !== "paid") {
                    await db
                      .update(supplierOrders)
                      .set({
                        paymentStatus: "paid",
                        stripePaymentIntentId:
                          storedIntentId || paymentIntent.id,
                        updatedAt: new Date(),
                      } as any)
                      .where(eq(supplierOrders.id, String(supplierOrderId)));
                  }
                } else {
                  throw new Error(
                    `Supplier order ${supplierOrderId} not found for PaymentIntent ${paymentIntent.id}`,
                  );
                }
              } catch (supplierError) {
                console.error(
                  "[WEBHOOK] Supplier order update failed:",
                  supplierError,
                );
                throw supplierError;
              }
              break;
            }

            // ── Single-event booking payment (bookingId metadata) ──────────
            const bookingId = String(metadata.bookingId || "").trim();
            if (bookingId && !metadata.passId) {
              try {
                const [booking] = await db
                  .select()
                  .from(eventBookings)
                  .where(eq(eventBookings.id, bookingId))
                  .limit(1);

                if (!booking) {
                  throw new Error(`Booking ${bookingId} not found`);
                }
                const bookingIntentId = String(
                  booking.stripePaymentIntentId || "",
                ).trim();
                if (
                  !["pending", "confirmed"].includes(String(booking.status)) ||
                  !isLegacyParkingPaymentBound(booking, paymentIntent, event.account ?? null)
                ) {
                  throw new Error(
                    `Booking ${bookingId} requires reconciliation; payment or pending hold is no longer bound`,
                  );
                }

                // Idempotent: a retry may be reconciling a host-earnings
                // write that failed after the booking itself was confirmed.
                if (booking.status === "confirmed") {
                  const { recordHostBookingEarnings } =
                    await import("../hostEarningsService");
                  if (Number(booking.hostPriceCents || 0) > 0) {
                    await recordHostBookingEarnings([
                      {
                        hostId: booking.hostId,
                        bookingId: booking.id,
                        amountCents: Number(booking.hostPriceCents),
                        stripePaymentIntentId: paymentIntent.id,
                      },
                    ]);
                  }
                  console.log(
                    `[WEBHOOK] Booking ${bookingId} already confirmed`,
                  );
                  break;
                }

                const now = new Date();
                const [confirmedBooking] = await db
                  .update(eventBookings)
                  .set({
                    status: "confirmed",
                    stripePaymentStatus: "succeeded",
                    paidAt: now,
                    bookingConfirmedAt: now,
                    updatedAt: now,
                  })
                  .where(
                    and(
                      eq(eventBookings.id, bookingId),
                      eq(eventBookings.status, "pending"),
                      eq(eventBookings.stripePaymentIntentId, bookingIntentId),
                      eq(eventBookings.eventId, booking.eventId),
                      eq(eventBookings.truckId, booking.truckId),
                      eq(eventBookings.hostId, booking.hostId),
                      eq(eventBookings.hostPriceCents, booking.hostPriceCents),
                      eq(eventBookings.platformFeeCents, booking.platformFeeCents),
                      eq(eventBookings.totalCents, booking.totalCents),
                      booking.stripeApplicationFeeAmount === null
                        ? isNull(eventBookings.stripeApplicationFeeAmount)
                        : eq(eventBookings.stripeApplicationFeeAmount, booking.stripeApplicationFeeAmount),
                      booking.stripeTransferDestination === null
                        ? isNull(eventBookings.stripeTransferDestination)
                        : eq(eventBookings.stripeTransferDestination, booking.stripeTransferDestination),
                    ),
                  )
                  .returning({ id: eventBookings.id });
                if (!confirmedBooking) {
                  throw new Error(`Booking ${bookingId} changed during payment confirmation; reconciliation required`);
                }

                // Update event fill status
                const [countRow] = await db
                  .select({ count: sql<number>`count(*)` })
                  .from(eventBookings)
                  .where(
                    and(
                      eq(eventBookings.eventId, booking.eventId),
                      eq(eventBookings.status, "confirmed"),
                    ),
                  );
                const confirmedCount = Number(countRow?.count ?? 0);

                const [eventRow] = await db
                  .select()
                  .from(events)
                  .where(eq(events.id, booking.eventId))
                  .limit(1);

                if (eventRow) {
                  const newStatus =
                    confirmedCount >= (eventRow.maxTrucks ?? 1)
                      ? "filled"
                      : "open";
                  await db
                    .update(events)
                    .set({ status: newStatus, updatedAt: now })
                    .where(eq(events.id, booking.eventId));

                  // Capacity warning notification
                  try {
                    if (
                      confirmedCount >= (eventRow.maxTrucks ?? 1) ||
                      confirmedCount / (eventRow.maxTrucks ?? 1) >= 0.8
                    ) {
                      await notifyHostCapacityWarning({
                        hostId: eventRow.hostId,
                        eventId: booking.eventId,
                        eventStartDate: eventRow.date ?? null,
                        confirmedCount,
                        maxTrucks: eventRow.maxTrucks ?? 1,
                      });
                    }
                  } catch (notifyErr) {
                    console.error(
                      "[WEBHOOK] Capacity notify error:",
                      notifyErr,
                    );
                  }
                }

                // Record host earnings
                try {
                  const { recordHostBookingEarnings } =
                    await import("../hostEarningsService");
                  if (Number(booking.hostPriceCents || 0) > 0) {
                    await recordHostBookingEarnings([
                      {
                        hostId: booking.hostId,
                        bookingId: booking.id,
                        amountCents: Number(booking.hostPriceCents),
                        stripePaymentIntentId: paymentIntent.id,
                      },
                    ]);
                  }
                } catch (ledgerErr) {
                  console.error("[WEBHOOK] Host earnings error:", ledgerErr);
                  throw ledgerErr;
                }

                // Send confirmation email to truck owner
                try {
                  const [truck] = await db
                    .select({
                      ownerId: restaurants.ownerId,
                      name: restaurants.name,
                    })
                    .from(restaurants)
                    .where(eq(restaurants.id, booking.truckId));
                  const owner = truck
                    ? await storage.getUser(truck.ownerId)
                    : null;
                  const [hostRow] = await db
                    .select({
                      businessName: hosts.businessName,
                      userId: hosts.userId,
                    })
                    .from(hosts)
                    .where(eq(hosts.id, booking.hostId))
                    .limit(1);
                  if (owner?.email && eventRow) {
                    const dateKey = eventRow.date
                      ? new Date(eventRow.date).toISOString().slice(0, 10)
                      : "";
                    await emailService.sendBookingConfirmationEmail({
                      to: owner.email,
                      hostName: hostRow?.businessName || "Host location",
                      startDate: dateKey,
                      endDate: dateKey,
                      slotSummary: eventRow.name || "Event",
                      totalCents: booking.totalCents,
                    });
                    // Also notify the host
                    if (hostRow?.userId) {
                      const hostUser = await storage.getUser(hostRow.userId);
                      if (hostUser?.email) {
                        await emailService.sendHostBookingNotification({
                          to: hostUser.email,
                          hostName: hostRow.businessName || "Your location",
                          truckName: truck?.name || "A food truck",
                          startDate: dateKey,
                          endDate: dateKey,
                          slotSummary: eventRow.name || undefined,
                          totalCents: booking.totalCents,
                        });
                      }
                    }
                  }
                } catch (emailErr) {
                  console.error(
                    "[WEBHOOK] Booking confirmation email error:",
                    emailErr,
                  );
                }
              } catch (bookingError) {
                console.error(
                  "[WEBHOOK] Error confirming event booking:",
                  bookingError,
                );
                throw bookingError;
              }
              break;
            }
            // ─────────────────────────────────────────────────────────────

            const passId = metadata.passId;
            const truckId = metadata.truckId;

            if (!passId || !truckId) {
              break;
            }

            const amountCents =
              Number(metadata.totalCents) || Number(paymentIntent.amount || 0);

            const intentRows = await db
              .select()
              .from(eventBookings)
              .where(
                and(
                  eq(eventBookings.stripePaymentIntentId, paymentIntent.id),
                  eq(eventBookings.truckId, truckId),
                ),
              );
            const pendingHolds = intentRows.filter(
              (row: (typeof intentRows)[number]) => row.status === "pending",
            );
            const alreadyProcessed = intentRows.some(
              (row: (typeof intentRows)[number]) =>
                row.status === "confirmed" ||
                (row.status === "cancelled" && row.refundStatus === "credit"),
            );

            const reconcileHostEarnings = async (rows: typeof intentRows) => {
              const entries = rows
                .filter(
                  (row: (typeof rows)[number]) =>
                    row.status === "confirmed" &&
                    Number(row.hostPriceCents || 0) > 0,
                )
                .map((row: (typeof rows)[number]) => ({
                  hostId: row.hostId,
                  bookingId: row.id,
                  amountCents: Number(row.hostPriceCents),
                  stripePaymentIntentId: paymentIntent.id,
                }));
              if (entries.length === 0) return;
              const { recordHostBookingEarnings } =
                await import("../hostEarningsService");
              await recordHostBookingEarnings(entries);
            };

            const reconcileCommittedCreditDebit = async () => {
              const creditAppliedCents = Number(
                metadata.creditAppliedCents || 0,
              );
              if (creditAppliedCents <= 0) return;

              const [truck] = await db
                .select({ ownerId: restaurants.ownerId })
                .from(restaurants)
                .where(eq(restaurants.id, truckId));
              if (!truck?.ownerId) {
                throw new Error(
                  `Truck owner missing while reconciling booking credit for ${truckId}`,
                );
              }

              const { debitCredit } = await import("../creditService");
              // Stripe has already honored the metadata discount. Record that
              // exact committed value. debitCredit is idempotent on this
              // PaymentIntent-backed reference.
              await debitCredit(
                truck.ownerId,
                creditAppliedCents / 100,
                "booking_credit",
                paymentIntent.id,
                "booking",
                { externalValueAlreadyCommitted: true },
              );
            };

            if (alreadyProcessed) {
              // A prior delivery may have committed the booking/credit state
              // and then failed during a ledger write. Reconcile idempotent
              // financial side effects before acknowledging the replay.
              await reconcileHostEarnings(intentRows);
              await reconcileCommittedCreditDebit();
              break;
            }

            const [eventRow] = await db
              .select()
              .from(events)
              .where(eq(events.id, passId));

            if (!eventRow || !eventRow.requiresPayment) {
              break;
            }

            const [host] = await db
              .select()
              .from(hosts)
              .where(eq(hosts.id, eventRow.hostId));
            const bookingTimeZone = resolveCityTimeZoneSync({
              city: host?.city,
              state: host?.state,
            });

            const slotTypes = String(
              metadata.slotTypes || metadata.slotType || "",
            )
              .split(",")
              .map((value) => value.trim().toLowerCase())
              .filter((value) => value.length > 0)
              .filter((value) =>
                PARKING_PASS_SLOT_TYPES.includes(value as any),
              );
            const normalizedSlotTypes =
              slotTypes.length > 0 ? slotTypes : ["daily"];

            const hasMonthly = normalizedSlotTypes.includes("monthly");
            const hasWeekly = normalizedSlotTypes.includes("weekly");
            const hasDaily = normalizedSlotTypes.includes("daily");
            const bookingDays = Math.max(
              1,
              Number(
                metadata.bookingDays ||
                  (hasMonthly
                    ? PARKING_PASS_BOOKING_DAYS.monthly
                    : hasWeekly
                      ? PARKING_PASS_BOOKING_DAYS.weekly
                      : hasDaily
                        ? PARKING_PASS_BOOKING_DAYS.daily
                        : 1),
              ),
            );

            const startDateKey = metadata.bookingStartDate
              ? String(metadata.bookingStartDate)
              : dateKeyInZone(new Date(eventRow.date), bookingTimeZone);
            const rangeStart = utcDateFromDateKey(startDateKey);
            const rangeEnd = new Date(rangeStart);
            rangeEnd.setDate(rangeEnd.getDate() + bookingDays);

            const bookingEvents: Array<typeof events.$inferSelect> = await db
              .select()
              .from(events)
              .where(
                and(
                  eq(events.hostId, eventRow.hostId),
                  eq(events.requiresPayment, true),
                  gte(events.date, rangeStart),
                  lt(events.date, rangeEnd),
                ),
              )
              .orderBy(asc(events.date));

            const eventsByDate = new Map<
              string,
              (typeof bookingEvents)[number]
            >();
            for (const row of bookingEvents) {
              const dateKey = dateKeyInZone(
                new Date(row.date),
                bookingTimeZone,
              );
              eventsByDate.set(dateKey, row);
            }

            const expectedDateKeys: string[] = [];
            for (let offset = 0; offset < bookingDays; offset += 1) {
              expectedDateKeys.push(addDaysToDateKey(startDateKey, offset));
            }

            const metadataHostPriceCents = Number(metadata.hostPriceCents || 0);
            const metadataPlatformFeeCents = Number(
              metadata.platformFeeCents || 0,
            );
            let cancelled = false;
            // `cancelled` above only guards against multiple calls within a
            // single invocation of this handler -- it does nothing against
            // two genuinely concurrent deliveries of the same Stripe event
            // (Stripe documents at-least-once delivery, including
            // near-simultaneous retries), each getting its own fresh
            // `cancelled = false` closure. Without a lock, both could reach
            // addCredit before either committed the booking-row status
            // change that the alreadyProcessed check above relies on,
            // double-issuing credit for one overbooked payment. Serialize
            // on the PaymentIntent id and re-check terminal state inside
            // the lock so a second concurrent caller sees the first's
            // committed result and skips re-issuing credit.
            const cancelWithCredit = async (reason: string) => {
              if (cancelled) return;
              cancelled = true;

              await db.transaction(async (tx: any) => {
                await tx.execute(
                  sql`SELECT pg_advisory_xact_lock(hashtext(${`payment_intent_credit:${paymentIntent.id}`}))`,
                );

                const recheckRows = await tx
                  .select()
                  .from(eventBookings)
                  .where(
                    and(
                      eq(eventBookings.stripePaymentIntentId, paymentIntent.id),
                      eq(eventBookings.truckId, truckId),
                    ),
                  );
                const recheckAlreadyProcessed = recheckRows.some(
                  (row: (typeof recheckRows)[number]) =>
                    row.status === "confirmed" ||
                    (row.status === "cancelled" &&
                      row.refundStatus === "credit"),
                );
                if (recheckAlreadyProcessed) {
                  console.log(
                    `[WEBHOOK] Skipping duplicate credit issuance for PaymentIntent ${paymentIntent.id} -- already processed by a concurrent delivery`,
                  );
                  return;
                }

                const [truck] = await tx
                  .select({ ownerId: restaurants.ownerId })
                  .from(restaurants)
                  .where(eq(restaurants.id, truckId));

                if (truck?.ownerId && amountCents > 0) {
                  const [existingCredit] = await tx
                    .select({ id: creditLedger.id })
                    .from(creditLedger)
                    .where(
                      and(
                        eq(creditLedger.userId, truck.ownerId),
                        eq(creditLedger.sourceId, paymentIntent.id),
                        sql`${creditLedger.amount} > 0`,
                      ),
                    )
                    .limit(1);
                  if (!existingCredit) {
                    await tx.insert(creditLedger).values({
                      userId: truck.ownerId,
                      amount: (amountCents / 100).toFixed(2),
                      sourceType: reason,
                      sourceId: paymentIntent.id,
                    });
                  }
                }

                // If we created pending holds ahead of payment, update them instead of inserting,
                // otherwise the unique constraint (event_id, truck_id) can fail.
                if (recheckRows.length > 0) {
                  const now = new Date();
                  for (const row of recheckRows) {
                    await tx
                      .update(eventBookings)
                      .set({
                        status: "cancelled",
                        stripePaymentStatus: "succeeded",
                        refundStatus: "credit",
                        refundAmountCents: row.totalCents,
                        refundedAt: now,
                        refundReason: "Credit issued",
                        cancelledAt: now,
                        cancellationReason: "Overbooked - credit issued",
                        updatedAt: now,
                      })
                      .where(eq(eventBookings.id, row.id));
                  }
                  return;
                }

                await tx
                  .insert(eventBookings)
                  .values({
                    eventId: passId,
                    truckId,
                    hostId: eventRow.hostId,
                    hostPriceCents: metadataHostPriceCents,
                    platformFeeCents: metadataPlatformFeeCents,
                    totalCents: amountCents,
                    status: "cancelled",
                    stripePaymentIntentId: paymentIntent.id,
                    stripePaymentStatus: "succeeded",
                    stripeApplicationFeeAmount: metadataPlatformFeeCents,
                    stripeTransferDestination:
                      host?.stripeConnectAccountId || null,
                    slotType: normalizedSlotTypes.join(","),
                    refundStatus: "credit",
                    refundAmountCents: amountCents,
                    refundedAt: new Date(),
                    refundReason: "Overbooked",
                    cancelledAt: new Date(),
                    cancellationReason: "Overbooked - credit issued",
                  })
                  .onConflictDoNothing();
              });
            };

            const missingDates = expectedDateKeys.filter(
              (dateKey) => !eventsByDate.has(dateKey),
            );
            if (missingDates.length > 0) {
              await cancelWithCredit("parking_pass_overbook");
              break;
            }

            for (const dateKey of expectedDateKeys) {
              const row = eventsByDate.get(dateKey);
              if (!row) continue;
              if (row.status !== "open") {
                await cancelWithCredit("parking_pass_overbook");
                break;
              }

              for (const slotType of normalizedSlotTypes) {
                if (
                  !isSlotWithinHours(
                    slotType as any,
                    row.startTime,
                    row.endTime,
                  )
                ) {
                  await cancelWithCredit("parking_pass_overbook");
                  break;
                }
              }
              if (cancelled) {
                break;
              }
            }
            if (cancelled) {
              break;
            }

            const eventIds = bookingEvents.map((row) => row.id);
            const counts =
              eventIds.length > 0
                ? await db
                    .select({
                      eventId: eventBookings.eventId,
                      count: sql<number>`count(*)`,
                    })
                    .from(eventBookings)
                    .where(inArray(eventBookings.eventId, eventIds))
                    .where(inArray(eventBookings.status, ["confirmed"]))
                    .groupBy(eventBookings.eventId)
                : [];

            const countsByEvent = new Map<string, number>();
            for (const row of counts) {
              countsByEvent.set(row.eventId, Number(row.count || 0));
            }

            for (const dateKey of expectedDateKeys) {
              const row = eventsByDate.get(dateKey);
              if (!row) continue;
              const count = countsByEvent.get(row.id) ?? 0;
              if (count >= (row.maxTrucks ?? 1)) {
                await cancelWithCredit("parking_pass_overbook");
                break;
              }
            }
            if (cancelled) {
              break;
            }

            const existingTruckBooking = await db
              .select({ id: eventBookings.id })
              .from(eventBookings)
              .where(inArray(eventBookings.eventId, eventIds))
              .where(eq(eventBookings.truckId, truckId))
              .where(inArray(eventBookings.status, ["confirmed"]))
              .limit(1);

            if (existingTruckBooking.length > 0) {
              await cancelWithCredit("parking_pass_duplicate");
              break;
            }

            const splitAmount = (total: number, days: number) => {
              if (days <= 1) return [total];
              const base = Math.floor(total / days);
              const remainder = total - base * days;
              return Array.from({ length: days }, (_, index) =>
                index === 0 ? base + remainder : base,
              );
            };

            const hostPriceCents = Number(metadata.hostPriceCents || 0);
            const platformFeeCents = Number(metadata.platformFeeCents || 0);
            const hostSplit = splitAmount(hostPriceCents, bookingDays);
            const platformSplit = splitAmount(platformFeeCents, bookingDays);

            const confirmedBookings = await db
              .select({
                eventId: eventBookings.eventId,
                spotNumber: eventBookings.spotNumber,
                bookingConfirmedAt: eventBookings.bookingConfirmedAt,
              })
              .from(eventBookings)
              .where(inArray(eventBookings.eventId, eventIds))
              .where(inArray(eventBookings.status, ["confirmed"]))
              .orderBy(asc(eventBookings.bookingConfirmedAt));

            const bookingsByEvent = new Map<
              string,
              (typeof confirmedBookings)[number][]
            >();
            for (const row of confirmedBookings) {
              const list = bookingsByEvent.get(row.eventId) ?? [];
              list.push(row);
              bookingsByEvent.set(row.eventId, list);
            }

            const now = new Date();
            // If the PaymentIntent succeeded but we no longer have pending holds
            // (e.g. hold expired or was cancelled), do NOT confirm a booking.
            // Instead, issue credits and mark the rows cancelled so we don't create ghost bookings.
            if (intentRows.length > 0 && pendingHolds.length === 0) {
              await cancelWithCredit("parking_pass_hold_expired");
              break;
            }

            const usesHolds = pendingHolds.length > 0;
            let bookingConfirmed = false;
            const newlyConfirmedByEventId = new Map<string, number>();
            const incrementNewlyConfirmed = (eventId: string) => {
              newlyConfirmedByEventId.set(
                eventId,
                (newlyConfirmedByEventId.get(eventId) ?? 0) + 1,
              );
            };
            const earnedEntries: Array<{
              hostId: string;
              bookingId: string;
              amountCents: number;
            }> = [];

            if (usesHolds) {
              const holdsByEventId = new Map<
                string,
                (typeof pendingHolds)[number]
              >();
              for (const row of pendingHolds) {
                holdsByEventId.set(row.eventId, row);
              }

              const plannedUpdates = expectedDateKeys.map((dateKey, index) => {
                const row = eventsByDate.get(dateKey);
                if (!row) return null;
                const hold = holdsByEventId.get(row.id);
                if (!hold) return null;

                const bookedRows = bookingsByEvent.get(row.id) ?? [];
                const usedSpotNumbers = new Set<number>();
                for (const booked of bookedRows) {
                  if (booked.spotNumber && booked.spotNumber > 0) {
                    usedSpotNumbers.add(booked.spotNumber);
                  }
                }
                let spotNumber = 1;
                while (usedSpotNumbers.has(spotNumber)) {
                  spotNumber += 1;
                }
                if (spotNumber > row.maxTrucks) {
                  return null;
                }

                // Ensure deterministic assignment for subsequent days in this loop.
                bookedRows.push({
                  eventId: row.id,
                  spotNumber,
                  bookingConfirmedAt: now,
                });
                bookingsByEvent.set(row.id, bookedRows);

                const hostCents = hostSplit[index] ?? 0;
                const feeCents = platformSplit[index] ?? 0;

                return {
                  id: hold.id,
                  eventId: row.id,
                  hostId: row.hostId,
                  maxTrucks: row.maxTrucks,
                  hostCents,
                  feeCents,
                  spotNumber,
                };
              });

              const filtered = plannedUpdates.filter(
                (row): row is NonNullable<(typeof plannedUpdates)[number]> =>
                  Boolean(row),
              );

              if (filtered.length !== expectedDateKeys.length) {
                await cancelWithCredit("parking_pass_overbook");
                break;
              }

              for (const update of filtered) {
                await db.transaction(async (tx: any) => {
                  await tx.execute(
                    sql`SELECT pg_advisory_xact_lock(hashtext(${`parking_pass_spot:${update.eventId}`}))`,
                  );

                  const confirmedRows = await tx
                    .select({ spotNumber: eventBookings.spotNumber })
                    .from(eventBookings)
                    .where(
                      and(
                        eq(eventBookings.eventId, update.eventId),
                        eq(eventBookings.status, "confirmed"),
                      ),
                    );

                  const usedSpotNumbers = new Set<number>();
                  for (const confirmed of confirmedRows) {
                    if (confirmed.spotNumber && confirmed.spotNumber > 0) {
                      usedSpotNumbers.add(confirmed.spotNumber);
                    }
                  }

                  let nextSpotNumber = 1;
                  while (usedSpotNumbers.has(nextSpotNumber)) {
                    nextSpotNumber += 1;
                  }

                  if (nextSpotNumber > update.maxTrucks) {
                    throw new Error("parking_pass_overbook");
                  }

                  await tx
                    .update(eventBookings)
                    .set({
                      eventId: update.eventId,
                      truckId,
                      hostId: eventRow.hostId,
                      hostPriceCents: update.hostCents,
                      platformFeeCents: update.feeCents,
                      totalCents: update.hostCents + update.feeCents,
                      status: "confirmed",
                      stripePaymentIntentId: paymentIntent.id,
                      stripePaymentStatus: "succeeded",
                      stripeApplicationFeeAmount: update.feeCents,
                      stripeTransferDestination:
                        host?.stripeConnectAccountId || null,
                      slotType: normalizedSlotTypes.join(","),
                      paidAt: now,
                      bookingConfirmedAt: now,
                      spotNumber: nextSpotNumber,
                      updatedAt: now,
                    })
                    .where(eq(eventBookings.id, update.id));
                });

                incrementNewlyConfirmed(update.eventId);

                if (update.hostCents > 0) {
                  earnedEntries.push({
                    hostId: update.hostId,
                    bookingId: update.id,
                    amountCents: update.hostCents,
                  });
                }
              }
              bookingConfirmed = true;
            } else {
              const bookingRows = expectedDateKeys.map((dateKey, index) => {
                const row = eventsByDate.get(dateKey);
                if (!row) return null;

                const hostCents = hostSplit[index] ?? 0;
                const feeCents = platformSplit[index] ?? 0;

                return {
                  eventId: row.id,
                  maxTrucks: row.maxTrucks,
                  truckId,
                  hostId: row.hostId,
                  hostPriceCents: hostCents,
                  platformFeeCents: feeCents,
                  totalCents: hostCents + feeCents,
                  status: "confirmed",
                  stripePaymentIntentId: paymentIntent.id,
                  stripePaymentStatus: "succeeded",
                  stripeApplicationFeeAmount: feeCents,
                  stripeTransferDestination:
                    host?.stripeConnectAccountId || null,
                  slotType: normalizedSlotTypes.join(","),
                  paidAt: now,
                  bookingConfirmedAt: now,
                };
              });

              const filteredRows = bookingRows.filter(
                (row): row is NonNullable<(typeof bookingRows)[number]> =>
                  Boolean(row),
              );

              if (filteredRows.length !== expectedDateKeys.length) {
                await cancelWithCredit("parking_pass_overbook");
                break;
              }

              const upsertedRows: Array<{
                id: string;
                eventId: string;
                hostId: string;
                hostPriceCents: number;
              }> = [];

              let hasUpsertFailure = false;
              for (const row of filteredRows) {
                try {
                  const result = await db.transaction(async (tx: any) => {
                    await tx.execute(
                      sql`SELECT pg_advisory_xact_lock(hashtext(${`parking_pass_spot:${row.eventId}`}))`,
                    );

                    const confirmedRows = await tx
                      .select({ spotNumber: eventBookings.spotNumber })
                      .from(eventBookings)
                      .where(
                        and(
                          eq(eventBookings.eventId, row.eventId),
                          eq(eventBookings.status, "confirmed"),
                        ),
                      );

                    const usedSpotNumbers = new Set<number>();
                    for (const confirmed of confirmedRows) {
                      if (confirmed.spotNumber && confirmed.spotNumber > 0) {
                        usedSpotNumbers.add(confirmed.spotNumber);
                      }
                    }

                    let nextSpotNumber = 1;
                    while (usedSpotNumbers.has(nextSpotNumber)) {
                      nextSpotNumber += 1;
                    }

                    if (nextSpotNumber > row.maxTrucks) {
                      throw new Error("parking_pass_overbook");
                    }

                    const [inserted] = await tx
                      .insert(eventBookings)
                      .values({
                        eventId: row.eventId,
                        truckId: row.truckId,
                        hostId: row.hostId,
                        hostPriceCents: row.hostPriceCents,
                        platformFeeCents: row.platformFeeCents,
                        totalCents: row.totalCents,
                        status: row.status,
                        stripePaymentIntentId: row.stripePaymentIntentId,
                        stripePaymentStatus: row.stripePaymentStatus,
                        stripeApplicationFeeAmount:
                          row.stripeApplicationFeeAmount,
                        stripeTransferDestination:
                          row.stripeTransferDestination,
                        slotType: row.slotType,
                        paidAt: row.paidAt,
                        bookingConfirmedAt: row.bookingConfirmedAt,
                        spotNumber: nextSpotNumber,
                      })
                      .onConflictDoNothing()
                      .returning({
                        id: eventBookings.id,
                        eventId: eventBookings.eventId,
                        hostId: eventBookings.hostId,
                        hostPriceCents: eventBookings.hostPriceCents,
                      });

                    if (inserted) {
                      return inserted;
                    }

                    const [existing] = await tx
                      .select({
                        id: eventBookings.id,
                        eventId: eventBookings.eventId,
                        hostId: eventBookings.hostId,
                        hostPriceCents: eventBookings.hostPriceCents,
                      })
                      .from(eventBookings)
                      .where(
                        and(
                          eq(eventBookings.eventId, row.eventId),
                          eq(eventBookings.truckId, truckId),
                          eq(
                            eventBookings.stripePaymentIntentId,
                            paymentIntent.id,
                          ),
                          eq(eventBookings.status, "confirmed"),
                        ),
                      )
                      .limit(1);

                    if (!existing) {
                      throw new Error("parking_pass_duplicate");
                    }

                    return existing;
                  });

                  upsertedRows.push(result);
                } catch (upsertError: any) {
                  const reason = String(
                    upsertError?.message || "parking_pass_duplicate",
                  );
                  await cancelWithCredit(
                    reason === "parking_pass_overbook"
                      ? "parking_pass_overbook"
                      : "parking_pass_duplicate",
                  );
                  hasUpsertFailure = true;
                  break;
                }
              }

              if (hasUpsertFailure) {
                break;
              }

              bookingConfirmed =
                upsertedRows.length === expectedDateKeys.length;
              for (const row of upsertedRows) {
                incrementNewlyConfirmed(row.eventId);
                if (Number(row.hostPriceCents || 0) > 0) {
                  earnedEntries.push({
                    hostId: row.hostId,
                    bookingId: row.id,
                    amountCents: Number(row.hostPriceCents || 0),
                  });
                }
              }
            }

            if (bookingConfirmed) {
              try {
                const { recordHostBookingEarnings } =
                  await import("../hostEarningsService");
                await recordHostBookingEarnings(
                  earnedEntries.map((entry) => ({
                    ...entry,
                    stripePaymentIntentId: paymentIntent.id,
                  })),
                );
              } catch (ledgerError) {
                console.error(
                  "[WEBHOOK] Error recording host earnings ledger entries:",
                  ledgerError,
                );
                throw ledgerError;
              }

              try {
                const truck = await storage.getRestaurant(truckId);
                const owner = truck
                  ? await storage.getUser(truck.ownerId)
                  : null;
                const endDateKey =
                  expectedDateKeys[expectedDateKeys.length - 1] || startDateKey;
                if (owner?.email) {
                  await emailService.sendBookingConfirmationEmail({
                    to: owner.email,
                    hostName: host?.businessName || "Host location",
                    startDate: startDateKey,
                    endDate: endDateKey,
                    slotSummary: normalizedSlotTypes.join(", "),
                    totalCents: amountCents,
                  });
                }
                // Also notify the host
                if (host?.userId) {
                  const hostUser = await storage.getUser(host.userId);
                  if (hostUser?.email) {
                    await emailService.sendHostBookingNotification({
                      to: hostUser.email,
                      hostName: host.businessName || "Your location",
                      truckName: truck?.name || "A food truck",
                      startDate: startDateKey,
                      endDate: endDateKey,
                      slotSummary:
                        normalizedSlotTypes.length > 0
                          ? normalizedSlotTypes.join(", ")
                          : undefined,
                      totalCents: amountCents,
                    });
                  }
                }

                // Best-effort: mark one-time booking-fee promo as redeemed.
                try {
                  const promoCode = String(metadata.bookingPromoCode || "")
                    .trim()
                    .toUpperCase();
                  if (promoCode === "BOOKFEE10") {
                    const explicitUserId = String(metadata.userId || "").trim();
                    const promoUserId = explicitUserId || owner?.id || "";
                    if (promoUserId) {
                      const userRecord = await storage.getUser(promoUserId);
                      const settings =
                        (userRecord?.accountSettings as any) || {};
                      const promos = settings.promos || {};
                      const bookingFee10 = promos.bookingFee10 || {};
                      promos.bookingFee10 = {
                        ...bookingFee10,
                        redeemedAt: now.toISOString(),
                        redeemedPaymentIntentId: paymentIntent.id,
                        discountCents: Number(
                          metadata.bookingPromoDiscountCents || 0,
                        ),
                        pendingPaymentIntentId: null,
                        pendingAt: null,
                      };
                      await storage.updateUser(promoUserId, {
                        accountSettings: { ...settings, promos } as any,
                      });
                    }
                  }
                } catch (promoError) {
                  console.error(
                    "[WEBHOOK] Error persisting booking promo redemption:",
                    promoError,
                  );
                }
              } catch (emailError) {
                console.error(
                  "[WEBHOOK] Error sending booking confirmation:",
                  emailError,
                );
              }
            }

            await reconcileCommittedCreditDebit();

            try {
              const [truckOwner] = await db
                .select({ ownerId: restaurants.ownerId })
                .from(restaurants)
                .where(eq(restaurants.id, truckId));

              if (host?.userId && truckOwner?.ownerId) {
                const { createAffiliateCommissionsForBooking } =
                  await import("../affiliateCommissionService");
                await createAffiliateCommissionsForBooking({
                  hostOwnerId: host.userId,
                  truckOwnerId: truckOwner.ownerId,
                  platformFeeCents,
                  paymentIntentId: paymentIntent.id,
                  truckRestaurantId: truckId,
                });
              }
            } catch (commissionError) {
              console.error(
                "[WEBHOOK] Error processing booking affiliate commissions:",
                commissionError,
              );
            }

            const affectedEventIds = Array.from(
              new Set(
                expectedDateKeys
                  .map((dateKey) => eventsByDate.get(dateKey)?.id)
                  .filter((id): id is string => Boolean(id)),
              ),
            );
            if (affectedEventIds.length === 0) {
              affectedEventIds.push(passId);
            }

            const maxTrucksByEventId = new Map<string, number>();
            const bookingEventsById = new Map<
              string,
              (typeof bookingEvents)[number]
            >();
            for (const row of bookingEvents) {
              maxTrucksByEventId.set(row.id, row.maxTrucks ?? 1);
              bookingEventsById.set(row.id, row);
            }

            const countRows =
              affectedEventIds.length > 0
                ? await db
                    .select({
                      eventId: eventBookings.eventId,
                      count: sql<number>`count(*)`,
                    })
                    .from(eventBookings)
                    .where(inArray(eventBookings.eventId, affectedEventIds))
                    .where(inArray(eventBookings.status, ["confirmed"]))
                    .groupBy(eventBookings.eventId)
                : [];

            const confirmedByEventId = new Map<string, number>();
            for (const row of countRows) {
              confirmedByEventId.set(row.eventId, Number(row.count || 0));
            }

            for (const eventId of affectedEventIds) {
              const confirmedCount = confirmedByEventId.get(eventId) ?? 0;
              const maxTrucks = maxTrucksByEventId.get(eventId) ?? 1;
              const newlyConfirmed = newlyConfirmedByEventId.get(eventId) ?? 0;
              const previousCount = Math.max(
                0,
                confirmedCount - newlyConfirmed,
              );
              const previousFillRate =
                maxTrucks > 0 ? previousCount / maxTrucks : 0;
              const currentFillRate =
                maxTrucks > 0 ? confirmedCount / maxTrucks : 0;
              const crossedWarningThreshold =
                previousFillRate < 0.8 && currentFillRate >= 0.8;
              const crossedFullThreshold =
                previousCount < maxTrucks && confirmedCount >= maxTrucks;
              const newStatus = confirmedCount >= maxTrucks ? "filled" : "open";

              if (crossedWarningThreshold || crossedFullThreshold) {
                const eventRowForNotify = bookingEventsById.get(eventId);
                if (eventRowForNotify) {
                  try {
                    await notifyHostCapacityWarning({
                      hostId: eventRowForNotify.hostId,
                      eventId,
                      eventStartDate: eventRowForNotify.date ?? null,
                      confirmedCount,
                      maxTrucks,
                    });
                  } catch (notifyError) {
                    console.error(
                      "[WEBHOOK] Error sending host capacity warning:",
                      notifyError,
                    );
                  }
                }
              }

              await db
                .update(events)
                .set({
                  status: newStatus,
                  bookedRestaurantId: null,
                })
                .where(eq(events.id, eventId));
            }
          } catch (error) {
            console.error("[WEBHOOK] Error confirming booking:", error);
            throw error;
          }
          break;

        case "charge.dispute.created":
        case "charge.dispute.updated":
        case "charge.dispute.closed": {
          const webhookDispute = event.data.object as Stripe.Dispute;
          if (!stripe) {
            throw new Error(
              `Stripe client unavailable for dispute ${webhookDispute.id}`,
            );
          }
          const dispute = await retrieveAuthoritativePickupOrderDispute({
            stripe,
            webhookDispute,
          });
          const disputedPaymentIntentId = pickupDisputePaymentIntentId(dispute);
          if (!disputedPaymentIntentId) {
            throw new Error(
              `Stripe dispute ${dispute.id} has no PaymentIntent binding`,
            );
          }
          const { pickupOrders } = await import("@shared/schema");
          const [candidate] = await db
            .select({ id: pickupOrders.id })
            .from(pickupOrders)
            .where(
              or(
                eq(pickupOrders.stripeDisputeId, dispute.id),
                eq(pickupOrders.stripePaymentIntentId, disputedPaymentIntentId),
              ),
            )
            .limit(1);
          if (!candidate) {
            console.warn(
              `[WEBHOOK] No pickup order matches Stripe dispute ${dispute.id}`,
            );
            break;
          }
          let reconciled = await reconcilePickupOrderDispute({
            orderId: candidate.id,
            dispute,
            stripe,
          });
          let shouldNotifyCancellation = reconciled.status === "cancelled";
          if (reconciled.status === "cancellation_pending") {
            const cancellation =
              await requestAndFinalizeCardPickupOrderCancellation({
                orderId: reconciled.id,
                expectedStatuses: ["cancellation_pending"],
                cancellationReason:
                  reconciled.cancellationReason ||
                  "Payment dispute resolution requires cancellation",
                stripe,
              });
            if (cancellation.outcome === "conflict") {
              throw new Error(
                `Pickup order ${reconciled.id} changed during post-dispute cancellation`,
              );
            }
            reconciled = cancellation.order;
            shouldNotifyCancellation = cancellation.outcome === "cancelled";
          }
          if (shouldNotifyCancellation) {
            const { sendPickupOrderCancelledNotification } =
              await import("../services/pickupOrderNotificationService");
            await sendPickupOrderCancelledNotification(reconciled);
          }
          const { getWebSocketServer } = await import("../websocket");
          getWebSocketServer()
            ?.to(`kitchen:${reconciled.restaurantId}`)
            .emit("kitchen:order_update", {
              order: reconciled as Record<string, unknown>,
            });
          break;
        }

        case "refund.created":
        case "refund.updated":
        case "refund.failed":
        case "charge.refund.updated": {
          const refund = event.data.object as Stripe.Refund;
          const pickupOrderId = String(
            refund.metadata?.pickupOrderId || "",
          ).trim();
          const refundPaymentIntent = refund.payment_intent;
          const refundPaymentIntentId =
            typeof refundPaymentIntent === "string"
              ? refundPaymentIntent
              : String(refundPaymentIntent?.id || "").trim();
          if (!stripe) {
            throw new Error(
              `Stripe client unavailable for refund ${refund.id}`,
            );
          }
          const { pickupOrders } = await import("@shared/schema");
          const trackedOrder = await db.transaction(async (tx: any) => {
            let [candidate] = await tx
              .select({ id: pickupOrders.id })
              .from(pickupOrders)
              .where(eq(pickupOrders.stripeRefundId, refund.id))
              .limit(1);
            if (!candidate && pickupOrderId) {
              [candidate] = await tx
                .select({ id: pickupOrders.id })
                .from(pickupOrders)
                .where(eq(pickupOrders.id, pickupOrderId))
                .limit(1);
            }
            if (!candidate && refundPaymentIntentId) {
              [candidate] = await tx
                .select({ id: pickupOrders.id })
                .from(pickupOrders)
                .where(
                  and(
                    eq(
                      pickupOrders.stripePaymentIntentId,
                      refundPaymentIntentId,
                    ),
                    inArray(pickupOrders.status, [
                      "pending",
                      "confirmed",
                      "preparing",
                      "ready",
                      "cancellation_pending",
                      "cancelled",
                      "completed",
                    ]),
                  ),
                )
                .limit(1);
            }
            if (!candidate) return null;
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtext(${pickupOrderFinancialLockKey(candidate.id)}))`,
            );
            const [current] = await tx
              .select()
              .from(pickupOrders)
              .where(eq(pickupOrders.id, candidate.id))
              .limit(1);
            if (!current) return null;
            if (
              ![
                "pending",
                "confirmed",
                "preparing",
                "ready",
                "cancellation_pending",
                "cancelled",
                "completed",
              ].includes(String(current.status || "")) ||
              !isPickupRefundFromOrder(
                refund,
                current.stripePaymentIntentId,
                current.totalCents,
              )
            ) {
              console.warn(
                `[WEBHOOK] Pickup order ${current.id} ignored unbound refund ${refund.id}`,
              );
              return null;
            }
            const refundSummary = await summarizePickupOrderRefunds({
              stripe,
              paymentIntentId: current.stripePaymentIntentId,
              totalCents: current.totalCents,
            });
            if (
              !refundSummary.refunds.some(
                (listedRefund) => listedRefund.id === refund.id,
              )
            ) {
              throw new Error(
                `Stripe refund ${refund.id} was not present in the authoritative PaymentIntent refund list.`,
              );
            }
            const latestRefund = refundSummary.latestRefund || refund;
            const latestRefundStatus = String(latestRefund.status || "unknown");
            const aggregateRefundStatus =
              derivePickupOrderAggregateRefundStatus({
                totalCents: current.totalCents,
                succeededAmountCents: refundSummary.succeededAmountCents,
                pendingAmountCents: refundSummary.pendingAmountCents,
                latestRefundStatus,
              });
            const aggregateRefundFailed = [
              "failed",
              "canceled",
              "reconciliation_required",
            ].includes(aggregateRefundStatus);
            const shouldEnterCancellation = shouldPickupRefundEnterCancellation(
              current.status,
              aggregateRefundStatus,
            );
            const [updated] = await tx
              .update(pickupOrders)
              .set({
                status: shouldEnterCancellation
                  ? "cancellation_pending"
                  : current.status,
                cancellationReason: shouldEnterCancellation
                  ? current.cancellationReason ||
                    "Card payment was refunded in Stripe"
                  : current.cancellationReason,
                stripeRefundId: latestRefund.id,
                stripeRefundStatus: aggregateRefundStatus,
                stripeRefundAmountCents: refundSummary.succeededAmountCents,
                refundFailureReason:
                  String(
                    (
                      latestRefund as Stripe.Refund & {
                        failure_reason?: string | null;
                      }
                    ).failure_reason || "",
                  ).trim() || null,
                refundUpdatedAt: new Date(),
                payoutStatus:
                  current.status === "cancelled"
                    ? current.payoutStatus
                    : current.status === "completed" && aggregateRefundFailed
                      ? current.payoutStatus
                      : aggregateRefundFailed
                        ? "failed"
                        : PICKUP_ORDER_PAYOUT_REVERSAL_PENDING,
                updatedAt: new Date(),
              })
              .where(eq(pickupOrders.id, current.id))
              .returning();
            return updated || current;
          });

          if (!trackedOrder) break;
          if (trackedOrder.status === "cancellation_pending") {
            const result = await requestAndFinalizeCardPickupOrderCancellation({
              orderId: trackedOrder.id,
              expectedStatuses: ["cancellation_pending"],
              cancellationReason:
                trackedOrder.cancellationReason || "Order cancelled",
              stripe,
            });
            if (result.outcome === "cancelled") {
              const { sendPickupOrderCancelledNotification } =
                await import("../services/pickupOrderNotificationService");
              await sendPickupOrderCancelledNotification(result.order);
              const { getWebSocketServer } = await import("../websocket");
              getWebSocketServer()
                ?.to(`kitchen:${result.order.restaurantId}`)
                .emit("kitchen:order_update", {
                  order: result.order as Record<string, unknown>,
                });
            }
          } else if (trackedOrder.status === "completed") {
            await reconcileCompletedPickupOrderRefund({
              orderId: trackedOrder.id,
              stripe,
            });
          } else if (["failed", "canceled"].includes(String(refund.status))) {
            console.error(
              `[WEBHOOK] Refund ${refund.id} failed for pickup order ${trackedOrder.id}; owner reconciliation is required`,
            );
          }
          break;
        }

        case "payment_intent.payment_failed":
          const failedIntent = event.data.object;
          console.log(`[WEBHOOK] PaymentIntent ${failedIntent.id} failed`);

          try {
            const { eventBookings, pickupOrders } =
              await import("@shared/schema");
            const metadata = (failedIntent as any).metadata || {};

            // Pickup order payment failure
            const pickupOrderId = String(
              metadata.pickupOrderId || metadata.orderId || "",
            ).trim();
            if (pickupOrderId) {
              try {
                await db.transaction(async (tx: any) => {
                  await tx.execute(
                    sql`select pg_advisory_xact_lock(hashtext(${pickupOrderFinancialLockKey(pickupOrderId)}))`,
                  );
                  const [order] = await tx
                    .select()
                    .from(pickupOrders)
                    .where(eq(pickupOrders.id, pickupOrderId))
                    .limit(1);
                  if (!order) {
                    throw new Error(
                      `Pickup order ${pickupOrderId} not found for failed PaymentIntent ${failedIntent.id}`,
                    );
                  }
                  const storedIntentId = String(
                    order.stripePaymentIntentId || "",
                  ).trim();
                  if (storedIntentId && storedIntentId !== failedIntent.id) {
                    console.warn(
                      `[WEBHOOK] Pickup order ${pickupOrderId} ignored failed PaymentIntent ${failedIntent.id}; expected ${storedIntentId}`,
                    );
                    return;
                  }
                  // A PaymentIntent can fail one confirmation attempt and later
                  // succeed on the same checkout. Keep the order and its
                  // reservation pending until the bounded expiry saga cancels
                  // the intent; a delayed succeeded event can then safely use
                  // the normal settlement path.
                  if (order.status !== "pending") {
                    console.log(
                      `[WEBHOOK] Pickup order ${order.id} ignored payment failure after leaving pending state`,
                    );
                    return;
                  }
                  if (!storedIntentId) {
                    await tx
                      .update(pickupOrders)
                      .set({
                        stripePaymentIntentId: failedIntent.id,
                        stripeTransferGroupId:
                          String(failedIntent.transfer_group || "").trim() ||
                          order.stripeTransferGroupId,
                        updatedAt: new Date(),
                      })
                      .where(
                        and(
                          eq(pickupOrders.id, order.id),
                          eq(pickupOrders.status, "pending"),
                          isNull(pickupOrders.stripePaymentIntentId),
                        ),
                      );
                  }
                });
              } catch (pickupError) {
                console.error(
                  "[WEBHOOK] Pickup order failure update failed:",
                  pickupError,
                );
                throw pickupError;
              }
              break;
            }

            // Supplier marketplace order payment failure
            const supplierOrderId = metadata.supplierOrderId;
            if (supplierOrderId) {
              try {
                const { supplierOrders } = await import("@shared/schema");
                const [order] = await db
                  .select()
                  .from(supplierOrders)
                  .where(eq(supplierOrders.id, String(supplierOrderId)))
                  .limit(1);
                if (order) {
                  const storedIntentId = String(
                    (order as any).stripePaymentIntentId || "",
                  ).trim();
                  if (storedIntentId && storedIntentId !== failedIntent.id) {
                    console.warn(
                      `[WEBHOOK] Supplier order ${supplierOrderId} ignored failed PaymentIntent ${failedIntent.id}; expected ${storedIntentId}`,
                    );
                    break;
                  }
                  // Stripe may deliver events out of order. Never let an older
                  // failure event regress an order that a succeeded event has
                  // already marked paid.
                  if (String((order as any).paymentStatus || "") !== "paid") {
                    await db
                      .update(supplierOrders)
                      .set({
                        paymentStatus: "unpaid",
                        stripePaymentIntentId:
                          storedIntentId || failedIntent.id,
                        updatedAt: new Date(),
                      } as any)
                      .where(eq(supplierOrders.id, String(supplierOrderId)));
                  }
                } else {
                  throw new Error(
                    `Supplier order ${supplierOrderId} not found for failed PaymentIntent ${failedIntent.id}`,
                  );
                }
              } catch (supplierError) {
                console.error(
                  "[WEBHOOK] Supplier order failure update failed:",
                  supplierError,
                );
                throw supplierError;
              }
              break;
            }

            await db
              .update(eventBookings)
              .set({
                status: "cancelled",
                stripePaymentStatus: "failed",
                cancellationReason: "Payment failed",
                cancelledAt: new Date(),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(eventBookings.stripePaymentIntentId, failedIntent.id),
                  inArray(eventBookings.status, ["pending"]),
                ),
              );
          } catch (error) {
            console.error("[WEBHOOK] Error updating failed booking:", error);
            throw error;
          }
          break;

        case "customer.subscription.updated": {
          const subscriptionUpdated = event.data.object;
          const eventCreatedAt = new Date(Number(event.created) * 1000);
          const terminalLegacyStatus = [
            "canceled",
            "incomplete_expired",
          ].includes(String(subscriptionUpdated.status || ""));
          if (terminalLegacyStatus) {
            await retireLegacyProfileSubscription(
              subscriptionUpdated.id,
              event.id,
              eventCreatedAt,
              getSubscriptionCustomerId(subscriptionUpdated.customer),
            );
          } else {
            await recordLegacyProfileSubscriptionEvent({
              subscriptionId: subscriptionUpdated.id,
              eventId: event.id,
              eventCreatedAt,
            });
            console.warn(
              `[WEBHOOK] Legacy profile subscription ${subscriptionUpdated.id} changed to ${subscriptionUpdated.status}; no automatic cancellation or access change was made`,
            );
          }
          break;
        }

        case "customer.subscription.deleted": {
          const subscriptionDeleted = event.data.object;
          await retireLegacyProfileSubscription(
            subscriptionDeleted.id,
            event.id,
            new Date(Number(event.created) * 1000),
            getSubscriptionCustomerId(subscriptionDeleted.customer),
          );
          break;
        }

        case "account.updated": {
          const account = event.data.object as Stripe.Account;
          const accountId = String(account.id || "").trim();
          if (!accountId) break;

          const status =
            account.charges_enabled &&
            account.payouts_enabled &&
            account.details_submitted
              ? "active"
              : "pending";
          const updateValues = {
            stripeChargesEnabled: Boolean(account.charges_enabled),
            stripePayoutsEnabled: Boolean(account.payouts_enabled),
            stripeOnboardingCompleted: Boolean(account.details_submitted),
            stripeConnectStatus: status,
            updatedAt: new Date(),
          };

          const hostUpdate = await db
            .update(hosts)
            .set(updateValues)
            .where(eq(hosts.stripeConnectAccountId, accountId));

          const supplierUpdate = await db
            .update(suppliers)
            .set(updateValues)
            .where(eq(suppliers.stripeConnectAccountId, accountId));

          const restaurantUpdate = await db
            .update(restaurants)
            .set(updateValues)
            .where(eq(restaurants.stripeConnectAccountId, accountId));

          const hostRows = Number(
            (hostUpdate as { rowCount?: number })?.rowCount || 0,
          );
          const supplierRows = Number(
            (supplierUpdate as { rowCount?: number })?.rowCount || 0,
          );
          const restaurantRows = Number(
            (restaurantUpdate as { rowCount?: number })?.rowCount || 0,
          );
          console.log(
            `[WEBHOOK] Synced Stripe account ${accountId} (hosts: ${hostRows}, suppliers: ${supplierRows}, restaurants: ${restaurantRows})`,
          );
          break;
        }

        case "account.application.deauthorized": {
          const accountId = String(event.account || "").trim();
          if (!accountId) break;

          const revokedValues = {
            stripeConnectStatus: "revoked",
            stripeOnboardingCompleted: false,
            stripeChargesEnabled: false,
            stripePayoutsEnabled: false,
            updatedAt: new Date(),
          };

          const hostUpdate = await db
            .update(hosts)
            .set(revokedValues)
            .where(eq(hosts.stripeConnectAccountId, accountId));

          const supplierUpdate = await db
            .update(suppliers)
            .set(revokedValues)
            .where(eq(suppliers.stripeConnectAccountId, accountId));

          const restaurantUpdate = await db
            .update(restaurants)
            .set({ ...revokedValues, stripeConnectAccountId: null })
            .where(eq(restaurants.stripeConnectAccountId, accountId));

          const hostRows = Number(
            (hostUpdate as { rowCount?: number })?.rowCount || 0,
          );
          const supplierRows = Number(
            (supplierUpdate as { rowCount?: number })?.rowCount || 0,
          );
          const restaurantRows = Number(
            (restaurantUpdate as { rowCount?: number })?.rowCount || 0,
          );
          console.log(
            `[WEBHOOK] Deauthorized Stripe account ${accountId} (hosts: ${hostRows}, suppliers: ${supplierRows}, restaurants: ${restaurantRows})`,
          );
          break;
        }

        default:
          console.log(`[WEBHOOK] Unhandled event type: ${event.type}`);
      }

      res.json({ received: true });
    } catch (error) {
      console.error("[WEBHOOK] Error processing webhook:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });
}
