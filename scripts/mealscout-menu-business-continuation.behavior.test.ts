import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { PrivateMenuDraftPage } from "../client/src/components/private-menu-draft";
import { buildRestaurantSignupContinuationPath, parseBusinessSignupRouteIntent } from "../shared/businessSignupIntent";
import { buildGuestBusinessSignupPath, buildProgressiveAccountPath, getGuestBusinessDraftIntent, preserveProgressiveAuthContext, resolveProgressiveBusinessSetupDestination } from "../shared/progressiveOnboarding";

const menuDestination = "/menu-builder?reviewDraft=1#preview";
const context = new URLSearchParams({ redirect: menuDestination, reason: "keep_draft", password: "discard", ownerId: "discard", send: "1", charge: "1" });

test("business register, login and OAuth share a safe menu continuation with the selected claim", () => {
  const route = parseBusinessSignupRouteIntent("?businessType=food_truck&intent=claim&claimListingId=old&q=Lunch");
  const selected = getGuestBusinessDraftIntent(route, "selected-claim");
  const continuation = preserveProgressiveAuthContext(buildRestaurantSignupContinuationPath(selected), context);
  const params = new URL(continuation, "https://mealscout.local").searchParams;
  assert.equal(params.get("claimListingId"), "selected-claim");
  assert.equal(params.get("q"), "Lunch");
  assert.equal(params.get("redirect"), menuDestination);
  assert.equal(params.get("reason"), "keep_draft");
  for (const forbidden of ["password", "ownerId", "send", "charge"]) assert.equal(params.has(forbidden), false);
  const auth = new URL(buildProgressiveAccountPath("verify_email", "keep_draft", continuation), "https://mealscout.local");
  assert.equal(auth.searchParams.get("redirect"), continuation);
});

test("changing business type or choosing a claim keeps the pending menu without importing it", () => {
  const route = parseBusinessSignupRouteIntent("?businessType=restaurant&intent=create");
  const changed = new URL(buildGuestBusinessSignupPath(route, "food_truck", context), "https://mealscout.local");
  assert.equal(changed.searchParams.get("keepDraft"), "1");
  assert.equal(changed.searchParams.get("businessType"), "food_truck");
  assert.equal(changed.searchParams.get("redirect"), menuDestination);
  assert.equal(changed.searchParams.get("reason"), "keep_draft");
  assert.equal(changed.searchParams.has("import"), false);
});

test("explicit setup completion returns to the kept menu for the server-created business", () => {
  const destination = new URL(resolveProgressiveBusinessSetupDestination(context, "/owner-ai?restaurantId=server-business", "server-business"), "https://mealscout.local");
  assert.equal(destination.pathname, "/menu-builder");
  assert.equal(destination.searchParams.get("reviewDraft"), "1");
  assert.equal(destination.searchParams.get("restaurantId"), "server-business");
  assert.equal(destination.hash, "#preview");
  assert.equal(destination.searchParams.has("import"), false);
  assert.equal(resolveProgressiveBusinessSetupDestination(new URLSearchParams(), "/owner-ai?focus=menu"), "/owner-ai?focus=menu");
  for (const redirect of ["https://evil.test", "//evil.test", "javascript:alert(1)"]) {
    const unsafe = new URLSearchParams({ redirect, reason: "keep_draft" });
    assert.equal(resolveProgressiveBusinessSetupDestination(unsafe, "/owner-ai"), "/owner-ai");
    assert.equal(new URL(preserveProgressiveAuthContext("/restaurant-signup", unsafe), "https://mealscout.local").searchParams.has("redirect"), false);
  }
});

test("the real verified private-menu page offers business setup with a kept-menu return", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => null } } });
  try {
    const html = renderToStaticMarkup(createElement(Router, { ssrPath: "/menu-builder" }, createElement(PrivateMenuDraftPage, { user: { emailVerified: true } })));
    const links = [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1].replace(/&amp;/g, "&"));
    const setup = new URL(links.find(href => href.startsWith("/restaurant-signup"))!, "https://mealscout.local");
    assert.equal(setup.searchParams.get("redirect"), "/menu-builder?reviewDraft=1");
    assert.equal(setup.searchParams.get("reason"), "keep_draft");
    assert.doesNotMatch(html, /Submit order|Pay now|send=|charge=/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
