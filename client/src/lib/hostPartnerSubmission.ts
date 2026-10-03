export type HostPartnerReceipt = { leadId: string; emailed: boolean };

export const HOST_PARTNER_CONFIRMATION_UNAVAILABLE =
  "We could not confirm whether your request was saved. Your details are still here. No automatic retry was made.";

/** Accept only the existing server's explicit persistence receipt, not a generic HTTP 200. */
export function parseHostPartnerReceipt(value: unknown): HostPartnerReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(HOST_PARTNER_CONFIRMATION_UNAVAILABLE);
  }
  const data = value as Record<string, unknown>;
  if (
    data.ok !== true || typeof data.leadId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(data.leadId) || typeof data.emailed !== "boolean"
  ) {
    throw new Error(HOST_PARTNER_CONFIRMATION_UNAVAILABLE);
  }
  return { leadId: data.leadId, emailed: data.emailed };
}

/** One deliberate submission. A timeout/uncertain response never triggers a second write. */
export async function submitHostPartnerRequest(
  payload: Record<string, unknown>,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<HostPartnerReceipt> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timeoutMs = options.timeoutMs ?? 20000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000) {
    throw new Error(HOST_PARTNER_CONFIRMATION_UNAVAILABLE);
  }
  if (options.signal?.aborted) throw new Error(HOST_PARTNER_CONFIRMATION_UNAVAILABLE);
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  try {
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)("/api/public/host-partner-leads", {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch {
      throw new Error(HOST_PARTNER_CONFIRMATION_UNAVAILABLE);
    }
    if (!response.ok) {
      if (response.status === 400) throw new Error("Check your details and try again.");
      if (response.status === 429) throw new Error("Too many requests. Please wait before trying again.");
      if (response.status === 503) throw new Error("Host requests are temporarily unavailable. Your details are still here.");
      throw new Error(HOST_PARTNER_CONFIRMATION_UNAVAILABLE);
    }
    if (!/^application\/(?:[a-z0-9.-]+\+)?json(?:\s*;|\s*$)/i.test(response.headers.get("content-type") || "")) {
      throw new Error(HOST_PARTNER_CONFIRMATION_UNAVAILABLE);
    }
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new Error(HOST_PARTNER_CONFIRMATION_UNAVAILABLE); }
    if (controller.signal.aborted) throw new Error(HOST_PARTNER_CONFIRMATION_UNAVAILABLE);
    return parseHostPartnerReceipt(data);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
