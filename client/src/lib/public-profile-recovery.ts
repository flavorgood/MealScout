import { normalizeSafeInternalPath } from "@shared/safeInternalPath";

export class PublicProfileReadError extends Error {
  constructor(public readonly status: number | null) {
    super("Public profile could not be loaded");
    this.name = "PublicProfileReadError";
  }
}

export const isMissingPublicProfile = (error: unknown) =>
  error instanceof PublicProfileReadError &&
  (error.status === 404 || error.status === 410);

export const isPrivatePublicProfile = (error: unknown) =>
  error instanceof PublicProfileReadError &&
  (error.status === 401 || error.status === 403);

export type PublicProfileLoginIntent = "save" | "recommend" | "follow";

export function publicProfileLoginHref(
  fallback?: string,
  intent?: PublicProfileLoginIntent,
): string {
  const current = typeof window === "undefined" ? null :
    normalizeSafeInternalPath(window.location.pathname + window.location.search + window.location.hash);
  const destination = current || normalizeSafeInternalPath(fallback) || "/scout";
  const intentParam = intent ? `&intent=${encodeURIComponent(intent)}` : "";
  return `/login?redirect=${encodeURIComponent(destination)}${intentParam}`;
}

export function publicProfileSignupHref(fallback?: string): string {
  const current = typeof window === "undefined" ? null :
    normalizeSafeInternalPath(window.location.pathname + window.location.search + window.location.hash);
  const destination = current || normalizeSafeInternalPath(fallback) || "/scout";
  return `/customer-signup?redirect=${encodeURIComponent(destination)}`;
}

export async function readPublicProfileJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 15_000);
  try {
    const response = await fetch(url, { credentials: "include", signal: controller.signal });
    if (!response.ok) throw new PublicProfileReadError(response.status);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        typeof (payload as { id?: unknown }).id !== "string" ||
        !(payload as { id: string }).id.trim()) {
      throw new PublicProfileReadError(null);
    }
    return payload as T;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof PublicProfileReadError) throw error;
    throw new PublicProfileReadError(null);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
