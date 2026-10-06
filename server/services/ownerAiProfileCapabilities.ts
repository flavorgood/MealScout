import { OwnerAiCapabilityError, previewOwnerAiPacket, readOwnerAiCapabilities } from "@shared/ownerAiCapabilities";
import { resolveOwnerAiNativeAdapter } from "@shared/ownerAiNativeAdapters";
import type { OwnerAiConnectorPrincipal } from "./ownerAiActions";
import { deriveProfileEvidenceQuarantineVisibility } from "./profileEvidenceQuarantine";
import { shouldExposeStaticTruckProfileLocation } from "../utils/truckLocationSemantics";

type Credential = { id: string; userId: string; restaurantId: string | null; purpose: string; scope: string; isActive: boolean | null; expiresAt: Date | null; revokedAt: Date | null };
type Binding = { credential: Credential | undefined; restaurant: { id: string; ownerId: string | null; businessType: string; isFoodTruck?: boolean | null; publicSurface: boolean; blockedProfileFields: string[]; completeProfileAccess?: boolean } | undefined };
export type OwnerAiProfileDependencies = {
  readBinding(principal: OwnerAiConnectorPrincipal): Promise<Binding>;
  readContext(restaurantId: string, ownerId: string): Promise<{ restaurant: { id: string; businessType: string; isFoodTruck?: boolean | null }; expectedVersions: unknown }>;
  now(): Date;
};

// Dependencies accept an already authenticated principal, never a request body principal.
export function createOwnerAiProfileCapabilities(deps: OwnerAiProfileDependencies) {
  async function resolve(principal: OwnerAiConnectorPrincipal) {
    const initial = await deps.readBinding(principal);
    const validBinding = ({ credential, restaurant }: Binding) => credential && restaurant && credential.id === principal.apiKeyId && credential.purpose === "owner_ai_connector" && credential.restaurantId === principal.restaurantId && credential.userId === principal.userId && restaurant.id === principal.restaurantId && restaurant.ownerId === principal.userId;
    if (!validBinding(initial)) throw new OwnerAiCapabilityError("CURRENT_OWNER_REQUIRED");
    const initialCredential = initial.credential!;
    if (!initialCredential.isActive || initialCredential.revokedAt || (initialCredential.expiresAt && initialCredential.expiresAt <= deps.now())) throw new OwnerAiCapabilityError("PRINCIPAL_INACTIVE");
    if (!initialCredential.scope.split(/[\s,]+/).includes("owner_ai:context")) throw new OwnerAiCapabilityError("CONTEXT_SCOPE_REQUIRED");
    const context = await deps.readContext(principal.restaurantId, principal.userId);
    // Recheck after the native snapshot: ownership transfer/revocation during the read fails closed.
    const { credential, restaurant } = await deps.readBinding(principal);
    const now = deps.now().toISOString();
    if (!validBinding({ credential, restaurant }) || !credential || !restaurant) {
      throw new OwnerAiCapabilityError("CURRENT_OWNER_REQUIRED");
    }
    if (context.restaurant.id !== restaurant.id || context.restaurant.businessType !== restaurant.businessType || context.restaurant.isFoodTruck !== restaurant.isFoodTruck) throw new OwnerAiCapabilityError("STALE_CONTEXT");
    let native;
    try { native = resolveOwnerAiNativeAdapter(restaurant); } catch { throw new OwnerAiCapabilityError("UNSUPPORTED_ADAPTER"); }
    const target = { profileId: restaurant.id, profileType: native.profileType };
    return {
      target, now, blockedProfileFields: restaurant.blockedProfileFields,
      authority: { target, completeProfileAccess: restaurant.completeProfileAccess === true, currentOwnerId: restaurant.ownerId, adapter: native.adapter, backingRestaurantId: restaurant.id, currentVersions: context.expectedVersions,
        // This labels the native public profile publication surface, not private inventory or externally supplied evidence.
        provenance: { source: "MealScout native publication visibility policy", observedAt: now, access: restaurant.publicSurface ? "public" : "private", expiresAt: nowPlusMinute(now) } },
      principal: { apiKeyId: credential.id, userId: credential.userId, target, scopes: credential.scope.split(/[\s,]+/).filter(Boolean), isActive: credential.isActive === true, expiresAt: credential.expiresAt?.toISOString() ?? null, revokedAt: credential.revokedAt?.toISOString() ?? null },
    };
  }
  return {
    read: async (principal: OwnerAiConnectorPrincipal) => {
      const input = await resolve(principal);
      return { ...readOwnerAiCapabilities(input), blockedProfileFields: [...input.blockedProfileFields] };
    },
    preview: async (principal: OwnerAiConnectorPrincipal, request: unknown) => {
      const input = await resolve(principal);
      const preview = previewOwnerAiPacket({ ...input, request });
      if (Object.keys(preview.packet.profile || {}).some(field => input.blockedProfileFields.includes(field))) throw new OwnerAiCapabilityError("PROFILE_FIELD_NOT_PUBLIC");
      return { ...preview, sourceVerification: "declared_unverified" as const, mutationPerformed: false as const,
        nextStep: "Create a native versioned draft and obtain explicit owner consent for its exact revision before applying. Source declarations confer no authority or verified evidence." };
    },
  };
}
function nowPlusMinute(now: string) { return new Date(Date.parse(now) + 60_000).toISOString(); }

export function deriveOwnerAiPublicationPolicy(restaurant: { isActive?: boolean | null; businessType?: string; rawData?: unknown } | undefined, visibility: { ownerEnabled?: boolean; showAddress: boolean; showContact: boolean } | undefined) {
  const quarantine = deriveProfileEvidenceQuarantineVisibility(restaurant);
  const blocked = new Set<string>();
  if (!visibility?.showAddress || restaurant?.businessType === "private_chef" || !shouldExposeStaticTruckProfileLocation(restaurant) || quarantine.isRejected("contact_address") || (quarantine.hidePublicTrustFields && !quarantine.isAccepted("contact_address"))) ["address", "city", "state"].forEach(field => blocked.add(field));
  if (!visibility?.showContact) ["phone", "websiteUrl", "instagramUrl", "facebookPageUrl", "xUrl", "menuUrl", "onlineOrderingUrl", "deliveryUrl", "doordashUrl", "uberEatsUrl", "toastUrl", "squareUrl", "chowNowUrl", "grubhubUrl", "cateringInquiryUrl", "truckBookingInquiryUrl"].forEach(field => blocked.add(field));
  for (const [field, evidence] of [["phone", "contact_phone"], ["websiteUrl", "website_link"], ["instagramUrl", "social_instagram"], ["facebookPageUrl", "social_facebook"], ["xUrl", "social_x"]]) {
    const social = evidence.startsWith("social_");
    const rejected = social ? quarantine.isRejectedWithLegacyFallback(evidence, "social_links") : quarantine.isRejected(evidence);
    const accepted = social ? quarantine.isAcceptedWithLegacyFallback(evidence, "social_links") : quarantine.isAccepted(evidence);
    if (rejected || (quarantine.hidePublicTrustFields && !accepted)) blocked.add(field);
  }
  for (const [field, evidence] of [["logoUrl", "media_logo"], ["coverImageUrl", "media_cover"], ["gallery", "media_gallery"]]) if (quarantine.isRejected(evidence) || (quarantine.hideMedia && !quarantine.isAccepted(evidence))) blocked.add(field);
  return { publicSurface: restaurant?.isActive === true && visibility?.ownerEnabled === true, blockedProfileFields: [...blocked] };
}

const productionDependencies: OwnerAiProfileDependencies = {
  now: () => new Date(),
  async readContext(id, ownerId) { const { getOwnerAiContextForCurrentOwner } = await import("./ownerAiActions"); return getOwnerAiContextForCurrentOwner(ownerId, id); },
  async readBinding(principal) {
    const [{ db }, { apiKeys, restaurants }, { and, eq }] = await Promise.all([import("../db"), import("@shared/schema"), import("drizzle-orm")]);
    return db.transaction(async (tx: any) => {
      const [credential] = await tx.select({ id: apiKeys.id, userId: apiKeys.userId, restaurantId: apiKeys.restaurantId, purpose: apiKeys.purpose, scope: apiKeys.scope, isActive: apiKeys.isActive, expiresAt: apiKeys.expiresAt, revokedAt: apiKeys.revokedAt }).from(apiKeys).where(and(eq(apiKeys.id, principal.apiKeyId), eq(apiKeys.userId, principal.userId), eq(apiKeys.restaurantId, principal.restaurantId))).limit(1);
      const [restaurant] = await tx.select().from(restaurants).where(and(eq(restaurants.id, principal.restaurantId), eq(restaurants.ownerId, principal.userId))).limit(1);
      const { loadPublicRestaurantListingVisibility } = await import("../publicProfiles/toPublicRestaurantListingWithVisibility");
      const visibility = restaurant ? (await loadPublicRestaurantListingVisibility([restaurant], tx)).get(restaurant.ownerId) : undefined;
      const policy = deriveOwnerAiPublicationPolicy(restaurant, visibility);
      const { hasOwnerAiCompleteProfileAccess } = await import("./ownerAiActions");
      const completeProfileAccess = restaurant ? await hasOwnerAiCompleteProfileAccess(principal.userId, tx) : false;
      return { credential, restaurant: restaurant ? { ...restaurant, ...policy, completeProfileAccess } : undefined };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  },
};
const service = createOwnerAiProfileCapabilities(productionDependencies);
async function translate<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (!(error instanceof OwnerAiCapabilityError)) throw error;
    const { OwnerAiActionError } = await import("./ownerAiActions");
    throw new OwnerAiActionError(error.code === "STALE_CONTEXT" ? 409 : error.code === "INVALID_INPUT" ? 400 : 403, error.code, "Authenticated profile capability request rejected");
  }
}
export const ownerAiProfileCapabilities = {
  read: (principal: OwnerAiConnectorPrincipal) => translate(() => service.read(principal)),
  preview: (principal: OwnerAiConnectorPrincipal, request: unknown) => translate(() => service.preview(principal, request)),
};
