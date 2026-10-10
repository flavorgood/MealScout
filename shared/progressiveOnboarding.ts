import { normalizeSafeInternalPath } from "./safeInternalPath";
import {
  buildRestaurantSignupPath,
  shouldRestoreBusinessSignupDraft,
  type BusinessSignupRouteIntent,
  type SignupBusinessType,
} from "./businessSignupIntent";

export type ProgressiveAccountAction = "keep_draft" | "contact" | "restricted";
export type ProgressiveAccountGate = "sign_in" | "verify_email" | "continue";

export function getProgressiveAccountAction(params: URLSearchParams): ProgressiveAccountAction | null {
  const reason = params.get("reason");
  return reason === "keep_draft" || reason === "contact" || reason === "restricted" ? reason : null;
}

export function resolveProgressiveAuthDestination(requested: unknown, fallback: unknown = "/profile-setup"): string {
  return normalizeSafeInternalPath(requested) || normalizeSafeInternalPath(fallback) || "/profile-setup";
}

export function preserveProgressiveAuthContext(href: string, source: URLSearchParams): string {
  const target = new URL(normalizeSafeInternalPath(href) || "/login", "https://mealscout.local");
  const redirect = normalizeSafeInternalPath(target.searchParams.get("redirect")) || normalizeSafeInternalPath(source.get("redirect"));
  if (redirect) target.searchParams.set("redirect", redirect);
  else target.searchParams.delete("redirect");
  const reason = getProgressiveAccountAction(target.searchParams) || getProgressiveAccountAction(source);
  if (reason) target.searchParams.set("reason", reason);
  else target.searchParams.delete("reason");
  return `${target.pathname}${target.search}${target.hash}`;
}

// This is a UI gate. Membership, ownership and transaction authority stay on the server.
export function getProgressiveAccountGate(
  user: { emailVerified?: unknown } | null | undefined,
): ProgressiveAccountGate {
  if (!user) return "sign_in";
  return user.emailVerified === true ? "continue" : "verify_email";
}

export function buildProgressiveAccountPath(
  gate: Exclude<ProgressiveAccountGate, "continue">,
  action: ProgressiveAccountAction,
  destination: unknown,
): string {
  const redirect = resolveProgressiveAuthDestination(destination);
  const params = new URLSearchParams({ redirect, reason: action });
  if (gate === "verify_email") params.set("status", "check-email");
  return `${gate === "verify_email" ? "/post-verification" : "/login"}?${params}`;
}

export function buildGuestBusinessSignupPath(
  intent: BusinessSignupRouteIntent,
  businessType: SignupBusinessType,
): string {
  return `${buildRestaurantSignupPath({
    businessType,
    intent: intent.intent,
    source: intent.source || "guest-design",
    passthrough: intent.passthrough,
  })}&keepDraft=1`;
}

const ACCOUNT_ONLY_FIELDS = new Set([
  "password", "confirmPassword", "email", "emailVerified", "token",
  "accessToken", "refreshToken", "authorization", "user", "userId", "ownerId",
  "restaurantId", "userType", "role", "membership", "subscription",
]);

export const GUEST_BUSINESS_DRAFT_KEY = "mealscout:restaurant-signup-draft";

const GUEST_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function getGuestBusinessDraftIntent(
  intent: BusinessSignupRouteIntent,
  selectedClaimListingId?: string,
): BusinessSignupRouteIntent {
  if (!intent.isClaim || !selectedClaimListingId) return intent;
  return {
    ...intent,
    passthrough: { ...intent.passthrough, claimListingId: selectedClaimListingId },
  };
}

export function shouldRestoreGuestBusinessDraft(
  intent: BusinessSignupRouteIntent,
  draft: Record<string, unknown>,
  now = Date.now(),
): boolean {
  if (!intent.isClaim) return shouldRestoreBusinessSignupDraft(intent, draft.businessType);
  const context = draft.__guestClaim as Record<string, unknown> | undefined;
  const savedAt = draft.__savedAt;
  return Boolean(
    context?.version === 1 && context.businessType === "food_truck" &&
    draft.businessType === "food_truck" &&
    typeof savedAt === "number" && Number.isFinite(savedAt) &&
    savedAt <= now && now - savedAt <= GUEST_DRAFT_MAX_AGE_MS &&
    context.listingId === (intent.passthrough.claimListingId || "") &&
    context.query === (intent.passthrough.q || ""),
  );
}

export function getGuestClaimPrefillValue(
  intent: BusinessSignupRouteIntent,
  savedDraft: Record<string, unknown> | null,
  currentValue: string,
  prefillValue: string,
  listingId?: string,
): string {
  const context = savedDraft?.__guestClaim as Record<string, unknown> | undefined;
  const sameTarget = listingId === undefined || context?.listingId === listingId;
  return savedDraft && sameTarget && shouldRestoreGuestBusinessDraft(intent, savedDraft) && currentValue.trim()
    ? currentValue
    : prefillValue;
}

export function persistGuestBusinessDraft(
  storage: Pick<Storage, "setItem"> | (() => Pick<Storage, "setItem">),
  draft: Record<string, unknown>,
  now = Date.now(),
  intent?: BusinessSignupRouteIntent,
): boolean {
  try {
    const fields = Object.fromEntries(
      Object.entries(draft).filter(([key]) => !ACCOUNT_ONLY_FIELDS.has(key)),
    );
    const target = typeof storage === "function" ? storage() : storage;
    target.setItem(
      GUEST_BUSINESS_DRAFT_KEY,
      JSON.stringify({
        ...fields,
        __savedAt: now,
        __guestClaim: intent?.isClaim ? {
          version: 1,
          businessType: intent.businessType,
          listingId: intent.passthrough.claimListingId || "",
          query: intent.passthrough.q || "",
        } : undefined,
      }),
    );
    return true;
  } catch {
    return false;
  }
}
