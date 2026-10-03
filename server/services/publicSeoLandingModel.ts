import {
  resolveStoredFoodBusinessType,
} from "@shared/businessTypes";
import {
  isPublicRestaurantIndexable,
  type PublicRestaurantIndexabilityInput,
} from "../seo/publicRestaurantIndexability";
import { buildPublicProfilePath } from "../publicProfiles/publicProfileUtils";

export type PublicSeoLandingRouteKey =
  | "food-trucks"
  | "food-trucks-cuisine"
  | "food-trucks-today"
  | "food-truck-catering"
  | "book-food-truck"
  | "deals-today"
  | "events-today"
  | "city"
  | "cuisine"
  | "locations-with-trucks";

export type PublicSeoLandingRequest = {
  routeKey: PublicSeoLandingRouteKey;
  citySlug?: string | null;
  cuisineSlug?: string | null;
};

export type PublicSeoLandingCity = {
  id: string;
  name: string;
  slug: string;
  state: string | null;
};

export type PublicSeoLandingProfileType =
  | "restaurant"
  | "truck"
  | "bar"
  | "location";

export type PublicSeoLandingItem = {
  id: string;
  profileType: PublicSeoLandingProfileType;
  displayName: string;
  slug: string;
  profilePath: string;
  city: string | null;
  state: string | null;
  imageUrl: string | null;
  cuisineTags: string[];
  statusLabel: string | null;
  summary: string | null;
  primaryCtaPath: string;
};

export type PublicSeoLandingPayload = {
  page: {
    routeKey: PublicSeoLandingRouteKey;
    citySlug: string | null;
    cityName: string | null;
    cityState: string | null;
    cuisineSlug: string | null;
    cuisineName: string | null;
    canonicalPath: string;
    title: string;
    description: string;
    ogImage: string;
    emptyMessage: string;
  };
  items: PublicSeoLandingItem[];
  total: number;
};

export type PublicSeoLandingResolution =
  | { kind: "found"; payload: PublicSeoLandingPayload }
  | { kind: "not_found"; reason: "city" | "cuisine" };

export type PublicSeoLandingRepository = {
  resolveCityBySlug(citySlug: string): Promise<PublicSeoLandingCity | null>;
  loadFoodTrucks(
    city: PublicSeoLandingCity,
    cuisineSlug?: string | null,
  ): Promise<PublicSeoLandingItem[]>;
  loadFoodTrucksToday(
    city: PublicSeoLandingCity,
    now: Date,
  ): Promise<PublicSeoLandingItem[]>;
  loadDealsToday(
    city: PublicSeoLandingCity,
    now: Date,
  ): Promise<PublicSeoLandingItem[]>;
  loadEventsToday(
    city: PublicSeoLandingCity,
    now: Date,
  ): Promise<PublicSeoLandingItem[]>;
  loadCityFood(city: PublicSeoLandingCity): Promise<PublicSeoLandingItem[]>;
  loadCuisine(
    cuisineSlug: string,
    city: PublicSeoLandingCity | null,
  ): Promise<PublicSeoLandingItem[]>;
  loadLocationsWithTrucks(
    city: PublicSeoLandingCity,
    now: Date,
  ): Promise<PublicSeoLandingItem[]>;
};

export type PublicSeoPageLink = { label: string; href: string };

export const publicSeoBusinessProfileType = (input: {
  isFoodTruck?: boolean | null;
  businessType?: string | null;
}): Exclude<PublicSeoLandingProfileType, "location"> | null => {
  const canonicalType = resolveStoredFoodBusinessType(input);
  if (canonicalType === "food_truck") return "truck";
  if (canonicalType === "bar") return "bar";
  if (canonicalType === "restaurant") return "restaurant";
  return null;
};

export const toPublicSeoSlug = (value: string | null | undefined) =>
  String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 80);

const normalizeIdentityPart = (value: unknown) =>
  String(value ?? "").trim().toLowerCase();

export const publicSeoCityIdentityKey = (input: {
  city?: unknown;
  state?: unknown;
}) =>
  `${normalizeIdentityPart(input.city)}\u0000${normalizeIdentityPart(input.state)}`;

export const publicSeoCityIdentityMatches = (
  candidate: { city?: unknown; state?: unknown },
  city: PublicSeoLandingCity,
) =>
  normalizeIdentityPart(candidate.city) === normalizeIdentityPart(city.name) &&
  normalizeIdentityPart(candidate.state) === normalizeIdentityPart(city.state);

export const publicSeoCuisineMatches = (
  cuisineType: string | null | undefined,
  cuisineSlug: string | null | undefined,
) =>
  Boolean(toPublicSeoSlug(cuisineSlug)) &&
  toPublicSeoSlug(cuisineType) === toPublicSeoSlug(cuisineSlug);

export const isPublicSeoLandingRestaurantEligible = (
  input: PublicRestaurantIndexabilityInput & {
    isFoodTruck?: boolean | null;
    businessType?: string | null;
  },
) =>
  publicSeoBusinessProfileType(input) !== null &&
  isPublicRestaurantIndexable(input);

type PublicSeoActiveStop = {
  city?: unknown;
  state?: unknown;
  locationName?: string | null;
};

type PublicSeoOperatingPlanEvidence = {
  truckSchedule?: {
    currentStop?: PublicSeoActiveStop | null;
    todayStop?: PublicSeoActiveStop | null;
  };
};

export const publicSeoActiveTodayStop = (
  plan: PublicSeoOperatingPlanEvidence | undefined,
  city: PublicSeoLandingCity,
) =>
  [plan?.truckSchedule?.currentStop, plan?.truckSchedule?.todayStop].find(
    (stop): stop is PublicSeoActiveStop =>
      Boolean(stop) && publicSeoCityIdentityMatches(stop!, city),
  ) || null;

export const filterPublicSeoTrucksActiveToday = <
  T extends Pick<PublicSeoLandingItem, "id">,
>(
  items: T[],
  plans: ReadonlyMap<string, PublicSeoOperatingPlanEvidence>,
  city: PublicSeoLandingCity,
) =>
  items.filter((item) => Boolean(publicSeoActiveTodayStop(plans.get(item.id), city)));

export const buildPublicSeoProfilePath = (input: {
  profileType: PublicSeoLandingProfileType;
  id: string;
  name: string;
}) =>
  buildPublicProfilePath({
    entityType: input.profileType,
    id: input.id,
    name: input.name,
  });

const normalizeSlug = (value: string | null | undefined) =>
  String(value || "").trim().toLowerCase();

export const publicSeoCityRequest = (
  routeKey: Exclude<
    PublicSeoLandingRouteKey,
    "cuisine" | "food-trucks-cuisine"
  >,
  citySlug: string | null | undefined,
): PublicSeoLandingRequest => ({ routeKey, citySlug: normalizeSlug(citySlug) });

export const publicSeoFoodTruckCuisineRequest = (
  citySlug: string | null | undefined,
  cuisineSlug: string | null | undefined,
): PublicSeoLandingRequest => ({
  routeKey: "food-trucks-cuisine",
  citySlug: normalizeSlug(citySlug),
  cuisineSlug: toPublicSeoSlug(cuisineSlug),
});

export const publicSeoCuisineRequest = (
  cuisineSlug: string | null | undefined,
  citySlug?: string | null,
): PublicSeoLandingRequest => ({
  routeKey: "cuisine",
  cuisineSlug: toPublicSeoSlug(cuisineSlug),
  citySlug: citySlug === null || citySlug === undefined
    ? null
    : normalizeSlug(citySlug),
});

// Page templates below are authored with neutral language. Normalize spacing
// without rewriting stored city/cuisine identity that may contain these words.
const normalizeLandingCopy = (value: string) =>
  value.replace(/\s+/g, " ").trim();

const canonicalPathFor = (input: {
  routeKey: PublicSeoLandingRouteKey;
  citySlug: string | null;
  cuisineSlug: string | null;
}) => {
  const encodedCity = input.citySlug
    ? encodeURIComponent(input.citySlug)
    : "";
  const encodedCuisine = input.cuisineSlug
    ? encodeURIComponent(input.cuisineSlug)
    : "";
  switch (input.routeKey) {
    case "city":
      return `/city/${encodedCity}/food`;
    case "food-trucks":
      return `/food-trucks/${encodedCity}`;
    case "food-trucks-cuisine":
      return `/food-trucks/${encodedCity}/${encodedCuisine}`;
    case "cuisine":
      return encodedCity
        ? `/cuisine/${encodedCuisine}/${encodedCity}`
        : `/cuisine/${encodedCuisine}`;
    default:
      return `/${input.routeKey}/${encodedCity}`;
  }
};

const buildPayload = (input: {
  routeKey: PublicSeoLandingRouteKey;
  city: PublicSeoLandingCity | null;
  cuisineSlug: string | null;
  title: string;
  description: string;
  items: PublicSeoLandingItem[];
  emptyMessage: string;
}): PublicSeoLandingPayload => {
  const cuisineName = input.cuisineSlug?.replace(/-/g, " ") || null;
  const citySlug = input.city?.slug || null;
  return {
    page: {
      routeKey: input.routeKey,
      citySlug,
      cityName: input.city?.name || null,
      cityState: input.city?.state || null,
      cuisineSlug: input.cuisineSlug,
      cuisineName,
      canonicalPath: canonicalPathFor({
        routeKey: input.routeKey,
        citySlug,
        cuisineSlug: input.cuisineSlug,
      }),
      title: normalizeLandingCopy(input.title),
      description: normalizeLandingCopy(input.description),
      ogImage: "/og-default.jpg?v=20260506",
      emptyMessage: normalizeLandingCopy(input.emptyMessage),
    },
    items: input.items,
    total: input.items.length,
  };
};

const routeNeedsCity = (routeKey: PublicSeoLandingRouteKey) =>
  routeKey !== "cuisine";

export async function resolvePublicSeoLanding(
  request: PublicSeoLandingRequest,
  repository: PublicSeoLandingRepository,
  now = new Date(),
): Promise<PublicSeoLandingResolution> {
  const citySlug = normalizeSlug(request.citySlug);
  const cuisineSlug = toPublicSeoSlug(request.cuisineSlug);
  const hasCitySegment =
    request.citySlug !== null && request.citySlug !== undefined;
  const mustResolveCity = routeNeedsCity(request.routeKey) || hasCitySegment;
  if (mustResolveCity && !citySlug) {
    return { kind: "not_found", reason: "city" };
  }
  const city = mustResolveCity
    ? await repository.resolveCityBySlug(citySlug)
    : null;

  // A path that names a city must never become an unscoped/global query when
  // that city is unknown. Known cities with no matching rows remain valid
  // empty payloads below.
  if (mustResolveCity && !city) return { kind: "not_found", reason: "city" };

  switch (request.routeKey) {
    case "food-trucks": {
      const items = await repository.loadFoodTrucks(city!);
      return { kind: "found", payload: buildPayload({
        routeKey: request.routeKey,
        city,
        cuisineSlug: null,
        title: `Food trucks in ${city!.name}`,
        description: `Find food trucks in ${city!.name}. Browse profiles, menus, locations, and current local activity.`,
        items,
        emptyMessage:
          "No food trucks are listed here yet. Check nearby food or come back soon.",
      }) };
    }
    case "food-truck-catering": {
      const items = await repository.loadFoodTrucks(city!);
      const cityLabel = [city!.name, city!.state].filter(Boolean).join(", ");
      return { kind: "found", payload: buildPayload({
        routeKey: request.routeKey,
        city,
        cuisineSlug: null,
        title: `Food truck catering in ${cityLabel}`,
        description: `Browse public food truck profiles in ${cityLabel} for catering, office lunches, weddings, private parties, and community events. Check menus, public schedule details, and each truck's profile before sending a request.`,
        items,
        emptyMessage:
          "No public food truck profiles are available for this city yet. Check nearby food or come back soon.",
      }) };
    }
    case "book-food-truck": {
      const items = await repository.loadFoodTrucks(city!);
      const cityLabel = [city!.name, city!.state].filter(Boolean).join(", ");
      return { kind: "found", payload: buildPayload({
        routeKey: request.routeKey,
        city,
        cuisineSlug: null,
        title: `Book a food truck in ${cityLabel}`,
        description: `Find public food truck profiles in ${cityLabel} for events and catering. Compare menus and profile details, then use the contact or request options each business has made public on MealScout.`,
        items,
        emptyMessage:
          "No public food truck profiles are available for this city yet. Check nearby food or come back soon.",
      }) };
    }
    case "food-trucks-cuisine": {
      if (!cuisineSlug) return { kind: "not_found", reason: "cuisine" };
      const items = await repository.loadFoodTrucks(city!, cuisineSlug);
      if (items.length === 0) {
        return { kind: "not_found", reason: "cuisine" };
      }
      const cuisineName = cuisineSlug.replace(/-/g, " ");
      return { kind: "found", payload: buildPayload({
        routeKey: request.routeKey,
        city,
        cuisineSlug,
        title: `${cuisineName} food trucks in ${city!.name}`,
        description: `Find ${cuisineName} food trucks in ${city!.name} and open their canonical public profiles.`,
        items,
        emptyMessage: `No ${cuisineName} food trucks are listed in ${city!.name}.`,
      }) };
    }
    case "food-trucks-today": {
      const items = await repository.loadFoodTrucksToday(city!, now);
      return { kind: "found", payload: buildPayload({
        routeKey: request.routeKey,
        city,
        cuisineSlug: null,
        title: `Food trucks in ${city!.name} today`,
        description: `Find local food trucks active today in ${city!.name}. Browse menus, locations, and profile details.`,
        items,
        emptyMessage:
          "No food trucks listed for today yet. Check nearby food or come back soon.",
      }) };
    }
    case "deals-today": {
      const items = await repository.loadDealsToday(city!, now);
      return { kind: "found", payload: buildPayload({
        routeKey: request.routeKey,
        city,
        cuisineSlug: null,
        title: `Local deals in ${city!.name} today`,
        description: `See active food deals today in ${city!.name} from local restaurants and trucks.`,
        items,
        emptyMessage:
          "No local deals listed for today yet. Check nearby food or come back soon.",
      }) };
    }
    case "events-today": {
      const items = await repository.loadEventsToday(city!, now);
      return { kind: "found", payload: buildPayload({
        routeKey: request.routeKey,
        city,
        cuisineSlug: null,
        title: `Food events in ${city!.name} today`,
        description: `Find local food events happening today in ${city!.name}.`,
        items,
        emptyMessage:
          "No food events listed for today yet. Check nearby food or come back soon.",
      }) };
    }
    case "city": {
      const items = await repository.loadCityFood(city!);
      return { kind: "found", payload: buildPayload({
        routeKey: request.routeKey,
        city,
        cuisineSlug: null,
        title: `Places to eat in ${city!.name}`,
        description: `Browse local restaurants and food trucks in ${city!.name}.`,
        items,
        emptyMessage:
          "No places to eat are listed here yet. Check nearby food or come back soon.",
      }) };
    }
    case "cuisine": {
      if (!cuisineSlug) return { kind: "not_found", reason: "cuisine" };
      const items = await repository.loadCuisine(
        cuisineSlug,
        city,
      );
      if (items.length === 0) {
        return { kind: "not_found", reason: "cuisine" };
      }
      const cuisineName = cuisineSlug.replace(/-/g, " ");
      const cityLabel = city?.name ? ` in ${city.name}` : "";
      return { kind: "found", payload: buildPayload({
        routeKey: request.routeKey,
        city,
        cuisineSlug,
        title: `${cuisineName} food${cityLabel}`,
        description: `Find ${cuisineName} restaurants and trucks${cityLabel}.`,
        items,
        emptyMessage: `No ${cuisineName} listings are available here yet. Check nearby food or come back soon.`,
      }) };
    }
    case "locations-with-trucks": {
      const items = await repository.loadLocationsWithTrucks(city!, now);
      return { kind: "found", payload: buildPayload({
        routeKey: request.routeKey,
        city,
        cuisineSlug: null,
        title: `Locations with food trucks in ${city!.name}`,
        description: `Find locations with food trucks active this week in ${city!.name}.`,
        items,
        emptyMessage:
          "No locations with trucks are listed yet. Check nearby food or come back soon.",
      }) };
    }
  }
}

const escapeHtml = (value: string | null | undefined) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export function renderPublicSeoLandingItems(
  items: PublicSeoLandingItem[],
): string {
  if (items.length === 0) return "";
  const rows = items
    .map((item) => {
      const area = [item.city, item.state].filter(Boolean).join(", ");
      const cuisines = item.cuisineTags.slice(0, 2).join(" • ");
      return `<li><a href="${escapeHtml(item.profilePath)}"><strong>${escapeHtml(item.displayName)}</strong></a>${area ? `<span>${escapeHtml(area)}</span>` : ""}${item.statusLabel ? `<p>${escapeHtml(item.statusLabel)}</p>` : ""}${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ""}${cuisines ? `<p>${escapeHtml(cuisines)}</p>` : ""}</li>`;
    })
    .join("");
  return `<section class="listing-results" aria-labelledby="listing-results-heading"><h2 id="listing-results-heading">${items.length} local result${items.length === 1 ? "" : "s"}</h2><ul>${rows}</ul></section>`;
}

export function projectPublicSeoLandingForHtml(
  payload: PublicSeoLandingPayload,
  fallbackLinks: PublicSeoPageLink[],
) {
  const links: PublicSeoPageLink[] = [];
  const seen = new Set<string>();
  for (const link of fallbackLinks) {
    if (!link.href || seen.has(link.href)) continue;
    seen.add(link.href);
    links.push(link);
  }
  return {
    links,
    body:
      payload.total > 0
        ? [
            `${payload.total} public local result${payload.total === 1 ? "" : "s"} on this page.`,
          ]
        : [payload.page.emptyMessage],
    listingHtml: renderPublicSeoLandingItems(payload.items),
  };
}
