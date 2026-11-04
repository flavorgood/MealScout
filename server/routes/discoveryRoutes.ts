import type { Express } from "express";
import { db } from "../db";
import { cities, eventBookings, events, hosts, restaurants, truckManualSchedules, users } from "@shared/schema";
import { and, eq, gte, ilike, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { buildSlotDateTimes, intervalOverlaps, resolveTimeIntent, type TimeIntent } from "../services/timeIntent";
import { getPublicSlotGateConfigFromEnv, isSlotPublic, type PublicSlot } from "../services/publicSlotGate";
import { resolveCityTimeZone, usStateToTimeZone } from "../services/cityTimeZone";
import { dateKeyInZone } from "../services/dateKeys";
import { assertPublicResponseSafe } from "../publicProfiles";
import { isTruckOperatingPlanRowPublic } from "../services/truckOperatingPlan";
import { resolvePublicProfileVisibility } from "../publicProfiles/publicProfileUtils";
import { toPublicRestaurantListing } from "../publicProfiles/toPublicRestaurantListing";
import { resolvePublicHostProximityCoordinates } from "../services/publicHostProximityProjection";
import { deriveProfileEvidenceQuarantineVisibility } from "../services/profileEvidenceQuarantine";
import { isPublicBusinessVisible } from "../utils/publicBusinessVisibility";

type TimeKey = "now" | "breakfast" | "lunch" | "dinner" | "tonight" | "this-weekend";

const TIME_PAGES: TimeKey[] = [
  "now",
  "breakfast",
  "lunch",
  "dinner",
  "tonight",
  "this-weekend",
];

function normalizeSlug(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

function toSeoSlug(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 80);
}

function makeEntitySlug(name: unknown, id: unknown): string {
  const slug = toSeoSlug(name);
  const rawId = String(id || "").trim();
  return slug ? `${slug}--${rawId}` : rawId;
}

function toDateKey(value: unknown, timeZone?: string): string | null {
  if (value instanceof Date) {
    const key = dateKeyInZone(value, timeZone || "America/Chicago");
    return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
  }
  const raw = String(value || "").trim();
  if (!raw) return null;
  const key = raw.includes("T") ? raw.split("T")[0] : raw;
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
}


function timeKeyToIntent(value: TimeKey): TimeIntent {
  return value as unknown as TimeIntent;
}

function getFreshnessGateConfig() {
  return getPublicSlotGateConfigFromEnv();
}

const sendPublicJson = <T>(res: any, payload: T) =>
  res.json(assertPublicResponseSafe(payload));

export function registerDiscoveryRoutes(app: Express) {
  const rowsOf = (result: any) =>
    Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : [];

  app.get("/api/public/trending", async (req, res) => {
    try {
      const limit = Math.max(
        4,
        Math.min(24, Number.parseInt(String(req.query.limit || "12"), 10) || 12),
      );
      const windowDays = Math.max(
        1,
        Math.min(30, Number.parseInt(String(req.query.days || "14"), 10) || 14),
      );
      const cuisineContributionLimit = Math.max(200, limit * 50);
      const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

      const [itemResult, cuisineResult, placeResult, signalResult] =
        await Promise.all([
          db.execute(sql`
            with menu_interest as (
              select
                nullif(properties->>'itemId', '') as item_id,
                count(*) filter (where event_name = 'menu_item_click')::int as clicks,
                count(*) filter (where event_name = 'menu_item_impression')::int as impressions,
                max(created_at) as last_seen_at
              from telemetry_events
              where created_at >= ${since}
                and event_name in ('menu_item_click', 'menu_item_impression')
                and nullif(properties->>'itemId', '') is not null
              group by nullif(properties->>'itemId', '')
            )
            select
              mi.item_id as id,
              m.name,
              m.description,
              m.price_cents as "priceCents",
              m.image_url as "imageUrl",
              m.restaurant_id as "restaurantId",
              r.name as "restaurantName",
              r.address as "restaurantAddress",
              r.city as "restaurantCity",
              r.state as "restaurantState",
              r.cuisine_type as "cuisineType",
              r.description as "restaurantDescription",
              r.phone as "restaurantPhone",
              restaurant_owner.email as "restaurantEmail",
              r.website_url as "restaurantWebsiteUrl",
              r.raw_data as "restaurantRawData",
              r.logo_url as "restaurantLogoUrl",
              r.cover_image_url as "restaurantCoverImageUrl",
              mi.clicks,
              mi.impressions,
              mi.last_seen_at as "lastSeenAt",
              (
                mi.clicks * 10
                + least(mi.impressions, 50)
                + case when m.updated_at >= ${since} then 8 else 0 end
                + least(coalesce(r.ranking_score, 0), 200) / 20
              )::int as "trendScore"
            from menu_interest mi
            inner join menu_items m on m.id = mi.item_id
            inner join menus menu on menu.id = m.menu_id
            inner join restaurants r on r.id = m.restaurant_id
            inner join users restaurant_owner on restaurant_owner.id = r.owner_id
            where m.is_available = true
              and menu.is_active = true
              and m.price_cents > 0
              and r.is_active = true
              and restaurant_owner.is_disabled = false
              and m.name !~* '^(extra|add[-\s]?on|side of|upgrade|substitut)'
            order by "trendScore" desc, mi.last_seen_at desc
            limit ${limit}
          `),
          db.execute(sql`
            with cuisine_items as (
              select
                r.id as restaurant_id,
                coalesce(nullif(trim(r.cuisine_type), ''), 'Local food') as cuisine,
                count(distinct m.id)::int as menu_items,
                max(m.updated_at) as last_menu_update
              from menu_items m
              inner join menus menu on menu.id = m.menu_id
              inner join restaurants r on r.id = m.restaurant_id
              inner join users restaurant_owner on restaurant_owner.id = r.owner_id
              where m.is_available = true
                and menu.is_active = true
                and m.price_cents > 0
                and r.is_active = true
                and restaurant_owner.is_disabled = false
              group by r.id, coalesce(nullif(trim(r.cuisine_type), ''), 'Local food')
            ),
            cuisine_interest as (
              select
                r.id as restaurant_id,
                coalesce(nullif(trim(r.cuisine_type), ''), 'Local food') as cuisine,
                count(*) filter (where te.event_name = 'menu_item_click')::int as clicks,
                count(*) filter (where te.event_name = 'menu_item_impression')::int as impressions
              from telemetry_events te
              inner join menu_items m on m.id = nullif(te.properties->>'itemId', '')
              inner join menus menu on menu.id = m.menu_id
              inner join restaurants r on r.id = m.restaurant_id
              inner join users restaurant_owner on restaurant_owner.id = r.owner_id
              where te.created_at >= ${since}
                and te.event_name in ('menu_item_click', 'menu_item_impression')
                and m.is_available = true
                and menu.is_active = true
                and m.price_cents > 0
                and r.is_active = true
                and restaurant_owner.is_disabled = false
              group by r.id, coalesce(nullif(trim(r.cuisine_type), ''), 'Local food')
            )
            select
              ci.restaurant_id as "restaurantId",
              ci.cuisine,
              ci.menu_items as "menuItems",
              ci.last_menu_update as "lastMenuUpdate",
              coalesce(cx.clicks, 0) as clicks,
              coalesce(cx.impressions, 0) as impressions,
              r.name as "restaurantName",
              r.address as "restaurantAddress",
              r.city as "restaurantCity",
              r.state as "restaurantState",
              r.cuisine_type as "restaurantCuisineType",
              r.description as "restaurantDescription",
              r.phone as "restaurantPhone",
              restaurant_owner.email as "restaurantEmail",
              r.website_url as "restaurantWebsiteUrl",
              r.raw_data as "restaurantRawData"
            from cuisine_items ci
            inner join restaurants r on r.id = ci.restaurant_id
            inner join users restaurant_owner on restaurant_owner.id = r.owner_id
            left join cuisine_interest cx
              on cx.restaurant_id = ci.restaurant_id and cx.cuisine = ci.cuisine
            order by coalesce(cx.clicks, 0) desc, ci.menu_items desc
            limit ${cuisineContributionLimit}
          `),
          db.execute(sql`
            with restaurant_interest as (
              select
                nullif(properties->>'restaurantId', '') as restaurant_id,
                count(*) filter (where event_name like '%click%')::int as clicks,
                count(*)::int as events,
                max(created_at) as last_seen_at
              from telemetry_events
              where created_at >= ${since}
                and nullif(properties->>'restaurantId', '') is not null
              group by nullif(properties->>'restaurantId', '')
            ),
            video_counts as (
              select story.restaurant_id, count(*)::int as video_recommendations
              from video_stories story
              inner join users story_owner on story_owner.id = story.user_id
              where story.created_at >= ${since}
                and story.restaurant_id is not null
                and story.status = 'ready'
                and story.is_approved = true
                and story.deleted_at is null
                and story.expires_at >= now()
                and story_owner.is_disabled = false
              group by story.restaurant_id
            )
            select
              r.id,
              r.name,
              r.address as "profileAddress",
              r.city,
              r.state,
              r.latitude as "latitude",
              r.longitude as "longitude",
              r.cuisine_type as "cuisineType",
              r.logo_url as "logoUrl",
              r.cover_image_url as "coverImageUrl",
              r.business_type as "businessType",
              r.is_food_truck as "isFoodTruck",
              r.description,
              r.phone as "profilePhone",
              restaurant_owner.email as "profileEmail",
              r.website_url as "profileWebsiteUrl",
              r.raw_data as "rawData",
              restaurant_owner.public_profile_settings as "publicProfileSettings",
              coalesce(ri.clicks, 0) as clicks,
              coalesce(ri.events, 0) as events,
              coalesce(vc.video_recommendations, 0) as "videoRecommendations",
              (
                coalesce(ri.clicks, 0) * 8
                + coalesce(ri.events, 0) * 2
                + coalesce(vc.video_recommendations, 0) * 18
                + least(coalesce(r.ranking_score, 0), 200) / 10
              )::int as "trendScore"
            from restaurants r
            inner join users restaurant_owner on restaurant_owner.id = r.owner_id
            left join restaurant_interest ri on ri.restaurant_id = r.id
            left join video_counts vc on vc.restaurant_id = r.id
            where r.is_active = true
              and restaurant_owner.is_disabled = false
              and (
                coalesce(ri.events, 0) > 0
                or coalesce(vc.video_recommendations, 0) > 0
                or coalesce(r.ranking_score, 0) > 0
              )
            order by "trendScore" desc, coalesce(ri.last_seen_at, r.updated_at, r.created_at) desc
            limit ${limit}
          `),
          db.execute(sql`
            select
              event_name as "eventName",
              count(*)::int as count,
              max(created_at) as "lastSeenAt"
            from telemetry_events
            where created_at >= ${since}
            group by event_name
            order by count(*) desc
            limit 10
          `),
        ]);

      const publicTrendingItems = rowsOf(itemResult).flatMap((row: any) => {
        if (
          !isPublicBusinessVisible({
            name: row.restaurantName,
            city: row.restaurantCity,
            state: row.restaurantState,
            cuisineType: row.cuisineType,
            description: row.restaurantDescription,
            address: row.restaurantAddress,
          }) ||
          deriveProfileEvidenceQuarantineVisibility({
            name: row.restaurantName,
            address: row.restaurantAddress,
            city: row.restaurantCity,
            state: row.restaurantState,
            cuisineType: row.cuisineType,
            description: row.restaurantDescription,
            phone: row.restaurantPhone,
            email: row.restaurantEmail,
            websiteUrl: row.restaurantWebsiteUrl,
            rawData: row.restaurantRawData,
          }).isQuarantined
        ) {
          return [];
        }
        const {
          restaurantDescription: _restaurantDescription,
          restaurantAddress: _restaurantAddress,
          restaurantPhone: _restaurantPhone,
          restaurantEmail: _restaurantEmail,
          restaurantWebsiteUrl: _restaurantWebsiteUrl,
          restaurantRawData: _restaurantRawData,
          ...publicRow
        } = row;
        return [publicRow];
      });
      const cuisineTotals = new Map<
        string,
        {
          cuisine: string;
          menuItems: number;
          places: number;
          clicks: number;
          impressions: number;
          hasRecentMenuUpdate: boolean;
        }
      >();
      rowsOf(cuisineResult).forEach((row: any) => {
        if (
          !isPublicBusinessVisible({
            name: row.restaurantName,
            address: row.restaurantAddress,
            city: row.restaurantCity,
            state: row.restaurantState,
            cuisineType: row.restaurantCuisineType,
            description: row.restaurantDescription,
          }) ||
          deriveProfileEvidenceQuarantineVisibility({
            name: row.restaurantName,
            address: row.restaurantAddress,
            city: row.restaurantCity,
            state: row.restaurantState,
            cuisineType: row.restaurantCuisineType,
            description: row.restaurantDescription,
            phone: row.restaurantPhone,
            email: row.restaurantEmail,
            websiteUrl: row.restaurantWebsiteUrl,
            rawData: row.restaurantRawData,
          }).isQuarantined
        ) {
          return;
        }
        const cuisine = String(row.cuisine || "Local food").trim() || "Local food";
        const current = cuisineTotals.get(cuisine) || {
          cuisine,
          menuItems: 0,
          places: 0,
          clicks: 0,
          impressions: 0,
          hasRecentMenuUpdate: false,
        };
        current.menuItems += Math.max(0, Number(row.menuItems) || 0);
        current.places += 1;
        current.clicks += Math.max(0, Number(row.clicks) || 0);
        current.impressions += Math.max(0, Number(row.impressions) || 0);
        const lastMenuUpdate = new Date(row.lastMenuUpdate || 0).getTime();
        current.hasRecentMenuUpdate ||=
          Number.isFinite(lastMenuUpdate) && lastMenuUpdate >= since.getTime();
        cuisineTotals.set(cuisine, current);
      });
      const publicTrendingCuisines = Array.from(cuisineTotals.values())
        .map(({ hasRecentMenuUpdate, ...row }) => ({
          ...row,
          trendScore:
            row.clicks * 10 +
            Math.min(row.impressions, 100) +
            Math.min(row.menuItems, 40) +
            Math.min(row.places, 20) * 2 +
            (hasRecentMenuUpdate ? 10 : 0),
        }))
        .sort(
          (left, right) =>
            right.trendScore - left.trendScore || right.places - left.places,
        )
        .slice(0, limit);
      const publicTrendingPlaces = rowsOf(placeResult).flatMap((row: any) => {
        if (
          !isPublicBusinessVisible({
            ...row,
            address: row.profileAddress,
          }) ||
          deriveProfileEvidenceQuarantineVisibility({
            ...row,
            address: row.profileAddress,
            phone: row.profilePhone,
            email: row.profileEmail,
            websiteUrl: row.profileWebsiteUrl,
          }).isQuarantined
        ) {
          return [];
        }
        // Coordinates leave this route only through the canonical public
        // listing projection — the same gate every other public restaurant
        // surface uses. The raw r.latitude/r.longitude selected above are
        // internal inputs to that projection, never response fields: the
        // projection returns them only when the owner's public settings
        // allow the address, the business is not a private chef, the
        // contact-address evidence is accepted, and a truck's saved address
        // is an operating location rather than an administrative one. In
        // every other case they come back null. Trend metrics are computed
        // in SQL and pass through untouched. (The query above already
        // restricts rows to owners with is_disabled = false, which is the
        // projection's ownerEnabled condition.)
        const ownerVisibility = resolvePublicProfileVisibility(
          row.publicProfileSettings,
        );
        const projectedListing = toPublicRestaurantListing(
          {
            ...row,
            address: row.profileAddress,
            phone: row.profilePhone,
            email: row.profileEmail,
            websiteUrl: row.profileWebsiteUrl,
          },
          {
            showAddress: ownerVisibility.showAddress,
            showContact: ownerVisibility.showContact,
            ownerEnabled: true,
          },
        );
        const {
          rawData: _rawData,
          description: _description,
          profileAddress: _profileAddress,
          profilePhone: _profilePhone,
          profileEmail: _profileEmail,
          profileWebsiteUrl: _profileWebsiteUrl,
          publicProfileSettings: _publicProfileSettings,
          latitude: _rawLatitude,
          longitude: _rawLongitude,
          ...publicRow
        } = row;
        return [
          {
            ...publicRow,
            latitude: projectedListing.latitude ?? null,
            longitude: projectedListing.longitude ?? null,
          },
        ];
      });

      sendPublicJson(res, {
        generatedAt: new Date().toISOString(),
        windowDays,
        items: publicTrendingItems,
        cuisines: publicTrendingCuisines,
        places: publicTrendingPlaces,
        signals: rowsOf(signalResult),
      });
    } catch (error) {
      console.error("Error fetching trending discovery:", error);
      res.status(500).json({ message: "Failed to fetch trending discovery" });
    }
  });

  app.get("/api/public/discovery/city/:citySlug/time/:timeKey", async (req, res) => {
    try {
      const citySlug = normalizeSlug(req.params.citySlug);
      const timeKeyRaw = normalizeSlug(req.params.timeKey) as TimeKey;
      const timeKey = TIME_PAGES.includes(timeKeyRaw) ? timeKeyRaw : null;
      if (!citySlug || !timeKey) {
        return res.status(400).json({ message: "Invalid city or time key" });
      }

      const [city] = await db.select().from(cities).where(eq(cities.slug, citySlug)).limit(1);
      if (!city) return res.status(404).json({ message: "City not found" });

      const timeZone = String(city.timezone || "").trim() || usStateToTimeZone(city.state);
      const now = new Date();
      const intent = timeKeyToIntent(timeKey);
      const window = resolveTimeIntent({ timeZone, intent, now });
      const gate = getFreshnessGateConfig();
      const windowStart = new Date(window.startUtc.getTime() - 24 * 60 * 60 * 1000);
      const windowEnd = new Date(window.endUtc.getTime() + 24 * 60 * 60 * 1000);
      const cityName = String(city.name || "").trim();
      const cityLike = `%${cityName}%`;
      const stateAbbr = String(city.state || "").trim();

      const candidateHostRows = await db
        .select({
          id: hosts.id,
          businessName: hosts.businessName,
          city: hosts.city,
          state: hosts.state,
          address: hosts.address,
          publicProfileSettings: users.publicProfileSettings,
        })
        .from(hosts)
        .innerJoin(users, eq(hosts.userId, users.id))
        .where(
          and(
            ilike(hosts.city, cityLike),
            stateAbbr ? ilike(hosts.state, stateAbbr.toUpperCase()) : undefined,
            eq(users.isDisabled, false),
          ),
        )
        .limit(2000);

      const hostRows = candidateHostRows.filter(
        (host: any) =>
          resolvePublicProfileVisibility(host.publicProfileSettings)
            .showAddress &&
          isPublicBusinessVisible({
            name: host.businessName,
            city: host.city,
            state: host.state,
          }),
      );

      const hostIds = hostRows.map((h: any) => String(h.id));

      const eventRows =
        hostIds.length === 0
          ? []
          : await db
              .select({
                id: events.id,
                hostId: events.hostId,
                date: events.date,
                startTime: events.startTime,
                endTime: events.endTime,
                name: events.name,
                status: events.status,
                lastConfirmedAt: eventBookings.bookingConfirmedAt,
                updatedAt: eventBookings.updatedAt,
                truckId: restaurants.id,
                truckName: restaurants.name,
                truckAddress: restaurants.address,
                cuisineType: restaurants.cuisineType,
                truckCity: restaurants.city,
                truckState: restaurants.state,
                truckDescription: restaurants.description,
                truckPhone: restaurants.phone,
                truckEmail: users.email,
                truckWebsiteUrl: restaurants.websiteUrl,
                truckRawData: restaurants.rawData,
                logoUrl: restaurants.logoUrl,
                coverImageUrl: restaurants.coverImageUrl,
              })
              .from(eventBookings)
              .innerJoin(events, eq(eventBookings.eventId, events.id))
              .innerJoin(restaurants, eq(eventBookings.truckId, restaurants.id))
              .innerJoin(users, eq(restaurants.ownerId, users.id))
              .where(
                and(
                  eq(eventBookings.status, "confirmed"),
                  isNotNull(eventBookings.bookingConfirmedAt),
                  inArray(events.hostId, hostIds),
                  inArray(events.status, ["open", "booked", "filled"]),
                  eq(restaurants.isActive, true),
                  eq(users.isDisabled, false),
                  or(
                    eq(restaurants.isFoodTruck, true),
                    inArray(restaurants.businessType, [
                      "food_truck",
                      "truck",
                      "food-truck",
                      "foodtruck",
                      "mobile_food_vendor",
                    ]),
                  ),
                  gte(events.date, windowStart),
                  lte(events.date, windowEnd),
                ),
              )
              .limit(5000);

      const manualRows = await db
        .select({
          id: truckManualSchedules.id,
          truckId: truckManualSchedules.truckId,
          date: truckManualSchedules.date,
          startTime: truckManualSchedules.startTime,
          endTime: truckManualSchedules.endTime,
          locationName: truckManualSchedules.locationName,
          address: truckManualSchedules.address,
          city: truckManualSchedules.city,
          state: truckManualSchedules.state,
          lastConfirmedAt: truckManualSchedules.lastConfirmedAt,
          updatedAt: truckManualSchedules.updatedAt,
          timezone: truckManualSchedules.timezone,
          expiresAt: truckManualSchedules.expiresAt,
          sourceType: truckManualSchedules.sourceType,
          sourceConfidence: truckManualSchedules.sourceConfidence,
          ownerSubmittedEquivalent:
            truckManualSchedules.ownerSubmittedEquivalent,
          mapEligible: truckManualSchedules.mapEligible,
          liveFeedEligible: truckManualSchedules.liveFeedEligible,
          status: truckManualSchedules.status,
          isPublic: truckManualSchedules.isPublic,
          truckName: restaurants.name,
          truckAddress: restaurants.address,
          cuisineType: restaurants.cuisineType,
          truckCity: restaurants.city,
          truckState: restaurants.state,
          truckDescription: restaurants.description,
          truckPhone: restaurants.phone,
          truckEmail: users.email,
          truckWebsiteUrl: restaurants.websiteUrl,
          truckRawData: restaurants.rawData,
          logoUrl: restaurants.logoUrl,
          coverImageUrl: restaurants.coverImageUrl,
        })
        .from(truckManualSchedules)
        .innerJoin(restaurants, eq(truckManualSchedules.truckId, restaurants.id))
        .innerJoin(users, eq(restaurants.ownerId, users.id))
        .where(
          and(
            eq(truckManualSchedules.isPublic, true),
            or(ilike(truckManualSchedules.city, cityLike), ilike(truckManualSchedules.address, cityLike)),
            gte(truckManualSchedules.date, windowStart),
            lte(truckManualSchedules.date, windowEnd),
            eq(restaurants.isActive, true),
            eq(users.isDisabled, false),
            or(
              eq(restaurants.isFoodTruck, true),
              inArray(restaurants.businessType, [
                "food_truck",
                "truck",
                "food-truck",
                "foodtruck",
                "mobile_food_vendor",
              ]),
            ),
          ),
        )
        .limit(5000);

      const hostById = new Map<string, any>(hostRows.map((h: any) => [String(h.id), h]));
      const items: Array<{
        kind: "booking" | "manual";
        truckId: string;
        truckName: string;
        cuisineType: string | null;
        date: Date;
        startTime: string;
        endTime: string;
        lastConfirmedAtUtc: Date;
        locationName: string | null;
        address: string | null;
        hostId?: string | null;
      }> = [];

      for (const row of eventRows as any[]) {
        if (
          !isPublicBusinessVisible({
            name: row.truckName,
            city: row.truckCity,
            state: row.truckState,
            cuisineType: row.cuisineType,
            description: row.truckDescription,
          }) ||
          deriveProfileEvidenceQuarantineVisibility({
            name: row.truckName,
            address: row.truckAddress,
            city: row.truckCity,
            state: row.truckState,
            cuisineType: row.cuisineType,
            description: row.truckDescription,
            phone: row.truckPhone,
            email: row.truckEmail,
            websiteUrl: row.truckWebsiteUrl,
            rawData: row.truckRawData,
          }).isQuarantined
        ) {
          continue;
        }
        const host = hostById.get(String(row.hostId));
        items.push({
          kind: "booking",
          truckId: String(row.truckId),
          truckName: String(row.truckName || "Food truck"),
          cuisineType: row.cuisineType ? String(row.cuisineType) : null,
          date: new Date(row.date),
          startTime: String(row.startTime || ""),
          endTime: String(row.endTime || ""),
          lastConfirmedAtUtc: new Date(row.lastConfirmedAt),
          locationName: host?.businessName ? String(host.businessName) : row.name ? String(row.name) : null,
          address: host?.address ? String(host.address) : null,
          hostId: String(row.hostId || ""),
        });
      }

      for (const row of manualRows as any[]) {
        if (
          !isPublicBusinessVisible({
            name: row.truckName,
            city: row.truckCity,
            state: row.truckState,
            cuisineType: row.cuisineType,
            description: row.truckDescription,
          }) ||
          deriveProfileEvidenceQuarantineVisibility({
            name: row.truckName,
            address: row.truckAddress,
            city: row.truckCity,
            state: row.truckState,
            cuisineType: row.cuisineType,
            description: row.truckDescription,
            phone: row.truckPhone,
            email: row.truckEmail,
            websiteUrl: row.truckWebsiteUrl,
            rawData: row.truckRawData,
          }).isQuarantined
        ) {
          continue;
        }
        if (
          !isTruckOperatingPlanRowPublic(
            {
              sourceKind: "manual",
              stopId: row.id,
              date: row.date,
              startTime: row.startTime,
              endTime: row.endTime,
              sourceStatus: row.status,
              isPublic: row.isPublic,
              locationName: row.locationName,
              address: row.address,
              city: row.city,
              state: row.state,
              timezone: row.timezone,
              updatedAt: row.updatedAt,
              lastConfirmedAt: row.lastConfirmedAt,
              expiresAt: row.expiresAt,
              sourceType: row.sourceType,
              sourceConfidence: row.sourceConfidence,
              ownerSubmittedEquivalent: row.ownerSubmittedEquivalent,
              mapEligible: row.mapEligible,
              liveFeedEligible: row.liveFeedEligible,
            },
            now,
          )
        ) {
          continue;
        }
        items.push({
          kind: "manual",
          truckId: String(row.truckId),
          truckName: String(row.truckName || "Food truck"),
          cuisineType: row.cuisineType ? String(row.cuisineType) : null,
          date: new Date(row.date),
          startTime: String(row.startTime || ""),
          endTime: String(row.endTime || ""),
          lastConfirmedAtUtc: new Date(row.lastConfirmedAt || row.updatedAt || row.date || Date.now()),
          locationName: row.locationName ? String(row.locationName) : null,
          address: row.address ? String(row.address) : null,
        });
      }

      const filtered = items.filter((item) => {
        const dt = buildSlotDateTimes({
          timeZone,
          date: item.date,
          startTime: item.startTime,
          endTime: item.endTime,
        });
        if (!dt) return false;

        const slot: PublicSlot = {
          source: item.kind === "booking" ? "parking_pass_booking" : "manual",
          status: "confirmed",
          startsAtUtc: dt.startUtc,
          endsAtUtc: dt.endUtc,
          lastConfirmedAtUtc: item.lastConfirmedAtUtc,
        };

        if (
          item.kind === "booking" &&
          !isSlotPublic({
            slot,
            now,
            ...gate,
            ttlHours: item.kind === "booking" ? 24 * 365 * 100 : gate.ttlHours,
          })
        ) {
          return false;
        }

        return intervalOverlaps({
          startUtc: dt.startUtc,
          endUtc: dt.endUtc,
          otherStartUtc: window.startUtc,
          otherEndUtc: window.endUtc,
        });
      });

      const byTruck = new Map<
        string,
        {
          id: string;
          name: string;
          cuisineType: string | null;
          truckPath: string;
          schedules: Array<{
            kind: "booking" | "manual";
            date: string;
            startTime: string;
            endTime: string;
            lastConfirmedAt: string;
            locationName: string | null;
            address: string | null;
            locationPath: string | null;
          }>;
        }
      >();

      for (const row of filtered) {
        const id = row.truckId;
        const existing = byTruck.get(id);
        const truckPath = `/truck/${encodeURIComponent(makeEntitySlug(row.truckName, row.truckId))}`;
        const locationPath =
          row.hostId && row.kind === "booking"
            ? `/location/${encodeURIComponent(
                makeEntitySlug(
                  hostById.get(String(row.hostId))?.businessName || row.locationName || "location",
                  row.hostId,
                ),
              )}`
            : null;
        const schedule = {
          kind: row.kind,
          date:
            toDateKey(row.date, timeZone) ??
            dateKeyInZone(new Date(row.date), timeZone),
          startTime: row.startTime,
          endTime: row.endTime,
          lastConfirmedAt: row.lastConfirmedAtUtc.toISOString(),
          locationName: row.locationName,
          address: row.address,
          locationPath,
        };

        if (!existing) {
          byTruck.set(id, {
            id,
            name: row.truckName,
            cuisineType: row.cuisineType,
            truckPath,
            schedules: [schedule],
          });
          continue;
        }
        existing.schedules.push(schedule);
      }

      const trucks = Array.from(byTruck.values()).sort((a, b) => a.name.localeCompare(b.name));

      res.setHeader("Cache-Control", "no-store");
      sendPublicJson(res, {
        city: { name: city.name, slug: city.slug, state: city.state || null },
        timeKey,
        timeZone,
        intentWindowUtc: { start: window.startUtc.toISOString(), end: window.endUtc.toISOString() },
        freshnessGate: gate,
        generatedAt: new Date().toISOString(),
        totalTrucks: trucks.length,
        trucks,
      });
    } catch (error) {
      console.error("[discovery] city time error:", error);
      res.status(500).json({ message: "Unable to load discovery feed" });
    }
  });

  app.get("/api/public/discovery/location/:hostId/time/:timeKey", async (req, res) => {
    try {
      const hostId = String(req.params.hostId || "").trim();
      const timeKeyRaw = normalizeSlug(req.params.timeKey) as TimeKey;
      const timeKey = TIME_PAGES.includes(timeKeyRaw) ? timeKeyRaw : null;
      if (!hostId || !timeKey) {
        return res.status(400).json({ message: "Invalid location or time key" });
      }

      const [host] = await db
        .select({
          id: hosts.id,
          businessName: hosts.businessName,
          address: hosts.address,
          city: hosts.city,
          state: hosts.state,
          latitude: hosts.latitude,
          longitude: hosts.longitude,
          updatedAt: hosts.updatedAt,
          publicProfileSettings: users.publicProfileSettings,
        })
        .from(hosts)
        .innerJoin(users, eq(hosts.userId, users.id))
        .where(and(eq(hosts.id, hostId), eq(users.isDisabled, false)))
        .limit(1);

      if (!host) return res.status(404).json({ message: "Location not found" });

      const timeZone = await resolveCityTimeZone({ city: host.city, state: host.state });
      const now = new Date();
      const intent = timeKeyToIntent(timeKey);
      const window = resolveTimeIntent({ timeZone, intent, now });
      const gate = getFreshnessGateConfig();

      const windowStart = new Date(window.startUtc.getTime() - 24 * 60 * 60 * 1000);
      const windowEnd = new Date(window.endUtc.getTime() + 24 * 60 * 60 * 1000);

      const rows = await db
        .select({
          id: events.id,
          date: events.date,
          startTime: events.startTime,
          endTime: events.endTime,
          name: events.name,
          status: events.status,
          lastConfirmedAt: eventBookings.bookingConfirmedAt,
          updatedAt: eventBookings.updatedAt,
          truckId: restaurants.id,
          truckName: restaurants.name,
          truckAddress: restaurants.address,
          cuisineType: restaurants.cuisineType,
          truckCity: restaurants.city,
          truckState: restaurants.state,
          truckDescription: restaurants.description,
          truckPhone: restaurants.phone,
          truckEmail: users.email,
          truckWebsiteUrl: restaurants.websiteUrl,
          truckRawData: restaurants.rawData,
        })
        .from(eventBookings)
        .innerJoin(events, eq(eventBookings.eventId, events.id))
        .innerJoin(restaurants, eq(eventBookings.truckId, restaurants.id))
        .innerJoin(users, eq(restaurants.ownerId, users.id))
        .where(
          and(
            eq(eventBookings.status, "confirmed"),
            isNotNull(eventBookings.bookingConfirmedAt),
            eq(events.hostId, hostId),
            inArray(events.status, ["open", "booked", "filled"]),
            eq(restaurants.isActive, true),
            eq(users.isDisabled, false),
            or(
              eq(restaurants.isFoodTruck, true),
              inArray(restaurants.businessType, [
                "food_truck",
                "truck",
                "food-truck",
                "foodtruck",
                "mobile_food_vendor",
              ]),
            ),
            gte(events.date, windowStart),
            lte(events.date, windowEnd),
          ),
        )
        .limit(5000);

      const byTruck = new Map<
        string,
        {
          id: string;
          name: string;
          cuisineType: string | null;
          truckPath: string;
          schedules: Array<{
            kind: "booking";
            date: string;
            startTime: string;
            endTime: string;
            lastConfirmedAt: string;
            eventPath: string;
          }>;
        }
      >();

      for (const row of rows as any[]) {
        if (
          !isPublicBusinessVisible({
            name: row.truckName,
            city: row.truckCity,
            state: row.truckState,
            cuisineType: row.cuisineType,
            description: row.truckDescription,
          }) ||
          deriveProfileEvidenceQuarantineVisibility({
            name: row.truckName,
            address: row.truckAddress,
            city: row.truckCity,
            state: row.truckState,
            cuisineType: row.cuisineType,
            description: row.truckDescription,
            phone: row.truckPhone,
            email: row.truckEmail,
            websiteUrl: row.truckWebsiteUrl,
            rawData: row.truckRawData,
          }).isQuarantined
        ) {
          continue;
        }
        const dt = buildSlotDateTimes({
          timeZone,
          date: new Date(row.date),
          startTime: String(row.startTime || ""),
          endTime: String(row.endTime || ""),
        });
        if (!dt) continue;

        const slot: PublicSlot = {
          source: "parking_pass_booking",
          status: "confirmed",
          startsAtUtc: dt.startUtc,
          endsAtUtc: dt.endUtc,
          lastConfirmedAtUtc: new Date(row.lastConfirmedAt),
        };
        if (
          !isSlotPublic({
            slot,
            now,
            ...gate,
            ttlHours: 24 * 365 * 100,
          })
        ) {
          continue;
        }
        if (
          !intervalOverlaps({
            startUtc: dt.startUtc,
            endUtc: dt.endUtc,
            otherStartUtc: window.startUtc,
            otherEndUtc: window.endUtc,
          })
        ) {
          continue;
        }

        const truckId = String(row.truckId);
        const truckName = String(row.truckName || "Food truck");
        const existing = byTruck.get(truckId);
        const truckPath = `/truck/${encodeURIComponent(makeEntitySlug(truckName, truckId))}`;
        const schedule = {
          kind: "booking" as const,
          date:
            toDateKey(row.date, timeZone) ??
            dateKeyInZone(new Date(row.date), timeZone),
          startTime: String(row.startTime || ""),
          endTime: String(row.endTime || ""),
          lastConfirmedAt: slot.lastConfirmedAtUtc.toISOString(),
          eventPath: `/event/${encodeURIComponent(`${toSeoSlug(row.name || host.businessName || row.id)}--${row.id}`)}`,
        };

        if (!existing) {
          byTruck.set(truckId, {
            id: truckId,
            name: truckName,
            cuisineType: row.cuisineType ? String(row.cuisineType) : null,
            truckPath,
            schedules: [schedule],
          });
        } else {
          existing.schedules.push(schedule);
        }
      }

      const trucks = Array.from(byTruck.values()).sort((a, b) => a.name.localeCompare(b.name));
      const hostVisibility = resolvePublicProfileVisibility(
        host.publicProfileSettings,
      );
      const publicHostCoordinates = resolvePublicHostProximityCoordinates({
        latitude: host.latitude,
        longitude: host.longitude,
        publicProfileSettings: host.publicProfileSettings,
      });

      res.setHeader("Cache-Control", "no-store");
      sendPublicJson(res, {
        location: {
          id: host.id,
          name: host.businessName,
          address: hostVisibility.showAddress ? host.address : null,
          city: host.city,
          state: host.state,
          latitude: publicHostCoordinates?.latitude ?? null,
          longitude: publicHostCoordinates?.longitude ?? null,
          locationPath: `/location/${encodeURIComponent(makeEntitySlug(host.businessName, host.id))}`,
        },
        timeKey,
        timeZone,
        intentWindowUtc: { start: window.startUtc.toISOString(), end: window.endUtc.toISOString() },
        freshnessGate: gate,
        generatedAt: new Date().toISOString(),
        totalTrucks: trucks.length,
        trucks,
      });
    } catch (error) {
      console.error("[discovery] location time error:", error);
      res.status(500).json({ message: "Unable to load location discovery feed" });
    }
  });

  app.get("/api/public/discovery/city/:citySlug/cuisine/:cuisineSlug", async (req, res) => {
    try {
      const citySlug = normalizeSlug(req.params.citySlug);
      const cuisineSlug = normalizeSlug(req.params.cuisineSlug);
      if (!citySlug || !cuisineSlug) {
        return res.status(400).json({ message: "Invalid city or cuisine" });
      }

      const [city] = await db.select().from(cities).where(eq(cities.slug, citySlug)).limit(1);
      if (!city) return res.status(404).json({ message: "City not found" });

      const cityName = String(city.name || "").trim();
      const cityLike = `%${cityName}%`;
      const cuisineLike = `%${cuisineSlug.replace(/-/g, " ")}%`;

      const rows = await db
        .select({
          id: restaurants.id,
          name: restaurants.name,
          cuisineType: restaurants.cuisineType,
          city: restaurants.city,
          state: restaurants.state,
          description: restaurants.description,
          rawData: restaurants.rawData,
          updatedAt: restaurants.updatedAt,
        })
        .from(restaurants)
        .innerJoin(users, eq(restaurants.ownerId, users.id))
        .where(
          and(
            eq(restaurants.isActive, true),
            eq(users.isDisabled, false),
            or(
              eq(restaurants.isFoodTruck, true),
              inArray(restaurants.businessType, [
                "food_truck",
                "truck",
                "food-truck",
                "foodtruck",
                "mobile_food_vendor",
              ]),
            ),
            ilike(restaurants.city, cityLike),
            or(ilike(restaurants.cuisineType, cuisineLike), ilike(restaurants.name, cuisineLike)),
          ),
        )
        .limit(2000);

      const trucks = rows
        .flatMap((row: any) => {
          if (
            !isPublicBusinessVisible(row) ||
            deriveProfileEvidenceQuarantineVisibility(row).isQuarantined
          ) {
            return [];
          }
          return [{
          id: row.id,
          name: row.name,
          cuisineType: row.cuisineType || null,
          city: row.city || null,
          state: row.state || null,
          truckPath: `/truck/${encodeURIComponent(makeEntitySlug(row.name, row.id))}`,
          updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
          }];
        })
        .sort((a: any, b: any) => a.name.localeCompare(b.name));

      res.setHeader("Cache-Control", "no-store");
      sendPublicJson(res, {
        city: { name: city.name, slug: city.slug, state: city.state || null },
        cuisine: { slug: cuisineSlug, label: cuisineSlug.replace(/-/g, " ") },
        generatedAt: new Date().toISOString(),
        totalTrucks: trucks.length,
        trucks,
      });
    } catch (error) {
      console.error("[discovery] city cuisine error:", error);
      res.status(500).json({ message: "Unable to load cuisine feed" });
    }
  });
}
