import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import express from "express";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import * as schema from "../shared/schema";
import { checkPinnedPublicSource, hasPublicSourceAccessBarrier, sourceCheckUrl } from "../server/utils/pinnedPublicSourceCheck";

process.env.NODE_ENV = "development";
const service = await import("../server/services/publicProfileSourceChecks");
const { registerPublicProfileSourceCheckRoutes } = await import("../server/routes/publicProfileSourceCheckRoutes");
const pg = new PGlite();
for (const table of [schema.users, schema.restaurants, schema.telemetryEvents]) {
  const config = getTableConfig(table);
  await pg.exec(`create table "${config.name}" (${config.columns.map(c => `"${c.name}" ${c.getSQLType()}${c.primary ? " primary key" : ""}`).join(",")})`);
}
const database = drizzle(pg, { schema });
const restaurantId = service.PUBLIC_SOURCE_CHECK_TARGETS[1];
const ownerId = "source-owner";
await database.insert(schema.users).values({ id: ownerId, isDisabled: false, publicProfileSettings: { showContact: true } });
await database.insert(schema.restaurants).values({ id: restaurantId, ownerId,
  name: "Sweet Love", isActive: true, businessType: "restaurant", websiteUrl: "https://public.example/menu" });
let reads = 0;
const check = async (sourceUrl: string) => { reads++; return { sourceUrl, checkedAt: new Date().toISOString(), httpStatus: 200,
  bodyHash: String(reads === 1 ? "a" : "b").repeat(64), byteCount: 9, outcome: "UNVERIFIED" as const,
  availability: "reachable" as const, reason: "link_response_only_not_verified_facts" }; };
const options = { database, restaurantIds: [restaurantId], check, now: new Date("2026-09-30T00:00:00Z") };
assert.equal((await service.runPublicProfileSourceChecks(options)).results[0].status, "checked_unverified");
assert.equal((await service.runPublicProfileSourceChecks(options)).results[0].status, "already_checked");
assert.equal(reads, 1);
await service.runPublicProfileSourceChecks({ ...options, now: new Date("2026-10-01T00:00:00Z") });
let ownerResponse: any = await service.readPublicProfileSourceChecks(ownerId, restaurantId, database);
assert.equal(ownerResponse.checks[0].receipts[0].reviewStatus, "REVIEW_REQUIRED");
assert.equal(ownerResponse.checks[0].receipts[0].outcome, "UNVERIFIED");
await database.insert(schema.telemetryEvents).values({ id: "client-forgery", eventName: service.PUBLIC_SOURCE_CHECK_EVENT,
  properties: { restaurantId, day: "2026-09-30", complete: true, receipts: [{ html: "private" }] } });
assert.equal((await service.readPublicProfileSourceChecks(ownerId, restaurantId, database) as any).checks.length, 2);
assert.equal((await service.readPublicProfileSourceChecks("administrator", restaurantId, database)).status, 403);
await database.update(schema.users).set({ publicProfileSettings: { showContact: false } }).where(eq(schema.users.id, ownerId));
assert.equal((await service.readPublicProfileSourceChecks(ownerId, restaurantId, database) as any).checks[0].receipts.length, 0);
await service.runPublicProfileSourceChecks({ ...options, now: new Date("2026-10-02T00:00:00Z") });
assert.equal(reads, 2, "hidden contact must not be fetched");
await database.update(schema.users).set({ publicProfileSettings: { showContact: true } }).where(eq(schema.users.id, ownerId));
let activeTx: any;
const capturedDatabase = { transaction: (fn: any, config: any) => database.transaction(async tx => {
  activeTx = tx; return fn(tx);
}, config) };
await service.runPublicProfileSourceChecks({ ...options, database: capturedDatabase, now: new Date("2026-10-03T00:00:00Z"), check: async url => {
  const receipt = await check(url);
  await activeTx.update(schema.restaurants).set({ websiteUrl: "https://public.example/replaced" }).where(eq(schema.restaurants.id, restaurantId));
  return receipt;
} });
assert.equal((await service.readPublicProfileSourceChecks(ownerId, restaurantId, database) as any).checks[0].receipts.length, 0);
await database.update(schema.users).set({ isDisabled: true }).where(eq(schema.users.id, ownerId));
await service.runPublicProfileSourceChecks({ ...options, now: new Date("2026-10-04T00:00:00Z") });
assert.equal(reads, 3);
await database.update(schema.users).set({ isDisabled: false }).where(eq(schema.users.id, ownerId));
await service.runPublicProfileSourceChecks({ ...options, restaurantIds: [service.PUBLIC_SOURCE_CHECK_TARGETS[0]] });
assert.equal(reads, 3, "missing Florida native profile must skip");
const [native] = await database.select().from(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
assert.equal(native.updatedAt, null, "checker does not update native row timestamp");
await database.insert(schema.users).values({ id: "next-owner", isDisabled: false });
await database.update(schema.restaurants).set({ ownerId: "next-owner" }).where(eq(schema.restaurants.id, restaurantId));
assert.equal((await service.readPublicProfileSourceChecks(ownerId, restaurantId, database)).status, 403);
assert.equal((await service.readPublicProfileSourceChecks("next-owner", restaurantId, database) as any).checks.length, 0);
assert.equal((await service.runPublicProfileSourceChecks({ ...options, now: new Date("2026-10-01T00:00:00Z") })).results[0].status, "prior_owner_check");
await database.update(schema.restaurants).set({ ownerId }).where(eq(schema.restaurants.id, restaurantId));
await service.runPublicProfileSourceChecks({ ...options, database: capturedDatabase, now: new Date("2026-10-05T00:00:00Z"), check: async url => {
  const receipt = await check(url);
  await activeTx.update(schema.restaurants).set({ ownerId: "next-owner" }).where(eq(schema.restaurants.id, restaurantId));
  return receipt;
} });
assert.equal((await service.readPublicProfileSourceChecks("next-owner", restaurantId, database) as any).checks.length, 0);
await database.update(schema.restaurants).set({ ownerId }).where(eq(schema.restaurants.id, restaurantId));
assert.deepEqual(service.projectPublicSourceUrls({ ...native, isActive: false }, { id: ownerId, isDisabled: false }), []);
assert.deepEqual(service.projectPublicSourceUrls(native, { id: ownerId, isDisabled: false, publicProfileSettings: { showContact: false } }), []);
assert.deepEqual(service.projectPublicSourceUrls({ ...native, rawData: { evidenceQuarantine: {
  status: "quarantined", decisions: { website_link: { status: "rejected" }, social_links: { status: "rejected" } },
} } }, { id: ownerId, isDisabled: false }), []);
const beforeBusy = reads;
const busyDatabase = { transaction: (fn: any, config: any) => database.transaction(tx => fn(new Proxy(tx, {
  get(target, key) { return key === "execute" ? async () => ({ rows: [{ acquired: false }] }) : (target as any)[key]; },
})), config) };
assert.equal((await service.runPublicProfileSourceChecks({ ...options, database: busyDatabase,
  now: new Date("2026-10-06T00:00:00Z") })).results[0].status, "in_progress");
assert.equal(reads, beforeBusy, "busy lock must suppress external reads");

function transport(reply: { status?: number; location?: string; body?: string; bytes?: number; hang?: boolean; hangBody?: boolean }, seen: any[]) {
  return ((options: any, callback: any) => {
    seen.push(options); const req: any = new EventEmitter();
    options.signal.addEventListener("abort", () => req.emit("error", new Error("aborted")), { once: true });
    req.end = () => { if (reply.hang) return; queueMicrotask(() => {
      const res: any = new PassThrough(); res.statusCode = reply.status || 200;
      res.headers = { location: reply.location }; callback(res);
      if (!res.destroyed && !reply.hangBody) res.end(reply.bytes ? Buffer.alloc(reply.bytes) : reply.body || "public page");
    }); }; return req;
  }) as any;
}
const seen: any[] = [];
const resolver = async () => [{ address: "93.184.216.34", family: 4 }];
assert.equal(sourceCheckUrl("https://user:password@public.example/"), null);
assert.equal(sourceCheckUrl("https://public.example/?secret=value"), null);
assert.equal(sourceCheckUrl("http://public.example/"), null);
assert.equal(sourceCheckUrl("https://public.example:8443/"), null);
let receipt = await checkPinnedPublicSource("https://public.example/", { resolve: resolver, request: transport({}, seen) });
assert.equal(receipt.availability, "reachable"); assert.equal(receipt.outcome, "UNVERIFIED");
assert.equal(seen[0].hostname, "93.184.216.34"); assert.equal(seen[0].servername, "public.example");
assert.equal(seen[0].headers.Cookie, undefined); assert.equal(seen[0].headers.Authorization, undefined);
receipt = await checkPinnedPublicSource("https://public.example/", { resolve: async () => [{ address: "127.0.0.1", family: 4 }], request: transport({}, seen) });
assert.equal(receipt.reason, "blocked_address"); assert.equal(seen.length, 1);
receipt = await checkPinnedPublicSource("https://public.example/", { resolve: resolver, request: transport({ status: 403 }, seen) });
assert.equal(receipt.httpStatus, 403); assert.equal(receipt.availability, "unavailable");
receipt = await checkPinnedPublicSource("https://public.example/", { resolve: resolver, request: transport({ body: "<title>Please log in to continue</title>" }, seen) });
assert.equal(receipt.reason, "login_or_access_barrier");
receipt = await checkPinnedPublicSource("https://public.example/", { resolve: resolver, request: transport({ body:
  '<title>Home Sweet Love</title><nav>Sign in</nav><script>const challengeRecovery = true; const loginDialog = "Log in";</script><h1>Welcome</h1>' }, seen) });
assert.equal(receipt.availability, "reachable"); assert.equal(receipt.outcome, "UNVERIFIED");
receipt = await checkPinnedPublicSource("https://www.instagram.com/accounts/login/", { resolve: resolver, request: transport({ body: "<title>Instagram</title>" }, seen) });
assert.equal(receipt.availability, "unavailable");
assert.equal(hasPublicSourceAccessBarrier(new URL("https://public.example/"), "<title>Login • Instagram</title>"), true);
for (const punctuation of ["|", ":", "-"]) assert.equal(hasPublicSourceAccessBarrier(new URL("https://public.example/"), `<title>Log in${punctuation}Instagram</title>`), true);
assert.equal(hasPublicSourceAccessBarrier(new URL("https://public.example/"), "<h1>Access denied</h1>"), true);
assert.equal(hasPublicSourceAccessBarrier(new URL("https://public.example/"), "<h1>Verify you are human</h1>"), true);
receipt = await checkPinnedPublicSource("https://public.example/", { resolve: resolver, request: transport({ bytes: 524289 }, seen) });
assert.equal(receipt.reason, "size_limit"); assert.equal(receipt.bodyHash, null);
receipt = await checkPinnedPublicSource("https://public.example/", { timeoutMs: 15, resolve: async () => new Promise(() => {}), request: transport({}, seen) });
assert.equal(receipt.reason, "timeout");
receipt = await checkPinnedPublicSource("https://public.example/", { timeoutMs: 15, resolve: resolver, request: transport({ hangBody: true }, seen) });
assert.equal(receipt.reason, "timeout");
receipt = await checkPinnedPublicSource("https://public.example/", { timeoutMs: 15, resolve: resolver, request: transport({ hang: true }, seen) });
assert.equal(receipt.reason, "timeout");
receipt = await checkPinnedPublicSource("https://public.example/", { resolve: resolver, request: transport({ status: 302, location: "https://public.example/next" }, seen) });
assert.equal(receipt.reason, "redirect_limit");
receipt = await checkPinnedPublicSource("https://public.example/", { resolve: resolver, request: transport({ status: 302, location: "http://127.0.0.1/" }, seen) });
assert.equal(receipt.reason, "unsafe_redirect");
receipt = await checkPinnedPublicSource("https://public.example/", {
  resolve: async host => host === "public.example" ? resolver() : [{ address: "169.254.169.254", family: 4 }],
  request: transport({ status: 302, location: "https://metadata.example/" }, seen) });
assert.equal(receipt.reason, "blocked_address");

const app = express();
registerPublicProfileSourceCheckRoutes(app, { authenticate: (req: any, _res, next) => {
  if (req.headers["x-test-user"]) req.user = { id: req.headers["x-test-user"] }; next();
}, read: (userId, id) => service.readPublicProfileSourceChecks(userId, id, database) });
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api/restaurants/${restaurantId}/public-source-checks`;
try {
  const anonymous = await fetch(base); assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("cache-control"), "private, no-store");
  assert.equal((await fetch(base, { headers: { "x-test-user": "administrator" } })).status, 403);
  const owner = await fetch(base, { headers: { "x-test-user": ownerId } }); assert.equal(owner.status, 200);
  assert.equal((await owner.json()).schedule.timezone, "Etc/UTC");
  assert.equal((await fetch(base, { method: "POST" })).status, 404);
} finally { server.close(); await pg.close(); }
console.log("PASS public-profile-source-checks: real PGlite native/dedup/visibility/forgery/hash comparison; pinned transport SSRF/DNS deadline/socket timeout/size/redirect/login; real loopback owner-only route");
