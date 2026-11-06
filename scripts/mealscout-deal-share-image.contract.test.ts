import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolvePublicShareImageUrl } from "../server/publicProfiles/publicProfileUtils";

/**
 * The one live deal's og:image was the site origin glued onto a data URI
 * (299,320 characters; fetching it returns 414): the stored deals.imageUrl
 * held inline image data, and dealPage passed any truthy value straight
 * to absoluteUrl, which prefixes everything that is not http(s). A deal
 * with no usable image URL must fall back to the default share image as a
 * normal fetchable URL. The resolver reuses normalizePublicUrl, the same
 * validator the public profile mappers already apply — which is why
 * truck/city pages (whose images pass through those mappers) were
 * well-formed while the deal page was not.
 */

const FALLBACK = "/og-default.jpg?v=20260506";
const LONG_DATA_URI = `data:image/jpeg;base64,${"QUJD".repeat(60000)}`;

test("a stored data URI falls back to the default share image", () => {
  assert.equal(
    resolvePublicShareImageUrl("data:image/jpeg;base64,QUJD", FALLBACK),
    FALLBACK,
  );
  const resolved = resolvePublicShareImageUrl(LONG_DATA_URI, FALLBACK);
  assert.equal(resolved, FALLBACK);
  assert.ok(!resolved.includes("data:"));
  assert.ok(resolved.length < 100);
});

test("other non-fetchable values fall back too", () => {
  for (const value of [
    null,
    undefined,
    "",
    "   ",
    "blob:https://www.mealscout.us/1234",
    "//cdn.example.com/deal.jpg",
    "javascript:alert(1)",
  ]) {
    assert.equal(resolvePublicShareImageUrl(value, FALLBACK), FALLBACK, String(value));
  }
});

test("real image URLs and internal paths pass through", () => {
  assert.equal(
    resolvePublicShareImageUrl("https://cdn.example.com/deal.jpg", FALLBACK),
    "https://cdn.example.com/deal.jpg",
  );
  assert.equal(
    resolvePublicShareImageUrl("/uploads/deal.jpg", FALLBACK),
    "/uploads/deal.jpg",
  );
  assert.equal(resolvePublicShareImageUrl(FALLBACK, "/other.jpg"), FALLBACK);
});

test("dealPage resolves its share image and cleans description before falling back", () => {
  const prerender = readFileSync(
    new URL("../server/seo/publicProfilePrerender.ts", import.meta.url),
    "utf8",
  );
  const dealPage = prerender.slice(
    prerender.indexOf("async function dealPage"),
    prerender.indexOf("async function jobPage"),
  );
  assert.ok(dealPage.length > 0, "dealPage found");
  assert.match(dealPage, /resolvePublicShareImageUrl\(\s*row\.imageUrl/);
  assert.match(dealPage, /imageUrl: shareImageUrl/);
  assert.match(dealPage, /image: absoluteUrl\(baseUrl, shareImageUrl\)/);
  assert.doesNotMatch(dealPage, /row\.imageUrl \|\| defaultSocialImagePath/);
  // A whitespace-only stored description is truthy, so the fallback must
  // be applied after cleaning, not as cleanText's fallback argument.
  assert.match(dealPage, /cleanText\(row\.description\) \|\|/);
});
