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
import { chromium } from "@playwright/test";
import { createRootHealthGuard } from "../../server/seo/rootEntry";
import { guardUnauthenticatedProtectedHtml } from "../../server/seo/protectedHtmlRoutes";
import { registerPublicProfileAppAssets } from "../../server/seo/publicProfileAppAssets";

// Owned loopback only. Uses the actual production bundle and asset namespace.
// APIs and every write are synthetic/blocked; no database, auth boot or provider.
const output = process.env.HOMEPAGE_PROOF_DIR;
if (output) fs.mkdirSync(output, { recursive: true });
const roots = [{ name: "after", root: process.cwd() }];
if (process.env.HOMEPAGE_BASELINE_ROOT) roots.unshift({ name: "before", root: path.resolve(process.env.HOMEPAGE_BASELINE_ROOT) });
const servers: http.Server[] = [];
const results: unknown[] = [];
const browser = await chromium.launch({ executablePath: process.env.UI_CHROMIUM_EXECUTABLE || undefined, args: ["--no-sandbox"] });
try {
  for (const source of roots) {
    const distPath = path.join(source.root, "dist/public");
    const { serveStatic } = await import(pathToFileURL(path.join(source.root, "dist/server/vite.js")).href);
    const app = express();
    app.set("env", "production");
    // Read the actual static Helmet options without importing application boot.
    const securitySource = ts.createSourceFile("index.ts", fs.readFileSync(path.join(source.root, "server/index.ts"), "utf8"), ts.ScriptTarget.Latest, true);
    let helmetOptions: string | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(securitySource) === "helmet") helmetOptions = node.arguments[0].getText(securitySource);
      ts.forEachChild(node, visit);
    };
    visit(securitySource);
    assert.ok(helmetOptions, "actual production Helmet options found");
    app.use(helmet(vm.runInNewContext(`(${helmetOptions})`)));
    app.use(guardUnauthenticatedProtectedHtml);
    app.use("/", createRootHealthGuard(app, path.join(distPath, "index.html")));
    registerPublicProfileAppAssets(app, path.join(distPath, "assets"));
    const previousDirectory = process.cwd();
    try {
      // Released serveStatic predates the explicit fixture directory option.
      process.chdir(source.root);
      serveStatic(app, { canonicalBaseUrl: "https://www.mealscout.us", distPath });
    } finally { process.chdir(previousDirectory); }
    const server = http.createServer(app);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const [label, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } })) {
      for (const javaScriptEnabled of [false, true]) {
        const context = await browser.newContext({ viewport, javaScriptEnabled, serviceWorkers: "block" });
        const page = await context.newPage();
        const errors: string[] = [];
        const writes: string[] = [];
        const assets: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("response", response => {
          if (response.url().includes("/api/public-profile/app-assets/assets/")) {
            assert.equal(response.status(), 200, `compiled asset ${response.url()}`);
            assets.push(response.url().replace(origin, ""));
          }
        });
        await page.routeWebSocket("**/*", socket => socket.close());
        await page.route("**/*", async route => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== origin) return route.abort();
          if (!["GET", "HEAD"].includes(request.method())) {
            writes.push(url.pathname);
            return route.fulfill({ status: 405, contentType: "application/json", body: JSON.stringify({ error: "synthetic_fixture_write_blocked" }) });
          }
          if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/public-profile/app-assets/")) {
            if (url.pathname === "/api/auth/user") return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "Unauthorized" }) });
            const body = url.pathname.includes("trucks/live") ? { trucks: [] } : url.pathname.includes("deals/featured") ? { deals: [] } : url.pathname.includes("events/public") ? { events: [] } : [];
            return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
          }
          return route.continue();
        });
        // A browser's own coordinates never become a business location. No real
        // geolocation is read; Scout receives a synthetic unavailable result.
        await page.addInitScript("Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: (_success, failure) => failure({ code: 1, message: 'Synthetic fixture denies location' }), watchPosition: () => 0, clearWatch: () => undefined } })");
        const response = await page.goto(origin + "/", { waitUntil: "networkidle" });
        assert.equal(response?.status(), 200);
        const raw = await response!.text();
        const rawHasIdentity = raw.includes('<h1 class="sr-only">Welcome to MealScout</h1>');
        if (source.name === "after") {
          assert.ok(rawHasIdentity);
          assert.ok(raw.includes('rel="canonical" href="https://www.mealscout.us/"'));
          assert.ok(raw.includes('name="robots" content="index, follow'));
        } else assert.equal(rawHasIdentity, false);
        if (source.name === "after" || javaScriptEnabled) {
          await page.getByTestId("welcome-landing").waitFor({ state: "visible" });
          const signup = page.getByRole("link", { name: "Sign up", exact: true });
          for (const name of ["Sign up", "Log in", "Follow The Flavor"]) {
            const link = page.getByRole("link", { name, exact: true });
            const box = await link.boundingBox();
            assert.ok(box && box.width >= 24 && box.height >= 24 && box.x >= 0 && box.x + box.width <= viewport.width + 1);
          }
          const background = await page.locator('[data-testid="welcome-landing"] > div').first().evaluate(element => getComputedStyle(element).backgroundImage);
          assert.ok(background.includes("mealscout-welcome-map-night"));
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
          if (javaScriptEnabled) {
            await page.waitForFunction(() => Object.keys(document.getElementById("root") || {}).some(key => key.startsWith("__reactContainer")));
            const betaButton = page.getByRole("button", { name: /got it/i });
            if (await betaButton.isVisible()) await betaButton.click();
            await signup.click();
            await page.getByTestId("button-signup-flow-private_chef").waitFor();
            assert.ok(page.url().includes("/customer-signup"));
            await page.goto(origin + "/", { waitUntil: "networkidle" });
            if (await betaButton.isVisible()) await betaButton.click();
            await page.getByRole("link", { name: "Log in", exact: true }).click();
            await page.getByTestId("button-email-login").click();
            await page.getByTestId("button-login-submit").waitFor();
            assert.ok(page.url().includes("/login"));
            await page.goto(origin + "/", { waitUntil: "networkidle" });
            if (await betaButton.isVisible()) await betaButton.click();
            await page.getByRole("link", { name: "Follow The Flavor", exact: true }).click();
            await page.getByTestId("scout-map-container").waitFor();
            assert.ok(page.url().includes("/scout"));
            assert.ok(assets.length > 0, "real compiled App graph loaded through existing bridge");
          }
        }
        if (!javaScriptEnabled && output) await page.screenshot({ path: path.join(output, `${source.name}-${label}.png`), fullPage: true });
        assert.deepEqual(errors, []);
        assert.deepEqual(writes, []);
        results.push({ source: source.name, viewport: label, javaScriptEnabled, rawHasIdentity, compiledAssets: assets.length, writes, errors, result: "PASS" });
        await context.close();
      }
    }
  }
  console.log(JSON.stringify({ results }, null, 2));
} finally {
  if (output) fs.writeFileSync(path.join(output, "browser-results.json"), JSON.stringify({ results }, null, 2));
  await browser.close();
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
}
