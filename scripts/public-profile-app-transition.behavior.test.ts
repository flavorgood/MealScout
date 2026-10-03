import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import express from "express";
import { chromium } from "playwright";
import { PUBLIC_PROFILE_STYLES, PUBLIC_PROFILE_STYLES_PATH } from "../server/seo/publicProfileStyles";

process.env.NODE_ENV = "development";
const { registerPublicProfilePrerenderRoutes } = await import("../server/seo/publicProfilePrerender");

const ID = "a0000000-0000-4000-8000-000000000001";
const OTHER = "a0000000-0000-4000-8000-000000000002";
const canonical = `/truck/public-fixture--${ID}`;
// Exact production CSP observed in the immutable September 30 public browser receipt.
const productionCsp = "default-src 'self';style-src 'self';script-src 'self';img-src 'self' data: https:;connect-src 'self' https: ws: wss:;font-src 'self' https: data:;worker-src 'self' blob:;child-src 'self' blob:;base-uri 'self';form-action 'self';frame-ancestors 'self';object-src 'none';script-src-attr 'none';upgrade-insecure-requests";

async function fixture() {
  const state = { visible: true, fail: false, path: canonical, appId: ID, appType: "truck" as "truck" | "bar", runtimeBase: "", continuationCount: 0, trustedAppMarkers: [] as unknown[], reads: [] as Array<{ id: string; type?: string }> };
  const app = express();
  app.use((_req, res, next) => { res.setHeader("Content-Security-Policy", productionCsp); next(); });
  registerPublicProfilePrerenderRoutes(app, "https://www.mealscout.us", async () => ({ kind: "not_found", reason: "city" }), {
    restaurantPage: async (_base, id, type) => {
      state.reads.push({ id, type });
      if (state.fail) throw new Error("Fixture native loader unavailable");
      if (!state.visible || id !== ID || (type && type !== "truck")) return null;
      return { title: "Public Fixture in Pensacola, FL | MealScout", description: "Current public food truck fixture", canonicalPath: state.path, imageUrl: state.runtimeBase + "/og-default.jpg", robots: "index,follow", schema: {}, links: [{ label: "Open profile", href: state.path }], body: ["Public menu fixture"], appProfile: { id: state.appId, profileType: state.appType }, selectiveIntelligence: { manifestUrl: `https://www.mealscout.us/api/owner-ai/profiles/${id}/selective-intelligence`, mcpUrl: `https://www.mealscout.us/api/owner-ai/profiles/${id}/mcp` } };
    },
  });
  app.get("/og-default.jpg", (_req, res) => res.type("image/gif").send(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")));
  app.use((req, res) => {
    state.continuationCount++;
    state.trustedAppMarkers.push(res.locals.mealScoutPublicProfileAppView);
    res.type("html").send(`<!doctype html><html><head><title>Existing app boundary fixture</title></head><body><main id="root"><h1>PublicProfilePage handoff fixture</h1><p>This marker proves route continuation, not actual React rendering.</p><p>${req.path}</p></main></body></html>`);
  });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  state.runtimeBase = base;
  return { state, base, get: (url: string) => fetch(base + url, { redirect: "manual", signal: AbortSignal.timeout(5000) }), close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

test("canonical public SSR links to a bounded existing-app view and serves CSP-compatible CSS", async () => {
  const f = await fixture();
  try {
    const response = await f.get(canonical + "?ref=affiliate&utm_source=google&token=secret&redirect=https://evil.example");
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, new RegExp(`href="${canonical}\\?view=app&amp;ref=affiliate&amp;utm_source=google"`));
    assert.match(html, new RegExp(`<link rel="stylesheet" href="${PUBLIC_PROFILE_STYLES_PATH}">`));
    assert.doesNotMatch(html, /<style\b|\sstyle=/);
    assert.doesNotMatch(html, /secret|evil\.example/);
    assert.equal(f.state.continuationCount, 0);
    const css = await f.get(PUBLIC_PROFILE_STYLES_PATH);
    assert.equal(css.status, 200); assert.match(css.headers.get("content-type")!, /text\/css/); assert.equal(css.headers.get("x-content-type-options"), "nosniff"); assert.equal(await css.text(), PUBLIC_PROFILE_STYLES);
    const app = await f.get(canonical + "?view=app&ref=affiliate&utm_source=google");
    assert.equal(app.status, 200); assert.match(await app.text(), /PublicProfilePage handoff fixture/);
    assert.equal(app.headers.get("cache-control"), "no-store"); assert.equal(f.state.continuationCount, 1);
    assert.deepEqual(f.state.trustedAppMarkers, [true]);
    assert.match(app.headers.get("link")!, new RegExp(`<https://www.mealscout.us${canonical}>; rel="canonical"`));
    assert.match(app.headers.get("link")!, new RegExp(`/profiles/${ID}/selective-intelligence>; rel="alternate"; type="application/vnd.selective-intelligence\\+json"`));
    assert.match(app.headers.get("link")!, new RegExp(`/profiles/${ID}/mcp>; rel="alternate"; type="application/mcp\\+json"`));
  } finally { await f.close(); }
});

test("only one exact app flag reaches continuation; attribution normalization removes unsafe query values", async () => {
  const f = await fixture();
  try {
    for (const query of ["?app=1", "?view=APP", "?view=app&view=app", "?view=app&view=other", "?view=other", "?view[mode]=app"]) {
      const response = await f.get(canonical + query); assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /handoff fixture/);
    }
    assert.equal(f.state.continuationCount, 0);
    assert.deepEqual(f.state.trustedAppMarkers, []);
    const sanitized = await f.get(canonical + "?view=app&ref=partner&token=secret&redirect=https://evil.example");
    assert.equal(sanitized.status, 308); assert.equal(sanitized.headers.get("location"), canonical + "?view=app&ref=partner");
    assert.equal(f.state.continuationCount, 0);
    assert.equal((await f.get(sanitized.headers.get("location")!)).status, 200); assert.equal(f.state.continuationCount, 1);
    assert.deepEqual(f.state.trustedAppMarkers, [true]);
    await f.get("/unrelated-app-route?view=app");
    assert.deepEqual(f.state.trustedAppMarkers, [true, undefined], "An unrelated query cannot manufacture the server-owned rewrite marker");
  } finally { await f.close(); }
});

test("current eligibility, canonical path, type and entity binding are checked before app handoff", async () => {
  const f = await fixture();
  try {
    f.state.visible = false;
    assert.equal((await f.get(canonical + "?view=app")).status, 404);
    f.state.visible = true;
    assert.equal((await f.get(`/truck/missing--${OTHER}?view=app`)).status, 404);
    for (const mutation of [() => { f.state.appId = OTHER; }, () => { f.state.appType = "bar"; }, () => { f.state.path = "//evil.example/profile"; }, () => { f.state.path = `/truck/other--${OTHER}`; }]) {
      f.state.appId = ID; f.state.appType = "truck"; f.state.path = canonical; mutation();
      assert.equal((await f.get(canonical + "?view=app")).status, 200); assert.equal(f.state.continuationCount, 0);
    }
    f.state.path = canonical; f.state.appId = ID; f.state.appType = "truck";
    const wrongKind = await f.get(`/bar/public-fixture--${ID}?view=app&ref=partner`);
    assert.equal(wrongKind.status, 308); assert.equal(wrongKind.headers.get("location"), canonical + "?ref=partner");
    const staleSlug = await f.get(`/truck/stale-name--${ID}?view=app`);
    assert.equal(staleSlug.status, 200); assert.equal(f.state.continuationCount, 0);
    f.state.fail = true; assert.equal((await f.get(canonical + "?view=app")).status, 503);
    assert.equal(f.state.continuationCount, 0);
  } finally { await f.close(); }
});

test("public disable revokes a previously valid app-view request and private gates gain no app bypass", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.get(canonical + "?view=app")).status, 200); assert.equal(f.state.continuationCount, 1);
    f.state.visible = false;
    assert.equal((await f.get(canonical + "?view=app")).status, 404); assert.equal(f.state.continuationCount, 1);
    assert.equal((await f.get(`/caterer/private--${OTHER}?view=app`)).status, 404);
    assert.equal((await f.get(`/private-chef/private--${OTHER}?view=app`)).status, 404);
    assert.equal(f.state.continuationCount, 1);
  } finally { await f.close(); }
});

test("real Chromium applies same-origin SSR CSS under production CSP and follows only the eligible app boundary", async () => {
  const f = await fixture();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const errors: string[] = [];
  const report: Record<string, unknown> = { fixtureOnly: true, actualReactRenderingProven: false, observedAt: new Date().toISOString(), productionCsp };
  try {
    browser = await chromium.launch({ headless: true });
    const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36 MealScout-public-customer-proof`;
    const page = await browser.newPage({ userAgent });
    await page.route("**/*", route => ["GET", "HEAD", "OPTIONS"].includes(route.request().method()) ? route.continue() : route.abort("blockedbyclient"));
    report.userAgent = userAgent;
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(f.base + canonical + "?ref=browser-proof", { waitUntil: "load" });
    const styles = await page.evaluate(() => ({ headingSize: getComputedStyle(document.querySelector("h1")!).fontSize, bodyBackground: getComputedStyle(document.body).backgroundColor, stylesheetCount: document.styleSheets.length, canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href"), openHref: document.querySelector<HTMLAnchorElement>('.links a')?.getAttribute("href") }));
    assert.equal(styles.headingSize, "34px"); assert.equal(styles.bodyBackground, "rgb(255, 250, 242)"); assert.equal(styles.stylesheetCount, 1);
    assert.equal(styles.canonical, "https://www.mealscout.us" + canonical);
    assert.equal(styles.openHref, canonical + "?view=app&ref=browser-proof");
    const [appResponse] = await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.getByRole("link", { name: "Open profile", exact: true }).click()]);
    await page.getByRole("heading", { name: "PublicProfilePage handoff fixture", exact: true }).waitFor({ state: "visible" });
    assert.equal(new URL(page.url()).search, "?view=app&ref=browser-proof");
    assert.ok(await page.locator("#root").isVisible());
    assert.deepEqual(errors, []);
    Object.assign(report, { passed: true, styles, appUrlPathAndQuery: new URL(page.url()).pathname + new URL(page.url()).search, appDiscoveryLinkHeader: await appResponse!.headerValue("link"), consoleErrors: errors });
  } finally {
    if (browser) await browser.close(); await f.close(); report.browserClosed = Boolean(browser);
    if (process.env.PUBLIC_PROFILE_APP_TRANSITION_EVIDENCE_DIR) await writeFile(path.join(process.env.PUBLIC_PROFILE_APP_TRANSITION_EVIDENCE_DIR, "public-profile-app-transition-local.json"), JSON.stringify(report, null, 2));
  }
});
