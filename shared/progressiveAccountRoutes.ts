import { normalizeSafeInternalPath } from "./safeInternalPath";
import { buildProgressiveAccountPath, getProgressiveAccountGate } from "./progressiveOnboarding";

// Known private account/owner routes, excluding the new private menu designer.
// This is an account UI boundary; every page/API still checks its own entitlement.
export const PROGRESSIVE_RESTRICTED_ROUTES = [
  "/dashboard", "/favorites", "/owner/ecosystem-sharing/:sourceId", "/restaurant-owner-dashboard",
  "/restaurant/dashboard", "/deal-edit/:dealId", "/subscribe", "/host/dashboard",
  "/event-coordinator/dashboard", "/truck-discovery", "/supply/orders", "/orders",
  "/merchant-promotions", "/profile", "/profile/notifications", "/settings",
  "/profile/addresses", "/profile/payment", "/profile/help", "/profile/reporter-reputation",
  "/supplier/dashboard", "/affiliate/earnings", "/parking-pass-manage", "/business-team",
  "/owner-ai", "/owner-ai/authorize", "/kitchen",
] as const;

export function isProgressiveRestrictedPath(location: unknown): boolean {
  const path = normalizeSafeInternalPath(location)?.split(/[?#]/)[0]?.replace(/\/$/, "");
  if (!path) return false;
  const actual = path.split("/");
  return PROGRESSIVE_RESTRICTED_ROUTES.some(pattern => {
    const expected = pattern.split("/");
    return actual.length === expected.length && expected.every((part, index) => part.startsWith(":") ? Boolean(actual[index]) : part === actual[index]);
  });
}

export function isProgressiveContactHref(href: unknown): boolean {
  if (typeof href !== "string") return false;
  const value = href.trim();
  if (/^(?:mailto|tel|sms):/i.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["wa.me", "api.whatsapp.com", "m.me"].includes(url.hostname.toLowerCase());
  } catch { return false; }
}

// An auth continuation returns to the page, never to a pending contact action.
export function getProgressiveContactGatePath(
  user: { emailVerified?: unknown } | null | undefined,
  contactHref: unknown,
  destination: unknown,
): string | null {
  if (!isProgressiveContactHref(contactHref)) return null;
  const gate = getProgressiveAccountGate(user);
  return gate === "continue" ? null : buildProgressiveAccountPath(gate, "contact", destination);
}
