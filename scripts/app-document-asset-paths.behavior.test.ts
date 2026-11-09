import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  normalizePublicProfileAssetPaths,
  renderAppDocumentHtml,
} from "../server/seo/appDocumentHtml";

/**
 * The compiled template addresses every public file through the API
 * asset bridge (/api/public-profile/app-assets/), but only the compiled
 * JS/CSS under assets/ is served there. The favicon, the touch icon,
 * and the brand image answer 404 at the bridged addresses and 200 at
 * their native public paths. Documents must point those references at
 * the native paths while the compiled graph keeps the bridge — and the
 * plain SPA shell served by vite.ts must get the same treatment,
 * because it bypasses the document renderers.
 */

const compiledTemplate = [
  "<!DOCTYPE html><html><head>",
  '<link rel="icon" type="image/svg+xml" href="/api/public-profile/app-assets/favicon.svg" />',
  '<link rel="icon" href="/api/public-profile/app-assets/favicon.ico" />',
  '<link rel="apple-touch-icon" href="/api/public-profile/app-assets/icons/icon-192x192.png" />',
  '<meta property="og:image" content="/api/public-profile/app-assets/brand/logo.png" />',
  '<meta name="twitter:image" content="/api/public-profile/app-assets/brand/logo.png" />',
  '<link rel="stylesheet" href="/api/public-profile/app-assets/assets/index-synthetic.css" />',
  '<script type="module" src="/api/public-profile/app-assets/assets/index-synthetic.js"></script>',
  "<title>MealScout | Discover Local Food Near You</title>",
  '</head><body><div id="root"></div></body></html>',
].join("\n");

test("icon, favicon, and brand references use native public paths", () => {
  const html = normalizePublicProfileAssetPaths(compiledTemplate);
  assert.ok(html.includes('href="/favicon.svg"'));
  assert.ok(html.includes('href="/favicon.ico"'));
  assert.ok(html.includes('href="/icons/icon-192x192.png"'));
  assert.ok(html.includes('content="/brand/logo.png"'));
  assert.ok(!html.includes("app-assets/favicon"));
  assert.ok(!html.includes("app-assets/icons"));
  assert.ok(!html.includes("app-assets/brand"));
});

test("the compiled assets graph keeps the API bridge", () => {
  const html = normalizePublicProfileAssetPaths(compiledTemplate);
  assert.ok(
    html.includes('href="/api/public-profile/app-assets/assets/index-synthetic.css"'),
  );
  assert.ok(
    html.includes('src="/api/public-profile/app-assets/assets/index-synthetic.js"'),
  );
});

test("rendered app documents carry the same native paths", () => {
  const html = renderAppDocumentHtml(compiledTemplate, {
    markup: "",
    title: "A Truck | MealScout",
    description: "A truck.",
    canonical: "https://www.mealscout.us/truck/a-truck--x",
    noIndex: false,
  });
  assert.ok(html.includes('href="/favicon.ico"'));
  assert.ok(html.includes('content="/brand/logo.png"'));
  assert.ok(
    html.includes('src="/api/public-profile/app-assets/assets/index-synthetic.js"'),
  );
});

test("the plain shell fallback in vite.ts normalizes asset paths", () => {
  const viteTs = readFileSync(
    new URL("../server/vite.ts", import.meta.url),
    "utf8",
  );
  assert.match(viteTs, /normalizePublicProfileAssetPaths/);
  const fallback = viteTs.slice(viteTs.indexOf('app.use("*"'));
  assert.match(fallback, /normalizePublicProfileAssetPaths\(template\)/);
});
