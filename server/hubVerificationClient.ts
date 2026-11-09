// MealScout side of verify-once (ecosystem-gaps entry 31,
// "verify once, never ask again"). Companion to hubIdentityClient.ts
// (entry 30): that client links a MealScout signup to the one shared
// TradeScout profile; this one READS the verification standing
// TradeScout holds for that profile, so a person TradeScout already
// verified is not asked to verify again on MealScout.
//
// ALREADY-LINKED ACCOUNTS ONLY — the load-bearing boundary. The read is
// keyed on users.tradescoutId, the link the SSO upsert or the hub
// resolver already recorded. A MealScout user with no tradescoutId
// returns "not_linked" and NO call is made: this client never looks
// anyone up by email, never links, never provisions. How separate
// existing accounts reconcile is entry #30's owner Decision 1, and a
// verification read must not pre-decide it through a side door.
//
// FAIL CLOSED: unconfigured env, a network error, a non-200, or a
// malformed body all read as "unknown" — never verified. Only a 200
// whose body carries businessVerified === true reads "verified". The
// function never throws: a TradeScout outage must not break a
// MealScout flow, it just means the standing could not be confirmed.
//
// SSO CLAIMS (the second, passive door): when a person arrives via
// TradeScout SSO, the TradeScout issuer carries verification_status
// and email_verified claims; the POST /api/auth/tradescout/sso handler
// in server/unifiedAuth.ts passes both into TradeScoutUserData, and
// the SSO upsert's email stamps are driven by the email_verified
// claim (stamp only when it is exactly true) — landed in the same
// release as this client, so MealScout carries TradeScout's actual
// email standing instead of assuming one.

export type TradeScoutVerification =
  | {
      status: "verified" | "not_verified";
      businessVerificationStatus: string | null;
      emailVerified: boolean;
    }
  | {
      status: "not_linked" | "unknown";
      businessVerificationStatus: null;
      emailVerified: false;
    };

const FAIL_CLOSED: TradeScoutVerification = {
  status: "unknown",
  businessVerificationStatus: null,
  emailVerified: false,
};

export async function getTradeScoutVerification(user: {
  tradescoutId?: string | null;
}): Promise<TradeScoutVerification> {
  const tsUserId = user?.tradescoutId;
  if (!tsUserId) {
    // Not linked: no call, no lookup, no decision smuggled in.
    return { status: "not_linked", businessVerificationStatus: null, emailVerified: false };
  }
  const base = process.env.TRADESCOUT_API_BASE;
  const secret = process.env.HUB_IDENTITY_SECRET;
  if (!base || !secret) return FAIL_CLOSED;
  try {
    const res = await fetch(`${base}/api/auth/hub/verification-status`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-identity-secret": secret },
      body: JSON.stringify({ tsUserId }),
    });
    if (!res.ok) return FAIL_CLOSED;
    const body: any = await res.json();
    if (!body || body.found !== true) return FAIL_CLOSED;
    return {
      status: body.businessVerified === true ? "verified" : "not_verified",
      businessVerificationStatus:
        typeof body.businessVerificationStatus === "string"
          ? body.businessVerificationStatus
          : null,
      emailVerified: body.emailVerified === true,
    };
  } catch {
    return FAIL_CLOSED;
  }
}
