import assert from "node:assert/strict";
import { test } from "node:test";
import { createOwnerAiProfileCapabilities, deriveOwnerAiPublicationPolicy, type OwnerAiProfileDependencies } from "../server/services/ownerAiProfileCapabilities";
import { OWNER_AI_PROFILE_PREVIEW_JSON_SCHEMA } from "../shared/ownerAiCapabilities";
import { OWNER_AI_PACKET_JSON_SCHEMA } from "../shared/ownerAiActions";
const now = new Date("2026-09-30T12:00:00Z");
const versions = { restaurant: "r1", menus: "m1", schedules: "s1", deals: "d1" };
function fixture() {
  const principal = { apiKeyId: "key-a", userId: "owner-a", restaurantId: "restaurant-a", scopes: ["owner_ai:context", "owner_ai:drafts:create", "owner_ai:drafts:approve"] };
  const credential = { id: principal.apiKeyId, userId: principal.userId, restaurantId: principal.restaurantId, purpose: "owner_ai_connector", scope: "owner_ai:context owner_ai:drafts:create", isActive: true, expiresAt: new Date("2026-10-01T00:00:00Z"), revokedAt: null as Date | null };
  const restaurant = { id: principal.restaurantId, ownerId: principal.userId, businessType: "food_truck", publicSurface: true, blockedProfileFields: [] as string[] };
  const state = { credential, restaurant, contextReads: 0, bindingReads: 0, duringRead: () => {} };
  const deps: OwnerAiProfileDependencies = {
    now: () => now,
    async readBinding(p) { state.bindingReads++; return { credential: p.apiKeyId === credential.id ? { ...credential } : undefined, restaurant: p.restaurantId === restaurant.id ? { ...restaurant } : undefined }; },
    async readContext(id) { assert.equal(id, restaurant.id); state.contextReads++; const businessType = restaurant.businessType; state.duringRead(); return { restaurant: { id, businessType }, expectedVersions: { ...versions } }; },
  };
  const request = { packet: { intent: "Owner details", profile: { description: "New details" } }, expectedVersions: { ...versions }, provenance: { source: "An agent claims owner confirmation", observedAt: now.toISOString(), access: "public", expiresAt: "2026-10-01T00:00:00Z" } };
  return { principal, state, request, service: createOwnerAiProfileCapabilities(deps) };
}
const rejectsCode = (operation: () => Promise<unknown>, code: string) => assert.rejects(operation, (error: any) => error.code === code);
test("portable preview discovery schema requires the strict request and resolves every native reference", () => {
  const schema = OWNER_AI_PROFILE_PREVIEW_JSON_SCHEMA;
  assert.ok(new URL(schema.$id).pathname.endsWith("owner-ai-profile-preview.v1.json"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["packet", "expectedVersions", "provenance"]);
  assert.deepEqual(schema.properties.packet, OWNER_AI_PACKET_JSON_SCHEMA.properties.packet);
  assert.deepEqual(schema.properties.expectedVersions, OWNER_AI_PACKET_JSON_SCHEMA.properties.expectedVersions);
  assert.deepEqual(schema.properties.provenance.required, ["source", "observedAt", "access", "expiresAt"]);
  assert.equal(schema.properties.provenance.additionalProperties, false);
  assert.deepEqual(schema.properties.provenance.properties.access.enum, ["public", "private", "restricted", "unknown"]);
  let references = 0;
  function walk(value: unknown) {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (typeof node.$ref === "string") {
      references++;
      assert.ok(node.$ref.startsWith("#/$defs/"), `Unexpected reference scope: ${node.$ref}`);
      const target = node.$ref.slice(2).split("/").reduce((parent: any, key) => parent?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], schema);
      assert.ok(target && typeof target === "object", `Dangling reference: ${node.$ref}`);
    }
    Object.values(node).forEach(walk);
  }
  walk(schema);
  assert.ok(references > 10, "Native packet definitions must be discoverable, not an opaque object");
});
test("native field redaction does not suppress independently public profile or dated stops", async () => {
  const row = { isActive: true, businessType: "food_truck", rawData: {} };
  const visible = { ownerEnabled: true, showAddress: true, showContact: true };
  const truckPolicy = deriveOwnerAiPublicationPolicy(row, visible);
  assert.equal(truckPolicy.publicSurface, true);
  assert.ok(truckPolicy.blockedProfileFields.includes("address"));
  const truck = fixture(); Object.assign(truck.state.restaurant, truckPolicy);
  const stopRequest = { ...truck.request, packet: { intent: "Public dated stop", schedules: [{ date: "2026-10-01", timezone: "America/Chicago", expiresAt: "2026-10-02T00:00:00Z", isPublic: true, locationName: "Public venue", startTime: "10:00", endTime: "12:00" }] } };
  assert.equal((await truck.service.preview(truck.principal, stopRequest)).canApply, false);
  await rejectsCode(() => truck.service.preview(truck.principal, { ...truck.request, packet: { intent: "Hidden address", profile: { address: "Owner private admin address" } } }), "PROFILE_FIELD_NOT_PUBLIC");
  const chef = fixture(); chef.state.restaurant.businessType = "private_chef";
  Object.assign(chef.state.restaurant, deriveOwnerAiPublicationPolicy({ ...row, businessType: "private_chef" }, { ...visible, showAddress: false, showContact: false }));
  assert.equal((await chef.service.preview(chef.principal, chef.request)).target.profileType, "private_chef");
  assert.equal(deriveOwnerAiPublicationPolicy(row, undefined).publicSurface, false);
  assert.equal(deriveOwnerAiPublicationPolicy({ ...row, isActive: false }, visible).publicSurface, false);
  assert.equal(deriveOwnerAiPublicationPolicy(row, { ...visible, ownerEnabled: false }).publicSurface, false);
  const quarantined = deriveOwnerAiPublicationPolicy({ ...row, rawData: { evidenceQuarantine: { active: true } } }, visible);
  assert.equal(quarantined.publicSurface, true);
  for (const field of ["phone", "websiteUrl", "logoUrl", "gallery", "address"]) assert.ok(quarantined.blockedProfileFields.includes(field));
  const rejected = deriveOwnerAiPublicationPolicy({ ...row, rawData: { evidenceQuarantine: { active: false, decisions: { contact_phone: { status: "rejected" } } } } }, visible);
  assert.ok(rejected.blockedProfileFields.includes("phone"));
  const q = fixture(); Object.assign(q.state.restaurant, quarantined);
  await rejectsCode(() => q.service.preview(q.principal, { ...q.request, packet: { intent: "Hidden phone", profile: { phone: "secret" } } }), "PROFILE_FIELD_NOT_PUBLIC");
});
test("server persisted type/versions bind read and preview without creating a draft or applying", async () => {
  const f = fixture();
  const read = await f.service.read(f.principal);
  assert.deepEqual(read.target, { profileId: "restaurant-a", profileType: "truck" });
  assert.equal(read.canApply, false);
  const preview = await f.service.preview(f.principal, f.request);
  assert.equal(preview.sourceVerification, "declared_unverified");
  assert.equal(preview.mutationPerformed, false);
  assert.equal(preview.canApply, false);
  assert.equal(f.state.contextReads, 2);
  assert.equal(f.state.bindingReads, 4);
});
test("current DB credential overrides stale authenticated scopes and stops context read", async () => {
  const f = fixture(); f.state.credential.scope = "owner_ai:drafts:create";
  await rejectsCode(() => f.service.read(f.principal), "CONTEXT_SCOPE_REQUIRED");
  assert.equal(f.state.contextReads, 0);
});
test("revoked/expired/inactive credentials fail before native inventory read", async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.state.credential.revokedAt = now; }, (f: ReturnType<typeof fixture>) => { f.state.credential.expiresAt = now; }, (f: ReturnType<typeof fixture>) => { f.state.credential.isActive = false; }]) {
    const f = fixture(); change(f); await rejectsCode(() => f.service.preview(f.principal, f.request), "PRINCIPAL_INACTIVE"); assert.equal(f.state.contextReads, 0);
  }
});
test("ownership transfer and revocation during snapshot fail closed", async () => {
  const cases: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [["CURRENT_OWNER_REQUIRED", f => { f.state.restaurant.ownerId = "new-owner"; }], ["PRINCIPAL_INACTIVE", f => { f.state.credential.revokedAt = now; }]];
  for (const [code, change] of cases) {
    const f = fixture(); f.state.duringRead = () => change(f);
    await rejectsCode(() => f.service.preview(f.principal, f.request), code);
  }
});
test("cross-key/profile, unknown persisted adapter and changed native type reject", async () => {
  const key = fixture(); key.principal.apiKeyId = "other"; await rejectsCode(() => key.service.read(key.principal), "CURRENT_OWNER_REQUIRED");
  const profile = fixture(); profile.principal.restaurantId = "other"; await rejectsCode(() => profile.service.read(profile.principal), "CURRENT_OWNER_REQUIRED");
  const unsupported = fixture(); unsupported.state.restaurant.businessType = "host_venue"; await rejectsCode(() => unsupported.service.read(unsupported.principal), "UNSUPPORTED_ADAPTER");
  const type = fixture(); type.state.duringRead = () => { type.state.restaurant.businessType = "host_venue"; }; await rejectsCode(() => type.service.read(type.principal), "STALE_CONTEXT");
});
test("source claims cannot override visibility, stale versions, create scopes or strict request shape", async () => {
  const hidden = fixture(); hidden.state.restaurant.publicSurface = false; await rejectsCode(() => hidden.service.preview(hidden.principal, hidden.request), "PUBLIC_ACCESS_REQUIRED");
  const stale = fixture(); stale.request.expectedVersions.restaurant = "old"; await rejectsCode(() => stale.service.preview(stale.principal, stale.request), "STALE_CONTEXT");
  const scope = fixture(); scope.state.credential.scope = "owner_ai:context"; await rejectsCode(() => scope.service.preview(scope.principal, scope.request), "CREATE_SCOPE_REQUIRED");
  for (const extra of [{ principal: { userId: "owner-a" } }, { profileType: "restaurant" }, { apply: true }]) {
    const f = fixture(); await rejectsCode(() => f.service.preview(f.principal, { ...f.request, ...extra }), "INVALID_INPUT");
  }
});
