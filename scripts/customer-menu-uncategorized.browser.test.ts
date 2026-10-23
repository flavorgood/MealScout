import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig.js";
import { chromium, expect } from "@playwright/test";

// Actual customer component and its dependencies; synthetic public API only.
// No application server, database, checkout, payment SDK or credentials.
const root = resolve(import.meta.dirname, "..");
const tailwindConfig = loadConfig(resolve(root, "client/tailwind.config.ts"));
const output = resolve(process.env.CUSTOMER_MENU_EVIDENCE_DIR || resolve(root, ".tmp-tests/customer-menu-uncategorized"));
mkdirSync(output, { recursive: true });
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const reproduction = process.argv.includes("--reproduce");
const results: Array<{ name: string; status: string; error?: string }> = [];
const apiRequests: string[] = [];
const blockedRequests: string[] = [];
const errors: string[] = [];
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { Route } from 'wouter'; import MenuPage from '@/pages/online-menu';
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Route path='/menu/:restaurantId'><MenuPage /></Route></QueryClientProvider>);`,
    resolveDir: root, sourcefile: "customer-menu-fixture.tsx", loader: "tsx",
  },
  bundle: true, write: false, platform: "browser", format: "esm", jsx: "automatic",
  alias: { "@": resolve(root, "client/src"), "@shared": resolve(root, "shared") },
  define: { "process.env.NODE_ENV": '"development"' }, logLevel: "silent",
});
const css = await postcss([tailwindcss({ ...tailwindConfig, content: [
  resolve(root, "client/src/pages/online-menu.tsx"),
  resolve(root, "client/src/components/ui/*.{ts,tsx}"),
  resolve(root, "client/src/components/public-ordering/*.tsx"),
] })]).process(readFileSync(resolve(root, "client/src/index.css"), "utf8"), { from: undefined });
const server = createServer((req, res) => {
  if (req.url === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); }
  else if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); }
  else if (req.url?.startsWith("/menu/")) {
    res.setHeader("Content-Type", "text/html");
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
  } else { res.statusCode = 404; res.end(); }
});
await new Promise<void>(ready => server.listen(0, "127.0.0.1", ready));
server.unref();
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" });
const page = await context.newPage();
page.on("pageerror", error => errors.push(error.message));
const restaurantId = "fixture-restaurant-a";
let payload: Record<string, unknown> = {};
await context.route("**/*", async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== baseUrl) { blockedRequests.push(request.url()); return route.abort(); }
  if (url.pathname.startsWith("/api/")) {
    apiRequests.push(`${request.method()} ${url.pathname}`);
    assert.equal(request.method(), "GET", "fixture must never write");
    assert.equal(url.pathname, `/api/menus/${restaurantId}`, "only the public menu read is allowed");
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  }
  return route.continue();
});
const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, description: null, priceCents: 1000, itemType: "food", imageUrl: null,
  isAvailable: true, calories: null, dietaryTags: [], allergens: [], variants: [], modifiers: [], ...extra,
});
const category = (items: unknown[], id = "mains") => ({ id, name: id, description: null, items });
const menu = (id: string, categories: unknown[] = [], uncategorizedItems: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  id, name: id, serviceType: "pickup", isActive: true, acceptsCash: false, hidePlatformFee: false,
  pricesIncludeTax: false, orderingEnabled: true, orderingBlockingReasons: [],
  paymentMethods: { card: true, cash: false }, categories, uncategorizedItems, ...extra,
});
const load = async (menus: unknown[], savedCart: unknown[] = [], query = "") => {
  payload = { menus, orderingEnabled: true, restaurantName: "Fixture Kitchen" };
  await page.goto(`${baseUrl}/menu/${restaurantId}`);
  await page.evaluate(cart => { localStorage.clear(); localStorage.setItem("mealscout_cart", JSON.stringify(cart)); }, savedCart);
  await page.goto(`${baseUrl}/menu/${restaurantId}${query}`);
  await expect(page.getByRole("heading", { name: "Fixture Kitchen", exact: true })).toBeVisible();
};
const cart = () => page.evaluate(() => JSON.parse(localStorage.getItem("mealscout_cart") || "[]"));
const add = async (name: string) => {
  await page.getByRole("button", { name: `Add ${name} to cart`, exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: /^Add to Cart/ }).click();
};
const check = async (name: string, test: () => Promise<void>) => {
  try { await test(); results.push({ name, status: "PASS" }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, status: "FAIL", error: String(error) }); throw error; }
};

try {
  await check("uncategorized-only public payload renders dish and adds with selected ownership", async () => {
    await load([menu("lunch", [], [item("Daily special")])]);
    await expect(page.getByRole("heading", { name: "Daily special", exact: true })).toBeVisible({ timeout: reproduction ? 1500 : 5000 });
    await page.screenshot({ path: resolve(output, "uncategorized-only.png"), fullPage: true });
    await add("Daily special");
    assert.deepEqual((await cart()).map((entry: any) => [entry.menuId, entry.restaurantId, entry.menuItemId, entry.lineTotalCents]), [["lunch", restaurantId, "Daily special", 1000]]);
  });
  if (!reproduction) {
    await check("mixed menu preserves category order and renders uncategorized dishes once", async () => {
      await load([menu("lunch", [category([item("Soup")]), category([item("Cake")], "dessert")], [item("Special")])]);
      assert.deepEqual(await page.locator("article h3").allTextContents(), ["Soup", "Cake", "Special"]);
      await expect(page.getByRole("navigation", { name: "Menu categories" })).toBeVisible();
      await page.screenshot({ path: resolve(output, "mixed-menu.png"), fullPage: true });
      await add("Soup"); await add("Special");
      assert.deepEqual((await cart()).map((entry: any) => entry.menuId), ["lunch", "lunch"]);
    });
    await check("legacy categorized-only payload keeps categories and cart behavior", async () => {
      const categorized = menu("lunch", [category([item("Soup")])]);
      delete (categorized as any).uncategorizedItems;
      await load([categorized]);
      assert.deepEqual(await page.locator("article h3").allTextContents(), ["Soup"]);
      await add("Soup"); assert.equal((await cart())[0].menuItemId, "Soup");
    });
    await check("non-array optional uncategorized field does not break categorized menus", async () => {
      for (const uncategorizedItems of [null, {}]) {
        await load([menu("lunch", [category([item("Soup")])], [], { uncategorizedItems })]);
        assert.deepEqual(await page.locator("article h3").allTextContents(), ["Soup"]);
      }
    });
    await check("uncategorized navigation cannot collide with an existing category ID", async () => {
      await load([menu("lunch", [category([item("Soup")], "uncategorized")], [item("Special")])]);
      const anchors = await page.getByRole("navigation", { name: "Menu categories" }).locator("a").evaluateAll(links => links.map(link => link.getAttribute("href")));
      assert.equal(new Set(anchors).size, 2);
      for (const anchor of anchors) assert.equal(await page.locator(`[id="${anchor!.slice(1)}"]`).count(), 1);
      await page.getByRole("navigation", { name: "Menu categories" }).locator("a").last().click();
      await expect(page.getByRole("heading", { name: "Special", exact: true })).toBeVisible();
    });
    await check("server-hidden items stay absent; inactive menus and unavailable cache items cannot be ordered", async () => {
      // Public API owns hidden/category/schedule/inventory filtering: hidden dish is omitted, not a new client flag.
      await load([menu("lunch", [], [item("Available"), item("Sold out", { isAvailable: false })]), menu("hidden-menu", [], [item("Hidden dish")], { isActive: false })]);
      await expect(page.getByRole("heading", { name: "Hidden dish", exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Sold out", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Add Sold out to cart", exact: true })).toHaveCount(0);
      await expect(page.getByText("Unavailable", { exact: true })).toBeVisible();
      assert.deepEqual(await cart(), []);
    });
    await check("duplicate IDs use the categorized entry and first uncategorized occurrence", async () => {
      await load([menu("lunch", [category([item("same", { name: "Category dish", priceCents: 1700 })])], [item("same", { name: "Duplicate dish", priceCents: 10 }), item("unique", { name: "First special", priceCents: 1200 }), item("unique", { name: "Duplicate special", priceCents: 20 })])]);
      assert.deepEqual(await page.locator("article h3").allTextContents(), ["Category dish", "First special"]);
      await add("Category dish"); await add("First special");
      assert.deepEqual((await cart()).map((entry: any) => entry.priceCents), [1700, 1200]);
    });
    await check("uncategorized variants modifiers required selection quantity and instructions use existing pricing", async () => {
      await load([menu("lunch", [], [item("Custom special", { variants: [{ id: "large", label: "Large", additionalCents: 200, isDefault: true }], modifiers: [{ id: "sauce", groupName: "Sauce", label: "Hot sauce", additionalCents: 75, isRequired: true, maxSelections: 1 }] })])]);
      await page.getByRole("button", { name: "Add Custom special to cart", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("button", { name: "Choose required options", exact: true })).toBeDisabled();
      await dialog.getByRole("checkbox", { name: "Hot sauce" }).check();
      await dialog.locator("button").filter({ has: page.locator("svg.lucide-plus") }).click();
      await dialog.getByPlaceholder("Any allergies or special requests?").fill("Sauce on side");
      await dialog.getByRole("button", { name: /^Add to Cart/ }).click();
      const [entry] = await cart();
      assert.equal(entry.lineTotalCents, 2550); assert.equal(entry.quantity, 2);
      assert.equal(entry.selectedVariantId, "large"); assert.deepEqual(entry.selectedModifierIds, ["sauce"]);
      assert.equal(entry.specialInstructions, "Sauce on side");
    });
    await check("missing price and browse-only readiness never expose Add", async () => {
      await load([menu("lunch", [], [item("Unpriced", { priceCents: null })])]);
      await expect(page.getByText("Price unavailable", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Add Unpriced to cart", exact: true })).toHaveCount(0);
      await load([menu("lunch", [], [item("Browse special")], { orderingEnabled: false })]);
      await expect(page.getByRole("button", { name: "Add Browse special to cart", exact: true })).toHaveCount(0);
      assert.deepEqual(await cart(), []);
    });
    await check("menu switching preserves other restaurant cart and requires replacement consent", async () => {
      const foreign = { menuId: "foreign-menu", restaurantId: "fixture-restaurant-b", menuItemId: "foreign", itemName: "Foreign", priceCents: 600, quantity: 1, selectedVariantId: null, variantLabel: null, variantAddCents: 0, selectedModifierIds: [], modifierLabels: [], modifierAddCents: 0, lineTotalCents: 600, specialInstructions: "" };
      await load([menu("lunch", [], [item("Lunch special")]), menu("dinner", [], [item("Dinner special")])], [foreign]);
      await add("Lunch special");
      await page.getByRole("button", { name: "dinner", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Lunch special", exact: true })).toHaveCount(0);
      page.once("dialog", dialog => dialog.dismiss());
      await add("Dinner special");
      assert.deepEqual((await cart()).map((entry: any) => entry.menuId), ["foreign-menu", "lunch"]);
      page.once("dialog", dialog => dialog.accept());
      await page.getByRole("dialog").getByRole("button", { name: /^Add to Cart/ }).click();
      assert.deepEqual((await cart()).map((entry: any) => [entry.restaurantId, entry.menuId]), [["fixture-restaurant-b", "foreign-menu"], [restaurantId, "dinner"]]);
    });
    await check("mobile mixed menu remains usable", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await load([menu("lunch", [category([item("Soup")])], [item("Mobile special")])]);
      await expect(page.getByRole("button", { name: "Add Mobile special to cart", exact: true })).toBeVisible();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.screenshot({ path: resolve(output, "mobile-mixed.png"), fullPage: true });
      await add("Mobile special"); assert.equal((await cart())[0].menuId, "lunch");
    });
    await check("no runtime errors and zero external/payment/order/write requests", async () => {
      assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
      assert.ok(apiRequests.length > 0);
      assert.ok(apiRequests.every(request => request === `GET /api/menus/${restaurantId}`));
    });
  }
} catch (error) {
  await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true }).catch(() => {});
  console.error(error); process.exitCode = 1;
} finally {
  const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  writeFileSync(resolve(output, "results.json"), JSON.stringify({ revision, sourceSha256: sha256(resolve(root, "client/src/pages/online-menu.tsx")), testSha256: sha256(import.meta.filename), reproduction, results, apiRequests, blockedRequests, errors, boundary: "synthetic API; actual customer component; local rendered interactions only; server filtering is source-confirmed, not executed" }, null, 2));
  await context.close(); await browser.close(); await new Promise<void>(ready => server.close(() => ready()));
  console.log(`${results.filter(result => result.status === "PASS").length}/${results.length} customer-menu browser checks passed`);
}
