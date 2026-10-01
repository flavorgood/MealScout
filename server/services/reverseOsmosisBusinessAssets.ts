import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { ReverseOsmosisError } from "@tradescout-infinity/reverse-osmosis";
import type { BusinessAssetEvidence, ProposalInput, Scope } from "@tradescout-infinity/reverse-osmosis";
import type { SocialPublishingConnection } from "@shared/schema";
export type { SocialPublishingConnection } from "@shared/schema";

// Native provider evidence only. Shared Infinity owns business-only orchestration policy.
const GRAPH = "https://graph.facebook.com/v24.0/";
const RESPONSE_LIMIT = 64 * 1024;
const MESSAGE_LIMIT = 16 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const EVIDENCE_TTL_MS = 5 * 60_000;
const CAPTURE_TTL_MS = 24 * 60 * 60_000;
// Deliberately narrow provider-category evidence. Unknown/localized/personal Page
// categories need a separately proven connector route rather than a guessed mapping.
const FOOD_BUSINESS_CATEGORIES = new Set([
  "restaurant", "food truck", "food stand", "caterer", "bakery", "coffee shop", "cafe", "café",
]);
function fail(code: string): never { throw new ReverseOsmosisError(`reverse-osmosis:${code}`); }
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 16) return fail("connection-metadata-limit");
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(record(value)[key], depth + 1)]));
  }
  return fail("invalid-connection-metadata");
}

/** Any permission, credential, owner or provider-account change invalidates exact approval. */
export function connectionBindingRevision(connection: SocialPublishingConnection, ownerId: string): string {
  return hash(JSON.stringify(canonical({
    id: connection.id, restaurantId: connection.restaurantId,
    currentOwnerId: ownerId, createdByUserId: connection.createdByUserId,
    platform: connection.platform, externalAccountId: connection.externalAccountId,
    updatedAt: connection.updatedAt, status: connection.status,
    credentialHash: hash(JSON.stringify([connection.accessToken, connection.refreshToken, connection.tokenExpiresAt])),
    scopes: connection.scopes, metadata: connection.metadata,
  })));
}

function nativeBinding(scope: Scope, connection: SocialPublishingConnection, ownerId: string): void {
  if (!ownerId || connection.createdByUserId !== ownerId) fail("connection-owner-mismatch");
  if (scope.product !== "mealscout" || scope.ownerId !== ownerId ||
      scope.businessId !== connection.restaurantId || scope.subjectId !== connection.restaurantId ||
      scope.tenantId !== "mealscout" || scope.provider !== connection.platform || scope.accountId !== connection.externalAccountId) {
    fail("connection-scope-mismatch");
  }
  if (connection.platform !== "facebook") fail("provider-business-verification-unavailable");
  if (!connection.id || !/^\d+$/.test(connection.externalAccountId || "") ||
      connection.status !== "active" || !connection.accessToken) fail("connection-inactive");
  if (connection.accessToken.length > 10_000 || !connection.updatedAt) fail("connection-unverified");
  if (connection.tokenExpiresAt && (!Number.isFinite(connection.tokenExpiresAt.getTime()) ||
      connection.tokenExpiresAt.getTime() <= Date.now())) fail("connection-token-expired");
  // Metadata is only a consistency check: the manual connector can store user-supplied JSON.
  const metadata = record(connection.metadata);
  if (metadata.provider !== "meta" || metadata.pageId !== connection.externalAccountId) fail("connection-page-mismatch");
}

async function providerRead(path: string, params: Record<string, string>, bearer: string): Promise<{ data: Record<string, unknown>; raw: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new ReverseOsmosisError("reverse-osmosis:provider-timeout")); }, FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const url = new URL(path, GRAPH);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const response = await fetch(url, {
        method: "GET", headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
        redirect: "error", signal: controller.signal,
      });
      if (!response.ok) fail("provider-verification-failed");
      const length = response.headers.get("content-length");
      if (length && Number(length) > RESPONSE_LIMIT) fail("provider-response-limit");
      if (!response.body) fail("provider-response-invalid");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > RESPONSE_LIMIT) fail("provider-response-limit");
          chunks.push(next.value);
        }
      } finally { void reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || record(parsed).error) fail("provider-response-invalid");
      return { data: record(parsed), raw };
    })()]);
  } catch (error) {
    // Provider bodies, URLs and thrown transport errors may contain credentials. Never propagate them.
    if (error instanceof ReverseOsmosisError) throw error;
    return fail("provider-verification-failed");
  } finally { if (timer) clearTimeout(timer); controller.abort(); }
}

function providerExpiry(value: unknown, now: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail("provider-expiry-unverified");
  if (value === 0) return now + EVIDENCE_TTL_MS;
  if (value * 1000 <= now) fail("provider-token-expired");
  return value * 1000;
}

export async function verifyMealScoutBusinessAsset(
  proposal: ProposalInput, connection: SocialPublishingConnection, ownerId: string,
): Promise<BusinessAssetEvidence> {
  nativeBinding(proposal.scope, connection, ownerId);
  const initialBinding = connectionBindingRevision(connection, ownerId);
  const initialScope = JSON.stringify(proposal.scope);
  const appId = process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.FACEBOOK_APP_SECRET;
  if (!appId || !appSecret) fail("provider-verification-not-configured");
  const requiredScope = proposal.direction === "native-to-social" ? "pages_manage_posts" : "pages_read_engagement";
  const me = (await providerRead("me", { fields: "id,category,tasks" }, connection.accessToken!)).data;
  if (me.id !== connection.externalAccountId || typeof me.category !== "string" ||
      !FOOD_BUSINESS_CATEGORIES.has(me.category.trim().toLowerCase())) fail("provider-page-unverified");
  const tasks = me.tasks;
  if (!Array.isArray(tasks) || !tasks.includes("MANAGE") ||
      (proposal.direction === "native-to-social" && !tasks.includes("CREATE_CONTENT"))) fail("provider-page-authority-unverified");
  const debug = record((await providerRead("debug_token", { input_token: connection.accessToken! }, `${appId}|${appSecret}`)).data.data);
  if (debug.is_valid !== true || debug.type !== "PAGE" || debug.profile_id !== connection.externalAccountId ||
      debug.app_id !== appId || typeof debug.user_id !== "string" || !/^\d+$/.test(debug.user_id)) fail("provider-token-unverified");
  if (!Array.isArray(debug.scopes) || !debug.scopes.includes(requiredScope)) fail("provider-permission-missing");
  // Some token types omit granular targets; PAGE + profile_id + Page /me binds the exact asset.
  // If targets are supplied, do not ignore an explicit denial of the selected Page.
  if (debug.granular_scopes !== undefined) {
    if (!Array.isArray(debug.granular_scopes)) fail("provider-permission-unverified");
    for (const item of debug.granular_scopes) {
      const granular = record(item);
      if (granular.scope === requiredScope && granular.target_ids !== undefined &&
          (!Array.isArray(granular.target_ids) || !granular.target_ids.includes(connection.externalAccountId))) fail("provider-permission-wrong-page");
    }
  }
  if (proposal.direction === "native-to-social") await publicPageVisibilityHash(connection);
  const now = Date.now();
  const expiresAt = Math.min(now + EVIDENCE_TTL_MS,
    providerExpiry(debug.expires_at, now), providerExpiry(debug.data_access_expires_at, now),
    connection.tokenExpiresAt?.getTime() ?? Infinity);
  if (connectionBindingRevision(connection, ownerId) !== initialBinding ||
      JSON.stringify(proposal.scope) !== initialScope) fail("connection-changed-during-verification");
  return {
    scope: { ...proposal.scope }, assetKind: "business-page", providerVerified: true,
    ownerAuthorized: true, revoked: false, verifiedAt: now, expiresAt,
    providerAssetId: connection.externalAccountId!, nativeBusinessId: connection.restaurantId,
    nativeSubjectId: connection.restaurantId, authorizedOwnerId: ownerId,
    bindingRevision: initialBinding,
  };
}

function publicHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
        url.port || isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".") ||
        /(^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(host) ||
        host.endsWith(".")) return undefined;
    if ([...url.searchParams.keys()].some(key => /(?:token|secret|password|signature|credential|api[_-]?key|expires?)/i.test(key))) return undefined;
    return url.href;
  } catch { return undefined; }
}

function extractMenu(message: string): { profile: { menuUrl?: string }; holds: string[] } {
  const holds: string[] = [];
  // Only one standalone explicit label is actionable; the connector never synthesizes facts.
  const labels = message.match(/^\s*menu\s*:\s*(\S+)\s*$/gim) || [];
  const mentions = message.match(/\bmenu\s*:/gi) || [];
  if (labels.length !== 1 || mentions.length !== 1) holds.push("menu-source-ambiguous");
  const url = labels.length === 1 ? publicHttpUrl(labels[0]!.replace(/^\s*menu\s*:\s*/i, "").trim()) : undefined;
  if (labels.length === 1 && !url) holds.push("menu-url-unsafe");
  // Until richer native source-review semantics exist, prose beyond the exact label
  // may qualify availability, privacy or dates in ways a keyword matcher cannot prove.
  if (labels.length === 1 && message.replace(labels[0]!, "").trim()) holds.push("additional-source-content-review-required");
  if (/\b(today|tonight|tomorrow|yesterday|this\s+(week|weekend)|next\s+(week|month)|until|through|expires?|valid|effective|temporary|seasonal|limited|specials?|sale|discount|offer|no longer|old menu|outdated|previous menu|archived)\b|\b\d{1,4}[/-]\d{1,2}(?:[/-]\d{1,4})?\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i.test(message)) holds.push("dated-source-review-required");
  if (/[$€£]|\b(?:price|cost|\d+(?:\.\d{2})?\s*(?:usd|dollars?|each))\b/i.test(message)) holds.push("price-source-review-required");
  if (/\b(?:private|invite[ -]?only|members[ -]?only|reservation|wedding|catering|closed|sold[ -]?out|cancel(?:led|ed)|event)\b/i.test(message)) holds.push("private-event-source-review-required");
  return { profile: holds.length || !url ? {} : { menuUrl: url }, holds };
}

export interface CapturedMealScoutBusinessPost {
  sourceUrl: string;
  capturedAt: number;
  expiresAt: number;
  sourceVersion: string;
  providerBodyHash: string;
  bodyHash: string;
  publicProofHash: string;
  providerPostId: string;
  providerCreatedAt: string;
  providerUpdatedAt: string;
  profile: { menuUrl?: string };
  holds: string[];
}

function requirePublicPost(post: Record<string, unknown>): void {
  // Meta Page Post reference: targeting limits visibility; feed_targeting selects
  // audiences independently of privacy. Published status alone is not public proof.
  const privacy = record(post.privacy);
  if (privacy.value !== "EVERYONE" || Object.keys(privacy).some(key =>
      !["value", "description", "allow", "deny", "friends", "networks"].includes(key)) ||
      ["allow", "deny", "friends", "networks"].some(key =>
        privacy[key] !== undefined && privacy[key] !== "")) fail("post-public-privacy-unverified");
  for (const field of ["targeting", "feed_targeting"]) {
    const value = post[field];
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) {
      fail("post-public-audience-unverified");
    }
  }
  if (post.is_hidden !== false || post.is_expired !== false ||
      (post.scheduled_publish_time !== null && post.scheduled_publish_time !== 0)) fail("post-public-visibility-unverified");
}

async function publicPageVisibilityHash(connection: SocialPublishingConnection): Promise<string> {
  // Page settings are provider-authenticated separately: a public post's targeting
  // does not override Page-level demographic restrictions. Never treat omitted
  // settings, null, an empty country whitelist or token access as public evidence.
  const settings = await providerRead(`${connection.externalAccountId}/settings`, { fields: "setting,value" }, connection.accessToken!);
  if (!Array.isArray(settings.data.data)) fail("page-public-visibility-unverified");
  const required = ["IS_PUBLISHED", "AGE_RESTRICTIONS", "COUNTRY_RESTRICTIONS"];
  const values = new Map<string, unknown>();
  for (const item of settings.data.data) {
    const setting = record(item);
    if (typeof setting.setting !== "string") fail("page-public-visibility-unverified");
    if (!required.includes(setting.setting)) {
      if (/RESTRICT|PRIVACY|VISIBILITY|AUDIENCE/.test(setting.setting)) fail("page-public-visibility-unverified");
      continue;
    }
    if (values.has(setting.setting)) fail("page-public-visibility-unverified");
    values.set(setting.setting, setting.value);
  }
  const country = record(values.get("COUNTRY_RESTRICTIONS"));
  if (values.get("IS_PUBLISHED") !== true || values.get("AGE_RESTRICTIONS") !== "Public" ||
      country.restriction_type !== "blacklist" || !Array.isArray(country.countries) || country.countries.length ||
      Object.keys(country).some(key => !["restriction_type", "countries"].includes(key))) fail("page-public-visibility-unverified");
  return hash(settings.raw);
}

/** Always re-fetch this exact endpoint before apply and compare sourceVersion. No caller text accepted. */
export async function captureMealScoutBusinessPost(
  proposalScope: Scope, connection: SocialPublishingConnection, ownerId: string, postId: string,
): Promise<CapturedMealScoutBusinessPost> {
  nativeBinding(proposalScope, connection, ownerId);
  const initialBinding = connectionBindingRevision(connection, ownerId);
  const initialScope = JSON.stringify(proposalScope);
  if (!new RegExp(`^${connection.externalAccountId}_[0-9]+$`).test(postId)) fail("post-page-mismatch");
  await verifyMealScoutBusinessAsset({
    scope: proposalScope, direction: "social-to-native", eventId: postId,
    sourceVersion: "provider-capture", expectedNativeVersion: "provider-capture", fields: {},
  }, connection, ownerId);
  const { data: post, raw } = await providerRead(postId, {
    fields: "id,message,from,permalink_url,updated_time,created_time,is_published,privacy,targeting,feed_targeting,is_hidden,is_expired,scheduled_publish_time",
  }, connection.accessToken!);
  if (post.id !== postId || record(post.from).id !== connection.externalAccountId || post.is_published !== true) fail("post-author-unverified");
  requirePublicPost(post);
  if (typeof post.message !== "string" || post.message.length > MESSAGE_LIMIT) fail("post-message-unverified");
  if (typeof post.created_time !== "string" || typeof post.updated_time !== "string" ||
      !Number.isFinite(Date.parse(post.created_time)) || !Number.isFinite(Date.parse(post.updated_time)) ||
      Date.parse(post.updated_time) < Date.parse(post.created_time) || Date.parse(post.updated_time) > Date.now() + 60_000) fail("post-timestamp-unverified");
  const sourceUrl = typeof post.permalink_url === "string" ? publicHttpUrl(post.permalink_url) : undefined;
  if (!sourceUrl || !["facebook.com", "www.facebook.com", "m.facebook.com"].includes(new URL(sourceUrl).hostname)) fail("post-permalink-unverified");
  const publicProofHash = hash(JSON.stringify(canonical({
    pageSettingsBodyHash: await publicPageVisibilityHash(connection),
    postVisibility: {
      privacy: post.privacy, targeting: post.targeting, feed_targeting: post.feed_targeting,
      is_hidden: post.is_hidden, is_expired: post.is_expired,
      scheduled_publish_time: post.scheduled_publish_time, is_published: post.is_published,
    },
  })));
  const capturedAt = Date.now();
  if (connectionBindingRevision(connection, ownerId) !== initialBinding ||
      JSON.stringify(proposalScope) !== initialScope) fail("connection-changed-during-capture");
  const bodyHash = hash(raw);
  const sourceVersion = hash(JSON.stringify({ bodyHash, publicProofHash }));
  return {
    sourceUrl, capturedAt, expiresAt: capturedAt + CAPTURE_TTL_MS, sourceVersion,
    providerBodyHash: bodyHash, bodyHash, publicProofHash, providerPostId: postId,
    providerCreatedAt: post.created_time, providerUpdatedAt: post.updated_time,
    ...extractMenu(post.message),
  };
}
