import { DateTime } from "luxon";
import bcrypt from "bcryptjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  sql,
  or,
} from "drizzle-orm";

import { db } from "../db";
import {
  apiKeys,
  deals,
  eventBookings,
  events,
  eventSeries,
  hosts,
  users,
  menuCategories,
  menuItems,
  menus,
  ownerAiActionDrafts,
  restaurants,
  socialPostQueue,
  socialPublishingConnections,
  truckManualSchedules,
  type OwnerAiActionDraft,
} from "@shared/schema";
import {
  OWNER_AI_CONNECTOR_SCOPES,
  OWNER_AI_DRAFT_ONLY_SCOPES,
  OWNER_AI_PLATFORMS,
  ownerAiActionPacketSchema,
  ownerAiDraftRequestSchema,
  type OwnerAiActionPacket,
  type OwnerAiDraftRequest,
  type OwnerAiExpectedVersions,
  type OwnerAiPlatform,
} from "@shared/ownerAiActions";
import {
  fetchOwnerAiRemoteImagePreview,
  isCloudinaryConfigured,
  uploadToCloudinary,
  uploadGeneratedSocialCardToCloudinary,
} from "../imageUpload";
import {
  markSocialPostResult,
  publishSocialQueueItem,
} from "./socialPublishing";
import { resolveCityTimeZoneSync } from "./cityTimeZone";
import { isPublicDiscoveryEligibleEntity } from "@shared/publicDiscoveryIntegrity";
import { buildSlotDateTimes } from "./timeIntent";

const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PUBLIC_BASE_URL = () =>
  String(process.env.PUBLIC_BASE_URL || "https://www.mealscout.us").replace(
    /\/+$/,
    "",
  );

export class OwnerAiActionError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const asRecord = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};

const asArray = <T = any>(value: unknown): T[] =>
  Array.isArray(value) ? (value as T[]) : [];

const stableHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const bufferSha256 = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");

type OwnerAiMediaManifestEntry = {
  assetKey: string;
  sha256: string;
  contentType: string;
  byteLength: number;
};

const dateVersion = (value: unknown) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
};

const escapeXml = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const wrapSvgText = (value: string, max = 34, lines = 3) => {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const result: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > max && line) {
      result.push(line);
      line = word;
      if (result.length === lines - 1) break;
    } else {
      line = candidate;
    }
  }
  if (line && result.length < lines) result.push(line);
  if (result.join(" ").length < value.trim().length && result.length) {
    result[result.length - 1] = `${result[result.length - 1].slice(0, max - 1)}…`;
  }
  return result;
};

export function buildOwnerAiSocialCardSvg(input: {
  restaurantName: string;
  headline: string;
  subheadline: string;
  platform: OwnerAiPlatform;
}) {
  const headline = wrapSvgText(input.headline || "Something fresh is happening", 31, 3);
  const subheadline = wrapSvgText(input.subheadline || "See the latest on MealScout", 48, 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080" role="img" aria-label="${escapeXml(input.headline)}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#10261f"/><stop offset="1" stop-color="#ef6c35"/></linearGradient></defs>
  <rect width="1080" height="1080" rx="48" fill="url(#bg)"/>
  <circle cx="915" cy="165" r="210" fill="#ffffff" opacity=".08"/><circle cx="120" cy="980" r="260" fill="#ffffff" opacity=".06"/>
  <text x="82" y="112" fill="#f9d66f" font-family="Arial, sans-serif" font-size="34" font-weight="700" letter-spacing="4">MEALSCOUT</text>
  ${headline.map((line, index) => `<text x="82" y="${350 + index * 92}" fill="#ffffff" font-family="Arial, sans-serif" font-size="78" font-weight="800">${escapeXml(line)}</text>`).join("\n  ")}
  ${subheadline.map((line, index) => `<text x="86" y="${700 + index * 52}" fill="#f7f1df" font-family="Arial, sans-serif" font-size="36">${escapeXml(line)}</text>`).join("\n  ")}
  <text x="84" y="930" fill="#ffffff" font-family="Arial, sans-serif" font-size="42" font-weight="700">${escapeXml(input.restaurantName)}</text>
  <text x="84" y="988" fill="#f9d66f" font-family="Arial, sans-serif" font-size="27">Find us on MealScout · mealscout.us</text>
</svg>`;
}

const summarizePacket = (packet: OwnerAiActionPacket) => {
  if (packet.deals?.length) return packet.deals[0].title;
  const firstItem = packet.menus?.flatMap((menu) => menu.categories)
    .flatMap((category) => category.items)[0];
  if (firstItem) return `${firstItem.name}${firstItem.priceCents != null ? ` · $${(firstItem.priceCents / 100).toFixed(2)}` : ""}`;
  const stop = packet.schedules?.[0];
  if (stop) return `${stop.eventName || stop.locationName || "Upcoming stop"} · ${stop.date}`;
  if (packet.profile?.description) return packet.profile.description.slice(0, 180);
  if (packet.hours) return "Updated hours are now available";
  return packet.intent.slice(0, 180);
};

const generatedSocialMessage = (
  platform: OwnerAiPlatform,
  restaurantName: string,
  summary: string,
) => {
  if (platform === "instagram") {
    return `${restaurantName}: ${summary}\n\nSee the approved details on MealScout.\n\n#MealScout #EatLocal`;
  }
  if (platform === "x") {
    return `${restaurantName}: ${summary}. See the approved details on MealScout.`.slice(0, 240);
  }
  return `Fresh from ${restaurantName}: ${summary}. See the approved details on MealScout.`;
};

const limitSocialMessageForFinalPayload = (
  platform: OwnerAiPlatform,
  message: string,
  link: string | null,
) => {
  const normalizedMessage = platform === "x" ? message.trim() : message;
  const separatorLength = link ? (platform === "instagram" ? 2 : 1) : 0;
  const payloadLimit = platform === "x" ? 280 : platform === "instagram" ? 2200 : 5000;
  const messageBudget = Math.max(
    0,
    payloadLimit - separatorLength - (link?.length || 0),
  );
  return normalizedMessage.slice(0, messageBudget);
};

export function buildOwnerAiSocialDrafts(input: {
  draftId: string;
  restaurantId: string;
  restaurantName: string;
  packet: OwnerAiActionPacket;
}) {
  const social = input.packet.social;
  if (!social?.enabled) return [];
  const platforms = social.platforms?.length
    ? social.platforms
    : [...OWNER_AI_PLATFORMS];
  const summary = summarizePacket(input.packet);
  const headline = social.headline || social.campaignLabel || summary;
  const subheadline = social.subheadline || input.packet.intent;
  const defaultLink = `${PUBLIC_BASE_URL()}/restaurant/${encodeURIComponent(input.restaurantId)}`;

  return platforms.map((platform) => {
    const override = social.posts?.[platform];
    const generatedMessage = generatedSocialMessage(
      platform,
      input.restaurantName,
      summary,
    );
    const generatedSvg = buildOwnerAiSocialCardSvg({
      restaurantName: input.restaurantName,
      headline,
      subheadline,
      platform,
    });
    const link = override?.link || social.link || defaultLink;
    const proposedMessage = override?.message || generatedMessage;
    const selectedMessage = limitSocialMessageForFinalPayload(
      platform,
      proposedMessage,
      link,
    );
    const attemptedPayloadText = [selectedMessage, link]
      .filter(Boolean)
      .join(
        platform === "instagram" ? "\n\n" : platform === "facebook" ? " " : "\n",
      );
    const suppliedImageUrl = override?.imageUrl || social.imageUrl || null;
    const fallbackPreviewUrl = `${PUBLIC_BASE_URL()}/api/owner-ai/drafts/${input.draftId}/social-preview/${platform}.svg`;
    return {
      platform,
      generatedMessage,
      aiSuppliedMessage: override?.message || null,
      selectedMessage,
      attemptedPayloadText,
      suppliedImageUrl,
      link,
      generatedSvg,
      previewUrl: suppliedImageUrl
        ? `${PUBLIC_BASE_URL()}/api/owner-ai/drafts/${input.draftId}/media-preview/social-${platform}`
        : fallbackPreviewUrl,
      fallbackPreviewUrl,
    };
  });
}

export function normalizeOwnerAiPlan(packet: OwnerAiActionPacket) {
  const plan: Array<Record<string, unknown>> = [];
  if (packet.profile) {
    plan.push({
      section: "profile",
      action: "upsert",
      fields: Object.keys(packet.profile),
      proposed: packet.profile,
    });
  }
  if (packet.mediaRights?.affirmed) {
    plan.push({
      section: "media_rights",
      action: "owner_affirmation_required_at_approval",
      affirmation: packet.mediaRights.affirmation,
    });
  }
  if (packet.hours) {
    plan.push({
      section: "hours",
      action: "replace_weekly_hours",
      proposed: packet.hours,
    });
  }
  for (const menu of packet.menus || []) {
    plan.push({ section: "menu", action: menu.operation, id: menu.id || null, ref: menu.ref || null, name: menu.name, categories: menu.categories.length, items: menu.categories.reduce((count, category) => count + category.items.length, 0), proposed: menu });
  }
  for (const stop of packet.schedules || []) {
    plan.push({ section: "schedule", action: stop.operation, id: stop.id || null, ref: stop.ref || null, date: stop.date, kind: stop.kind, proposed: stop });
  }
  for (const deal of packet.deals || []) {
    plan.push({ section: "deal", action: deal.operation, id: deal.id || null, ref: deal.ref || null, title: deal.title, proposed: deal });
  }
  if (packet.social?.enabled) {
    plan.push({ section: "social", action: "publish_after_approval", platforms: packet.social.platforms });
  }
  return plan;
}

export async function computeOwnerAiExpectedVersions(
  restaurantId: string,
  database: any = db,
  options: { forUpdate?: boolean } = {},
): Promise<OwnerAiExpectedVersions> {
  const [restaurant] = await database
    .select({ id: restaurants.id, updatedAt: restaurants.updatedAt })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1);
  if (!restaurant) throw new OwnerAiActionError(404, "RESTAURANT_NOT_FOUND", "Restaurant not found");

  const maybeLock = (query: any) =>
    options.forUpdate ? query.for("update") : query;
  const menuRows = await maybeLock(database
    .select({ id: menus.id, updatedAt: menus.updatedAt, isActive: menus.isActive })
    .from(menus)
    .where(eq(menus.restaurantId, restaurantId)));
  const categoryRows = await maybeLock(database
    .select({ id: menuCategories.id, updatedAt: menuCategories.updatedAt, isActive: menuCategories.isActive })
    .from(menuCategories)
    .where(eq(menuCategories.restaurantId, restaurantId)));
  const itemRows = await maybeLock(database
    .select({ id: menuItems.id, updatedAt: menuItems.updatedAt, isAvailable: menuItems.isAvailable })
    .from(menuItems)
    .where(eq(menuItems.restaurantId, restaurantId)));
  const scheduleRows = await maybeLock(database
    .select({ id: truckManualSchedules.id, updatedAt: truckManualSchedules.updatedAt, status: truckManualSchedules.status })
    .from(truckManualSchedules)
    .where(eq(truckManualSchedules.truckId, restaurantId)));
  const dealRows = await maybeLock(database
    .select({ id: deals.id, updatedAt: deals.updatedAt, isActive: deals.isActive })
    .from(deals)
    .where(eq(deals.restaurantId, restaurantId)));

  const normalizeRows = (rows: any[]) =>
    rows
      .map((row) => ({ ...row, updatedAt: dateVersion(row.updatedAt) }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return {
    restaurant: stableHash({ id: restaurant.id, updatedAt: dateVersion(restaurant.updatedAt) }),
    menus: stableHash([...normalizeRows(menuRows), ...normalizeRows(categoryRows), ...normalizeRows(itemRows)]),
    schedules: stableHash(normalizeRows(scheduleRows)),
    deals: stableHash(normalizeRows(dealRows)),
  };
}

const versionsEqual = (a: OwnerAiExpectedVersions, b: OwnerAiExpectedVersions) =>
  a.restaurant === b.restaurant &&
  a.menus === b.menus &&
  a.schedules === b.schedules &&
  a.deals === b.deals;

async function buildOwnerAiCurrentSnapshot(
  restaurantId: string,
  packet: OwnerAiActionPacket,
  database: any = db,
) {
  const [restaurantRows, allMenus, allCategories, allItems, allSchedules, allDeals] =
    await Promise.all([
      database
        .select({
          id: restaurants.id,
          name: restaurants.name,
          description: restaurants.description,
          phone: restaurants.phone,
          websiteUrl: restaurants.websiteUrl,
          cuisineType: restaurants.cuisineType,
          address: restaurants.address,
          city: restaurants.city,
          state: restaurants.state,
          instagramUrl: restaurants.instagramUrl,
          facebookPageUrl: restaurants.facebookPageUrl,
          xUrl: restaurants.xUrl,
          logoUrl: restaurants.logoUrl,
          coverImageUrl: restaurants.coverImageUrl,
          operatingHours: restaurants.operatingHours,
          socialAutopostSettings: restaurants.socialAutopostSettings,
        })
        .from(restaurants)
        .where(eq(restaurants.id, restaurantId))
        .limit(1),
      database.select().from(menus).where(eq(menus.restaurantId, restaurantId)),
      database
        .select()
        .from(menuCategories)
        .where(eq(menuCategories.restaurantId, restaurantId)),
      database
        .select()
        .from(menuItems)
        .where(eq(menuItems.restaurantId, restaurantId)),
      database
        .select()
        .from(truckManualSchedules)
        .where(eq(truckManualSchedules.truckId, restaurantId)),
      database.select().from(deals).where(eq(deals.restaurantId, restaurantId)),
    ]);
  const restaurant = restaurantRows[0] || null;
  const settings = asRecord(restaurant?.socialAutopostSettings);
  const profileCurrent = restaurant
    ? {
        ...restaurant,
        socialAutopostSettings: undefined,
        gallery: asArray(settings.publicGalleryImages),
        publicActionLinks: asRecord(settings.publicActionLinks),
      }
    : null;
  const scheduleDate = (value: unknown) =>
    dateVersion(value)?.slice(0, 10) || null;

  return {
    profile: packet.profile ? profileCurrent : null,
    hours: packet.hours ? restaurant?.operatingHours || null : null,
    menus: (packet.menus || []).map((proposed) => {
      const current = allMenus.find(
        (row: any) =>
          (proposed.id && row.id === proposed.id) ||
          (!proposed.id &&
            row.name === proposed.name &&
            row.serviceType === proposed.serviceType),
      );
      return {
        proposedKey: proposed.id || `${proposed.name}:${proposed.serviceType}`,
        current: current
          ? {
              ...current,
              categories: allCategories
                .filter((category: any) => category.menuId === current.id)
                .map((category: any) => ({
                  ...category,
                  items: allItems.filter(
                    (item: any) => item.categoryId === category.id,
                  ),
                })),
              uncategorizedItems: allItems.filter(
                (item: any) => item.menuId === current.id && !item.categoryId,
              ),
            }
          : null,
      };
    }),
    schedules: (packet.schedules || []).map((proposed) => {
      const expectedLocation =
        proposed.status === "closed" ? "Closed" : proposed.locationName || proposed.eventName || "Scheduled stop";
      const current = allSchedules.find(
        (row: any) =>
          (proposed.id && row.id === proposed.id) ||
          (!proposed.id &&
            scheduleDate(row.date) === proposed.date &&
            row.locationName === expectedLocation),
      );
      return {
        proposedKey: proposed.id || `${proposed.date}:${expectedLocation}`,
        current: current || null,
      };
    }),
    deals: (packet.deals || []).map((proposed) => ({
      proposedKey: proposed.id || proposed.title,
      current:
        allDeals.find(
          (row: any) =>
            (proposed.id && row.id === proposed.id) ||
            (!proposed.id && row.title === proposed.title),
        ) || null,
    })),
  };
}

async function getOwnerAiContextSnapshot(
  restaurantId: string,
  database: any,
  options: {
    menuOffset?: number;
    menuCategoryOffset?: number;
    menuItemOffset?: number;
    scheduleOffset?: number;
    dealOffset?: number;
  } = {},
) {
  const menuOffset = Math.max(0, Math.floor(options.menuOffset || 0));
  const menuCategoryOffset = Math.max(
    0,
    Math.floor(options.menuCategoryOffset || 0),
  );
  const menuItemOffset = Math.max(
    0,
    Math.floor(options.menuItemOffset || 0),
  );
  const scheduleOffset = Math.max(0, Math.floor(options.scheduleOffset || 0));
  const dealOffset = Math.max(0, Math.floor(options.dealOffset || 0));
  const currentPageSize = 250;
  const historyLimit = 25;
  const menuPageSize = 25;
  const menuCategoryPageSize = 500;
  const menuItemPageSize = 1000;
  const now = new Date();
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const [restaurant] = await database
    .select({
      id: restaurants.id,
      name: restaurants.name,
      businessType: restaurants.businessType,
      address: restaurants.address,
      city: restaurants.city,
      state: restaurants.state,
      phone: restaurants.phone,
      description: restaurants.description,
      cuisineType: restaurants.cuisineType,
      websiteUrl: restaurants.websiteUrl,
      instagramUrl: restaurants.instagramUrl,
      facebookPageUrl: restaurants.facebookPageUrl,
      xUrl: restaurants.xUrl,
      logoUrl: restaurants.logoUrl,
      coverImageUrl: restaurants.coverImageUrl,
      operatingHours: restaurants.operatingHours,
      socialAutopostSettings: restaurants.socialAutopostSettings,
      updatedAt: restaurants.updatedAt,
    })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1);
  if (!restaurant) throw new OwnerAiActionError(404, "RESTAURANT_NOT_FOUND", "Restaurant not found");

  const menuPageRows = await database
    .select()
    .from(menus)
    .where(eq(menus.restaurantId, restaurantId))
    .orderBy(asc(menus.createdAt))
    .limit(menuPageSize + 1)
    .offset(menuOffset);
  const menuHasMore = menuPageRows.length > menuPageSize;
  const menuRows = menuPageRows.slice(0, menuPageSize);
  const menuIds = menuRows.map((row: any) => row.id);
  const categoryPageRows = menuIds.length
    ? await database
        .select()
        .from(menuCategories)
        .where(inArray(menuCategories.menuId, menuIds))
        .orderBy(asc(menuCategories.sortOrder))
        .limit(menuCategoryPageSize + 1)
        .offset(menuCategoryOffset)
    : [];
  const categoryHasMore = categoryPageRows.length > menuCategoryPageSize;
  const categoryRows = categoryPageRows.slice(0, menuCategoryPageSize);
  const itemPageRows = menuIds.length
    ? await database
        .select()
        .from(menuItems)
        .where(inArray(menuItems.menuId, menuIds))
        .orderBy(asc(menuItems.sortOrder))
        .limit(menuItemPageSize + 1)
        .offset(menuItemOffset)
    : [];
  const itemHasMore = itemPageRows.length > menuItemPageSize;
  const itemRows = itemPageRows.slice(0, menuItemPageSize);
  const currentScheduleRows = await database
    .select()
    .from(truckManualSchedules)
    .where(
      and(
        eq(truckManualSchedules.truckId, restaurantId),
        gte(truckManualSchedules.date, todayUtc),
      ),
    )
    .orderBy(asc(truckManualSchedules.date))
    .limit(currentPageSize + 1)
    .offset(scheduleOffset);
  const scheduleHistoryRows =
    scheduleOffset === 0
      ? await database
          .select()
          .from(truckManualSchedules)
          .where(
            and(
              eq(truckManualSchedules.truckId, restaurantId),
              lt(truckManualSchedules.date, todayUtc),
            ),
          )
          .orderBy(desc(truckManualSchedules.date))
          .limit(historyLimit)
      : [];
  const activeDealRows = await database
    .select()
    .from(deals)
    .where(
      and(
        eq(deals.restaurantId, restaurantId),
        eq(deals.isActive, true),
        or(isNull(deals.endDate), gte(deals.endDate, now)),
      ),
    )
    .orderBy(desc(deals.startDate))
    .limit(currentPageSize + 1)
    .offset(dealOffset);
  const dealHistoryRows =
    dealOffset === 0
      ? await database
          .select()
          .from(deals)
          .where(
            and(
              eq(deals.restaurantId, restaurantId),
              or(eq(deals.isActive, false), lt(deals.endDate, now)),
            ),
          )
          .orderBy(desc(deals.updatedAt))
          .limit(historyLimit)
      : [];
  const scheduleHasMore = currentScheduleRows.length > currentPageSize;
  const dealHasMore = activeDealRows.length > currentPageSize;
  const scheduleRows = [
    ...currentScheduleRows.slice(0, currentPageSize),
    ...scheduleHistoryRows,
  ];
  const dealRows = [
    ...activeDealRows.slice(0, currentPageSize),
    ...dealHistoryRows,
  ];
  const connections = await database
    .select({
      platform: socialPublishingConnections.platform,
      displayName: socialPublishingConnections.displayName,
      status: socialPublishingConnections.status,
      accessToken: socialPublishingConnections.accessToken,
      updatedAt: socialPublishingConnections.updatedAt,
    })
    .from(socialPublishingConnections)
    .where(eq(socialPublishingConnections.restaurantId, restaurantId));
  const expectedVersions = await computeOwnerAiExpectedVersions(
    restaurantId,
    database,
  );
  const gallery = asArray(asRecord(restaurant.socialAutopostSettings).publicGalleryImages);
  const publicActionLinks = asRecord(
    asRecord(restaurant.socialAutopostSettings).publicActionLinks,
  );

  return {
    restaurant: {
      ...restaurant,
      socialAutopostSettings: undefined,
      gallery,
      publicActionLinks,
    },
    menus: menuRows.map((menu: any) => ({
      ...menu,
      categories: categoryRows
        .filter((category: any) => category.menuId === menu.id)
        .map((category: any) => ({ ...category, items: itemRows.filter((item: any) => item.categoryId === category.id) })),
      uncategorizedItems: itemRows.filter((item: any) => item.menuId === menu.id && !item.categoryId),
    })),
    schedules: scheduleRows,
    deals: dealRows,
    contextBounds: {
      currentPageSize,
      archivedHistoryLimit: historyLimit,
      menus: {
        menuOffset,
        nextMenuOffset: menuHasMore ? menuOffset + menuPageSize : null,
        categoryOffset: menuCategoryOffset,
        nextCategoryOffset: categoryHasMore
          ? menuCategoryOffset + menuCategoryPageSize
          : null,
        itemOffset: menuItemOffset,
        nextItemOffset: itemHasMore
          ? menuItemOffset + menuItemPageSize
          : null,
        menusReturned: menuRows.length,
        categoriesReturned: categoryRows.length,
        itemsReturned: itemRows.length,
      },
      schedules: {
        currentOffset: scheduleOffset,
        nextOffset: scheduleHasMore
          ? scheduleOffset + currentPageSize
          : null,
        currentOrUpcomingReturned: Math.min(
          currentScheduleRows.length,
          currentPageSize,
        ),
        historyReturned: scheduleHistoryRows.length,
      },
      deals: {
        currentOffset: dealOffset,
        nextOffset: dealHasMore ? dealOffset + currentPageSize : null,
        currentOrActiveReturned: Math.min(
          activeDealRows.length,
          currentPageSize,
        ),
        historyReturned: dealHistoryRows.length,
      },
    },
    socialConnections: OWNER_AI_PLATFORMS.map((platform) => {
      const connection = connections.find((row: any) => row.platform === platform);
      return {
        platform,
        connected: Boolean(
          connection?.status === "active" && connection?.accessToken,
        ),
        displayName: connection?.displayName || null,
        status: connection?.status || "not_connected",
        updatedAt: connection?.updatedAt || null,
      };
    }),
    expectedVersions,
    draftRequest: { packet: { schemaVersion: "1.0", intent: "Describe the proposed owner changes" }, expectedVersions },
  };
}

export async function getOwnerAiContext(
  restaurantId: string,
  options: {
    menuOffset?: number;
    menuCategoryOffset?: number;
    menuItemOffset?: number;
    scheduleOffset?: number;
    dealOffset?: number;
  } = {},
) {
  return db.transaction(
    (tx: any) => getOwnerAiContextSnapshot(restaurantId, tx, options),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export type OwnerAiConnectorPrincipal = {
  apiKeyId: string;
  userId: string;
  restaurantId: string;
  scopes: string[];
};

const parseScopes = (scope: unknown) =>
  String(scope || "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

export async function authenticateOwnerAiConnector(
  bearerToken: string,
  requiredScope?: (typeof OWNER_AI_CONNECTOR_SCOPES)[number],
): Promise<OwnerAiConnectorPrincipal> {
  const token = String(bearerToken || "").trim();
  if (!token || token.length < 24) throw new OwnerAiActionError(401, "CONNECTOR_AUTH_REQUIRED", "Valid connector bearer token required");
  const candidates = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyPrefix, token.slice(0, 8)), eq(apiKeys.isActive, true), eq(apiKeys.purpose, "owner_ai_connector")));
  for (const candidate of candidates) {
    if (!candidate.restaurantId || candidate.revokedAt) continue;
    if (candidate.expiresAt && candidate.expiresAt <= new Date()) continue;
    let matches = false;
    try {
      matches = await bcrypt.compare(token, candidate.keyHash);
    } catch {
      matches = false;
    }
    if (!matches) continue;
    const scopes = parseScopes(candidate.scope);
    if (requiredScope && !scopes.includes(requiredScope)) throw new OwnerAiActionError(403, "CONNECTOR_SCOPE_REQUIRED", `Connector lacks ${requiredScope}`);
    const [restaurant] = await db.select({ ownerId: restaurants.ownerId }).from(restaurants).where(and(eq(restaurants.id, candidate.restaurantId), eq(restaurants.ownerId, candidate.userId))).limit(1);
    if (!restaurant) throw new OwnerAiActionError(403, "CONNECTOR_OWNERSHIP_INVALID", "Connector is no longer attached to its owner and business");
    await db.update(apiKeys).set({ lastUsedAt: new Date(), updatedAt: new Date() }).where(eq(apiKeys.id, candidate.id));
    return { apiKeyId: candidate.id, userId: candidate.userId, restaurantId: candidate.restaurantId, scopes };
  }
  throw new OwnerAiActionError(401, "CONNECTOR_AUTH_INVALID", "Connector token is invalid, expired, or revoked");
}

export async function assertActualRestaurantOwner(userId: string, restaurantId: string) {
  const [restaurant] = await db.select({ id: restaurants.id, ownerId: restaurants.ownerId, name: restaurants.name }).from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1);
  if (!restaurant) throw new OwnerAiActionError(404, "RESTAURANT_NOT_FOUND", "Restaurant not found");
  if (restaurant.ownerId !== userId) throw new OwnerAiActionError(403, "ACTUAL_OWNER_REQUIRED", "Only the restaurant's actual owner can perform this action");
  return restaurant;
}

export async function createOwnerAiConnectorCredential(input: {
  userId: string;
  restaurantId: string;
  name?: string;
  expiresAt?: Date | null;
}) {
  await assertActualRestaurantOwner(input.userId, input.restaurantId);
  const rawToken = `msai_${randomBytes(32).toString("base64url")}`;
  const [row] = await db
    .insert(apiKeys)
    .values({
      userId: input.userId,
      restaurantId: input.restaurantId,
      name: input.name?.trim() || "Owner AI connector",
      keyHash: await bcrypt.hash(rawToken, 12),
      keyPrefix: rawToken.slice(0, 8),
      scope: OWNER_AI_DRAFT_ONLY_SCOPES.join(" "),
      purpose: "owner_ai_connector",
      isActive: true,
      expiresAt: input.expiresAt || null,
      updatedAt: new Date(),
    })
    .returning({ id: apiKeys.id, name: apiKeys.name, keyPrefix: apiKeys.keyPrefix, scope: apiKeys.scope, expiresAt: apiKeys.expiresAt, createdAt: apiKeys.createdAt });
  return { credential: row, token: rawToken, warning: "This token is shown once. It can prepare drafts only and can never approve, apply, or publish." };
}

export async function listOwnerAiConnectorCredentials(userId: string, restaurantId: string) {
  await assertActualRestaurantOwner(userId, restaurantId);
  const credentials = await db
    .select({ id: apiKeys.id, name: apiKeys.name, keyPrefix: apiKeys.keyPrefix, scope: apiKeys.scope, isActive: apiKeys.isActive, lastUsedAt: apiKeys.lastUsedAt, expiresAt: apiKeys.expiresAt, revokedAt: apiKeys.revokedAt, createdAt: apiKeys.createdAt })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.restaurantId, restaurantId), eq(apiKeys.purpose, "owner_ai_connector")))
    .orderBy(desc(apiKeys.createdAt));
  const refreshRows = await db
    .select({
      name: apiKeys.name,
      isActive: apiKeys.isActive,
      revokedAt: apiKeys.revokedAt,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, userId),
        eq(apiKeys.restaurantId, restaurantId),
        eq(apiKeys.purpose, "owner_ai_oauth_refresh"),
      ),
    );
  const refreshByAccessKeyId = new Map<string, (typeof refreshRows)[number]>();
  for (const refresh of refreshRows) {
    try {
      const metadata = JSON.parse(String(refresh.name || ""));
      if (
        metadata?.kind === "owner_ai_oauth_refresh" &&
        typeof metadata.accessKeyId === "string"
      ) {
        refreshByAccessKeyId.set(metadata.accessKeyId, refresh);
      }
    } catch {
      // Ignore malformed historical rows; they do not establish a connection.
    }
  }
  return credentials.map((credential: any) => {
    const refresh = refreshByAccessKeyId.get(credential.id);
    const refreshActive = Boolean(
      refresh &&
        refresh.isActive !== false &&
        !refresh?.revokedAt &&
        (!refresh?.expiresAt || refresh.expiresAt > new Date()),
    );
    return {
      ...credential,
      connectionKind: refresh ? "oauth" : "legacy",
      connectionExpiresAt: refreshActive
        ? refresh?.expiresAt || null
        : credential.expiresAt,
    };
  });
}

export async function revokeOwnerAiConnectorCredential(userId: string, credentialId: string) {
  const [candidate] = await db.select({ id: apiKeys.id, restaurantId: apiKeys.restaurantId, userId: apiKeys.userId, purpose: apiKeys.purpose }).from(apiKeys).where(eq(apiKeys.id, credentialId)).limit(1);
  if (!candidate || candidate.purpose !== "owner_ai_connector" || !candidate.restaurantId) throw new OwnerAiActionError(404, "CONNECTOR_NOT_FOUND", "Connector credential not found");
  await assertActualRestaurantOwner(userId, candidate.restaurantId);
  if (candidate.userId !== userId) throw new OwnerAiActionError(403, "ACTUAL_OWNER_REQUIRED", "Only the credential owner can revoke it");
  const [row] = await db.update(apiKeys).set({ isActive: false, revokedAt: new Date(), updatedAt: new Date() }).where(eq(apiKeys.id, credentialId)).returning({ id: apiKeys.id, restaurantId: apiKeys.restaurantId, isActive: apiKeys.isActive, revokedAt: apiKeys.revokedAt });
  return row;
}

const assertRequestVersions = async (
  restaurantId: string,
  request: OwnerAiDraftRequest,
  database: any = db,
) => {
  const current = await computeOwnerAiExpectedVersions(restaurantId, database);
  if (request.expectedVersions && !versionsEqual(request.expectedVersions, current)) {
    throw new OwnerAiActionError(409, "STALE_CONTEXT", "MealScout changed after this AI context was read. Refresh context and rebuild the draft.", { expected: request.expectedVersions, current });
  }
  return current;
};

export async function createOwnerAiDraft(input: {
  restaurantId: string;
  createdByUserId: string;
  connectorApiKeyId?: string | null;
  idempotencyKey?: string | null;
  request: unknown;
}) {
  const request = ownerAiDraftRequestSchema.parse(input.request);
  const requestHash = stableHash(request);
  const idempotencyKey = input.idempotencyKey
    ? stableHash(input.idempotencyKey)
    : null;
  if (input.connectorApiKeyId && !idempotencyKey) {
    throw new OwnerAiActionError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Connector draft creation requires an Idempotency-Key header",
    );
  }
  if (input.connectorApiKeyId && idempotencyKey) {
    const [replay] = await db
      .select()
      .from(ownerAiActionDrafts)
      .where(
        and(
          eq(ownerAiActionDrafts.connectorApiKeyId, input.connectorApiKeyId),
          eq(ownerAiActionDrafts.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (replay) {
      if (replay.requestHash !== requestHash) {
        throw new OwnerAiActionError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency-Key was already used with different draft content",
        );
      }
      return { ...toOwnerAiDraftResponse(replay), idempotencyReplay: true };
    }
  }
  const [restaurant] = await db.select({ id: restaurants.id, name: restaurants.name, ownerId: restaurants.ownerId }).from(restaurants).where(eq(restaurants.id, input.restaurantId)).limit(1);
  if (!restaurant || restaurant.ownerId !== input.createdByUserId) throw new OwnerAiActionError(403, "CONNECTOR_OWNERSHIP_INVALID", "Draft identity must come from the current owner-business attachment");
  const id = randomUUID();
  const packet = ownerAiActionPacketSchema.parse(request.packet);
  const { expectedVersions, currentSnapshot } = await db.transaction(
    async (tx: any) => ({
      expectedVersions: await assertRequestVersions(
        input.restaurantId,
        request,
        tx,
      ),
      currentSnapshot: await buildOwnerAiCurrentSnapshot(
        input.restaurantId,
        packet,
        tx,
      ),
    }),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  const normalizedPlan = normalizeOwnerAiPlan(packet);
  const socialDrafts = buildOwnerAiSocialDrafts({ draftId: id, restaurantId: input.restaurantId, restaurantName: packet.profile?.name || restaurant.name, packet });
  const mediaManifest = await buildOwnerAiMediaManifest(id, packet);
  const inserted = await db.insert(ownerAiActionDrafts).values({
    id,
    restaurantId: input.restaurantId,
    createdByUserId: input.createdByUserId,
    connectorApiKeyId: input.connectorApiKeyId || null,
    idempotencyKey,
    requestHash,
    status: "draft",
    revision: 1,
    packet,
    normalizedPlan,
    currentSnapshot,
    socialDrafts,
    mediaManifest,
    expectedVersions,
    expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
    errors: [],
    updatedAt: new Date(),
  }).onConflictDoNothing().returning();
  let [draft] = inserted;
  if (!draft && input.connectorApiKeyId && idempotencyKey) {
    [draft] = await db
      .select()
      .from(ownerAiActionDrafts)
      .where(
        and(
          eq(ownerAiActionDrafts.connectorApiKeyId, input.connectorApiKeyId),
          eq(ownerAiActionDrafts.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (draft?.requestHash !== requestHash) {
      throw new OwnerAiActionError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency-Key was already used with different draft content",
      );
    }
  }
  if (!draft) {
    throw new OwnerAiActionError(
      500,
      "DRAFT_CREATE_FAILED",
      "Draft could not be created",
    );
  }
  return toOwnerAiDraftResponse(draft);
}

export const ownerAiApprovalUrl = (draftId: string, restaurantId: string) =>
  `${PUBLIC_BASE_URL()}/owner-ai?restaurantId=${encodeURIComponent(restaurantId)}&ownerAiDraft=${encodeURIComponent(draftId)}`;

const ownerAiMediaPreviewUrl = (draftId: string, assetKey: string) =>
  `${PUBLIC_BASE_URL()}/api/owner-ai/drafts/${draftId}/media-preview/${encodeURIComponent(assetKey)}`;

export function buildOwnerAiMediaPreviewDescriptors(
  draftId: string,
  packetValue: unknown,
) {
  const packet = ownerAiActionPacketSchema.parse(packetValue);
  const descriptors: Array<Record<string, unknown>> = [];
  const add = (assetKey: string, label: string, url: unknown) => {
    if (!url) return;
    descriptors.push({
      assetKey,
      label,
      kind: "owner_supplied_remote_image",
      previewUrl: ownerAiMediaPreviewUrl(draftId, assetKey),
      rightsAffirmed: packet.mediaRights?.affirmed === true,
      rightsAffirmation: packet.mediaRights?.affirmation || null,
    });
  };
  add("profile-logo", "Business logo", packet.profile?.logoUrl);
  add("profile-cover", "Business cover image", packet.profile?.coverImageUrl);
  for (const [index, entry] of (packet.profile?.gallery || []).entries()) {
    add(`gallery-${index}`, `Gallery image ${index + 1}`, entry.url);
  }
  for (const [menuIndex, menu] of (packet.menus || []).entries()) {
    for (const [categoryIndex, category] of menu.categories.entries()) {
      for (const [itemIndex, item] of category.items.entries()) {
        add(
          `menu-${menuIndex}-category-${categoryIndex}-item-${itemIndex}`,
          `${menu.name} · ${category.name} · ${item.name}`,
          item.imageUrl,
        );
      }
    }
  }
  for (const [index, deal] of (packet.deals || []).entries()) {
    add(`deal-${index}`, `Deal image · ${deal.title}`, deal.imageUrl);
  }
  for (const platform of packet.social?.platforms || []) {
    const override = packet.social?.posts?.[platform];
    add(
      `social-${platform}`,
      `${platform} supplied social image`,
      override?.imageUrl || packet.social?.imageUrl,
    );
  }
  return descriptors;
}

const resolveOwnerAiDraftMediaSource = (
  packetValue: unknown,
  assetKey: string,
) => {
  const packet = ownerAiActionPacketSchema.parse(packetValue);
  if (assetKey === "profile-logo") return packet.profile?.logoUrl || null;
  if (assetKey === "profile-cover") return packet.profile?.coverImageUrl || null;
  let match = assetKey.match(/^gallery-(\d+)$/);
  if (match) return packet.profile?.gallery?.[Number(match[1])]?.url || null;
  match = assetKey.match(/^menu-(\d+)-category-(\d+)-item-(\d+)$/);
  if (match) {
    return (
      packet.menus?.[Number(match[1])]?.categories?.[Number(match[2])]
        ?.items?.[Number(match[3])]?.imageUrl || null
    );
  }
  match = assetKey.match(/^deal-(\d+)$/);
  if (match) return packet.deals?.[Number(match[1])]?.imageUrl || null;
  match = assetKey.match(/^social-(facebook|instagram|x)$/);
  if (match) {
    const platform = match[1] as OwnerAiPlatform;
    return (
      packet.social?.posts?.[platform]?.imageUrl ||
      packet.social?.imageUrl ||
      null
    );
  }
  return null;
};

async function buildOwnerAiMediaManifest(
  draftId: string,
  packet: OwnerAiActionPacket,
): Promise<OwnerAiMediaManifestEntry[]> {
  const descriptors = buildOwnerAiMediaPreviewDescriptors(draftId, packet);
  if (!descriptors.length) return [];
  const entries = new Array<OwnerAiMediaManifestEntry>(descriptors.length);
  const fetches = new Map<
    string,
    Promise<Awaited<ReturnType<typeof fetchOwnerAiRemoteImagePreview>>>
  >();
  let cursor = 0;
  const worker = async () => {
    while (cursor < descriptors.length) {
      const index = cursor++;
      const descriptor = descriptors[index];
      const assetKey = String(descriptor.assetKey || "");
      const sourceUrl = resolveOwnerAiDraftMediaSource(packet, assetKey);
      if (!sourceUrl) {
        throw new OwnerAiActionError(
          422,
          "MEDIA_SNAPSHOT_FAILED",
          `The ${String(descriptor.label || assetKey)} image could not be resolved`,
        );
      }
      let pending = fetches.get(sourceUrl);
      if (!pending) {
        pending = fetchOwnerAiRemoteImagePreview(sourceUrl);
        fetches.set(sourceUrl, pending);
      }
      try {
        const preview = await pending;
        entries[index] = {
          assetKey,
          sha256: bufferSha256(preview.buffer),
          contentType: preview.contentType,
          byteLength: preview.buffer.byteLength,
        };
      } catch (error) {
        throw new OwnerAiActionError(
          422,
          "MEDIA_SNAPSHOT_FAILED",
          `${String(descriptor.label || assetKey)} could not be frozen for exact owner review: ${
            error instanceof Error ? error.message : "image unavailable"
          }`,
          { assetKey },
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(6, descriptors.length) }, () => worker()),
  );
  return entries;
}

const findMediaManifestEntry = (
  manifestValue: unknown,
  assetKey: string,
) =>
  asArray<OwnerAiMediaManifestEntry>(manifestValue).find(
    (entry) => entry.assetKey === assetKey,
  ) || null;

export function toOwnerAiDraftResponse(draft: OwnerAiActionDraft) {
  const {
    requestHash: _requestHash,
    idempotencyKey: _idempotencyKey,
    mediaManifest: internalMediaManifest,
    socialPublishLeaseId: _socialPublishLeaseId,
    socialPublishLeaseExpiresAt: _socialPublishLeaseExpiresAt,
    ...safe
  } =
    draft as OwnerAiActionDraft & {
      requestHash?: string | null;
      idempotencyKey?: string | null;
    };
  return {
    ...safe,
    approvalUrl: ownerAiApprovalUrl(draft.id, draft.restaurantId),
    mediaPreviews: buildOwnerAiMediaPreviewDescriptors(draft.id, draft.packet).map(
      (preview) => ({
        ...preview,
        contentSha256:
          findMediaManifestEntry(
            internalMediaManifest,
            String(preview.assetKey || ""),
          )?.sha256 || null,
      }),
    ),
    mediaManifestHash: stableHash(internalMediaManifest || []),
    connectorCapabilities: { canReadContext: true, canCreateDraft: true, canReadOwnDraftStatus: true, canApprove: false, canApply: false, canPublish: false },
  };
}

export async function getOwnerAiMediaPreview(
  userId: string,
  draftId: string,
  assetKey: string,
) {
  if (!/^[a-z0-9-]{3,160}$/.test(assetKey)) {
    throw new OwnerAiActionError(400, "INVALID_MEDIA_ASSET_KEY", "Invalid media preview asset key");
  }
  const [draft] = await db
    .select()
    .from(ownerAiActionDrafts)
    .where(eq(ownerAiActionDrafts.id, draftId))
    .limit(1);
  if (!draft) throw new OwnerAiActionError(404, "DRAFT_NOT_FOUND", "Draft not found");
  await assertActualRestaurantOwner(userId, draft.restaurantId);
  const sourceUrl = resolveOwnerAiDraftMediaSource(draft.packet, assetKey);
  if (!sourceUrl) {
    throw new OwnerAiActionError(404, "MEDIA_PREVIEW_NOT_FOUND", "Draft media preview not found");
  }
  const manifestEntry = findMediaManifestEntry(draft.mediaManifest, assetKey);
  if (!manifestEntry) {
    throw new OwnerAiActionError(
      409,
      "MEDIA_SNAPSHOT_MISSING",
      "This draft does not contain an immutable snapshot for the requested image",
    );
  }
  try {
    const preview = await fetchOwnerAiRemoteImagePreview(sourceUrl);
    if (
      bufferSha256(preview.buffer) !== manifestEntry.sha256 ||
      preview.contentType !== manifestEntry.contentType
    ) {
      throw new OwnerAiActionError(
        409,
        "MEDIA_CHANGED",
        "The remote image changed after this draft was created. Create a new draft before approval.",
        { assetKey },
      );
    }
    return preview;
  } catch (error) {
    if (error instanceof OwnerAiActionError) throw error;
    throw new OwnerAiActionError(
      422,
      "MEDIA_PREVIEW_UNAVAILABLE",
      error instanceof Error ? error.message : "Draft media preview is unavailable",
    );
  }
}

export async function getOwnerAiDraftForConnector(
  principal: OwnerAiConnectorPrincipal,
  draftId: string,
) {
  const [draft] = await db
    .select()
    .from(ownerAiActionDrafts)
    .where(
      and(
        eq(ownerAiActionDrafts.id, draftId),
        eq(ownerAiActionDrafts.connectorApiKeyId, principal.apiKeyId),
        eq(ownerAiActionDrafts.restaurantId, principal.restaurantId),
        eq(ownerAiActionDrafts.createdByUserId, principal.userId),
      ),
    )
    .limit(1);
  if (!draft) {
    throw new OwnerAiActionError(
      404,
      "DRAFT_NOT_FOUND",
      "Draft was not created by this connector for this business",
    );
  }
  const socialResults = await db
    .select({
      platform: socialPostQueue.platform,
      status: socialPostQueue.status,
      error: socialPostQueue.errorMessage,
      imageUrl: socialPostQueue.imageUrl,
      metadata: socialPostQueue.metadata,
      updatedAt: socialPostQueue.updatedAt,
    })
    .from(socialPostQueue)
    .where(eq(socialPostQueue.ownerAiActionDraftId, draft.id))
    .orderBy(asc(socialPostQueue.createdAt));
  return {
    id: draft.id,
    restaurantId: draft.restaurantId,
    status: draft.status,
    revision: draft.revision,
    packet: draft.packet,
    currentSnapshot: draft.currentSnapshot,
    normalizedPlan: draft.normalizedPlan,
    socialDrafts: draft.socialDrafts,
    mediaPreviews: buildOwnerAiMediaPreviewDescriptors(
      draft.id,
      draft.packet,
    ).map((preview) => ({
      ...preview,
      contentSha256:
        findMediaManifestEntry(
          draft.mediaManifest,
          String(preview.assetKey || ""),
        )?.sha256 || null,
    })),
    expiresAt: draft.expiresAt,
    approvedAt: draft.approvedAt,
    appliedAt: draft.appliedAt,
    cancelledAt: draft.cancelledAt,
    errors: draft.errors,
    result: draft.result,
    approvalUrl: ownerAiApprovalUrl(draft.id, draft.restaurantId),
    social: socialResults.map((row: any) => ({
      platform: row.platform,
      status: row.status,
      error: row.error || null,
      imageUrl: row.imageUrl || null,
      providerPostId: asRecord(row.metadata).providerPostId || null,
      providerUrl: asRecord(row.metadata).providerUrl || null,
      updatedAt: row.updatedAt,
    })),
    connectorCapabilities: {
      canReadOwnDraftStatus: true,
      canEdit: false,
      canCancel: false,
      canApproveWithOwnerConsent: principal.scopes.includes(
        "owner_ai:drafts:approve",
      ),
      canApplyWithOwnerConsent: principal.scopes.includes(
        "owner_ai:drafts:approve",
      ),
      canPublishWithOwnerConsent: principal.scopes.includes(
        "owner_ai:drafts:approve",
      ),
    },
  };
}

export async function listOwnerAiDrafts(userId: string, restaurantId: string) {
  await assertActualRestaurantOwner(userId, restaurantId);
  const rows = await db.select().from(ownerAiActionDrafts).where(eq(ownerAiActionDrafts.restaurantId, restaurantId)).orderBy(desc(ownerAiActionDrafts.updatedAt));
  return rows.map(toOwnerAiDraftResponse);
}

export async function getOwnerAiDraftForOwner(userId: string, draftId: string) {
  const [draft] = await db.select().from(ownerAiActionDrafts).where(eq(ownerAiActionDrafts.id, draftId)).limit(1);
  if (!draft) throw new OwnerAiActionError(404, "DRAFT_NOT_FOUND", "Draft not found");
  await assertActualRestaurantOwner(userId, draft.restaurantId);
  const socialResults = await db.select().from(socialPostQueue).where(eq(socialPostQueue.ownerAiActionDraftId, draft.id)).orderBy(asc(socialPostQueue.createdAt));
  return { ...toOwnerAiDraftResponse(draft), socialResults };
}

export async function updateOwnerAiDraft(input: { userId: string; draftId: string; expectedRevision: number; request: unknown }) {
  const request = ownerAiDraftRequestSchema.parse(input.request);
  const [existing] = await db.select().from(ownerAiActionDrafts).where(eq(ownerAiActionDrafts.id, input.draftId)).limit(1);
  if (!existing) throw new OwnerAiActionError(404, "DRAFT_NOT_FOUND", "Draft not found");
  const restaurant = await assertActualRestaurantOwner(input.userId, existing.restaurantId);
  if (existing.status !== "draft") throw new OwnerAiActionError(409, "DRAFT_NOT_EDITABLE", "Only draft-status proposals can be edited");
  if (existing.revision !== input.expectedRevision) throw new OwnerAiActionError(409, "STALE_DRAFT_REVISION", "Draft revision changed; reload before editing", { currentRevision: existing.revision });
  const packet = ownerAiActionPacketSchema.parse(request.packet);
  const { expectedVersions, currentSnapshot } = await db.transaction(
    async (tx: any) => ({
      expectedVersions: await assertRequestVersions(
        existing.restaurantId,
        request,
        tx,
      ),
      currentSnapshot: await buildOwnerAiCurrentSnapshot(
        existing.restaurantId,
        packet,
        tx,
      ),
    }),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  const nextRevision = existing.revision + 1;
  const mediaManifest = await buildOwnerAiMediaManifest(existing.id, packet);
  const [updated] = await db.update(ownerAiActionDrafts).set({
    packet,
    normalizedPlan: normalizeOwnerAiPlan(packet),
    currentSnapshot,
    socialDrafts: buildOwnerAiSocialDrafts({ draftId: existing.id, restaurantId: existing.restaurantId, restaurantName: packet.profile?.name || restaurant.name, packet }),
    mediaManifest,
    expectedVersions,
    revision: nextRevision,
    expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
    errors: [],
    updatedAt: new Date(),
  }).where(and(eq(ownerAiActionDrafts.id, existing.id), eq(ownerAiActionDrafts.revision, input.expectedRevision), eq(ownerAiActionDrafts.status, "draft"))).returning();
  if (!updated) throw new OwnerAiActionError(409, "STALE_DRAFT_REVISION", "Draft changed before update completed");
  return toOwnerAiDraftResponse(updated);
}

export async function cancelOwnerAiDraft(userId: string, draftId: string, expectedRevision: number) {
  const [existing] = await db.select().from(ownerAiActionDrafts).where(eq(ownerAiActionDrafts.id, draftId)).limit(1);
  if (!existing) throw new OwnerAiActionError(404, "DRAFT_NOT_FOUND", "Draft not found");
  await assertActualRestaurantOwner(userId, existing.restaurantId);
  if (existing.status === "applied") throw new OwnerAiActionError(409, "DRAFT_ALREADY_APPLIED", "Applied drafts cannot be cancelled");
  if (existing.revision !== expectedRevision) throw new OwnerAiActionError(409, "STALE_DRAFT_REVISION", "Draft revision changed; reload before cancelling");
  const [cancelled] = await db
    .update(ownerAiActionDrafts)
    .set({
      status: "cancelled",
      cancelledAt: new Date(),
      revision: existing.revision + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(ownerAiActionDrafts.id, draftId),
        eq(ownerAiActionDrafts.revision, expectedRevision),
        eq(ownerAiActionDrafts.status, "draft"),
      ),
    )
    .returning();
  if (!cancelled) {
    throw new OwnerAiActionError(
      409,
      "DRAFT_NOT_CANCELLABLE",
      "Draft changed before cancellation completed",
    );
  }
  return toOwnerAiDraftResponse(cancelled);
}

async function validateAndPrepareRemoteImage(
  value: string | null | undefined,
  folder: string,
  manifestEntry: OwnerAiMediaManifestEntry | null,
) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (!manifestEntry) {
    throw new OwnerAiActionError(
      409,
      "MEDIA_SNAPSHOT_MISSING",
      "Approved remote media is missing its immutable draft fingerprint",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new OwnerAiActionError(422, "INVALID_IMAGE_URL", "Image URL is invalid");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new OwnerAiActionError(422, "INVALID_IMAGE_URL", "Only http(s) image URLs are allowed");
  let preview: Awaited<ReturnType<typeof fetchOwnerAiRemoteImagePreview>>;
  try {
    preview = await fetchOwnerAiRemoteImagePreview(parsed.toString());
  } catch (error) {
    throw new OwnerAiActionError(
      422,
      "UNSAFE_IMAGE_URL",
      error instanceof Error
        ? error.message
        : "Image URL must resolve to a supported public raster image",
    );
  }
  if (
    bufferSha256(preview.buffer) !== manifestEntry.sha256 ||
    preview.contentType !== manifestEntry.contentType
  ) {
    throw new OwnerAiActionError(
      409,
      "MEDIA_CHANGED",
      "A remote image changed after the owner preview was created. Nothing was applied; create and review a fresh draft.",
      { assetKey: manifestEntry.assetKey },
    );
  }
  if (!isCloudinaryConfigured()) return parsed.toString();
  try {
    return (await uploadToCloudinary(preview.buffer, folder)).secureUrl;
  } catch {
    throw new OwnerAiActionError(
      422,
      "IMAGE_HOSTING_FAILED",
      "Approved image could not be copied into MealScout hosting",
    );
  }
}

async function uploadGeneratedSvg(svg: string, _folder: string, publicId: string) {
  return uploadGeneratedSocialCardToCloudinary(svg, publicId);
}

async function prepareCanonicalPacketMedia(
  packet: OwnerAiActionPacket,
  draftId: string,
  socialDrafts: any[],
  mediaManifest: unknown,
) {
  const prepared = structuredClone(packet) as OwnerAiActionPacket;
  const manifestEntry = (assetKey: string) =>
    findMediaManifestEntry(mediaManifest, assetKey);
  if (prepared.profile?.logoUrl) {
    prepared.profile.logoUrl = await validateAndPrepareRemoteImage(
      prepared.profile.logoUrl,
      "restaurant-logos",
      manifestEntry("profile-logo"),
    );
  }
  if (prepared.profile?.coverImageUrl) {
    prepared.profile.coverImageUrl = await validateAndPrepareRemoteImage(
      prepared.profile.coverImageUrl,
      "restaurant-covers",
      manifestEntry("profile-cover"),
    );
  }
  for (const [galleryIndex, entry] of (
    prepared.profile?.gallery || []
  ).entries()) {
    if (entry.url) {
      entry.url = await validateAndPrepareRemoteImage(
        entry.url,
        "restaurant-gallery",
        manifestEntry(`gallery-${galleryIndex}`),
      );
    }
  }
  for (const [menuIndex, menu] of (prepared.menus || []).entries()) {
    for (const [categoryIndex, category] of menu.categories.entries()) {
      for (const [itemIndex, item] of category.items.entries()) {
        if (item.imageUrl) {
          item.imageUrl = await validateAndPrepareRemoteImage(
            item.imageUrl,
            "menu-items",
            manifestEntry(
              `menu-${menuIndex}-category-${categoryIndex}-item-${itemIndex}`,
            ),
          );
        }
      }
    }
  }
  let dealFallback: string | null = prepared.profile?.coverImageUrl || prepared.profile?.logoUrl || null;
  for (const [dealIndex, deal] of (prepared.deals || []).entries()) {
    if (deal.operation === "archive") continue;
    if (deal.imageUrl) {
      deal.imageUrl = await validateAndPrepareRemoteImage(
        deal.imageUrl,
        "deals",
        manifestEntry(`deal-${dealIndex}`),
      );
    }
    if (!deal.imageUrl) {
      if (!dealFallback) {
        const svg = socialDrafts[0]?.generatedSvg;
        if (svg) dealFallback = await uploadGeneratedSvg(svg, "owner-ai-deals", `${draftId}-deal`);
      }
      if (!dealFallback) throw new OwnerAiActionError(422, "DEAL_IMAGE_REQUIRED", "A public deal image is required. Supply an image URL or configure MealScout image hosting for the generated fallback.");
      deal.imageUrl = dealFallback;
    }
  }
  return prepared;
}

const mergeGallery = (settingsValue: unknown, entries: NonNullable<OwnerAiActionPacket["profile"]>["gallery"], now: Date) => {
  const settings = asRecord(settingsValue);
  const gallery = asArray<Record<string, any>>(settings.publicGalleryImages).map((entry) => ({ ...entry }));
  for (const proposed of entries || []) {
    const index = gallery.findIndex((entry) => (proposed.id && String(entry.id) === proposed.id) || (proposed.url && String(entry.url) === proposed.url));
    if (proposed.operation === "archive") {
      if (index >= 0) gallery[index] = { ...gallery[index], publicApproved: false, archivedAt: now.toISOString(), lastVerifiedAt: now.toISOString() };
      continue;
    }
    const next = { id: proposed.id || gallery[index]?.id || randomUUID(), url: proposed.url, source: "owner_ai_approved", category: proposed.category, altText: proposed.altText || null, publicApproved: true, uploadedAt: gallery[index]?.uploadedAt || now.toISOString(), lastVerifiedAt: now.toISOString(), archivedAt: null };
    if (index >= 0) gallery[index] = { ...gallery[index], ...next };
    else gallery.push(next);
  }
  return { ...settings, publicGalleryImages: gallery };
};

const OWNER_AI_ACTION_LINK_KEYS = [
  "menuUrl",
  "onlineOrderingUrl",
  "deliveryUrl",
  "doordashUrl",
  "uberEatsUrl",
  "toastUrl",
  "squareUrl",
  "chowNowUrl",
  "grubhubUrl",
  "cateringInquiryUrl",
  "truckBookingInquiryUrl",
] as const;

export const mergeOwnerAiProfileActionLinks = (
  settingsValue: unknown,
  actionLinkUpdates: Record<string, unknown>,
) => {
  const settings = asRecord(settingsValue);
  return {
    ...settings,
    publicActionLinks: {
      ...asRecord(settings.publicActionLinks),
      ...actionLinkUpdates,
    },
  };
};

export async function applyCanonicalPacket(tx: any, restaurant: any, packet: OwnerAiActionPacket, now: Date) {
  const counts = { profile: 0, hours: 0, menusUpserted: 0, menusArchived: 0, categoriesUpserted: 0, categoriesArchived: 0, itemsUpserted: 0, itemsArchived: 0, schedulesUpserted: 0, schedulesArchived: 0, dealsUpserted: 0, dealsArchived: 0 };
  if (packet.profile || packet.hours) {
    const updates: Record<string, any> = { updatedAt: now };
    const profile = packet.profile;
    if (profile) {
      for (const key of ["name", "description", "phone", "websiteUrl", "cuisineType", "address", "city", "state", "instagramUrl", "facebookPageUrl", "xUrl", "logoUrl", "coverImageUrl"] as const) {
        if (profile[key] !== undefined) updates[key] = profile[key];
      }
      let nextSettings: unknown = restaurant.socialAutopostSettings;
      if (profile.gallery) {
        nextSettings = mergeGallery(nextSettings, profile.gallery, now);
      }
      const actionLinkUpdates = Object.fromEntries(
        OWNER_AI_ACTION_LINK_KEYS.filter(
          (key) => profile[key] !== undefined,
        ).map((key) => [key, profile[key]]),
      );
      if (Object.keys(actionLinkUpdates).length > 0) {
        nextSettings = mergeOwnerAiProfileActionLinks(
          nextSettings,
          actionLinkUpdates,
        );
      }
      if (profile.gallery || Object.keys(actionLinkUpdates).length > 0) {
        updates.socialAutopostSettings = nextSettings;
      }
      counts.profile = 1;
    }
    if (packet.hours) {
      updates.operatingHours = packet.hours;
      counts.hours = 1;
    }
    await tx.update(restaurants).set(updates).where(eq(restaurants.id, restaurant.id));
  }

  for (const menu of packet.menus || []) {
    let existing: any = null;
    if (menu.id) [existing] = await tx.select().from(menus).where(and(eq(menus.id, menu.id), eq(menus.restaurantId, restaurant.id))).limit(1);
    if (!existing) [existing] = await tx.select().from(menus).where(and(eq(menus.restaurantId, restaurant.id), eq(menus.name, menu.name), eq(menus.serviceType, menu.serviceType))).limit(1);
    if (menu.operation === "archive") {
      if (existing) {
        await tx.update(menus).set({ isActive: false, updatedAt: now }).where(eq(menus.id, existing.id));
        await tx.update(menuCategories).set({ isActive: false, updatedAt: now }).where(eq(menuCategories.menuId, existing.id));
        await tx.update(menuItems).set({ isAvailable: false, updatedAt: now }).where(eq(menuItems.menuId, existing.id));
        counts.menusArchived += 1;
      }
      continue;
    }
    const menuValues = { restaurantId: restaurant.id, name: menu.name, serviceType: menu.serviceType, availableFrom: menu.availableFrom ?? null, availableTo: menu.availableTo ?? null, availableDays: menu.availableDays, isActive: true, importSource: "owner_ai", importedAt: now, updatedAt: now };
    if (existing) [existing] = await tx.update(menus).set(menuValues).where(eq(menus.id, existing.id)).returning();
    else [existing] = await tx.insert(menus).values(menuValues).returning();
    counts.menusUpserted += 1;

    const categoryRefIds = new Map<string, string>();
    for (const category of menu.categories) {
      let existingCategory: any = null;
      if (category.id) [existingCategory] = await tx.select().from(menuCategories).where(and(eq(menuCategories.id, category.id), eq(menuCategories.menuId, existing.id), eq(menuCategories.restaurantId, restaurant.id))).limit(1);
      if (!existingCategory) [existingCategory] = await tx.select().from(menuCategories).where(and(eq(menuCategories.menuId, existing.id), eq(menuCategories.name, category.name))).limit(1);
      if (category.operation === "archive") {
        if (existingCategory) {
          await tx.update(menuCategories).set({ isActive: false, updatedAt: now }).where(eq(menuCategories.id, existingCategory.id));
          await tx.update(menuItems).set({ isAvailable: false, updatedAt: now }).where(eq(menuItems.categoryId, existingCategory.id));
          counts.categoriesArchived += 1;
        }
        continue;
      }
      const categoryValues = { menuId: existing.id, restaurantId: restaurant.id, name: category.name, description: category.description ?? null, sortOrder: category.sortOrder ?? 0, isActive: true, updatedAt: now };
      if (existingCategory) [existingCategory] = await tx.update(menuCategories).set(categoryValues).where(eq(menuCategories.id, existingCategory.id)).returning();
      else [existingCategory] = await tx.insert(menuCategories).values(categoryValues).returning();
      if (category.ref) categoryRefIds.set(category.ref, existingCategory.id);
      counts.categoriesUpserted += 1;

      for (const item of category.items) {
        let existingItem: any = null;
        if (item.id) [existingItem] = await tx.select().from(menuItems).where(and(eq(menuItems.id, item.id), eq(menuItems.restaurantId, restaurant.id), eq(menuItems.menuId, existing.id))).limit(1);
        if (!existingItem) [existingItem] = await tx.select().from(menuItems).where(and(eq(menuItems.menuId, existing.id), eq(menuItems.categoryId, existingCategory.id), eq(menuItems.name, item.name))).limit(1);
        if (item.operation === "archive") {
          if (existingItem) {
            await tx.update(menuItems).set({ isAvailable: false, updatedAt: now }).where(eq(menuItems.id, existingItem.id));
            counts.itemsArchived += 1;
          }
          continue;
        }
        const itemValues = { menuId: existing.id, categoryId: existingCategory.id, restaurantId: restaurant.id, name: item.name, description: item.description ?? null, priceCents: item.priceCents ?? null, itemType: item.itemType, imageUrl: item.imageUrl ?? null, dietaryTags: item.dietaryTags || [], allergens: item.allergens || [], sortOrder: item.sortOrder ?? 0, isAvailable: true, updatedAt: now };
        if (existingItem) await tx.update(menuItems).set(itemValues).where(eq(menuItems.id, existingItem.id));
        else await tx.insert(menuItems).values(itemValues);
        counts.itemsUpserted += 1;
      }
    }
    void categoryRefIds;
  }

  for (const stop of packet.schedules || []) {
    let existing: any = null;
    if (stop.id) [existing] = await tx.select().from(truckManualSchedules).where(and(eq(truckManualSchedules.id, stop.id), eq(truckManualSchedules.truckId, restaurant.id))).limit(1);
    if (stop.id && !existing) throw new OwnerAiActionError(409, "schedule_not_found", "The requested schedule does not belong to this restaurant or no longer exists");
    const closed = stop.status === "closed";
    if (closed && stop.operation === "upsert") {
      const expiry = stop.expiresAt ? new Date(stop.expiresAt) : null;
      const closureDayStart = DateTime.fromISO(stop.date, { zone: stop.timezone || "invalid" }).startOf("day");
      const nextMidnight = closureDayStart.plus({ days: 1 });
      if (!expiry || !nextMidnight.isValid || !Number.isFinite(expiry.getTime()) || expiry <= now || expiry.getTime() <= closureDayStart.toMillis() || expiry.getTime() > nextMidnight.toMillis()) {
        throw new OwnerAiActionError(409, "invalid_closure_expiry", "A dated closure requires an expiry after its local day begins and after now, no later than the next midnight in its explicit timezone");
      }
    }
    const locationName = closed ? "Closed" : stop.locationName || stop.eventName || "Scheduled stop";
    const date = new Date(`${stop.date}T00:00:00.000Z`);
    if (!existing) [existing] = await tx.select().from(truckManualSchedules).where(and(eq(truckManualSchedules.truckId, restaurant.id), eq(truckManualSchedules.date, date), eq(truckManualSchedules.locationName, locationName))).limit(1);
    if (stop.operation === "archive") {
      if (existing) {
        await tx.update(truckManualSchedules).set({ status: "cancelled", isPublic: false, mapEligible: false, liveFeedEligible: false, updatedAt: now }).where(eq(truckManualSchedules.id, existing.id));
        counts.schedulesArchived += 1;
      }
      continue;
    }
    const city = stop.city || restaurant.city || null;
    const state = stop.state || restaurant.state || null;
    const values = { truckId: restaurant.id, date, startTime: stop.startTime ?? null, endTime: stop.endTime ?? null, locationName, address: stop.address ?? null, city, state, notes: [stop.eventName && stop.kind === "event_stop" ? `Event: ${stop.eventName}` : null, stop.notes].filter(Boolean).join("\n") || null, isPublic: stop.isPublic, status: stop.status, scheduleType: stop.kind, timezone: closed ? stop.timezone! : stop.timezone || resolveCityTimeZoneSync({ city: city || "", state: state || "" }), sourceType: "owner_ai_approved", sourceArtifact: stop.sourceUrl || null, sourceConfidence: "confirmed", ownerSubmittedEquivalent: true, recurring: false, expiresAt: stop.expiresAt ? new Date(stop.expiresAt) : null, mapEligible: stop.isPublic && !closed, liveFeedEligible: stop.isPublic, lastConfirmedAt: now, updatedAt: now };
    if (existing) await tx.update(truckManualSchedules).set(values).where(eq(truckManualSchedules.id, existing.id));
    else await tx.insert(truckManualSchedules).values(values);
    counts.schedulesUpserted += 1;
  }

  // Check the final reviewed schedule state, allowing explicit archives in either packet order.
  for (const closure of (packet.schedules || []).filter((stop) => stop.status === "closed" && stop.operation === "upsert")) {
    const dayStart = DateTime.fromISO(closure.date, { zone: closure.timezone! }).startOf("day");
    const dayEnd = dayStart.plus({ days: 1 });
    // Inventory proof is scoped to the closure day, never to the public feed's
    // current lookahead/confirmation TTL. Date keys are stored at UTC midnight;
    // two days on either side cover timezone differences and overnight intervals.
    const dateAnchor = DateTime.fromISO(closure.date, { zone: "utc" });
    const queryStart = dateAnchor.minus({ days: 2 }).toJSDate();
    const queryEnd = dateAnchor.plus({ days: 2 }).endOf("day").toJSDate();
    const activeTruck = sql`exists (
      select 1 from restaurants operating_truck
      inner join users operating_truck_owner on operating_truck_owner.id = operating_truck.owner_id
      where operating_truck.id = ${restaurant.id}
        and operating_truck.is_active = true and operating_truck_owner.is_disabled = false
    )`;
    const manualRows = await tx.select().from(truckManualSchedules).where(and(
      eq(truckManualSchedules.truckId, restaurant.id), eq(truckManualSchedules.isPublic, true),
      gte(truckManualSchedules.date, queryStart), lte(truckManualSchedules.date, queryEnd), activeTruck,
    ));
    const bookingRows = await tx.select({
      date: events.date, startTime: events.startTime, endTime: events.endTime,
      timezone: eventSeries.timezone, city: hosts.city, state: hosts.state,
      eventType: events.eventType, eventName: events.name, hostName: hosts.businessName,
    }).from(eventBookings)
      .innerJoin(events, eq(eventBookings.eventId, events.id))
      .innerJoin(hosts, eq(events.hostId, hosts.id))
      .innerJoin(users, eq(hosts.userId, users.id))
      .leftJoin(eventSeries, eq(events.seriesId, eventSeries.id))
      .where(and(eq(eventBookings.truckId, restaurant.id), eq(eventBookings.status, "confirmed"),
        eq(users.isDisabled, false), activeTruck, inArray(events.status, ["open", "booked", "filled"]),
        or(isNull(events.requiresPayment), eq(events.requiresPayment, false)),
        gte(events.date, queryStart), lte(events.date, queryEnd)));
    const serviceRows = [
      ...manualRows.filter((row: any) =>
        ["open", "confirmed", "scheduled", "filled", "booked"].includes(String(row.status || "").trim().toLowerCase()) &&
        row.liveFeedEligible !== false &&
        (!row.expiresAt || new Date(row.expiresAt).getTime() > Math.max(now.getTime(), dayStart.toMillis()))),
      ...bookingRows.filter((row: any) =>
        String(row.eventType || "").trim().toLowerCase() !== "private_event" &&
        isPublicDiscoveryEligibleEntity({ name: row.eventName, isActive: true }) &&
        isPublicDiscoveryEligibleEntity({ name: row.hostName, isActive: true })),
    ];
    for (const row of serviceRows) {
      const date = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date || "").slice(0, 10);
      if (!date || !row.startTime || !row.endTime) continue;
      const timezone = String(row.timezone || "") || resolveCityTimeZoneSync({ city: String(row.city || ""), state: String(row.state || "") });
      const interval = buildSlotDateTimes({ date, startTime: row.startTime, endTime: row.endTime, timeZone: timezone });
      if (interval && interval.startUtc.getTime() < dayEnd.toMillis() && interval.endUtc.getTime() > dayStart.toMillis()) {
        throw new OwnerAiActionError(409, "closure_schedule_conflict", "Another public service stop remains on this closure day. Review and archive the manual stop or cancel its booking through the existing owner flow before applying the closure");
      }
    }
  }

  for (const deal of packet.deals || []) {
    let existing: any = null;
    if (deal.id) [existing] = await tx.select().from(deals).where(and(eq(deals.id, deal.id), eq(deals.restaurantId, restaurant.id))).limit(1);
    if (!existing) [existing] = await tx.select().from(deals).where(and(eq(deals.restaurantId, restaurant.id), eq(deals.title, deal.title))).limit(1);
    if (deal.operation === "archive") {
      if (existing) {
        await tx.update(deals).set({ isActive: false, updatedAt: now }).where(eq(deals.id, existing.id));
        counts.dealsArchived += 1;
      }
      continue;
    }
    const values = { restaurantId: restaurant.id, title: deal.title, description: deal.description, dealType: deal.dealType, discountValue: String(deal.discountValue), minOrderAmount: deal.minOrderAmount == null ? null : String(deal.minOrderAmount), imageUrl: deal.imageUrl!, startDate: new Date(deal.startDate), endDate: deal.endDate ? new Date(deal.endDate) : null, startTime: deal.startTime ?? null, endTime: deal.endTime ?? null, availableDuringBusinessHours: deal.availableDuringBusinessHours, isOngoing: deal.isOngoing, totalUsesLimit: deal.totalUsesLimit ?? null, perCustomerLimit: deal.perCustomerLimit, isActive: true, isAiGenerated: false, updatedAt: now };
    if (existing) await tx.update(deals).set(values).where(eq(deals.id, existing.id));
    else await tx.insert(deals).values(values);
    counts.dealsUpserted += 1;
  }
  return counts;
}

async function processApprovedSocialIntents(draftId: string) {
  const leaseId = randomUUID();
  const leaseStartedAt = new Date();
  const leaseExpiresAt = new Date(leaseStartedAt.getTime() + 15 * 60 * 1000);
  const [draft] = await db
    .update(ownerAiActionDrafts)
    .set({
      socialPublishLeaseId: leaseId,
      socialPublishLeaseExpiresAt: leaseExpiresAt,
      updatedAt: leaseStartedAt,
    })
    .where(
      and(
        eq(ownerAiActionDrafts.id, draftId),
        or(
          isNull(ownerAiActionDrafts.socialPublishLeaseExpiresAt),
          lt(ownerAiActionDrafts.socialPublishLeaseExpiresAt, leaseStartedAt),
        ),
      ),
    )
    .returning();
  if (!draft) {
    return db
      .select()
      .from(socialPostQueue)
      .where(eq(socialPostQueue.ownerAiActionDraftId, draftId))
      .orderBy(asc(socialPostQueue.createdAt));
  }
  try {
  const socialDrafts = asArray<Record<string, any>>(draft.socialDrafts);
  const rows = await db.select().from(socialPostQueue).where(eq(socialPostQueue.ownerAiActionDraftId, draftId));
  const order = new Map(OWNER_AI_PLATFORMS.map((platform, index) => [platform, index]));
  rows.sort((a: any, b: any) => (order.get(a.platform as OwnerAiPlatform) ?? 99) - (order.get(b.platform as OwnerAiPlatform) ?? 99));
  for (const row of rows) {
    if (row.status === "publishing") {
      const leaseStartedAt = new Date(
        asRecord(row.metadata).publishLeaseStartedAt || row.updatedAt || 0,
      );
      if (
        Number.isFinite(leaseStartedAt.getTime()) &&
        Date.now() - leaseStartedAt.getTime() >= 15 * 60 * 1000
      ) {
        await markSocialPostResult(row, {
          ok: false,
          manualRequired: true,
          error:
            "A prior publish attempt was interrupted and provider delivery is uncertain. MealScout did not retry, preventing a possible duplicate; review the channel manually.",
        });
      }
      continue;
    }
    const leaseStartedAt = new Date();
    const [claimed] = await db.update(socialPostQueue).set({
      status: "publishing",
      metadata: {
        ...asRecord(row.metadata),
        publishLeaseStartedAt: leaseStartedAt.toISOString(),
      },
      updatedAt: leaseStartedAt,
    }).where(and(eq(socialPostQueue.id, row.id), eq(socialPostQueue.status, "approved"))).returning();
    if (!claimed) continue;
    let providerResult: Awaited<ReturnType<typeof publishSocialQueueItem>> | null = null;
    try {
      const socialDraft = socialDrafts.find((value) => value.platform === row.platform) || {};
      let imageUrl = await validateAndPrepareRemoteImage(
        socialDraft.suppliedImageUrl,
        "owner-ai-social",
        socialDraft.suppliedImageUrl
          ? findMediaManifestEntry(
              draft.mediaManifest,
              `social-${row.platform}`,
            )
          : null,
      );
      if (!imageUrl && socialDraft.generatedSvg) imageUrl = await uploadGeneratedSvg(socialDraft.generatedSvg, "owner-ai-social", `${draftId}-${row.platform}`);
      if (!imageUrl) {
        await markSocialPostResult(claimed, { ok: false, manualRequired: true, error: "Approved social image could not be hosted; nothing was published" });
        continue;
      }
      const [withImage] = await db.update(socialPostQueue).set({ imageUrl, metadata: { ...asRecord(claimed.metadata), hostedImageUrl: imageUrl, hostedAt: new Date().toISOString() }, updatedAt: new Date() }).where(eq(socialPostQueue.id, claimed.id)).returning();
      providerResult = await publishSocialQueueItem(withImage);
      await markSocialPostResult(withImage, providerResult);
    } catch (error) {
      if (providerResult && (providerResult.ok || providerResult.manualRequired)) {
        // Provider delivery succeeded or is uncertain, but local persistence
        // did not. Keep the publishing lease so a later owner check becomes
        // manual_required instead of risking a duplicate or false failure.
        continue;
      }
      await markSocialPostResult(claimed, { ok: false, error: error instanceof Error ? error.message.slice(0, 1000) : "Social publish failed" });
    }
  }
    return db.select().from(socialPostQueue).where(eq(socialPostQueue.ownerAiActionDraftId, draftId)).orderBy(asc(socialPostQueue.createdAt));
  } finally {
    try {
      await db
        .update(ownerAiActionDrafts)
        .set({
          socialPublishLeaseId: null,
          socialPublishLeaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(ownerAiActionDrafts.id, draftId),
            eq(ownerAiActionDrafts.socialPublishLeaseId, leaseId),
          ),
        );
    } catch {
      // The lease expires automatically; never replace provider truth with a
      // secondary cleanup failure.
    }
  }
}

export async function approveOwnerAiDraft(input: { userId: string; draftId: string; expectedRevision: number }) {
  const initial = await getOwnerAiDraftForOwner(input.userId, input.draftId);
  if (initial.status === "cancelled") throw new OwnerAiActionError(409, "DRAFT_CANCELLED", "Cancelled drafts cannot be approved");
  if (initial.status === "draft" && initial.revision !== input.expectedRevision) throw new OwnerAiActionError(409, "STALE_DRAFT_REVISION", "Draft revision changed; reload before approval", { currentRevision: initial.revision });
  if (initial.expiresAt && new Date(initial.expiresAt) <= new Date() && initial.status !== "applied") throw new OwnerAiActionError(410, "DRAFT_EXPIRED", "Draft expired; create a fresh proposal from current context");

  let applied = initial.status === "applied";
  if (!applied) {
    const packet = ownerAiActionPacketSchema.parse(initial.packet);
    const socialDrafts = asArray<Record<string, any>>(initial.socialDrafts);
    const requestedSocialPlatforms = [
      ...new Set(
        socialDrafts
          .map((social) => String(social.platform || "").trim())
          .filter(Boolean),
      ),
    ];
    if (requestedSocialPlatforms.length) {
      const connectedRows = await db
        .select({
          platform: socialPublishingConnections.platform,
          status: socialPublishingConnections.status,
          accessToken: socialPublishingConnections.accessToken,
        })
        .from(socialPublishingConnections)
        .where(
          and(
            eq(socialPublishingConnections.restaurantId, initial.restaurantId),
            inArray(
              socialPublishingConnections.platform,
              requestedSocialPlatforms,
            ),
          ),
        );
      const connectedPlatforms = new Set(
        connectedRows
          .filter((row: any) => row.status === "active" && row.accessToken)
          .map((row: any) => row.platform),
      );
      const missingPlatforms = requestedSocialPlatforms.filter(
        (platform) => !connectedPlatforms.has(platform),
      );
      if (missingPlatforms.length) {
        throw new OwnerAiActionError(
          409,
          "SOCIAL_CONNECTION_REQUIRED",
          `Connect ${missingPlatforms.join(", ")} to MealScout before approving this draft`,
          { missingPlatforms },
        );
      }
    }
    const [mediaState] = await db
      .select({ mediaManifest: ownerAiActionDrafts.mediaManifest })
      .from(ownerAiActionDrafts)
      .where(eq(ownerAiActionDrafts.id, initial.id))
      .limit(1);
    const preparedPacket = await prepareCanonicalPacketMedia(
      packet,
      initial.id,
      socialDrafts,
      mediaState?.mediaManifest,
    );
    const transactionResult = await db.transaction(async (tx: any) => {
      const [lockedDraft] = await tx.select().from(ownerAiActionDrafts).where(eq(ownerAiActionDrafts.id, input.draftId)).limit(1).for("update");
      if (!lockedDraft) throw new OwnerAiActionError(404, "DRAFT_NOT_FOUND", "Draft not found");
      if (lockedDraft.status === "applied") return { alreadyApplied: true };
      if (lockedDraft.status !== "draft") throw new OwnerAiActionError(409, "DRAFT_NOT_APPROVABLE", `Draft status is ${lockedDraft.status}`);
      if (lockedDraft.revision !== input.expectedRevision) throw new OwnerAiActionError(409, "STALE_DRAFT_REVISION", "Draft changed before approval completed", { currentRevision: lockedDraft.revision });
      const [restaurant] = await tx.select().from(restaurants).where(eq(restaurants.id, lockedDraft.restaurantId)).limit(1).for("update");
      if (!restaurant || restaurant.ownerId !== input.userId) throw new OwnerAiActionError(403, "ACTUAL_OWNER_REQUIRED", "Only the current actual restaurant owner can approve");
      if (requestedSocialPlatforms.length) {
        const lockedConnections = await tx
          .select({
            platform: socialPublishingConnections.platform,
            status: socialPublishingConnections.status,
            accessToken: socialPublishingConnections.accessToken,
          })
          .from(socialPublishingConnections)
          .where(
            and(
              eq(
                socialPublishingConnections.restaurantId,
                lockedDraft.restaurantId,
              ),
              inArray(
                socialPublishingConnections.platform,
                requestedSocialPlatforms,
              ),
            ),
          )
          .for("update");
        const stillConnected = new Set(
          lockedConnections
            .filter((row: any) => row.status === "active" && row.accessToken)
            .map((row: any) => row.platform),
        );
        const disconnectedDuringApproval = requestedSocialPlatforms.filter(
          (platform) => !stillConnected.has(platform),
        );
        if (disconnectedDuringApproval.length) {
          throw new OwnerAiActionError(
            409,
            "SOCIAL_CONNECTION_REQUIRED",
            `A social connection changed before approval. Reconnect ${disconnectedDuringApproval.join(", ")}; nothing was applied or published.`,
            { missingPlatforms: disconnectedDuringApproval },
          );
        }
      }
      const currentVersions = await computeOwnerAiExpectedVersions(
        lockedDraft.restaurantId,
        tx,
        { forUpdate: true },
      );
      const expectedVersions = lockedDraft.expectedVersions as OwnerAiExpectedVersions;
      if (!versionsEqual(expectedVersions, currentVersions)) throw new OwnerAiActionError(409, "STALE_CONTEXT", "MealScout content changed after this draft was prepared. Nothing was applied or published.", { expected: expectedVersions, current: currentVersions });
      const now = new Date();
      const canonicalCounts = await applyCanonicalPacket(tx, restaurant, preparedPacket, now);
      for (const social of socialDrafts) {
        await tx.insert(socialPostQueue).values({
          platform: social.platform,
          target: social.platform,
          message: social.selectedMessage,
          link: social.link || null,
          imageUrl: null,
          restaurantId: restaurant.id,
          createdByUserId: input.userId,
          source: "owner_ai_approved",
          ownerAiActionDraftId: lockedDraft.id,
          status: "approved",
          metadata: { ownerAiActionDraftId: lockedDraft.id, ownerApprovedAt: now.toISOString(), draftRevision: lockedDraft.revision, generatedMessage: social.generatedMessage, aiSuppliedMessage: social.aiSuppliedMessage || null, suppliedImageUrl: social.suppliedImageUrl || null },
          updatedAt: now,
        }).onConflictDoNothing();
      }
      const result = { canonicalCommitted: true, canonicalCounts, socialRequested: socialDrafts.map((social) => social.platform) };
      await tx.update(ownerAiActionDrafts).set({ status: "applied", revision: lockedDraft.revision + 1, approvedByUserId: input.userId, approvedAt: now, appliedAt: now, result, errors: [], updatedAt: now }).where(eq(ownerAiActionDrafts.id, lockedDraft.id));
      return { alreadyApplied: false, result };
    });
    applied = !transactionResult.alreadyApplied || applied;
  }

  const socialResults = await processApprovedSocialIntents(input.draftId);
  const [latest] = await db.select().from(ownerAiActionDrafts).where(eq(ownerAiActionDrafts.id, input.draftId)).limit(1);
  const finalResult = {
    ...asRecord(latest?.result),
    canonicalCommitted: true,
    social: socialResults.map((row: any) => ({
      platform: row.platform,
      status: row.status,
      error: row.errorMessage || null,
      providerPostId: asRecord(row.metadata).providerPostId || null,
      providerUrl: asRecord(row.metadata).providerUrl || null,
      imageUrl: row.imageUrl || null,
    })),
  };
  await db.update(ownerAiActionDrafts).set({ result: finalResult, updatedAt: new Date() }).where(eq(ownerAiActionDrafts.id, input.draftId));
  return { ...toOwnerAiDraftResponse({ ...latest, result: finalResult } as OwnerAiActionDraft), canonicalCommitted: applied || latest?.status === "applied", socialResults: finalResult.social };
}

export async function getOwnerAiSocialPreview(userId: string, draftId: string, platform: string) {
  const draft = await getOwnerAiDraftForOwner(userId, draftId);
  const social = asArray<Record<string, any>>(draft.socialDrafts).find((entry) => entry.platform === platform);
  if (!social?.generatedSvg) throw new OwnerAiActionError(404, "SOCIAL_PREVIEW_NOT_FOUND", "Social preview not found");
  return social.generatedSvg as string;
}
