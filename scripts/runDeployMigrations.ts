import "dotenv/config";

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import pg from "pg";
import ws from "ws";

import { splitSqlStatements } from "./sqlMigrationStatements";
import { assertIsolatedVerificationDatabaseUrl, isIsolatedVerificationMode, isRenderService } from "../server/bootstrap/isolatedVerification";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEPLOY_MIGRATION_FLOOR = 119;
export const EMPTY_DATABASE_BOOTSTRAP_FLOOR = 0;
export const EMPTY_DATABASE_BOOTSTRAP_KEY = "historical-0-through-118";
export const DEPLOY_MIGRATION_LOCK_KEY = 2026081101;
export const DEPLOY_MIGRATION_LOCK_TIMEOUT_MS = 120_000;
export const DEPLOY_MIGRATION_DDL_LOCK_TIMEOUT_MS = 5_000;
export const DEPLOY_MIGRATION_STATEMENT_TIMEOUT_MS = 300_000;

neonConfig.webSocketConstructor = ws;
const { Pool: NodePool } = pg;

export type DeployMigration = {
  filename: string;
  number: number;
  path: string;
  sha256: string;
  compatibleSha256s: readonly string[];
};

export type AppliedDeployMigration = {
  filename: string;
  migrationNumber: number;
  sha256: string;
};

export type DeployMigrationHooks = {
  beforeBootstrapMigration?: (
    migration: DeployMigration,
    completedCount: number,
  ) => void | Promise<void>;
};

type MigrationClient = {
  query: (
    queryText: string,
    values?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

export function normalizeMigrationSqlForFingerprint(sqlText: string): string {
  return sqlText.replace(/\r\n?/g, "\n");
}

export function migrationFingerprints(sqlText: string): {
  canonical: string;
  compatible: readonly string[];
} {
  const canonicalSql = normalizeMigrationSqlForFingerprint(sqlText);
  const canonical = sha256(canonicalSql);
  const legacyCrLf = sha256(canonicalSql.replace(/\n/g, "\r\n"));
  return {
    canonical,
    compatible: [...new Set([canonical, legacyCrLf])],
  };
}

export function discoverDeployMigrations(
  migrationsDirectory = path.resolve(__dirname, "../migrations"),
  floor = DEPLOY_MIGRATION_FLOOR,
): DeployMigration[] {
  return fs
    .readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => {
      const match = entry.name.match(/^(\d+)/);
      if (!match) return null;
      const number = Number(match[1]);
      if (number < floor) return null;
      const migrationPath = path.join(migrationsDirectory, entry.name);
      const fingerprints = migrationFingerprints(
        fs.readFileSync(migrationPath, "utf8"),
      );
      return {
        filename: entry.name,
        number,
        path: migrationPath,
        sha256: fingerprints.canonical,
        compatibleSha256s: fingerprints.compatible,
      };
    })
    .filter((entry): entry is DeployMigration => entry !== null)
    .sort((left, right) =>
      left.number === right.number
        ? left.filename.localeCompare(right.filename)
        : left.number - right.number,
    );
}

export function discoverBootstrapMigrations(
  migrationsDirectory = path.resolve(__dirname, "../migrations"),
): DeployMigration[] {
  return discoverDeployMigrations(
    migrationsDirectory,
    EMPTY_DATABASE_BOOTSTRAP_FLOOR,
  ).filter((migration) => migration.number < DEPLOY_MIGRATION_FLOOR);
}

export function resolveBootstrapAction(
  userTableCount: number,
  markerExists: boolean,
): "initialize" | "resume" | "skip" {
  if (!Number.isInteger(userTableCount) || userTableCount < 0) {
    throw new Error("userTableCount must be a nonnegative integer");
  }
  if (userTableCount === 0) {
    if (markerExists) {
      throw new Error(
        "Empty-database bootstrap marker cannot exist without a user table",
      );
    }
    return "initialize";
  }
  return markerExists ? "resume" : "skip";
}

export function isBootstrapTransactionControlStatement(
  statement: string,
): boolean {
  let remainder = statement.trimStart();
  for (;;) {
    if (remainder.startsWith("--")) {
      const newline = remainder.search(/[\r\n]/);
      remainder = newline < 0 ? "" : remainder.slice(newline + 1).trimStart();
      continue;
    }
    if (remainder.startsWith("/*")) {
      const closing = remainder.indexOf("*/", 2);
      if (closing < 0) return false;
      remainder = remainder.slice(closing + 2).trimStart();
      continue;
    }
    break;
  }
  return /^(?:begin|commit)(?:\s+(?:work|transaction))?$/i.test(
    remainder.trim(),
  );
}

export function planDeployMigrations(
  available: DeployMigration[],
  applied: AppliedDeployMigration[],
): DeployMigration[] {
  const availableByFilename = new Map(
    available.map((migration) => [migration.filename, migration]),
  );
  const appliedByFilename = new Map(
    applied.map((migration) => [migration.filename, migration]),
  );

  for (const record of applied) {
    const migration = availableByFilename.get(record.filename);
    if (!migration) {
      throw new Error(
        `Applied migration file is missing: ${record.filename}. Restore immutable migration history.`,
      );
    }
    if (
      migration.number !== record.migrationNumber ||
      !migration.compatibleSha256s.includes(record.sha256)
    ) {
      throw new Error(
        `Applied migration changed after execution: ${record.filename}`,
      );
    }
  }

  return available.filter(
    (migration) => !appliedByFilename.has(migration.filename),
  );
}

export function assertTransactionCompatibleMigration(
  migration: DeployMigration,
  sqlText: string,
): void {
  if (
    /\b(?:create\s+(?:unique\s+)?index|drop\s+index)\s+concurrently\b/i.test(
      sqlText,
    )
  ) {
    throw new Error(
      `${migration.filename} requires a dedicated non-transactional deploy path; ` +
        "do not weaken CREATE/DROP INDEX CONCURRENTLY to make this gate pass",
    );
  }
}

export function resolveMigrationDatabaseUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const raw =
    environment.MIGRATION_DATABASE_URL || environment.DATABASE_URL || "";
  if (!raw) {
    throw new Error(
      "MIGRATION_DATABASE_URL or DATABASE_URL is required for deploy migrations",
    );
  }

  const parsed = new URL(raw);
  if (isIsolatedVerificationMode(environment)) {
    assertIsolatedVerificationDatabaseUrl(raw, environment);
    if (environment.MIGRATION_DATABASE_URL) {
      if (!environment.DATABASE_URL) {
        throw new Error("Isolated migrations require the runtime DATABASE_URL for target matching");
      }
      assertIsolatedVerificationDatabaseUrl(environment.DATABASE_URL, environment);
      const runtime = new URL(environment.DATABASE_URL);
      const directHost = (host: string) => host.replace(/-pooler(?=\.)/i, "");
      if (
        directHost(parsed.hostname) !== directHost(runtime.hostname) ||
        parsed.pathname !== runtime.pathname ||
        parsed.port !== runtime.port
      ) {
        throw new Error("Isolated migration and runtime database targets differ");
      }
    }
  }
  if (!environment.MIGRATION_DATABASE_URL && /\.neon\.tech$/i.test(parsed.hostname)) {
    parsed.hostname = parsed.hostname.replace(/-pooler(?=\.)/i, "");
  }
  if (/-pooler(?=\.)/i.test(parsed.hostname)) {
    throw new Error(
      "Deploy migrations require a direct Postgres connection, not a transaction-pooled endpoint",
    );
  }
  return parsed.toString();
}

export function useLocalPostgresTransport(
  databaseUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (environment.MEALSCOUT_LOCAL_POSTGRES_MIGRATION !== "true") {
    return false;
  }
  const parsed = new URL(databaseUrl);
  // node-postgres treats URL query parameters such as ?host= as connection
  // overrides, so checking only URL.hostname can permit a remote target.
  if (parsed.search || parsed.hash) {
    throw new Error(
      "Local migration transport does not permit connection URL parameters or fragments",
    );
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!["127.0.0.1", "[::1]"].includes(hostname)) {
    throw new Error(
      "Local migration transport requires a numeric loopback PostgreSQL address",
    );
  }
  if (isRenderService(environment)) {
    throw new Error(
      "Local migration transport is unavailable in a Render service",
    );
  }
  return true;
}

async function countUserTables(client: MigrationClient): Promise<number> {
  const result = await client.query(`
    select count(*)::int as count
    from pg_class relation
    inner join pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where relation.relkind in ('r', 'p')
      and namespace.nspname <> 'information_schema'
      and namespace.nspname !~ '^pg_'
  `);
  return Number(result.rows[0]?.count ?? 0);
}

async function bootstrapMarkerExists(client: MigrationClient): Promise<boolean> {
  const result = await client.query(
    "select to_regclass($1) is not null as exists",
    ["public.mealscout_schema_bootstrap"],
  );
  return result.rows[0]?.exists === true;
}

async function initializeEmptyDatabaseBootstrap(
  client: MigrationClient,
): Promise<void> {
  await client.query("begin");
  try {
    const userTableCount = await countUserTables(client);
    if (userTableCount !== 0) {
      throw new Error(
        "Database became nonempty before bootstrap initialization; refusing historical replay",
      );
    }
    await client.query(`
      create table mealscout_schema_bootstrap (
        bootstrap_key text primary key,
        status text not null check (status in ('in_progress', 'complete')),
        started_at timestamptz not null default now(),
        completed_at timestamptz
      )
    `);
    await client.query(`
      create table mealscout_schema_bootstrap_migrations (
        filename text primary key,
        migration_number integer not null,
        sha256 text not null,
        execution_ms integer not null,
        applied_at timestamptz not null default now()
      )
    `);
    await client.query(
      `insert into mealscout_schema_bootstrap (bootstrap_key, status)
       values ($1, 'in_progress')`,
      [EMPTY_DATABASE_BOOTSTRAP_KEY],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

async function runEmptyDatabaseBootstrap(
  client: MigrationClient,
  hooks: DeployMigrationHooks,
): Promise<void> {
  const stateResult = await client.query(
    `select status
     from mealscout_schema_bootstrap
     where bootstrap_key = $1`,
    [EMPTY_DATABASE_BOOTSTRAP_KEY],
  );
  if (stateResult.rows.length !== 1) {
    throw new Error(
      "Empty-database bootstrap marker is missing or ambiguous; refusing historical replay",
    );
  }
  const status = String(stateResult.rows[0]?.status || "");
  if (status !== "in_progress" && status !== "complete") {
    throw new Error(`Unsupported empty-database bootstrap status: ${status}`);
  }

  const bootstrapMigrations = discoverBootstrapMigrations();
  const appliedResult = await client.query(`
    select
      filename,
      migration_number as "migrationNumber",
      sha256
    from mealscout_schema_bootstrap_migrations
    order by migration_number, filename
  `);
  const pending = planDeployMigrations(
    bootstrapMigrations,
    appliedResult.rows as AppliedDeployMigration[],
  );

  if (status === "complete") {
    if (pending.length > 0) {
      throw new Error(
        "Completed empty-database bootstrap has missing migration records",
      );
    }
    console.log(
      `Empty database bootstrap already complete (${bootstrapMigrations.length} verified)`,
    );
    return;
  }

  console.log(
    `Empty database bootstrap ${appliedResult.rows.length === 0 ? "starting" : "resuming"} ` +
      `(${pending.length} pending, ${appliedResult.rows.length} verified)`,
  );
  let completedCount = bootstrapMigrations.length - pending.length;
  for (const migration of pending) {
    await hooks.beforeBootstrapMigration?.(migration, completedCount);
    const migrationSql = fs.readFileSync(migration.path, "utf8");
    assertTransactionCompatibleMigration(migration, migrationSql);
    const statements = splitSqlStatements(migrationSql).filter(
      (statement) => !isBootstrapTransactionControlStatement(statement),
    );
    const startedAt = Date.now();

    console.log(`Bootstrapping historical migration ${migration.filename}`);
    await client.query("begin");
    try {
      for (const statement of statements) {
        await client.query(statement);
      }
      await client.query(
        `insert into mealscout_schema_bootstrap_migrations
          (filename, migration_number, sha256, execution_ms)
         values ($1, $2, $3, $4)`,
        [
          migration.filename,
          migration.number,
          migration.sha256,
          Date.now() - startedAt,
        ],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
    completedCount += 1;
  }

  const completed = await client.query(
    `update mealscout_schema_bootstrap
     set status = 'complete', completed_at = now()
     where bootstrap_key = $1 and status = 'in_progress'
     returning bootstrap_key`,
    [EMPTY_DATABASE_BOOTSTRAP_KEY],
  );
  if (completed.rows.length !== 1) {
    throw new Error("Empty-database bootstrap completion marker update failed");
  }
  console.log(
    `Empty database bootstrap PASS (${bootstrapMigrations.length} verified)`,
  );
}

export async function runDeployMigrations(
  hooks: DeployMigrationHooks = {},
): Promise<void> {
  const connectionString = resolveMigrationDatabaseUrl();
  const poolOptions = { connectionString, max: 1 };
  const pool = useLocalPostgresTransport(connectionString)
    ? new NodePool(poolOptions)
    : new NeonPool(poolOptions);

  const client = await pool.connect();
  let lockAcquired = false;
  try {
    await client.query(
      "select set_config('statement_timeout', $1, false)",
      [`${DEPLOY_MIGRATION_LOCK_TIMEOUT_MS}ms`],
    );
    await client.query("select pg_advisory_lock($1)", [
      DEPLOY_MIGRATION_LOCK_KEY,
    ]);
    lockAcquired = true;
    await client.query("select set_config('lock_timeout', $1, false)", [
      `${DEPLOY_MIGRATION_DDL_LOCK_TIMEOUT_MS}ms`,
    ]);
    await client.query("select set_config('statement_timeout', $1, false)", [
      `${DEPLOY_MIGRATION_STATEMENT_TIMEOUT_MS}ms`,
    ]);

    const userTableCount = await countUserTables(client);
    const markerExists = await bootstrapMarkerExists(client);
    const bootstrapAction = resolveBootstrapAction(
      userTableCount,
      markerExists,
    );
    if (bootstrapAction === "initialize") {
      await initializeEmptyDatabaseBootstrap(client);
      await runEmptyDatabaseBootstrap(client, hooks);
    } else if (bootstrapAction === "resume") {
      await runEmptyDatabaseBootstrap(client, hooks);
    } else {
      console.log(
        `Nonempty database without bootstrap marker; preserving deploy migration floor ${DEPLOY_MIGRATION_FLOOR}`,
      );
    }

    await client.query(`
      create table if not exists mealscout_release_migrations (
        filename text primary key,
        migration_number integer not null,
        sha256 text not null,
        execution_ms integer not null,
        applied_at timestamptz not null default now()
      )
    `);

    const appliedResult = await client.query(
      `
      select
        filename,
        migration_number as "migrationNumber",
        sha256
      from mealscout_release_migrations
      where migration_number >= $1
      order by migration_number, filename
    `,
      [DEPLOY_MIGRATION_FLOOR],
    );
    const available = discoverDeployMigrations();
    const pending = planDeployMigrations(
      available,
      appliedResult.rows as AppliedDeployMigration[],
    );

    for (const migration of pending) {
      const migrationSql = fs.readFileSync(migration.path, "utf8");
      assertTransactionCompatibleMigration(migration, migrationSql);
      const statements = splitSqlStatements(migrationSql);
      const startedAt = Date.now();
      console.log(`Applying deploy migration ${migration.filename}`);
      await client.query("begin");
      try {
        for (const statement of statements) {
          await client.query(statement);
        }
        await client.query(
          `insert into mealscout_release_migrations
            (filename, migration_number, sha256, execution_ms)
           values ($1, $2, $3, $4)`,
          [
            migration.filename,
            migration.number,
            migration.sha256,
            Date.now() - startedAt,
          ],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      }
    }

    console.log(
      `Deploy migration PASS (${pending.length} applied, ${available.length - pending.length} already recorded)`,
    );
  } finally {
    if (lockAcquired) {
      await client
        .query("select pg_advisory_unlock($1)", [DEPLOY_MIGRATION_LOCK_KEY])
        .catch((error: unknown) => {
          console.error("Failed to release deploy migration lock:", error);
        });
    }
    client.release();
    await pool.end().catch(() => undefined);
  }
}

if (path.resolve(process.argv[1] || "") === __filename) {
  runDeployMigrations().catch((error) => {
    console.error("Deploy migration failed:", error);
    process.exit(1);
  });
}
