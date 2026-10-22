import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableColumns } from "drizzle-orm";
import { deals, dealClaims, restaurants, users } from "../shared/schema";
import { claimDealWithReceipt, getUserDealClaimReceipts } from "../server/services/dealClaimLifecycle";
import { createDealClaimHandler } from "../server/routes/dealClaimHandler";

const NOW = new Date("2026-10-22T12:00:00Z");
const baseDeal = () => ({
  id: "synthetic-deal", restaurantId: "synthetic-restaurant", title: "Fixture lunch",
  dealType: "fixed", discountValue: "4.00", minOrderAmount: null,
  startDate: new Date("2026-10-01T00:00:00Z"), endDate: new Date("2026-11-01T00:00:00Z"),
  startTime: "11:00", endTime: "15:00", availableDuringBusinessHours: false,
  isOngoing: false, isActive: true, currentUses: 0, totalUsesLimit: null, perCustomerLimit: 1,
});

// Real Drizzle SQL and transaction orchestration, with an in-memory PostgreSQL
// transport. This fixture never reads DATABASE_URL or connects to a database.
function fixture(patch: Record<string, unknown> = {}) {
  const state = {
    deal: { ...baseDeal(), ...patch } as any,
    restaurant: { id: "synthetic-restaurant", ownerId: "synthetic-owner", name: "Fixture kitchen", address: null, isActive: true } as any,
    owner: { id: "synthetic-owner", isDisabled: false } as any,
    claims: [] as any[],
    failInsert: false,
    queries: [] as { text: string; params: any[]; client: number }[],
  };
  let nextClient = 0;
  let lockTail = Promise.resolve();
  const tables: Record<string, any> = { deals, deal_claims: dealClaims, restaurants, users };
  const columnKeys = (table: string) => Object.fromEntries(
    Object.entries(getTableColumns(tables[table])).map(([key, column]) => [(column as any).name, key]),
  );
  const rowFor = (select: string, from: string, joined: Record<string, any>) =>
    select.split(/,\s*/).map((field) => {
      const match = field.match(/^(?:"([^"]+)"\.)?"([^"]+)"$/);
      assert.ok(match, `Unrecognized native select: ${field}`);
      const table = match[1] || from;
      const value = joined[table]?.[columnKeys(table)[match[2]]] ?? null;
      // pg returns timestamp-without-time-zone strings; Drizzle supplies UTC.
      return value instanceof Date ? value.toISOString().replace("Z", "") : value;
    });
  const pool = {
    async connect() {
      const client = ++nextClient;
      let unlock: (() => void) | undefined;
      let snapshot: any;
      return {
        release() {},
        async query(config: any, values?: any[]) {
          const text = typeof config === "string" ? config : config.text;
          const params = values || config.values || [];
          state.queries.push({ text, params, client });
          if (/^begin/i.test(text)) return { rows: [] };
          if (/^(commit|rollback)/i.test(text)) {
            if (/^rollback/i.test(text) && snapshot) {
              state.deal = snapshot.deal;
              state.claims = snapshot.claims;
            }
            unlock?.();
            return { rows: [] };
          }
          if (/for update$/i.test(text)) {
            const previous = lockTail;
            lockTail = new Promise<void>((resolve) => { unlock = resolve; });
            await previous;
            snapshot = structuredClone({ deal: state.deal, claims: state.claims });
          }
          if (/^select /i.test(text)) {
            const match = text.match(/^select (.*?) from "([^"]+)"/i)!;
            const [_, select, table] = match;
            let rows: Record<string, any>[];
            if (table === "deals") rows = state.deal?.id === params[0] ? [{ deals: state.deal }] : [];
            else if (table === "restaurants") rows = state.restaurant?.id === params[0] ? [{ restaurants: state.restaurant }] : [];
            else if (table === "users") rows = state.owner?.id === params[0] ? [{ users: state.owner }] : [];
            else {
              const wallet = /left join/.test(text);
              rows = state.claims.filter((claim) => wallet
                ? claim.userId === params[0]
                : claim.dealId === params[0] && claim.userId === params[1])
                .slice().reverse().map((claim) => ({
                  deal_claims: claim,
                  deals: state.deal?.id === claim.dealId ? state.deal : null,
                  restaurants: state.deal?.id === claim.dealId ? state.restaurant : null,
                  users: state.restaurant ? state.owner : null,
                }));
            }
            return { rows: rows.map((row) => rowFor(select, table, row)) };
          }
          if (/^update "deals"/.test(text)) {
            assert.match(text, /coalesce\("deals"\."current_uses", 0\)/);
            assert.match(text, /"total_uses_limit" is null or/);
            if (state.deal.totalUsesLimit != null && state.deal.currentUses >= state.deal.totalUsesLimit) return { rows: [] };
            state.deal.currentUses = (state.deal.currentUses || 0) + 1;
            return { rows: [[state.deal.id]] };
          }
          if (/^insert into "deal_claims"/.test(text)) {
            if (state.failInsert) throw new Error("Synthetic insert failure");
            const claim = {
              id: `synthetic-claim-${state.claims.length + 1}`, dealId: params[0], userId: params[1],
              claimedAt: NOW, usedAt: null, isUsed: false, orderAmount: null,
            };
            state.claims.push(claim);
            return { rows: [rowFor(text.split(" returning ")[1], "deal_claims", { deal_claims: claim })] };
          }
          throw new Error(`Unexpected native SQL: ${text}`);
        },
      };
    },
    async query(config: any, values?: any[]) {
      const client = await this.connect();
      return client.query(config, values);
    },
  };
  // Drizzle recognizes pool clients by their constructor name and pins each
  // native transaction to one connection, as with the real pg.Pool.
  class SyntheticPool {}
  Object.setPrototypeOf(pool, SyntheticPool.prototype);
  const database = drizzle(pool as any);
  return { state, database, claim: (userId = "synthetic-user") => claimDealWithReceipt(database, state.deal?.id || "missing", userId, NOW) };
}

test("native transaction persists one receipt through concurrent clicks, retry and wallet reload", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.claim()));
  assert.equal(f.state.claims.length, 1);
  assert.equal(f.state.deal.currentUses, 1);
  assert.equal(new Set(results.map((result) => result.ok && result.claim.id)).size, 1);
  assert.equal(results.filter((result) => result.ok && !result.replayed).length, 1);
  for (const query of f.state.queries.filter((query) => /from "deal_claims"/.test(query.text))) {
    const before = f.state.queries.slice(0, f.state.queries.indexOf(query));
    assert.ok(before.some((item) => item.client === query.client && /for update$/.test(item.text)));
  }
  const wallet = await getUserDealClaimReceipts(f.database, "synthetic-user");
  assert.equal(wallet[0].id, f.state.claims[0].id);
  assert.equal(wallet[0].dealType, "fixed");
  assert.equal(wallet[0].endDate.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(wallet[0].isActive, true);
  assert.equal(wallet[0].restaurantAddress, null);
  assert.equal(wallet[0].startTime, "11:00");
  assert.equal(wallet[0].endTime, "15:00");
  assert.equal(wallet[0].availableDuringBusinessHours, false);
  assert.deepEqual(await getUserDealClaimReceipts(f.database, "other-user"), []);
});

test("used receipts and configured per-customer limits survive reload and deliberate later claim", async () => {
  const f = fixture({ perCustomerLimit: 2 });
  await f.claim();
  f.state.claims[0].isUsed = true;
  f.state.claims[0].usedAt = NOW;
  const second = await f.claim();
  assert.equal(second.ok && second.replayed, false);
  assert.equal(f.state.claims.length, 2);
  f.state.claims[1].isUsed = true;
  f.state.claims[1].usedAt = NOW;
  const replay = await f.claim();
  assert.equal(replay.ok && replay.claim.id, "synthetic-claim-2");
  assert.equal(replay.ok && replay.claim.isUsed, true);
  assert.equal(f.state.deal.currentUses, 2);
});

test("existing receipt is recoverable after expiry or closure; a new claim is unavailable", async () => {
  const f = fixture();
  await f.claim();
  f.state.deal.isActive = false;
  f.state.deal.endDate = new Date("2026-10-20");
  assert.equal((await f.claim()).ok, true);
  assert.deepEqual(await f.claim("new-user"), { ok: false, reason: "unavailable" });
  const receipts = await getUserDealClaimReceipts(f.database, "synthetic-user");
  assert.equal(receipts[0].isActive, false);
  assert.equal(receipts[0].endDate.toISOString(), "2026-10-20T00:00:00.000Z");
  f.state.restaurant = null;
  assert.equal((await getUserDealClaimReceipts(f.database, "synthetic-user"))[0].restaurantIsActive, false);
});

test("wallet and claim receipts never expose the raw private business address", async () => {
  const f = fixture();
  f.state.restaurant.address = "Synthetic private address: do not publish";
  await f.claim();
  const receipts = await getUserDealClaimReceipts(f.database, "synthetic-user");
  assert.equal(receipts[0].restaurantAddress, null);
  assert.ok(!JSON.stringify(receipts).includes("do not publish"));
  const walletRead = f.state.queries.find((query) => /left join/.test(query.text));
  assert.ok(walletRead);
  assert.doesNotMatch(walletRead.text, /"restaurants"\."address"/);
  assert.ok(!JSON.stringify(receipts).includes("restaurantVisibility"));
  assert.ok(!JSON.stringify(receipts).includes("ownerIsDisabled"));
});

test("canonical hidden business policy blocks new claims while issued receipts remain recoverable", async () => {
  for (const hide of [
    (f: ReturnType<typeof fixture>) => { f.state.owner.isDisabled = true; },
    (f: ReturnType<typeof fixture>) => { f.state.owner = null; },
    (f: ReturnType<typeof fixture>) => { f.state.restaurant.name = "Dummy fixture kitchen"; },
    (f: ReturnType<typeof fixture>) => { f.state.restaurant.rawData = { evidenceQuarantine: { active: true } }; },
  ]) {
    const f = fixture();
    await f.claim();
    hide(f);
    assert.deepEqual(await f.claim("new-user"), { ok: false, reason: "unavailable" });
    const replay = await f.claim();
    assert.equal(replay.ok && replay.claim.id, "synthetic-claim-1");
    const receipts = await getUserDealClaimReceipts(f.database, "synthetic-user");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].restaurantIsActive, false);
    assert.equal(receipts[0].restaurantAddress, null);
    assert.ok(!JSON.stringify(receipts).includes("evidenceQuarantine"));
  }
});

test("fresh claims reject future/expired/malformed dates, inactive businesses and sold out capacity", async () => {
  for (const patch of [
    { startDate: new Date("2026-11-02") }, { endDate: NOW }, { isActive: false },
    { endDate: "bad-date" }, { startDate: null }, { endDate: null, isOngoing: false },
  ]) {
    const f = fixture(patch);
    assert.deepEqual(await f.claim(), { ok: false, reason: "unavailable" });
    assert.equal(f.state.claims.length, 0);
  }
  const inactive = fixture();
  inactive.state.restaurant.isActive = false;
  assert.deepEqual(await inactive.claim(), { ok: false, reason: "unavailable" });
  const limited = fixture({ totalUsesLimit: 1 });
  const results = await Promise.all([limited.claim("a"), limited.claim("b")]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(limited.state.deal.currentUses, 1);
  const ongoing = fixture({ endDate: null, isOngoing: true });
  assert.equal((await ongoing.claim()).ok, true);
});

test("failed persistence rolls back capacity and a later explicit retry succeeds once", async () => {
  const f = fixture();
  f.state.failInsert = true;
  await assert.rejects(f.claim());
  assert.equal(f.state.deal.currentUses, 0);
  assert.equal(f.state.claims.length, 0);
  assert.ok(f.state.queries.some((query) => /^rollback/i.test(query.text)));
  f.state.failInsert = false;
  assert.equal((await f.claim()).ok, true);
  assert.equal(f.state.claims.length, 1);
});

test("actual HTTP claim handler returns durable receipt, recovers lost response and notifies once", async () => {
  const f = fixture();
  let notifications = 0;
  const app = express();
  const storage = {
    getDeal: async () => f.state.deal,
    getRestaurant: async () => f.state.restaurant,
    claimDealAtomic: async (_deal: string, user: string) => f.claim(user),
    getUserDealClaimsWithDetails: (user: string) => getUserDealClaimReceipts(f.database, user),
  };
  app.post("/api/deals/:dealId/claim", (req: any, _res, next) => { req.user = { id: "synthetic-user" }; next(); },
    createDealClaimHandler(storage, async () => { notifications++; }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/api/deals/synthetic-deal/claim`;
    // Discard the first successful body to model response loss after commit.
    const initial = await fetch(url, { method: "POST" });
    assert.equal(initial.status, 200);
    const response = await fetch(url, { method: "POST" });
    const receipt = await response.json();
    assert.equal(receipt.claimId, "synthetic-claim-1");
    assert.equal(receipt.claim.id, receipt.claimId);
    assert.equal(receipt.replayed, true);
    assert.equal(receipt.claim.isUsed, false);
    assert.equal(receipt.restaurantAddress, null);
    assert.match(receipt.facebookPostData.message, /\$4.00 off/);
    assert.doesNotMatch(receipt.facebookPostData.message, /15|4.00%/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(notifications, 1);
    assert.equal(f.state.claims.length, 1);

    f.state.claims[0].isUsed = true;
    f.state.claims[0].usedAt = NOW;
    const usedReceipt = await (await fetch(url, { method: "POST" })).json();
    assert.equal(usedReceipt.claim.isUsed, true);
    assert.equal(usedReceipt.replayed, true);
    assert.equal(f.state.claims.length, 1);

    f.state.deal.isActive = false;
    const unavailable = createDealClaimHandler({ ...storage, claimDealAtomic: async () => ({ ok: false, reason: "unavailable" }) }, async () => {});
    let responseCode = 200;
    let body: any;
    await unavailable({ params: { dealId: f.state.deal.id }, user: { id: "new-user" } }, {
      status(code: number) { responseCode = code; return this; },
      json(payload: any) { body = payload; return this; },
    });
    assert.equal(responseCode, 409);
    assert.equal(body.code, "unavailable");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
