const OAUTH_IDENTITY_FAILURE_MESSAGES: Record<string, string> = {
  auth_account_link_required:
    "That email already belongs to a MealScout account. Sign in with its existing method; no accounts were linked or changed.",
  auth_identity_collision:
    "MealScout found conflicting account records. Sign in with your existing method or use account recovery; no accounts were linked or changed.",
  auth_account_disabled:
    "This MealScout account is disabled. Use account recovery or contact support; no account was linked or changed.",
};

export function getOAuthIdentityFailureMessage(
  errorCode: unknown,
): string | null {
  if (typeof errorCode !== "string") return null;
  const normalized = errorCode.trim().toLowerCase();
  return Object.hasOwn(OAUTH_IDENTITY_FAILURE_MESSAGES, normalized)
    ? OAUTH_IDENTITY_FAILURE_MESSAGES[normalized]
    : null;
}
