import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import ts from "typescript";
import { captureMealScoutBusinessPost, connectionBindingRevision, verifyMealScoutBusinessAsset } from "../server/services/reverseOsmosisBusinessAssets";
import * as guards from "../server/services/reverseOsmosisCaptureGuard";
import * as envelope from "../shared/reverseOsmosis";
import type { Scope } from "@tradescout-infinity/reverse-osmosis";

// No network fallback, real account, DB client or valid provider credentials.
process.env.FACEBOOK_APP_ID = "222222";
process.env.FACEBOOK_APP_SECRET = "SYNTHETIC_ONLY_NEVER_REAL";
const scope: Scope = { product: "mealscout", tenantId: "mealscout", businessId: "synthetic-restaurant", subjectId: "synthetic-restaurant", ownerId: "synthetic-owner", provider: "facebook", accountId: "111111" };
function connection() {
  return { id: "synthetic-connection", restaurantId: scope.businessId, createdByUserId: scope.ownerId, platform: "facebook", externalAccountId: scope.accountId, accessToken: "SYNTHETIC_PAGE_ONLY", refreshToken: null, tokenExpiresAt: new Date(Date.now() + 3_600_000), status: "active", scopes: ["pages_read_engagement"], metadata: { provider: "meta", pageId: scope.accountId }, updatedAt: new Date("2025-01-01") } as any;
}
function response(url: URL) {
  const name = url.pathname.split("/").at(-1);
  const payload = name === "me" ? { id: scope.accountId, category: "Restaurant", tasks: ["MANAGE"] }
    : name === "debug_token" ? { data: { is_valid: true, type: "PAGE", profile_id: scope.accountId, app_id: "222222", user_id: "333333", scopes: ["pages_read_engagement"], expires_at: 0, data_access_expires_at: 0 } }
    : name === "settings" ? { data: [{ setting: "IS_PUBLISHED", value: true }, { setting: "AGE_RESTRICTIONS", value: "Public" }, { setting: "COUNTRY_RESTRICTIONS", value: { restriction_type: "blacklist", countries: [] } }] }
    : { id: "111111_444444", from: { id: scope.accountId }, message: "Menu: https://menus.mealscout-fixture.net/current", permalink_url: "https://www.facebook.com/111111/posts/444444", is_published: true, privacy: { value: "EVERYONE", allow: "", deny: "" }, targeting: {}, feed_targeting: {}, is_hidden: false, is_expired: false, scheduled_publish_time: null, created_time: "2020-01-01T00:00:00Z", updated_time: "2020-01-01T00:00:00Z" };
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}
type Reply = (url: URL, init: RequestInit | undefined, calls: URL[]) => Response | Promise<Response>;
async function mocked<T>(work: (calls: URL[]) => Promise<T>, reply: Reply = url => response(url)) {
  const original = globalThis.fetch;
  const calls: URL[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://graph.facebook.com");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    assert.ok(["me", "debug_token", "111111_444444", "settings"].includes(url.pathname.split("/").at(-1)!));
    calls.push(url);
    return reply(url, init, calls);
  };
  try { return await work(calls); } finally { globalThis.fetch = original; }
}
const rejected = (work: Promise<unknown>, code: string) => assert.rejects(work, (error: any) => error.message === "reverse-osmosis:" + code);
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test("pre-aborted capture and invalid budgets start no provider work", async () => mocked(async calls => {
  const caller = new AbortController(); caller.abort(new Error("SYNTHETIC_PRIVATE_REASON"));
  await rejected(captureMealScoutBusinessPost(scope, connection(), scope.ownerId, "111111_444444", { signal: caller.signal }), "capture-cancelled");
  for (const budgetMs of [0, 20_001, Infinity, 1.5]) await rejected(captureMealScoutBusinessPost(scope, connection(), scope.ownerId, "111111_444444", { budgetMs }), "capture-budget-invalid");
  assert.equal(calls.length, 0);
}));
test("bounded successful capture still verifies the exact Page post and public evidence", async () => mocked(async calls => {
  const receipt = await captureMealScoutBusinessPost(scope, connection(), scope.ownerId, "111111_444444");
  assert.equal(receipt.providerPostId, "111111_444444");
  assert.equal(receipt.profile.menuUrl, "https://menus.mealscout-fixture.net/current");
  assert.match(receipt.sourceVersion, /^[a-f0-9]{64}$/);
  assert.equal(calls.length, 4);
  assert.equal(JSON.stringify(receipt).includes("SYNTHETIC_PAGE_ONLY"), false);
}));
test("caller cancellation rejects pending fetch, discards a late response and hides its reason", async () => {
  const caller = new AbortController();
  let release!: (value: Response) => void, reached!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  let cancelledBody = 0, signal: AbortSignal | null | undefined;
  await mocked(async calls => {
    const capture = captureMealScoutBusinessPost(scope, connection(), scope.ownerId, "111111_444444", { signal: caller.signal });
    await started; caller.abort(new Error("SYNTHETIC_PRIVATE_REASON"));
    await rejected(capture, "capture-cancelled");
    assert.equal(signal?.aborted, true);
    release(new Response(new ReadableStream({ cancel() { cancelledBody++; } })));
    await turn(); await turn();
    assert.equal(cancelledBody, 1);
    assert.equal(calls.length, 1);
  }, (_url, init) => { signal = init?.signal; reached(); return new Promise(resolve => { release = resolve; }); });
});
test("caller cancellation cancels a pending response reader and prevents later provider reads", async () => {
  const caller = new AbortController();
  let reached!: () => void, cancelledBody = 0;
  const started = new Promise<void>(resolve => { reached = resolve; });
  await mocked(async calls => {
    const capture = captureMealScoutBusinessPost(scope, connection(), scope.ownerId, "111111_444444", { signal: caller.signal });
    await started; caller.abort("SYNTHETIC_PRIVATE_REASON");
    await rejected(capture, "capture-cancelled");
    await turn();
    assert.equal(cancelledBody, 1); assert.equal(calls.length, 1);
  }, () => new Response(new ReadableStream({ pull() { reached(); return new Promise(() => {}); }, cancel() { cancelledBody++; } })));
});
test("one total budget stops sequential individually short reads and aborts the pending transport", async () => {
  let transportStops = 0;
  await mocked(async calls => {
    await rejected(captureMealScoutBusinessPost(scope, connection(), scope.ownerId, "111111_444444", { budgetMs: 80 }), "capture-deadline");
    assert.ok(calls.length > 0 && calls.length < 4);
    assert.equal(transportStops, 1);
  }, (url, init) => new Promise((resolve, reject) => {
    const signal = init!.signal!;
    const stop = () => { clearTimeout(timer); transportStops++; reject(new Error("SYNTHETIC_TRANSPORT_REASON")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(response(url)); }, 30);
    signal.addEventListener("abort", stop, { once: true });
  }));
});
test("direct asset verification accepts caller cancellation without starting its next read", async () => {
  const caller = new AbortController();
  await mocked(async calls => {
    const proposal = { scope, direction: "social-to-native" as const, eventId: "synthetic", sourceVersion: "synthetic", expectedNativeVersion: "synthetic", fields: {} };
    await rejected(verifyMealScoutBusinessAsset(proposal, connection(), scope.ownerId, caller.signal), "capture-cancelled");
    assert.equal(calls.length, 1);
  }, url => { const result = response(url); queueMicrotask(() => caller.abort("SYNTHETIC_PRIVATE_REASON")); return result; });
});

// Execute the actual source-preparation module with explicit DB/core/packet stand-ins.
// No server/db import is permitted; these cases do not claim native DB/core acceptance.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(repository, "server/services/reverseOsmosis.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
const nativeRequire = createRequire(import.meta.url);
function prepared(state: any) {
  const tables = Object.fromEntries(["restaurants", "users", "socialPublishingConnections", "reverseOsmosisOperations", "ownerAiActionDrafts", "socialPostQueue"].map(name => [name, { id: "id", ownerId: "ownerId" }]));
  const rows = (table: any) => {
    if (table === tables.restaurants) { state.ownerReads++; return [{ id: scope.businessId, ownerId: state.ownerId }]; }
    if (table === tables.users) return [{ id: scope.ownerId, isDisabled: state.disabled }];
    if (table === tables.socialPublishingConnections) return [structuredClone(state.connection)];
    if (table === tables.reverseOsmosisOperations) { state.reflectionReads++; return state.reflection ? [{ proposal: { direction: "native-to-social", scope }, receipt: { providerPostId: "111111_444444" } }] : []; }
    throw new Error("Unexpected synthetic table");
  };
  const database = { select() {
    let table: any;
    const query: any = { from(value: any) { table = value; return query; }, where() { return query; }, for() { return query; },
      limit() { state.queryStarts++; return state.pending ? state.pending : Promise.resolve(rows(table)); },
      then(resolve: any, reject: any) { return Promise.resolve(rows(table)).then(resolve, reject); } };
    return query;
  } };
  class OwnerError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
  const imports: Record<string, any> = {
    "node:crypto": nativeRequire("node:crypto"),
    "drizzle-orm": { and: (...values: unknown[]) => values, eq: (...values: unknown[]) => values },
    "../db": { db: database },
    "@shared/schema": tables,
    "@shared/reverseOsmosis": envelope,
    "@shared/ownerAiActions": { ownerAiActionPacketSchema: { parse(packet: any) { envelope.reverseOsmosisEnvelopeSchema.parse(packet.reverseOsmosis); return packet; } } },
    "./ownerAiActions": { OwnerAiActionError: OwnerError, computeOwnerAiExpectedVersions: async (id: string) => { assert.equal(id, scope.businessId); return { syntheticVersion: 1 }; } },
    "./ownerAiSourceFacts": { loadSourceFactAuthority: async () => ({ blockedFields: state.blocked ? ["menuUrl"] : [] }) },
    "./reverseOsmosisCaptureGuard": guards,
    "./reverseOsmosisBusinessAssets": { captureMealScoutBusinessPost, connectionBindingRevision, verifyMealScoutBusinessAsset },
    "@tradescout-infinity/reverse-osmosis": { createReverseOsmosisEngine(port: any) { return { async propose(input: any) {
      const proof = await port.verifyBusinessAsset(input);
      return { ...input, businessBindingRevision: proof.bindingRevision, payloadDigest: "a".repeat(64), operationKey: "b".repeat(64) };
    } }; } },
  };
  const exports: Record<string, any> = {};
  vm.runInNewContext(compiled.outputText, { exports, require(name: string) {
    assert.ok(Object.hasOwn(imports, name), "Unexpected dependency; no production import allowed: " + name);
    return imports[name];
  }, Date, Buffer, console }, { filename: "actual-reverseOsmosis-synthetic-fixture.cjs" });
  return exports.prepareMealScoutReverseOsmosisSourceDraftInput as (input: any, options?: guards.SourceCaptureOptions) => Promise<any>;
}
const state = () => ({ ownerId: scope.ownerId, disabled: false, blocked: false, connection: connection(), reflection: false, ownerReads: 0, reflectionReads: 0, queryStarts: 0, pending: undefined as Promise<any> | undefined });
const request = () => ({ restaurantId: scope.businessId, userId: scope.ownerId, postId: "444444", publishPlatforms: ["facebook"] });
test("actual preparation rechecks current authority and uses its immutable request snapshot", async () => {
  const current = state(), input = request();
  await mocked(async calls => {
    const result = await prepared(current)(input);
    assert.equal(result.packet.reverseOsmosis.inbound.scope.ownerId, scope.ownerId);
    assert.deepEqual(Array.from(result.packet.social.platforms), ["facebook"]);
    assert.equal(current.ownerReads, 2); assert.equal(current.reflectionReads, 2);
    assert.equal(calls.length, 6);
  }, (url, _init, calls) => {
    if (calls.length === 3) { input.userId = "changed-caller-object"; input.restaurantId = "changed-object"; input.publishPlatforms[0] = "x"; }
    return response(url);
  });
});
const changes: Array<[string, (current: ReturnType<typeof state>) => void]> = [
  ["transferred owner", current => { current.ownerId = "other-current-owner"; }],
  ["disabled owner", current => { current.disabled = true; }],
  ["private menu", current => { current.blocked = true; }],
  ["revoked connector owner", current => { current.connection.createdByUserId = "other-owner"; }],
  ["rotated connector binding", current => { current.connection.accessToken = "ROTATED_SYNTHETIC_ONLY"; }],
  ["new reflected publication", current => { current.reflection = true; }],
];
for (const [label, change] of changes) test("actual preparation holds a " + label + " changed during provider waits", async () => {
  const current = state();
  await mocked(async () => {
    await assert.rejects(prepared(current)(request()), (error: any) => error.code === "REVERSE_OSMOSIS_HOLD");
  }, (url, _init, calls) => { if (calls.length === 3) change(current); return response(url); });
});
test("preparation cancellation during a readonly DB wait starts no later query or provider work", async () => {
  const current = state(), caller = new AbortController();
  let release!: (rows: any[]) => void;
  current.pending = new Promise(resolve => { release = resolve; });
  await mocked(async calls => {
    const work = prepared(current)(request(), { signal: caller.signal });
    await turn(); caller.abort("SYNTHETIC_PRIVATE_REASON");
    await rejected(work, "capture-cancelled");
    release([{ id: scope.businessId, ownerId: scope.ownerId }]); await turn();
    assert.equal(current.queryStarts, 1); assert.equal(calls.length, 0);
  });
});
test("the preparation signal also cancels final proposal verification after source capture", async () => {
  const current = state(), caller = new AbortController();
  let reached!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  await mocked(async calls => {
    const work = prepared(current)(request(), { signal: caller.signal });
    await started; caller.abort("SYNTHETIC_PRIVATE_REASON");
    await rejected(work, "capture-cancelled");
    assert.equal(calls.length, 5); assert.equal(current.ownerReads, 1);
  }, (url, _init, calls) => {
    if (calls.length === 5) { reached(); return new Promise(() => {}); }
    return response(url);
  });
});

// Actual handler lifecycle under EventEmitter req/res and native auth/draft stand-ins.
const routeSource = readFileSync(path.join(repository, "server/routes/reverseOsmosisRoutes.ts"), "utf8");
const routeCompiled = ts.transpileModule(routeSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
assert.equal(routeCompiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
function handlerFixture(options: { pending?: boolean; ownerPending?: Promise<void> } = {}) {
  let selected: any, reached!: () => void, draftWrites = 0, captureStarts = 0, captureSignal: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const imports: Record<string, any> = {
    zod: nativeRequire("zod"),
    "@tradescout-infinity/reverse-osmosis": nativeRequire("@tradescout-infinity/reverse-osmosis"),
    "../unifiedAuth": { isAuthenticated() {} },
    "../middleware/distributedRateLimit": { distributedRateLimit: () => () => {} },
    "../services/reverseOsmosisCaptureGuard": guards,
    "../services/ownerAiActions": {
      assertActualRestaurantOwner: async () => { await options.ownerPending; },
      createOwnerAiDraft: async () => { draftWrites++; return { id: "synthetic-private-draft" }; },
    },
    "../services/reverseOsmosis": {
      prepareMealScoutReverseOsmosisSourceDraftInput: async (_input: any, controls: guards.SourceCaptureOptions) => {
        captureStarts++; captureSignal = controls.signal; reached();
        if (options.pending) await new Promise((_resolve, reject) => controls.signal!.addEventListener("abort", () => reject(new Error("SYNTHETIC_CANCELLED")), { once: true }));
        return { packet: { syntheticOnly: true }, expectedVersions: {}, holds: [] };
      },
      readMealScoutReverseOsmosisOutcome() { throw new Error("Unrelated handler must not run"); },
    },
  };
  const exports: Record<string, any> = {};
  vm.runInNewContext(routeCompiled.outputText, { exports, require(name: string) { assert.ok(Object.hasOwn(imports, name), "No production route dependency: " + name); return imports[name]; }, URL, AbortController }, { filename: "actual-reverseOsmosisRoutes-synthetic-fixture.cjs" });
  exports.registerReverseOsmosisRoutes({ post(name: string, ...callbacks: any[]) { if (name.endsWith("/source-draft")) selected = callbacks.at(-1); }, get() {}, use() {} });
  const req: any = Object.assign(new EventEmitter(), { params: { restaurantId: "00000000-0000-4000-8000-000000000201" }, user: { id: scope.ownerId }, body: { postId: "444444" }, aborted: false });
  const res: any = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, statusCode: 200, setHeader() {}, status(value: number) { this.statusCode = value; return this; }, json(value: any) { this.body = value; this.writableEnded = true; return this; } });
  const run = () => selected(req, res, (error: unknown) => { throw error; });
  return { req, res, run, started, counts: () => ({ draftWrites, captureStarts, captureSignal }) };
}
for (const event of ["request-abort", "response-close"]) test("actual source handler cancels " + event + " before private draft creation and removes listeners", async () => {
  const fixture = handlerFixture({ pending: true });
  const work = fixture.run(); await fixture.started;
  if (event === "request-abort") { fixture.req.aborted = true; fixture.req.emit("aborted"); }
  else { fixture.res.destroyed = true; fixture.res.emit("close"); }
  await work;
  assert.equal(fixture.counts().captureSignal?.aborted, true);
  assert.equal(fixture.counts().draftWrites, 0);
  assert.equal(fixture.req.listenerCount("aborted"), 0); assert.equal(fixture.res.listenerCount("close"), 0);
});
test("actual handler abort during its owner check never starts source capture", async () => {
  let release!: () => void;
  const fixture = handlerFixture({ ownerPending: new Promise(resolve => { release = resolve; }) });
  const work = fixture.run(); await turn();
  fixture.req.aborted = true; fixture.req.emit("aborted"); release(); await work;
  assert.equal(fixture.counts().captureStarts, 0); assert.equal(fixture.counts().draftWrites, 0);
  assert.equal(fixture.req.listenerCount("aborted"), 0); assert.equal(fixture.res.listenerCount("close"), 0);
});
test("actual handler normal completion preserves private draft response and releases cancellation listeners", async () => {
  const fixture = handlerFixture(); await fixture.run();
  assert.equal(fixture.res.statusCode, 201); assert.equal(fixture.res.body.mutationPerformed, false);
  assert.equal(fixture.counts().draftWrites, 1);
  assert.equal(fixture.req.listenerCount("aborted"), 0); assert.equal(fixture.res.listenerCount("close"), 0);
  fixture.res.emit("close");
  assert.equal(fixture.counts().captureSignal?.aborted, false);
});
