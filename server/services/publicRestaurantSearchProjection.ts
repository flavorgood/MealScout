import {
  expandScoutSearchTerms,
  foldScoutSearchText,
  scoutSearchRelevanceScore,
} from "@shared/scoutSearchIntent";
import { AGGREGATE_SEARCH_RESTAURANT_LIMIT } from "@shared/searchResponseBounds";
import {
  toPublicRestaurantListingArray,
  type PublicRestaurantListingVisibility,
} from "../publicProfiles/toPublicRestaurantListing";
import { isPublicBusinessVisible } from "../utils/publicBusinessVisibility";
import { resolveCoordinatePair } from "@shared/consumerEntity";

function publicRestaurantActivityScore(restaurant: any): number {
  return (
    Number(restaurant.homeRankingScore || restaurant.rankingScore || 0) * 10 +
    Number(restaurant.communityActivityCount || 0) * 5 +
    Number(restaurant.recommendationCount || 0) * 4 +
    Number(restaurant.favoriteCount || 0) * 3 +
    Number(restaurant.followCount || 0) * 2 +
    Number(restaurant.activeDealCount || restaurant.activeDealsCount || 0) * 4
  );
}

export function publicRestaurantDistanceKm(
  restaurant: any,
  userLat: number,
  userLng: number,
): number | null {
  // A truck's last-known broadcast position is display data, labelled by
  // broadcastState in the public listing — it is not a current position,
  // so it must never drive distance math. Only a live broadcast (or a row
  // carrying no presence label at all) may use the current* coordinates;
  // anything else falls back to the static coordinates, which the listing
  // projection has already visibility-gated.
  const presenceLabel = restaurant?.broadcastState;
  const currentIsLive = presenceLabel === undefined || presenceLabel === "live";
  const latRaw =
    (currentIsLive ? restaurant?.currentLatitude : null) ??
    restaurant?.latitude ??
    null;
  const lngRaw =
    (currentIsLive ? restaurant?.currentLongitude : null) ??
    restaurant?.longitude ??
    null;
  const coordinates = resolveCoordinatePair(latRaw, lngRaw);
  if (
    !Number.isFinite(userLat) ||
    !Number.isFinite(userLng) ||
    !coordinates
  ) {
    return null;
  }
  const targetLat = coordinates.latitude;
  const targetLng = coordinates.longitude;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(targetLat - userLat);
  const dLng = toRad(targetLng - userLng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(userLat)) *
      Math.cos(toRad(targetLat)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function filterProjectedPublicNearbyRestaurantRows(
  projectedRows: any[],
  input: {
    userLat: number;
    userLng: number;
    radiusKm: number;
  },
) {
  if (
    !Number.isFinite(input.userLat) ||
    !Number.isFinite(input.userLng) ||
    !Number.isFinite(input.radiusKm) ||
    input.radiusKm <= 0
  ) {
    return [];
  }
  const radiusKm = Math.min(100, input.radiusKm);
  return projectedRows.filter((restaurant: any) => {
    if (
      restaurant?.isActive !== true ||
      !isPublicBusinessVisible(restaurant)
    ) {
      return false;
    }
    const distanceKm = publicRestaurantDistanceKm(
      restaurant,
      input.userLat,
      input.userLng,
    );
    return distanceKm !== null && distanceKm <= radiusKm;
  });
}

export function filterProjectedRestaurantSearchRows(
  projectedRows: any[],
  input: {
    query: string;
    userLat?: number;
    userLng?: number;
    radiusKm?: number;
  },
) {
  const searchTerm = foldScoutSearchText(input.query.trim());
  const hasLocation =
    Number.isFinite(input.userLat) && Number.isFinite(input.userLng);
  const radiusKm = Math.max(1, Math.min(50, Number(input.radiusKm || 10)));
  return projectedRows.filter((restaurant: any) => {
    if (
      restaurant?.isActive !== true ||
      ![restaurant.name, restaurant.cuisineType, restaurant.address]
        .map((value) => foldScoutSearchText(value))
        .some((value) => value.includes(searchTerm))
    ) {
      return false;
    }
    if (!hasLocation) return true;
    const distanceKm = publicRestaurantDistanceKm(
      restaurant,
      Number(input.userLat),
      Number(input.userLng),
    );
    return distanceKm !== null && distanceKm <= radiusKm;
  });
}

export function rankPublicRestaurantSearchRows(
  restaurantRows: any[],
  query: string,
  visibilityByOwnerId: ReadonlyMap<string, PublicRestaurantListingVisibility>,
) {
  const searchTerm = foldScoutSearchText(query.trim());
  const searchTerms = expandScoutSearchTerms(searchTerm);
  return toPublicRestaurantListingArray(restaurantRows, visibilityByOwnerId)
    .filter((restaurant: any) => {
      if (!isPublicBusinessVisible(restaurant)) return false;
      const haystack = [
        restaurant.name,
        restaurant.cuisineType,
        restaurant.address,
        restaurant.city,
        restaurant.state,
        restaurant.description,
      ]
        .map((value) => foldScoutSearchText(value))
        .join(" ");
      return searchTerms.some((term) => haystack.includes(term));
    })
    .sort((a: any, b: any) => {
      const relevanceDelta =
        scoutSearchRelevanceScore(b, searchTerm) -
        scoutSearchRelevanceScore(a, searchTerm);
      if (relevanceDelta !== 0) return relevanceDelta;

      const verifiedDelta =
        Number(Boolean(b.isVerified)) - Number(Boolean(a.isVerified));
      if (verifiedDelta !== 0) return verifiedDelta;

      const activityDelta =
        publicRestaurantActivityScore(b) - publicRestaurantActivityScore(a);
      if (activityDelta !== 0) return activityDelta;

      return String(a.name || "").localeCompare(String(b.name || ""));
    })
    .slice(0, AGGREGATE_SEARCH_RESTAURANT_LIMIT)
    .map((restaurant: any) => ({
      id: restaurant.id,
      name: restaurant.name,
      cuisineType: restaurant.cuisineType,
      address: restaurant.address,
      city: restaurant.city || null,
      state: restaurant.state || null,
      slug: null,
      description: restaurant.description || null,
      logoUrl: restaurant.logoUrl || null,
      coverImageUrl: restaurant.coverImageUrl || null,
      imageUrl: restaurant.coverImageUrl || restaurant.logoUrl || null,
      businessType: restaurant.businessType || null,
      isFoodTruck: Boolean(restaurant.isFoodTruck),
      isVerified: Boolean(restaurant.isVerified),
      activeDealCount: Number(restaurant.activeDealCount || 0),
      favoriteCount: Number(restaurant.favoriteCount || 0),
      followCount: Number(restaurant.followCount || 0),
      recommendationCount: Number(restaurant.recommendationCount || 0),
      communityActivityCount: Number(restaurant.communityActivityCount || 0),
      homeRankingScore: Number(restaurant.homeRankingScore || 0),
    }));
}

export function buildPublicRestaurantSearchSuggestions(
  restaurantRows: any[],
  query: string,
  visibilityByOwnerId: ReadonlyMap<string, PublicRestaurantListingVisibility>,
) {
  const searchTerm = foldScoutSearchText(query.trim());
  const cuisineSuggestions = new Map<string, any>();
  const suggestions: any[] = [];
  const publicRows = toPublicRestaurantListingArray(
    restaurantRows,
    visibilityByOwnerId,
  ).filter((row: any) => {
    if (!isPublicBusinessVisible(row)) return false;
    return [row.name, row.cuisineType, row.address, row.city, row.state]
      .map((value) => foldScoutSearchText(value))
      .join(" ")
      .includes(searchTerm);
  });

  for (const row of publicRows) {
    suggestions.push({
      id: `restaurant-${row.id}`,
      text: row.name,
      type: "restaurant",
      subtitle: [row.cuisineType || "Restaurant", row.address]
        .filter(Boolean)
        .join(" - "),
    });
    const cuisine = String(row.cuisineType || "").trim();
    if (cuisine && foldScoutSearchText(cuisine).includes(searchTerm)) {
      const key = cuisine.toLowerCase();
      if (!cuisineSuggestions.has(key)) {
        cuisineSuggestions.set(key, {
          id: `cuisine-${key}`,
          text: cuisine,
          type: "cuisine",
          subtitle: "Food category",
        });
      }
    }
  }
  suggestions.push(...cuisineSuggestions.values());
  return suggestions;
}
