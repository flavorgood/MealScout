import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { restaurants, telemetryEvents } from "@shared/schema";
import { resolveStoredFoodBusinessType } from "@shared/businessTypes";
import { ownerAiActionPacketSchema } from "@shared/ownerAiActions";
import { canonicalSourceSection } from "@shared/ownerAiSourceFacts";
import { db } from "../db";
import { sourceCheckDay, PUBLIC_SOURCE_CHECK_TIMEZONE } from "./publicProfileSourceChecks";
import { assertSourceFactAuthority, captureOfficialSource, loadSourceFactAuthority, proposeOwnerAiSourceFacts } from "./ownerAiSourceFacts";
import { assertActualRestaurantOwner, computeOwnerAiExpectedVersions, createOwnerAiDraft, OwnerAiActionError } from "./ownerAiActions";

export const OWNER_AI_SOURCE_REVIEW_EVENT = "private_owner_ai_source_review_v1";
export const ownerAiSourceReviewSchedule = () => ({ expression: "0 0 * * *", timezone: PUBLIC_SOURCE_CHECK_TIMEZONE,
  mode: "private_semantic_proposals", scope: "active_public_native_food_profiles", createsOwnerDrafts: false, publishes: false, approvalRequired: true });
export const ownerAiSourceReviewId = (restaurantId: string, day: string) => "owner-source-review-v1:" + createHash("sha256").update(`${restaurantId}:${day}`).digest("hex");
const reviewHash = (properties: any) => createHash("sha256").update(canonicalSourceSection(properties)).digest("hex");
function validReview(row: any, restaurantId: string, ownerId?: string) {
  const p = row?.properties;
  if (!p || typeof p !== "object" || Array.isArray(p)) return false;
  const { integritySha256, ...observation } = p;
  if (integritySha256 !== reviewHash(observation) || !Array.isArray(p.sourceUrls) || p.sourceUrls.length > 4
    || p.sourceUrls.some((v: any) => typeof v !== "string" || !v.startsWith("https://"))
    || !p.proposal || p.proposal.mutationPerformed !== false || p.proposal.approvalRequired !== true || p.proposal.canApply !== false
    || !Array.isArray(p.proposal.holds) || p.proposal.holds.some((v: any) => typeof v !== "string")) return false;
  if (p.proposal.packet !== null && (!p.proposal.packet?.sourceFacts || !ownerAiActionPacketSchema.safeParse(p.proposal.packet).success)) return false;
  return row?.userId == null && row?.eventName === OWNER_AI_SOURCE_REVIEW_EVENT && p?.version === 1 && p.complete === true
    && p.restaurantId === restaurantId && /^\d{4}-\d{2}-\d{2}$/.test(p.day || "")
    && row.id === ownerAiSourceReviewId(restaurantId, p.day) && p.publishes === false && p.createsOwnerDrafts === false
    && (ownerId === undefined || p.ownerId === ownerId);
}

// A server observation is never recorded as owner authentication or approval.
// Network reads are bounded by the existing safe fetcher; the per-profile lock
// deduplicates concurrent schedulers/retries without changing canonical content.
export async function runOwnerAiSourceReviews(options: { restaurantIds?: readonly string[]; now?: Date; database?: any; capture?: typeof captureOfficialSource } = {}) {
  const database = options.database || db, now = options.now || new Date(), day = sourceCheckDay(now);
  const results: Array<{ restaurantId: string; status: string }> = [];
  const run = async (restaurantId: string) => {
    const id = ownerAiSourceReviewId(restaurantId, day);
    try {
      const status = await database.transaction(async (tx: any) => {
        const lock = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${id}, 0)) as acquired`);
        if (!(lock.rows || lock)[0]?.acquired) return "in_progress";
        const [row] = await tx.select({ ownerId: restaurants.ownerId }).from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1);
        if (!row?.ownerId) return "missing_profile";
        const [existing] = await tx.select().from(telemetryEvents).where(eq(telemetryEvents.id, id)).limit(1);
        if (validReview(existing, restaurantId)) return existing.properties.ownerId === row.ownerId ? "already_reviewed" : "prior_owner_review";
        if (existing) throw new Error("SOURCE_REVIEW_RECEIPT_COLLISION");
        const authority = await loadSourceFactAuthority(restaurantId, row.ownerId, tx);
        const proposal = await proposeOwnerAiSourceFacts(restaurantId, row.ownerId, { database: tx, capture: options.capture });
        const current = await loadSourceFactAuthority(restaurantId, row.ownerId, tx, true);
        if (JSON.stringify([...authority.urls].sort()) !== JSON.stringify([...current.urls].sort())) throw new Error("SOURCE_FACT_OFFICIAL_SOURCE_SET_CHANGED");
        if (proposal.packet) assertSourceFactAuthority(proposal.packet, current);
        const observation = { version: 1, restaurantId, ownerId: row.ownerId, day, complete: true, checkedAt: new Date().toISOString(),
          sourceUrls: [...current.urls].sort(), proposal, createsOwnerDrafts: false, publishes: false };
        await tx.insert(telemetryEvents).values({ id, eventName: OWNER_AI_SOURCE_REVIEW_EVENT, userId: null, createdAt: now,
          properties: { ...observation, integritySha256: reviewHash(observation) } }).onConflictDoNothing();
        return proposal.packet ? "proposal_ready" : "held";
      }, { isolationLevel: "read committed" });
      results.push({ restaurantId, status });
    } catch { results.push({ restaurantId, status: "held_authority_or_capture_changed" }); }
  };
  if (options.restaurantIds) {
    const ids = [...new Set(options.restaurantIds)];
    if (ids.length > 1000 || ids.some(id => !/^[0-9a-f-]{36}$/i.test(id))) throw new Error("Invalid native source-review targets");
    for (const id of ids) await run(id);
  } else {
    // Page the existing native table; no new paid scheduler or grant is needed.
    let cursor = "";
    for (;;) {
      const rows = await database.select({ id: restaurants.id, businessType: restaurants.businessType, isFoodTruck: restaurants.isFoodTruck }).from(restaurants)
        .where(and(eq(restaurants.isActive, true), gt(restaurants.id, cursor))).orderBy(asc(restaurants.id)).limit(100);
      if (!rows.length) break;
      for (const row of rows) if (resolveStoredFoodBusinessType(row)) await run(row.id);
      cursor = rows[rows.length - 1].id;
    }
  }
  return { day, results, createsOwnerDrafts: false, publishes: false };
}

export async function readOwnerAiSourceReviews(userId: string, restaurantId: string, database: any = db) {
  let authority;
  try { authority = await loadSourceFactAuthority(restaurantId, userId, database); }
  catch { throw new OwnerAiActionError(403, "SOURCE_REVIEW_OWNER_REQUIRED", "Current owner of an active public food profile required"); }
  const rows = await database.select().from(telemetryEvents).where(and(eq(telemetryEvents.eventName, OWNER_AI_SOURCE_REVIEW_EVENT),
    sql`${telemetryEvents.id} like 'owner-source-review-v1:%'`, sql`${telemetryEvents.properties}->>'restaurantId' = ${restaurantId}`))
    .orderBy(desc(telemetryEvents.createdAt)).limit(30);
  const reviews = rows.filter((r: any) => validReview(r, restaurantId, userId)
    && JSON.stringify(r.properties.sourceUrls) === JSON.stringify([...authority.urls].sort())).map((r: any) => {
      const proposal = r.properties.proposal;
      let packet = proposal?.packet || null;
      const holds = Array.isArray(proposal?.holds) ? proposal.holds.filter((h: any) => typeof h === "string") : [];
      if (packet) try { assertSourceFactAuthority(packet, authority); } catch { packet = null; holds.push("SOURCE_REVIEW_EXPIRED_OR_VISIBILITY_CHANGED"); }
      return { day: r.properties.day, checkedAt: r.properties.checkedAt, packet, holds, approvalRequired: true, canApply: false };
    });
  // Repeat the authority read so removed links or ownership changes during the
  // receipt query cannot disclose historical evidence to a different owner.
  const current = await loadSourceFactAuthority(restaurantId, userId, database);
  if (JSON.stringify([...authority.urls].sort()) !== JSON.stringify([...current.urls].sort()) || JSON.stringify(authority.blockedFields) !== JSON.stringify(current.blockedFields)) return { schedule: ownerAiSourceReviewSchedule(), reviews: [] };
  return { schedule: ownerAiSourceReviewSchedule(), reviews };
}

export async function createOwnerAiOfficialSourceDraft(userId: string, restaurantId: string) {
  await assertActualRestaurantOwner(userId, restaurantId);
  const expectedVersions = await computeOwnerAiExpectedVersions(restaurantId);
  let proposal;
  try { proposal = await proposeOwnerAiSourceFacts(restaurantId, userId); }
  catch { throw new OwnerAiActionError(409, "SOURCE_FACT_HOLD", "Official sources or owner visibility changed; refresh before preparing a draft"); }
  if (!proposal.packet) return { draft: null, holds: proposal.holds, approvalRequired: true, canonicalMutationPerformed: false };
  const draft = await createOwnerAiDraft({ restaurantId, createdByUserId: userId, request: { packet: proposal.packet, expectedVersions } });
  return { draft, holds: proposal.holds, approvalRequired: true, canonicalMutationPerformed: false };
}
