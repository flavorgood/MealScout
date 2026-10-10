import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressiveContactAnchor } from "../client/src/components/progressive-contact-anchor";

const destination = "/restaurant/taco-truck?ref=scout#visit";
const render = (user: { emailVerified?: unknown } | null, href: string, extra: object = {}) => renderToStaticMarkup(createElement(ProgressiveContactAnchor, { user, href, destination, ...extra }, "Contact"));
const hrefFrom = (html: string) => html.match(/href="([^"]+)"/)![1].replace(/&amp;/g, "&");

test("guest contact anchors expose the auth href even for new-tab and keyboard navigation", () => {
  for (const href of ["mailto:owner@example.test?subject=Menu", "tel:+12025550123", "sms:+12025550123", "https://wa.me/12025550123", "https://m.me/example"]) {
    const html = render(null, href, { target: "_blank", rel: "noreferrer", "aria-label": "Contact owner" });
    const auth = new URL(hrefFrom(html), "https://mealscout.local");
    assert.equal(auth.pathname, "/login");
    assert.equal(auth.searchParams.get("redirect"), destination);
    assert.equal(auth.searchParams.get("reason"), "contact");
    assert.equal(auth.searchParams.has("send"), false);
    assert.equal(auth.searchParams.has("charge"), false);
    assert.match(html, /target="_blank"/);
    assert.match(html, /aria-label="Contact owner"/);
    assert.doesNotMatch(html, /href="(?:mailto|tel|sms):/);
  }
});

test("unverified and non-boolean verification cannot expose direct contact", () => {
  for (const emailVerified of [false, undefined, "true", 1]) {
    const auth = new URL(hrefFrom(render({ emailVerified }, "tel:+12025550123")), "https://mealscout.local");
    assert.equal(auth.pathname, "/post-verification");
    assert.equal(auth.searchParams.get("redirect"), destination);
    assert.equal(auth.searchParams.get("reason"), "contact");
  }
});

test("authentication return renders the direct contact anchor without sending or invoking it", () => {
  let sends = 0;
  const contact = "mailto:owner@example.test?subject=Menu";
  const before = new URL(hrefFrom(render(null, contact)), "https://mealscout.local");
  assert.equal(before.searchParams.get("redirect"), destination);
  const after = render({ emailVerified: true }, contact, { onClick() { sends++; } });
  assert.equal(hrefFrom(after), contact);
  assert.equal(sends, 0);
  assert.doesNotMatch(after, /<script>|autoSubmit|send=|charge=/);
});

test("public menus, map directions and ordinary business websites remain usable by guests", () => {
  for (const href of ["/menu/business-id", "#menu", "https://maps.google.com/?q=Tacos", "https://business.example/menu", "https://instagram.com/example", "https://wa.me.evil.test/12025550123"]) {
    assert.equal(hrefFrom(render(null, href)), href);
  }
});
