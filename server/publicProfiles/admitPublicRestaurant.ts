import { publicSeoBusinessProfileType } from "../services/publicSeoLandingModel";
import { toCanonicalFoodBusinessType } from "@shared/businessTypes";
import { isPublicBusinessVisible } from "../utils/publicBusinessVisibility";
import { resolvePublicProfileVisibility } from "./publicProfileUtils";
import { toPublicRestaurantProfile } from "./toPublicRestaurantProfile";
import { assertPublicResponseSafe } from "./assertPublicResponseSafe";
import { MEALSCOUT_PUBLIC_CANONICAL_ORIGIN } from "../seo/publicCanonicalOrigin";

// Preserve restaurant-only route admission independently of food-profile export.
// Quarantine remains a field-redaction policy in the native projector.
export function isNativePublicRestaurant(row: any): boolean {
  return Boolean(row && row.isActive && isPublicBusinessVisible(row)
    && publicSeoBusinessProfileType(row) === "restaurant");
}

export type NativePublicFoodProfileType = "restaurant" | "truck" | "bar" | "caterer" | "private_chef";

// The native public routes include service profiles without expanding SEO landing semantics.
export function canonicalPublicRestaurantProfileEntity(row: any): NativePublicFoodProfileType | null {
  if (!row) return null;
  const discoveryProfileType = publicSeoBusinessProfileType(row);
  if (discoveryProfileType) return discoveryProfileType;
  const serviceType = toCanonicalFoodBusinessType(row.businessType);
  return serviceType === "caterer" || serviceType === "private_chef" ? serviceType : null;
}

export function projectAdmittedFoodProfileLink(row: any, owner: any) {
  const profileType = canonicalPublicRestaurantProfileEntity(row);
  if (!profileType || !row.isActive || !isPublicBusinessVisible(row)
    || !owner || owner.id !== row.ownerId || owner.isDisabled !== false) return null;
  const visibility = resolvePublicProfileVisibility(owner.publicProfileSettings);
  const dto = toPublicRestaurantProfile({ row, profileType,
    baseUrl: MEALSCOUT_PUBLIC_CANONICAL_ORIGIN, ...visibility });
  assertPublicResponseSafe(dto);
  if (dto.profileType !== profileType || dto.id !== row.id
    || dto.seo.entityType !== profileType || dto.seo.entityId !== row.id) return null;
  return { dto, visibility };
}

export function projectAdmittedRestaurantLink(row: any, owner: any) {
  if (!isNativePublicRestaurant(row) || !owner || owner.id !== row.ownerId
    || owner.isDisabled !== false) return null;
  const visibility = resolvePublicProfileVisibility(owner.publicProfileSettings);
  const dto = toPublicRestaurantProfile({ row,
    baseUrl: MEALSCOUT_PUBLIC_CANONICAL_ORIGIN, ...visibility });
  assertPublicResponseSafe(dto);
  if (dto.profileType !== "restaurant" || dto.id !== row.id
    || dto.seo.entityType !== "restaurant" || dto.seo.entityId !== row.id) return null;
  return { dto, visibility };
}
