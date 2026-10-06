import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RequestHandler } from "express";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableColumns } from "drizzle-orm";
import { splitSqlStatements } from "./sqlMigrationStatements";
import { createOnboardingJobService, onboardingRequestHash, type OnboardingDatabase } from "../server/services/onboardingJobs";
import { onboardingResearchInputSchema, onboardingResearchReceiptSchema } from "../shared/onboardingJobs";

// Run only after root reserves the migration and allocates this native-test slot.
// The file argument is explicit; no migration number or external DB is guessed.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacyPhase = path.resolve(repository, "../evidence/mealscout-durable-onboarding-20261005");
const phase = process.argv[4] ? realpathSync(path.resolve(repository, process.argv[4])) : legacyPhase;
assert.equal(path.dirname(phase), path.resolve(repository, "../evidence"), "Output must remain in an owned evidence phase");
if (!process.argv[2]) throw new Error("Explicit reviewed SQL file argument is required");
const migrationFile = realpathSync(path.resolve(repository, process.argv[2]));
const candidateSql = path.join(legacyPhase, "proposed-owner-onboarding-jobs.sql");
assert.ok(migrationFile.startsWith(path.join(repository, "migrations") + path.sep) || migrationFile === candidateSql, "Use the reviewed owned SQL only");
const migrationSql = readFileSync(migrationFile, "utf8");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
assert.match(process.argv[3] || "", /^[a-f0-9]{64}$/, "Reviewed SQL SHA256 argument is required");
assert.equal(sha(migrationSql), process.argv[3], "SQL changed after independent review; stop before creating the native fixture");
const started = Date.now();
const checks: string[] = [];
let peakRss = process.memoryUsage().rss;
const memoryLimit = 768 * 1024 * 1024;
let guardReason: string | null = null;
const stop = (reason: string): never => { guardReason = reason; process.stderr.write(reason + "\n"); process.exit(2); };
const deadline = setTimeout(() => stop("Native synthetic proof exceeded 45-second deadline"), 45_000);
const memoryGuard = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  if (peakRss > memoryLimit) stop("Native synthetic proof exceeded 768-MiB RSS bound");
}, 100);
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "mealscout-onboarding-synthetic-"));
const dataPath = path.join(fixtureRoot, "pg");
// PGlite0.5.8 bootstrap creates two WASM heaps and copies the scratch heap.
// Start them at32MiB rather than128MiB; normal WASM growth stays enabled.
// initdb's supported -c option also avoids probing oversized shared buffers.
const pgliteOptions = { initialMemory: 32 * 1024 * 1024, initDbStartParams: ["-c", "shared_buffers=16MB"] };
const initialization: Array<{ stage: string; atMs: number; rssBytes: number }> = [];
const stage = (name: string) => {
  const rssBytes = process.memoryUsage().rss;
  peakRss = Math.max(peakRss, rssBytes);
  initialization.push({ stage: name, atMs: Date.now() - started, rssBytes });
  writeFileSync(path.join(phase, "native-initialization.json"), JSON.stringify({ ownedFixtureRoot: fixtureRoot, dataPath, pgliteOptions, initialization, rssBudgetBytes: memoryLimit, deadlineSeconds: 45 }) + "\n");
  process.stdout.write("STAGE " + name + " " + rssBytes + "\n");
  if (rssBytes > memoryLimit) stop("Native synthetic proof exceeded 768-MiB RSS bound");
};
const cleanupFixture = () => {
  const fixtureAbsolute = path.resolve(fixtureRoot);
  assert.ok(fixtureAbsolute.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(fixtureAbsolute).startsWith("mealscout-onboarding-synthetic-"), "Cleanup must stay within the exact owned synthetic temp directory");
  rmSync(fixtureAbsolute, { recursive: true, force: true });
};
process.once("exit", () => {
  if (!guardReason) return;
  let cleanupCompleted = false;
  try { if (existsSync(fixtureRoot)) cleanupFixture(); cleanupCompleted = true; } catch {}
  writeFileSync(path.join(phase, "native-guard-stop.json"), JSON.stringify({ result: "BLOCKED_BUDGET_OR_DEADLINE", exitCode: 2, guardReason, cleanupCompleted, ownedFixtureRoot: fixtureRoot }) + "\n");
});
const nativeFetch = globalThis.fetch;
let externalFetchCalls = 0;
globalThis.fetch = async () => { externalFetchCalls++; throw new Error("Synthetic proof forbids external fetch"); };
let engine: PGlite | undefined;
let database: ReturnType<typeof drizzle> | undefined;
let service: ReturnType<typeof createOnboardingJobService> | undefined;
let httpServer: import("node:http").Server | undefined;
let clock = new Date("2026-10-05T01:00:00Z");
const owner = "synthetic-owner-a";
const other = "synthetic-owner-b";
const business = (suffix: string) => "00000000-0000-4000-8000-000000000" + suffix;
const scope = (suffix = "201", ownerId = owner) => ({ ownerId, restaurantId: business(suffix) });
const input = onboardingResearchInputSchema.parse({ businessName: "Synthetic business", location: "Synthetic city", officialLinks: ["https://official.example/"] });
const research = (validScope = scope()) => ({
  version: 1,
  requestHash: onboardingRequestHash(validScope, input),
  sources: [{ url: "https://official.example/", capturedAt: clock.toISOString(), contentHash: "a".repeat(64), excerpt: "Synthetic captured source" }],
  observations: [{ field: "name", value: "Synthetic business", sourceUrl: "https://official.example/" }],
  unknowns: ["Exact service cadence remains unset"],
});
const rejects = (work: () => Promise<unknown>, code: string) => assert.rejects(work, (error: any) => error.code === code);
const pass = (name: string) => { checks.push(name); process.stdout.write("PASS " + name + "\n"); };
async function open() {
  stage("before-pglite-import");
  const { PGlite } = await import("@electric-sql/pglite");
  stage("before-pglite-open");
  engine = new PGlite(dataPath, pgliteOptions);
  await engine.waitReady;
  stage("pglite-ready");
  database = drizzle(engine);
  service = createOnboardingJobService(database as unknown as OnboardingDatabase, () => clock);
}
async function restart() {
  stage("before-disk-close-reopen");
  service = undefined;
  database = undefined;
  await engine!.close();
  engine = undefined;
  (globalThis as { gc?: () => void }).gc?.();
  await open();
}
let succeeded = false;
let failure: string | null = null;
try {
  stage("guard-ready");
  await open();
  // Load the actual full schema only after bootstrap's transient heaps retire.
  const { ownerOnboardingJobs } = await import("../shared/schema/onboardingJobs");
  stage("actual-column-contract-loaded");
  await engine!.exec("CREATE TABLE users(id varchar PRIMARY KEY, is_disabled boolean DEFAULT false); CREATE TABLE restaurants(id varchar PRIMARY KEY, owner_id varchar REFERENCES users(id)); CREATE TABLE owner_ai_action_drafts(id varchar PRIMARY KEY, restaurant_id varchar REFERENCES restaurants(id), created_by_user_id varchar REFERENCES users(id), status varchar, revision integer, expires_at timestamp); CREATE TABLE unrelated_jobs(id integer PRIMARY KEY, payload text); INSERT INTO unrelated_jobs VALUES (1,'preserved');");
  for (let run = 0; run < 2; run++) for (const statement of splitSqlStatements(migrationSql)) await engine!.exec(statement);
  const columns = await engine!.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'owner_onboarding_jobs'");
  assert.deepEqual(columns.rows.map(row => row.column_name).sort(), Object.values(getTableColumns(ownerOnboardingJobs)).map(column => column.name).sort());
  pass("exact proposed/canonical additive DDL reapplies and matches the owned Drizzle column contract");
  await engine!.query("INSERT INTO users(id,is_disabled) VALUES ($1,false),($2,false)", [owner, other]);
  for (const suffix of ["201", "202", "203", "204"]) await engine!.query("INSERT INTO restaurants(id,owner_id) VALUES ($1,$2)", [business(suffix), suffix === "203" ? other : owner]);

  const created = await service!.enqueue(scope(), "synthetic-research-key", input);
  const id = created.job.id;
  assert.equal(created.reused, false);
  assert.equal(created.job.status, "queued");
  const [replay, differentKey] = await Promise.all([
    service!.enqueue(scope(), "synthetic-research-key", input),
    service!.enqueue(scope(), "another-synthetic-key", input),
  ]);
  assert.equal(replay.job.id, id);
  assert.equal(differentKey.job.id, id);
  assert.equal(replay.reused, true);
  assert.equal((await engine!.query("SELECT id FROM owner_onboarding_jobs")).rows.length, 1);
  await rejects(() => service!.enqueue(scope(), "synthetic-research-key", { ...input, location: "Changed city" }), "RESEARCH_INPUT_CONFLICT");
  assert.equal((await engine!.query("SELECT id FROM owner_onboarding_jobs")).rows.length, 1);
  pass("same brief/key and same brief/different key reuse one row; conflicting input creates no work");

  const [claimA, concurrentClaim] = await Promise.all([service!.claim(scope(), id), service!.claim(scope(), id)]);
  assert.ok(claimA);
  assert.equal(concurrentClaim, null);
  const leaseA = claimA.leaseToken;
  assert.equal(claimA.job.attempts, 1);
  assert.equal(JSON.stringify(await service!.read(scope(), id)).includes("lease"), false);
  pass("native transaction serializes claims and keeps worker tokens out of owner responses");

  await restart();
  assert.equal((await service!.read(scope(), id)).status, "running");
  assert.equal(await service!.claim(scope(), id), null);
  clock = new Date(clock.getTime() + 31_000);
  assert.equal((await service!.recoverable()).find(row => row.id === id)?.ownerId, owner);
  const claimB = await service!.claim(scope(), id);
  assert.ok(claimB);
  assert.notEqual(claimB.leaseToken, leaseA);
  assert.equal(claimB.job.attempts, 2);
  await rejects(() => service!.complete(scope(), id, leaseA, research()), "ONBOARDING_LEASE_STALE");
  await rejects(() => service!.retry(scope(), id, leaseA), "ONBOARDING_LEASE_STALE");
  pass("disk-backed running state survives reopen; expired lease recovers and rejects both stale result and stale retry");

  const receipt = research();
  const nearLimit = { ...receipt, observations: Array.from({ length: 24 }, (_, i) => ({ field: "field-" + i, value: "x".repeat(2_048), sourceUrl: "https://official.example/" })) };
  let normalizedSize = Buffer.byteLength(JSON.stringify(onboardingResearchReceiptSchema.parse(nearLimit)), "utf8");
  for (const item of nearLimit.observations) {
    const replacements = Math.min(2_048, Math.max(0, Math.floor((65_480 - normalizedSize) / 2)));
    item.value = "漢".repeat(replacements) + "x".repeat(2_048 - replacements);
    normalizedSize += replacements * 2;
  }
  assert.ok(normalizedSize <= 65_536);
  await rejects(() => service!.complete(scope(), id, claimB.leaseToken, nearLimit), "RESEARCH_RECEIPT_TOO_LARGE");
  assert.equal((await service!.read(scope(), id)).status, "running");
  pass("JSONB separator overhead is bounded before completion without consuming the valid worker lease");
  const completed = await service!.complete(scope(), id, claimB.leaseToken, receipt);
  assert.equal(completed.status, "completed");
  assert.equal(completed.researchReceipt?.currentScore, null);
  const completedRevision = completed.revision;
  assert.equal((await service!.complete(scope(), id, claimB.leaseToken, receipt)).revision, completedRevision);
  await rejects(() => service!.complete(scope(), id, claimB.leaseToken, { ...receipt, unknowns: ["Changed result"] }), "RESEARCH_RESULT_CONFLICT");
  assert.equal(await service!.claim(scope(), id), null);
  assert.equal((await service!.recoverable()).some(row => row.id === id), false);
  pass("completed receipt is immutable and JSONB-normalized completion replay does not increment revision or rerun research");

  await restart();
  assert.equal((await service!.read(scope(), id)).researchReceipt?.observations[0].value, "Synthetic business");
  assert.equal((await service!.enqueue(scope(), "post-restart-key", input)).job.id, id);
  assert.equal((await service!.read(scope(), id)).revision, completedRevision);
  pass("completed research persists across a second reopen and is reused after browser/process closure");

  // Observe actual UPDATE completion, then cancel before the real transaction
  // callback returns. No SQL result, lock, commit or persistence is simulated.
  await engine!.query("INSERT INTO restaurants(id,owner_id) VALUES ($1,$2)", [business("205"), owner]);
  const cancellationScope = scope("205");
  const cancellationJob = (await service!.enqueue(cancellationScope, "synthetic-cancellation-key", input)).job;
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  const cancellation = () => {
    const caller = new AbortController(), reason = new Error("SYNTHETIC_TRANSACTION_CANCELLED");
    let updates = 0;
    const observed: OnboardingDatabase = { transaction: work => (database as unknown as OnboardingDatabase).transaction(tx => work({
      async execute(query) {
        const result = await tx.execute(query);
        if (/^\s*UPDATE\s+owner_onboarding_jobs\b/i.test(dialect.sqlToQuery(query).sql)) { updates++; caller.abort(reason); }
        return result;
      },
    })) };
    return { service: createOnboardingJobService(observed, () => clock), checkpoint: () => caller.signal.throwIfAborted(), reason, updates: () => updates };
  };
  const cancelledClaim = cancellation();
  await assert.rejects(() => cancelledClaim.service.claim(cancellationScope, cancellationJob.id, cancelledClaim.checkpoint), error => error === cancelledClaim.reason);
  assert.equal(cancelledClaim.updates(), 1);
  const unchangedQueued = await service!.read(cancellationScope, cancellationJob.id);
  assert.deepEqual([unchangedQueued.status, unchangedQueued.attempts, unchangedQueued.revision], ["queued", 0, cancellationJob.revision]);
  const validClaim = await service!.claim(cancellationScope, cancellationJob.id);
  assert.ok(validClaim);
  const cancelledCompletion = cancellation();
  await assert.rejects(() => cancelledCompletion.service.complete(cancellationScope, cancellationJob.id, validClaim.leaseToken, research(cancellationScope), cancelledCompletion.checkpoint), error => error === cancelledCompletion.reason);
  assert.equal(cancelledCompletion.updates(), 1);
  const cancelledRetry = cancellation();
  await assert.rejects(() => cancelledRetry.service.retry(cancellationScope, cancellationJob.id, validClaim.leaseToken, cancelledRetry.checkpoint), error => error === cancelledRetry.reason);
  assert.equal(cancelledRetry.updates(), 1);
  const unchangedRunning = await service!.read(cancellationScope, cancellationJob.id);
  assert.deepEqual([unchangedRunning.status, unchangedRunning.revision, unchangedRunning.researchReceipt], ["running", validClaim.job.revision, null]);
  await service!.complete(cancellationScope, cancellationJob.id, validClaim.leaseToken, research(cancellationScope));
  pass("real SQL rolls back cancelled claim, completion and retry callbacks; original row and lease remain usable");

  const retryJob = (await service!.enqueue(scope("202"), "synthetic-retry-key", input)).job;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const claimed = await service!.claim(scope("202"), retryJob.id);
    assert.ok(claimed);
    assert.equal(claimed.job.attempts, attempt);
    const retried = await service!.retry(scope("202"), retryJob.id, claimed.leaseToken);
    assert.equal(retried.status, attempt < 3 ? "retry_wait" : "failed");
    assert.equal(await service!.claim(scope("202"), retryJob.id), null);
    clock = new Date(clock.getTime() + 5_000);
  }
  assert.equal((await service!.read(scope("202"), retryJob.id)).attempts, 3);
  assert.equal(await service!.claim(scope("202"), retryJob.id), null);
  pass("persisted technical attempt budget and retry delay prevent unbounded nonbuyer work");

  await rejects(() => service!.read(scope("201", other), id), "CURRENT_OWNER_REQUIRED");
  await rejects(() => service!.read(scope("203", other), id), "ONBOARDING_JOB_NOT_FOUND");
  await engine!.query("UPDATE users SET is_disabled = true WHERE id = $1", [owner]);
  await rejects(() => service!.read(scope(), id), "CURRENT_OWNER_REQUIRED");
  await engine!.query("UPDATE users SET is_disabled = false WHERE id = $1", [owner]);
  const transferred = (await service!.enqueue(scope("204"), "synthetic-transfer-key", input)).job;
  await engine!.query("UPDATE restaurants SET owner_id = $1 WHERE id = $2", [other, business("204")]);
  await rejects(() => service!.read(scope("204"), transferred.id), "CURRENT_OWNER_REQUIRED");
  await rejects(() => service!.read(scope("204", other), transferred.id), "ONBOARDING_JOB_NOT_FOUND");
  assert.equal((await service!.recoverable()).some(row => row.id === transferred.id), false);
  pass("foreign owner/business, disabled account and ownership transfer fail closed without disclosing former-owner research");

  const draftId = "00000000-0000-4000-8000-000000000301";
  const foreignDraftId = "00000000-0000-4000-8000-000000000302";
  await engine!.query("INSERT INTO owner_ai_action_drafts(id,restaurant_id,created_by_user_id,status,revision,expires_at) VALUES ($1,$2,$3,'draft',1,$4),($5,$6,$7,'draft',1,$4)", [draftId, business("201"), owner, new Date(clock.getTime() + 60_000).toISOString(), foreignDraftId, business("203"), other]);
  await rejects(() => service!.attachExistingPrivatePreview(scope(), id, { draftId: foreignDraftId, revision: 1 }), "PRIVATE_PREVIEW_REQUIRED");
  await rejects(() => service!.attachExistingPrivatePreview(scope(), id, { draftId, revision: 2 }), "PRIVATE_PREVIEW_REQUIRED");
  const attached = await service!.attachExistingPrivatePreview(scope(), id, { draftId, revision: 1 });
  assert.equal(attached.preview?.draftId, draftId);
  assert.equal((await service!.attachExistingPrivatePreview(scope(), id, { draftId, revision: 1 })).revision, attached.revision);
  const draft = (await engine!.query<{status: string; revision: number}>("SELECT status,revision FROM owner_ai_action_drafts WHERE id=$1", [draftId])).rows[0];
  assert.deepEqual(draft, { status: "draft", revision: 1 });
  pass("only exact current private owner draft is linked; replay does not approve or mutate that draft");

  const auth: RequestHandler = (req, res, next) => {
    const id = req.get("x-synthetic-owner");
    if (!id) { res.status(401).json({ error: "Synthetic fixture login required" }); return; }
    (req as any).user = { id };
    next();
  };
  // Actual route and Express coverage is retained, outside initialization peak.
  const [{ default: express }, { registerOnboardingJobRoutes }] = await Promise.all([import("express"), import("../server/routes/onboardingJobRoutes")]);
  stage("actual-http-route-loaded");
  const app = express();
  app.use(express.json());
  registerOnboardingJobRoutes(app, { database: database as unknown as OnboardingDatabase, isAuthenticated: auth, limiter: (_req, _res, next) => next(), enabled: () => true });
  httpServer = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => httpServer!.once("listening", resolve));
  const localBase = "http://127.0.0.1:" + (httpServer.address() as any).port + "/api/owner-ai/restaurants/" + business("201") + "/onboarding";
  const get = async (ownerId?: string) => {
    const res = await nativeFetch(localBase + "/jobs/" + id, { headers: ownerId ? { "x-synthetic-owner": ownerId } : {} });
    return { status: res.status, cache: res.headers.get("cache-control"), body: await res.json() as any };
  };
  assert.equal((await get()).status, 401);
  assert.equal((await get(other)).status, 403);
  const own = await get(owner);
  assert.equal(own.status, 200);
  assert.equal(own.cache, "private, no-store");
  assert.equal(own.body.job.preview.draftId, draftId);
  assert.equal(JSON.stringify(own.body).includes("lease"), false);
  const disabled = await nativeFetch(localBase + "/service-build", { method: "POST", headers: { "x-synthetic-owner": owner, "content-type": "application/json" }, body: JSON.stringify({ paymentVerified: true, tier: 2500 }) });
  assert.equal(disabled.status, 503);
  assert.equal((await disabled.json() as any).code, "SERVICE_BUILD_INTEGRATION_REQUIRED");
  pass("real route handlers and DB owner guards accept only synthetic authenticated owner status; forged paid state cannot enable build");

  await assert.rejects(() => engine!.query("UPDATE owner_onboarding_jobs SET max_attempts=4 WHERE id=$1", [id]));
  await assert.rejects(() => engine!.query("UPDATE owner_onboarding_jobs SET status='running' WHERE id=$1", [id]));
  assert.equal((await engine!.query<{payload: string}>("SELECT payload FROM unrelated_jobs WHERE id=1")).rows[0].payload, "preserved");
  assert.equal(externalFetchCalls, 0);
  pass("DB constraints reject invalid state/budget; unrelated job data preserved; no external fetch");
  succeeded = true;
} catch (error) {
  failure = String((error as any)?.message || error).slice(0, 2_000);
  throw error;
} finally {
  if (httpServer) await new Promise<void>(resolve => httpServer!.close(() => resolve()));
  service = undefined;
  database = undefined;
  if (engine) await engine.close();
  globalThis.fetch = nativeFetch;
  clearTimeout(deadline);
  clearInterval(memoryGuard);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  cleanupFixture();
  const sourceHashes = Object.fromEntries(["shared/onboardingJobs.ts", "shared/schema/onboardingJobs.ts", "server/services/onboardingJobs.ts", "server/routes/onboardingJobRoutes.ts", "scripts/onboarding-job-recovery.integration.test.ts"].map(file => [file, sha(readFileSync(path.join(repository, file)))]));
  const result = {
    schemaVersion: "mealscout.durable-onboarding-native-proof.v1",
    result: succeeded ? "PASS" : "FAIL",
    headAtRun: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
    migration: { path: migrationFile, sha256: sha(migrationSql), reapplied: true },
    sourceHashes,
    checks,
    failure,
    durationMs: Date.now() - started,
    peakRssBytes: peakRss,
    rssBudgetBytes: memoryLimit,
    deadlineSeconds: 45,
    pgliteOptions,
    initialization,
    externalFetchCalls,
    fixtureCleanupCompleted: true,
    scope: "Single disk-backed PGlite synthetic DB, actual durable service and actual new route handlers. Authentication/rate middleware are fixture stand-ins; no genuine native owner/provider/payment/production acceptance.",
    productionMigrationDatabaseProviderModelOrCustomerActions: 0,
  };
  writeFileSync(path.join(phase, "native-recovery-result.json"), JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ result: result.result, checks: checks.length, durationMs: result.durationMs, peakRssBytes: peakRss, externalFetchCalls }) + "\n");
}
