import assert from "node:assert/strict";
import { test, after } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { withSourceCaptureBudget } from "../server/services/reverseOsmosisCaptureGuard";

// Execute the actual exported writer plus its private implementation only.
// DB/schema/media/native-RO standins never import server/db or perform effects.
// This proves cooperative control and transaction-callback ordering, not SQL.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const full = readFileSync(path.join(root, "server/services/ownerAiActions.ts"), "utf8");
const start = full.indexOf("export async function createOwnerAiDraft(");
const end = full.indexOf("\nexport const ownerAiApprovalUrl", start);
assert.ok(start > 0 && end > start);
const compiled = ts.transpileModule(full.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
let fetchCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { fetchCalls++; throw new Error("External fetch forbidden in writer fixture"); };
after(() => { globalThis.fetch = originalFetch; assert.equal(fetchCalls, 0); });
const ownerId = "synthetic-owner";
const restaurantId = "00000000-0000-4000-8000-000000000201";
function fixture(pendingAt?: string) {
  const calls: string[] = [], signals: Array<AbortSignal | undefined> = [];
  let reached!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const state = { insertStarts: 0, commits: 0, rollbacks: 0, responseBuilds: 0, currentOwner: ownerId, replay: undefined as any };
  async function phase(name: string) { calls.push(name); if (name === pendingAt) { reached(); await pending; } }
  const tables = { restaurants: { id: "restaurant-id" }, ownerAiActionDrafts: { id: "draft-id" } };
  const select = () => {
    let table: unknown, locked = false;
    const query: any = {
      from(value: unknown) { table = value; return query; },
      where() { return query; }, limit() { return query; },
      for() { locked = true; return query; },
      async then(resolve: any, reject: any) {
        return (async () => {
          await phase(locked ? "lock" : table === tables.restaurants ? "owner" : "replay");
          return table === tables.restaurants ? [{ id: restaurantId, ownerId: state.currentOwner, name: "Synthetic" }] : state.replay ? [state.replay] : [];
        })().then(resolve, reject);
      }
    };
    return query;
  };
  const db: any = {
    select,
    async transaction(work: (tx: any) => Promise<any>, options?: unknown) {
      let staged: any;
      const tx = { select, insert() { return { values(value: any) { staged = value; return { onConflictDoNothing() { return { async returning() { state.insertStarts++; await phase("insert"); return [value]; } }; } }; } }; } };
      try { const result = await work(tx); if (!options && staged) state.commits++; return result; }
      catch (error) { if (!options) state.rollbacks++; throw error; }
    }
  };
  class OwnerAiActionError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const exports: any = {};
  vm.runInNewContext(compiled.outputText, {
    exports, withSourceCaptureBudget, db, ...tables, OwnerAiActionError,
    ownerAiDraftRequestSchema: { parse: (value: any) => structuredClone(value) },
    ownerAiActionPacketSchema: { parse: (value: any) => value },
    stableHash: hash, randomUUID: () => "synthetic-private-draft", and: (...v: any[]) => v, eq: (...v: any[]) => v,
    assertOwnerAiSettingsAccess: async () => phase("settings"),
    validateSourceFacts: async () => phase("source-facts"),
    assertRequestVersions: async () => { await phase("read-versions"); return { synthetic: 1 }; },
    buildOwnerAiCurrentSnapshot: async () => { await phase("snapshot"); return { nativeAdapter: "synthetic" }; },
    normalizeOwnerAiPlan: () => [], buildOwnerAiSocialDrafts: () => [],
    buildOwnerAiMediaManifest: async () => { await phase("media"); return {}; },
    finalizeMealScoutReverseOsmosisDraftPacket: async (...args: any[]) => { signals.push(args[7]); await phase("finalize"); },
    validateMealScoutReverseOsmosisPacket: async (...args: any[]) => {
      signals.push(args[6]); await phase("validate");
      if (state.currentOwner !== ownerId) throw new OwnerAiActionError(409, "CURRENT_OWNER_REQUIRED", "Synthetic owner changed");
      if (args[6]?.aborted) throw new Error("Native validation must not proceed after stop");
    },
    computeOwnerAiExpectedVersions: async () => { await phase("write-versions"); return { synthetic: 1 }; },
    versionsEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
    toOwnerAiDraftResponse: (value: any) => { state.responseBuilds++; return value; },
    DRAFT_TTL_MS: 1000, Date
  }, { filename: "actual-private-writer-synthetic-fixture.cjs" });
  const input = { restaurantId, createdByUserId: ownerId, request: { packet: { profile: { menuUrl: "https://menu.example/" }, reverseOsmosis: { syntheticOnly: true } } } };
  return { run: (controls?: any, value = input) => exports.createOwnerAiDraft(value, controls), input, state, calls, signals, started, release };
}
const cancelled = (work: Promise<any>) => assert.rejects(work, (error: any) => error.code === "reverse-osmosis:capture-cancelled");
test("pre-aborted bounded writer starts no schema, query or native work", async () => {
  const f = fixture(), caller = new AbortController(); caller.abort("DO_NOT_ECHO_SYNTHETIC_REASON");
  await cancelled(f.run({ signal: caller.signal }));
  assert.equal(f.calls.length, 0); assert.equal(f.state.insertStarts, 0);
});
for (const phase of ["owner", "media", "finalize", "lock", "validate", "write-versions"]) test("actual writer cancellation during " + phase + " prevents private insert", async () => {
  const f = fixture(phase), caller = new AbortController();
  const work = f.run({ signal: caller.signal }); await f.started;
  caller.abort("DO_NOT_ECHO_SYNTHETIC_REASON"); await cancelled(work);
  f.release(); await turn(); await turn();
  assert.equal(f.state.insertStarts, 0); assert.equal(f.state.commits, 0);
  assert.equal(f.state.responseBuilds, 0);
  assert.equal(f.calls.at(-1), phase);
  assert.ok(f.signals.every(signal => signal?.aborted));
});
test("bounded writer deadline prevents later validation and insert", async () => {
  const f = fixture("media");
  const work = f.run({ budgetMs: 15 }); await f.started;
  await assert.rejects(work, (error: any) => error.code === "reverse-osmosis:capture-deadline");
  f.release(); await turn();
  assert.equal(f.state.insertStarts, 0); assert.equal(f.calls.includes("finalize"), false);
});
test("normal bounded writer forwards one live guard into finalization and locked validation", async () => {
  const f = fixture(); const result = await f.run({ budgetMs: 500 });
  assert.equal(result.id, "synthetic-private-draft");
  assert.equal(f.state.insertStarts, 1); assert.equal(f.state.commits, 1);
  assert.equal(f.signals.length, 2); assert.equal(f.signals[0], f.signals[1]);
  assert.equal(f.signals[0]?.aborted, true); // scope cleanup, after completion
});
test("unchanged callers without controls preserve existing writer contract", async () => {
  const f = fixture(); await f.run();
  assert.equal(f.state.commits, 1); assert.ok(f.signals.every(value => value === undefined));
});
test("owner transfer during finalization prevents native locked validation from inserting", async () => {
  const f = fixture("finalize"); const work = f.run({ budgetMs: 500 });
  await f.started; f.state.currentOwner = "other-owner"; f.release();
  await assert.rejects(work, (error: any) => error.code === "CURRENT_OWNER_REQUIRED");
  assert.equal(f.state.insertStarts, 0); assert.equal(f.state.commits, 0);
});
test("cancelled replay verification returns no saved draft and starts no private insert", async () => {
  const f = fixture("validate"), caller = new AbortController();
  f.state.replay = { id: "existing-private-draft", restaurantId, packet: f.input.request.packet, expectedVersions: {}, requestHash: createHash("sha256").update(JSON.stringify(f.input.request)).digest("hex") };
  const work = f.run({ signal: caller.signal }, { ...f.input, connectorApiKeyId: "synthetic-key", idempotencyKey: "synthetic-replay" } as any);
  await f.started; caller.abort(); await cancelled(work); f.release(); await turn();
  assert.equal(f.state.responseBuilds, 0); assert.equal(f.state.insertStarts, 0);
});
test("abort while an issued insert waits throws inside transaction callback before commit", async () => {
  const f = fixture("insert"), caller = new AbortController();
  const work = f.run({ signal: caller.signal }); await f.started;
  assert.equal(f.state.insertStarts, 1);
  caller.abort(); await cancelled(work); f.release(); await turn(); await turn();
  assert.equal(f.state.commits, 0); assert.equal(f.state.rollbacks, 1);
  // The deterministic transaction adapter models rollback ordering; this is
  // neither native SQL cancellation nor proof that a committed write can undo.
});

test("writer snapshots caller identity before waits and cannot be rerouted by input mutation", async () => {
  const f = fixture("media"), work = f.run({ budgetMs: 500 }); await f.started;
  f.input.restaurantId = "00000000-0000-4000-8000-000000000299";
  f.input.createdByUserId = "other-owner"; f.release();
  const result = await work;
  assert.equal(result.restaurantId, restaurantId); assert.equal(result.createdByUserId, ownerId);
  assert.equal(f.state.commits, 1);
});
