import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEPLOY_MIGRATION_FLOOR,
  DEPLOY_MIGRATION_DDL_LOCK_TIMEOUT_MS,
  DEPLOY_MIGRATION_LOCK_TIMEOUT_MS,
  DEPLOY_MIGRATION_STATEMENT_TIMEOUT_MS,
  assertTransactionCompatibleMigration,
  discoverBootstrapMigrations,
  discoverDeployMigrations,
  isBootstrapTransactionControlStatement,
  migrationFingerprints,
  normalizeMigrationSqlForFingerprint,
  planDeployMigrations,
  resolveBootstrapAction,
  resolveMigrationDatabaseUrl,
  useLocalPostgresTransport,
} from "./runDeployMigrations";

assert.equal(
  normalizeMigrationSqlForFingerprint("select 1;\r\nselect 2;\r"),
  "select 1;\nselect 2;\n",
  "migration fingerprints must not depend on checkout line endings",
);
const lfFingerprints = migrationFingerprints("select 1;\nselect 2;\n");
const crlfFingerprints = migrationFingerprints("select 1;\r\nselect 2;\r\n");
assert.equal(
  lfFingerprints.canonical,
  crlfFingerprints.canonical,
  "LF and CRLF copies of the same migration must share a canonical fingerprint",
);
assert.deepEqual(
  lfFingerprints.compatible,
  crlfFingerprints.compatible,
  "legacy compatibility must be deterministic on every operating system",
);

const migrations = discoverDeployMigrations();
assert.ok(migrations.length >= 6, "release migration set must include 119-124");
assert.equal(migrations[0]?.number, DEPLOY_MIGRATION_FLOOR);
assert.deepEqual(
  migrations.slice(0, 6).map((migration) => migration.number),
  [119, 120, 121, 122, 123, 124],
);
assert.equal(
  planDeployMigrations(migrations, []).length,
  migrations.length,
  "an empty ledger must apply every release migration",
);

const bootstrapMigrations = discoverBootstrapMigrations();
assert.equal(bootstrapMigrations[0]?.number, 0);
assert.equal(bootstrapMigrations.at(-1)?.number, 118);
assert.ok(
  bootstrapMigrations.every(
    (migration) => migration.number < DEPLOY_MIGRATION_FLOOR,
  ),
  "empty-database bootstrap must never replay release-ledger migrations",
);
assert.ok(
  bootstrapMigrations.some(
    (migration) => migration.filename === "089_online_menus_and_ordering.sql",
  ),
  "empty-database bootstrap must create menu_items before migration 119",
);
assert.equal(resolveBootstrapAction(0, false), "initialize");
assert.equal(resolveBootstrapAction(1, true), "resume");
assert.equal(resolveBootstrapAction(1, false), "skip");
assert.throws(() => resolveBootstrapAction(-1, false), /nonnegative integer/);
assert.throws(
  () => resolveBootstrapAction(0, true),
  /marker cannot exist without a user table/,
);
assert.equal(
  isBootstrapTransactionControlStatement(
    "-- authored transaction boundary\nBEGIN",
  ),
  true,
);
assert.equal(isBootstrapTransactionControlStatement("COMMIT TRANSACTION"), true);
assert.equal(
  isBootstrapTransactionControlStatement("select 'begin' as label"),
  false,
);
assert.throws(
  () =>
    planDeployMigrations(bootstrapMigrations, [
      {
        filename: bootstrapMigrations[0]!.filename,
        migrationNumber: bootstrapMigrations[0]!.number,
        sha256: "changed-bootstrap-history",
      },
    ]),
  /changed after execution/,
  "resumable bootstrap history must fail closed when an applied file changes",
);

const applied = migrations.map((migration) => ({
  filename: migration.filename,
  migrationNumber: migration.number,
  sha256: migration.sha256,
}));
assert.deepEqual(
  planDeployMigrations(migrations, applied),
  [],
  "an intact ledger must make repeated deploys a no-op",
);
const migrationWithLegacyCrLfHash = migrations.find(
  (migration) => migration.compatibleSha256s.length > 1,
);
assert.ok(
  migrationWithLegacyCrLfHash,
  "the contract fixture must exercise the legacy Windows CRLF ledger path",
);
assert.deepEqual(
  planDeployMigrations(migrations, [
    {
      filename: migrationWithLegacyCrLfHash.filename,
      migrationNumber: migrationWithLegacyCrLfHash.number,
      sha256: migrationWithLegacyCrLfHash.compatibleSha256s.find(
        (fingerprint) => fingerprint !== migrationWithLegacyCrLfHash.sha256,
      )!,
    },
  ]).map((migration) => migration.filename),
  migrations
    .filter(
      (migration) => migration.filename !== migrationWithLegacyCrLfHash.filename,
    )
    .map((migration) => migration.filename),
  "a previously recorded CRLF hash must be accepted without replaying its migration",
);
assert.throws(
  () =>
    planDeployMigrations(migrations, [
      { ...applied[0]!, sha256: "changed-after-apply" },
    ]),
  /changed after execution/,
  "editing an applied migration must fail closed",
);
assert.throws(
  () =>
    planDeployMigrations(migrations.slice(1), [applied[0]!]),
  /file is missing/,
  "deleting applied migration history must fail closed",
);
assert.ok(
  DEPLOY_MIGRATION_LOCK_TIMEOUT_MS > 0,
  "migration lock wait must be bounded",
);
assert.ok(
  DEPLOY_MIGRATION_DDL_LOCK_TIMEOUT_MS > 0 &&
    DEPLOY_MIGRATION_DDL_LOCK_TIMEOUT_MS <
      DEPLOY_MIGRATION_STATEMENT_TIMEOUT_MS,
  "DDL lock waits must fail before the bounded statement timeout",
);
assert.doesNotThrow(() =>
  assertTransactionCompatibleMigration(migrations[0]!, "select 1"),
);
assert.throws(
  () =>
    assertTransactionCompatibleMigration(
      migrations[0]!,
      "create index concurrently idx_example on example(id)",
    ),
  /dedicated non-transactional deploy path/,
  "concurrent indexes must retain their semantics outside the transactional path",
);
assert.throws(
  () =>
    assertTransactionCompatibleMigration(
      migrations[0]!,
      "create unique index concurrently uq_example on example(id)",
    ),
  /dedicated non-transactional deploy path/,
  "unique concurrent indexes must also retain their non-transactional semantics",
);
assert.equal(
  new URL(
    resolveMigrationDatabaseUrl({
      DATABASE_URL:
        "postgresql://user:password@ep-example-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
    }),
  ).hostname,
  "ep-example.us-east-2.aws.neon.tech",
  "the migration runner must bypass Neon's transaction pooler",
);
assert.equal(
  new URL(
    resolveMigrationDatabaseUrl({
      DATABASE_URL:
        "postgresql://user:password@ep-pooled-pooler.us-east-2.aws.neon.tech/neondb",
      MIGRATION_DATABASE_URL:
        "postgresql://user:password@ep-direct.us-east-2.aws.neon.tech/neondb",
    }),
  ).hostname,
  "ep-direct.us-east-2.aws.neon.tech",
  "an explicit direct migration URL must take precedence",
);
assert.throws(
  () =>
    resolveMigrationDatabaseUrl({
      MIGRATION_DATABASE_URL:
        "postgresql://user:password@pgbouncer-pooler.example.com/app",
    }),
  /direct Postgres connection/,
);
const localMigrationUrl = "postgresql://user@127.0.0.1:55494/mealscout_pr394";
assert.equal(
  useLocalPostgresTransport(localMigrationUrl, {}),
  false,
  "the production transport remains the default",
);
assert.equal(
  useLocalPostgresTransport(localMigrationUrl, {
    MEALSCOUT_LOCAL_POSTGRES_MIGRATION: "true",
  }),
  true,
  "an explicit loopback database may use the native PostgreSQL client",
);
assert.throws(
  () =>
    useLocalPostgresTransport(
      "postgresql://user@ep-example.us-east-2.aws.neon.tech/neondb",
      { MEALSCOUT_LOCAL_POSTGRES_MIGRATION: "true" },
    ),
  /loopback PostgreSQL address/,
);
assert.throws(
  () =>
    useLocalPostgresTransport(
      `${localMigrationUrl}?host=ep-example.us-east-2.aws.neon.tech`,
      { MEALSCOUT_LOCAL_POSTGRES_MIGRATION: "true" },
    ),
  /connection URL parameters/,
  "pg connection-string query parameters must not override a loopback hostname",
);
assert.throws(
  () =>
    useLocalPostgresTransport("postgresql://user@localhost:55494/mealscout_pr394", {
      MEALSCOUT_LOCAL_POSTGRES_MIGRATION: "true",
    }),
  /numeric loopback PostgreSQL address/,
  "localhost can resolve outside loopback through host configuration",
);
assert.throws(
  () =>
    useLocalPostgresTransport(localMigrationUrl, {
      MEALSCOUT_LOCAL_POSTGRES_MIGRATION: "true",
      RENDER_SERVICE_ID: "srv-example",
    }),
  /unavailable in a Render service/,
);

const runnerSource = readFileSync("scripts/runDeployMigrations.ts", "utf8");
const emptyDatabaseCheck = runnerSource.indexOf(
  "const userTableCount = await countUserTables(client)",
);
const releaseLedgerCreate = runnerSource.indexOf(
  "create table if not exists mealscout_release_migrations",
);
assert.ok(
  emptyDatabaseCheck >= 0 &&
    releaseLedgerCreate >= 0 &&
    emptyDatabaseCheck < releaseLedgerCreate,
  "the deploy runner must classify a truly empty database before creating its release ledger",
);
assert.match(
  runnerSource,
  /bootstrapAction === "initialize"[\s\S]*initializeEmptyDatabaseBootstrap\(client\)[\s\S]*runEmptyDatabaseBootstrap\(client, hooks\)/,
  "a truly empty database must durably initialize before historical replay",
);
assert.match(
  runnerSource,
  /bootstrapAction === "resume"[\s\S]*runEmptyDatabaseBootstrap\(client, hooks\)/,
  "only a database carrying the bootstrap marker may resume historical replay",
);
assert.match(
  runnerSource,
  /create table mealscout_schema_bootstrap[\s\S]*create table mealscout_schema_bootstrap_migrations[\s\S]*'in_progress'/,
  "bootstrap state and its fingerprint ledger must initialize atomically",
);
assert.match(
  runnerSource,
  /client\.query\("begin"\)[\s\S]*insert into mealscout_schema_bootstrap_migrations[\s\S]*client\.query\("commit"\)/,
  "each historical migration and its bootstrap fingerprint must commit atomically",
);
assert.match(
  runnerSource,
  /const client = await pool\.connect\(\)/,
  "the advisory lock must remain pinned to one database session",
);
assert.doesNotMatch(
  runnerSource,
  /import\("\.\.\/server\/db\.js"\)/,
  "the deploy runner must not reuse the app's pooled database client",
);
assert.match(
  runnerSource,
  /pg_advisory_lock/,
  "concurrent migration runs must serialize behind a bounded blocking lock",
);
assert.doesNotMatch(runnerSource, /pg_try_advisory_lock/);
assert.match(
  runnerSource,
  /set_config\('lock_timeout', \$1, false\)/,
  "live-table DDL lock acquisition must be bounded",
);
assert.match(
  runnerSource,
  /DEPLOY_MIGRATION_STATEMENT_TIMEOUT_MS/,
  "every deploy migration statement must retain a finite runtime bound",
);
assert.doesNotMatch(
  runnerSource,
  /set_config\('statement_timeout', '0', false\)/,
  "the migration runner must never disable its statement timeout",
);
assert.match(
  runnerSource,
  /client\.query\("begin"\)[\s\S]*insert into mealscout_release_migrations[\s\S]*client\.query\("commit"\)/,
  "migration SQL and its ledger record must commit atomically",
);

const renderConfig = readFileSync("render.yaml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
assert.match(
  renderConfig,
  /preDeployCommand:\s*npm run migrate:deploy/,
  "Render must run pending migrations before switching traffic",
);
assert.equal(
  packageJson.scripts["migrate:deploy"],
  "tsx scripts/runDeployMigrations.ts",
);

const claimRequestMigration = readFileSync(
  "migrations/124_truck_claim_requests.sql",
  "utf8",
);
assert.match(
  claimRequestMigration,
  /CREATE TABLE IF NOT EXISTS truck_claim_requests/i,
);
assert.match(
  claimRequestMigration,
  /listing_id VARCHAR NOT NULL REFERENCES truck_import_listings\(id\)/i,
);
assert.match(
  claimRequestMigration,
  /user_id VARCHAR NOT NULL REFERENCES users\(id\)/i,
);

console.log("mealscout-render-migration-gate.contract: PASS");
