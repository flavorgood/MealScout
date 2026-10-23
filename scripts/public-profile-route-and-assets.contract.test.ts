import { readFileSync } from "node:fs";

const vercelConfig = JSON.parse(readFileSync("vercel.json", "utf8"));
const rewrites: Array<{ source?: string; destination?: string }> = Array.isArray(
  vercelConfig?.rewrites,
)
  ? vercelConfig.rewrites
  : [];
const routes: Array<{ src?: string; dest?: string; status?: number; handle?: string }> =
  Array.isArray(vercelConfig?.routes) ? vercelConfig.routes : [];

const hasAssetsPassThrough = rewrites.some(
  (rule) => rule.source === "/assets/:path*" && rule.destination === "/assets/:path*",
);
if (!hasAssetsPassThrough) {
  throw new Error("vercel.json must preserve /assets/* as static assets before SPA fallback");
}

const hasStaticPassThrough = rewrites.some(
  (rule) => rule.source === "/static/:path*" && rule.destination === "/static/:path*",
);
if (!hasStaticPassThrough) {
  throw new Error("vercel.json must preserve /static/* as static assets before SPA fallback");
}

// Exact app routes (for example /deals/featured) also use index.html. Select
// the catch-all by its path parameter, then test its matching behavior.
const spaFallbackRule = rewrites.find(
  (rule) => rule.destination === "/index.html" && rule.source?.startsWith("/:path("),
);
if (!spaFallbackRule?.source?.endsWith(")")) {
  throw new Error("vercel.json must include the parameterized SPA fallback");
}
const spaFallback = new RegExp(`^/(?:${spaFallbackRule.source.slice(7, -1)})$`);
if (["/assets/missing.js", "/static/missing.css"].some((path) => spaFallback.test(path))) {
  throw new Error("SPA fallback must explicitly exclude /assets and /static paths");
}
if (!["/scout", "/restaurant/example", "/caterer/example"].every((path) => spaFallback.test(path))) {
  throw new Error("SPA fallback must preserve ordinary app routes after explicit proxy rules");
}

const filesystemHandleIndex = routes.findIndex((rule) => rule.handle === "filesystem");
if (filesystemHandleIndex < 0) {
  throw new Error("vercel.json routes must include handle=filesystem before SPA route fallback");
}

const assetJsCss404RuleIndex = routes.findIndex(
  (rule) => rule.src === "/assets/(.*\\.(?:js|css))" && rule.status === 404,
);
if (assetJsCss404RuleIndex < 0) {
  throw new Error("vercel.json routes must return 404 for missing /assets/*.js and /assets/*.css");
}
if (assetJsCss404RuleIndex <= filesystemHandleIndex) {
  throw new Error("Asset 404 guard must be evaluated after filesystem static lookup");
}

const staticJsCss404RuleIndex = routes.findIndex(
  (rule) => rule.src === "/static/(.*\\.(?:js|css))" && rule.status === 404,
);
if (staticJsCss404RuleIndex < 0) {
  throw new Error("vercel.json routes must return 404 for missing /static/*.js and /static/*.css");
}
if (staticJsCss404RuleIndex <= filesystemHandleIndex) {
  throw new Error("Static 404 guard must be evaluated after filesystem static lookup");
}

const routesSpaFallbackRuleIndex = routes.findIndex(
  (rule) => rule.src === "/(.*)" && rule.dest === "/index.html",
);
if (routesSpaFallbackRuleIndex < 0) {
  throw new Error("vercel.json routes must include SPA fallback to /index.html");
}
if (
  routesSpaFallbackRuleIndex <= assetJsCss404RuleIndex ||
  routesSpaFallbackRuleIndex <= staticJsCss404RuleIndex
) {
  throw new Error("SPA fallback must be evaluated after JS/CSS asset 404 guards");
}

const scoutAdapters = readFileSync("client/src/features/scout/scoutAdapters.ts", "utf8");
if (!scoutAdapters.includes("buildPublicProfilePath({")) {
  throw new Error("Scout truck scene links must use clean public profile path helper");
}
if (scoutAdapters.includes("`/p/truck/${id}`")) {
  throw new Error("Scout truck scene links must not emit legacy /p/truck canonical paths");
}

const cityLanding = readFileSync("client/src/pages/city-landing.tsx", "utf8");
if (cityLanding.includes("href={`/restaurant/${truck.id}`}")) {
  throw new Error("City landing truck cards must not link to /restaurant/:id");
}
if (!cityLanding.includes("truckPublicProfilePath(truck)")) {
  throw new Error("City landing truck cards must use clean public profile path helper");
}
if (cityLanding.includes("`/p/truck/${id}`")) {
  throw new Error("City landing truck cards must not emit legacy /p/truck paths");
}

const publicProfilePage = readFileSync("client/src/pages/public-profile.tsx", "utf8");
const publicProfileComponentIndex = publicProfilePage.indexOf(
  "export default function PublicProfilePage()",
);
if (publicProfileComponentIndex < 0) {
  throw new Error("PublicProfilePage component must be present");
}

const loadingGuardIndex = publicProfilePage.indexOf(
  "if ((isLoading || cleanBusinessLoading) && !invalidRestaurantRoute)",
  publicProfileComponentIndex,
);
const canonicalUrlIndex = publicProfilePage.indexOf(
  "const canonicalUrl =",
  publicProfileComponentIndex,
);
const affiliateRefEffectIndex = publicProfilePage.indexOf(
  "const routeRef = String(cleanBusinessRoute?.affiliateTag || \"\").trim();",
  publicProfileComponentIndex,
);
if (loadingGuardIndex < 0 || canonicalUrlIndex < 0 || affiliateRefEffectIndex < 0) {
  throw new Error("PublicProfilePage must keep expected loading, canonical, and affiliate-ref blocks");
}
if (affiliateRefEffectIndex > loadingGuardIndex) {
  throw new Error("PublicProfilePage affiliate-ref hook must run before conditional loading returns");
}

const postGuardSetup = publicProfilePage.slice(loadingGuardIndex, canonicalUrlIndex);
const hookAfterGuard = postGuardSetup.match(/\buse(?:State|Effect|Memo|Callback|Ref|Query)\s*\(/);
if (hookAfterGuard) {
  throw new Error(
    `PublicProfilePage must not call React/query hooks after conditional profile guards: ${hookAfterGuard[0]}`,
  );
}

console.log("public-profile-route-and-assets.contract: PASS");
