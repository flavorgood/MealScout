import {
  isPublicDiscoveryEligibleEntity,
  isSyntheticPublicEntityName,
} from "@shared/publicDiscoveryIntegrity";
import { deriveProfileEvidenceQuarantineVisibility } from "../services/profileEvidenceQuarantine";
import { isPublicBusinessVisible } from "../utils/publicBusinessVisibility";

/**
 * Sitemap membership + public restaurant/truck robots must share this rule.
 * A URL may appear in a MealScout sitemap only when this predicate is true.
 */
export const PUBLIC_RESTAURANT_INDEXABLE_ROBOTS =
  "index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1";
export const PUBLIC_RESTAURANT_NOINDEX_ROBOTS = "noindex,follow";

/** Bump when sitemap membership rules change so CDN/browser caches cannot keep excluded URLs. */
export const SITEMAP_MEMBERSHIP_VERSION = "pd-v1-indexability-4";

export const IMPORT_SYSTEM_EMAIL = (
  process.env.IMPORT_SYSTEM_EMAIL || "system-import@mealscout.us"
).toLowerCase();

export type PublicRestaurantIndexabilityInput = {
  name: unknown;
  isActive?: unknown;
  ownerId?: unknown;
  ownerEmail?: unknown;
  address?: unknown;
  cuisineType?: unknown;
  description?: unknown;
  city?: unknown;
  state?: unknown;
  rawData?: unknown;
  phone?: unknown;
  email?: unknown;
  websiteUrl?: unknown;
};

export type PublicRestaurantIndexabilityReason =
  | "inactive"
  | "synthetic"
  | "unclaimed"
  | "non_public_ready"
  | "quarantined";

export type PublicRestaurantIndexabilityResult = {
  indexable: boolean;
  robots: string;
  reasons: PublicRestaurantIndexabilityReason[];
};

export function isImportSystemOwnerEmail(email: unknown): boolean {
  const normalized = String(email || "")
    .trim()
    .toLowerCase();
  return Boolean(normalized) && normalized === IMPORT_SYSTEM_EMAIL;
}

/**
 * Canonical public indexability for restaurant-table entities (trucks, bars,
 * restaurants). Used by public profile prerender robots and sitemap membership.
 */
export function evaluatePublicRestaurantIndexability(
  input: PublicRestaurantIndexabilityInput,
): PublicRestaurantIndexabilityResult {
  const reasons: PublicRestaurantIndexabilityReason[] = [];

  if (input.isActive === false) {
    reasons.push("inactive");
  }

  if (isSyntheticPublicEntityName(input.name)) {
    reasons.push("synthetic");
  } else if (
    !isPublicDiscoveryEligibleEntity({
      name: input.name,
      isActive: input.isActive !== false,
    })
  ) {
    // Defense in depth if discovery eligibility gains non-synthetic gates later.
    reasons.push("synthetic");
  }

  const ownerId = String(input.ownerId || "").trim();
  const ownerEmailProvided = Object.prototype.hasOwnProperty.call(
    input,
    "ownerEmail",
  );
  const ownerEmail = ownerEmailProvided
    ? String(input.ownerEmail || "")
        .trim()
        .toLowerCase()
    : "";

  // Fail closed: missing owner, missing owner-email evidence, or import-system owner.
  if (
    !ownerId ||
    !ownerEmailProvided ||
    !ownerEmail ||
    isImportSystemOwnerEmail(ownerEmail)
  ) {
    reasons.push("unclaimed");
  }

  if (
    !isPublicBusinessVisible({
      name: input.name == null ? null : String(input.name),
      address: input.address == null ? null : String(input.address),
      cuisineType:
        input.cuisineType == null ? null : String(input.cuisineType),
      description:
        input.description == null ? null : String(input.description),
      city: input.city == null ? null : String(input.city),
      state: input.state == null ? null : String(input.state),
    })
  ) {
    reasons.push("non_public_ready");
  }

  if (deriveProfileEvidenceQuarantineVisibility(input).isQuarantined) {
    reasons.push("quarantined");
  }

  const uniqueReasons = Array.from(new Set(reasons));
  const indexable = uniqueReasons.length === 0;
  return {
    indexable,
    robots: indexable
      ? PUBLIC_RESTAURANT_INDEXABLE_ROBOTS
      : PUBLIC_RESTAURANT_NOINDEX_ROBOTS,
    reasons: uniqueReasons,
  };
}

export function isPublicRestaurantIndexable(
  input: PublicRestaurantIndexabilityInput,
): boolean {
  return evaluatePublicRestaurantIndexability(input).indexable;
}

export function publicRestaurantRobotsDirective(
  input: PublicRestaurantIndexabilityInput,
): string {
  return evaluatePublicRestaurantIndexability(input).robots;
}

export function applySitemapMembershipCacheHeaders(res: {
  setHeader: (name: string, value: string) => void;
}): void {
  // Membership contains merchant identity. Owner disable/quarantine changes
  // must take effect on the next request instead of lingering in shared caches.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-MealScout-Sitemap-Membership", SITEMAP_MEMBERSHIP_VERSION);
}
