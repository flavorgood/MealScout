import assert from "node:assert/strict";
import { test } from "node:test";
import { onboardingResearchInputSchema, ONBOARDING_SERVICE_BUILD_ENABLED } from "../shared/onboardingJobs";
import { createOnboardingJobService, onboardingRequestHash, validateOnboardingResearchReceipt } from "../server/services/onboardingJobs";

const scope = { ownerId: "synthetic-owner", restaurantId: "00000000-0000-4000-8000-000000000147" };
const input = onboardingResearchInputSchema.parse({ businessName: "Synthetic business", location: "Synthetic city", officialLinks: ["https://official.example/"] });
const requestHash = onboardingRequestHash(scope, input);
const receipt = () => ({
  version: 1,
  requestHash,
  sources: [{ url: "https://official.example/", capturedAt: "2026-10-05T00:00:00Z", contentHash: "a".repeat(64), excerpt: "Synthetic source" }],
  observations: [{ field: "name", value: "Synthetic business", sourceUrl: "https://official.example/" }],
  unknowns: ["Service terms remain unset"],
});

test("canonical brief normalizes whitespace and declared-link order without inferring facts", () => {
  const normalized = onboardingResearchInputSchema.parse({ businessName: " Synthetic business ", location: " Synthetic city ", officialLinks: ["https://b.example/#fragment", "https://official.example", "https://b.example/"] });
  assert.deepEqual(normalized.officialLinks, ["https://b.example/", "https://official.example/"]);
  assert.equal(normalized.businessName, input.businessName);
  assert.equal(onboardingRequestHash(scope, normalized), onboardingRequestHash(scope, { ...normalized, officialLinks: [...normalized.officialLinks].reverse() }));
  assert.notEqual(requestHash, onboardingRequestHash({ ...scope, ownerId: "other-owner" }, input));
  assert.notEqual(requestHash, onboardingRequestHash(scope, { ...input, location: "Other city" }));
});

test("brief rejects extra payment/build/owner fields and bounds links and text", () => {
  for (const extra of [{ ownerId: "spoof" }, { paymentVerified: true }, { kind: "deep_build" }, { tier: 2500 }]) assert.throws(() => onboardingResearchInputSchema.parse({ ...input, ...extra }));
  assert.throws(() => onboardingResearchInputSchema.parse({ ...input, officialLinks: Array(5).fill("https://a.example/") }));
  assert.throws(() => onboardingResearchInputSchema.parse({ ...input, businessName: "x".repeat(201) }));
  for (const link of ["http://example.com/", "https://user:pass@example.com/", "javascript:alert(1)"]) assert.throws(() => onboardingResearchInputSchema.parse({ ...input, officialLinks: [link] }));
});

test("receipt binds only saved captures and leaves both scores unknown", () => {
  const saved = validateOnboardingResearchReceipt(receipt(), input, requestHash);
  assert.equal(saved.currentScore, null);
  assert.equal(saved.conditionalProjectedScore, null);
  assert.throws(() => validateOnboardingResearchReceipt({ ...receipt(), requestHash: "b".repeat(64) }, input, requestHash), (error: any) => error.code === "RESEARCH_BINDING_MISMATCH");
  assert.throws(() => validateOnboardingResearchReceipt({ ...receipt(), sources: [{ ...receipt().sources[0], url: "https://unrelated.example/" }] }, input, requestHash), (error: any) => error.code === "RESEARCH_SOURCE_MISMATCH");
  assert.throws(() => validateOnboardingResearchReceipt({ ...receipt(), observations: [{ ...receipt().observations[0], sourceUrl: "https://unrelated.example/" }] }, input, requestHash), (error: any) => error.code === "RESEARCH_SOURCE_MISMATCH");
  assert.throws(() => validateOnboardingResearchReceipt({ ...receipt(), currentScore: 100 }, input, requestHash));
  assert.throws(() => validateOnboardingResearchReceipt({ ...receipt(), conditionalProjectedScore: { value: 100 } }, input, requestHash));
});

test("UTF-8 receipt cap rejects bounded fields whose combined bytes exceed storage budget", () => {
  const large = { ...receipt(), observations: Array.from({ length: 24 }, (_, i) => ({ field: "field-" + i, value: "漢".repeat(2_048), sourceUrl: "https://official.example/" })) };
  assert.throws(() => validateOnboardingResearchReceipt(large, input, requestHash), (error: any) => error.code === "RESEARCH_RECEIPT_TOO_LARGE");
});

test("service payment/build entry stays disabled without any DB, provider or model work", async () => {
  let calls = 0;
  const service = createOnboardingJobService({ async transaction() { calls++; throw new Error("No database work permitted"); } });
  assert.equal(ONBOARDING_SERVICE_BUILD_ENABLED, false);
  await assert.rejects(() => service.startServiceBuild(), (error: any) => error.status === 503 && error.code === "SERVICE_BUILD_INTEGRATION_REQUIRED");
  assert.equal(calls, 0);
});
