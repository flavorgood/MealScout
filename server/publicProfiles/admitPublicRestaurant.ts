import { publicSeoBusinessProfileType } from "../services/publicSeoLandingModel";
import { isPublicBusinessVisible } from "../utils/publicBusinessVisibility";
import { resolvePublicProfileVisibility } from "./publicProfileUtils";
import { toPublicRestaurantProfile } from "./toPublicRestaurantProfile";
import { assertPublicResponseSafe } from "./assertPublicResponseSafe";
import { MEALSCOUT_PUBLIC_CANONICAL_ORIGIN } from "../seo/publicCanonicalOrigin";

// The restaurant-only native route and optional ecosystem export share admission.
// Quarantine remains a field-redaction policy in the native projector.
export function isNativePublicRestaurant(row: any): boolean {
  return Boolean(row && row.isActive && isPublicBusinessVisible(row)
    && publicSeoBusinessProfileType(row) === "restaurant");
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
