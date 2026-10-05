import assert from "node:assert/strict";
import { test } from "node:test";
import { readSavedBusinessDomain, verifySelfManagedDomain } from "../shared/domainLinking";
const restaurantId = "00000000-0000-4000-8000-000000000201";
const saved = {
  hostname: "food.example.com", restaurantId, canonicalPath: "/restaurant/" + restaurantId,
  status: "verified", expectedTarget: "synthetic-host.example.com",
  lastCheckedAt: "2026-10-05T00:00:00Z", diagnostics: "",
};

test("DIY verification sends only hostname/business to the existing free endpoint", async () => {
  let calls = 0;
  const result = await verifySelfManagedDomain(restaurantId, " FOOD.EXAMPLE.COM ", async (path, body) => {
    calls++;
    assert.equal(path, "/api/settings/custom-domain/verify");
    assert.deepEqual(body, { hostname: "food.example.com", restaurantId });
    return saved;
  });
  assert.equal(result.status, "verified");
  assert.equal(calls, 1);
});

test("invalid hostname fails before any verification request", async () => {
  let calls = 0;
  for (const hostname of ["https://food.example.com", "user:pass@example.com", "food.example.com/path", "x".repeat(256), "<script>.com"]) {
    await assert.rejects(() => verifySelfManagedDomain(restaurantId, hostname, async () => { calls++; return saved; }));
  }
  assert.equal(calls, 0);
});

test("response must retain exact business/hostname/canonical profile identity", async () => {
  for (const change of [
    { restaurantId: "00000000-0000-4000-8000-000000000202" },
    { hostname: "other.example.com" },
    { canonicalPath: "/unrelated-profile" },
    { expectedTarget: "https://untrusted.example/" },
    { status: "paid_verified" },
  ]) await assert.rejects(() => verifySelfManagedDomain(restaurantId, "food.example.com", async () => ({ ...saved, ...change })), /DOMAIN_VERIFICATION_BINDING_MISMATCH/);
});

test("mismatch/error retain the actual server target without declaring a working domain", async () => {
  for (const status of ["mismatch", "error"]) {
    const result = await verifySelfManagedDomain(restaurantId, "food.example.com", async () => ({ ...saved, status, diagnostics: "Synthetic DNS result" }));
    assert.equal(result.status, status);
    assert.equal(result.expectedTarget, saved.expectedTarget);
  }
});

test("CNAME target retains www while normalizing DNS case and trailing dot", async () => {
  const result = await verifySelfManagedDomain(restaurantId, "food.example.com.", async (_path, body) => {
    assert.equal(body.hostname, "food.example.com");
    return { ...saved, expectedTarget: "WWW.SYNTHETIC-HOST.EXAMPLE.COM." };
  });
  assert.equal(result.expectedTarget, "www.synthetic-host.example.com");
});

test("stored domain for another business is hidden and www normalization matches existing verifier", async () => {
  assert.equal(readSavedBusinessDomain(saved, "00000000-0000-4000-8000-000000000202"), null);
  const result = await verifySelfManagedDomain(restaurantId, "www.food.example.com", async (_path, body) => {
    assert.equal(body.hostname, "food.example.com");
    return saved;
  });
  assert.equal(result.hostname, "food.example.com");
});
