import type { Express } from "express";
import { and, asc, desc, eq, gte, isNull, or, sql } from "drizzle-orm";

import { db } from "../db";
import { storage } from "../storage";
import { computeParkingPassQualityFlags } from "../services/parkingPassQuality";
import {
  deals,
  eventSeries,
  events,
  hosts,
  restaurants,
  users,
  videoStories,
} from "@shared/schema";
import {
  expandScoutSearchTerms,
  foldScoutSearchText,
} from "@shared/scoutSearchIntent";
import { recordInternalSearchOutcome } from "../services/discoveryObservatory";
import {
  AGGREGATE_SEARCH_DEAL_LIMIT,
  AGGREGATE_SEARCH_EVENT_LIMIT,
  AGGREGATE_SEARCH_HOST_LIMIT,
  AGGREGATE_SEARCH_RESTAURANT_CANDIDATE_LIMIT,
  AGGREGATE_SEARCH_VIDEO_LIMIT,
  MAX_SEARCH_RESPONSE_BYTES,
  PUBLIC_SEARCH_TIMEOUT_MS,
  clampJsonByBucketArrays,
  isDeadlineError,
  withDeadline,
} from "@shared/searchResponseBounds";
import { loadPublicRestaurantListingVisibility } from "../publicProfiles/toPublicRestaurantListingWithVisibility";
import {
  buildPublicRestaurantSearchSuggestions,
  rankPublicRestaurantSearchRows,
} from "../services/publicRestaurantSearchProjection";
import { projectPublicDealRows } from "../services/publicDealProjection";
import { resolvePublicHostProximityCoordinates } from "../services/publicHostProximityProjection";
import { resolvePublicProfileVisibility } from "../publicProfiles/publicProfileUtils";
import {
  isPublicStoryAssociationEligible,
  publicStoryPublicationWhere,
} from "../services/publicStoryProjection";
import { canExposeAnonymousEventListItem } from "../publicProfiles/publicEventDetailAccess";

/**
 * SQL projection of foldScoutSearchText (@shared/scoutSearchIntent) for the
 * columns this route matches with LIKE. Postgres cannot run the JS NFD
 * fold, so the stored side is folded with translate() over the Latin
 * letters that carry a single diacritical mark (Latin-1 Supplement +
 * Latin Extended-A): SEARCH_SQL_FOLD_FROM[i] folds to
 * SEARCH_SQL_FOLD_TO[i]. Letters with no decomposition (ø, æ, ß) stay
 * unfolded on both sides, exactly as the JS fold leaves them. The pairing
 * and lengths are pinned by
 * scripts/mealscout-search-accent-folding.contract.test.ts.
 */
export const SEARCH_SQL_FOLD_FROM =
  "àáâãäåāăąçćĉċčďèéêëēĕėęěĝğġģĥìíîïĩīĭįĵķĺļľñńņňòóôõöōŏőŕŗřśŝşšţťùúûüũūŭůűųŵýÿŷźżž";
export const SEARCH_SQL_FOLD_TO =
  "aaaaaaaaacccccdeeeeeeeeegggghiiiiiiiijklllnnnnoooooooorrrssssttuuuuuuuuuuwyyyzzz";

const foldedSearchColumn = (column: any) =>
  sql`translate(lower(coalesce(${column}, '')), ${SEARCH_SQL_FOLD_FROM}, ${SEARCH_SQL_FOLD_TO})`;

function restaurantSearchMatchSql(searchTerms: string[]) {
  const terms = searchTerms.length > 0 ? searchTerms : [""];
  return or(
    ...terms.map((term) => {
      const like = `%${term}%`;
      return or(
        sql`${foldedSearchColumn(restaurants.name)} like ${like}`,
        sql`${foldedSearchColumn(restaurants.cuisineType)} like ${like}`,
        sql`${foldedSearchColumn(restaurants.city)} like ${like}`,
        sql`${foldedSearchColumn(restaurants.state)} like ${like}`,
        sql`${foldedSearchColumn(restaurants.description)} like ${like}`,
      );
    }),
  );
}

export async function searchPublicRestaurantResults(
  database: any,
  query: string,
) {
  const searchTerm = foldScoutSearchText(query.trim());
  const searchTerms = expandScoutSearchTerms(searchTerm);
  const searchValue = `%${searchTerm}%`;
  const searchPrefixValue = `${searchTerm}%`;

  // The phrase order must run in SQL before the cap. Otherwise broad imported
  // token matches can discard the exact business before JS relevance runs.
  const restaurantMatches = await database
    .select({
      id: restaurants.id,
      ownerId: restaurants.ownerId,
      name: restaurants.name,
      cuisineType: restaurants.cuisineType,
      address: restaurants.address,
      city: restaurants.city,
      state: restaurants.state,
      description: restaurants.description,
      logoUrl: restaurants.logoUrl,
      coverImageUrl: restaurants.coverImageUrl,
      businessType: restaurants.businessType,
      isFoodTruck: restaurants.isFoodTruck,
      isVerified: restaurants.isVerified,
      isActive: restaurants.isActive,
      rawData: restaurants.rawData,
      homeRankingScore: restaurants.rankingScore,
    })
    .from(restaurants)
    .where(
      and(
        eq(restaurants.isActive, true),
        restaurantSearchMatchSql(searchTerms),
      ),
    )
    .orderBy(
      asc(sql`case
        when lower(${restaurants.name}) = ${searchTerm} then 0
        when lower(${restaurants.name}) like ${searchPrefixValue} then 1
        when lower(${restaurants.name}) like ${searchValue} then 2
        else 3
      end`),
      desc(restaurants.rankingScore),
      asc(restaurants.name),
    )
    .limit(AGGREGATE_SEARCH_RESTAURANT_CANDIDATE_LIMIT);

  const visibilityByOwnerId = await loadPublicRestaurantListingVisibility(
    restaurantMatches,
    database,
  );
  return rankPublicRestaurantSearchRows(
    restaurantMatches,
    query,
    visibilityByOwnerId,
  );
}

export function registerPublicSearchRoutes(app: Express) {
  app.get("/api/search/suggestions/:query", async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const { query } = req.params;
      if (!query || query.length < 2) {
        return res.json([]);
      }

      const searchTerm = query.toLowerCase();
      const searchValue = `%${searchTerm}%`;
      const suggestionsV2: any[] = [];

      const restaurantRows = await db
        .select({
          id: restaurants.id,
          ownerId: restaurants.ownerId,
          name: restaurants.name,
          cuisineType: restaurants.cuisineType,
          address: restaurants.address,
          city: restaurants.city,
          state: restaurants.state,
          businessType: restaurants.businessType,
          isFoodTruck: restaurants.isFoodTruck,
          isActive: restaurants.isActive,
          rawData: restaurants.rawData,
        })
        .from(restaurants)
        .where(
          and(
            eq(restaurants.isActive, true),
            or(
              sql`lower(${restaurants.name}) like ${searchValue}`,
              sql`lower(coalesce(${restaurants.cuisineType}, '')) like ${searchValue}`,
              sql`lower(coalesce(${restaurants.city}, '')) like ${searchValue}`,
              sql`lower(coalesce(${restaurants.state}, '')) like ${searchValue}`,
            ),
          ),
        )
        .limit(6);

      const visibilityByOwnerId = await loadPublicRestaurantListingVisibility(
        restaurantRows,
        db,
      );
      suggestionsV2.push(
        ...buildPublicRestaurantSearchSuggestions(
          restaurantRows,
          searchTerm,
          visibilityByOwnerId,
        ),
      );

      const dealRows = await db
        .select({
          id: deals.id,
          restaurantId: deals.restaurantId,
          title: deals.title,
          discountValue: deals.discountValue,
        })
        .from(deals)
        .innerJoin(restaurants, eq(deals.restaurantId, restaurants.id))
        .where(
          and(
            eq(deals.isActive, true),
            or(
              sql`lower(${deals.title}) like ${searchValue}`,
              sql`lower(${restaurants.name}) like ${searchValue}`,
            ),
          ),
        )
        .limit(6);
      const publicDealRows = await projectPublicDealRows(dealRows, {
        database: db,
      });
      for (const row of publicDealRows) {
        suggestionsV2.push({
          id: `deal-${row.id}`,
          text: row.title,
          type: "deal",
          subtitle: `${row.restaurant?.name || "Restaurant"} - ${row.discountValue}% off`,
        });
      }

      const hostRows = await db
        .select({
          hostId: hosts.id,
          hostUserId: hosts.userId,
          businessName: hosts.businessName,
          address: hosts.address,
          city: hosts.city,
          state: hosts.state,
          latitude: hosts.latitude,
          longitude: hosts.longitude,
          spotImageUrl: hosts.spotImageUrl,
          stripeConnectAccountId: hosts.stripeConnectAccountId,
          stripeChargesEnabled: hosts.stripeChargesEnabled,
          defaultStartTime: eventSeries.defaultStartTime,
          defaultEndTime: eventSeries.defaultEndTime,
          defaultMaxTrucks: eventSeries.defaultMaxTrucks,
          breakfastPriceCents: eventSeries.defaultBreakfastPriceCents,
          lunchPriceCents: eventSeries.defaultLunchPriceCents,
          dinnerPriceCents: eventSeries.defaultDinnerPriceCents,
          dailyPriceCents: eventSeries.defaultDailyPriceCents,
          weeklyPriceCents: eventSeries.defaultWeeklyPriceCents,
          monthlyPriceCents: eventSeries.defaultMonthlyPriceCents,
          publicProfileSettings: users.publicProfileSettings,
        })
        .from(eventSeries)
        .innerJoin(hosts, eq(eventSeries.hostId, hosts.id))
        .innerJoin(users, eq(hosts.userId, users.id))
        .where(
          and(
            eq(eventSeries.seriesType, "parking_pass"),
            eq(eventSeries.status, "published"),
            eq(users.isDisabled, false),
            or(
              sql`lower(${hosts.businessName}) like ${searchValue}`,
              sql`lower(coalesce(${hosts.city}, '')) like ${searchValue}`,
              sql`lower(coalesce(${hosts.state}, '')) like ${searchValue}`,
            ),
          ),
        )
        .orderBy(desc(eventSeries.updatedAt))
        .limit(10);
      for (const row of hostRows.slice(0, 4)) {
        const publicCoordinates = resolvePublicHostProximityCoordinates({
          latitude: row.latitude,
          longitude: row.longitude,
          publicProfileSettings: row.publicProfileSettings,
        });
        if (!publicCoordinates) continue;
        const qualityFlags = computeParkingPassQualityFlags({
          host: {
            address: row.address,
            city: row.city,
            state: row.state,
            latitude: publicCoordinates.latitude,
            longitude: publicCoordinates.longitude,
            stripeConnectAccountId: row.stripeConnectAccountId,
            stripeChargesEnabled: row.stripeChargesEnabled,
          },
          startTime: row.defaultStartTime,
          endTime: row.defaultEndTime,
          maxTrucks: row.defaultMaxTrucks,
          breakfastPriceCents: row.breakfastPriceCents,
          lunchPriceCents: row.lunchPriceCents,
          dinnerPriceCents: row.dinnerPriceCents,
          dailyPriceCents: row.dailyPriceCents,
          weeklyPriceCents: row.weeklyPriceCents,
          monthlyPriceCents: row.monthlyPriceCents,
        });
        if (qualityFlags.length > 0) continue;
        suggestionsV2.push({
          id: `parking-pass-${row.hostId}`,
          text: row.businessName || "Parking Pass spot",
          type: "parking_pass",
          subtitle: `${row.address}${row.city ? `, ${row.city}` : ""}${row.state ? `, ${row.state}` : ""}`,
        });
      }

      const nowSql = sql`NOW()`;
      const storyRows = await db
        .select({
          id: videoStories.id,
          title: videoStories.title,
          restaurantId: videoStories.restaurantId,
          restaurantName: restaurants.name,
          restaurantActive: restaurants.isActive,
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
          creatorDisabled: users.isDisabled,
        })
        .from(videoStories)
        .innerJoin(users, eq(videoStories.userId, users.id))
        .leftJoin(restaurants, eq(videoStories.restaurantId, restaurants.id))
        .where(
          and(
            publicStoryPublicationWhere(nowSql as any),
            eq(users.isDisabled, false),
            or(
              isNull(videoStories.restaurantId),
              eq(restaurants.isActive, true),
            ),
            or(
              sql`lower(coalesce(${videoStories.title}, '')) like ${searchValue}`,
              sql`lower(coalesce(${restaurants.name}, '')) like ${searchValue}`,
            ),
          ),
        )
        .orderBy(desc(videoStories.createdAt))
        .limit(16);
      const publicStoryRows = storyRows
        .filter((row: any) => isPublicStoryAssociationEligible(row))
        .slice(0, 4);
      for (const row of publicStoryRows) {
        suggestionsV2.push({
          id: `video-${row.id}`,
          text: row.title || "Video",
          type: "video",
          subtitle: row.restaurantName
            ? `From ${row.restaurantName}`
            : "Video story",
        });
      }

      const eventRows = await db
        .select({
          id: events.id,
          name: events.name,
          eventType: events.eventType,
          requiresPayment: events.requiresPayment,
          status: events.status,
          hostBusinessName: hosts.businessName,
          hostCity: hosts.city,
          hostState: hosts.state,
        })
        .from(events)
        .innerJoin(hosts, eq(events.hostId, hosts.id))
        .innerJoin(users, eq(hosts.userId, users.id))
        .where(
          and(
            eq(events.eventType, "event"),
            eq(users.isDisabled, false),
            gte(events.date, nowSql as any),
            or(
              sql`lower(coalesce(${events.name}, '')) like ${searchValue}`,
              sql`lower(${hosts.businessName}) like ${searchValue}`,
              sql`lower(coalesce(${hosts.city}, '')) like ${searchValue}`,
            ),
          ),
        )
        .orderBy(asc(events.date))
        .limit(4);
      for (const row of eventRows) {
        if (
          !canExposeAnonymousEventListItem({
            eventType: row.eventType,
            requiresPayment: row.requiresPayment,
            status: row.status,
            eventName: row.name,
            hostName: row.hostBusinessName,
          })
        ) {
          continue;
        }
        suggestionsV2.push({
          id: `event-${row.id}`,
          text: row.name || row.hostBusinessName || "Event",
          type: "event",
          subtitle: `${row.hostBusinessName}${row.hostCity ? ` - ${row.hostCity}` : ""}${row.hostState ? `, ${row.hostState}` : ""}`,
        });
      }

      const limitedSuggestionsV2 = suggestionsV2.slice(0, 10).sort((a, b) => {
        const aExact = String(a.text || "")
          .toLowerCase()
          .startsWith(searchTerm)
          ? 1
          : 0;
        const bExact = String(b.text || "")
          .toLowerCase()
          .startsWith(searchTerm)
          ? 1
          : 0;
        return bExact - aExact;
      });

      return res.json(limitedSuggestionsV2);
    } catch (error) {
      console.error("Search suggestions error:", error);
      res.status(500).json({ message: "Failed to get search suggestions" });
    }
  });

  app.get("/api/search", async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const query = String(req.query?.q || "").trim();
      if (!query || query.length < 2) {
        return res.json({
          query,
          restaurants: [],
          deals: [],
          parkingPassHosts: [],
          videos: [],
          events: [],
        });
      }

      const payload = await withDeadline(
        (async () => {
          const searchTerm = foldScoutSearchText(query);
          const searchValue = `%${searchTerm}%`;
          const restaurantsOut = await searchPublicRestaurantResults(db, query);

          const publicDeals = await projectPublicDealRows(
            await storage.getActiveDeals(),
            { database: db },
          );
          const dealsOut = publicDeals
            .filter((deal: any) => {
              const searchable = [
                deal.title,
                deal.description,
                deal.restaurant?.name,
                deal.restaurant?.cuisineType,
              ]
                .map((value) => foldScoutSearchText(value))
                .join(" ");
              return searchable.includes(searchTerm);
            })
            .slice(0, AGGREGATE_SEARCH_DEAL_LIMIT);

          const hostSeriesRows = await db
            .select({
              hostId: hosts.id,
              hostUserId: hosts.userId,
              businessName: hosts.businessName,
              address: hosts.address,
              city: hosts.city,
              state: hosts.state,
              latitude: hosts.latitude,
              longitude: hosts.longitude,
              spotImageUrl: hosts.spotImageUrl,
              stripeConnectAccountId: hosts.stripeConnectAccountId,
              stripeChargesEnabled: hosts.stripeChargesEnabled,
              defaultStartTime: eventSeries.defaultStartTime,
              defaultEndTime: eventSeries.defaultEndTime,
              defaultMaxTrucks: eventSeries.defaultMaxTrucks,
              breakfastPriceCents: eventSeries.defaultBreakfastPriceCents,
              lunchPriceCents: eventSeries.defaultLunchPriceCents,
              dinnerPriceCents: eventSeries.defaultDinnerPriceCents,
              dailyPriceCents: eventSeries.defaultDailyPriceCents,
              weeklyPriceCents: eventSeries.defaultWeeklyPriceCents,
              monthlyPriceCents: eventSeries.defaultMonthlyPriceCents,
              updatedAt: eventSeries.updatedAt,
              publicProfileSettings: users.publicProfileSettings,
            })
            .from(eventSeries)
            .innerJoin(hosts, eq(eventSeries.hostId, hosts.id))
            .innerJoin(users, eq(hosts.userId, users.id))
            .where(
              and(
                eq(eventSeries.seriesType, "parking_pass"),
                eq(eventSeries.status, "published"),
                eq(users.isDisabled, false),
                or(
                  sql`lower(${hosts.businessName}) like ${searchValue}`,
                  sql`lower(coalesce(${hosts.city}, '')) like ${searchValue}`,
                  sql`lower(coalesce(${hosts.state}, '')) like ${searchValue}`,
                ),
              ),
            )
            .orderBy(desc(eventSeries.updatedAt))
            .limit(50);

          const bestHostById = new Map<string, any>();
          for (const row of hostSeriesRows) {
            const hostId = String((row as any).hostId);
            if (!bestHostById.has(hostId)) bestHostById.set(hostId, row);
          }

          const parkingPassHostsOut = Array.from(bestHostById.values())
            .map((row: any) => {
              const publicCoordinates = resolvePublicHostProximityCoordinates({
                latitude: row.latitude,
                longitude: row.longitude,
                publicProfileSettings: row.publicProfileSettings,
              });
              if (!publicCoordinates) return null;
              const qualityFlags = computeParkingPassQualityFlags({
                host: {
                  address: row.address,
                  city: row.city,
                  state: row.state,
                  latitude: publicCoordinates.latitude,
                  longitude: publicCoordinates.longitude,
                  stripeConnectAccountId: row.stripeConnectAccountId,
                  stripeChargesEnabled: row.stripeChargesEnabled,
                },
                startTime: row.defaultStartTime,
                endTime: row.defaultEndTime,
                maxTrucks: row.defaultMaxTrucks,
                breakfastPriceCents: row.breakfastPriceCents,
                lunchPriceCents: row.lunchPriceCents,
                dinnerPriceCents: row.dinnerPriceCents,
                dailyPriceCents: row.dailyPriceCents,
                weeklyPriceCents: row.weeklyPriceCents,
                monthlyPriceCents: row.monthlyPriceCents,
              });

              return {
                hostId: row.hostId,
                businessName: row.businessName,
                address: row.address,
                city: row.city,
                state: row.state,
                latitude: publicCoordinates.latitude,
                longitude: publicCoordinates.longitude,
                spotImageUrl: row.spotImageUrl,
                qualityFlags,
              };
            })
            .filter(
              (row: any) =>
                row !== null &&
                Array.isArray(row.qualityFlags) &&
                row.qualityFlags.length === 0,
            )
            .slice(0, AGGREGATE_SEARCH_HOST_LIMIT);

          const nowSql = sql`NOW()`;
          const videoRows = (
            await db
            .select({
              id: videoStories.id,
              title: videoStories.title,
              description: videoStories.description,
              restaurantId: videoStories.restaurantId,
              restaurantName: restaurants.name,
              restaurantActive: restaurants.isActive,
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
              creatorDisabled: users.isDisabled,
              createdAt: videoStories.createdAt,
            })
            .from(videoStories)
            .innerJoin(users, eq(videoStories.userId, users.id))
            .leftJoin(
              restaurants,
              eq(videoStories.restaurantId, restaurants.id),
            )
            .where(
              and(
                publicStoryPublicationWhere(nowSql as any),
                eq(users.isDisabled, false),
                or(
                  isNull(videoStories.restaurantId),
                  eq(restaurants.isActive, true),
                ),
                or(
                  sql`lower(coalesce(${videoStories.title}, '')) like ${searchValue}`,
                  sql`lower(coalesce(${videoStories.description}, '')) like ${searchValue}`,
                  sql`lower(coalesce(${restaurants.name}, '')) like ${searchValue}`,
                ),
              ),
            )
            .orderBy(desc(videoStories.createdAt))
            .limit(AGGREGATE_SEARCH_VIDEO_LIMIT * 4)
          )
            .filter((row: any) => isPublicStoryAssociationEligible(row))
            .slice(0, AGGREGATE_SEARCH_VIDEO_LIMIT)
            .map(
              ({
                restaurantActive: _restaurantActive,
                restaurantAddress: _restaurantAddress,
                restaurantCity: _restaurantCity,
                restaurantState: _restaurantState,
                restaurantCuisineType: _restaurantCuisineType,
                restaurantDescription: _restaurantDescription,
                restaurantOwnerDisabled: _restaurantOwnerDisabled,
                restaurantRawData: _restaurantRawData,
                creatorDisabled: _creatorDisabled,
                ...publicVideo
              }: any) => publicVideo,
            );

          const eventsRows = await db
            .select({
              id: events.id,
              name: events.name,
              description: events.description,
              eventType: events.eventType,
              requiresPayment: events.requiresPayment,
              status: events.status,
              date: events.date,
              startTime: events.startTime,
              endTime: events.endTime,
              hostId: hosts.id,
              hostBusinessName: hosts.businessName,
              hostAddress: hosts.address,
              hostCity: hosts.city,
              hostState: hosts.state,
              hostPublicProfileSettings: users.publicProfileSettings,
            })
            .from(events)
            .innerJoin(hosts, eq(events.hostId, hosts.id))
            .innerJoin(users, eq(hosts.userId, users.id))
            .where(
              and(
                eq(events.eventType, "event"),
                eq(users.isDisabled, false),
                gte(events.date, nowSql as any),
                or(
                  sql`lower(coalesce(${events.name}, '')) like ${searchValue}`,
                  sql`lower(coalesce(${events.description}, '')) like ${searchValue}`,
                  sql`lower(${hosts.businessName}) like ${searchValue}`,
                  sql`lower(coalesce(${hosts.city}, '')) like ${searchValue}`,
                ),
              ),
            )
            .orderBy(asc(events.date))
            .limit(AGGREGATE_SEARCH_EVENT_LIMIT);

          const publicEventsRows = eventsRows.flatMap((row: any) => {
            if (
              !canExposeAnonymousEventListItem({
                eventType: row.eventType,
                requiresPayment: row.requiresPayment,
                status: row.status,
                eventName: row.name,
                hostName: row.hostBusinessName,
              })
            ) {
              return [];
            }
            const visibility = resolvePublicProfileVisibility(
              row.hostPublicProfileSettings,
            );
            const {
              hostPublicProfileSettings: _settings,
              eventType: _eventType,
              requiresPayment: _requiresPayment,
              status: _status,
              ...publicEvent
            } = row;
            return [{
              ...publicEvent,
              hostAddress: visibility.showAddress ? row.hostAddress : null,
            }];
          });

          return {
            query,
            restaurants: restaurantsOut,
            deals: dealsOut,
            parkingPassHosts: parkingPassHostsOut,
            videos: videoRows,
            events: publicEventsRows,
          };
        })(),
        PUBLIC_SEARCH_TIMEOUT_MS,
        "public search",
      );

      const bounded = clampJsonByBucketArrays(
        payload,
        MAX_SEARCH_RESPONSE_BYTES,
      );
      if (bounded.truncated) {
        res.setHeader("X-MealScout-Search-Truncated", "1");
        res.setHeader("X-MealScout-Search-Bytes", String(bounded.bytes));
      }
      const resultCount = [
        payload.restaurants,
        payload.deals,
        payload.parkingPassHosts,
        payload.videos,
        payload.events,
      ].reduce(
        (total, bucket) => total + (Array.isArray(bucket) ? bucket.length : 0),
        0,
      );
      await recordInternalSearchOutcome({ req, query, resultCount }).catch(
        (observatoryError) => {
          console.error(
            "Failed to record internal search outcome:",
            observatoryError,
          );
        },
      );
      res.json(bounded.value);
    } catch (error) {
      if (isDeadlineError(error)) {
        console.error("Unified search timeout:", error);
        return res.status(504).json({
          message: "Search timed out",
          timeoutMs: PUBLIC_SEARCH_TIMEOUT_MS,
        });
      }
      console.error("Unified search error:", error);
      res.status(500).json({ message: "Failed to search" });
    }
  });
}
