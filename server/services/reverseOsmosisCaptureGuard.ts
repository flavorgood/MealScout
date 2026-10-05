import { performance } from "node:perf_hooks";
import { ReverseOsmosisError } from "@tradescout-infinity/reverse-osmosis";

// Leaves ten seconds of the durable research lease for its terminal DB write.
export const MEALSCOUT_SOURCE_CAPTURE_MAX_MS = 20_000;
export interface SourceCaptureOptions { signal?: AbortSignal; budgetMs?: number }
export interface SourceCaptureGuard {
  signal: AbortSignal;
  checkpoint(): void;
  wait<T>(work: () => Promise<T>): Promise<T>;
}
const cancelled = () => new ReverseOsmosisError("reverse-osmosis:capture-cancelled");
export function assertSourceCaptureActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

export async function withSourceCaptureBudget<T>(
  options: SourceCaptureOptions,
  work: (guard: SourceCaptureGuard) => Promise<T>,
): Promise<T> {
  const budget = options.budgetMs ?? MEALSCOUT_SOURCE_CAPTURE_MAX_MS;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > MEALSCOUT_SOURCE_CAPTURE_MAX_MS) {
    throw new ReverseOsmosisError("reverse-osmosis:capture-budget-invalid");
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new ReverseOsmosisError("reverse-osmosis:capture-signal-invalid");
  }
  const controller = new AbortController();
  const until = performance.now() + budget;
  let deadlineExpired = false;
  const error = () => deadlineExpired
    ? new ReverseOsmosisError("reverse-osmosis:capture-deadline")
    : cancelled();
  const abort = () => { if (!controller.signal.aborted) controller.abort(); };
  const expire = () => {
    if (!controller.signal.aborted) { deadlineExpired = true; controller.abort(); }
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(expire, budget);
  const checkpoint = () => {
    if (!controller.signal.aborted && performance.now() >= until) expire();
    if (controller.signal.aborted) throw error();
  };
  const guard: SourceCaptureGuard = {
    signal: controller.signal,
    checkpoint,
    async wait<R>(action: () => Promise<R>): Promise<R> {
      checkpoint();
      let onAbort: (() => void) | undefined;
      const stopped = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(error());
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([
          stopped,
          Promise.resolve().then(() => { checkpoint(); return action(); }),
        ]);
      } finally {
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      }
    },
  };
  try {
    const result = await guard.wait(() => work(guard));
    checkpoint();
    return result;
  } catch (failure) {
    checkpoint();
    throw failure;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
