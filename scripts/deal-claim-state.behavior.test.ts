import assert from "node:assert/strict";
import test from "node:test";
import { dealClaimStatus, dealDirectionsHref, dealIntentPath, dealPhoneHref, displayClaimStatus, isDealAuthenticationError, receiptDateLabel, readClaimList, readClaimResponse, type DealClaimReceipt } from "../client/src/lib/deal-claim-state";

const now = Date.parse("2026-10-22T12:00:00Z");
const active: DealClaimReceipt = { id: "synthetic-receipt", dealId: "synthetic-deal", claimedAt: "2026-10-22T11:00:00Z", isUsed: false, isActive: true, restaurantIsActive: true, startDate: "2026-10-01T00:00:00Z", endDate: "2026-10-23T00:00:00Z" };

test("wallet status follows persisted usage, expiry and availability rather than unused alone", () => {
  assert.equal(dealClaimStatus(active, now), "Active");
  assert.match(displayClaimStatus(dealClaimStatus(active, now)), /Claimed.*check offer hours/);
  assert.equal(dealClaimStatus({ ...active, endDate: new Date(now).toISOString() }, now), "Expired");
  assert.equal(dealClaimStatus({ ...active, endDate: "2026-10-21T00:00:00Z", isUsed: true }, now), "Used");
  assert.equal(dealClaimStatus({ ...active, usedAt: "2026-10-22T11:30:00Z" }, now), "Used");
  assert.equal(dealClaimStatus({ ...active, isActive: false }, now), "Unavailable");
  assert.equal(dealClaimStatus({ ...active, restaurantIsActive: false }, now), "Unavailable");
  assert.equal(dealClaimStatus({ ...active, startDate: "2026-10-23T00:00:00Z" }, now), "Upcoming");
  assert.equal(dealClaimStatus({ ...active, endDate: null, isOngoing: true }, now), "Active");
  assert.equal(dealClaimStatus({ ...active, endDate: null }, now), "Unavailable");
  assert.equal(dealClaimStatus({ ...active, endDate: "invalid" }, now), "Unavailable");
  assert.equal(dealClaimStatus({ ...active, isUsed: null }, now), "Unavailable");
});

test("raw Response must be decoded and a persisted receipt validated", async () => {
  const response = new Response(JSON.stringify({ success: true, claimId: active.id, claim: active, replayed: false }));
  assert.throws(() => readClaimResponse(response, active.dealId), /could not be read/);
  assert.deepEqual(readClaimResponse(await response.json(), active.dealId), active);
  assert.throws(() => readClaimResponse({ success: true, claim: active }, "other-deal"), /could not be read/);
  assert.throws(() => readClaimList({ claims: [] }), /could not be read/);
  assert.throws(() => readClaimList([null]), /could not be read/);
  assert.throws(() => readClaimList([{ ...active, claimedAt: "not-a-date" }]), /could not be read/);
  assert.throws(() => readClaimResponse({ success: true, claim: { ...active, id: "" } }, active.dealId), /could not be read/);
  assert.deepEqual(readClaimList([]), []);
  assert.deepEqual(readClaimList([{ ...active, isUsed: null }]), [{ ...active, isUsed: null }]);
});

test("canonical expired-session errors retain claim/save login continuation", () => {
  const errorMessage = "Authentication required"; // unifiedAuth's native 401 JSON error.
  assert.equal(isDealAuthenticationError(errorMessage), true);
  assert.equal(isDealAuthenticationError("Deal is no longer available"), false);
  const original = "/deal/taco--synthetic?ref=fixture#terms";
  for (const intent of ["claim", "save"] as const) {
    const login = `/login?redirect=${encodeURIComponent(dealIntentPath(original, intent))}`;
    assert.equal(new URL(login, "https://www.mealscout.us").searchParams.get("redirect"), `/deal/taco--synthetic?ref=fixture&intent=${intent}#terms`);
  }
  assert.equal(receiptDateLabel("invalid"), "Date unavailable");
});

test("login continuation retains original deal query and hash without issuing a claim", () => {
  assert.equal(dealIntentPath("/deal/taco--synthetic?ref=fixture#terms", "claim"), "/deal/taco--synthetic?ref=fixture&intent=claim#terms");
  assert.equal(dealIntentPath("/deal/synthetic?intent=claim", "save"), "/deal/synthetic?intent=save");
});

test("contact actions only use supplied phone/address facts", () => {
  assert.equal(dealPhoneHref(null), null);
  assert.equal(dealPhoneHref("call us"), null);
  assert.equal(dealPhoneHref("+1 (212) 555-0199"), "tel:+12125550199");
  assert.equal(dealDirectionsHref("  "), null);
  assert.equal(dealDirectionsHref("12 Test St, Example"), "https://www.google.com/maps/dir/?api=1&destination=12%20Test%20St%2C%20Example");
});
