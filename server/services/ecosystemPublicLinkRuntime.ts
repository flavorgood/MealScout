import type { Express } from "express";
import { pool } from "../db";
import { isAuthenticated } from "../unifiedAuth";
import { createPublicLinkAuthority, type LinkDatabase } from "./ecosystemPublicLinkAuthority";
import { registerEcosystemPublicLinkRoutes } from "../routes/ecosystemPublicLinkRoutes";
import { distributedRateLimit } from "../middleware/distributedRateLimit";

export function registerNativeEcosystemLinks(app: Express) {
  const database: LinkDatabase = {
    async query(sql, params) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        await client.query("SET LOCAL statement_timeout = '1s'");
        const result = await client.query(sql, params);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },
    async transaction(action) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '3s'");
        await client.query("SET LOCAL statement_timeout = '3s'");
        const value = await action(client);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },
  };
  registerEcosystemPublicLinkRoutes(app, {
    authority: createPublicLinkAuthority(database, {
      sourceRevision: process.env.RENDER_GIT_COMMIT ?? process.env.COMMIT_SHA ?? "",
    }),
    isAuthenticated,
    readLimit: distributedRateLimit({ scope: "ecosystem-public-link-read", limit: 60, windowMs: 60000 }),
    writeLimit: distributedRateLimit({ scope: "ecosystem-public-link-write", limit: 10, windowMs: 60000 }),
    enabled: () => !["0", "false", "off", "disabled"].includes(
      String(process.env.MEALSCOUT_ECOSYSTEM_LINKS_ENABLED ?? "true").trim().toLowerCase()),
  });
}
