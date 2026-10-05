import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createHash } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { createMealScoutOnboardingWorker, ONBOARDING_SOURCE_PROVIDER_EXECUTION_ENABLED, type OnboardingSourceAdapter } from "../server/services/onboardingSourceWorker";
import { createOnboardingJobService, validateOnboardingResearchReceipt, type OnboardingDatabase } from "../server/services/onboardingJobs";
import { MEALSCOUT_RO_CORE_PIN } from "../shared/reverseOsmosis";
import { onboardingResearchInputSchema } from "../shared/onboardingJobs";

// Actual worker, job service, SQL construction and schemas; deterministic SQL
// transaction adapter only. Shared state survives new worker/service instances.
// No PostgreSQL/PGlite/disk/server/core/provider runtime acceptance is claimed.
const dialect = new PgDialect();
const scope = { ownerId: "synthetic-owner", restaurantId: "00000000-0000-4000-8000-000000000201" };
const url = "https://www.facebook.com/111111/posts/444444";
const input = () => ({ businessName: "Synthetic", location: "Synthetic city", officialLinks: [url] });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
let fetchCalls = 0; const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { fetchCalls++; throw new Error("External fetch forbidden in worker fixture"); };
after(() => { globalThis.fetch = originalFetch; assert.equal(fetchCalls, 0); });
function store() {
  const state = {
    rows: new Map<string, any>(), owners: new Map([[scope.restaurantId, scope.ownerId]]), disabled: new Set<string>(),
    at: Date.parse("2026-10-05T12:00:00Z"), transactions: 0, rollbacks: 0, queries: [] as string[],
    before: undefined as ((phase: string) => Promise<void> | void) | undefined, tail: Promise.resolve()
  };
  const clock = () => new Date(state.at);
  function database(): OnboardingDatabase {
    return { async transaction(work) {
      state.transactions++;
      const previous = state.tail; let unlock!: () => void;
      const lock = new Promise<void>(resolve => { unlock = resolve; }); state.tail = previous.then(() => lock);
      await previous;
      const rows = structuredClone(state.rows);
      try {
        const result = await work({ async execute(query) {
          const q = dialect.sqlToQuery(query), text = q.sql.replace(/\s+/g, " ").trim(), p = q.params;
          let phase = "unexpected";
          if (text.startsWith("SELECT r.id FROM restaurants")) phase = "owner";
          else if (text.startsWith("SELECT j.id")) phase = "discovery";
          else if (text.startsWith("SELECT *")) phase = "job-read";
          else if (text.startsWith("INSERT INTO")) phase = "enqueue";
          else if (text.startsWith("SELECT octet_length")) phase = "storage-size";
          else if (text.includes("SET status = 'running'")) phase = "claim-update";
          else if (text.includes("SET status = 'completed'")) phase = "complete-update";
          else if (text.includes("SET status = 'failed'")) phase = "exhausted-update";
          else if (text.includes("SET status = $")) phase = "retry-update";
          state.queries.push(phase); await state.before?.(phase);
          if (phase === "owner") return { rows: state.owners.get(p[0] as string) === p[1] && !state.disabled.has(p[1] as string) ? [{ id: p[0] }] : [] };
          if (phase === "discovery") {
            assert.match(text, /LIMIT 10$/);
            return { rows: [...rows.values()].filter(r => state.owners.get(r.restaurant_id) === r.owner_id && !state.disabled.has(r.owner_id) &&
              ((["queued", "retry_wait"].includes(r.status) && Date.parse(r.available_at) <= Date.parse(p[0] as string)) ||
               (r.status === "running" && Date.parse(r.lease_expires_at) <= Date.parse(p[0] as string))))
              .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).slice(0, 10)
              .map(r => ({ id: r.id, owner_id: r.owner_id, restaurant_id: r.restaurant_id })) };
          }
          if (phase === "job-read") {
            const r = text.includes("WHERE id =") ? rows.get(p[0] as string) : [...rows.values()].find(r => r.owner_id === p[0] && r.restaurant_id === p[1]);
            const valid = text.includes("WHERE id =") ? r?.owner_id === p[1] && r?.restaurant_id === p[2] : Boolean(r);
            return { rows: r && valid ? [r] : [] };
          }
          if (phase === "enqueue") {
            const r = { id: p[0], owner_id: p[1], restaurant_id: p[2], idempotency_key: p[3], request_hash: p[4], input: JSON.parse(p[5] as string),
              max_attempts: p[6], available_at: p[7], created_at: p[8], updated_at: p[9], status: "queued", attempts: 0, revision: 1,
              lease_token: null, lease_expires_at: null, research_receipt: null, preview_draft_id: null, preview_draft_revision: null, last_error_code: null, completed_at: null };
            rows.set(r.id as string, r); return { rows: [r] };
          }
          if (phase === "storage-size") return { rows: [{ bytes: Buffer.byteLength(p[0] as string, "utf8") + 100 }] }; // bounded fixture approximation, not native JSONB proof
          const r = rows.get(p.at(-1) as string); assert.ok(r, "Synthetic row exists");
          if (phase === "claim-update") Object.assign(r, { status: "running", attempts: r.attempts + 1, lease_token: p[0], lease_expires_at: p[1], last_error_code: p[2], updated_at: p[3], revision: r.revision + 1 });
          else if (phase === "complete-update") Object.assign(r, { status: "completed", research_receipt: JSON.parse(p[0] as string), lease_token: null, lease_expires_at: null, last_error_code: null, completed_at: p[1], updated_at: p[2], revision: r.revision + 1 });
          else if (phase === "retry-update") Object.assign(r, { status: p[0], lease_token: null, lease_expires_at: null, last_error_code: "RESEARCH_UNAVAILABLE", available_at: p[1], updated_at: p[2], revision: r.revision + 1 });
          else if (phase === "exhausted-update") Object.assign(r, { status: "failed", lease_token: null, lease_expires_at: null, last_error_code: "RESEARCH_ATTEMPTS_EXHAUSTED", updated_at: p[0], revision: r.revision + 1 });
          else throw new Error("Unexpected SQL; no native fallback permitted");
          return { rows: [r] };
        } });
        state.rows = rows; return result;
      } catch (error) { state.rollbacks++; throw error; } finally { unlock(); }
    } };
  }
  return { state, clock, database };
}
function prepared(at: number, value = "a", validScope = scope) {
  const expectedVersions = { profile: "synthetic-version" };
  const capture = {
    sourceUrl: url, capturedAt: at, expiresAt: at + 24 * 60 * 60_000, bodyHash: value.repeat(64), publicProofHash: "b".repeat(64),
    sourceVersion: hash({ bodyHash: value.repeat(64), publicProofHash: "b".repeat(64) }), providerPostId: "111111_444444",
    providerCreatedAt: "2026-10-05T11:00:00Z", providerUpdatedAt: "2026-10-05T11:00:00Z", profile: { menuUrl: "https://menu.example/" }, holds: []
  };
  const inbound = { scope: { product: "mealscout", tenantId: "mealscout", ownerId: validScope.ownerId, businessId: validScope.restaurantId, subjectId: validScope.restaurantId, provider: "facebook", accountId: "111111" },
    direction: "social-to-native", eventId: capture.providerPostId, sourceVersion: capture.sourceVersion, expectedNativeVersion: hash(expectedVersions),
    fields: { profile: capture.profile, capture }, businessBindingRevision: "c".repeat(64), payloadDigest: "d".repeat(64), operationKey: "e".repeat(64) };
  return { packet: { profile: capture.profile, reverseOsmosis: { schemaVersion: "mealscout.reverse-osmosis.v1", core: MEALSCOUT_RO_CORE_PIN, capture, inbound, outbound: [] } }, expectedVersions, holds: [] };
}
async function queued(links = [url]) {
  const f = store(), db = f.database(), service = createOnboardingJobService(db, f.clock);
  const result = await service.enqueue(scope, "synthetic-worker-idempotency", { ...input(), officialLinks: links });
  return { ...f, db, service, id: result.job.id, row: () => f.state.rows.get(result.job.id)! };
}
function adapter(f: Awaited<ReturnType<typeof queued>>, run?: OnboardingSourceAdapter["prepare"]) {
  const calls: Array<{ input: any; options: any }> = [];
  const source: OnboardingSourceAdapter = { kind: "deterministic", async prepare(input, options) { calls.push({ input, options }); return run ? run(input, options) : prepared(f.state.at, "a", { ownerId: input.userId, restaurantId: input.restaurantId }); } };
  return { calls, source, worker: () => createMealScoutOnboardingWorker(f.database(), { source, clock: f.clock }) };
}
function gate(f: Awaited<ReturnType<typeof queued>>, phase: string) {
  let reached!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
  f.state.before = async name => { if (name === phase) { f.state.before = undefined; reached(); await pending; } };
  return { started, release };
}
test("default and native-adapter worker stay disabled before any database or provider work", async () => {
  let transactions = 0, captures = 0;
  const db: OnboardingDatabase = { async transaction() { transactions++; throw new Error("No DB permitted"); } };
  const native: OnboardingSourceAdapter = { kind: "native", async prepare() { captures++; throw new Error("No provider permitted"); } };
  for (const worker of [createMealScoutOnboardingWorker(db), createMealScoutOnboardingWorker(db, { source: native })]) {
    assert.equal((await worker.runNext()).status, "disabled");
    assert.equal((await worker.runOne(scope, "ignored")).status, "disabled");
  }
  assert.equal(ONBOARDING_SOURCE_PROVIDER_EXECUTION_ENABLED, false); assert.equal(transactions, 0); assert.equal(captures, 0);
});
test("actual worker claims once, persists bound source and reuses immutable completion without recapture", async () => {
  const f = await queued(), a = adapter(f), worker = a.worker();
  const result = await worker.runOne(scope, f.id);
  assert.equal(result.status, "completed"); assert.equal(a.calls.length, 1);
  assert.equal(f.row().attempts, 1); assert.equal(f.row().lease_token, null);
  assert.equal(result.job?.researchReceipt?.sourceBinding?.ownerId, scope.ownerId);
  assert.equal(result.job?.researchReceipt?.sourceBinding?.postId, "111111_444444");
  assert.equal(result.job?.researchReceipt?.currentScore, null); assert.equal(result.job?.researchReceipt?.conditionalProjectedScore, null);
  assert.equal(Object.hasOwn(result, "leaseToken"), false);
  assert.deepEqual(a.calls[0].input.publishPlatforms, []);
  assert.equal(Object.isFrozen(a.calls[0].input), true); assert.equal(Object.isFrozen(a.calls[0].input.publishPlatforms), true);
  assert.equal(a.calls[0].options.signal.aborted, true);
  const saved = structuredClone(f.row().research_receipt);
  assert.equal((await worker.runOne(scope, f.id)).status, "reused"); assert.equal(a.calls.length, 1);
  assert.deepEqual(f.row().research_receipt, saved);
});
test("new worker/service instances recover shared adapter state and process only one persisted job", async () => {
  const f = await queued(), a = adapter(f);
  const other = { ...scope, restaurantId: "00000000-0000-4000-8000-000000000202" };
  f.state.owners.set(other.restaurantId, scope.ownerId);
  await createOnboardingJobService(f.database(), f.clock).enqueue(other, "synthetic-worker-second", input());
  assert.equal((await a.worker().runNext()).status, "completed");
  assert.equal(a.calls.length, 1);
  assert.equal([...f.state.rows.values()].filter(r => r.status === "queued").length, 1);
  assert.equal([...f.state.rows.values()].filter(r => r.status === "completed").length, 1);
});
for (const [label, links] of [["missing", []], ["unsupported", ["https://official.example/"]], ["ambiguous", [url, "https://www.facebook.com/111111/posts/555555"]]] as const) test(label + " declared source completes a held receipt without capture or guessed Page binding", async () => {
  const f = await queued([...links]), a = adapter(f), result = await a.worker().runOne(scope, f.id);
  assert.equal(result.status, "completed"); assert.equal(a.calls.length, 0);
  assert.equal(result.job?.researchReceipt?.sourceBinding, undefined);
  assert.equal(result.job?.researchReceipt?.sources.length, 0); assert.equal(result.job?.researchReceipt?.observations.length, 0);
  assert.match(result.job!.researchReceipt!.unknowns[0], /unresolved/);
});
for (const [label, change] of [
  ["owner", (p: any) => { p.packet.reverseOsmosis.inbound.scope.ownerId = "other-owner"; }],
  ["post", (p: any) => { p.packet.reverseOsmosis.capture.providerPostId = "111111_555555"; }],
  ["native version", (p: any) => { p.packet.reverseOsmosis.inbound.expectedNativeVersion = "f".repeat(64); }],
  ["expired capture", (p: any) => { p.packet.reverseOsmosis.capture.expiresAt = p.packet.reverseOsmosis.capture.capturedAt; }],
] as Array<[string, (p: any) => void]>) test("wrong " + label + " cannot complete a bound source receipt", async () => {
  const f = await queued(), a = adapter(f, async () => { const p = prepared(f.state.at); change(p); return p; });
  assert.equal((await a.worker().runOne(scope, f.id)).status, "retry_wait");
  assert.equal(f.row().research_receipt, null);
});
for (const kind of ["transfer", "disable"] as const) test("current owner " + kind + " during source wait holds completion and restart discovery", async () => {
  const f = await queued(), a = adapter(f, async () => {
    if (kind === "transfer") f.state.owners.set(scope.restaurantId, "other-owner"); else f.state.disabled.add(scope.ownerId);
    return prepared(f.state.at);
  });
  assert.equal((await a.worker().runOne(scope, f.id)).status, "owner_changed");
  assert.equal(f.row().research_receipt, null);
  assert.equal((await a.worker().runNext()).status, "idle"); assert.equal(a.calls.length, 1);
});
test("cancellation during source wait retires the current lease and late source resolution cannot complete", async () => {
  const f = await queued(), caller = new AbortController(); let reached!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
  const a = adapter(f, async () => { reached(); await pending; return prepared(f.state.at); });
  const work = a.worker().runOne(scope, f.id, caller.signal); await started; caller.abort("DO_NOT_ECHO_SYNTHETIC_REASON");
  const result = await work;
  assert.equal(result.status, "cancelled"); assert.equal(a.calls[0].options.signal.aborted, true);
  assert.equal(f.row().status, "retry_wait"); assert.equal(f.row().lease_token, null);
  release(); await turn(); await turn(); assert.equal(f.row().research_receipt, null);
  assert.equal(JSON.stringify(result).includes("DO_NOT_ECHO"), false);
});
for (const phase of ["claim-update", "storage-size", "complete-update"]) test("cancelled " + phase + " callback rolls back its mutation before terminal commit", async () => {
  const f = await queued(), a = adapter(f), caller = new AbortController(), g = gate(f, phase);
  const work = a.worker().runOne(scope, f.id, caller.signal); await g.started;
  caller.abort(); g.release(); const result = await work;
  await turn(); await turn(); // the raced SQL callback settles and records rollback
  assert.equal(result.status, "cancelled"); assert.equal(f.row().research_receipt, null);
  assert.ok(f.state.rollbacks >= 1);
  if (phase === "claim-update") { assert.equal(f.row().status, "queued"); assert.equal(f.row().attempts, 0); assert.equal(a.calls.length, 0); }
  else assert.equal(f.row().status, "retry_wait");
});
test("remaining lease determines a lowered capture budget with ten-second terminal reserve", async () => {
  const f = await queued(), a = adapter(f);
  f.state.before = phase => { if (phase === "claim-update") { f.state.at += 11_000; f.state.before = undefined; } };
  assert.equal((await a.worker().runOne(scope, f.id)).status, "completed");
  assert.equal(a.calls[0].options.budgetMs, 9_000);
});
test("lease without source budget retires without starting capture", async () => {
  const f = await queued(), a = adapter(f);
  f.state.before = phase => { if (phase === "claim-update") { f.state.at += 25_000; f.state.before = undefined; } };
  assert.equal((await a.worker().runOne(scope, f.id)).status, "retry_wait");
  assert.equal(a.calls.length, 0); assert.equal(f.row().research_receipt, null);
});
test("expired lease can be reclaimed by a new worker while old source cannot overwrite winner", async () => {
  const f = await queued(); let reached!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
  const oldResult = prepared(f.state.at, "a");
  const first = adapter(f, async () => { reached(); await pending; return oldResult; });
  const oldWork = first.worker().runOne(scope, f.id); await started;
  const oldToken = f.row().lease_token; f.state.at = Date.parse(f.row().lease_expires_at) + 1;
  const next = adapter(f, async () => prepared(f.state.at, "f"));
  assert.equal((await next.worker().runNext()).status, "completed");
  assert.equal(f.row().attempts, 2); const winner = structuredClone(f.row().research_receipt);
  release(); assert.equal((await oldWork).status, "lease_lost");
  assert.deepEqual(f.row().research_receipt, winner); assert.equal(f.row().lease_token, null); assert.ok(oldToken);
});
test("retry exhaustion is persisted and source errors never echo raw details", async () => {
  const f = await queued(), a = adapter(f, async () => { throw new Error("DO_NOT_ECHO_SYNTHETIC_PROVIDER_BODY"); });
  for (let i = 1; i <= 3; i++) {
    const result = await a.worker().runOne(scope, f.id);
    assert.equal(result.status, i === 3 ? "failed" : "retry_wait");
    assert.equal(JSON.stringify(result).includes("DO_NOT_ECHO"), false);
    f.state.at = Date.parse(f.row().available_at);
  }
  assert.equal((await a.worker().runNext()).status, "idle"); assert.equal(a.calls.length, 3);
});
test("total source deadline aborts adapter and late result cannot complete research", async () => {
  const f = await queued(); let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.state.before = phase => { if (phase === "claim-update") { f.state.at += 19_997; f.state.before = undefined; } };
  const a = adapter(f, async () => { await pending; return prepared(f.state.at); });
  assert.equal((await a.worker().runOne(scope, f.id)).status, "retry_wait");
  assert.equal(a.calls[0].options.budgetMs, 3); assert.equal(a.calls[0].options.signal.aborted, true);
  release(); await turn(); assert.equal(f.row().research_receipt, null);
});
test("caller scope mutation during source wait cannot reroute a terminal write", async () => {
  const f = await queued(), callerScope = { ...scope };
  const a = adapter(f, async () => { callerScope.ownerId = "other-owner"; callerScope.restaurantId = "00000000-0000-4000-8000-000000000299"; return prepared(f.state.at); });
  assert.equal((await a.worker().runOne(callerScope, f.id)).status, "completed");
  assert.equal(f.row().research_receipt.sourceBinding.ownerId, scope.ownerId);
  assert.equal(f.row().research_receipt.sourceBinding.restaurantId, scope.restaurantId);
});
test("cancelled restart discovery never starts a claim or capture", async () => {
  const f = await queued(), a = adapter(f), caller = new AbortController(), g = gate(f, "discovery");
  const work = a.worker().runNext(caller.signal); await g.started; caller.abort();
  assert.equal((await work).status, "cancelled"); g.release(); await turn();
  assert.equal(f.state.queries.includes("claim-update"), false); assert.equal(a.calls.length, 0);
});
test("receipt validator rejects changed Page/scope/version identity and preserves legacy receipt compatibility", async () => {
  const f = await queued(), a = adapter(f), result = await a.worker().runOne(scope, f.id);
  const receipt = result.job!.researchReceipt!, savedInput = onboardingResearchInputSchema.parse(input());
  for (const patch of [{ ownerId: "other-owner" }, { restaurantId: "00000000-0000-4000-8000-000000000299" }, { accountId: "999999" }, { sourceVersion: "e".repeat(64) }]) {
    assert.throws(() => validateOnboardingResearchReceipt({ ...receipt, sourceBinding: { ...receipt.sourceBinding, ...patch } }, savedInput, receipt.requestHash, scope));
  }
  const { sourceBinding, ...legacy } = receipt;
  assert.equal(validateOnboardingResearchReceipt(legacy, savedInput, receipt.requestHash).currentScore, null);
});

test("bounded claim deadline rolls back late mutation without starting source", async context => {
  const f = await queued(), a = adapter(f), g = gate(f, "claim-update");
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const work = a.worker().runOne(scope, f.id); await g.started;
    context.mock.timers.tick(20_001);
    assert.equal((await work).status, "unclaimed"); g.release(); await turn();
    assert.equal(f.row().status, "queued"); assert.equal(f.row().attempts, 0); assert.equal(a.calls.length, 0);
  } finally { g.release(); context.mock.timers.reset(); }
});
test("actual completion service rechecks lease after storage wait even without worker controls", async () => {
  const f = await queued(), lease = await f.service.claim(scope, f.id);
  const at = f.clock().toISOString(), requestHash = f.row().request_hash;
  f.state.before = phase => { if (phase === "storage-size") { f.state.at = Date.parse(f.row().lease_expires_at) + 1; f.state.before = undefined; } };
  await assert.rejects(f.service.complete(scope, f.id, lease!.leaseToken, {
    version: 1, requestHash, sources: [{ url, capturedAt: at, contentHash: "a".repeat(64), excerpt: "Synthetic" }], observations: [], unknowns: []
  }), (error: any) => error.code === "ONBOARDING_LEASE_STALE");
  assert.equal(f.row().research_receipt, null); assert.equal(f.row().status, "running");
});
