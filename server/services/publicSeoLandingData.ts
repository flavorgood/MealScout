import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import { db } from "../db";
import {
  cities,
  deals,
  eventBookings,
  events,
  hosts,
  restaurants,
  users,
} from "@shared/schema";
import { isPublicDiscoveryEligibleEntity } from "@shared/publicDiscoveryIntegrity";
import { assertPublicResponseSafe } from "../publicProfiles/assertPublicResponseSafe";
import { canExposeAnonymousEventDetail } from "../publicProfiles/publicEventDetailAccess";
import { projectPublicRestaurantMedia } from "../publicProfiles/toPublicRestaurantProfile";
import { publicTruckClassificationWhere } from "../seo/publicTruckClassification";
import { resolveCityTimeZoneSync } from "./cityTimeZone";
import { buildSlotDateTimes } from "./timeIntent";
import { dateKeyInZone } from "./dateKeys";
import { isSlotPublic } from "./publicSlotGate";
import { buildPublicTruckOperatingPlans } from "./truckOperatingPlan";
import {
  collectPublicSeoRowsInBatches,
  scanPublicSeoRowsInBatches,
} from "./publicSeoBatchTraversal";
import {
  canonicalPublicSeoCityName,
  canonicalPublicSeoCitySlug,
  canonicalPublicSeoStateLabel,
  resolvePublicSeoLanding,
  buildPublicSeoProfilePath,
  filterPublicSeoTrucksActiveToday,
  isPublicSeoLandingRestaurantEligible,
  publicSeoActiveTodayStop,
  publicSeoBusinessProfileType,
  publicSeoCityIdentityMatches,
  publicSeoCuisineMatches,
  toPublicSeoSlug,
  type PublicSeoLandingCity,
  type PublicSeoLandingItem,
  type PublicSeoLandingRepository,
  type PublicSeoLandingRequest,
} from "./publicSeoLandingModel";

// Merchant-controlled identity and titles are facts. Ranking-language policy
// applies to MealScout-authored templates, never by rewriting stored names.
const normalizeStoredLabel = (value: string) =>
  value.replace(/\s+/g, " ").trim();

const normalizedTextEquals = (column: any, value: unknown) =>
  sql`lower(btrim(coalesce(${column}, ''))) = ${String(value ?? "")
    .trim()
    .toLowerCase()}`;

const normalizeCityRegistrySlug = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase();

const cityIdentityWhere = (
  city: PublicSeoLandingCity,
  cityColumn: any,
  stateColumn: any,
) =>
  and(
    // Match the canonical name or the stored spelling: a business whose
    // record carries the registry's original (misspelled) city name is
    // still a business of this city. Without the stored spelling, the
    // SQL prefilter drops those rows before the in-memory canonical
    // re-check can see them, and the landing page renders empty.
    city.storedName && city.storedName !== city.name
      ? or(
          normalizedTextEquals(cityColumn, city.name),
          normalizedTextEquals(cityColumn, city.storedName),
        )
      : normalizedTextEquals(cityColumn, city.name),
    normalizedTextEquals(stateColumn, city.state),
  );

const canonicalCuisineWhere = (column: any, cuisineSlug: string) =>
  sql`left(trim(both '-' from regexp_replace(lower(btrim(coalesce(${column}, ''))), '[^a-z0-9]+', '-', 'g')), 80) = ${toPublicSeoSlug(cuisineSlug)}`;

const publicRestaurantSelect = {
  id: restaurants.id,
  name: restaurants.name,
  businessType: restaurants.businessType,
  isFoodTruck: restaurants.isFoodTruck,
  isActive: restaurants.isActive,
  ownerId: restaurants.ownerId,
  ownerEmail: users.email,
  ownerDisabled: users.isDisabled,
  address: restaurants.address,
  city: restaurants.city,
  state: restaurants.state,
  cuisineType: restaurants.cuisineType,
  description: restaurants.description,
  rawData: restaurants.rawData,
  phone: restaurants.phone,
  websiteUrl: restaurants.websiteUrl,
  coverImageUrl: restaurants.coverImageUrl,
  logoUrl: restaurants.logoUrl,
  updatedAt: restaurants.updatedAt,
};

const isIndexableRestaurantRow = (row: any) =>
  row?.ownerDisabled === false &&
  isPublicSeoLandingRestaurantEligible({
    name: row.name,
    isActive: row.isActive,
    ownerId: row.ownerId,
    ownerEmail: row.ownerEmail,
    address: row.address,
    cuisineType: row.cuisineType,
    description: row.description,
    city: row.city,
    state: row.state,
    rawData: row.rawData,
    phone: row.phone,
    websiteUrl: row.websiteUrl,
    isFoodTruck: row.isFoodTruck,
    businessType: row.businessType,
  });

const buildCard = (row: any): PublicSeoLandingItem => {
  const profileType = publicSeoBusinessProfileType(row);
  if (!profileType) {
    throw new Error("Unsupported service business cannot become a public SEO card");
  }
  const id = String(row.id);
  const name = String(row.name || "");
  const profilePath = buildPublicSeoProfilePath({ profileType, id, name });
  const publicMedia = projectPublicRestaurantMedia(row);
  return {
    id,
    profileType,
    displayName: normalizeStoredLabel(name || "Local business"),
    slug: toPublicSeoSlug(name) || id,
    profilePath,
    // Card city/state are display labels built from the same free-text
    // storage as the city registry; print them through the canonical
    // display-case/state normalizers so cards never show "Milton, Fl".
    city: row.city ? canonicalPublicSeoCityName(row.city) || null : null,
    state: row.state ? canonicalPublicSeoStateLabel(row.state) || null : null,
    imageUrl: publicMedia.coverImageUrl || publicMedia.logoUrl || null,
    cuisineTags:
      row.cuisineType && String(row.cuisineType).trim().toLowerCase() !== "other"
        ? [String(row.cuisineType)]
        : [],
    statusLabel: null,
    summary: null,
    primaryCtaPath: profilePath,
  };
};

const loadFoodTrucks = async (
  city: PublicSeoLandingCity,
  cuisineSlug?: string | null,
) => {
  const rows = await collectPublicSeoRowsInBatches({
    visibleLimit: 60,
    loadBatch: (offset, limit) =>
      db
        .select(publicRestaurantSelect)
        .from(restaurants)
        .innerJoin(users, eq(restaurants.ownerId, users.id))
        .where(
          and(
            eq(restaurants.isActive, true),
            publicTruckClassificationWhere(
              restaurants.isFoodTruck,
              restaurants.businessType,
            ),
            cityIdentityWhere(city, restaurants.city, restaurants.state),
            ...(cuisineSlug
              ? [canonicalCuisineWhere(restaurants.cuisineType, cuisineSlug)]
              : []),
          ),
        )
        .orderBy(desc(restaurants.updatedAt), asc(restaurants.id))
        .limit(limit)
        .offset(offset),
    selectVisible: (row: any) =>
      isIndexableRestaurantRow(row) &&
      publicSeoCityIdentityMatches(row, city) &&
      (cuisineSlug
        ? publicSeoCuisineMatches(row.cuisineType, cuisineSlug)
        : true),
  });
  return rows.map(buildCard);
};

const toLandingCity = (city: any): PublicSeoLandingCity => {
  const storedName = String(city.name || "").trim();
  const canonicalName = canonicalPublicSeoCityName(city.name);
  return {
    id: String(city.id),
    // The public name/slug are the canonical (correctly spelled) ones —
    // see canonicalPublicSeoCityName in publicSeoLandingModel. The
    // stored spelling rides along so row matching can still find
    // businesses whose records carry it.
    name: canonicalName,
    slug: canonicalPublicSeoCitySlug(city.name),
    state: canonicalPublicSeoStateLabel(city.state) || null,
    storedName: storedName && storedName !== canonicalName ? storedName : null,
  };
};

const repository: PublicSeoLandingRepository = {
  async resolveCityBySlug(citySlug: string): Promise<PublicSeoLandingCity | null> {
    const [city] = await db
      .select({
        id: cities.id,
        name: cities.name,
        slug: cities.slug,
        state: cities.state,
      })
      .from(cities)
      .where(
        and(
          normalizedTextEquals(cities.slug, citySlug),
          sql`btrim(coalesce(${cities.name}, '')) <> ''`,
        ),
      )
      .orderBy(sql`${cities.createdAt} desc nulls last`, asc(cities.id))
      .limit(1);
    if (city) return toLandingCity(city);
    // The requested slug may be the canonical spelling while the stored
    // slug carries the original misspelling (e.g. /city/lake-worth-beach/
    // for the row stored as "lakeworth-beach"). Fall back to matching the
    // canonical slug derived from each stored city name.
    const requestedSlug = normalizeCityRegistrySlug(citySlug);
    if (!requestedSlug) return null;
    const rows = await db
      .select({
        id: cities.id,
        name: cities.name,
        slug: cities.slug,
        state: cities.state,
      })
      .from(cities)
      .where(sql`btrim(coalesce(${cities.name}, '')) <> ''`)
      .orderBy(sql`${cities.createdAt} desc nulls last`, asc(cities.id));
    const canonicalHit = rows.find(
      (row: any) => canonicalPublicSeoCitySlug(row.name) === requestedSlug,
    );
    return canonicalHit ? toLandingCity(canonicalHit) : null;
  },

  loadFoodTrucks,

  async loadFoodTrucksToday(city: PublicSeoLandingCity, now: Date) {
    const activeItems: PublicSeoLandingItem[] = [];
    await scanPublicSeoRowsInBatches({
      loadBatch: (offset, limit) =>
        db
          .select(publicRestaurantSelect)
          .from(restaurants)
          .innerJoin(users, eq(restaurants.ownerId, users.id))
          .where(
            and(
              eq(restaurants.isActive, true),
              publicTruckClassificationWhere(
                restaurants.isFoodTruck,
                restaurants.businessType,
              ),
            ),
          )
          .orderBy(desc(restaurants.updatedAt), asc(restaurants.id))
          .limit(limit)
          .offset(offset),
      async visitBatch(rows) {
        const items = rows.filter(isIndexableRestaurantRow).map(buildCard);
        const plans = await buildPublicTruckOperatingPlans(
          items.map((item) => item.id),
          { now },
        );
        for (const item of filterPublicSeoTrucksActiveToday(items, plans, city)) {
          const schedule = plans.get(item.id)?.truckSchedule;
          const activeStop = publicSeoActiveTodayStop(plans.get(item.id), city);
          activeItems.push({
            ...item,
            city: String(activeStop?.city || city.name).trim() || city.name,
            state:
              String(activeStop?.state || city.state || "").trim() || null,
            statusLabel:
              schedule?.currentStop === activeStop
                ? "Serving now"
                : "Serving today",
            summary:
              activeStop?.locationName || "Owner-confirmed service today",
          });
          if (activeItems.length >= 60) return false;
        }
      },
    });
    return activeItems;
  },

  async loadDealsToday(city: PublicSeoLandingCity, now: Date) {
    const rows = await collectPublicSeoRowsInBatches({
      visibleLimit: 60,
      loadBatch: (offset, limit) =>
        db
          .select({
            ...publicRestaurantSelect,
            dealTitle: deals.title,
            dealEndDate: deals.endDate,
            updatedAt: deals.updatedAt,
          })
          .from(deals)
          .innerJoin(restaurants, eq(deals.restaurantId, restaurants.id))
          .innerJoin(users, eq(restaurants.ownerId, users.id))
          .where(
            and(
              eq(restaurants.isActive, true),
              eq(deals.isActive, true),
              lte(deals.startDate, now),
              or(isNull(deals.endDate), gte(deals.endDate, now)),
              cityIdentityWhere(city, restaurants.city, restaurants.state),
            ),
          )
          .orderBy(desc(deals.updatedAt), asc(deals.id))
          .limit(limit)
          .offset(offset),
      selectVisible: (row: any) =>
        isIndexableRestaurantRow(row) &&
        publicSeoCityIdentityMatches(row, city) &&
        isPublicDiscoveryEligibleEntity({
          name: row.dealTitle,
          isActive: true,
        }),
    });

    return rows
      .map((row: any) => ({
        ...buildCard(row),
        statusLabel: "Active today",
        summary: row.dealTitle
          ? `Deal today: ${normalizeStoredLabel(String(row.dealTitle))}`
          : "Deal available today",
      }));
  },

  async loadEventsToday(city: PublicSeoLandingCity, now: Date) {
    const queryStart = new Date(now);
    queryStart.setUTCHours(0, 0, 0, 0);
    queryStart.setUTCDate(queryStart.getUTCDate() - 1);
    const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const rows = await collectPublicSeoRowsInBatches({
      visibleLimit: 60,
      loadBatch: (offset, limit) => db
      .selectDistinct({
        eventId: events.id,
        ...publicRestaurantSelect,
        eventName: events.name,
        eventType: events.eventType,
        eventStatus: events.status,
        eventRequiresPayment: events.requiresPayment,
        eventDate: events.date,
        eventStartTime: events.startTime,
        eventEndTime: events.endTime,
        bookingConfirmedAt: eventBookings.bookingConfirmedAt,
        hostName: hosts.businessName,
        hostCity: hosts.city,
        hostState: hosts.state,
        updatedAt: events.updatedAt,
      })
      .from(eventBookings)
      .innerJoin(events, eq(eventBookings.eventId, events.id))
      .innerJoin(hosts, eq(events.hostId, hosts.id))
      .innerJoin(restaurants, eq(eventBookings.truckId, restaurants.id))
      .innerJoin(users, eq(restaurants.ownerId, users.id))
      .where(
        and(
          eq(eventBookings.status, "confirmed"),
          isNotNull(eventBookings.bookingConfirmedAt),
          inArray(events.status, ["open", "booked", "filled"]),
          or(eq(events.requiresPayment, false), isNull(events.requiresPayment)),
          eq(restaurants.isActive, true),
          eq(users.isDisabled, false),
          sql`exists (
            select 1 from users host_owner
            where host_owner.id = ${hosts.userId}
              and host_owner.is_disabled = false
          )`,
          publicTruckClassificationWhere(
            restaurants.isFoodTruck,
            restaurants.businessType,
          ),
          gte(events.date, queryStart),
          lte(events.date, end),
          cityIdentityWhere(city, hosts.city, hosts.state),
        ),
      )
      .orderBy(
        desc(events.updatedAt),
        asc(events.id),
        asc(restaurants.id),
      )
      .limit(limit)
      .offset(offset),
      selectVisible: (row: any) => {
        if (!isIndexableRestaurantRow(row)) return false;
        if (!isPublicDiscoveryEligibleEntity({
          name: row.hostName,
          isActive: true,
        })) return false;
        if (!isPublicDiscoveryEligibleEntity({
          name: row.eventName,
          isActive: true,
        })) return false;
        if (!publicSeoCityIdentityMatches(
          { city: row.hostCity, state: row.hostState },
          city,
        )) return false;
        const timeZone = resolveCityTimeZoneSync({
          city: row.hostCity || null,
          state: row.hostState || null,
        });
        const interval = buildSlotDateTimes({
          timeZone,
          date: row.eventDate,
          startTime: String(row.eventStartTime || ""),
          endTime: String(row.eventEndTime || ""),
        });
        if (
          !interval ||
          !row.bookingConfirmedAt ||
          interval.endUtc.getTime() < now.getTime() ||
          dateKeyInZone(interval.startUtc, timeZone) !==
            dateKeyInZone(now, timeZone)
        ) {
          return false;
        }
        const slotIsPublic = isSlotPublic({
          slot: {
            source: "parking_pass_booking",
            status: "confirmed",
            startsAtUtc: interval.startUtc,
            endsAtUtc: interval.endUtc,
            lastConfirmedAtUtc: row.bookingConfirmedAt,
          },
          now,
          ttlHours: 24 * 365 * 100,
        });
        return canExposeAnonymousEventDetail({
          eventType: row.eventType,
          requiresPayment: row.eventRequiresPayment,
          status: row.eventStatus,
          slotIsPublic,
        });
      },
    });

    return rows
      .map((row: any) => ({
        ...buildCard(row),
        city: String(row.hostCity || "").trim() || city.name,
        state: String(row.hostState || "").trim() || city.state,
        statusLabel: "Confirmed today",
        summary: row.eventName
          ? `Event today: ${normalizeStoredLabel(String(row.eventName))}`
          : "Event happening today",
      }));
  },

  async loadCityFood(city: PublicSeoLandingCity) {
    const rows = await collectPublicSeoRowsInBatches({
      visibleLimit: 80,
      loadBatch: (offset, limit) => db
        .select(publicRestaurantSelect)
        .from(restaurants)
        .innerJoin(users, eq(restaurants.ownerId, users.id))
        .where(
          and(
            eq(restaurants.isActive, true),
            cityIdentityWhere(city, restaurants.city, restaurants.state),
          ),
        )
        .orderBy(desc(restaurants.updatedAt), asc(restaurants.id))
        .limit(limit)
        .offset(offset),
      selectVisible: (row: any) =>
        isIndexableRestaurantRow(row) &&
        publicSeoCityIdentityMatches(row, city),
    });
    return rows.map(buildCard);
  },

  async loadCuisine(
    cuisineSlug: string,
    city: PublicSeoLandingCity | null,
  ) {
    const rows = await collectPublicSeoRowsInBatches({
      visibleLimit: 80,
      loadBatch: (offset, limit) => db
        .select(publicRestaurantSelect)
        .from(restaurants)
        .innerJoin(users, eq(restaurants.ownerId, users.id))
        .where(
          and(
            eq(restaurants.isActive, true),
            canonicalCuisineWhere(restaurants.cuisineType, cuisineSlug),
            ...(city
              ? [cityIdentityWhere(city, restaurants.city, restaurants.state)]
              : []),
          ),
        )
        .orderBy(desc(restaurants.updatedAt), asc(restaurants.id))
        .limit(limit)
        .offset(offset),
      selectVisible: (row: any) =>
        isIndexableRestaurantRow(row) &&
        (city ? publicSeoCityIdentityMatches(row, city) : true) &&
        publicSeoCuisineMatches(row.cuisineType, cuisineSlug),
    });
    return rows.map(buildCard);
  },

  async loadLocationsWithTrucks(city: PublicSeoLandingCity, now: Date) {
    const queryStart = new Date(now);
    queryStart.setUTCHours(0, 0, 0, 0);
    queryStart.setUTCDate(queryStart.getUTCDate() - 1);
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const hostRows: any[] = [];
    await scanPublicSeoRowsInBatches({
      loadBatch: (offset, limit) => db
      .selectDistinct({
        bookingId: eventBookings.id,
        hostId: hosts.id,
        hostName: hosts.businessName,
        hostCity: hosts.city,
        hostState: hosts.state,
        hostAddress: hosts.address,
        hostUpdatedAt: hosts.updatedAt,
        eventId: events.id,
        eventName: events.name,
        eventType: events.eventType,
        eventStatus: events.status,
        eventRequiresPayment: events.requiresPayment,
        eventDate: events.date,
        eventStartTime: events.startTime,
        eventEndTime: events.endTime,
        bookingConfirmedAt: eventBookings.bookingConfirmedAt,
        truckId: eventBookings.truckId,
        truckName: restaurants.name,
        truckIsActive: restaurants.isActive,
        truckIsFoodTruck: restaurants.isFoodTruck,
        truckBusinessType: restaurants.businessType,
        truckOwnerId: restaurants.ownerId,
        truckOwnerEmail: users.email,
        truckOwnerDisabled: users.isDisabled,
        truckAddress: restaurants.address,
        truckCity: restaurants.city,
        truckState: restaurants.state,
        truckCuisineType: restaurants.cuisineType,
        truckDescription: restaurants.description,
        truckRawData: restaurants.rawData,
        truckPhone: restaurants.phone,
        truckWebsiteUrl: restaurants.websiteUrl,
      })
      .from(eventBookings)
      .innerJoin(events, eq(eventBookings.eventId, events.id))
      .innerJoin(hosts, eq(events.hostId, hosts.id))
      .innerJoin(restaurants, eq(eventBookings.truckId, restaurants.id))
      .innerJoin(users, eq(restaurants.ownerId, users.id))
      .where(
        and(
          eq(eventBookings.status, "confirmed"),
          isNotNull(eventBookings.bookingConfirmedAt),
          inArray(events.status, ["open", "booked", "filled"]),
          or(eq(events.requiresPayment, false), isNull(events.requiresPayment)),
          eq(restaurants.isActive, true),
          eq(users.isDisabled, false),
          sql`exists (
            select 1 from users host_owner
            where host_owner.id = ${hosts.userId}
              and host_owner.is_disabled = false
          )`,
          publicTruckClassificationWhere(
            restaurants.isFoodTruck,
            restaurants.businessType,
          ),
          gte(events.date, queryStart),
          lte(events.date, end),
          cityIdentityWhere(city, hosts.city, hosts.state),
        ),
      )
      .orderBy(
        desc(hosts.updatedAt),
        asc(hosts.id),
        asc(events.id),
        asc(eventBookings.id),
      )
      .limit(limit)
      .offset(offset),
      visitBatch(rows) {
        hostRows.push(...rows);
      },
    });

    const counts = new Map<string, { row: any; stopKeys: Set<string> }>();
    for (const row of hostRows as any[]) {
      const key = String(row.hostId || "");
      if (
        !key ||
        !publicSeoCityIdentityMatches(
          { city: row.hostCity, state: row.hostState },
          city,
        ) ||
        !isPublicDiscoveryEligibleEntity({
          name: row.hostName,
          isActive: true,
        }) ||
        !isPublicDiscoveryEligibleEntity({
          name: row.eventName,
          isActive: true,
        }) ||
        !isIndexableRestaurantRow({
          name: row.truckName,
          isActive: row.truckIsActive,
          ownerId: row.truckOwnerId,
          ownerEmail: row.truckOwnerEmail,
          ownerDisabled: row.truckOwnerDisabled,
          address: row.truckAddress,
          city: row.truckCity,
          state: row.truckState,
          cuisineType: row.truckCuisineType,
          description: row.truckDescription,
          rawData: row.truckRawData,
          phone: row.truckPhone,
          websiteUrl: row.truckWebsiteUrl,
          isFoodTruck: row.truckIsFoodTruck,
          businessType: row.truckBusinessType,
        })
      ) {
        continue;
      }
      const timeZone = resolveCityTimeZoneSync({
        city: row.hostCity || null,
        state: row.hostState || null,
      });
      const interval = buildSlotDateTimes({
        timeZone,
        date: row.eventDate,
        startTime: String(row.eventStartTime || ""),
        endTime: String(row.eventEndTime || ""),
      });
      if (!interval || !row.bookingConfirmedAt) {
        continue;
      }
      const slotIsPublic = isSlotPublic({
        slot: {
          source: "parking_pass_booking",
          status: "confirmed",
          startsAtUtc: interval.startUtc,
          endsAtUtc: interval.endUtc,
          lastConfirmedAtUtc: row.bookingConfirmedAt,
        },
        now,
        ttlHours: 24 * 365 * 100,
      });
      if (
        !canExposeAnonymousEventDetail({
          eventType: row.eventType,
          requiresPayment: row.eventRequiresPayment,
          status: row.eventStatus,
          slotIsPublic,
        })
      ) {
        continue;
      }
      if (!counts.has(key)) counts.set(key, { row, stopKeys: new Set() });
      if (row.eventId && row.truckId) {
        counts
          .get(key)!
          .stopKeys.add(`${String(row.eventId)}:${String(row.truckId)}`);
      }
    }

    return Array.from(counts.values())
      .filter((entry) => entry.stopKeys.size > 0)
      .slice(0, 120)
      .map((entry): PublicSeoLandingItem => {
        const id = String(entry.row.hostId);
        const name = String(entry.row.hostName || "");
        const profilePath = buildPublicSeoProfilePath({
          profileType: "location",
          id,
          name,
        });
        return {
          id,
          profileType: "location",
          displayName: normalizeStoredLabel(name || "Location"),
          slug: toPublicSeoSlug(name) || id,
          profilePath,
          city: entry.row.hostCity || null,
          state: entry.row.hostState || null,
          imageUrl: null,
          cuisineTags: [],
          statusLabel: "Confirmed this week",
          summary: `${entry.stopKeys.size} confirmed truck stop${entry.stopKeys.size === 1 ? "" : "s"}`,
          primaryCtaPath: profilePath,
        };
      });
  },
};

export async function loadPublicSeoCityNavigationData(citySlug: string) {
  const city = await repository.resolveCityBySlug(citySlug);
  if (!city) return null;

  const foodCuisineCounts = new Map<string, number>();
  const truckCuisineCounts = new Map<string, number>();
  let totalFood = 0;
  let totalTrucks = 0;
  await scanPublicSeoRowsInBatches<any>({
    loadBatch: (offset, limit) =>
      db
        .select(publicRestaurantSelect)
        .from(restaurants)
        .innerJoin(users, eq(restaurants.ownerId, users.id))
        .where(
          and(
            eq(restaurants.isActive, true),
            cityIdentityWhere(city, restaurants.city, restaurants.state),
          ),
        )
        .orderBy(desc(restaurants.updatedAt), asc(restaurants.id))
        .limit(limit)
        .offset(offset),
    visitBatch(rows) {
      for (const row of rows) {
        if (
          !isIndexableRestaurantRow(row) ||
          !publicSeoCityIdentityMatches(row, city)
        ) {
          continue;
        }
        const profileType = publicSeoBusinessProfileType(row);
        if (!profileType) continue;
        totalFood += 1;
        const cuisineSlug = toPublicSeoSlug(row.cuisineType);
        if (cuisineSlug) {
          foodCuisineCounts.set(
            cuisineSlug,
            (foodCuisineCounts.get(cuisineSlug) || 0) + 1,
          );
        }
        if (profileType === "truck") {
          totalTrucks += 1;
          if (cuisineSlug) {
            truckCuisineCounts.set(
              cuisineSlug,
              (truckCuisineCounts.get(cuisineSlug) || 0) + 1,
            );
          }
        }
      }
    },
  });

  const sortedCuisines = (counts: Map<string, number>) =>
    Array.from(counts.entries())
      .sort(
        (left, right) =>
          right[1] - left[1] || left[0].localeCompare(right[0]),
      )
      .map(([slug, count]) => ({ slug, count }));

  return {
    city,
    totalFood,
    totalTrucks,
    foodCuisines: sortedCuisines(foodCuisineCounts),
    truckCuisines: sortedCuisines(truckCuisineCounts),
  };
}

export async function loadPublicSeoLandingData(
  request: PublicSeoLandingRequest,
  now = new Date(),
) {
  const resolution = await resolvePublicSeoLanding(request, repository, now);
  if (resolution.kind === "not_found") return resolution;
  return {
    kind: "found" as const,
    payload: assertPublicResponseSafe(resolution.payload),
  };
}
