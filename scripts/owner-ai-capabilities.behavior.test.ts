import assert from "node:assert/strict";
import { test } from "node:test";
import { OWNER_AI_PROFILE_TYPES, previewOwnerAiPacket, readOwnerAiCapabilities, OwnerAiCapabilityError } from "../shared/ownerAiCapabilities";
const now = "2026-09-30T12:00:00Z";
const provenance = { source: "owner-confirmed source", observedAt: "2026-09-30T11:00:00Z", access: "public", expiresAt: "2026-10-01T12:00:00Z" };
const versions = { restaurant: "r1", menus: "m1", schedules: "s1", deals: "d1" };
function fixture(type = "truck") {
  const target = { profileType: type, profileId: "profile-a" };
  return { target, now,
    authority: { target: { ...target }, currentOwnerId: "owner-a", adapter: "restaurant_native", backingRestaurantId: "profile-a", currentVersions: { ...versions }, provenance: { ...provenance } },
    principal: { apiKeyId: "key-a", userId: "owner-a", target: { ...target }, scopes: ["owner_ai:context", "owner_ai:drafts:create"], isActive: true, expiresAt: "2026-10-01T12:00:00Z", revokedAt: null as string | null },
    request: { packet: { intent: "Update details", profile: { description: "Owner supplied details" } } as Record<string, unknown>, expectedVersions: { ...versions }, provenance: { ...provenance } },
  };
}
function rejects(input: ReturnType<typeof fixture>, code: string) {
  assert.throws(() => previewOwnerAiPacket(input), (e: unknown) => e instanceof OwnerAiCapabilityError && e.code === code);
}
test("all canonical types advertised; only matching verified native adapter previews", () => {
  for (const type of OWNER_AI_PROFILE_TYPES) {
    const input = fixture(type);
    const supported = ["restaurant", "truck", "bar", "caterer", "private_chef"].includes(type);
    if (!supported) { input.authority.adapter = "unsupported"; input.authority.backingRestaurantId = "unused"; }
    const result = readOwnerAiCapabilities(input);
    assert.equal(result.profiles.length, 8);
    assert.equal(result.profiles.find(p => p.profileType === type)?.details, supported);
    assert.ok(result.profiles.every(p => !p.settings));
    if (supported) { const preview = previewOwnerAiPacket(input); assert.equal(preview.canApply, false); assert.equal(preview.approvalRequired, true); }
    else rejects(input, "UNSUPPORTED_ADAPTER");
  }
});
test("owner, immutable type/id and backing adapter bindings fail closed", () => {
  const owner = fixture(); owner.authority.currentOwnerId = "new-owner"; rejects(owner, "CURRENT_OWNER_REQUIRED");
  const id = fixture(); id.target.profileId = "other"; rejects(id, "TARGET_MISMATCH");
  const type = fixture(); type.authority.target.profileType = "bar"; rejects(type, "TARGET_MISMATCH");
  const backing = fixture(); backing.authority.backingRestaurantId = "other"; rejects(backing, "ADAPTER_TARGET_MISMATCH");
  const location = fixture("location"); rejects(location, "ADAPTER_TARGET_MISMATCH");
});
test("context/create scopes, expiry and revocation checked without approval scope", () => {
  for (const scope of ["owner_ai:context", "owner_ai:drafts:create"]) { const input = fixture(); input.principal.scopes = input.principal.scopes.filter(s => s !== scope); rejects(input, scope.endsWith("context") ? "CONTEXT_SCOPE_REQUIRED" : "CREATE_SCOPE_REQUIRED"); }
  const read = fixture(); read.principal.scopes = ["owner_ai:context"]; assert.equal(readOwnerAiCapabilities(read).profiles.find(p => p.profileType === "truck")?.details, false);
  for (const state of ["expired", "revoked", "inactive"]) { const input = fixture(); if (state === "expired") input.principal.expiresAt = now; if (state === "revoked") input.principal.revokedAt = now; if (state === "inactive") input.principal.isActive = false; rejects(input, "PRINCIPAL_INACTIVE"); }
});
test("current versions mandatory and stale packets rejected", () => {
  const stale = fixture(); stale.request.expectedVersions.schedules = "old"; rejects(stale, "STALE_CONTEXT");
  const missing = fixture(); delete (missing.request as Partial<typeof missing.request>).expectedVersions; rejects(missing, "INVALID_INPUT");
});
test("native strict schema rejects settings, apply flags and unsupported social", () => {
  for (const field of ["settings", "apply", "profileId"]) { const input = fixture(); input.request.packet[field] = {}; rejects(input, "INVALID_INPUT"); }
  const social = fixture(); social.request.packet.social = { platforms: ["facebook"] }; rejects(social, "UNSUPPORTED_CAPABILITY");
});
test("dated source and explicit public schedule access preserve private/restricted boundaries", () => {
  for (const access of ["private", "restricted", "unknown"]) { const input = fixture(); input.request.provenance.access = access; rejects(input, access === "unknown" ? "SOURCE_UNAVAILABLE" : "PUBLIC_ACCESS_REQUIRED"); }
  const expired = fixture(); expired.request.provenance.expiresAt = now; rejects(expired, "SOURCE_UNAVAILABLE");
  const context = fixture(); context.authority.provenance.expiresAt = now; rejects(context, "CONTEXT_EXPIRED");
  const missing = fixture(); missing.request.packet = { intent: "Stop", schedules: [{ date: "2026-10-01" }] }; rejects(missing, "EXPLICIT_SCHEDULE_ACCESS_REQUIRED");
  const privateStop = fixture(); privateStop.request.provenance.access = "private"; privateStop.request.packet = { intent: "Private stop", schedules: [{ date: "2026-10-01", isPublic: false, timezone: "America/Chicago", expiresAt: "2026-10-02T00:00:00Z" }] }; assert.equal(previewOwnerAiPacket(privateStop).packet.schedules?.[0].isPublic, false);
  privateStop.request.packet.schedules = [{ date: "2026-10-01", isPublic: true }]; rejects(privateStop, "PUBLIC_ACCESS_REQUIRED");
});
test("dated stops require timezone/absolute expiry and cannot resurrect past dates", () => {
  const input = fixture(); input.request.packet = { intent: "Stop", schedules: [{ date: "2026-10-01", isPublic: true }] }; rejects(input, "DATED_STOP_CONTEXT_REQUIRED");
  input.request.packet.schedules = [{ date: "2026-09-29", isPublic: true, timezone: "America/Chicago", expiresAt: "2026-10-02T00:00:00Z" }]; rejects(input, "SCHEDULE_EXPIRED");
  input.request.packet.schedules = [{ date: "2026-10-01", isPublic: true, timezone: "unknown", expiresAt: "2026-10-02T00:00:00Z" }]; rejects(input, "INVALID_INPUT");
  const noVersions = fixture(); (noVersions.authority as { currentVersions: unknown }).currentVersions = null;
  assert.ok(readOwnerAiCapabilities(noVersions).profiles.every(p => !p.schedules)); rejects(noVersions, "STALE_CONTEXT");
  assert.throws(() => readOwnerAiCapabilities(fixture("event")), (e: unknown) => e instanceof OwnerAiCapabilityError && e.code === "INVALID_INPUT");
});
test("synchronous capture detaches and freezes returned target, versions and source", async () => {
  const input = fixture(); const pending = Promise.resolve(previewOwnerAiPacket(input));
  input.target.profileId = "other"; input.request.expectedVersions.restaurant = "changed"; input.request.provenance.source = "changed";
  const result = await pending;
  assert.equal(result.target.profileId, "profile-a"); assert.equal(result.expectedVersions.restaurant, "r1"); assert.equal(result.provenance.source, provenance.source);
  assert.ok(Object.isFrozen(result.target)); assert.ok(Object.isFrozen(result.packet.profile));
});
test("calendar dates reject rollover and accept a valid leap day", () => {
  for (const date of ["2026-09-31", "2027-02-29"]) {
    const input = fixture(); input.request.packet = { intent: "Stop", schedules: [{ date, isPublic: true, timezone: "America/Chicago", expiresAt: "2028-03-01T00:00:00Z" }] };
    rejects(input, "INVALID_INPUT");
  }
  const leap = fixture(); leap.request.packet = { intent: "Leap stop", schedules: [{ date: "2028-02-29", isPublic: true, timezone: "America/Chicago", expiresAt: "2028-03-01T00:00:00Z" }] };
  assert.equal(previewOwnerAiPacket(leap).packet.schedules?.[0].date, "2028-02-29");
});
test("private authority advertises private schedules without unavailable public edits", () => {
  const input = fixture();
  input.authority.provenance.access = "private";
  const capability = readOwnerAiCapabilities(input).profiles.find(profile => profile.profileType === "truck")!;
  assert.equal(capability.details, false);
  assert.equal(capability.menus, false);
  assert.equal(capability.prices, false);
  assert.equal(capability.locations, false);
  assert.equal(capability.photos, false);
  assert.equal(capability.schedules, true);
  assert.equal(capability.scheduleAccess, "private_only");
  rejects(input, "PUBLIC_ACCESS_REQUIRED");
  input.request.provenance.access = "private";
  input.request.packet = { intent: "Owner-private stop", schedules: [{ date: "2026-10-01", isPublic: false, timezone: "America/Chicago", expiresAt: "2026-10-02T05:00:00Z" }] };
  assert.equal(previewOwnerAiPacket(input).packet.schedules?.[0].isPublic, false);
});
test("future closure preview expiry must fall inside its own local day", () => {
  for (const expiresAt of ["2026-10-01T05:00:00Z", "2026-11-01T05:00:00Z", "2026-11-02T06:00:01Z"]) {
    const input = fixture();
    input.request.packet = { intent: "One dated closure", schedules: [{ status: "closed", date: "2026-11-01", isPublic: true, timezone: "America/Chicago", expiresAt }] };
    rejects(input, "INVALID_INPUT");
  }
  const valid = fixture();
  valid.request.packet = { intent: "One dated closure", schedules: [{ status: "closed", date: "2026-11-01", isPublic: true, timezone: "America/Chicago", expiresAt: "2026-11-02T06:00:00Z" }] };
  assert.equal(previewOwnerAiPacket(valid).packet.schedules?.[0].status, "closed");
});
