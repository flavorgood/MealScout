/**
 * Protected HTML route gate.
 *
 * Unauthenticated GET/HEAD requests to private app entry paths must never
 * fall through to the marketing SPA homepage shell (title / H1 / JSON-LD).
 * Enforcement is session-based — never user-agent based.
 */
import type { Request, Response, NextFunction } from "express";
import { appPageTitleForPath } from "./appPageTitles";

/** Entry prefixes disallowed in robots.txt plus clearly related dashboards. */
export const PROTECTED_HTML_PATH_PREFIXES = [
  "/admin",
  "/dashboard",
  "/vendor-dashboard",
  "/supplier-portal",
  "/staff",
  "/user-dashboard",
  "/restaurant-owner-dashboard",
  "/host/dashboard",
  "/event-coordinator/dashboard",
  "/supplier/dashboard",
  "/restaurant/dashboard",
] as const;

const MARKETING_HOMEPAGE_TITLE = "MealScout | Discover Local Food Near You";

export function normalizeRequestPath(pathValue: string): string {
  const raw = String(pathValue || "/");
  if (!raw.startsWith("/")) return `/${raw}`;
  if (raw.length > 1 && raw.endsWith("/")) return raw.replace(/\/+$/, "") || "/";
  return raw;
}

export function isProtectedHtmlPath(pathValue: string): boolean {
  const path = normalizeRequestPath(pathValue).toLowerCase();
  return PROTECTED_HTML_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildProtectedRouteInterstitialHtml(requestPath: string): string {
  const safePath = escapeHtml(normalizeRequestPath(requestPath));
  const loginHref = `/login?redirect=${encodeURIComponent(normalizeRequestPath(requestPath))}`;
  const safeLoginHref = escapeHtml(loginHref);
  // Pages with a registered own title are named in the tab even on the
  // sign-in interstitial; other gated paths keep the shared sign-in title.
  const pageTitle = appPageTitleForPath(requestPath)?.title ?? "MealScout | Sign in required";
  // The gate still answers 401 and never serves the app shell, but a person
  // who lands here should end up on the real sign-in screen, not a dead-end
  // page: forward immediately (meta refresh + script), with the link kept
  // as the no-script/no-refresh fallback.
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow, noarchive" />
    <meta http-equiv="refresh" content="0; url=${safeLoginHref}" />
    <title>${escapeHtml(pageTitle)}</title>
    <script>window.location.replace(${JSON.stringify(loginHref)});</script>
  </head>
  <body>
    <main>
      <h1>Sign in required</h1>
      <p>This MealScout workspace page is private.</p>
      <p>Requested path: <code>${safePath}</code></p>
      <p>Taking you to sign in&hellip; <a href="${safeLoginHref}">Sign in to continue</a></p>
    </main>
  </body>
</html>`;
}

export function assertNotMarketingHomepageShell(html: string): void {
  if (html.includes(MARKETING_HOMEPAGE_TITLE)) {
    throw new Error("protected route response must not include marketing homepage title");
  }
  if (/application\/ld\+json/i.test(html) && /Discover Local Food/i.test(html)) {
    throw new Error("protected route response must not include marketing homepage JSON-LD");
  }
}

function wantsHtml(req: Request): boolean {
  const accept = String(req.get("Accept") || "");
  if (!accept || accept.includes("*/*")) return true;
  return accept.includes("text/html") || accept.includes("application/xhtml+xml");
}

function isAuthenticatedRequest(req: Request): boolean {
  const anyReq = req as Request & {
    isAuthenticated?: () => boolean;
    user?: { id?: string | number };
  };
  if (typeof anyReq.isAuthenticated === "function") {
    try {
      if (anyReq.isAuthenticated()) return true;
    } catch {
      // fall through
    }
  }
  return Boolean(anyReq.user?.id);
}

/**
 * Express middleware: block unauthenticated HTML access to protected prefixes.
 * Authenticated sessions continue to the real SPA/app handlers.
 */
export function guardUnauthenticatedProtectedHtml(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!["GET", "HEAD"].includes(req.method)) return next();

  const pathValue = normalizeRequestPath(req.path || "/");
  if (!isProtectedHtmlPath(pathValue)) return next();

  // Never intercept APIs or static assets under a protected prefix.
  if (
    pathValue.startsWith("/api/") ||
    /\.(js|mjs|css|map|png|jpg|jpeg|gif|svg|ico|woff2?|webmanifest|txt|xml)$/i.test(
      pathValue,
    )
  ) {
    return next();
  }

  if (!wantsHtml(req) && req.method === "GET") {
    // Non-HTML probes still must not receive the marketing homepage.
    // Return a compact private JSON/text response instead.
    if (isAuthenticatedRequest(req)) return next();
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.setHeader("Cache-Control", "no-store");
    res.status(401).json({
      error: "authentication_required",
      path: pathValue,
    });
    return;
  }

  if (isAuthenticatedRequest(req)) return next();

  const html = buildProtectedRouteInterstitialHtml(pathValue);
  assertNotMarketingHomepageShell(html);

  res.status(401);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.send(html);
}
