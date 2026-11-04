/**
 * pickupOrderRoutes.ts
 * Online ordering for the verified pickup + card fulfillment cohort.
 *
 * Payment model:
 *   - MealScout collects the full order amount (subtotal + customer fees) via
 *     MealScout's own Stripe account.
 *   - After payment confirms (Stripe webhook), MealScout transfers subtotal to
 *     the business's Stripe Connect account.
 *   - By default customers pay Stripe processing plus the $1 MealScout fee.
 *   - If the business toggles `hidePlatformFee`, the fee is presented as $0 to
 *     the customer (absorbed by the business). The combined fee transfer
 *     reduction is reflected internally.
 *
 * WebSocket kitchen queue:
 *   - When order status changes a `kitchen:order_update` event is emitted to the
 *     room `kitchen:{restaurantId}`.
 *   - The kitchen display page subscribes to this room on connect.
 */

import type { Express } from "express";
import { z } from "zod";
import Stripe from "stripe";
import { db } from "../db";
import {
  menus,
  menuCategories,
  menuItems,
  menuItemVariants,
  menuItemModifiers,
  pickupOrders,
  pickupOrderItems,
  restaurants,
  telemetryEvents,
  ORDER_STATUS,
  LISA_CLAIM_TYPES,
  LISA_CLAIM_SOURCES,
  lisaClaims,
  type PickupOrder,
  type PickupOrderItem,
  type MenuItem,
  type MenuItemVariant,
  type MenuItemModifier,
} from "@shared/schema";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { isAuthenticated } from "../unifiedAuth";
import { isAdminUserType } from "../roleAccess";
import { storage } from "../storage";
import { distributedRateLimit } from "../middleware/distributedRateLimit";
import { getWebSocketServer } from "../websocket";
import {
  consumePromotionAttribution,
  updatePromotedOrderCommissionStatus,
} from "../services/merchantPromotionService";
import { buildPublicTruckOperatingPlan } from "../services/truckOperatingPlan";
import {
  sendPickupOrderCancelledNotification,
  sendPickupOrderConfirmedNotifications,
  sendPickupOrderReadyNotifications,
} from "../services/pickupOrderNotificationService";
import {
  cleanupPendingPickupOrderAfterPaymentSetupFailure,
  restoreTrackedInventoryForPickupOrderByOrderId,
  reserveTrackedInventoryForPickupOrder,
} from "../services/pickupInventoryService";
import {
  calculateAuthoritativeMerchantDeliveryTotals,
  customerAccessTokenMatches,
  hashCustomerAccessToken,
  projectOrderForCustomer,
  projectPickupOrderItemsForCustomer,
} from "../services/merchantDeliverySafety";
import { loadAuthoritativePickupOrderItems } from "../services/pickupOrderIdentityService";
import { requestAndFinalizeCardPickupOrderCancellation } from "../services/pickupOrderCancellationService";
import {
  isPickupPaymentIntentCheckoutBound,
  isPickupPaymentIntentSettlementBound,
  isPickupOrderPaymentExpired,
  PICKUP_ORDER_ACKNOWLEDGEMENT_EXPIRED_REASON,
  PICKUP_ORDER_CONTRACT_VERSION,
  PICKUP_ORDER_PAYMENT_EXPIRED_REASON,
} from "../services/pickupOrderPaymentReconciliation";
import { pickupOrderFinancialLockKey } from "../utils/pickupOrderFinancialLock";
import { buildOrderingReadiness } from "./menuRoutes";
import { normalizeOrderContactPhone } from "@shared/orderContact";
import {
  isMenuItemCategoryOrderable,
  isPickupOrderItemAvailableForExistingReservation,
} from "../services/restaurantOrderingEligibility";
import { isPendingPickupCheckoutReplayReady } from "../services/pickupCheckoutReplayPolicy";
import { isRestaurantOrderingAuthorityVersionCurrent } from "../services/restaurantOrderingAuthorityVersion";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const PICKUP_ORDER_MEALSCOUT_FEE_CENTS = Math.max(
  0,
  Number(process.env.PICKUP_ORDER_MEALSCOUT_FEE_CENTS || 100) || 100,
);
const PICKUP_ORDER_STRIPE_FEE_BPS = Math.max(
  0,
  Number(process.env.PICKUP_ORDER_STRIPE_FEE_BPS || 290) || 290,
);
const PICKUP_ORDER_STRIPE_FEE_FIXED_CENTS = Math.max(
  0,
  Number(process.env.PICKUP_ORDER_STRIPE_FEE_FIXED_CENTS || 30) || 30,
);
const MAX_PICKUP_ORDER_TOTAL_CENTS = 1_000_000;
const MAX_PICKUP_ORDER_UNITS = 20;
const MIN_CARD_CHARGE_CENTS = 50;

function estimateStripeFeeCents(chargeAmountCents: number): number {
  if (!Number.isFinite(chargeAmountCents) || chargeAmountCents <= 0) return 0;
  return Math.max(
    0,
    Math.ceil(
      (chargeAmountCents * PICKUP_ORDER_STRIPE_FEE_BPS) / 10_000 +
        PICKUP_ORDER_STRIPE_FEE_FIXED_CENTS,
    ),
  );
}

async function revalidatePendingPickupCheckoutReplay(
  order: PickupOrder,
): Promise<{ ok: boolean; menuId: string | null; blockingReasons: string[] }> {
  const orderLines: any[] = await db
    .select({
      menuItemId: menuItems.id,
      menuId: menuItems.menuId,
      categoryId: menuItems.categoryId,
      categoryActive: menuCategories.isActive,
      isAvailable: menuItems.isAvailable,
      trackInventory: menuItems.trackInventory,
      inventoryQty: menuItems.inventoryQty,
      inventoryAutoUnavailable: menuItems.inventoryAutoUnavailable,
      inventoryReservedQuantity: pickupOrderItems.inventoryReservedQuantity,
      priceCents: menuItems.priceCents,
      availableFrom: menuItems.availableFrom,
      availableTo: menuItems.availableTo,
    })
    .from(pickupOrderItems)
    .leftJoin(menuItems, eq(menuItems.id, pickupOrderItems.menuItemId))
    .leftJoin(
      menuCategories,
      and(
        eq(menuCategories.id, menuItems.categoryId),
        eq(menuCategories.menuId, menuItems.menuId),
        eq(menuCategories.restaurantId, menuItems.restaurantId),
      ),
    )
    .where(eq(pickupOrderItems.orderId, order.id));
  const menuIds = new Set<string>(
    orderLines.map((line) => String(line.menuId || "").trim()).filter(Boolean),
  );
  const menuId: string | null = menuIds.size === 1 ? [...menuIds][0] : null;
  const allItemsStillAvailable = Boolean(
    menuId &&
    orderLines.length > 0 &&
    orderLines.every(
      (line) =>
        String(line.menuId || "").trim() === menuId &&
        isPickupOrderItemAvailableForExistingReservation(line) &&
        Number.isInteger(line.priceCents) &&
        Number(line.priceCents) >= 0 &&
        !String(line.availableFrom || "").trim() &&
        !String(line.availableTo || "").trim() &&
        isMenuItemCategoryOrderable(line),
    ),
  );
  if (!menuId || !allItemsStillAvailable) {
    return {
      ok: false,
      menuId,
      blockingReasons: ["The original checkout items are no longer orderable"],
    };
  }

  const readiness = await buildOrderingReadiness(order.restaurantId, menuId, {
    includeSettlementIdentity: true,
    existingReservedMenuItemIds: orderLines
      .filter((line) => Number(line.inventoryReservedQuantity || 0) > 0)
      .map((line) => String(line.menuItemId || "").trim())
      .filter(Boolean),
  });
  return {
    ok: isPendingPickupCheckoutReplayReady({
      order,
      menuId,
      allItemsStillAvailable,
      readiness,
    }),
    menuId,
    blockingReasons: readiness.blockingReasons,
  };
}

function grossUpStripeProcessingFeeCents(
  baseBeforeProcessingCents: number,
): number {
  if (
    !Number.isFinite(baseBeforeProcessingCents) ||
    baseBeforeProcessingCents <= 0
  ) {
    return 0;
  }
  const denominator = 10_000 - PICKUP_ORDER_STRIPE_FEE_BPS;
  if (denominator <= 0) {
    return estimateStripeFeeCents(baseBeforeProcessingCents);
  }
  const grossChargeCents = Math.ceil(
    ((baseBeforeProcessingCents + PICKUP_ORDER_STRIPE_FEE_FIXED_CENTS) *
      10_000) /
      denominator,
  );
  return Math.max(0, grossChargeCents - baseBeforeProcessingCents);
}

function computePickupOrderFees(
  subtotalCents: number,
  paymentMethod: "card" | "cash",
  feePaidByBusiness: boolean,
) {
  const cleanSubtotal = Math.max(0, Math.round(Number(subtotalCents || 0)));
  const mealscoutFeeCents =
    paymentMethod === "card" ? PICKUP_ORDER_MEALSCOUT_FEE_CENTS : 0;
  const processingFeeCents =
    paymentMethod === "card"
      ? feePaidByBusiness
        ? estimateStripeFeeCents(cleanSubtotal)
        : grossUpStripeProcessingFeeCents(cleanSubtotal + mealscoutFeeCents)
      : 0;
  const platformFeeCents = mealscoutFeeCents + processingFeeCents;
  const totalCents = feePaidByBusiness
    ? cleanSubtotal
    : cleanSubtotal + platformFeeCents;

  return {
    mealscoutFeeCents,
    processingFeeCents,
    platformFeeCents,
    totalCents,
  };
}

// ── Rate limiting ──────────────────────────────────────────────────────────────
const createOrderLimiter = distributedRateLimit({
  scope: "pickup_orders_create",
  limit: 5,
  windowMs: 15 * 60 * 1000,
  key: (req) => {
    const principal = String((req as any)?.user?.id || req.ip || "unknown");
    const restaurantId = String((req as any)?.body?.restaurantId || "unknown")
      .trim()
      .slice(0, 100);
    return `${principal}:${restaurantId}`;
  },
});

const totalsPreviewLimiter = distributedRateLimit({
  scope: "pickup_orders_totals_preview",
  limit: 60,
  windowMs: 15 * 60 * 1000,
  key: (req) => {
    const principal = String((req as any)?.user?.id || req.ip || "unknown");
    const restaurantId = String((req as any)?.body?.restaurantId || "unknown")
      .trim()
      .slice(0, 100);
    return `${principal}:${restaurantId}`;
  },
});

// ── Error wrapper ─────────────────────────────────────────────────────────────
function wrap(handler: (req: any, res: any) => Promise<void>) {
  return async (req: any, res: any) => {
    try {
      await handler(req, res);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      const message = err?.message || "Internal server error";
      if (status === 500) console.error("[pickupOrderRoutes]", err);
      res.status(status).json({ message });
    }
  };
}

// ── Ownership helper ──────────────────────────────────────────────────────────
async function assertOwnsRestaurant(userId: string, restaurantId: string) {
  const ok = await storage.verifyRestaurantOwnership(restaurantId, userId);
  if (!ok)
    throw Object.assign(new Error("Not authorized"), { statusCode: 403 });
}

async function assertCanManageRestaurantOrders(
  user: any,
  restaurantId: string,
) {
  if (isAdminUserType(user?.userType)) return;
  if (
    !["restaurant_owner", "food_truck"].includes(String(user?.userType || ""))
  ) {
    throw Object.assign(new Error("Restaurant owner access required"), {
      statusCode: 403,
    });
  }
  await assertOwnsRestaurant(user.id, restaurantId);
}

async function assertOrderingWorkspaceAccess(user: any, restaurantId: string) {
  await assertCanManageRestaurantOrders(user, restaurantId);
}

// ── Calculate line total ──────────────────────────────────────────────────────
function calcLineTotal(
  basePriceCents: number,
  variantAddCents: number,
  modifierAddCents: number,
  qty: number,
): number {
  return (basePriceCents + variantAddCents + modifierAddCents) * qty;
}

// ── WebSocket emitter helper ──────────────────────────────────────────────────
function emitKitchenUpdate(restaurantId: string, order: any) {
  const io = getWebSocketServer();
  if (io) {
    io.to(`kitchen:${restaurantId}`).emit("kitchen:order_update", { order });
  }
}

export function registerPickupOrderRoutes(app: Express) {
  // ── ─────────────────────────────────────────────────────────────────────────
  // CUSTOMER: Create order + payment intent
  // ── ─────────────────────────────────────────────────────────────────────────

  /**
   * POST /api/pickup-orders
   * Body:
   * {
   *   restaurantId, menuId,
   *   customerName, customerEmail?, customerPhone?,
   *   orderType: 'pickup',
   *   paymentMethod: 'card',
   *   items: [{ menuItemId, quantity, selectedVariantId?, selectedModifierIds?: string[], specialInstructions? }],
   *   specialInstructions?,
   *   checkoutRequestId, customerAccessToken,
   *   scheduledFor?   // currently rejected; ordering is ASAP-only
   * }
   *
   * Response:
   *   { order, clientSecret }
   */
  app.post(
    "/api/pickup-orders",
    createOrderLimiter,
    wrap(async (req, res) => {
      const bodySchema = z.object({
        restaurantId: z.string().min(1),
        menuId: z.string().min(1),
        customerName: z.string().min(1).max(100),
        customerEmail: z.string().email().optional().nullable(),
        customerPhone: z.string().trim().max(40).optional().nullable(),
        orderType: z.enum(["pickup", "delivery"]).default("pickup"),
        deliveryAddress: z
          .string()
          .trim()
          .min(5)
          .max(400)
          .optional()
          .nullable(),
        deliveryCity: z.string().trim().min(2).max(100).optional().nullable(),
        deliveryState: z.string().trim().min(2).max(50).optional().nullable(),
        deliveryPostalCode: z
          .string()
          .trim()
          .min(3)
          .max(12)
          .optional()
          .nullable(),
        deliveryInstructions: z.string().trim().max(500).optional().nullable(),
        paymentMethod: z.enum(["card", "cash"]).default("card"),
        items: z
          .array(
            z.object({
              menuItemId: z.string().min(1),
              quantity: z.number().int().min(1).max(MAX_PICKUP_ORDER_UNITS),
              selectedVariantId: z.string().optional().nullable(),
              selectedModifierIds: z
                .array(z.string().min(1).max(100))
                .max(20)
                .optional()
                .default([]),
              specialInstructions: z.string().max(200).optional().nullable(),
            }),
          )
          .min(1)
          .max(MAX_PICKUP_ORDER_UNITS),
        specialInstructions: z.string().max(500).optional().nullable(),
        scheduledFor: z.string().datetime().optional().nullable(),
        promotionToken: z.string().max(200).optional().nullable(),
        checkoutRequestId: z.string().uuid().optional().nullable(),
        customerAccessToken: z.string().min(32).max(200).optional().nullable(),
      });

      const body = bodySchema.parse(req.body);
      if (body.orderType !== "pickup") {
        return res.status(409).json({
          code: "FULFILLMENT_MODE_UNAVAILABLE",
          message:
            "Verified online checkout is currently available for pickup only.",
        });
      }
      if (body.paymentMethod !== "card") {
        return res.status(409).json({
          code: "PAYMENT_METHOD_UNAVAILABLE",
          message:
            "Verified online checkout currently requires secure card payment.",
        });
      }
      const requestedUnitCount = body.items.reduce(
        (total, item) => total + item.quantity,
        0,
      );
      if (requestedUnitCount > MAX_PICKUP_ORDER_UNITS) {
        return res.status(400).json({
          code: "ORDER_UNIT_LIMIT_EXCEEDED",
          message: `Online checkout is limited to ${MAX_PICKUP_ORDER_UNITS} total items per order.`,
        });
      }
      const normalizedCustomerPhone = body.customerPhone
        ? normalizeOrderContactPhone(body.customerPhone)
        : null;
      if (body.customerPhone && !normalizedCustomerPhone) {
        return res.status(400).json({
          code: "INVALID_ORDER_PHONE",
          message: "Enter a valid phone number that can receive order updates.",
        });
      }
      if (
        !req.user?.id &&
        !String(body.customerEmail || "").trim() &&
        !normalizedCustomerPhone
      ) {
        return res.status(400).json({
          code: "ORDER_CONTACT_REQUIRED",
          message:
            "Enter an email address or phone number so you can receive and recover order updates.",
        });
      }
      if (!body.checkoutRequestId || !body.customerAccessToken) {
        return res.status(400).json({
          code: "ORDER_RECOVERY_REQUIRED",
          message:
            "Checkout requires a durable request and customer access token. Refresh and try again.",
        });
      }
      if (body.scheduledFor) {
        return res.status(400).json({
          code: "SCHEDULED_ORDERING_UNAVAILABLE",
          message:
            "Scheduled ordering is not available yet. Place an ASAP order while this menu is open.",
        });
      }

      if (body.checkoutRequestId) {
        const [existing] = await db
          .select()
          .from(pickupOrders)
          .where(eq(pickupOrders.checkoutRequestId, body.checkoutRequestId))
          .limit(1);
        if (existing) {
          if (
            !customerAccessTokenMatches(
              body.customerAccessToken,
              existing.customerAccessTokenHash,
            )
          ) {
            return res
              .status(409)
              .json({ message: "Checkout request already exists" });
          }
          if (existing.status !== ORDER_STATUS.PENDING) {
            if (existing.status === ORDER_STATUS.CONFIRMED) {
              await sendPickupOrderConfirmedNotifications(existing);
            }
            return res.status(200).json({
              order: projectOrderForCustomer(existing, true),
              clientSecret: null,
              customerAccessToken: body.customerAccessToken,
              replayed: true,
              checkoutState: "status_only",
            });
          }
          if (
            existing.paymentMethod === "card" &&
            isPickupOrderPaymentExpired(existing.createdAt)
          ) {
            await requestAndFinalizeCardPickupOrderCancellation({
              orderId: existing.id,
              expectedStatuses: [ORDER_STATUS.PENDING],
              cancellationReason: PICKUP_ORDER_PAYMENT_EXPIRED_REASON,
              stripe,
              stripeCancellationReason: "abandoned",
            });
            return res.status(409).json({
              code: "CHECKOUT_EXPIRED",
              message:
                "This checkout expired. Return to the menu to start again.",
            });
          }
          if (
            existing.paymentMethod !== "card" ||
            existing.orderingContractVersion !== PICKUP_ORDER_CONTRACT_VERSION
          ) {
            return res.status(409).json({
              code: "CHECKOUT_NOT_PAYABLE",
              message:
                "This checkout is outside the current pickup card contract. Start a new order.",
            });
          }
          if (!stripe || !existing.stripePaymentIntentId) {
            return res.status(409).json({
              code: "PAYMENT_SETUP_RECONCILIATION_REQUIRED",
              message:
                "Payment setup did not finish. Wait for this checkout to expire, then try again.",
            });
          }
          const intent = await stripe.paymentIntents.retrieve(
            existing.stripePaymentIntentId,
          );
          if (
            !isPickupPaymentIntentCheckoutBound(intent, existing) ||
            !isPickupPaymentIntentSettlementBound(intent, existing)
          ) {
            await requestAndFinalizeCardPickupOrderCancellation({
              orderId: existing.id,
              expectedStatuses: [ORDER_STATUS.PENDING],
              cancellationReason:
                "Payment setup did not match the authoritative checkout",
              stripe,
              stripeCancellationReason: "abandoned",
            });
            return res.status(409).json({
              code: "PAYMENT_SETUP_MISMATCH",
              message:
                "This checkout could not be verified and was closed. Start a new order.",
            });
          }
          const replayReadiness =
            await revalidatePendingPickupCheckoutReplay(existing);
          if (
            body.restaurantId !== existing.restaurantId ||
            body.menuId !== replayReadiness.menuId
          ) {
            return res.status(409).json({
              code: "CHECKOUT_REQUEST_MISMATCH",
              message:
                "This checkout request belongs to a different menu. Return to the original order status.",
            });
          }
          if (!replayReadiness.ok) {
            await requestAndFinalizeCardPickupOrderCancellation({
              orderId: existing.id,
              expectedStatuses: [ORDER_STATUS.PENDING],
              cancellationReason:
                "Ordering eligibility changed before checkout resumed",
              stripe,
              stripeCancellationReason: "abandoned",
            });
            return res.status(409).json({
              code: "ORDERING_CHANGED",
              message:
                "This checkout is no longer payable because current ordering readiness changed. Return to the menu to start again.",
              blockingReasons: replayReadiness.blockingReasons,
            });
          }
          const resumableStatuses = [
            "requires_payment_method",
            "requires_confirmation",
            "requires_action",
          ];
          if (
            !resumableStatuses.includes(String(intent.status || "")) ||
            !intent.client_secret
          ) {
            return res.status(409).json({
              code: "PAYMENT_PROCESSING",
              message:
                "This payment is already processing or closed. Check the order status instead of paying again.",
            });
          }
          return res.status(200).json({
            order: projectOrderForCustomer(existing, true),
            clientSecret: intent.client_secret,
            customerAccessToken: body.customerAccessToken,
            replayed: true,
          });
        }
      }

      // Public menu projection and transaction creation must share one
      // authority. Re-run it here so a stale client or direct POST cannot
      // create an order, reserve inventory, or create a PaymentIntent after
      // verification, hours, stop, or settlement eligibility changes.
      const readiness = await buildOrderingReadiness(
        body.restaurantId,
        body.menuId,
        { includeSettlementIdentity: true },
      );
      const requestedPaymentReady = readiness.paymentMethods.card;
      if (!readiness.orderingEnabled || !requestedPaymentReady) {
        return res.status(409).json({
          code: "ORDERING_UNAVAILABLE",
          message: !readiness.paymentMethods.card
            ? "Card ordering is unavailable until this business can receive payouts."
            : "Online ordering is not available for this business right now.",
          blockingReasons: readiness.blockingReasons,
        });
      }
      const merchantOwnerIdSnapshot = String(
        readiness.settlementIdentity?.merchantOwnerId || "",
      ).trim();
      const stripeConnectAccountIdSnapshot = String(
        readiness.settlementIdentity?.stripeConnectAccountId || "",
      ).trim();
      const merchantAcknowledgementMinutesSnapshot = Number(
        readiness.merchantAcknowledgementMinutes,
      );
      const orderingAuthorityVersionSnapshot = Number(
        readiness.orderingAuthorityVersion,
      );
      if (
        !merchantOwnerIdSnapshot ||
        !stripeConnectAccountIdSnapshot ||
        !Number.isInteger(orderingAuthorityVersionSnapshot) ||
        orderingAuthorityVersionSnapshot < 0 ||
        !Number.isInteger(merchantAcknowledgementMinutesSnapshot) ||
        merchantAcknowledgementMinutesSnapshot < 5 ||
        merchantAcknowledgementMinutesSnapshot > 30
      ) {
        return res.status(409).json({
          code: "ORDERING_UNAVAILABLE",
          message:
            "Card ordering is unavailable until this business's payout identity and response deadline are verified.",
        });
      }

      // Fetch the exact menu to enforce current fee presentation.
      const [menu] = await db
        .select()
        .from(menus)
        .where(
          and(
            eq(menus.id, body.menuId),
            eq(menus.restaurantId, body.restaurantId),
          ),
        );
      if (!menu || !menu.isActive) {
        return res.status(400).json({ message: "Menu not available" });
      }
      if (menu.pricesIncludeTax !== true) {
        return res.status(409).json({
          code: "TAX_PRICING_NOT_CONFIRMED",
          message:
            "Online pickup is unavailable until the business confirms that menu prices include applicable tax.",
        });
      }

      // Resolve all menu items
      const itemIds = body.items.map((i) => i.menuItemId);
      const dbItems: MenuItem[] = await loadAuthoritativePickupOrderItems(db, {
        restaurantId: body.restaurantId,
        menuId: body.menuId,
        menuItemIds: itemIds,
      });

      const itemMap = new Map<string, MenuItem>(dbItems.map((i) => [i.id, i]));

      // Check every requested item exists and is available
      for (const reqItem of body.items) {
        const item = itemMap.get(reqItem.menuItemId);
        if (!item) {
          return res.status(400).json({
            message: `Item ${reqItem.menuItemId} is not available`,
          });
        }
        if (
          typeof item.priceCents !== "number" ||
          !Number.isInteger(item.priceCents) ||
          item.priceCents < 0
        ) {
          return res.status(400).json({
            message: `"${item.name}" cannot be ordered until the business adds a price`,
          });
        }
      }

      // Check inventory for tracked items
      for (const reqItem of body.items) {
        const dbItem = itemMap.get(reqItem.menuItemId)!;
        if (dbItem.trackInventory && dbItem.inventoryQty !== null) {
          if (dbItem.inventoryQty < reqItem.quantity) {
            return res.status(400).json({
              message: `"${dbItem.name}" only has ${dbItem.inventoryQty} left in stock`,
            });
          }
        }
      }

      // Fetch all variants + modifiers for requested items
      const [allVariants, allModifiers]: [
        MenuItemVariant[],
        MenuItemModifier[],
      ] = await Promise.all([
        db
          .select()
          .from(menuItemVariants)
          .where(inArray(menuItemVariants.menuItemId, itemIds)),
        db
          .select()
          .from(menuItemModifiers)
          .where(inArray(menuItemModifiers.menuItemId, itemIds)),
      ]);

      const variantMap = new Map<string, MenuItemVariant>(
        allVariants.map((v) => [v.id, v]),
      );
      const modifierMap = new Map<string, MenuItemModifier>(
        allModifiers.map((m) => [m.id, m]),
      );
      const variantsByItem = new Map<string, MenuItemVariant[]>();
      for (const variant of allVariants) {
        const current = variantsByItem.get(variant.menuItemId) || [];
        current.push(variant);
        variantsByItem.set(variant.menuItemId, current);
      }
      const modifiersByItem = new Map<string, MenuItemModifier[]>();
      for (const modifier of allModifiers) {
        const current = modifiersByItem.get(modifier.menuItemId) || [];
        current.push(modifier);
        modifiersByItem.set(modifier.menuItemId, current);
      }

      // Validate required choices before pricing. Invalid or omitted choices
      // must not be silently discarded because the resulting order would be
      // ambiguous to both the diner and kitchen.
      for (const reqItem of body.items) {
        const item = itemMap.get(reqItem.menuItemId)!;
        const itemVariants = variantsByItem.get(item.id) || [];
        if (itemVariants.length > 0) {
          const selectedVariant = reqItem.selectedVariantId
            ? variantMap.get(reqItem.selectedVariantId)
            : null;
          if (!selectedVariant || selectedVariant.menuItemId !== item.id) {
            return res.status(400).json({
              code: "ITEM_OPTION_REQUIRED",
              message: `Choose an option for "${item.name}".`,
            });
          }
        } else if (reqItem.selectedVariantId) {
          return res.status(400).json({
            code: "INVALID_ITEM_OPTION",
            message: `The selected option is not available for "${item.name}".`,
          });
        }

        const requestedModifierIds = reqItem.selectedModifierIds || [];
        if (
          new Set(requestedModifierIds).size !== requestedModifierIds.length
        ) {
          return res.status(400).json({
            code: "INVALID_ITEM_MODIFIER",
            message: `A choice was duplicated for "${item.name}".`,
          });
        }
        for (const modifierId of requestedModifierIds) {
          const modifier = modifierMap.get(modifierId);
          if (!modifier || modifier.menuItemId !== item.id) {
            return res.status(400).json({
              code: "INVALID_ITEM_MODIFIER",
              message: `A selected choice is not available for "${item.name}".`,
            });
          }
        }

        const groups = new Map<string, MenuItemModifier[]>();
        for (const modifier of modifiersByItem.get(item.id) || []) {
          const current = groups.get(modifier.groupName) || [];
          current.push(modifier);
          groups.set(modifier.groupName, current);
        }
        for (const [groupName, groupModifiers] of groups) {
          const groupIds = new Set(
            groupModifiers.map((modifier) => modifier.id),
          );
          const selectedCount = requestedModifierIds.filter((id) =>
            groupIds.has(id),
          ).length;
          const required = groupModifiers.some(
            (modifier) => modifier.isRequired === true,
          );
          const maxSelections = Math.min(
            ...groupModifiers.map((modifier) =>
              Math.max(1, Number(modifier.maxSelections || 1)),
            ),
          );
          if (required && selectedCount === 0) {
            return res.status(400).json({
              code: "ITEM_MODIFIER_REQUIRED",
              message: `Choose ${groupName} for "${item.name}".`,
            });
          }
          if (selectedCount > maxSelections) {
            return res.status(400).json({
              code: "TOO_MANY_ITEM_MODIFIERS",
              message: `Choose no more than ${maxSelections} from ${groupName} for "${item.name}".`,
            });
          }
        }
      }

      // Build order line items with pricing
      let subtotalCents = 0;
      const lineItems: Array<{
        menuItemId: string;
        itemName: string;
        itemDescription: string | null;
        basePriceCents: number;
        selectedVariant: any;
        selectedModifiers: any[];
        quantity: number;
        lineTotalCents: number;
        specialInstructions: string | null;
      }> = [];

      for (const reqItem of body.items) {
        const item = itemMap.get(reqItem.menuItemId)!;
        if (
          typeof item.priceCents !== "number" ||
          !Number.isInteger(item.priceCents) ||
          item.priceCents < 0
        ) {
          throw new Error("Unpriced menu item passed checkout validation");
        }
        let variantAddCents = 0;
        let selectedVariant: any = null;

        if (reqItem.selectedVariantId) {
          const variant = variantMap.get(reqItem.selectedVariantId);
          if (variant && variant.menuItemId === item.id) {
            variantAddCents = variant.additionalCents;
            selectedVariant = {
              id: variant.id,
              label: variant.label,
              additionalCents: variant.additionalCents,
            };
          }
        }

        let modifierAddCents = 0;
        const selectedModifiers: any[] = [];
        for (const modId of reqItem.selectedModifierIds ?? []) {
          const mod = modifierMap.get(modId);
          if (mod && mod.menuItemId === item.id) {
            modifierAddCents += mod.additionalCents;
            selectedModifiers.push({
              id: mod.id,
              groupName: mod.groupName,
              label: mod.label,
              additionalCents: mod.additionalCents,
            });
          }
        }

        const lineTotalCents = calcLineTotal(
          item.priceCents,
          variantAddCents,
          modifierAddCents,
          reqItem.quantity,
        );

        if (
          !Number.isSafeInteger(lineTotalCents) ||
          lineTotalCents < 0 ||
          lineTotalCents > MAX_PICKUP_ORDER_TOTAL_CENTS
        ) {
          return res.status(409).json({
            code: "INVALID_ORDER_PRICE",
            message: `The current price for "${item.name}" cannot be ordered safely.`,
          });
        }

        subtotalCents += lineTotalCents;
        if (subtotalCents > MAX_PICKUP_ORDER_TOTAL_CENTS) {
          return res.status(409).json({
            code: "ORDER_TOTAL_TOO_LARGE",
            message: "This order total is too large for online checkout.",
          });
        }

        lineItems.push({
          menuItemId: item.id,
          itemName: item.name,
          itemDescription: item.description ?? null,
          basePriceCents: item.priceCents,
          selectedVariant,
          selectedModifiers,
          quantity: reqItem.quantity,
          lineTotalCents,
          specialInstructions: reqItem.specialInstructions ?? null,
        });
      }

      const feePaidByBusiness = menu.hidePlatformFee;
      const { mealscoutFeeCents, processingFeeCents, platformFeeCents } =
        computePickupOrderFees(
          subtotalCents,
          body.paymentMethod,
          feePaidByBusiness,
        );
      const customerPlatformFeeCents = feePaidByBusiness ? 0 : platformFeeCents;

      // Determine prep time from menu's restaurant
      const [restaurant] = await db
        .select()
        .from(restaurants)
        .where(eq(restaurants.id, body.restaurantId));
      if (!restaurant || !restaurant.isActive) {
        return res.status(400).json({ message: "Restaurant not available" });
      }

      if (restaurant.isFoodTruck) {
        const plan = await buildPublicTruckOperatingPlan(body.restaurantId);
        const currentStop = plan.truckSchedule.currentStop;
        if (
          !currentStop ||
          currentStop.status !== "here_now" ||
          !currentStop.addressPublicLabel
        ) {
          return res.status(409).json({
            message:
              "Ordering opens when this truck confirms its current service window and pickup location.",
            code: "TRUCK_CURRENT_STOP_REQUIRED",
          });
        }
      }

      const deliveryFeeCents = 0;
      const deliveryEstimateMinutes: number | null = null;
      const preflightTotals = calculateAuthoritativeMerchantDeliveryTotals({
        subtotalCents,
        platformFeeCents: customerPlatformFeeCents,
        deliveryFeeCents,
      });
      if (preflightTotals.totalCents < MIN_CARD_CHARGE_CENTS) {
        return res.status(409).json({
          code: "CARD_TOTAL_BELOW_MINIMUM",
          message:
            "This card order is below the minimum amount supported by online payment. Add another item before continuing.",
        });
      }
      let totalCents = preflightTotals.totalCents;

      let order: PickupOrder;
      try {
        order = await db.transaction(async (tx: any) => {
          const [lockedSettlementRestaurant] = await tx
            .select({
              ownerId: restaurants.ownerId,
              name: restaurants.name,
              stripeConnectAccountId: restaurants.stripeConnectAccountId,
              orderingAuthorityVersion:
                restaurants.orderingAuthorityVersion,
              pickupAcknowledgementMinutes:
                restaurants.pickupAcknowledgementMinutes,
            })
            .from(restaurants)
            .where(eq(restaurants.id, body.restaurantId))
            .limit(1)
            .for("update");
          if (
            !lockedSettlementRestaurant ||
            !isRestaurantOrderingAuthorityVersionCurrent({
              preflightVersion: orderingAuthorityVersionSnapshot,
              lockedVersion:
                lockedSettlementRestaurant.orderingAuthorityVersion,
            }) ||
            String(lockedSettlementRestaurant.ownerId || "").trim() !==
              merchantOwnerIdSnapshot ||
            String(
              lockedSettlementRestaurant.stripeConnectAccountId || "",
            ).trim() !== stripeConnectAccountIdSnapshot ||
            String(lockedSettlementRestaurant.name || "").trim() !==
              String(readiness.restaurantName || "").trim() ||
            Number(lockedSettlementRestaurant.pickupAcknowledgementMinutes) !==
              merchantAcknowledgementMinutesSnapshot
          ) {
            throw Object.assign(
              new Error(
                "Business payout identity changed during checkout. Refresh and try again.",
              ),
              { statusCode: 409 },
            );
          }
          // The authority row is now locked. Database triggers make every
          // owner, menu, inventory, option, and truck-stop readiness mutation
          // bump this row, so no such write can commit until this transaction
          // finishes. Re-read canonical readiness through the same transaction
          // before the first durable order or inventory write.
          const lockedReadiness = await buildOrderingReadiness(
            body.restaurantId,
            body.menuId,
            {
              includeSettlementIdentity: true,
              database: tx,
            },
          );
          if (
            !lockedReadiness.orderingEnabled ||
            !lockedReadiness.paymentMethods.card ||
            !isRestaurantOrderingAuthorityVersionCurrent({
              preflightVersion: orderingAuthorityVersionSnapshot,
              lockedVersion: lockedReadiness.orderingAuthorityVersion,
            }) ||
            String(
              lockedReadiness.settlementIdentity?.merchantOwnerId || "",
            ).trim() !== merchantOwnerIdSnapshot ||
            String(
              lockedReadiness.settlementIdentity?.stripeConnectAccountId || "",
            ).trim() !== stripeConnectAccountIdSnapshot ||
            String(lockedReadiness.restaurantName || "").trim() !==
              String(readiness.restaurantName || "").trim() ||
            String(lockedReadiness.pickupAddressLabel || "").trim() !==
              String(readiness.pickupAddressLabel || "").trim() ||
            String(lockedReadiness.pickupDirectionsUrl || "").trim() !==
              String(readiness.pickupDirectionsUrl || "").trim() ||
            Number(lockedReadiness.merchantAcknowledgementMinutes) !==
              merchantAcknowledgementMinutesSnapshot
          ) {
            throw Object.assign(
              new Error(
                "Ordering readiness changed during checkout. Refresh and try again.",
              ),
              { statusCode: 409 },
            );
          }
          const authoritativeTotals =
            calculateAuthoritativeMerchantDeliveryTotals({
              subtotalCents,
              platformFeeCents: customerPlatformFeeCents,
              deliveryFeeCents,
            });
          totalCents = authoritativeTotals.totalCents;
          const [createdOrder] = await tx
            .insert(pickupOrders)
            .values({
              restaurantId: body.restaurantId,
              customerId: req.user?.id ?? null,
              customerName: body.customerName,
              customerEmail: body.customerEmail ?? null,
              customerPhone: normalizedCustomerPhone,
              orderType: body.orderType,
              orderingContractVersion: PICKUP_ORDER_CONTRACT_VERSION,
              status: ORDER_STATUS.PENDING,
              subtotalCents,
              mealscoutFeeCents,
              processingFeeCents,
              platformFeeCents,
              feePaidByBusiness,
              pricesIncludeTax: true,
              totalCents,
              paymentMethod: body.paymentMethod,
              merchantNameSnapshot: lockedReadiness.restaurantName,
              merchantOwnerIdSnapshot: lockedSettlementRestaurant.ownerId,
              stripeConnectAccountIdSnapshot:
                lockedSettlementRestaurant.stripeConnectAccountId,
              merchantAcknowledgementMinutesSnapshot,
              merchantAcknowledgementDueAt: null,
              merchantAcknowledgedAt: null,
              pickupAddressSnapshot: lockedReadiness.pickupAddressLabel,
              pickupDirectionsUrlSnapshot:
                lockedReadiness.pickupDirectionsUrl,
              checkoutRequestId: body.checkoutRequestId,
              customerAccessTokenHash: hashCustomerAccessToken(
                body.customerAccessToken!,
              ),
              specialInstructions:
                (body.specialInstructions ?? "").trim() || null,
              prepTimeMinutes: null,
              confirmedAt: null,
              scheduledFor: body.scheduledFor
                ? new Date(body.scheduledFor)
                : null,
              deliveryAddress: null,
              deliveryCity: null,
              deliveryState: null,
              deliveryPostalCode: null,
              deliveryFeeCents,
              taxCents: authoritativeTotals.taxCents,
              tipCents: authoritativeTotals.tipCents,
              discountCents: authoritativeTotals.discountCents,
              deliveryEstimateMinutes,
              deliveryInstructions: null,
            })
            .returning();

          if (!createdOrder) {
            throw new Error("Unable to create pickup order");
          }

          const trackedReservations =
            await reserveTrackedInventoryForPickupOrder(
              tx,
              lineItems.map((li) => ({
                menuItemId: li.menuItemId,
                quantity: li.quantity,
              })),
            );
          const trackedMenuItemIds = new Set(
            trackedReservations.map((reservation) => reservation.menuItemId),
          );

          // Persist the exact tracked quantity decremented for every line. The
          // order insert and reservation share this transaction, so neither can
          // survive alone.
          await tx.insert(pickupOrderItems).values(
            lineItems.map((li) => ({
              ...li,
              orderId: createdOrder.id,
              inventoryReservedQuantity: trackedMenuItemIds.has(li.menuItemId)
                ? li.quantity
                : 0,
            })),
          );

          return createdOrder;
        });
      } catch (err: any) {
        const statusCode = Number(err?.statusCode || 0);
        if (statusCode === 409) {
          return res.status(409).json({ message: err.message });
        }
        if (["40001", "40P01"].includes(String(err?.code || ""))) {
          return res.status(409).json({
            code: "ORDERING_CHANGED",
            message:
              "Ordering details changed while checkout was being secured. Refresh and try again.",
          });
        }
        if (
          String(err?.code || err?.cause?.code || "") === "23505" &&
          body.checkoutRequestId
        ) {
          return res.status(409).json({
            message: "This pickup checkout is already being processed",
            code: "DUPLICATE_CHECKOUT",
          });
        }
        throw err;
      }

      if (body.promotionToken) {
        await consumePromotionAttribution({
          token: body.promotionToken,
          orderId: order.id,
          targetRestaurantId: body.restaurantId,
          customerUserId: req.user?.id ?? null,
          eligibleOrderCents: subtotalCents,
          commissionEligible: body.paymentMethod === "card",
        });
      }

      // Card payment: create Stripe PaymentIntent
      if (!stripe) {
        // No Stripe configured – should not happen in production
        await cleanupPendingPickupOrderAfterPaymentSetupFailure(db, order.id);
        return res
          .status(503)
          .json({ message: "Payment processing is not configured" });
      }

      const transferGroup = `order_${order.id}`;

      let paymentIntent: Stripe.PaymentIntent;
      try {
        paymentIntent = await stripe.paymentIntents.create(
          {
            amount: totalCents,
            currency: "usd",
            payment_method_types: ["card"],
            transfer_group: transferGroup,
            metadata: {
              pickupOrderId: order.id,
              orderId: order.id,
              restaurantId: body.restaurantId,
              merchantOwnerId: String(order.merchantOwnerIdSnapshot),
              stripeConnectAccountId: String(
                order.stripeConnectAccountIdSnapshot,
              ),
              subtotalCents: subtotalCents.toString(),
              platformFeeCents: platformFeeCents.toString(),
              mealscoutFeeCents: mealscoutFeeCents.toString(),
              processingFeeCents: processingFeeCents.toString(),
              deliveryFeeCents: deliveryFeeCents.toString(),
              feePaidByBusiness: String(feePaidByBusiness),
            },
            description: `MealScout order at ${restaurant.name}`,
          },
          { idempotencyKey: `pickup-order:${order.id}:payment-intent` },
        );
      } catch (stripeErr: any) {
        // Clean up pending order if Stripe fails
        await cleanupPendingPickupOrderAfterPaymentSetupFailure(db, order.id);
        console.error(
          "[pickupOrderRoutes] Stripe PI creation failed:",
          stripeErr,
        );
        return res
          .status(502)
          .json({ message: "Payment setup failed. Please try again." });
      }

      if (
        !isPickupPaymentIntentCheckoutBound(paymentIntent, order) ||
        !isPickupPaymentIntentSettlementBound(paymentIntent, order) ||
        !paymentIntent.client_secret
      ) {
        let intentCancelled = false;
        try {
          await stripe.paymentIntents.cancel(
            paymentIntent.id,
            { cancellation_reason: "abandoned" },
            {
              idempotencyKey: `pickup-order:${order.id}:payment-intent-cancel`,
            },
          );
          intentCancelled = true;
        } catch (cancelError) {
          console.error(
            `[pickupOrderRoutes] Could not cancel invalid PaymentIntent ${paymentIntent.id}`,
            cancelError,
          );
        }
        if (intentCancelled) {
          await cleanupPendingPickupOrderAfterPaymentSetupFailure(db, order.id);
        }
        return res.status(502).json({
          code: "PAYMENT_SETUP_RECONCILIATION_REQUIRED",
          message:
            "Payment setup could not be verified. Please try again later.",
        });
      }

      // Attach intent IDs to order
      let updatedOrder: PickupOrder | undefined;
      try {
        [updatedOrder] = await db
          .update(pickupOrders)
          .set({
            stripePaymentIntentId: paymentIntent.id,
            stripeTransferGroupId: transferGroup,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(pickupOrders.id, order.id),
              eq(pickupOrders.status, ORDER_STATUS.PENDING),
            ),
          )
          .returning();
        if (!updatedOrder) {
          throw new Error(
            "Pending order changed before payment setup completed",
          );
        }
      } catch (attachmentError) {
        let intentCancelled = false;
        try {
          await stripe.paymentIntents.cancel(
            paymentIntent.id,
            { cancellation_reason: "abandoned" },
            {
              idempotencyKey: `pickup-order:${order.id}:payment-intent-cancel`,
            },
          );
          intentCancelled = true;
        } catch (cancelError) {
          console.error(
            `[pickupOrderRoutes] Could not cancel unattached PaymentIntent ${paymentIntent.id}`,
            cancelError,
          );
        }
        if (intentCancelled) {
          await cleanupPendingPickupOrderAfterPaymentSetupFailure(db, order.id);
        }
        console.error(
          `[pickupOrderRoutes] Could not attach PaymentIntent ${paymentIntent.id} to order ${order.id}`,
          attachmentError,
        );
        return res.status(502).json({
          code: "PAYMENT_SETUP_RECONCILIATION_REQUIRED",
          message: "Payment setup did not finish. Please try again later.",
        });
      }

      // Emit LISA claim for card order placed (payment pending)
      db.insert(lisaClaims)
        .values({
          app: "mealscout",
          claimType: LISA_CLAIM_TYPES.ORDER_PLACED,
          source: LISA_CLAIM_SOURCES.ORDER,
          subjectType: "order",
          subjectId: updatedOrder.id,
          actorType: req.user?.id ? "user" : "guest",
          actorId: req.user?.id ?? "guest",
          payload: {
            restaurantId: body.restaurantId,
            orderType: body.orderType,
            totalCents,
            paymentMethod: "card",
          },
        })
        .catch(() => {});

      res.status(201).json({
        order: projectOrderForCustomer(updatedOrder, true),
        clientSecret: paymentIntent.client_secret,
        customerAccessToken: body.customerAccessToken ?? null,
      });
    }),
  );

  // ── ─────────────────────────────────────────────────────────────────────────
  // CUSTOMER: Preview the server-priced final total for a cart
  // ── ─────────────────────────────────────────────────────────────────────────

  /**
   * POST /api/pickup-orders/totals-preview
   * Body:
   * {
   *   restaurantId, menuId,
   *   paymentMethod: 'card',
   *   items: [{ menuItemId, quantity, selectedVariantId?, selectedModifierIds?: string[] }]
   * }
   *
   * Response:
   *   { subtotalCents, mealscoutFeeCents, processingFeeCents, platformFeeCents,
   *     totalCents, feePaidByBusiness }
   *
   * Runs the same read-only pricing sequence as POST /api/pickup-orders —
   * the menu's fee presentation, authoritative item prices, required-choice
   * validation, computePickupOrderFees — so checkout can show the final
   * total (card fees included) and keep Continue disabled until that number
   * exists. Creates nothing: no order row, no PaymentIntent, no inventory
   * reservation. Order creation remains the authority at charge time and
   * recomputes the same figures from the same helpers before charging.
   */
  app.post(
    "/api/pickup-orders/totals-preview",
    totalsPreviewLimiter,
    wrap(async (req, res) => {
      const bodySchema = z.object({
        restaurantId: z.string().min(1),
        menuId: z.string().min(1),
        paymentMethod: z.enum(["card", "cash"]).default("card"),
        items: z
          .array(
            z.object({
              menuItemId: z.string().min(1),
              quantity: z.number().int().min(1).max(MAX_PICKUP_ORDER_UNITS),
              selectedVariantId: z.string().optional().nullable(),
              selectedModifierIds: z
                .array(z.string().min(1).max(100))
                .max(20)
                .optional()
                .default([]),
            }),
          )
          .min(1)
          .max(MAX_PICKUP_ORDER_UNITS),
      });

      const body = bodySchema.parse(req.body);
      if (body.paymentMethod !== "card") {
        return res.status(409).json({
          code: "PAYMENT_METHOD_UNAVAILABLE",
          message:
            "Verified online checkout currently requires secure card payment.",
        });
      }
      const requestedUnitCount = body.items.reduce(
        (total, item) => total + item.quantity,
        0,
      );
      if (requestedUnitCount > MAX_PICKUP_ORDER_UNITS) {
        return res.status(400).json({
          code: "ORDER_UNIT_LIMIT_EXCEEDED",
          message: `Online checkout is limited to ${MAX_PICKUP_ORDER_UNITS} total items per order.`,
        });
      }

      // Fetch the exact menu to enforce current fee presentation (same
      // lookup as order creation).
      const [menu] = await db
        .select()
        .from(menus)
        .where(
          and(
            eq(menus.id, body.menuId),
            eq(menus.restaurantId, body.restaurantId),
          ),
        );
      if (!menu || !menu.isActive) {
        return res.status(400).json({ message: "Menu not available" });
      }
      if (menu.pricesIncludeTax !== true) {
        return res.status(409).json({
          code: "TAX_PRICING_NOT_CONFIRMED",
          message:
            "Online pickup is unavailable until the business confirms that menu prices include applicable tax.",
        });
      }

      // Resolve all menu items (same authoritative loader as creation).
      const itemIds = body.items.map((i) => i.menuItemId);
      const dbItems: MenuItem[] = await loadAuthoritativePickupOrderItems(db, {
        restaurantId: body.restaurantId,
        menuId: body.menuId,
        menuItemIds: itemIds,
      });

      const itemMap = new Map<string, MenuItem>(dbItems.map((i) => [i.id, i]));

      // Check every requested item exists and is available.
      for (const reqItem of body.items) {
        const item = itemMap.get(reqItem.menuItemId);
        if (!item) {
          return res.status(400).json({
            message: `Item ${reqItem.menuItemId} is not available`,
          });
        }
        if (
          typeof item.priceCents !== "number" ||
          !Number.isInteger(item.priceCents) ||
          item.priceCents < 0
        ) {
          return res.status(400).json({
            message: `"${item.name}" cannot be ordered until the business adds a price`,
          });
        }
      }

      // Check inventory for tracked items (read-only here; creation
      // re-checks under its transaction before reserving).
      for (const reqItem of body.items) {
        const dbItem = itemMap.get(reqItem.menuItemId)!;
        if (dbItem.trackInventory && dbItem.inventoryQty !== null) {
          if (dbItem.inventoryQty < reqItem.quantity) {
            return res.status(400).json({
              message: `"${dbItem.name}" only has ${dbItem.inventoryQty} left in stock`,
            });
          }
        }
      }

      // Fetch all variants + modifiers for requested items.
      const [allVariants, allModifiers]: [
        MenuItemVariant[],
        MenuItemModifier[],
      ] = await Promise.all([
        db
          .select()
          .from(menuItemVariants)
          .where(inArray(menuItemVariants.menuItemId, itemIds)),
        db
          .select()
          .from(menuItemModifiers)
          .where(inArray(menuItemModifiers.menuItemId, itemIds)),
      ]);

      const variantMap = new Map<string, MenuItemVariant>(
        allVariants.map((v) => [v.id, v]),
      );
      const modifierMap = new Map<string, MenuItemModifier>(
        allModifiers.map((m) => [m.id, m]),
      );
      const variantsByItem = new Map<string, MenuItemVariant[]>();
      for (const variant of allVariants) {
        const current = variantsByItem.get(variant.menuItemId) || [];
        current.push(variant);
        variantsByItem.set(variant.menuItemId, current);
      }
      const modifiersByItem = new Map<string, MenuItemModifier[]>();
      for (const modifier of allModifiers) {
        const current = modifiersByItem.get(modifier.menuItemId) || [];
        current.push(modifier);
        modifiersByItem.set(modifier.menuItemId, current);
      }

      // Validate required choices before pricing (same rules as creation).
      for (const reqItem of body.items) {
        const item = itemMap.get(reqItem.menuItemId)!;
        const itemVariants = variantsByItem.get(item.id) || [];
        if (itemVariants.length > 0) {
          const selectedVariant = reqItem.selectedVariantId
            ? variantMap.get(reqItem.selectedVariantId)
            : null;
          if (!selectedVariant || selectedVariant.menuItemId !== item.id) {
            return res.status(400).json({
              code: "ITEM_OPTION_REQUIRED",
              message: `Choose an option for "${item.name}".`,
            });
          }
        } else if (reqItem.selectedVariantId) {
          return res.status(400).json({
            code: "INVALID_ITEM_OPTION",
            message: `The selected option is not available for "${item.name}".`,
          });
        }

        const requestedModifierIds = reqItem.selectedModifierIds || [];
        if (
          new Set(requestedModifierIds).size !== requestedModifierIds.length
        ) {
          return res.status(400).json({
            code: "INVALID_ITEM_MODIFIER",
            message: `A choice was duplicated for "${item.name}".`,
          });
        }
        for (const modifierId of requestedModifierIds) {
          const modifier = modifierMap.get(modifierId);
          if (!modifier || modifier.menuItemId !== item.id) {
            return res.status(400).json({
              code: "INVALID_ITEM_MODIFIER",
              message: `A selected choice is not available for "${item.name}".`,
            });
          }
        }

        const groups = new Map<string, MenuItemModifier[]>();
        for (const modifier of modifiersByItem.get(item.id) || []) {
          const current = groups.get(modifier.groupName) || [];
          current.push(modifier);
          groups.set(modifier.groupName, current);
        }
        for (const [groupName, groupModifiers] of groups) {
          const groupIds = new Set(
            groupModifiers.map((modifier) => modifier.id),
          );
          const selectedCount = requestedModifierIds.filter((id) =>
            groupIds.has(id),
          ).length;
          const required = groupModifiers.some(
            (modifier) => modifier.isRequired === true,
          );
          const maxSelections = Math.min(
            ...groupModifiers.map((modifier) =>
              Math.max(1, Number(modifier.maxSelections || 1)),
            ),
          );
          if (required && selectedCount === 0) {
            return res.status(400).json({
              code: "ITEM_MODIFIER_REQUIRED",
              message: `Choose ${groupName} for "${item.name}".`,
            });
          }
          if (selectedCount > maxSelections) {
            return res.status(400).json({
              code: "TOO_MANY_ITEM_MODIFIERS",
              message: `Choose no more than ${maxSelections} from ${groupName} for "${item.name}".`,
            });
          }
        }
      }

      // Price the cart with the same line math as order creation.
      let subtotalCents = 0;
      for (const reqItem of body.items) {
        const item = itemMap.get(reqItem.menuItemId)!;
        if (
          typeof item.priceCents !== "number" ||
          !Number.isInteger(item.priceCents) ||
          item.priceCents < 0
        ) {
          throw new Error("Unpriced menu item passed checkout validation");
        }
        let variantAddCents = 0;
        if (reqItem.selectedVariantId) {
          const variant = variantMap.get(reqItem.selectedVariantId);
          if (variant && variant.menuItemId === item.id) {
            variantAddCents = variant.additionalCents;
          }
        }

        let modifierAddCents = 0;
        for (const modId of reqItem.selectedModifierIds ?? []) {
          const mod = modifierMap.get(modId);
          if (mod && mod.menuItemId === item.id) {
            modifierAddCents += mod.additionalCents;
          }
        }

        const lineTotalCents = calcLineTotal(
          item.priceCents,
          variantAddCents,
          modifierAddCents,
          reqItem.quantity,
        );

        if (
          !Number.isSafeInteger(lineTotalCents) ||
          lineTotalCents < 0 ||
          lineTotalCents > MAX_PICKUP_ORDER_TOTAL_CENTS
        ) {
          return res.status(409).json({
            code: "INVALID_ORDER_PRICE",
            message: `The current price for "${item.name}" cannot be ordered safely.`,
          });
        }

        subtotalCents += lineTotalCents;
        if (subtotalCents > MAX_PICKUP_ORDER_TOTAL_CENTS) {
          return res.status(409).json({
            code: "ORDER_TOTAL_TOO_LARGE",
            message: "This order total is too large for online checkout.",
          });
        }
      }

      const feePaidByBusiness = menu.hidePlatformFee;
      const { mealscoutFeeCents, processingFeeCents, platformFeeCents } =
        computePickupOrderFees(
          subtotalCents,
          body.paymentMethod,
          feePaidByBusiness,
        );
      const customerPlatformFeeCents = feePaidByBusiness ? 0 : platformFeeCents;
      const totals = calculateAuthoritativeMerchantDeliveryTotals({
        subtotalCents,
        platformFeeCents: customerPlatformFeeCents,
        deliveryFeeCents: 0,
      });
      if (totals.totalCents < MIN_CARD_CHARGE_CENTS) {
        return res.status(409).json({
          code: "CARD_TOTAL_BELOW_MINIMUM",
          message:
            "This card order is below the minimum amount supported by online payment. Add another item before continuing.",
        });
      }

      return res.status(200).json({
        subtotalCents,
        mealscoutFeeCents,
        processingFeeCents,
        platformFeeCents,
        totalCents: totals.totalCents,
        feePaidByBusiness,
      });
    }),
  );

  // ── ─────────────────────────────────────────────────────────────────────────
  // CUSTOMER: Poll order status
  // ── ─────────────────────────────────────────────────────────────────────────

  /**
   * GET /api/pickup-orders/:orderId
   * Returns order + items. No auth required (customers link to this page).
   * We don't expose sensitive financial details to unauthenticated requests.
   */
  app.get(
    "/api/pickup-orders/:orderId",
    wrap(async (req, res) => {
      const { orderId } = req.params;
      const [order] = await db
        .select()
        .from(pickupOrders)
        .where(eq(pickupOrders.id, orderId));

      if (!order) return res.status(404).json({ message: "Order not found" });

      const items = await db
        .select()
        .from(pickupOrderItems)
        .where(eq(pickupOrderItems.orderId, orderId));

      // Strip payment intent details for non-owners
      const userId = (req as any)?.user?.id;
      const isOwner =
        userId &&
        (order.customerId === userId ||
          (await storage.verifyRestaurantOwnership(
            order.restaurantId,
            userId,
          )));

      const accessToken = String(
        req.get("x-order-access-token") || req.query.accessToken || "",
      ).trim();
      const safeOrder = projectOrderForCustomer(
        order,
        Boolean(
          isOwner ||
          customerAccessTokenMatches(
            accessToken,
            order.customerAccessTokenHash,
          ),
        ),
      );

      res.json({
        order: safeOrder,
        items: projectPickupOrderItemsForCustomer(
          items,
          Boolean(
            isOwner ||
            customerAccessTokenMatches(
              accessToken,
              order.customerAccessTokenHash,
            ),
          ),
        ),
      });
    }),
  );

  /**
   * GET /api/pickup-orders/by-intent/:paymentIntentId
   * Poll an order by Stripe PaymentIntent ID (used after Stripe redirect).
   */
  app.get(
    "/api/pickup-orders/by-intent/:paymentIntentId",
    isAuthenticated,
    wrap(async (req, res) => {
      const { paymentIntentId } = req.params;
      const [order] = await db
        .select()
        .from(pickupOrders)
        .where(eq(pickupOrders.stripePaymentIntentId, paymentIntentId));

      if (!order) return res.status(404).json({ message: "Order not found" });

      const userId = (req as any)?.user?.id;
      const canView =
        userId &&
        (order.customerId === userId ||
          (await storage.verifyRestaurantOwnership(
            order.restaurantId,
            userId,
          )));
      if (!canView) return res.status(403).json({ message: "Not authorized" });

      const items = await db
        .select()
        .from(pickupOrderItems)
        .where(eq(pickupOrderItems.orderId, order.id));

      res.json({
        order: projectOrderForCustomer(order, true),
        items: projectPickupOrderItemsForCustomer(items, true),
      });
    }),
  );

  // ── ─────────────────────────────────────────────────────────────────────────
  // OWNER: Kitchen queue + status management
  // ── ─────────────────────────────────────────────────────────────────────────

  /**
   * GET /api/owner/kitchen-queue/:restaurantId
   * Returns paid/confirmed active orders sorted newest first. Unpaid pending
   * checkouts are deliberately excluded from kitchen operations.
   */
  app.get(
    "/api/owner/kitchen-queue/:restaurantId",
    isAuthenticated,
    wrap(async (req, res) => {
      const { restaurantId } = req.params;
      await assertOrderingWorkspaceAccess(req.user, restaurantId);

      const activeOrders: PickupOrder[] = await db
        .select()
        .from(pickupOrders)
        .where(
          and(
            eq(pickupOrders.restaurantId, restaurantId),
            inArray(pickupOrders.status, [
              ORDER_STATUS.CONFIRMED,
              ORDER_STATUS.PREPARING,
              ORDER_STATUS.READY,
              ORDER_STATUS.PAYMENT_DISPUTED,
              ORDER_STATUS.OUT_FOR_DELIVERY,
              ORDER_STATUS.CANCELLATION_PENDING,
            ]),
          ),
        )
        .orderBy(desc(pickupOrders.createdAt));

      const orderIds = activeOrders.map((o) => o.id);
      const items: PickupOrderItem[] =
        orderIds.length > 0
          ? await db
              .select()
              .from(pickupOrderItems)
              .where(inArray(pickupOrderItems.orderId, orderIds))
          : [];

      const ordersWithItems = activeOrders.map((order) => ({
        ...order,
        items: items.filter((i) => i.orderId === order.id),
      }));

      res.json({ orders: ordersWithItems });
    }),
  );

  /**
   * GET /api/owner/orders/:restaurantId
   * Full order history (all statuses, paginated).
   */
  app.get(
    "/api/owner/orders/:restaurantId",
    isAuthenticated,
    wrap(async (req, res) => {
      const { restaurantId } = req.params;
      await assertOrderingWorkspaceAccess(req.user, restaurantId);

      const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
      const limit = 50;
      const offset = (page - 1) * limit;

      const orders: PickupOrder[] = await db
        .select()
        .from(pickupOrders)
        .where(eq(pickupOrders.restaurantId, restaurantId))
        .orderBy(desc(pickupOrders.createdAt))
        .limit(limit)
        .offset(offset);

      const orderIds = orders.map((order) => order.id);
      const items: PickupOrderItem[] =
        orderIds.length > 0
          ? await db
              .select()
              .from(pickupOrderItems)
              .where(inArray(pickupOrderItems.orderId, orderIds))
          : [];

      res.json({
        orders: orders.map((order) => ({
          ...order,
          items: items.filter((item) => item.orderId === order.id),
        })),
        page,
        hasMore: orders.length === limit,
      });
    }),
  );

  /**
   * PATCH /api/owner/orders/:orderId/status
   * Advance order through the kitchen lifecycle.
   * Allowed transitions:
   *   pending    → cancelled (card confirmation is Stripe-webhook-only)
   *   confirmed  → preparing | cancelled
   *   preparing  → ready     | cancelled
   *   ready      → completed | out_for_delivery
   *   out_for_delivery → delivered
   *   delivered  → completed
   */
  app.patch(
    "/api/owner/orders/:orderId/status",
    isAuthenticated,
    wrap(async (req, res) => {
      const { orderId } = req.params;
      const { status, prepTimeMinutes } = z
        .object({
          status: z.enum([
            ORDER_STATUS.PREPARING,
            ORDER_STATUS.READY,
            ORDER_STATUS.OUT_FOR_DELIVERY,
            ORDER_STATUS.DELIVERED,
            ORDER_STATUS.COMPLETED,
            ORDER_STATUS.CANCELLED,
          ]),
          prepTimeMinutes: z.number().int().min(1).max(120).optional(),
          cancellationReason: z.string().max(500).optional(),
        })
        .parse(req.body);

      if (
        status === ORDER_STATUS.PREPARING &&
        !Number.isInteger(prepTimeMinutes)
      ) {
        return res.status(400).json({
          code: "PREPARATION_ESTIMATE_REQUIRED",
          message: "Choose a preparation estimate before starting this order.",
        });
      }

      const [order] = await db
        .select()
        .from(pickupOrders)
        .where(eq(pickupOrders.id, orderId));
      if (!order) return res.status(404).json({ message: "Order not found" });

      await assertOrderingWorkspaceAccess(req.user, order.restaurantId);

      // Validate transition
      const validTransitions: Record<string, string[]> = {
        [ORDER_STATUS.PENDING]: [ORDER_STATUS.CANCELLED],
        [ORDER_STATUS.CONFIRMED]: [
          ORDER_STATUS.PREPARING,
          ORDER_STATUS.CANCELLED,
        ],
        [ORDER_STATUS.PREPARING]: [ORDER_STATUS.READY, ORDER_STATUS.CANCELLED],
        [ORDER_STATUS.READY]:
          order.orderType === "delivery"
            ? [ORDER_STATUS.OUT_FOR_DELIVERY]
            : [ORDER_STATUS.COMPLETED],
        [ORDER_STATUS.OUT_FOR_DELIVERY]: [ORDER_STATUS.DELIVERED],
        [ORDER_STATUS.DELIVERED]: [ORDER_STATUS.COMPLETED],
        [ORDER_STATUS.CANCELLATION_PENDING]: [ORDER_STATUS.CANCELLED],
        [ORDER_STATUS.CANCELLED]: [ORDER_STATUS.CANCELLED],
      };
      const allowed = validTransitions[order.status] ?? [];
      if (!allowed.includes(status)) {
        return res.status(400).json({
          message: `Cannot transition from ${order.status} to ${status}`,
        });
      }

      if (
        order.paymentMethod === "card" &&
        status !== ORDER_STATUS.CANCELLED &&
        order.payoutStatus !== "transferred"
      ) {
        return res.status(409).json({
          code: "PAYOUT_RECONCILIATION_REQUIRED",
          message:
            "This card order cannot advance until customer payment and merchant settlement are both confirmed. Reconcile the payout or cancel and refund the order.",
        });
      }

      const now = new Date();
      const updates: Partial<PickupOrder & { updatedAt: Date }> = {
        status,
        updatedAt: now,
      };

      if (status === ORDER_STATUS.PREPARING) {
        updates.merchantAcknowledgedAt = now;
        updates.prepTimeMinutes = prepTimeMinutes;
      }
      if (status === ORDER_STATUS.READY) updates.readyAt = now;
      if (status === ORDER_STATUS.OUT_FOR_DELIVERY)
        updates.outForDeliveryAt = now;
      if (status === ORDER_STATUS.DELIVERED) updates.deliveredAt = now;
      if (status === ORDER_STATUS.COMPLETED) updates.completedAt = now;
      if (status === ORDER_STATUS.CANCELLED) {
        updates.cancelledAt = now;
        updates.cancellationReason =
          (req.body as any).cancellationReason || "Cancelled by restaurant";
      }

      let updated: PickupOrder | null;
      if (status === ORDER_STATUS.CANCELLED && order.paymentMethod === "card") {
        const result = await requestAndFinalizeCardPickupOrderCancellation({
          orderId,
          expectedStatuses: [order.status],
          cancellationReason: String(
            (req.body as any).cancellationReason || "Cancelled by restaurant",
          ),
          stripe,
          allowFailedRefundRetry:
            order.status === ORDER_STATUS.CANCELLATION_PENDING,
        });
        updated = result.outcome === "conflict" ? null : result.order;
      } else {
        let acknowledgementExpired = false;
        updated = await db.transaction(async (tx: any) => {
          // Every owner status transition shares the payment webhook's lock and
          // re-reads current state before its compare-and-swap update.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${pickupOrderFinancialLockKey(orderId)}))`,
          );
          const [lockedOrder] = await tx
            .select()
            .from(pickupOrders)
            .where(eq(pickupOrders.id, orderId))
            .limit(1);
          if (!lockedOrder || lockedOrder.status !== order.status) return null;
          if (
            lockedOrder.status === ORDER_STATUS.CONFIRMED &&
            status === ORDER_STATUS.PREPARING
          ) {
            const dueAtMs = new Date(
              String(lockedOrder.merchantAcknowledgementDueAt || ""),
            ).getTime();
            if (!Number.isFinite(dueAtMs) || dueAtMs <= now.getTime()) {
              acknowledgementExpired = true;
              return null;
            }
          }
          if (
            lockedOrder.paymentMethod === "card" &&
            status !== ORDER_STATUS.CANCELLED &&
            (lockedOrder.payoutStatus !== "transferred" ||
              Boolean(lockedOrder.stripeRefundId) ||
              Boolean(lockedOrder.stripeDisputeId))
          ) {
            return null;
          }

          const [updatedOrder] = await tx
            .update(pickupOrders)
            .set(updates)
            .where(
              and(
                eq(pickupOrders.id, orderId),
                eq(pickupOrders.status, lockedOrder.status),
              ),
            )
            .returning();
          if (!updatedOrder) return null;

          if (status === ORDER_STATUS.CANCELLED) {
            await restoreTrackedInventoryForPickupOrderByOrderId(
              tx,
              updatedOrder.id,
            );
          }
          return updatedOrder;
        });
        if (!updated && acknowledgementExpired) {
          const result = await requestAndFinalizeCardPickupOrderCancellation({
            orderId,
            expectedStatuses: [
              ORDER_STATUS.CONFIRMED,
              ORDER_STATUS.CANCELLATION_PENDING,
            ],
            cancellationReason: PICKUP_ORDER_ACKNOWLEDGEMENT_EXPIRED_REASON,
            stripe,
          });
          if (result.outcome === "cancelled") {
            await sendPickupOrderCancelledNotification(result.order);
          }
          if (result.outcome !== "conflict") {
            emitKitchenUpdate(order.restaurantId, result.order);
            return res.status(409).json({
              code: "ACKNOWLEDGEMENT_WINDOW_EXPIRED",
              message:
                "The response deadline passed. MealScout is cancelling the order and reconciling the customer refund.",
            });
          }
        }
      }

      if (!updated) {
        return res.status(409).json({
          message: "Order status changed before this update could be applied",
        });
      }

      if (
        status === ORDER_STATUS.CANCELLED &&
        updated.status === ORDER_STATUS.CANCELLED
      ) {
        sendPickupOrderCancelledNotification(updated).catch(console.error);
      }

      // Notify customer when order is ready
      if (status === ORDER_STATUS.READY && !order.readyNotificationSent) {
        sendPickupOrderReadyNotifications(updated).catch(console.error);
      }

      // Emit to kitchen display WebSocket room
      emitKitchenUpdate(order.restaurantId, updated);

      // Emit LISA claims for terminal status transitions
      if (status === ORDER_STATUS.COMPLETED) {
        await updatePromotedOrderCommissionStatus(order.id, "completed");
        db.insert(lisaClaims)
          .values({
            app: "mealscout",
            claimType: LISA_CLAIM_TYPES.ORDER_COMPLETED,
            source: LISA_CLAIM_SOURCES.ORDER,
            subjectType: "order",
            subjectId: updated.id,
            actorType: "restaurant",
            actorId: updated.restaurantId,
            payload: {
              totalCents: updated.totalCents,
              orderType: updated.orderType,
            },
          })
          .catch(() => {});
      } else if (
        status === ORDER_STATUS.CANCELLED &&
        updated.status === ORDER_STATUS.CANCELLED
      ) {
        await updatePromotedOrderCommissionStatus(order.id, "cancelled");
        db.insert(lisaClaims)
          .values({
            app: "mealscout",
            claimType: LISA_CLAIM_TYPES.ORDER_CANCELLED,
            source: LISA_CLAIM_SOURCES.ORDER,
            subjectType: "order",
            subjectId: updated.id,
            actorType: "restaurant",
            actorId: updated.restaurantId,
            payload: { cancellationReason: updated.cancellationReason },
          })
          .catch(() => {});
      }

      res.json({ order: updated });
    }),
  );

  // ── ─────────────────────────────────────────────────────────────────────────
  // CUSTOMER: View own order history
  // ── ─────────────────────────────────────────────────────────────────────────

  /**
   * GET /api/my/orders
   * Returns the authenticated customer's order history.
   */
  app.get(
    "/api/my/orders",
    isAuthenticated,
    wrap(async (req, res) => {
      const orders = await db
        .select()
        .from(pickupOrders)
        .where(eq(pickupOrders.customerId, req.user.id))
        .orderBy(desc(pickupOrders.createdAt))
        .limit(50);

      res.json({ orders });
    }),
  );
}
