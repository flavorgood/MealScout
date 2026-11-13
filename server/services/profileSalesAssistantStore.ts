import { and, eq, or } from "drizzle-orm";
import {
  deals,
  eventSeries,
  hosts,
  menuItems,
  profileSalesAssistantConfigs,
  profileSalesInquiries,
  restaurants,
  supplierProducts,
  suppliers,
} from "@shared/schema";
import {
  backfillProfileSalesAssistants,
  PROFILE_SALES_CUSTOMER_COPY,
  buildSalesInquiry,
  completeSalesInquiry,
  ensureProfileSalesConfig,
  marketingOptInFromVisitor,
  qualifySalesInquiry,
  quoteListedOffers,
  type ProfileSalesAssistantConfig,
  type ProfileSalesKind,
  type ProfileSalesSource,
  type SalesAssistantRepository,
  type SalesInquiryRecord,
} from "@shared/profileSalesAssistant";
import { canonicalPublicRestaurantProfileEntity } from "../publicProfiles/admitPublicRestaurant";
import { isPublicBusinessVisible } from "../utils/publicBusinessVisibility";
import { db } from "../db";

type EnsureMode = "public" | "claim";

const configFromRow = (row: {
  defaults: unknown;
}): ProfileSalesAssistantConfig => row.defaults as ProfileSalesAssistantConfig;

const repository = (): SalesAssistantRepository => ({
  async findConfig(profileKind, profileId) {
    const [row] = await db
      .select({ defaults: profileSalesAssistantConfigs.defaults })
      .from(profileSalesAssistantConfigs)
      .where(
        and(
          eq(profileSalesAssistantConfigs.profileKind, profileKind),
          eq(profileSalesAssistantConfigs.profileId, profileId),
        ),
      )
      .limit(1);
    return row ? configFromRow(row) : null;
  },
  async saveConfig(config) {
    const [existing] = await db
      .select({
        id: profileSalesAssistantConfigs.id,
        defaults: profileSalesAssistantConfigs.defaults,
      })
      .from(profileSalesAssistantConfigs)
      .where(
        and(
          eq(profileSalesAssistantConfigs.profileKind, config.profileKind),
          eq(profileSalesAssistantConfigs.profileId, config.profileId),
        ),
      )
      .limit(1);
    if (existing) {
      const current = existing.defaults as ProfileSalesAssistantConfig;
      const unchanged =
        current.displayName === config.displayName &&
        JSON.stringify(current.offers) === JSON.stringify(config.offers) &&
        JSON.stringify(current.bookingPreferences) ===
          JSON.stringify(config.bookingPreferences);
      if (!unchanged) {
        await db
          .update(profileSalesAssistantConfigs)
          .set({
            defaults: config,
            enabled: true,
            solicitationGuard: true,
            marketingOptInDefault: false,
            quotePolicy: "listed_items_only",
            contractVersion: config.contractVersion,
            updatedAt: new Date(),
          })
          .where(eq(profileSalesAssistantConfigs.id, existing.id));
      }
      return "existing";
    }
    try {
      await db.insert(profileSalesAssistantConfigs).values({
        profileKind: config.profileKind,
        profileId: config.profileId,
        contractVersion: config.contractVersion,
        enabled: true,
        solicitationGuard: true,
        marketingOptInDefault: false,
        quotePolicy: "listed_items_only",
        defaults: config,
      });
      return "created";
    } catch (error: any) {
      if (String(error?.code) !== "23505") throw error;
      await db
        .update(profileSalesAssistantConfigs)
        .set({ defaults: config, updatedAt: new Date() })
        .where(
          and(
            eq(profileSalesAssistantConfigs.profileKind, config.profileKind),
            eq(profileSalesAssistantConfigs.profileId, config.profileId),
          ),
        );
      return "existing";
    }
  },
  async writeInquiry(record) {
    const [config] = await db
      .select({ id: profileSalesAssistantConfigs.id })
      .from(profileSalesAssistantConfigs)
      .where(
        and(
          eq(profileSalesAssistantConfigs.profileKind, record.profileKind),
          eq(profileSalesAssistantConfigs.profileId, record.profileId),
        ),
      )
      .limit(1);
    if (!config) throw new Error("PROFILE_SALES_CONFIG_MISSING");
    const [inquiry] = await db
      .insert(profileSalesInquiries)
      .values({
        configId: config.id,
        profileKind: record.profileKind,
        profileId: record.profileId,
        qualification: record.qualification,
        quote: record.quote,
        completion: record.completion,
        marketingOptIn: record.marketingOptIn,
        customerName:
          typeof record.completion.body?.customerName === "string"
            ? record.completion.body.customerName
            : null,
      })
      .returning({ id: profileSalesInquiries.id });
    return { id: inquiry.id };
  },
});

function dealTerms(deal: { dealType?: string | null; discountValue?: unknown }) {
  const value = String(deal.discountValue ?? "").trim();
  if (!value) return null;
  if (deal.dealType === "percentage") return `${value}% off`;
  if (deal.dealType === "fixed") return `$${value} off`;
  return null;
}

async function loadTruckSource(
  profileId: string,
  mode: EnsureMode,
): Promise<ProfileSalesSource | null> {
  const [row] = await db
    .select()
    .from(restaurants)
    .where(eq(restaurants.id, profileId))
    .limit(1);
  if (!row || canonicalPublicRestaurantProfileEntity(row) !== "truck") return null;
  const claimed = Boolean(row.claimedFromImportId);
  const visible = Boolean(row.isActive) && isPublicBusinessVisible(row);
  if (mode === "public" && !visible) return null;
  if (mode === "claim" && !visible && !claimed) return null;
  const [items, activeDeals] = await Promise.all([
    db
      .select({
        id: menuItems.id,
        name: menuItems.name,
        priceCents: menuItems.priceCents,
        menuId: menuItems.menuId,
      })
      .from(menuItems)
      .where(
        and(eq(menuItems.restaurantId, row.id), eq(menuItems.isAvailable, true)),
      ),
    db
      .select({
        id: deals.id,
        title: deals.title,
        dealType: deals.dealType,
        discountValue: deals.discountValue,
      })
      .from(deals)
      .where(and(eq(deals.restaurantId, row.id), eq(deals.isActive, true))),
  ]);
  return {
    profileKind: "truck",
    profileId: row.id,
    displayName: row.name,
    offers: [
      ...items.map((item: (typeof items)[number]) => ({
        id: item.id,
        source: "menu_item" as const,
        name: item.name,
        priceCents: item.priceCents,
        menuId: item.menuId,
      })),
      ...activeDeals.map((deal: (typeof activeDeals)[number]) => ({
        id: deal.id,
        source: "deal" as const,
        name: deal.title,
        listedTerms: dealTerms(deal),
      })),
    ],
  };
}

async function loadHostSource(profileId: string): Promise<ProfileSalesSource | null> {
  const [host] = await db.select().from(hosts).where(eq(hosts.id, profileId)).limit(1);
  if (
    !host ||
    !isPublicBusinessVisible({
      name: host.businessName,
      city: host.city,
      state: host.state,
    })
  ) {
    return null;
  }
  const [series] = await db
    .select({ id: eventSeries.id, status: eventSeries.status })
    .from(eventSeries)
    .where(
      and(
        eq(eventSeries.hostId, host.id),
        eq(eventSeries.seriesType, "parking_pass"),
        eq(eventSeries.status, "published"),
      ),
    )
    .limit(1);
  const passId = series?.id || null;
  const slots = [
    ["Breakfast parking", host.parkingPassBreakfastPriceCents],
    ["Lunch parking", host.parkingPassLunchPriceCents],
    ["Dinner parking", host.parkingPassDinnerPriceCents],
    ["Daily parking", host.parkingPassDailyPriceCents],
    ["Weekly parking", host.parkingPassWeeklyPriceCents],
    ["Monthly parking", host.parkingPassMonthlyPriceCents],
  ] as const;
  return {
    profileKind: "host",
    profileId: host.id,
    displayName: host.businessName,
    bookingPreferences: {
      daysOfWeek: Array.isArray(host.parkingPassDaysOfWeek)
        ? host.parkingPassDaysOfWeek.map((day: unknown) => String(day))
        : [],
      startTime: host.parkingPassStartTime,
      endTime: host.parkingPassEndTime,
    },
    offers: slots.map(([name, priceCents], index) => ({
      id: `${host.id}:parking:${index}`,
      source: "host_parking" as const,
      name,
      priceCents,
      bookingPassId: passId,
    })),
  };
}

async function loadVendorSource(profileId: string): Promise<ProfileSalesSource | null> {
  const [supplier] = await db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, profileId), eq(suppliers.isActive, true)))
    .limit(1);
  if (
    !supplier ||
    !isPublicBusinessVisible({
      name: supplier.businessName,
      city: supplier.city,
      state: supplier.state,
    })
  ) {
    return null;
  }
  const products = await db
    .select({
      id: supplierProducts.id,
      name: supplierProducts.name,
      priceCents: supplierProducts.priceCents,
    })
    .from(supplierProducts)
    .where(
      and(
        eq(supplierProducts.supplierId, supplier.id),
        eq(supplierProducts.isActive, true),
      ),
    );
  return {
    profileKind: "vendor",
    profileId: supplier.id,
    displayName: supplier.businessName,
    offers: products.map((product: (typeof products)[number]) => ({
      id: product.id,
      source: "supplier_product" as const,
      name: product.name,
      priceCents: product.priceCents,
    })),
  };
}

export async function loadProfileSalesSource(
  profileKind: ProfileSalesKind,
  profileId: string,
  mode: EnsureMode = "public",
): Promise<ProfileSalesSource | null> {
  if (profileKind === "truck") return loadTruckSource(profileId, mode);
  if (profileKind === "host") return loadHostSource(profileId);
  return loadVendorSource(profileId);
}

export async function ensureProfileSalesAssistant(
  profileKind: ProfileSalesKind,
  profileId: string,
  mode: EnsureMode = "public",
) {
  const source = await loadProfileSalesSource(profileKind, profileId, mode);
  if (!source) return null;
  return ensureProfileSalesConfig(source, repository());
}

export function rememberProfileSalesAssistant(
  profileKind: ProfileSalesKind,
  profileId: string,
  mode: EnsureMode = "public",
) {
  void ensureProfileSalesAssistant(profileKind, profileId, mode).catch((error) => {
    console.warn("[profile-sales-assistant] ensure failed", error);
  });
}

export async function backfillExistingProfileSalesAssistants() {
  const [truckRows, hostRows, vendorRows] = await Promise.all([
    db
      .select({ id: restaurants.id })
      .from(restaurants)
      .where(
        or(
          eq(restaurants.isFoodTruck, true),
          eq(restaurants.businessType, "food_truck"),
        ),
      ),
    db.select({ id: hosts.id }).from(hosts),
    db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(eq(suppliers.isActive, true)),
  ]);
  const sources: ProfileSalesSource[] = [];
  for (const row of truckRows) {
    const source = await loadTruckSource(row.id, "claim");
    if (source) sources.push(source);
  }
  for (const row of hostRows) {
    const source = await loadHostSource(row.id);
    if (source) sources.push(source);
  }
  for (const row of vendorRows) {
    const source = await loadVendorSource(row.id);
    if (source) sources.push(source);
  }
  return backfillProfileSalesAssistants(sources, repository());
}

export async function inquireOnProfileSalesAssistant(input: {
  profileKind: ProfileSalesKind;
  profileId: string;
  what: unknown;
  where: unknown;
  when: unknown;
  headcount?: unknown;
  marketingOptIn?: unknown;
  customerName?: unknown;
  customerEmail?: unknown;
  customerPhone?: unknown;
}): Promise<
  | { ok: false; status: number; code: string; customerMessage: string }
  | { ok: true; inquiryId: string; record: SalesInquiryRecord }
> {
  const ensured = await ensureProfileSalesAssistant(
    input.profileKind,
    input.profileId,
    "public",
  );
  if (!ensured) {
    return {
      ok: false,
      status: 404,
      code: "PROFILE_NOT_PUBLIC",
      customerMessage: PROFILE_SALES_CUSTOMER_COPY.unavailable,
    };
  }
  const qualified = qualifySalesInquiry({
    profileKind: input.profileKind,
    what: input.what,
    where: input.where,
    when: input.when,
    headcount: input.headcount,
  });
  if (!qualified.ok) {
    return {
      ok: false,
      status: 400,
      code: qualified.code,
      customerMessage: qualified.customerMessage,
    };
  }
  const quote = quoteListedOffers(ensured.config, qualified.qualification);
  const completion = completeSalesInquiry({
    config: ensured.config,
    qualification: qualified.qualification,
    quote,
    customerName: input.customerName,
  });
  const record = buildSalesInquiry({
    config: ensured.config,
    qualification: qualified.qualification,
    quote,
    completion,
    marketingOptIn: marketingOptInFromVisitor(input.marketingOptIn),
  });
  const customerName = String(input.customerName || "").trim() || null;
  const customerEmail = String(input.customerEmail || "").trim() || null;
  const customerPhone = String(input.customerPhone || "").trim() || null;
  const [config] = await db
    .select({ id: profileSalesAssistantConfigs.id })
    .from(profileSalesAssistantConfigs)
    .where(
      and(
        eq(profileSalesAssistantConfigs.profileKind, input.profileKind),
        eq(profileSalesAssistantConfigs.profileId, input.profileId),
      ),
    )
    .limit(1);
  if (!config) {
    return {
      ok: false,
      status: 404,
      code: "PROFILE_NOT_PUBLIC",
      customerMessage: PROFILE_SALES_CUSTOMER_COPY.unavailable,
    };
  }
  const [inquiry] = await db
    .insert(profileSalesInquiries)
    .values({
      configId: config.id,
      profileKind: record.profileKind,
      profileId: record.profileId,
      qualification: record.qualification,
      quote: record.quote,
      completion: record.completion,
      marketingOptIn: record.marketingOptIn,
      customerName,
      customerEmail,
      customerPhone,
    })
    .returning({ id: profileSalesInquiries.id });
  return { ok: true, inquiryId: inquiry.id, record };
}

export async function readPublicProfileSalesAssistant(
  profileKind: ProfileSalesKind,
  profileId: string,
) {
  const ensured = await ensureProfileSalesAssistant(profileKind, profileId, "public");
  return ensured?.config || null;
}
