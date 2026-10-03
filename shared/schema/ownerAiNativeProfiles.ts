import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import { users } from "./legacy";

// Host/location aliases share one target. Never store them in restaurant drafts.
export const ownerAiNativeProfileDrafts = pgTable("owner_ai_native_profile_drafts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  targetKind: varchar("target_kind").notNull(),
  targetId: varchar("target_id").notNull(),
  ownerId: varchar("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull().default(1),
  status: varchar("status").notNull().default("draft"),
  contextVersion: varchar("context_version").notNull(),
  contentHash: varchar("content_hash").notNull(),
  packet: jsonb("packet").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  mediaManifest: jsonb("media_manifest").notNull(),
  consent: jsonb("consent"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  appliedAt: timestamp("applied_at"),
}, t => [index("owner_ai_native_profile_drafts_owner_target_idx").on(t.ownerId, t.targetKind, t.targetId)]);
