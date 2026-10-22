import type { PublicRestaurantListingVisibility } from "../publicProfiles/toPublicRestaurantListing";
import { toPublicRestaurantListing } from "../publicProfiles/toPublicRestaurantListing";
import { isPublicBusinessVisible } from "../utils/publicBusinessVisibility";

export function projectPublicLocalMenuItemRow(
  row: any,
  visibility: PublicRestaurantListingVisibility,
): { publicRow: Record<string, unknown>; privateRankingScore: number } | null {
  if (visibility.ownerEnabled === false) return null;
  const restaurantSource = {
    id: row.restaurantId,
    ownerId: row.restaurantOwnerId,
    name: row.restaurantName,
    address: row.restaurantAddress,
    phone: row.restaurantPhone,
    city: row.restaurantCity,
    state: row.restaurantState,
    logoUrl: row.restaurantLogoUrl,
    coverImageUrl: row.restaurantCoverImageUrl,
    cuisineType: row.cuisineType,
    latitude: row.restaurantLatitude,
    longitude: row.restaurantLongitude,
    currentLatitude: row.restaurantCurrentLatitude,
    currentLongitude: row.restaurantCurrentLongitude,
    mobileOnline: row.restaurantMobileOnline,
    lastBroadcastAt: row.restaurantLastBroadcastAt,
    liveUntilAt: row.restaurantLiveUntilAt,
    isFoodTruck: row.isFoodTruck,
    businessType: row.businessType,
    isActive: row.restaurantIsActive,
    isVerified: row.restaurantIsVerified,
    rawData: row.restaurantRawData,
  };
  if (!isPublicBusinessVisible(restaurantSource)) return null;

  const restaurant = toPublicRestaurantListing(restaurantSource, visibility);
  if (!restaurant?.id || restaurant.isActive !== true) return null;

  return {
    publicRow: {
      id: row.id,
      name: row.name,
      description: row.description,
      priceCents: row.priceCents,
      itemType: row.itemType,
      imageUrl: row.imageUrl,
      dietaryTags: row.dietaryTags,
      updatedAt: row.updatedAt,
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      restaurantCity: restaurant.city,
      restaurantState: restaurant.state,
      restaurantLogoUrl: restaurant.logoUrl,
      restaurantCoverImageUrl: restaurant.coverImageUrl,
      cuisineType: restaurant.cuisineType,
      // Both alternatives have already passed the canonical public-location
      // policy. A mobile business's administrative base is never a fallback.
      restaurantLatitude: restaurant.currentLatitude ?? restaurant.latitude,
      restaurantLongitude: restaurant.currentLongitude ?? restaurant.longitude,
      isFoodTruck: restaurant.isFoodTruck,
      businessType: restaurant.businessType,
      favoriteCount: Number(row.favoriteCount || 0),
    },
    // Used only while ranking this response. It is deliberately separated
    // from publicRow so the internal score cannot escape through `...row`.
    privateRankingScore: Number(row.rankingScore || 0),
  };
}
