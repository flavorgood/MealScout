import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { dealClaims, deals, restaurants, users, type DealClaim } from "@shared/schema";
import { isPublicBusinessVisible } from "../utils/publicBusinessVisibility";
import { deriveProfileEvidenceQuarantineVisibility } from "./profileEvidenceQuarantine";

export type DealClaimResult =
  | { ok: true; claim: DealClaim; replayed: boolean }
  | { ok: false; reason: "unavailable" | "sold_out" };

function isClaimRestaurantAvailable(restaurant: any, ownerIsDisabled: unknown) {
  return restaurant?.isActive === true && ownerIsDisabled === false &&
    isPublicBusinessVisible(restaurant) &&
    !deriveProfileEvidenceQuarantineVisibility(restaurant).isQuarantined;
}

export async function getUserDealClaimReceipts(database: any, userId: string) {
  const rows = await database.select({
    id: dealClaims.id,
    dealId: dealClaims.dealId,
    claimedAt: dealClaims.claimedAt,
    usedAt: dealClaims.usedAt,
    isUsed: dealClaims.isUsed,
    orderAmount: dealClaims.orderAmount,
    dealTitle: deals.title,
    dealType: deals.dealType,
    discountValue: deals.discountValue,
    restaurantId: deals.restaurantId,
    restaurantName: restaurants.name,
    restaurantIsActive: restaurants.isActive,
    ownerIsDisabled: users.isDisabled,
    restaurantVisibility: {
      name: restaurants.name,
      cuisineType: restaurants.cuisineType,
      description: restaurants.description,
      city: restaurants.city,
      state: restaurants.state,
      rawData: restaurants.rawData,
      isActive: restaurants.isActive,
    },
    startDate: deals.startDate,
    endDate: deals.endDate,
    startTime: deals.startTime,
    endTime: deals.endTime,
    availableDuringBusinessHours: deals.availableDuringBusinessHours,
    isOngoing: deals.isOngoing,
    isActive: deals.isActive,
  }).from(dealClaims)
    .leftJoin(deals, eq(dealClaims.dealId, deals.id))
    .leftJoin(restaurants, eq(deals.restaurantId, restaurants.id))
    .leftJoin(users, eq(restaurants.ownerId, users.id))
    .where(eq(dealClaims.userId, userId))
    .orderBy(desc(dealClaims.claimedAt), desc(dealClaims.id));
  // A claim is not permission to reveal an owner's private street address.
  // Directions use the separate canonical public restaurant projection.
  return rows.map((row: any) => {
    const { ownerIsDisabled, restaurantVisibility, ...receipt } = row;
    return {
      ...receipt,
      restaurantIsActive: isClaimRestaurantAvailable(restaurantVisibility, ownerIsDisabled),
      restaurantAddress: null,
    };
  });
}

// An issued receipt remains recoverable when a deal later closes. Capacity and
// dates govern new claims, not access to the user's existing receipt.
export async function claimDealWithReceipt(
  database: any,
  dealId: string,
  userId: string,
  now = new Date(),
): Promise<DealClaimResult> {
  return database.transaction(async (tx: any) => {
    // Lock before reading the user's count. The old count-before-UPDATE order
    // allowed two simultaneous requests to both pass a per-customer limit.
    const [deal] = await tx.select().from(deals)
      .where(eq(deals.id, dealId)).for("update");
    if (!deal) return { ok: false, reason: "unavailable" as const };

    const existing: DealClaim[] = await tx.select().from(dealClaims)
      .where(and(eq(dealClaims.dealId, dealId), eq(dealClaims.userId, userId)))
      .orderBy(desc(dealClaims.claimedAt), desc(dealClaims.id));
    const unused = existing.find((claim) => !claim.isUsed && !claim.usedAt);
    if (unused) return { ok: true, claim: unused, replayed: true };

    const configuredLimit = Number(deal.perCustomerLimit);
    const limit = Number.isInteger(configuredLimit) && configuredLimit > 0
      ? configuredLimit : 1;
    if (existing.length >= limit) {
      return { ok: true, claim: existing[0], replayed: true };
    }

    // The schema has no timezone for daily offer hours. Keep the existing
    // detail/claim date-level semantics; receipt consumers show those hours as
    // terms rather than promising that redemption is available right now.
    const start = new Date(deal.startDate).getTime();
    const end = deal.endDate == null ? null : new Date(deal.endDate).getTime();
    const [restaurant] = await tx.select().from(restaurants)
      .where(eq(restaurants.id, deal.restaurantId)).for("share");
    const [owner] = restaurant?.ownerId
      ? await tx.select({ isDisabled: users.isDisabled }).from(users)
        .where(eq(users.id, restaurant.ownerId)).for("share")
      : [];
    if (deal.isActive !== true || !isClaimRestaurantAvailable(restaurant, owner?.isDisabled) ||
        deal.startDate == null || !Number.isFinite(start) || start > now.getTime() ||
        (end === null && deal.isOngoing !== true) ||
        (end !== null && (!Number.isFinite(end) || end <= now.getTime()))) {
      return { ok: false, reason: "unavailable" as const };
    }

    const [reserved] = await tx.update(deals).set({
      currentUses: sql`coalesce(${deals.currentUses}, 0) + 1`,
      updatedAt: now,
    }).where(and(eq(deals.id, dealId), or(
      isNull(deals.totalUsesLimit),
      lt(sql`coalesce(${deals.currentUses}, 0)`, deals.totalUsesLimit),
    ))).returning({ id: deals.id });
    if (!reserved) return { ok: false, reason: "sold_out" as const };

    const [claim] = await tx.insert(dealClaims).values({ dealId, userId }).returning();
    return { ok: true, claim, replayed: false };
  });
}
