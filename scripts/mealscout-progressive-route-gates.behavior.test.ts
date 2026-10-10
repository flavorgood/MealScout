import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router, Route, Switch } from "wouter";
import { VerifiedAccountBoundary } from "../client/src/components/verified-account-boundary";
import { getProgressiveContactGatePath, isProgressiveContactHref, isProgressiveRestrictedPath } from "../shared/progressiveAccountRoutes";

// The default Node/tsx path lowers imported TSX through React.createElement.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("existing private account/owner/subscription destinations stay gated while public and guest-design routes stay open", () => {
  for (const path of ["/dashboard", "/profile?tab=member", "/subscribe", "/orders", "/profile/payment", "/owner/ecosystem-sharing/source-1", "/deal-edit/deal-1", "/PROFILE", "/OWNER-AI", "/Restaurant/Dashboard", "/supplier/dashboard"]) assert.equal(isProgressiveRestrictedPath(path), true, path);
  for (const path of ["/menu-builder?design=1", "/restaurant-signup", "/restaurant/business-1", "/scout", "/contact", "/menu/business-1", "https://outside.example/profile"]) assert.equal(isProgressiveRestrictedPath(path), false, path);
});

test("classification aligns with installed Wouter case matching and catches public-profile shadowing", () => {
  for (const [pattern, location] of [["/profile", "/PROFILE"], ["/owner-ai", "/OWNER-AI"]]) {
    const html = renderToStaticMarkup(createElement(Router, { ssrPath: location }, createElement(Route, { path: pattern }, createElement("p", null, "Private route matched"))));
    assert.match(html, /Private route matched/);
    assert.equal(isProgressiveRestrictedPath(location), true);
  }
  for (const [publicPattern, location] of [["/restaurant/:id", "/restaurant/dashboard"], ["/supplier/:slug", "/supplier/dashboard"]]) {
    const html = renderToStaticMarkup(createElement(Router, { ssrPath: location }, createElement(Switch, null,
      createElement(Route, { path: publicPattern }, createElement("p", null, "Public profile matches first")),
      createElement(Route, { path: location }, createElement("p", null, "Private dashboard")),
    )));
    assert.match(html, /Public profile matches first/);
    assert.doesNotMatch(html, /Private dashboard/);
    assert.equal(isProgressiveRestrictedPath(location), true);
  }
});

test("a single route fragment must be supplied in an array for installed Wouter Switch precedence", () => {
  for (const path of ["/profile-setup", "/menu-builder"]) {
    const routes = createElement(Fragment, null,
      createElement(Route, { path }, createElement("p", null, "Explicit product route")),
      createElement(Route, { path: "/:businessSlug" }, createElement("p", null, "Clean business fallback")),
    );
    const before = renderToStaticMarkup(createElement(Router, { ssrPath: path }, createElement(Switch, null, routes)));
    assert.match(before, /Explicit product route/);
    assert.match(before, /Clean business fallback/);
    const after = renderToStaticMarkup(createElement(Router, { ssrPath: path }, createElement(Switch, null, [routes])));
    assert.equal(after, "<p>Explicit product route</p>");
  }
});

test("an unverified or guest account cannot mount restricted content that could run page actions", () => {
  let mounts = 0;
  function RestrictedPage() { mounts++; return createElement("p", null, "Private account data"); }
  for (const user of [null, {emailVerified:false}, {emailVerified:"true"}]) {
    const html = renderToStaticMarkup(createElement(Router, {ssrPath:"/profile"}, createElement(VerifiedAccountBoundary, {user, destination:"/profile?tab=member"}, createElement(RestrictedPage))));
    assert.doesNotMatch(html, /Private account data/);
    assert.match(html, /Membership and business access requirements still apply/);
  }
  assert.equal(mounts, 0);
  const html = renderToStaticMarkup(createElement(Router, {ssrPath:"/profile"}, createElement(VerifiedAccountBoundary, {user:{emailVerified:true}, destination:"/profile"}, createElement(RestrictedPage))));
  assert.match(html, /Private account data/);
  assert.equal(mounts, 1);
});

test("the real restricted-page prompt preserves destination for sign-in and signup without granting access", () => {
  const html = renderToStaticMarkup(createElement(Router, {ssrPath:"/subscribe"}, createElement(VerifiedAccountBoundary, {user:null, destination:"/subscribe?plan=starter#details"})));
  assert.match(html, /\/login\?redirect=%2Fsubscribe%3Fplan%3Dstarter%23details&amp;reason=restricted/);
  assert.match(html, /\/customer-signup\?redirect=%2Fsubscribe%3Fplan%3Dstarter%23details&amp;reason=restricted/);
  assert.doesNotMatch(html, /emailVerified=true|subscription=paid|payment=1|send=1/);
});

test("direct contact requires account verification and returns to the page for a second explicit click", () => {
  for (const href of ["tel:+15551234567", "mailto:owner@example.test?subject=Hello", "sms:+15551234567", "https://wa.me/15551234567", "https://m.me/example"]) {
    assert.equal(isProgressiveContactHref(href), true);
    for (const user of [null, {emailVerified:false}]) {
      const auth = new URL(getProgressiveContactGatePath(user, href, "/restaurant/truck-1?ref=scout#contact")!, "https://www.mealscout.us");
      assert.equal(auth.searchParams.get("redirect"), "/restaurant/truck-1?ref=scout#contact");
      assert.equal(auth.searchParams.get("reason"), "contact");
      assert.equal(auth.searchParams.has("send"), false);
      assert.equal(auth.toString().includes("owner%40example"), false);
    }
    assert.equal(getProgressiveContactGatePath({emailVerified:true}, href, "/restaurant/truck-1"), null);
  }
});

test("ordinary website, map and menu navigation are not treated as a contact or membership grant", () => {
  for (const href of ["https://example.test/menu", "/menu/truck-1", "https://maps.google.com/?q=Tacos", "https://instagram.com/business", "https://wa.me.evil.example/message"]) {
    assert.equal(isProgressiveContactHref(href), false);
    assert.equal(getProgressiveContactGatePath(null, href, "/restaurant/truck-1"), null);
  }
});
