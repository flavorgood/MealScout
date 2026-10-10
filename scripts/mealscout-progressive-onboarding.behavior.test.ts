import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GuestBusinessDraft } from "../client/src/components/guest-business-draft";
import {
  buildGuestBusinessSignupPath,
  buildProgressiveAccountPath,
  getProgressiveAccountGate,
  GUEST_BUSINESS_DRAFT_KEY,
  persistGuestBusinessDraft,
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
