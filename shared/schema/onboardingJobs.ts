import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { ownerAiActionDrafts, restaurants, users } from "./legacy";
import type { OnboardingResearchInput, OnboardingResearchReceipt } from "../onboardingJobs";

export const ownerOnboardingJobs = pgTable("owner_onboarding_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  ownerId: varchar("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  restaurantId: varchar("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" }),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  input: jsonb("input").$type<OnboardingResearchInput>().notNull(),
  status: varchar("status").notNull().default("queued"),
  revision: integer("revision").notNull().default(1),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  leaseToken: varchar("lease_token", { length: 64 }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  researchReceipt: jsonb("research_receipt").$type<OnboardingResearchReceipt>(),
  previewDraftId: varchar("preview_draft_id").references(() => ownerAiActionDrafts.id, { onDelete: "set null" }),
  previewDraftRevision: integer("preview_draft_revision"),
  lastErrorCode: varchar("last_error_code", { length: 64 }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("owner_onboarding_jobs_owner_business_idx").on(table.ownerId, table.restaurantId),
  uniqueIndex("owner_onboarding_jobs_idempotency_idx").on(table.ownerId, table.restaurantId, table.idempotencyKey),
  index("owner_onboarding_jobs_recovery_idx").on(table.status, table.availableAt, table.leaseExpiresAt),
  check("owner_onboarding_jobs_status_check", sql`${table.status} IN ('queued','running','retry_wait','completed','failed')`),
  check("owner_onboarding_jobs_attempts_check", sql`${table.maxAttempts} = 3 AND ${table.attempts} BETWEEN 0 AND ${table.maxAttempts} AND ${table.revision} > 0`),
  check("owner_onboarding_jobs_lease_check", sql`(${table.status} = 'running' AND ${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL) OR (${table.status} <> 'running' AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL)`),
  check("owner_onboarding_jobs_result_check", sql`(${table.status} = 'completed' AND ${table.researchReceipt} IS NOT NULL AND ${table.completedAt} IS NOT NULL) OR (${table.status} <> 'completed' AND ${table.researchReceipt} IS NULL AND ${table.completedAt} IS NULL)`),
  check("owner_onboarding_jobs_input_check", sql`jsonb_typeof(${table.input}) = 'object' AND octet_length(${table.input}::text) <= 16384`),
  check("owner_onboarding_jobs_receipt_check", sql`${table.researchReceipt} IS NULL OR (jsonb_typeof(${table.researchReceipt}) = 'object' AND octet_length(${table.researchReceipt}::text) <= 65536)`),
  check("owner_onboarding_jobs_identity_check", sql`${table.requestHash} ~ '^[a-f0-9]{64}$' AND ${table.idempotencyKey} ~ '^[A-Za-z0-9._:-]{8,128}$'`),
  check("owner_onboarding_jobs_preview_check", sql`(${table.previewDraftRevision} IS NULL OR ${table.previewDraftRevision} > 0) AND (${table.previewDraftId} IS NULL OR (${table.previewDraftRevision} IS NOT NULL AND ${table.status} = 'completed'))`),
]);
