import type { Express } from "express";
import { z } from "zod";
import Stripe from "stripe";
import { db } from "../db";
import { storage } from "../storage";
import {
  restaurants,
  supplierOrderItems,
  supplierProducts,
  supplierRequests,
  supplierRequestItems,
  supplyItemAliases,
  supplyItems,
  supplyOrderPreferences,
  supplyPriceAlerts,
  supplyPriceDailySnapshots,
  supplyPrices,
  supplyPriceWatches,
  supplyDemandNotifications,
  supplyDemands,
  supplyShoppingListItems,
  supplyShoppingLists,
  supplyStoreLocations,
  supplyStores,
  suppliers,
} from "@shared/schema";
import { and, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { isAuthenticated } from "../unifiedAuth";
import { emailService } from "../emailService";
import { distributedRateLimit } from "../middleware/distributedRateLimit";
import { requireIdempotencyKey } from "../middleware/idempotency";
import { enqueueInProcessJob } from "../jobs/jobQueue";
import { canEmailForTopic } from "../utils/notificationPreferences";
import { registerSupplierAdminOrdersRoutes } from "./suppliers/adminOrdersRoutes";
import { registerSupplierCatalogRoutes } from "./suppliers/catalogRoutes";
import { registerSupplierOnboardingRoutes } from "./suppliers/onboardingRoutes";
import { registerSupplierOrdersRoutes } from "./suppliers/ordersRoutes";
import { registerSupplierPaymentRoutes } from "./suppliers/paymentsRoutes";
import { registerSupplierProfileRoutes } from "./suppliers/profileRoutes";
import { registerSupplierRequestsRoutes } from "./suppliers/requestsRoutes";
import { registerSupplierSearchDemandRoutes } from "./suppliers/searchDemandRoutes";
import { registerSupplierShoppingListOptimizeRoutes } from "./suppliers/shoppingListOptimizeRoutes";
import { registerSupplierShoppingListsRoutes } from "./suppliers/shoppingListsRoutes";
import { registerSupplierSupplyIntelRoutes } from "./suppliers/supplyIntelRoutes";

const parsePageLimit = (raw: unknown, fallback: number, max: number) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
};

const parseBeforeTimestamp = (raw: unknown) => {
  const value = String(raw || "").trim();
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed;
};

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const computeOnPlatformPaymentFees = (supplierGrossCents: number) => {
  const gross = Math.max(0, Math.round(Number(supplierGrossCents || 0)));

  // Platform keeps a fixed $1 on supplier on-platform transactions by default.
  const platformBaseFeeCents = Math.max(
    0,
    Number(process.env.SUPPLIER_ORDER_PLATFORM_FIXED_CENTS || 100) || 100,
  );

  // Stripe processing estimate (cards are 2.9% + $0.30 by default).
  const stripeFeeBps = Math.max(
    0,
    Number(process.env.SUPPLIER_ORDER_STRIPE_FEE_BPS || 290) || 290,
  );
  const stripeFeeFixed = Math.max(
    0,
    Number(process.env.SUPPLIER_ORDER_STRIPE_FEE_FIXED_CENTS || 30) || 30,
  );
  const stripeFeeEstimateCents =
    Math.max(0, Math.round((gross * stripeFeeBps) / 10_000)) + stripeFeeFixed;

  // Optional MealScout processing overhead to include in split.
  const msProcessingFeeBps = Math.max(
    0,
    Number(process.env.SUPPLIER_ORDER_MS_PROCESSING_FEE_BPS || 0) || 0,
  );
  const msProcessingFeeFixedCents = Math.max(
    0,
    Number(process.env.SUPPLIER_ORDER_MS_PROCESSING_FIXED_CENTS || 0) || 0,
  );
  const msProcessingFeeCents =
    Math.max(0, Math.round((gross * msProcessingFeeBps) / 10_000)) +
    msProcessingFeeFixedCents;

  const processingTotalCents = stripeFeeEstimateCents + msProcessingFeeCents;

  // Split processing costs between buyer and seller.
  const buyerProcessingFeeCents = Math.ceil(processingTotalCents / 2);
  const sellerProcessingFeeCents = Math.max(
    0,
    processingTotalCents - buyerProcessingFeeCents,
  );

  // `platformFeeCents` is what seller contributes to the platform side.
  const platformFeeCents = platformBaseFeeCents + sellerProcessingFeeCents;

  // Buyer pays: supplier gross + buyer share + $1 platform fee.
  const totalCents = gross + buyerProcessingFeeCents + platformBaseFeeCents;

  return {
    platformBaseFeeCents,
    platformFeeCents,
    stripeFeeEstimateCents,
    msProcessingFeeCents,
    processingTotalCents,
    buyerProcessingFeeCents,
    sellerProcessingFeeCents,
    totalCents,
  };
};

const estimateCardProcessingFeeCents = (amountCents: number) => {
  const amount = Math.max(0, Math.round(Number(amountCents || 0)));
  const cardBps = Math.max(
    0,
    Number(process.env.SUPPLIER_ORDER_STRIPE_FEE_BPS || 290) || 290,
  );
  const cardFixed = Math.max(
    0,
    Number(process.env.SUPPLIER_ORDER_STRIPE_FEE_FIXED_CENTS || 30) || 30,
  );
  return Math.max(0, Math.round((amount * cardBps) / 10_000)) + cardFixed;
};

const estimateAchProcessingFeeCents = (amountCents: number) => {
  const amount = Math.max(0, Math.round(Number(amountCents || 0)));
  const achBps = Math.max(
    0,
    Number(process.env.SUPPLIER_ORDER_ACH_FEE_BPS || 80) || 80,
  );
  const achFixed = Math.max(
    0,
    Number(process.env.SUPPLIER_ORDER_ACH_FEE_FIXED_CENTS || 0) || 0,
  );
  const achCapRaw = String(
    process.env.SUPPLIER_ORDER_ACH_FEE_CAP_CENTS || "",
  ).trim();
  const achCapCents =
    achCapRaw === ""
      ? 500
      : Math.max(
          0,
          Number(process.env.SUPPLIER_ORDER_ACH_FEE_CAP_CENTS || 0) || 0,
        );

  const percentPart = Math.max(0, Math.round((amount * achBps) / 10_000));
  const uncapped = percentPart + achFixed;
  if (achCapCents > 0) return Math.min(uncapped, achCapCents);
  return uncapped;
};

const computeAchCheaperThresholdCents = () => {
  const minAmount = Math.max(
    1,
    Number(process.env.SUPPLIER_ORDER_ACH_CHEAPER_MIN_SCAN_CENTS || 100) || 100,
  );
  const maxAmount = Math.max(
    minAmount,
    Number(process.env.SUPPLIER_ORDER_ACH_CHEAPER_MAX_SCAN_CENTS || 500_000) ||
      500_000,
  );
  const step = Math.max(
    1,
    Number(process.env.SUPPLIER_ORDER_ACH_CHEAPER_SCAN_STEP_CENTS || 1) || 1,
  );

  for (let amount = minAmount; amount <= maxAmount; amount += step) {
    if (
      estimateAchProcessingFeeCents(amount) <=
      estimateCardProcessingFeeCents(amount)
    ) {
      return amount;
    }
  }

  return maxAmount;
};

const normalizeSupplyKey = (raw: string) =>
  String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const haversineMiles = (
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
) => {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 3958.7613; // earth radius (miles)
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

async function resolveBuyerRestaurantOrThrow(
  req: any,
  buyerRestaurantId: string,
) {
  const buyerRestaurant = await storage.getRestaurant(buyerRestaurantId);
  if (
    !buyerRestaurant ||
    String(buyerRestaurant.ownerId) !== String(req.user.id)
  ) {
    throw new Error("Not authorized");
  }
  return buyerRestaurant;
}

async function resolveBuyerRestaurantOrNull(
  req: any,
  buyerRestaurantId: unknown,
) {
  const id = String(buyerRestaurantId || "").trim();
  if (!id) return null;
  return resolveBuyerRestaurantOrThrow(req, id);
}

async function resolveSupplyShoppingListOrThrow(req: any, listId: string) {
  const [list] = await db
    .select()
    .from(supplyShoppingLists)
    .where(eq(supplyShoppingLists.id, String(listId)))
    .limit(1);
  if (!list) throw new Error("List not found");
  if (String((list as any).ownerUserId) !== String(req.user.id)) {
    throw new Error("Not authorized");
  }
  return list as any;
}

async function findLocalSuppliersForBuyer(buyerRestaurant: any) {
  const radiusMiles = Number(process.env.SUPPLY_LOCAL_RADIUS_MILES || 75) || 75;
  const limit = Math.min(
    Number(process.env.SUPPLY_LOCAL_SUPPLIER_LIMIT || 60) || 60,
    200,
  );

  const conditions: any[] = [eq(suppliers.isActive, true)];
  const buyerState = String((buyerRestaurant as any).state || "").trim();
  if (buyerState) conditions.push(eq(suppliers.state, buyerState));

  const candidates = await db
    .select()
    .from(suppliers)
    .where(and(...conditions))
    .orderBy(desc(suppliers.updatedAt))
    .limit(500);

  const buyerLat = Number((buyerRestaurant as any).latitude);
  const buyerLon = Number((buyerRestaurant as any).longitude);
  const hasBuyerCoords = Number.isFinite(buyerLat) && Number.isFinite(buyerLon);

  if (!hasBuyerCoords) {
    return candidates.slice(0, limit);
  }

  const withDistance = (candidates as any[])
    .map((s: any) => {
      const lat = Number(s.latitude);
      const lon = Number(s.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const distanceMiles = haversineMiles(
        { lat: buyerLat, lon: buyerLon },
        { lat, lon },
      );
      return { supplier: s, distanceMiles };
    })
    .filter(Boolean) as Array<{ supplier: any; distanceMiles: number }>;

  return withDistance
    .filter((r) => r.distanceMiles <= radiusMiles)
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, limit)
    .map((r) => r.supplier);
}

async function searchSupplierProductsForTerms(params: {
  terms: string[];
  buyerRestaurant: any | null;
  limit: number;
}) {
  const terms = params.terms
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .slice(0, 100);
  if (terms.length === 0) return [];

  const conditions: any[] = [
    eq(supplierProducts.isActive, true),
    eq(suppliers.isActive, true),
  ];

  const buyerState = params.buyerRestaurant
    ? String((params.buyerRestaurant as any).state || "").trim()
    : "";
  if (buyerState) conditions.push(eq(suppliers.state, buyerState));

  const orConditions: any[] = [];
  for (const t of terms) {
    orConditions.push(ilike(supplierProducts.name, `%${t}%`));
    orConditions.push(ilike(supplierProducts.sku, `%${t}%`));
  }
  conditions.push(or(...orConditions));

  return db
    .select({
      product: supplierProducts,
      supplier: suppliers,
    })
    .from(supplierProducts)
    .innerJoin(suppliers, eq(supplierProducts.supplierId, suppliers.id))
    .where(and(...conditions))
    .orderBy(desc(supplierProducts.updatedAt))
    .limit(Math.min(Math.max(params.limit, 50), 1500));
}

async function recordDemandAndNotifyIfUnlisted(params: {
  buyerRestaurant?: any | null;
  itemNameRaw: string;
  quantity?: number | null;
  source: "manual" | "request" | "import";
}) {
  const itemName = String(params.itemNameRaw || "").trim();
  const itemKey = normalizeSupplyKey(itemName);
  if (!itemKey) return { created: false, notified: 0, reason: "empty_key" };

  const [existing] = await db
    .select({ id: supplierProducts.id })
    .from(supplierProducts)
    .where(
      and(
        eq(supplierProducts.isActive, true),
        or(
          ilike(supplierProducts.name, `%${itemName}%`),
          ilike(supplierProducts.sku, `%${itemName}%`),
        ),
      ),
    )
    .limit(1);
  if (existing)
    return { created: false, notified: 0, reason: "already_listed" };

  const now = new Date();
  const buyer = params.buyerRestaurant ?? null;
  const [demand] = await db
    .insert(supplyDemands)
    .values({
      buyerRestaurantId: buyer ? String((buyer as any).id) : null,
      itemKey,
      itemName,
      quantity: params.quantity ?? null,
      buyerCity: buyer ? ((buyer as any).city ?? null) : null,
      buyerState: buyer ? ((buyer as any).state ?? null) : null,
      buyerLatitude: buyer ? ((buyer as any).latitude ?? null) : null,
      buyerLongitude: buyer ? ((buyer as any).longitude ?? null) : null,
      source: params.source,
      createdAt: now,
      updatedAt: now,
    } as any)
    .returning();

  const notifyEnabled =
    String(process.env.SUPPLY_DEMAND_NOTIFY || "").toLowerCase() !== "false";
  if (!notifyEnabled)
    return { created: true, notified: 0, demandId: demand?.id };
  if (!buyer) return { created: true, notified: 0, demandId: demand?.id };

  const localSuppliers = await findLocalSuppliersForBuyer(buyer);
  if (localSuppliers.length === 0)
    return { created: true, notified: 0, demandId: demand?.id };

  const supplierIds = localSuppliers.map((s: any) => String(s.id));
  const existingNotifs = await db
    .select()
    .from(supplyDemandNotifications)
    .where(
      and(
        eq(supplyDemandNotifications.itemKey, itemKey),
        inArray(supplyDemandNotifications.supplierId, supplierIds),
      ),
    );

  const notifBySupplierId = new Map<string, any>(
    (existingNotifs as any[]).map((n: any) => [String(n.supplierId), n]),
  );

  const ttlHours =
    Number(process.env.SUPPLY_DEMAND_NOTIFY_TTL_HOURS || 24) || 24;
  const ttlMs = ttlHours * 60 * 60 * 1000;
  const nowMs = now.getTime();

  const toNotify = (localSuppliers as any[]).filter((s: any) => {
    const n = notifBySupplierId.get(String(s.id));
    if (!n) return true;
    const last = n.lastNotifiedAt ? new Date(n.lastNotifiedAt).getTime() : 0;
    return nowMs - last > ttlMs;
  });

  let notified = 0;
  for (const supplier of toNotify) {
    try {
      const supplierUser = await storage
        .getUser(String((supplier as any).userId))
        .catch(() => null);
      const to =
        String((supplier as any).contactEmail || "").trim() ||
        String((supplierUser as any)?.email || "").trim();
      if (!to) continue;
      if (!canEmailForTopic((supplierUser as any)?.accountSettings, "businessMessages")) {
        continue;
      }

      const baseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:5000";
      const manageUrl = `${baseUrl.replace(/\/+$/, "")}/supplier/dashboard`;
      const location = [
        params.buyerRestaurant.city,
        params.buyerRestaurant.state,
      ]
        .map((s: any) => String(s || "").trim())
        .filter(Boolean)
        .join(", ");
      const subject = location
        ? `In-demand item near ${location}: ${itemName}`
        : `In-demand item: ${itemName}`;
      const html = `
        <h2>Item in demand</h2>
        <p><strong>Item:</strong> ${itemName}</p>
        ${location ? `<p><strong>Area:</strong> ${location}</p>` : ""}
        <p>A local vendor searched for this item but it isn't listed yet.</p>
        <p style="margin: 18px 0;">
          <a href="${manageUrl}" class="cta-button">Add it to your catalog</a>
        </p>
      `;
      enqueueInProcessJob("supply-demand-email", async () => {
        await emailService.sendBasicEmail(
          to,
          subject,
          html,
          undefined,
          "marketing",
        );
      });

      await db
        .insert(supplyDemandNotifications)
        .values({
          supplierId: String((supplier as any).id),
          itemKey,
          lastNotifiedAt: now,
        } as any)
        .onConflictDoUpdate({
          target: [
            supplyDemandNotifications.supplierId,
            supplyDemandNotifications.itemKey,
          ] as any,
          set: { lastNotifiedAt: now } as any,
        });

      notified += 1;
    } catch (e) {
      console.warn("Demand notify failed:", e);
    }
  }

  return { created: true, notified, demandId: demand?.id };
}

async function ensureSupplierProfile(userId: string) {
  const [existing] = await db
    .select()
    .from(suppliers)
    .where(eq(suppliers.userId, userId))
    .limit(1);
  if (existing) return existing;

  const user = await storage.getUser(userId).catch(() => null);

  const [created] = await db
    .insert(suppliers)
    .values({
      userId,
      businessName: "New Supplier",
      contactEmail: (user as any)?.email ?? null,
      isActive: true,
    } as any)
    .returning();
  try {
    const { rememberProfileSalesAssistant } = await import(
      "../services/profileSalesAssistantStore"
    );
    rememberProfileSalesAssistant("vendor", created.id, "public");
  } catch (error) {
    console.warn("[profile-sales-assistant] vendor ensure failed", error);
  }
  return created;
}

const isSupplierProfileOrAdmin = async (req: any, res: any, next: any) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({ error: "Authentication required" });
  }

  if (req.user?.isDisabled) {
    return res.status(403).json({ error: "Account disabled" });
  }

  const userType = String(req.user?.userType || "");
  if (["supplier", "admin", "duper_admin", "super_admin"].includes(userType)) {
    return next();
  }

  try {
    const [existing] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(eq(suppliers.userId, String(req.user.id)))
      .limit(1);

    if (existing) {
      return next();
    }
  } catch (error) {
    console.error("Error checking supplier profile access:", error);
    return res
      .status(500)
      .json({ message: "Failed to verify supplier access" });
  }

  return res.status(403).json({
    error: "Forbidden",
    message: "Supplier profile required",
  });
};

async function ensureSupplyOrderPreferences(userId: string) {
  const [existing] = await db
    .select()
    .from(supplyOrderPreferences)
    .where(eq(supplyOrderPreferences.userId, userId))
    .limit(1);
  if (existing) return existing;

  const now = new Date();
  const [created] = await db
    .insert(supplyOrderPreferences)
    .values({
      userId,
      maxStops: 2,
      maxRadiusMiles: 20,
      costPerStopCents: 0,
      stopMinutes: 10,
      costPerMinuteCents: 0,
      pingSuppliers: true,
      allowSubstitutions: true,
      createdAt: now,
      updatedAt: now,
    } as any)
    .returning();
  return created;
}

const toDayKey = (value: Date) => {
  const yyyy = value.getUTCFullYear();
  const mm = String(value.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(value.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

async function resolveSupplyItemIds(params: {
  itemKey?: string | null;
  itemName?: string | null;
}) {
  const rawKey = String(params.itemKey || "").trim();
  const rawName = String(params.itemName || "").trim();
  const normalizedKey = normalizeSupplyKey(rawKey || rawName);

  const itemCandidates = await db
    .select({
      id: supplyItems.id,
      itemKey: supplyItems.itemKey,
      canonicalName: supplyItems.canonicalName,
    })
    .from(supplyItems)
    .where(
      or(
        eq(supplyItems.itemKey, normalizedKey),
        ilike(supplyItems.canonicalName, `%${rawName || rawKey}%`),
      ),
    )
    .limit(30);

  const aliasCandidates = await db
    .select({ itemId: supplyItemAliases.itemId })
    .from(supplyItemAliases)
    .where(
      or(
        eq(supplyItemAliases.aliasKey, normalizedKey),
        ilike(supplyItemAliases.alias, `%${rawName || rawKey}%`),
      ),
    )
    .limit(40);

  const itemIds = Array.from(
    new Set([
      ...itemCandidates.map((row: any) => String(row.id || "")).filter(Boolean),
      ...aliasCandidates
        .map((row: any) => String(row.itemId || ""))
        .filter(Boolean),
    ]),
  );

  return {
    normalizedKey,
    itemIds,
    canonicalName: String(
      itemCandidates[0]?.canonicalName || rawName || rawKey || normalizedKey,
    ),
  };
}

async function getLocalizedPriceOffers(params: {
  itemKey?: string | null;
  itemName?: string | null;
  buyerRestaurant?: any | null;
  maxRadiusMiles?: number | null;
}) {
  const { itemIds } = await resolveSupplyItemIds({
    itemKey: params.itemKey,
    itemName: params.itemName,
  });
  if (itemIds.length === 0) return [] as any[];

  const priceRows = await db
    .select()
    .from(supplyPrices)
    .where(
      and(
        inArray(supplyPrices.itemId, itemIds),
        eq(supplyPrices.currency, "usd"),
      ),
    )
    .orderBy(desc(supplyPrices.observedAt))
    .limit(2000);
  if (priceRows.length === 0) return [] as any[];

  const storeIds = Array.from(
    new Set(
      (priceRows as any[])
        .map((row) => String(row.storeId || ""))
        .filter(Boolean),
    ),
  );
  const locationIds = Array.from(
    new Set(
      (priceRows as any[])
        .map((row) => String(row.storeLocationId || ""))
        .filter(Boolean),
    ),
  );

  const [stores, locations] = await Promise.all([
    storeIds.length > 0
      ? db
          .select()
          .from(supplyStores)
          .where(
            and(
              inArray(supplyStores.id, storeIds),
              eq(supplyStores.isActive, true),
            ),
          )
      : Promise.resolve([] as any[]),
    locationIds.length > 0
      ? db
          .select()
          .from(supplyStoreLocations)
          .where(
            and(
              inArray(supplyStoreLocations.id, locationIds),
              eq(supplyStoreLocations.isActive, true),
            ),
          )
      : Promise.resolve([] as any[]),
  ]);

  const storeById = new Map(
    (stores as any[]).map((row: any) => [String(row.id), row]),
  );
  const locationById = new Map(
    (locations as any[]).map((row: any) => [String(row.id), row]),
  );

  const buyerLat = Number(params.buyerRestaurant?.latitude);
  const buyerLon = Number(params.buyerRestaurant?.longitude);
  const buyerState = String(params.buyerRestaurant?.state || "").trim();
  const hasBuyerCoords = Number.isFinite(buyerLat) && Number.isFinite(buyerLon);
  const maxRadius = Math.max(1, Number(params.maxRadiusMiles || 25) || 25);

  return (priceRows as any[])
    .map((price: any) => {
      const store = storeById.get(String(price.storeId || ""));
      if (!store) return null;
      const location = price.storeLocationId
        ? locationById.get(String(price.storeLocationId || "")) || null
        : null;

      if (buyerState) {
        const locationState = String(location?.state || "").trim();
        if (locationState && locationState !== buyerState) {
          return null;
        }
      }

      const lat = Number(location?.latitude);
      const lon = Number(location?.longitude);
      const distanceMiles =
        hasBuyerCoords && Number.isFinite(lat) && Number.isFinite(lon)
          ? haversineMiles({ lat: buyerLat, lon: buyerLon }, { lat, lon })
          : null;

      if (distanceMiles !== null && distanceMiles > maxRadius) {
        return null;
      }

      return {
        unitPriceCents: Number(price.unitPriceCents || 0),
        observedAt: price.observedAt,
        storeId: String(store.id),
        storeName: String(store.name || "Unknown store"),
        storeLocationId: location ? String(location.id) : null,
        storeCity: location?.city ? String(location.city) : null,
        storeState: location?.state ? String(location.state) : null,
        distanceMiles,
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => {
      if (a.unitPriceCents !== b.unitPriceCents)
        return a.unitPriceCents - b.unitPriceCents;
      const aObserved = new Date(a.observedAt || 0).getTime();
      const bObserved = new Date(b.observedAt || 0).getTime();
      return bObserved - aObserved;
    });
}

async function getWatchSnapshotTrend(params: {
  itemKey: string;
  areaKey: string;
  limitDays: number;
}) {
  const snapshots = await db
    .select({
      snapshotDay: supplyPriceDailySnapshots.snapshotDay,
      medianPriceCents: supplyPriceDailySnapshots.medianPriceCents,
      minPriceCents: supplyPriceDailySnapshots.minPriceCents,
      maxPriceCents: supplyPriceDailySnapshots.maxPriceCents,
      sampleCount: supplyPriceDailySnapshots.sampleCount,
    })
    .from(supplyPriceDailySnapshots)
    .where(
      and(
        eq(supplyPriceDailySnapshots.itemKey, params.itemKey),
        eq(supplyPriceDailySnapshots.areaKey, params.areaKey),
      ),
    )
    .orderBy(desc(supplyPriceDailySnapshots.snapshotDay))
    .limit(Math.max(2, params.limitDays));

  const newest = snapshots[0] as any;
  const newestMedian =
    newest?.medianPriceCents === null || newest?.medianPriceCents === undefined
      ? null
      : Number(newest.medianPriceCents);

  const day7 = snapshots[6] as any;
  const day30 = snapshots[29] as any;

  const median7 =
    day7?.medianPriceCents === null || day7?.medianPriceCents === undefined
      ? null
      : Number(day7.medianPriceCents);
  const median30 =
    day30?.medianPriceCents === null || day30?.medianPriceCents === undefined
      ? null
      : Number(day30.medianPriceCents);

  const pct = (latest: number | null, baseline: number | null) => {
    if (latest === null || baseline === null || baseline <= 0) return null;
    return Number((((latest - baseline) / baseline) * 100).toFixed(1));
  };

  return {
    sampleDays: snapshots.length,
    newestMedian,
    median7,
    median30,
    trend7dPct: pct(newestMedian, median7),
    trend30dPct: pct(newestMedian, median30),
  };
}

export function registerSupplierMarketplaceRoutes(app: Express) {
  // Register extracted supplier catalog routes.
  registerSupplierCatalogRoutes(app);
  registerSupplierOrdersRoutes(app, {
    isSupplierProfileOrAdmin,
    ensureSupplierProfile,
    parsePageLimit,
    parseBeforeTimestamp,
    resolveBuyerRestaurantOrThrow,
    computeOnPlatformPaymentFees,
    stripe,
  });
  registerSupplierPaymentRoutes(app, {
    computeOnPlatformPaymentFees,
    computeAchCheaperThresholdCents,
    stripe,
  });
  registerSupplierOnboardingRoutes(app, {
    isSupplierProfileOrAdmin,
    ensureSupplierProfile,
    stripe,
  });
  registerSupplierProfileRoutes(app, {
    isSupplierProfileOrAdmin,
    ensureSupplierProfile,
  });
  registerSupplierSupplyIntelRoutes(app, {
    ensureSupplyOrderPreferences,
    resolveBuyerRestaurantOrThrow,
    normalizeSupplyKey,
    toDayKey,
    getLocalizedPriceOffers,
    getWatchSnapshotTrend,
  });
  registerSupplierShoppingListsRoutes(app, {
    resolveBuyerRestaurantOrThrow,
    resolveSupplyShoppingListOrThrow,
  });
  registerSupplierShoppingListOptimizeRoutes(app, {
    resolveBuyerRestaurantOrNull,
    resolveBuyerRestaurantOrThrow,
    resolveSupplyShoppingListOrThrow,
    ensureSupplyOrderPreferences,
    searchSupplierProductsForTerms,
    normalizeSupplyKey,
    haversineMiles,
    recordDemandAndNotifyIfUnlisted,
  });
  registerSupplierSearchDemandRoutes(app, {
    resolveBuyerRestaurantOrThrow,
    resolveBuyerRestaurantOrNull,
    haversineMiles,
    recordDemandAndNotifyIfUnlisted,
  });
  registerSupplierRequestsRoutes(app, {
    isSupplierProfileOrAdmin,
    ensureSupplierProfile,
    resolveBuyerRestaurantOrThrow,
    resolveBuyerRestaurantOrNull,
    haversineMiles,
    normalizeSupplyKey,
    recordDemandAndNotifyIfUnlisted,
    computeOnPlatformPaymentFees,
  });
  registerSupplierAdminOrdersRoutes(app, {
    parsePageLimit,
    parseBeforeTimestamp,
  });
}
