import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GuestBusinessDraft } from "../client/src/components/guest-business-draft";
import {
  buildGuestBusinessSignupPath,
  buildProgressiveAccountPath,
  getProgressiveAccountAction,
  getProgressiveAccountGate,
  getGuestBusinessDraftIntent,
  getGuestClaimPrefillValue,
  GUEST_BUSINESS_DRAFT_KEY,
  persistGuestBusinessDraft,
  preserveProgressiveAuthContext,
  resolveProgressiveAuthDestination,
  shouldRestoreGuestBusinessDraft,
} from "../shared/progressiveOnboarding";
import { parseBusinessSignupRouteIntent } from "../shared/businessSignupIntent";

test("a guest and an unverified account stay distinct from a verified account", () => {
  assert.equal(getProgressiveAccountGate(null), "sign_in");
  for (const emailVerified of [undefined, null, false, "true", 1]) {
    assert.equal(getProgressiveAccountGate({ emailVerified }), "verify_email");
  }
  assert.equal(getProgressiveAccountGate({ emailVerified: true }), "continue");
});

for (const action of ["keep_draft", "contact", "restricted"] as const) {
  test(`${action} preserves the intended internal path without executing the action`, () => {
    const destination = "/restaurant-signup?businessType=food_truck&intent=claim&claimListingId=truck-1#details";
    for (const gate of ["sign_in", "verify_email"] as const) {
      const url = new URL(buildProgressiveAccountPath(gate, action, destination), "https://www.mealscout.us");
      assert.equal(url.pathname, gate === "sign_in" ? "/login" : "/post-verification");
      assert.equal(url.searchParams.get("redirect"), destination);
      assert.equal(url.searchParams.get("reason"), action);
      assert.equal(url.searchParams.get("status"), gate === "verify_email" ? "check-email" : null);
      assert.equal(url.searchParams.has("send"), false);
      assert.equal(url.searchParams.has("pay"), false);
    }
  });
}

for (const destination of ["https://other.example/contact", "//other.example", "/\\other.example", "/profile\ncontact"]) {
  test(`unsafe auth destination ${JSON.stringify(destination)} cannot replace the local continuation`, () => {
    const url = new URL(buildProgressiveAccountPath("sign_in", "contact", destination), "https://www.mealscout.us");
    assert.equal(url.searchParams.get("redirect"), "/profile-setup");
  });
}

test("keep preserves claim destination and its existing listing/referral context", () => {
  const intent = parseBusinessSignupRouteIntent("businessType=food_truck&intent=claim&claimListingId=truck-1&q=Tacos&ref=member-1");
  const path = buildGuestBusinessSignupPath(intent, "food_truck");
  const url = new URL(path, "https://www.mealscout.us");
  assert.equal(url.pathname, "/restaurant-signup");
  assert.equal(url.searchParams.get("intent"), "claim");
  assert.equal(url.searchParams.get("claimListingId"), "truck-1");
  assert.equal(url.searchParams.get("ref"), "member-1");
  assert.equal(url.searchParams.get("keepDraft"), "1");
});

test("a newly selected business type reaches the matching account flow", () => {
  const intent = parseBusinessSignupRouteIntent("businessType=restaurant&source=profile-setup");
  const url = new URL(buildGuestBusinessSignupPath(intent, "caterer"), "https://www.mealscout.us");
  assert.equal(url.searchParams.get("businessType"), "caterer");
  assert.equal(url.searchParams.get("intent"), "create");
  assert.equal(url.searchParams.get("source"), "profile-setup");
});

test("the existing signup draft key carries profile fields through authentication", () => {
  let storedKey = "";
  let storedValue = "";
  const profile = { name: "Guest Tacos", city: "Pensacola", businessType: "food_truck", description: "A private design", websiteUrl: "https://food.example/menu", phone: "5550000000", latitude: 30.4, acceptTerms: false };
  assert.equal(persistGuestBusinessDraft({setItem(key, value) { storedKey=key; storedValue=value; }}, profile, 1000), true);
  assert.equal(storedKey, GUEST_BUSINESS_DRAFT_KEY);
  assert.deepEqual(JSON.parse(storedValue), {...profile, __savedAt:1000});
});

test("account secrets and client authority claims are not carried as a profile draft", () => {
  let storedValue = "";
  const draft = {name:"Private",password:"unused-secret",confirmPassword:"unused-secret",email:"synthetic@example.test",emailVerified:true,userId:"other",ownerId:"other",restaurantId:"other",subscription:"paid",membership:true,token:"unused-token"};
  assert.equal(persistGuestBusinessDraft({setItem(_key, value) { storedValue=value; }}, draft, 1000), true);
  assert.deepEqual(JSON.parse(storedValue), {name:"Private",__savedAt:1000});
});

test("blocked storage and quota errors hold the draft on the current page", () => {
  assert.equal(persistGuestBusinessDraft(() => {throw new Error("Storage denied");}, {name:"Still here"}), false);
  assert.equal(persistGuestBusinessDraft({setItem() {throw new Error("Quota exceeded");}}, {name:"Still here"}), false);
});

test("the actual guest designer renders a private preview before any account fields or action", () => {
  let keeps = 0;
  let edits = 0;
  const html = renderToStaticMarkup(createElement(GuestBusinessDraft, {
    draft:{name:"Guest <Tacos>",businessType:"food_truck",description:"A private preview",city:"Pensacola"},
    onChange() {edits += 1;},
    onKeep() {keeps += 1;},
  }));
  assert.match(html, /private-draft-preview/);
  assert.match(html, /Guest &lt;Tacos&gt;/);
  assert.match(html, /Keep this draft/);
  assert.doesNotMatch(html, /type="password"|name="email"|mailto:|api\/auth/);
  assert.equal(keeps, 0);
  assert.equal(edits, 0);
});

test("claim design retains its selected business type before the server ownership check", () => {
  const html = renderToStaticMarkup(createElement(GuestBusinessDraft, {
    draft:{businessType:"food_truck"},canChangeBusinessType:false,onChange() {},onKeep() {},
  }));
  assert.match(html, /id="guest-draft-businessType"[^>]*disabled/);
  assert.match(html, /value="food_truck" selected/);
});

test("the exact new claim draft survives the actual restore guard after authentication", () => {
  const intent = parseBusinessSignupRouteIntent("businessType=food_truck&intent=claim&claimListingId=truck-1&q=Tacos");
  let raw = "";
  persistGuestBusinessDraft({setItem(_key, value) {raw=value;}}, {businessType:"food_truck",name:"My Tacos",cuisineType:"Mexican",description:"My design"}, Date.now(), intent);
  const draft = JSON.parse(raw);
  assert.equal(shouldRestoreGuestBusinessDraft(intent, draft), true);
  assert.equal(draft.cuisineType, "Mexican");
  assert.equal(getGuestClaimPrefillValue(intent, draft, "My Tacos", "Registry name", "truck-1"), "My Tacos");
  assert.equal(getGuestClaimPrefillValue(intent, draft, "My address", "Route prefill"), "My address");
  assert.equal(getGuestClaimPrefillValue(intent, draft, "", "Registry name", "truck-1"), "Registry name");
  assert.equal(getGuestClaimPrefillValue(intent, draft, "My Tacos", "Other truck", "truck-2"), "Other truck");
});

test("claim restore rejects old, stale, different-target and different-query drafts", () => {
  const intent = parseBusinessSignupRouteIntent("businessType=food_truck&intent=claim&claimListingId=truck-1&q=Tacos");
  let raw = "";
  persistGuestBusinessDraft({setItem(_key, value) {raw=value;}}, {businessType:"food_truck",name:"My Tacos"}, Date.now(), intent);
  const draft = JSON.parse(raw);
  assert.equal(shouldRestoreGuestBusinessDraft(intent, {...draft,__guestClaim:undefined}), false);
  assert.equal(shouldRestoreGuestBusinessDraft(intent, {...draft,__savedAt:0}), false);
  assert.equal(shouldRestoreGuestBusinessDraft(parseBusinessSignupRouteIntent("businessType=food_truck&intent=claim&claimListingId=truck-2&q=Tacos"), draft), false);
  assert.equal(shouldRestoreGuestBusinessDraft(parseBusinessSignupRouteIntent("businessType=food_truck&intent=claim&claimListingId=truck-1&q=Other"), draft), false);
});

test("verification of an edited business type returns to a route that restores that draft", () => {
  const original = parseBusinessSignupRouteIntent("businessType=restaurant&source=profile-setup");
  const currentDraft = {businessType:"caterer",name:"Guest catering",__savedAt:Date.now()};
  const intended = buildGuestBusinessSignupPath(original, "caterer");
  const verification = new URL(buildProgressiveAccountPath("verify_email", "keep_draft", intended), "https://www.mealscout.us");
  const returned = new URL(verification.searchParams.get("redirect")!, "https://www.mealscout.us");
  assert.equal(shouldRestoreGuestBusinessDraft(parseBusinessSignupRouteIntent(returned.search), currentDraft), true);
  assert.equal(returned.searchParams.get("businessType"), "caterer");
});

test("a switched claim autosave cannot restore under the original target and continues to the selected target", () => {
  const original = parseBusinessSignupRouteIntent("businessType=food_truck&intent=claim&claimListingId=truck-1&q=Tacos");
  const selected = getGuestBusinessDraftIntent(original, "truck-2");
  let raw = "";
  persistGuestBusinessDraft({setItem(_key, value) {raw=value;}}, {businessType:"food_truck",name:"Truck two",address:"Second address"}, Date.now(), selected);
  const draft = JSON.parse(raw);
  assert.equal(draft.__guestClaim.listingId, "truck-2");
  assert.equal(shouldRestoreGuestBusinessDraft(original, draft), false);
  assert.equal(getGuestClaimPrefillValue(original, draft, "Truck two", "Truck one", "truck-1"), "Truck one");
  const returned = new URL(buildGuestBusinessSignupPath(selected, "food_truck"), "https://www.mealscout.us");
  const returnedIntent = parseBusinessSignupRouteIntent(returned.search);
  assert.equal(returned.searchParams.get("claimListingId"), "truck-2");
  assert.equal(shouldRestoreGuestBusinessDraft(returnedIntent, draft), true);
  assert.equal(getGuestClaimPrefillValue(returnedIntent, draft, "Truck two", "Registry two", "truck-2"), "Truck two");
});

test("login, signup choice and verification preserve the kept draft destination and reason", () => {
  const destination = "/restaurant-signup?businessType=caterer&intent=create&keepDraft=1#details";
  const login = new URL(buildProgressiveAccountPath("sign_in", "keep_draft", destination), "https://www.mealscout.us");
  const signup = new URL(preserveProgressiveAuthContext("/customer-signup?ref=existing-ref", login.searchParams), login.origin);
  const chosen = new URL(preserveProgressiveAuthContext("/customer-signup?role=diner", signup.searchParams), login.origin);
  const intended = resolveProgressiveAuthDestination(chosen.searchParams.get("redirect"), "/scout");
  const verification = new URL(preserveProgressiveAuthContext(`/post-verification?status=check-email&redirect=${encodeURIComponent(intended)}`, chosen.searchParams), login.origin);
  const returningLogin = new URL(preserveProgressiveAuthContext("/login?verified=1", verification.searchParams), login.origin);
  for (const stage of [signup, chosen, verification, returningLogin]) {
    assert.equal(stage.searchParams.get("redirect"), destination);
    assert.equal(getProgressiveAccountAction(stage.searchParams), "keep_draft");
    assert.equal(stage.searchParams.has("send"), false);
    assert.equal(stage.searchParams.has("payment"), false);
  }
  assert.equal(signup.searchParams.get("ref"), "existing-ref");
});

test("the current verification destination wins over an older saved account destination", () => {
  assert.equal(resolveProgressiveAuthDestination("/restaurant-signup?businessType=bar&keepDraft=1", "/supplier/dashboard"), "/restaurant-signup?businessType=bar&keepDraft=1");
  assert.equal(resolveProgressiveAuthDestination(null, "/scout"), "/scout");
});

test("auth continuity discards unsafe destinations, unknown reasons and authority or action parameters", () => {
  const source = new URLSearchParams({redirect:"//outside.example",reason:"owner",userType:"admin",emailVerified:"true",subscription:"paid",send:"1",payment:"1"});
  const continued = new URL(preserveProgressiveAuthContext("/customer-signup", source), "https://www.mealscout.us");
  assert.equal(continued.search, "");
  assert.equal(resolveProgressiveAuthDestination(source.get("redirect"), "https://outside.example"), "/profile-setup");
});

test("an explicitly constructed safe verification destination stays ahead of inherited context", () => {
  const current = "/restaurant-signup?businessType=food_truck&intent=claim&claimListingId=truck-2&keepDraft=1";
  const carried = new URL(preserveProgressiveAuthContext(`/post-verification?redirect=${encodeURIComponent(current)}`, new URLSearchParams({redirect:"/scout",reason:"keep_draft"})), "https://www.mealscout.us");
  assert.equal(carried.searchParams.get("redirect"), current);
});
