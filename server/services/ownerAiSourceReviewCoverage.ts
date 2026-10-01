import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { telemetryEvents } from "@shared/schema";
import { canonicalSourceSection } from "@shared/ownerAiSourceFacts";
import { db } from "../db";

export const SOURCE_REVIEW_RUN_EVENT = "private_owner_ai_source_review_run_v1";
export const SOURCE_REVIEW_HOLD_REASONS = [
  "missing_official_source", "source_unavailable_or_redirected", "conflicting_public_facts",
  "date_identity_or_public_access_verification", "unsupported_or_incomplete_extraction",
  "owner_or_adapter_invalid", "public_profile_ineligible", "authority_or_context_changed",
  "receipt_integrity_collision", "unclassified_receipt_hold", "unclassified_failure",
] as const;
const OUTCOMES = ["proposal_ready", "held", "held_authority_or_capture_changed", "already_reviewed", "prior_owner_review", "in_progress", "missing_profile", "unclassified_outcome"] as const;
type Kind = "food" | "native_content";
export type SourceReviewOutcome = { status: string; reason?: string };
const hash = (value: unknown) => createHash("sha256").update(canonicalSourceSection(value)).digest("hex");
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const countsFor = <T extends readonly string[]>(keys: T) => z.object(Object.fromEntries(keys.map(key => [key, count])) as Record<T[number], typeof count>).strict();
const summarySchema = z.object({
  version: z.literal(1), kind: z.enum(["food", "native_content"]), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  runId: z.string().uuid(), startedAt: z.string().datetime(), completedAt: z.string().datetime(),
  total: count, outcomes: countsFor(OUTCOMES), held: count, proposals: count, ownerConsentRequiredForProposals: count,
  reasons: countsFor(SOURCE_REVIEW_HOLD_REASONS), heldOutcomesRecorded: count, heldWithReason: count, heldWithoutReason: count,
  classifiedHeld: count, unclassifiedHeld: count, reasonsAreExclusive: z.literal(true),
  createsOwnerDrafts: z.literal(false), publishes: z.literal(false), historicalReasonsInferred: z.literal(false),
}).strict();
type Summary = z.infer<typeof summarySchema>;

// Read only the existing workflow's error code. Never persist exception text,
// profile/owner IDs, source URLs or packet/body data in a run summary.
export function sourceReviewFailureReason(error: unknown): typeof SOURCE_REVIEW_HOLD_REASONS[number] {
  const code = error && typeof error === "object" ? String((error as any).code || (error as any).message || "") : "";
  if (["SOURCE_FACT_OWNER_OR_ADAPTER_INVALID", "CURRENT_NATIVE_OWNER_REQUIRED"].includes(code)) return "owner_or_adapter_invalid";
  if (["SOURCE_FACT_PUBLIC_ACCESS_REQUIRED", "PUBLIC_NATIVE_PROFILE_REQUIRED", "CONTENT_FIELD_NOT_PUBLIC", "SOURCE_FACT_FIELD_NOT_PUBLIC"].includes(code)) return "public_profile_ineligible";
  if (["SOURCE_FACT_OFFICIAL_SOURCE_SET_CHANGED", "SOURCE_FACT_OFFICIAL_SOURCE_REMOVED", "STALE_NATIVE_CONTEXT"].includes(code)) return "authority_or_context_changed";
  if (["SOURCE_REVIEW_RECEIPT_COLLISION", "SOURCE_FACT_VALUE_MISMATCH", "SOURCE_FACT_UNSUPPORTED_CHANGE"].includes(code)) return "receipt_integrity_collision";
  if (["SOURCE_FACT_UNAVAILABLE", "SOURCE_FACT_LINK_UNAVAILABLE", "SOURCE_FACT_CHANGED_OR_UNAVAILABLE"].includes(code)) return "source_unavailable_or_redirected";
  if (["SOURCE_FACT_CONFLICT", "SOURCE_FACT_CHANGED_OR_CONFLICTING"].includes(code)) return "conflicting_public_facts";
  if (["SOURCE_FACT_EXPIRED", "SOURCE_FACT_SCHEDULE_CONTEXT_REQUIRED", "SOURCE_FACT_SEMANTIC_SOURCE_HELD"].includes(code)) return "date_identity_or_public_access_verification";
  return "unclassified_failure";
}
export function buildSourceReviewRunCoverage(kind: Kind, day: string, results: readonly SourceReviewOutcome[], startedAt: string, completedAt = new Date().toISOString(), runId = randomUUID()): Summary {
  const outcomes = Object.fromEntries(OUTCOMES.map(key => [key, 0])) as Summary["outcomes"];
  const reasons = Object.fromEntries(SOURCE_REVIEW_HOLD_REASONS.map(key => [key, 0])) as Summary["reasons"];
  let held = 0;
  for (const result of results) {
    const status = OUTCOMES.includes(result.status as any) ? result.status as keyof typeof outcomes : "unclassified_outcome";
    outcomes[status]++;
    if (status === "held" || status === "held_authority_or_capture_changed") {
      held++;
      const reason = SOURCE_REVIEW_HOLD_REASONS.includes(result.reason as any) ? result.reason as keyof typeof reasons : "unclassified_failure";
      reasons[reason]++;
    }
  }
  const unclassifiedHeld = reasons.unclassified_failure + reasons.unclassified_receipt_hold;
  return summarySchema.parse({ version: 1, kind, day, runId, startedAt, completedAt, total: results.length, outcomes,
    held, proposals: outcomes.proposal_ready, ownerConsentRequiredForProposals: outcomes.proposal_ready,
    reasons, heldOutcomesRecorded: held, heldWithReason: held - unclassifiedHeld, heldWithoutReason: unclassifiedHeld, classifiedHeld: held - unclassifiedHeld, unclassifiedHeld,
    reasonsAreExclusive: true, createsOwnerDrafts: false, publishes: false, historicalReasonsInferred: false });
}
function validSummary(row: any): Summary | null {
  const p = row?.properties;
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const { integritySha256, ...rest } = p;
  const parsed = summarySchema.safeParse(rest);
  if (!parsed.success || row.eventName !== SOURCE_REVIEW_RUN_EVENT || row.userId != null || row.id !== "owner-source-run-v1:" + parsed.data.runId || integritySha256 !== hash(rest)) return null;
  const s = parsed.data;
  if (Date.parse(s.completedAt) < Date.parse(s.startedAt)
    || Object.values(s.outcomes).reduce((a, b) => a + b, 0) !== s.total
    || s.held !== s.outcomes.held + s.outcomes.held_authority_or_capture_changed
    || s.proposals !== s.outcomes.proposal_ready || s.ownerConsentRequiredForProposals !== s.proposals
    || Object.values(s.reasons).reduce((a, b) => a + b, 0) !== s.held
    || s.heldOutcomesRecorded !== s.held || s.heldWithReason !== s.classifiedHeld || s.heldWithoutReason !== s.unclassifiedHeld
    || s.unclassifiedHeld !== s.reasons.unclassified_failure + s.reasons.unclassified_receipt_hold
    || s.classifiedHeld + s.unclassifiedHeld !== s.held) return null;
  return s;
}
export async function persistSourceReviewRunCoverage(kind: Kind, day: string, results: readonly SourceReviewOutcome[], startedAt: string, database: any = db) {
  const summary = buildSourceReviewRunCoverage(kind, day, results, startedAt);
  try {
    await database.insert(telemetryEvents).values({ id: "owner-source-run-v1:" + summary.runId, eventName: SOURCE_REVIEW_RUN_EVENT, userId: null,
      createdAt: new Date(summary.completedAt), properties: { ...summary, integritySha256: hash(summary) } });
    return { persisted: true, summary };
  } catch {
    // Log the same safe counters with a false persistence flag; an unavailable
    // telemetry store must not masquerade as a durable completed receipt.
    return { persisted: false, summary };
  }
}
export async function readLatestSourceReviewRunCoverage(database: any = db) {
  const output: Record<Kind, { latestValidRun: Summary | null; invalidReceipts: number }> = {
    food: { latestValidRun: null, invalidReceipts: 0 }, native_content: { latestValidRun: null, invalidReceipts: 0 },
  };
  for (const kind of ["food", "native_content"] as const) {
    const rows = await database.select().from(telemetryEvents).where(and(eq(telemetryEvents.eventName, SOURCE_REVIEW_RUN_EVENT), sql`${telemetryEvents.properties}->>'kind' = ${kind}`)).orderBy(desc(telemetryEvents.createdAt)).limit(30);
    for (const row of rows) {
      const summary = validSummary(row);
      if (!summary) { output[kind].invalidReceipts++; continue; }
      output[kind].latestValidRun = summary; break;
    }
  }
  // Per-run summaries are never summed across retries/concurrent runs. Skipped
  // or prior-owner observations are separate outcomes, not new source holds.
  return { runs: output, historicalReasonsInferred: false, readsOnly: true, aggregation: "latest_valid_run_per_lane" };
}
