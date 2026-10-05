import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createReverseOsmosisEngine, type Proposal, type ProposalInput, type Scope, type ExactApproval, type NativePort, type DurableOutcome, type JSONValue } from "@tradescout-infinity/reverse-osmosis";
import { db } from "../db";
import { restaurants, users, ownerAiActionDrafts, socialPublishingConnections, socialPostQueue, reverseOsmosisOperations } from "@shared/schema";
import { MEALSCOUT_RO_CORE_PIN, reverseOsmosisEnvelopeSchema, type MealScoutReverseOsmosisEnvelope } from "@shared/reverseOsmosis";
import { ownerAiActionPacketSchema, type OwnerAiActionPacket, type OwnerAiExpectedVersions } from "@shared/ownerAiActions";
import { OwnerAiActionError, computeOwnerAiExpectedVersions } from "./ownerAiActions";
import { loadSourceFactAuthority } from "./ownerAiSourceFacts";
import { verifyMealScoutBusinessAsset, connectionBindingRevision, captureMealScoutBusinessPost } from "./reverseOsmosisBusinessAssets";
import { assertSourceCaptureActive, withSourceCaptureBudget, type SourceCaptureOptions } from "./reverseOsmosisCaptureGuard";

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function mealScoutReverseOsmosisHash(value: unknown) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
const deny = (message: string): never => { throw new OwnerAiActionError(409, "REVERSE_OSMOSIS_HOLD", message); };
const same = (a: unknown, b: unknown) => mealScoutReverseOsmosisHash(a) === mealScoutReverseOsmosisHash(b);
function approvalFor(proposal: Proposal, draft: any, approvedRevision: number): ExactApproval {
  return { scope: proposal.scope, direction: proposal.direction, eventId: proposal.eventId, sourceVersion: proposal.sourceVersion, expectedNativeVersion: proposal.expectedNativeVersion, payloadDigest: proposal.payloadDigest, businessBindingRevision: proposal.businessBindingRevision, approvalId: `${draft.id}:${approvedRevision}:${mealScoutReverseOsmosisHash({ packet: draft.packet, media: draft.mediaManifest, social: draft.socialDrafts })}` };
}
async function authority(restaurantId: string, userId: string, database: any = db, lock = false, requirePublicEligibility = true, signal?: AbortSignal) {
  assertSourceCaptureActive(signal);
  const q = (query: any) => lock ? query.for("update") : query;
  const [restaurant] = await q(database.select().from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1));
  assertSourceCaptureActive(signal);
  const [user] = await q(database.select({ id: users.id, isDisabled: users.isDisabled }).from(users).where(eq(users.id, userId)).limit(1));
  assertSourceCaptureActive(signal);
  if (!restaurant || restaurant.ownerId !== userId || user?.isDisabled !== false) deny("Current enabled business owner is required");
  if (requirePublicEligibility) {
    // Reuse MealScout's native publication/privacy policy. A verified public Page never overrides native visibility or field restrictions.
    let native;
    try { native = await loadSourceFactAuthority(restaurantId, userId, database, lock); }
    catch { assertSourceCaptureActive(signal); deny("This native business profile is not eligible for public-source synchronization"); }
    assertSourceCaptureActive(signal);
    if (native?.blockedFields.includes("menuUrl")) deny("The owner's native privacy settings do not expose the menu link");
  }
  const [connection] = await q(database.select().from(socialPublishingConnections).where(and(eq(socialPublishingConnections.restaurantId, restaurantId), eq(socialPublishingConnections.platform, "facebook"))).limit(1));
  assertSourceCaptureActive(signal);
  if (!connection || connection.status !== "active" || !connection.accessToken || !connection.externalAccountId || connection.createdByUserId !== userId) deny("An active Facebook business Page connection belonging to the current owner is required");
  return { restaurant, connection };
}
function scopeFor(restaurantId: string, userId: string, accountId: string): Scope { return { product: "mealscout", tenantId: "mealscout", businessId: restaurantId, subjectId: restaurantId, ownerId: userId, provider: "facebook", accountId }; }
function captureShape(capture: any) {
  return { sourceUrl: capture.sourceUrl, capturedAt: capture.capturedAt, expiresAt: capture.expiresAt, sourceVersion: capture.sourceVersion, providerPostId: capture.providerPostId, providerCreatedAt: capture.providerCreatedAt ?? null, providerUpdatedAt: capture.providerUpdatedAt ?? null, bodyHash: capture.bodyHash, publicProofHash: capture.publicProofHash, profile: capture.profile, holds: capture.holds };
}
function inboundInput(scope: Scope, capture: MealScoutReverseOsmosisEnvelope["capture"], versions: OwnerAiExpectedVersions): ProposalInput {
  return { scope, direction: "social-to-native", eventId: capture.providerPostId, sourceVersion: capture.sourceVersion, expectedNativeVersion: mealScoutReverseOsmosisHash(versions), fields: { profile: capture.profile, capture } as unknown as Record<string, JSONValue> };
}
function outboundInput(inbound: Proposal, draftId: string, social: any, media: unknown): ProposalInput {
  return { scope: inbound.scope, direction: "native-to-social", eventId: `${draftId}:facebook`, sourceVersion: mealScoutReverseOsmosisHash({ social, media }), expectedNativeVersion: inbound.expectedNativeVersion, fields: { draftId, inboundOperationKey: inbound.operationKey, message: social.selectedMessage, link: social.link || null, socialDigest: mealScoutReverseOsmosisHash(social), mediaDigest: mealScoutReverseOsmosisHash(media) } };
}
function proposalEngine(connection: any, userId: string, signal?: AbortSignal) {
  // Preparation never has an effect capability. Only the native controller creates one below.
  const unavailable = async (): Promise<never> => deny("Native exact approval is required");
  return createReverseOsmosisEngine({ verifyBusinessAsset: input => verifyMealScoutBusinessAsset(input, connection, userId, signal), authorizeAndClaim: unavailable, executeClaimed: unavailable, holdUncertain: unavailable, readOutcome: unavailable, reconcile: unavailable });
}
async function rejectReflection(scope: Scope, postId: string, database: any = db) {
  const rows = await database.select().from(reverseOsmosisOperations).where(and(eq(reverseOsmosisOperations.restaurantId, scope.businessId), eq(reverseOsmosisOperations.ownerId, scope.ownerId), eq(reverseOsmosisOperations.status, "completed")));
  if (rows.some((row: any) => row.proposal?.direction === "native-to-social" && same(row.proposal?.scope, scope) && row.receipt?.providerPostId === postId)) deny("This Page post is a recorded MealScout publication; reflection is held to prevent a synchronization loop");
}
export async function prepareMealScoutReverseOsmosisSourceDraftInput(input: { restaurantId: string; userId: string; postId: string; publishPlatforms?: Array<"facebook"> }, options: SourceCaptureOptions = {}) {
  const { restaurantId, userId } = input;
  const requestedPostId = input.postId;
  const publishPlatforms = input.publishPlatforms ? [...input.publishPlatforms] : undefined;
  if (publishPlatforms && (publishPlatforms.length > 1 || publishPlatforms.some(p => p !== "facebook"))) deny("Select Facebook once to request publication");
  return withSourceCaptureBudget(options, async guard => {
    const { connection } = await guard.wait(() => authority(restaurantId, userId, db, false, true, guard.signal));
    const initialBinding = connectionBindingRevision(connection, userId);
    const scope = scopeFor(restaurantId, userId, connection.externalAccountId!);
    const postId = /^\d+$/.test(requestedPostId) ? `${scope.accountId}_${requestedPostId}` : requestedPostId;
    await guard.wait(() => rejectReflection(scope, postId));
    const capture = captureShape(await captureMealScoutBusinessPost(scope, connection, userId, postId, { signal: guard.signal }));
    guard.checkpoint();
    if (!capture.profile.menuUrl) deny("The exact verified Page post contains no safe menu URL to propose");
    const expectedVersions = await guard.wait(() => computeOwnerAiExpectedVersions(restaurantId));
    const inbound = await guard.wait(() => proposalEngine(connection, userId, guard.signal).propose(inboundInput(scope, capture, expectedVersions)));
    const current = await guard.wait(() => authority(restaurantId, userId, db, false, true, guard.signal));
    if (connectionBindingRevision(current.connection, userId) !== initialBinding) deny("The business Page connection changed during source preparation");
    await guard.wait(() => rejectReflection(scope, postId));
    guard.checkpoint();
    const packet = ownerAiActionPacketSchema.parse({ schemaVersion: "1.0", intent: "Review the menu link captured from the connected Facebook business Page post", profile: capture.profile, ...(publishPlatforms?.length ? { social: { enabled: true, platforms: ["facebook"] } } : {}), reverseOsmosis: { schemaVersion: "mealscout.reverse-osmosis.v1", core: MEALSCOUT_RO_CORE_PIN, capture, inbound, outbound: [] } });
    return { packet, expectedVersions, holds: capture.holds };
  });
}
function packetPolicy(packet: OwnerAiActionPacket, restaurantId: string, ownerId: string, requireFreshCapture = true) {
  const envelope = reverseOsmosisEnvelopeSchema.parse(packet.reverseOsmosis);
  if (packet.hours || packet.menus || packet.schedules || packet.deals || packet.settings || packet.sourceFacts) deny("This captured Page post authorizes only its reviewed profile menu URL and explicitly selected Facebook publication");
  if (!same(packet.profile, envelope.capture.profile) || !packet.profile?.menuUrl || Object.keys(packet.profile).some(key => key !== "menuUrl")) deny("Profile must exactly match the captured menu URL");
  if (packet.social && (!packet.social.enabled || !same(packet.social.platforms, ["facebook"]))) deny("Reverse Osmosis publication requires explicit Facebook selection");
  if (!same(envelope.core, MEALSCOUT_RO_CORE_PIN) || envelope.inbound.direction !== "social-to-native" || envelope.inbound.scope.product !== "mealscout" || envelope.inbound.scope.tenantId !== "mealscout" || envelope.inbound.scope.ownerId !== ownerId || envelope.inbound.scope.businessId !== restaurantId || envelope.inbound.scope.subjectId !== restaurantId || envelope.inbound.scope.provider !== "facebook" || envelope.inbound.causalProvenance) deny("Source envelope scope or core pin does not match the native business");
  if ((requireFreshCapture && envelope.capture.expiresAt <= Date.now()) || envelope.capture.capturedAt > Date.now() || envelope.capture.expiresAt <= envelope.capture.capturedAt || envelope.capture.expiresAt - envelope.capture.capturedAt > 24 * 60 * 60 * 1000) deny("Source capture expired or has an invalid lifetime");
  return envelope;
}
export async function validateMealScoutReverseOsmosisPacket(packet: OwnerAiActionPacket, restaurantId: string, userId: string, versions: OwnerAiExpectedVersions, database: any = db, lock = false, signal?: AbortSignal) {
  assertSourceCaptureActive(signal);
  if (!packet.reverseOsmosis) return;
  const envelope = packetPolicy(packet, restaurantId, userId);
  const { connection } = await authority(restaurantId, userId, database, lock, true, signal);
  const scope = scopeFor(restaurantId, userId, connection.externalAccountId!);
  if (!same(scope, envelope.inbound.scope)) deny("Business Page binding changed");
  await rejectReflection(scope, envelope.capture.providerPostId, database);
  assertSourceCaptureActive(signal);
  const current = captureShape(await captureMealScoutBusinessPost(scope, connection, userId, envelope.capture.providerPostId, { signal }));
  assertSourceCaptureActive(signal);
  for (const key of ["sourceUrl", "sourceVersion", "providerPostId", "providerCreatedAt", "providerUpdatedAt", "bodyHash", "publicProofHash", "profile", "holds"] as const) if (!same(current[key], envelope.capture[key])) deny("The Page post or its public proof changed after capture; prepare and review a fresh draft");
  const actual = await proposalEngine(connection, userId, signal).propose(inboundInput(scope, envelope.capture, versions));
  assertSourceCaptureActive(signal);
  if (!same(actual, envelope.inbound)) deny("Captured proposal or native version does not match");
  return { envelope, connection, currentCapture: current };
}
export async function finalizeMealScoutReverseOsmosisDraftPacket(packet: OwnerAiActionPacket, restaurantId: string, userId: string, versions: OwnerAiExpectedVersions, draftId: string, socialDrafts: any[], media: unknown, signal?: AbortSignal) {
  assertSourceCaptureActive(signal);
  const validated = await validateMealScoutReverseOsmosisPacket(packet, restaurantId, userId, versions, db, false, signal);
  assertSourceCaptureActive(signal);
  if (!validated) return;
  const { envelope, connection, currentCapture } = validated;
  if (socialDrafts.some(s => s.platform !== "facebook") || socialDrafts.length > 1) deny("Only explicitly selected Facebook publication is supported");
  // Persist only this server's actual recapture time and expiry. Submitted capture timestamps never become reviewed provenance.
  const inbound = await proposalEngine(connection, userId, signal).propose(inboundInput(envelope.inbound.scope, currentCapture, versions));
  assertSourceCaptureActive(signal);
  const outbound = [];
  for (const social of socialDrafts) {
    assertSourceCaptureActive(signal);
    outbound.push(await proposalEngine(connection, userId, signal).propose(outboundInput(inbound, draftId, social, media)));
    assertSourceCaptureActive(signal);
  }
  // Caller outbound proposals never become authority. Native preparation derives the exact reviewed payload.
  packet.reverseOsmosis = reverseOsmosisEnvelopeSchema.parse({ ...envelope, capture: currentCapture, inbound, outbound });
}
function outcome(row: any, proposal: Proposal): DurableOutcome {
  if (!row || row.payloadDigest !== proposal.payloadDigest || !same(row.proposal, proposal)) deny("Operation collision or receipt mismatch");
  return { operationKey: proposal.operationKey, payloadDigest: proposal.payloadDigest, status: row.status === "claimed" ? "held" : row.status, ...(row.receipt ? { receipt: row.receipt } : {}) };
}
async function claim(database: any, proposal: Proposal, draft: any, revision: number, approval: ExactApproval) {
  const inserted = await database.insert(reverseOsmosisOperations).values({ operationKey: proposal.operationKey, payloadDigest: proposal.payloadDigest, draftId: draft.id, restaurantId: draft.restaurantId, ownerId: proposal.scope.ownerId, approvedRevision: revision, approvalId: approval.approvalId, proposal, status: "claimed" }).onConflictDoNothing().returning();
  if (inserted.length) return undefined;
  const [row] = await database.select().from(reverseOsmosisOperations).where(eq(reverseOsmosisOperations.operationKey, proposal.operationKey)).limit(1).for("update");
  if (row?.draftId !== draft.id || row?.approvedRevision !== revision || row?.approvalId !== approval.approvalId) deny("This source operation belongs to a different native approval");
  return outcome(row, proposal);
}
async function persist(database: any, proposal: Proposal, status: string, receipt: unknown) {
  const [row] = await database.update(reverseOsmosisOperations).set({ status, receipt, updatedAt: new Date() }).where(and(eq(reverseOsmosisOperations.operationKey, proposal.operationKey), eq(reverseOsmosisOperations.payloadDigest, proposal.payloadDigest), eq(reverseOsmosisOperations.status, "claimed"))).returning();
  if (!row) deny("Durable operation ownership changed");
  return outcome(row, proposal);
}
export async function applyMealScoutReverseOsmosisWithinApproval(input: { tx: any; draft: any; userId: string; execute: () => Promise<any> }) {
  const { tx, draft, userId } = input;
  const packet = ownerAiActionPacketSchema.parse(draft.packet);
  const validated = await validateMealScoutReverseOsmosisPacket(packet, draft.restaurantId, userId, draft.expectedVersions, tx, true);
  if (!validated) return input.execute();
  const proposal = validated.envelope.inbound as Proposal;
  const approval = approvalFor(proposal, draft, draft.revision);
  const capability = Object.freeze({});
  let claimed = false;
  let result: any;
  const assertExact = async () => {
    const [current] = await tx.select().from(ownerAiActionDrafts).where(eq(ownerAiActionDrafts.id, draft.id)).limit(1).for("update");
    if (!current || current.status !== "draft" || current.revision !== draft.revision || !same(current.packet, draft.packet) || !same(current.mediaManifest, draft.mediaManifest) || !same(current.socialDrafts, draft.socialDrafts) || current.createdByUserId !== userId || current.expiresAt <= new Date()) deny("Native exact draft consent changed");
    const { connection } = await authority(draft.restaurantId, userId, tx, true);
    if (connectionBindingRevision(connection, userId) !== proposal.businessBindingRevision) deny("Business connection changed before native effect");
    if (mealScoutReverseOsmosisHash(await computeOwnerAiExpectedVersions(draft.restaurantId, tx, { forUpdate: true })) !== proposal.expectedNativeVersion) deny("Full native version changed before effect");
  };
  const unavailable = async (): Promise<never> => deny("This capability is restricted to this native approval transaction");
  const port: NativePort = { verifyBusinessAsset: p => verifyMealScoutBusinessAsset(p, validated.connection, userId),
    authorizeAndClaim: async request => { await assertExact(); if (!same(request.approval, approval) || !same(request.proposal, proposal)) deny("Exact native approval mismatch"); const replay = await claim(tx, proposal, draft, draft.revision, approval); if (replay) deny("Source operation was already claimed; no native change was repeated"); claimed = true; return { kind: "claimed", claim: capability }; },
    executeClaimed: async token => { if (token !== capability || !claimed) deny("Invalid native capability"); await assertExact(); await verifyMealScoutBusinessAsset(proposal, validated.connection, userId); result = await input.execute(); const completedNativeVersion = mealScoutReverseOsmosisHash(await computeOwnerAiExpectedVersions(draft.restaurantId, tx)); return persist(tx, proposal, "completed", { draftId: draft.id, approvedRevision: draft.revision, appliedRevision: draft.revision + 1, packetDigest: mealScoutReverseOsmosisHash(draft.packet), mediaDigest: mealScoutReverseOsmosisHash(draft.mediaManifest), socialDigest: mealScoutReverseOsmosisHash(draft.socialDrafts), completedNativeVersion, completedAt: new Date().toISOString() }); },
    holdUncertain: async token => { if (token !== capability) deny("Invalid native capability"); await tx.update(reverseOsmosisOperations).set({ status: "held", updatedAt: new Date() }).where(eq(reverseOsmosisOperations.operationKey, proposal.operationKey)); }, readOutcome: unavailable, reconcile: unavailable };
  await createReverseOsmosisEngine(port).apply(proposal, approval);
  return result;
}

export async function publishMealScoutReverseOsmosisSocialIntent(input: { draft: any; row: any; execute: (tx: any, connection: any) => Promise<any> }) {
  const { draft, row } = input;
  const packet = ownerAiActionPacketSchema.parse(draft.packet);
  const envelope = packetPolicy(packet, draft.restaurantId, draft.approvedByUserId);
  const proposal: Proposal = (envelope.outbound.find(p => p.scope.provider === row.platform) as Proposal | undefined) || deny("Queue item has no exact approved outbound proposal");
  const revision = draft.revision - 1;
  const approval = approvalFor(proposal, draft, revision);
  const { connection } = await authority(draft.restaurantId, draft.approvedByUserId);
  const capability = Object.freeze({}); let claimed = false;
  const assertExact = async (tx: any) => {
    const [current] = await tx.select().from(ownerAiActionDrafts).where(eq(ownerAiActionDrafts.id, draft.id)).limit(1).for("update");
    if (!current || current.status !== "applied" || current.revision !== draft.revision || current.approvedByUserId !== draft.approvedByUserId || !current.approvedAt || !same(current.packet, draft.packet) || !same(current.mediaManifest, draft.mediaManifest) || !same(current.socialDrafts, draft.socialDrafts)) deny("Applied native consent changed");
    const { connection: locked } = await authority(draft.restaurantId, draft.approvedByUserId, tx, true);
    if (connectionBindingRevision(locked, draft.approvedByUserId) !== proposal.businessBindingRevision) deny("Business Page connection changed before publication");
    const [inbound] = await tx.select().from(reverseOsmosisOperations).where(eq(reverseOsmosisOperations.operationKey, envelope.inbound.operationKey)).limit(1).for("share");
    const receipt: any = inbound?.receipt;
    if (inbound?.status !== "completed" || inbound.draftId !== draft.id || inbound.approvedRevision !== revision || !same(inbound.proposal, envelope.inbound) || receipt?.packetDigest !== mealScoutReverseOsmosisHash(draft.packet) || receipt?.mediaDigest !== mealScoutReverseOsmosisHash(draft.mediaManifest) || receipt?.socialDigest !== mealScoutReverseOsmosisHash(draft.socialDrafts) || mealScoutReverseOsmosisHash(await computeOwnerAiExpectedVersions(draft.restaurantId, tx, { forUpdate: true })) !== receipt?.completedNativeVersion) deny("Native completion receipt or current full version changed before publication");
    const social = draft.socialDrafts.find((s: any) => s.platform === "facebook");
    const expected = await proposalEngine(locked, draft.approvedByUserId).propose(outboundInput(envelope.inbound as Proposal, draft.id, social, draft.mediaManifest));
    if (!same(expected, proposal)) deny("Approved publication payload or media changed");
    const [queue] = await tx.select().from(socialPostQueue).where(eq(socialPostQueue.id, row.id)).limit(1).for("update");
    if (!queue || queue.status !== "publishing" || queue.ownerAiActionDraftId !== draft.id || queue.restaurantId !== draft.restaurantId || queue.createdByUserId !== draft.approvedByUserId || queue.platform !== "facebook" || queue.message !== social.selectedMessage || (queue.link || null) !== (social.link || null)) deny("Approved queue payload changed");
    await verifyMealScoutBusinessAsset(proposal, locked, draft.approvedByUserId);
    return locked;
  };
  const port: NativePort = { verifyBusinessAsset: p => verifyMealScoutBusinessAsset(p, connection, draft.approvedByUserId),
    authorizeAndClaim: async request => db.transaction(async (tx: any) => { await assertExact(tx); if (!same(request.proposal, proposal) || !same(request.approval, approval)) deny("Exact publication approval mismatch"); const replay = await claim(tx, proposal, draft, revision, approval); if (replay) return { kind: "outcome", outcome: replay } as const; claimed = true; return { kind: "claimed", claim: capability } as const; }),
    executeClaimed: async token => { if (token !== capability || !claimed) deny("Invalid publish capability"); return db.transaction(async (tx: any) => { const locked = await assertExact(tx); const [operation] = await tx.select().from(reverseOsmosisOperations).where(eq(reverseOsmosisOperations.operationKey, proposal.operationKey)).limit(1).for("update"); if (operation?.status !== "claimed" || operation.approvalId !== approval.approvalId) deny("Publish claim changed"); const result = await input.execute(tx, locked); const completed = result?.ok === true && typeof result.providerPostId === "string" && result.providerPostId.length > 0; return persist(tx, proposal, completed ? "completed" : result?.manualRequired ? "held" : "denied", { draftId: draft.id, approvedRevision: revision, packetDigest: mealScoutReverseOsmosisHash(draft.packet), mediaDigest: mealScoutReverseOsmosisHash(draft.mediaManifest), ...(completed ? { providerPostId: result.providerPostId, providerUrl: result.providerUrl || null } : { reason: String(result?.error || "Publication outcome uncertain").slice(0,1000) }), completedAt: new Date().toISOString() }); }); },
    holdUncertain: async token => { if (token !== capability) deny("Invalid publish capability"); await db.update(reverseOsmosisOperations).set({ status: "held", updatedAt: new Date() }).where(and(eq(reverseOsmosisOperations.operationKey, proposal.operationKey), eq(reverseOsmosisOperations.status, "claimed"))); },
    readOutcome: async p => db.transaction(async (tx: any) => { await assertExact(tx); const [operation] = await tx.select().from(reverseOsmosisOperations).where(eq(reverseOsmosisOperations.operationKey, p.operationKey)).limit(1); return operation ? outcome(operation,p) : undefined; }),
    reconcile: async p => db.transaction(async (tx: any) => { await assertExact(tx); const [operation] = await tx.select().from(reverseOsmosisOperations).where(eq(reverseOsmosisOperations.operationKey,p.operationKey)).limit(1); return operation ? outcome(operation,p) : deny("No trusted durable publication outcome is available"); }), };
  return createReverseOsmosisEngine(port).publish(proposal, approval);
}
export async function readMealScoutReverseOsmosisOutcome(input: { draftId: string; userId: string; reconcile?: boolean }) {
  return db.transaction(async (tx: any) => {
    const [draft] = await tx.select().from(ownerAiActionDrafts).where(eq(ownerAiActionDrafts.id,input.draftId)).limit(1).for("share");
    if (!draft) deny("Draft not found");
    const { connection } = await authority(draft.restaurantId,input.userId,tx,true,false);
    // Historical outcomes are owner disclosures, not new effects. Capture expiry and current public-profile visibility do not prevent safe reconciliation.
    const envelope = packetPolicy(ownerAiActionPacketSchema.parse(draft.packet),draft.restaurantId,input.userId,false);
    const read = async (p: Proposal) => {
      const [row] = await tx.select().from(reverseOsmosisOperations).where(eq(reverseOsmosisOperations.operationKey,p.operationKey)).limit(1);
      if (!row) return undefined;
      if (row.ownerId !== input.userId || row.draftId !== draft.id || row.approvalId !== approvalFor(p,draft,row.approvedRevision).approvalId || !draft.approvedAt || draft.approvedByUserId !== input.userId || draft.status !== "applied" || draft.revision !== row.approvedRevision + 1) deny("Outcome exact native consent changed");
      return outcome(row,p);
    };
    const unavailable = async (): Promise<never> => deny("Outcome reads cannot claim effects");
    const engine = createReverseOsmosisEngine({ verifyBusinessAsset: p => verifyMealScoutBusinessAsset(p,connection,input.userId), authorizeAndClaim: unavailable, executeClaimed: unavailable, holdUncertain: unavailable, readOutcome: read, reconcile: async p => (await read(p)) || deny("No trusted operation exists to reconcile") });
    const receipts = [];
    for (const p of [envelope.inbound,...envelope.outbound]) { const receipt = input.reconcile ? await engine.reconcile(p as Proposal) : await engine.authorizedOutcome(p as Proposal); if (receipt) receipts.push(receipt); }
    return { draftId: draft.id, outcomes: receipts, reconciliation: "Held publications remain held until trusted provider delivery or absence can be verified; no retry was initiated" };
  });
}
