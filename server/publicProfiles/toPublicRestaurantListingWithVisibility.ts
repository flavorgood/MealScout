import { inArray } from "drizzle-orm";

import { users } from "@shared/schema";
import { db } from "../db";
import { resolvePublicProfileVisibility } from "./publicProfileUtils";
import { isPublicBusinessVisible } from "../utils/publicBusinessVisibility";
import { deriveProfileEvidenceQuarantineVisibility } from "../services/profileEvidenceQuarantine";
import {
  toPublicRestaurantListingArray,
  type PublicRestaurantListingVisibility,
} from "./toPublicRestaurantListing";

export async function loadPublicRestaurantListingVisibility(
  rows: any[] | null | undefined,
  database: any = db,
): Promise<Map<string, PublicRestaurantListingVisibility>> {
  const ownerIds = Array.from(
    new Set(
      (Array.isArray(rows) ? rows : [])
        .map((row) => String(row?.ownerId || "").trim())
        .filter(Boolean),
    ),
  );
  if (ownerIds.length === 0) {
    return new Map<string, PublicRestaurantListingVisibility>();
  }
  const ownerRows: Array<{
    id: string;
    isDisabled: boolean | null;
    publicProfileSettings: unknown;
  }> = await database
    .select({
      id: users.id,
      isDisabled: users.isDisabled,
      publicProfileSettings: users.publicProfileSettings,
    })
    .from(users)
    .where(inArray(users.id, ownerIds));
  return new Map<string, PublicRestaurantListingVisibility>(
    ownerRows.map((owner): [string, PublicRestaurantListingVisibility] => {
      const visibility = resolvePublicProfileVisibility(
        owner.publicProfileSettings,
      );
      const ownerEnabled = owner.isDisabled === false;
      return [
        String(owner.id),
        {
          showAddress: ownerEnabled && visibility.showAddress,
          showContact: ownerEnabled && visibility.showContact,
          ownerEnabled,
        },
      ];
    }),
  );
}

export async function toPublicRestaurantListingArrayWithVisibility(
  rows: any[] | null | undefined,
  database: any = db,
) {
  const visibilityByOwnerId = await loadPublicRestaurantListingVisibility(
    rows,
    database,
  );
  return toPublicRestaurantListingArray(rows, visibilityByOwnerId);
}

export async function toPublicRestaurantListingWithVisibility(
  row: any,
  database: any = db,
) {
  const [projected] = await toPublicRestaurantListingArrayWithVisibility(
    row ? [row] : [],
    database,
  );
  return projected;
}

// Personal relationships do not grant access to private business profile data.
// Keep native relationship timestamps/IDs while projecting the nested business
// with the same consent, eligibility and field allowlist as public discovery.
export async function toPublicRestaurantRelationshipArrayWithVisibility(
  rows: any[],
  database: any = db,
) {
  const eligible = rows.filter((row) => row.restaurant?.isActive === true &&
    isPublicBusinessVisible(row.restaurant) &&
    !deriveProfileEvidenceQuarantineVisibility(row.restaurant).isQuarantined);
  const publicRestaurants = await toPublicRestaurantListingArrayWithVisibility(
    eligible.map((row) => row.restaurant), database,
  );
  const byId = new Map(publicRestaurants.map((restaurant: any) => [restaurant.id, restaurant]));
  return eligible.flatMap((row) => {
    const restaurant = byId.get(row.restaurantId);
    return restaurant ? [{
      id: row.id, restaurantId: row.restaurantId, createdAt: row.createdAt,
      ...(row.favoritedAt !== undefined ? { favoritedAt: row.favoritedAt } : {}),
      ...(row.followedAt !== undefined ? { followedAt: row.followedAt } : {}),
      ...(row.recommendedAt !== undefined ? { recommendedAt: row.recommendedAt } : {}),
      restaurant,
    }] : [];
  });
}
