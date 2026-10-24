import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import express from "express";
import helmet from "helmet";
import ts from "typescript";
import { chromium, expect } from "@playwright/test";
import { registerPublicProfileAppAssets } from "../../server/seo/publicProfileAppAssets";
import { publicMenuFixture, SYNTHETIC_MENU_ID as id } from "./public-menu-fixture";

// Actual compiled native App + document/static pipeline on owned loopback.
// Public payloads, auth, API failure and telemetry are isolated fixtures. No
// production auth/record, provider, order or inventory endpoint is reachable.
const output = process.env.PUBLIC_MENU_PROOF_DIR;
if (output) fs.mkdirSync(output, { recursive: true });
const sources = [{ name: "after", root: process.cwd() }];
if (process.env.PUBLIC_MENU_BASELINE_ROOT) sources.unshift({ name: "before", root: path.resolve(process.env.PUBLIC_MENU_BASELINE_ROOT) });
const results: unknown[] = [];
const servers: http.Server[] = [];
let releaseRead: (() => void) | undefined;
const browser = await chromium.launch({ executablePath: process.env.UI_CHROMIUM_EXECUTABLE || undefined, args: ["--no-sandbox"] });
try {
  for (const source of sources) {
    const state = { apiFails: false, documentFails: false, holdApi: false };
    const fixture = publicMenuFixture();
    const distPath = path.join(source.root, "dist/public");
    const { serveStatic } = await import(pathToFileURL(path.join(source.root, "dist/server/vite.js")).href);
    const app = express();
    app.set("env", "production");
    const ast = ts.createSourceFile("index.ts", fs.readFileSync(path.join(source.root, "server/index.ts"), "utf8"), ts.ScriptTarget.Latest, true);
    let options: string | undefined;
    const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(ast) === "helmet") options = node.arguments[0].getText(ast); ts.forEachChild(node, visit); };
    visit(ast); assert.ok(options); app.use(helmet(vm.runInNewContext(`(${options})`)));
    app.get("/api/menus/:restaurantId", async (req, res) => {
      if (state.holdApi) await new Promise<void>(resolve => { releaseRead = resolve; });
      res.setHeader("Cache-Control", "no-store");
      if (state.apiFails) return res.status(503).json({ message: "Synthetic menu read unavailable" });
      if (req.params.restaurantId !== id) return res.status(404).json({ message: "Restaurant not found" });
      res.json(fixture);
    });
    registerPublicProfileAppAssets(app, path.join(distPath, "assets"));
    const previous = process.cwd();
    try {
      process.chdir(source.root);
      serveStatic(app, { distPath, loadPublicMenu: async (key: string) => {
        if (state.documentFails) throw new Error("Synthetic document unavailable");
        return key === id ? fixture : null;
      } });
    } finally { process.chdir(previous); }
    const server = app.listen(0, "127.0.0.1"); servers.push(server);
    if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const [label, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } })) {
      for (const javascript of source.name === "before" ? [false] : [false, true]) {
        state.apiFails = false; state.documentFails = false; state.holdApi = javascript;
        const context = await browser.newContext({ viewport, javaScriptEnabled: javascript, serviceWorkers: "block" });
        const page = await context.newPage();
        const errors: string[] = []; const writes: string[] = []; const failedAssets: string[] = [];
        let mockedTelemetry = 0; let compiledAssets = 0;
        page.on("pageerror", error => errors.push(error.message));
        page.on("response", response => { if (response.url().includes("/api/public-profile/app-assets/assets/")) {
          compiledAssets++; if (response.status() !== 200) failedAssets.push(response.url().replace(origin, ""));
        } });
        await page.routeWebSocket("**/*", socket => socket.close());
        await page.route("**/*", async route => {
          const request = route.request(); const url = new URL(request.url());
          if (url.origin !== origin) return route.abort();
          if (url.pathname === "/api/telemetry/track" && request.method() === "POST") { mockedTelemetry++; return route.fulfill({ status: 202, contentType: "application/json", body: '{"synthetic":true}' }); }
          if (!["GET", "HEAD"].includes(request.method())) { writes.push(url.pathname); return route.fulfill({ status: 405, body: "Synthetic fixture blocks writes" }); }
          if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/public-profile/app-assets/") && !url.pathname.startsWith("/api/menus/")) {
            const body = url.pathname === "/api/auth/user" ? { message: "Unauthorized" } : url.pathname.includes("trucks/live") ? { trucks: [] } : url.pathname.includes("deals/featured") ? { deals: [] } : url.pathname.includes("events/public") ? { events: [] } : [];
            return route.fulfill({ status: url.pathname === "/api/auth/user" ? 401 : 200, contentType: "application/json", body: JSON.stringify(body) });
          }
          return route.continue();
        });
        await page.addInitScript("Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: (_ok, fail) => fail({code:1,message:'Synthetic unavailable location'}), watchPosition:()=>0, clearWatch:()=>{} } })");
        const response = await page.goto(origin + `/menu/${id}?returnTo=${encodeURIComponent(`/bar/proof--${id}`)}`, { waitUntil: "domcontentloaded" });
        assert.equal(response?.status(), 200);
        const raw = await response!.text();
        const hasIdentity = raw.includes(fixture.restaurantName);
        assert.equal(hasIdentity, source.name === "after");
        const ownedSchema = page.locator('script[type="application/ld+json"][data-page-schema="true"]');
        if (source.name === "after") {
          if (!javascript) await expect(page.getByRole("heading", { name: fixture.restaurantName, exact: true })).toBeVisible();
          if (javascript) {
            await page.waitForFunction(() => Object.keys(document.getElementById("root") || {}).some(key => key.startsWith("__reactContainer")));
            await expect(page.getByText("Loading menu", { exact: true })).toBeVisible();
            await expect(ownedSchema).toHaveCount(0); // SSR schema relinquished while API is pending.
            for (let n = 0; !releaseRead && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 20));
            assert.ok(releaseRead); state.holdApi = false; releaseRead(); releaseRead = undefined;
            await expect(page.getByRole("heading", { name: fixture.restaurantName, exact: true })).toBeVisible();
          }
          await expect(ownedSchema).toHaveCount(1);
          const schema = async () => JSON.parse(await ownedSchema.textContent() || "{}");
          assert.equal((await schema()).name, fixture.restaurantName + " — Lunch menu");
          const dinner = page.getByRole("link", { name: "Dinner menu", exact: true });
          const bounds = await dinner.boundingBox(); assert.ok(bounds && bounds.height >= 44 && bounds.x + bounds.width <= viewport.width + 1);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          if (!javascript && output) await page.screenshot({ path: path.join(output, `${source.name}-${label}.png`), fullPage: true });
          await dinner.click();
          await expect(page.getByRole("heading", { name: "Synthetic dinner plate", exact: true })).toBeVisible();
          await expect(ownedSchema).toHaveCount(1);
          assert.equal((await schema()).name, fixture.restaurantName + " — Dinner menu");
          if (javascript) {
            const savedCart = [{ menuId: "lunch", restaurantId: id, menuItemId: "lunch-item", itemName: "Synthetic lunch plate", priceCents: 825, quantity: 1,
              selectedVariantId: null, variantLabel: null, variantAddCents: 0, selectedModifierIds: [], modifierLabels: [], modifierAddCents: 0, lineTotalCents: 825, specialInstructions: "Synthetic only" }];
            await page.evaluate(cart => localStorage.setItem("mealscout_cart", JSON.stringify(cart)), savedCart);
            state.documentFails = true; state.apiFails = true;
            const unavailable = await page.reload({ waitUntil: "networkidle" });
            assert.equal(unavailable?.status(), 503);
            await expect(page.getByRole("heading", { name: "Menu could not be loaded", exact: true })).toBeVisible();
            await expect(ownedSchema).toHaveCount(0);
            assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("mealscout_cart") || "null")), savedCart);
            state.apiFails = false;
            await page.getByRole("button", { name: "Retry menu", exact: true }).click();
            await expect(page.getByRole("heading", { name: "Synthetic dinner plate", exact: true })).toBeVisible();
            await expect(ownedSchema).toHaveCount(1);
            assert.equal((await schema()).name, fixture.restaurantName + " — Dinner menu");
            assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("mealscout_cart") || "null")), savedCart);
            await page.getByRole("link", { name: "Scout", exact: true }).first().click();
            await expect(page.getByTestId("scout-map-container")).toBeVisible();
            await expect(ownedSchema).toHaveCount(0);
            assert.ok(page.url().includes("/scout"));
          }
        } else if (output) await page.screenshot({ path: path.join(output, `${source.name}-${label}.png`), fullPage: true });
        assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(failedAssets, []);
        results.push({ source: source.name, viewport: label, javascript, rawHasIdentity: hasIdentity, compiledAssets, mockedTelemetry, errors, writes, failedAssets, result: "PASS" });
        await context.close();
      }
    }
  }
  console.log(JSON.stringify({ results }, null, 2));
} finally {
  releaseRead?.();
  if (output) fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({ results }, null, 2));
  await browser.close();
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
}
