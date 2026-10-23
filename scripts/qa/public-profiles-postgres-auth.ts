import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import express from "express";
import passport from "passport";
import bcrypt from "bcryptjs";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import * as schema from "../../shared/schema";

// Requires an explicitly owned, empty Docker PostgreSQL fixture with the native
// schema applied using drizzle-kit push. Accepts a port, never a database URL.
// Native auth, Passport, PostgreSQL session store, storage, ownership and route
// policies are retained. The server/db module's Neon driver/Drizzle binding
// is replaced by local node-postgres/Drizzle; Neon setup remains unproved.
const port = Number(process.env.PROFILE_QA_POSTGRES_PORT);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, "Owned local PostgreSQL port required");
for (const key of Object.keys(process.env)) {
  if (/DATABASE_URL|STRIPE|BREVO|TWILIO|SMTP|SENDGRID|RESEND|GOOGLE|FACEBOOK|OPENAI|ANTHROPIC|SESSION_COOKIE_DOMAIN/.test(key)) delete process.env[key];
}
process.env.NODE_ENV = "development";
process.env.DATABASE_URL = `postgresql://profile_qa:synthetic-local-proof-only@127.0.0.1:${port}/mealscout_profiles_qa`;
process.env.SESSION_SECRET = "synthetic-disposable-session-secret-no-production-authority";
process.env.ADMIN_EMAIL = "unseeded-admin@example.invalid";
process.env.EMAIL_NOTIFICATIONS_MODE = "off";
const root = process.cwd();
const output = path.resolve(process.env.PROFILE_QA_EVIDENCE_DIR || "../mealscout-profile-evidence/postgres-auth");
await mkdir(output, { recursive: true }); await mkdir(".tmp-tests", { recursive: true });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const db = drizzle(pool, { schema });
const report: any = { checks: [], scope: "Disposable PostgreSQL with native schema/constraints, bcrypt login, Passport, native PostgreSQL sessions, real storage and API registrars. The server/db module uses a test-only node-postgres/Drizzle binding; native Neon setup and migration upgrades are not exercised. No production, OAuth, providers, payments or deployment." };
const check = (label: string, value: unknown) => { assert.ok(value, label); report.checks.push(label); };
let browser: any, server: any, vite: any, sessionStore: any;
try {
  const identity = (await pool.query("select current_database() as db, current_user as actor, version() as version")).rows[0];
  assert.equal(identity.db, "mealscout_profiles_qa"); assert.equal(identity.actor, "profile_qa");
  assert.equal(Number((await pool.query("select count(*) from users")).rows[0].count), 0, "Fixture must be empty");
  report.database = { ...identity, constraints: Number((await pool.query("select count(*) from pg_constraint where connamespace='public'::regnamespace")).rows[0].count) };
  check("native PostgreSQL constraints exist", report.database.constraints > 100);
  const password = "SyntheticProfile!2026";
  const ownerId = "profile-pg-owner", otherId = "profile-pg-other";
  const passwordHash = await bcrypt.hash(password, 12);
  for (const [id, emailVerified] of [[ownerId, true], [otherId, true], ["profile-pg-unverified", false]] as const) {
    await db.insert(schema.users).values({ id, email: `${id}@example.invalid`, passwordHash, emailVerified, firstName: "Synthetic", lastName: "Owner", phone: "+18505550199", userType: "food_truck", isDisabled: false, publicProfileSettings: { showAddress: true, showContact: true } });
  }
  await db.insert(schema.cities).values({ id: "profile-pg-city", name: "Pensacola", slug: "pensacola-fl", state: "FL", timezone: "America/Chicago" });
  const kinds = ["restaurant", "truck", "bar", "caterer", "private_chef", "location", "supplier"];
  const rows = new Map<string, any>();
  for (const [index, kind] of kinds.entries()) {
    const id = `d0000000-0000-4000-8000-00000000000${index + 1}`;
    const row = { id, ownerId, userId: ownerId, name: `Native PG ${kind} Kitchen`, businessName: `Native PG ${kind} Kitchen`, businessType: kind === "truck" ? "food_truck" : kind, isFoodTruck: kind === "truck", isActive: true, isVerified: false, city: "Pensacola", state: "FL", address: "101 Synthetic Market Street", cuisineType: "Coastal", description: "Synthetic PostgreSQL public profile", phone: "+18505550199", contactPhone: "+18505550199", websiteUrl: "https://profile.example.invalid", logoUrl: "/fixture/photo.svg", coverImageUrl: "/fixture/photo.svg", locationType: "other" };
    rows.set(kind, row);
    await db.insert(schema.publicBusinessSlugOwnerships).values({ id: `pg-slug-${kind}`, slug: `native-pg-${kind.replace("_", "-")}-kitchen`, entityType: kind, entityId: id, assignmentStatus: "assigned" });
    if (kind === "location") await db.insert(schema.hosts).values(row);
    else if (kind === "supplier") await db.insert(schema.suppliers).values(row);
    else {
      await db.insert(schema.restaurants).values(row);
      const [menu] = await db.insert(schema.menus).values({ restaurantId: id, name: "Synthetic lunch" }).returning();
      await db.insert(schema.menuItems).values({ menuId: menu.id, restaurantId: id, name: "Synthetic coastal bowl", priceCents: 1200, imageUrl: "/fixture/photo.svg", isAvailable: true });
    }
  }
  const truck = rows.get("truck");
  const hiddenId = "d0000000-0000-4000-8000-000000000098", foreignId = "d0000000-0000-4000-8000-000000000099";
  await db.insert(schema.restaurants).values([{ ...truck, id: hiddenId, name: "Synthetic hidden kitchen", isActive: false }, { ...truck, id: foreignId, name: "Synthetic other owner", ownerId: otherId }]);
  (globalThis as any).__profilePostgres = { db, pool };
  const bundle = path.resolve(".tmp-tests/profile-postgres-native.cjs");
  await build({ absWorkingDir: root, stdin: { contents: `export {storage} from './server/storage'; export {registerClaimRoutes} from './server/routes/claimRoutes'; export {registerDealManagementRoutes} from './server/routes/dealManagementRoutes'; export {setupUnifiedAuth,getSession} from './server/unifiedAuth'; export {registerAuthAccountRoutes} from './server/routes/authAccountRoutes'; export {registerBusinessTeamRoutes} from './server/routes/businessTeamRoutes'; export {registerPublicDiscoveryRoutes} from './server/routes/publicDiscoveryRoutes'; export {registerDiscoveryRoutes} from './server/routes/discoveryRoutes'; export {registerPublicProfilePrerenderRoutes} from './server/seo/publicProfilePrerender'; export {registerRestaurantOperationsRoutes} from './server/routes/restaurantOperationsRoutes'; export {registerBookingRoutes} from './server/routes/bookingRoutes'; export {registerMenuRoutes} from './server/routes/menuRoutes'; export {registerSupplierMarketplaceRoutes} from './server/routes/supplierMarketplaceRoutes'; export {createRouteAccessPolicyDependencies} from './server/routes/accessPolicyDependencies';`, resolveDir: root, loader: "ts" }, outfile: bundle, bundle: true, platform: "node", format: "cjs", packages: "external", plugins: [{ name: "local-postgres-transport", setup(b) {
    b.onResolve({ filter: /.*/ }, args => path.resolve(args.resolveDir, args.path) === root + "/server/db" ? { path: "db", namespace: "profile-pg" } : undefined);
    b.onLoad({ filter: /.*/, namespace: "profile-pg" }, () => ({ loader: "js", contents: "export const db=globalThis.__profilePostgres.db;export const pool=globalThis.__profilePostgres.pool;" }));
  } }] });
  const native = createRequire(import.meta.url)(bundle);
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !["/api/auth/login", "/api/auth/restaurant/login", "/api/auth/logout"].includes(req.path) && !/\/profile-basics$|\/manual-schedule$/.test(req.path) && !/^\/api\/deals\/[^/]+(?:\/claim)?$/.test(req.path)) { res.status(405).json({ message: "Unrelated fixture write blocked" }); return; }
    next();
  });
  app.use(native.getSession());
  app.use((req: any, _res, next) => { sessionStore = req.sessionStore; next(); });
  app.use(passport.initialize()); app.use(passport.session());
  await native.setupUnifiedAuth(app);
  native.registerAuthAccountRoutes(app); native.registerBusinessTeamRoutes(app);
  const policies = native.createRouteAccessPolicyDependencies(null);
  native.registerRestaurantOperationsRoutes(app, policies); native.registerBookingRoutes(app, policies);
  native.registerMenuRoutes(app); native.registerSupplierMarketplaceRoutes(app);
  let syntheticClaimNotifications = 0;
  native.registerClaimRoutes(app, { sendDealClaimedNotification: async () => { syntheticClaimNotifications += 1; } });
  native.registerDealManagementRoutes(app, { logAudit: async () => {}, notifyNearbyDealSubscribers: async () => {}, notifyRestaurantFollowersOfDeal: async () => {}, toNumeric: (value: unknown) => Number(value), hasCompleteProfileAccess: async () => false, queueSocialPost: async () => {} });
  native.registerPublicDiscoveryRoutes(app); native.registerDiscoveryRoutes(app);
  app.use("/api", (_req, res) => res.status(404).json({ message: "Unregistered fixture API" }));
  native.registerPublicProfilePrerenderRoutes(app, "https://www.mealscout.us");
  app.get("/fixture/photo.svg", (_req, res) => res.type("svg").send('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="#ffb777"/></svg>'));
  vite = await createServer({ configFile: path.resolve("vite.config.ts"), server: { middlewareMode: true, hmr: false }, appType: "spa" }); app.use(vite.middlewares);
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const publicDto = async (kind: string, id: string) => { const response = await fetch(`${base}/api/public/profiles/${kind}/${id}`); assert.equal(response.status, 200); return response.json(); };
  browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await context.route("**/*", route => {
    const u = new URL(route.request().url()); if (u.origin !== base) return route.abort();
    if (!["GET", "HEAD", "OPTIONS"].includes(route.request().method()) && !["/api/auth/login", "/api/auth/logout"].includes(u.pathname) && !/\/profile-basics$|\/manual-schedule$/.test(u.pathname)) return route.fulfill({ status: 204 });
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  await page.addInitScript(() => { navigator.geolocation.getCurrentPosition = () => { throw Error("Owner GPS is not a business location"); }; });
  for (const kind of kinds) {
    const row = rows.get(kind); row.dto = await publicDto(kind, row.id);
    const response = await fetch(base + row.dto.profilePath); const html = await response.text();
    check(`${kind} PostgreSQL-backed logged-out HTML/API`, response.status === 200 && html.includes(row.dto.displayName));
    await page.goto(base + row.dto.profilePath + "?view=app", { waitUntil: "networkidle" });
    check(`${kind} actual logged-out routed UI`, await page.getByRole("heading", { name: row.dto.displayName, exact: true }).isVisible());
    check(`${kind} canonical`, await page.locator('link[rel="canonical"]').getAttribute("href") === row.dto.seo.canonicalUrl);
  }
  check("logged-out profile edits rejected", (await context.request.patch(`${base}/api/restaurants/${truck.id}/profile-basics`, { data: { description: "forbidden" } })).status() === 401);
  check("wrong password rejected", (await context.request.post(base + "/api/auth/login", { data: { email: `${ownerId}@example.invalid`, password: "wrong" } })).status() === 401);
  check("unverified email cannot establish a session", (await context.request.post(base + "/api/auth/login", { data: { email: "profile-pg-unverified@example.invalid", password } })).status() === 403);
  const editorPath = `/restaurant-owner-dashboard?setup=profile&restaurantId=${truck.id}`;
  await page.goto(base + "/login?redirect=" + encodeURIComponent(editorPath), { waitUntil: "networkidle" });
  await page.getByTestId("button-email-login").click(); await page.getByTestId("input-email").fill(`${ownerId}@example.invalid`); await page.getByTestId("input-password").fill(password);
  await page.getByTestId("button-login-submit").click();
  await page.getByRole("heading", { name: "What customers see", exact: true }).waitFor();
  check("native password login opens owner editor", new URL(page.url()).pathname === "/restaurant-owner-dashboard");
  const cookies = await context.cookies(); const sessionCookie = cookies.find((cookie: any) => cookie.name === "tradescout.sid");
  check("native session cookie is HTTP-only and local SameSite Lax", sessionCookie?.httpOnly && sessionCookie.sameSite === "Lax");
  check("session persisted by native PostgreSQL store", Number((await pool.query("select count(*) from sessions where sess->'passport'->>'user'=$1", [ownerId])).rows[0].count) > 0);
  const current = await context.request.get(base + "/api/auth/user"); const actor = await current.json();
  check("native session deserializes sanitized owner", current.status() === 200 && actor.id === ownerId && !JSON.stringify(actor).includes(passwordHash));
  check("foreign business edit rejected", (await context.request.patch(`${base}/api/restaurants/${foreignId}/profile-basics`, { data: { description: "forbidden" } })).status() === 403);
  check("hidden unverified publication stays blocked", (await context.request.patch(`${base}/api/restaurants/${hiddenId}/profile-basics`, { data: { isActive: true } })).status() === 409);
  check("hidden public API stays unavailable", (await context.request.get(`${base}/api/public/profiles/truck/${hiddenId}`)).status() === 404);
  const dismiss = page.getByRole("button", { name: /got it/i }); if (await dismiss.isVisible()) await dismiss.click();
  const about = page.getByLabel(/^About your business/);
  await pool.query("create function profile_qa_reject() returns trigger language plpgsql as $$ begin if NEW.description = 'Synthetic rejected draft' then raise exception 'Synthetic owned persistence failure'; end if; return NEW; end $$; create trigger profile_qa_failure before update on restaurants for each row execute function profile_qa_reject()");
  await about.fill("Synthetic rejected draft"); await page.getByTestId("button-save-profile").click(); await page.getByText("Unable to save profile", { exact: true }).waitFor();
  check("real PostgreSQL failed save retains owner draft", await about.inputValue() === "Synthetic rejected draft");
  check("failed transaction rolls back persisted description", (await publicDto("truck", truck.id)).description !== "Synthetic rejected draft");
  await pool.query("drop trigger profile_qa_failure on restaurants; drop function profile_qa_reject()");
  await page.getByTestId("button-save-profile").click(); await page.getByText("Business Profile Updated", { exact: true }).waitFor();
  await page.reload({ waitUntil: "networkidle" }); await page.getByRole("heading", { name: "What customers see", exact: true }).waitFor();
  check("real session owner retry/save survives reload", await about.inputValue() === "Synthetic rejected draft");
  await page.setViewportSize({ width: 1365, height: 900 }); await page.reload({ waitUntil: "networkidle" }); await page.getByRole("heading", { name: "What customers see", exact: true }).waitFor();
  check("desktop owner sees mobile PostgreSQL edit", await about.inputValue() === "Synthetic rejected draft");
  const concurrent = await Promise.all([context.request.patch(`${base}/api/restaurants/${truck.id}/profile-basics`, { data: { description: "Concurrent public description" } }), context.request.patch(`${base}/api/restaurants/${truck.id}/profile-basics`, { data: { websiteUrl: "https://concurrent.example.invalid" } })]);
  const saved = await publicDto("truck", truck.id);
  check("native locked concurrent field edits both persist", concurrent.every(response => response.status() === 200) && saved.description === "Concurrent public description" && saved.websiteUrl === "https://concurrent.example.invalid");
  const dealData = { restaurantId: truck.id, title: "Synthetic release special", description: "Isolated local PostgreSQL fixture only", dealType: "fixed", discountValue: "4.00", imageUrl: "/fixture/photo.svg", startDate: new Date("2020-01-01"), endDate: new Date("2099-01-01"), isOngoing: false, isActive: true, perCustomerLimit: 2, totalUsesLimit: 10 };
  const [offer] = await db.insert(schema.deals).values(dealData).returning();
  const claims = await Promise.all(Array.from({ length: 5 }, () => context.request.post(`${base}/api/deals/${offer.id}/claim`, { data: {} })));
  const receipts = await Promise.all(claims.map(response => response.json()));
  const firstId = receipts[0].claim?.id;
  check("native authenticated concurrent claim API issues one durable receipt", claims.every(response => response.status() === 200) && receipts.every(value => value.claim?.id === firstId));
  check("PostgreSQL row lock reserves capacity once", Number((await pool.query("select current_uses from deals where id=$1", [offer.id])).rows[0].current_uses) === 1);
  check("native replay sends only one synthetic notification", syntheticClaimNotifications === 1);
  await pool.query("update deal_claims set is_used=true,used_at=now() where id=$1", [firstId]);
  const second = await context.request.post(`${base}/api/deals/${offer.id}/claim`, { data: {} }); const secondReceipt = await second.json();
  check("native PostgreSQL allows a deliberate second claim after use within limit", second.status() === 200 && secondReceipt.claim.id !== firstId && secondReceipt.replayed === false);
  const removed = await context.request.delete(`${base}/api/deals/${offer.id}`);
  check("native owner delete preserves issued receipts", removed.status() === 200 && Number((await pool.query("select count(*) from deal_claims where deal_id=$1", [offer.id])).rows[0].count) === 2);
  check("removal deactivates the retained offer", (await pool.query("select is_active from deals where id=$1", [offer.id])).rows[0].is_active === false);
  const wallet = await context.request.get(base + "/api/deals/claimed"); const walletRows = await wallet.json();
  check("native wallet retains used and unavailable receipts after removal", wallet.status() === 200 && walletRows.some((value: any) => value.id === firstId && value.isUsed) && walletRows.some((value: any) => value.id === secondReceipt.claim.id && value.isActive === false));
  check("receipt projection keeps private address hidden", walletRows.every((value: any) => value.restaurantAddress === null && !("restaurantVisibility" in value)));
  const [emptyOffer] = await db.insert(schema.deals).values({ ...dealData, title: "Synthetic unclaimed removal" }).returning();
  check("claim-free offer still deletes through native route", (await context.request.delete(`${base}/api/deals/${emptyOffer.id}`)).status() === 200 && (await pool.query("select count(*) from deals where id=$1", [emptyOffer.id])).rows[0].count === "0");
  const [racingOffer] = await db.insert(schema.deals).values({ ...dealData, title: "Synthetic concurrent removal" }).returning();
  const [racingClaim, racingRemoval] = await Promise.all([context.request.post(`${base}/api/deals/${racingOffer.id}/claim`, { data: {} }), context.request.delete(`${base}/api/deals/${racingOffer.id}`)]);
  const racingClaims = (await pool.query("select id from deal_claims where deal_id=$1", [racingOffer.id])).rows;
  const retainedOffer = (await pool.query("select is_active from deals where id=$1", [racingOffer.id])).rows;
  check("concurrent native removal and claim cannot orphan or erase an issued receipt", racingRemoval.status() === 200 && (racingClaim.status() === 200 ? racingClaims.length === 1 && retainedOffer[0]?.is_active === false : racingClaims.length === 0));
  const originalCookie = `${sessionCookie.name}=${sessionCookie.value}`;
  check("native logout succeeds", (await context.request.post(base + "/api/auth/logout")).status() === 200);
  check("logged-out session no longer reads owner", (await context.request.get(base + "/api/auth/user")).status() === 401);
  check("destroyed cookie replay rejected", (await fetch(base + "/api/auth/user", { headers: { cookie: originalCookie } })).status === 401);
  check("logout removes persisted authenticated session", Number((await pool.query("select count(*) from sessions where sess->'passport'->>'user'=$1", [ownerId])).rows[0].count) === 0);
  const login = await context.request.post(base + "/api/auth/restaurant/login", { data: { email: `${ownerId}@example.invalid`, password } });
  check("native business password login succeeds", login.status() === 200);
  await pool.query("update sessions set expire=now()-interval '1 minute' where sess->'passport'->>'user'=$1", [ownerId]);
  check("expired PostgreSQL session cannot edit profile", (await context.request.patch(`${base}/api/restaurants/${truck.id}/profile-basics`, { data: { description: "expired" } })).status() === 401);
  await context.close();
  report.status = "PASS";
} catch (error) { report.status = "FAIL"; report.error = String(error); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await vite?.close(); await sessionStore?.close(); await pool.end();
  report.cleanup = { browserClosed: !browser?.isConnected(), serverClosed: !server?.listening, sessionStoreClosed: sessionStore?.closed === true, databasePoolClosed: pool.ended };
  await writeFile(path.join(output, "receipt.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, output }));
}
// The native document-validation module starts a process-lifetime cache timer.
// End this standalone fixture only after its server/browser/store/pool close.
process.exit(process.exitCode || 0);
