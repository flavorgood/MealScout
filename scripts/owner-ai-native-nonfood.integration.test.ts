import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableColumns, getTableName, eq } from "drizzle-orm";
import * as schema from "../shared/schema";
import { canonicalSourceSection } from "../shared/ownerAiSourceFacts";
import { toPublicLocationProfile } from "../server/publicProfiles/toPublicLocationProfile";
import { toPublicSupplierProfile } from "../server/publicProfiles/toPublicSupplierProfile";

// Disposable PostgreSQL and synthetic local session only. No production DB,
// customer identity, credential, canonical profile or remote website is used.
delete process.env.DATABASE_URL;
process.env.NODE_ENV = "development";
process.env.SESSION_SECRET = "disposable-nonfood-profile-fixture-only-000000";
const nativeFetch = globalThis.fetch;
let externalNetworkCalls = 0;
globalThis.fetch = async () => { externalNetworkCalls++; throw new Error("External network forbidden in fixture"); };
const engine = new PGlite();
const added = new Set(["website_url", "instagram_url", "facebook_page_url", "x_url", "logo_url", "cover_image_url"]);
for (const table of [schema.users, schema.hosts, schema.suppliers, schema.telemetryEvents]) {
  const columns = Object.values(getTableColumns(table)).filter(c => table !== schema.hosts && table !== schema.suppliers || !added.has(c.name));
  await engine.exec(`create table "${getTableName(table)}" (${columns.map(c => `"${c.name}" ${c.getSQLType()} ${c.name === "id" ? "primary key default gen_random_uuid()" : ""}`).join(",")})`);
}
const migration = readFileSync(new URL("../migrations/145_native_owner_profile_content_drafts.sql", import.meta.url), "utf8");
await engine.exec(migration); await engine.exec(migration);
const database = drizzle(engine);
(globalThis as any).__nativeProfileDb = database;
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
(globalThis as any).__nativeProfileHash = hash;
(globalThis as any).__nativeProfileHtml = '<a href="tel:+15555550199">Call</a><a href="https://instagram.com/realvenue">Instagram</a>';
registerHooks({ load(url, context, nextLoad) {
  if (/\/server\/db\.ts(?:\?|$)/.test(url)) return { format: "module", source: "export const db = globalThis.__nativeProfileDb; export const pool = undefined;", shortCircuit: true };
  if (/\/server\/utils\/pinnedPublicSourceCheck\.ts$/.test(url)) return { format: "module", source: `export { sourceCheckUrl } from "./pinnedPublicSourceCheck.ts?actual";
    export async function checkPinnedPublicSource(url, options={}) {
      if(globalThis.__duringNativeCapture) await globalThis.__duringNativeCapture();
      if(globalThis.__nativeSourceUnavailable) return {availability:"unavailable"};
      const html=globalThis.__nativeProfileHtmlByUrl?.[url] ?? globalThis.__nativeProfileHtml;
      options.capture?.({sourceUrl:url,finalUrl:url,body:Buffer.from(html),contentType:"text/html",checkedAt:new Date().toISOString(),bodyHash:globalThis.__nativeProfileHash(html)});
      return {availability:"reachable"};
    }`, shortCircuit: true };
  if (/\/server\/imageUpload\.ts(?:\?|$)/.test(url)) return { format: "module", source: `export async function fetchOwnerAiRemoteImagePreview() { return {buffer:Buffer.from(globalThis.__nativeImageBytes||"image-original"),contentType:"image/png"}; }
    export function isCloudinaryConfigured(){return false;}
    export async function uploadToCloudinary(){throw new Error("No hosted media in fixture");}
    export async function uploadGeneratedSocialCardToCloudinary(){throw new Error("No generated media in fixture");}
    export const upload={};`, shortCircuit:true };
  return nextLoad(url, context);
}});
const service = await import("../server/services/ownerAiNativeProfiles");
const foodReviews = await import("../server/services/ownerAiSourceReviews");
const owner = "native-content-owner", successor = "native-content-successor", admin = "native-content-admin";
await database.insert(schema.users).values([owner, successor, admin].map(id => ({ id, isDisabled: false, userType: id === admin ? "admin" : "host", publicProfileSettings: { showContact: true, showAddress: true } })));
const hostId = "70000000-0000-4000-8000-000000000001", supplierId = "70000000-0000-4000-8000-000000000002";
await database.insert(schema.hosts).values({ id: hostId, userId: owner, businessName: "Garden Courtyard", address: "12 Palm Road", city: "Orlando", state: "FL", locationType: "office", spotCount: 7, parkingPassDailyPriceCents: 2000, websiteUrl: "https://venue.example/", updatedAt: new Date("2026-01-01") });
await database.insert(schema.suppliers).values({ id: supplierId, userId: owner, businessName: "Sunshine Produce", address: "44 Farm Road", city: "Orlando", state: "FL", isActive: true, websiteUrl: "https://supplier.example/", deliveryNotes: "Delivery agreement remains unchanged", onlinePaymentsNotes: "Payment agreement remains unchanged", updatedAt: new Date("2026-01-01") });
const express = (await import("express")).default;
const { registerOwnerAiNativeProfileRoutes } = await import("../server/routes/ownerAiNativeProfileRoutes");
const app = express(); app.use(express.json());
app.use((req: any, _res, next) => { const id = req.get("x-fixture-user"); req.isAuthenticated = () => !!id; req.user = id ? { id } : undefined; next(); });
registerOwnerAiNativeProfileRoutes(app);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status || 500).json({ code: error.code, message: error.message }));
const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}/api/owner-ai/native-profiles`;
async function request(path: string, user?: string, body?: any) {
  const response = await nativeFetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { ...(user ? { "x-fixture-user": user } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
}
const reject = async (fn: Promise<unknown>, code: string) => { await assert.rejects(fn, (e: any) => e.code === code || e.message === code); };
try {
  assert.equal((await request("")).status, 401);
  assert.equal((await request(`/host/${hostId}/source-draft`, admin, {})).status, 403);
  assert.equal((await request(`/host/${hostId}/source-draft`, owner, { userId: successor })).status, 400);
  const profiles = await request("", owner); assert.equal(profiles.body.length, 2); assert.deepEqual(profiles.body[0].aliases, ["host", "location"]);
  const beforeHost = (await database.select().from(schema.hosts))[0], beforeSupplier = (await database.select().from(schema.suppliers))[0];
  const native = await service.runNativeOwnerSourceReviews(database);
  assert.equal(native.results.length, 2); assert.ok(native.results.every(r => r.status === "proposal_ready"));
  assert.ok((await service.runNativeOwnerSourceReviews(database)).results.every(r => r.status === "already_reviewed"));
  assert.equal((await database.select().from(schema.ownerAiNativeProfileDrafts)).length, 0);
  assert.deepEqual((await database.select().from(schema.hosts))[0], beforeHost);
  assert.deepEqual((await database.select().from(schema.suppliers))[0], beforeSupplier);
  console.log("PASS actual migration145 replay/idempotency; real owner HTTP excludes anonymous/admin/forged principals; paged native source observations create no draft, approval or canonical write");
  for (const [kind, id] of [["location", hostId], ["host", hostId], ["supplier", supplierId]] as const) {
    const source = await request(`/${kind}/${id}/source-draft`, owner, {});
    assert.equal(source.status, 201, JSON.stringify(source.body)); assert.equal(source.cache, "private, no-store");
    const draft = source.body.draft;
    assert.equal(draft.targetKind, kind === "supplier" ? "supplier" : "host");
    assert.ok(draft.packet.sourceFacts.officialSources.includes(draft.packet.sourceFacts.fields[0].sourceUrl));
    assert.ok(draft.packet.sourceFacts.fields[0].captureSha256); assert.equal(draft.consent, null);
    assert.equal((await request(`/drafts/${draft.id}/approve`, owner, { expectedRevision: 1, expectedContentHash: "0".repeat(64) })).status, 409);
    const applied = await request(`/drafts/${draft.id}/approve`, owner, { expectedRevision: 1, expectedContentHash: draft.contentHash });
    assert.equal(applied.status, 200, JSON.stringify(applied.body)); assert.equal(applied.body.status, "applied"); assert.equal(applied.body.consent.sourceFactsRechecked, true);
    assert.equal((await service.approveNativeOwnerDraft(owner, draft.id, 1, draft.contentHash)).id, draft.id);
    if (kind === "supplier") {
      const row = (await database.select().from(schema.suppliers))[0];
      const dto = toPublicSupplierProfile({ row, baseUrl: "https://mealscout.example", activeProductCount: 0 });
      assert.equal(dto.phonePublic, "+15555550199"); assert.equal(row.deliveryNotes, beforeSupplier.deliveryNotes); assert.equal(row.onlinePaymentsNotes, beforeSupplier.onlinePaymentsNotes);
    } else {
      const row = (await database.select().from(schema.hosts))[0], dto = toPublicLocationProfile({ row, baseUrl: "https://mealscout.example" });
      assert.equal(dto.socialLinks.instagramUrl, "https://instagram.com/realvenue"); assert.equal(row.spotCount, 7); assert.equal(row.parkingPassDailyPriceCents, 2000); assert.equal(row.address, beforeHost.address);
    }
  }
  console.log("PASS all three public aliases: server-captured provenance -> actual native immutable draft -> exact owner consent -> native write -> real public projector; capacity, parking pricing, addresses and supplier delivery/payment controls preserved");
  let context = await service.getNativeOwnerContext(owner, "host", hostId);
  for (const raw of [{ profile: { address: "Wrong Venue" } }, { profile: { description: "Booking rights" } }, { profile: { menuUrl: "https://venue.example/menu" } }, { profile: { phone: "+15555550122" }, schedules: [] }, { profile: { name: "Garden" }, settings: { socialPosting: { promptBeforePost: true } } }]) {
    await assert.rejects(service.createNativeOwnerDraft(owner, "host", hostId, { intent: "Forbidden controls", ...raw }, context.version));
  }
  const websiteDraft = await service.createNativeOwnerDraft(owner, "supplier", supplierId, { intent: "My official website", profile: { websiteUrl: "https://fresh-supplier.example/" } }, (await service.getNativeOwnerContext(owner, "supplier", supplierId)).version);
  await service.approveNativeOwnerDraft(owner, websiteDraft.id, 1, websiteDraft.contentHash);
  assert.equal(toPublicSupplierProfile({ row: (await database.select().from(schema.suppliers))[0], baseUrl: "https://mealscout.example", activeProductCount: 0 }).websiteUrl, "https://fresh-supplier.example/");
  const draft = (await service.createNativeOfficialSourceDraft(owner, "host", hostId)).draft!;
  (globalThis as any).__nativeProfileHtml = '<a href="tel:+15555550122">Call</a>';
  await reject(service.approveNativeOwnerDraft(owner, draft.id, 1, draft.contentHash), "SOURCE_FACT_CHANGED_OR_UNAVAILABLE");
  (globalThis as any).__nativeProfileHtml = '<a href="tel:+15555550199">Call</a><a href="https://instagram.com/realvenue">Instagram</a>';
  await database.update(schema.hosts).set({ spotCount: 9 }).where(eq(schema.hosts.id, hostId));
  await reject(service.approveNativeOwnerDraft(owner, draft.id, 1, draft.contentHash), "STALE_NATIVE_CONTEXT");
  const transfer = (await service.createNativeOfficialSourceDraft(owner, "host", hostId)).draft!;
  await database.update(schema.hosts).set({ userId: successor }).where(eq(schema.hosts.id, hostId));
  await reject(service.approveNativeOwnerDraft(owner, transfer.id, 1, transfer.contentHash), "CURRENT_NATIVE_OWNER_REQUIRED");
  await reject(service.approveNativeOwnerDraft(successor, transfer.id, 1, transfer.contentHash), "NATIVE_DRAFT_NOT_FOUND");
  await database.update(schema.hosts).set({ userId: owner }).where(eq(schema.hosts.id, hostId));
  await database.update(schema.users).set({ publicProfileSettings: { showContact: false } }).where(eq(schema.users.id, owner));
  assert.equal((await service.createNativeOfficialSourceDraft(owner, "host", hostId)).draft, null);
  await reject(service.approveNativeOwnerDraft(owner, transfer.id, 1, transfer.contentHash), "CONTENT_FIELD_NOT_PUBLIC");
  await database.update(schema.users).set({ publicProfileSettings: { showContact: true } }).where(eq(schema.users.id, owner));
  (globalThis as any).__duringNativeCapture = async () => { (globalThis as any).__duringNativeCapture = undefined; await database.update(schema.hosts).set({ websiteUrl: "https://changed-venue.example/" }).where(eq(schema.hosts.id, hostId)); };
  await reject(service.createNativeOfficialSourceDraft(owner, "host", hostId), "STALE_NATIVE_CONTEXT");
  await database.update(schema.hosts).set({ websiteUrl: "https://venue.example/" }).where(eq(schema.hosts.id, hostId));
  const tamper = (await service.createNativeOfficialSourceDraft(owner, "host", hostId)).draft!;
  await database.update(schema.ownerAiNativeProfileDrafts).set({ packet: { intent: "Corrupt revision", profile: { phone: "+15555550999" } } }).where(eq(schema.ownerAiNativeProfileDrafts.id, tamper.id));
  await reject(service.approveNativeOwnerDraft(owner, tamper.id, 1, tamper.contentHash), "EXACT_NATIVE_REVISION_REQUIRED");
  assert.ok(!(await service.listNativeOwnerDrafts(owner, "host", hostId)).some((d: any) => d.id === tamper.id));
  const beforeDisable = (await service.createNativeOfficialSourceDraft(owner, "host", hostId)).draft!;
  await database.update(schema.users).set({ isDisabled: true }).where(eq(schema.users.id, owner));
  await reject(service.approveNativeOwnerDraft(owner, beforeDisable.id, 1, beforeDisable.contentHash), "CURRENT_NATIVE_OWNER_REQUIRED");
  await database.update(schema.users).set({ isDisabled: false }).where(eq(schema.users.id, owner));
  console.log("PASS unsafe content/booking fields, changed facts, hidden contact, transfer, disabled owner, native edit, capture race and packet tampering are held; website consent reaches actual supplier projector");
  const media = await service.createNativeOwnerDraft(owner, "host", hostId, { intent: "My logo", profile: { logoUrl: "https://venue.example/logo.png" }, mediaRights: { affirmed: true, affirmation: "I own this image and approve its use on my public profile." } }, (await service.getNativeOwnerContext(owner, "host", hostId)).version);
  assert.equal((media.mediaManifest as any[])[0].sha256, hash("image-original"));
  assert.equal((await service.getNativeOwnerMediaPreview(owner, media.id, "profile-logo")).buffer.toString(), "image-original");
  (globalThis as any).__nativeImageBytes = "image-changed";
  await reject(service.getNativeOwnerMediaPreview(owner, media.id, "profile-logo"), "MEDIA_CHANGED_OR_UNAVAILABLE");
  await reject(service.approveNativeOwnerDraft(owner, media.id, 1, media.contentHash), "MEDIA_CHANGED_OR_UNAVAILABLE");
  assert.equal((await database.select().from(schema.hosts))[0].logoUrl, null);
  (globalThis as any).__nativeImageBytes = "image-original";
  await service.approveNativeOwnerDraft(owner, media.id, 1, media.contentHash);
  assert.equal(toPublicLocationProfile({ row: (await database.select().from(schema.hosts))[0], baseUrl: "https://mealscout.example" }).logoUrl, "https://venue.example/logo.png");
  (globalThis as any).__nativeProfileHtml = '<a href="tel:+15555550199">Call</a><a href="/one.pdf">Menu</a><a href="/two.pdf">Menu</a>';
  const unrelated = (await service.createNativeOfficialSourceDraft(owner, "host", hostId)).draft!;
  assert.ok(unrelated); await service.approveNativeOwnerDraft(owner, unrelated.id, 1, unrelated.contentHash);
  (globalThis as any).__nativeProfileHtml = '<a href="tel:+15555550199">Call</a>';
  (globalThis as any).__nativeProfileHtmlByUrl = { "https://instagram.com/realvenue": '<a href="tel:+15555550888">Call</a>' };
  assert.equal((await service.createNativeOfficialSourceDraft(owner, "host", hostId)).draft, null);
  (globalThis as any).__nativeProfileHtmlByUrl = undefined;
  console.log("PASS reused actual immutable-media functions: byte-bound private preview and changed-image rejection; restored exact bytes reach native branding; unsupported menu conflicts do not poison phone consent; supported phone conflicts held");
  const day = "2026-10-01";
  const cases = [ { sourceUrls: [], holds: [], packet: null }, { sourceUrls: ["https://a.example/"], holds: ["SOURCE_UNAVAILABLE:https://a.example/"], packet: null }, { sourceUrls: ["https://a.example/"], holds: ["NO_CURRENT_COMPLETE_STRUCTURED_MENU"], packet: null } ];
  for (const [index, test] of cases.entries()) {
    const restaurantId = `80000000-0000-4000-8000-${String(index).padStart(12,"0")}`;
    const p = { version: 1, restaurantId, ownerId: owner, day, complete: true, checkedAt: new Date().toISOString(), sourceUrls: test.sourceUrls, proposal: { packet: test.packet, holds: test.holds, mutationPerformed: false, approvalRequired: true, canApply: false }, createsOwnerDrafts: false, publishes: false };
    await database.insert(schema.telemetryEvents).values({ id: foodReviews.ownerAiSourceReviewId(restaurantId, day), eventName: foodReviews.OWNER_AI_SOURCE_REVIEW_EVENT, userId: null, properties: { ...p, integritySha256: hash(canonicalSourceSection(p)) } });
  }
  const countBefore = (await database.select().from(schema.telemetryEvents)).length;
  const summary = await foodReviews.summarizeOwnerAiSourceReviewReasons(day);
  assert.equal(summary.heldReceipts, 3); assert.equal(summary.reasons.missing_official_source, 1); assert.equal(summary.reasons.source_unavailable_or_redirected, 1); assert.equal(summary.reasons.unsupported_or_incomplete_extraction, 1);
  assert.equal((await database.select().from(schema.telemetryEvents)).length, countBefore); assert.ok(!JSON.stringify(summary).includes("native-content-owner")); assert.ok(!JSON.stringify(summary).includes("https://")); assert.equal(summary.unrecordedFailuresClassified, false);
  assert.equal(externalNetworkCalls, 0);
  console.log("PASS reason counts read only exact-day integrity-checked source receipts; customer identifiers, URLs and facts excluded; missing historical failures explicitly unclassified; external network calls zero");
} finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); globalThis.fetch = nativeFetch; await engine.close(); }
