import type { Express } from "express";
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
  suppliers,
  users,
  videoStories,
} from "@shared/schema";
import { getIndexNowConfig } from "../services/indexNow";
import { resolveCityTimeZoneSync } from "../services/cityTimeZone";
import { buildSlotDateTimes } from "../services/timeIntent";
import { dateKeyInZone } from "../services/dateKeys";
import { isSlotPublic } from "../services/publicSlotGate";
import {
  buildPublicTruckOperatingPlans,
} from "../services/truckOperatingPlan";
import {
  publicSeoActiveTodayStop,
  publicSeoBusinessProfileType,
  publicSeoCityIdentityMatches,
  toPublicSeoSlug,
  type PublicSeoLandingCity,
} from "../services/publicSeoLandingModel";
import { buildPublicProfilePath as buildCanonicalPublicProfilePath } from "../publicProfiles/publicProfileUtils";
import { scanPublicSeoRowsInBatches } from "../services/publicSeoBatchTraversal";
import { isPublicDiscoveryEligibleEntity } from "@shared/publicDiscoveryIntegrity";
import { toCanonicalFoodBusinessType } from "@shared/businessTypes";
import { canExposeAnonymousEventDetail } from "../publicProfiles/publicEventDetailAccess";
import { publicTruckClassificationWhere } from "../seo/publicTruckClassification";
import {
  applySitemapMembershipCacheHeaders,
  isPublicRestaurantIndexable,
} from "../seo/publicRestaurantIndexability";
import {
  isIsolatedDeployment,
  isIsolatedSitemapPath,
} from "../seo/previewIsolation";
import {
  isPublicStoryAssociationEligible,
  publicStoryPublicationWhere,
} from "../services/publicStoryProjection";

const normalizedCityFieldEquals = (column: any, value: unknown) =>
  sql`lower(btrim(coalesce(${column}, ''))) = ${String(value ?? "")
    .trim()
    .toLowerCase()}`;

const normalizeCityRegistrySlug = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase();

const loadCanonicalSitemapCities = async () => {
  const rows = await db
    .select()
    .from(cities)
    .orderBy(sql`${cities.createdAt} desc nulls last`, asc(cities.id));
  const winnerBySlug = new Map<string, any>();
  for (const row of rows as any[]) {
    const slug = normalizeCityRegistrySlug(row.slug);
    const cityName = String(row.name || "").trim();
    if (!slug || !cityName || winnerBySlug.has(slug)) continue;
    winnerBySlug.set(slug, {
      ...row,
      name: cityName,
      slug,
      state: String(row.state || "").trim() || null,
    });
  }
  return Array.from(winnerBySlug.values());
};

const sitemapCityIdentityWhere = (
  city: PublicSeoLandingCity,
  cityColumn: any,
  stateColumn: any,
) =>
  and(
    normalizedCityFieldEquals(cityColumn, city.name),
    normalizedCityFieldEquals(stateColumn, city.state),
  );

const toSlug = toPublicSeoSlug;

const buildPublicProfilePath = (input: {
  profileType: "restaurant" | "truck" | "bar" | "caterer" | "private_chef" | "location" | "supplier";
  id: string;
  name: string;
}) => buildCanonicalPublicProfilePath({
  entityType: input.profileType,
  id: input.id,
  name: input.name,
});

const restaurantSitemapSelect = {
  id: restaurants.id,
  name: restaurants.name,
  city: restaurants.city,
  state: restaurants.state,
  address: restaurants.address,
  cuisineType: restaurants.cuisineType,
  description: restaurants.description,
  isFoodTruck: restaurants.isFoodTruck,
  businessType: restaurants.businessType,
  updatedAt: restaurants.updatedAt,
  isActive: restaurants.isActive,
  ownerId: restaurants.ownerId,
  ownerEmail: users.email,
  ownerDisabled: users.isDisabled,
  rawData: restaurants.rawData,
  phone: restaurants.phone,
  websiteUrl: restaurants.websiteUrl,
};

const isIndexableRestaurantRow = (row: {
  name?: unknown;
  isActive?: unknown;
  ownerId?: unknown;
  ownerEmail?: unknown;
  ownerDisabled?: unknown;
  address?: unknown;
  cuisineType?: unknown;
  description?: unknown;
  city?: unknown;
  state?: unknown;
  rawData?: unknown;
  phone?: unknown;
  websiteUrl?: unknown;
  isFoodTruck?: boolean | null;
  businessType?: string | null;
}) =>
  row.ownerDisabled === false &&
  publicSeoBusinessProfileType(row) !== null &&
  isPublicRestaurantIndexable({
    name: row.name,
    isActive: row.isActive !== false,
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
  });

type PublicServiceProfileType = "caterer" | "private_chef";

const publicServiceProfileType = (row: {
  businessType?: unknown;
  isFoodTruck?: unknown;
}): PublicServiceProfileType | null => {
  if (row.isFoodTruck === true) return null;
  const canonical = toCanonicalFoodBusinessType(row.businessType);
  return canonical === "caterer" || canonical === "private_chef"
    ? canonical
    : null;
};

const isIndexableServiceProfileRow = (row: {
  name?: unknown;
  isActive?: unknown;
  ownerId?: unknown;
  ownerEmail?: unknown;
  ownerDisabled?: unknown;
  cuisineType?: unknown;
  description?: unknown;
  city?: unknown;
  state?: unknown;
  rawData?: unknown;
  phone?: unknown;
  websiteUrl?: unknown;
  isFoodTruck?: boolean | null;
  businessType?: string | null;
}) =>
  row.ownerDisabled === false &&
  publicServiceProfileType(row) !== null &&
  isPublicRestaurantIndexable({
    name: row.name,
    isActive: row.isActive !== false,
    ownerId: row.ownerId,
    ownerEmail: row.ownerEmail,
    // Service-area businesses do not need a public street address to qualify.
    address: null,
    cuisineType: row.cuisineType,
    description: row.description,
    city: row.city,
    state: row.state,
    rawData: row.rawData,
    phone: row.phone,
    websiteUrl: row.websiteUrl,
  });

const resolveSitemapSiteUrl = () => {
  const normalizeCandidate = (raw?: string | null): string | null => {
    const value = String(raw || "").trim();
    if (!value) return null;
    try {
      const withProtocol = /^[a-z]+:\/\//i.test(value)
        ? value
        : `https://${value}`;
      const parsed = new URL(withProtocol);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
      }
      const hostname = parsed.hostname.toLowerCase();
      const bareHost = hostname.replace(/^www\./, "");
      if (bareHost !== "mealscout.us") return null;
      return "https://www.mealscout.us";
    } catch {
      return null;
    }
  };

  return (
    normalizeCandidate(process.env.SITEMAP_SITE_URL) ||
    normalizeCandidate(process.env.CLIENT_ORIGIN) ||
    normalizeCandidate(process.env.PUBLIC_BASE_URL) ||
    "https://www.mealscout.us"
  );
};

const toIsoDateOrNull = (value: unknown): string | null => {
  if (!value) return null;
  const dt = new Date(value as any);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt.toISOString();
};

const sendUrlsetXml = (
  res: any,
  params: { entries: Array<{ loc: string; lastmod?: unknown }> },
) => {
  const lastmodByLoc = new Map<string, string | null>();
  const normalizeSitemapLoc = (loc: string): string | null => {
    const value = String(loc || "").trim();
    if (!value) return null;
    try {
      const parsed = new URL(value);
      const bareHost = parsed.hostname.toLowerCase().replace(/^www\./, "");
      if (bareHost !== "mealscout.us") return null;
      parsed.protocol = "https:";
      parsed.hostname = "www.mealscout.us";
      parsed.hash = "";
      parsed.search = "";
      return parsed.toString();
    } catch {
      return null;
    }
  };

  const mergeUrl = (loc: string, lastmod?: unknown) => {
    const normalized = normalizeSitemapLoc(loc);
    if (!normalized) return;
    const next = toIsoDateOrNull(lastmod);
    const existing = lastmodByLoc.get(normalized) || null;
    if (!existing) {
      lastmodByLoc.set(normalized, next);
      return;
    }
    if (!next) return;
    if (new Date(next).getTime() > new Date(existing).getTime()) {
      lastmodByLoc.set(normalized, next);
    }
  };

  for (const entry of params.entries) {
    mergeUrl(entry.loc, entry.lastmod);
  }

  const urls = Array.from(lastmodByLoc.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([loc, lastmod]) => ({ loc, lastmod }));

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map(
      (entry) =>
        `  <url><loc>${entry.loc}</loc>${entry.lastmod ? `<lastmod>${entry.lastmod}</lastmod>` : ""}</url>`,
    )
    .join("\n")}\n</urlset>`;

  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  applySitemapMembershipCacheHeaders(res);
  res.send(xml);
};

type SeoRouteDependencies = {
  loadRootDealCityRows?: (now: Date) => Promise<any[]>;
  loadRootEventCityRows?: (now: Date) => Promise<any[]>;
};

export function registerSeoRoutes(
  app: Express,
  dependencies: SeoRouteDependencies = {},
) {
  app.use((req, res, next) => {
    if (!isIsolatedDeployment() || !isIsolatedSitemapPath(req.path)) {
      return next();
    }

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    return res.status(404).end();
  });

  const indexNowConfig = getIndexNowConfig();
  if (indexNowConfig.enabled && indexNowConfig.key) {
    const keyPath = `/${indexNowConfig.key}.txt`;
    app.get(keyPath, async (_req, res) => {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=1800");
      res.send(indexNowConfig.key);
    });
  }

  app.get("/sitemap.xml", async (_req, res) => {
    try {
      const uniqueCityRows = await loadCanonicalSitemapCities();
      const allRestaurantRows = await db
        .select(restaurantSitemapSelect)
        .from(restaurants)
        .innerJoin(users, eq(restaurants.ownerId, users.id))
        .where(eq(restaurants.isActive, true))
        .orderBy(desc(restaurants.updatedAt));
      const allHostRows = await db
        .select({
          id: hosts.id,
          name: hosts.businessName,
          updatedAt: hosts.updatedAt,
          ownerDisabled: users.isDisabled,
        })
        .from(hosts)
        .innerJoin(users, eq(hosts.userId, users.id))
        .where(eq(users.isDisabled, false))
        .orderBy(desc(hosts.updatedAt));
      const allSupplierRows = await db
        .select({
          id: suppliers.id,
          name: suppliers.businessName,
          updatedAt: suppliers.updatedAt,
          ownerDisabled: users.isDisabled,
        })
        .from(suppliers)
        .innerJoin(users, eq(suppliers.userId, users.id))
        .where(and(eq(suppliers.isActive, true), eq(users.isDisabled, false)))
        .orderBy(desc(suppliers.updatedAt));
      const restaurantRows = allRestaurantRows.filter((row: any) =>
        isIndexableRestaurantRow(row),
      );
      const serviceProfileRows = allRestaurantRows.filter((row: any) =>
        isIndexableServiceProfileRow(row),
      );
      const hostRows = allHostRows.filter((row: any) =>
        row.ownerDisabled === false && isPublicDiscoveryEligibleEntity({
          name: row.name,
          isActive: true,
        }),
      );
      const supplierRows = allSupplierRows.filter((row: any) =>
        row.ownerDisabled === false && isPublicDiscoveryEligibleEntity({
          name: row.name,
          isActive: true,
        }),
      );
      const eligibleRestaurantIds = new Set(
        restaurantRows.map((row: any) => String(row.id)),
      );
      const eligibleHostIds = new Set(
        hostRows.map((row: any) => String(row.id)),
      );
      const indexableTruckRows = restaurantRows.filter(
        (row: any) => publicSeoBusinessProfileType(row) === "truck",
      );
      const sitemapNow = new Date();
      const activeTruckPlans = await buildPublicTruckOperatingPlans(
        indexableTruckRows.map((row: any) => String(row.id)),
        { now: sitemapNow },
      );

      const baseUrl = resolveSitemapSiteUrl();
      const lastmodByLoc = new Map<string, string | null>();
      const mergeUrl = (loc: string, lastmod?: unknown) => {
        const parsedLoc = toIsoDateOrNull(lastmod);
        const normalized = String(loc || "").trim();
        if (!normalized) return;
        const existing = lastmodByLoc.get(normalized) || null;
        if (!existing) {
          lastmodByLoc.set(normalized, parsedLoc);
          return;
        }
        if (!parsedLoc) return;
        if (new Date(parsedLoc).getTime() > new Date(existing).getTime()) {
          lastmodByLoc.set(normalized, parsedLoc);
        }
      };

      [
        "/",
        "/for-hosts",
        "/host-location-partner",
        "/for-restaurants",
        "/for-food-trucks",
        "/for-bars",
        "/for-events",
        "/restaurant-signup",
        "/claim-business",
        "/host-signup",
        "/search",
        "/scout",
        "/parking-pass",
        "/deals",
        "/deals/featured",
        "/video",
        "/suppliers",
        "/about",
        "/faq",
        "/how-it-works",
        "/contact",
        "/install",
        "/terms-of-service",
        "/privacy-policy",
        "/sitemap",
        "/status",
      ].forEach((path) => mergeUrl(`${baseUrl}${path}`));

      uniqueCityRows.forEach((city: any) => {
        const cityName = String(city?.name || "").trim();
        if (!cityName) return;
        const canonicalCity = {
          id: String(city.id),
          name: cityName,
          slug: String(city.slug),
          state: city.state || null,
        };
        const cityRestaurantRows = restaurantRows.filter((row: any) =>
          publicSeoCityIdentityMatches(row, canonicalCity),
        );
        const cityTruckRows = cityRestaurantRows.filter(
          (row: any) => publicSeoBusinessProfileType(row) === "truck",
        );
        if (cityTruckRows.length > 0) {
          mergeUrl(
            `${baseUrl}/food-trucks/${encodeURIComponent(city.slug)}`,
            city.updatedAt || city.createdAt,
          );
          mergeUrl(
            `${baseUrl}/food-truck-catering/${encodeURIComponent(city.slug)}`,
            city.updatedAt || city.createdAt,
          );
          mergeUrl(
            `${baseUrl}/book-food-truck/${encodeURIComponent(city.slug)}`,
            city.updatedAt || city.createdAt,
          );
        }
        if (
          indexableTruckRows.some((row: any) =>
            Boolean(
              publicSeoActiveTodayStop(
                activeTruckPlans.get(String(row.id)),
                canonicalCity,
              ),
            ),
          )
        ) {
          mergeUrl(
            `${baseUrl}/food-trucks-today/${encodeURIComponent(city.slug)}`,
            city.updatedAt || city.createdAt,
          );
        }
        if (cityRestaurantRows.length > 0) {
          mergeUrl(
            `${baseUrl}/city/${encodeURIComponent(city.slug)}/food`,
            city.updatedAt || city.createdAt,
          );
        }
      });

      restaurantRows.forEach((row: any) => {
        const profileType = publicSeoBusinessProfileType(row);
        // Trucks/bars have dedicated sitemaps.
        if (profileType !== "restaurant") return;
        mergeUrl(
          `${baseUrl}${buildPublicProfilePath({
            profileType: "restaurant",
            id: String(row.id),
            name: String(row.name || ""),
          })}`,
          row.updatedAt,
        );
      });

      serviceProfileRows.forEach((row: any) => {
        const profileType = publicServiceProfileType(row);
        if (!profileType) return;
        mergeUrl(
          `${baseUrl}${buildPublicProfilePath({
            profileType,
            id: String(row.id),
            name: String(row.name || ""),
          })}`,
          row.updatedAt,
        );
      });

      hostRows.forEach((row: any) => {
        mergeUrl(
          `${baseUrl}${buildPublicProfilePath({
            profileType: "location",
            id: String(row.id),
            name: String(row.name || ""),
          })}`,
          row.updatedAt,
        );
      });

      supplierRows.forEach((row: any) => {
        mergeUrl(
          `${baseUrl}${buildPublicProfilePath({
            profileType: "supplier",
            id: String(row.id),
            name: String(row.name || ""),
          })}`,
          row.updatedAt,
        );
      });

      const resolveCitySlug = (input: { city?: unknown; state?: unknown }) => {
        const match = uniqueCityRows.find((city: any) =>
          publicSeoCityIdentityMatches(input, {
            id: String(city.id),
            name: String(city.name || ""),
            slug: String(city.slug || ""),
            state: city.state || null,
          }),
        );
        return String(match?.slug || "").trim() || null;
      };

      const cuisineLastmodByCity = new Map<string, string | null>();
      const truckCuisineLastmodByCity = new Map<string, string | null>();
      const mergeLastmod = (
        target: Map<string, string | null>,
        key: string,
        next: string | null,
      ) => {
        const existing = target.get(key) || null;
        if (
          !existing ||
          (next && new Date(next).getTime() > new Date(existing).getTime())
        ) {
          target.set(key, next);
        }
      };
      for (const row of restaurantRows as any[]) {
        const citySlug = resolveCitySlug({ city: row.city, state: row.state });
        const cuisineSlug = toSlug(row.cuisineType || "");
        if (!citySlug || !cuisineSlug) continue;
        const key = `${citySlug}:${cuisineSlug}`;
        const next = toIsoDateOrNull(row.updatedAt);
        mergeLastmod(cuisineLastmodByCity, key, next);
        if (publicSeoBusinessProfileType(row) === "truck") {
          mergeLastmod(truckCuisineLastmodByCity, key, next);
        }
      }

      cuisineLastmodByCity.forEach((lastmod, key) => {
        const [citySlug, cuisineSlug] = key.split(":");
        if (!citySlug || !cuisineSlug) return;
        mergeUrl(
          `${baseUrl}/cuisine/${encodeURIComponent(cuisineSlug)}/${encodeURIComponent(citySlug)}`,
          lastmod || undefined,
        );
      });
      truckCuisineLastmodByCity.forEach((lastmod, key) => {
        const [citySlug, cuisineSlug] = key.split(":");
        if (!citySlug || !cuisineSlug) return;
        mergeUrl(
          `${baseUrl}/food-trucks/${encodeURIComponent(citySlug)}/${encodeURIComponent(cuisineSlug)}`,
          lastmod || undefined,
        );
      });

      // Canonical server-rendered deal-today pages for cities with an active deal.
      try {
        const activeDealRows = dependencies.loadRootDealCityRows
          ? await dependencies.loadRootDealCityRows(sitemapNow)
          : await db
              .select({
                restaurantId: restaurants.id,
                dealTitle: deals.title,
                cityName: restaurants.city,
                cityState: restaurants.state,
                updatedAt: deals.updatedAt,
              })
              .from(deals)
              .innerJoin(restaurants, eq(deals.restaurantId, restaurants.id))
              .where(
                and(
                  eq(restaurants.isActive, true),
                  eq(deals.isActive, true),
                  lte(deals.startDate, sitemapNow),
                  or(isNull(deals.endDate), gte(deals.endDate, sitemapNow)),
                  isNotNull(restaurants.city),
                ),
              );

        const dealCityLastmod = new Map<string, string | null>();
        for (const row of activeDealRows) {
          if (!eligibleRestaurantIds.has(String(row.restaurantId))) continue;
          if (
            !isPublicDiscoveryEligibleEntity({
              name: row.dealTitle,
              isActive: true,
            })
          ) {
            continue;
          }
          const slug = resolveCitySlug({
            city: row.cityName,
            state: row.cityState,
          });
          if (!slug) continue;
          const next = toIsoDateOrNull(row.updatedAt);
          const existing = dealCityLastmod.get(slug) || null;
          if (
            !existing ||
            (next && new Date(next).getTime() > new Date(existing).getTime())
          ) {
            dealCityLastmod.set(slug, next);
          }
        }

        dealCityLastmod.forEach((lastmod, slug) => {
          mergeUrl(
            `${baseUrl}/deals-today/${encodeURIComponent(slug)}`,
            lastmod || undefined,
          );
        });
      } catch (dealCityErr) {
        console.error("[sitemap] deal-city section failed:", dealCityErr);
        throw dealCityErr;
      }

      // Event city pages use two distinct truths: today's event collection and
      // the locations collection's seven-day confirmed-stop window.
      try {
        const queryStart = new Date(sitemapNow);
        queryStart.setUTCHours(0, 0, 0, 0);
        queryStart.setUTCDate(queryStart.getUTCDate() - 1);
        const locationsWindowEnd = new Date(
          sitemapNow.getTime() + 7 * 24 * 60 * 60 * 1000,
        );
        const eventCityRows = dependencies.loadRootEventCityRows
          ? await dependencies.loadRootEventCityRows(sitemapNow)
          : await db
              .selectDistinct({
                truckId: restaurants.id,
                hostId: hosts.id,
                hostName: hosts.businessName,
                eventName: events.name,
                eventType: events.eventType,
                eventStatus: events.status,
                eventRequiresPayment: events.requiresPayment,
                cityName: hosts.city,
                hostState: hosts.state,
                eventDate: events.date,
                eventStartTime: events.startTime,
                eventEndTime: events.endTime,
                bookingConfirmedAt: eventBookings.bookingConfirmedAt,
                updatedAt: events.updatedAt,
              })
              .from(eventBookings)
              .innerJoin(events, eq(eventBookings.eventId, events.id))
              .innerJoin(hosts, eq(events.hostId, hosts.id))
              .innerJoin(restaurants, eq(eventBookings.truckId, restaurants.id))
              .where(
                and(
                  eq(eventBookings.status, "confirmed"),
                  isNotNull(eventBookings.bookingConfirmedAt),
                  inArray(events.status, ["open", "booked", "filled"]),
                  or(
                    isNull(events.requiresPayment),
                    eq(events.requiresPayment, false),
                  ),
                  eq(restaurants.isActive, true),
                  publicTruckClassificationWhere(
                    restaurants.isFoodTruck,
                    restaurants.businessType,
                  ),
                  gte(events.date, queryStart),
                  lte(events.date, locationsWindowEnd),
                  isNotNull(hosts.city),
                ),
              );

        const eventTodayCityLastmod = new Map<string, string | null>();
        const locationsThisWeekCityLastmod = new Map<string, string | null>();
        const updateCityLastmod = (
          target: Map<string, string | null>,
          slug: string,
          next: string | null,
        ) => {
          const existing = target.get(slug) || null;
          if (
            !existing ||
            (next && new Date(next).getTime() > new Date(existing).getTime())
          ) {
            target.set(slug, next);
          }
        };
        for (const row of eventCityRows) {
          if (
            !eligibleRestaurantIds.has(String(row.truckId)) ||
            !eligibleHostIds.has(String(row.hostId)) ||
            !isPublicDiscoveryEligibleEntity({
              name: row.hostName,
              isActive: true,
            }) ||
            !isPublicDiscoveryEligibleEntity({
              name: row.eventName,
              isActive: true,
            })
          ) {
            continue;
          }
          const timeZone = resolveCityTimeZoneSync({
            city: row.cityName || null,
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
            !canExposeAnonymousEventDetail({
              eventType: row.eventType,
              requiresPayment: row.eventRequiresPayment,
              status: row.eventStatus,
              slotIsPublic: isSlotPublic({
                slot: {
                  source: "parking_pass_booking",
                  status: "confirmed",
                  startsAtUtc: interval.startUtc,
                  endsAtUtc: interval.endUtc,
                  lastConfirmedAtUtc: row.bookingConfirmedAt,
                },
                now: sitemapNow,
                ttlHours: 24 * 365 * 100,
              }),
            })
          ) {
            continue;
          }
          const slug = resolveCitySlug({
            city: row.cityName,
            state: row.hostState,
          });
          if (!slug) continue;
          const next = toIsoDateOrNull(row.updatedAt);
          updateCityLastmod(locationsThisWeekCityLastmod, slug, next);
          if (
            interval.endUtc.getTime() >= sitemapNow.getTime() &&
            dateKeyInZone(interval.startUtc, timeZone) ===
              dateKeyInZone(sitemapNow, timeZone)
          ) {
            updateCityLastmod(eventTodayCityLastmod, slug, next);
          }
        }

        eventTodayCityLastmod.forEach((lastmod, slug) => {
          mergeUrl(
            `${baseUrl}/events-today/${encodeURIComponent(slug)}`,
            lastmod || undefined,
          );
        });
        locationsThisWeekCityLastmod.forEach((lastmod, slug) => {
          mergeUrl(
            `${baseUrl}/locations-with-trucks/${encodeURIComponent(slug)}`,
            lastmod || undefined,
          );
        });
      } catch (eventCityErr) {
        console.error("[sitemap] event-city section failed:", eventCityErr);
        throw eventCityErr;
      }

      sendUrlsetXml(res, {
        entries: Array.from(lastmodByLoc.entries()).map(([loc, lastmod]) => ({
          loc,
          lastmod,
        })),
      });
    } catch (e) {
      console.error("sitemap failed", e);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Retry-After", "60");
      res.setHeader("X-Robots-Tag", "noindex, follow");
      res
        .status(503)
        .type("application/xml")
        .send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><error>temporarily unavailable</error>");
    }
  });

  app.get("/sitemap-trucks.xml", async (_req, res) => {
    try {
      const baseUrl = resolveSitemapSiteUrl();
      const rows = await db
        .select(restaurantSitemapSelect)
        .from(restaurants)
        .innerJoin(users, eq(restaurants.ownerId, users.id))
        .where(eq(restaurants.isActive, true))
        .orderBy(desc(restaurants.updatedAt))
        .limit(50000);

      const entries = rows
        .filter(
          (row: any) =>
            publicSeoBusinessProfileType(row) === "truck" &&
            isIndexableRestaurantRow(row),
        )
        .map((row: any) => ({
          loc: `${baseUrl}${buildPublicProfilePath({
            profileType: "truck",
            id: String(row.id),
            name: String(row.name || ""),
          })}`,
          lastmod: row.updatedAt,
        }));

      sendUrlsetXml(res, { entries });
    } catch (e) {
      console.error("sitemap-trucks failed", e);
      res.status(500).send("<error>failed</error>");
    }
  });

  app.get("/sitemap-bars.xml", async (_req, res) => {
    try {
      const baseUrl = resolveSitemapSiteUrl();
      const rows = await db
        .select(restaurantSitemapSelect)
        .from(restaurants)
        .innerJoin(users, eq(restaurants.ownerId, users.id))
        .where(eq(restaurants.isActive, true))
        .orderBy(desc(restaurants.updatedAt))
        .limit(50000);

      const entries = rows
        .filter(
          (row: any) =>
            publicSeoBusinessProfileType(row) === "bar" &&
            isIndexableRestaurantRow(row),
        )
        .map((row: any) => ({
          loc: `${baseUrl}${buildPublicProfilePath({
            profileType: "bar",
            id: String(row.id),
            name: String(row.name || ""),
          })}`,
          lastmod: row.updatedAt,
        }));

      sendUrlsetXml(res, { entries });
    } catch (e) {
      console.error("sitemap-bars failed", e);
      res.status(500).send("<error>failed</error>");
    }
  });

  app.get("/sitemap-services.xml", async (_req, res) => {
    try {
      const baseUrl = resolveSitemapSiteUrl();
      const rows = await db
        .select(restaurantSitemapSelect)
        .from(restaurants)
        .innerJoin(users, eq(restaurants.ownerId, users.id))
        .where(eq(restaurants.isActive, true))
        .orderBy(desc(restaurants.updatedAt))
        .limit(50000);

      const entries = rows
        .filter((row: any) => isIndexableServiceProfileRow(row))
        .flatMap((row: any) => {
          const profileType = publicServiceProfileType(row);
          if (!profileType) return [];
          return [{
            loc: `${baseUrl}${buildPublicProfilePath({
              profileType,
              id: String(row.id),
              name: String(row.name || ""),
            })}`,
            lastmod: row.updatedAt,
          }];
        });

      sendUrlsetXml(res, { entries });
    } catch (e) {
      console.error("sitemap-services failed", e);
      res.status(500).send("<error>failed</error>");
    }
  });

  app.get("/sitemap-locations.xml", async (_req, res) => {
    try {
      const baseUrl = resolveSitemapSiteUrl();
      const lookaheadHoursRaw = Number(
        process.env.PUBLIC_SLOT_LOOKAHEAD_HOURS ?? 24 * 7,
      );
      const lookaheadHours = Number.isFinite(lookaheadHoursRaw)
        ? Math.max(1, Math.min(lookaheadHoursRaw, 24 * 30))
        : 24 * 7;
      const now = new Date();
      const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const windowEnd = new Date(
        now.getTime() + lookaheadHours * 60 * 60 * 1000,
      );

      const candidateRows = await db
        .select({
          ...restaurantSitemapSelect,
          hostId: events.hostId,
          hostName: hosts.businessName,
          eventDate: events.date,
          eventStartTime: events.startTime,
          eventEndTime: events.endTime,
          eventName: events.name,
          eventType: events.eventType,
          eventStatus: events.status,
          eventRequiresPayment: events.requiresPayment,
          hostCity: hosts.city,
          hostState: hosts.state,
          bookingConfirmedAt: eventBookings.bookingConfirmedAt,
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
            gte(events.date, windowStart),
            lte(events.date, windowEnd),
          ),
        )
        .limit(50000);

      const eligibleHostIds = Array.from(
        new Set<string>(
          candidateRows.flatMap((row: (typeof candidateRows)[number]) => {
            if (
              !isIndexableRestaurantRow(row) ||
              !isPublicDiscoveryEligibleEntity({
                name: row.hostName,
                isActive: true,
              }) ||
              !isPublicDiscoveryEligibleEntity({
                name: row.eventName,
                isActive: true,
              })
            ) {
              return [];
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
            if (
              !interval ||
              !row.bookingConfirmedAt ||
              !canExposeAnonymousEventDetail({
                eventType: row.eventType,
                requiresPayment: row.eventRequiresPayment,
                status: row.eventStatus,
                slotIsPublic: isSlotPublic({
                  slot: {
                    source: "parking_pass_booking",
                    status: "confirmed",
                    startsAtUtc: interval.startUtc,
                    endsAtUtc: interval.endUtc,
                    lastConfirmedAtUtc: row.bookingConfirmedAt,
                  },
                  now,
                  lookaheadHours,
                  ttlHours: 24 * 365 * 100,
                }),
              })
            ) {
              return [];
            }
            return [String(row.hostId)];
          }),
        ),
      );

      const rows =
        eligibleHostIds.length === 0
          ? []
          : await db
              .select({
                id: hosts.id,
                name: hosts.businessName,
                updatedAt: hosts.updatedAt,
                ownerDisabled: users.isDisabled,
              })
              .from(hosts)
              .innerJoin(users, eq(hosts.userId, users.id))
              .where(
                and(
                  inArray(hosts.id, eligibleHostIds),
                  eq(users.isDisabled, false),
                ),
              )
              .orderBy(desc(hosts.updatedAt))
              .limit(50000);

      sendUrlsetXml(res, {
        entries: rows.map((row: any) => ({
          loc: `${baseUrl}/location/${encodeURIComponent(`${toSlug(row.name) || row.id}--${row.id}`)}`,
          lastmod: row.updatedAt,
        })),
      });
    } catch (e) {
      console.error("sitemap-locations failed", e);
      res.status(500).send("<error>failed</error>");
    }
  });

  app.get("/sitemap-cities.xml", async (_req, res) => {
    try {
      const baseUrl = resolveSitemapSiteUrl();
      const rows = await loadCanonicalSitemapCities();

      const entries: Array<{ loc: string; lastmod?: unknown }> = [];
      for (const row of rows as any[]) {
        const slug = normalizeCityRegistrySlug(row.slug);
        const cityName = String(row.name || "").trim();
        if (!slug || !cityName) continue;
        const canonicalCity: PublicSeoLandingCity = {
          id: String(row.id),
          name: cityName,
          slug,
          state: row.state || null,
        };

        let hasEligibleHomeCityProfile = false;
        await scanPublicSeoRowsInBatches({
          loadBatch: (offset, limit) => db
            .select(restaurantSitemapSelect)
            .from(restaurants)
            .innerJoin(users, eq(restaurants.ownerId, users.id))
            .where(
              and(
                eq(restaurants.isActive, true),
                sitemapCityIdentityWhere(
                  canonicalCity,
                  restaurants.city,
                  restaurants.state,
                ),
              ),
            )
            .orderBy(desc(restaurants.updatedAt), asc(restaurants.id))
            .limit(limit)
            .offset(offset),
          visitBatch(candidates) {
            hasEligibleHomeCityProfile = candidates.some((candidate: any) =>
              isIndexableRestaurantRow(candidate),
            );
            return hasEligibleHomeCityProfile ? false : undefined;
          },
        });

        if (!hasEligibleHomeCityProfile) {
          continue;
        }

        entries.push({
          loc: `${baseUrl}/city/${encodeURIComponent(slug)}/food`,
          lastmod: row.createdAt,
        });
      }

      sendUrlsetXml(res, { entries });
    } catch (e) {
      console.error("sitemap-cities failed", e);
      res.status(500).send("<error>failed</error>");
    }
  });

  app.get("/sitemap-cuisines.xml", async (_req, res) => {
    try {
      const baseUrl = resolveSitemapSiteUrl();
      const rows = await db
        .select(restaurantSitemapSelect)
        .from(restaurants)
        .innerJoin(users, eq(restaurants.ownerId, users.id))
        .where(eq(restaurants.isActive, true))
        .orderBy(desc(restaurants.updatedAt))
        .limit(50000);

      const lastmodByCuisine = new Map<string, string | null>();
      for (const row of rows.filter((candidate: any) =>
        isIndexableRestaurantRow(candidate),
      ) as any[]) {
        const slug = toSlug(row.cuisineType || "");
        if (!slug) continue;
        const next = toIsoDateOrNull(row.updatedAt);
        const existing = lastmodByCuisine.get(slug) || null;
        if (!existing) {
          lastmodByCuisine.set(slug, next);
          continue;
        }
        if (!next) continue;
        if (new Date(next).getTime() > new Date(existing).getTime()) {
          lastmodByCuisine.set(slug, next);
        }
      }

      sendUrlsetXml(res, {
        entries: Array.from(lastmodByCuisine.entries()).map(
          ([slug, lastmod]) => ({
            loc: `${baseUrl}/cuisine/${encodeURIComponent(slug)}`,
            lastmod,
          }),
        ),
      });
    } catch (e) {
      console.error("sitemap-cuisines failed", e);
      res.status(500).send("<error>failed</error>");
    }
  });

  app.get("/sitemap-time-pages.xml", (_req, res) => {
    res.status(410);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send("Gone");
  });

  app.get("/sitemap-events.xml", async (_req, res) => {
    try {
      const baseUrl = resolveSitemapSiteUrl();
      const lookaheadHoursRaw = Number(
        process.env.PUBLIC_SLOT_LOOKAHEAD_HOURS ?? 24 * 7,
      );
      const lookaheadHours = Number.isFinite(lookaheadHoursRaw)
        ? Math.max(1, Math.min(lookaheadHoursRaw, 24 * 30))
        : 24 * 7;
      const now = new Date();
      const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const windowEnd = new Date(
        now.getTime() + lookaheadHours * 60 * 60 * 1000,
      );

      const rows = await db
        .selectDistinct({
          ...restaurantSitemapSelect,
          eventId: events.id,
          eventName: events.name,
          eventType: events.eventType,
          eventStatus: events.status,
          eventRequiresPayment: events.requiresPayment,
          hostName: hosts.businessName,
          eventDate: events.date,
          eventStartTime: events.startTime,
          eventEndTime: events.endTime,
          hostCity: hosts.city,
          hostState: hosts.state,
          bookingConfirmedAt: eventBookings.bookingConfirmedAt,
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
            or(
              isNull(events.requiresPayment),
              eq(events.requiresPayment, false),
            ),
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
            gte(events.date, windowStart),
            lte(events.date, windowEnd),
          ),
        )
        .orderBy(desc(events.updatedAt))
        .limit(50000);

      const eligibleRows = rows.filter((row: any) => {
        if (
          !isIndexableRestaurantRow(row) ||
          !isPublicDiscoveryEligibleEntity({
            name: row.hostName,
            isActive: true,
          }) ||
          !isPublicDiscoveryEligibleEntity({
            name: row.eventName,
            isActive: true,
          })
        ) {
          return false;
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
        return Boolean(
          interval &&
          row.bookingConfirmedAt &&
          canExposeAnonymousEventDetail({
            eventType: row.eventType,
            requiresPayment: row.eventRequiresPayment,
            status: row.eventStatus,
            slotIsPublic: isSlotPublic({
              slot: {
                source: "parking_pass_booking",
                status: "confirmed",
                startsAtUtc: interval.startUtc,
                endsAtUtc: interval.endUtc,
                lastConfirmedAtUtc: row.bookingConfirmedAt,
              },
              now,
              lookaheadHours,
              ttlHours: 24 * 365 * 100,
            }),
          }),
        );
      });
      const uniqueEligibleRows = Array.from(
        new Map(
          eligibleRows.map((row: any) => [String(row.eventId), row] as const),
        ).values(),
      );

      sendUrlsetXml(res, {
        entries: uniqueEligibleRows.map((row: any) => {
          const title = row.eventName || row.hostName || row.eventId;
          return {
            loc: `${baseUrl}/event/${encodeURIComponent(`${toSlug(title) || row.eventId}--${row.eventId}`)}`,
            lastmod: row.updatedAt,
          };
        }),
      });
    } catch (e) {
      console.error("sitemap-events failed", e);
      res.status(500).send("<error>failed</error>");
    }
  });

  app.get("/sitemap-deals.xml", async (_req, res) => {
    try {
      const baseUrl = resolveSitemapSiteUrl();
      const now = new Date();
      const rows = await db
        .select({
          ...restaurantSitemapSelect,
          dealId: deals.id,
          dealTitle: deals.title,
          dealUpdatedAt: deals.updatedAt,
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
          ),
        )
        .orderBy(desc(deals.updatedAt))
        .limit(50000);

      sendUrlsetXml(res, {
        entries: rows
          .filter(
            (row: any) =>
              isIndexableRestaurantRow(row) &&
              isPublicDiscoveryEligibleEntity({
                name: row.dealTitle,
                isActive: true,
              }),
          )
          .map((row: any) => ({
            loc: `${baseUrl}/deal/${encodeURIComponent(`${toSlug(row.dealTitle) || row.dealId}--${row.dealId}`)}`,
            lastmod: row.dealUpdatedAt,
          })),
      });
    } catch (e) {
      console.error("sitemap-deals failed", e);
      res.status(500).send("<error>failed</error>");
    }
  });

  app.get("/sitemap-suppliers.xml", async (_req, res) => {
    try {
      const baseUrl = resolveSitemapSiteUrl();
      const rows = await db
        .select({
          id: suppliers.id,
          name: suppliers.businessName,
          updatedAt: suppliers.updatedAt,
          ownerDisabled: users.isDisabled,
        })
        .from(suppliers)
        .innerJoin(users, eq(suppliers.userId, users.id))
        .where(and(eq(suppliers.isActive, true), eq(users.isDisabled, false)))
        .orderBy(desc(suppliers.updatedAt))
        .limit(50000);

      sendUrlsetXml(res, {
        entries: rows
          .filter((row: any) =>
            row.ownerDisabled === false && isPublicDiscoveryEligibleEntity({
              name: row.name,
              isActive: true,
            }),
          )
          .map((row: any) => ({
            loc: `${baseUrl}/supplier/${encodeURIComponent(`${toSlug(row.name) || row.id}--${row.id}`)}`,
            lastmod: row.updatedAt,
          })),
      });
    } catch (e) {
      console.error("sitemap-suppliers failed", e);
      res.status(500).send("<error>failed</error>");
    }
  });

  app.get("/sitemap-videos.xml", async (_req, res) => {
    try {
      const baseUrl = resolveSitemapSiteUrl();
      const now = new Date();
      const candidates = await db
        .select({
          id: videoStories.id,
          title: videoStories.title,
          createdAt: videoStories.createdAt,
          restaurantId: videoStories.restaurantId,
          creatorDisabled: users.isDisabled,
          restaurantActive: restaurants.isActive,
          restaurantName: restaurants.name,
          restaurantAddress: restaurants.address,
          restaurantCity: restaurants.city,
          restaurantState: restaurants.state,
          restaurantCuisineType: restaurants.cuisineType,
          restaurantDescription: restaurants.description,
          restaurantOwnerDisabled: sql<boolean | null>`(
            select linked_owner.is_disabled from users linked_owner
            where linked_owner.id = ${restaurants.ownerId} limit 1
          )`,
          restaurantRawData: restaurants.rawData,
        })
        .from(videoStories)
        .innerJoin(users, eq(videoStories.userId, users.id))
        .leftJoin(restaurants, eq(videoStories.restaurantId, restaurants.id))
        .where(
          and(
            publicStoryPublicationWhere(now),
            eq(users.isDisabled, false),
            or(
              isNull(videoStories.restaurantId),
              eq(restaurants.isActive, true),
            ),
            isNotNull(videoStories.transcriptSource),
          ),
        )
        .orderBy(desc(videoStories.createdAt))
        .limit(200000);
      const rows = candidates
        .filter((row: any) => isPublicStoryAssociationEligible(row))
        .slice(0, 50000);

      sendUrlsetXml(res, {
        entries: rows.map((row: any) => ({
          loc: `${baseUrl}/video/${encodeURIComponent(`${toSlug(row.title) || row.id}--${row.id}`)}`,
          lastmod: row.createdAt,
        })),
      });
    } catch (e) {
      console.error("sitemap-videos failed", e);
      res.status(500).send("<error>failed</error>");
    }
  });

  app.get("/llms.txt", async (_req, res) => {
    try {
      const baseUrl = resolveSitemapSiteUrl();
      const lines = [
        "# MealScout",
        "",
        "MealScout is a local food discovery platform. It helps diners find food trucks, restaurants, and bars near them. It helps food truck owners get booked at host locations and events. It helps restaurant and bar owners publish specials and stay visible locally. It helps host-location partners list parking spots for food trucks.",
        "",
        "## What MealScout Does",
        "- Food truck discovery: live map, city/cuisine pages, booking",
        "- Restaurant & bar discovery: local specials, deals, profiles",
        "- Host locations: bookable parking spots for food trucks",
        "- Events & open calls: food truck event coordination",
        "- Online ordering: pickup menus with Stripe payments",
        "- Supply Scout: ingredient price tracking for operators",
        "",
        "## Priority Pages",
        `${baseUrl}/`,
        `${baseUrl}/for-restaurants`,
        `${baseUrl}/for-food-trucks`,
        `${baseUrl}/for-bars`,
        `${baseUrl}/for-events`,
        `${baseUrl}/scout`,
        `${baseUrl}/restaurant-signup`,
        `${baseUrl}/claim-business`,
        `${baseUrl}/for-hosts`,
        `${baseUrl}/host-location-partner`,
        `${baseUrl}/map`,
        `${baseUrl}/search`,
        `${baseUrl}/deals/featured`,
        `${baseUrl}/about`,
        `${baseUrl}/faq`,
        `${baseUrl}/how-it-works`,
        `${baseUrl}/sitemap`,
        `${baseUrl}/sitemap.xml`,
        "",
        "## City & Cuisine Discovery Pages",
        "Pattern: /food-trucks/{city-slug}",
        "Pattern: /food-trucks/{city-slug}/{cuisine-slug}",
        "Pattern: /food-truck-catering/{city-slug}",
        "Pattern: /book-food-truck/{city-slug}",
        "City and cuisine child pages are discoverable only when published in MealScout's sitemap.",
        "",
        "## Business Profile Pages",
        "Pattern: /restaurant/{slug}--{id}",
        "Pattern: /truck/{slug}--{id}",
        "Pattern: /bar/{slug}--{id}",
        "Pattern: /caterer/{slug}--{id}",
        "Pattern: /private-chef/{slug}--{id}",
        "Pattern: /location/{slug}--{id}",
        "Pattern: /supplier/{slug}--{id}",
        "Eligible profile pages are canonical public entity pages. Use the canonical URL in the first HTML response and sitemap.",
        "Public profile facts may include category, city/state, menu or schedule context, business website/social identities, and public contact details when the owner has allowed them. Private account fields are never discovery facts.",
        "",
        "## Policies",
        "Public marketing, discovery, and profile pages may be indexed and summarized.",
        "Private account, admin, and dashboard pages are not for indexing.",
        "",
        "## Contact",
        "Email: info.mealscout@gmail.com",
        "Website: https://www.mealscout.us",
      ].join("\n");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=1800");
      res.send(lines);
    } catch (e) {
      console.error("llms.txt failed", e);
      res.status(500).send("MealScout");
    }
  });

  app.get("/ai.txt", async (_req, res) => {
    try {
      const baseUrl = resolveSitemapSiteUrl();
      const lines = ["MealScout", `${baseUrl}/llms.txt`].join("\n");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=1800");
      res.send(lines);
    } catch (e) {
      console.error("ai.txt failed", e);
      res.status(500).send("MealScout");
    }
  });

  app.get("/robots.txt", async (_req, res) => {
    try {
      if (isIsolatedDeployment()) {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
        return res.send(["User-agent: *", "Disallow: /", ""].join("\n"));
      }

      const baseUrl = resolveSitemapSiteUrl();
      const robots = [
        "User-agent: *",
        "Allow: /robots.txt",
        "Allow: /llms.txt",
        "Allow: /ai.txt",
        "Allow: /sitemap.xml",
        "Allow: /sitemap-*.xml",
        "Allow: /truck/",
        "Allow: /location/",
        "Allow: /city/",
        "Allow: /event/",
        "Allow: /cuisine/",
        "Allow: /deal/",
        "Allow: /bar/",
        "Allow: /caterer/",
        "Allow: /private-chef/",
        "Allow: /supplier/",
        "Allow: /video/",
        "Allow: /food-trucks/",
        "Allow: /p/",
        "Allow: /api/public/",
        "Allow: /api/trucks/live",
        "Allow: /api/truck-claims/public-search",
        "",
        "Disallow: /dashboard",
        "Disallow: /admin",
        "Disallow: /api",
        "Disallow: /vendor-dashboard",
        "Disallow: /supplier-portal",
        "",
        `Sitemap: ${baseUrl}/sitemap.xml`,
        `Sitemap: ${baseUrl}/sitemap-trucks.xml`,
        `Sitemap: ${baseUrl}/sitemap-bars.xml`,
        `Sitemap: ${baseUrl}/sitemap-services.xml`,
        `Sitemap: ${baseUrl}/sitemap-locations.xml`,
        `Sitemap: ${baseUrl}/sitemap-cities.xml`,
        `Sitemap: ${baseUrl}/sitemap-cuisines.xml`,
        `Sitemap: ${baseUrl}/sitemap-events.xml`,
        `Sitemap: ${baseUrl}/sitemap-deals.xml`,
        `Sitemap: ${baseUrl}/sitemap-suppliers.xml`,
        `Sitemap: ${baseUrl}/sitemap-videos.xml`,
        "",
        `AI: ${baseUrl}/llms.txt`,
        ...(indexNowConfig.enabled &&
        indexNowConfig.key &&
        indexNowConfig.keyLocation
          ? [`IndexNow: ${indexNowConfig.keyLocation}`]
          : []),
        "",
      ].join("\n");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=1800");
      res.send(robots);
    } catch (e) {
      console.error("robots failed", e);
      res.status(500).send("User-agent: *\nAllow: /\n");
    }
  });
}
