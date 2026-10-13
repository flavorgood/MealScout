import assert from "node:assert/strict";
import test from "node:test";
import { resolveProgressivePostVerificationDestination } from "../shared/progressiveOnboarding";

const truckIntent = "/restaurant-signup?businessType=food_truck&claim=1";
const menuIntent = "/menu-builder?reviewDraft=1#kept";

test("legacy check-email keeps same-session truck intent over the generic query", () => {
  assert.equal(resolveProgressivePostVerificationDestination(
    new URLSearchParams("status=check-email"), "/scout", truckIntent,
  ), truckIntent);
});

test("fresh emailed redirects win over stale saved intent", () => {
  for (const destination of ["/host-signup", "/scout", menuIntent]) {
    assert.equal(resolveProgressivePostVerificationDestination(
      new URLSearchParams("verified=1"), destination, "/supplier/dashboard",
    ), destination);
  }
});

test("explicit progressive destinations win over saved legacy intent", () => {
  for (const reason of ["keep_draft", "contact", "restricted"]) {
    for (const destination of ["/scout", menuIntent]) {
      assert.equal(resolveProgressivePostVerificationDestination(
        new URLSearchParams({ status: "check-email", reason }), destination, truckIntent,
      ), destination);
    }
  }
});

test("unsafe destinations are rejected in both priority orders", () => {
  for (const context of ["status=check-email", "verified=1", "reason=keep_draft"]) {
    for (const unsafe of ["https://outside.test/pay", "//outside.test/pay", "javascript:alert(1)"]) {
      assert.equal(resolveProgressivePostVerificationDestination(
        new URLSearchParams(context), unsafe, unsafe, "/dashboard",
      ), "/dashboard");
    }
  }
});

test("missing or unsafe preferred paths safely fall back without invented authority", () => {
  assert.equal(resolveProgressivePostVerificationDestination(
    new URLSearchParams("verified=1"), null, truckIntent,
  ), truckIntent);
  assert.equal(resolveProgressivePostVerificationDestination(
    new URLSearchParams("status=check-email"), menuIntent, "//outside.test",
  ), menuIntent);
  assert.equal(resolveProgressivePostVerificationDestination(
    new URLSearchParams("status=check-email&reason=owner&ownerId=forged"), "/scout", truckIntent,
  ), truckIntent);
  assert.equal(resolveProgressivePostVerificationDestination(
    new URLSearchParams(), null, null, "//outside.test",
  ), "/profile-setup");
});

test("account setup requires an actual nonempty query token in every priority position", () => {
  for (const context of ["status=check-email", "verified=1", "reason=keep_draft"]) {
    const params = new URLSearchParams(context);
    for (const tokenless of [
      "/account-setup", "/account-setup#kept", "/account-setup?token=#kept",
      "/account-setup/?token=", "/ACCOUNT-SETUP#kept", "/account-setup?token=%20#kept",
    ]) {
      assert.equal(resolveProgressivePostVerificationDestination(params, tokenless, tokenless), "/dashboard");
      assert.equal(resolveProgressivePostVerificationDestination(params, tokenless, menuIntent), menuIntent);
      assert.equal(resolveProgressivePostVerificationDestination(params, menuIntent, tokenless), menuIntent);
      assert.equal(resolveProgressivePostVerificationDestination(params, null, null, tokenless), "/profile-setup");
    }
    const tokenized = "/account-setup?token=opaque-server-token#kept";
    assert.equal(resolveProgressivePostVerificationDestination(params, tokenized, tokenized), tokenized);
  }
});
