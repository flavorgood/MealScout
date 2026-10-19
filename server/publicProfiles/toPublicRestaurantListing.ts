import {
  DEFAULT_TRUCK_BROADCAST_FRESHNESS_MS,
  deriveTruckPresence,
  resolveCoordinatePair,
} from "@shared/consumerEntity";
import { deriveProfileEvidenceQuarantineVisibility } from "../services/profileEvidenceQuarantine";
import { shouldExposeStaticTruckProfileLocation } from "../utils/truckLocationSemantics";
import { projectPublicRestaurantMedia } from "./toPublicRestaurantProfile";

export type PublicRestaurantListingVisibility = {
  showAddress: boolean;
  showContact: boolean;
  ownerEnabled?: boolean;
};

// Allowlisted projection for unauthenticated restaurant list/detail responses
// (/api/restaurants/public, /search, /nearby, /subscribed, /:id). Keeps the
// existing flat field names consumers already read (name, address, latitude,
// currentLatitude, etc.) so callers don't need to change, while dropping
// columns that were never meant to leave the server: owner identity, raw
// import payloads, insurance/verification audit trail, and internal
// pricing/ranking controls.
export function toPublicRestaurantListing(
  row: any,
  visibility: PublicRestaurantListingVisibility = {
    showAddress: false,
    showContact: false,
  },
): Record<string, unknown> {
  if (!row || typeof row !== "object") return row;
  if (visibility.ownerEnabled === false) return {};

  const {
    hidePublicTrustFields,
    isAccepted,
    isRejected,
    isAcceptedWithLegacyFallback,
    isRejectedWithLegacyFallback,
  } = deriveProfileEvidenceQuarantineVisibility(row);
  const isPrivateChef =
    String(row.businessType || "")
      .trim()
      .toLowerCase() === "private_chef";
  const addressVisible = Boolean(
    visibility.showAddress &&
    !isPrivateChef &&
    !isRejected("contact_address") &&
    (!hidePublicTrustFields || isAccepted("contact_address")) &&
    shouldExposeStaticTruckProfileLocation(row),
  );
  const phoneVisible = Boolean(
    visibility.showContact &&
    !isRejected("contact_phone") &&
    (!hidePublicTrustFields || isAccepted("contact_phone")),
  );
  const staticCoordinates = addressVisible
    ? resolveCoordinatePair(row.latitude, row.longitude)
    : null;
  const isTruck =
    row.isFoodTruck === true ||
    String(row.businessType || "")
      .trim()
      .toLowerCase() === "food_truck";
  const truckPresence = isTruck
    ? deriveTruckPresence(
        {
          mobileOnline: row.mobileOnline,
          liveBroadcasting: row.liveBroadcasting,
          currentLatitude: row.currentLatitude,
          currentLongitude: row.currentLongitude,
          lastBroadcastAt: row.lastBroadcastAt,
          liveUntilAt: row.liveUntilAt,
          locationSource: row.liveLocationSource || row.locationSource || "unknown",
          gpsAccuracy: row.gpsAccuracy,
        },
        { freshnessMs: DEFAULT_TRUCK_BROADCAST_FRESHNESS_MS },
      )
    : null;
  const liveCoordinates =
    truckPresence?.broadcastState === "live" ? truckPresence.location : null;
  const contactFieldVisible = (
    evidenceId:
      "website_link" | "social_instagram" | "social_facebook" | "social_x",
    legacyEvidenceId?: "social_links",
  ) =>
    Boolean(
      visibility.showContact &&
      !(legacyEvidenceId
        ? isRejectedWithLegacyFallback(evidenceId, legacyEvidenceId)
        : isRejected(evidenceId)) &&
      (!hidePublicTrustFields ||
        (legacyEvidenceId
          ? isAcceptedWithLegacyFallback(evidenceId, legacyEvidenceId)
          : isAccepted(evidenceId))),
    );
  const publicMedia = projectPublicRestaurantMedia(row);

  const {
    id,
    name,
    address,
    phone,
    businessType,
    cuisineType,
    city,
    state,
    isFoodTruck,
    lastBroadcastAt,
    liveUntilAt,
    operatingHours,
    isActive,
    isVerified,
    insuranceVerified,
    description,
    websiteUrl,
    instagramUrl,
    facebookPageUrl,
    xUrl,
    amenities,
    hasGoldenPlate,
    goldenPlateEarnedAt,
    goldenPlateCount,
    featuredMenuItemId,
    createdAt,
    updatedAt,
    // Computed fields attached at query time (not raw DB columns) — safe to
    // pass through as-is when present.
    distance,
    favoriteCount,
    followCount,
    recommendationCount,
    videoRecommendationCount,
    communityActivityCount,
    activeDealCount,
    homeRankingScore,
    homeRankingReason,
  } = row;

  return {
    id,
    name,
    address: addressVisible ? String(address || "").trim() || null : null,
    phone: phoneVisible ? String(phone || "").trim() || null : null,
    businessType,
    cuisineType,
    latitude: staticCoordinates?.latitude ?? null,
    longitude: staticCoordinates?.longitude ?? null,
    city,
    state,
    isFoodTruck,
    mobileOnline: Boolean(liveCoordinates),
    currentLatitude: liveCoordinates?.latitude ?? null,
    currentLongitude: liveCoordinates?.longitude ?? null,
    lastBroadcastAt,
    liveUntilAt,
    operatingHours,
    isActive,
    isVerified:
      hidePublicTrustFields && !isAccepted("identity_verification")
        ? false
        : Boolean(isVerified),
    insuranceVerified,
    logoUrl: publicMedia.logoUrl,
    coverImageUrl: publicMedia.coverImageUrl,
    description,
    websiteUrl: contactFieldVisible("website_link") ? websiteUrl : null,
    instagramUrl: contactFieldVisible("social_instagram", "social_links")
      ? instagramUrl
      : null,
    facebookPageUrl: contactFieldVisible("social_facebook", "social_links")
      ? facebookPageUrl
      : null,
    xUrl: contactFieldVisible("social_x", "social_links") ? xUrl : null,
    amenities,
    hasGoldenPlate,
    goldenPlateEarnedAt,
    goldenPlateCount,
    featuredMenuItemId,
    createdAt,
    updatedAt,
    ...(distance !== undefined ? { distance } : {}),
    ...(favoriteCount !== undefined ? { favoriteCount } : {}),
    ...(followCount !== undefined ? { followCount } : {}),
    ...(recommendationCount !== undefined ? { recommendationCount } : {}),
    ...(videoRecommendationCount !== undefined
      ? { videoRecommendationCount }
      : {}),
    ...(communityActivityCount !== undefined ? { communityActivityCount } : {}),
    ...(activeDealCount !== undefined ? { activeDealCount } : {}),
    ...(homeRankingScore !== undefined ? { homeRankingScore } : {}),
    ...(homeRankingReason !== undefined ? { homeRankingReason } : {}),
  };
}

export function toPublicRestaurantListingArray(
  rows: any[] | null | undefined,
  visibilityByOwnerId?: ReadonlyMap<string, PublicRestaurantListingVisibility>,
): Record<string, unknown>[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const visibility = visibilityByOwnerId?.get(String(row?.ownerId || ""));
    if (visibilityByOwnerId && (!visibility || visibility.ownerEnabled === false)) {
      return [];
    }
    return [toPublicRestaurantListing(row, visibility)];
  });
}
