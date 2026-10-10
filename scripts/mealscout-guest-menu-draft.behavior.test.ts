import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivateMenuDraftEditor } from "../client/src/components/private-menu-draft";
import { emptyGuestMenuDraft, guestMenuDraftToCsv, parseGuestMenuDraft, persistGuestMenuDraft, readGuestMenuDraft, GUEST_MENU_DRAFT_KEY, type GuestMenuDraft } from "../shared/guestMenuDraft";
import { buildProgressiveAccountPath } from "../shared/progressiveOnboarding";

const sample: GuestMenuDraft = { name: 'Dinner "Menu"', serviceType: "dinner", items: [{ name: "Tacos, two", description: "Fresh\nmade", price: "12.50", category: "Mains" }] };

test("a guest's edited items survive keep, safe authentication and a remount without account authority", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.equal(persistGuestMenuDraft(() => storage, { ...sample, ownerId: "forged", emailVerified: true } as GuestMenuDraft), true);
  assert.deepEqual(readGuestMenuDraft(() => storage), sample);
  const raw = JSON.parse(values.get(GUEST_MENU_DRAFT_KEY)!);
  assert.equal(raw.ownerId, undefined);
  assert.equal(raw.emailVerified, undefined);
  const auth = new URL(buildProgressiveAccountPath("sign_in", "keep_draft", "/menu-builder?reviewDraft=1"), "https://www.mealscout.us");
  assert.equal(auth.searchParams.get("redirect"), "/menu-builder?reviewDraft=1");
  assert.equal(auth.searchParams.has("create"), false);
  assert.equal(auth.searchParams.has("order"), false);
});

test("broken, stale, future and oversized saved menus cannot become an owner import", () => {
  const now = Date.now();
  const raw = (extra: object) => JSON.stringify({ version: 1, __savedAt: now, ...sample, ...extra });
  assert.equal(parseGuestMenuDraft("{"), null);
  assert.equal(parseGuestMenuDraft(raw({ __savedAt: now - 8 * 24 * 60 * 60 * 1000 })), null);
  assert.equal(parseGuestMenuDraft(raw({ __savedAt: now + 1000 })), null);
  assert.equal(parseGuestMenuDraft(raw({ items: Array(101).fill(sample.items[0]) })), null);
  assert.equal(parseGuestMenuDraft(raw({ serviceType: "admin" })), null);
  assert.equal(readGuestMenuDraft(() => { throw new Error("blocked"); }), null);
});

test("a failed keep preserves the page instead of pretending draft persistence", () => {
  assert.equal(persistGuestMenuDraft(() => { throw new Error("getter blocked"); }, sample), false);
  assert.equal(persistGuestMenuDraft(() => ({ setItem() { throw new Error("quota"); } }), sample), false);
});

test("kept items prepare the existing CSV import with quotes, commas and lines intact", () => {
  assert.equal(guestMenuDraftToCsv(sample), 'Name,Description,Price,Category\r\n"Tacos, two","Fresh\nmade","12.50","Mains"');
  assert.throws(() => guestMenuDraftToCsv(emptyGuestMenuDraft()), /name and a valid price/);
  for (const price of ["-1", "NaN", "1e3", "Infinity", "123.456", ""]) {
    assert.throws(() => guestMenuDraftToCsv({ ...sample, items: [{ ...sample.items[0], price }] }), /valid price/);
  }
});

test("the real guest menu editor previews escaped items before account, contact or payment controls", () => {
  const html = renderToStaticMarkup(createElement(PrivateMenuDraftEditor, { draft: { ...sample, name: "<script>bad</script>" }, onChange() {}, onKeep() {} }));
  assert.match(html, /Private menu preview/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(html, /Tacos, two/);
  assert.match(html, /Keep this menu draft/);
  assert.doesNotMatch(html, /type="password"|type="email"|href="mailto:|<script>|Submit order|Pay now/);
});
