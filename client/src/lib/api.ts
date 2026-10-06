/**
 * API base URL configuration
 * In development, force same-origin (relative paths only).
 * In production, allow optional VITE_API_BASE_URL; otherwise same-origin.
 */
const IS_DEV = import.meta.env.DEV;
const SHARED_API_FALLBACK = "https://www.mealscout.us";
const MEALSCOUT_API_ORIGIN_FALLBACK = "https://mealscout.onrender.com";

function isTradeScoutPlatformHostname(hostname: string): boolean {
  return hostname === "thetradescout.com" || hostname.endsWith(".thetradescout.com");
}

function isMealScoutSameOriginPath(path: string): boolean {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return normalizedPath.startsWith("/api/");
}

function resolveApiBaseUrl() {
  if (IS_DEV) return "";

  const fromEnv = String(import.meta.env.VITE_API_BASE_URL || "").trim();
  if (typeof window === "undefined") {
    return fromEnv.replace(/\/+$/, "");
  }

  const host = window.location.hostname.toLowerCase();
  // Deployment hosts should use same-origin API calls. Vercel proxies /api/*
  // through its rewrite, while each Render service owns its matching backend
  // and session cookie (including isolated preview services).
  if (host.endsWith(".vercel.app") || host.endsWith(".onrender.com")) {
    return "";
  }

  // The TradeScout host consumes the existing MealScout API contract.
  if (!fromEnv && isTradeScoutPlatformHostname(host)) {
    return SHARED_API_FALLBACK;
  }

  // MealScout production hosts should never silently fall back to same-origin
  // when no API base is configured, because www may be frontend-only.
  if (
    !fromEnv &&
    (host === "www.mealscout.us" ||
      host === "mealscout.us" ||
      host.endsWith(".mealscout.us"))
  ) {
    return MEALSCOUT_API_ORIGIN_FALLBACK;
  }

  return fromEnv.replace(/\/+$/, "");
}

export const API_BASE_URL = resolveApiBaseUrl();

/**
 * Build API URL with base path
 */
export function apiUrl(path: string): string {
  if (typeof window !== "undefined") {
    const host = window.location.hostname.toLowerCase();
    const isMealScoutHost =
      host === "www.mealscout.us" ||
      host === "mealscout.us" ||
      host.endsWith(".mealscout.us");
    // Every MealScout API request stays same-origin. The production host proxies
    // /api/* to the backend, preserving the active first-party session cookie.
    if (isMealScoutHost && isMealScoutSameOriginPath(path)) {
      return path.startsWith("/") ? path : `/${path}`;
    }
  }
  // Remove leading slash from path to avoid double slashes
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  return API_BASE_URL ? `${API_BASE_URL}/${cleanPath}` : `/${cleanPath}`;
}

/**
 * Build auth redirect URL.
 * On TradeScout hosts, force Facebook OAuth app context to "tradescout".
 */
export function authUrl(path: string): string {
  const url = apiUrl(path);
  if (typeof window === "undefined") return url;

  const host = window.location.hostname.toLowerCase();
  const isMealScoutHost =
    host === "www.mealscout.us" ||
    host === "mealscout.us" ||
    host.endsWith(".mealscout.us");
  const isAuthPath = path.startsWith("/api/auth/");

  // Keep auth/session bootstrap same-origin on MealScout hosts so
  // login cookies and redirect state stay on the active web domain.
  if (isMealScoutHost && isAuthPath) {
    const sameOriginUrl = new URL(path, window.location.origin).toString();
    return sameOriginUrl;
  }

  const isTradeScoutHost = isTradeScoutPlatformHostname(host);
  if (!isTradeScoutHost || !isAuthPath) {
    return url;
  }

  const normalized = new URL(url, window.location.origin);
  if (!normalized.searchParams.get("app")) {
    normalized.searchParams.set("app", "tradescout");
  }
  return normalized.toString();
}
