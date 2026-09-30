import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const appRoutes = readFileSync("client/src/App.tsx", "utf8");
const publicSeoPage = readFileSync("client/src/pages/public-seo-landing.tsx", "utf8");
const publicSeoClientRoute = readFileSync(
  "client/src/lib/publicSeoLandingRoute.ts",
  "utf8",
);
const publicSeoRoutes = readFileSync("server/routes/publicSeoLandingRoutes.ts", "utf8");
const publicSeoData = readFileSync("server/services/publicSeoLandingData.ts", "utf8");
const publicSeoModel = readFileSync("server/services/publicSeoLandingModel.ts", "utf8");
const publicSeoBatchTraversal = readFileSync(
  "server/services/publicSeoBatchTraversal.ts",
  "utf8",
);
const publicTruckClassification = readFileSync(
  "server/seo/publicTruckClassification.ts",
  "utf8",
);
const publicRestaurantIndexability = readFileSync(
  "server/seo/publicRestaurantIndexability.ts",
  "utf8",
);
const publicIndexabilityStart = publicRestaurantIndexability.indexOf(
  "export function evaluatePublicRestaurantIndexability",
);
const publicIndexabilityEnd = publicRestaurantIndexability.indexOf(
  "export function isPublicRestaurantIndexable",
  publicIndexabilityStart,
);
const publicIndexabilityPolicy = publicRestaurantIndexability.slice(
  publicIndexabilityStart,
  publicIndexabilityEnd,
);
if (
  publicIndexabilityStart < 0 ||
  publicIndexabilityEnd <= publicIndexabilityStart ||
  /subscription|premium|membership|billing|stripe|payment/i.test(
    publicIndexabilityPolicy,
  )
) {
  throw new Error(
    "Public profile indexability must remain tier-neutral and independent of payment state",
  );
}

const publicSeoImplementation = `${publicSeoRoutes}\n${publicSeoData}\n${publicSeoModel}`;
const routerRegistry = readFileSync("server/routes.ts", "utf8");
const seoRoutes = readFileSync("server/routes/seoRoutes.ts", "utf8");
const prerender = readFileSync("server/seo/publicProfilePrerender.ts", "utf8");
const acquisitionPrerender = readFileSync(
  "server/seo/acquisitionPrerender.ts",
  "utf8",
);
const schedulerRegistry = readFileSync(
  "server/bootstrap/registerSchedulers.ts",
  "utf8",
);
const publicSitemapPage = readFileSync(
  "client/src/pages/sitemap.tsx",
  "utf8",
);
const serverIndex = readFileSync("server/index.ts", "utf8");
const vercelConfig = readFileSync("vercel.json", "utf8");
const vercel = JSON.parse(vercelConfig);
const publicProfile = readFileSync("client/src/pages/public-profile.tsx", "utf8");
const publicDiscoveryRoutes = readFileSync(
  "server/routes/publicDiscoveryRoutes.ts",
  "utf8",
);
const publicCanonicalOrigin = readFileSync(
  "server/seo/publicCanonicalOrigin.ts",
  "utf8",
);
const publicSeoIntegration = readFileSync(
  "scripts/public-seo-landing.integration.test.ts",
  "utf8",
);
const dealDiscoveryRoutes = readFileSync(
  "server/routes/dealDiscoveryRoutes.ts",
  "utf8",
);
const publicEventAccess = readFileSync(
  "server/publicProfiles/publicEventDetailAccess.ts",
  "utf8",
);
const eventRoutes = readFileSync("server/routes/eventRoutes.ts", "utf8");
const publicEventProjection = readFileSync(
  "server/publicProfiles/toPublicEventListing.ts",
  "utf8",
);
const publicProfileUtils = readFileSync(
  "server/publicProfiles/publicProfileUtils.ts",
  "utf8",
);
const restaurantProjection = readFileSync(
  "server/publicProfiles/toPublicRestaurantProfile.ts",
  "utf8",
);
const locationProjection = readFileSync(
  "server/publicProfiles/toPublicLocationProfile.ts",
  "utf8",
);
const supplierProjection = readFileSync(
  "server/publicProfiles/toPublicSupplierProfile.ts",
  "utf8",
);
const confirmedEventTrucks = readFileSync(
  "server/services/confirmedEventTrucks.ts",
  "utf8",
);
const staticRobots = readFileSync("client/public/robots.txt", "utf8");
const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
const packageManifest = JSON.parse(readFileSync("package.json", "utf8"));

const requiredClientRoutes = [
  '"/food-trucks/:citySlug"',
  '"/food-trucks/:citySlug/:cuisineSlug"',
  '"/food-trucks-today/:city"',
  '"/food-truck-catering/:city"',
  '"/book-food-truck/:city"',
  '"/deals-today/:city"',
  '"/events-today/:city"',
  '"/city/:city/food"',
  '"/cuisine/:cuisine/:city"',
  '"/locations-with-trucks/:city"',
];

for (const snippet of requiredClientRoutes) {
  if (!appRoutes.includes(snippet)) {
    throw new Error(`SEO client route missing: ${snippet}`);
  }
}

if (!routerRegistry.includes("registerPublicSeoLandingRoutes(app);")) {
  throw new Error("Public SEO routes are not registered in server routes");
}

const requiredApiRoutes = [
  "/api/public/seo/food-trucks/:city/:cuisine",
  "/api/public/seo/food-trucks/:city",
  "/api/public/seo/food-trucks-today/:city",
  "/api/public/seo/food-truck-catering/:city",
  "/api/public/seo/book-food-truck/:city",
  "/api/public/seo/deals-today/:city",
  "/api/public/seo/events-today/:city",
  "/api/public/seo/city/:city/food",
  "/api/public/seo/cuisine/:cuisine/:city?",
  "/api/public/seo/locations-with-trucks/:city",
  "assertPublicResponseSafe",
  "profilePath",
  "primaryCtaPath",
];

for (const snippet of requiredApiRoutes) {
  if (!publicSeoImplementation.includes(snippet)) {
    throw new Error(`SEO API route/payload missing: ${snippet}`);
  }
}

const requiredSitemapSnippets = [
  "/food-trucks-today/",
  "/food-truck-catering/",
  "/book-food-truck/",
  "/deals-today/",
  "/events-today/",
  "/city/",
  "/locations-with-trucks/",
  "/cuisine/",
];
for (const snippet of requiredSitemapSnippets) {
  if (!seoRoutes.includes(snippet)) {
    throw new Error(`Sitemap missing SEO landing inclusion: ${snippet}`);
  }
}

const cityFoodRouteIndex = appRoutes.indexOf('path="/city/:city/food"');
const genericCityModeIndex = appRoutes.indexOf('path="/city/:city/:mode"');
if (cityFoodRouteIndex < 0 || genericCityModeIndex < 0 || cityFoodRouteIndex > genericCityModeIndex) {
  throw new Error("City SEO route must run before the generic city mode route");
}

for (const snippet of [
  "loadPublicSeoCityNavigationData(requestedSlug)",
  "hasFoodTrucks: navigation.totalTrucks > 0",
  "foodCuisines: navigation.foodCuisines",
  "cuisines: navigation.truckCuisines",
]) {
  if (!publicDiscoveryRoutes.includes(snippet)) {
    throw new Error(`Shared human city navigation projection missing: ${snippet}`);
  }
}
for (const snippet of [
  "export async function loadPublicSeoCityNavigationData",
  "scanPublicSeoRowsInBatches",
  "totalFood += 1",
  'if (profileType === "truck")',
  "truckCuisineCounts",
  "foodCuisineCounts",
]) {
  if (!publicSeoData.includes(snippet)) {
    throw new Error(`Uncapped city cuisine membership traversal missing: ${snippet}`);
  }
}
for (const snippet of [
  'href={`/city/${encodeURIComponent(city.slug)}/food`}',
  "city.hasFoodTrucks",
  'href={`/food-trucks/${encodeURIComponent(city.slug)}`}',
  'const href = `/cuisine/${cuisine.slug}`',
  "city.foodCuisines",
]) {
  if (!publicSitemapPage.includes(snippet)) {
    throw new Error(`Human sitemap parity missing: ${snippet}`);
  }
}
if (
  !publicDiscoveryRoutes.includes(
    "collectPublicSeoRowsInBatches<any>",
  ) ||
  !publicDiscoveryRoutes.includes("publicSeoBusinessProfileType(row) !== null")
) {
  throw new Error(
    "Related business traversal must remain deterministic and require a canonical public business type",
  );
}
if (
  !seoRoutes.includes('throw dealCityErr;') ||
  !seoRoutes.includes('throw eventCityErr;') ||
  !seoRoutes.includes('.status(503)') ||
  !seoRoutes.includes('res.setHeader("Retry-After", "60")') ||
  !seoRoutes.includes('res.setHeader("Cache-Control", "no-store")')
) {
  throw new Error(
    "Required root sitemap section failures must terminate with retryable no-store 503 semantics",
  );
}
const restaurantImageProjection = prerender.slice(
  prerender.indexOf("const resolveRestaurantImage"),
  prerender.indexOf("const resolveHostImage"),
);
if (
  restaurantImageProjection.includes("row.") ||
  !prerender.includes("resolveRestaurantImage(baseUrl, publicProfile)")
) {
  throw new Error(
    "Restaurant profile SSR media must consume the canonical projected media policy",
  );
}

const forbiddenTimeModes = [
  "food-trucks-now",
  "food-trucks-breakfast",
  "food-trucks-lunch",
  "food-trucks-dinner",
  "food-trucks-tonight",
  "food-trucks-this-weekend",
];
const retiredTimeSitemapStart = seoRoutes.indexOf(
  'app.get("/sitemap-time-pages.xml"',
);
const nextSitemapStart = seoRoutes.indexOf(
  'app.get("/sitemap-events.xml"',
  retiredTimeSitemapStart,
);
const retiredTimeSitemap = seoRoutes.slice(
  retiredTimeSitemapStart,
  nextSitemapStart,
);
if (
  retiredTimeSitemapStart < 0 ||
  nextSitemapStart <= retiredTimeSitemapStart ||
  !retiredTimeSitemap.includes("res.status(410)") ||
  !retiredTimeSitemap.includes('res.setHeader("Cache-Control", "no-store")') ||
  !retiredTimeSitemap.includes('res.setHeader("Content-Type", "text/plain; charset=utf-8")') ||
  seoRoutes.includes("Sitemap: ${baseUrl}/sitemap-time-pages.xml") ||
  staticRobots.includes("sitemap-time-pages.xml") ||
  !vercelConfig.includes('"source": "/sitemap-:name.xml"') ||
  !vercelConfig.includes('"src": "/sitemap-([\\\\w-]+)\\\\.xml"')
) {
  throw new Error(
    "The unsupported time-page child sitemap must be a proxied terminal 410 and remain unadvertised",
  );
}
if (/`\$\{baseUrl\}\/deals\/\$\{encodeURIComponent\(slug\)\}`/.test(seoRoutes)) {
  throw new Error(
    "The root sitemap must not advertise the legacy JS-only city deals route",
  );
}
for (const snippet of [
  "Pattern: /food-truck-catering/{city-slug}",
  "Pattern: /book-food-truck/{city-slug}",
  "Pattern: /truck/{slug}--{id}",
  "Pattern: /bar/{slug}--{id}",
  "Eligible profile pages are canonical public entity pages.",
  "Private account fields are never discovery facts.",
]) {
  if (!seoRoutes.includes(snippet)) {
    throw new Error(`AI public profile guidance missing: ${snippet}`);
  }
}

if (
  seoRoutes.includes("/food-trucks/pensacola-fl") ||
  seoRoutes.includes("/food-trucks/pensacola-fl/bbq") ||
  !seoRoutes.includes("Pattern: /food-trucks/{city-slug}") ||
  !seoRoutes.includes(
    "City and cuisine child pages are discoverable only when published in MealScout's sitemap.",
  )
) {
  throw new Error(
    "AI guidance must use non-clickable route templates instead of unverifiable city/cuisine examples",
  );
}
for (const mode of forbiddenTimeModes) {
  if (seoRoutes.includes(mode)) {
    throw new Error(`Unsupported time-page mode is still emitted: ${mode}`);
  }
}
if (
  !appRoutes.includes('<Route path="/events/public" component={EventsPage} />') ||
  !publicEventAccess ||
  !readFileSync("server/routes/eventRoutes.ts", "utf8").includes(
    'app.get("/api/events/public"',
  )
) {
  throw new Error("The human events SPA and public feed API must remain available");
}
for (const [sourceName, source] of [
  ["root sitemap and llms", seoRoutes],
  ["IndexNow scheduler", schedulerRegistry],
  ["acquisition SSR", acquisitionPrerender],
  ["profile SSR discovery", prerender],
  ["public sitemap navigation", publicSitemapPage],
] as const) {
  if (source.includes('/events/public')) {
    throw new Error(`${sourceName} must not advertise the deferred events SPA URL`);
  }
}
for (const snippet of [
  "eventTodayCityLastmod",
  "locationsThisWeekCityLastmod",
  "7 * 24 * 60 * 60 * 1000",
]) {
  if (!seoRoutes.includes(snippet)) {
    throw new Error(`Event/location sitemap window partition missing: ${snippet}`);
  }
}
if (
  !publicSeoData.includes("normalizeStoredLabel") ||
  /replace\(\/\\b\(best\|top\|#1\|elite\|highest quality\)/.test(
    publicSeoData,
  ) ||
  !publicSeoData.includes("city: String(activeStop?.city || city.name)") ||
  !publicSeoData.includes("city: String(row.hostCity || \"\").trim() || city.name")
) {
  throw new Error(
    "Stored identity must remain intact and time-based cards must report their matched stop/host area",
  );
}
if (
  !/eventTodayCityLastmod\.forEach[\s\S]*\/events-today\//.test(seoRoutes) ||
  !/locationsThisWeekCityLastmod\.forEach[\s\S]*\/locations-with-trucks\//.test(
    seoRoutes,
  )
) {
  throw new Error(
    "Today-only event and seven-day location sitemap memberships must remain separate",
  );
}
if (
  !/<Route\s+path="\/city\/:city\/food"\s+component=\{PublicSeoLandingPage\}\s*\/>/.test(
    appRoutes,
  )
) {
  throw new Error("City food path must render the public SEO landing component");
}
const truckCuisineRouteIndex = appRoutes.indexOf(
  'path="/food-trucks/:citySlug/:cuisineSlug"',
);
const truckCityRouteIndex = appRoutes.indexOf(
  'path="/food-trucks/:citySlug"',
);
if (
  truckCuisineRouteIndex < 0 ||
  truckCuisineRouteIndex > truckCityRouteIndex ||
  !/<Route\s+path="\/food-trucks\/:citySlug\/:cuisineSlug"\s+component=\{PublicSeoLandingPage\}\s*\/>/.test(
    appRoutes,
  )
) {
  throw new Error(
    "The specific truck-cuisine browser route must use the shared SEO page before the city-only route",
  );
}

function resolveConfiguredRoute(profilePath: string) {
  const route = vercel.routes.find(
    (candidate: { src?: string }) =>
      candidate.src && new RegExp(`^(?:${candidate.src})$`).test(profilePath),
  );
  const captures = route && profilePath.match(new RegExp(`^(?:${route.src})$`));
  const destination = route?.dest?.replace(
    /\$(\d+)/g,
    (_: string, index: string) => captures?.[Number(index)] ?? "",
  );
  return { route, destination };
}

for (const kind of ["caterer", "private-chef", "chef"]) {
  const profilePath = `/${kind}/fixture-profile--fixture-id`;
  const { route, destination } = resolveConfiguredRoute(profilePath);
  const rewrite = vercel.rewrites.find((candidate: { source: string }) => {
    const match = candidate.source.match(/^\/:kind\(([^)]+)\)\/:path\*$/);
    return match?.[1].split("|").includes(kind);
  });
  if (
    route?.has || route?.continue ||
    destination !== `https://mealscout.onrender.com${profilePath}` ||
    rewrite?.has ||
    rewrite?.destination !== "https://mealscout.onrender.com/:kind/:path*"
  ) {
    throw new Error(`Vercel service profile routing must preserve kind and id: ${kind}`);
  }
}

for (const snippet of [
  '"/food-trucks/:city/:cuisine"',
  '"/food-trucks/:city"',
  '"/food-trucks-today/:city"',
  '"/food-truck-catering/:city"',
  '"/book-food-truck/:city"',
  '"/city/:city/food"',
  '"/deals-today/:city"',
  '"/events-today/:city"',
  '"/locations-with-trucks/:city"',
  '"/cuisine/:cuisine/:city"',
]) {
  if (!vercelConfig.includes(snippet)) {
    throw new Error(`Vercel SEO rewrite missing: ${snippet}`);
  }
}

if (!publicSeoModel.includes('case "city"') || !publicSeoModel.includes("encodedCity")) {
  throw new Error("SEO API canonical mapping for city pages is missing");
}
if (!publicSeoModel.includes('case "cuisine"') || !publicSeoModel.includes("encodedCuisine")) {
  throw new Error("SEO API canonical mapping for cuisine pages is missing");
}
if (
  !publicSeoRoutes.includes("req.params.city === undefined ? null") ||
  !publicSeoModel.includes(
    "request.citySlug !== null && request.citySlug !== undefined",
  ) ||
  !publicSeoModel.includes("if (mustResolveCity && !city)")
) {
  throw new Error(
    "Optional city segments must preserve presence and fail closed before listing queries",
  );
}

for (const snippet of [
  '"/caterer/:slug"',
  '"/private-chef/:slug"',
  '"/chef/:slug"',
  '"caterer"',
  '"private_chef"',
]) {
  if (!prerender.includes(snippet)) {
    throw new Error(`Canonical service profile prerender contract missing: ${snippet}`);
  }
}
for (const snippet of [
  'app.get("/sitemap-services.xml"',
  "isIndexableServiceProfileRow",
  "serviceProfileRows.forEach",
  '"Allow: /caterer/"',
  '"Allow: /private-chef/"',
  "sitemap-services.xml",
]) {
  if (!seoRoutes.includes(snippet)) {
    throw new Error(`Service profile sitemap/crawler contract missing: ${snippet}`);
  }
}

const requiredPrerenderRoutes = [
  "/food-trucks/:city/:cuisine",
  "/food-trucks/:city",
  "/food-trucks-today/:city",
  "/food-truck-catering/:city",
  "/book-food-truck/:city",
  "/deals-today/:city",
  "/events-today/:city",
  "/city/:city/food",
  "/cuisine/:cuisine/:city?",
  "/locations-with-trucks/:city",
];
for (const snippet of requiredPrerenderRoutes) {
  if (!prerender.includes(snippet)) {
    throw new Error(`Prerender SEO route missing: ${snippet}`);
  }
}

const bannedClaimPhrases = [" top-rated ", " #1 ", " elite ", " highest quality "];
const routeCopy = publicSeoImplementation.toLowerCase().replace(/\s+/g, " ");
for (const phrase of bannedClaimPhrases) {
  if (routeCopy.includes(phrase)) {
    throw new Error(`Banned ranking claim introduced in public SEO routes: ${phrase.trim()}`);
  }
}

if (!publicSeoPage.includes("canonicalUrl")) {
  throw new Error("Public SEO page is missing canonical metadata wiring");
}
if (
  (prerender.match(/label: "List or claim your food truck"/g) || []).length < 5 ||
  (prerender.match(/href: "\/for-food-trucks"/g) || []).length < 3 ||
  !publicSeoPage.includes('"food-trucks-cuisine"') ||
  !publicSeoPage.includes('"food-trucks-today"') ||
  !publicSeoPage.includes('"food-truck-catering"') ||
  !publicSeoPage.includes('"book-food-truck"') ||
  !publicSeoPage.includes('href="/for-food-trucks"') ||
  !publicSeoPage.includes("List or claim your food truck") ||
  !publicSeoPage.includes('eventType: "discovery_cta_click"') ||
  !publicSeoPage.includes('targetPath: "/for-food-trucks"')
) {
  throw new Error(
    "Every food-truck landing family must connect SSR and hydrated users to the repaired list/claim funnel",
  );
}

for (const snippet of [
  "loadLanding(input)",
  "loadLanding: typeof loadPublicSeoLandingData = loadPublicSeoLandingData",
  'resolution.kind === "not_found"',
  'if (resolution.kind === "not_found") return null',
  "res.status(404)",
  "projectPublicSeoLandingForHtml",
  "listingHtml: listing.listingHtml",
  "landingGate((req)",
  ".status(503)",
  'content="noindex,follow"',
  "payload.total === 0",
  'setHeader("Cache-Control", "no-store")',
]) {
  if (!prerender.includes(snippet)) {
    throw new Error(`Prerender is missing the shared SEO landing contract: ${snippet}`);
  }
}

for (const snippet of [
  'res.setHeader("Retry-After", "60")',
  'res.setHeader("Cache-Control", "no-store")',
  ".status(503)",
  'resolution.kind === "not_found"',
  "res.status(404)",
]) {
  if (!publicSeoRoutes.includes(snippet)) {
    throw new Error(`SEO API failure contract missing: ${snippet}`);
  }
}

for (const snippet of [
  "isPublicSeoLandingRestaurantEligible",
  "ownerEmail: users.email",
  ".innerJoin(users",
  "cityIdentityWhere",
  "publicSeoCityIdentityMatches",
  "canonicalCuisineWhere",
  "publicSeoCuisineMatches",
  "buildPublicTruckOperatingPlans",
  "filterPublicSeoTrucksActiveToday",
]) {
  if (!publicSeoData.includes(snippet)) {
    throw new Error(`Shared landing data policy missing: ${snippet}`);
  }
}
if (/ilike\((?:restaurants|hosts)\.(?:city|address)/.test(publicSeoData)) {
  throw new Error(
    "SEO landing membership must not use substring city/address matching",
  );
}
if (/ilike\(restaurants\.cuisineType/.test(publicSeoData)) {
  throw new Error("SEO landing cuisine membership must use canonical slug equality");
}
for (const snippet of [
  "eligibleRestaurantIds",
  "eligibleHostIds",
  "activeTruckPlans",
  "publicSeoActiveTodayStop",
  "truckCuisineLastmodByCity",
  "isIndexableRestaurantRow(candidate)",
  "sitemapCityIdentityWhere",
  "canExposeAnonymousEventDetail",
  "publicTruckClassificationWhere",
]) {
  if (!seoRoutes.includes(snippet)) {
    throw new Error(`Sitemap-to-landing parity missing: ${snippet}`);
  }
}
if (
  !publicTruckClassification.includes(
    "FOOD_TRUCK_BUSINESS_TYPE_ALIASES",
  ) ||
  !publicTruckClassification.includes("lower(btrim(coalesce(") ||
  /inArray\(restaurants\.businessType/.test(publicSeoData) ||
  /inArray\(restaurants\.businessType/.test(seoRoutes)
) {
  throw new Error(
    "Landing and sitemap SQL must share normalized legacy truck classification",
  );
}
if (/\bcityLike\b/.test(seoRoutes)) {
  throw new Error(
    "Sitemap city membership must use the canonical city/state identity, never a fuzzy cityLike term",
  );
}
const canonicalCityHelperUses =
  seoRoutes.match(/loadCanonicalSitemapCities\(\)/g)?.length || 0;
if (
  !publicSeoData.includes("normalizedTextEquals(cities.slug, citySlug)") ||
  !publicSeoData.includes(
    "sql`${cities.createdAt} desc nulls last`, asc(cities.id)",
  ) ||
  !publicSeoData.includes(
    "sql`btrim(coalesce(${cities.name}, '')) <> ''`",
  ) ||
  !publicSeoData.includes("slug: normalizeCityRegistrySlug(city.slug)") ||
  !seoRoutes.includes("normalizeCityRegistrySlug") ||
  !seoRoutes.includes(
    "sql`${cities.createdAt} desc nulls last`, asc(cities.id)",
  ) ||
  canonicalCityHelperUses < 2
) {
  throw new Error(
    "API and every city sitemap loop must share a normalized, null-safe deterministic city-registry winner",
  );
}
if (
  !publicRestaurantIndexability.includes(
    'SITEMAP_MEMBERSHIP_VERSION = "pd-v1-indexability-4"',
  ) ||
  !publicRestaurantIndexability.includes(
    'res.setHeader("X-MealScout-Sitemap-Membership", SITEMAP_MEMBERSHIP_VERSION)',
  ) ||
  publicRestaurantIndexability.includes('res.setHeader("ETag"')
) {
  throw new Error(
    "Changed sitemap eligibility must carry the bumped policy header without a body-independent fixed ETag",
  );
}
const sitemapCitiesStart = seoRoutes.indexOf(
  'app.get("/sitemap-cities.xml"',
);
const sitemapCuisinesStart = seoRoutes.indexOf(
  'app.get("/sitemap-cuisines.xml"',
);
const sitemapCitiesSource = seoRoutes.slice(
  sitemapCitiesStart,
  sitemapCuisinesStart,
);
if (
  sitemapCitiesStart < 0 ||
  sitemapCuisinesStart < sitemapCitiesStart ||
  !sitemapCitiesSource.includes(
    'loc: `${baseUrl}/city/${encodeURIComponent(slug)}/food`',
  ) ||
  !sitemapCitiesSource.includes("hasEligibleHomeCityProfile") ||
  !sitemapCitiesSource.includes("scanPublicSeoRowsInBatches") ||
  sitemapCitiesSource.includes("hasEligibleConfirmedEventInCity") ||
  sitemapCitiesSource.includes("hasEligibleManualTruckStopInCity") ||
  sitemapCitiesSource.includes("publicTruckClassificationWhere") ||
  sitemapCitiesSource.includes(
    'loc: `${baseUrl}/city/${encodeURIComponent(slug)}`',
  )
) {
  throw new Error(
    "The city sitemap must publish the shared /city/:slug/food landing, never the legacy self-canonicalizing route",
  );
}
for (const source of [publicSeoData, seoRoutes]) {
  if (!source.includes("scanPublicSeoRowsInBatches")) {
    throw new Error("Landing and sitemap candidates must traverse past raw ineligible batches");
  }
}
for (const snippet of [
  "loadBatch",
  "visitBatch",
  "offset += rows.length",
  "rows.length < batchSize",
]) {
  if (!publicSeoBatchTraversal.includes(snippet)) {
    throw new Error(`Deterministic public SEO batch traversal missing: ${snippet}`);
  }
}
for (const snippet of [
  "publicSeoBusinessProfileType(row) === \"truck\"",
  "publicSeoBusinessProfileType(row) === \"bar\"",
  'profileType !== "restaurant"',
  "indexableTruckRows.some",
]) {
  if (!seoRoutes.includes(snippet)) {
    throw new Error(`Canonical sitemap classification/traveling-truck truth missing: ${snippet}`);
  }
}
for (const snippet of [
  "canonicalPublicRestaurantProfileEntity",
  "publicSeoBusinessProfileType(row)",
  "routeEntity !== requestedEntity",
  'canonicalPublicRestaurantProfileEntity(row) !== "truck"',
  'canonicalPublicRestaurantProfileEntity(row) !== "bar"',
  'canonicalPublicRestaurantProfileEntity(row) !== "restaurant"',
  '["restaurant", "truck", "bar"].includes(entity)',
  "canonicalEntity !== entity",
  "entityType: canonicalEntity",
]) {
  if (!publicDiscoveryRoutes.includes(snippet)) {
    throw new Error(`Canonical typed public profile identity missing: ${snippet}`);
  }
}
for (const snippet of [
  "resolveCanonicalProfileCity",
  '"@type": "WebPage"',
  '"@type": "BreadcrumbList"',
  '"@id": profileEntityId',
  'mainEntityOfPage: { "@id": profilePageId }',
  "dateModified: profileUpdatedAt",
  "/food-truck-catering/",
  "/book-food-truck/",
  "const locationSchema = {",
  "const supplierSchema = {",
  "#location",
  "#supplier",
  'sameAs: [publicProfile.websiteUrl].filter(Boolean)',
]) {
  if (!prerender.includes(snippet)) {
    throw new Error(`Profile discoverability graph missing: ${snippet}`);
  }
}

for (const snippet of [
  "resolveOwnerPublicProfile",
  "users.publicProfileSettings",
  "toPublicRestaurantProfile",
  "toPublicLocationProfile",
  "toPublicSupplierProfile",
  "publicProfile.phonePublic",
  "publicProfile.addressPublicLabel",
]) {
  if (!prerender.includes(snippet)) {
    throw new Error(`Profile SSR privacy projection missing: ${snippet}`);
  }
}
if (
  !publicProfileUtils.includes("resolvePublicProfileVisibility") ||
  !publicProfileUtils.includes('input.type === "phone"') ||
  !publicProfileUtils.includes("isSafePhone(rawHref)") ||
  !publicProfileUtils.includes("export const normalizePublicUrl") ||
  !publicProfileUtils.includes("parsed.username") ||
  !publicProfileUtils.includes("parsed.password") ||
  !publicProfileUtils.includes('raw.startsWith("//")') ||
  !restaurantProjection.includes("const exposeProfileCoordinates = Boolean(addressPublicLabel)") ||
  (restaurantProjection.match(/input\.showContact === false/g) || []).length < 4 ||
  !locationProjection.includes("input.showAddress !== false") ||
  (locationProjection.match(/input\.showContact === false/g) || []).length < 5 ||
  locationProjection.includes("row.notes") ||
  !supplierProjection.includes("input.showAddress !== false") ||
  !supplierProjection.includes("input.showContact === false") ||
  !prerender.includes("publicProfile.socialLinks.instagramUrl")
) {
  throw new Error(
    "Saved location/contact fields and CTAs must follow shared visibility and safe-scheme policy",
  );
}
for (const [name, source] of [
  ["restaurant", restaurantProjection],
  ["location", locationProjection],
  ["supplier", supplierProjection],
] as const) {
  if (!source.includes("normalizePublicUrl")) {
    throw new Error(`${name} projection must normalize direct public URL fields`);
  }
}
if (
  !restaurantProjection.includes("export function projectPublicRestaurantMedia") ||
  !publicSeoData.includes("projectPublicRestaurantMedia(row)") ||
  !confirmedEventTrucks.includes("projectPublicRestaurantMedia(row)")
) {
  throw new Error(
    "Landing cards and confirmed event trucks must share the accepted public merchant media projection",
  );
}
const hostPrerenderSource = prerender.slice(
  prerender.indexOf("async function hostPage"),
  prerender.indexOf("async function eventPage"),
);
if (hostPrerenderSource.includes("row.notes")) {
  throw new Error("Internal host notes must not become public location copy");
}
const canonicalHostSource = publicDiscoveryRoutes.slice(
  publicDiscoveryRoutes.indexOf('if (entity === "host")'),
  publicDiscoveryRoutes.indexOf('if (entity === "deal")'),
);
if (/stripe|row\.notes/i.test(canonicalHostSource)) {
  throw new Error(
    "Anonymous canonical host truth must not reveal notes or payment-onboarding state",
  );
}
for (const snippet of [
  "sendPrerenderUnavailable",
  'setHeader("X-Robots-Tag", "noindex,follow")',
  'String(req.params.slug || "").trim().toLowerCase() === "public"',
  'String(req.params.slug || "").trim().toLowerCase() === "reviews"',
  'setHeader("X-Robots-Tag", "noindex,nofollow,noarchive")',
  'String(req.params.id || "").trim().toLowerCase() === "dashboard"',
]) {
  if (!prerender.includes(snippet)) {
    throw new Error(`Profile SSR failure/reserved-route contract missing: ${snippet}`);
  }
}
if (
  !publicEventAccess.includes("eventType: unknown") ||
  !publicDiscoveryRoutes.includes("eventType: row.eventType")
) {
  throw new Error("Anonymous event JSON must provide the required private-event truth");
}
for (const snippet of [
  "eventType: events.eventType",
  "eventName: events.name",
  "isPublicDiscoveryEligibleEntity",
  "canExposeAnonymousEventDetail",
  "eventType: row.eventType",
]) {
  if (!publicSeoData.includes(snippet) || !seoRoutes.includes(snippet)) {
    throw new Error(
      `Anonymous event collection/sitemap eligibility missing: ${snippet}`,
    );
  }
}
if (!publicEventAccess.includes('=== "private_event"')) {
  throw new Error("Anonymous event eligibility must reject private events");
}
const publicEventDetailSource = eventRoutes.slice(
  eventRoutes.indexOf('app.get("/api/public/events/:eventId"'),
  eventRoutes.indexOf("// Pensacola Report lead magnet"),
);
if (
  !publicEventDetailSource.includes("canExposeAnonymousEventDetail") ||
  !publicEventDetailSource.includes("canExposeAuthorizedPaidEventDetail") ||
  !publicEventDetailSource.includes("verifyRestaurantOwnership") ||
  !publicEventDetailSource.includes('"manageParkingPass"') ||
  !publicEventDetailSource.includes("hostPriceCents: row.hostPriceCents")
) {
  throw new Error(
    "Event detail must preserve anonymous privacy and require exact owned-truck authorization for a paid booking price",
  );
}
const eventPrerenderRouteSource = prerender.slice(
  prerender.indexOf("const eventDetailGate"),
  prerender.indexOf('app.get(\n    "/deals/:city"'),
);
for (const snippet of [
  "req.isAuthenticated?.()",
  'res.setHeader("Cache-Control", "private, no-store")',
  'res.setHeader("X-Robots-Tag", "noindex,nofollow,noarchive")',
  "return next()",
]) {
  if (!eventPrerenderRouteSource.includes(snippet)) {
    throw new Error(
      `Authenticated paid event HTML must reach a private SPA shell: ${snippet}`,
    );
  }
}
for (const priceKey of [
  "hostPriceCents",
  "breakfastPriceCents",
  "lunchPriceCents",
  "dinnerPriceCents",
  "dailyPriceCents",
  "weeklyPriceCents",
  "monthlyPriceCents",
]) {
  if (publicEventProjection.includes(`    ${priceKey},`)) {
    throw new Error(`Anonymous event feeds must strip ${priceKey}`);
  }
}
for (const source of [publicSeoData, seoRoutes, prerender, publicDiscoveryRoutes]) {
  if (!source.includes("isPublicDiscoveryEligibleEntity")) {
    throw new Error("Public deal eligibility must use the shared entity integrity gate");
  }
}

const legacyDealRedirectPolicy = prerender.slice(
  prerender.indexOf("const LEGACY_CITY_DEAL_REDIRECT_QUERY_KEYS"),
  prerender.indexOf("const extractId"),
);
for (const safeQueryKey of [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "source",
  "ref",
  "reftag",
  "promosource",
]) {
  if (!legacyDealRedirectPolicy.includes(`"${safeQueryKey}"`)) {
    throw new Error(
      `Legacy city-deals redirect must preserve safe attribution key: ${safeQueryKey}`,
    );
  }
}
for (const snippet of [
  "req.originalUrl || req.url",
  "new URLSearchParams()",
  "incoming.searchParams.forEach",
  "retained >= 12",
  ".slice(0, 200)",
  "LEGACY_CITY_DEAL_REDIRECT_QUERY_KEYS.has(normalizedKey)",
  "safe.append(normalizedKey, normalizedValue)",
]) {
  if (!legacyDealRedirectPolicy.includes(snippet)) {
    throw new Error(
      `Legacy city-deals redirect attribution safety is missing: ${snippet}`,
    );
  }
}
const legacyDealRedirectRouteStart = prerender.indexOf('"/deals/:city"');
const legacyDealRedirectRouteEnd = prerender.indexOf(
  '"/deal/:slug"',
  legacyDealRedirectRouteStart,
);
const legacyDealRedirectRoute = prerender.slice(
  legacyDealRedirectRouteStart,
  legacyDealRedirectRouteEnd,
);
if (
  legacyDealRedirectRouteStart < 0 ||
  legacyDealRedirectRouteEnd < legacyDealRedirectRouteStart ||
  !legacyDealRedirectRoute.includes('citySlug === "featured"') ||
  !legacyDealRedirectRoute.includes("res.redirect(") ||
  !legacyDealRedirectRoute.includes("308,") ||
  !legacyDealRedirectRoute.includes(
    "${legacyCityDealRedirectQuery(req)}",
  )
) {
  throw new Error(
    "Legacy /deals/:city must preserve bounded attribution through a fixed 308 canonical redirect while excluding /deals/featured",
  );
}
const legacyDealRewriteIndex = vercel.rewrites.findIndex(
  (entry: any) => entry.source === "/deals/:city",
);
const featuredDealRewriteIndex = vercel.rewrites.findIndex(
  (entry: any) => entry.source === "/deals/featured",
);
const publicEventsRewriteIndex = vercel.rewrites.findIndex(
  (entry: any) => entry.source === "/events/public",
);
const broadProfileRewriteIndex = vercel.rewrites.findIndex(
  (entry: any) => String(entry.source || "").startsWith("/:kind("),
);
const legacyDealRouteIndex = vercel.routes.findIndex(
  (entry: any) => entry.src === "/deals/([^/]+)",
);
const featuredDealRouteIndex = vercel.routes.findIndex(
  (entry: any) => entry.src === "/deals/featured",
);
const publicEventsRouteIndex = vercel.routes.findIndex(
  (entry: any) => entry.src === "/events/public",
);
const broadProfileRouteIndex = vercel.routes.findIndex(
  (entry: { src?: string }) => {
    const match = entry.src?.match(/^\/\(([^)]+)\)\/\(\.\*\)$/);
    return match?.[1].split("|").includes("events");
  },
);
if (
  featuredDealRewriteIndex < 0 ||
  legacyDealRewriteIndex < 0 ||
  featuredDealRewriteIndex > legacyDealRewriteIndex ||
  vercel.rewrites[featuredDealRewriteIndex]?.destination !== "/index.html" ||
  vercel.rewrites[legacyDealRewriteIndex]?.destination !==
    "https://mealscout.onrender.com/deals/:city" ||
  String(vercel.rewrites[legacyDealRewriteIndex]?.destination).includes("?") ||
  featuredDealRouteIndex < 0 ||
  legacyDealRouteIndex < 0 ||
  featuredDealRouteIndex > legacyDealRouteIndex ||
  vercel.routes[featuredDealRouteIndex]?.dest !== "/index.html" ||
  vercel.routes[legacyDealRouteIndex]?.dest !==
    "https://mealscout.onrender.com/deals/$1" ||
  String(vercel.routes[legacyDealRouteIndex]?.dest).includes("?") ||
  vercel.redirects.some((entry: any) =>
    String(entry.source || "").startsWith("/deals/"),
  )
) {
  throw new Error(
    "Vercel must keep /deals/featured on its SPA and pass query-preserving /deals/:city requests to Render's bounded 308 in both routing forms",
  );
}
if (
  publicEventsRewriteIndex < 0 ||
  publicEventsRewriteIndex > broadProfileRewriteIndex ||
  vercel.rewrites[publicEventsRewriteIndex]?.destination !== "/index.html" ||
  !String(vercel.rewrites[broadProfileRewriteIndex]?.source).includes("events") ||
  !String(vercel.rewrites[broadProfileRewriteIndex]?.destination).startsWith(
    "https://mealscout.onrender.com/",
  ) ||
  publicEventsRouteIndex < 0 ||
  publicEventsRouteIndex > broadProfileRouteIndex ||
  vercel.routes[publicEventsRouteIndex]?.dest !== "/index.html" ||
  !String(vercel.routes[broadProfileRouteIndex]?.src).includes("events") ||
  !String(vercel.routes[broadProfileRouteIndex]?.dest).startsWith(
    "https://mealscout.onrender.com/",
  ) ||
  resolveConfiguredRoute("/events/public").destination !== "/index.html" ||
  resolveConfiguredRoute("/events/fixture-profile--fixture-id").destination !==
    "https://mealscout.onrender.com/events/fixture-profile--fixture-id"
) {
  throw new Error(
    "Vercel must keep exact /events/public on the local SPA before the unchanged external event-detail proxy",
  );
}

if (
  !publicDiscoveryRoutes.includes('from "../seo/publicCanonicalOrigin"') ||
  !publicDiscoveryRoutes.includes("resolvePublicCanonicalOrigin({") ||
  !eventRoutes.includes('from "../seo/publicCanonicalOrigin"') ||
  !publicEventDetailSource.includes("resolvePublicCanonicalOrigin({") ||
  publicEventDetailSource.includes(
    'process.env.PUBLIC_BASE_URL || "https://www.mealscout.us"',
  ) ||
  !publicCanonicalOrigin.includes(
    'MEALSCOUT_PUBLIC_CANONICAL_ORIGIN = "https://www.mealscout.us"',
  ) ||
  !publicCanonicalOrigin.includes('replace(/^www\\./, "") === "mealscout.us"') ||
  !publicSeoIntegration.includes(
    'process.env.PUBLIC_BASE_URL = "https://mealscout.us"',
  ) ||
  !publicSeoIntegration.includes(
    'assert.equal(dedicatedPublicEvent.body.canonicalUrl, `https://www.mealscout.us${publicEventPath}`)',
  ) ||
  !publicSeoIntegration.includes(
    'assert.equal(genericActiveDeal.body.canonicalUrl, `https://www.mealscout.us${activeDealPath}`)',
  )
) {
  throw new Error(
    "Public discovery APIs must normalize an apex environment to the same exact www canonical used by SSR and sitemaps",
  );
}
if (
  !dealDiscoveryRoutes.includes(
    'app.get("/api/public/deals/city/:citySlug"',
  ) ||
  !dealDiscoveryRoutes.includes('res.setHeader("Cache-Control", "no-store")') ||
  !dealDiscoveryRoutes.includes("res.status(410).json") ||
  !dealDiscoveryRoutes.includes("replacementPath") ||
  !dealDiscoveryRoutes.includes("deals: []")
) {
  throw new Error(
    "The retired city-deals API must return 410/no-store with a canonical replacement and no legacy rows",
  );
}

const threeSegmentRewriteIndex = vercel.rewrites.findIndex(
  (entry: any) => entry.source === "/food-trucks/:city/:cuisine",
);
const baseTruckRewriteIndex = vercel.rewrites.findIndex(
  (entry: any) => entry.source === "/food-trucks/:city",
);
const threeSegmentRouteIndex = vercel.routes.findIndex(
  (entry: any) => entry.src === "/food-trucks/([^/]+)/([^/]+)",
);
const baseTruckRouteIndex = vercel.routes.findIndex(
  (entry: any) => entry.src === "/food-trucks/([^/]+)",
);
if (
  threeSegmentRewriteIndex < 0 ||
  threeSegmentRewriteIndex > baseTruckRewriteIndex ||
  threeSegmentRouteIndex < 0 ||
  threeSegmentRouteIndex > baseTruckRouteIndex ||
  vercel.rewrites[threeSegmentRewriteIndex].has !== undefined ||
  vercel.routes[threeSegmentRouteIndex].has !== undefined
) {
  throw new Error(
    "Both Vercel routing forms must proxy the 3-segment truck cuisine route unconditionally before the base city route",
  );
}
for (const acquisitionPath of ["/for-food-trucks", "/for-restaurants"]) {
  const rewrite = vercel.rewrites.find(
    (entry: any) => entry.source === acquisitionPath,
  );
  const route = vercel.routes.find(
    (entry: any) => entry.src === acquisitionPath,
  );
  if (!rewrite?.has?.[0]?.value || !route?.has?.[0]?.value) {
    throw new Error(
      `PR #360 crawler-only acquisition matcher changed: ${acquisitionPath}`,
    );
  }
}

if (!publicSeoPage.includes("item.statusLabel")) {
  throw new Error("Browser landing cards must show the same public status rendered in SSR");
}
if (
  !publicSeoPage.includes("mapPublicSeoLandingPathToEndpoint") ||
  !publicSeoPage.includes("noIndex={Boolean(error) || data?.total === 0}")
) {
  throw new Error(
    "Browser landings must share route mapping and noindex empty/error states",
  );
}
if (
  !publicSeoClientRoute.includes('case "food-trucks"') ||
  !publicSeoClientRoute.includes('case "food-trucks-cuisine"') ||
  !publicSeoClientRoute.includes('return "food_trucks_city"') ||
  !publicDiscoveryRoutes.includes('"food_trucks_city"') ||
  !publicDiscoveryRoutes.includes('"discovery_food_trucks_city"')
) {
  throw new Error(
    "Food-truck city/cuisine analytics classification and profile attribution must stay paired",
  );
}

const listSourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });

const unsafeInlineJsonLd =
  /<script[^>]*application\/ld\+json[^>]*>\s*\$\{\s*JSON\.stringify\(/i;
for (const path of listSourceFiles("server")) {
  const source = readFileSync(path, "utf8");
  if (unsafeInlineJsonLd.test(source)) {
    throw new Error(`Server JSON-LD bypasses HTML-safe serialization: ${path}`);
  }
}
for (const [label, source] of [
  ["public profile prerender", prerender],
  ["acquisition prerender", acquisitionPrerender],
  ["video SSR", serverIndex],
] as const) {
  if (!source.includes("buildJsonLdScript")) {
    throw new Error(`${label} must use the shared HTML-safe JSON-LD serializer`);
  }
}

const publicSeoTestCommand = packageManifest.scripts?.["test:public-seo-landing"];
if (
  typeof publicSeoTestCommand !== "string" ||
  !publicSeoTestCommand.includes(
    "scripts/public-seo-landing-pages.contract.test.ts",
  ) ||
  !publicSeoTestCommand.includes(
    "scripts/public-seo-landing-model.behavior.test.ts",
  )
) {
  throw new Error("Public SEO package command must run both boundary tests");
}
const publicSeoDbTestCommand =
  packageManifest.scripts?.["test:public-seo-landing:db"];
if (
  typeof publicSeoDbTestCommand !== "string" ||
  !publicSeoDbTestCommand.includes(
    "scripts/public-seo-landing.integration.test.ts",
  )
) {
  throw new Error("Public SEO DB package command must run the guarded PG proof");
}
const publicDataStep = ciWorkflow.indexOf("Public Data Boundary Contract");
const publicSeoStep = ciWorkflow.indexOf("Public SEO Landing Boundary");
const frozenCleanupStep = ciWorkflow.indexOf("Frozen Cleanup Safety Contract");
if (
  publicDataStep < 0 ||
  publicSeoStep < publicDataStep ||
  frozenCleanupStep < publicSeoStep ||
  !ciWorkflow.includes("run: npm run test:public-seo-landing")
) {
  throw new Error(
    "CI must run the public SEO boundary in the declared public-data sequence",
  );
}

if (!publicProfile.includes("/city/") || !publicProfile.includes("/food-trucks-today/")) {
  throw new Error("Public profile related discovery links were not added");
}

console.log("public-seo-landing-pages.contract: PASS");
