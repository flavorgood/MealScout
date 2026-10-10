import { normalizeSafeInternalPath } from "./safeInternalPath";
import {
  buildRestaurantSignupPath,
  type BusinessSignupRouteIntent,
  type SignupBusinessType,
} from "./businessSignupIntent";

export type ProgressiveAccountAction = "keep_draft" | "contact" | "restricted";
export type ProgressiveAccountGate = "sign_in" | "verify_email" | "continue";

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
  const redirect = normalizeSafeInternalPath(destination) || "/profile-setup";
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

export function persistGuestBusinessDraft(
  storage: Pick<Storage, "setItem"> | (() => Pick<Storage, "setItem">),
  draft: Record<string, unknown>,
  now = Date.now(),
): boolean {
  try {
    const fields = Object.fromEntries(
      Object.entries(draft).filter(([key]) => !ACCOUNT_ONLY_FIELDS.has(key)),
    );
    const target = typeof storage === "function" ? storage() : storage;
    target.setItem(
      GUEST_BUSINESS_DRAFT_KEY,
      JSON.stringify({ ...fields, __savedAt: now }),
    );
    return true;
  } catch {
    return false;
  }
}
