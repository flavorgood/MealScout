import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPublicSeoProfilePath,
  filterPublicSeoTrucksActiveToday,
  isPublicSeoLandingRestaurantEligible,
  projectPublicSeoLandingForHtml,
  publicSeoActiveTodayStop,
  publicSeoBusinessProfileType,
  publicSeoCityIdentityMatches,
  publicSeoCityRequest,
  publicSeoCuisineMatches,
  publicSeoCuisineRequest,
  publicSeoFoodTruckCuisineRequest,
  resolvePublicSeoLanding,
  type PublicSeoLandingCity,
  type PublicSeoLandingItem,
  type PublicSeoLandingRepository,
} from "../server/services/publicSeoLandingModel";
import { buildJsonLdScript } from "../server/seo/jsonLdScript";
import {
  canExposeAnonymousEventDetail,
  canExposeAuthorizedPaidEventDetail,
} from "../server/publicProfiles/publicEventDetailAccess";
import {
  MEALSCOUT_PUBLIC_CANONICAL_ORIGIN,
  normalizePublicCanonicalOrigin,
  resolvePublicCanonicalOrigin,
} from "../server/seo/publicCanonicalOrigin";
import {
  mapPublicSeoLandingPathToEndpoint,
  mapPublicSeoLandingSourcePageType,
} from "../client/src/lib/publicSeoLandingRoute";

const pensacola: PublicSeoLandingCity = {
  id: "city-pensacola",
  name: "Pensacola",
  slug: "pensacola",
  state: "FL",
};

const item = (
  input: Partial<PublicSeoLandingItem> & Pick<PublicSeoLandingItem, "id" | "displayName">,
): PublicSeoLandingItem => ({
  id: input.id,
  profileType: input.profileType || "truck",
  displayName: input.displayName,
  slug: input.slug || input.id,
  profilePath: input.profilePath || `/truck/${input.id}`,
  city: input.city ?? "Pensacola",
  state: input.state ?? "FL",
  imageUrl: input.imageUrl || null,
  cuisineTags: input.cuisineTags || [],
  statusLabel: input.statusLabel || null,
  summary: input.summary || null,
  primaryCtaPath: input.primaryCtaPath || input.profilePath || `/truck/${input.id}`,
});

const makeRepository = (
  overrides: Partial<PublicSeoLandingRepository> = {},
): PublicSeoLandingRepository => ({
  resolveCityBySlug: async (slug) => (slug === "pensacola" ? pensacola : null),
  loadFoodTrucks: async () => [],
  loadFoodTrucksToday: async () => [],
  loadDealsToday: async () => [],
  loadEventsToday: async () => [],
  loadCityFood: async () => [],
  loadCuisine: async () => [],
  loadLocationsWithTrucks: async () => [],
  ...overrides,
});

test("public canonical origin normalizes the MealScout apex before API URLs are built", () => {
  for (const candidate of [
    "mealscout.us",
    "https://mealscout.us",
    "http://mealscout.us/",
    "https://www.mealscout.us/path?ignored=1",
  ]) {
    assert.equal(
      normalizePublicCanonicalOrigin(candidate),
      MEALSCOUT_PUBLIC_CANONICAL_ORIGIN,
    );
  }
  assert.equal(
    resolvePublicCanonicalOrigin({
      publicBaseUrl: "https://mealscout.us",
      serviceUrl: "https://preview.invalid",
    }),
    MEALSCOUT_PUBLIC_CANONICAL_ORIGIN,
  );
  assert.equal(
    resolvePublicCanonicalOrigin({ serviceUrl: "http://127.0.0.1:5000/app" }),
    "http://127.0.0.1:5000",
  );
  assert.equal(
    normalizePublicCanonicalOrigin("javascript:alert(1)"),
    MEALSCOUT_PUBLIC_CANONICAL_ORIGIN,
  );
  for (const malformed of ["http:/mealscout.us", "https//mealscout.us"]) {
    assert.equal(
      normalizePublicCanonicalOrigin(malformed),
      MEALSCOUT_PUBLIC_CANONICAL_ORIGIN,
    );
  }
});

test("browser route mapping keeps the specific truck-cuisine endpoint before city-only", () => {
  assert.equal(
    mapPublicSeoLandingPathToEndpoint(
      "/food-trucks/fort-walton-beach/pizza-sammys-desserts",
    ),
    "/api/public/seo/food-trucks/fort-walton-beach/pizza-sammys-desserts",
  );
  assert.equal(
    mapPublicSeoLandingPathToEndpoint("/food-trucks/pensacola"),
    "/api/public/seo/food-trucks/pensacola",
  );
  assert.equal(
    mapPublicSeoLandingSourcePageType("food-trucks-cuisine"),
    "food_trucks_city",
  );
  assert.equal(
    mapPublicSeoLandingSourcePageType("food-truck-catering"),
    "food_truck_catering",
  );
  assert.equal(
    mapPublicSeoLandingSourcePageType("book-food-truck"),
    "book_food_truck",
  );
  assert.equal(
    mapPublicSeoLandingSourcePageType("food-trucks"),
    "food_trucks_city",
  );
});

test("anonymous event membership rejects private events", () => {
  assert.equal(
    canExposeAnonymousEventDetail({
      eventType: "private_event",
      requiresPayment: false,
      status: "open",
      slotIsPublic: true,
    }),
    false,
  );
  assert.equal(
    canExposeAnonymousEventDetail({
      eventType: "public_event",
      requiresPayment: false,
      status: "open",
      slotIsPublic: true,
    }),
    true,
  );
});

test("paid Parking Pass detail needs the separate authorized-owner lane", () => {
  const anonymousPaidParkingPass = {
    eventType: "parking_pass",
    requiresPayment: true,
    status: "open",
    slotIsPublic: true,
  };
  const authorizedPaidParkingPass = {
    eventType: "parking_pass",
    requiresPayment: true,
    status: "open",
    slotIsBookable: true,
  };
  assert.equal(canExposeAnonymousEventDetail(anonymousPaidParkingPass), false);
  assert.equal(
    canExposeAuthorizedPaidEventDetail(authorizedPaidParkingPass),
    true,
  );
  assert.equal(
    canExposeAuthorizedPaidEventDetail({
      ...authorizedPaidParkingPass,
      eventType: "private_event",
    }),
    false,
  );
  assert.equal(
    canExposeAuthorizedPaidEventDetail({
      ...authorizedPaidParkingPass,
      status: "draft",
    }),
    false,
  );
});

test("known empty city is a valid page, while an unknown city is not found", async () => {
  let foodTruckLoads = 0;
  const repository = makeRepository({
    loadFoodTrucks: async (city) => {
      foodTruckLoads += 1;
      assert.equal(city.name, "Pensacola");
      return [];
    },
  });

  const known = await resolvePublicSeoLanding(
    publicSeoCityRequest("food-trucks", "  PENSACOLA "),
    repository,
  );
  assert.equal(known.kind, "found");
  if (known.kind !== "found") return;
  assert.equal(known.payload.page.canonicalPath, "/food-trucks/pensacola");
  assert.equal(known.payload.total, 0);
  assert.match(known.payload.page.emptyMessage, /No food trucks/i);

  const unknown = await resolvePublicSeoLanding(
    publicSeoCityRequest("food-trucks", "definitely-not-a-real-city"),
    repository,
  );
  assert.deepEqual(unknown, { kind: "not_found", reason: "city" });
  assert.equal(foodTruckLoads, 1, "unknown city must not run an unscoped listing query");
});

test("stored merchant identity and titles are not rewritten as ranking claims", async () => {
  const stored = item({
    id: "top-hat",
    displayName: "Top Hat Tacos",
    profilePath: "/truck/top-hat-tacos--top-hat",
    summary: "Deal today: Best Friends Lunch",
  });
  const repository = makeRepository({
    loadDealsToday: async () => [stored],
  });
  const resolution = await resolvePublicSeoLanding(
    publicSeoCityRequest("deals-today", "pensacola"),
    repository,
  );
  assert.equal(resolution.kind, "found");
  if (resolution.kind !== "found") return;
  assert.equal(resolution.payload.items[0]?.displayName, "Top Hat Tacos");
  assert.equal(
    resolution.payload.items[0]?.summary,
    "Deal today: Best Friends Lunch",
  );
  assert.equal(
    resolution.payload.items[0]?.profilePath,
    "/truck/top-hat-tacos--top-hat",
  );
});

test("city-qualified cuisine requests reject unknown cities and stay city-scoped", async () => {
  const cuisineCalls: Array<{ cuisineSlug: string; cityName: string | null }> = [];
  const repository = makeRepository({
    loadCuisine: async (cuisineSlug, city) => {
      cuisineCalls.push({ cuisineSlug, cityName: city?.name || null });
      return [
        item({
          id: "sweet-love",
          displayName: "Sweet Love",
          cuisineTags: ["Ice cream"],
        }),
      ];
    },
  });

  const unknown = await resolvePublicSeoLanding(
    publicSeoCuisineRequest("ice-cream", "missing-city"),
    repository,
  );
  assert.deepEqual(unknown, { kind: "not_found", reason: "city" });
  assert.equal(cuisineCalls.length, 0);

  const known = await resolvePublicSeoLanding(
    publicSeoCuisineRequest("ICE-CREAM", "PENSACOLA"),
    repository,
  );
  assert.equal(known.kind, "found");
  if (known.kind !== "found") return;
  assert.deepEqual(cuisineCalls, [
    { cuisineSlug: "ice-cream", cityName: "Pensacola" },
  ]);
  assert.equal(
    known.payload.page.canonicalPath,
    "/cuisine/ice-cream/pensacola",
  );
  assert.equal(known.payload.items[0]?.displayName, "Sweet Love");
});

test("a blank supplied cuisine city cannot fall through to global discovery", async () => {
  let cityResolutions = 0;
  let loaderCalls = 0;
  const unexpectedLoad = async () => {
    loaderCalls += 1;
    return [];
  };
  const repository = makeRepository({
    resolveCityBySlug: async () => {
      cityResolutions += 1;
      return { ...pensacola, name: " ", slug: "" };
    },
    loadFoodTrucks: unexpectedLoad,
    loadFoodTrucksToday: unexpectedLoad,
    loadDealsToday: unexpectedLoad,
    loadEventsToday: unexpectedLoad,
    loadCityFood: unexpectedLoad,
    loadCuisine: unexpectedLoad,
    loadLocationsWithTrucks: unexpectedLoad,
  });

  const explicitCuisineCity = await resolvePublicSeoLanding(
    publicSeoCuisineRequest("ice-cream", "   "),
    repository,
  );
  const requiredCity = await resolvePublicSeoLanding(
    publicSeoCityRequest("food-trucks", " \t "),
    repository,
  );

  assert.deepEqual(explicitCuisineCity, { kind: "not_found", reason: "city" });
  assert.deepEqual(requiredCity, { kind: "not_found", reason: "city" });
  assert.equal(
    cityResolutions,
    0,
    "an explicit blank city must fail before repository resolution",
  );
  assert.equal(loaderCalls, 0, "blank city requests must not reach any loader");
});

test("cityless cuisine discovery remains intentionally global", async () => {
  let cityResolutions = 0;
  let scopedCity: string | null | undefined;
  const repository = makeRepository({
    resolveCityBySlug: async () => {
      cityResolutions += 1;
      return null;
    },
    loadCuisine: async (_cuisineSlug, city) => {
      scopedCity = city?.name || null;
      return [item({ id: "global-taco", displayName: "Global Taco" })];
    },
  });

  const resolution = await resolvePublicSeoLanding(
    publicSeoCuisineRequest("tacos"),
    repository,
  );
  assert.equal(resolution.kind, "found");
  assert.equal(cityResolutions, 0);
  assert.equal(scopedCity, null);
});

test("canonical city identity rejects substrings and same-name rows in another state", () => {
  assert.equal(
    publicSeoCityIdentityMatches(
      { city: "Pensacola", state: "FL" },
      pensacola,
    ),
    true,
  );
  assert.equal(
    publicSeoCityIdentityMatches(
      { city: "Pensacola Beach", state: "FL" },
      pensacola,
    ),
    false,
  );
  assert.equal(
    publicSeoCityIdentityMatches(
      { city: "Pensacola", state: "OK" },
      pensacola,
    ),
    false,
  );
  const statelessCity: PublicSeoLandingCity = {
    id: "city-stateless",
    name: "Stateless",
    slug: "stateless",
    state: null,
  };
  assert.equal(
    publicSeoCityIdentityMatches(
      { city: "Stateless", state: "FL" },
      statelessCity,
    ),
    false,
  );
  assert.equal(
    publicSeoCityIdentityMatches(
      { city: "Stateless", state: null },
      statelessCity,
    ),
    true,
  );
});

test("landing eligibility excludes profiles that canonical robots and sitemaps exclude", () => {
  const claimed = {
    name: "Pensacola Pizza Wagon",
    isActive: true,
    ownerId: "owner-1",
    ownerEmail: "owner@example.com",
    address: "100 Main Street",
    city: "Pensacola",
    state: "FL",
    cuisineType: "Pizza",
    description: "Wood-fired pizza around Pensacola",
    businessType: "restaurant",
    isFoodTruck: false,
    rawData: {},
  };
  assert.equal(isPublicSeoLandingRestaurantEligible(claimed), true);
  assert.equal(
    isPublicSeoLandingRestaurantEligible({
      ...claimed,
      ownerEmail: "system-import@mealscout.us",
    }),
    false,
  );
  assert.equal(
    isPublicSeoLandingRestaurantEligible({
      ...claimed,
      rawData: { evidenceQuarantine: { active: true } },
    }),
    false,
  );
});

test("cuisine matching uses the sitemap slug and arbitrary cuisines are not found", async () => {
  assert.equal(
    publicSeoCuisineMatches(
      "Pizza / Sammys & Desserts",
      "pizza-sammys-desserts",
    ),
    true,
  );
  assert.equal(publicSeoCuisineMatches("Pizza", "%"), false);

  const arbitrary = await resolvePublicSeoLanding(
    publicSeoCuisineRequest("definitely-not-a-cuisine", "pensacola"),
    makeRepository({ loadCuisine: async () => [] }),
  );
  assert.deepEqual(arbitrary, { kind: "not_found", reason: "cuisine" });
});

test("food-truck cuisine is a first-class canonical route and rejects restaurant-only rows", async () => {
  const truck = item({
    id: "pizza-truck",
    displayName: "Pizza Wagon",
    cuisineTags: ["Pizza / Sammys & Desserts"],
  });
  const found = await resolvePublicSeoLanding(
    publicSeoFoodTruckCuisineRequest(
      "PENSACOLA",
      "  Pizza / Sammys & Desserts  ",
    ),
    makeRepository({ loadFoodTrucks: async () => [truck] }),
  );
  assert.equal(found.kind, "found");
  if (found.kind === "found") {
    assert.equal(
      found.payload.page.canonicalPath,
      "/food-trucks/pensacola/pizza-sammys-desserts",
    );
  }

  const restaurantOnly = await resolvePublicSeoLanding(
    publicSeoFoodTruckCuisineRequest("pensacola", "restaurant-only"),
    makeRepository({ loadFoodTrucks: async () => [] }),
  );
  assert.deepEqual(restaurantOnly, {
    kind: "not_found",
    reason: "cuisine",
  });
});

test("today listings require current or today operating-plan evidence in the requested city", () => {
  const truck = item({ id: "today-truck", displayName: "Today Truck" });
  const wrongCity = item({ id: "wrong-city", displayName: "Wrong City" });
  const inactive = item({ id: "inactive", displayName: "Inactive Truck" });
  const plans = new Map([
    [
      truck.id,
      {
        truckSchedule: {
          currentStop: {
            city: "Pensacola",
            state: "FL",
            locationName: "Lunch Stop",
          },
        },
      },
    ],
    [
      wrongCity.id,
      {
        truckSchedule: {
          todayStop: { city: "Pensacola", state: "OK" },
        },
      },
    ],
    [inactive.id, { truckSchedule: {} }],
  ]);

  assert.equal(
    publicSeoActiveTodayStop(plans.get(truck.id), pensacola)?.locationName,
    "Lunch Stop",
  );
  assert.deepEqual(
    filterPublicSeoTrucksActiveToday(
      [truck, wrongCity, inactive],
      plans,
      pensacola,
    ).map((entry) => entry.id),
    [truck.id],
  );
});

test("bar listings keep their canonical public profile type", () => {
  assert.equal(
    publicSeoBusinessProfileType({
      businessType: "bar",
      isFoodTruck: false,
    }),
    "bar",
  );
  assert.equal(
    publicSeoBusinessProfileType({
      businessType: "brewery",
      isFoodTruck: false,
    }),
    "bar",
  );
  assert.equal(
    publicSeoBusinessProfileType({
      businessType: "bar",
      isFoodTruck: true,
    }),
    "truck",
    "truck truth must take precedence over a conflicting legacy bar type",
  );
  assert.equal(
    publicSeoBusinessProfileType({
      businessType: "caterer",
      isFoodTruck: false,
    }),
    null,
  );
  assert.equal(
    publicSeoBusinessProfileType({
      businessType: " PRIVATE-CHEF ",
      isFoodTruck: false,
    }),
    null,
  );
  for (const unsupportedType of [
    "caterer_private_chef",
    "host_venue",
    "supplier",
    "unknown_legacy_type",
    "",
  ]) {
    assert.equal(
      publicSeoBusinessProfileType({
        businessType: unsupportedType,
        isFoodTruck: false,
      }),
      null,
      `${unsupportedType || "blank"} must fail closed instead of becoming a restaurant`,
    );
  }
  assert.equal(
    buildPublicSeoProfilePath({
      profileType: "bar",
      id: "bar-1",
      name: "Bay Brewery",
    }),
    "/bar/bay-brewery--bar-1",
  );
  assert.equal(
    buildPublicSeoProfilePath({
      profileType: "restaurant",
      id: "restaurant-1",
      name: "Bay Table",
    }),
    "/restaurant/bay-table--restaurant-1",
  );
});

test("deal, event, and location facts render into escaped first-response markup", async () => {
  const seeded = {
    "deals-today": item({
      id: "deal-truck",
      displayName: "Deal Truck <script>alert(1)</script>",
      profilePath: "/truck/deal-truck--1?from=<seo>",
      statusLabel: "Active today",
      summary: "Deal today: Two tacos & a drink",
      cuisineTags: ["Tacos"],
    }),
    "events-today": item({
      id: "event-truck",
      displayName: "Event Truck",
      statusLabel: "Confirmed today",
      summary: "Event today: Gallery Night",
    }),
    "locations-with-trucks": item({
      id: "host-location",
      displayName: "Bayfront Market",
      profileType: "location",
      profilePath: "/location/bayfront-market--1",
      primaryCtaPath: "/location/bayfront-market--1",
      statusLabel: "Confirmed this week",
      summary: "2 confirmed truck stops",
    }),
  } as const;

  const repository = makeRepository({
    loadDealsToday: async () => [seeded["deals-today"]],
    loadEventsToday: async () => [seeded["events-today"]],
    loadLocationsWithTrucks: async () => [seeded["locations-with-trucks"]],
  });

  for (const routeKey of [
    "deals-today",
    "events-today",
    "locations-with-trucks",
  ] as const) {
    const resolution = await resolvePublicSeoLanding(
      publicSeoCityRequest(routeKey, "pensacola"),
      repository,
      new Date("2026-08-21T16:00:00.000Z"),
    );
    assert.equal(resolution.kind, "found");
    if (resolution.kind !== "found") continue;
    const projection = projectPublicSeoLandingForHtml(resolution.payload, [
      { label: "City food", href: "/city/pensacola/food" },
    ]);
    const expected = seeded[routeKey];
    assert.match(projection.listingHtml, new RegExp(expected.statusLabel!));
    assert.ok(
      projection.listingHtml.includes(
        expected.summary!.replace(/&/g, "&amp;"),
      ),
    );
    assert.ok(
      projection.listingHtml.includes(
        expected.profilePath.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
      ),
    );
    assert.ok(
      projection.listingHtml.includes(
        expected.displayName.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
      ),
    );
    assert.doesNotMatch(projection.listingHtml, /<script>alert\(1\)<\/script>/);
  }
});

test("data failures propagate instead of becoming an indexable generic page", async () => {
  const repository = makeRepository({
    loadDealsToday: async () => {
      throw new Error("database unavailable");
    },
  });
  await assert.rejects(
    resolvePublicSeoLanding(
      publicSeoCityRequest("deals-today", "pensacola"),
      repository,
    ),
    /database unavailable/,
  );
});

test("JSON-LD serialization cannot be terminated by merchant-controlled text", () => {
  const maliciousName =
    '</script><script>globalThis.mealScoutInjected = true</script>&\u2028\u2029';
  const script = buildJsonLdScript({
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: [{ name: maliciousName }],
  });

  assert.equal(script.match(/<script\b/gi)?.length, 1);
  assert.equal(script.match(/<\/script>/gi)?.length, 1);
  assert.doesNotMatch(script, /<\/script><script>/i);
  assert.match(script, /\\u003c\/script\\u003e/);
  assert.match(script, /\\u0026/);
  assert.match(script, /\\u2028\\u2029/);

  const json = script
    .replace(/^<script type="application\/ld\+json">/, "")
    .replace(/<\/script>$/, "");
  assert.equal(JSON.parse(json).itemListElement[0].name, maliciousName);
});

assert.equal(
  mapPublicSeoLandingPathToEndpoint("/food-truck-catering/pensacola"),
  "/api/public/seo/food-truck-catering/pensacola",
);
assert.equal(
  mapPublicSeoLandingPathToEndpoint("/book-food-truck/pensacola"),
  "/api/public/seo/book-food-truck/pensacola",
);
