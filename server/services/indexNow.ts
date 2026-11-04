type IndexNowSubmitResult = {
  ok: boolean;
  status: number;
  provider: string;
  submitted: number;
  body?: string;
};

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

function resolveIndexNowKeyLocation(params: {
  configured: string;
  host: string;
  key: string;
}) {
  const defaultLocation = params.key
    ? `https://${params.host}/${encodeURIComponent(params.key)}.txt`
    : "";
  const configured = params.configured.trim();
  if (!configured) return defaultLocation;
  try {
    const parsed = new URL(configured);
    const configuredHost = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const host = params.host.toLowerCase().replace(/^www\./, "");
    const expectedPath = `/${params.key}.txt`;
    if (
      configured.includes("<") ||
      configured.includes(">") ||
      configuredHost !== host ||
      parsed.pathname !== expectedPath
    ) {
      return defaultLocation;
    }
    parsed.protocol = "https:";
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return defaultLocation;
  }
}

export function getIndexNowConfig() {
  // On by default (owner direction 2026-11-04, set-it-and-forget-it):
  // IndexNow runs unless INDEXNOW_ENABLED is explicitly "false". The key
  // is still required before anything can be submitted — without one the
  // state is "awaiting_key" (on, waiting for its key), not "disabled".
  const enabled =
    String(process.env.INDEXNOW_ENABLED || "").trim().toLowerCase() !== "false";
  const key = String(process.env.INDEXNOW_KEY || "").trim();
  const host = String(
    process.env.INDEXNOW_HOST || process.env.SITEMAP_SITE_URL || "www.mealscout.us",
  )
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  const keyLocation = String(process.env.INDEXNOW_KEY_LOCATION || "").trim();

  return {
    enabled,
    key,
    host,
    keyLocation: resolveIndexNowKeyLocation({ configured: keyLocation, host, key }),
    state: !enabled ? "disabled" : key ? "ready" : "awaiting_key",
  };
}

export async function submitIndexNowUrls(
  urls: string[],
): Promise<IndexNowSubmitResult> {
  const config = getIndexNowConfig();
  if (!config.enabled) {
    return {
      ok: false,
      status: 400,
      provider: "IndexNow",
      submitted: 0,
      body: "INDEXNOW_ENABLED=false (IndexNow disabled)",
    };
  }
  if (!config.key || !config.host) {
    return {
      ok: false,
      status: 400,
      provider: "IndexNow",
      submitted: 0,
      body: "Missing INDEXNOW_KEY or INDEXNOW_HOST",
    };
  }

  const deduped = Array.from(
    new Set(
      urls
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .slice(0, 10000),
    ),
  );

  if (deduped.length === 0) {
    return {
      ok: false,
      status: 400,
      provider: "IndexNow",
      submitted: 0,
      body: "No URLs provided",
    };
  }

  const payload = {
    host: config.host,
    key: config.key,
    keyLocation: config.keyLocation,
    urlList: deduped,
  };

  const response = await fetch(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text().catch(() => "");
  return {
    ok: response.ok,
    status: response.status,
    provider: "IndexNow",
    submitted: deduped.length,
    body: bodyText || undefined,
  };
}

