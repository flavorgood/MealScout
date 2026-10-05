import { createHash, randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import {
  ONBOARDING_RESEARCH_MAX_ATTEMPTS,
  ONBOARDING_RESEARCH_RECEIPT_MAX_BYTES,
  onboardingIdempotencyKeySchema,
  onboardingResearchInputSchema,
  onboardingResearchReceiptSchema,
  onboardingScopeSchema,
  type OnboardingJobStatus,
  type OnboardingResearchInput,
  type OnboardingResearchReceipt,
  type OnboardingScope,
} from "../../shared/onboardingJobs";

type Row = Record<string, any>;
export interface OnboardingTransaction {
  execute(query: SQL): Promise<{ rows: Row[] }>;
}
export interface OnboardingDatabase {
  transaction<T>(work: (tx: OnboardingTransaction) => Promise<T>): Promise<T>;
}

export class OnboardingJobError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const fail = (status: number, code: string, message: string): never => {
  throw new OnboardingJobError(status, code, message);
};

export function onboardingRequestHash(scope: OnboardingScope, input: OnboardingResearchInput): string {
  return createHash("sha256").update(JSON.stringify({ version: 1, ...onboardingScopeSchema.parse(scope), input: onboardingResearchInputSchema.parse(input) })).digest("hex");
}

export function validateOnboardingResearchReceipt(value: unknown, input: OnboardingResearchInput, requestHash: string): OnboardingResearchReceipt {
  const receipt = onboardingResearchReceiptSchema.parse(value);
  if (receipt.requestHash !== requestHash) fail(409, "RESEARCH_BINDING_MISMATCH", "Research does not match this saved request");
  if (Buffer.byteLength(JSON.stringify(receipt), "utf8") > ONBOARDING_RESEARCH_RECEIPT_MAX_BYTES) fail(400, "RESEARCH_RECEIPT_TOO_LARGE", "Research receipt exceeds the storage bound");
  const captured = new Set<string>();
  for (const source of receipt.sources) {
    if (!input.officialLinks.includes(source.url) || captured.has(source.url)) fail(400, "RESEARCH_SOURCE_MISMATCH", "Research must use the saved declared links");
    captured.add(source.url);
  }
  if (receipt.observations.some(item => !captured.has(item.sourceUrl))) fail(400, "RESEARCH_SOURCE_MISMATCH", "Every observation requires its saved source capture");
  return receipt;
}

function publicJob(row: Row) {
  return {
    id: row.id as string,
    restaurantId: row.restaurant_id as string,
    status: row.status as OnboardingJobStatus,
    revision: row.revision as number,
    attempts: row.attempts as number,
    maxAttempts: row.max_attempts as number,
    input: row.input as OnboardingResearchInput,
    researchReceipt: row.research_receipt as OnboardingResearchReceipt | null,
    preview: row.preview_draft_id ? { draftId: row.preview_draft_id as string, revision: row.preview_draft_revision as number } : null,
    lastErrorCode: row.last_error_code as string | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    serviceBuildEnabled: false as const,
    commercialTerms: null,
  };
}

export function createOnboardingJobService(database: OnboardingDatabase, clock: () => Date = () => new Date()) {
  const now = () => clock().toISOString();
  async function owner(tx: OnboardingTransaction, scope: OnboardingScope) {
    const rows = (await tx.execute(sql`SELECT r.id FROM restaurants r JOIN users u ON u.id = r.owner_id
      WHERE r.id = ${scope.restaurantId} AND r.owner_id = ${scope.ownerId} AND u.is_disabled = false
      FOR UPDATE OF r, u`)).rows;
    if (rows.length !== 1) fail(403, "CURRENT_OWNER_REQUIRED", "Current enabled business owner is required");
  }
  async function scoped<T>(rawScope: OnboardingScope, work: (tx: OnboardingTransaction, scope: OnboardingScope) => Promise<T>) {
    const scope = onboardingScopeSchema.parse(rawScope);
    return database.transaction(async tx => { await owner(tx, scope); return work(tx, scope); });
  }
  async function job(tx: OnboardingTransaction, scope: OnboardingScope, id: string) {
    const row = (await tx.execute(sql`SELECT * FROM owner_onboarding_jobs WHERE id = ${id}
      AND owner_id = ${scope.ownerId} AND restaurant_id = ${scope.restaurantId} FOR UPDATE`)).rows[0];
    if (!row) fail(404, "ONBOARDING_JOB_NOT_FOUND", "Private job was not found");
    return row;
  }
  function activeLease(row: Row, token: string, at: string) {
    if (row.status !== "running" || row.lease_token !== token || !row.lease_expires_at || new Date(row.lease_expires_at).getTime() <= new Date(at).getTime()) {
      fail(409, "ONBOARDING_LEASE_STALE", "This worker lease is no longer current");
    }
  }

  return {
    async enqueue(rawScope: OnboardingScope, key: string, rawInput: unknown) {
      const input = onboardingResearchInputSchema.parse(rawInput);
      const idempotencyKey = onboardingIdempotencyKeySchema.parse(key);
      return scoped(rawScope, async (tx, scope) => {
        const hash = onboardingRequestHash(scope, input);
        const existing = (await tx.execute(sql`SELECT * FROM owner_onboarding_jobs
          WHERE owner_id = ${scope.ownerId} AND restaurant_id = ${scope.restaurantId} FOR UPDATE`)).rows[0];
        if (existing) {
          if (existing.request_hash !== hash) fail(409, "RESEARCH_INPUT_CONFLICT", "Reuse the saved research; a changed brief requires a separately authorized refresh");
          return { job: publicJob(existing), reused: true };
        }
        const at = now();
        const created = (await tx.execute(sql`INSERT INTO owner_onboarding_jobs
          (id, owner_id, restaurant_id, idempotency_key, request_hash, input, max_attempts, available_at, created_at, updated_at)
          VALUES (${randomUUID()}, ${scope.ownerId}, ${scope.restaurantId}, ${idempotencyKey}, ${hash}, ${JSON.stringify(input)}::jsonb,
            ${ONBOARDING_RESEARCH_MAX_ATTEMPTS}, ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz) RETURNING *`)).rows[0];
        return { job: publicJob(created), reused: false };
      });
    },

    async read(scope: OnboardingScope, id: string) {
      return scoped(scope, async (tx, valid) => publicJob(await job(tx, valid, id)));
    },

    // Bounded internal discovery after process restart. Never returned by HTTP.
    async recoverable() {
      const at = now();
      return database.transaction(async tx => (await tx.execute(sql`SELECT j.id, j.owner_id, j.restaurant_id
        FROM owner_onboarding_jobs j JOIN restaurants r ON r.id = j.restaurant_id AND r.owner_id = j.owner_id
        JOIN users u ON u.id = j.owner_id AND u.is_disabled = false
        WHERE (j.status IN ('queued','retry_wait') AND j.available_at <= ${at}::timestamptz)
          OR (j.status = 'running' AND j.lease_expires_at <= ${at}::timestamptz)
        ORDER BY j.created_at, j.id LIMIT 10`)).rows.map(row => ({
          id: row.id as string, ownerId: row.owner_id as string, restaurantId: row.restaurant_id as string,
        })));
    },

    // Internal worker capability only. No HTTP endpoint exposes a lease token.
    async claim(scope: OnboardingScope, id: string) {
      return scoped(scope, async (tx, valid) => {
        const row = await job(tx, valid, id);
        const at = now();
        if (row.status === "completed" || row.status === "failed") return null;
        if (row.status === "running" && new Date(row.lease_expires_at).getTime() > new Date(at).getTime()) return null;
        if (row.status !== "running" && new Date(row.available_at).getTime() > new Date(at).getTime()) return null;
        if (row.attempts >= row.max_attempts) {
          await tx.execute(sql`UPDATE owner_onboarding_jobs SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
            last_error_code = 'RESEARCH_ATTEMPTS_EXHAUSTED', revision = revision + 1, updated_at = ${at}::timestamptz WHERE id = ${id}`);
          return null;
        }
        const token = randomUUID();
        const expires = new Date(new Date(at).getTime() + 30_000).toISOString();
        const updated = (await tx.execute(sql`UPDATE owner_onboarding_jobs SET status = 'running', attempts = attempts + 1,
          lease_token = ${token}, lease_expires_at = ${expires}::timestamptz,
          last_error_code = ${row.status === "running" ? "RESEARCH_LEASE_EXPIRED" : row.last_error_code},
          revision = revision + 1, updated_at = ${at}::timestamptz WHERE id = ${id} RETURNING *`)).rows[0];
        return { job: publicJob(updated), leaseToken: token, leaseExpiresAt: expires };
      });
    },

    async complete(scope: OnboardingScope, id: string, token: string, rawReceipt: unknown) {
      return scoped(scope, async (tx, valid) => {
        const row = await job(tx, valid, id);
        const receipt = validateOnboardingResearchReceipt(rawReceipt, row.input, row.request_hash);
        // Normalize JSONB key order before checking an exact lost-response replay.
        if (row.status === "completed") {
          if (JSON.stringify(onboardingResearchReceiptSchema.parse(row.research_receipt)) !== JSON.stringify(receipt)) fail(409, "RESEARCH_RESULT_CONFLICT", "Completed research is immutable");
          return publicJob(row);
        }
        const at = now();
        activeLease(row, token, at);
        const updated = (await tx.execute(sql`UPDATE owner_onboarding_jobs SET status = 'completed', research_receipt = ${JSON.stringify(receipt)}::jsonb,
          lease_token = NULL, lease_expires_at = NULL, last_error_code = NULL, completed_at = ${at}::timestamptz,
          revision = revision + 1, updated_at = ${at}::timestamptz WHERE id = ${id} RETURNING *`)).rows[0];
        return publicJob(updated);
      });
    },

    async retry(scope: OnboardingScope, id: string, token: string) {
      return scoped(scope, async (tx, valid) => {
        const row = await job(tx, valid, id);
        const at = now();
        activeLease(row, token, at);
        const status = row.attempts < row.max_attempts ? "retry_wait" : "failed";
        const available = new Date(new Date(at).getTime() + Math.min(4_000, 1_000 * 2 ** (row.attempts - 1))).toISOString();
        const updated = (await tx.execute(sql`UPDATE owner_onboarding_jobs SET status = ${status}, lease_token = NULL, lease_expires_at = NULL,
          last_error_code = 'RESEARCH_UNAVAILABLE', available_at = ${available}::timestamptz,
          revision = revision + 1, updated_at = ${at}::timestamptz WHERE id = ${id} RETURNING *`)).rows[0];
        return publicJob(updated);
      });
    },

    async attachExistingPrivatePreview(rawScope: OnboardingScope, id: string, preview: { draftId: string; revision: number }) {
      if (!Number.isSafeInteger(preview.revision) || preview.revision < 1) fail(400, "PREVIEW_REVISION_REQUIRED", "Exact private draft revision is required");
      const scope = onboardingScopeSchema.parse(rawScope);
      // Match existing approval lock order: draft, restaurant/owner, then job.
      return database.transaction(async tx => {
        const draft = (await tx.execute(sql`SELECT id, status, revision, expires_at FROM owner_ai_action_drafts
          WHERE id = ${preview.draftId} AND restaurant_id = ${scope.restaurantId}
            AND created_by_user_id = ${scope.ownerId} FOR UPDATE`)).rows[0];
        if (!draft) fail(409, "PRIVATE_PREVIEW_REQUIRED", "A current private draft owned by this business is required");
        await owner(tx, scope);
        const row = await job(tx, scope, id);
        if (row.status !== "completed") fail(409, "RESEARCH_NOT_COMPLETED", "Complete research before linking a private preview");
        if (row.preview_draft_id) {
          if (row.preview_draft_id !== preview.draftId || row.preview_draft_revision !== preview.revision) fail(409, "PREVIEW_BINDING_CONFLICT", "The saved private preview reference is immutable");
          return publicJob(row);
        }
        const at = now();
        if (draft.status !== "draft" || draft.revision !== preview.revision || new Date(draft.expires_at).getTime() <= new Date(at).getTime()) fail(409, "PRIVATE_PREVIEW_REQUIRED", "A current exact private draft revision is required");
        const updated = (await tx.execute(sql`UPDATE owner_onboarding_jobs SET preview_draft_id = ${preview.draftId}, preview_draft_revision = ${preview.revision},
          revision = revision + 1, updated_at = ${at}::timestamptz WHERE id = ${id} RETURNING *`)).rows[0];
        return publicJob(updated);
      });
    },

    async startServiceBuild(): Promise<never> {
      return fail(503, "SERVICE_BUILD_INTEGRATION_REQUIRED", "Verified service payment and build integration are not enabled");
    },
  };
}
