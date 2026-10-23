import type { Express } from "express";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db";
import { storage } from "../storage";
import { isAuthenticated } from "../unifiedAuth";
import {
  insertReviewSchema,
  users,
} from "@shared/schema";
import { toPublicRestaurantReviewArray } from "../publicProfiles/toPublicRestaurantReview";
import { projectPublicDealRows } from "../services/publicDealProjection";
import { toPublicRestaurantListingWithVisibility } from "../publicProfiles/toPublicRestaurantListingWithVisibility";
import { deriveProfileEvidenceQuarantineVisibility } from "../services/profileEvidenceQuarantine";
import { isPublicBusinessVisible } from "../utils/publicBusinessVisibility";

type DealDiscoveryRouteDependencies = {
  filterDealsByBusinessAccess: <T extends { restaurantId?: string | null }>(
    dealRows: T[],
  ) => Promise<T[]>;
  hasCompleteProfileAccess: (userId: string) => Promise<boolean>;
};

export function registerDealDiscoveryRoutes(
  app: Express,
  {
    filterDealsByBusinessAccess,
    hasCompleteProfileAccess,
  }: DealDiscoveryRouteDependencies,
) {
  const projectAccessibleDeals = async (
    dealRows: any[],
    options: { userLat?: number; userLng?: number; radiusKm?: number } = {},
  ) =>
    projectPublicDealRows(
      await filterDealsByBusinessAccess(dealRows as any[]),
      options,
    );

  app.get("/api/deals/active", async (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const activeDeals = await storage.getActiveDeals();
      res.json(await projectAccessibleDeals(activeDeals as any[]));
    } catch (error) {
      console.error("Error fetching active deals:", error);
      res.status(500).json({ message: "Failed to fetch deals" });
    }
  });

  app.get("/api/deals/my-active", isAuthenticated, async (req: any, res) => {
    try {
      const restaurantsByOwner = await storage.getRestaurantsByOwner(req.user.id);
      const allDeals = await Promise.all(
        restaurantsByOwner.map(async (restaurant) => {
          const restaurantDeals = await storage.getDealsByRestaurant(
            restaurant.id,
          );
          return restaurantDeals.filter((deal) => deal.isActive);
        }),
      );

      res.json(allDeals.flat());
    } catch (error) {
      console.error("Error fetching my active deals:", error);
      res.status(500).json({ message: "Failed to fetch active deals" });
    }
  });

  app.get("/api/deals/featured", async (req, res) => {
    try {
      const filter = req.query.filter as string;
      const showLimitedTimeOnly = filter === "limited-time";

      const featuredDeals = await storage.getFilteredDeals(showLimitedTimeOnly);
      const payloadDeals = await projectAccessibleDeals(featuredDeals as any[]);

      res.setHeader("Cache-Control", "no-store");

      res.json(payloadDeals);
    } catch (error) {
      console.error("Error fetching featured deals:", error);
      res.status(500).json({ message: "Failed to fetch featured deals" });
    }
  });

  app.get("/api/public/deals/city/:citySlug", async (req, res) => {
    const citySlug = String(req.params.citySlug || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/(^-|-$)+/g, "")
      .slice(0, 80);
    const replacementPath = citySlug
      ? `/deals-today/${encodeURIComponent(citySlug)}`
      : "/deals-today";
    res.setHeader("Cache-Control", "no-store");
    return res.status(410).json({
      message: "This city deals API has been retired.",
      replacementPath,
      totalDeals: 0,
      deals: [],
    });
  });

  app.get("/api/deals/restaurant/:restaurantId", async (req, res) => {
    try {
      const restaurantId = z
        .string()
        .uuid("Invalid restaurant ID format")
        .parse(req.params.restaurantId);

      const restaurant = await storage.getRestaurant(restaurantId);
      if (!restaurant) {
        return res.status(404).json({ message: "Restaurant not found" });
      }

      const isOwnerViewing =
        Boolean(req.isAuthenticated?.()) &&
        String((req as any)?.user?.id || "") ===
          String((restaurant as any).ownerId || "");
      const ownerHasAccess = await hasCompleteProfileAccess(
        String((restaurant as any).ownerId || ""),
      );
      if (!ownerHasAccess && !isOwnerViewing) {
        return res.json([]);
      }

      const activeDeals = await projectPublicDealRows(
        (await storage.getDealsByRestaurant(restaurantId)).filter(
          (deal) => deal.isActive,
        ),
      );

      res.setHeader("Cache-Control", "no-store");

      res.json(activeDeals);
    } catch (error: any) {
      console.error("Error fetching restaurant deals:", error);
      if (error.name === "ZodError") {
        return res.status(400).json({ message: "Invalid restaurant ID format" });
      }
      res.status(500).json({ message: "Failed to fetch restaurant deals" });
    }
  });

  app.get("/api/deals/nearby/:lat/:lng", async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const lat = Number(req.params.lat);
      const lng = Number(req.params.lng);
      const radius = req.query.radius == null ? 5 : Number(req.query.radius);
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

      res.json(
        (await projectAccessibleDeals((await storage.getActiveDeals({
          userLat: lat, userLng: lng, radiusKm: radius,
        })) as any[], {
          userLat: lat,
          userLng: lng,
          radiusKm: radius,
        })).slice(0, 50),
      );
    } catch (error) {
      console.error("Error fetching nearby deals:", error);
      res.status(500).json({ message: "Failed to fetch nearby deals" });
    }
  });

  app.get("/api/deals/search", async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const {
        q: query,
        cuisine,
        minPrice,
        maxPrice,
        radius = 10,
        lat,
        lng,
        sortBy = "relevance",
      } = req.query;

      const hasLocation = lat != null || lng != null;
      const userLat = lat == null || String(lat).trim() === "" ? undefined : Number(lat);
      const userLng = lng == null || String(lng).trim() === "" ? undefined : Number(lng);
      const radiusKm = Number(radius);
      if (hasLocation && (
        !Number.isFinite(userLat) || !Number.isFinite(userLng) ||
        Math.abs(Number(userLat)) > 90 || Math.abs(Number(userLng)) > 180 ||
        !Number.isFinite(radiusKm) || radiusKm <= 0
      )) return res.status(400).json({ message: "Invalid coordinates or radius" });
      const scope = hasLocation
        ? { userLat: Number(userLat), userLng: Number(userLng), radiusKm }
        : undefined;
      let publicDeals = await projectAccessibleDeals(
        (await storage.getActiveDeals(scope)) as any[],
        scope || {},
      );
      const searchTerm = String(query || "").trim().toLowerCase();
      if (searchTerm) {
        publicDeals = publicDeals.filter((deal: any) =>
          [
            deal.title,
            deal.description,
            deal.restaurant?.name,
            deal.restaurant?.cuisineType,
          ]
            .map((value) => String(value || "").toLowerCase())
            .some((value) => value.includes(searchTerm)),
        );
      }
      const cuisineTerm = String(cuisine || "").trim().toLowerCase();
      if (cuisineTerm) {
        publicDeals = publicDeals.filter((deal: any) =>
          String(deal.restaurant?.cuisineType || "")
            .toLowerCase()
            .includes(cuisineTerm),
        );
      }
      const minimum = minPrice ? parseFloat(minPrice as string) : null;
      const maximum = maxPrice ? parseFloat(maxPrice as string) : null;
      if (Number.isFinite(minimum)) {
        publicDeals = publicDeals.filter(
          (deal: any) => Number(deal.minOrderAmount || 0) >= Number(minimum),
        );
      }
      if (Number.isFinite(maximum)) {
        publicDeals = publicDeals.filter(
          (deal: any) => Number(deal.minOrderAmount || 0) <= Number(maximum),
        );
      }
      if (sortBy === "price-low") {
        publicDeals.sort(
          (a: any, b: any) =>
            Number(a.minOrderAmount || 0) - Number(b.minOrderAmount || 0),
        );
      } else if (sortBy === "price-high") {
        publicDeals.sort(
          (a: any, b: any) =>
            Number(b.minOrderAmount || 0) - Number(a.minOrderAmount || 0),
        );
      } else if (sortBy === "discount") {
        publicDeals.sort(
          (a: any, b: any) =>
            Number(b.discountValue || 0) - Number(a.discountValue || 0),
        );
      } else if (sortBy === "date") {
        publicDeals.sort(
          (a: any, b: any) =>
            new Date(b.createdAt || 0).getTime() -
            new Date(a.createdAt || 0).getTime(),
        );
      }
      res.json(publicDeals.slice(0, 50));
    } catch (error) {
      console.error("Error searching deals:", error);
      res.status(500).json({ message: "Failed to search deals" });
    }
  });

  app.get("/api/deals/recommended", async (req: any, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const userId = req.user?.id;
      const sessionId = req.sessionID || "anonymous";

      const recommendedDeals = await storage.getActiveDeals();
      const filteredDeals = await projectAccessibleDeals(
        recommendedDeals as any[],
      );

      if (filteredDeals.length > 0) {
        Promise.all(
          filteredDeals.slice(0, 10).map(async (deal: any) => {
            try {
              await storage.trackRestaurantRecommendation({
                restaurantId: deal.restaurantId,
                userId,
                sessionId,
                recommendationType: "personalized",
                recommendationContext: "deals_recommended_endpoint",
              });
            } catch (error) {
              console.error("Error tracking recommendation:", error);
            }
          }),
        ).catch((error) =>
          console.error("Error tracking recommendations batch:", error),
        );
      }

      res.json(filteredDeals);
    } catch (error) {
      console.error("Error fetching recommended deals:", error);
      res.status(500).json({ message: "Failed to fetch recommended deals" });
    }
  });

  app.get("/api/deals/:id", async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const deal = await storage.getDeal(req.params.id);
      if (!deal) {
        return res.status(404).json({ message: "Deal not found" });
      }

      const restaurant = await storage.getRestaurant(String(deal.restaurantId));
      if (!restaurant) {
        return res.status(404).json({ message: "Restaurant not found" });
      }

      const isOwnerViewing =
        Boolean(req.isAuthenticated?.()) &&
        String((req as any)?.user?.id || "") ===
          String((restaurant as any).ownerId || "");
      const ownerHasAccess = await hasCompleteProfileAccess(
        String((restaurant as any).ownerId || ""),
      );
      if (!ownerHasAccess && !isOwnerViewing) {
        return res.status(404).json({ message: "Deal not found" });
      }

      const [publicDeal] = await projectPublicDealRows([deal]);
      if (!publicDeal) {
        return res.status(404).json({ message: "Deal not found" });
      }
      res.json(publicDeal);
    } catch (error) {
      console.error("Error fetching deal:", error);
      res.status(500).json({ message: "Failed to fetch deal" });
    }
  });

  app.post("/api/reviews", isAuthenticated, async (req: any, res) => {
    try {
      const reviewData = insertReviewSchema.parse({
        ...req.body,
        rating: 0,
        userId: req.user.id,
      });

      const review = await storage.createReview(reviewData);

      // This detail step adds weight on top of a bare recommend
      // (see /api/restaurants/:restaurantId/recommend).
      await db
        .update(users)
        .set({
          reviewCount: sql`${users.reviewCount} + 1`,
          influenceScore: sql`${users.influenceScore} + 2`,
          updatedAt: new Date(),
        } as any)
        .where(eq(users.id, req.user.id));

      res.json(review);
    } catch (error: any) {
      console.error("Error creating review:", error);
      res.status(400).json({ message: error.message });
    }
  });

  app.get("/api/reviews/restaurant/:restaurantId", async (req, res) => {
    try {
      const restaurant = await storage.getRestaurant(req.params.restaurantId);
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
      const reviews = await storage.getRestaurantReviews(
        req.params.restaurantId,
      );
      res.json(toPublicRestaurantReviewArray(reviews));
    } catch (error) {
      console.error("Error fetching reviews:", error);
      res.status(500).json({ message: "Failed to fetch reviews" });
    }
  });

}
