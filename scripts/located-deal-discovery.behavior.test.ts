import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { build } from "esbuild";
import express from "express";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableColumns } from "drizzle-orm";
import { deals, restaurants, users } from "../shared/schema";
import { locatedDealBounds } from "../server/services/locatedDealCandidates";

const root = resolve(import.meta.dirname, "..");
const now = new Date();
const globals = globalThis as any;

// Compile the actual registrar plus the two actual storage methods. Substitute
// only singleton/auth seams; no provider or DATABASE_URL module is imported.
const source = await readFile(join(root, "server/storage.ts"), "utf8");
const ast = ts.createSourceFile("storage.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const storageClass = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "DatabaseStorage") as ts.ClassDeclaration;
const methods = ["getActiveDeals", "filterDealsByOperatingHours"].map((name) => {
  const method = storageClass.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === name);
  assert.ok(method, `Native storage method ${name} exists`);
  return method.getText(ast);
});
const seamPlugin: any = {
  name: "synthetic-deal-discovery-seams",
  setup(builder: any) {
    builder.onResolve({ filter: /^(\.\.\/|\.\/)(db|storage|unifiedAuth)$/ }, (args: any) => ({ path: args.path.split("/").at(-1), namespace: "synthetic" }));
    builder.onLoad({ filter: /.*/, namespace: "synthetic" }, (args: any) => ({
      contents: args.path === "unifiedAuth"
        ? "export const isAuthenticated = (_req, _res, next) => next();"
        : `export const ${args.path === "db" ? "db" : "storage"} = new Proxy({}, { get(_t, key) { const target = globalThis.__locatedDealFixture.${args.path === "db" ? "database" : "storage"}; const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; } });`,
      loader: "js",
    }));
  },
};
async function compile(name: string, input: any) {
  const result = await build({ absWorkingDir: root, bundle: true, platform: "node", format: "esm", packages: "external", write: false,
    tsconfig: join(root, "tsconfig.json"), plugins: [seamPlugin], ...input });
  const filename = join(root, "scripts", `.located-deal-${name}-${process.pid}.mjs`);
  await writeFile(filename, result.outputFiles[0].text);
  try { return await import(pathToFileURL(filename).href); }
  finally { await unlink(filename); }
}
const { NativeStorage } = await compile("storage", { stdin: { contents: `
  import { and, eq, lte, gte, sql, desc, inArray } from 'drizzle-orm';
  import { deals, restaurants } from '@shared/schema';
  import { db } from './db';
  import { getLocatedActiveDealCandidates } from './services/locatedDealCandidates';
  export class NativeStorage { ${methods.join("\n")} }
`, loader: "ts", resolveDir: join(root, "server") } });
const { registerDealDiscoveryRoutes } = await compile("route", { entryPoints: ["server/routes/dealDiscoveryRoutes.ts"] });

function fixture() {
  const state = { deals: [] as any[], restaurants: [] as any[], users: [] as any[], queries: [] as { text: string; params: any[] }[] };
  const tables: Record<string, any> = { deals, restaurants, users };
  const keys = (table: string) => Object.fromEntries(Object.entries(getTableColumns(tables[table])).map(([key, value]) => [(value as any).name, key]));
  const rowFor = (select: string, table: string, row: any) => select.split(/,\s*/).map((field) => {
    const match = field.match(/^(?:"([^"]+)"\.)?"([^"]+)"$/);
    assert.ok(match, `Native select field ${field}`);
    const value = row[keys(match[1] || table)[match[2]]] ?? null;
    return value instanceof Date ? value.toISOString().replace("Z", "") : value;
  });
  const pairMatches = (restaurant: any, text: string, params: any[], current: boolean) => {
    const lat = current ? "current_latitude" : "latitude";
    const lng = current ? "current_longitude" : "longitude";
    const latitude = restaurant[current ? "currentLatitude" : "latitude"];
    const longitude = restaurant[current ? "currentLongitude" : "longitude"];
    if (latitude == null || longitude == null) return false;
    const latMatch = text.match(new RegExp(`"restaurants"\\."${lat}" between \\$(\\d+) and \\$(\\d+)`));
    assert.ok(latMatch, `Latitude bound for ${lat} is in native SQL`);
    if (Number(latitude) < params[Number(latMatch[1]) - 1] || Number(latitude) > params[Number(latMatch[2]) - 1]) return false;
    const between = text.match(new RegExp(`"restaurants"\\."${lng}" between \\$(\\d+) and \\$(\\d+)`));
    if (between) return Number(longitude) >= params[Number(between[1]) - 1] && Number(longitude) <= params[Number(between[2]) - 1];
    const wraps = text.match(new RegExp(`"restaurants"\\."${lng}" >= \\$(\\d+) or "restaurants"\\."${lng}" <= \\$(\\d+)`));
    return wraps ? Number(longitude) >= params[Number(wraps[1]) - 1] || Number(longitude) <= params[Number(wraps[2]) - 1] : true;
  };
  const client = { async query(config: any, values?: any[]) {
    const text = typeof config === "string" ? config : config.text;
    const params = values || config.values || [];
    state.queries.push({ text, params });
    const match = text.match(/^select (.*?) from "([^"]+)"/i);
    assert.ok(match, `Only native read queries are permitted: ${text}`);
    const [, select, table] = match;
    let rows: any[];
    if (table === "deals") {
      const scoped = /inner join "restaurants"/.test(text);
      if (scoped) {
        assert.doesNotMatch(text, /\blimit\b/i, "No candidate cap before radius/query/public projection");
        assert.match(text, /"deals"\."end_date" is null and "deals"\."is_ongoing" = \$\d+/);
        assert.match(text, /"deals"\."available_during_business_hours" = \$\d+/);
      }
      rows = state.deals.filter((deal) => {
        if (!deal.isActive || new Date(deal.startDate).getTime() > Date.now()) return false;
        if (deal.endDate == null ? !scoped || deal.isOngoing !== true : new Date(deal.endDate).getTime() < Date.now()) return false;
        if (scoped && !deal.availableDuringBusinessHours && (deal.startTime == null || deal.endTime == null)) return false;
        if (!scoped) return true;
        const restaurant = state.restaurants.find((row) => row.id === deal.restaurantId);
        return restaurant && (pairMatches(restaurant, text, params, false) || pairMatches(restaurant, text, params, true));
      }).slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const limit = text.match(/limit \$(\d+)/);
      if (limit) rows = rows.slice(0, params[Number(limit[1]) - 1]);
    } else rows = (state as any)[table].filter((row: any) => params.includes(row.id));
    return { rows: rows.map((row) => rowFor(select, table, row)) };
  } };
  const database = drizzle(client as any);
  const storage = new NativeStorage();
  function add(id: string, latitude: number | null, longitude: number | null, options: any = {}) {
    const { restaurant: restaurantPatch, owner: ownerPatch, ...dealPatch } = options;
    const restaurant = { id: `r-${id}`, ownerId: `u-${id}`, name: `Kitchen ${id}`, cuisineType: "Soup", isActive: true,
      latitude, longitude, address: "Synthetic public address", ...restaurantPatch };
    state.restaurants.push(restaurant);
    state.users.push({ id: restaurant.ownerId, isDisabled: false, publicProfileSettings: { showAddress: true, showContact: false }, ...ownerPatch });
    state.deals.push({ id, restaurantId: restaurant.id, title: "Lunch soup", description: "A warm bowl", dealType: "fixed", discountValue: "3.00",
      minOrderAmount: "10.00", imageUrl: "/images/soup.jpg", isActive: true, startDate: new Date(now.getTime() - 86400000),
      endDate: new Date(now.getTime() + 86400000), startTime: "00:00", endTime: "23:59", createdAt: now, ...dealPatch });
    return restaurant;
  }
  return { state, database, storage, add };
}
async function withApi(f: ReturnType<typeof fixture>, run: (get: (path: string) => Promise<{ status: number; body: any }>) => Promise<void>) {
  globals.__locatedDealFixture = f;
  const app = express();
  registerDealDiscoveryRoutes(app, { filterDealsByBusinessAccess: async (rows: any[]) => rows, hasCompleteProfileAccess: async () => true });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const port = (server.address() as any).port;
    await run(async (path) => { const response = await fetch(`http://127.0.0.1:${port}${path}`); return { status: response.status, body: await response.json() }; });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("both native APIs recover an older local offer behind51newer distant offers", async () => {
  const f = fixture();
  for (let i = 0; i < 51; i++) f.add(`far-${i}`, 40, -80, { createdAt: new Date(now.getTime() + i) });
  f.add("older-near", 0.01, 0, { createdAt: new Date(now.getTime() - 100000) });
  await withApi(f, async (get) => {
    const native = f.storage.getActiveDeals.bind(f.storage);
    f.storage.getActiveDeals = () => native();
    assert.deepEqual((await get("/api/deals/search?lat=0&lng=0&radius=5&q=soup")).body, [], "Original global50candidate flow hides the local offer");
    f.storage.getActiveDeals = native;
    assert.deepEqual((await get("/api/deals/search?lat=0&lng=0&radius=5&q=soup")).body.map((row: any) => row.id), ["older-near"]);
    assert.deepEqual((await get("/api/deals/nearby/0/0?radius=5")).body.map((row: any) => row.id), ["older-near"]);
    assert.equal((await get("/api/deals/search?q=soup")).body.length, 50, "Unlocated flow retains original cap");
  });
});

test("query and price sorting happen before final50local result cap; ongoing hours remain eligible", async () => {
  const f = fixture();
  for (let i = 0; i < 51; i++) f.add(`local-${i}`, 0.01, 0, { title: "Sandwich", createdAt: new Date(now.getTime() + i) });
  f.add("older-match", 0.01, 0, { title: "Unique soup", createdAt: new Date(now.getTime() - 1000), minOrderAmount: "1.00", endDate: null, isOngoing: true,
    startTime: null, endTime: null, availableDuringBusinessHours: true });
  f.add("invalid-no-expiry", 0.01, 0, { title: "Unique invalid expiry", endDate: null, isOngoing: false });
  f.add("unknown-no-expiry", 0.01, 0, { title: "Unique unknown expiry", endDate: null, isOngoing: null });
  f.add("invalid-no-hours", 0.01, 0, { title: "Unique invalid hours", startTime: null, endTime: null, availableDuringBusinessHours: false });
  await withApi(f, async (get) => {
    assert.deepEqual((await get("/api/deals/search?lat=0&lng=0&radius=5&q=unique")).body.map((row: any) => row.id), ["older-match"]);
    const sorted = await get("/api/deals/search?lat=0&lng=0&radius=5&sortBy=price-low");
    assert.equal(sorted.body.length, 50);
    assert.equal(sorted.body[0].id, "older-match");
    assert.equal((await get("/api/deals/nearby/0/0?radius=5")).body.length, 50);
  });
});

test("canonical public projection chooses current live location and excludes stale/private/closed offers", async () => {
  const f = fixture();
  const live = { isFoodTruck: true, businessType: "food_truck", mobileOnline: true, liveBroadcasting: true,
    lastBroadcastAt: now, liveUntilAt: new Date(now.getTime() + 3600000), locationSource: "owner_gps" };
  f.add("live-near", 40, -80, { restaurant: { ...live, currentLatitude: 0.01, currentLongitude: 0 } });
  f.add("live-far", 0.01, 0, { restaurant: { ...live, currentLatitude: 40, currentLongitude: -80 } });
  f.add("stale-near", 40, -80, { restaurant: { ...live, currentLatitude: 0.01, currentLongitude: 0, lastBroadcastAt: new Date(now.getTime() - 86400000), liveUntilAt: new Date(now.getTime() - 1000) } });
  f.add("private-near", 0.01, 0, { owner: { publicProfileSettings: { showAddress: false } } });
  f.add("closed-near", 0.01, 0, { restaurant: { operatingHours: {} } });
  await withApi(f, async (get) => {
    for (const path of ["/api/deals/search?lat=0&lng=0&radius=5", "/api/deals/nearby/0/0?radius=5"]) {
      const response = await get(path);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.map((row: any) => row.id), ["live-near"]);
      assert.equal(response.body[0].restaurant.latitude, null, "Private truck administration location remains hidden");
    }
  });
});

test("exact sub-kilometre and above100km radii survive candidate and public projection", async () => {
  const f = fixture();
  f.add("quarter-km", 0.002, 0);
  f.add("three-quarter-km", 0.007, 0);
  f.add("one-hundred-fifty-km", 1.35, 0);
  await withApi(f, async (get) => {
    assert.deepEqual((await get("/api/deals/search?lat=0&lng=0&radius=0.5")).body.map((row: any) => row.id), ["quarter-km"]);
    assert.deepEqual((await get("/api/deals/nearby/0/0?radius=0.5")).body.map((row: any) => row.id), ["quarter-km"]);
    assert.ok((await get("/api/deals/search?lat=0&lng=0&radius=200")).body.some((row: any) => row.id === "one-hundred-fifty-km"));
  });
});

test("SQL bounding covers antimeridian and pole, while invalid local parameters fail explicitly", async () => {
  const f = fixture();
  f.add("across-dateline", 0, -179.99);
  f.add("across-pole", 89.99, 150);
  await withApi(f, async (get) => {
    assert.deepEqual((await get("/api/deals/nearby/0/179.99?radius=5")).body.map((row: any) => row.id), ["across-dateline"]);
    assert.deepEqual((await get("/api/deals/search?lat=89.99&lng=0&radius=5")).body.map((row: any) => row.id), ["across-pole"]);
    for (const path of ["/api/deals/search?lat=0", "/api/deals/search?lat=91&lng=0", "/api/deals/search?lat=0&lng=0&radius=0", "/api/deals/nearby/0/0?radius=nope"]) {
      assert.equal((await get(path)).status, 400);
    }
  });
  assert.equal(locatedDealBounds({ userLat: 0, userLng: 0, radiusKm: 50000 }).allLongitudes, true);
});
