import { Pool as NeonPool, neonConfig } from '@neondatabase/serverless';
import pg, { type Pool as LocalPoolType } from 'pg';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless';
import { drizzle as drizzleLocal } from 'drizzle-orm/node-postgres';
import ws from "ws";
import * as schema from "@shared/schema";
import { assertIsolatedVerificationDatabaseUrl, useLocalPostgresRuntime } from "./bootstrap/isolatedVerification";

const { Pool: LocalPool } = pg;

neonConfig.webSocketConstructor = ws;

// Allow development to boot without a DATABASE_URL; server will run in limited mode
if (!process.env.DATABASE_URL) {
  if (process.env.NODE_ENV === 'development') {
    console.warn("[DB] Warning: DATABASE_URL is not set. Running in limited dev mode without DB.");
  } else {
    throw new Error(
      "DATABASE_URL must be set. Did you forget to provision a database?",
    );
  }
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) assertIsolatedVerificationDatabaseUrl(databaseUrl);
const localRuntime = databaseUrl ? useLocalPostgresRuntime(databaseUrl) : false;
const selectedPool = databaseUrl
  ? localRuntime
    ? new LocalPool({ connectionString: databaseUrl })
    : new NeonPool({ connectionString: databaseUrl })
  : undefined;
export const pool = selectedPool as NeonPool;

// Some managed Postgres setups (or older DBs) can end up with a `search_path`
// that excludes `public`, which breaks unqualified table lookups (SQLSTATE 42P01)
// for tables that were created in `public`.
if (process.env.DATABASE_URL && pool) {
  pool.on("connect", (client) => {
    void client
      .query("show search_path")
      .then((result) => {
        const current = String(result?.rows?.[0]?.search_path || "").trim();
        if (!current) return;
        const tokens = current
          .split(",")
          .map((part) => part.trim().replace(/^"+|"+$/g, "").toLowerCase());
        if (tokens.includes("public")) return;
        const next = `${current}, public`;
        return client.query("select set_config('search_path', $1, false)", [next]);
      })
      .catch((error) => {
        console.warn("[DB] Failed to normalize search_path:", error?.message || error);
      });
  });
}
// Cast to any to keep query builder usable even when DATABASE_URL is absent in local dev.
// Runtime will still require a real connection string in production.
export const db = (databaseUrl
  ? localRuntime
    ? drizzleLocal({ client: selectedPool as LocalPoolType, schema })
    : drizzleNeon({ client: selectedPool as NeonPool, schema })
  : undefined) as any;
