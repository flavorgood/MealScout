import { createHash } from "node:crypto";

type InfinityShadowResult = "sent" | "disabled" | "failed";

const EMAIL_LIKE = /(^|[^a-z0-9])[^/\s@]+@[^/\s@]+\.[^/\s@]+($|[^a-z0-9])/i;
const PHONE_LIKE =
  /(?:^|\D)(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}(?:\D|$)/;
const SAFE_ATTRIBUTION_TAG = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/i;
const SAFE_PARTNER_ID = /^[a-z0-9_-]{1,128}$/i;

function redactSensitivePathSegments(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return "_redacted";
      }
      if (EMAIL_LIKE.test(decoded) || PHONE_LIKE.test(decoded)) {
        return "_redacted";
      }
      return segment;
    })
    .join("/");
}

/**
 * Infinity receives a canonical route only. Query strings and fragments are
 * deliberately discarded so tokens, emails, phone numbers, authorization
 * codes, and unknown parameters can never cross this shadow boundary.
 */
export function sanitizeInfinityCanonicalPath(rawPath: string): string {
  try {
    const parsed = new URL(String(rawPath || "/"), "https://www.mealscout.us");
    const pathname = redactSensitivePathSegments(parsed.pathname || "/");
    return pathname.startsWith("/") ? pathname : `/${pathname}`;
  } catch {
    return "/";
  }
}

export function sanitizeInfinityAffiliateTag(value: string): string | null {
  const tag = String(value || "").trim();
  if (!SAFE_ATTRIBUTION_TAG.test(tag)) return null;
  if (EMAIL_LIKE.test(tag) || PHONE_LIKE.test(tag)) return null;
  return tag;
}

function config() {
  return {
    baseUrl: String(process.env.INFINITY_API_URL || "").replace(/\/$/, ""),
    apiKey: String(process.env.INFINITY_API_KEY || ""),
    tenantId: String(process.env.INFINITY_TENANT_ID || ""),
    programId: String(process.env.INFINITY_PROGRAM_ID || ""),
  };
}

function opaqueObjectId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

async function post(
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<InfinityShadowResult> {
  const current = config();
  if (
    !current.baseUrl ||
    !current.apiKey ||
    !current.tenantId ||
    !current.programId
  ) {
    return "disabled";
  }
  if (
    process.env.NODE_ENV === "production" &&
    !current.baseUrl.startsWith("https://")
  ) {
    console.warn(
      "[infinity-shadow] disabled: production endpoint must use HTTPS",
    );
    return "disabled";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${current.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${current.apiKey}`,
        "content-type": "application/json",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Infinity returned ${response.status}`);
    return "sent";
  } catch (error) {
    console.warn("[infinity-shadow] observation was not delivered", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

export async function mirrorInfinityTouch(input: {
  partnerId: string;
  affiliateTag: string;
  canonicalPath: string;
  carrier: "query_ref" | "path_segment";
}): Promise<InfinityShadowResult> {
  const current = config();
  const partnerId = String(input.partnerId || "").trim();
  const affiliateTag = sanitizeInfinityAffiliateTag(input.affiliateTag);
  if (!SAFE_PARTNER_ID.test(partnerId) || !affiliateTag) return "disabled";
  const canonicalPath = sanitizeInfinityCanonicalPath(input.canonicalPath);

  return post("/v1/attribution-touches", {
    programId: current.programId,
    partnerId,
    carrier: input.carrier,
    target: {
      object: {
        tenantId: current.tenantId,
        objectType: "mealscout_route",
        objectId: opaqueObjectId(canonicalPath),
      },
      canonicalPath,
    },
    evidence: {
      affiliateTag,
      source: "mealscout_referral",
    },
  });
}

export async function mirrorInfinitySignup(input: {
  partnerId: string;
  referralProofId: string;
  restaurantId: string;
}): Promise<InfinityShadowResult> {
  const current = config();
  return post(
    "/v1/conversion-evidence",
    {
      object: {
        tenantId: current.tenantId,
        objectType: "restaurant_signup",
        objectId: opaqueObjectId(input.restaurantId),
      },
      eventType: "signup_completed",
      attributionProofId: input.referralProofId,
    },
    `mealscout:signup:${input.partnerId}:${input.restaurantId}`,
  );
}
