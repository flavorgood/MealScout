import { buildOwnerAiMediaManifest, validateAndPrepareRemoteImage } from "./ownerAiActions";
import { fetchOwnerAiRemoteImagePreview } from "../imageUpload";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { hosts, suppliers, users, ownerAiNativeProfileDrafts, telemetryEvents } from "@shared/schema";
import { ownerAiActionPacketSchema } from "@shared/ownerAiActions";
import { canonicalSourceSection, assertOwnerAiSourceFactBindings, type OwnerAiSourceFact } from "@shared/ownerAiSourceFacts";
import { db } from "../db";
import { resolvePublicProfileVisibility } from "../publicProfiles/publicProfileUtils";
import { isPublicBusinessVisible } from "../utils/publicBusinessVisibility";
import { sourceCheckUrl } from "../utils/pinnedPublicSourceCheck";
import { captureOfficialSource, extractOfficialSourceFacts, assertSourceFactAuthority } from "./ownerAiSourceFacts";
import { sourceCheckDay } from "./publicProfileSourceChecks";

export type NativeProfileKind = "host" | "supplier";
export const NATIVE_SOURCE_REVIEW_EVENT = "private_owner_ai_native_source_review_v1";
const sha = (value: unknown) => createHash("sha256").update(canonicalSourceSection(value)).digest("hex");
const fields = {
  host: { name: "businessName", phone: "contactPhone", websiteUrl: "websiteUrl", instagramUrl: "instagramUrl", facebookPageUrl: "facebookPageUrl", xUrl: "xUrl", logoUrl: "logoUrl", coverImageUrl: "coverImageUrl" },
  supplier: { name: "businessName", phone: "contactPhone", websiteUrl: "websiteUrl", logoUrl: "logoUrl" },
} as const;
export class NativeProfileDraftError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const fail = (code: string, status = 409): never => { throw new NativeProfileDraftError(status, code); };
export function nativeProfileKind(value: unknown): NativeProfileKind {
  if (value === "host" || value === "location") return "host";
  if (value === "supplier") return "supplier";
  return fail("UNSUPPORTED_NATIVE_PROFILE", 400);
}
const tableFor = (kind: NativeProfileKind) => kind === "host" ? hosts : suppliers;
function content(kind: NativeProfileKind, row: any) {
  return Object.fromEntries(Object.entries(fields[kind]).map(([field, column]) => [field, row[column] ?? null]));
}
// Same admission and owner contact visibility used by the actual public routes.
async function authority(kind: NativeProfileKind, id: string, ownerId: string, database: any, lock = false) {
  const table = tableFor(kind);
  let rq = database.select().from(table).where(and(eq(table.id, id), eq(table.userId, ownerId))).limit(1);
  if (lock) rq = rq.for("update");
  const [row] = await rq;
  let uq = database.select().from(users).where(eq(users.id, ownerId)).limit(1);
  if (lock) uq = uq.for("share");
  const [owner] = await uq;
  if (!row || owner?.isDisabled !== false) return fail("CURRENT_NATIVE_OWNER_REQUIRED", 403);
  if ((kind === "supplier" && row.isActive !== true) || !isPublicBusinessVisible({ name: row.businessName, city: row.city, state: row.state })) return fail("PUBLIC_NATIVE_PROFILE_REQUIRED", 403);
  const visibility = resolvePublicProfileVisibility(owner.publicProfileSettings);
  const contactFields = ["phone", "websiteUrl", "instagramUrl", "facebookPageUrl", "xUrl"];
  const urls = visibility.showContact ? [...new Set([row.websiteUrl, ...(kind === "host" ? [row.instagramUrl, row.facebookPageUrl, row.xUrl] : [])].map(sourceCheckUrl).filter((v): v is string => !!v))].sort() : [];
  const snapshot = content(kind, row);
  // Include the actual row, ownership and publication policy. A timestamp alone
  // cannot detect an out-of-band native edit or transfer.
  return { row, owner, snapshot, urls, blockedFields: visibility.showContact ? [] : contactFields,
    version: sha({ kind, id, ownerId, row: JSON.parse(JSON.stringify(row)), visibility }) };
}
function parsePacket(kind: NativeProfileKind, raw: unknown) {
  const packet = ownerAiActionPacketSchema.parse(raw);
  if (!packet.profile || !Object.keys(packet.profile).length || packet.hours || packet.menus || packet.schedules || packet.deals || packet.social || packet.settings) return fail("NATIVE_CONTENT_FIELDS_ONLY", 400);
  if (Object.keys(packet.profile).some(k => !(k in fields[kind]))) return fail("UNSUPPORTED_NATIVE_CONTENT_FIELD", 400);
  if (packet.sourceFacts && packet.sourceFacts.version !== 1) return fail("NATIVE_SOURCE_SECTIONS_UNSUPPORTED", 400);
  return packet;
}
function assertPacket(packet: any, current: Awaited<ReturnType<typeof authority>>) {
  if (Object.keys(packet.profile).some(k => current.blockedFields.includes(k))) return fail("CONTENT_FIELD_NOT_PUBLIC");
  if (packet.profile.name && !isPublicBusinessVisible({ name: packet.profile.name, city: current.row.city, state: current.row.state })) return fail("PUBLIC_NATIVE_PROFILE_REQUIRED");
  if (packet.sourceFacts) {
    try { assertSourceFactAuthority(packet, current); }
    catch (error) { return fail(error instanceof Error && /^SOURCE_FACT_/.test(error.message) ? error.message : "SOURCE_FACT_HOLD"); }
  }
}
async function observe(kind: NativeProfileKind, current: Awaited<ReturnType<typeof authority>>, capture = captureOfficialSource) {
  const all: OwnerAiSourceFact[] = [], holds: string[] = [];
  if (!current.urls.length) holds.push("MISSING_OFFICIAL_SOURCE");
  for (const url of current.urls) {
    try {
      const extracted = extractOfficialSourceFacts(await capture(url));
      all.push(...extracted.fields);
      // Menu/schedule qualifications belong to food adapters, not host booking
      // capacity or supplier purchasing authority.
      holds.push(...extracted.holds.filter(h => !h.endsWith("REQUIRE_SEPARATE_VERIFICATION")));
    } catch { holds.push("SOURCE_UNAVAILABLE"); }
  }
  const selected: OwnerAiSourceFact[] = [];
  for (const path of new Set(all.map(f => f.path))) {
    const field = path.split(".")[1];
    if (!(field in fields[kind])) { holds.push("UNSUPPORTED_NATIVE_SOURCE_FIELD"); continue; }
    const candidates = all.filter(f => f.path === path);
    if (new Set(candidates.map(f => f.value)).size !== 1 || holds.includes("CONFLICT:" + path)) { holds.push("CONFLICT:" + path); continue; }
    if (!current.blockedFields.includes(field)) selected.push(candidates[0]);
  }
  if (!selected.length && current.urls.length) holds.push("NO_SUPPORTED_PUBLIC_CONTENT_FACTS");
  // An unavailable configured source may contain a contradictory value.
  const packet = selected.length && !holds.includes("SOURCE_UNAVAILABLE") ? parsePacket(kind, { schemaVersion: "1.0", intent: "Review content explicitly supplied by official public sources", profile: Object.fromEntries(selected.map(f => [f.path.split(".")[1], f.value])), sourceFacts: { version: 1, officialSources: current.urls, fields: selected } }) : null;
  return { packet, holds: [...new Set(holds)], mutationPerformed: false, approvalRequired: true, canApply: false };
}
async function verifySource(kind: NativeProfileKind, id: string, ownerId: string, packet: any, database: any) {
  if (!packet.sourceFacts) return;
  const before = await authority(kind, id, ownerId, database);
  assertPacket(packet, before);
  const result = await observe(kind, before);
  if (!result.packet || result.holds.some(h => packet.sourceFacts.fields.some((f: OwnerAiSourceFact) => h === "CONFLICT:" + f.path))) return fail("SOURCE_FACT_CHANGED_OR_UNAVAILABLE");
  for (const fact of packet.sourceFacts.fields) {
    if (!result.packet.sourceFacts?.fields.some(f => f.path === fact.path && f.value === fact.value && f.sourceUrl === fact.sourceUrl)) return fail("SOURCE_FACT_CHANGED_OR_UNAVAILABLE");
  }
  // Original immutable evidence remains hashed; fresh capture proves the same
  // approved meaning. New facts or changed meaning require a new draft.
  assertPacket(packet, await authority(kind, id, ownerId, database));
}
export async function listNativeOwnerProfiles(ownerId: string, database: any = db) {
  const [owner] = await database.select({ isDisabled: users.isDisabled }).from(users).where(eq(users.id, ownerId)).limit(1);
  if (owner?.isDisabled !== false) return fail("CURRENT_NATIVE_OWNER_REQUIRED", 403);
  const output: any[] = [];
  for (const kind of ["host", "supplier"] as const) {
    const table = tableFor(kind);
    const rows = await database.select().from(table).where(eq(table.userId, ownerId));
    for (const row of rows) {
      try { const current = await authority(kind, row.id, ownerId, database); output.push({ kind, aliases: kind === "host" ? ["host", "location"] : ["supplier"], id: row.id, name: current.row.businessName }); } catch (error) { if (!(error instanceof NativeProfileDraftError)) throw error; }
    }
  }
  return output;
}
export async function getNativeOwnerContext(ownerId: string, type: unknown, id: string, database: any = db) {
  const kind = nativeProfileKind(type), current = await authority(kind, id, ownerId, database);
  return { kind, id, version: current.version, profile: current.snapshot, supportedFields: Object.keys(fields[kind]), blockedFields: current.blockedFields,
    officialSources: current.urls, approvalRequired: true, menusSupported: false, bookingControlsSupported: false, purchasingControlsSupported: false };
}
const draftHash = (draft: any) => sha({ targetKind: draft.targetKind, targetId: draft.targetId, ownerId: draft.ownerId, revision: draft.revision, contextVersion: draft.contextVersion, packet: draft.packet, snapshot: draft.snapshot, mediaManifest: draft.mediaManifest, expiresAt: new Date(draft.expiresAt).toISOString() });
export async function listNativeOwnerDrafts(ownerId: string, type: unknown, id: string, database: any = db) {
  const kind = nativeProfileKind(type);
  await authority(kind, id, ownerId, database);
  const drafts = await database.select().from(ownerAiNativeProfileDrafts).where(and(eq(ownerAiNativeProfileDrafts.targetKind, kind), eq(ownerAiNativeProfileDrafts.targetId, id), eq(ownerAiNativeProfileDrafts.ownerId, ownerId))).orderBy(desc(ownerAiNativeProfileDrafts.createdAt)).limit(30);
  await authority(kind, id, ownerId, database);
  return drafts.filter((d: any) => draftHash(d) === d.contentHash);
}
async function insertDraft(ownerId: string, kind: NativeProfileKind, id: string, packet: any, expectedVersion: string, database: any) {
  const draftId = randomUUID();
  let mediaManifest;
  try { mediaManifest = await buildOwnerAiMediaManifest(draftId, packet); }
  catch { return fail("MEDIA_SNAPSHOT_FAILED", 422); }
  return database.transaction(async (tx: any) => {
    const current = await authority(kind, id, ownerId, tx, true);
    if (current.version !== expectedVersion) return fail("STALE_NATIVE_CONTEXT");
    assertPacket(packet, current);
    const draft = { id: draftId, mediaManifest, targetKind: kind, targetId: id, ownerId, revision: 1, status: "draft", contextVersion: current.version, packet, snapshot: current.snapshot, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) };
    const [saved] = await tx.insert(ownerAiNativeProfileDrafts).values({ ...draft, contentHash: draftHash(draft) }).returning();
    return saved;
  });
}
export async function createNativeOwnerDraft(ownerId: string, type: unknown, id: string, raw: unknown, expectedVersion: string, database: any = db) {
  const kind = nativeProfileKind(type);
  const packet = parsePacket(kind, raw);
  // Source-backed drafting is exclusively server capture, never caller evidence.
  if (packet.sourceFacts) return fail("USE_NATIVE_OFFICIAL_SOURCE_DRAFT", 400);
  await authority(kind, id, ownerId, database);
  return insertDraft(ownerId, kind, id, packet, expectedVersion, database);
}
export async function createNativeOfficialSourceDraft(ownerId: string, type: unknown, id: string, database: any = db) {
  const kind = nativeProfileKind(type), before = await authority(kind, id, ownerId, database);
  const proposal = await observe(kind, before);
  const after = await authority(kind, id, ownerId, database);
  if (before.version !== after.version) return fail("STALE_NATIVE_CONTEXT");
  return { draft: proposal.packet ? await insertDraft(ownerId, kind, id, proposal.packet, before.version, database) : null, holds: proposal.holds, approvalRequired: true, canonicalMutationPerformed: false };
}
export async function approveNativeOwnerDraft(ownerId: string, draftId: string, expectedRevision: number, expectedContentHash: string, database: any = db) {
  const [original] = await database.select().from(ownerAiNativeProfileDrafts).where(and(eq(ownerAiNativeProfileDrafts.id, draftId), eq(ownerAiNativeProfileDrafts.ownerId, ownerId))).limit(1);
  if (!original) return fail("NATIVE_DRAFT_NOT_FOUND", 404);
  const kind = nativeProfileKind(original.targetKind);
  await authority(kind, original.targetId, ownerId, database);
  if (original.revision !== expectedRevision || original.contentHash !== expectedContentHash || draftHash(original) !== original.contentHash) return fail("EXACT_NATIVE_REVISION_REQUIRED");
  if (original.status === "applied") return original;
  if (original.status !== "draft" || new Date(original.expiresAt).getTime() <= Date.now()) return fail("NATIVE_DRAFT_EXPIRED_OR_CLOSED");
  const packet = parsePacket(kind, original.packet);
  await verifySource(kind, original.targetId, ownerId, packet, database);
  const preparedProfile = { ...packet.profile };
  for (const [field, assetKey] of [["logoUrl", "profile-logo"], ["coverImageUrl", "profile-cover"]] as const) {
    if (packet.profile?.[field]) {
      try {
        const manifest = (original.mediaManifest as any[]).find(entry => entry.assetKey === assetKey);
        preparedProfile[field] = await validateAndPrepareRemoteImage(packet.profile[field], "mealscout/native-owner-profile-content", manifest || null);
      } catch { return fail("MEDIA_CHANGED_OR_UNAVAILABLE"); }
    }
  }
  return database.transaction(async (tx: any) => {
    // Canonical row first, then owner and draft. Native transfer/disable edits
    // serialize with the final authority, version and consent check.
    const current = await authority(kind, original.targetId, ownerId, tx, true);
    const [draft] = await tx.select().from(ownerAiNativeProfileDrafts).where(eq(ownerAiNativeProfileDrafts.id, draftId)).limit(1).for("update");
    if (!draft || draft.ownerId !== ownerId || draft.targetKind !== kind || draft.targetId !== original.targetId || draftHash(draft) !== expectedContentHash || draft.contentHash !== expectedContentHash || draft.revision !== expectedRevision) return fail("EXACT_NATIVE_REVISION_REQUIRED");
    if (draft.status === "applied") return draft;
    if (draft.status !== "draft" || new Date(draft.expiresAt).getTime() <= Date.now()) return fail("NATIVE_DRAFT_EXPIRED_OR_CLOSED");
    if (current.version !== draft.contextVersion) return fail("STALE_NATIVE_CONTEXT");
    assertPacket(packet, current);
    if (packet.sourceFacts) assertOwnerAiSourceFactBindings(packet);
    const values = Object.fromEntries(Object.entries(preparedProfile).map(([key, value]) => [(fields[kind] as Record<string, string>)[key], value]));
    const table = tableFor(kind);
    await tx.update(table).set({ ...values, updatedAt: new Date() }).where(and(eq(table.id, draft.targetId), eq(table.userId, ownerId)));
    const [applied] = await tx.update(ownerAiNativeProfileDrafts).set({ status: "applied", appliedAt: new Date(), consent: { ownerId, revision: expectedRevision, contentHash: expectedContentHash, contextVersion: draft.contextVersion, approvedAt: new Date().toISOString(), sourceFactsRechecked: !!packet.sourceFacts } }).where(eq(ownerAiNativeProfileDrafts.id, draftId)).returning();
    return applied;
  });
}
export async function runNativeOwnerSourceReviews(database: any = db) {
  const day = sourceCheckDay(new Date()), results: Array<{ status: string }> = [];
  for (const kind of ["host", "supplier"] as const) {
    const table = tableFor(kind); let cursor = "";
    for (;;) {
      const rows = await database.select({ id: table.id, userId: table.userId }).from(table).where(gt(table.id, cursor)).orderBy(asc(table.id)).limit(100);
      if (!rows.length) break;
      for (const row of rows) {
        const id = "native-source-review-v1:" + sha({ kind, id: row.id, day });
        try {
          const status = await database.transaction(async (tx: any) => {
            const lock = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${id}, 0)) as acquired`);
            if (!(lock.rows || lock)[0]?.acquired) return "in_progress";
            const [existing] = await tx.select({ id: telemetryEvents.id }).from(telemetryEvents).where(eq(telemetryEvents.id, id)).limit(1);
            if (existing) return "already_reviewed";
            const before = await authority(kind, row.id, row.userId, tx);
            const proposal = await observe(kind, before);
            const after = await authority(kind, row.id, row.userId, tx, true);
            if (before.version !== after.version) return fail("STALE_NATIVE_CONTEXT");
            const observation = { version: 1, kind, targetId: row.id, ownerId: row.userId, day, checkedAt: new Date().toISOString(), sourceUrls: after.urls, proposal, createsOwnerDrafts: false, publishes: false };
            await tx.insert(telemetryEvents).values({ id, userId: null, eventName: NATIVE_SOURCE_REVIEW_EVENT, properties: { ...observation, integritySha256: sha(observation) } });
            return proposal.packet ? "proposal_ready" : "held";
          });
          results.push({ status });
        } catch { results.push({ status: "held_authority_or_capture_changed" }); }
      }
      cursor = rows[rows.length - 1].id;
    }
  }
  return { day, results, createsOwnerDrafts: false, publishes: false };
}

export async function getNativeOwnerMediaPreview(ownerId: string, draftId: string, assetKey: string, database: any = db) {
  if (!["profile-logo", "profile-cover"].includes(assetKey)) return fail("NATIVE_MEDIA_NOT_FOUND", 404);
  const [draft] = await database.select().from(ownerAiNativeProfileDrafts).where(and(eq(ownerAiNativeProfileDrafts.id, draftId), eq(ownerAiNativeProfileDrafts.ownerId, ownerId))).limit(1);
  if (!draft) return fail("NATIVE_DRAFT_NOT_FOUND", 404);
  const kind = nativeProfileKind(draft.targetKind);
  await authority(kind, draft.targetId, ownerId, database);
  if (draftHash(draft) !== draft.contentHash || new Date(draft.expiresAt).getTime() <= Date.now()) return fail("NATIVE_MEDIA_REVISION_EXPIRED_OR_CHANGED");
  const packet = parsePacket(kind, draft.packet), field = assetKey === "profile-logo" ? "logoUrl" : "coverImageUrl";
  const entry = (draft.mediaManifest as any[]).find(m => m.assetKey === assetKey);
  if (!entry || !packet.profile?.[field]) return fail("NATIVE_MEDIA_NOT_FOUND", 404);
  let preview;
  try { preview = await fetchOwnerAiRemoteImagePreview(packet.profile[field]!); }
  catch { return fail("NATIVE_MEDIA_UNAVAILABLE", 422); }
  if (createHash("sha256").update(preview.buffer).digest("hex") !== entry.sha256 || preview.contentType !== entry.contentType || preview.buffer.byteLength !== entry.byteLength) return fail("MEDIA_CHANGED_OR_UNAVAILABLE");
  await authority(kind, draft.targetId, ownerId, database);
  return preview;
}
