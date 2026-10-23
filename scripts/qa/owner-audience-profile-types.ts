import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import express from "express";
import passport from "passport";
import bcrypt from "bcryptjs";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import * as schema from "../../shared/schema";

// Use an owned, empty, disposable PostgreSQL fixture with the native schema.
// Accept a loopback port only, never an ambient database URL or provider key.
const port = Number(process.env.AUDIENCE_QA_POSTGRES_PORT);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, "Owned local PostgreSQL port required");
const baseline = process.env.AUDIENCE_QA_BASELINE === "1";
for (const key of Object.keys(process.env)) {
  if (/DATABASE_URL|STRIPE|BREVO|TWILIO|SMTP|SENDGRID|RESEND|GOOGLE|FACEBOOK|OPENAI|ANTHROPIC|SESSION_COOKIE_DOMAIN/.test(key)) delete process.env[key];
}
process.env.NODE_ENV = "development";
process.env.DATABASE_URL = `postgresql://profile_qa:synthetic-local-proof-only@127.0.0.1:${port}/mealscout_profiles_qa`;
process.env.SESSION_SECRET = "synthetic-disposable-audience-session-no-production-authority";
process.env.ADMIN_EMAIL = "unseeded-admin@example.invalid";
process.env.EMAIL_NOTIFICATIONS_MODE = "off";
const root = process.cwd();
const output = path.resolve(process.env.AUDIENCE_QA_EVIDENCE_DIR || "../mealscout-profile-benefits-evidence/audience");
await mkdir(output, { recursive: true });
await mkdir(".tmp-tests", { recursive: true });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const db = drizzle(pool, { schema });
const report: any = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  operationsSha256: createHash("sha256").update(await readFile("server/routes/restaurantOperationsRoutes.ts")).digest("hex"),
  mode: baseline ? "reproduce existing omission" : "verify repaired native flow",
  scope: "Loopback disposable PostgreSQL, native schema, bcrypt/Passport/session, storage, public analytics writer, both owner analytics routes and actual App on desktop/mobile. Test-only node-postgres transport replaces Neon binding. No production, providers, grants, payments or configuration changes.",
  checks: [],
};
const check = (label: string, value: unknown) => { assert.ok(value, label); report.checks.push(label); };
let browser: any, server: any, vite: any, sessionStore: any;
try {
  const identity = (await pool.query("select current_database() as db, current_user as actor, version() as version")).rows[0];
  assert.equal(identity.db, "mealscout_profiles_qa");
  assert.equal(identity.actor, "profile_qa");
  assert.equal(Number((await pool.query("select count(*) from users")).rows[0].count), 0, "Fixture must be empty");
  report.database = identity;
  const password = "SyntheticAudience!2026";
  const ownerId = "audience-qa-owner", outsiderId = "audience-qa-other";
  const passwordHash = await bcrypt.hash(password, 12);
  for (const id of [ownerId, outsiderId]) {
    await db.insert(schema.users).values({ id, email: `${id}@example.invalid`, passwordHash, emailVerified: true, firstName: "Synthetic", lastName: "Owner", userType: "restaurant_owner", isDisabled: false, publicProfileSettings: { showAddress: true, showContact: true } });
  }
  const kinds = ["restaurant", "truck", "bar", "caterer", "private_chef"] as const;
  const rows = new Map<string, any>();
  for (const [index, kind] of kinds.entries()) {
    const id = `e0000000-0000-4000-8000-00000000000${index + 1}`;
    const row = { id, ownerId, name: `Synthetic ${kind.replace("_", " ")} Kitchen`, businessType: kind === "truck" ? "food_truck" : kind, isFoodTruck: kind === "truck", isActive: true, isVerified: false, city: "Pensacola", state: "FL", address: "101 Synthetic Market Street", description: "Isolated Audience proof", cuisineType: "Coastal", websiteUrl: "https://audience.example.invalid", coverImageUrl: "/fixture/photo.svg" };
    rows.set(kind, row);
    await db.insert(schema.restaurants).values(row);
    await db.insert(schema.publicBusinessSlugOwnerships).values({ id: `audience-slug-${kind}`, slug: `synthetic-audience-${kind.replace("_", "-")}`, entityType: kind, entityId: id, assignmentStatus: "assigned" });
    const [menu] = await db.insert(schema.menus).values({ restaurantId: id, name: "Synthetic lunch" }).returning();
    await db.insert(schema.menuItems).values({ menuId: menu.id, restaurantId: id, name: "Synthetic coastal bowl", priceCents: 1200, isAvailable: true });
  }
  (globalThis as any).__audiencePostgres = { db, pool };
  const bundle = path.resolve(".tmp-tests/audience-native.cjs");
  await build({ absWorkingDir: root, stdin: { contents: `export {storage} from './server/storage'; export {setupUnifiedAuth,getSession} from './server/unifiedAuth'; export {registerAuthAccountRoutes} from './server/routes/authAccountRoutes'; export {registerBusinessTeamRoutes} from './server/routes/businessTeamRoutes'; export {registerPublicDiscoveryRoutes} from './server/routes/publicDiscoveryRoutes'; export {registerRestaurantOperationsRoutes} from './server/routes/restaurantOperationsRoutes'; export {createRouteAccessPolicyDependencies} from './server/routes/accessPolicyDependencies';`, resolveDir: root, loader: "ts" }, outfile: bundle, bundle: true, platform: "node", format: "cjs", packages: "external", plugins: [{ name: "owned-loopback-postgres", setup(b) {
    b.onResolve({ filter: /.*/ }, args => path.resolve(args.resolveDir, args.path) === root + "/server/db" ? { path: "db", namespace: "audience-pg" } : undefined);
    b.onLoad({ filter: /.*/, namespace: "audience-pg" }, () => ({ loader: "js", contents: "export const db=globalThis.__audiencePostgres.db;export const pool=globalThis.__audiencePostgres.pool;" }));
  } }] });
  const native = createRequire(import.meta.url)(bundle);
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !["/api/auth/login", "/api/auth/logout", "/api/public/profile-analytics"].includes(req.path)) { res.status(405).json({ message: "Unrelated fixture write blocked" }); return; }
    next();
  });
  app.use(native.getSession());
  app.use((req: any, _res, next) => { sessionStore = req.sessionStore; next(); });
  app.use(passport.initialize()); app.use(passport.session());
  await native.setupUnifiedAuth(app);
  native.registerAuthAccountRoutes(app); native.registerBusinessTeamRoutes(app);
  native.registerRestaurantOperationsRoutes(app, native.createRouteAccessPolicyDependencies(null));
  native.registerPublicDiscoveryRoutes(app);
  app.use("/api", (_req, res) => res.status(404).json({ message: "Unregistered fixture API" }));
  app.get("/fixture/photo.svg", (_req, res) => res.type("svg").send('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="#ffb777"/></svg>'));
  vite = await createServer({ configFile: path.resolve("vite.config.ts"), server: { middlewareMode: true, hmr: false }, appType: "spa" });
  app.use(vite.middlewares);
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const writer = async (kind: string, id: string, actionType: string) => {
    const response = await context.request.post(base + "/api/public/profile-analytics", { data: { profileEntity: kind, profileId: id, actionType, source: "public_profile" } });
    check(`${kind} native public writer acknowledges ${actionType}`, response.status() === 202 && (await response.json()).ok === true);
  };
  for (const kind of kinds) {
    await writer(kind, rows.get(kind).id, "profile_view");
    await writer(kind, rows.get(kind).id, "menu_click");
  }
  // Different surfaces, unrelated entity IDs and non-business entity types must
  // not inflate the selected business's genuine public-profile activity.
  await pool.query("insert into request_logs (method,path,status_code,duration_ms,surface,entity_id,entity_type,event_type,metadata) values ('EVENT','/fixture',200,0,'public_discovery',$1,'caterer','profile_view','{}'),('EVENT','/fixture',200,0,'public_profile',$1,'host','profile_view','{}')", [rows.get("caterer").id]);
  for (const kind of kinds) {
    const stored = (await pool.query("select event_type,metadata from request_logs where entity_id=$1 and entity_type=$2 and surface='public_profile'", [rows.get(kind).id, kind])).rows;
    check(`${kind} native writer preserves canonical event type`, stored.length === 2 && stored.some(row => row.event_type === "profile_view") && stored.some(row => row.metadata.actionType === "menu_click"));
    const unauthenticated = await context.request.get(`${base}/api/restaurants/${rows.get(kind).id}/owner-value-dashboard`);
    check(`${kind} analytics rejects logged-out access`, unauthenticated.status() === 401);
  }
  const login = await context.request.post(base + "/api/auth/login", { data: { email: `${ownerId}@example.invalid`, password } });
  check("native password login succeeds without stored membership grant", login.status() === 200);
  for (const kind of kinds) {
    const id = rows.get(kind).id;
    const expected = baseline && ["caterer", "private_chef"].includes(kind) ? 0 : 1;
    for (const window of ["7d", "30d"]) {
      const response = await context.request.get(`${base}/api/restaurants/${id}/owner-value-dashboard?window=${window}`);
      const body = await response.json();
      check(`${kind} ${window} selected-business Audience totals${expected === 0 ? " reproduce missing activity" : " include recorded activity"}`, response.status() === 200 && body.totals.profileViews === expected && body.totals.menuClicks === expected && body.restaurantId === id);
      check(`${kind} ${window} recommendations agree with recorded views`, body.recommendations.some((row: any) => row.id === "drive_initial_traffic") === (expected === 0));
      check(`${kind} ${window} response omits raw viewer data`, !JSON.stringify(body).includes("anonymousActorId") && !("logs" in body));
    }
    const actions = await context.request.get(`${base}/api/restaurants/${id}/analytics/profile-actions`);
    const body = await actions.json();
    check(`${kind} profile-action analytics agrees with Audience`, actions.status() === 200 && body.totals.profileViews === expected && body.totals.menuClicks === expected && body.totals.lifetime === expected * 2);
  }
  const caterer = rows.get("caterer");
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  const pathToAudience = `/restaurant-owner-dashboard?workspace=audience&restaurantId=${caterer.id}`;
  for (const [label, viewport] of [["desktop", { width: 1365, height: 1000 }], ["mobile", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(viewport);
    await page.goto(base + pathToAudience, { waitUntil: "networkidle" });
    const audience = page.getByTestId("owner-audience-workspace"); await audience.waitFor();
    await expect(audience.getByRole("heading", { name: `See what people do after finding ${caterer.name}` })).toBeVisible();
    const summary = audience.getByRole("region", { name: "Audience summary" });
    for (const metric of ["Profile views", "Menu opens"]) {
      await expect(summary.getByText(metric, { exact: true }).locator("..").locator("p").nth(1)).toHaveText(baseline ? "0" : "1");
    }
    await expect(page.getByTestId("audience-empty-state")).toHaveCount(baseline ? 1 : 0);
    check(`${label} actual native Audience renders ${baseline ? "the reproduced false empty state" : "recorded caterer activity"}`, true);
    await audience.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${baseline ? "before" : "after"}-${label}.png`), fullPage: true });
    check(`${label} page fits viewport`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.getByTestId("audience-window-7d").click();
    await expect(page.getByTestId("audience-window-7d")).toHaveAttribute("aria-pressed", "true");
    check(`${label} period switch keeps the selected business`, new URL(page.url()).searchParams.get("restaurantId") === caterer.id);
    await page.route("**/owner-value-dashboard?*", async route => {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic transient audience outage" }) });
    });
    await audience.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByTestId("audience-error-state").waitFor();
    check(`${label} failed refresh is shown as unavailable`, await page.getByTestId("audience-empty-state").count() === 0);
    await page.unroute("**/owner-value-dashboard?*");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.getByRole("region", { name: "Audience summary" }).waitFor();
    check(`${label} explicit retry recovers native PostgreSQL totals`, await page.getByTestId("audience-error-state").count() === 0);
  }
  const logout = await context.request.post(base + "/api/auth/logout");
  check("native logout succeeds", logout.status() === 200);
  await page.goto(base + `/p/caterer/${caterer.id}?view=app`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: caterer.name, exact: true })).toBeVisible();
  check("logged-out actual public caterer profile remains reachable without membership", true);
  const outsider = await context.request.post(base + "/api/auth/login", { data: { email: `${outsiderId}@example.invalid`, password } });
  check("native outsider session succeeds", outsider.status() === 200);
  for (const suffix of ["owner-value-dashboard", "analytics/profile-actions"]) {
    check(`${suffix} rejects another business owner`, (await context.request.get(`${base}/api/restaurants/${caterer.id}/${suffix}`)).status() === 403);
  }
  check("no synthetic membership was granted", (await pool.query("select stripe_subscription_id from users where id=$1", [ownerId])).rows[0].stripe_subscription_id === null);
  await context.close(); report.status = baseline ? "REPRODUCED" : "PASS";
} catch (error) { report.status = "FAIL"; report.error = String(error); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await vite?.close(); await sessionStore?.close(); await pool.end();
  report.cleanup = { browserClosed: !browser?.isConnected(), serverClosed: !server?.listening, sessionStoreClosed: sessionStore?.closed === true, databasePoolClosed: pool.ended };
  await writeFile(path.join(output, "receipt.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, error: report.error, output }));
}
// Native document validation retains a process-lifetime timer. Exit only after
// the owned browser/server/session store/database pool have been closed.
process.exit(process.exitCode || 0);
