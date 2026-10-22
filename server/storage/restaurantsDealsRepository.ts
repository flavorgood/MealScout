import {
  restaurants,
  deals,
  dealClaims,
  dealViews,
  dealFeedback,
  type Restaurant,
  type InsertRestaurant,
  type Deal,
  type InsertDeal,
} from "@shared/schema";
import { db } from "../db";
import {
  eq,
  and,
  desc,
  sql,
} from "drizzle-orm";
import { getBusinessAccessContext } from "../services/businessTeamAccess";
import { isPublicBusinessVisible } from "../utils/publicBusinessVisibility";
import { applyRestaurantCreationPolicy } from "../services/restaurantCreationPolicy";

type RestaurantsDealsRepositoryDependencies = {
  ensureCityExists: (name: string, state: string | null) => Promise<void>;
};

export function createRestaurantsDealsRepository(
  deps: RestaurantsDealsRepositoryDependencies,
) {
  const { ensureCityExists } = deps;
  const PROTECTED_IDENTITY_FIELDS = new Set([
    "ownerId",
    "businessType",
    "isFoodTruck",
    "isActive",
    "isVerified",
    "claimedFromImportId",
    "insuranceVerified",
    "insuranceVerifiedAt",
    "insuranceExpiresAt",
    "insuranceVerifiedByUserId",
    "rawData",
    "hasGoldenPlate",
    "goldenPlateEarnedAt",
    "goldenPlateCount",
    "rankingScore",
    "lockedPriceCents",
    "priceLockDate",
    "priceLockReason",
    "stripeConnectAccountId",
    "stripeConnectStatus",
    "stripeOnboardingCompleted",
    "stripeChargesEnabled",
    "stripePayoutsEnabled",
    "orderingApprovedAt",
    "orderingApprovedByUserId",
    "orderingApprovalEvidenceUrl",
    "orderingApprovalReviewNote",
    "pickupAcknowledgementMinutes",
  ]);

  function preserveCanonicalBusinessIdentity(
    existingBusiness: Restaurant,
    patch: Partial<InsertRestaurant>,
    allowIdentityChange: boolean,
  ): Partial<InsertRestaurant> {
    if (allowIdentityChange) return patch;
    const normalizedPatch: Partial<InsertRestaurant> = { ...patch };
    for (const field of PROTECTED_IDENTITY_FIELDS) {
      if (field in normalizedPatch) {
        const currentValue = (existingBusiness as any)[field];
        (normalizedPatch as any)[field] = currentValue;
      }
    }
    return normalizedPatch;
  }

  return {
    async createRestaurant(restaurant: InsertRestaurant): Promise<Restaurant> {
      // NORTH STAR RULE: Apply pricing lock for restaurants (not trucks) created before April 1, 2026
      const now = new Date();
      const restaurantData = applyRestaurantCreationPolicy(restaurant, now);

      const [newRestaurant] = await db
        .insert(restaurants)
        .values(restaurantData)
        .returning();
      try {
        if ((newRestaurant as any).city) {
          await ensureCityExists(
            (newRestaurant as any).city,
            (newRestaurant as any).state || null,
          );
        }
      } catch (e) {
        console.warn("ensureCityExists failed for restaurant", e);
      }
      return newRestaurant;
    },

    async getRestaurant(id: string): Promise<Restaurant | undefined> {
      const [restaurant] = await db
        .select()
        .from(restaurants)
        .where(eq(restaurants.id, id));
      return restaurant;
    },

    async getRestaurantsByOwner(ownerId: string): Promise<Restaurant[]> {
      return await db
        .select()
        .from(restaurants)
        .where(eq(restaurants.ownerId, ownerId));
    },

    async updateRestaurant(
      id: string,
      restaurant: Partial<InsertRestaurant>,
      options?: { allowIdentityChange?: boolean },
    ): Promise<Restaurant> {
      const [existingBusiness] = await db
        .select()
        .from(restaurants)
        .where(eq(restaurants.id, id))
        .limit(1);
      if (!existingBusiness) {
        throw new Error("Business not found");
      }
      const safePatch = preserveCanonicalBusinessIdentity(
        existingBusiness,
        restaurant,
        options?.allowIdentityChange === true,
      );
      const [updated] = await db
        .update(restaurants)
        .set({
          ...safePatch,
          updatedAt: new Date(),
        })
        .where(eq(restaurants.id, id))
        .returning();
      return updated;
    },

    async getAllRestaurants(): Promise<Restaurant[]> {
      return await db.select().from(restaurants);
    },

    async getNearbyRestaurants(
      lat: number,
      lng: number,
      radiusKm: number,
    ): Promise<Restaurant[]> {
      const results = await db
        .select()
        .from(restaurants)
        .where(
          and(
            eq(restaurants.isActive, true),
            sql`
              (6371 * acos(
                cos(radians(${lat})) *
                cos(radians(${restaurants.latitude})) *
                cos(radians(${restaurants.longitude}) - radians(${lng})) +
                sin(radians(${lat})) *
                sin(radians(${restaurants.latitude}))
              )) <= ${radiusKm}
            `,
          ),
        );
      return results.filter((restaurant: any) =>
        isPublicBusinessVisible(restaurant),
      );
    },

    async getSubscribedRestaurants(
      lat: number,
      lng: number,
      radiusKm: number,
    ): Promise<Restaurant[]> {
      // Legacy method name retained for compatibility. Complete active profiles
      // are discoverable without any subscription or billing-row requirement.
      const results = await db
        .select()
        .from(restaurants)
        .where(
          and(
            eq(restaurants.isActive, true),
            sql`
              (6371 * acos(
                cos(radians(${lat})) *
                cos(radians(${restaurants.latitude})) *
                cos(radians(${restaurants.longitude}) - radians(${lng})) +
                sin(radians(${lat})) *
                sin(radians(${restaurants.latitude}))
              )) <= ${radiusKm}
            `,
          ),
        );

      return results.filter((restaurant: any) =>
        isPublicBusinessVisible(restaurant),
      );
    },

    async verifyRestaurantOwnership(
      restaurantId: string,
      userId: string,
      requiredPermission?:
        | "manageDeals"
        | "manageParkingPass"
        | "viewAnalytics"
        | "manageProfile",
    ): Promise<boolean> {
      const [restaurant] = await db
        .select({ ownerId: restaurants.ownerId })
        .from(restaurants)
        .where(eq(restaurants.id, restaurantId))
        .limit(1);

      if (restaurant?.ownerId === userId) {
        return true;
      }
      if (!requiredPermission) {
        return false;
      }
      const context = await getBusinessAccessContext(userId);
      const match = context.restaurants.find((row) => row.id === restaurantId);
      return Boolean(match?.permissions?.[requiredPermission]);
    },

    async createDeal(deal: InsertDeal): Promise<Deal> {
      const [newDeal] = await db.insert(deals).values(deal).returning();
      return newDeal;
    },

    async getDeal(id: string): Promise<Deal | undefined> {
      const [deal] = await db.select().from(deals).where(eq(deals.id, id));
      return deal;
    },

    async getDealsByRestaurant(restaurantId: string): Promise<Deal[]> {
      return await db
        .select()
        .from(deals)
        .where(eq(deals.restaurantId, restaurantId))
        .orderBy(desc(deals.createdAt));
    },

    async updateDeal(id: string, updates: Partial<InsertDeal>): Promise<Deal> {
      const [updated] = await db
        .update(deals)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq(deals.id, id))
        .returning();
      return updated;
    },

    async deleteDeal(id: string): Promise<void> {
      await db.transaction(async (tx: any) => {
        // Serialize removal with claim issuance. Issued receipts require their
        // parent offer, so remove availability rather than the receipt history.
        await tx.select({ id: deals.id }).from(deals).where(eq(deals.id, id)).for("update");
        const [issued] = await tx.select({ id: dealClaims.id }).from(dealClaims).where(eq(dealClaims.dealId, id)).limit(1);
        if (issued) {
          await tx.update(deals).set({ isActive: false, updatedAt: new Date() }).where(eq(deals.id, id));
          return;
        }
        await tx.delete(dealViews).where(eq(dealViews.dealId, id));
        await tx.delete(dealFeedback).where(eq(dealFeedback.dealId, id));
        await tx.delete(deals).where(eq(deals.id, id));
      });
    },

    async duplicateDeal(id: string): Promise<Deal> {
      const [originalDeal] = await db.select().from(deals).where(eq(deals.id, id));
      if (!originalDeal) {
        throw new Error("Deal not found");
      }

      const {
        id: _,
        createdAt: __,
        updatedAt: ___,
        currentUses: ____,
        ...dealData
      } = originalDeal;

      const [clonedDeal] = await db
        .insert(deals)
        .values({
          ...dealData,
          title: `${dealData.title} (Copy)`,
          currentUses: 0,
          isActive: false,
        })
        .returning();

      return clonedDeal;
    },

    async getAllDeals(): Promise<Deal[]> {
      return await db.select().from(deals);
    },
  };
}
