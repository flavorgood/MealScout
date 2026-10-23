import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderHomepageHtml } from "../server/seo/homepageHtml";
import { WELCOME_CONTENT } from "../shared/welcomeContent";

const template = readFileSync(new URL("../client/index.html", import.meta.url), "utf8");
test("native initial Welcome preserves the App template, brand and real links with public identity before JS", () => {
  const html = renderHomepageHtml(template, "https://www.mealscout.us", "/?prerender=1");
  assert.match(html, /<h1 class="sr-only">Welcome to MealScout<\/h1>/);
  assert.ok(html.includes(WELCOME_CONTENT.description.replace(/'/g, "&#x27;")));
  for (const href of ["/customer-signup", "/login", "/scout"]) assert.ok(html.includes(`href="${href}"`));
  assert.ok(html.includes("mealscout-welcome-background"));
  assert.ok(html.includes('<script type="module" src="/src/main.tsx"></script>'));
  assert.ok(html.includes('<link rel="canonical" href="https://www.mealscout.us/">'));
  assert.ok(html.includes('<meta name="robots" content="index, follow,'));
  assert.equal((html.match(/id="root"/g) || []).length, 1);
});
test("tracking and isolated deployment metadata retain their existing noindex policy", () => {
  for (const query of ["?ref=synthetic", "?utm_source=synthetic"]) {
    const html = renderHomepageHtml(template, "https://www.mealscout.us", "/" + query);
    assert.ok(html.includes('<meta name="robots" content="noindex, nofollow">'));
    assert.ok(html.includes('href="https://www.mealscout.us/"'));
  }
  assert.ok(renderHomepageHtml(template, "https://www.mealscout.us", "/", true).includes('content="noindex, nofollow"'));
});
test("canonical configuration and template failures fail explicitly", () => {
  assert.throws(() => renderHomepageHtml("<html></html>", "https://www.mealscout.us"), /no empty application root/);
  assert.throws(() => renderHomepageHtml(template, "invalid origin"), /Invalid URL/);
});
test("compiled graph retains the existing API bridge while public icons use native public paths", () => {
  const compiled = template.replace('href="/favicon.svg"', 'href="/api/public-profile/app-assets/favicon.svg"').replace('src="/src/main.tsx"', 'src="/api/public-profile/app-assets/assets/app-synthetic.js"');
  const html = renderHomepageHtml(compiled, "https://www.mealscout.us");
  assert.ok(html.includes('href="/favicon.svg"'));
  assert.ok(html.includes('src="/api/public-profile/app-assets/assets/app-synthetic.js"'));
});
