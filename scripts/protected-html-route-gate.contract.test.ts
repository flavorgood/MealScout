/**
 * Offline contract: protected HTML routes never fall through to the marketing
 * homepage shell for unauthenticated requests. Auth path is structural.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROTECTED_HTML_PATH_PREFIXES,
  assertNotMarketingHomepageShell,
  buildProtectedRouteInterstitialHtml,
  guardUnauthenticatedProtectedHtml,
  isProtectedHtmlPath,
  normalizeRequestPath,
} from "../server/seo/protectedHtmlRoutes.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function read(rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

const MARKETING_TITLE = "MealScout | Discover Local Food Near You";

assert.ok(isProtectedHtmlPath("/admin"));
assert.ok(isProtectedHtmlPath("/admin/control-center"));
assert.ok(isProtectedHtmlPath("/dashboard"));
assert.ok(isProtectedHtmlPath("/vendor-dashboard"));
assert.ok(isProtectedHtmlPath("/supplier-portal"));
assert.ok(isProtectedHtmlPath("/host/dashboard"));
assert.ok(isProtectedHtmlPath("/restaurant/dashboard"));
assert.ok(isProtectedHtmlPath("/supplier/dashboard"));
assert.equal(isProtectedHtmlPath("/supplier/some-public-slug"), false);
assert.equal(isProtectedHtmlPath("/truck/demo"), false);
assert.equal(isProtectedHtmlPath("/"), false);
assert.equal(normalizeRequestPath("/admin/"), "/admin");

for (const prefix of ["/admin", "/dashboard", "/vendor-dashboard", "/supplier-portal"]) {
  assert.ok(
    (PROTECTED_HTML_PATH_PREFIXES as readonly string[]).includes(prefix),
    `prefix list must include ${prefix}`,
  );
}

const interstitial = buildProtectedRouteInterstitialHtml("/admin");
assert.equal(interstitial.includes(MARKETING_TITLE), false);
assert.equal(/application\/ld\+json/i.test(interstitial), false);
assert.match(interstitial, /noindex/i);
assert.match(interstitial, /Sign in required/i);
assert.match(interstitial, /\/login\?redirect=/);
assertNotMarketingHomepageShell(interstitial);

const exerciseGuard = (authenticated: boolean) => {
  let status = 200;
  let body = "";
  let nextCalls = 0;
  const req = {
    method: "GET",
    path: "/restaurant/dashboard",
    get: () => "text/html",
    isAuthenticated: () => authenticated,
    user: authenticated ? { id: "owner-1" } : undefined,
  } as any;
  const res = {
    status(value: number) {
      status = value;
      return this;
    },
    setHeader() {},
    send(value: string) {
      body = value;
      return this;
    },
  } as any;
  guardUnauthenticatedProtectedHtml(req, res, () => {
    nextCalls += 1;
  });
  return { status, body, nextCalls };
};
const anonymousDashboard = exerciseGuard(false);
assert.equal(anonymousDashboard.status, 401);
assert.equal(anonymousDashboard.nextCalls, 0);
assert.match(anonymousDashboard.body, /noindex/i);
assert.match(anonymousDashboard.body, /Sign in required/i);
const authenticatedDashboard = exerciseGuard(true);
assert.equal(authenticatedDashboard.nextCalls, 1);
assert.equal(authenticatedDashboard.body, "");

const indexTs = read("server/index.ts");
assert.match(indexTs, /guardUnauthenticatedProtectedHtml/);
assert.match(indexTs, /from "\.\/seo\/protectedHtmlRoutes"/);

const viteTs = read("server/vite.ts");
assert.match(viteTs, /guardUnauthenticatedProtectedHtml/);

const gateSrc = read("server/seo/protectedHtmlRoutes.ts");
assert.match(gateSrc, /isAuthenticatedRequest/);
assert.match(gateSrc, /return next\(\)/);
assert.equal(
  /\bGPTBot\b|req\.get\(\s*["']user-agent["']|headers\[["']user-agent["']\]/i.test(
    gateSrc,
  ),
  false,
  "protected-route enforcement must not key off user-agent",
);

const vercel = JSON.parse(read("vercel.json"));
const rewrites: Array<{ source?: string; destination?: string }> = vercel.rewrites || [];
const routes: Array<{ src?: string; dest?: string }> = vercel.routes || [];

for (const prefix of ["admin", "dashboard", "vendor-dashboard", "supplier-portal"]) {
  const rewriteHit = rewrites.some(
    (rule) =>
      String(rule.source || "").includes(`/${prefix}`) &&
      String(rule.destination || "").includes(`mealscout.onrender.com/${prefix}`),
  );
  assert.ok(rewriteHit, `vercel rewrites must proxy /${prefix} to Render before SPA fallback`);
  const routeHit = routes.some(
    (rule) =>
      String(rule.src || "").includes(prefix) &&
      String(rule.dest || "").includes(`mealscout.onrender.com/${prefix}`),
  );
  assert.ok(routeHit, `vercel routes must proxy /${prefix} to Render before SPA fallback`);
}

const spaRewriteIndex = rewrites.findIndex((rule) => rule.destination === "/index.html");
const adminRewriteIndex = rewrites.findIndex(
  (rule) => rule.source === "/admin" && String(rule.destination || "").includes("/admin"),
);
assert.ok(spaRewriteIndex > adminRewriteIndex, "protected rewrites must precede SPA fallback");

// Own titles for owner pages: the dashboard interstitial names the page it
// guards, while unregistered gated paths keep the shared sign-in title.
const dashboardInterstitial = buildProtectedRouteInterstitialHtml("/dashboard");
assert.ok(
  dashboardInterstitial.includes("<title>Dashboard | MealScout</title>"),
  "dashboard interstitial must carry the dashboard's own title",
);
assert.ok(
  interstitial.includes("<title>MealScout | Sign in required</title>"),
  "unregistered gated paths keep the shared sign-in title",
);

// /orders and /menu-builder documents must reach the same Render shell path
// as /dashboard — the edge otherwise serves them the generic shell title and
// no server-side title can ever reach the document.
for (const prefix of ["orders", "menu-builder"]) {
  const rewriteHit = rewrites.some(
    (rule) =>
      String(rule.source || "") === `/${prefix}` &&
      String(rule.destination || "").includes(`mealscout.onrender.com/${prefix}`),
  );
  assert.ok(rewriteHit, `vercel rewrites must proxy /${prefix} to Render for its own page title`);
  const routeHit = routes.some(
    (rule) =>
      String(rule.src || "").includes(prefix) &&
      String(rule.dest || "").includes(`mealscout.onrender.com/${prefix}`),
  );
  assert.ok(routeHit, `vercel routes must proxy /${prefix} to Render for its own page title`);
}

assert.match(viteTs, /appPageTitles/, "shell serving must apply registered app page titles");

const robots = read("client/public/robots.txt");
assert.ok(robots.includes("Disallow: /admin"));
assert.ok(robots.includes("Disallow: /dashboard"));

assert.ok(existsSync(path.join(root, "server/seo/protectedHtmlRoutes.ts")));

console.log("protected-html-route-gate offline checks: PASS");
console.log(
  "Authenticated path (manual/contract): session-authenticated GET continues via next() to SPA handlers in server/vite.ts serveStatic/setupVite; unauthenticated receives 401 interstitial from guardUnauthenticatedProtectedHtml.",
);
