// MealScout side of the one-shared-identity conversion
// (ecosystem-gaps entry 30).
//
// A native MealScout signup creates a MealScout users row with
// tradescoutId = NULL; this client is called by the three register
// handlers in server/unifiedAuth.ts (customer, restaurant, supplier)
// immediately after their upsertUserByAuth("email", ...) insert so the
// same signup creates/resolves the ONE shared profile on TradeScout
// and stamps the returned id into users.tradescoutId — the exact
// column and semantics the existing SSO upsert already uses.
//
// Non-fatal on purpose: a TradeScout outage must not fail a MealScout
// signup; the backfill script (scripts/backfill-tradescout-id.ts) is
// the safety net and re-runs the same rule. Inert until
// TRADESCOUT_API_BASE + HUB_IDENTITY_SECRET are configured.

export interface HubLinkUser {
  id: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  tradescoutId?: string | null;
}

export async function linkHubSignupToSharedProfile(user: HubLinkUser): Promise<void> {
  const base = process.env.TRADESCOUT_API_BASE;
  const secret = process.env.HUB_IDENTITY_SECRET;
  if (!base || !secret || !user.email) return; // unconfigured = today's behavior
  const res = await fetch(`${base}/api/auth/hub/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-identity-secret": secret },
    body: JSON.stringify({
      hub: "mealscout",
      hubUserId: user.id,
      email: user.email,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      phone: user.phone ?? null,
      existingLinkTsId: user.tradescoutId ?? null,
    }),
  });
  if (res.status === 409) {
    // Genuine duplicate-account conflict. Do NOT invent a merge: leave
    // tradescoutId NULL and surface for the owner decision in SCOPE.md.
    console.error("[hub-identity] conflict for MealScout user", user.id);
    return;
  }
  if (!res.ok) throw new Error(`hub resolve failed: ${res.status}`);
  const body: any = await res.json();
  if (body.tsUserId && body.tsUserId !== user.tradescoutId) {
    const { storage } = await import("./storage");
    await (storage as any).setUserTradescoutId(user.id, body.tsUserId);
    // setUserTradescoutId landed with this client (server/storage.ts +
    // server/storage/usersRepository.ts): it stamps users.tradescoutId.
  }
}
