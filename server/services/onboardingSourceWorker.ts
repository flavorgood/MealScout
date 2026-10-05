import { createHash } from "node:crypto";
import { businessPostIdentifier } from "../../shared/businessPostIdentifier";
import { onboardingResearchInputSchema, onboardingResearchReceiptSchema, onboardingScopeSchema, type OnboardingResearchReceipt, type OnboardingScope } from "../../shared/onboardingJobs";
import { reverseOsmosisEnvelopeSchema } from "../../shared/reverseOsmosis";
import { createOnboardingJobService, onboardingRequestHash, OnboardingJobError, type OnboardingDatabase } from "./onboardingJobs";
import { assertSourceCaptureActive, withSourceCaptureBudget, type SourceCaptureOptions } from "./reverseOsmosisCaptureGuard";

// No env switch, startup registration, polling loop or default native adapter.
// A separately authorized verified production binding is required to change this.
export const ONBOARDING_SOURCE_PROVIDER_EXECUTION_ENABLED = false;
export const ONBOARDING_WORKER_TERMINAL_RESERVE_MS = 10_000;
export interface OnboardingSourceAdapter {
  readonly kind: "deterministic" | "native";
  prepare(input: Readonly<{ restaurantId: string; userId: string; postId: string; publishPlatforms: readonly [] }>, options: SourceCaptureOptions): Promise<{ packet: unknown; expectedVersions: unknown; holds: string[] }>;
}
type Jobs = ReturnType<typeof createOnboardingJobService>;
type Job = Awaited<ReturnType<Jobs["read"]>>;
export interface OnboardingWorkerResult {
  status: "disabled" | "idle" | "reused" | "unclaimed" | "completed" | "cancelled" | "retry_wait" | "failed" | "lease_lost" | "owner_changed";
  jobId?: string;
  job?: Job;
}
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 16) throw new OnboardingJobError(409, "RESEARCH_BINDING_MISMATCH", "Native context exceeds its bound");
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key], depth + 1)]));
  return value;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const lost = () => { throw new OnboardingJobError(409, "ONBOARDING_LEASE_STALE", "This worker lease is no longer current"); };
const ownerChanged = (error: unknown) => error instanceof OnboardingJobError && error.code === "CURRENT_OWNER_REQUIRED";

function sourceReceipt(scope: OnboardingScope, input: ReturnType<typeof onboardingResearchInputSchema.parse>, declaredUrl: string, postId: string, result: Awaited<ReturnType<OnboardingSourceAdapter["prepare"]>>, at: number): OnboardingResearchReceipt {
  const packet = result.packet as { reverseOsmosis?: unknown; profile?: { menuUrl?: unknown }; social?: { enabled?: unknown } } | undefined;
  const envelope = reverseOsmosisEnvelopeSchema.parse(packet?.reverseOsmosis);
  const { capture, inbound } = envelope, nativeScope = inbound.scope;
  const qualify = (id: string) => /^\d+$/.test(id) ? nativeScope.accountId + "_" + id : id;
  if (nativeScope.ownerId !== scope.ownerId || nativeScope.businessId !== scope.restaurantId || nativeScope.subjectId !== scope.restaurantId ||
      inbound.direction !== "social-to-native" || inbound.causalProvenance || envelope.outbound.length || packet?.social?.enabled ||
      inbound.eventId !== capture.providerPostId || inbound.sourceVersion !== capture.sourceVersion ||
      hash(inbound.fields.profile) !== hash(capture.profile) || hash(inbound.fields.capture) !== hash(capture) ||
      inbound.expectedNativeVersion !== hash(result.expectedVersions) ||
      capture.providerPostId !== qualify(postId) || capture.providerPostId !== qualify(businessPostIdentifier(capture.sourceUrl)) ||
      !capture.providerPostId.startsWith(nativeScope.accountId + "_") ||
      capture.capturedAt > at || capture.expiresAt <= at || capture.expiresAt <= capture.capturedAt ||
      capture.expiresAt - capture.capturedAt > 24 * 60 * 60_000 || !capture.profile.menuUrl || packet?.profile?.menuUrl !== capture.profile.menuUrl) {
    throw new OnboardingJobError(409, "RESEARCH_BINDING_MISMATCH", "Native source does not match this saved owner, business and selected post");
  }
  return onboardingResearchReceiptSchema.parse({
    version: 1, requestHash: onboardingRequestHash(scope, input),
    sources: [{ url: declaredUrl, capturedAt: new Date(capture.capturedAt).toISOString(), contentHash: capture.sourceVersion, excerpt: "Menu URL from the selected connected business Page post." }],
    observations: [{ field: "profile.menuUrl", value: capture.profile.menuUrl, sourceUrl: declaredUrl }],
    unknowns: ["Scores, service terms and cadence remain unset.", ...(input.officialLinks.length > 1 ? ["Other declared links require separately verified source adapters."] : []), ...(capture.holds.length ? ["Other captured source fields require independent review."] : [])],
    sourceBinding: {
      kind: "mealscout.facebook-post.v1", ownerId: scope.ownerId, restaurantId: scope.restaurantId,
      provider: "facebook", accountId: nativeScope.accountId, postId: capture.providerPostId,
      declaredSourceUrl: declaredUrl, capturedSourceUrl: capture.sourceUrl,
      bindingRevision: inbound.businessBindingRevision, sourceVersion: capture.sourceVersion,
      publicProofHash: capture.publicProofHash, expectedNativeVersion: inbound.expectedNativeVersion,
      expiresAt: new Date(capture.expiresAt).toISOString(),
    },
    currentScore: null, conditionalProjectedScore: null,
  });
}

/** Internal one-job worker. Persisted SQL service owns current-owner/token fences.
 * Ports are trusted server capabilities, never request body or client callbacks.
 * Deterministic adapters are for isolated fixtures; native execution stays off.
 */
export function createMealScoutOnboardingWorker(database: OnboardingDatabase, adapters: { source?: OnboardingSourceAdapter; clock?: () => Date } = {}) {
  const clock = adapters.clock ?? (() => new Date());
  const source = adapters.source;
  const enabled = Boolean(source && (source.kind === "deterministic" || ONBOARDING_SOURCE_PROVIDER_EXECUTION_ENABLED));
  const jobs = createOnboardingJobService(database, clock);
  const disabled = (): OnboardingWorkerResult => ({ status: "disabled" });
  async function read(scope: OnboardingScope, id: string, signal?: AbortSignal) {
    return withSourceCaptureBudget({ signal }, guard => guard.wait(() => jobs.read(scope, id)));
  }
  async function runOne(rawScope: OnboardingScope, id: string, signal?: AbortSignal): Promise<OnboardingWorkerResult> {
    if (!enabled) return disabled();
    const scope = Object.freeze(onboardingScopeSchema.parse(rawScope));
    let lease: Awaited<ReturnType<Jobs["claim"]>> | undefined;
    const remaining = () => lease ? Math.floor(Date.parse(lease.leaseExpiresAt) - clock().getTime()) : 0;
    const checkpoint = () => { assertSourceCaptureActive(signal); };
    const leaseCheckpoint = () => { checkpoint(); if (remaining() <= 0) lost(); };
    try {
      checkpoint();
      const previous = await read(scope, id, signal);
      checkpoint();
      if (previous.status === "completed") return { status: "reused", jobId: id, job: previous };
      lease = await withSourceCaptureBudget({ signal }, guard =>
        jobs.claim(scope, id, () => { guard.checkpoint(); checkpoint(); }));
      checkpoint();
      if (!lease) return { status: "unclaimed", jobId: id };
      const input = onboardingResearchInputSchema.parse(lease.job.input);
      const candidates: Array<{ url: string; postId: string }> = [];
      for (const url of input.officialLinks) {
        try { candidates.push({ url, postId: businessPostIdentifier(url) }); } catch { /* unsupported links remain held */ }
      }
      let receipt: OnboardingResearchReceipt;
      if (candidates.length !== 1) {
        receipt = onboardingResearchReceiptSchema.parse({
          version: 1, requestHash: onboardingRequestHash(scope, input), sources: [], observations: [],
          unknowns: ["Select exactly one supported public Facebook business Page post; source binding remains unresolved.", "Scores, service terms and cadence remain unset."],
          currentScore: null, conditionalProjectedScore: null,
        });
      } else {
        const budgetMs = Math.min(20_000, remaining() - ONBOARDING_WORKER_TERMINAL_RESERVE_MS);
        if (budgetMs < 1) lost();
        const selected = candidates[0];
        receipt = await withSourceCaptureBudget({ signal, budgetMs }, async guard => {
          const request = Object.freeze({ restaurantId: scope.restaurantId, userId: scope.ownerId, postId: selected.postId, publishPlatforms: Object.freeze([]) as readonly [] });
          const prepared = await guard.wait(() => source!.prepare(request, { signal: guard.signal, budgetMs }));
          guard.checkpoint();
          return sourceReceipt(scope, input, selected.url, selected.postId, prepared, clock().getTime());
        });
      }
      leaseCheckpoint();
      const terminalBudget = Math.min(ONBOARDING_WORKER_TERMINAL_RESERVE_MS, remaining());
      const job = await withSourceCaptureBudget({ signal, budgetMs: terminalBudget }, guard =>
        jobs.complete(scope, id, lease!.leaseToken, receipt, () => { guard.checkpoint(); leaseCheckpoint(); }));
      return { status: "completed", jobId: id, job };
    } catch (error) {
      if (ownerChanged(error)) return { status: "owner_changed", jobId: id };
      const cancelled = Boolean(signal?.aborted || (error as { code?: unknown })?.code === "reverse-osmosis:capture-cancelled");
      if (!lease) return { status: cancelled ? "cancelled" : "unclaimed", jobId: id };
      if (remaining() < 1) return { status: "lease_lost", jobId: id };
      try {
        // Retire only this still-current lease, even when its caller cancelled.
        // Its own bounded control protects rollback; it does not restart capture.
        const job = await withSourceCaptureBudget({ budgetMs: Math.min(ONBOARDING_WORKER_TERMINAL_RESERVE_MS, remaining()) }, guard =>
          jobs.retry(scope, id, lease!.leaseToken, () => { guard.checkpoint(); if (remaining() <= 0) lost(); }));
        return { status: cancelled ? "cancelled" : job.status === "failed" ? "failed" : "retry_wait", jobId: id, job };
      } catch (retireError) {
        return { status: ownerChanged(retireError) ? "owner_changed" : "lease_lost", jobId: id };
      }
    }
  }
  async function runNext(signal?: AbortSignal): Promise<OnboardingWorkerResult> {
    if (!enabled) return disabled();
    try {
      const candidates = await withSourceCaptureBudget({ signal }, guard => guard.wait(() => jobs.recoverable()));
      assertSourceCaptureActive(signal);
      if (!candidates.length) return { status: "idle" };
      const next = candidates[0]; // one persisted job per explicit invocation
      return runOne({ ownerId: next.ownerId, restaurantId: next.restaurantId }, next.id, signal);
    } catch (error) {
      return { status: signal?.aborted ? "cancelled" : ownerChanged(error) ? "owner_changed" : "unclaimed" };
    }
  }
  return { runOne, runNext, providerExecutionEnabled: ONBOARDING_SOURCE_PROVIDER_EXECUTION_ENABLED };
}
