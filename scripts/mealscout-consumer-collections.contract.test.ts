import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const shell = readFileSync(
  "client/src/components/consumer-collection-shell.tsx",
  "utf8",
);
const favorites = readFileSync("client/src/pages/favorites.tsx", "utf8");
const deals = readFileSync("client/src/pages/deals-featured.tsx", "utf8");
const appRoutes = readFileSync("client/src/App.tsx", "utf8");
const publicSeoLanding = readFileSync(
  "client/src/pages/public-seo-landing.tsx",
  "utf8",
);
const publicSeoRoute = readFileSync(
  "client/src/lib/publicSeoLandingRoute.ts",
  "utf8",
);
const dealDiscoveryRoutes = readFileSync(
  "server/routes/dealDiscoveryRoutes.ts",
  "utf8",
);
const events = readFileSync("client/src/pages/events.tsx", "utf8");
const eventsRouter = readFileSync("client/src/pages/events-router.tsx", "utf8");
const eventCoordinator = readFileSync(
  "client/src/pages/event-coordinator-dashboard.tsx",
  "utf8",
);
const profile = readFileSync("client/src/pages/profile.tsx", "utf8");

for (const phrase of [
  'data-consumer-collection-shell="true"',
  'label: "Saved", href: "/favorites"',
  'label: "Deals", href: "/deals"',
  'label: "Events", href: "/events/public"',
  '<Link href="/scout">',
  "CollectionState",
  "CollectionLoadingState",
]) {
  assert(shell.includes(phrase), `Consumer collection shell must include: ${phrase}`);
}

assert(favorites.includes('queryKey: ["/api/favorites/restaurants", user?.id]'), "Saved cache must be scoped to the current account");
assert(favorites.includes('apiRequest("GET", "/api/favorites/restaurants")'), "Cache identity must not become a different API endpoint");
assert(favorites.includes("buildPublicProfilePath"));
assert(favorites.includes('section="saved"'));
assert(!favorites.includes("<Navigation"));
assert(!favorites.includes('href="/search"'));
assert(!favorites.includes("Pro Tip"));

assert(deals.includes('queryKey: ["/api/deals/featured"]'));
assert(deals.includes('queryKey: ["/api/geo-ads"'));
assert(deals.includes("<DealCard"));
assert(deals.includes('section="deals"'));
assert(!deals.includes("<Navigation"));
assert(!deals.includes(">Sort<"));
assert(!deals.includes(">Filter<"));

assert.equal(
  existsSync("client/src/pages/deals-city.tsx"),
  false,
  "The retired legacy city-deals page must not be restored.",
);
assert(
  appRoutes.includes(
    '<Route path="/deals-today/:city" component={PublicSeoLandingPage} />',
  ),
  "City deal discovery must use the canonical deals-today public SEO surface.",
);
assert(
  publicSeoRoute.includes('parts[0] === "deals-today"') &&
    publicSeoRoute.includes("/api/public/seo/deals-today/"),
  "The canonical deals-today browser page must resolve through the shared public SEO API.",
);
assert(
  publicSeoLanding.includes("mapPublicSeoLandingPathToEndpoint") &&
    publicSeoLanding.includes("item.profilePath") &&
    publicSeoLanding.includes("item.statusLabel"),
  "The canonical deals-today collection must render shared public cards and status truth.",
);
assert(
  dealDiscoveryRoutes.includes('app.get("/api/public/deals/city/:citySlug"') &&
    dealDiscoveryRoutes.includes("res.status(410).json") &&
    dealDiscoveryRoutes.includes("replacementPath") &&
    dealDiscoveryRoutes.includes("deals: []"),
  "The retired city-deals API must fail terminally with its canonical replacement.",
);

assert(events.includes('queryKey: ["/api/events/upcoming"]'));
assert(events.includes('section="events"'));
assert(events.includes('href={`/event/${encodeURIComponent(String(event.id))}`}'));
assert(!events.includes("/api/event-coordinator/events"));
assert(!events.includes("hostPriceCents"));
assert(!events.includes("maxTrucks"));
assert(
  eventCoordinator.includes('/api/event-coordinator/events'),
  "Event creation must remain in the existing coordinator workspace.",
);

for (const destination of [
  '"/events/public"',
  '"/event-coordinator/dashboard"',
  '"/truck-discovery"',
]) {
  assert(
    eventsRouter.includes(destination),
    `Role-aware events entry must preserve ${destination}.`,
  );
}

assert(profile.includes('href: "/favorites"'));
assert(profile.includes('title: "Saved"'));

const publicCopy = `${shell}\n${favorites}\n${deals}\n${publicSeoLanding}\n${events}`.toLowerCase();
for (const prohibited of [
  "open scout",
  "scout nearby",
  "keep scouting",
  "back to scout",
]) {
  assert(
    !publicCopy.includes(prohibited),
    `Consumer collection copy must use the exact Scout action, not: ${prohibited}`,
  );
}

console.log("mealscout-consumer-collections.contract: PASS");
