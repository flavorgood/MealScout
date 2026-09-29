/** Request evidence only. None of these labels establish a unique human or external causation. */
export type DiscoverySignalRequest = {
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  get?: (name: string) => unknown;
};

export type DiscoveryTrafficQuality = {
  version: 2;
  basis: "server_observed_request_signals";
  classification:
    | "browser_candidate"
    | "discovery_crawler"
    | "infrastructure_monitor"
    | "automation_signal"
    | "qa_signal"
    | "unclassified";
};

const CAMPAIGN_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  google: "google", "google.com": "google", google_maps: "google_maps",
  "maps.google.com": "google_maps", bing: "bing", "bing.com": "bing",
  chatgpt: "chatgpt", "chatgpt.com": "chatgpt", openai: "chatgpt", "openai.com": "chatgpt",
  facebook: "facebook", "facebook.com": "facebook", fb: "facebook", "fb.com": "facebook",
  instagram: "instagram", "instagram.com": "instagram",
});
// Explicit supported roots, not a wildcard like google.<anything>. Other roots remain unknown.
const GOOGLE_ROOTS = ["google.com", "google.co.uk", "google.ca", "google.com.au", "google.co.nz", "google.de", "google.fr", "google.co.in", "google.co.jp"];
const PROVIDER_ROOTS: ReadonlyArray<readonly [string, string]> = [
  ["chatgpt.com", "chatgpt"], ["openai.com", "chatgpt"], ["bing.com", "bing"],
  ["facebook.com", "facebook"], ["fb.com", "facebook"], ["instagram.com", "instagram"],
];

function scalar(value: unknown, limit: number): string | null {
  if (typeof value !== "string" || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value.trim() || null;
}

function header(req: DiscoverySignalRequest | null | undefined, name: string): string | null {
  try {
    return scalar(typeof req?.get === "function" ? req.get(name) : req?.headers?.[name], 2048);
  } catch {
    return null;
  }
}

function referrerUrl(value: unknown): URL | null {
  const raw = scalar(value, 2048);
  if (!raw || !/^https?:\/\//i.test(raw) || raw.includes("\\")) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password || parsed.port) return null;
    return parsed;
  } catch {
    return null;
  }
}

function matchesRoot(host: string, root: string): boolean {
  return host === root || host.endsWith("." + root);
}

export function discoverySourceFromReferrer(value: unknown): string | null {
  const parsed = referrerUrl(value);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  for (const root of GOOGLE_ROOTS) {
    if (matchesRoot(host, "maps." + root)) return "google_maps";
    if (matchesRoot(host, root)) {
      return /^\/maps(?:\/|$)/i.test(parsed.pathname) ? "google_maps" : "google";
    }
  }
  for (const [root, source] of PROVIDER_ROOTS) {
    if (matchesRoot(host, root)) return source;
  }
  return null;
}

export function deriveDiscoverySourceEvidence(req: DiscoverySignalRequest | null | undefined): {
  source: string;
  basis: "campaign_label" | "referrer_host_label" | "unavailable";
} {
  const campaign = scalar(req?.query?.utm_source, 80)?.toLowerCase();
  if (campaign && Object.prototype.hasOwnProperty.call(CAMPAIGN_SOURCES, campaign)) {
    return { source: CAMPAIGN_SOURCES[campaign], basis: "campaign_label" };
  }
  const source = discoverySourceFromReferrer(header(req, "referer"));
  return source ? { source, basis: "referrer_host_label" } : { source: "unknown", basis: "unavailable" };
}

export function deriveDiscoverySource(req: DiscoverySignalRequest | null | undefined): string {
  return deriveDiscoverySourceEvidence(req).source;
}

export function deriveDiscoverySearchSurface(req: DiscoverySignalRequest | null | undefined): string | null {
  const medium = scalar(req?.query?.utm_medium, 40);
  if (medium && /^[a-z0-9_-]+$/i.test(medium)) return medium;
  return referrerUrl(header(req, "referer"))?.hostname.toLowerCase() || null;
}

export function classifyDiscoveryRequest(req: DiscoverySignalRequest | null | undefined): DiscoveryTrafficQuality {
  let classification: DiscoveryTrafficQuality["classification"] = "unclassified";
  const ua = header(req, "user-agent") || "";
  // Exclusion markers never grant access or promote a request to a human classification.
  if (header(req, "x-mealscout-qa") === "1" || header(req, "x-mealscout-traffic-class") === "qa_automation") {
    classification = "qa_signal";
  } else if (/uptimerobot|better uptime|betterstack|pingdom|statuscake|site24x7|healthchecks\.io/i.test(ua)) {
    classification = "infrastructure_monitor";
  } else if (/googlebot|bingbot|oai-searchbot|chatgpt-user|claudebot|anthropic-ai|facebookexternalhit|ahrefsbot|semrushbot|duckduckbot|applebot|bytespider|yandexbot/i.test(ua)) {
    classification = "discovery_crawler";
  } else if (/bot\b|crawler|spider|headless|playwright|puppeteer|selenium|curl\/|wget\/|python-requests|httpx|node-fetch|undici|postman|google-inspectiontool|sway-runtime-proof|mealscout.*(?:proof|qa|smoke)/i.test(ua)) {
    classification = "automation_signal";
  } else if (/^Mozilla\/5\.0\b/.test(ua)
    && /AppleWebKit|Gecko\//.test(ua)
    && ["same-origin", "same-site", "cross-site"].includes(header(req, "sec-fetch-site") || "")
    && ["cors", "same-origin"].includes(header(req, "sec-fetch-mode") || "")) {
    classification = "browser_candidate";
  }
  return { version: 1, basis: "server_observed_request_signals", classification };
}

export function discoveryRequestActorType(quality: DiscoveryTrafficQuality): "unknown" | "bot" | "internal" {
  if (
    quality.classification === "automation_signal" ||
    quality.classification === "discovery_crawler" ||
    quality.classification === "infrastructure_monitor"
  ) return "bot";
  if (quality.classification === "qa_signal") return "internal";
  return "unknown";
}
