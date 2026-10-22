import { inArray } from "drizzle-orm";

import { restaurants } from "@shared/schema";
import { db } from "../db";
import { toPublicRestaurantListing } from "../publicProfiles/toPublicRestaurantListing";
import { loadPublicRestaurantListingVisibility } from "../publicProfiles/toPublicRestaurantListingWithVisibility";
import { isPublicBusinessVisible } from "../utils/publicBusinessVisibility";
import { publicRestaurantDistanceKm } from "./publicRestaurantSearchProjection";
import { projectPublicDealRow } from "./publicDealRowProjection";
import { deriveProfileEvidenceQuarantineVisibility } from "./profileEvidenceQuarantine";

export async function projectPublicDealRows(
  dealRows: any[] | null | undefined,
  options: {
    database?: any;
    userLat?: number;
    userLng?: number;
    radiusKm?: number;
  } = {},
) {
  const database = options.database ?? db;
  const now = Date.now();
  const rows = (Array.isArray(dealRows) ? dealRows : []).filter((deal) => {
    if (deal?.isActive !== true) return false;
    const start = deal?.startDate ? new Date(deal.startDate).getTime() : null;
    const end = deal?.endDate ? new Date(deal.endDate).getTime() : null;
    if (start !== null && (!Number.isFinite(start) || start > now)) return false;
    if (end !== null && (!Number.isFinite(end) || end < now)) return false;
    return true;
  });
  const restaurantIds = Array.from(
    new Set(
      rows
        .map((deal) => String(deal?.restaurantId || "").trim())
        .filter(Boolean),
    ),
  );
  if (restaurantIds.length === 0) return [];

  const restaurantRows = await database
    .select()
    .from(restaurants)
    .where(inArray(restaurants.id, restaurantIds));
  const visibleRestaurantRows = restaurantRows.filter(
    (restaurant: any) =>
      restaurant?.isActive === true &&
      isPublicBusinessVisible(restaurant) &&
      !deriveProfileEvidenceQuarantineVisibility(restaurant).isQuarantined,
  );
  const visibilityByOwnerId = await loadPublicRestaurantListingVisibility(
    visibleRestaurantRows,
    database,
  );
  const publicRestaurantById = new Map<string, Record<string, unknown>>(
    visibleRestaurantRows.flatMap((restaurant: any) => {
      const visibility = visibilityByOwnerId.get(
        String(restaurant.ownerId || ""),
      );
      if (!visibility?.ownerEnabled) return [];
      const projected = toPublicRestaurantListing(restaurant, visibility);
      if (!projected?.id) return [];
      return [[String(restaurant.id), projected] as const];
    }),
  );
  const hasLocation =
    Number.isFinite(options.userLat) && Number.isFinite(options.userLng);
  const radiusKm = Number.isFinite(options.radiusKm)
    ? Number(options.radiusKm)
    : null;

  const projected: any[] = [];
  for (const deal of rows) {
    const restaurantId = String(deal?.restaurantId || "").trim();
    const publicRestaurant = publicRestaurantById.get(restaurantId);
    if (!publicRestaurant) continue;

    const distanceKm = hasLocation
      ? publicRestaurantDistanceKm(
          publicRestaurant,
          Number(options.userLat),
          Number(options.userLng),
        )
      : null;
    if (
      hasLocation &&
      (distanceKm === null ||
        !Number.isFinite(distanceKm) ||
        (radiusKm !== null && distanceKm > radiusKm))
    ) {
      continue;
    }

    projected.push(projectPublicDealRow(deal, publicRestaurant, distanceKm));
  }
  return projected;
}
