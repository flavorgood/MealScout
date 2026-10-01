import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { restaurants, telemetryEvents, users } from "@shared/schema";
import { db } from "../db";
import { toPublicRestaurantProfile } from "../publicProfiles/toPublicRestaurantProfile";
import { resolvePublicProfileVisibility } from "../publicProfiles/publicProfileUtils";
import { isPublicBusinessVisible } from "../utils/publicBusinessVisibility";
import { checkPinnedPublicSource, sourceCheckUrl, type SourceCheckReceipt } from "../utils/pinnedPublicSourceCheck";

export const PUBLIC_SOURCE_CHECK_EVENT = "private_public_profile_source_check_v1";
export const PUBLIC_SOURCE_CHECK_TARGETS = Object.freeze([
  "f1ed3d1d-3ea8-4f54-85b9-af48d1d884e0",
  "f3b76054-f355-43b0-a2d3-901277748557",
  "e77ac77a-c432-42d0-ac0f-22c48b6306c9",
  "95c4e656-f3cc-46ab-ae18-53f549cecfd1",
]);
// This is the requesting user's explicit timezone, independent of marketing jobs.
export const PUBLIC_SOURCE_CHECK_TIMEZONE = "America/Chicago";
export function publicSourceCheckSchedule() {
  new Intl.DateTimeFormat("en-US", { timeZone: PUBLIC_SOURCE_CHECK_TIMEZONE }).format();
  return { expression: "0 0 * * *", timezone: PUBLIC_SOURCE_CHECK_TIMEZONE,
    targetCount: PUBLIC_SOURCE_CHECK_TARGETS.length, mode: "private_link_checks",
    publishes: false, verifiesFacts: false };
}
export function sourceCheckDay(now: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PUBLIC_SOURCE_CHECK_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export function sourceCheckId(restaurantId: string, day: string) {
  return "public-source-check-v1:" + createHash("sha256").update(`${restaurantId}:${day}`).digest("hex");
}
function validStoredCheck(row: any, restaurantId: string, ownerId?: string) {
  const p = row?.properties;
  return row?.userId == null && row?.eventName === PUBLIC_SOURCE_CHECK_EVENT
    && p?.version === 1 && p?.restaurantId === restaurantId
    && /^\d{4}-\d{2}-\d{2}$/.test(p?.day || "")
    && row.id === sourceCheckId(restaurantId, p.day) && p.complete === true
    && p.outcome === "UNVERIFIED" && p.publishes === false && p.verifiesFacts === false
    && (ownerId === undefined || p.ownerId === ownerId);
}
export function projectPublicSourceUrls(row: any, owner: any): string[] {
  if (!row || row.isActive !== true || !isPublicBusinessVisible(row) || !owner
    || owner.id !== row.ownerId || owner.isDisabled !== false) return [];
  const dto = toPublicRestaurantProfile({ row, baseUrl: "https://www.mealscout.us",
    ...resolvePublicProfileVisibility(owner.publicProfileSettings) });
  return [...new Set([dto.websiteUrl, dto.socialLinks.instagramUrl,
    dto.socialLinks.facebookPageUrl, dto.socialLinks.xUrl].map(sourceCheckUrl).filter((v): v is string => !!v))].slice(0, 4);
}
async function loadTarget(database: any, restaurantId: string, lock = false) {
  let query = database.select().from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1);
  if (lock) query = query.for("share");
  const [row] = await query;
  if (!row?.ownerId) return { row, owner: null, urls: [] as string[] };
  let ownerQuery = database.select().from(users).where(eq(users.id, row.ownerId)).limit(1);
  if (lock) ownerQuery = ownerQuery.for("share");
  const [owner] = await ownerQuery;
  return { row, owner, urls: projectPublicSourceUrls(row, owner) };
}

// This internal function accepts native restaurant-backed IDs only. There is no
// HTTP fetch/write entry point. Default cron scope is the four requested IDs.
export async function runPublicProfileSourceChecks(options: {
  restaurantIds?: readonly string[]; now?: Date; database?: any;
  check?: typeof checkPinnedPublicSource;
} = {}) {
  const database = options.database || db;
  const now = options.now || new Date(); const day = sourceCheckDay(now);
  const results: Array<{ restaurantId: string; status: string }> = [];
  const ids = [...new Set(options.restaurantIds || PUBLIC_SOURCE_CHECK_TARGETS)];
  if (ids.length > 100 || ids.some(id => !/^[0-9a-f-]{36}$/i.test(id))) throw new Error("Invalid native source-check targets");
  for (const restaurantId of ids) {
    const id = sourceCheckId(restaurantId, day);
    const status = await database.transaction(async (tx: any) => {
      const lock = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${id}, 0)) as acquired`);
      if (!(lock.rows || lock)[0]?.acquired) return "in_progress";
      const [existing] = await tx.select().from(telemetryEvents).where(eq(telemetryEvents.id, id)).limit(1);
      if (validStoredCheck(existing, restaurantId)) {
        const current = await loadTarget(tx, restaurantId);
        return existing.properties.ownerId === current.row?.ownerId ? "already_checked" : "prior_owner_check";
      }
      if (existing) throw new Error("Invalid source-check receipt collision");
      const before = await loadTarget(tx, restaurantId);
      const priorRows = await tx.select().from(telemetryEvents).where(and(
        eq(telemetryEvents.eventName, PUBLIC_SOURCE_CHECK_EVENT),
        sql`${telemetryEvents.id} like 'public-source-check-v1:%'`,
        sql`${telemetryEvents.properties}->>'restaurantId' = ${restaurantId}`))
        .orderBy(desc(telemetryEvents.createdAt)).limit(30);
      const prior = priorRows.filter((row: any) => validStoredCheck(row, restaurantId, before.row?.ownerId || ""));
      const receipts: SourceCheckReceipt[] = [];
      for (const url of before.urls) receipts.push(await (options.check || checkPinnedPublicSource)(url));
      // READ COMMITTED reload plus short shared row locks prevent saving a
      // removed/hidden link while its owner or profile changes at commit time.
      const after = await loadTarget(tx, restaurantId, true);
      const sameOwner = before.row?.ownerId === after.row?.ownerId;
      const current = sameOwner ? receipts.filter(r => after.urls.includes(r.sourceUrl)) : [];
      const compared = current.map(receipt => {
        const previous = prior.flatMap((row: any) => Array.isArray(row.properties?.receipts) ? row.properties.receipts : [])
          .find((old: SourceCheckReceipt) => old?.sourceUrl === receipt.sourceUrl && old.availability === "reachable" && /^[a-f0-9]{64}$/.test(old.bodyHash || ""));
        const changed = receipt.availability === "reachable" && receipt.bodyHash && previous
          ? receipt.bodyHash !== previous.bodyHash : null;
        return { ...receipt, bytesChanged: changed, reviewStatus: changed === true ? "REVIEW_REQUIRED" : "UNVERIFIED" };
      });
      const properties = { version: 1, restaurantId, ownerId: sameOwner ? after.row?.ownerId || null : null,
        day, checkedAt: now.toISOString(),
        timezone: PUBLIC_SOURCE_CHECK_TIMEZONE, outcome: "UNVERIFIED", complete: true,
        reason: !before.row ? "missing_native_profile" : !before.urls.length ? "no_visible_public_sources"
          : current.length !== receipts.length ? "sources_changed_during_check" : "link_checks_only",
        receipts: compared, publishes: false, verifiesFacts: false };
      await tx.insert(telemetryEvents).values({ id, eventName: PUBLIC_SOURCE_CHECK_EVENT,
        userId: null, properties, createdAt: now }).onConflictDoNothing();
      return current.length ? "checked_unverified" : "skipped";
    }, { isolationLevel: "read committed" });
    results.push({ restaurantId, status });
  }
  return { day, results };
}

export async function readPublicProfileSourceChecks(userId: string, restaurantId: string, database: any = db) {
  return database.transaction(async (tx: any) => {
    const target = await loadTarget(tx, restaurantId, true);
    if (!target.row) return { status: 404, error: "Restaurant not found" };
    if (target.row.ownerId !== userId || target.owner?.isDisabled !== false)
      return { status: 403, error: "Current actual owner required" };
    const rows = await tx.select().from(telemetryEvents)
      .where(and(eq(telemetryEvents.eventName, PUBLIC_SOURCE_CHECK_EVENT),
        sql`${telemetryEvents.id} like 'public-source-check-v1:%'`,
        sql`${telemetryEvents.properties}->>'restaurantId' = ${restaurantId}`))
      .orderBy(desc(telemetryEvents.createdAt)).limit(30);
    // Link visibility is enforced again at read time, including historical rows.
    const checks = rows.filter((row: any) => validStoredCheck(row, restaurantId, userId)).map((r: any) => ({
      day: r.properties.day, checkedAt: r.createdAt?.toISOString(), outcome: "UNVERIFIED",
      complete: true, publishes: false, verifiesFacts: false,
      reason: ["missing_native_profile", "no_visible_public_sources", "sources_changed_during_check", "link_checks_only"].includes(r.properties.reason)
        ? r.properties.reason : "link_checks_only",
      changeMeaning: "Raw response byte changes only; not verified semantic or business fact changes",
      receipts: (Array.isArray(r.properties.receipts) ? r.properties.receipts : []).slice(0, 4)
        .filter((receipt: SourceCheckReceipt) => receipt?.outcome === "UNVERIFIED" && target.urls.includes(receipt.sourceUrl))
        .map((receipt: SourceCheckReceipt & { bytesChanged?: boolean | null; reviewStatus?: string }) => ({ sourceUrl: receipt.sourceUrl,
          checkedAt: typeof receipt.checkedAt === "string" ? receipt.checkedAt.slice(0, 30) : null,
          httpStatus: Number.isInteger(receipt.httpStatus) && Number(receipt.httpStatus) >= 100 && Number(receipt.httpStatus) <= 599 ? receipt.httpStatus : null,
          bodyHash: /^[a-f0-9]{64}$/.test(receipt.bodyHash || "") ? receipt.bodyHash : null,
          byteCount: Number.isInteger(receipt.byteCount) && receipt.byteCount >= 0 && receipt.byteCount <= 512 * 1024 ? receipt.byteCount : 0,
          outcome: "UNVERIFIED", availability: receipt.availability === "reachable" ? "reachable" : "unavailable",
          bytesChanged: typeof receipt.bytesChanged === "boolean" ? receipt.bytesChanged : null,
          reviewStatus: receipt.bytesChanged === true ? "REVIEW_REQUIRED" : "UNVERIFIED",
          reason: receipt.availability === "reachable" ? "link_response_only_not_verified_facts" : "unavailable" })) }));
    return { status: 200, schedule: publicSourceCheckSchedule(), checks };
  });
}
