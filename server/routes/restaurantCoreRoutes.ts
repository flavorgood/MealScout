import type { Express } from "express";
import crypto from "crypto";
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { db } from "../db";
import { storage } from "../storage";
import { emailService } from "../emailService";
import { notifyUser } from "../productNotifications";
import { isAuthenticated, isRestaurantOwner } from "../unifiedAuth";
import { sanitizeUser } from "../utils/sanitize";
import { isUniqueViolation } from "../utils/isUniqueViolation";
import { validateDocuments, checkRateLimit } from "../documentValidation";
import { vacEvaluateRestaurantSignup } from "../vacLite";
import { ensurePremiumTrialForUser } from "../services/premiumTrial";
import {
  BusinessPromotionError,
  promoteBusinessSetupToProfile,
} from "../services/businessOnboardingPromotion";
import { isPublicBusinessVisible } from "../utils/publicBusinessVisibility";
import { parseQuickReviewScore } from "../quickReview/parseQuickReviewScore";
import {
  buildQuickReviewContextFingerprint,
  decideQuickReviewContext,
  mergeQuickReviewScores,
} from "../quickReview/contextIdempotency";
import { distributedRateLimit } from "../middleware/distributedRateLimit";
import { recordFollowJourneyOutcome } from "../services/discoveryObservatory";
import {
  toPublicRestaurantListingArrayWithVisibility,
  toPublicRestaurantListingWithVisibility,
} from "../publicProfiles/toPublicRestaurantListingWithVisibility";
import { deriveProfileEvidenceQuarantineVisibility } from "../services/profileEvidenceQuarantine";
import {
  MAX_SEARCH_RESPONSE_BYTES,
  RESTAURANT_SEARCH_RESULT_LIMIT,
  clampArrayToMaxBytes,
} from "@shared/searchResponseBounds";
import {
  publicInsertRestaurantSchema,
  insertRestaurantFavoriteSchema,
  insertRestaurantFollowSchema,
  insertRestaurantUserRecommendationSchema,
  insertVerificationRequestSchema,
  verificationRequests,
  deals,
  imageUploads,
  restaurantFavorites,
  restaurantFollows,
  restaurantUserRecommendations,
  videoStories,
  users,
  telemetryEvents,
  truckImportListings,
  menuItems,
  restaurants,
  reviews,
} from "@shared/schema";
import {
  deleteFromCloudinary,
  isCloudinaryConfigured,
  upload as imageUpload,
  uploadToCloudinary,
} from "../imageUpload";
import {
  computeHomeRankingScore,
  getHomeRankingReasons,
} from "@shared/rankingPolicy";
import { resolveStoredFoodBusinessType } from "@shared/businessTypes";
import {
  filterProjectedPublicNearbyRestaurantRows,
  filterProjectedRestaurantSearchRows,
  publicRestaurantDistanceKm,
} from "../services/publicRestaurantSearchProjection";
import { publicStoryPublicationWhere } from "../services/publicStoryProjection";
import { postgresTextArray } from "../utils/postgresTextArray";

const ensureTrialForUser = ensurePremiumTrialForUser;

const restaurantRecommendLimiter = distributedRateLimit({
  scope: "restaurant-recommend",
  limit: 12,
  windowMs: 60 * 1000,
  key: (req) => String((req as any).user?.id || "authenticated"),
});

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const messageBodyToHtml = (value: string) =>
  value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map(
      (paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`,
    )
    .join("");

type AnalyticsAccessResult = {
  hasAccess: boolean;
  error?: string;
  subscriptionTier?: string;
};

type RestaurantCoreRouteDependencies = {
  validateProfileAnalyticsAccess: (userId: string) => Promise<AnalyticsAccessResult>;
};

const ENGAGEMENT_ACTION_COOLDOWN_MS = 3000;
const engagementActionLastSeen = new Map<string, number>();

const consumeEngagementWindow = (key: string) => {
  const now = Date.now();
  const lastSeen = engagementActionLastSeen.get(key) || 0;
  const elapsed = now - lastSeen;
  if (elapsed < ENGAGEMENT_ACTION_COOLDOWN_MS) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((ENGAGEMENT_ACTION_COOLDOWN_MS - elapsed) / 1000),
      ),
    };
  }

  engagementActionLastSeen.set(key, now);
  return { allowed: true, retryAfterSeconds: 0 };
};

async function recordVerifiedFollowDiscoveryOutcome(input: {
  req: any;
  restaurantId: string;
  userId: string;
  restaurantName: string;
  entityType: "truck" | "restaurant";
  actionObservedAt: string;
  alreadyExists?: boolean;
}) {
  let durableFollow: any = null;
  try {
    // Receipt/completion is eligible only after a separate canonical read,
    // not merely because the insert returned successfully.
    durableFollow = await storage.getRestaurantFollowReceipt(
      input.restaurantId,
      input.userId,
    );
  } catch (readError) {
    console.error("Failed to verify durable restaurant follow:", readError);
  }
  await recordFollowJourneyOutcome({
    req: input.req,
    restaurantId: input.restaurantId,
    restaurantName: input.restaurantName,
    entityType: input.entityType,
    alreadyExists: input.alreadyExists,
    actionObservedAt: input.actionObservedAt,
    durableFollowId: durableFollow?.id || null,
    durableFollowVerifiedAt: durableFollow ? new Date().toISOString() : null,
  }).catch((observatoryError) => {
    console.error("Failed to record discovery follow outcome:", observatoryError);
  });
}

export function registerRestaurantCoreRoutes(
  app: Express,
  { validateProfileAnalyticsAccess }: RestaurantCoreRouteDependencies,
) {
  const trackEngagement = async (
    eventName: string,
    userId: string | null | undefined,
    restaurantId: string | null | undefined,
    properties?: Record<string, any>,
  ) => {
    const safeUserId = String(userId || "").trim();
    const safeRestaurantId = String(restaurantId || "").trim();
    if (!safeUserId || !safeRestaurantId) return;

    try {
      await db.insert(telemetryEvents).values({
        eventName,
        userId: safeUserId,
        properties: {
          restaurantId: safeRestaurantId,
          ...(properties || {}),
        },
      });
    } catch (error) {
      console.warn(`[telemetry] Failed to record ${eventName}:`, error);
    }
  };

  const trackBusinessConversationEvent = async (
    eventName: string,
    properties: Record<string, any>,
    userId?: string | null,
  ) => {
    try {
      await db.insert(telemetryEvents).values({
        eventName,
        userId: userId || null,
        properties,
      });
    } catch (error) {
      console.warn(`[telemetry] Failed to record ${eventName}:`, error);
    }
  };

  app.post("/api/restaurants", isRestaurantOwner, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const publicRestaurantData = publicInsertRestaurantSchema.parse(req.body);
      const restaurantData = {
        ...publicRestaurantData,
        ownerId: userId,
      };

      let restaurant: any;
      if (resolveStoredFoodBusinessType(restaurantData) === "food_truck") {
        if (req.body?.acceptTerms !== true) {
          return res.status(400).json({
            message: "You must accept the terms",
          });
        }
        const promoted = await promoteBusinessSetupToProfile(userId, {
          onboardingAttemptId:
            String(req.body?.onboardingAttemptId || "").trim() ||
            crypto.randomUUID(),
          businessName: restaurantData.name,
          businessType: "food_truck",
          address: restaurantData.address,
          city: restaurantData.city,
          state: restaurantData.state,
          phone: restaurantData.phone,
          cuisineType: restaurantData.cuisineType,
          description: restaurantData.description,
          websiteUrl: restaurantData.websiteUrl,
          instagramUrl: restaurantData.instagramUrl,
          facebookPageUrl: restaurantData.facebookPageUrl,
          logoUrl: restaurantData.logoUrl,
          coverImageUrl: restaurantData.coverImageUrl,
          menuItems:
            req.body?.menuItems || req.body?.menu || req.body?.menuDraft || [],
          placeEvidence: req.body?.placeEvidence || null,
        });
        restaurant = promoted.restaurant;
      } else {
        restaurant = await storage.createRestaurant(restaurantData);
      }

      try {
        const enabled =
          String(
            process.env.VAC_AUTO_VERIFY_ENABLED || "false",
          ).toLowerCase() !== "false";
        if (enabled) {
          const vac = await vacEvaluateRestaurantSignup({
            user: req.user,
            restaurant,
            req,
          });
          console.log("🔍 VAC-lite evaluation:", {
            restaurantId: restaurant.id,
            restaurantName: (restaurant as any).name,
            score: vac.score,
            threshold: vac.threshold,
            shouldAutoVerify: vac.shouldAutoVerify,
            signals: vac.signals,
          });

          if (vac.shouldAutoVerify) {
            console.log("✅ Auto-verifying restaurant:", restaurant.id);
            await storage.setRestaurantVerified(restaurant.id, true);
            (restaurant as any).isVerified = true;
            try {
              await ensureTrialForUser(req.user);
            } catch (error) {
              console.warn(
                "ensureTrialForUser failed after /api/restaurants auto-verify:",
                error,
              );
            }
          } else {
            console.log(
              "⚠️  Creating manual verification request for:",
              restaurant.id,
            );
            const hasPending = await storage.hasPendingVerificationRequest(
              restaurant.id,
            );
            if (!hasPending) {
              await storage.createVerificationRequest({
                restaurantId: restaurant.id,
                documents: [],
              });
            } else {
              console.log("ℹ️  Pending verification request already exists");
            }
          }
        }
      } catch (error) {
        console.warn("VAC-lite failed", error);
      }

      res.json(restaurant);
    } catch (error: any) {
      console.error("Error creating restaurant:", error);
      if (error instanceof BusinessPromotionError) {
        return res.status(error.statusCode).json({
          ...(error.code ? { code: error.code } : {}),
          message: error.message,
        });
      }
      res.status(400).json({ message: error.message });
    }
  });

  app.get("/api/restaurants/my", isRestaurantOwner, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const restaurants = await storage.getRestaurantsByOwner(userId);
      res.json(restaurants);
    } catch (error) {
      console.error("Error fetching restaurants:", error);
      res.status(500).json({ message: "Failed to fetch restaurants" });
    }
  });

  app.get(
    "/api/auth/restaurant/user",
    isRestaurantOwner,
    async (req: any, res) => {
      try {
        res.json(sanitizeUser(req.user));
      } catch (error) {
        console.error("Error fetching restaurant owner:", error);
        res.status(500).json({ message: "Failed to fetch user" });
      }
    },
  );

  app.get("/api/restaurants/search", async (req, res) => {
    try {
      const { q: query, lat, lng, radius = 10 } = req.query;

      console.log("🔍 Restaurant search request:", { query, lat, lng, radius });

      if (!query || typeof query !== "string" || query.length < 2) {
        console.log("⚠️  Empty or short query, returning empty array");
        return res.json([]);
      }

      const searchTerm = query.toLowerCase();
      const restaurants = (await storage.getAllRestaurants()).filter(
        (restaurant: any) => isPublicBusinessVisible(restaurant),
      );
      const publicRestaurants =
        await toPublicRestaurantListingArrayWithVisibility(restaurants);

      const filteredRestaurants = filterProjectedRestaurantSearchRows(
        publicRestaurants,
        {
          query: searchTerm,
          userLat:
            typeof lat === "string" ? Number.parseFloat(lat) : undefined,
          userLng:
            typeof lng === "string" ? Number.parseFloat(lng) : undefined,
          radiusKm: Number.parseFloat(String(radius || "10")),
        },
      );

      // Cap results so broad queries cannot dump the full inventory over the wire
      // (Aug 2026 search 502 cluster: large/slow Facebook in-app responses).
      const bounded = clampArrayToMaxBytes(
        filteredRestaurants.slice(0, RESTAURANT_SEARCH_RESULT_LIMIT),
        RESTAURANT_SEARCH_RESULT_LIMIT,
        MAX_SEARCH_RESPONSE_BYTES,
        (items) => items,
      );
      if (bounded.truncated) {
        res.setHeader("X-MealScout-Search-Truncated", "1");
        res.setHeader("X-MealScout-Search-Bytes", String(bounded.bytes));
      }
      res.json(bounded.value);
    } catch (error) {
      console.error("Error searching restaurants:", error);
      res.status(500).json({ message: "Failed to search restaurants" });
    }
  });

  app.get("/api/restaurants/public", async (req, res) => {
    try {
      const {
        lat,
        lng,
        radius = 12,
        limit = 80,
      } = req.query as Record<string, string | undefined>;
      const parsedLimit = Math.max(
        1,
        Math.min(200, Number.parseInt(String(limit || "80"), 10) || 80),
      );
      const hasLocation = typeof lat === "string" && typeof lng === "string";
      const userLat = hasLocation ? Number.parseFloat(lat!) : Number.NaN;
      const userLng = hasLocation ? Number.parseFloat(lng!) : Number.NaN;
      const radiusKm = Math.max(
        1,
        Math.min(50, Number.parseFloat(String(radius || "12")) || 12),
      );

      const allRestaurants = (await storage.getAllRestaurants()).filter(
        (restaurant: any) => isPublicBusinessVisible(restaurant),
      );
      const activeRestaurants = allRestaurants.filter(
        (restaurant: any) => restaurant?.isActive,
      );
      // Visibility is an input to membership and distance, not just a final
      // response mask. Hidden/quarantined coordinates therefore cannot make a
      // restaurant appear in a proximity result.
      const publicActiveRestaurants =
        await toPublicRestaurantListingArrayWithVisibility(activeRestaurants);
      const restaurantIds = publicActiveRestaurants
        .map((restaurant: any) => String(restaurant?.id || "").trim())
        .filter(Boolean);
      const restaurantIdArraySql = postgresTextArray(restaurantIds);

      const safeQuery = async <T>(
        label: string,
        run: () => Promise<T>,
        fallback: T,
      ): Promise<T> => {
        try {
          return await run();
        } catch (error) {
          console.warn(`[restaurants/public] ${label} query failed`, error);
          return fallback;
        }
      };

      const [
        favoriteRows,
        followRows,
        recommendationRows,
        activeDealRows,
        videoRecommendationRows,
        recommendationReactionRows,
        recommendationShareRows,
        videoEngagementRows,
      ] =
        restaurantIds.length > 0
          ? await Promise.all([
              safeQuery(
                "favorites",
                () =>
                  db
                    .select({
                      restaurantId: restaurantFavorites.restaurantId,
                      count: sql<number>`cast(count(*) as integer)`,
                    })
                    .from(restaurantFavorites)
                    .where(
                      inArray(restaurantFavorites.restaurantId, restaurantIds),
                    )
                    .groupBy(restaurantFavorites.restaurantId),
                [],
              ),
              safeQuery(
                "follows",
                () =>
                  db
                    .select({
                      restaurantId: restaurantFollows.restaurantId,
                      count: sql<number>`cast(count(*) as integer)`,
                    })
                    .from(restaurantFollows)
                    .where(
                      inArray(restaurantFollows.restaurantId, restaurantIds),
                    )
                    .groupBy(restaurantFollows.restaurantId),
                [],
              ),
              safeQuery(
                "recommendations",
                () =>
                  db
                    .select({
                      restaurantId: restaurantUserRecommendations.restaurantId,
                      count: sql<number>`cast(count(*) as integer)`,
                    })
                    .from(restaurantUserRecommendations)
                    .where(
                      inArray(
                        restaurantUserRecommendations.restaurantId,
                        restaurantIds,
                      ),
                    )
                    .groupBy(restaurantUserRecommendations.restaurantId),
                [],
              ),
              safeQuery(
                "active-deals",
                () =>
                  db
                    .select({
                      restaurantId: deals.restaurantId,
                      count: sql<number>`cast(count(*) as integer)`,
                    })
                    .from(deals)
                    .where(
                      and(
                        eq(deals.isActive, true),
                        inArray(deals.restaurantId, restaurantIds),
                        or(isNull(deals.startDate), lte(deals.startDate, sql`NOW()`)),
                        or(isNull(deals.endDate), gte(deals.endDate, sql`NOW()`)),
                      ),
                    )
                    .groupBy(deals.restaurantId),
                [],
              ),
              safeQuery(
                "video-recommendations",
                () =>
                  db
                    .select({
                      restaurantId: videoStories.restaurantId,
                      count: sql<number>`cast(count(*) as integer)`,
                    })
                    .from(videoStories)
                    .innerJoin(users, eq(videoStories.userId, users.id))
                    .where(
                      and(
                        inArray(videoStories.restaurantId, restaurantIds),
                        publicStoryPublicationWhere(sql`NOW()`),
                        eq(users.isDisabled, false),
                      ),
                    )
                    .groupBy(videoStories.restaurantId),
                [],
              ),
              safeQuery(
                "recommendation-reactions",
                () =>
                  db.execute(sql<{
                    restaurant_id: string;
                    score: number;
                  }>`
                    select
                      rur.restaurant_id,
                      cast(sum(case rr.reaction_type when 'like' then 1 when 'dislike' then -1 else 0 end) as integer) as score
                    from recommendation_reactions rr
                    inner join restaurant_user_recommendations rur on rur.id = rr.recommendation_id
                    where rur.restaurant_id = any(${restaurantIdArraySql})
                    group by rur.restaurant_id
                  `),
                { rows: [] } as any,
              ),
              safeQuery(
                "recommendation-shares",
                () =>
                  db.execute(sql<{
                    restaurant_id: string;
                    count: number;
                  }>`
                    select
                      rur.restaurant_id,
                      cast(count(*) as integer) as count
                    from recommendation_shares rs
                    inner join restaurant_user_recommendations rur on rur.id = rs.recommendation_id
                    where rur.restaurant_id = any(${restaurantIdArraySql})
                    group by rur.restaurant_id
                  `),
                { rows: [] } as any,
              ),
              safeQuery(
                "video-engagement",
                () =>
                  db.execute(sql<{
                    restaurant_id: string;
                    score: number;
                  }>`
                    select
                      vs.restaurant_id,
                      cast(sum(coalesce(vs.like_count, 0) + coalesce(vs.comment_count, 0) + coalesce(vs.share_count, 0)) as integer) as score
                    from video_stories vs
                    inner join users vu on vu.id = vs.user_id
                    where
                      vs.restaurant_id = any(${restaurantIdArraySql})
                      and vs.status = 'ready'
                      and vs.is_approved = true
                      and vs.deleted_at is null
                      and vs.expires_at >= now()
                      and vu.is_disabled = false
                    group by vs.restaurant_id
                  `),
                { rows: [] } as any,
              ),
            ])
          : [[], [], [], [], [], { rows: [] }, { rows: [] }, { rows: [] }];

      const favoritesByRestaurant = new Map(
        favoriteRows.map((row: any) => [
          String(row.restaurantId),
          Number(row.count) || 0,
        ]),
      );
      const followsByRestaurant = new Map(
        followRows.map((row: any) => [
          String(row.restaurantId),
          Number(row.count) || 0,
        ]),
      );
      const recommendationsByRestaurant = new Map(
        recommendationRows.map((row: any) => [
          String(row.restaurantId),
          Number(row.count) || 0,
        ]),
      );
      const activeDealsByRestaurant = new Map(
        activeDealRows.map((row: any) => [
          String(row.restaurantId),
          Number(row.count) || 0,
        ]),
      );
      const videoRecommendationsByRestaurant = new Map(
        videoRecommendationRows.map((row: any) => [
          String(row.restaurantId),
          Number(row.count) || 0,
        ]),
      );
      const reactionByRestaurant = new Map(
        ((recommendationReactionRows as any)?.rows || []).map((row: any) => [
          String(row.restaurant_id || ""),
          Number(row.score) || 0,
        ]),
      );
      const sharesByRestaurant = new Map(
        ((recommendationShareRows as any)?.rows || []).map((row: any) => [
          String(row.restaurant_id || ""),
          Number(row.count) || 0,
        ]),
      );
      const videoEngagementByRestaurant = new Map(
        ((videoEngagementRows as any)?.rows || []).map((row: any) => [
          String(row.restaurant_id || ""),
          Number(row.score) || 0,
        ]),
      );

      const attachTrustSignals = (restaurant: any, distance: number | null) => {
        const restaurantId = String(restaurant.id || "");
        const favoriteCount = favoritesByRestaurant.get(restaurantId) || 0;
        const followCount = followsByRestaurant.get(restaurantId) || 0;
        const recommendationCount =
          recommendationsByRestaurant.get(restaurantId) || 0;
        const videoRecommendationCount =
          videoRecommendationsByRestaurant.get(restaurantId) || 0;
        const activeDealCount = activeDealsByRestaurant.get(restaurantId) || 0;
        const communityActivityCount =
          Number(reactionByRestaurant.get(restaurantId) || 0) +
          Number(sharesByRestaurant.get(restaurantId) || 0) +
          Number(videoEngagementByRestaurant.get(restaurantId) || 0);
        const hasDistance =
          typeof distance === "number" && Number.isFinite(distance);
        const locationBoost = hasDistance
          ? Math.max(0, 1 - Math.min(distance, radiusKm) / radiusKm)
          : 0;
        const homeRankingScore = computeHomeRankingScore({
          recommendationCount,
          videoRecommendationCount,
          followCount,
          favoriteCount,
          activeDealCount,
          locationBoost,
          liveTruckBoost: 0,
          communityActivityCount,
        });

        return {
          ...restaurant,
          distance,
          favoriteCount,
          followCount,
          recommendationCount,
          videoRecommendationCount,
          communityActivityCount,
          activeDealCount,
          homeRankingScore,
          homeRankingReason: getHomeRankingReasons({
            recommendationCount,
            videoRecommendationCount,
            followCount,
            favoriteCount,
            activeDealCount,
            hasLocationBoost: locationBoost > 0,
          }),
        };
      };

      const withDistance = publicActiveRestaurants
        .map((restaurant: any) => {
          if (!hasLocation || Number.isNaN(userLat) || Number.isNaN(userLng)) {
            return attachTrustSignals(restaurant, null);
          }

          const distanceKm = publicRestaurantDistanceKm(
            restaurant,
            userLat,
            userLng,
          );
          if (
            distanceKm === null ||
            !Number.isFinite(distanceKm) ||
            distanceKm > radiusKm
          )
            return null;

          return attachTrustSignals(restaurant, distanceKm * 0.621371);
        })
        .filter(Boolean) as Array<any>;

      const sorted = withDistance.sort((a: any, b: any) => {
        const aScore =
          typeof a.homeRankingScore === "number" &&
          Number.isFinite(a.homeRankingScore)
            ? a.homeRankingScore
            : 0;
        const bScore =
          typeof b.homeRankingScore === "number" &&
          Number.isFinite(b.homeRankingScore)
            ? b.homeRankingScore
            : 0;
        if (aScore !== bScore) return bScore - aScore;

        const aDistance =
          typeof a.distance === "number" && Number.isFinite(a.distance)
            ? a.distance
            : Number.POSITIVE_INFINITY;
        const bDistance =
          typeof b.distance === "number" && Number.isFinite(b.distance)
            ? b.distance
            : Number.POSITIVE_INFINITY;
        if (aDistance !== bDistance) return aDistance - bDistance;

        const aUpdated = new Date(a.updatedAt || 0).getTime();
        const bUpdated = new Date(b.updatedAt || 0).getTime();
        return bUpdated - aUpdated;
      });

      res.json(sorted.slice(0, parsedLimit));
    } catch (error) {
      console.error("Error fetching public restaurants:", error);
      res.status(500).json({ message: "Failed to fetch public restaurants" });
    }
  });

  app.get("/api/restaurants/:id", async (req, res) => {
    try {
      const restaurant = await storage.getRestaurant(req.params.id);
      if (
        !restaurant ||
        restaurant.isActive !== true ||
        !isPublicBusinessVisible(restaurant)
      ) {
        return res.status(404).json({ message: "Restaurant not found" });
      }
      const publicRestaurant =
        await toPublicRestaurantListingWithVisibility(restaurant);
      if (
        !(publicRestaurant as any)?.id ||
        deriveProfileEvidenceQuarantineVisibility(restaurant).isQuarantined
      ) {
        return res.status(404).json({ message: "Restaurant not found" });
      }
      res.json(publicRestaurant);
    } catch (error) {
      console.error("Error fetching restaurant:", error);
      res.status(500).json({ message: "Failed to fetch restaurant" });
    }
  });

  app.post("/api/restaurants/:restaurantId/message", async (req: any, res) => {
    try {
      const { restaurantId } = req.params;
      const userId = req.user?.id || null;
      const rawGuestEmail = String(req.body?.email || "").trim();
      const rawGuestName = String(req.body?.name || "").trim();
      const senderKey = userId || rawGuestEmail || req.ip || "anonymous";
      const actionGate = consumeEngagementWindow(
        `${senderKey}:${restaurantId}:business-message`,
      );
      if (!actionGate.allowed) {
        return res.status(429).json({
          message: "Please wait a moment before sending another message.",
          retryAfterSeconds: actionGate.retryAfterSeconds,
        });
      }

      const restaurant = await storage.getRestaurant(restaurantId);
      if (
        !restaurant ||
        restaurant.isActive !== true ||
        !isPublicBusinessVisible(restaurant) ||
        deriveProfileEvidenceQuarantineVisibility(restaurant).isQuarantined
      ) {
        return res.status(404).json({ message: "Business not found" });
      }

      const publicRestaurant =
        await toPublicRestaurantListingWithVisibility(restaurant);
      if (!(publicRestaurant as any)?.id) {
        return res.status(404).json({ message: "Business not found" });
      }

      const owner = await storage.getUser(restaurant.ownerId);
      if (!owner?.email || owner.isDisabled !== false) {
        return res
          .status(400)
          .json({ message: "This business is not accepting messages yet" });
      }

      const sender = userId ? await storage.getUser(userId) : null;
      const senderEmail = String(sender?.email || req.user?.email || "").trim();
      const replyEmail = senderEmail || rawGuestEmail;
      const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyEmail);
      if (!replyEmail || !emailLooksValid) {
        return res.status(400).json({
          message: "Enter a valid reply email before messaging this business",
        });
      }
      if (!sender && rawGuestName.length < 2) {
        return res.status(400).json({
          message: "Enter your name before messaging this business",
        });
      }

      const topic = String(req.body?.topic || "Question")
        .trim()
        .slice(0, 60);
      const preferredReply =
        String(req.body?.preferredReply || "email") === "phone"
          ? "phone"
          : "email";
      const phone = String(req.body?.phone || "")
        .trim()
        .slice(0, 40);
      if (preferredReply === "phone" && phone.length < 7) {
        return res.status(400).json({
          message: "Enter a callback number or choose email reply",
        });
      }
      const message = String(req.body?.message || "").trim();
      if (message.length < 10 || message.length > 2000) {
        return res.status(400).json({
          message: "Message must be between 10 and 2000 characters",
        });
      }

      const senderName =
        [sender?.firstName, sender?.lastName].filter(Boolean).join(" ") ||
        req.user?.name ||
        rawGuestName ||
        "A MealScout user";
      const businessName = restaurant.name || "your business";
      const conversationId = crypto.randomUUID();
      const baseUrl = String(
        process.env.PUBLIC_BASE_URL || "http://localhost:5000",
      ).replace(/\/+$/, "");
      const dashboardUrl = `${baseUrl}/restaurant-owner-dashboard`;
      const trackedDashboardUrl = `${baseUrl}/api/restaurants/messages/${conversationId}/open?restaurantId=${encodeURIComponent(restaurantId)}`;
      const safeBusinessName = escapeHtml(businessName);
      const safeSenderName = escapeHtml(senderName);
      const safeSenderEmail = escapeHtml(replyEmail);
      const safePhone = escapeHtml(phone);
      const safeTopic = escapeHtml(topic || "General question");
      const replyLine =
        preferredReply === "phone" && phone
          ? `<p><strong>Preferred reply:</strong> Call/text ${safePhone}</p><p><strong>Backup email:</strong> ${safeSenderEmail}</p>`
          : `<p><strong>Reply directly to:</strong> ${safeSenderEmail}</p>`;
      const textReplyLine =
        preferredReply === "phone" && phone
          ? `Preferred reply: Call/text ${phone}\nBackup email: ${replyEmail}`
          : `Reply directly to: ${replyEmail}`;
      const subjectTopic = topic || "Question";
      const html = `
          <p><strong>${safeSenderName}</strong> contacted <strong>${safeBusinessName}</strong> from MealScout.</p>
          <p><strong>Topic:</strong> ${safeTopic}</p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;" />
          ${messageBodyToHtml(message)}
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;" />
          ${replyLine}
          <p style="color:#6b7280;font-size:13px;">MealScout shared this email address because the user chose to contact your business. No live location data, payment details, or private preference data was included.</p>
          <p><a href="${trackedDashboardUrl}">Open your MealScout dashboard</a></p>
        `;
      const text = `${senderName} contacted ${businessName} from MealScout.\n\nTopic: ${subjectTopic}\n\n${message}\n\n${textReplyLine}\n\nMealScout shared this reply info because the user chose to contact your business. No live location data, payment details, or private preference data was included.\n\nDashboard: ${trackedDashboardUrl}`;

      const notificationResult = await notifyUser({
        user: owner,
        topic: "businessMessages",
        title: `MealScout ${subjectTopic}: ${businessName}`,
        body: `${senderName} sent ${businessName} a MealScout message.`,
        actionUrl: `/api/restaurants/messages/${conversationId}/open?restaurantId=${encodeURIComponent(restaurantId)}`,
        priority: "high",
        sourceType: "business_message",
        sourceId: conversationId,
        actorUserId: userId,
        channels: ["in_app", "email", "sms"],
        emailHtml: html,
        emailText: text,
        smsText: `MealScout: ${senderName} sent ${businessName} a message. Open your dashboard to respond.`,
        metadata: {
          conversationId,
          restaurantId,
          restaurantOwnerId: restaurant.ownerId,
          topic,
          preferredReply,
          senderKind: userId ? "registered_user" : "guest",
          hasReplyEmail: Boolean(replyEmail),
          hasPhone: Boolean(phone),
          messageLength: message.length,
          source: "restaurant_profile",
        },
      });
      const notificationChannels = notificationResult.channels || {};
      const ok =
        notificationChannels.email === "sent" ||
        notificationChannels.in_app === "created" ||
        notificationChannels.sms === "sent";

      await trackBusinessConversationEvent(
        "business_contact_intent_sent",
        {
          conversationId,
          restaurantId,
          restaurantOwnerId: restaurant.ownerId,
          topic,
          preferredReply,
          senderKind: userId ? "registered_user" : "guest",
          hasReplyEmail: Boolean(replyEmail),
          hasPhone: Boolean(phone),
          messageLength: message.length,
          delivered: ok,
          notificationId: notificationResult.notificationId,
          notificationChannels,
          source: "restaurant_profile",
        },
        userId,
      );

      if (userId) {
        await trackEngagement(
          "restaurant_user_message_sent",
          userId,
          restaurantId,
          {
            conversationId,
            topic,
            preferredReply,
            delivered: ok,
          },
        );
      }

      res.json({ success: ok, conversationId });
    } catch (error: any) {
      console.error("Error sending business message:", error);
      res.status(500).json({
        message: error?.message || "Failed to send message",
      });
    }
  });

  app.get(
    "/api/restaurants/messages/:conversationId/open",
    async (req: any, res) => {
      const conversationId = String(req.params.conversationId || "").trim();
      const restaurantId = String(req.query.restaurantId || "").trim();
      const baseUrl = String(
        process.env.PUBLIC_BASE_URL || "http://localhost:5000",
      ).replace(/\/+$/, "");

      if (conversationId) {
        const restaurant = restaurantId
          ? await storage.getRestaurant(restaurantId).catch(() => null)
          : null;
        await trackBusinessConversationEvent(
          "business_contact_owner_return_opened",
          {
            conversationId,
            restaurantId: restaurantId || null,
            restaurantOwnerId: restaurant?.ownerId || null,
            source: "business_contact_email",
            userAgent: String(req.headers["user-agent"] || "").slice(0, 240),
          },
          req.user?.id || null,
        );
      }

      res.redirect(`${baseUrl}/restaurant-owner-dashboard`);
    },
  );

  app.get("/api/restaurants/nearby/:lat/:lng", async (req, res) => {
    try {
      const lat = parseFloat(req.params.lat);
      const lng = parseFloat(req.params.lng);
      const radius = parseFloat(req.query.radius as string) || 5;
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        lat < -90 ||
        lat > 90 ||
        lng < -180 ||
        lng > 180 ||
        !Number.isFinite(radius) ||
        radius <= 0
      ) {
        return res.status(400).json({ message: "Invalid coordinates or radius" });
      }

      const projectedRestaurants =
        await toPublicRestaurantListingArrayWithVisibility(
          await storage.getAllRestaurants(),
        );
      res.json(
        filterProjectedPublicNearbyRestaurantRows(projectedRestaurants, {
          userLat: lat,
          userLng: lng,
          radiusKm: radius,
        }),
      );
    } catch (error) {
      console.error("Error fetching nearby restaurants:", error);
      res.status(500).json({ message: "Failed to fetch nearby restaurants" });
    }
  });

  // Follow is no longer a separate manual action on restaurant cards -
  // favoriting or recommending a restaurant implies wanting updates from it.
  // Best-effort: a follow failure should never block the favorite/recommend
  // response, and an existing follow (23505) is not an error here.
  async function autoFollowRestaurant(userId: string, restaurantId: string) {
    try {
      const followData = insertRestaurantFollowSchema.parse({
        restaurantId,
        userId,
      });
      await storage.createRestaurantFollow(followData);
      void trackEngagement("restaurant_follow_added", userId, restaurantId);
    } catch (error: unknown) {
      // Already followed (IDX_restaurant_follows_unique) — silent success.
      // Drizzle wraps pg unique violations as DrizzleQueryError with cause.code.
      if (!isUniqueViolation(error)) {
        console.error("Error auto-following restaurant:", error);
      }
    }
  }

  app.post(
    "/api/restaurants/:restaurantId/favorite",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const userId = req.user.id;
        const maxFavorites = 3;
        const actionGate = consumeEngagementWindow(
          `${userId}:${restaurantId}:favorite:add`,
        );
        if (!actionGate.allowed) {
          return res.status(429).json({
            message: "Please wait a moment before trying again.",
            retryAfterSeconds: actionGate.retryAfterSeconds,
          });
        }

        const restaurant = await storage.getRestaurant(restaurantId);
        if (!restaurant) {
          return res.status(404).json({ message: "Restaurant not found" });
        }

        const favoriteCount =
          await storage.getUserRestaurantFavoritesCount(userId);
        if (favoriteCount >= maxFavorites) {
          return res.status(400).json({
            message: `You can favorite up to ${maxFavorites} restaurants.`,
          });
        }

        const favoriteData = insertRestaurantFavoriteSchema.parse({
          restaurantId,
          userId,
        });

        const favorite = await storage.createRestaurantFavorite(favoriteData);
        void trackEngagement("restaurant_favorite_added", userId, restaurantId);
        await autoFollowRestaurant(userId, restaurantId);
        res.json(favorite);
      } catch (error: any) {
        if (isUniqueViolation(error)) {
          void trackEngagement(
            "restaurant_favorite_duplicate",
            req.user?.id,
            req.params?.restaurantId,
          );
          return res.status(200).json({
            success: true,
            alreadyExists: true,
            message: "Restaurant already favorited",
          });
        }
        console.error("Error adding restaurant favorite:", error);
        res
          .status(400)
          .json({ message: error.message || "Failed to add favorite" });
      }
    },
  );

  app.delete(
    "/api/restaurants/:restaurantId/favorite",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const userId = req.user.id;
        const actionGate = consumeEngagementWindow(
          `${userId}:${restaurantId}:favorite:remove`,
        );
        if (!actionGate.allowed) {
          return res.status(429).json({
            message: "Please wait a moment before trying again.",
            retryAfterSeconds: actionGate.retryAfterSeconds,
          });
        }

        await storage.removeRestaurantFavorite(restaurantId, userId);
        void trackEngagement(
          "restaurant_favorite_removed",
          userId,
          restaurantId,
        );
        res.json({ success: true });
      } catch (error) {
        console.error("Error removing restaurant favorite:", error);
        res.status(500).json({ message: "Failed to remove favorite" });
      }
    },
  );

  app.get(
    "/api/favorites/restaurants",
    isAuthenticated,
    async (req: any, res) => {
      res.setHeader("Cache-Control", "private, no-store");
      try {
        const userId = req.user.id;
        const favorites = await storage.getUserRestaurantFavorites(userId);
        // Saving is not consent to reveal an owner's private profile fields.
        // Apply the same visibility and allowlist as public discovery before
        // returning the nested business to this non-owner consumer screen.
        const eligible = favorites.filter((favorite: any) =>
          favorite.restaurant?.isActive === true &&
          isPublicBusinessVisible(favorite.restaurant) &&
          !deriveProfileEvidenceQuarantineVisibility(favorite.restaurant).isQuarantined,
        );
        const publicRestaurants = await toPublicRestaurantListingArrayWithVisibility(
          eligible.map((favorite: any) => favorite.restaurant),
        );
        const publicById = new Map(publicRestaurants.map((restaurant: any) => [restaurant.id, restaurant]));
        res.json(eligible.flatMap((favorite: any) => {
          const restaurant = publicById.get(favorite.restaurantId);
          return restaurant ? [{ id: favorite.id, restaurantId: favorite.restaurantId, favoritedAt: favorite.favoritedAt, createdAt: favorite.createdAt, restaurant }] : [];
        }));
      } catch (error) {
        console.error("Error fetching user restaurant favorites:", error);
        res.status(500).json({ message: "Failed to fetch favorites" });
      }
    },
  );

  app.post(
    "/api/restaurants/:restaurantId/follow",
    isAuthenticated,
    async (req: any, res) => {
      let followRestaurant: any = null;
      const followActionObservedAt = new Date().toISOString();
      try {
        const { restaurantId } = req.params;
        const userId = req.user.id;
        const actionGate = consumeEngagementWindow(
          `${userId}:${restaurantId}:follow:add`,
        );
        if (!actionGate.allowed) {
          return res.status(429).json({
            message: "Please wait a moment before trying again.",
            retryAfterSeconds: actionGate.retryAfterSeconds,
          });
        }

        const restaurant = await storage.getRestaurant(restaurantId);
        followRestaurant = restaurant;
        if (!restaurant) {
          return res.status(404).json({ message: "Restaurant not found" });
        }

        const followData = insertRestaurantFollowSchema.parse({
          restaurantId,
          userId,
        });

        const follow = await storage.createRestaurantFollow(followData);
        void trackEngagement("restaurant_follow_added", userId, restaurantId);
        await recordVerifiedFollowDiscoveryOutcome({
          req,
          restaurantId,
          userId,
          restaurantName: String(restaurant.name || "Restaurant"),
          entityType: restaurant.isFoodTruck ? "truck" : "restaurant",
          actionObservedAt: followActionObservedAt,
        });
        res.json(follow);
      } catch (error: any) {
        if (isUniqueViolation(error)) {
          void trackEngagement(
            "restaurant_follow_duplicate",
            req.user?.id,
            req.params?.restaurantId,
          );
          if (followRestaurant) {
            await recordVerifiedFollowDiscoveryOutcome({
              req,
              restaurantId: String(req.params.restaurantId),
              userId: String(req.user?.id || ""),
              restaurantName: String(followRestaurant.name || "Restaurant"),
              entityType: followRestaurant.isFoodTruck ? "truck" : "restaurant",
              alreadyExists: true,
              actionObservedAt: followActionObservedAt,
            });
          }
          return res.status(200).json({
            success: true,
            alreadyExists: true,
            message: "Restaurant already followed",
          });
        }
        console.error("Error adding restaurant follow:", error);
        res
          .status(400)
          .json({ message: error.message || "Failed to follow restaurant" });
      }
    },
  );

  app.delete(
    "/api/restaurants/:restaurantId/follow",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const userId = req.user.id;
        const actionGate = consumeEngagementWindow(
          `${userId}:${restaurantId}:follow:remove`,
        );
        if (!actionGate.allowed) {
          return res.status(429).json({
            message: "Please wait a moment before trying again.",
            retryAfterSeconds: actionGate.retryAfterSeconds,
          });
        }

        await storage.removeRestaurantFollow(restaurantId, userId);
        void trackEngagement("restaurant_follow_removed", userId, restaurantId);
        res.json({ success: true });
      } catch (error) {
        console.error("Error removing restaurant follow:", error);
        res.status(500).json({ message: "Failed to unfollow restaurant" });
      }
    },
  );

  app.get(
    "/api/following/restaurants",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const userId = req.user.id;
        const follows = await storage.getUserRestaurantFollows(userId);
        res.json(follows);
      } catch (error) {
        console.error("Error fetching user restaurant follows:", error);
        res.status(500).json({ message: "Failed to fetch follows" });
      }
    },
  );

  app.post(
    "/api/restaurants/:restaurantId/recommend",
    isAuthenticated,
    restaurantRecommendLimiter,
    imageUpload.single("image"),
    async (req: any, res) => {
      let uploadedProofPublicId: string | null = null;
      try {
        const { restaurantId } = req.params;
        const userId = req.user.id;

        const restaurant = await storage.getRestaurant(restaurantId);
        if (!restaurant) {
          return res.status(404).json({ message: "Restaurant not found" });
        }

        const body = req.body || {};
        const comment = String(body.comment || "").trim() || null;
        const scoresRaw =
          typeof body.scores === "string"
            ? JSON.parse(body.scores || "{}")
            : body.scores || {};

        const foodResult = parseQuickReviewScore(
          "food",
          scoresRaw.food,
          body.foodScore,
        );
        const valueResult = parseQuickReviewScore(
          "value",
          scoresRaw.value,
          body.valueScore,
        );
        const speedResult = parseQuickReviewScore(
          "speed",
          scoresRaw.speed,
          body.speedScore,
        );
        const vibeResult = parseQuickReviewScore(
          "vibe",
          scoresRaw.vibe,
          body.vibeScore,
        );

        const invalidScoreFields = [
          foodResult,
          valueResult,
          speedResult,
          vibeResult,
        ]
          .map((result) => result.error)
          .filter((error): error is string => Boolean(error));

        if (invalidScoreFields.length > 0) {
          return res.status(400).json({
            message: `Quick-review scores must be whole numbers from 1 to 100 (invalid: ${invalidScoreFields.join(", ")}).`,
          });
        }

        const scores = {
          food: foodResult.value,
          value: valueResult.value,
          speed: speedResult.value,
          vibe: vibeResult.value,
        };
        const scoreValues = Object.values(scores).filter(
          (value): value is number => value !== null,
        );
        const hasContext = Boolean(
          comment || scoreValues.length > 0 || req.file,
        );
        const contextPayloadFingerprint = hasContext
          ? buildQuickReviewContextFingerprint({
              comment,
              scores,
              proofBytes: req.file?.buffer || null,
            })
          : null;
        const recommendationData =
          insertRestaurantUserRecommendationSchema.parse({
            restaurantId,
            userId,
          });

        const outcome = await db.transaction(async (tx: any) => {
          // This database-scoped lock serializes the same user's request for
          // the same restaurant across every server replica. It turns retries
          // and concurrent submissions into the same durable operation.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${`${userId}:${restaurantId}:recommend`}))`,
          );

          const inserted = await tx
            .insert(restaurantUserRecommendations)
            .values(recommendationData)
            .onConflictDoNothing()
            .returning();
          const createdRecommendation = inserted.length > 0;
          const [recommendation] = createdRecommendation
            ? inserted
            : await tx
                .select()
                .from(restaurantUserRecommendations)
                .where(
                  and(
                    eq(
                      restaurantUserRecommendations.restaurantId,
                      restaurantId,
                    ),
                    eq(restaurantUserRecommendations.userId, userId),
                  ),
                )
                .limit(1);

          if (!recommendation) {
            throw new Error("Unable to create or load recommendation");
          }

          const contextDecision = decideQuickReviewContext({
            hasIncomingContext: hasContext,
            contextSubmittedAt: recommendation.contextSubmittedAt,
            storedFingerprint: recommendation.contextPayloadFingerprint,
            incomingFingerprint: contextPayloadFingerprint,
          });
          const contextAlreadySaved = Boolean(
            recommendation.contextSubmittedAt,
          );
          if (contextDecision === "conflict") {
            const error: any = new Error(
              "Quick review context was already submitted for this recommendation.",
            );
            error.statusCode = 409;
            throw error;
          }
          let createdContext = false;
          let proofPhoto: any = null;
          let contextReviewId = recommendation.contextReviewId ?? null;

          if (contextDecision === "create") {
            if (req.file) {
              if (!isCloudinaryConfigured()) {
                const error: any = new Error(
                  "Image upload service not configured",
                );
                error.statusCode = 503;
                throw error;
              }
              const proofToken = crypto
                .createHash("sha256")
                .update(`restaurant-recommendation-proof:${recommendation.id}`)
                .digest("hex")
                .slice(0, 24);
              const uploadResult = await uploadToCloudinary(
                req.file.buffer,
                "restaurant-recommendation-photos",
                `proof-${proofToken}`,
              );
              uploadedProofPublicId = uploadResult.publicId;
              const [createdUpload] = await tx
                .insert(imageUploads)
                .values({
                  uploadedByUserId: userId,
                  imageType: "restaurant_recommendation_photo",
                  entityId: recommendation.id,
                  entityType: "restaurant_recommendation",
                  cloudinaryPublicId: uploadResult.publicId,
                  cloudinaryUrl: uploadResult.secureUrl,
                  thumbnailUrl: uploadResult.thumbnailUrl,
                  width: uploadResult.width,
                  height: uploadResult.height,
                  fileSize: uploadResult.bytes,
                  mimeType: req.file.mimetype,
                } as any)
                .returning();
              proofPhoto = createdUpload;
            }

            if (comment || proofPhoto?.cloudinaryUrl) {
              const photoLine = proofPhoto?.cloudinaryUrl
                ? `Photo proof: ${proofPhoto.cloudinaryUrl}`
                : "";
              const reviewComment =
                [comment, photoLine].filter(Boolean).join("\n\n") ||
                "Photo proof added on MealScout.";
              const [createdReview] = await tx
                .insert(reviews)
                .values({
                  restaurantId,
                  userId,
                  rating: 0,
                  comment: reviewComment,
                })
                .returning({ id: reviews.id });
              contextReviewId = createdReview.id;
            }

            const nextScores = mergeQuickReviewScores(
              {
                food: recommendation.foodScore ?? null,
                value: recommendation.valueScore ?? null,
                speed: recommendation.speedScore ?? null,
                vibe: recommendation.vibeScore ?? null,
              },
              scores,
            );
            const contextSubmittedAt = new Date();
            await tx
              .update(restaurantUserRecommendations)
              .set({
                foodScore: nextScores.food,
                valueScore: nextScores.value,
                speedScore: nextScores.speed,
                vibeScore: nextScores.vibe,
                contextReviewId,
                contextSubmittedAt,
                contextPayloadFingerprint,
              })
              .where(eq(restaurantUserRecommendations.id, recommendation.id));
            recommendation.foodScore = nextScores.food;
            recommendation.valueScore = nextScores.value;
            recommendation.speedScore = nextScores.speed;
            recommendation.vibeScore = nextScores.vibe;
            recommendation.contextReviewId = contextReviewId;
            recommendation.contextSubmittedAt = contextSubmittedAt;
            recommendation.contextPayloadFingerprint =
              contextPayloadFingerprint;
            createdContext = true;
          }

          const influenceBump = createdRecommendation
            ? createdContext
              ? 3
              : 1
            : createdContext
              ? 2
              : 0;
          if (createdRecommendation || createdContext) {
            await tx
              .update(users)
              .set({
                recommendationCount: createdRecommendation
                  ? sql`${users.recommendationCount} + 1`
                  : users.recommendationCount,
                reviewCount: createdContext
                  ? sql`${users.reviewCount} + 1`
                  : users.reviewCount,
                influenceScore:
                  influenceBump > 0
                    ? sql`${users.influenceScore} + ${influenceBump}`
                    : users.influenceScore,
                updatedAt: new Date(),
              } as any)
              .where(eq(users.id, userId));
          }

          return {
            recommendation,
            createdRecommendation,
            createdContext,
            contextAlreadySaved,
            contextReplay: contextDecision === "replay",
            proofPhoto,
          };
        });
        // From this point forward the database transaction is committed, so a
        // later response-side error must not delete the persisted proof asset.
        uploadedProofPublicId = null;

        await autoFollowRestaurant(userId, restaurantId);

        if (outcome.createdContext) {
          void trackEngagement(
            "restaurant_recommend_context_added",
            userId,
            restaurantId,
          );
        } else if (outcome.createdRecommendation) {
          void trackEngagement(
            "restaurant_recommend_added",
            userId,
            restaurantId,
          );
        } else {
          void trackEngagement(
            "restaurant_recommend_duplicate",
            userId,
            restaurantId,
          );
        }

        const {
          contextPayloadFingerprint: _contextPayloadFingerprint,
          ...recommendationResponse
        } = outcome.recommendation;
        res.json({
          ...recommendationResponse,
          success: true,
          alreadyExists: !outcome.createdRecommendation,
          contextSaved:
            hasContext &&
            (outcome.createdContext || outcome.contextAlreadySaved),
          contextAlreadySaved: outcome.contextAlreadySaved,
          contextReplay: outcome.contextReplay,
          quickReview: outcome.recommendation.contextSubmittedAt
            ? {
                food: outcome.recommendation.foodScore ?? null,
                value: outcome.recommendation.valueScore ?? null,
                speed: outcome.recommendation.speedScore ?? null,
                vibe: outcome.recommendation.vibeScore ?? null,
              }
            : null,
          proofPhoto: outcome.proofPhoto,
        });
      } catch (error: any) {
        if (uploadedProofPublicId) {
          await deleteFromCloudinary(uploadedProofPublicId).catch(
            (cleanupError) => {
              console.warn(
                "Failed to clean up rolled-back recommendation proof:",
                cleanupError,
              );
            },
          );
        }
        console.error("Error adding restaurant recommendation:", error);
        if (error?.statusCode === 409 || error?.statusCode === 503) {
          return res.status(error.statusCode).json({ message: error.message });
        }
        res.status(400).json({
          message: error.message || "Failed to recommend restaurant",
        });
      }
    },
  );

  /**
   * PATCH /api/restaurants/:restaurantId/featured-item
   * Owner's manual pick for the one dish spotlighted on discovery cards.
   * Body: { menuItemId: string | null } - null clears the pick, falling
   * back to the automatic top-recommended-dish ranking.
   */
  app.patch(
    "/api/restaurants/:restaurantId/featured-item",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const userId = req.user.id;

        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          userId,
          "manageProfile",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: you can only set this for restaurants you own",
          });
        }

        const menuItemId =
          req.body?.menuItemId === null || req.body?.menuItemId === undefined
            ? null
            : String(req.body.menuItemId).trim() || null;

        if (menuItemId) {
          const [item] = await db
            .select({ id: menuItems.id, restaurantId: menuItems.restaurantId })
            .from(menuItems)
            .where(eq(menuItems.id, menuItemId))
            .limit(1);
          if (!item || item.restaurantId !== restaurantId) {
            return res.status(400).json({
              message: "That item doesn't belong to this restaurant.",
            });
          }
        }

        await db
          .update(restaurants)
          .set({ featuredMenuItemId: menuItemId, updatedAt: new Date() } as any)
          .where(eq(restaurants.id, restaurantId));

        res.json({ success: true, featuredMenuItemId: menuItemId });
      } catch (error: any) {
        console.error("Error setting featured item:", error);
        res.status(400).json({
          message: error.message || "Failed to set the featured item",
        });
      }
    },
  );

  app.get(
    "/api/recommendations/restaurants",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const userId = req.user.id;
        const recommendations =
          await storage.getUserRestaurantRecommendations(userId);
        res.json(recommendations);
      } catch (error) {
        console.error("Error fetching user restaurant recommendations:", error);
        res.status(500).json({ message: "Failed to fetch recommendations" });
      }
    },
  );

  app.get(
    "/api/restaurants/:restaurantId/recommendations/public",
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const restaurant = await storage.getRestaurant(restaurantId);
        const publicRestaurant = restaurant
          ? await toPublicRestaurantListingWithVisibility(restaurant)
          : null;
        if (
          !restaurant ||
          restaurant.isActive !== true ||
          !isPublicBusinessVisible(restaurant) ||
          !(publicRestaurant as any)?.id ||
          deriveProfileEvidenceQuarantineVisibility(restaurant).isQuarantined
        ) {
          return res.status(404).json({ message: "Restaurant not found" });
        }
        const viewerId = req.user?.id || null;
        const limit = Math.max(
          1,
          Math.min(
            50,
            Number.parseInt(String(req.query.limit || "12"), 10) || 12,
          ),
        );

        const rowsResult = await db.execute(sql<{
          id: string;
          user_id: string;
          created_at: Date;
          first_name: string | null;
          last_name: string | null;
          like_count: number;
          share_count: number;
          viewer_reaction: string | null;
          recommendation_comment: string | null;
          recommendation_photo_url: string | null;
          has_video_recommendation: boolean;
        }>`
          select
            rur.id,
            rur.user_id,
            rur.created_at,
            u.first_name,
            u.last_name,
            coalesce(sum(case rr.reaction_type when 'like' then 1 else 0 end), 0)::int as like_count,
            coalesce(count(distinct rs.id), 0)::int as share_count,
            max(case when rr.user_id = ${viewerId} then rr.reaction_type else null end) as viewer_reaction,
            (
              select rv.comment
              from reviews rv
              where rv.restaurant_id = rur.restaurant_id
                and rv.user_id = rur.user_id
                and rv.comment is not null
                and length(trim(rv.comment)) > 0
              order by rv.created_at desc
              limit 1
            ) as recommendation_comment,
            (
              select substring(rv.comment from '(https?://\\S+)')
              from reviews rv
              where rv.restaurant_id = rur.restaurant_id
                and rv.user_id = rur.user_id
                and rv.comment is not null
                and rv.comment ~* '(https?://\\S+)'
              order by rv.created_at desc
              limit 1
            ) as recommendation_photo_url,
            exists(
              select 1
              from video_stories vs
              inner join users story_user on story_user.id = vs.user_id
              where vs.restaurant_id = rur.restaurant_id
                and vs.user_id = rur.user_id
                and vs.status = 'ready'
                and vs.deleted_at is null
                and vs.is_approved = true
                and vs.expires_at >= now()
                and story_user.is_disabled = false
            ) as has_video_recommendation
          from restaurant_user_recommendations rur
          inner join users u on u.id = rur.user_id
          left join recommendation_reactions rr on rr.recommendation_id = rur.id
          left join recommendation_shares rs on rs.recommendation_id = rur.id
          where rur.restaurant_id = ${restaurantId}
            and u.is_disabled = false
          group by rur.id, rur.user_id, rur.created_at, u.first_name, u.last_name
          order by rur.created_at desc
          limit ${limit}
        `);

        const rows = Array.isArray((rowsResult as any).rows)
          ? (rowsResult as any).rows
          : [];
        const payload = rows.map((row: any) => ({
          id: String(row.id || ""),
          createdAt: row.created_at,
          authorName:
            String(
              [row.first_name, row.last_name].filter(Boolean).join(" ").trim(),
            ) || "Community Member",
          likeCount: Number(row.like_count) || 0,
          shareCount: Number(row.share_count) || 0,
          comment: String(row.recommendation_comment || "").trim() || null,
          photoUrl: String(row.recommendation_photo_url || "").trim() || null,
          hasVideoRecommendation: Boolean(row.has_video_recommendation),
          viewerReaction:
            row.viewer_reaction === "like" || row.viewer_reaction === "dislike"
              ? row.viewer_reaction
              : null,
        }));

        res.json(payload);
      } catch (error) {
        console.error("Error fetching public recommendations:", error);
        res.status(500).json({ message: "Failed to fetch recommendations" });
      }
    },
  );

  app.post(
    "/api/recommendations/:recommendationId/reaction",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const recommendationId = String(
          req.params.recommendationId || "",
        ).trim();
        const userId = String(req.user.id || "").trim();
        const reaction = String(req.body?.reaction || "")
          .trim()
          .toLowerCase();

        if (!recommendationId) {
          return res.status(400).json({ message: "Invalid recommendation id" });
        }
        if (!["like", "dislike", "clear"].includes(reaction)) {
          return res
            .status(400)
            .json({ message: "Reaction must be like, dislike, or clear" });
        }

        const existing = await db.execute(sql<{
          id: string;
          reaction_type: string;
        }>`
          select id, reaction_type
          from recommendation_reactions
          where recommendation_id = ${recommendationId} and user_id = ${userId}
          limit 1
        `);
        const existingRow = ((existing as any)?.rows || [])[0] as
          { id: string; reaction_type: string } | undefined;

        if (reaction === "clear") {
          await db.execute(sql`
            delete from recommendation_reactions
            where recommendation_id = ${recommendationId} and user_id = ${userId}
          `);
        } else if (!existingRow) {
          await db.execute(sql`
            insert into recommendation_reactions (recommendation_id, user_id, reaction_type)
            values (${recommendationId}, ${userId}, ${reaction})
          `);
        } else if (existingRow.reaction_type !== reaction) {
          await db.execute(sql`
            update recommendation_reactions
            set reaction_type = ${reaction}, updated_at = now()
            where recommendation_id = ${recommendationId} and user_id = ${userId}
          `);
        }

        const summaryResult = await db.execute(sql<{
          like_count: number;
          dislike_count: number;
        }>`
          select
            coalesce(sum(case reaction_type when 'like' then 1 else 0 end), 0)::int as like_count,
            coalesce(sum(case reaction_type when 'dislike' then 1 else 0 end), 0)::int as dislike_count
          from recommendation_reactions
          where recommendation_id = ${recommendationId}
        `);
        const summary = ((summaryResult as any)?.rows || [])[0] || {
          like_count: 0,
          dislike_count: 0,
        };

        res.json({
          success: true,
          reaction: reaction === "clear" ? null : reaction,
          likeCount: Number(summary.like_count) || 0,
        });
      } catch (error) {
        console.error("Error reacting to recommendation:", error);
        res.status(500).json({ message: "Failed to save reaction" });
      }
    },
  );

  app.post(
    "/api/recommendations/:recommendationId/share",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const recommendationId = String(
          req.params.recommendationId || "",
        ).trim();
        const userId = String(req.user.id || "").trim();
        if (!recommendationId) {
          return res.status(400).json({ message: "Invalid recommendation id" });
        }

        await db.execute(sql`
          insert into recommendation_shares (recommendation_id, user_id)
          values (${recommendationId}, ${userId})
        `);

        const shareCountResult = await db.execute(sql<{ share_count: number }>`
          select coalesce(count(*), 0)::int as share_count
          from recommendation_shares
          where recommendation_id = ${recommendationId}
        `);
        const shareCount = Number(
          ((shareCountResult as any)?.rows || [])[0]?.share_count || 0,
        );

        res.json({ success: true, shareCount });
      } catch (error) {
        console.error("Error sharing recommendation:", error);
        res.status(500).json({ message: "Failed to save share" });
      }
    },
  );

  app.get(
    "/api/restaurants/:restaurantId/analytics/favorites",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const userId = req.user.id;

        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          userId,
          "viewAnalytics",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only access analytics for restaurants you own",
          });
        }

        const analyticsAccess = await validateProfileAnalyticsAccess(userId);
        if (!analyticsAccess.hasAccess) {
          return res.status(402).json({
            message: analyticsAccess.error,
            subscriptionTier: analyticsAccess.subscriptionTier,
          });
        }

        const { startDate, endDate } = req.query;
        let dateRange: { start: Date; end: Date } | undefined;
        if (startDate && endDate) {
          dateRange = {
            start: new Date(startDate as string),
            end: new Date(endDate as string),
          };
        }

        const favoritesAnalytics =
          await storage.getRestaurantFavoritesAnalytics(
            restaurantId,
            dateRange,
          );
        res.json(favoritesAnalytics);
      } catch (error) {
        console.error("Error fetching favorites analytics:", error);
        res
          .status(500)
          .json({ message: "Failed to fetch favorites analytics" });
      }
    },
  );

  app.get(
    "/api/restaurants/:restaurantId/analytics/recommendations",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const userId = req.user.id;

        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          userId,
          "viewAnalytics",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only access analytics for restaurants you own",
          });
        }

        const analyticsAccess = await validateProfileAnalyticsAccess(userId);
        if (!analyticsAccess.hasAccess) {
          return res.status(402).json({
            message: analyticsAccess.error,
            subscriptionTier: analyticsAccess.subscriptionTier,
          });
        }

        const { startDate, endDate } = req.query;
        let dateRange: { start: Date; end: Date } | undefined;
        if (startDate && endDate) {
          dateRange = {
            start: new Date(startDate as string),
            end: new Date(endDate as string),
          };
        }

        const recommendationsAnalytics =
          await storage.getRestaurantRecommendationsAnalytics(
            restaurantId,
            dateRange,
          );
        res.json(recommendationsAnalytics);
      } catch (error) {
        console.error("Error fetching recommendations analytics:", error);
        res
          .status(500)
          .json({ message: "Failed to fetch recommendations analytics" });
      }
    },
  );

  app.post(
    "/api/restaurants/:restaurantId/recommendation/click",
    async (req: any, res) => {
      try {
        const { recommendationId } = req.body;

        if (recommendationId) {
          await storage.markRecommendationClicked(recommendationId);
        }

        res.json({ success: true });
      } catch (error) {
        console.error("Error tracking recommendation click:", error);
        res
          .status(500)
          .json({ message: "Failed to track recommendation click" });
      }
    },
  );

  app.post(
    "/api/restaurants/:id/verification/request",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const restaurantId = req.params.id;
        const userId = req.user.id;

        const restaurant = await storage.getRestaurant(restaurantId);
        if (!restaurant || restaurant.ownerId !== userId) {
          return res.status(403).json({ message: "Unauthorized" });
        }

        if (restaurant.claimedFromImportId) {
          const [listing] = await db
            .select({
              externalId: truckImportListings.externalId,
            })
            .from(truckImportListings)
            .where(eq(truckImportListings.id, restaurant.claimedFromImportId))
            .limit(1);
          const expected = String(listing?.externalId || "").trim();
          if (expected) {
            const provided = String(req.body?.licenseNumber || "").trim();
            if (!provided) {
              return res.status(400).json({
                message: "License number is required for imported food trucks.",
              });
            }
            if (provided.toLowerCase() !== expected.toLowerCase()) {
              return res.status(400).json({
                message:
                  "License number does not match the registry record for this truck.",
              });
            }
          }
        }

        const verificationData = insertVerificationRequestSchema.parse({
          ...req.body,
          restaurantId,
        });
        const normalizedDocuments = Array.isArray(verificationData.documents)
          ? verificationData.documents
              .map((doc) => (typeof doc === "string" ? doc.trim() : ""))
              .filter((doc) => doc.length > 0)
          : [];
        if (normalizedDocuments.length === 0) {
          return res.status(400).json({
            message:
              "Please upload at least one verification document before submitting.",
          });
        }
        verificationData.documents = normalizedDocuments;

        const documentValidation = validateDocuments(
          verificationData.documents,
        );
        if (!documentValidation.valid) {
          return res.status(400).json({
            message: "Document validation failed",
            errors: documentValidation.errors,
          });
        }

        const [pendingRequest] = await db
          .select({
            id: verificationRequests.id,
            documents: verificationRequests.documents,
          })
          .from(verificationRequests)
          .where(
            and(
              eq(verificationRequests.restaurantId, restaurantId),
              eq(verificationRequests.status, "pending"),
            ),
          )
          .limit(1);

        if (pendingRequest) {
          const mergedDocuments = Array.from(
            new Set(
              [
                ...(Array.isArray(pendingRequest.documents)
                  ? pendingRequest.documents
                  : []),
                ...verificationData.documents,
              ]
                .map((doc) => String(doc || "").trim())
                .filter(Boolean),
            ),
          );

          const [updatedRequest] = await db
            .update(verificationRequests)
            .set({
              documents: mergedDocuments,
              licenseNumber:
                String(req.body?.licenseNumber || "").trim() || null,
              submittedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(verificationRequests.id, pendingRequest.id))
            .returning();

          return res.json(updatedRequest);
        }

        const rateLimit = checkRateLimit(restaurantId);
        if (!rateLimit.allowed) {
          return res.status(429).json({
            message:
              "Rate limit exceeded. Only one verification request per restaurant per hour is allowed.",
            nextAllowedTime: rateLimit.nextAllowedTime,
          });
        }

        const verificationRequest =
          await storage.createVerificationRequest(verificationData);
        res.json(verificationRequest);
      } catch (error: any) {
        console.error("Error creating verification request:", error);
        res.status(400).json({
          message: error.message || "Failed to create verification request",
        });
      }
    },
  );

  app.get(
    "/api/restaurants/my/verifications",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const userId = req.user.id;
        const verifications =
          await storage.getVerificationRequestsByOwner(userId);
        res.json(verifications);
      } catch (error) {
        console.error("Error fetching verification requests:", error);
        res
          .status(500)
          .json({ message: "Failed to fetch verification requests" });
      }
    },
  );
}
