import { readScoutFeed } from "@/lib/scout-feed-read";
import { ScoutReadStatus } from "@/components/scout/ScoutReadStatus";
import { readScoutJourney, scoutJourneyRoute } from "@/lib/scout-journey-state";
import { useScoutJourneyPersistence } from "@/hooks/useScoutJourneyPersistence";
import {
  DEFAULT_TRUCK_BROADCAST_FRESHNESS_MS,
  deriveTruckPresence,
  resolveCoordinatePair,
  resolveTruckCoordinates,
} from "@shared/consumerEntity";
import { isBarBusinessType } from "@shared/businessTypes";
import {
  expandScoutSearchTerms,
  tokenizeScoutSearchIntent,
} from "@shared/scoutSearchIntent";
import {
  selectScoutDiscoveryResults,
  toScoutDiscoveryResult,
  type ScoutDiscoveryResultKind,
  type ScoutDiscoveryScope,
  type ScoutDiscoverySource,
} from "@shared/scoutDiscoveryResult";
import { resolveBusinessMedia, type BusinessMediaAsset } from "@/lib/businessMedia";
import {
  useCallback,
  useEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  Suspense,
  type ReactNode,
} from "react";
import { Link, useLocation as useWouterLocation } from "wouter";
import { createPortal } from "react-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  Bookmark,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Compass,
  Flame,
  Heart,
  MapPin,
  Maximize2,
  Plus,
  MessageCircle,
  Minimize2,
  Navigation2,
  Tag,
  TrendingUp,
  Truck as TruckIcon,
  Users,
  Utensils,
  User as UserIcon,
  X,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/useAuth";
import {
  useEffectiveLocationContext,
  type EffectiveLocationContext,
} from "@/hooks/useEffectiveLocationContext";
import { getReverseGeocodedLocationName } from "@/utils/locationUtils";
import { SEOHead } from "@/components/seo-head";
import { ScoutMapHero } from "@/components/scout/ScoutMapHero";
import { PlaceAutocompleteInput } from "@/components/maps/place-autocomplete-input";
import { ActiveScenePanel } from "@/components/scout/ActiveScenePanel";
import type { ScoutSearchFilterId } from "@/components/scout/ScoutSearchDock";
import { useScoutNavSearch } from "@/components/scout/ScoutNavSearchContext";
import { ScoutEmptyState as ScoutSceneEmptyState } from "@/components/scout/ScoutEmptyState";
import {
  GoogleMapSurface,
  preloadGoogleMapsScript,
} from "@/components/maps/google-map-surface";
import { MapErrorBoundary } from "@/components/maps/map-error-boundary";
import { GOOGLE_MAPS_WEB_API_KEY } from "@/lib/mapProvider";
import { apiUrl } from "@/lib/api";
import {
  getEventCalendarDay,
  getRestaurantOpenState,
  getScoutRecenterDecision,
  shouldShowRestaurantMarker,
} from "@/lib/scoutMapTruth";
import {
  getScoutHostParkingCopy,
  getScoutParkingInventoryStatus,
  type ScoutParkingInventoryStatus,
} from "@/lib/scoutParkingPassTruth";
import { toast } from "@/hooks/use-toast";
import { buildPublicProfilePath } from "@/lib/public-profile-path";
import {
  getDishCategoryPhoto,
  type DishCategoryPhoto,
} from "@/lib/dishCategoryPhoto";
import type {
  MapAdapterMarker,
  MapBoundsLike,
} from "@/components/maps/map-adapter.types";
const mealScoutIcon = "/brand/meal-scout-icon.png";
import {
  SCOUT_HORIZONTAL_ROW_REGISTRY,
  SCOUT_MIN_MENU_BUSINESS_DIVERSITY,
  assignScoutBusinessCardsBySection,
  getScoutCanonicalBusinessKey,
  normalizeScoutBusinessKind,
  withScoutDishOwners,
  rotateScoutSpots,
  selectDistinctScoutMenuBusinesses,
  type ScoutHorizontalRowId,
  type ScoutNormalizedCardKind,
} from "@/features/scout/scoutDiscoveryModel";
import {
  buildScoutResultViewModel,
  type ScoutResultViewModel,
} from "@/features/scout/scoutResultViewModel";
import type { ScoutSceneLane, ScoutSceneId } from "@/features/scout/scoutTypes";

const ThemedScoutMap = lazy(
  () => import("@/components/maps/themed-scout-map-v2"),
);

/**
 * Atmospheric page background.
 * `/atmospheric/foodpark-night-hero.jpg` is the originally approved
 * Atmospheric UI reference (commit 4011a0b7). Swap this constant to point
 * at a different asset under `client/public/atmospheric/` if a new approved
 * background is provided. Known alternates already shipped:
 *   - /atmospheric/mealscout-welcome-map-night.png (welcome map-pin scene)
 */
const SCOUT_BACKGROUND_IMAGE = "/atmospheric/foodpark-night-hero.jpg";
const PENSACOLA_LAUNCH_MARKET = {
  label: "Pensacola, FL",
  lat: 30.4213,
  lng: -87.2169,
  marketKey: "pensacola-fl",
} as const;

function formatScoutMarketLabel({
  city,
  state,
  marketKey,
  fallbackLabel,
}: {
  city?: string | null;
  state?: string | null;
  marketKey?: string | null;
  fallbackLabel?: string;
}): string {
  const normalizedCity = String(city || "").trim();
  const normalizedState = String(state || "").trim();
  if (normalizedCity && normalizedState)
    return `${normalizedCity}, ${normalizedState}`;
  if (normalizedCity) return normalizedCity;
  if (normalizedState) return normalizedState;

  const normalizedMarketKey = String(marketKey || "")
    .trim()
    .toLowerCase();
  if (normalizedMarketKey) {
    const parts = normalizedMarketKey
      .split("-")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      const stateCandidate = parts[parts.length - 1];
      const cityLabel = parts
        .slice(0, -1)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
      const stateLabel =
        stateCandidate.length <= 3
          ? stateCandidate.toUpperCase()
          : stateCandidate.charAt(0).toUpperCase() + stateCandidate.slice(1);
      return cityLabel ? `${cityLabel}, ${stateLabel}` : stateLabel;
    }
  }

  return fallbackLabel || "Your market";
}

type MapRuntimeResponse = {
  hasGoogleMapsKey: boolean;
  googleMapsApiKey?: string | null;
  hasGoogleMapsMapId?: boolean;
  googleMapsMapId?: string | null;
};

/**
 * /scout — The canonical MealScout food discovery page.
 * Legacy explore routes redirect here from App.tsx.
 *
 * Goals (from Thomas):
 *  1. Live interactive Google Map REPLACES the food-park hero photo.
 *  2. The user's location is centered such that their pin renders in the
 *     RIGHT QUADRANT of the visible hero map. (The hero text on the left
 *     visually balances the layout.)
 *  3. No "Explore the Map" CTA — the map IS the page.
 *  4. Section order under the hero: Live Now first, Explore by Craving
 *     second, then restored discovery sections (Deals, Events, Favorites).
 *  5. Pull DOWN on the page → map full-screens. A floating "Collapse"
 *     button (top-right of map) returns to default sheet position.
 *  6. Bottom nav drops "Scout" (it conflicted with Explore + the search
 *     button in the top bar). Four items: Explore / Saved / Alerts / Profile.
 */

/* ============================================================
   TYPES
   ============================================================ */

interface LiveTruckSummary {
  id: string;
  name: string;
  cuisineType?: string | null;
  imageUrl?: string | null;
  heroImageUrl?: string | null;
  coverImageUrl?: string | null;
  logoUrl?: string | null;
  city?: string | null;
  state?: string | null;
  address?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  currentLatitude?: number | string | null;
  currentLongitude?: number | string | null;
  lat?: number | string | null;
  lng?: number | string | null;
  distance?: number | null;
  distanceMiles?: number | null;
  waitMinutes?: number | null;
  estimatedWaitMinutes?: number | null;
  vibe?: string | null;
  crowdLevel?: string | null;
  mobileOnline?: boolean;
  lastBroadcastAt?: string | null;
  liveUntilAt?: string | null;
  liveBroadcasting?: boolean | null;
  location_state?: "green" | "amber" | "hidden" | null;
  locationState?: "green" | "amber" | "hidden" | null;
  serviceStatus?: string | null;
  status?: string | null;
  operatingStatus?: string | null;
  activeDealCount?: number | null;
}

type LiveTrucksResponse =
  | { trucks?: LiveTruckSummary[] }
  | LiveTruckSummary[]
  | null;

interface DealSummary {
  id: string;
  title?: string | null;
  description?: string | null;
  restaurantName?: string | null;
  imageUrl?: string | null;
  discountText?: string | null;
}

type DealsResponse = { deals?: DealSummary[] } | DealSummary[] | null;

interface EventSummary {
  id: string;
  title?: string | null;
  name?: string | null;
  startsAt?: string | null;
  date?: string | null;
  startTime?: string | null;
  venueName?: string | null;
  locationName?: string | null;
  imageUrl?: string | null;
  heroImageUrl?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  lat?: number | null;
  lng?: number | null;
  venueLat?: number | null;
  venueLng?: number | null;
  host?: {
    businessName?: string | null;
    latitude?: number | string | null;
    longitude?: number | string | null;
  } | null;
}

type EventsResponse = { events?: EventSummary[] } | EventSummary[] | null;

interface ScoutHostLocation {
  id?: string | null;
  hostId?: string | null;
  businessName?: string | null;
  name?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  spotImageUrl?: string | null;
  locationType?: string | null;
  updatedAt?: string | null;
  lastUpdatedAt?: string | null;
  confirmedAt?: string | null;
  lastConfirmedAt?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
}

interface ScoutMapEventLocation {
  id?: string | null;
  type?: "event" | "truck_manual_schedule" | string | null;
  name?: string | null;
  date?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  hostId?: string | null;
  hostName?: string | null;
  hostAddress?: string | null;
  hostCity?: string | null;
  hostState?: string | null;
  hostLatitude?: number | string | null;
  hostLongitude?: number | string | null;
  truckId?: string | null;
  bookedRestaurantId?: string | null;
  truckName?: string | null;
  manualScheduleId?: string | null;
  lastConfirmedAt?: string | null;
}

interface ScoutParkingPassListing {
  id?: string | null;
  date?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  status?: string | null;
  hardCapEnabled?: boolean | null;
  maxTrucks?: number | null;
  spotCount?: number | null;
  bookedSpots?: number | null;
  availableSpotNumbers?: number[] | null;
  hostPriceCents?: number | null;
  breakfastPriceCents?: number | null;
  lunchPriceCents?: number | null;
  dinnerPriceCents?: number | null;
  dailyPriceCents?: number | null;
  weeklyPriceCents?: number | null;
  monthlyPriceCents?: number | null;
  host?: ScoutHostLocation | null;
  bookings?: Array<{
    truckId?: string | null;
    truckName?: string | null;
    slotType?: string | null;
    spotNumber?: number | null;
  }> | null;
}

type MapLocationsResponse = {
  hostLocations?: ScoutHostLocation[];
  eventLocations?: ScoutMapEventLocation[];
  supplierLocations?: unknown[];
} | null;

interface RestaurantSummary {
  id: string;
  businessName?: string | null;
  name?: string | null;
  slug?: string | null;
  cuisineType?: string | null;
  logoUrl?: string | null;
  coverImageUrl?: string | null;
  heroImageUrl?: string | null;
  imageUrl?: string | null;
  city?: string | null;
  state?: string | null;
  neighborhood?: string | null;
  address?: string | null;
  activeDealsCount?: number;
  activeDealCount?: number;
  favoriteCount?: number | null;
  followCount?: number | null;
  recommendationCount?: number | null;
  videoRecommendationCount?: number | null;
  communityActivityCount?: number | null;
  homeRankingScore?: number | null;
  homeRankingReason?: string | null;
  distanceMiles?: number | null;
  distance?: number | null;
  description?: string | null;
  businessType?: string | null;
  entityType?: string | null;
  profileType?: string | null;
  isFoodTruck?: boolean | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  lat?: number | null;
  lng?: number | null;
  isOpen?: boolean | null;
  openNow?: boolean | null;
  openStatus?: string | null;
  hoursStatus?: string | null;
}

interface MenuPreviewItem {
  id: string;
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  priceCents?: number | null;
}

interface LocalMenuItemFeedItem extends MenuPreviewItem {
  restaurantId: string;
  restaurantName?: string | null;
  restaurantCity?: string | null;
  restaurantState?: string | null;
  restaurantLogoUrl?: string | null;
  restaurantCoverImageUrl?: string | null;
  cuisineType?: string | null;
  businessType?: string | null;
  isFoodTruck?: boolean | null;
  distanceMiles?: number | null;
  dietaryTags?: string[] | null;
  discoveryReasons?: string[] | null;
  discoveryScore?: number | null;
  updatedAt?: string | null;
  dishRecommendationCount?: number | null;
  cvsScore?: number | null;
}

interface TrendingPlaceSummary {
  id: string;
  name: string;
  city?: string | null;
  state?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  cuisineType?: string | null;
  logoUrl?: string | null;
  coverImageUrl?: string | null;
  businessType?: string | null;
  isFoodTruck?: boolean | null;
  clicks?: number | null;
  events?: number | null;
  videoRecommendations?: number | null;
  trendScore?: number | null;
}

interface TrendingDishSummary {
  id: string;
  name: string;
  description?: string | null;
  priceCents?: number | null;
  imageUrl?: string | null;
  restaurantId: string;
  restaurantName?: string | null;
  restaurantCity?: string | null;
  restaurantState?: string | null;
  restaurantLogoUrl?: string | null;
  restaurantCoverImageUrl?: string | null;
  cuisineType?: string | null;
  clicks?: number | null;
  impressions?: number | null;
  trendScore?: number | null;
  businessType?: string | null;
  isFoodTruck?: boolean | null;
}

type ScoutTrendingResponse = {
  generatedAt: string;
  windowDays: number;
  items: TrendingDishSummary[];
  places: TrendingPlaceSummary[];
};

type ScoutGlobalSearchResponse = {
  query: string;
  restaurants: RestaurantSummary[];
  deals: DealSummary[];
  events: EventSummary[];
};

interface RestaurantRelationshipSnapshot {
  favoriteIds: Set<string>;
  followIds: Set<string>;
  recommendationIds: Set<string>;
}

type CravingCategory = {
  id: string;
  label: string;
  query: string;
  helper: string;
  keywords: string[];
  image: string;
};

type ScoutSceneLaneId = ScoutSceneId;

const SCOUT_SCENE_LANES: ScoutSceneLane[] = [
  {
    id: "for_you",
    label: "For You",
    icon: "spark",
    cravingId: "something-new",
  },
  {
    id: "community",
    label: "Community",
    icon: "community",
    cravingId: "something-new",
  },
  { id: "nearby_now", label: "Nearby", icon: "nearby", cravingId: "open-now" },
  {
    id: "food_trucks",
    label: "Food Trucks",
    icon: "truck",
    cravingId: "food-truck",
  },
  {
    id: "restaurants",
    label: "Restaurants",
    icon: "restaurant",
    cravingId: "sit-down",
  },
  { id: "deals", label: "Deals", icon: "deal", cravingId: "deals-today" },
  { id: "events", label: "Events", icon: "event", cravingId: "today" },
  {
    id: "new_menus",
    label: "New Menus",
    icon: "menu",
    cravingId: "something-new",
  },
  {
    id: "late_night",
    label: "Late Night",
    icon: "late",
    cravingId: "open-now",
  },
  {
    id: "worth_discovering",
    label: "Worth Discovering",
    icon: "discover",
    cravingId: "something-new",
  },
];

function getSceneOptionIcon(icon: ScoutSceneLane["icon"]) {
  if (icon === "spark")
    return <Compass className="h-3.5 w-3.5" aria-hidden="true" />;
  if (icon === "community")
    return <Users className="h-3.5 w-3.5" aria-hidden="true" />;
  if (icon === "nearby")
    return <Navigation2 className="h-3.5 w-3.5" aria-hidden="true" />;
  if (icon === "truck")
    return <Flame className="h-3.5 w-3.5" aria-hidden="true" />;
  if (icon === "restaurant")
    return <Utensils className="h-3.5 w-3.5" aria-hidden="true" />;
  if (icon === "deal")
    return <Tag className="h-3.5 w-3.5" aria-hidden="true" />;
  if (icon === "event")
    return <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />;
  if (icon === "menu")
    return <Bookmark className="h-3.5 w-3.5" aria-hidden="true" />;
  if (icon === "late")
    return <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />;
  return <Heart className="h-3.5 w-3.5" aria-hidden="true" />;
}

type Daypart = "morning" | "lunch" | "afternoon" | "dinner" | "late";

function getDaypart(date = new Date()): Daypart {
  const hour = date.getHours();
  if (hour >= 5 && hour < 10) return "morning";
  if (hour >= 10 && hour < 14) return "lunch";
  if (hour >= 14 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "dinner";
  return "late";
}

const DAYPART_DEFAULT_INTENT: Record<Daypart, string> = {
  morning: "coffee-breakfast",
  lunch: "quick-bite",
  afternoon: "snack-coffee",
  dinner: "sit-down",
  late: "open-now",
};

const DAYPART_SEARCH_COPY: Record<Daypart, { title: string; body: string }> = {
  morning: {
    title: "Start your day local.",
    body: "Coffee, breakfast, bakeries, and quick bites near you.",
  },
  lunch: {
    title: "Lunch without the scroll.",
    body: "Fast local options, food trucks, and solid deals near you.",
  },
  afternoon: {
    title: "Need a reset?",
    body: "Coffee, snacks, sweets, and low-effort local stops.",
  },
  dinner: {
    title: "Make dinner easier.",
    body: "Local food, deals, trucks, and events worth checking out.",
  },
  late: {
    title: "Still hungry?",
    body: "Open spots, late bites, and local food still open.",
  },
};

const SCOUT_SEARCH_OPTIONS: CravingCategory[] = [
  {
    id: "open-now",
    label: "Open now",
    query: "open now",
    helper: "Food you can actually get right now",
    keywords: ["open", "serving", "available", "pickup", "late"],
    image: "/atmospheric/craving-burgers.jpg",
  },
  {
    id: "quick-bite",
    label: "Quick bite",
    query: "quick bite",
    helper: "Fast, low-friction food nearby",
    keywords: [
      "quick",
      "fast",
      "lunch",
      "pickup",
      "sandwich",
      "taco",
      "burger",
      "truck",
    ],
    image: "/atmospheric/craving-burgers.jpg",
  },
  {
    id: "deals-today",
    label: "Deals today",
    query: "deals",
    helper: "Local value without digging",
    keywords: ["deal", "special", "discount", "offer", "value", "happy hour"],
    image: "/atmospheric/craving-pizza.jpg",
  },
  {
    id: "today",
    label: "Today",
    query: "happening today",
    helper: "Food activity happening today",
    keywords: ["today", "event", "pop-up", "deal", "menu", "serving", "open"],
    image: "/atmospheric/craving-tacos.jpg",
  },
  {
    id: "food-truck",
    label: "Food truck",
    query: "food truck",
    helper: "Mobile kitchens nearby",
    keywords: ["truck", "mobile", "pop-up", "street", "serving"],
    image: "/atmospheric/craving-tacos.jpg",
  },
  {
    id: "coffee-breakfast",
    label: "Coffee & breakfast",
    query: "coffee breakfast",
    helper: "Start the day local",
    keywords: [
      "coffee",
      "breakfast",
      "bakery",
      "biscuit",
      "bagel",
      "pastry",
      "brunch",
      "taco",
    ],
    image: "/atmospheric/craving-dessert.jpg",
  },
  {
    id: "snack-coffee",
    label: "Snack & coffee",
    query: "coffee snack dessert",
    helper: "A useful reset between meals",
    keywords: [
      "coffee",
      "snack",
      "dessert",
      "sweet",
      "bakery",
      "pastry",
      "tea",
    ],
    image: "/atmospheric/craving-dessert.jpg",
  },
  {
    id: "something-new",
    label: "Something new",
    query: "new menu items",
    helper: "Fresh menu drops and new local finds",
    keywords: ["new", "fresh", "menu", "drop", "special", "limited", "popular"],
    image: "/atmospheric/craving-ramen.jpg",
  },
  {
    id: "sit-down",
    label: "Sit-down",
    query: "sit down dinner",
    helper: "A real meal, not just a snack",
    keywords: [
      "dinner",
      "restaurant",
      "table",
      "plate",
      "meal",
      "group",
      "date",
    ],
    image: "/atmospheric/craving-pizza.jpg",
  },
  {
    id: "sweet-tooth",
    label: "Sweet tooth",
    query: "dessert bakery sweets",
    helper: "Dessert, bakeries, and treats",
    keywords: [
      "dessert",
      "ice cream",
      "cake",
      "pastry",
      "sweet",
      "chocolate",
      "bakery",
    ],
    image: "/atmospheric/craving-dessert.jpg",
  },
  {
    id: "tacos",
    label: "Tacos",
    query: "tacos",
    helper: "Quick, bold, easy to share",
    keywords: ["taco", "mexican", "carne", "al pastor", "barbacoa", "salsa"],
    image: "/atmospheric/craving-tacos.jpg",
  },
  {
    id: "burgers",
    label: "Burgers",
    query: "burgers",
    helper: "Comfort food, no fuss",
    keywords: ["burger", "smash", "cheese", "patty", "fries", "comfort"],
    image: "/atmospheric/craving-burgers.jpg",
  },
  {
    id: "ramen",
    label: "Ramen",
    query: "ramen",
    helper: "Warm bowl, slow sip",
    keywords: ["ramen", "noodle", "broth", "tonkotsu", "miso", "asian"],
    image: "/atmospheric/craving-ramen.jpg",
  },
  {
    id: "pizza",
    label: "Pizza",
    query: "pizza",
    helper: "Easy win for the table",
    keywords: ["pizza", "slice", "pepperoni", "italian", "wood", "neapolitan"],
    image: "/atmospheric/craving-pizza.jpg",
  },
  {
    id: "drinks",
    label: "Drinks",
    query: "drinks",
    helper: "Bar energy, sip and stay",
    keywords: ["bar", "cocktail", "wine", "beer", "drink", "lounge", "spritz"],
    image: "/atmospheric/craving-drinks.jpg",
  },
  {
    id: "dessert",
    label: "Dessert",
    query: "dessert",
    helper: "Sweet finish, any time",
    keywords: ["dessert", "ice cream", "cake", "pastry", "sweet", "chocolate"],
    image: "/atmospheric/craving-dessert.jpg",
  },
];

type CravingBoardItem = {
  id: string;
  kind: "Menu" | "Place" | "Truck" | "Deal" | "Event";
  title: string;
  subtitle: string;
  href: string;
  restaurantId?: string | null;
  truckId?: string | null;
  dealId?: string | null;
  imageUrl?: string | null;
  priceCents?: number | null;
  meta?: string | null;
  reason?: string | null;
  freshnessMeta?: FreshnessMeta;
  score: number;
};

function getDecisionMarker(
  item: CravingBoardItem,
  markers: MapAdapterMarker[],
): MapAdapterMarker | null {
  const expectedKind =
    item.kind === "Truck"
      ? "truck"
      : item.kind === "Deal"
        ? "deal"
        : item.kind === "Event"
          ? "event"
          : "restaurant";
  const sourceId =
    item.truckId ||
    item.dealId ||
    item.restaurantId ||
    (item.kind === "Event" ? item.id.replace(/^event-/, "") : null);
  if (!sourceId) return null;
  return (
    markers.find(
      (marker) =>
        marker.kind === expectedKind &&
        String(marker.sourceId) === String(sourceId),
    ) || null
  );
}

type LocalActivityItem = {
  id: string;
  type: "menu_update" | "deal" | "truck" | "event" | "host" | "open" | "update";
  title: string;
  subtitle: string;
  href: string;
  entityId: string;
  timeLabel?: string | null;
  sourceLabel?: string | null;
  freshnessMeta: FreshnessMeta;
};

type ScoutActivityMode = "high_activity" | "medium_activity" | "low_activity";

type ScoutActivityInputs = {
  servingTruckCount: number;
  openRestaurantCount: number;
  dealCount: number;
  eventCount: number;
  menuUpdateCount: number;
  activityItemCount: number;
  mapMarkerCount: number;
};

type DiscoveryLayerId =
  | "localBoard"
  | "cravings"
  | "trending"
  | "menuItems"
  | "foodTrucks"
  | "restaurants"
  | "deals"
  | "events";

const DISCOVERY_LAYERS: Record<
  DiscoveryLayerId,
  { title: string; href: string; subtitle?: string }
> = {
  localBoard: {
    title: "Community Picks",
    href: "/scout",
  },
  cravings: {
    title: "Search by Craving",
    href: "/search",
    subtitle: "Search dishes, trucks, places, and events by what sounds good.",
  },
  trending: {
    title: "Local Activity",
    href: "/search",
  },
  menuItems: {
    title: "Menu Highlights",
    href: "/search",
  },
  foodTrucks: {
    title: "Food Trucks Today",
    href: "/search?q=food%20truck",
    subtitle: "Food trucks currently serving or active nearby today.",
  },
  restaurants: {
    title: "Nearby Restaurants",
    href: "/search",
    subtitle: "Open restaurants and local spots close to you.",
  },
  deals: {
    title: "Hot Deals",
    href: "/deals/featured",
    subtitle: "Active offers from nearby restaurants, bars, and food trucks.",
  },
  events: {
    title: "Events & Pop-Ups",
    href: "/events",
    subtitle: "Events, pop-ups, and local food moments near you.",
  },
};

function getMetaDistance(meta: string): string | null {
  const match = meta.match(/(\d+(?:\.\d+)?)\s*mi\b/i);
  if (!match) return null;
  const value = match[1];
  return `${value} mi`;
}

type FreshnessState = "fresh" | "aging" | "needs_update" | "unknown";

type FreshnessMeta = {
  kind?:
    | CravingBoardItem["kind"]
    | "event"
    | "host"
    | "restaurant"
    | "truck"
    | "deal"
    | "menu";
  meta?: string | null;
  reason?: string | null;
  startsAt?: string | null;
  startTime?: string | null;
  updatedAt?: string | null;
  lastUpdatedAt?: string | null;
  confirmedAt?: string | null;
  lastConfirmedAt?: string | null;
  hasDeal?: boolean;
  hasMenu?: boolean;
  hasCommunityUpdate?: boolean;
  hasDistance?: boolean;
  isOpen?: boolean;
  closesSoon?: boolean;
};

type MapLayerId = "openNow" | "foodTrucks" | "deals" | "happeningToday";

type MapLayerState = Record<MapLayerId, boolean>;
type ScoutSourceStatusKey =
  | "trucks"
  | "restaurants"
  | "mapLocations"
  | "deals"
  | "events"
  | "menus";

function readStringField(source: unknown, fields: string[]): string | null {
  if (!source || typeof source !== "object") return null;
  const record = source as Record<string, unknown>;
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function readBooleanField(source: unknown, fields: string[]): boolean | null {
  if (!source || typeof source !== "object") return null;
  const record = source as Record<string, unknown>;
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "open", "serving", "available", "yes"].includes(normalized))
        return true;
      if (
        ["false", "closed", "not_open", "unavailable", "no"].includes(
          normalized,
        )
      )
        return false;
    }
  }
  return null;
}

function getRestaurantEntityType(
  source: Pick<
    RestaurantSummary,
    "businessType" | "entityType" | "profileType" | "isFoodTruck"
  >,
): "restaurant" | "truck" | "bar" | "unknown" {
  const normalizedKind = normalizeScoutBusinessKind(source, "restaurant");
  if (normalizedKind === "food_truck") return "truck";
  if (
    isBarBusinessType(
      source.entityType || source.profileType || source.businessType,
    )
  ) {
    return "bar";
  }
  if (normalizedKind === "restaurant") return "restaurant";
  return "unknown";
}

function getRestaurantProfilePath(restaurant: RestaurantSummary): string {
  const entityType = getRestaurantEntityType(restaurant);
  return (
    buildPublicProfilePath({
      entityType: entityType === "unknown" ? "restaurant" : entityType,
      id: restaurant.id,
      slug: restaurant.slug,
      name: restaurant.businessName || restaurant.name,
    }) || `/restaurant/${encodeURIComponent(String(restaurant.id))}`
  );
}

function getScoutRestaurantLikeKind(
  source: RestaurantSummary | TrendingPlaceSummary,
): ScoutNormalizedCardKind {
  return normalizeScoutBusinessKind(source, "restaurant");
}

function getScoutBusinessCardKey(
  source: RestaurantSummary | LiveTruckSummary | TrendingPlaceSummary,
  route?: string | null,
): string | null {
  return getScoutCanonicalBusinessKey(source, route);
}

function getTruckProfilePath(truck: LiveTruckSummary): string {
  return (
    buildPublicProfilePath({
      entityType: "truck",
      id: truck.id,
      name: truck.name,
    }) || `/truck/${encodeURIComponent(String(truck.id))}`
  );
}

function getMenuItemProfilePath(item: LocalMenuItemFeedItem): string {
  const ownerKind = normalizeScoutBusinessKind(item, "restaurant");
  return (
    buildPublicProfilePath({
      entityType: ownerKind === "food_truck" ? "truck" : "restaurant",
      id: item.restaurantId,
      name: item.restaurantName,
      businessType: item.businessType,
    }) || `/restaurant/${encodeURIComponent(String(item.restaurantId))}`
  );
}

function getScoutMenuItemBusinessKey(
  item: LocalMenuItemFeedItem,
): string | null {
  return getScoutCanonicalBusinessKey(item, getMenuItemProfilePath(item));
}

function getTrendingPlaceProfilePath(place: TrendingPlaceSummary): string {
  const placeKind = getScoutRestaurantLikeKind(place);
  return (
    buildPublicProfilePath({
      entityType:
        placeKind === "food_truck"
          ? "truck"
          : isBarBusinessType(place.businessType)
            ? "bar"
            : "restaurant",
      id: place.id,
      name: place.name,
    }) || `/restaurant/${encodeURIComponent(String(place.id))}`
  );
}

function getCurrentUserId(user: unknown): string | null {
  return readStringField(user, ["id", "userId"]);
}

function isFoodOperator(user: unknown): boolean {
  const userType = readStringField(user, ["userType", "role", "primaryRole"]);
  return userType === "restaurant_owner" || userType === "food_truck";
}

function isOwnedByCurrentUser(
  entity: unknown,
  currentUserId?: string | null,
): boolean {
  if (!currentUserId) return false;
  const ownerId = readStringField(entity, [
    "ownerId",
    "ownerUserId",
    "userId",
    "vendorUserId",
    "restaurantOwnerId",
    "truckOwnerId",
    "businessOwnerId",
    "coordinatorUserId",
  ]);
  return ownerId === currentUserId;
}

function isTruckBroadcastLive(truck: LiveTruckSummary): boolean {
  return (
    deriveTruckPresence(
      {
        mobileOnline: truck.mobileOnline,
        liveBroadcasting: truck.liveBroadcasting,
        currentLatitude: truck.currentLatitude,
        currentLongitude: truck.currentLongitude,
        lastBroadcastAt: truck.lastBroadcastAt,
        liveUntilAt: truck.liveUntilAt,
        locationSource: readStringField(truck, ["locationSource", "location_source"]),
      },
      { freshnessMs: DEFAULT_TRUCK_BROADCAST_FRESHNESS_MS },
    ).broadcastState === "live"
  );
}

function isTruckServingNow(truck: LiveTruckSummary): boolean {
  const explicit = readBooleanField(truck, [
    "isServing",
    "servingNow",
    "availableNow",
    "liveNow",
  ]);
  if (explicit !== null) return explicit;

  const locationState = readStringField(truck, [
    "location_state",
    "locationState",
  ]);
  if (locationState) {
    const normalized = locationState.toLowerCase();
    if (normalized === "green") return true;
    return false;
  }

  return isTruckBroadcastLive(truck);
}

function getKnownTimestamp(
  meta: FreshnessMeta,
): { value: string; type: "updated" | "confirmed" } | null {
  const updated = meta.updatedAt || meta.lastUpdatedAt;
  if (updated) return { value: updated, type: "updated" };
  const confirmed = meta.confirmedAt || meta.lastConfirmedAt;
  if (confirmed) return { value: confirmed, type: "confirmed" };
  return null;
}

function formatFreshnessTime(
  timestamp: string,
): { state: FreshnessState; label: string } | null {
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) return null;

  const now = Date.now();
  const ageMinutes = Math.max(0, Math.floor((now - time) / 60000));
  const eventDate = new Date(time);
  const today = new Date();
  const isToday =
    eventDate.getFullYear() === today.getFullYear() &&
    eventDate.getMonth() === today.getMonth() &&
    eventDate.getDate() === today.getDate();

  if (ageMinutes < 60) {
    return {
      state: "fresh",
      label: "Updated today",
    };
  }
  if (isToday) return { state: "fresh", label: "Updated today" };
  if (ageMinutes < 60 * 24 * 3) return { state: "aging", label: "" };
  return { state: "needs_update", label: "" };
}

function isTodayDate(value?: string | null): boolean {
  if (!value) return false;
  const dateOnly = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const today = new Date();
    return (
      Number(dateOnly[1]) === today.getFullYear() &&
      Number(dateOnly[2]) === today.getMonth() + 1 &&
      Number(dateOnly[3]) === today.getDate()
    );
  }
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return false;
  const date = new Date(time);
  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

function getFreshnessState(entityOrMeta: FreshnessMeta): FreshnessState {
  const timestamp = getKnownTimestamp(entityOrMeta);
  if (timestamp)
    return formatFreshnessTime(timestamp.value)?.state ?? "unknown";
  if (
    entityOrMeta.isOpen ||
    entityOrMeta.hasDeal ||
    entityOrMeta.hasMenu ||
    isTodayDate(entityOrMeta.startsAt || entityOrMeta.startTime)
  ) {
    return "fresh";
  }
  if (entityOrMeta.hasDistance || entityOrMeta.hasCommunityUpdate)
    return "unknown";
  return "unknown";
}

function getFreshnessLabel(entityOrMeta: FreshnessMeta): string {
  const timestamp = getKnownTimestamp(entityOrMeta);
  if (timestamp) {
    const formatted = formatFreshnessTime(timestamp.value);
    if (formatted) {
      if (timestamp.type === "confirmed" && formatted.label === "Updated today")
        return "Confirmed today";
      if (
        timestamp.type === "confirmed" &&
        formatted.label.startsWith("Updated ")
      ) {
        return formatted.label.replace("Updated", "Confirmed");
      }
      return formatted.label;
    }
  }

  if (
    entityOrMeta.hasMenu ||
    entityOrMeta.kind === "Menu" ||
    entityOrMeta.kind === "menu"
  )
    return "Menu updated";
  if (
    entityOrMeta.hasDeal ||
    entityOrMeta.kind === "Deal" ||
    entityOrMeta.kind === "deal"
  )
    return "Deal today";
  if (
    (entityOrMeta.kind === "Truck" || entityOrMeta.kind === "truck") &&
    entityOrMeta.isOpen
  )
    return "Serving now";
  if (isTodayDate(entityOrMeta.startsAt || entityOrMeta.startTime))
    return "Happening today";
  if (entityOrMeta.isOpen) return "Open now";
  if (entityOrMeta.hasDistance) return "Nearby now";
  return "Open near you";
}

function getSourceLabel(entityOrMeta: FreshnessMeta): string | null {
  if (entityOrMeta.hasCommunityUpdate) return "Community update";
  if (entityOrMeta.hasMenu) return "Menu updated";
  if (entityOrMeta.hasDeal) return "Deal today";
  return null;
}

function splitCuisineCategories(raw: string | null | undefined): string[] {
  return String(raw || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

// A business's cuisine field is often several categories crammed into one
// string (e.g. "Asian, Hawaiian, Korean BBQ") - showing all of them on a
// small dish card is exactly the kind of clutter that makes cards hard to
// scan. This picks exactly one: prefer a category matching the viewer's own
// interests (inferred from what they've favorited), otherwise a stable pick
// from the business's own list (same category every time for a given
// business, distributed across their categories rather than always the
// first one) so cards stay consistent without needing personalization data.
function pickDisplayCategory(
  cuisineTypeRaw: string | null | undefined,
  userInterestCuisines: Set<string>,
  seedKey: string,
): string | null {
  const categories = splitCuisineCategories(cuisineTypeRaw);
  if (categories.length === 0) return null;
  if (categories.length === 1) return categories[0];
  if (userInterestCuisines.size > 0) {
    const match = categories.find((c) =>
      userInterestCuisines.has(c.toLowerCase()),
    );
    if (match) return match;
  }
  let hash = 0;
  for (let i = 0; i < seedKey.length; i += 1) {
    hash = (hash * 31 + seedKey.charCodeAt(i)) >>> 0;
  }
  return categories[hash % categories.length];
}

// Reads the same react-query cache entry the main Scout page already
// populates (`/api/favorites/restaurants`) so dish cards can infer "cuisines
// this viewer likes" without a separate fetch or prop-drilling the favorites
// list through every card's parent.
function useFavoriteCuisineInterests(
  currentUserId?: string | null,
): Set<string> {
  const { data: favoriteRestaurantsData = [] } = useQuery<any[]>({
    queryKey: ["/api/favorites/restaurants", "scout"],
    enabled: !!currentUserId,
    queryFn: async () => {
      const response = await fetch("/api/favorites/restaurants", {
        credentials: "include",
      });
      if (!response.ok) return [];
      return response.json();
    },
    staleTime: 60_000,
    retry: false,
  });
  return useMemo(() => {
    const cuisines = new Set<string>();
    for (const favorite of favoriteRestaurantsData) {
      for (const category of splitCuisineCategories(
        favorite?.restaurant?.cuisineType,
      )) {
        cuisines.add(category.toLowerCase());
      }
    }
    return cuisines;
  }, [favoriteRestaurantsData]);
}

function getOperationalBadges(entityOrMeta: FreshnessMeta): string[] {
  const labels = new Set<string>();
  const freshnessLabel = getFreshnessLabel(entityOrMeta);
  if (freshnessLabel) labels.add(freshnessLabel);
  const sourceLabel = getSourceLabel(entityOrMeta);
  if (sourceLabel) labels.add(sourceLabel);
  if (entityOrMeta.closesSoon) labels.add("Closes soon");
  if (entityOrMeta.kind === "Truck" || entityOrMeta.kind === "truck")
    labels.add("Food truck");
  if (
    entityOrMeta.hasDeal ||
    entityOrMeta.kind === "Deal" ||
    entityOrMeta.kind === "deal"
  )
    labels.add("Deal today");
  if (
    entityOrMeta.hasMenu ||
    entityOrMeta.kind === "Menu" ||
    entityOrMeta.kind === "menu"
  )
    labels.add("Menu updated");
  if (entityOrMeta.isOpen)
    labels.add(
      entityOrMeta.kind === "Truck" || entityOrMeta.kind === "truck"
        ? "Serving now"
        : "Open now",
    );
  if (entityOrMeta.hasDistance) labels.add("Nearby");
  if (isTodayDate(entityOrMeta.startsAt || entityOrMeta.startTime))
    labels.add("Happening today");
  const allowedLabels = new Set([
    "Open now",
    "Serving now",
    "Updated today",
    "Confirmed today",
    "Deal today",
    "Menu updated",
    "Food truck",
  ]);
  return [...labels].filter((label) => allowedLabels.has(label));
}

function getFreshnessBadgeClass(meta: FreshnessMeta, label: string): string {
  const base =
    "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1";
  if (getFreshnessState(meta) === "needs_update") {
    return `${base} bg-amber-300/14 text-amber-100 ring-amber-200/20`;
  }
  if (getFreshnessState(meta) === "aging") {
    return `${base} bg-white/8 text-orange-100/78 ring-white/10`;
  }
  return `${base} bg-emerald-300/12 text-emerald-100 ring-emerald-200/20`;
}

function getRestaurantUpdateHref(
  restaurantId: string,
  setup: "status" | "location" | "menu" | "deal",
): string {
  if (setup === "menu") {
    return `/menu-builder?src=scout&restaurantId=${encodeURIComponent(restaurantId)}`;
  }
  if (setup === "deal") {
    return `/deal-creation?src=scout&restaurantId=${encodeURIComponent(restaurantId)}`;
  }
  return `/restaurant-owner-dashboard?src=scout&setup=${setup}&restaurantId=${encodeURIComponent(restaurantId)}`;
}

function getTruckUpdateHref(
  truckId: string,
  setup: "status" | "location" | "menu" | "deal",
): string {
  return getRestaurantUpdateHref(truckId, setup);
}

function getMapMarkerColor(meta: FreshnessMeta): string {
  if (meta.kind === "Truck" || meta.kind === "truck") return "#ff6f3c";
  if (meta.hasDeal || meta.kind === "Deal" || meta.kind === "deal")
    return "#22c55e";
  if (meta.kind === "event") return "#f59e0b";
  if (getFreshnessState(meta) === "fresh") return "#14b8a6";
  return "#f97316";
}

function getMapMarkerSubtitle(
  base: string | null | undefined,
  meta: FreshnessMeta,
): string | undefined {
  const status = getOperationalBadges(meta)
    .filter((label) => label !== "Open near you")
    .slice(0, 2)
    .join(" · ");
  return [status, base].filter(Boolean).join(" · ") || undefined;
}

function getScoutActivityMode({
  servingTruckCount,
  openRestaurantCount,
  dealCount,
  eventCount,
  menuUpdateCount,
  activityItemCount,
  mapMarkerCount,
}: ScoutActivityInputs): ScoutActivityMode {
  const activityScore =
    servingTruckCount * 3 +
    openRestaurantCount * 2 +
    dealCount * 2 +
    eventCount * 2 +
    menuUpdateCount +
    activityItemCount;

  if (
    activityScore >= 12 ||
    mapMarkerCount >= 10 ||
    (servingTruckCount >= 2 &&
      dealCount + eventCount + openRestaurantCount >= 3)
  ) {
    return "high_activity";
  }

  if (
    activityScore >= 3 ||
    servingTruckCount > 0 ||
    openRestaurantCount > 0 ||
    dealCount > 0 ||
    eventCount > 0
  ) {
    return "medium_activity";
  }

  return "low_activity";
}

function getActivityRailTitle(mode: ScoutActivityMode): string {
  if (mode === "high_activity") return "Happening right now nearby";
  if (mode === "medium_activity") return "Open Near You";
  return "Worth checking out nearby";
}

function getActivityRailSubtitle(mode: ScoutActivityMode): string {
  if (mode === "high_activity") {
    return "Food trucks, open places, deals, events, and menu updates near you.";
  }
  if (mode === "medium_activity") {
    return "Open places, food trucks, deals, and updates close to you.";
  }
  return "Local places and upcoming food activity around you.";
}

function getRestaurantIdFromActivity(item: LocalActivityItem): string | null {
  const hrefMatch = item.href.match(/^\/restaurant\/([^/?#]+)/);
  return hrefMatch?.[1] ? decodeURIComponent(hrefMatch[1]) : null;
}

/* ============================================================
   FORMATTERS
   ============================================================ */

function formatDistance(truck: LiveTruckSummary): string | null {
  const miles = truck.distanceMiles;
  if (typeof miles === "number" && Number.isFinite(miles)) {
    return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
  }
  const km = truck.distance;
  if (typeof km === "number" && Number.isFinite(km)) {
    const asMiles = km * 0.621371;
    return `${asMiles.toFixed(asMiles < 10 ? 1 : 0)} mi`;
  }
  return null;
}

function formatMiles(value?: number | null): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${value.toFixed(value < 10 ? 1 : 0)} mi`;
}

function readNumberField(source: unknown, fields: string[]): number | null {
  if (!source || typeof source !== "object") return null;
  const record = source as Record<string, unknown>;
  for (const field of fields) {
    const value = record[field];
    const parsed = typeof value === "string" ? Number(value) : value;
    if (typeof parsed === "number" && Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getBoundsForScoutLocation(
  location: { lat: number; lng: number },
  radiusKm: number,
) {
  const latDelta = radiusKm / 111.32;
  const lngDelta =
    radiusKm /
    (111.32 * Math.max(Math.cos((location.lat * Math.PI) / 180), 0.2));
  return {
    north: location.lat + latDelta,
    south: location.lat - latDelta,
    east: location.lng + lngDelta,
    west: location.lng - lngDelta,
  };
}

function getDistanceMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const hav =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusMiles * Math.asin(Math.min(1, Math.sqrt(hav)));
}

function getScoutHostMarkerKey(host: ScoutHostLocation): string {
  const id = String(host.hostId || host.id || "").trim();
  if (id) return id;
  const lat = readNumberField(host, ["latitude", "lat"]);
  const lng = readNumberField(host, ["longitude", "lng"]);
  if (lat !== null && lng !== null)
    return `${lat.toFixed(5)}:${lng.toFixed(5)}`;
  return (
    normalizeScoutLocationAddress(host.address, host.city, host.state) ||
    "host-location"
  );
}

function normalizeScoutLocationAddress(
  address?: string | null,
  city?: string | null,
  state?: string | null,
): string {
  return [address, city, state]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(usa|united states)\b/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

function timeStringToMinutes(value?: string | null): number | null {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function isScoutMapWindowActiveNow(row: {
  date?: string | null;
  startTime?: string | null;
  endTime?: string | null;
}): boolean {
  if (row.date && !isTodayDate(row.date)) return false;
  const start = timeStringToMinutes(row.startTime);
  const end = timeStringToMinutes(row.endTime);
  if (start === null || end === null) return true;
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (end < start) return nowMinutes >= start || nowMinutes <= end;
  return nowMinutes >= start && nowMinutes <= end;
}

function getRestaurantName(restaurant: RestaurantSummary): string {
  return restaurant.businessName || restaurant.name || "Local spot";
}

function getRestaurantDistance(restaurant: RestaurantSummary): string | null {
  if (typeof restaurant.distanceMiles === "number") {
    return formatMiles(restaurant.distanceMiles);
  }
  if (typeof restaurant.distance === "number") {
    return formatMiles(restaurant.distance * 0.621371);
  }
  return null;
}

function formatScoutCount(
  count: number,
  singular: string,
  plural: string,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatScoutResultSummary(count: number): string {
  if (count <= 0) return "Search or move the map";
  return `${count} ${count === 1 ? "spot" : "spots"} in this area`;
}

function getRestaurantArea(restaurant: RestaurantSummary): string | null {
  return restaurant.neighborhood || restaurant.city || null;
}

function getTruckArea(truck: LiveTruckSummary): string | null {
  return truck.city || truck.address || null;
}

function buildDirectionsUrl(source: {
  latitude?: number | string | null;
  longitude?: number | string | null;
  lat?: number | string | null;
  lng?: number | string | null;
}): string | null {
  const coordinates =
    resolveCoordinatePair(source.latitude, source.longitude) ??
    resolveCoordinatePair(source.lat, source.lng);
  if (!coordinates) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${coordinates.latitude},${coordinates.longitude}&travelmode=driving`;
}

function scoreTextForCraving(text: string, craving: CravingCategory): number {
  const haystack = text.toLowerCase();
  return craving.keywords.reduce(
    (score, keyword) => score + (haystack.includes(keyword) ? 1 : 0),
    0,
  );
}

function getRestaurantCravingScore(
  restaurant: RestaurantSummary,
  craving: CravingCategory,
): number {
  const text = `${getRestaurantName(restaurant)} ${restaurant.cuisineType || ""} ${restaurant.description || ""}`;
  return scoreTextForCraving(text, craving);
}

function getTruckCravingScore(
  truck: LiveTruckSummary,
  craving: CravingCategory,
): number {
  const text = `${truck.name} ${truck.cuisineType || ""} ${truck.vibe || ""}`;
  return scoreTextForCraving(text, craving);
}

function getMenuItemCravingScore(
  item: LocalMenuItemFeedItem,
  craving: CravingCategory,
): number {
  const text = `${item.name} ${item.description || ""} ${item.cuisineType || ""} ${(item.discoveryReasons || []).join(" ")}`;
  return scoreTextForCraving(text, craving);
}

function getDealCravingScore(
  deal: DealSummary,
  craving: CravingCategory,
): number {
  const text = `${deal.title || ""} ${deal.description || ""} ${deal.restaurantName || ""}`;
  return scoreTextForCraving(text, craving);
}

function getRestaurantDiscoveryReason(restaurant: RestaurantSummary): string {
  const reasons = [
    Number(restaurant.favoriteCount || 0) > 0 ? "saved by locals" : null,
    Number(restaurant.videoRecommendationCount || 0) > 0
      ? "recent video updates"
      : null,
    Number(restaurant.recommendationCount || 0) > 0
      ? "community updates"
      : null,
    Number(restaurant.activeDealsCount || restaurant.activeDealCount || 0) > 0
      ? "active deal"
      : null,
  ].filter(Boolean);
  return reasons.length > 0
    ? `${reasons.slice(0, 2).join(" + ")}`
    : "Open and nearby today.";
}

function getRestaurantCommunityScore(restaurant: RestaurantSummary): number {
  return (
    Number(restaurant.favoriteCount || 0) * 3 +
    Number(restaurant.followCount || 0) * 2 +
    Number(restaurant.recommendationCount || 0) * 4 +
    Number(restaurant.videoRecommendationCount || 0) * 5 +
    Number(restaurant.communityActivityCount || 0) * 4 +
    Number(restaurant.activeDealsCount || restaurant.activeDealCount || 0) * 2
  );
}

function getMenuItemSearchReason(item: LocalMenuItemFeedItem): string {
  if (item.discoveryReasons?.[0]) return "Menu updated";
  if (typeof item.discoveryScore === "number" && item.discoveryScore > 0) {
    return "Menu updated";
  }
  if (Array.isArray(item.dietaryTags) && item.dietaryTags.length > 0) {
    return item.dietaryTags.slice(0, 2).join(" + ");
  }
  return "Menu option";
}

function getRestaurantSearchReason(restaurant: RestaurantSummary): string {
  return getRestaurantDiscoveryReason(restaurant);
}

function resolveScoutBusinessImage(input: {
  coverImageUrl?: string | null;
  heroImageUrl?: string | null;
  imageUrl?: string | null;
  logoUrl?: string | null;
}): string | null {
  const assets: BusinessMediaAsset[] = [
    ...(input.coverImageUrl
      ? [{ kind: "cover" as const, image: input.coverImageUrl, publicApproved: true }]
      : []),
    ...(input.heroImageUrl
      ? [{ kind: "hero" as const, image: input.heroImageUrl, publicApproved: true }]
      : []),
    ...(input.imageUrl
      ? [{ kind: "legacy" as const, image: input.imageUrl, publicApproved: true }]
      : []),
    ...(input.logoUrl
      ? [{ kind: "logo" as const, image: input.logoUrl, publicApproved: true }]
      : []),
  ];
  return resolveBusinessMedia(assets, "scout_card")?.url || null;
}

function getRestaurantImage(restaurant: RestaurantSummary): string | null {
  return resolveScoutBusinessImage(restaurant);
}

function getTruckImage(truck: LiveTruckSummary): string | null {
  return resolveScoutBusinessImage(truck);
}

function buildCravingBoardItems({
  craving,
  liveTrucks,
  restaurants,
  menuItems,
  deals,
  events,
}: {
  craving: CravingCategory;
  liveTrucks: LiveTruckSummary[];
  restaurants: RestaurantSummary[];
  menuItems: LocalMenuItemFeedItem[];
  deals: DealSummary[];
  events: EventSummary[];
}): CravingBoardItem[] {
  const used = new Set<string>();
  const addPick = (
    items: CravingBoardItem[],
    pick: CravingBoardItem | null,
  ) => {
    if (!pick || used.has(pick.id)) return;
    used.add(pick.id);
    items.push(pick);
  };

  const rankedMenuItems = menuItems
    .map((item) => ({ item, score: getMenuItemCravingScore(item, craving) }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.item.discoveryScore ?? 0) - (a.item.discoveryScore ?? 0) ||
        (a.item.distanceMiles ?? 999) - (b.item.distanceMiles ?? 999),
    );

  const rankedRestaurants = restaurants
    .map((restaurant) => ({
      restaurant,
      score: getRestaurantCravingScore(restaurant, craving),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.restaurant.homeRankingScore ?? 0) -
          (a.restaurant.homeRankingScore ?? 0) ||
        (a.restaurant.distanceMiles ?? 999) -
          (b.restaurant.distanceMiles ?? 999),
    );

  const rankedTrucks = liveTrucks
    .map((truck) => ({ truck, score: getTruckCravingScore(truck, craving) }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.truck.distanceMiles ?? 999) - (b.truck.distanceMiles ?? 999),
    );

  const rankedDeals = deals
    .map((deal) => ({ deal, score: getDealCravingScore(deal, craving) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  const rankedEvents = events
    .map((event) => {
      const title = event.title || event.name || "";
      const subtitle = [event.venueName, event.locationName]
        .filter(Boolean)
        .join(" ");
      const score = scoreTextForCraving(`${title} ${subtitle}`, craving);
      return { event, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  const items: CravingBoardItem[] = [];

  for (const { item, score } of rankedMenuItems.slice(0, 4)) {
    addPick(items, {
      id: `menu-${item.id}`,
      kind: "Menu",
      title: item.name,
      subtitle: item.restaurantName || item.cuisineType || "Local menu item",
      href: getMenuItemProfilePath(item),
      restaurantId: String(item.restaurantId),
      imageUrl: item.imageUrl,
      priceCents: item.priceCents,
      meta: formatMiles(item.distanceMiles) || item.cuisineType || "Menu",
      reason: getMenuItemSearchReason(item),
      freshnessMeta: {
        kind: "menu",
        updatedAt: readStringField(item, ["updatedAt", "lastUpdatedAt"]),
        confirmedAt: readStringField(item, ["confirmedAt", "lastConfirmedAt"]),
        hasMenu: true,
        hasDistance: typeof item.distanceMiles === "number",
      },
      score,
    });
  }

  for (const { restaurant, score } of rankedRestaurants.slice(0, 4)) {
    const restaurantOpenState = getRestaurantOpenState(restaurant);
    addPick(items, {
      id: `restaurant-${restaurant.id}`,
      kind: "Place",
      title: getRestaurantName(restaurant),
      subtitle:
        restaurant.cuisineType || restaurant.description || "Local restaurant",
      href: getRestaurantProfilePath(restaurant),
      restaurantId: String(restaurant.id),
      imageUrl: getRestaurantImage(restaurant),
      meta: getRestaurantDistance(restaurant) || "Place",
      reason: getRestaurantSearchReason(restaurant),
      freshnessMeta: {
        kind: "restaurant",
        updatedAt: readStringField(restaurant, ["updatedAt", "lastUpdatedAt"]),
        confirmedAt: readStringField(restaurant, [
          "confirmedAt",
          "lastConfirmedAt",
        ]),
        hasDeal:
          Number(
            restaurant.activeDealsCount || restaurant.activeDealCount || 0,
          ) > 0,
        hasCommunityUpdate:
          Number(restaurant.communityActivityCount || 0) > 0 ||
          Number(restaurant.recommendationCount || 0) > 0 ||
          Number(restaurant.videoRecommendationCount || 0) > 0,
        hasDistance: Boolean(getRestaurantDistance(restaurant)),
        isOpen:
          restaurantOpenState === "unknown"
            ? undefined
            : restaurantOpenState === "open",
      },
      score,
    });
  }

  for (const { truck, score } of rankedTrucks.slice(0, 3)) {
    addPick(items, {
      id: `truck-${truck.id}`,
      kind: "Truck",
      title: truck.name,
      subtitle: truck.cuisineType || "Food truck",
      href: getTruckProfilePath(truck),
      truckId: String(truck.id),
      imageUrl: getTruckImage(truck),
      meta:
        [formatDistance(truck), formatWait(truck)]
          .filter(Boolean)
          .join(" / ") ||
        (isTruckBroadcastLive(truck) ? "Live now" : "Serving now"),
      reason: isTruckBroadcastLive(truck) ? "Live now" : "Serving now",
      freshnessMeta: {
        kind: "truck",
        updatedAt: readStringField(truck, ["updatedAt", "lastUpdatedAt"]),
        confirmedAt: readStringField(truck, ["confirmedAt", "lastConfirmedAt"]),
        hasDeal: Boolean(truck.activeDealCount && truck.activeDealCount > 0),
        hasDistance: Boolean(formatDistance(truck)),
        isOpen: true,
      },
      score,
    });
  }

  for (const { deal, score } of rankedDeals.slice(0, 2)) {
    addPick(items, {
      id: `deal-${deal.id}`,
      kind: "Deal",
      title: deal.title || "Nearby deal",
      subtitle: deal.restaurantName || deal.description || "Local offer",
      href: `/deal/${deal.id}`,
      dealId: String(deal.id),
      imageUrl: deal.imageUrl,
      meta: deal.discountText || "Deal",
      reason: "Deal today",
      freshnessMeta: {
        kind: "deal",
        updatedAt: readStringField(deal, ["updatedAt", "lastUpdatedAt"]),
        confirmedAt: readStringField(deal, ["confirmedAt", "lastConfirmedAt"]),
        hasDeal: true,
      },
      score,
    });
  }

  for (const { event, score } of rankedEvents.slice(0, 2)) {
    addPick(items, {
      id: `event-${event.id}`,
      kind: "Event",
      title: event.title || event.name || "Nearby event",
      subtitle: [
        event.venueName || event.locationName,
        formatEventStartLabel(event),
      ]
        .filter(Boolean)
        .join(" · "),
      href: `/events/${event.id}`,
      imageUrl: event.imageUrl || event.heroImageUrl || null,
      meta: formatEventStartLabel(event) || "Event",
      reason: "Happening today",
      freshnessMeta: {
        kind: "event",
        startsAt: event.startsAt,
        startTime: event.startTime,
        updatedAt: readStringField(event, ["updatedAt", "lastUpdatedAt"]),
      },
      score,
    });
  }

  return items
    .sort((a, b) => {
      const kindRank = { Menu: 5, Place: 4, Truck: 3, Deal: 2, Event: 1 };
      return b.score - a.score || kindRank[b.kind] - kindRank[a.kind];
    })
    .slice(0, 8);
}

function getFreshnessTimeLabel(meta: FreshnessMeta): string | null {
  const timestamp = getKnownTimestamp(meta);
  return timestamp ? getFreshnessLabel(meta) : null;
}

function formatEventStartLabel(event: EventSummary): string | null {
  const raw = event.startsAt || event.startTime;
  if (!raw) return null;
  const time = new Date(raw).getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(time).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildLocalActivityItems({
  menuItems,
  deals,
  liveTrucks,
  events,
  hosts,
  restaurants,
}: {
  menuItems: LocalMenuItemFeedItem[];
  deals: DealSummary[];
  liveTrucks: LiveTruckSummary[];
  events: EventSummary[];
  hosts: ScoutHostLocation[];
  restaurants: RestaurantSummary[];
}): LocalActivityItem[] {
  const items: LocalActivityItem[] = [];

  for (const item of menuItems.slice(0, 4)) {
    const distance = formatMiles(item.distanceMiles);
    const freshnessMeta: FreshnessMeta = {
      kind: "menu",
      updatedAt: readStringField(item, ["updatedAt", "lastUpdatedAt"]),
      confirmedAt: readStringField(item, ["confirmedAt", "lastConfirmedAt"]),
      hasMenu: true,
      hasDistance: Boolean(distance),
    };
    items.push({
      id: `menu-${item.id}`,
      type: "menu_update",
      title: "Menu updated",
      subtitle: [item.name, item.restaurantName, distance]
        .filter(Boolean)
        .join(" · "),
      href: `/restaurant/${item.restaurantId}?tab=menu`,
      entityId: String(item.id),
      timeLabel: getFreshnessTimeLabel(freshnessMeta),
      sourceLabel: getSourceLabel(freshnessMeta),
      freshnessMeta,
    });
  }

  for (const deal of deals.slice(0, 4)) {
    const freshnessMeta: FreshnessMeta = {
      kind: "deal",
      updatedAt: readStringField(deal, ["updatedAt", "lastUpdatedAt"]),
      confirmedAt: readStringField(deal, ["confirmedAt", "lastConfirmedAt"]),
      hasDeal: true,
    };
    items.push({
      id: `deal-${deal.id}`,
      type: "deal",
      title: "Deal posted",
      subtitle: [deal.title, deal.restaurantName || deal.discountText]
        .filter(Boolean)
        .join(" · "),
      href: `/deal/${deal.id}`,
      entityId: String(deal.id),
      timeLabel: getFreshnessTimeLabel(freshnessMeta),
      sourceLabel: getSourceLabel(freshnessMeta),
      freshnessMeta,
    });
  }

  for (const truck of liveTrucks.slice(0, 4)) {
    const distance = formatDistance(truck);
    const freshnessMeta: FreshnessMeta = {
      kind: "truck",
      updatedAt: readStringField(truck, ["updatedAt", "lastUpdatedAt"]),
      confirmedAt: readStringField(truck, ["confirmedAt", "lastConfirmedAt"]),
      hasDeal: Boolean(truck.activeDealCount && truck.activeDealCount > 0),
      hasDistance: Boolean(distance),
      isOpen: true,
    };
    items.push({
      id: `truck-${truck.id}`,
      type: "truck",
      title: isTruckBroadcastLive(truck) ? "Live now" : "Serving now",
      subtitle: [truck.name, truck.cuisineType, distance]
        .filter(Boolean)
        .join(" · "),
      href: getTruckProfilePath(truck),
      entityId: String(truck.id),
      timeLabel: getFreshnessTimeLabel(freshnessMeta),
      sourceLabel: getSourceLabel(freshnessMeta),
      freshnessMeta,
    });
  }

  for (const event of events.slice(0, 4)) {
    const freshnessMeta: FreshnessMeta = {
      kind: "event",
      startsAt: event.startsAt,
      startTime: event.startTime,
      updatedAt: readStringField(event, ["updatedAt", "lastUpdatedAt"]),
      confirmedAt: readStringField(event, ["confirmedAt", "lastConfirmedAt"]),
    };
    items.push({
      id: `event-${event.id}`,
      type: "event",
      title: "Event today",
      subtitle: [
        event.title || event.name,
        event.venueName || event.locationName,
        formatEventStartLabel(event),
      ]
        .filter(Boolean)
        .join(" · "),
      href: `/event/${event.id}`,
      entityId: String(event.id),
      timeLabel: getFreshnessTimeLabel(freshnessMeta),
      sourceLabel: getSourceLabel(freshnessMeta),
      freshnessMeta,
    });
  }

  for (const host of hosts.slice(0, 4)) {
    const hostName = host.businessName || host.name || "Host location";
    const area =
      [host.city, host.state].filter(Boolean).join(", ") ||
      host.address ||
      "Nearby location";
    const hostId = String(host.hostId || host.id || "").trim();
    const freshnessMeta: FreshnessMeta = {
      kind: "host",
      updatedAt: readStringField(host, ["updatedAt", "lastUpdatedAt"]),
      confirmedAt: readStringField(host, ["confirmedAt", "lastConfirmedAt"]),
    };
    items.push({
      id: `host-${hostId || hostName}`,
      type: "host",
      title: "Host location",
      subtitle: [hostName, area].filter(Boolean).join(" · "),
      href: hostId ? `/events?hostId=${encodeURIComponent(hostId)}` : "/events",
      entityId: hostId || hostName,
      timeLabel: getFreshnessTimeLabel(freshnessMeta),
      sourceLabel: getSourceLabel(freshnessMeta),
      freshnessMeta,
    });
  }

  for (const restaurant of restaurants.slice(0, 4)) {
    const distance = getRestaurantDistance(restaurant);
    const restaurantOpenState = getRestaurantOpenState(restaurant);
    const freshnessMeta: FreshnessMeta = {
      kind: "restaurant",
      updatedAt: readStringField(restaurant, ["updatedAt", "lastUpdatedAt"]),
      confirmedAt: readStringField(restaurant, [
        "confirmedAt",
        "lastConfirmedAt",
      ]),
      hasDeal:
        Number(restaurant.activeDealsCount || restaurant.activeDealCount || 0) >
        0,
      hasCommunityUpdate:
        Number(restaurant.communityActivityCount || 0) > 0 ||
        Number(restaurant.recommendationCount || 0) > 0 ||
        Number(restaurant.videoRecommendationCount || 0) > 0,
      hasDistance: Boolean(distance),
      isOpen:
        restaurantOpenState === "unknown"
          ? undefined
          : restaurantOpenState === "open",
    };
    const timestamp = getKnownTimestamp(freshnessMeta);
    const hasUpdateToday = Boolean(timestamp && isTodayDate(timestamp.value));
    items.push({
      id: `restaurant-${restaurant.id}`,
      type:
        hasUpdateToday || restaurantOpenState !== "open" ? "update" : "open",
      title: hasUpdateToday
        ? "Updated today"
        : restaurantOpenState === "open"
          ? "Open now"
          : restaurantOpenState === "closed"
            ? "Closed now"
            : "Schedule not posted",
      subtitle: [
        getRestaurantName(restaurant),
        restaurant.cuisineType,
        distance,
      ]
        .filter(Boolean)
        .join(" · "),
      href: getRestaurantProfilePath(restaurant),
      entityId: String(restaurant.id),
      timeLabel: getFreshnessTimeLabel(freshnessMeta),
      sourceLabel: getSourceLabel(freshnessMeta),
      freshnessMeta,
    });
  }

  return items
    .filter((item) => item.subtitle.trim().length > 0)
    .sort((a, b) => {
      const order: Record<LocalActivityItem["type"], number> = {
        truck: 6,
        open: 5,
        deal: 4,
        event: 3,
        host: 3,
        menu_update: 2,
        update: 1,
      };
      return order[b.type] - order[a.type];
    })
    .slice(0, 10);
}

function formatWait(truck: LiveTruckSummary): string | null {
  const wait = truck.waitMinutes ?? truck.estimatedWaitMinutes;
  if (typeof wait === "number" && Number.isFinite(wait) && wait > 0) {
    return `${Math.round(wait)} min wait`;
  }
  return null;
}

function getCrowdVibe(truck: LiveTruckSummary): { label: string } {
  const raw = (truck.crowdLevel || truck.vibe || "").toLowerCase();
  if (raw.includes("hot") || raw.includes("packed"))
    return { label: "Crowd is Hot" };
  if (raw.includes("busy")) return { label: "Busy Right Now" };
  return { label: "Live nearby" };
}

type TruckCardTone = "live" | "scheduled" | "claimed" | "neutral";

function getTruckCardTone(truck: LiveTruckSummary): {
  label: string;
  tone: TruckCardTone;
} {
  if (isTruckBroadcastLive(truck)) return { label: "Live now", tone: "live" };
  if (isTruckServingNow(truck)) return { label: "Serving now", tone: "scheduled" };

  const status = readStringField(truck, [
    "serviceStatus",
    "status",
    "operatingStatus",
  ]);
  if (status) {
    const normalized = status.toLowerCase();
    if (normalized.includes("scheduled"))
      return { label: "Scheduled", tone: "scheduled" };
    if (normalized.includes("claim"))
      return { label: "Claimed", tone: "claimed" };
  }

  return { label: "Food truck", tone: "neutral" };
}

function getTruckToneClass(tone: TruckCardTone): string {
  if (tone === "live")
    return "bg-emerald-500/95 text-white ring-emerald-200/40";
  if (tone === "scheduled")
    return "bg-amber-400/92 text-[#1a0d08] ring-amber-100/40";
  if (tone === "claimed") return "bg-white/14 text-white ring-white/20";
  return "bg-[#120805]/72 text-white/86 ring-white/10";
}

function getTruckToneDotClass(tone: TruckCardTone): string {
  if (tone === "live") return "bg-white animate-pulse";
  if (tone === "scheduled") return "bg-[#1a0d08]/80";
  return "bg-white/70";
}

function getTruckCoords(
  truck: LiveTruckSummary,
): { lat: number; lng: number } | null {
  const coordinates = resolveTruckCoordinates(truck, {
    freshnessMs: DEFAULT_TRUCK_BROADCAST_FRESHNESS_MS,
  });
  if (!coordinates) return null;
  return { lat: coordinates.latitude, lng: coordinates.longitude };
}

function getEventCoords(
  event: EventSummary,
): { lat: number; lng: number } | null {
  const coordinates =
    resolveCoordinatePair(event.latitude, event.longitude) ??
    resolveCoordinatePair(event.lat, event.lng) ??
    resolveCoordinatePair(event.venueLat, event.venueLng) ??
    resolveCoordinatePair(event.host?.latitude, event.host?.longitude);
  if (!coordinates) return null;
  return { lat: coordinates.latitude, lng: coordinates.longitude };
}

function formatTruckPlace(truck: LiveTruckSummary): string {
  return (
    [truck.address, truck.city, truck.state].filter(Boolean).join(", ") ||
    "Nearby location"
  );
}

function buildTruckDirectionsUrl(
  truck: LiveTruckSummary,
  origin?: { lat: number; lng: number } | null,
): string {
  const truckCoords = getTruckCoords(truck);
  const destination = truckCoords
    ? `${truckCoords.lat},${truckCoords.lng}`
    : encodeURIComponent(formatTruckPlace(truck));
  const originParam = origin ? `&origin=${origin.lat},${origin.lng}` : "";
  return `https://www.google.com/maps/dir/?api=1${originParam}&destination=${destination}&travelmode=driving`;
}

function getGreetingTime(): "morning" | "afternoon" | "evening" {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

const DISCOVERY_RADIUS_STORAGE_KEY = "mealscout:discovery-radius-km";
const DEFAULT_DISCOVERY_RADIUS_KM = 12; // about 7.5 miles
const MIN_DISCOVERY_RADIUS_KM = 3;
const MAX_DISCOVERY_RADIUS_KM = 40;
const SCOUT_ROTATING_SPOT_INTERVAL_MS = 30 * 60 * 1000;
const SCOUT_ROTATING_SPOT_LIMIT = 16;

function getScoutSpotRotationBucket(now = Date.now()): number {
  return Math.floor(now / SCOUT_ROTATING_SPOT_INTERVAL_MS);
}

function clampDiscoveryRadiusKm(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DISCOVERY_RADIUS_KM;
  return Math.max(
    MIN_DISCOVERY_RADIUS_KM,
    Math.min(MAX_DISCOVERY_RADIUS_KM, value),
  );
}

function readDiscoveryRadiusKm(): number {
  if (typeof window === "undefined") return DEFAULT_DISCOVERY_RADIUS_KM;
  const stored = Number(
    window.localStorage.getItem(DISCOVERY_RADIUS_STORAGE_KEY),
  );
  if (!Number.isFinite(stored)) return DEFAULT_DISCOVERY_RADIUS_KM;
  return clampDiscoveryRadiusKm(stored);
}

type ScoutCoords = { lat: number; lng: number };

function toScoutNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function distanceKmBetween(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function isWithinScoutRadius(
  origin: ScoutCoords | null,
  latValue: unknown,
  lngValue: unknown,
  radiusKm: number,
  fallbackDistanceKm?: number | null,
): boolean {
  if (!origin) return false;
  const lat = toScoutNumber(latValue);
  const lng = toScoutNumber(lngValue);
  if (lat !== null && lng !== null) {
    return distanceKmBetween(origin.lat, origin.lng, lat, lng) <= radiusKm;
  }
  if (
    typeof fallbackDistanceKm === "number" &&
    Number.isFinite(fallbackDistanceKm)
  ) {
    return fallbackDistanceKm <= radiusKm;
  }
  return false;
}

type ScoutSearchIntent =
  | "all"
  | "now"
  | "trucks"
  | "restaurants"
  | "dishes"
  | "deals"
  | "happy_hour"
  | "events"
  | "community"
  | "new"
  | "best";

function normalizeScoutSearchText(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function tokenizeScoutSearch(value: string): string[] {
  return tokenizeScoutSearchIntent(value);
}

function inferScoutSearchIntent(
  query: string,
  filter: ScoutSearchFilterId | null,
): ScoutSearchIntent {
  if (filter === "happy_hour") return "happy_hour";
  if (filter) return filter === "community" ? "community" : filter;
  const normalized = normalizeScoutSearchText(query);
  if (!normalized) return "all";
  if (/\b(truck|trucks|food truck|foodtruck)\b/.test(normalized))
    return "trucks";
  if (/\b(restaurant|restaurants|dine|dining|place|places)\b/.test(normalized))
    return "restaurants";
  if (
    /\b(dish|dishes|menu|menus|taco|tacos|burger|pizza|bbq|wings|bowl|bowls)\b/.test(
      normalized,
    )
  )
    return "dishes";
  if (/\b(happy hour|happy-hour)\b/.test(normalized)) return "happy_hour";
  if (/\b(deal|deals|discount|special|specials)\b/.test(normalized))
    return "deals";
  if (/\b(event|events|pop.?up|popup|popups)\b/.test(normalized))
    return "events";
  if (/\b(community|favorite|favorites|pick|picks|saved)\b/.test(normalized))
    return "community";
  if (/\b(new|newest|fresh|recent|latest)\b/.test(normalized)) return "new";
  if (/\b(best|top|hot|trending|popular)\b/.test(normalized)) return "best";
  if (/\b(now|open|serving|live)\b/.test(normalized)) return "now";
  return "all";
}

function scoutRecordSearchText(record: unknown): string {
  if (!record || typeof record !== "object") return "";
  const source = record as Record<string, unknown>;
  const values = [
    source.name,
    source.businessName,
    source.restaurantName,
    source.title,
    source.description,
    source.cuisineType,
    source.businessType,
    source.profileType,
    source.entityType,
    source.city,
    source.state,
    source.neighborhood,
    source.address,
    source.addressPublicLabel,
    source.discountText,
    source.locationName,
    source.venueName,
    ...(Array.isArray(source.tags) ? source.tags : []),
    ...(Array.isArray(source.dietaryTags) ? source.dietaryTags : []),
    ...(Array.isArray(source.discoveryReasons) ? source.discoveryReasons : []),
  ];
  return values
    .map((value) => String(value || ""))
    .join(" ")
    .toLowerCase();
}

function matchesScoutSearchText(record: unknown, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = scoutRecordSearchText(record);
  return terms.every((term) => haystack.includes(term));
}

function hasCommunitySignal(record: unknown): boolean {
  if (!record || typeof record !== "object") return false;
  const source = record as Record<string, unknown>;
  return [
    source.favoriteCount,
    source.followCount,
    source.recommendationCount,
    source.videoRecommendationCount,
    source.communityActivityCount,
  ].some((value) => Number(value || 0) > 0);
}

function hasNewListingSignal(record: unknown): boolean {
  if (!record || typeof record !== "object") return false;
  const source = record as Record<string, unknown>;
  const raw =
    source.createdAt || source.addedAt || source.publishedAt || source.listedAt;
  const time = raw ? new Date(String(raw)).getTime() : NaN;
  if (!Number.isFinite(time)) return false;
  return Date.now() - time <= 45 * 24 * 60 * 60 * 1000;
}

function matchesScoutIntent(
  record: unknown,
  intent: ScoutSearchIntent,
  kindHint?: string,
): boolean {
  const kind = normalizeScoutSearchText(
    kindHint ||
      (record as any)?.kind ||
      (record as any)?.profileType ||
      (record as any)?.businessType,
  );
  if (intent === "all") return true;
  if (intent === "trucks")
    return (
      kind.includes("truck") ||
      normalizeScoutSearchText((record as any)?.isFoodTruck) === "true"
    );
  if (intent === "restaurants")
    return (
      kind.includes("restaurant") ||
      kind.includes("bar") ||
      kind.includes("cafe")
    );
  if (intent === "dishes")
    return Boolean(
      (record as any)?.priceCents ||
      (record as any)?.priceLabel ||
      kind.includes("menu"),
    );
  if (intent === "deals")
    return (
      kind.includes("deal") ||
      Number(
        (record as any)?.activeDealCount ||
          (record as any)?.activeDealsCount ||
          0,
      ) > 0
    );
  if (intent === "happy_hour")
    return scoutRecordSearchText(record).includes("happy hour");
  if (intent === "events")
    return (
      kind.includes("event") ||
      Boolean((record as any)?.startsAt || (record as any)?.startTime)
    );
  if (intent === "community") return hasCommunitySignal(record);
  if (intent === "new") return hasNewListingSignal(record);
  if (intent === "best")
    return (
      hasCommunitySignal(record) ||
      Number((record as any)?.discoveryScore || 0) > 0
    );
  if (intent === "now")
    return (
      kind.includes("truck") ||
      /open|serving|live/i.test(scoutRecordSearchText(record))
    );
  return true;
}

function filterScoutSearchRows<T>(
  rows: T[],
  searchMode: boolean,
  query: string,
  intent: ScoutSearchIntent,
  kindHint?: string,
): T[] {
  if (!searchMode) return rows;
  const terms = tokenizeScoutSearch(query);
  return rows.filter(
    (row) =>
      matchesScoutSearchText(row, terms) &&
      matchesScoutIntent(row, intent, kindHint),
  );
}

function filterScoutFallbackRows<T>(
  rows: T[],
  searchMode: boolean,
  query: string,
  intent: ScoutSearchIntent,
  kindHint?: string,
): T[] {
  if (!searchMode || !query.trim()) return rows;
  const expandedTerms = expandScoutSearchTerms(query);
  const fallbackIntent =
    kindHint === "restaurant" && intent === "dishes" ? "all" : intent;
  return rows.filter(
    (row) =>
      expandedTerms.some((term) => matchesScoutSearchText(row, [term])) &&
      matchesScoutIntent(row, fallbackIntent, kindHint),
  );
}

function canonicalizeScoutRows<T>(
  rows: T[],
  {
    kind,
    scope,
    source,
    query,
    limit,
  }: {
    kind: ScoutDiscoveryResultKind;
    scope: ScoutDiscoveryScope;
    source: ScoutDiscoverySource;
    query?: string;
    limit?: number;
  },
): T[] {
  return selectScoutDiscoveryResults(rows, {
    kind,
    scope,
    source,
    queryTerms: query ? expandScoutSearchTerms(query) : [],
    limit,
  }).map((result) => result.raw);
}

/* ============================================================
   MAP CENTER OFFSET
   ----
   To place the user's pin in the RIGHT QUADRANT of the visible
   hero map, we shift the *map center* WEST of the user by ~1/4
   of the visible longitude span at the current zoom. The user
   coordinate then renders at roughly x = 75% across the viewport.
   ============================================================ */

function shiftCenterForRightQuadrant(
  lat: number,
  lng: number,
  zoom: number,
): { lat: number; lng: number } {
  // Rough longitude span at a given zoom level for a ~430px-wide viewport.
  // 360 deg / 2^zoom ~= world span per 256px tile, scaled for viewport.
  const tilesAcross = 430 / 256;
  const lngSpan = (360 / Math.pow(2, zoom)) * tilesAcross;
  // Shift center ~25% west so user pin lands in the right ~75% column.
  const lngOffset = lngSpan * 0.25;
  return { lat, lng: lng - lngOffset };
}

/* ============================================================
   PAGE
   ============================================================ */

export default function ExplorePreview() {
  const { user, authState } = useAuth();
  const account = authState === "loading" ? null : String(user?.id || "guest");
  return <ScoutDiscoveryView key={account || "loading"} account={account} />;
}

function ScoutDiscoveryView({ account }: { account: string | null }) {
  const [restoredJourney] = useState(() => readScoutJourney(account));
  const [journeyRoute] = useState(() => scoutJourneyRoute(window.location.pathname + window.location.search) || "/scout");
  const { user } = useAuth();
  const authEffectiveLocationContext = useMemo(
    () =>
      ((
        user as {
          effectiveLocationContext?: EffectiveLocationContext | null;
        } | null
      )?.effectiveLocationContext ?? null) as EffectiveLocationContext | null,
    [user],
  );
  const { effectiveLocationContext: fetchedLocationContext } =
    useEffectiveLocationContext(
      Boolean(user?.id) && !authEffectiveLocationContext,
    );
  const effectiveLocationContext =
    authEffectiveLocationContext ?? fetchedLocationContext;
  const [location, navigate] = useWouterLocation();

  const firstName =
    typeof user?.name === "string" && user.name.trim().length > 0
      ? user.name.trim().split(" ")[0]
      : null;

  /* --------- location --------- */

  const [deviceCoords, setDeviceCoords] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [discoveryRadiusKm, setDiscoveryRadiusKm] = useState<number>(() =>
    restoredJourney?.radiusKm ?? readDiscoveryRadiusKm(),
  );
  const [deviceLocationName, setDeviceLocationName] =
    useState<string>("Your area");
  const [locationStatus, setLocationStatus] = useState<
    "idle" | "requesting" | "ready" | "denied"
  >("idle");
  const [currentDaypart] = useState<Daypart>(() => getDaypart());
  const [selectedCravingId, setSelectedCravingId] = useState<string>(
    () => SCOUT_SEARCH_OPTIONS.some(option => option.id === restoredJourney?.craving) ? restoredJourney!.craving : DAYPART_DEFAULT_INTENT[getDaypart()],
  );
  const [activeSceneLaneId, setActiveSceneLaneId] =
    useState<ScoutSceneLaneId>(restoredJourney?.scene ?? "for_you");
  const [scoutSpotRotationBucket, setScoutSpotRotationBucket] =
    useState<number>(() => getScoutSpotRotationBucket());
  useEffect(() => {
    const timer = window.setInterval(() => {
      setScoutSpotRotationBucket(getScoutSpotRotationBucket());
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const {
    searchMode: scoutSearchMode,
    query: scoutSearchQuery,
    activeFilter: scoutSearchFilter,
    closeSearch: closeScoutSearch,
    restoreSearch,
  } = useScoutNavSearch();
  useEffect(() => {
    restoreSearch(restoredJourney?.search ?? { open: false, query: "", filter: null });
  }, [restoredJourney, restoreSearch]);
  const [resultsSheet, setResultsSheet] =
    useState<ScoutResultsSheetData | null>(null);
  const [isPlaceRequestOpen, setIsPlaceRequestOpen] = useState(false);
  const [placeRequestQuery, setPlaceRequestQuery] = useState("");
  const [selectedPlaceRequest, setSelectedPlaceRequest] = useState<{
    placeId: string;
    restaurantName: string;
    address: string;
    city: string;
    county: string;
    state: string;
    latitude: number | null;
    longitude: number | null;
  } | null>(null);
  const [isLoadingPlaceRequest, setIsLoadingPlaceRequest] = useState(false);
  const [isSubmittingPlaceRequest, setIsSubmittingPlaceRequest] =
    useState(false);
  const [scoutSourceStatuses, setScoutSourceStatuses] = useState<
    Record<ScoutSourceStatusKey, number | null>
  >({
    trucks: null,
    restaurants: null,
    mapLocations: null,
    deals: null,
    events: null,
    menus: null,
  });
  const recordScoutSourceStatus = useCallback(
    (key: ScoutSourceStatusKey, status: number) => {
      setScoutSourceStatuses((current) =>
        current[key] === status ? current : { ...current, [key]: status },
      );
    },
    [],
  );
  const userType = String((user as any)?.userType || "").toLowerCase();
  const normalizedUserType = String(userType || "")
    .trim()
    .toLowerCase();
  const userRoles = useMemo(() => {
    const roles = new Set<string>();
    const rawRoles = (user as { roles?: unknown } | null | undefined)?.roles;
    if (Array.isArray(rawRoles)) {
      rawRoles.forEach((role) => {
        const normalized = String(role || "")
          .trim()
          .toLowerCase();
        if (normalized) roles.add(normalized);
      });
    }
    if (normalizedUserType) roles.add(normalizedUserType);
    return roles;
  }, [normalizedUserType, user]);
  const isScoutPreviewEligible =
    userRoles.has("super_admin") ||
    userRoles.has("admin") ||
    userRoles.has("duper_admin");
  const isAdminFamilyUser =
    userRoles.has("super_admin") ||
    userRoles.has("admin") ||
    userRoles.has("duper_admin") ||
    userRoles.has("staff");
  const isTruckVendorUser =
    userRoles.has("food_truck") || userRoles.has("restaurant_owner");
  const scoutPreviewCity = useMemo(() => {
    if (typeof window === "undefined") return "";
    const params = new URLSearchParams(window.location.search);
    return (params.get("scoutPreview") || params.get("previewCity") || "")
      .trim()
      .toLowerCase();
  }, [location]);
  const isPensacolaScoutPreview =
    isScoutPreviewEligible && scoutPreviewCity === "pensacola";
  const previewLocation = useMemo(
    () =>
      isPensacolaScoutPreview
        ? {
            label: PENSACOLA_LAUNCH_MARKET.label,
            lat: PENSACOLA_LAUNCH_MARKET.lat,
            lng: PENSACOLA_LAUNCH_MARKET.lng,
            source: "admin_preview" as const,
          }
        : null,
    [isPensacolaScoutPreview],
  );
  const manualSelectedLocation = null;
  const savedLocation = useMemo(() => {
    if (!effectiveLocationContext) return null;
    const lat = Number(effectiveLocationContext?.latitude);
    const lng = Number(effectiveLocationContext?.longitude);
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
    const city = String(effectiveLocationContext.city || "").trim();
    const state = String(effectiveLocationContext.state || "").trim();
    const marketKey = String(effectiveLocationContext.marketKey || "")
      .trim()
      .toLowerCase();
    const isPensacolaDefault =
      effectiveLocationContext.source === "super_admin_default" ||
      marketKey === PENSACOLA_LAUNCH_MARKET.marketKey ||
      (city.toLowerCase() === "pensacola" && state.toLowerCase() === "fl");
    if (!hasCoords && !isPensacolaDefault) return null;
    const label = isPensacolaDefault
      ? PENSACOLA_LAUNCH_MARKET.label
      : formatScoutMarketLabel({
          city,
          state,
          marketKey,
          fallbackLabel: "Your market",
        });
    return {
      label,
      lat: hasCoords ? lat : PENSACOLA_LAUNCH_MARKET.lat,
      lng: hasCoords ? lng : PENSACOLA_LAUNCH_MARKET.lng,
      source: isPensacolaDefault
        ? ("super_admin_default" as const)
        : ("saved" as const),
    };
  }, [effectiveLocationContext]);
  const fallbackLocation = useMemo(
    () => ({
      label: PENSACOLA_LAUNCH_MARKET.label,
      lat: PENSACOLA_LAUNCH_MARKET.lat,
      lng: PENSACOLA_LAUNCH_MARKET.lng,
      source: "launch_market_default" as const,
    }),
    [],
  );
  const resolvedScoutLocation = useMemo(() => {
    if (previewLocation) return previewLocation;
    if (manualSelectedLocation) return manualSelectedLocation;
    if (deviceCoords) {
      return {
        label: deviceLocationName || "Your area",
        lat: deviceCoords.lat,
        lng: deviceCoords.lng,
        source: "device" as const,
      };
    }
    if (savedLocation) return savedLocation;
    return fallbackLocation;
  }, [deviceCoords, deviceLocationName, previewLocation, savedLocation]);
  const resolvedScoutCoords = useMemo(
    () =>
      resolvedScoutLocation
        ? { lat: resolvedScoutLocation.lat, lng: resolvedScoutLocation.lng }
        : null,
    [resolvedScoutLocation],
  );
  const verifiedMapUserLocation = useMemo(
    () =>
      resolvedScoutLocation?.source === "device" ? resolvedScoutCoords : null,
    [resolvedScoutCoords, resolvedScoutLocation?.source],
  );
  const showScoutPreviewDebug =
    isScoutPreviewEligible && scoutPreviewCity.length > 0;

  useEffect(() => {
    if (!showScoutPreviewDebug) return;
    console.info("[scout-preview-debug]", {
      isScoutPreviewEligible,
      scoutPreviewCity,
      isPensacolaScoutPreview,
      resolvedScoutLocation,
    });
  }, [
    isPensacolaScoutPreview,
    isScoutPreviewEligible,
    resolvedScoutLocation,
    scoutPreviewCity,
    showScoutPreviewDebug,
  ]);

  const scoutSearchIntent = useMemo(
    () => inferScoutSearchIntent(scoutSearchQuery, scoutSearchFilter),
    [scoutSearchFilter, scoutSearchQuery],
  );

  useEffect(() => {
    if (!location.startsWith("/scout") && !location.startsWith("/map")) {
      closeScoutSearch();
    }
  }, [closeScoutSearch, location]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const requestedPreview = (
      params.get("scoutPreview") ||
      params.get("previewCity") ||
      ""
    )
      .trim()
      .toLowerCase();
    if (
      requestedPreview === "pensacola" &&
      isScoutPreviewEligible &&
      !isPensacolaScoutPreview
    ) {
      console.warn("[scout-preview-warning] pensacola requested but inactive", {
        requestedPreview,
        isScoutPreviewEligible,
        userType: normalizedUserType,
      });
    }
  }, [
    isPensacolaScoutPreview,
    isScoutPreviewEligible,
    location,
    normalizedUserType,
  ]);

  useEffect(() => {
    if (savedLocation?.source === "super_admin_default") {
      setLocationStatus("ready");
    }
    if (!isPensacolaScoutPreview || !previewLocation) return;
    setLocationStatus("ready");
    setMapCenter({ lat: previewLocation.lat, lng: previewLocation.lng });
  }, [isPensacolaScoutPreview, previewLocation, savedLocation?.source]);

  const requestLocation = useCallback(() => {
    if (isPensacolaScoutPreview && previewLocation) {
      setLocationStatus("ready");
      return;
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocationStatus("denied");
      return;
    }
    setLocationStatus("requesting");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        if (isPensacolaScoutPreview) return;
        setDeviceCoords({ lat: latitude, lng: longitude });
        setLocationStatus("ready");
        if (user?.id) {
          const marketKeyFallback = [
            String(effectiveLocationContext?.city || "")
              .trim()
              .toLowerCase(),
            String(effectiveLocationContext?.state || "")
              .trim()
              .toLowerCase(),
          ]
            .filter(Boolean)
            .join("-");
          const marketKey = marketKeyFallback || "device-market";
          fetch(apiUrl("/api/location/context"), {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "device",
              location: {
                marketKey,
                city: effectiveLocationContext?.city || undefined,
                state: effectiveLocationContext?.state || undefined,
                latitude,
                longitude,
              },
            }),
          }).catch(() => {});
        }
        getReverseGeocodedLocationName(latitude, longitude, (name) => {
          if (name && !isPensacolaScoutPreview) setDeviceLocationName(name);
        }).catch(() => {});
      },
      () => {
        setLocationStatus("denied");
      },
      { timeout: 10000, maximumAge: 0 },
    );
  }, [
    effectiveLocationContext,
    isPensacolaScoutPreview,
    previewLocation,
    user?.id,
  ]);

  // Auto-request on mount
  useEffect(() => {
    if (savedLocation?.source === "super_admin_default") return;
    requestLocation();
  }, [requestLocation, savedLocation?.source]);

  const updateDiscoveryRadiusKm = useCallback((value: number) => {
    const nextRadius = clampDiscoveryRadiusKm(value);
    setDiscoveryRadiusKm(nextRadius);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        DISCOVERY_RADIUS_STORAGE_KEY,
        String(nextRadius),
      );
    }
  }, []);

  const shortLocation = useMemo(() => {
    if (!resolvedScoutLocation?.label) return "Your area";
    return (
      resolvedScoutLocation.label.split(",")[0] || resolvedScoutLocation.label
    );
  }, [resolvedScoutLocation]);

  const hasResolvedLocation = useMemo(() => {
    const trimmed = (resolvedScoutLocation?.label || "").trim();
    return trimmed.length > 0 && trimmed.toLowerCase() !== "your area";
  }, [resolvedScoutLocation]);
  const isPensacolaOperatorMarket = useMemo(() => {
    const label = String(resolvedScoutLocation?.label || "")
      .trim()
      .toLowerCase();
    return (
      resolvedScoutLocation?.source === "super_admin_default" ||
      resolvedScoutLocation?.source === "admin_preview" ||
      label === PENSACOLA_LAUNCH_MARKET.label.toLowerCase() ||
      label === "pensacola"
    );
  }, [resolvedScoutLocation]);
  const scoutMarketEyebrow = isPensacolaOperatorMarket
    ? "Food around Pensacola"
    : resolvedScoutLocation?.source === "device"
      ? "Your live location"
      : hasResolvedLocation
        ? "Open near you"
        : "Nearby food";

  /* --------- trucks --------- */

  const {
    data: liveTrucksRaw,
    isLoading: liveTrucksLoading,
    isError: liveTrucksError,
    isFetching: liveTrucksFetching,
    refetch: retryLiveTrucks,
  } = useQuery<LiveTrucksResponse>({
    queryKey: resolvedScoutLocation
      ? [
          "/api/trucks/live",
          resolvedScoutLocation.lat,
          resolvedScoutLocation.lng,
          discoveryRadiusKm,
        ]
      : ["/api/trucks/live", "no-location"],
    enabled: !!resolvedScoutLocation,
    queryFn: ({ signal }) => readScoutFeed<LiveTrucksResponse>(
      `/api/trucks/live?lat=${resolvedScoutLocation?.lat}&lng=${resolvedScoutLocation?.lng}&radiusKm=${discoveryRadiusKm}`,
      "trucks", signal, status => recordScoutSourceStatus("trucks", status),
    ),
    retry: false,
    staleTime: 15_000,
    refetchInterval: 20_000,
  });

  const liveTrucksData = liveTrucksError ? undefined : liveTrucksRaw;
  const liveTrucks = useMemo<LiveTruckSummary[]>(() => {
    if (!liveTrucksData) return [];
    const raw = Array.isArray(liveTrucksData)
      ? liveTrucksData
      : Array.isArray(liveTrucksData.trucks)
        ? liveTrucksData.trucks
        : [];
    return raw.filter((truck) => {
      const truckCoords = getTruckCoords(truck);
      const fallbackKm =
        typeof truck.distanceMiles === "number"
          ? truck.distanceMiles * 1.609344
          : typeof truck.distance === "number"
            ? truck.distance
            : null;
      return isWithinScoutRadius(
        resolvedScoutCoords,
        truckCoords?.lat,
        truckCoords?.lng,
        discoveryRadiusKm,
        fallbackKm,
      );
    });
  }, [resolvedScoutCoords, discoveryRadiusKm, liveTrucksData]);

  /* --------- featured deals --------- */

  const { data: dealsData } = useQuery<DealsResponse>({
    queryKey: ["/api/deals/featured"],
    queryFn: async () => {
      const response = await fetch(`/api/deals/featured`, {
        credentials: "include",
      });
      if (!response.ok) return { deals: [] };
      return response.json();
    },
    staleTime: 60_000,
  });

  const deals = useMemo<DealSummary[]>(() => {
    if (!dealsData) return [];
    if (Array.isArray(dealsData)) return dealsData;
    if (Array.isArray(dealsData.deals)) return dealsData.deals;
    return [];
  }, [dealsData]);

  /* --------- events --------- */

  const { data: eventsData, isLoading: eventsLoading } =
    useQuery<EventsResponse>({
    queryKey: ["/api/events/public"],
    enabled: !!resolvedScoutLocation,
    queryFn: async () => {
      const response = await fetch(`/api/events/public`, {
        credentials: "include",
      });
      recordScoutSourceStatus("events", response.status);
      if (!response.ok) return { events: [] };
      return response.json();
    },
    staleTime: 60_000,
  });

  const events = useMemo<EventSummary[]>(() => {
    if (!eventsData) return [];
    if (Array.isArray(eventsData)) return eventsData;
    if (Array.isArray(eventsData.events)) return eventsData.events;
    return [];
  }, [eventsData]);

  const visibleEvents = useMemo<EventSummary[]>(() => {
    return events.filter((event) => {
      const coords = getEventCoords(event);
      return isWithinScoutRadius(
        resolvedScoutCoords,
        coords?.lat,
        coords?.lng,
        discoveryRadiusKm,
      );
    });
  }, [resolvedScoutCoords, discoveryRadiusKm, events]);

  const mapBoundsForScout = useMemo(
    () =>
      resolvedScoutLocation
        ? getBoundsForScoutLocation(resolvedScoutLocation, discoveryRadiusKm)
        : null,
    [resolvedScoutLocation, discoveryRadiusKm],
  );

  const { data: mapLocationsData } = useQuery<MapLocationsResponse>({
    queryKey: mapBoundsForScout
      ? [
          "/api/map/locations",
          mapBoundsForScout.north,
          mapBoundsForScout.south,
          mapBoundsForScout.east,
          mapBoundsForScout.west,
          discoveryRadiusKm,
        ]
      : ["/api/map/locations", "no-bounds"],
    enabled: !!mapBoundsForScout,
    queryFn: async () => {
      if (!mapBoundsForScout) return { hostLocations: [] };
      const params = new URLSearchParams({
        north: String(mapBoundsForScout.north),
        south: String(mapBoundsForScout.south),
        east: String(mapBoundsForScout.east),
        west: String(mapBoundsForScout.west),
        zoom: "13",
      });
      const response = await fetch(
        apiUrl(`/api/map/locations?${params.toString()}`),
        {
          credentials: "include",
        },
      );
      recordScoutSourceStatus("mapLocations", response.status);
      if (!response.ok) {
        throw new Error(`Map locations request failed (${response.status})`);
      }
      return response.json();
    },
    staleTime: 45_000,
    retry: false,
  });

  const allScoutHostLocations = useMemo<ScoutHostLocation[]>(() => {
    const rows = Array.isArray(mapLocationsData?.hostLocations)
      ? mapLocationsData.hostLocations
      : [];
    return rows;
  }, [mapLocationsData]);

  const visibleHosts = useMemo<ScoutHostLocation[]>(() => {
    return allScoutHostLocations.filter((host) =>
      isWithinScoutRadius(
        resolvedScoutCoords,
        readNumberField(host, ["latitude", "lat"]),
        readNumberField(host, ["longitude", "lng"]),
        discoveryRadiusKm,
      ),
    );
  }, [allScoutHostLocations, discoveryRadiusKm, resolvedScoutCoords]);

  // An empty local result is truthful. Never replace it with global hosts.
  const mapHostLocations = visibleHosts;

  const visibleMapEventLocations = useMemo<ScoutMapEventLocation[]>(() => {
    const rows = Array.isArray(mapLocationsData?.eventLocations)
      ? mapLocationsData.eventLocations
      : [];
    return rows.filter((event) =>
      isWithinScoutRadius(
        resolvedScoutCoords,
        readNumberField(event, ["hostLatitude", "latitude", "lat"]),
        readNumberField(event, ["hostLongitude", "longitude", "lng"]),
        discoveryRadiusKm,
      ),
    );
  }, [discoveryRadiusKm, mapLocationsData, resolvedScoutCoords]);

  const { data: parkingPassData } = useQuery<ScoutParkingPassListing[]>({
    queryKey: ["/api/parking-pass", "scout-map"],
    enabled: !!resolvedScoutLocation,
    queryFn: async () => {
      const response = await fetch(apiUrl("/api/parking-pass"), {
        credentials: "include",
      });
      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    },
    staleTime: 60_000,
    retry: false,
  });

  const visibleParkingPassListings = useMemo<ScoutParkingPassListing[]>(() => {
    const rows = Array.isArray(parkingPassData) ? parkingPassData : [];
    return rows.filter((listing) => {
      const host = listing.host;
      if (!host) return false;
      if (
        getScoutParkingInventoryStatus(
          listing,
          isScoutMapWindowActiveNow(listing),
        ) !== "available"
      ) {
        return false;
      }
      return isWithinScoutRadius(
        resolvedScoutCoords,
        readNumberField(host, ["latitude", "lat"]),
        readNumberField(host, ["longitude", "lng"]),
        discoveryRadiusKm,
      );
    });
  }, [discoveryRadiusKm, parkingPassData, resolvedScoutCoords]);

  const parkingPassStatusByHostKey = useMemo(() => {
    const byHost = new Map<string, Exclude<ScoutParkingInventoryStatus, null>>();
    const rows = Array.isArray(parkingPassData) ? parkingPassData : [];
    for (const listing of rows) {
      const host = listing.host;
      if (!host) continue;
      const lat = readNumberField(host, ["latitude", "lat"]);
      const lng = readNumberField(host, ["longitude", "lng"]);
      if (!isWithinScoutRadius(resolvedScoutCoords, lat, lng, discoveryRadiusKm)) {
        continue;
      }
      const key = getScoutHostMarkerKey(host);
      const status = getScoutParkingInventoryStatus(
        listing,
        isScoutMapWindowActiveNow(listing),
      );
      if (status === "available" || !byHost.has(key)) byHost.set(key, status);
    }
    return byHost;
  }, [discoveryRadiusKm, parkingPassData, resolvedScoutCoords]);

  const visibleParkingPassHosts = useMemo<ScoutHostLocation[]>(() => {
    const byKey = new Map<string, ScoutHostLocation>();
    const rows = Array.isArray(parkingPassData) ? parkingPassData : [];
    for (const listing of rows) {
      const host = listing.host;
      if (!host) continue;
      const lat = readNumberField(host, ["latitude", "lat"]);
      const lng = readNumberField(host, ["longitude", "lng"]);
      if (!isWithinScoutRadius(resolvedScoutCoords, lat, lng, discoveryRadiusKm)) {
        continue;
      }
      const key = getScoutHostMarkerKey(host);
      if (!byKey.has(key)) byKey.set(key, host);
    }
    return Array.from(byKey.values());
  }, [discoveryRadiusKm, parkingPassData, resolvedScoutCoords]);

  const scoutMapHostLocations = useMemo<ScoutHostLocation[]>(() => {
    const byKey = new Map<string, ScoutHostLocation>();
    for (const host of [...mapHostLocations, ...visibleParkingPassHosts]) {
      const key = getScoutHostMarkerKey(host);
      if (!byKey.has(key)) byKey.set(key, host);
    }
    return Array.from(byKey.values());
  }, [mapHostLocations, visibleParkingPassHosts]);

  const parkedTrucksByHostKey = useMemo(() => {
    const byHost = new Map<
      string,
      NonNullable<MapAdapterMarker["parkedTrucks"]>
    >();
    const addTruck = (
      host: ScoutHostLocation,
      truck: NonNullable<MapAdapterMarker["parkedTrucks"]>[number],
    ) => {
      const key = getScoutHostMarkerKey(host);
      const existing = byHost.get(key) || [];
      const truckKey = String(truck.id || truck.name).toLowerCase();
      if (
        !existing.some(
          (item) => String(item.id || item.name).toLowerCase() === truckKey,
        )
      ) {
        existing.push(truck);
      }
      byHost.set(key, existing);
    };

    for (const listing of visibleParkingPassListings) {
      const host = listing.host;
      if (!host || !Array.isArray(listing.bookings)) continue;
      for (const booking of listing.bookings) {
        const truckName = String(booking.truckName || "").trim();
        if (!truckName) continue;
        const truckId = String(booking.truckId || "").trim();
        addTruck(host, {
          id: truckId || null,
          name: truckName,
          href: truckId ? `/truck/${encodeURIComponent(truckId)}` : null,
          source: "parking_pass",
          slotLabel: booking.slotType || null,
        });
      }
    }

    for (const event of visibleMapEventLocations) {
      if (!isScoutMapWindowActiveNow(event)) continue;
      const truckName = String(event.truckName || "").trim();
      if (!truckName) continue;
      const truckId = String(
        event.truckId || event.bookedRestaurantId || "",
      ).trim();
      const eventHostId = String(event.hostId || "").trim();
      const eventAddress = normalizeScoutLocationAddress(
        event.hostAddress,
        event.hostCity,
        event.hostState,
      );
      const eventLat = readNumberField(event, [
        "hostLatitude",
        "latitude",
        "lat",
      ]);
      const eventLng = readNumberField(event, [
        "hostLongitude",
        "longitude",
        "lng",
      ]);
      for (const host of scoutMapHostLocations) {
        const hostIds = [host.hostId, host.id]
          .map((value) => String(value || "").trim())
          .filter(Boolean);
        const idMatches = Boolean(eventHostId && hostIds.includes(eventHostId));
        const addressMatches = Boolean(
          eventAddress &&
          eventAddress ===
            normalizeScoutLocationAddress(host.address, host.city, host.state),
        );
        const hostLat = readNumberField(host, ["latitude", "lat"]);
        const hostLng = readNumberField(host, ["longitude", "lng"]);
        const coordinateMatches =
          eventLat !== null &&
          eventLng !== null &&
          hostLat !== null &&
          hostLng !== null &&
          getDistanceMiles(
            { lat: eventLat, lng: eventLng },
            { lat: hostLat, lng: hostLng },
          ) <= 0.08;
        if (!idMatches && !addressMatches && !coordinateMatches) continue;
        addTruck(host, {
          id: truckId || null,
          name: truckName,
          href: truckId ? `/truck/${encodeURIComponent(truckId)}` : null,
          source:
            event.type === "truck_manual_schedule"
              ? "manual_schedule"
              : "event",
          slotLabel:
            event.startTime && event.endTime
              ? `${event.startTime} - ${event.endTime}`
              : null,
        });
      }
    }

    return byHost;
  }, [scoutMapHostLocations, visibleMapEventLocations, visibleParkingPassListings]);

  /* --------- nearby restaurants --------- */

  const { data: nearbyRestaurantsRaw, isLoading: nearbyRestaurantsLoading, isError: subscribedRestaurantsError, isFetching: subscribedRestaurantsFetching, refetch: retrySubscribedRestaurants } =
    useQuery<RestaurantSummary[]>({
      queryKey: resolvedScoutLocation
        ? [
            "/api/restaurants/subscribed",
            resolvedScoutLocation.lat,
            resolvedScoutLocation.lng,
            discoveryRadiusKm,
          ]
        : ["/api/restaurants/subscribed", "no-location"],
      enabled: !!resolvedScoutLocation,
      queryFn: ({ signal }) => readScoutFeed<RestaurantSummary[]>(
        `/api/restaurants/subscribed/${resolvedScoutLocation?.lat}/${resolvedScoutLocation?.lng}?radius=${discoveryRadiusKm}`,
        null, signal, status => recordScoutSourceStatus("restaurants", status),
      ),
      retry: false,
      staleTime: 120_000,
    });

  const {
    data: nearbyPublicRestaurantsRaw,
    isLoading: nearbyPublicRestaurantsLoading,
    isError: nearbyPublicRestaurantsError,
    isFetching: nearbyPublicRestaurantsFetching,
    refetch: retryNearbyPublicRestaurants,
  } = useQuery<RestaurantSummary[]>({
    queryKey: resolvedScoutLocation
      ? [
          "/api/restaurants/nearby",
          resolvedScoutLocation.lat,
          resolvedScoutLocation.lng,
          discoveryRadiusKm,
        ]
      : ["/api/restaurants/nearby", "no-location"],
    enabled: !!resolvedScoutLocation,
    queryFn: ({ signal }) => readScoutFeed<RestaurantSummary[]>(
      `/api/restaurants/nearby/${resolvedScoutLocation?.lat}/${resolvedScoutLocation?.lng}?radius=${discoveryRadiusKm}`,
      null, signal,
    ),
    retry: false,
    staleTime: 120_000,
  });

  const nearbyRestaurantsData = subscribedRestaurantsError ? undefined : nearbyRestaurantsRaw;
  const nearbyPublicRestaurantsData = nearbyPublicRestaurantsError ? undefined : nearbyPublicRestaurantsRaw;
  const nearbyFoodBusinesses = useMemo<RestaurantSummary[]>(() => {
    const byId = new Map<string, RestaurantSummary>();
    for (const restaurant of [
      ...(Array.isArray(nearbyRestaurantsData) ? nearbyRestaurantsData : []),
      ...(Array.isArray(nearbyPublicRestaurantsData)
        ? nearbyPublicRestaurantsData
        : []),
    ]) {
      const id = String(restaurant?.id || "").trim();
      if (!id || byId.has(id)) continue;
      byId.set(id, restaurant);
    }
    return Array.from(byId.values()).filter((restaurant) => {
      const fallbackKm =
        typeof restaurant.distanceMiles === "number"
          ? restaurant.distanceMiles * 1.609344
          : typeof restaurant.distance === "number"
            ? restaurant.distance
            : null;
      return isWithinScoutRadius(
        resolvedScoutCoords,
        restaurant.latitude ?? restaurant.lat,
        restaurant.longitude ?? restaurant.lng,
        discoveryRadiusKm,
        fallbackKm,
      );
    });
  }, [
    resolvedScoutCoords,
    discoveryRadiusKm,
    nearbyPublicRestaurantsData,
    nearbyRestaurantsData,
  ]);

  const nearbyRestaurants = useMemo<RestaurantSummary[]>(() => {
    return nearbyFoodBusinesses.filter(
      (restaurant) => getScoutRestaurantLikeKind(restaurant) === "restaurant",
    );
  }, [nearbyFoodBusinesses]);

  const nearbyFoodTruckBusinesses = useMemo<RestaurantSummary[]>(() => {
    return nearbyFoodBusinesses.filter(
      (restaurant) => getScoutRestaurantLikeKind(restaurant) === "food_truck",
    );
  }, [nearbyFoodBusinesses]);

  const restaurantMenuPreviewQueries = useQueries({
    queries: nearbyRestaurants.slice(0, 8).map((restaurant) => ({
      queryKey: ["/api/restaurants", restaurant.id, "featured-item"],
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<MenuPreviewItem[]> => {
        const response = await fetch(
          `/api/restaurants/${encodeURIComponent(String(restaurant.id))}/featured-item`,
          { credentials: "include", signal },
        );
        if (!response.ok) return [];
        const data = await response.json();
        return data?.item ? [data.item] : [];
      },
      staleTime: 120_000,
      retry: false,
    })),
  });

  const menuPreviewByRestaurantId = useMemo(() => {
    const map = new Map<string, MenuPreviewItem[]>();
    nearbyRestaurants.slice(0, 8).forEach((restaurant, index) => {
      const result = restaurantMenuPreviewQueries[index];
      map.set(
        String(restaurant.id),
        Array.isArray(result?.data) ? result.data : [],
      );
    });
    return map;
  }, [nearbyRestaurants, restaurantMenuPreviewQueries]);

  const {
    data: localMenuItemsData = [],
    isLoading: localMenuItemsLoading,
  } = useQuery<LocalMenuItemFeedItem[]>({
    queryKey: resolvedScoutLocation
      ? [
          "/api/menus/local-items",
          resolvedScoutLocation.lat,
          resolvedScoutLocation.lng,
          discoveryRadiusKm,
        ]
      : ["/api/menus/local-items", "no-location"],
    enabled: !!resolvedScoutLocation,
    queryFn: async () => {
      if (!resolvedScoutLocation) return [];
      const response = await fetch(
        `/api/menus/local-items?lat=${resolvedScoutLocation.lat}&lng=${resolvedScoutLocation.lng}&radiusKm=${discoveryRadiusKm}&limit=24`,
        { credentials: "include" },
      );
      recordScoutSourceStatus("menus", response.status);
      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data?.items) ? data.items : [];
    },
    staleTime: 120_000,
    retry: false,
  });

  const localMenuItems = useMemo<LocalMenuItemFeedItem[]>(() => {
    return Array.isArray(localMenuItemsData) ? localMenuItemsData : [];
  }, [localMenuItemsData]);

  const { data: trendingData, isLoading: trendingLoading } =
    useQuery<ScoutTrendingResponse>({
    queryKey: ["/api/public/trending", "scout", 7],
    queryFn: async () => {
      const response = await fetch("/api/public/trending?limit=12&days=7", {
        credentials: "include",
      });
      if (!response.ok) {
        return {
          generatedAt: new Date(0).toISOString(),
          windowDays: 7,
          items: [],
          places: [],
        };
      }
      const data: ScoutTrendingResponse = await response.json();
      return {
        ...data,
        items: withScoutDishOwners(Array.isArray(data?.items) ? data.items : [], Array.isArray(data?.places) ? data.places : []),
      };
    },
    staleTime: 60_000,
    retry: false,
  });

  const {
    data: globalSearchData,
    isLoading: globalSearchLoading,
  } = useQuery<ScoutGlobalSearchResponse>({
    queryKey: ["/api/search", "scout-network", scoutSearchQuery.trim()],
    enabled: scoutSearchMode && scoutSearchQuery.trim().length >= 2,
    queryFn: async () => {
      const query = scoutSearchQuery.trim();
      const response = await fetch(
        `/api/search?q=${encodeURIComponent(query)}`,
        { credentials: "include" },
      );
      if (!response.ok) {
        return { query, restaurants: [], deals: [], events: [] };
      }
      const data = await response.json();
      return {
        query,
        restaurants: Array.isArray(data?.restaurants)
          ? data.restaurants
          : [],
        deals: Array.isArray(data?.deals) ? data.deals : [],
        events: Array.isArray(data?.events) ? data.events : [],
      };
    },
    staleTime: 60_000,
    retry: false,
  });

  const { data: favoriteRestaurantsData = [] } = useQuery<any[]>({
    queryKey: ["/api/favorites/restaurants", "scout"],
    enabled: !!user,
    queryFn: async () => {
      const response = await fetch("/api/favorites/restaurants", {
        credentials: "include",
      });
      if (!response.ok) return [];
      return response.json();
    },
    staleTime: 60_000,
    retry: false,
  });

  const { data: followedRestaurantsData = [] } = useQuery<any[]>({
    queryKey: ["/api/following/restaurants", "scout"],
    enabled: !!user,
    queryFn: async () => {
      const response = await fetch("/api/following/restaurants", {
        credentials: "include",
      });
      if (!response.ok) return [];
      return response.json();
    },
    staleTime: 60_000,
    retry: false,
  });

  const { data: recommendedRestaurantsData = [] } = useQuery<any[]>({
    queryKey: ["/api/recommendations/restaurants", "scout"],
    enabled: !!user,
    queryFn: async () => {
      const response = await fetch("/api/recommendations/restaurants", {
        credentials: "include",
      });
      if (!response.ok) return [];
      return response.json();
    },
    staleTime: 60_000,
    retry: false,
  });

  const restaurantRelationships =
    useMemo<RestaurantRelationshipSnapshot>(() => {
      const pickId = (row: any) =>
        String(row?.restaurantId || row?.restaurant?.id || "").trim();
      return {
        favoriteIds: new Set(
          favoriteRestaurantsData.map(pickId).filter((id) => id.length > 0),
        ),
        followIds: new Set(
          followedRestaurantsData.map(pickId).filter((id) => id.length > 0),
        ),
        recommendationIds: new Set(
          recommendedRestaurantsData.map(pickId).filter((id) => id.length > 0),
        ),
      };
    }, [
      favoriteRestaurantsData,
      followedRestaurantsData,
      recommendedRestaurantsData,
    ]);

  /* --------- nearby deals (location-aware) --------- */

  const { data: nearbyDealsData, isLoading: nearbyDealsLoading } =
    useQuery<DealSummary[]>({
    queryKey: resolvedScoutLocation
      ? [
          "/api/deals/nearby",
          resolvedScoutLocation.lat,
          resolvedScoutLocation.lng,
          discoveryRadiusKm,
        ]
      : ["/api/deals/nearby", "no-location"],
    enabled: !!resolvedScoutLocation,
    queryFn: async () => {
      if (!resolvedScoutLocation) return [];
      const response = await fetch(
        `/api/deals/nearby/${resolvedScoutLocation.lat}/${resolvedScoutLocation.lng}?radius=${discoveryRadiusKm}`,
        { credentials: "include" },
      );
      recordScoutSourceStatus("deals", response.status);
      if (!response.ok) return [];
      const data = await response.json();
      if (Array.isArray(data)) return data;
      if (Array.isArray(data.deals)) return data.deals;
      return [];
    },
    staleTime: 60_000,
  });

  const nearbyDeals = useMemo<DealSummary[]>(() => {
    if (!nearbyDealsData) return [];
    if (Array.isArray(nearbyDealsData)) return nearbyDealsData;
    return [];
  }, [nearbyDealsData]);

  // Scout is a local dashboard. Do not leak global featured deals into this lane.
  const allDeals = useMemo<DealSummary[]>(() => {
    const seen = new Set<string>();
    const merged: DealSummary[] = [];
    for (const d of nearbyDeals) {
      if (!seen.has(d.id)) {
        seen.add(d.id);
        merged.push(d);
      }
    }
    return merged;
  }, [nearbyDeals]);

  const marketCity = useMemo(() => {
    const label = String(resolvedScoutLocation?.label || "").trim();
    return label ? label.split(",")[0]?.trim().toLowerCase() || "" : "";
  }, [resolvedScoutLocation]);
  const marketState = useMemo(() => {
    const label = String(resolvedScoutLocation?.label || "").trim();
    return label.includes(",")
      ? label.split(",")[1]?.trim().toLowerCase() || ""
      : "";
  }, [resolvedScoutLocation]);

  const trendingPlacesThisWeek = useMemo(() => {
    const places = Array.isArray(trendingData?.places)
      ? trendingData.places
      : [];
    if (!marketCity && !marketState) return [];
    return places
      .filter((place) => {
        const placeCity = String(place.city || "")
          .trim()
          .toLowerCase();
        const placeState = String(place.state || "")
          .trim()
          .toLowerCase();
        if (marketCity && placeCity === marketCity) return true;
        return Boolean(marketState && placeState === marketState);
      })
      .slice(0, 8);
  }, [marketCity, marketState, trendingData?.places]);

  const popularDishes = useMemo(() => {
    const items = Array.isArray(trendingData?.items) ? trendingData.items : [];
    const localItems = items.filter((item) => {
      const itemCity = String(item.restaurantCity || "")
        .trim()
        .toLowerCase();
      const itemState = String(item.restaurantState || "")
        .trim()
        .toLowerCase();
      if (marketCity && itemCity === marketCity) return true;
      return Boolean(marketState && itemState === marketState);
    });
    return localItems.slice(0, 8);
  }, [marketCity, marketState, trendingData?.items]);

  const openFavoritePlaceRequest = useCallback(() => {
    setPlaceRequestQuery("");
    setSelectedPlaceRequest(null);
    setIsPlaceRequestOpen(true);
  }, []);

  const selectFavoritePlaceRequest = useCallback(
    async (suggestion: {
      placeId: string;
      text: string;
      mainText: string;
      secondaryText: string;
      _sessionToken?: string;
    }) => {
      setIsLoadingPlaceRequest(true);
      try {
        const detailUrl = new URL(
          `/api/map/place-details/${encodeURIComponent(suggestion.placeId)}`,
          window.location.origin,
        );
        if (suggestion._sessionToken) {
          detailUrl.searchParams.set("sessionToken", suggestion._sessionToken);
        }
        const response = await fetch(detailUrl.toString(), {
          credentials: "include",
        });
        if (!response.ok) throw new Error("Could not load that place");
        const data = await response.json().catch(() => ({}));
        const place = data?.place || {};
        setSelectedPlaceRequest({
          placeId: String(place.placeId || suggestion.placeId),
          restaurantName: String(
            place.name || suggestion.mainText || suggestion.text,
          ).trim(),
          address: String(
            place.formattedAddress || suggestion.text || "",
          ).trim(),
          city: String(place.city || marketCity || "").trim(),
          county: String(place.county || "").trim(),
          state: String(place.state || marketState || "").trim(),
          latitude:
            typeof place.latitude === "number" ? place.latitude : null,
          longitude:
            typeof place.longitude === "number" ? place.longitude : null,
        });
      } catch {
        toast({
          variant: "destructive",
          description: "We couldn't load that place. Please try another result.",
        });
      } finally {
        setIsLoadingPlaceRequest(false);
      }
    },
    [marketCity, marketState, toast],
  );

  const submitFavoritePlaceRequest = useCallback(async () => {
    if (!selectedPlaceRequest?.restaurantName) return;
    setIsSubmittingPlaceRequest(true);
    try {
      const response = await fetch(apiUrl("/api/affiliate/submit-restaurant"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restaurantName: selectedPlaceRequest.restaurantName,
          address: selectedPlaceRequest.address,
          county:
            selectedPlaceRequest.county ||
            selectedPlaceRequest.city ||
            String(resolvedScoutLocation?.label || "Scout request"),
          state: selectedPlaceRequest.state || "Unknown",
          category: scoutSearchQuery.trim() || undefined,
          latitude:
            selectedPlaceRequest.latitude === null
              ? undefined
              : String(selectedPlaceRequest.latitude),
          longitude:
            selectedPlaceRequest.longitude === null
              ? undefined
              : String(selectedPlaceRequest.longitude),
          description: scoutSearchQuery.trim()
            ? `Requested from Scout after no nearby result for "${scoutSearchQuery.trim()}".`
            : "Requested from Scout because local coverage was empty.",
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(data?.error || "Request failed"));
      }
      toast({
        description:
          data?.success === false
            ? "That place has already been requested."
            : "Requested. We'll review it for MealScout.",
      });
      setIsPlaceRequestOpen(false);
      setPlaceRequestQuery("");
      setSelectedPlaceRequest(null);
    } catch {
      toast({
        variant: "destructive",
        description: "We couldn't send that request. Please try again.",
      });
    } finally {
      setIsSubmittingPlaceRequest(false);
    }
  }, [
    resolvedScoutLocation?.label,
    scoutSearchQuery,
    selectedPlaceRequest,
    toast,
  ]);

  const newToMealScoutRestaurants = useMemo(() => {
    const freshRows = nearbyRestaurants
      .map((restaurant) => ({
        restaurant,
        createdAt: readStringField(restaurant, ["createdAt"]),
      }))
      .filter(
        (
          value,
        ): value is {
          restaurant: RestaurantSummary;
          createdAt: string;
        } => Boolean(value.createdAt),
      )
      .filter(({ createdAt }) => {
        const createdAtMs = new Date(createdAt).getTime();
        if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return false;
        const ageDays = (Date.now() - createdAtMs) / (1000 * 60 * 60 * 24);
        return ageDays <= 45;
      })
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      .map(({ restaurant }) => restaurant);
    return freshRows.slice(0, 8);
  }, [nearbyRestaurants]);

  const happyHourDeals = useMemo(() => {
    return allDeals.filter((deal) => {
      const haystack =
        `${deal.title || ""} ${deal.description || ""}`.toLowerCase();
      return haystack.includes("happy hour");
    });
  }, [allDeals]);

  const fallbackTruckBusinesses = useMemo<LiveTruckSummary[]>(
    () =>
      nearbyFoodTruckBusinesses.map((restaurant) => ({
        id: String(restaurant.id),
        name: getRestaurantName(restaurant),
        cuisineType: restaurant.cuisineType ?? null,
        imageUrl:
          restaurant.imageUrl ??
          restaurant.coverImageUrl ??
          restaurant.heroImageUrl ??
          restaurant.logoUrl ??
          null,
        coverImageUrl:
          restaurant.coverImageUrl ??
          restaurant.heroImageUrl ??
          restaurant.imageUrl ??
          null,
        logoUrl: restaurant.logoUrl ?? null,
        city: restaurant.city ?? null,
        state: restaurant.state ?? null,
        address: restaurant.address ?? null,
        latitude: restaurant.latitude ?? restaurant.lat ?? null,
        longitude: restaurant.longitude ?? restaurant.lng ?? null,
        distanceMiles: restaurant.distanceMiles ?? null,
        distance:
          typeof restaurant.distance === "number"
            ? restaurant.distance
            : typeof restaurant.distanceMiles === "number"
              ? restaurant.distanceMiles * 1.609344
              : null,
        mobileOnline: false,
        activeDealCount: Number(
          restaurant.activeDealsCount || restaurant.activeDealCount || 0,
        ),
      })),
    [nearbyFoodTruckBusinesses],
  );

  const scoutTruckInventory = useMemo(() => {
    const byId = new Map<string, LiveTruckSummary>();
    liveTrucks.forEach((truck) => byId.set(String(truck.id), truck));
    fallbackTruckBusinesses.forEach((truck) => {
      if (!byId.has(String(truck.id))) byId.set(String(truck.id), truck);
    });
    return Array.from(byId.values());
  }, [fallbackTruckBusinesses, liveTrucks]);

  /* --------- markers for the hero map --------- */

  const truckMarkers = useMemo<MapAdapterMarker[]>(() => {
    return scoutTruckInventory
      .filter(isTruckBroadcastLive)
      .map((t) => {
        const coords = getTruckCoords(t);
        if (!coords) return null;
        const isServing = isTruckServingNow(t);
        return {
          id: String(t.id),
          sourceId: String(t.id),
          kind: "truck" as const,
          lat: coords.lat,
          lng: coords.lng,
          title: t.name,
          subtitle: getMapMarkerSubtitle(t.cuisineType, {
            kind: "truck",
            updatedAt: readStringField(t, ["updatedAt", "lastUpdatedAt"]),
            confirmedAt: readStringField(t, ["confirmedAt", "lastConfirmedAt"]),
            hasDeal: Boolean(t.activeDealCount && t.activeDealCount > 0),
            hasDistance: Boolean(formatDistance(t)),
            isOpen: isServing,
          }),
          color: getMapMarkerColor({
            kind: "truck",
            hasDeal: Boolean(t.activeDealCount && t.activeDealCount > 0),
            isOpen: isServing,
          }),
          imageUrl: getTruckImage(t),
        } as MapAdapterMarker;
      })
      .filter((m): m is MapAdapterMarker => m !== null);
  }, [scoutTruckInventory]);
  const liveTruckById = useMemo(() => {
    const map = new Map<string, LiveTruckSummary>();
    for (const truck of scoutTruckInventory) map.set(String(truck.id), truck);
    return map;
  }, [scoutTruckInventory]);

  const restaurantMarkers = useMemo<MapAdapterMarker[]>(() => {
    return nearbyRestaurants
      .map((r) => {
        const coordinates =
          resolveCoordinatePair(r.latitude, r.longitude) ??
          resolveCoordinatePair(r.lat, r.lng);
        if (!coordinates) return null;
        const lat = coordinates.latitude;
        const lng = coordinates.longitude;
        const openState = getRestaurantOpenState(r);
        const dealCount = Number(r.activeDealsCount || r.activeDealCount || 0);
        const hasCommunityUpdate =
          Number(r.communityActivityCount || 0) > 0 ||
          Number(r.recommendationCount || 0) > 0 ||
          Number(r.videoRecommendationCount || 0) > 0;
        const freshnessMeta: FreshnessMeta = {
          kind: "restaurant",
          updatedAt: readStringField(r, ["updatedAt", "lastUpdatedAt"]),
          confirmedAt: readStringField(r, ["confirmedAt", "lastConfirmedAt"]),
          hasDeal: dealCount > 0,
          hasCommunityUpdate,
          hasDistance: Boolean(getRestaurantDistance(r)),
          isOpen: openState === "open",
        };
        return {
          id: `restaurant-${r.id}`,
          sourceId: String(r.id),
          kind: "restaurant" as const,
          lat,
          lng,
          title: r.businessName ?? r.name ?? undefined,
          subtitle: getMapMarkerSubtitle(r.cuisineType, freshnessMeta),
          color: getMapMarkerColor(freshnessMeta),
          imageUrl: getRestaurantImage(r),
        } as MapAdapterMarker;
      })
      .filter((m): m is MapAdapterMarker => m !== null);
  }, [nearbyRestaurants]);

  const eventMarkers = useMemo<MapAdapterMarker[]>(() => {
    return visibleEvents
      .filter((event) => isTodayDate(getEventCalendarDay(event)))
      .map((e) => {
        const coords = getEventCoords(e);
        if (!coords) return null;
        const freshnessMeta: FreshnessMeta = {
          kind: "event",
          startsAt: getEventCalendarDay(e),
          startTime: e.startTime,
          updatedAt: readStringField(e, ["updatedAt", "lastUpdatedAt"]),
          confirmedAt: readStringField(e, ["confirmedAt", "lastConfirmedAt"]),
        };
        return {
          id: `event-${e.id}`,
          sourceId: String(e.id),
          kind: "event" as const,
          lat: coords.lat,
          lng: coords.lng,
          title: e.title ?? e.name ?? undefined,
          subtitle: getMapMarkerSubtitle(
            e.venueName ?? e.locationName ?? e.host?.businessName,
            freshnessMeta,
          ),
          color: getMapMarkerColor(freshnessMeta),
        } as MapAdapterMarker;
      })
      .filter((m): m is MapAdapterMarker => m !== null);
  }, [visibleEvents]);

  const hostMarkers = useMemo<MapAdapterMarker[]>(() => {
    return scoutMapHostLocations
      .map((host) => {
        const lat = readNumberField(host, ["latitude", "lat"]);
        const lng = readNumberField(host, ["longitude", "lng"]);
        if (lat === null || lng === null) return null;
        const hostKey = getScoutHostMarkerKey(host);
        const parkedTrucks = parkedTrucksByHostKey.get(hostKey) || [];
        const inventoryStatus = parkingPassStatusByHostKey.get(hostKey) || null;
        const parkingStatus =
          parkedTrucks.length > 0 ? "occupied" : inventoryStatus;
        const parkingCopy = getScoutHostParkingCopy(parkingStatus);
        const address = [host.address, host.city, host.state]
          .filter(Boolean)
          .join(", ");
        const title = host.businessName || host.name || "Host location";
        return {
          id: `host-${hostKey}`,
          sourceId: hostKey,
          kind: "parking" as const,
          lat,
          lng,
          title,
          subtitle:
            parkedTrucks.length > 0
              ? formatScoutCount(
                  parkedTrucks.length,
                  "truck parked here",
                  "trucks parked here",
                )
              : getMapMarkerSubtitle(parkingCopy.description, {
                  kind: "host",
                  updatedAt: readStringField(host, [
                    "updatedAt",
                    "lastUpdatedAt",
                  ]),
                  confirmedAt: readStringField(host, [
                    "confirmedAt",
                    "lastConfirmedAt",
                  ]),
                }),
          color: parkedTrucks.length > 0 ? "#fb923c" : "#f59e0b",
          address,
          spotImageUrl: host.spotImageUrl || null,
          parkedTrucks,
          parkingStatus,
        } as MapAdapterMarker;
      })
      .filter((m): m is MapAdapterMarker => Boolean(m && m.sourceId));
  }, [parkedTrucksByHostKey, parkingPassStatusByHostKey, scoutMapHostLocations]);

  const dealMarkers = useMemo<MapAdapterMarker[]>(() => {
    return nearbyDeals
      .map((deal) => {
        const lat = readNumberField(deal, [
          "latitude",
          "lat",
          "restaurantLatitude",
          "restaurantLat",
          "locationLat",
        ]);
        const lng = readNumberField(deal, [
          "longitude",
          "lng",
          "restaurantLongitude",
          "restaurantLng",
          "locationLng",
        ]);
        if (lat === null || lng === null) return null;
        return {
          id: `deal-${deal.id}`,
          sourceId: String(deal.id),
          kind: "deal" as const,
          lat,
          lng,
          title: deal.title || "Deal today",
          subtitle: getMapMarkerSubtitle(deal.restaurantName || "Nearby", {
            kind: "deal",
            hasDeal: true,
          }),
          color: "#fb923c",
        } as MapAdapterMarker;
      })
      .filter((m): m is MapAdapterMarker => Boolean(m));
  }, [nearbyDeals]);

  // Combined markers for the full Google Map view
  const allMapMarkers = useMemo<MapAdapterMarker[]>(
    () => [
      ...truckMarkers,
      ...restaurantMarkers,
      ...eventMarkers,
      ...hostMarkers,
      ...dealMarkers,
    ],
    [truckMarkers, restaurantMarkers, eventMarkers, hostMarkers, dealMarkers],
  );

  const scoutDebugCounts = useMemo(() => {
    const rawLiveTruckRows = Array.isArray(liveTrucksData)
      ? liveTrucksData
      : Array.isArray(liveTrucksData?.trucks)
        ? liveTrucksData.trucks
        : [];
    const rawRestaurantRows = Array.isArray(nearbyRestaurantsData)
      ? nearbyRestaurantsData
      : [];
    const rawHostRows = Array.isArray(mapLocationsData?.hostLocations)
      ? mapLocationsData.hostLocations
      : [];
    const rawEventRows = Array.isArray(events) ? events : [];
    const rawDealRows = Array.isArray(nearbyDeals) ? nearbyDeals : [];

    const hasCoords = (row: unknown) =>
      readNumberField(row, [
        "latitude",
        "lat",
        "venueLat",
        "restaurantLatitude",
        "locationLat",
      ]) !== null &&
      readNumberField(row, [
        "longitude",
        "lng",
        "venueLng",
        "restaurantLongitude",
        "locationLng",
      ]) !== null;

    const pinsByKind = allMapMarkers.reduce<Record<string, number>>(
      (acc, marker) => {
        acc[marker.kind] = (acc[marker.kind] || 0) + 1;
        return acc;
      },
      {},
    );

    return {
      trucksReturned: rawLiveTruckRows.length,
      trucksMissingCoords: rawLiveTruckRows.filter((row) => !hasCoords(row))
        .length,
      trucksShown: scoutTruckInventory.length,
      restaurantsReturned: rawRestaurantRows.length,
      restaurantsMissingCoords: rawRestaurantRows.filter(
        (row) => !hasCoords(row),
      ).length,
      hostsReturned: rawHostRows.length,
      hostsMissingCoords: rawHostRows.filter((row) => !hasCoords(row)).length,
      hostsShown: hostMarkers.length,
      eventsReturned: rawEventRows.length,
      eventsMissingCoords: rawEventRows.filter((row) => !hasCoords(row)).length,
      dealsReturned: rawDealRows.length,
      dealsMissingCoords: rawDealRows.filter((row) => !hasCoords(row)).length,
      mapPinsBuilt: allMapMarkers.length,
      mapPinsByKind: pinsByKind,
    };
  }, [
    allMapMarkers,
    events,
    liveTrucksData,
    mapLocationsData,
    nearbyDeals,
    nearbyRestaurantsData,
    scoutTruckInventory.length,
    hostMarkers.length,
  ]);

  const [activeMapLayers, setActiveMapLayers] = useState<MapLayerState>(restoredJourney?.layers ?? {
    openNow: true,
    foodTrucks: true,
    deals: true,
    happeningToday: true,
  });

  const filteredMapMarkers = useMemo<MapAdapterMarker[]>(() => {
    const searchTerms = tokenizeScoutSearch(scoutSearchQuery);
    return allMapMarkers.filter((marker) => {
      let layerAllowed = true;
      if (marker.kind === "truck")
        layerAllowed = activeMapLayers.foodTrucks && activeMapLayers.openNow;
      if (marker.kind === "event")
        layerAllowed = activeMapLayers.happeningToday;
      if (marker.kind === "parking") {
        layerAllowed =
          activeMapLayers.happeningToday || activeMapLayers.foodTrucks;
      }
      if (marker.kind === "deal") layerAllowed = activeMapLayers.deals;
      if (marker.kind === "restaurant") {
        const restaurant = nearbyRestaurants.find(
          (item) => String(item.id) === String(marker.sourceId),
        );
        const hasDeal = Boolean(
          restaurant &&
            Number(
              restaurant.activeDealsCount || restaurant.activeDealCount || 0,
            ) > 0,
        );
        const openState = restaurant
          ? getRestaurantOpenState(restaurant)
          : "unknown";
        layerAllowed = shouldShowRestaurantMarker({
          openState,
          hasDeal,
          showOpenNow: activeMapLayers.openNow,
          showDeals: activeMapLayers.deals,
        });
      }
      if (!layerAllowed) return false;
      if (scoutSearchMode) {
        if (!matchesScoutSearchText(marker, searchTerms)) return false;
        if (!matchesScoutIntent(marker, scoutSearchIntent, marker.kind))
          return false;
      }
      return true;
    });
  }, [
    activeMapLayers,
    allMapMarkers,
    nearbyRestaurants,
    scoutSearchIntent,
    scoutSearchMode,
    scoutSearchQuery,
  ]);

  const sceneFilteredMapMarkers = useMemo<MapAdapterMarker[]>(() => {
    if (activeSceneLaneId === "for_you") return filteredMapMarkers;
    if (activeSceneLaneId === "community")
      return filteredMapMarkers.filter(
        (marker) =>
          marker.kind === "restaurant" ||
          marker.kind === "truck" ||
          marker.kind === "parking",
      );
    if (activeSceneLaneId === "nearby_now")
      return filteredMapMarkers.filter(
        (marker) =>
          marker.kind === "truck" ||
          marker.kind === "restaurant" ||
          marker.kind === "parking",
      );
    if (activeSceneLaneId === "food_trucks")
      return filteredMapMarkers.filter((marker) => marker.kind === "truck");
    if (activeSceneLaneId === "restaurants")
      return filteredMapMarkers.filter(
        (marker) => marker.kind === "restaurant",
      );
    if (activeSceneLaneId === "deals")
      return filteredMapMarkers.filter(
        (marker) => marker.kind === "restaurant" || marker.kind === "deal",
      );
    if (activeSceneLaneId === "events")
      return filteredMapMarkers.filter(
        (marker) => marker.kind === "event" || marker.kind === "parking",
      );
    if (activeSceneLaneId === "new_menus")
      return filteredMapMarkers.filter(
        (marker) => marker.kind === "restaurant" || marker.kind === "truck",
      );
    if (activeSceneLaneId === "late_night")
      return filteredMapMarkers.filter(
        (marker) =>
          marker.kind === "restaurant" ||
          marker.kind === "event" ||
          marker.kind === "parking",
      );
    if (activeSceneLaneId === "worth_discovering")
      return filteredMapMarkers.filter(
        (marker) => marker.kind === "restaurant" || marker.kind === "truck",
      );
    return filteredMapMarkers;
  }, [activeSceneLaneId, filteredMapMarkers]);

  const sceneMapMarkerCounts = useMemo(
    () => ({
      pinCount: sceneFilteredMapMarkers.length,
      liveTruckCount: sceneFilteredMapMarkers.filter(
        (marker) => marker.kind === "truck",
      ).length,
      restaurantCount: sceneFilteredMapMarkers.filter(
        (marker) => marker.kind === "restaurant",
      ).length,
      dealCount: sceneFilteredMapMarkers.filter(
        (marker) => marker.kind === "deal",
      ).length,
      eventCount: sceneFilteredMapMarkers.filter(
        (marker) => marker.kind === "event",
      ).length,
    }),
    [sceneFilteredMapMarkers],
  );

  const toggleMapLayer = useCallback((layer: MapLayerId) => {
    setActiveMapLayers((current) => ({
      ...current,
      [layer]: !current[layer],
    }));
  }, []);

  const previousSceneLane = useRef(activeSceneLaneId);
  useEffect(() => {
    if (previousSceneLane.current === activeSceneLaneId) return;
    previousSceneLane.current = activeSceneLaneId;
    if (activeSceneLaneId === "food_trucks") {
      setActiveMapLayers({
        openNow: true,
        foodTrucks: true,
        deals: false,
        happeningToday: false,
      });
      return;
    }
    if (activeSceneLaneId === "restaurants") {
      setActiveMapLayers({
        openNow: true,
        foodTrucks: false,
        deals: true,
        happeningToday: false,
      });
      return;
    }
    if (activeSceneLaneId === "deals") {
      setActiveMapLayers({
        openNow: false,
        foodTrucks: false,
        deals: true,
        happeningToday: false,
      });
      return;
    }
    if (activeSceneLaneId === "events" || activeSceneLaneId === "late_night") {
      setActiveMapLayers({
        openNow: false,
        foodTrucks: false,
        deals: false,
        happeningToday: true,
      });
      return;
    }
    setActiveMapLayers({
      openNow: true,
      foodTrucks: true,
      deals: true,
      happeningToday: true,
    });
  }, [activeSceneLaneId]);

  /* --------- map state --------- */

  const HERO_ZOOM = 14;
  const [mapZoom, setMapZoom] = useState<number>(restoredJourney?.map.zoom ?? HERO_ZOOM);
  const [mapCenter, setMapCenter] = useState<{
    lat: number;
    lng: number;
  } | null>(restoredJourney?.map.center ?? null);
  const userPushedMapRef = useRef(Boolean(restoredJourney?.map.center));
  const lastCenteredScoutSourceRef = useRef<string | null>(null);
  const [sheetState, setSheetState] = useState<"default" | "fullMap">(
    restoredJourney?.map.expanded ? "fullMap" : "default",
  );
  const [selectedLiveTruck, setSelectedLiveTruck] =
    useState<LiveTruckSummary | null>(null);
  const [selectedMapMarker, setSelectedMapMarker] =
    useState<MapAdapterMarker | null>(null);
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(restoredJourney?.map.selectedMarkerId ?? null);
  const [mapBounds, setMapBounds] = useState<MapBoundsLike | null>(null);
  useScoutJourneyPersistence(account, {
    route: journeyRoute, search: { open: scoutSearchMode, query: scoutSearchQuery, filter: scoutSearchFilter },
    scene: activeSceneLaneId, craving: selectedCravingId, radiusKm: discoveryRadiusKm, layers: activeMapLayers,
    map: { center: mapCenter, zoom: mapZoom, expanded: sheetState === "fullMap", selectedMarkerId }, scrollY: 0,
  }, restoredJourney?.scrollY ?? 0);
  const restoredMarker = useRef(false);
  useEffect(() => {
    if (restoredMarker.current || !restoredJourney?.map.selectedMarkerId) return;
    const marker = allMapMarkers.find(item => item.id === restoredJourney.map.selectedMarkerId);
    if (!marker) return;
    restoredMarker.current = true;
    if (marker.kind === "truck") setSelectedLiveTruck(liveTruckById.get(String(marker.sourceId)) ?? null);
    else setSelectedMapMarker(marker);
  }, [allMapMarkers, liveTruckById, restoredJourney]);
  const googleMapContainerRef = useRef<HTMLDivElement | null>(null);
  const [googleMapFailed, setGoogleMapFailed] = useState(false);
  const { data: mapRuntime } = useQuery<MapRuntimeResponse>({
    queryKey: ["/api/map/runtime"],
    queryFn: async () => {
      const response = await fetch("/api/map/runtime");
      if (!response.ok) {
        return { hasGoogleMapsKey: false, googleMapsApiKey: null };
      }
      return response.json();
    },
    retry: 3,
    retryDelay: 800,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
  const runtimeGoogleMapsApiKey = String(
    mapRuntime?.googleMapsApiKey || "",
  ).trim();
  const runtimeGoogleMapsMapId = String(
    mapRuntime?.googleMapsMapId || "",
  ).trim();
  const mapRuntimeResolved = mapRuntime !== undefined;
  const buildGoogleMapsMapId = String(
    (import.meta as any).env?.VITE_GOOGLE_MAPS_MAP_ID || "",
  ).trim();
  const effectiveGoogleMapsApiKey =
    runtimeGoogleMapsApiKey ||
    (mapRuntimeResolved ? GOOGLE_MAPS_WEB_API_KEY : "");
  const effectiveGoogleMapsMapId =
    runtimeGoogleMapsMapId || buildGoogleMapsMapId;
  const hasMapKey = effectiveGoogleMapsApiKey.length > 0;

  const openScoutMap = useCallback(() => {
    if (resolvedScoutCoords) {
      setMapCenter(resolvedScoutCoords);
    }
    setGoogleMapFailed(false);
    setSheetState("fullMap");
  }, [resolvedScoutCoords]);

  const collapseScoutMap = useCallback(() => {
    setSheetState("default");
  }, []);

  useEffect(() => {
    if (!hasMapKey) return;
    if (sheetState !== "default") return;
    if (typeof window === "undefined") return;
    const connection = (navigator as any).connection;
    if (connection?.saveData) return;

    let cancelled = false;
    let timeoutId: number | null = null;
    let idleId: number | null = null;

    const startPrefetch = () => {
      if (cancelled) return;
      if (window.location.pathname !== "/scout") return;
      preloadGoogleMapsScript(effectiveGoogleMapsApiKey);
    };

    timeoutId = window.setTimeout(() => {
      if ("requestIdleCallback" in window) {
        idleId = (window as any).requestIdleCallback(startPrefetch, {
          timeout: 2500,
        });
        return;
      }
      startPrefetch();
    }, 2500);

    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (idleId !== null && "cancelIdleCallback" in window) {
        (window as any).cancelIdleCallback(idleId);
      }
    };
  }, [effectiveGoogleMapsApiKey, hasMapKey, sheetState]);

  // When we first get coords, set the map center to the right-quadrant offset.
  useEffect(() => {
    const source = resolvedScoutLocation?.source || null;
    if (restoredJourney?.map.center && lastCenteredScoutSourceRef.current === null) {
      lastCenteredScoutSourceRef.current = source; return;
    }
    const { freshDeviceLocation, shouldRecenter } = getScoutRecenterDecision({
      source,
      lastCenteredSource: lastCenteredScoutSourceRef.current,
      userPushedMap: userPushedMapRef.current,
    });
    lastCenteredScoutSourceRef.current = source;
    if (!resolvedScoutCoords || !shouldRecenter) return;
    if (freshDeviceLocation) userPushedMapRef.current = false;
    setMapCenter(
      shiftCenterForRightQuadrant(
        resolvedScoutCoords.lat,
        resolvedScoutCoords.lng,
        HERO_ZOOM,
      ),
    );
  }, [resolvedScoutCoords, resolvedScoutLocation?.source]);

  const handleMapBoundsChanged = useCallback((bounds: MapBoundsLike) => {
    setMapBounds(bounds);
  }, []);
  const handleMapZoomChanged = useCallback((z: number) => {
    setMapZoom(z);
    userPushedMapRef.current = true;
  }, []);
  const handleMapCenterChanged = useCallback(
    (c: { lat: number; lng: number }) => {
      setMapCenter(c);
      userPushedMapRef.current = true;
    },
    [],
  );
  const selectLiveTruck = useCallback(
    (truck: LiveTruckSummary) => {
      const truckCoords = getTruckCoords(truck);
      setSelectedLiveTruck(truck);
      if (truckCoords) {
        setMapCenter(truckCoords);
        setMapZoom(16);
      } else if (resolvedScoutCoords) {
        setMapCenter(resolvedScoutCoords);
      }
      setGoogleMapFailed(false);
      setSheetState("fullMap");
    },
    [resolvedScoutCoords],
  );
  const handleMarkerTap = useCallback(
    (marker: MapAdapterMarker) => {
      setSelectedMarkerId(marker.id);
      if (marker.kind === "truck") {
        const truck = liveTruckById.get(String(marker.sourceId));
        if (truck) {
          selectLiveTruck(truck);
          setSelectedMapMarker(null);
          return;
        }
        navigate(`/truck/${marker.sourceId}`);
      } else if (
        marker.kind === "restaurant" ||
        marker.kind === "event" ||
        marker.kind === "parking" ||
        marker.kind === "deal"
      ) {
        setSelectedLiveTruck(null);
        setSelectedMapMarker(marker);
        setMapCenter({ lat: marker.lat, lng: marker.lng });
        setMapZoom(Math.max(mapZoom, 15));
      }
    },
    [liveTruckById, mapZoom, navigate, selectLiveTruck],
  );
  const handlePreviewMarkerTap = useCallback(
    (marker: MapAdapterMarker) => {
      setGoogleMapFailed(false);
      setSelectedMarkerId(marker.id);
      setMapCenter({ lat: marker.lat, lng: marker.lng });
      setMapZoom(Math.max(mapZoom, 15));
      if (marker.kind === "truck") {
        const truck = liveTruckById.get(String(marker.sourceId));
        setSelectedLiveTruck(truck || null);
        setSelectedMapMarker(null);
      } else {
        setSelectedLiveTruck(null);
        setSelectedMapMarker(marker);
      }
    },
    [liveTruckById, mapZoom],
  );

  /* --------- pull-down-to-fullscreen sheet --------- */

  // When sheetState transitions to fullMap, after the 320ms CSS height
  // transition completes, fire a resize event
  //    so Google Maps re-tiles to the full 100dvh container dimensions.
  useEffect(() => {
    if (sheetState === "fullMap") {
      const timer = setTimeout(() => {
        // Dispatch a native resize event on the window — Google Maps listens
        // for this and re-tiles automatically.
        window.dispatchEvent(new Event("resize"));
      }, 340); // slightly after the 320ms CSS transition
      return () => clearTimeout(timer);
    }
  }, [sheetState]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.classList.toggle(
      "mealscout-map-fullscreen",
      sheetState === "fullMap",
    );
    return () => {
      document.body.classList.remove("mealscout-map-fullscreen");
    };
  }, [sheetState]);

  const dragStartY = useRef<number | null>(null);
  const dragLastY = useRef<number | null>(null);
  const mouseDragStartY = useRef<number | null>(null);
  const mouseDragLastY = useRef<number | null>(null);

  const handleSheetTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    dragStartY.current = touch.clientY;
    dragLastY.current = touch.clientY;
  }, []);
  const handleSheetTouchMove = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    dragLastY.current = touch.clientY;
  }, []);
  const handleSheetTouchEnd = useCallback(() => {
    const start = dragStartY.current;
    const last = dragLastY.current;
    dragStartY.current = null;
    dragLastY.current = null;
    if (start === null || last === null) return;
    const delta = last - start;
    // Keep interactions simple: pull down to expand, pull up to collapse.
    if (delta > 40 && sheetState === "default") {
      openScoutMap();
      return;
    }
    if (delta < -40 && sheetState === "fullMap") {
      collapseScoutMap();
    }
  }, [collapseScoutMap, openScoutMap, sheetState]);

  const handleSheetMouseDown = useCallback((e: React.MouseEvent) => {
    mouseDragStartY.current = e.clientY;
    mouseDragLastY.current = e.clientY;
  }, []);

  const handleSheetMouseMove = useCallback((e: React.MouseEvent) => {
    if (mouseDragStartY.current === null) return;
    mouseDragLastY.current = e.clientY;
  }, []);

  const handleSheetMouseUp = useCallback(() => {
    const start = mouseDragStartY.current;
    const last = mouseDragLastY.current;
    mouseDragStartY.current = null;
    mouseDragLastY.current = null;
    if (start === null || last === null) return;
    const delta = last - start;
    if (delta > 24 && sheetState === "default") {
      openScoutMap();
      return;
    }
    if (delta < -24 && sheetState === "fullMap") {
      collapseScoutMap();
    }
  }, [collapseScoutMap, openScoutMap, sheetState]);

  /* --------- greeting --------- */

  const greetingTime = getGreetingTime();
  const greetingFirstLine = `Good ${greetingTime},`;
  const greetingSecondLine = firstName ? `${firstName}.` : "Welcome.";

  /* --------- render --------- */

  const currentUserId = getCurrentUserId(user);
  const showQuickUpdateBar = isFoodOperator(user);
  const scoutTruckInventoryForFeed = useMemo(
    () =>
      canonicalizeScoutRows(
        filterScoutSearchRows(
          scoutTruckInventory,
          scoutSearchMode,
          scoutSearchQuery,
          scoutSearchIntent,
          "truck",
        ),
        {
          kind: "food_truck",
          scope: "nearby",
          source: "live_presence",
          query: scoutSearchMode ? scoutSearchQuery : undefined,
        },
      ),
    [scoutSearchIntent, scoutSearchMode, scoutSearchQuery, scoutTruckInventory],
  );
  const nearbyRestaurantsForFeed = useMemo(
    () =>
      canonicalizeScoutRows(
        filterScoutSearchRows(
          nearbyRestaurants,
          scoutSearchMode,
          scoutSearchQuery,
          scoutSearchIntent,
          "restaurant",
        ),
        {
          kind: "business",
          scope: "nearby",
          source: "local_inventory",
          query: scoutSearchMode ? scoutSearchQuery : undefined,
        },
      ),
    [nearbyRestaurants, scoutSearchIntent, scoutSearchMode, scoutSearchQuery],
  );
  const localRotatingSpotCandidatesForFeed = useMemo(
    () =>
      canonicalizeScoutRows(
        filterScoutSearchRows(
          nearbyFoodBusinesses,
          scoutSearchMode,
          scoutSearchQuery,
          scoutSearchIntent,
        ),
        {
          kind: "business",
          scope: "nearby",
          source: "local_inventory",
          query: scoutSearchMode ? scoutSearchQuery : undefined,
          limit: 24,
        },
      ),
    [
      nearbyFoodBusinesses,
      scoutSearchIntent,
      scoutSearchMode,
      scoutSearchQuery,
    ],
  );
  const allDealsForFeed = useMemo(
    () =>
      canonicalizeScoutRows(
        filterScoutSearchRows(
          allDeals,
          scoutSearchMode,
          scoutSearchQuery,
          scoutSearchIntent,
          "deal",
        ),
        {
          kind: "deal",
          scope: "nearby",
          source: "deal",
          query: scoutSearchMode ? scoutSearchQuery : undefined,
        },
      ),
    [allDeals, scoutSearchIntent, scoutSearchMode, scoutSearchQuery],
  );
  const visibleEventsForFeed = useMemo(
    () =>
      canonicalizeScoutRows(
        filterScoutSearchRows(
          visibleEvents,
          scoutSearchMode,
          scoutSearchQuery,
          scoutSearchIntent,
          "event",
        ),
        {
          kind: "event",
          scope: "nearby",
          source: "event",
          query: scoutSearchMode ? scoutSearchQuery : undefined,
        },
      ),
    [scoutSearchIntent, scoutSearchMode, scoutSearchQuery, visibleEvents],
  );
  const localMenuItemsForFeed = useMemo(
    () =>
      canonicalizeScoutRows(
        filterScoutSearchRows(
          localMenuItems,
          scoutSearchMode,
          scoutSearchQuery,
          scoutSearchIntent,
          "menu_item",
        ),
        {
          kind: "dish",
          scope: "nearby",
          source: "menu",
          query: scoutSearchMode ? scoutSearchQuery : undefined,
        },
      ),
    [localMenuItems, scoutSearchIntent, scoutSearchMode, scoutSearchQuery],
  );
  const popularDishesForFeed = useMemo(
    () =>
      canonicalizeScoutRows(
        filterScoutSearchRows(
          popularDishes,
          scoutSearchMode,
          scoutSearchQuery,
          scoutSearchIntent,
          "menu_item",
        ),
        {
          kind: "dish",
          scope: "nearby",
          source: "trending",
          query: scoutSearchMode ? scoutSearchQuery : undefined,
        },
      ),
    [popularDishes, scoutSearchIntent, scoutSearchMode, scoutSearchQuery],
  );
  const trendingPlacesThisWeekForFeed = useMemo(
    () =>
      canonicalizeScoutRows(
        filterScoutSearchRows(
          trendingPlacesThisWeek,
          scoutSearchMode,
          scoutSearchQuery,
          scoutSearchIntent,
          "restaurant",
        ),
        {
          kind: "business",
          scope: "nearby",
          source: "trending",
          query: scoutSearchMode ? scoutSearchQuery : undefined,
        },
      ),
    [
      scoutSearchIntent,
      scoutSearchMode,
      scoutSearchQuery,
      trendingPlacesThisWeek,
    ],
  );
  const newToMealScoutRestaurantsForFeed = useMemo(
    () =>
      canonicalizeScoutRows(
        filterScoutSearchRows(
          newToMealScoutRestaurants,
          scoutSearchMode,
          scoutSearchQuery,
          scoutSearchIntent,
          "restaurant",
        ),
        {
          kind: "business",
          scope: "nearby",
          source: "local_inventory",
          query: scoutSearchMode ? scoutSearchQuery : undefined,
        },
      ),
    [
      newToMealScoutRestaurants,
      scoutSearchIntent,
      scoutSearchMode,
      scoutSearchQuery,
    ],
  );
  const activeMarketPlaces = useMemo<RestaurantSummary[]>(() => {
    const rows = [
      ...(Array.isArray(globalSearchData?.restaurants)
        ? globalSearchData.restaurants
        : []),
      ...(Array.isArray(trendingData?.places) ? trendingData.places : []),
    ];
    return canonicalizeScoutRows(rows, {
      kind: "business",
      scope: "network",
      source: "network_search",
      query: scoutSearchMode ? scoutSearchQuery : undefined,
    });
  }, [
    globalSearchData?.restaurants,
    scoutSearchMode,
    scoutSearchQuery,
    trendingData?.places,
  ]);

  const activeMarketDishes = useMemo(
    () =>
      canonicalizeScoutRows(
        Array.isArray(trendingData?.items) ? trendingData.items : [],
        {
          kind: "dish",
          scope: "network",
          source: "trending",
          query: scoutSearchMode ? scoutSearchQuery : undefined,
        },
      ),
    [
      scoutSearchMode,
      scoutSearchQuery,
      trendingData?.items,
    ],
  );

  const activityFallbackRestaurants = useMemo(
    () =>
      canonicalizeScoutRows(
        filterScoutFallbackRows(
          activeMarketPlaces,
          scoutSearchMode,
          scoutSearchQuery,
          scoutSearchIntent,
          "restaurant",
        ),
        {
          kind: "business",
          scope: "network",
          source: "network_search",
          query: scoutSearchMode ? scoutSearchQuery : undefined,
          limit: 8,
        },
      ),
    [
      activeMarketPlaces,
      scoutSearchIntent,
      scoutSearchMode,
      scoutSearchQuery,
    ],
  );

  // Rotating-spot fillers render under local section headings (the empty
  // "Open Now Near You" row becomes "Places to Try"), so a network candidate
  // may only fill a local row when it actually sits inside the viewer's
  // discovery area. Before this filter the pool was platform-wide trending
  // and search results with no distance check, which put a Kingston, PA
  // business on the Pensacola market page.
  const localNetworkRotatingSpotCandidates = useMemo(() => {
    if (!resolvedScoutCoords) return [];
    const radiusMiles = discoveryRadiusKm / 1.60934;
    return activityFallbackRestaurants.filter((restaurant) => {
      const lat = readNumberField(restaurant, ["latitude", "lat"]);
      const lng = readNumberField(restaurant, ["longitude", "lng"]);
      if (lat === null || lng === null) return false;
      return getDistanceMiles(resolvedScoutCoords, { lat, lng }) <= radiusMiles;
    });
  }, [activityFallbackRestaurants, discoveryRadiusKm, resolvedScoutCoords]);

  const activityFallbackDishes = useMemo(
    () =>
      canonicalizeScoutRows(
        filterScoutFallbackRows(
          activeMarketDishes,
          scoutSearchMode,
          scoutSearchQuery,
          scoutSearchIntent,
          "menu_item",
        ),
        {
          kind: "dish",
          scope: "network",
          source: "trending",
          query: scoutSearchMode ? scoutSearchQuery : undefined,
          limit: 8,
        },
      ),
    [
      activeMarketDishes,
      scoutSearchIntent,
      scoutSearchMode,
      scoutSearchQuery,
    ],
  );

  const activitySupplementRestaurants = useMemo(() => {
    const localBusinessIds = new Set(
      nearbyFoodBusinesses.map((restaurant) => String(restaurant.id)),
    );
    return activityFallbackRestaurants.filter(
      (restaurant) => !localBusinessIds.has(String(restaurant.id)),
    );
  }, [activityFallbackRestaurants, nearbyFoodBusinesses]);

  const activitySupplementDishes = useMemo(() => {
    const localDishIds = new Set(
      [...localMenuItemsForFeed, ...popularDishesForFeed].map((item) =>
        String(item.id),
      ),
    );
    return activityFallbackDishes.filter(
      (item) => !localDishIds.has(String(item.id)),
    );
  }, [activityFallbackDishes, localMenuItemsForFeed, popularDishesForFeed]);

  const trucksServingNow = useMemo(
    () => scoutTruckInventoryForFeed.filter(isTruckServingNow),
    [scoutTruckInventoryForFeed],
  );
  const restaurantsOpenNow = useMemo(
    () =>
      nearbyRestaurantsForFeed.filter(
        (restaurant) => getRestaurantOpenState(restaurant) === "open",
      ),
    [nearbyRestaurantsForFeed],
  );
  const moreFoodRestaurants = useMemo(
    () =>
      nearbyRestaurantsForFeed.filter(
        (restaurant) => getRestaurantOpenState(restaurant) !== "open",
      ),
    [nearbyRestaurantsForFeed],
  );

  const showFoodTrucksSection =
    liveTrucksLoading || trucksServingNow.length > 0;
  const showRestaurantsSection =
    nearbyRestaurantsLoading || restaurantsOpenNow.length > 0;
  const showDealsSection = allDeals.length > 0;
  const showEventsSection = visibleEvents.length > 0 || visibleHosts.length > 0;
  const sceneWantsCommunity =
    activeSceneLaneId === "community" || activeSceneLaneId === "for_you";
  const sceneWantsNearbyNow =
    activeSceneLaneId === "nearby_now" || activeSceneLaneId === "for_you";
  const sceneWantsFoodTrucks =
    activeSceneLaneId === "food_trucks" || activeSceneLaneId === "for_you";
  const sceneWantsRestaurants =
    activeSceneLaneId === "restaurants" ||
    activeSceneLaneId === "for_you" ||
    activeSceneLaneId === "nearby_now";
  const sceneWantsDeals =
    activeSceneLaneId === "deals" || activeSceneLaneId === "for_you";
  const sceneWantsEvents =
    activeSceneLaneId === "events" ||
    activeSceneLaneId === "for_you" ||
    activeSceneLaneId === "late_night";
  const sceneWantsNewMenus =
    activeSceneLaneId === "new_menus" || activeSceneLaneId === "for_you";
  const sceneWantsWorthDiscovering =
    activeSceneLaneId === "worth_discovering" ||
    activeSceneLaneId === "for_you" ||
    activeSceneLaneId === "new_menus";
  const localActivityCount =
    scoutTruckInventoryForFeed.length +
    localMenuItemsForFeed.length +
    nearbyRestaurantsForFeed.length +
    allDealsForFeed.length +
    visibleEventsForFeed.length +
    visibleHosts.length;
  const localSearchContentCount =
    scoutTruckInventoryForFeed.length +
    localMenuItemsForFeed.length +
    nearbyRestaurantsForFeed.length +
    allDealsForFeed.length +
    visibleEventsForFeed.length +
    popularDishesForFeed.length +
    trendingPlacesThisWeekForFeed.length +
    newToMealScoutRestaurantsForFeed.length;
  const localDiscoverySettled =
    !liveTrucksLoading &&
    !nearbyRestaurantsLoading &&
    !nearbyPublicRestaurantsLoading &&
    !localMenuItemsLoading &&
    !nearbyDealsLoading &&
    !eventsLoading;
  const activityFallbackSettled =
    !trendingLoading && !globalSearchLoading;
  const showActivityFallback =
    localDiscoverySettled &&
    activityFallbackSettled &&
    (scoutSearchQuery.trim().length > 0
      ? scoutSearchMode && localSearchContentCount === 0
      : localActivityCount === 0 &&
        popularDishesForFeed.length === 0 &&
        trendingPlacesThisWeekForFeed.length === 0);
  const effectiveRestaurantsForFeed = showActivityFallback
    ? activityFallbackRestaurants
    : nearbyRestaurantsForFeed;
  const effectivePopularDishesForFeed = showActivityFallback
    ? activityFallbackDishes
    : popularDishesForFeed;
  const effectiveTrendingPlacesForFeed = showActivityFallback
    ? []
    : trendingPlacesThisWeekForFeed;
  const fallbackHasRelatedResults =
    activityFallbackRestaurants.length > 0 ||
    activityFallbackDishes.length > 0;
  const supplementHasResults =
    activitySupplementRestaurants.length > 0 ||
    activitySupplementDishes.length > 0;
  const showActivitySupplement =
    localDiscoverySettled &&
    activityFallbackSettled &&
    scoutSearchQuery.trim().length === 0 &&
    localSearchContentCount > 0 &&
    localSearchContentCount <= 1 &&
    supplementHasResults;
  const nearbyRestaurantsTitle = DISCOVERY_LAYERS.restaurants.title;
  const nearbyRestaurantsSubtitle = DISCOVERY_LAYERS.restaurants.subtitle;

  const selectedCraving = useMemo(() => {
    return (
      SCOUT_SEARCH_OPTIONS.find((cat) => cat.id === selectedCravingId) ??
      SCOUT_SEARCH_OPTIONS[0]
    );
  }, [selectedCravingId]);
  const handleSceneLaneChange = useCallback((laneId: ScoutSceneLaneId) => {
    setActiveSceneLaneId(laneId);
    const lane = SCOUT_SCENE_LANES.find((entry) => entry.id === laneId);
    if (lane) {
      setSelectedCravingId(lane.cravingId);
    }
  }, []);

  const cravingBoardItems = useMemo(
    () =>
      buildCravingBoardItems({
        craving: selectedCraving,
        liveTrucks: trucksServingNow,
        restaurants: restaurantsOpenNow,
        menuItems: localMenuItemsForFeed,
        deals: allDealsForFeed,
        events: visibleEventsForFeed,
      }),
    [
      allDealsForFeed,
      localMenuItemsForFeed,
      restaurantsOpenNow,
      selectedCraving,
      trucksServingNow,
      visibleEventsForFeed,
    ],
  );
  const sceneMixedFeedItems = useMemo(() => {
    const items = cravingBoardItems;
    if (activeSceneLaneId === "for_you") {
      const pickByKind = (kind: CravingBoardItem["kind"]) =>
        items.find((item) => item.kind === kind) || null;
      const picks: CravingBoardItem[] = [];
      const add = (candidate: CravingBoardItem | null) => {
        if (!candidate) return;
        if (picks.some((entry) => entry.id === candidate.id)) return;
        picks.push(candidate);
      };
      // Balanced first-screen mix: trucks, places, menu, deal, event, and discovery.
      add(pickByKind("Truck"));
      add(pickByKind("Place"));
      add(pickByKind("Menu"));
      add(pickByKind("Deal"));
      add(pickByKind("Event"));
      const discoveryPlace = items.find(
        (item) =>
          item.kind === "Place" &&
          /new|under|fresh|updated|quiet/i.test(String(item.reason || "")),
      );
      add(discoveryPlace || null);
      if (picks.length < 7) {
        for (const candidate of items) {
          add(candidate);
          if (picks.length >= 7) break;
        }
      }
      return picks.slice(0, 7);
    }
    if (activeSceneLaneId === "food_trucks") {
      return items.filter((item) => item.kind === "Truck").slice(0, 7);
    }
    if (activeSceneLaneId === "restaurants") {
      return items
        .filter((item) => item.kind === "Place" || item.kind === "Menu")
        .slice(0, 7);
    }
    if (activeSceneLaneId === "deals") {
      return items
        .filter((item) => item.kind === "Deal" || item.kind === "Place")
        .slice(0, 7);
    }
    if (activeSceneLaneId === "events") {
      return items
        .filter((item) => item.kind === "Event" || item.kind === "Place")
        .slice(0, 7);
    }
    if (activeSceneLaneId === "new_menus") {
      return items
        .filter((item) => item.kind === "Menu" || item.kind === "Place")
        .slice(0, 7);
    }
    if (activeSceneLaneId === "worth_discovering") {
      return items
        .filter((item) => item.kind === "Place" || item.kind === "Truck")
        .slice(0, 7);
    }
    return items.slice(0, 7);
  }, [activeSceneLaneId, cravingBoardItems]);
  const spatialDecisionItems = useMemo(
    () =>
      sceneMixedFeedItems
        .map((item) => ({
          item,
          marker: getDecisionMarker(item, sceneFilteredMapMarkers),
        }))
        .filter(
          (
            entry,
          ): entry is { item: CravingBoardItem; marker: MapAdapterMarker } =>
            Boolean(entry.marker),
        )
        .slice(0, 6),
    [sceneFilteredMapMarkers, sceneMixedFeedItems],
  );
  const compactDecisionMarkers = useMemo(
    () => spatialDecisionItems.map(({ marker }) => marker),
    [spatialDecisionItems],
  );
  useEffect(() => {
    if (sheetState === "fullMap") return;
    if (spatialDecisionItems.length === 0) {
      setSelectedMarkerId(null);
      return;
    }
    if (
      !selectedMarkerId ||
      !spatialDecisionItems.some(
        ({ marker }) => marker.id === selectedMarkerId,
      )
    ) {
      setSelectedMarkerId(spatialDecisionItems[0].marker.id);
    }
  }, [selectedMarkerId, sheetState, spatialDecisionItems]);
  const selectSpatialDecision = useCallback(
    (marker: MapAdapterMarker) => {
      setSelectedMarkerId(marker.id);
      setMapCenter({ lat: marker.lat, lng: marker.lng });
      setMapZoom((current) => Math.max(current, 15));
      if (marker.kind === "truck") {
        setSelectedLiveTruck(
          liveTruckById.get(String(marker.sourceId)) || null,
        );
        setSelectedMapMarker(null);
      } else {
        setSelectedLiveTruck(null);
        setSelectedMapMarker(marker);
      }
    },
    [liveTruckById],
  );
  const featuredRestaurantIds = useMemo(
    () =>
      new Set(
        sceneMixedFeedItems
          .map((item) => item.restaurantId)
          .filter((id): id is string => Boolean(id)),
      ),
    [sceneMixedFeedItems],
  );
  const featuredTruckIds = useMemo(
    () =>
      new Set(
        sceneMixedFeedItems
          .map((item) => item.truckId)
          .filter((id): id is string => Boolean(id)),
      ),
    [sceneMixedFeedItems],
  );
  const featuredDealIds = useMemo(
    () =>
      new Set(
        sceneMixedFeedItems
          .map((item) => item.dealId)
          .filter((id): id is string => Boolean(id)),
      ),
    [sceneMixedFeedItems],
  );
  const featuredEventIds = useMemo(
    () =>
      new Set(
        sceneMixedFeedItems
          .filter((item) => item.kind === "Event")
          .map((item) => item.id.replace(/^event-/, ""))
          .filter(Boolean),
      ),
    [sceneMixedFeedItems],
  );

  const localActivityItems = useMemo(
    () =>
      buildLocalActivityItems({
        menuItems: localMenuItemsForFeed,
        deals: allDealsForFeed,
        liveTrucks: trucksServingNow,
        events: visibleEventsForFeed,
        hosts: visibleHosts,
        restaurants: restaurantsOpenNow,
      }),
    [
      allDealsForFeed,
      localMenuItemsForFeed,
      restaurantsOpenNow,
      trucksServingNow,
      visibleEventsForFeed,
      visibleHosts,
    ],
  );
  const scoutActivityMode = useMemo(
    () =>
      getScoutActivityMode({
        servingTruckCount: trucksServingNow.length,
        openRestaurantCount: restaurantsOpenNow.length,
        dealCount: allDealsForFeed.length,
        eventCount: visibleEventsForFeed.length + visibleHosts.length,
        menuUpdateCount: localMenuItemsForFeed.length,
        activityItemCount: localActivityItems.length,
        mapMarkerCount: sceneFilteredMapMarkers.filter(
          (marker) => marker.kind !== "user",
        ).length,
      }),
    [
      allDealsForFeed.length,
      sceneFilteredMapMarkers,
      localActivityItems.length,
      localMenuItemsForFeed.length,
      restaurantsOpenNow.length,
      trucksServingNow.length,
      visibleEventsForFeed.length,
      visibleHosts.length,
    ],
  );
  useEffect(() => {
    if (!showScoutPreviewDebug) return;
    console.info("[scout-preview-counts]", {
      ...scoutDebugCounts,
      visibleScenePins: sceneFilteredMapMarkers.length,
      statuses: scoutSourceStatuses,
    });
  }, [
    sceneFilteredMapMarkers.length,
    scoutDebugCounts,
    scoutSourceStatuses,
    showScoutPreviewDebug,
  ]);
  useEffect(() => {
    if (!showScoutPreviewDebug) return;
    const dropped = {
      trucks: scoutDebugCounts.trucksMissingCoords,
      restaurants: scoutDebugCounts.restaurantsMissingCoords,
      hosts: scoutDebugCounts.hostsMissingCoords,
      events: scoutDebugCounts.eventsMissingCoords,
      deals: scoutDebugCounts.dealsMissingCoords,
    };
    const hasDrops = Object.values(dropped).some((count) => count > 0);
    if (hasDrops) {
      console.warn("[scout-preview-dropped-missing-coords]", dropped);
    }
  }, [scoutDebugCounts, sceneFilteredMapMarkers.length, showScoutPreviewDebug]);
  const visibleLocalActivityItems = useMemo(() => {
    const uniqueKeys = new Set<string>();
    const uniqueItems = localActivityItems.filter((item) => {
      const key =
        getRestaurantIdFromActivity(item) || `${item.type}-${item.entityId}`;
      if (uniqueKeys.has(key)) return false;
      uniqueKeys.add(key);
      return true;
    });
    return uniqueItems.length >= 2 && scoutActivityMode !== "low_activity"
      ? uniqueItems
      : [];
  }, [localActivityItems, scoutActivityMode]);
  const localActivityRestaurantIds = useMemo(() => {
    return new Set(
      visibleLocalActivityItems
        .map(getRestaurantIdFromActivity)
        .filter((id): id is string => Boolean(id)),
    );
  }, [visibleLocalActivityItems]);
  const visibleOpenRestaurants = useMemo(() => {
    return restaurantsOpenNow.filter(
      (restaurant) => !localActivityRestaurantIds.has(String(restaurant.id)),
    );
  }, [localActivityRestaurantIds, restaurantsOpenNow]);
  const visibleTrucksServingNow = useMemo(() => {
    return trucksServingNow;
  }, [trucksServingNow]);
  const visibleDeals = useMemo(() => {
    return allDealsForFeed;
  }, [allDealsForFeed]);
  const hotDealCandidates = useMemo(() => {
    const happyHourIds = new Set(happyHourDeals.map((deal) => deal.id));
    return visibleDeals.filter((deal) => !happyHourIds.has(deal.id));
  }, [happyHourDeals, visibleDeals]);
  const visibleSceneEvents = useMemo(() => {
    return visibleEventsForFeed;
  }, [visibleEventsForFeed]);
  const topLocalFavoriteRestaurants = useMemo(
    () =>
      nearbyRestaurants
        .map((restaurant) => ({
          restaurant,
          score: getRestaurantCommunityScore(restaurant),
        }))
        .filter(({ score }) => score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            (a.restaurant.distanceMiles ?? a.restaurant.distance ?? 999) -
              (b.restaurant.distanceMiles ?? b.restaurant.distance ?? 999),
        )
        .map(({ restaurant }) => restaurant),
    [nearbyRestaurants],
  );
  const topLocalFavoriteIds = useMemo(
    () =>
      new Set(
        topLocalFavoriteRestaurants.map((restaurant) => String(restaurant.id)),
      ),
    [topLocalFavoriteRestaurants],
  );
  const isHighActivity = scoutActivityMode === "high_activity";
  const isMediumActivity = scoutActivityMode === "medium_activity";
  const isLowActivity = scoutActivityMode === "low_activity";
  const visibleMoreFoodRestaurants = useMemo(() => {
    if (!isLowActivity) return moreFoodRestaurants;
    return moreFoodRestaurants.filter(
      (restaurant) => !topLocalFavoriteIds.has(String(restaurant.id)),
    );
  }, [isLowActivity, moreFoodRestaurants, topLocalFavoriteIds]);
  const openingLaterRestaurants = useMemo(
    () =>
      visibleMoreFoodRestaurants.filter(
        (restaurant) => getRestaurantOpenState(restaurant) === "closed",
      ),
    [visibleMoreFoodRestaurants],
  );
  const showMoreFoodSection = visibleMoreFoodRestaurants.length > 0;
  const showTopLocalFavoritesSection =
    (isLowActivity || activeSceneLaneId === "community") &&
    topLocalFavoriteRestaurants.length > 0;
  const isThinScoutViewport = isLowActivity && localActivityCount <= 1;
  const compactMapHeight = isThinScoutViewport
    ? "clamp(170px, 25dvh, 220px)"
    : "clamp(180px, 25dvh, 230px)";
  const collapsedMapClass =
    "mx-0 mt-0 bg-[var(--bg-surface)] md:mt-4 md:ring-1 md:ring-[color:var(--border-subtle)]";
  const railSectionClass = isHighActivity
    ? "pl-4 pr-0 pt-1 pb-4"
    : "pl-4 pr-0 pt-2 pb-4 sm:pl-5";
  const compactRailSectionClass = isHighActivity
    ? "pl-4 pr-0 pt-0 pb-3"
    : "pl-4 pr-0 pt-1 pb-4 sm:pl-5";
  const truckCardWidth = isHighActivity
    ? "w-[176px] sm:w-[198px]"
    : "w-[188px] sm:w-[212px]";
  const standardCardWidth = isHighActivity
    ? "w-[168px] sm:w-[186px]"
    : "w-[176px] sm:w-[196px]";
  const featureCardWidth = isHighActivity
    ? "w-[182px] sm:w-[204px]"
    : "w-[194px] sm:w-[216px]";
  const restaurantsRailTitle = isMediumActivity
    ? "Open Near You"
    : nearbyRestaurantsTitle;
  const restaurantsRailSubtitle = isMediumActivity
    ? "Open restaurants and local places nearby."
    : nearbyRestaurantsSubtitle;
  const eventsRailTitle = isHighActivity
    ? DISCOVERY_LAYERS.events.title
    : "Upcoming Food Events";
  const eventsRailSubtitle = isHighActivity
    ? DISCOVERY_LAYERS.events.subtitle
    : "Food events and pop-ups coming up nearby.";
  const moreRailTitle = isLowActivity ? "Worth Checking Out" : "More Nearby";
  const moreRailSubtitle = isLowActivity
    ? "Local places and food options around you."
    : "Nearby trucks and restaurants without current open status.";
  const laneFoodTrucksTitle =
    activeSceneLaneId === "food_trucks"
      ? "Food Trucks Today"
      : DISCOVERY_LAYERS.foodTrucks.title;
  const laneRestaurantsTitle =
    activeSceneLaneId === "restaurants"
      ? "Nearby Restaurants"
      : restaurantsRailTitle;
  const laneDealsTitle =
    activeSceneLaneId === "deals" ? "Hot Deals" : DISCOVERY_LAYERS.deals.title;
  const laneEventsTitle =
    activeSceneLaneId === "events" ? "Events & Pop-Ups" : eventsRailTitle;
  const laneMoreTitle =
    activeSceneLaneId === "worth_discovering"
      ? "Worth Discovering"
      : moreRailTitle;
  const showQuickUpdateBarForLane =
    showQuickUpdateBar &&
    (activeSceneLaneId === "for_you" ||
      activeSceneLaneId === "food_trucks" ||
      activeSceneLaneId === "restaurants" ||
      activeSceneLaneId === "deals");
  const compactMapSceneHint =
    activeSceneLaneId === "food_trucks"
      ? "Truck activity nearby"
      : activeSceneLaneId === "restaurants"
        ? "Open restaurants nearby"
        : activeSceneLaneId === "deals"
          ? "Active deals nearby"
          : activeSceneLaneId === "events"
            ? "Food events nearby"
            : activeSceneLaneId === "new_menus"
              ? "Fresh menu updates nearby"
              : activeSceneLaneId === "worth_discovering"
                ? "New and lesser-known spots nearby"
                : "Find trucks, bowls, pop-ups, and local favorites near you.";
  const compactMapMarketHint =
    trucksServingNow.length > 0
      ? `${scoutMarketEyebrow} • ${formatScoutCount(
          trucksServingNow.length,
          "truck nearby now",
          "trucks nearby now",
        )}`
      : scoutMarketEyebrow;
  const laneHasContent =
    sceneMixedFeedItems.length > 0 ||
    (sceneWantsFoodTrucks && visibleTrucksServingNow.length > 0) ||
    (sceneWantsRestaurants && visibleOpenRestaurants.length > 0) ||
    (sceneWantsDeals && visibleDeals.length > 0) ||
    (sceneWantsEvents &&
      (visibleSceneEvents.length > 0 || visibleHosts.length > 0)) ||
    (sceneWantsNewMenus && localMenuItems.length > 0) ||
    (sceneWantsWorthDiscovering && visibleMoreFoodRestaurants.length > 0) ||
    (sceneWantsCommunity && topLocalFavoriteRestaurants.length > 0);
  const discoveryReadFailures = [
    ...(liveTrucksError ? ["truck listings"] : []),
    ...(subscribedRestaurantsError ? ["featured restaurants"] : []),
    ...(nearbyPublicRestaurantsError ? ["nearby restaurants"] : []),
  ];
  const discoveryLoading = liveTrucksLoading || nearbyRestaurantsLoading || nearbyPublicRestaurantsLoading;
  const discoveryRetrying = liveTrucksFetching || subscribedRestaurantsFetching || nearbyPublicRestaurantsFetching;
  const readIncomplete = discoveryReadFailures.length > 0 || discoveryLoading;
  const retryDiscovery = () => {
    if (liveTrucksError) void retryLiveTrucks();
    if (subscribedRestaurantsError) void retrySubscribedRestaurants();
    if (nearbyPublicRestaurantsError) void retryNearbyPublicRestaurants();
  };
  const showForYouWorthFallback =
    activeSceneLaneId === "for_you" &&
    sceneMixedFeedItems.length === 0 &&
    visibleMoreFoodRestaurants.length > 0;
  return (
    <>
      <SEOHead
        title="Scout Local Food Discovery | MealScout"
        description="Discover food trucks, restaurants, dishes, events, and local food deals near you with MealScout."
      />

      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-20"
        style={{ background: "var(--bg-layered)" }}
      />

      <main
        className={`relative z-10 overflow-x-hidden ${
          sheetState === "fullMap"
            ? ""
            : "pb-[calc(7rem+env(safe-area-inset-bottom,0px))] md:mx-auto md:max-w-[1120px] md:px-4 md:pb-8 xl:max-w-[1280px]"
        }`}
      >
        {/* ============================================================
             SCOUT SURFACE
             Default: compact map accessory.
             Full map: interactive Google Map fills the viewport.
           ============================================================ */}
        <ScoutMapHero>
          <section
            data-testid="scout-map-container"
            data-scout-mobile-thirds-map="true"
            onTouchStart={handleSheetTouchStart}
            onTouchMove={handleSheetTouchMove}
            onTouchEnd={handleSheetTouchEnd}
            onMouseDown={handleSheetMouseDown}
            onMouseMove={handleSheetMouseMove}
            onMouseUp={handleSheetMouseUp}
            onMouseLeave={handleSheetMouseUp}
            className={`relative overflow-hidden ${
              sheetState === "fullMap"
                ? "w-full bg-[var(--bg-surface)]"
                : collapsedMapClass
            }`}
            style={{
              height: sheetState === "fullMap" ? "100dvh" : compactMapHeight,
              transition: "height 320ms cubic-bezier(0.22,0.61,0.36,1)",
              touchAction: "auto",
              boxShadow:
                sheetState === "fullMap"
                  ? undefined
                  : "0 14px 34px rgba(0,0,0,0.34)",
            }}
          >
            {/* Scout map surfaces
              ------------------
              DEFAULT state: deterministic compact MapLibre decision surface.
              FULLMAP state: interactive Google Map widget for real
                pan/zoom/tap-pin exploration.
          */}
            <div className="absolute inset-0">
              <div
                data-testid="scout-map-preview"
                className="absolute inset-0"
                style={{
                  visibility: sheetState === "fullMap" ? "hidden" : "visible",
                  pointerEvents: sheetState === "fullMap" ? "none" : "auto",
                  zIndex: 0,
                }}
              >
                {sheetState === "default" && resolvedScoutCoords ? (
                  <Suspense fallback={<HeroMapFallback reason="loading" />}>
                    <ThemedScoutMap
                      userLocation={resolvedScoutCoords}
                      showUserLocation={Boolean(verifiedMapUserLocation)}
                      markers={compactDecisionMarkers}
                      selectedMarkerId={selectedMarkerId}
                      zoom={13}
                      onMarkerTap={handlePreviewMarkerTap}
                    />
                  </Suspense>
                ) : sheetState === "default" ? (
                  <HeroMapFallback
                    reason={locationStatus === "denied" ? "denied" : "loading"}
                  />
                ) : null}
              </div>

              {/* GoogleMapSurface:
                - Reserved for full interactive exploration.
                - The compact decision surface always uses local MapLibre.
            */}
              {sheetState === "fullMap" &&
              hasMapKey &&
              !googleMapFailed &&
              resolvedScoutCoords &&
              mapCenter ? (
                <div
                  ref={googleMapContainerRef}
                  data-testid="scout-interactive-map"
                  className="absolute inset-0"
                  style={{
                    visibility: "visible",
                    pointerEvents: sheetState === "fullMap" ? "auto" : "none",
                    zIndex: 1,
                  }}
                >
                  <MapErrorBoundary>
                    <GoogleMapSurface
                      apiKey={effectiveGoogleMapsApiKey}
                      mapId={effectiveGoogleMapsMapId || undefined}
                      center={mapCenter}
                      zoom={mapZoom}
                      markers={sceneFilteredMapMarkers}
                      selectedMarkerId={selectedMarkerId}
                      showRoadTrafficLayer={false}
                      userLocation={verifiedMapUserLocation}
                      isNightTheme={true}
                      useNativeMapStyle={false}
                      showZoomControls={true}
                      zoomControlsPosition="below-header"
                      onBoundsChanged={handleMapBoundsChanged}
                      onZoomChanged={handleMapZoomChanged}
                      onCenterChanged={handleMapCenterChanged}
                      onMarkerTap={handleMarkerTap}
                      onFatalError={() => setGoogleMapFailed(true)}
                    />
                  </MapErrorBoundary>
                </div>
              ) : sheetState === "fullMap" &&
                (googleMapFailed ||
                  !hasMapKey ||
                  !resolvedScoutCoords ||
                  !mapCenter) ? (
                <div
                  data-testid="scout-interactive-map"
                  className="absolute inset-0"
                  style={{ zIndex: 1 }}
                >
                  {resolvedScoutCoords ? (
                    <>
                      <Suspense fallback={<HeroMapFallback reason="loading" />}>
                        <ThemedScoutMap
                          userLocation={resolvedScoutCoords}
                          showUserLocation={Boolean(verifiedMapUserLocation)}
                          markers={sceneFilteredMapMarkers}
                          selectedMarkerId={selectedMarkerId}
                          zoom={13}
                          interactive={true}
                          onMarkerTap={handlePreviewMarkerTap}
                        />
                      </Suspense>
                      {(!hasMapKey || googleMapFailed) && (
                        <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 max-w-[18rem] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-[#211710]/92 px-5 py-4 text-center text-sm font-bold text-orange-50 ring-1 ring-white/12 backdrop-blur-xl">
                          Full pan and zoom are loading. You can still browse
                          nearby food.
                        </div>
                      )}
                    </>
                  ) : (
                    <HeroMapFallback
                      reason={
                        locationStatus === "denied" ? "denied" : "loading"
                      }
                    />
                  )}
                </div>
              ) : null}
            </div>

            {sheetState === "fullMap" && (
              <MapLayerToggles
                layers={activeMapLayers}
                onToggle={toggleMapLayer}
              />
            )}

            {/* Floating "Collapse" button (top-right) — visible in fullMap state. */}
            {sheetState === "fullMap" && (
              <button
                type="button"
                onClick={collapseScoutMap}
                aria-label="Collapse map and return to discover"
                className="absolute z-30 right-4 top-[calc(env(safe-area-inset-top)+0.75rem)] inline-flex h-12 items-center gap-2 rounded-full bg-[#1b120d]/92 px-4 font-black text-orange-50 ring-1 ring-white/14 backdrop-blur-md transition-colors hover:bg-[#2a1b13]"
                style={{
                  boxShadow: "0 12px 30px rgba(154,72,18,0.18)",
                }}
              >
                <Minimize2 className="h-4 w-4" aria-hidden="true" />
                <span className="text-sm">Collapse</span>
              </button>
            )}

            {sheetState === "fullMap" && (
              <ScoutMapHud
                locationLabel={shortLocation}
                marketEyebrow={scoutMarketEyebrow}
                pinCount={sceneMapMarkerCounts.pinCount}
                liveTruckCount={sceneMapMarkerCounts.liveTruckCount}
                restaurantCount={sceneMapMarkerCounts.restaurantCount}
                eventCount={sceneMapMarkerCounts.eventCount}
                dealCount={sceneMapMarkerCounts.dealCount}
                discoveryRadiusKm={discoveryRadiusKm}
                onRadiusChange={updateDiscoveryRadiusKm}
                onRecenter={() => {
                  if (resolvedScoutCoords) {
                    setMapCenter(resolvedScoutCoords);
                    setMapZoom(14);
                  }
                }}
              />
            )}

            {sheetState === "fullMap" && selectedLiveTruck && (
              <LiveTruckMapCard
                truck={selectedLiveTruck}
                userLocation={resolvedScoutCoords}
                onClose={() => setSelectedLiveTruck(null)}
              />
            )}

            {sheetState === "fullMap" && selectedMapMarker && (
              <MapPlaceCard
                marker={selectedMapMarker}
                userLocation={resolvedScoutCoords}
                onClose={() => setSelectedMapMarker(null)}
              />
            )}

            {sheetState === "fullMap" && mapBounds && (
              <MapEdgeIndicators
                markers={sceneFilteredMapMarkers}
                bounds={mapBounds}
                center={mapCenter || resolvedScoutCoords}
                selectedId={
                  selectedLiveTruck
                    ? String(selectedLiveTruck.id)
                    : selectedMapMarker?.id || null
                }
                onSelect={(marker) => {
                  setMapCenter({ lat: marker.lat, lng: marker.lng });
                  setMapZoom(Math.max(mapZoom, 15));
                  if (marker.kind === "truck") {
                    const truck = liveTruckById.get(String(marker.sourceId));
                    if (truck) setSelectedLiveTruck(truck);
                  } else {
                    setSelectedLiveTruck(null);
                    setSelectedMapMarker(marker);
                  }
                }}
              />
            )}

            {/* Compact map overlay — matches visual mockup */}
            {sheetState === "default" && (
              <>
                {/* Map context, not a duplicate app header. */}
                <div className="absolute left-3 top-3 z-20 flex items-center gap-2">
                  <span className="inline-flex max-w-[15rem] items-center gap-1.5 rounded-full bg-[var(--bg-popup)] px-2.5 py-1.5 text-[11px] font-black text-[color:var(--text-primary)] ring-1 ring-[color:var(--border-subtle)] backdrop-blur-xl shadow-[0_8px_20px_rgba(0,0,0,0.14)]">
                    <MapPin className="h-3.5 w-3.5 shrink-0 text-[color:var(--action-primary)]" aria-hidden="true" />
                    <span className="truncate">{compactMapMarketHint}</span>
                  </span>
                </div>

                {/* Top-right: recenter (sits below the map's own "Live" badge so the two don't overlap) */}
                <button
                  type="button"
                  onClick={() => {
                    if (resolvedScoutCoords) {
                      setMapCenter(resolvedScoutCoords);
                      setMapZoom(14);
                    }
                  }}
                  aria-label="Recenter map"
                  className="absolute right-3 top-3 z-20 inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--bg-popup)] ring-1 ring-[color:var(--border-subtle)] backdrop-blur-xl shadow-[0_8px_20px_rgba(0,0,0,0.14)]"
                >
                  <Navigation2
                    className="h-4 w-4 text-[color:var(--text-primary)]"
                    aria-hidden="true"
                  />
                </button>

                <button
                  type="button"
                  onClick={openScoutMap}
                  aria-label="Expand map"
                  className="absolute right-3 top-14 z-20 inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--action-primary)] text-[color:var(--action-primary-text)] ring-1 ring-white/70 backdrop-blur-xl shadow-[0_8px_20px_rgba(0,0,0,0.18)]"
                >
                  <Maximize2 className="h-4 w-4" aria-hidden="true" />
                </button>

                <SpatialDecisionRail
                  decisions={spatialDecisionItems}
                  selectedMarkerId={selectedMarkerId}
                  onSelect={selectSpatialDecision}
                  onExpandMap={openScoutMap}
                />

                {/* Debug overlay (admin only) */}
                {showScoutPreviewDebug && (
                  <div className="absolute bottom-12 left-3 right-3 z-20">
                    <p className="text-[9px] font-bold text-white/60">
                      {String(isScoutPreviewEligible)} city:
                      {scoutPreviewCity || "none"} active:
                      {String(isPensacolaScoutPreview)} source:
                      {resolvedScoutLocation?.source || "none"} t:
                      {scoutSourceStatuses.trucks ?? "-"} r:
                      {scoutSourceStatuses.restaurants ?? "-"} h:
                      {scoutSourceStatuses.mapLocations ?? "-"} pins:
                      {scoutDebugCounts.mapPinsBuilt}
                    </p>
                  </div>
                )}
              </>
            )}
          </section>
        </ScoutMapHero>

        {/* ============================================================
             LOWER SHEET — discovery sections. Hidden when fullMap.
             Touch-swipe handlers sit on a thin drag handle at the top.
        ============================================================ */}
        {sheetState !== "fullMap" && (
          <ActiveScenePanel>
            <ScoutReadStatus failures={discoveryReadFailures} loading={discoveryLoading} retrying={discoveryRetrying} onRetry={retryDiscovery} />
            {(!readIncomplete || localSearchContentCount > 0) && <ActiveSceneContent
              readIncomplete={readIncomplete}
              laneId={activeSceneLaneId}
              sceneMixedFeedItems={sceneMixedFeedItems}
              visibleMoreFoodRestaurants={visibleMoreFoodRestaurants}
              topLocalFavoriteRestaurants={topLocalFavoriteRestaurants}
              scoutTruckInventory={scoutTruckInventoryForFeed}
              visibleTrucksServingNow={visibleTrucksServingNow}
              visibleOpenRestaurants={visibleOpenRestaurants}
              nearbyRestaurants={effectiveRestaurantsForFeed}
              localRotatingSpotCandidates={localRotatingSpotCandidatesForFeed}
              networkRotatingSpotCandidates={localNetworkRotatingSpotCandidates}
              spotRotationBucket={scoutSpotRotationBucket}
              visibleDeals={visibleDeals}
              hotDealCandidates={hotDealCandidates}
              happyHourDeals={happyHourDeals}
              visibleSceneEvents={visibleSceneEvents}
              visibleHosts={visibleHosts}
              localMenuItems={localMenuItemsForFeed}
              popularDishes={effectivePopularDishesForFeed}
              trendingPlacesThisWeek={effectiveTrendingPlacesForFeed}
              newToMealScoutRestaurants={newToMealScoutRestaurantsForFeed}
              openingLaterRestaurants={openingLaterRestaurants}
              visibleLocalActivityItems={visibleLocalActivityItems}
              scoutActivityMode={scoutActivityMode}
              liveTrucksLoading={liveTrucksLoading}
              liveTrucksError={liveTrucksError}
              nearbyRestaurantsLoading={nearbyRestaurantsLoading}
              locationStatus={locationStatus}
              currentUserId={currentUserId}
              isSignedIn={!!user}
              isAdminFamilyUser={isAdminFamilyUser}
              isTruckVendorUser={isTruckVendorUser}
              selectLiveTruck={selectLiveTruck}
              openScoutMap={openScoutMap}
              menuPreviewByRestaurantId={menuPreviewByRestaurantId}
              restaurantRelationships={restaurantRelationships}
              railSectionClass={railSectionClass}
              compactRailSectionClass={compactRailSectionClass}
              truckCardWidth={truckCardWidth}
              standardCardWidth={standardCardWidth}
              featureCardWidth={featureCardWidth}
              laneFoodTrucksTitle={laneFoodTrucksTitle}
              laneRestaurantsTitle={laneRestaurantsTitle}
              laneDealsTitle={laneDealsTitle}
              laneEventsTitle={laneEventsTitle}
              laneMoreTitle={laneMoreTitle}
              restaurantsRailSubtitle={restaurantsRailSubtitle}
              eventsRailSubtitle={eventsRailSubtitle}
              moreRailSubtitle={moreRailSubtitle}
              scoutSearchMode={scoutSearchMode}
              scoutSearchIntent={scoutSearchIntent}
              onOpenResultsSheet={setResultsSheet}
              showActivityFallback={showActivityFallback}
              fallbackSearchQuery={scoutSearchQuery}
              fallbackHasRelatedResults={fallbackHasRelatedResults}
              showActivitySupplement={showActivitySupplement}
              activitySupplementRestaurants={activitySupplementRestaurants}
              activitySupplementDishes={activitySupplementDishes}
              nearbyResultCount={localSearchContentCount}
              onRequestPlace={openFavoritePlaceRequest}
            />}
          </ActiveScenePanel>
        )}
        <Dialog
          open={isPlaceRequestOpen}
          onOpenChange={(open) => {
            setIsPlaceRequestOpen(open);
            if (!open) {
              setPlaceRequestQuery("");
              setSelectedPlaceRequest(null);
            }
          }}
        >
          <DialogContent className="border-orange-200/20 bg-[#24140c] text-white sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Request your favorite place</DialogTitle>
              <DialogDescription className="text-orange-100/65">
                Find the business, confirm it, and MealScout will add it to the
                review queue.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <PlaceAutocompleteInput
                id="scout-place-request"
                intent="food"
                value={placeRequestQuery}
                onChange={(value) => {
                  setPlaceRequestQuery(value);
                  setSelectedPlaceRequest(null);
                }}
                onSelect={(suggestion) => {
                  void selectFavoritePlaceRequest(suggestion);
                }}
                placeholder="Search the restaurant or food truck"
                disabled={isLoadingPlaceRequest || isSubmittingPlaceRequest}
                inputClassName="border-orange-200/20 bg-black/20 text-white placeholder:text-white/40"
                dataTestId="scout-place-request-input"
              />
              {isLoadingPlaceRequest ? (
                <p className="text-xs font-semibold text-orange-100/60">
                  Loading that place…
                </p>
              ) : null}
              {selectedPlaceRequest ? (
                <div className="rounded-xl border border-orange-200/20 bg-black/20 px-3 py-3">
                  <p className="text-sm font-black text-white">
                    {selectedPlaceRequest.restaurantName}
                  </p>
                  <p className="mt-1 text-xs font-semibold text-orange-100/60">
                    {selectedPlaceRequest.address}
                  </p>
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => void submitFavoritePlaceRequest()}
                disabled={
                  !selectedPlaceRequest ||
                  isLoadingPlaceRequest ||
                  isSubmittingPlaceRequest
                }
                className="inline-flex w-full items-center justify-center rounded-xl bg-[#ff6b35] px-4 py-3 text-sm font-black text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-45"
                data-testid="scout-submit-place-request"
              >
                {isSubmittingPlaceRequest
                  ? "Sending request…"
                  : "Request this place"}
              </button>
            </div>
          </DialogContent>
        </Dialog>

        {resultsSheet ? (
          <ScoutResultsSheet
            data={resultsSheet}
            onClose={() => setResultsSheet(null)}
          />
        ) : null}
      </main>
    </>
  );
}

/* ============================================================
   SHARED SECTION HEADER
   ============================================================ */

function SectionHeader({
  title,
  linkHref,
  subtitle,
  itemCount,
  onSeeAll,
}: {
  title: string;
  linkHref: string;
  subtitle?: string;
  itemCount?: number;
  onSeeAll?: () => void;
}) {
  const showLink = itemCount === undefined || itemCount > 1;
  const seeAllClassName =
    "inline-flex w-fit shrink-0 items-center gap-1 rounded-full bg-[color:var(--action-primary)]/10 px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.08em] text-[color:var(--action-primary)] ring-1 ring-[color:var(--action-primary)]/22 transition-colors hover:bg-[color:var(--action-primary)]/16 sm:text-sm sm:normal-case sm:tracking-normal";

  return (
    <div className="mb-2.5 pr-4">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-sans text-[17px] font-bold normal-case tracking-tight text-[color:var(--text-primary)] sm:text-xl">
            {title}
          </h2>
        </div>
        {showLink ? (
          onSeeAll ? (
            <button
              type="button"
              onClick={onSeeAll}
              className={seeAllClassName}
            >
              See All <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : (
            <Link href={linkHref} className={seeAllClassName}>
              See All <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          )
        ) : null}
      </div>
      {subtitle ? (
        <p className="mt-1 max-w-[34rem] text-xs font-medium leading-snug text-[color:var(--text-secondary)] sm:text-sm">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

/* ============================================================
   SCOUT HERO + FILTERS
   ============================================================ */

function CravingCompass({
  mode,
  daypartCopy,
  locationStatus,
  onRefreshLocation,
}: {
  mode: ScoutActivityMode;
  daypartCopy: { title: string; body: string };
  locationStatus: "idle" | "requesting" | "ready" | "denied";
  onRefreshLocation: () => void;
}) {
  const hasLocation = locationStatus === "ready";
  const modeLabel =
    mode === "high_activity"
      ? "Food happening now"
      : mode === "medium_activity"
        ? "Food nearby now"
        : "Explore local food";

  return (
    <section
      className={mode === "high_activity" ? "px-4 pt-3 pb-2" : "px-4 pt-4 pb-3"}
    >
      <div
        className={
          mode === "high_activity"
            ? "px-1 py-2"
            : "overflow-hidden rounded-[1.35rem] bg-[#17100d]/86 ring-1 ring-white/10 shadow-[0_16px_46px_rgba(0,0,0,0.24)]"
        }
      >
        <div className={mode === "high_activity" ? "" : "px-4 py-4"}>
          <p className="mb-2 text-[10px] font-black uppercase tracking-[0.16em] text-white/38">
            {modeLabel}
          </p>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-sans text-white text-lg font-black leading-tight">
                Find food near you.
              </h2>
              <p className="mt-1 text-white/62 text-xs leading-relaxed">
                Open restaurants, food trucks, and deals nearby.
              </p>
            </div>
            {!hasLocation ? (
              <button
                type="button"
                onClick={onRefreshLocation}
                className="shrink-0 rounded-full bg-white/90 px-2.5 py-1 text-[11px] font-black text-stone-900 ring-1 ring-white/40 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70"
              >
                Use location
              </button>
            ) : null}
          </div>
          <span className="sr-only">{daypartCopy.body}</span>
        </div>
      </div>
    </section>
  );
}

function SceneOptionsBar({
  activeSceneLaneId,
  onSceneLaneSelect,
}: {
  activeSceneLaneId: ScoutSceneLaneId;
  onSceneLaneSelect: (laneId: ScoutSceneLaneId) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollerRef.current?.scrollTo({ left: 0, behavior: "auto" });
  }, []);
  const getIcon = (icon: ScoutSceneLane["icon"]) => {
    if (icon === "spark")
      return <Compass className="h-3.5 w-3.5" aria-hidden="true" />;
    if (icon === "community")
      return <Users className="h-3.5 w-3.5" aria-hidden="true" />;
    if (icon === "nearby")
      return <Navigation2 className="h-3.5 w-3.5" aria-hidden="true" />;
    if (icon === "truck")
      return <Flame className="h-3.5 w-3.5" aria-hidden="true" />;
    if (icon === "restaurant")
      return <Utensils className="h-3.5 w-3.5" aria-hidden="true" />;
    if (icon === "deal")
      return <Tag className="h-3.5 w-3.5" aria-hidden="true" />;
    if (icon === "event")
      return <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />;
    if (icon === "menu")
      return <Bookmark className="h-3.5 w-3.5" aria-hidden="true" />;
    if (icon === "late")
      return <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />;
    return <Heart className="h-3.5 w-3.5" aria-hidden="true" />;
  };

  return (
    <section className="px-4 pb-4">
      <div
        ref={scrollerRef}
        className="overflow-x-auto atmo-hide-scrollbar pl-0.5"
      >
        <div className="flex w-max gap-1 pr-2">
          {SCOUT_SCENE_LANES.map((lane) => {
            const isActive = lane.id === activeSceneLaneId;
            return (
              <button
                key={lane.id}
                type="button"
                onClick={() => onSceneLaneSelect(lane.id)}
                className={[
                  "inline-flex min-h-11 min-w-[76px] shrink-0 items-center justify-center gap-1 rounded-2xl px-2 py-2 text-[11px] font-bold ring-1 transition-colors active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/60",
                  isActive
                    ? "bg-[#ff7945] text-white ring-white/20 shadow-[0_10px_22px_rgba(255,121,69,0.28)]"
                    : "bg-[#11131a]/82 text-white/78 ring-white/10 hover:bg-[#171a23] hover:text-white",
                ].join(" ")}
                aria-pressed={isActive}
              >
                {getIcon(lane.icon)}
                <span className="whitespace-nowrap">{lane.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ActiveSceneIntro({ laneId }: { laneId: ScoutSceneLaneId }) {
  const laneCopy: Record<
    ScoutSceneLaneId,
    { title: string; subtitle: string }
  > = {
    for_you: {
      title: "For You",
      subtitle:
        "Local favorites, open spots, new menus, and places worth finding.",
    },
    community: {
      title: "Community",
      subtitle: "What locals are saving, sharing, and coming back to.",
    },
    nearby_now: {
      title: "Nearby",
      subtitle: "Food, drinks, events, and trucks close to you.",
    },
    food_trucks: {
      title: "Food Trucks",
      subtitle: "Trucks posted up, scheduled, or serving nearby.",
    },
    restaurants: {
      title: "Restaurants",
      subtitle: "Open tables, local kitchens, and menu highlights.",
    },
    deals: {
      title: "Deals",
      subtitle: "Active offers from nearby spots.",
    },
    events: {
      title: "Events",
      subtitle: "Food, music, pop-ups, and things happening around town.",
    },
    new_menus: {
      title: "New Menus",
      subtitle: "Fresh dishes and menu updates from local spots.",
    },
    late_night: {
      title: "Late Night",
      subtitle: "Places still serving after hours.",
    },
    worth_discovering: {
      title: "Worth Discovering",
      subtitle: "New, quiet, or lesser-known spots nearby.",
    },
  };
  const activeCopy = laneCopy[laneId] ?? laneCopy.for_you;
  return (
    <section className="px-4 pb-3">
      <h2 className="font-sans text-2xl font-semibold tracking-tight text-white">
        {activeCopy.title}
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-white/62">
        {activeCopy.subtitle}
      </p>
    </section>
  );
}

type ScoutRailRenderCard =
  | {
      cardType: "truck";
      cardKind: "food_truck";
      truck: LiveTruckSummary;
      viewModel: ScoutResultViewModel;
    }
  | {
      cardType: "restaurant";
      cardKind: "restaurant" | "community_pick";
      restaurant: RestaurantSummary;
      viewModel: ScoutResultViewModel;
    }
  | {
      cardType: "menu_item";
      cardKind: "menu_item";
      item: LocalMenuItemFeedItem;
      position: number;
      viewModel: ScoutResultViewModel;
    }
  | {
      cardType: "deal";
      cardKind: "deal" | "happy_hour";
      deal: DealSummary;
      viewModel: ScoutResultViewModel;
    }
  | {
      cardType: "event";
      cardKind: "event";
      event: EventSummary;
      viewModel: ScoutResultViewModel;
    };

function buildTruckResultViewModel(
  truck: LiveTruckSummary,
  scope: ScoutDiscoveryScope = "nearby",
): ScoutResultViewModel {
  return buildScoutResultViewModel(
    toScoutDiscoveryResult(truck, {
      kind: "food_truck",
      scope,
      source: isTruckBroadcastLive(truck)
        ? "live_presence"
        : scope === "network"
          ? "network_search"
          : "local_inventory",
      href: getTruckProfilePath(truck),
    }),
  );
}

function buildRestaurantResultViewModel(
  restaurant: RestaurantSummary,
  scope: ScoutDiscoveryScope = "nearby",
): ScoutResultViewModel {
  const normalizedKind = getScoutRestaurantLikeKind(restaurant);
  return buildScoutResultViewModel(
    toScoutDiscoveryResult(restaurant, {
      kind: normalizedKind === "food_truck" ? "food_truck" : "business",
      scope,
      source: scope === "network" ? "network_search" : "local_inventory",
      href: getRestaurantProfilePath(restaurant),
    }),
    { variant: normalizedKind === "food_truck" ? "truck" : "place" },
  );
}

function buildMenuItemResultViewModel(
  item: LocalMenuItemFeedItem,
  scope: ScoutDiscoveryScope = "nearby",
): ScoutResultViewModel {
  return buildScoutResultViewModel(
    toScoutDiscoveryResult(item, {
      kind: "dish",
      scope,
      source: scope === "network" ? "network_search" : "menu",
      href: getMenuItemProfilePath(item),
    }),
  );
}

function buildDealResultViewModel(
  deal: DealSummary,
  scope: ScoutDiscoveryScope = "nearby",
): ScoutResultViewModel {
  return buildScoutResultViewModel(
    toScoutDiscoveryResult(deal, {
      kind: "deal",
      scope,
      source: scope === "network" ? "network_search" : "deal",
      href: `/deal/${encodeURIComponent(String(deal.id))}`,
    }),
  );
}

function buildEventResultViewModel(
  event: EventSummary,
  scope: ScoutDiscoveryScope = "nearby",
): ScoutResultViewModel {
  return buildScoutResultViewModel(
    toScoutDiscoveryResult(event, {
      kind: "event",
      scope,
      source: scope === "network" ? "network_search" : "event",
      href: `/event/${encodeURIComponent(String(event.id))}`,
    }),
  );
}

type ScoutImmediateDecisionItem =
  | {
      sourceRowId: ScoutHorizontalRowId;
      sectionLabel: string;
      summary: string;
      cardType: "truck";
      truck: LiveTruckSummary;
      businessKey: string | null;
    }
  | {
      sourceRowId: ScoutHorizontalRowId;
      sectionLabel: string;
      summary: string;
      cardType: "restaurant";
      restaurant: RestaurantSummary;
      businessKey: string | null;
    }
  | {
      sourceRowId: ScoutHorizontalRowId;
      sectionLabel: string;
      summary: string;
      cardType: "menu_item";
      item: LocalMenuItemFeedItem;
    }
  | {
      sourceRowId: ScoutHorizontalRowId;
      sectionLabel: string;
      summary: string;
      cardType: "deal";
      deal: DealSummary;
    }
  | {
      sourceRowId: ScoutHorizontalRowId;
      sectionLabel: string;
      summary: string;
      cardType: "event";
      event: EventSummary;
    }
  | {
      sourceRowId: ScoutHorizontalRowId;
      sectionLabel: string;
      summary: string;
      cardType: "host";
      host: ScoutHostLocation;
    };

type ScoutHorizontalRailDefinition = {
  id: ScoutHorizontalRowId;
  title: string;
  subtitle?: string;
  linkHref: string;
  cards: ScoutRailRenderCard[];
  className: string;
  cardWidth: string;
  rotatingFallbackFor?: ScoutHorizontalRowId;
};

const scoutHorizontalRowMeta = new Map(
  SCOUT_HORIZONTAL_ROW_REGISTRY.map((row) => [row.id, row]),
);

const scoutRotatingRowFallbackCopy: Partial<
  Record<ScoutHorizontalRowId, { title: string; subtitle: string }>
> = {
  open_now_near_you: {
    title: "Places to Try",
    subtitle: "Open hours are not posted yet.",
  },
  popular_dishes: {
    title: "Menus to Explore",
    subtitle: "Local menus are still filling in.",
  },
  hot_deals: {
    title: "More Food to Explore",
    subtitle: "No active deals are posted.",
  },
  happy_hours: {
    title: "Bars and Restaurants to Explore",
    subtitle: "No happy hours are posted.",
  },
  events_popups: {
    title: "Food Businesses to Explore",
    subtitle: "No food events are posted.",
  },
  nearby_restaurants: {
    title: "Restaurants to Explore",
    subtitle: "Local restaurant results are still filling in.",
  },
  trending_this_week: {
    title: "Worth a Look",
    subtitle: "Local activity is still building.",
  },
  new_to_mealscout: {
    title: "More on MealScout",
    subtitle: "New local listings are still building.",
  },
  worth_discovering: {
    title: "More Worth Discovering",
    subtitle: "More local food worth a look.",
  },
};

function getScoutRailCardKey(card: ScoutRailRenderCard): string {
  return card.viewModel.key;
}

function isScoutSearchHref(href: string): boolean {
  return href === "/search" || href.startsWith("/search?");
}

function ScoutHorizontalCategoryRail({
  row,
  renderCard,
  onOpenAll,
}: {
  row: ScoutHorizontalRailDefinition;
  renderCard: (card: ScoutRailRenderCard) => ReactNode;
  onOpenAll?: (row: ScoutHorizontalRailDefinition) => void;
}) {
  const rowMeta = scoutHorizontalRowMeta.get(row.id);
  if (!row.cards.length || !rowMeta?.hideWhenEmpty) return null;
  return (
    <section
      className={`${row.className} relative`}
      data-scout-row-id={row.id}
      data-scout-row-priority={rowMeta.priority}
      data-scout-accepted-kinds={rowMeta.acceptedCardKinds.join(",")}
      data-scout-dedup-policy={rowMeta.dedupPolicy}
      data-scout-row-fallback={
        row.rotatingFallbackFor ? "rotating-spots" : undefined
      }
      data-scout-fallback-for={row.rotatingFallbackFor}
    >
      <SectionHeader
        title={row.title}
        linkHref={row.linkHref}
        subtitle={row.subtitle}
        itemCount={row.cards.length}
        onSeeAll={
          onOpenAll && isScoutSearchHref(row.linkHref)
            ? () => onOpenAll(row)
            : undefined
        }
      />
      <div
        className="w-full max-w-full overflow-x-auto overscroll-x-contain atmo-hide-scrollbar [scrollbar-width:none] [&::-webkit-scrollbar]:hidden -mr-1"
        data-scout-horizontal-rail="true"
      >
        <ul
          className="flex w-max max-w-none snap-x snap-mandatory gap-3 pr-4 sm:gap-3.5 lg:grid lg:w-full lg:grid-cols-4 lg:snap-none"
          role="list"
          aria-label={row.title}
        >
          {row.cards.slice(0, rowMeta.maxCards).map((card, index) => (
            <li
              key={`${row.id}-${card.cardType}-${getScoutRailCardKey(card)}-${index}`}
              className={`shrink-0 snap-start ${row.cardWidth} lg:w-auto lg:min-w-0 ${index >= 4 ? "lg:hidden" : ""}`}
              data-scout-card-kind={card.cardKind}
            >
              {renderCard(card)}
            </li>
          ))}
        </ul>
      </div>
      {row.cards.length > 2 ? (
        <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-20 items-center justify-end bg-gradient-to-l from-[#211610] via-[#211610]/88 to-transparent pr-2 sm:flex lg:hidden">
          <span className="rounded-full bg-white/8 px-2 py-1 text-[10px] font-black uppercase tracking-[0.08em] text-white/58 ring-1 ring-white/10">
            Scroll
          </span>
        </div>
      ) : null}
    </section>
  );
}

/* ============================================================
   SCOUT RESULTS SHEET — full-screen "See All" overlay.
   Stays inside Scout instead of navigating to a separate page;
   reuses whatever data + card renderer the caller already has,
   just without the horizontal-rail's item cap.
   ============================================================ */

export type ScoutResultsSheetData = {
  title: string;
  subtitle?: string;
  items: unknown[];
  renderItem: (item: any, index: number) => ReactNode;
  getKey?: (item: any, index: number) => string;
};

function ScoutResultsSheet({
  data,
  onClose,
}: {
  data: ScoutResultsSheetData;
  onClose: () => void;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#0b0704]">
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)]">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/8 text-white ring-1 ring-white/10 active:bg-white/12"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-lg font-black text-white">
            {data.title}
          </h2>
          {data.subtitle ? (
            <p className="truncate text-xs font-semibold text-white/58">
              {data.subtitle}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] pt-4">
        {data.items.length === 0 ? (
          <p className="mt-10 text-center text-sm text-white/50">
            Nothing here yet.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {data.items.map((item, index) => (
              <div key={data.getKey ? data.getKey(item, index) : index}>
                {data.renderItem(item, index)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function ScoutFallbackMarketNotice({
  query,
  hasResults,
  nearbyResultCount = 0,
  onRequestPlace,
}: {
  query: string;
  hasResults: boolean;
  nearbyResultCount?: number;
  onRequestPlace: () => void;
}) {
  const normalizedQuery = query.trim();
  const hasOneNearbyResult =
    !normalizedQuery && nearbyResultCount === 1 && hasResults;
  return (
    <section
      className="px-4 pt-2 sm:h-full sm:px-0 sm:pt-3"
      data-testid="scout-fallback-market-notice"
    >
      <div className="h-full rounded-[1.1rem] border border-[color:var(--border-subtle)] bg-[var(--bg-card)] px-4 py-3 shadow-[0_8px_20px_rgba(0,0,0,0.06)]">
        <p className="text-[10px] font-black uppercase tracking-[0.13em] text-[color:var(--action-primary)]">
          {normalizedQuery
            ? "Nothing matched nearby"
            : hasOneNearbyResult
              ? "Only one nearby spot right now"
              : "No nearby listings yet"}
        </p>
        <div className="mt-1 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-black text-[color:var(--text-primary)]">
              {hasOneNearbyResult
                ? "More happening across MealScout"
                : hasResults
                ? normalizedQuery
                  ? "Showing related picks from active areas"
                  : "Showing popular picks from active areas"
                : normalizedQuery
                  ? `No related “${normalizedQuery}” picks are active right now`
                  : "No nearby listings are available for this area yet"}
            </p>
            <p className="mt-0.5 text-xs font-semibold leading-relaxed text-[color:var(--text-secondary)]">
              {hasOneNearbyResult
                ? "Your nearby result stays first. The picks below are popular in other active MealScout areas."
                : hasResults
                ? normalizedQuery
                  ? `These are farther away, may come from any active MealScout area, and clearly relate to “${normalizedQuery}.”`
                  : "These are farther away and come from MealScout areas with current activity."
                : "Scout will not substitute unrelated food. Request your favorite place and we’ll add it to the review queue."}
            </p>
          </div>
          <button
            type="button"
            onClick={onRequestPlace}
            className="inline-flex w-fit shrink-0 items-center justify-center gap-1.5 rounded-full bg-[color:var(--action-primary)] px-3.5 py-2 text-[11px] font-black text-[color:var(--action-primary-text)] shadow-sm"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Request your favorite place
          </button>
        </div>
      </div>
    </section>
  );
}

function ScoutFirstScreenDecisionStack({
  items,
  thinMarket,
  readIncomplete = false,
}: {
  items: ScoutImmediateDecisionItem[];
  thinMarket: boolean;
  readIncomplete?: boolean;
}) {
  const primary = items[0] ?? null;

  if (!primary) {
    if (readIncomplete) return null;
    return (
      <section
        className="px-4 pb-2 pt-2 sm:h-full sm:px-0"
        data-scout-first-screen-decision-stack="true"
        data-scout-first-screen-empty="true"
      >
        <div className="h-full rounded-2xl bg-[#2b1b13]/94 px-4 py-3 ring-1 ring-orange-200/18 shadow-[0_10px_26px_rgba(0,0,0,0.24)]">
          <p className="text-[11px] font-black uppercase tracking-[0.12em] text-orange-300">
            No food results yet
          </p>
          <p className="mt-1 text-sm font-semibold text-orange-50/62">
            Try a craving, category, or another map area.
          </p>
          <ScoutRecoveryActions className="mt-3" />
        </div>
      </section>
    );
  }

  return (
    <section
      className="px-4 pb-2 pt-2 sm:h-full sm:px-0"
      data-scout-first-screen-decision-stack="true"
      data-scout-decision-source-row={primary.sourceRowId}
    >
      <div className="h-full">
        <div className="mb-1.5 min-w-0 px-0.5">
          <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[color:var(--action-primary)]">
            {primary.sectionLabel}
          </p>
          <span className="sr-only">{primary.summary}</span>
        </div>
        <ScoutImmediateCompactCard item={primary} />
        {thinMarket && !readIncomplete ? (
          <div
            className="mt-2.5 rounded-2xl bg-[color:var(--action-primary)]/6 px-3 py-3 ring-1 ring-[color:var(--action-primary)]/18"
            data-testid="scout-thin-market-state"
          >
            <p className="text-sm font-black text-[color:var(--text-primary)]">
              Local food coverage is still growing, so the closest real place
              stays first.
            </p>
            <p className="mt-1 text-xs font-semibold leading-relaxed text-[color:var(--text-secondary)]">
              Explore the map or try another craving.
            </p>
            <ScoutRecoveryActions className="mt-3" />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ScoutRecoveryActions({ className = "" }: { className?: string }) {
  return (
    <div className={`flex flex-wrap gap-2 ${className}`.trim()}>
      <Link
        href="/search"
        className="rounded-full bg-[color:var(--action-primary)] px-3 py-1.5 text-[11px] font-black text-[color:var(--action-primary-text)]"
      >
        Browse food
      </Link>
      <Link
        href="/search"
        className="rounded-full bg-[color:var(--bg-surface-muted)] px-3 py-1.5 text-[11px] font-black text-[color:var(--text-primary)] ring-1 ring-[color:var(--border-subtle)]"
      >
        Search
      </Link>
    </div>
  );
}

function ScoutImmediateCompactCard({
  item,
}: {
  item: ScoutImmediateDecisionItem;
}) {
  if (item.cardType === "truck") {
    const truck = item.truck;
    const title = truck.name || "Food truck";
    const area = getTruckArea(truck);
    const status = isTruckBroadcastLive(truck)
      ? "Live now"
      : isTruckServingNow(truck)
        ? "Serving now"
        : "Scheduled";
    const meta = ["Food truck", status, area].filter(Boolean).join(" / ");
    const href = getTruckProfilePath(truck);
    const view = buildScoutResultViewModel(
      toScoutDiscoveryResult(truck, {
        kind: "food_truck",
        scope: "nearby",
        source: isTruckBroadcastLive(truck) ? "live_presence" : "local_inventory",
        href,
      }),
      { subtitle: meta },
    );
    const directionsUrl = buildTruckDirectionsUrl(truck);
    return (
      <CompactDecisionCardShell
        href={view.href}
        imageUrl={view.imageUrl}
        imageObjectPosition={view.imageObjectPosition}
        fallbackIcon={
          <TruckIcon className="h-4 w-4 text-white/90" aria-hidden="true" />
        }
        title={view.title || title}
        meta={view.subtitle || meta}
        primaryActionLabel={view.primaryActionLabel}
        directionsUrl={directionsUrl}
        categoryPhoto={getDishCategoryPhoto(
          truck.name,
          truck.cuisineType,
          truck.vibe,
        )}
        variant="truck"
      />
    );
  }

  if (item.cardType === "restaurant") {
    const restaurant = item.restaurant;
    const normalizedKind = getScoutRestaurantLikeKind(restaurant);
    const typeLabel =
      normalizedKind === "food_truck"
        ? "Food truck"
        : normalizedKind === "restaurant"
          ? "Restaurant"
          : "Local food";
    const openState = getRestaurantOpenState(restaurant);
    const status =
      openState === "open"
        ? "Open now"
        : openState === "closed"
          ? "Closed now"
          : null;
    const area = getRestaurantArea(restaurant);
    const meta = [typeLabel, status, area].filter(Boolean).join(" / ");
    const href = getRestaurantProfilePath(restaurant);
    const view = buildScoutResultViewModel(
      toScoutDiscoveryResult(restaurant, {
        kind: normalizedKind === "food_truck" ? "food_truck" : "business",
        scope: "nearby",
        source: "local_inventory",
        href,
      }),
      {
        subtitle: meta,
        variant: normalizedKind === "food_truck" ? "truck" : "place",
      },
    );
    const directionsUrl = buildDirectionsUrl(restaurant);
    return (
      <CompactDecisionCardShell
        href={view.href}
        imageUrl={view.imageUrl}
        imageObjectPosition={view.imageObjectPosition}
        fallbackIcon={
          normalizedKind === "food_truck" ? (
            <TruckIcon className="h-4 w-4 text-white/90" aria-hidden="true" />
          ) : (
            <MapPin className="h-4 w-4 text-white/90" aria-hidden="true" />
          )
        }
        title={view.title}
        meta={view.subtitle || meta}
        primaryActionLabel={view.primaryActionLabel}
        directionsUrl={directionsUrl}
        categoryPhoto={getDishCategoryPhoto(
          getRestaurantName(restaurant),
          restaurant.cuisineType,
        )}
        variant={view.variant}
      />
    );
  }

  if (item.cardType === "menu_item") {
    const menuItem = item.item;
    const reason = [
      menuItem.restaurantName || "Local menu",
      menuItem.cuisineType,
      typeof menuItem.priceCents === "number" && menuItem.priceCents > 0
        ? `$${(menuItem.priceCents / 100).toFixed(menuItem.priceCents % 100 === 0 ? 0 : 2)}`
        : null,
    ]
      .filter(Boolean)
      .join(" / ");
    const href = getMenuItemProfilePath(menuItem);
    const view = buildScoutResultViewModel(
      toScoutDiscoveryResult(menuItem, {
        kind: "dish",
        scope: "nearby",
        source: "menu",
        href,
      }),
      { subtitle: reason || "Popular nearby dish" },
    );
    return (
      <CompactDecisionCardShell
        href={view.href}
        imageUrl={view.imageUrl}
        imageObjectPosition={view.imageObjectPosition}
        fallbackIcon={
          <Utensils className="h-4 w-4 text-white/90" aria-hidden="true" />
        }
        title={view.title}
        meta={view.subtitle || "Popular nearby dish"}
        primaryActionLabel={view.primaryActionLabel}
        categoryPhoto={getDishCategoryPhoto(
          menuItem.name,
          menuItem.cuisineType,
        )}
        variant={view.variant}
      />
    );
  }

  if (item.cardType === "deal") {
    const deal = item.deal;
    const meta =
      [deal.restaurantName, deal.discountText || deal.description]
        .filter(Boolean)
        .join(" / ") || "Active nearby deal";
    const href = `/deal/${encodeURIComponent(String(deal.id))}`;
    const view = buildScoutResultViewModel(
      toScoutDiscoveryResult(deal, {
        kind: "deal",
        scope: "nearby",
        source: "deal",
        href,
      }),
      { subtitle: meta },
    );
    return (
      <CompactDecisionCardShell
        href={view.href}
        imageUrl={view.imageUrl}
        imageObjectPosition={view.imageObjectPosition}
        fallbackIcon={
          <Tag className="h-4 w-4 text-white/90" aria-hidden="true" />
        }
        title={view.title}
        meta={view.subtitle || meta}
        primaryActionLabel={view.primaryActionLabel}
        categoryPhoto={getDishCategoryPhoto(
          deal.title,
          (deal as any).description,
        )}
        variant={view.variant}
      />
    );
  }

  if (item.cardType === "host") {
    const host = item.host;
    const hostName = host.businessName || host.name || "Host location";
    const hostId = String(host.hostId || host.id || "").trim();
    const area =
      [host.city, host.state].filter(Boolean).join(", ") ||
      host.address ||
      "Nearby location";
    const directionsUrl = buildDirectionsUrl({
      lat: readNumberField(host, ["latitude", "lat"]),
      lng: readNumberField(host, ["longitude", "lng"]),
    });
    const href = hostId
      ? `/events?hostId=${encodeURIComponent(hostId)}`
      : "/events";
    const meta = ["Host location", area].filter(Boolean).join(" / ");
    const view = buildScoutResultViewModel(
      toScoutDiscoveryResult(
        { ...host, name: hostName, imageUrl: host.spotImageUrl },
        {
          kind: "business",
          scope: "nearby",
          source: "event",
          href,
        },
      ),
      {
        subtitle: meta,
        primaryActionLabel: "View host",
        variant: "host",
      },
    );
    return (
      <CompactDecisionCardShell
        href={view.href}
        imageUrl={view.imageUrl}
        imageObjectPosition={view.imageObjectPosition}
        fallbackIcon={
          <MapPin className="h-4 w-4 text-white/90" aria-hidden="true" />
        }
        title={view.title}
        meta={view.subtitle || meta}
        primaryActionLabel={view.primaryActionLabel}
        directionsUrl={directionsUrl}
        variant={view.variant}
      />
    );
  }

  const event = item.event;
  const title = event.title || event.name || "Food event";
  const start = event.startsAt || event.startTime;
  const startLabel = start
    ? new Date(start).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : null;
  const meta =
    [event.venueName || event.locationName, startLabel]
      .filter(Boolean)
      .join(" / ") || "Upcoming nearby event";
  const href = `/events?eventId=${encodeURIComponent(String(event.id))}`;
  const view = buildScoutResultViewModel(
    toScoutDiscoveryResult({ ...event, name: title }, {
      kind: "event",
      scope: "nearby",
      source: "event",
      href,
    }),
    { subtitle: meta },
  );
  return (
    <CompactDecisionCardShell
      href={view.href}
      imageUrl={view.imageUrl}
      imageObjectPosition={view.imageObjectPosition}
      fallbackIcon={
        <CalendarDays className="h-4 w-4 text-white/90" aria-hidden="true" />
      }
      title={view.title}
      meta={view.subtitle || meta}
      primaryActionLabel={view.primaryActionLabel}
      variant={view.variant}
    />
  );
}

type CompactDecisionCardVariant =
  | "truck"
  | "place"
  | "dish"
  | "deal"
  | "event"
  | "host";

function CompactDecisionCardShell({
  href,
  imageUrl,
  imageObjectPosition = "50% 50%",
  fallbackIcon,
  title,
  meta,
  primaryActionLabel,
  directionsUrl,
  categoryPhoto = null,
  variant = "place",
}: {
  href: string;
  imageUrl?: string | null;
  imageObjectPosition?: string;
  fallbackIcon: ReactNode;
  title: string;
  meta: string;
  primaryActionLabel: string;
  directionsUrl?: string | null;
  categoryPhoto?: DishCategoryPhoto | null;
  variant?: CompactDecisionCardVariant;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => {
    setImageFailed(false);
  }, [imageUrl]);
  const showImage = Boolean(imageUrl) && !imageFailed;
  const shellClass =
    variant === "dish"
      ? "bg-[var(--bg-card)] ring-orange-300/40"
      : variant === "truck"
        ? "bg-[var(--bg-card)] ring-orange-300/45"
        : variant === "deal"
          ? "bg-[var(--bg-card)] ring-lime-400/45"
          : variant === "event"
            ? "bg-[var(--bg-card)] ring-sky-400/45"
            : variant === "host"
              ? "bg-[var(--bg-card)] ring-amber-400/45"
              : "bg-[var(--bg-card)] ring-orange-300/40";
  const thumbClass =
    variant === "dish"
      ? "rounded-full bg-black/18 ring-orange-200/18"
      : variant === "truck"
        ? "rounded-2xl bg-black/18 ring-orange-200/18"
        : variant === "deal"
          ? "rounded-lg bg-black/18 ring-lime-200/18"
          : variant === "event"
            ? "rounded-lg bg-black/18 ring-sky-200/18"
            : variant === "host"
              ? "rounded-xl bg-black/18 ring-amber-200/18"
              : "rounded-xl bg-black/18 ring-orange-200/18";
  const actionClass =
    variant === "deal"
      ? "bg-lime-300 text-[#102006]"
      : variant === "event"
        ? "bg-sky-300 text-[#071322]"
        : variant === "host"
          ? "bg-amber-300 text-[#1f1204]"
          : "bg-orange-400 text-[#1a0d08]";
  return (
    <div
      className={`relative flex min-h-[88px] items-center gap-2.5 overflow-hidden rounded-2xl p-2 ring-1 shadow-[0_10px_26px_rgba(0,0,0,0.24)] ${shellClass}`}
      data-scout-immediate-compact-card="true"
    >
      {variant === "dish" ? (
        <span
          className="absolute inset-x-3 bottom-0 border-t border-dashed border-orange-100/18"
          aria-hidden="true"
        />
      ) : null}
      <div
        className={`flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden ring-1 ${thumbClass}`}
      >
        {showImage ? (
          <img
            src={imageUrl || undefined}
            alt=""
            className="h-full w-full object-cover"
            style={{ objectPosition: imageObjectPosition }}
            loading="lazy"
            onError={() => setImageFailed(true)}
          />
        ) : categoryPhoto ? (
          <img
            src={categoryPhoto.image}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            aria-hidden="true"
            data-testid="scout-compact-card-image-fallback"
          />
        ) : (
          <div
            className="relative flex h-full w-full items-center justify-center overflow-hidden bg-[linear-gradient(150deg,#ff8a4c_0%,#ff5a2f_45%,#c2410c_100%)]"
            data-testid="scout-compact-card-image-fallback"
          >
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.22),transparent_55%)]" />
            <div className="relative text-white/90">{fallbackIcon}</div>
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-black leading-tight text-[color:var(--text-primary)]">
          {title}
        </p>
        <p className="mt-1 truncate text-xs font-semibold text-[color:var(--text-secondary)]">
          {meta}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <Link
            href={href}
            className={`rounded-full px-3 py-1.5 text-[11px] font-black ${actionClass}`}
          >
            {primaryActionLabel}
          </Link>
          {directionsUrl ? (
            <a
              href={directionsUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-full bg-[color:var(--bg-surface-muted)] px-3 py-1.5 text-[11px] font-black text-[color:var(--text-primary)] ring-1 ring-[color:var(--border-subtle)]"
            >
              Directions
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ScoutCardMedia({
  imageUrl,
  imageObjectPosition = "50% 50%",
  fallbackIcon,
  fallbackTestId,
  imageClassName,
  fallbackClassName = "",
  categoryPhoto = null,
}: {
  imageUrl?: string | null;
  imageObjectPosition?: string;
  fallbackIcon: ReactNode;
  fallbackTestId: string;
  imageClassName: string;
  fallbackClassName?: string;
  categoryPhoto?: DishCategoryPhoto | null;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => {
    setImageFailed(false);
  }, [imageUrl]);
  const showImage = Boolean(imageUrl) && !imageFailed;

  if (showImage) {
    return (
      <img
        src={imageUrl || undefined}
        alt=""
        className={imageClassName}
        style={{ objectPosition: imageObjectPosition }}
        loading="lazy"
        onError={() => setImageFailed(true)}
      />
    );
  }

  if (categoryPhoto) {
    return (
      <div
        className="absolute inset-0 overflow-hidden"
        data-testid={fallbackTestId}
      >
        <img
          src={categoryPhoto.image}
          alt=""
          className={imageClassName}
          loading="lazy"
          aria-hidden="true"
        />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(180deg, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.55) 100%)",
          }}
          aria-hidden="true"
        />
        <span className="absolute bottom-2 right-2 rounded-full bg-black/70 px-2 py-1 text-[9px] font-black uppercase tracking-[0.08em] text-white/85 ring-1 ring-white/25 backdrop-blur-sm">
          {categoryPhoto.label} · photo coming soon
        </span>
      </div>
    );
  }

  return (
    <div
      className={[
        "absolute inset-0 flex items-center justify-center overflow-hidden",
        "bg-[linear-gradient(150deg,#ff8a4c_0%,#ff5a2f_45%,#c2410c_100%)]",
        fallbackClassName,
      ].join(" ")}
      data-testid={fallbackTestId}
      aria-hidden="true"
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.22),transparent_55%)]" />
      <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15 ring-1 ring-white/25 shadow-[0_10px_24px_rgba(0,0,0,0.28)] backdrop-blur-sm">
        {fallbackIcon}
      </div>
    </div>
  );
}

function ScoutNetworkScopeBadge({
  label,
  position = "bottom-left",
}: {
  label?: string | null;
  position?: "bottom-left" | "top-right";
}) {
  if (!label) return null;
  return (
    <span
      className={`absolute z-10 max-w-[calc(100%-1rem)] truncate rounded-full bg-[#2a180e]/92 px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.08em] text-orange-100 ring-1 ring-orange-300/35 backdrop-blur-md ${
        position === "top-right" ? "right-2 top-2" : "bottom-2 left-2"
      }`}
      data-testid="scout-network-scope-label"
    >
      {label}
    </span>
  );
}

type ScoutRotatingSpot = {
  restaurant: RestaurantSummary;
  scope: ScoutDiscoveryScope;
};

function ActiveSceneContent({
  readIncomplete = false,
  laneId,
  sceneMixedFeedItems,
  visibleMoreFoodRestaurants,
  topLocalFavoriteRestaurants,
  scoutTruckInventory,
  visibleTrucksServingNow,
  visibleOpenRestaurants,
  nearbyRestaurants,
  localRotatingSpotCandidates,
  networkRotatingSpotCandidates,
  spotRotationBucket,
  visibleDeals,
  hotDealCandidates,
  happyHourDeals,
  visibleSceneEvents,
  visibleHosts,
  localMenuItems,
  popularDishes,
  trendingPlacesThisWeek,
  newToMealScoutRestaurants,
  openingLaterRestaurants,
  visibleLocalActivityItems,
  scoutActivityMode,
  liveTrucksLoading,
  liveTrucksError,
  nearbyRestaurantsLoading,
  locationStatus,
  currentUserId,
  isSignedIn,
  isAdminFamilyUser,
  isTruckVendorUser,
  selectLiveTruck,
  openScoutMap,
  menuPreviewByRestaurantId,
  restaurantRelationships,
  railSectionClass,
  compactRailSectionClass,
  truckCardWidth,
  standardCardWidth,
  featureCardWidth,
  laneFoodTrucksTitle,
  laneRestaurantsTitle,
  laneDealsTitle,
  laneEventsTitle,
  laneMoreTitle,
  restaurantsRailSubtitle,
  eventsRailSubtitle,
  moreRailSubtitle,
  scoutSearchMode,
  scoutSearchIntent,
  onOpenResultsSheet,
  showActivityFallback,
  fallbackSearchQuery,
  fallbackHasRelatedResults,
  showActivitySupplement,
  activitySupplementRestaurants,
  activitySupplementDishes,
  nearbyResultCount,
  onRequestPlace,
}: {
  readIncomplete?: boolean;
  laneId: ScoutSceneLaneId;
  sceneMixedFeedItems: CravingBoardItem[];
  visibleMoreFoodRestaurants: RestaurantSummary[];
  topLocalFavoriteRestaurants: RestaurantSummary[];
  scoutTruckInventory: LiveTruckSummary[];
  visibleTrucksServingNow: LiveTruckSummary[];
  visibleOpenRestaurants: RestaurantSummary[];
  nearbyRestaurants: RestaurantSummary[];
  localRotatingSpotCandidates: RestaurantSummary[];
  networkRotatingSpotCandidates: RestaurantSummary[];
  spotRotationBucket: number;
  visibleDeals: DealSummary[];
  hotDealCandidates: DealSummary[];
  happyHourDeals: DealSummary[];
  visibleSceneEvents: EventSummary[];
  visibleHosts: ScoutHostLocation[];
  localMenuItems: LocalMenuItemFeedItem[];
  popularDishes: TrendingDishSummary[];
  trendingPlacesThisWeek: TrendingPlaceSummary[];
  newToMealScoutRestaurants: RestaurantSummary[];
  openingLaterRestaurants: RestaurantSummary[];
  visibleLocalActivityItems: LocalActivityItem[];
  scoutActivityMode: ScoutActivityMode;
  liveTrucksLoading: boolean;
  liveTrucksError: boolean;
  nearbyRestaurantsLoading: boolean;
  locationStatus: "idle" | "requesting" | "ready" | "denied";
  currentUserId?: string | null;
  isSignedIn: boolean;
  isAdminFamilyUser: boolean;
  isTruckVendorUser: boolean;
  selectLiveTruck: (truck: LiveTruckSummary) => void;
  openScoutMap: () => void;
  menuPreviewByRestaurantId: Map<string, MenuPreviewItem[]>;
  restaurantRelationships: RestaurantRelationshipSnapshot;
  railSectionClass: string;
  compactRailSectionClass: string;
  truckCardWidth: string;
  standardCardWidth: string;
  featureCardWidth: string;
  laneFoodTrucksTitle: string;
  laneRestaurantsTitle: string;
  laneDealsTitle: string;
  laneEventsTitle: string;
  laneMoreTitle: string;
  restaurantsRailSubtitle?: string;
  eventsRailSubtitle?: string;
  moreRailSubtitle: string;
  scoutSearchMode: boolean;
  scoutSearchIntent: ScoutSearchIntent;
  onOpenResultsSheet?: (data: ScoutResultsSheetData) => void;
  showActivityFallback: boolean;
  fallbackSearchQuery: string;
  fallbackHasRelatedResults: boolean;
  showActivitySupplement: boolean;
  activitySupplementRestaurants: RestaurantSummary[];
  activitySupplementDishes: TrendingDishSummary[];
  nearbyResultCount: number;
  onRequestPlace: () => void;
}) {
  const isLowActivityLane = scoutActivityMode === "low_activity";
  const rotatingSpots = useMemo<ScoutRotatingSpot[]>(() => {
    if (laneId === "food_trucks") return [];
    const getSpotKey = (restaurant: RestaurantSummary) =>
      getScoutBusinessCardKey(
        restaurant,
        getRestaurantProfilePath(restaurant),
      );
    const seed = `${laneId}:${spotRotationBucket}`;
    const localSpots = rotateScoutSpots(
      localRotatingSpotCandidates,
      `local:${seed}`,
      getSpotKey,
      SCOUT_ROTATING_SPOT_LIMIT,
    );
    const localKeys = new Set(localSpots.map(getSpotKey).filter(Boolean));
    const remaining = SCOUT_ROTATING_SPOT_LIMIT - localSpots.length;
    const networkSpots = rotateScoutSpots(
      networkRotatingSpotCandidates.filter((restaurant) => {
        const key = getSpotKey(restaurant);
        return !key || !localKeys.has(key);
      }),
      `network:${seed}`,
      getSpotKey,
      remaining,
    );
    return [
      ...localSpots.map((restaurant) => ({
        restaurant,
        scope: "nearby" as const,
      })),
      ...networkSpots.map((restaurant) => ({
        restaurant,
        scope: "network" as const,
      })),
    ];
  }, [
    laneId,
    localRotatingSpotCandidates,
    networkRotatingSpotCandidates,
    spotRotationBucket,
  ]);
  const distinctNewMenuItems = useMemo(
    () => selectDistinctScoutMenuBusinesses(localMenuItems, 10),
    [localMenuItems],
  );
  const hasNewMenuBusinessDiversity =
    distinctNewMenuItems.length >= SCOUT_MIN_MENU_BUSINESS_DIVERSITY;
  const newMenuFallbackSpots = rotatingSpots.slice(0, 4);

  if (laneId === "for_you") {
    type ScoutBusinessSectionCard =
      | { cardType: "truck"; truck: LiveTruckSummary }
      | { cardType: "restaurant"; restaurant: RestaurantSummary };

    const toBusinessKey = (card: ScoutBusinessSectionCard) =>
      card.cardType === "truck"
        ? getScoutBusinessCardKey(card.truck, getTruckProfilePath(card.truck))
        : getScoutBusinessCardKey(
            card.restaurant,
            getRestaurantProfilePath(card.restaurant),
          );
    const truckCards = (
      items: LiveTruckSummary[],
    ): ScoutBusinessSectionCard[] =>
      items.map((truck) => ({ cardType: "truck", truck }));
    const restaurantCards = (
      items: RestaurantSummary[],
    ): ScoutBusinessSectionCard[] =>
      items.map((restaurant) => ({ cardType: "restaurant", restaurant }));
    const extractTrucks = (items: ScoutBusinessSectionCard[] = []) =>
      items
        .filter(
          (item): item is { cardType: "truck"; truck: LiveTruckSummary } =>
            item.cardType === "truck",
        )
        .map((item) => item.truck);
    const extractRestaurants = (items: ScoutBusinessSectionCard[] = []) =>
      items
        .filter(
          (
            item,
          ): item is {
            cardType: "restaurant";
            restaurant: RestaurantSummary;
          } => item.cardType === "restaurant",
        )
        .map((item) => item.restaurant);

    const liveTruckCandidates = visibleTrucksServingNow;
    // Live truck discovery is operational truth, never a profile fallback.
    // General truck profiles can still appear in non-live discovery categories.
    const foodTrucksTodayCandidates: LiveTruckSummary[] = [];
    const nearbyRestaurantCandidates = nearbyRestaurants;
    const favoriteRestaurantCandidates = nearbyRestaurantCandidates.filter(
      (restaurant) =>
        restaurantRelationships.favoriteIds.has(String(restaurant.id)),
    );
    const followedRestaurantCandidates = nearbyRestaurantCandidates.filter(
      (restaurant) =>
        restaurantRelationships.followIds.has(String(restaurant.id)),
    );
    const orderAgainCandidates: ScoutBusinessSectionCard[] = [];
    const trendingPlaceCardsRaw: RestaurantSummary[] =
      trendingPlacesThisWeek.map((place) => ({
        id: place.id,
        businessName: place.name,
        name: place.name,
        city: place.city ?? null,
        state: place.state ?? null,
        cuisineType: place.cuisineType ?? null,
        coverImageUrl: place.coverImageUrl ?? null,
        logoUrl: place.logoUrl ?? null,
        businessType: place.businessType ?? null,
        isFoodTruck: place.isFoodTruck ?? null,
      }));
    const scoutBusinessAssignments =
      assignScoutBusinessCardsBySection<ScoutBusinessSectionCard>([
        {
          id: "live_trucks_now",
          items: truckCards(liveTruckCandidates),
          getBusinessKey: toBusinessKey,
        },
        {
          id: "food_trucks_today",
          items: truckCards(foodTrucksTodayCandidates),
          getBusinessKey: toBusinessKey,
        },
        {
          id: "open_now_near_you",
          items: [
            ...truckCards(liveTruckCandidates),
            ...restaurantCards(visibleOpenRestaurants),
          ],
          getBusinessKey: toBusinessKey,
        },
        {
          id: "saved_favorites",
          items: restaurantCards(favoriteRestaurantCandidates),
          getBusinessKey: toBusinessKey,
        },
        {
          id: "following",
          items: restaurantCards(followedRestaurantCandidates),
          getBusinessKey: toBusinessKey,
        },
        {
          id: "order_again",
          items: orderAgainCandidates,
          getBusinessKey: toBusinessKey,
        },
        {
          id: "nearby_restaurants",
          items: restaurantCards(
            nearbyRestaurantCandidates.filter(
              (restaurant) =>
                getScoutRestaurantLikeKind(restaurant) === "restaurant",
            ),
          ),
          getBusinessKey: toBusinessKey,
        },
        {
          id: "trending_this_week",
          items: restaurantCards(trendingPlaceCardsRaw),
          getBusinessKey: toBusinessKey,
        },
        {
          id: "new_to_mealscout",
          items: restaurantCards(newToMealScoutRestaurants),
          getBusinessKey: toBusinessKey,
        },
        {
          id: "community_picks",
          items: restaurantCards(topLocalFavoriteRestaurants),
          getBusinessKey: toBusinessKey,
        },
        {
          id: "worth_discovering",
          items: [
            ...truckCards(scoutTruckInventory),
            ...restaurantCards(visibleMoreFoodRestaurants),
          ],
          getBusinessKey: toBusinessKey,
        },
      ]);
    const liveTruckCards = extractTrucks(
      scoutBusinessAssignments.live_trucks_now,
    );
    const forYouTruckItems = extractTrucks(
      scoutBusinessAssignments.food_trucks_today,
    );
    const openNowTruckCards = extractTrucks(
      scoutBusinessAssignments.open_now_near_you,
    );
    const openNowRestaurantCards = extractRestaurants(
      scoutBusinessAssignments.open_now_near_you,
    );
    const favoriteCards = extractRestaurants(
      scoutBusinessAssignments.saved_favorites,
    );
    const followingCards = extractRestaurants(
      scoutBusinessAssignments.following,
    );
    const orderAgainCards = scoutBusinessAssignments.order_again ?? [];
    const nearbyRestaurantCards = extractRestaurants(
      scoutBusinessAssignments.nearby_restaurants,
    );
    const trendingPlaceCards = extractRestaurants(
      scoutBusinessAssignments.trending_this_week,
    );
    const newToMealScoutCards = extractRestaurants(
      scoutBusinessAssignments.new_to_mealscout,
    );
    const communityPickCards = extractRestaurants(
      scoutBusinessAssignments.community_picks,
    );
    const worthDiscoveringCards =
      scoutBusinessAssignments.worth_discovering ?? [];
    const knownTruckIds = new Set(
      scoutTruckInventory.map((truck) => String(truck.id)),
    );
    const rankedPopularDishCandidates: LocalMenuItemFeedItem[] =
      popularDishes.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description ?? null,
        imageUrl: item.imageUrl ?? null,
        priceCents: item.priceCents ?? null,
        restaurantId: item.restaurantId,
        restaurantName: item.restaurantName ?? null,
        restaurantCity: item.restaurantCity ?? null,
        restaurantState: item.restaurantState ?? null,
        restaurantLogoUrl: item.restaurantLogoUrl ?? null,
        restaurantCoverImageUrl: item.restaurantCoverImageUrl ?? null,
        cuisineType: item.cuisineType ?? null,
        businessType:
          item.businessType ??
          (knownTruckIds.has(String(item.restaurantId))
            ? "food_truck"
            : null),
        isFoodTruck:
          item.isFoodTruck ?? knownTruckIds.has(String(item.restaurantId)),
      }));
    const claimedMenuHighlightBusinessKeys = new Set<string>();
    const distinctPrimaryDishCards = selectDistinctScoutMenuBusinesses(
      [...rankedPopularDishCandidates, ...localMenuItems],
      8,
      claimedMenuHighlightBusinessKeys,
    );
    const supplementalDishCandidates: LocalMenuItemFeedItem[] =
      showActivitySupplement
        ? activitySupplementDishes.map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description ?? null,
            imageUrl: item.imageUrl ?? null,
            priceCents: item.priceCents ?? null,
            restaurantId: item.restaurantId,
            restaurantName: item.restaurantName ?? null,
            restaurantCity: item.restaurantCity ?? null,
            restaurantState: item.restaurantState ?? null,
            restaurantLogoUrl: item.restaurantLogoUrl ?? null,
            restaurantCoverImageUrl: item.restaurantCoverImageUrl ?? null,
            cuisineType: item.cuisineType ?? null,
            businessType: item.businessType ?? null,
            isFoodTruck: item.isFoodTruck ?? null,
          }))
        : [];
    const distinctSupplementalDishCards = selectDistinctScoutMenuBusinesses(
      supplementalDishCandidates,
      Math.max(0, 8 - distinctPrimaryDishCards.length),
      claimedMenuHighlightBusinessKeys,
    );
    const hasMenuHighlightBusinessDiversity =
      claimedMenuHighlightBusinessKeys.size >=
      SCOUT_MIN_MENU_BUSINESS_DIVERSITY;
    const popularDishCards = hasMenuHighlightBusinessDiversity
      ? distinctPrimaryDishCards
      : [];
    const supplementalDishCards = hasMenuHighlightBusinessDiversity
      ? distinctSupplementalDishCards
      : [];

    const highPriorityDecisionItems: ScoutImmediateDecisionItem[] = [
      ...liveTruckCards.map((truck) => ({
        sourceRowId: "live_trucks_now" as const,
        sectionLabel: "Now Serving Trucks",
        summary: formatScoutCount(
          liveTruckCards.length,
          "truck serving now",
          "trucks serving now",
        ),
        cardType: "truck" as const,
        truck,
        businessKey: getScoutBusinessCardKey(truck, getTruckProfilePath(truck)),
      })),
      ...forYouTruckItems.map((truck) => ({
        sourceRowId: "food_trucks_today" as const,
        sectionLabel: "Food Trucks Today",
        summary: formatScoutCount(
          forYouTruckItems.length,
          "truck nearby today",
          "trucks nearby today",
        ),
        cardType: "truck" as const,
        truck,
        businessKey: getScoutBusinessCardKey(truck, getTruckProfilePath(truck)),
      })),
      ...openNowTruckCards.map((truck) => ({
        sourceRowId: "open_now_near_you" as const,
        sectionLabel: "Open Now",
        summary: formatScoutCount(
          openNowTruckCards.length + openNowRestaurantCards.length,
          "open nearby",
          "open nearby",
        ),
        cardType: "truck" as const,
        truck,
        businessKey: getScoutBusinessCardKey(truck, getTruckProfilePath(truck)),
      })),
      ...openNowRestaurantCards.map((restaurant) => ({
        sourceRowId: "open_now_near_you" as const,
        sectionLabel: "Open Nearby",
        summary: formatScoutCount(
          openNowTruckCards.length + openNowRestaurantCards.length,
          "open nearby",
          "open nearby",
        ),
        cardType: "restaurant" as const,
        restaurant,
        businessKey: getScoutBusinessCardKey(
          restaurant,
          getRestaurantProfilePath(restaurant),
        ),
      })),
      ...visibleHosts.map((host) => ({
        sourceRowId: "host_locations" as const,
        sectionLabel: "Host Locations",
        summary: formatScoutCount(
          visibleHosts.length,
          "host nearby",
          "hosts nearby",
        ),
        cardType: "host" as const,
        host,
      })),
      ...communityPickCards.map((restaurant) => ({
        sourceRowId: "community_picks" as const,
        sectionLabel: "Community Picks",
        summary: formatScoutCount(
          communityPickCards.length,
          "real community pick",
          "real community picks",
        ),
        cardType: "restaurant" as const,
        restaurant,
        businessKey: getScoutBusinessCardKey(
          restaurant,
          getRestaurantProfilePath(restaurant),
        ),
      })),
      ...trendingPlaceCards.map((restaurant) => ({
        sourceRowId: "trending_this_week" as const,
        sectionLabel: "Best Now",
        summary: formatScoutCount(
          trendingPlaceCards.length,
          "popular pick",
          "popular picks",
        ),
        cardType: "restaurant" as const,
        restaurant,
        businessKey: getScoutBusinessCardKey(
          restaurant,
          getRestaurantProfilePath(restaurant),
        ),
      })),
      ...newToMealScoutCards.map((restaurant) => ({
        sourceRowId: "new_to_mealscout" as const,
        sectionLabel: "Newest",
        summary: formatScoutCount(
          newToMealScoutCards.length,
          "new nearby listing",
          "new nearby listings",
        ),
        cardType: "restaurant" as const,
        restaurant,
        businessKey: getScoutBusinessCardKey(
          restaurant,
          getRestaurantProfilePath(restaurant),
        ),
      })),
      ...popularDishCards.map((item) => ({
        sourceRowId: "popular_dishes" as const,
        sectionLabel: "Menu Highlights",
        summary: formatScoutCount(
          popularDishCards.length,
          "popular dish",
          "popular dishes",
        ),
        cardType: "menu_item" as const,
        item,
      })),
      ...hotDealCandidates.map((deal) => ({
        sourceRowId: "hot_deals" as const,
        sectionLabel: "Deals",
        summary: formatScoutCount(
          hotDealCandidates.length,
          "active deal",
          "active deals",
        ),
        cardType: "deal" as const,
        deal,
      })),
      ...happyHourDeals.map((deal) => ({
        sourceRowId: "happy_hours" as const,
        sectionLabel: "Happy Hours",
        summary: formatScoutCount(
          happyHourDeals.length,
          "happy hour",
          "happy hours",
        ),
        cardType: "deal" as const,
        deal,
      })),
      ...visibleSceneEvents.map((event) => ({
        sourceRowId: "events_popups" as const,
        sectionLabel: "Events & Pop-Ups",
        summary: formatScoutCount(
          visibleSceneEvents.length,
          "nearby event",
          "nearby events",
        ),
        cardType: "event" as const,
        event,
      })),
    ];
    const nearbyOnlyDecisionItems: ScoutImmediateDecisionItem[] =
      highPriorityDecisionItems.length > 0
        ? []
        : nearbyRestaurantCards.map((restaurant) => {
            const openState = getRestaurantOpenState(restaurant);
            const summary =
              openState === "open"
                ? formatScoutCount(
                    nearbyRestaurantCards.length,
                    "open nearby",
                    "open nearby",
                  )
                : formatScoutCount(
                    nearbyRestaurantCards.length,
                    "nearby spot",
                    "nearby spots",
                  );
            return {
              sourceRowId: "nearby_restaurants" as const,
              sectionLabel: openState === "open" ? "Open Nearby" : "Nearby Now",
              summary,
              cardType: "restaurant" as const,
              restaurant,
              businessKey: getScoutBusinessCardKey(
                restaurant,
                getRestaurantProfilePath(restaurant),
              ),
            };
          });
    const firstScreenDecisionItems = [
      ...highPriorityDecisionItems,
      ...nearbyOnlyDecisionItems,
    ];
    const primaryFirstScreenDecision = firstScreenDecisionItems[0] ?? null;
    const truckFirstScreenLead =
      primaryFirstScreenDecision?.cardType === "truck" &&
      (primaryFirstScreenDecision.sourceRowId === "live_trucks_now" ||
        primaryFirstScreenDecision.sourceRowId === "food_trucks_today" ||
        primaryFirstScreenDecision.sourceRowId === "open_now_near_you");
    const popularDishesRailTitle = showActivityFallback
      ? fallbackSearchQuery.trim()
        ? "Related dishes beyond your area"
        : "Popular dishes beyond your area"
      : showActivitySupplement && popularDishCards.length === 0
        ? "Popular dishes across MealScout"
      : primaryFirstScreenDecision?.sourceRowId === "popular_dishes"
        ? "More Dishes Nearby"
        : truckFirstScreenLead
          ? "Food From Nearby Trucks"
          : DISCOVERY_LAYERS.menuItems.title;
    const foodTrucksTodayRailTitle =
      primaryFirstScreenDecision?.sourceRowId === "food_trucks_today"
        ? "More Food Trucks"
        : "Food Trucks Today";
    const foodTrucksTodayRailSubtitle =
      primaryFirstScreenDecision?.sourceRowId === "food_trucks_today"
        ? "Other scheduled trucks and open-now options."
        : "Scheduled trucks and open-now options.";
    const firstScreenSuppressedBusinessKey =
      primaryFirstScreenDecision?.cardType === "truck" ||
      primaryFirstScreenDecision?.cardType === "restaurant"
        ? primaryFirstScreenDecision.businessKey
        : null;
    const suppressFirstScreenBusiness = (card: ScoutRailRenderCard) => {
      if (!firstScreenSuppressedBusinessKey) return false;
      if (card.cardType === "truck") {
        return (
          getScoutBusinessCardKey(
            card.truck,
            getTruckProfilePath(card.truck),
          ) === firstScreenSuppressedBusinessKey
        );
      }
      if (card.cardType === "restaurant") {
        return (
          getScoutBusinessCardKey(
            card.restaurant,
            getRestaurantProfilePath(card.restaurant),
          ) === firstScreenSuppressedBusinessKey
        );
      }
      return false;
    };

    const hasForYouSections =
      visibleLocalActivityItems.length > 0 ||
      liveTruckCards.length > 0 ||
      openNowRestaurantCards.length > 0 ||
      forYouTruckItems.length > 0 ||
      favoriteCards.length > 0 ||
      followingCards.length > 0 ||
      orderAgainCards.length > 0 ||
      nearbyRestaurantCards.length > 0 ||
      trendingPlaceCards.length > 0 ||
      newToMealScoutCards.length > 0 ||
      popularDishCards.length > 0 ||
      hotDealCandidates.length > 0 ||
      happyHourDeals.length > 0 ||
      visibleSceneEvents.length > 0 ||
      visibleHosts.length > 0 ||
      communityPickCards.length > 0 ||
      worthDiscoveringCards.length > 0 ||
      rotatingSpots.length > 0;

    if (!hasForYouSections) {
      if (showActivityFallback) {
        return (
          <ScoutFallbackMarketNotice
            query={fallbackSearchQuery}
            hasResults={fallbackHasRelatedResults}
            onRequestPlace={onRequestPlace}
          />
        );
      }
      return (
        <>
          <ScoutFirstScreenDecisionStack
            readIncomplete={readIncomplete}
            items={firstScreenDecisionItems}
            thinMarket={
              !showActivityFallback &&
              !showActivitySupplement &&
              isLowActivityLane &&
              firstScreenDecisionItems.length <= 1
            }
          />
          {!readIncomplete && <ScoutSceneEmptyState laneId="for_you" />}
        </>
      );
    }

    const truckRailCards = (
      trucks: LiveTruckSummary[],
      scope: ScoutDiscoveryScope = "nearby",
    ): ScoutRailRenderCard[] =>
      trucks.map((truck) => ({
        cardType: "truck",
        cardKind: "food_truck",
        truck,
        viewModel: buildTruckResultViewModel(truck, scope),
      }));
    const restaurantRailCards = (
      restaurants: RestaurantSummary[],
      cardKind: "restaurant" | "community_pick" = "restaurant",
      scope: ScoutDiscoveryScope = "nearby",
    ): ScoutRailRenderCard[] =>
      restaurants.map((restaurant) => {
        return {
          cardType: "restaurant",
          cardKind,
          restaurant,
          viewModel: buildRestaurantResultViewModel(restaurant, scope),
        };
      });
    const menuItemRailCards = (
      items: LocalMenuItemFeedItem[],
      scope: ScoutDiscoveryScope = "nearby",
    ): ScoutRailRenderCard[] =>
      items.map((item, position) => ({
        cardType: "menu_item",
        cardKind: "menu_item",
        item,
        position,
        viewModel: buildMenuItemResultViewModel(item, scope),
      }));
    const dealRailCards = (
      deals: DealSummary[],
      cardKind: "deal" | "happy_hour" = "deal",
      scope: ScoutDiscoveryScope = "nearby",
    ): ScoutRailRenderCard[] =>
      deals.map((deal) => ({
        cardType: "deal",
        cardKind,
        deal,
        viewModel: buildDealResultViewModel(deal, scope),
      }));
    const eventRailCards = (
      events: EventSummary[],
      scope: ScoutDiscoveryScope = "nearby",
    ): ScoutRailRenderCard[] =>
      events.map((event) => ({
        cardType: "event",
        cardKind: "event",
        event,
        viewModel: buildEventResultViewModel(event, scope),
      }));
    const businessSectionRailCards = (
      cards: ScoutBusinessSectionCard[],
    ): ScoutRailRenderCard[] =>
      cards.map((card) =>
        card.cardType === "truck"
          ? truckRailCards([card.truck])[0]!
          : {
              ...restaurantRailCards([card.restaurant])[0]!,
            },
      );

    const baseScoutRows: ScoutHorizontalRailDefinition[] = [
        {
          id: "live_trucks_now",
          title: "Now Serving Trucks",
          subtitle: "Food trucks currently serving nearby.",
          linkHref: DISCOVERY_LAYERS.foodTrucks.href,
          cards: truckRailCards(liveTruckCards),
          className: railSectionClass,
          cardWidth: truckCardWidth,
        },
        {
          id: "food_trucks_today",
          title: foodTrucksTodayRailTitle,
          subtitle: foodTrucksTodayRailSubtitle,
          linkHref: DISCOVERY_LAYERS.foodTrucks.href,
          cards: truckRailCards(forYouTruckItems),
          className: railSectionClass,
          cardWidth: truckCardWidth,
        },
        {
          id: "open_now_near_you",
          title: "Open Now Near You",
          subtitle: "Open restaurants and serving trucks near your location.",
          linkHref: DISCOVERY_LAYERS.restaurants.href,
          cards: [
            ...truckRailCards(openNowTruckCards),
            ...restaurantRailCards(openNowRestaurantCards),
          ],
          className: railSectionClass,
          cardWidth: standardCardWidth,
        },
        {
          id: "saved_favorites",
          title: "Your Favorites",
          subtitle:
            "Saved spots near this Scout area that are not already shown above.",
          linkHref: "/favorites",
          cards: restaurantRailCards(favoriteCards),
          className: compactRailSectionClass,
          cardWidth: standardCardWidth,
        },
        {
          id: "following",
          title: "Following",
          subtitle: "Places you follow near this Scout area.",
          linkHref: "/favorites",
          cards: restaurantRailCards(followingCards),
          className: compactRailSectionClass,
          cardWidth: standardCardWidth,
        },
        {
          id: "order_again",
          title: "Order Again",
          subtitle:
            "Past orders will appear here when real order history is available.",
          linkHref: "/orders",
          cards: businessSectionRailCards(orderAgainCards),
          className: compactRailSectionClass,
          cardWidth: standardCardWidth,
        },
        {
          id: "popular_dishes",
          title: popularDishesRailTitle,
          subtitle: undefined,
          linkHref: DISCOVERY_LAYERS.menuItems.href,
          cards: menuItemRailCards(
            popularDishCards,
            showActivityFallback ? "network" : "nearby",
          ).concat(menuItemRailCards(supplementalDishCards, "network")),
          className: railSectionClass,
          cardWidth: featureCardWidth,
        },
        {
          id: "hot_deals",
          title: DISCOVERY_LAYERS.deals.title,
          subtitle: DISCOVERY_LAYERS.deals.subtitle,
          linkHref: DISCOVERY_LAYERS.deals.href,
          cards: dealRailCards(hotDealCandidates),
          className: railSectionClass,
          cardWidth: featureCardWidth,
        },
        {
          id: "happy_hours",
          title: "Happy Hours",
          subtitle: "Deals explicitly marked as happy hour nearby.",
          linkHref: DISCOVERY_LAYERS.deals.href,
          cards: dealRailCards(happyHourDeals, "happy_hour"),
          className: compactRailSectionClass,
          cardWidth: featureCardWidth,
        },
        {
          id: "events_popups",
          title: DISCOVERY_LAYERS.events.title,
          subtitle: "Pop-ups and food events near this Scout area.",
          linkHref: DISCOVERY_LAYERS.events.href,
          cards: eventRailCards(visibleSceneEvents),
          className: railSectionClass,
          cardWidth: featureCardWidth,
        },
        {
          id: "nearby_restaurants",
          title: showActivityFallback
            ? fallbackSearchQuery.trim()
              ? "Related places beyond your area"
              : "Popular beyond your area"
            : DISCOVERY_LAYERS.restaurants.title,
          subtitle: showActivityFallback
            ? fallbackSearchQuery.trim()
              ? "Farther-away places that clearly match the search."
              : "Farther-away picks shown because nothing matched nearby."
            : DISCOVERY_LAYERS.restaurants.subtitle,
          linkHref: DISCOVERY_LAYERS.restaurants.href,
          cards: restaurantRailCards(
            nearbyRestaurantCards,
            "restaurant",
            showActivityFallback ? "network" : "nearby",
          ),
          className: railSectionClass,
          cardWidth: standardCardWidth,
        },
        {
          id: "trending_this_week",
          title: showActivitySupplement
            ? "Trending across MealScout"
            : showActivityFallback
            ? fallbackSearchQuery.trim()
              ? "Related activity beyond your area"
              : "Trending beyond your area"
            : "Local Activity",
          subtitle: showActivitySupplement
            ? "Outside your area, shown because nearby activity is limited."
            : showActivityFallback
            ? fallbackSearchQuery.trim()
              ? "These farther-away picks match the search."
              : "These are not nearby; they are fallback discovery picks."
            : undefined,
          linkHref: DISCOVERY_LAYERS.trending.href,
          cards: restaurantRailCards(
            trendingPlaceCards,
            "restaurant",
            showActivityFallback ? "network" : "nearby",
          ).concat(
            restaurantRailCards(
              showActivitySupplement ? activitySupplementRestaurants : [],
              "restaurant",
              "network",
            ),
          ),
          className: compactRailSectionClass,
          cardWidth: standardCardWidth,
        },
        {
          id: "new_to_mealscout",
          title: "Newest on MealScout",
          subtitle: "Fresh local listings recently added nearby.",
          linkHref: "/search",
          cards: restaurantRailCards(newToMealScoutCards),
          className: compactRailSectionClass,
          cardWidth: standardCardWidth,
        },
        {
          id: "community_picks",
          title: DISCOVERY_LAYERS.localBoard.title,
          subtitle: undefined,
          linkHref: DISCOVERY_LAYERS.localBoard.href,
          cards: restaurantRailCards(communityPickCards, "community_pick"),
          className: compactRailSectionClass,
          cardWidth: standardCardWidth,
        },
        {
          id: "worth_discovering",
          title: "Worth Discovering",
          subtitle:
            "Quiet nearby food spots not already shown in your top picks.",
          linkHref: DISCOVERY_LAYERS.restaurants.href,
          cards: businessSectionRailCards(worthDiscoveringCards),
          className: compactRailSectionClass,
          cardWidth: standardCardWidth,
        },
    ];

    const claimedBaseBusinessKeys = new Set<string>();
    baseScoutRows.forEach((row) => {
      row.cards.forEach((card) => {
        if (card.cardType === "truck") {
          const key = getScoutBusinessCardKey(
            card.truck,
            getTruckProfilePath(card.truck),
          );
          if (key) claimedBaseBusinessKeys.add(key);
          return;
        }
        if (card.cardType === "restaurant") {
          const key = getScoutBusinessCardKey(
            card.restaurant,
            getRestaurantProfilePath(card.restaurant),
          );
          if (key) claimedBaseBusinessKeys.add(key);
          return;
        }
        if (card.cardType === "menu_item") {
          const key = getScoutMenuItemBusinessKey(card.item);
          if (key) claimedBaseBusinessKeys.add(key);
        }
      });
    });
    const claimedFallbackBusinessKeys = new Set<string>();
    const rotatingSpotsForRow = (rowId: ScoutHorizontalRowId) => {
      if (rowId === "food_trucks_today" || rowId === "community_picks") {
        return [];
      }
      if (rowId === "nearby_restaurants" || rowId === "happy_hours") {
        return rotatingSpots.filter(
          (spot) =>
            getScoutRestaurantLikeKind(spot.restaurant) === "restaurant",
        );
      }
      return rotatingSpots;
    };
    const emptyRowsEligibleForRotation = new Set(
      baseScoutRows
        .filter(
          (row) =>
            row.cards.length === 0 &&
            Boolean(scoutRotatingRowFallbackCopy[row.id]) &&
            rotatingSpotsForRow(row.id).length > 0,
        )
        .map((row) => row.id),
    );
    const rowsWithRotatingFallback = baseScoutRows.map((row) => {
      if (!emptyRowsEligibleForRotation.has(row.id)) {
        return row;
      }
      const copy = scoutRotatingRowFallbackCopy[row.id];
      if (!copy) return row;
      const rowSpotPool = rotateScoutSpots(
        rotatingSpotsForRow(row.id),
        `fallback-spots:${row.id}:${spotRotationBucket}`,
        (spot) =>
          getScoutBusinessCardKey(
            spot.restaurant,
            getRestaurantProfilePath(spot.restaurant),
          ),
        SCOUT_ROTATING_SPOT_LIMIT,
      );
      const unseenEverywhereSpots = rowSpotPool.filter((spot) => {
        const key = getScoutBusinessCardKey(
          spot.restaurant,
          getRestaurantProfilePath(spot.restaurant),
        );
        return (
          !key ||
          (!claimedBaseBusinessKeys.has(key) &&
            !claimedFallbackBusinessKeys.has(key))
        );
      });
      const fallbackCards = unseenEverywhereSpots
        .slice(0, 4)
        .map(
          (spot) =>
            restaurantRailCards(
              [spot.restaurant],
              "restaurant",
              spot.scope,
            )[0]!,
        );
      if (fallbackCards.length === 0) return row;
      fallbackCards.forEach((card) => {
        if (card.cardType !== "restaurant") return;
        const key = getScoutBusinessCardKey(
          card.restaurant,
          getRestaurantProfilePath(card.restaurant),
        );
        if (key) claimedFallbackBusinessKeys.add(key);
      });
      return {
        ...row,
        title: copy.title,
        subtitle: copy.subtitle,
        linkHref: "/search",
        cards: fallbackCards,
        rotatingFallbackFor: row.id,
      };
    });

    const scoutRows = rowsWithRotatingFallback
      .sort((a, b) => {
        const activitySupplementPriority: Partial<
          Record<ScoutHorizontalRowId, number>
        > = showActivitySupplement
          ? {
              popular_dishes: -2,
              trending_this_week: -1,
            }
          : {};
        const restaurantSearchPriority: Partial<
          Record<ScoutHorizontalRowId, number>
        > =
          scoutSearchMode && scoutSearchIntent === "restaurants"
            ? {
                live_trucks_now: 1,
                nearby_restaurants: 2,
                open_now_near_you: 3,
              }
            : {};
        return (
          (activitySupplementPriority[a.id] ??
            restaurantSearchPriority[a.id] ??
            scoutHorizontalRowMeta.get(a.id)?.priority ??
            999) -
          (activitySupplementPriority[b.id] ??
            restaurantSearchPriority[b.id] ??
            scoutHorizontalRowMeta.get(b.id)?.priority ??
            999)
        );
      })
      .map((row) => ({
        ...row,
        cards: row.cards.filter((card) => !suppressFirstScreenBusiness(card)),
      }));

    const renderScoutRailCard = (card: ScoutRailRenderCard) => {
      if (card.cardType === "truck") {
        return card.cardKind === "food_truck" &&
          isTruckServingNow(card.truck) ? (
          <LiveTruckCard
            truck={card.truck}
            viewModel={card.viewModel}
            currentUserId={currentUserId}
            relationshipSnapshot={restaurantRelationships}
          />
        ) : (
          <TruckCard
            truck={card.truck}
            viewModel={card.viewModel}
            currentUserId={currentUserId}
          />
        );
      }
      if (card.cardType === "restaurant") {
        return (
          <NearbyRestaurantCard
            restaurant={card.restaurant}
            viewModel={card.viewModel}
            menuPreview={
              menuPreviewByRestaurantId.get(String(card.restaurant.id)) ?? []
            }
            isSignedIn={isSignedIn}
            currentUserId={currentUserId}
            relationshipSnapshot={restaurantRelationships}
          />
        );
      }
      if (card.cardType === "menu_item") {
        return (
          <LocalMenuItemCard
            item={card.item}
            viewModel={card.viewModel}
            position={card.position}
            currentUserId={currentUserId}
          />
        );
      }
      if (card.cardType === "deal") {
        return (
          <DealCard
            deal={card.deal}
            viewModel={card.viewModel}
            currentUserId={currentUserId}
          />
        );
      }
      if (card.cardType === "event") {
        return (
          <EventCard
            event={card.event}
            viewModel={card.viewModel}
            currentUserId={currentUserId}
          />
        );
      }
      return null;
    };

    return (
      <>
        {showActivityFallback ? (
          <ScoutFallbackMarketNotice
            query={fallbackSearchQuery}
            hasResults={fallbackHasRelatedResults}
            nearbyResultCount={0}
            onRequestPlace={onRequestPlace}
          />
        ) : null}
        <div
          className={
            showActivitySupplement
              ? "sm:grid sm:grid-cols-2 sm:gap-3 sm:px-4"
              : undefined
          }
          data-scout-first-screen-layout={
            showActivitySupplement ? "local-plus-network" : "local"
          }
        >
          <ScoutFirstScreenDecisionStack
            readIncomplete={readIncomplete}
            items={firstScreenDecisionItems}
            thinMarket={
              !showActivityFallback &&
              !showActivitySupplement &&
              isLowActivityLane &&
              firstScreenDecisionItems.length <= 1
            }
          />
          {showActivitySupplement ? (
            <ScoutFallbackMarketNotice
              query=""
              hasResults={true}
              nearbyResultCount={nearbyResultCount}
              onRequestPlace={onRequestPlace}
            />
          ) : null}
        </div>
        {scoutRows.map((row) => (
          <ScoutHorizontalCategoryRail
            key={row.id}
            row={row}
            renderCard={renderScoutRailCard}
            onOpenAll={
              onOpenResultsSheet
                ? (openedRow) =>
                    onOpenResultsSheet({
                      title: openedRow.title,
                      subtitle: openedRow.subtitle,
                      items: openedRow.cards,
                      renderItem: (card: ScoutRailRenderCard) =>
                        renderScoutRailCard(card),
                      getKey: (card: ScoutRailRenderCard, index: number) =>
                        `${card.cardType}-${getScoutRailCardKey(card)}-${index}`,
                    })
                : undefined
            }
          />
        ))}
      </>
    );
  }

  if (laneId === "community") {
    if (topLocalFavoriteRestaurants.length > 0) {
      return (
        <section className={compactRailSectionClass}>
          <SectionHeader
            title={DISCOVERY_LAYERS.localBoard.title}
            linkHref={DISCOVERY_LAYERS.localBoard.href}
            itemCount={topLocalFavoriteRestaurants.length}
          />
          <div className="overflow-x-auto atmo-hide-scrollbar -mr-1">
            <ul
              className="flex gap-4 pr-5"
              role="list"
              aria-label="Top local favorites"
            >
              {topLocalFavoriteRestaurants.slice(0, 10).map((restaurant) => (
                <li
                  key={`local-favorite-${restaurant.id}`}
                  className={`shrink-0 ${standardCardWidth}`}
                >
                  <SavedRestaurantCard restaurant={restaurant} />
                </li>
              ))}
            </ul>
          </div>
        </section>
      );
    }
    return readIncomplete ? null : <ScoutSceneEmptyState laneId="community" />;
  }

  return (
    <>
      {laneId === "nearby_now" && visibleLocalActivityItems.length > 0 ? (
        <LocalActivityRail
          mode={scoutActivityMode}
          items={visibleLocalActivityItems}
          onOpenResultsSheet={onOpenResultsSheet}
        />
      ) : null}

      {(laneId === "nearby_now" || laneId === "food_trucks") &&
      visibleTrucksServingNow.length > 0 ? (
        <section className={railSectionClass}>
          <SectionHeader
            title={laneFoodTrucksTitle}
            linkHref={DISCOVERY_LAYERS.foodTrucks.href}
            subtitle={DISCOVERY_LAYERS.foodTrucks.subtitle}
            itemCount={visibleTrucksServingNow.length}
            onSeeAll={
              onOpenResultsSheet
                ? () =>
                    onOpenResultsSheet({
                      title: laneFoodTrucksTitle,
                      subtitle: DISCOVERY_LAYERS.foodTrucks.subtitle,
                      items: visibleTrucksServingNow,
                      renderItem: (t) => (
                        <TruckCard
                          truck={t}
                          onSelect={selectLiveTruck}
                          currentUserId={currentUserId}
                        />
                      ),
                      getKey: (t) => String(t.id),
                    })
                : undefined
            }
          />
          {liveTrucksLoading && visibleTrucksServingNow.length === 0 ? (
            <HorizontalSkeletonRow count={3} width={200} />
          ) : (
            <div className="overflow-x-auto atmo-hide-scrollbar -mr-1">
              <ul
                className="flex gap-4 pr-5"
                role="list"
                aria-label="Food trucks near you"
              >
                {visibleTrucksServingNow.slice(0, 12).map((t) => (
                  <li key={t.id} className={`shrink-0 ${truckCardWidth}`}>
                    <TruckCard
                      truck={t}
                      onSelect={selectLiveTruck}
                      currentUserId={currentUserId}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ) : null}

      {(laneId === "nearby_now" ||
        laneId === "restaurants" ||
        laneId === "late_night") && (
        <section className={railSectionClass}>
          <SectionHeader
            title={laneRestaurantsTitle}
            linkHref={DISCOVERY_LAYERS.restaurants.href}
            subtitle={restaurantsRailSubtitle}
            itemCount={visibleOpenRestaurants.length}
            onSeeAll={
              onOpenResultsSheet
                ? () =>
                    onOpenResultsSheet({
                      title: laneRestaurantsTitle,
                      subtitle: restaurantsRailSubtitle,
                      items: visibleOpenRestaurants,
                      renderItem: (r) => (
                        <NearbyRestaurantCard
                          restaurant={r}
                          menuPreview={
                            menuPreviewByRestaurantId.get(String(r.id)) ?? []
                          }
                          isSignedIn={isSignedIn}
                          currentUserId={currentUserId}
                          relationshipSnapshot={restaurantRelationships}
                        />
                      ),
                      getKey: (r) => String(r.id),
                    })
                : undefined
            }
          />
          {nearbyRestaurantsLoading && visibleOpenRestaurants.length === 0 ? (
            <HorizontalSkeletonRow count={3} width={200} />
          ) : (
            <div className="overflow-x-auto atmo-hide-scrollbar -mr-1">
              <ul
                className="flex gap-4 pr-5"
                role="list"
                aria-label="Restaurants open now"
              >
                {visibleOpenRestaurants.slice(0, 10).map((r) => (
                  <li key={r.id} className={`shrink-0 ${standardCardWidth}`}>
                    <NearbyRestaurantCard
                      restaurant={r}
                      menuPreview={
                        menuPreviewByRestaurantId.get(String(r.id)) ?? []
                      }
                      isSignedIn={isSignedIn}
                      currentUserId={currentUserId}
                      relationshipSnapshot={restaurantRelationships}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {(laneId === "nearby_now" || laneId === "deals") &&
      visibleDeals.length > 0 ? (
        <section className={railSectionClass}>
          <SectionHeader
            title={laneDealsTitle}
            linkHref={DISCOVERY_LAYERS.deals.href}
            subtitle={DISCOVERY_LAYERS.deals.subtitle}
            itemCount={visibleDeals.length}
          />
          <div className="overflow-x-auto atmo-hide-scrollbar -mr-1">
            <ul className="flex gap-4 pr-5" role="list">
              {visibleDeals.slice(0, 10).map((d) => (
                <li key={d.id} className={`shrink-0 ${featureCardWidth}`}>
                  <DealCard deal={d} currentUserId={currentUserId} />
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {(laneId === "nearby_now" || laneId === "events") &&
      visibleSceneEvents.length > 0 ? (
        <section className={railSectionClass}>
          <SectionHeader
            title={laneEventsTitle}
            linkHref={DISCOVERY_LAYERS.events.href}
            subtitle={eventsRailSubtitle}
            itemCount={visibleSceneEvents.length}
          />
          <div className="overflow-x-auto atmo-hide-scrollbar -mr-1">
            <ul className="flex gap-4 pr-5" role="list">
              {visibleSceneEvents.slice(0, 8).map((e) => (
                <li key={e.id} className={`shrink-0 ${featureCardWidth}`}>
                  <EventCard event={e} currentUserId={currentUserId} />
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {laneId === "new_menus" && hasNewMenuBusinessDiversity ? (
        <section className={railSectionClass}>
          <SectionHeader
            title="New Menus"
            linkHref={DISCOVERY_LAYERS.menuItems.href}
            subtitle="Fresh menu items and recent local updates."
            itemCount={distinctNewMenuItems.length}
            onSeeAll={
              onOpenResultsSheet
                ? () =>
                    onOpenResultsSheet({
                      title: "New Menus",
                      subtitle: "Fresh menu items and recent local updates.",
                      items: distinctNewMenuItems,
                      renderItem: (item, index) => (
                        <LocalMenuItemCard
                          item={item}
                          position={index}
                          currentUserId={currentUserId}
                        />
                      ),
                      getKey: (item) => String(item.id),
                    })
                : undefined
            }
          />
          <div className="overflow-x-auto atmo-hide-scrollbar -mr-1">
            <ul className="flex gap-4 pr-5" role="list" aria-label="New menus">
              {distinctNewMenuItems.map((item, index) => (
                <li
                  key={`menu-item-${item.id}`}
                  className={`shrink-0 ${featureCardWidth}`}
                >
                  <LocalMenuItemCard
                    item={item}
                    position={index}
                    currentUserId={currentUserId}
                  />
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {laneId === "new_menus" &&
      !hasNewMenuBusinessDiversity &&
      newMenuFallbackSpots.length > 0 ? (
        <section
          className={railSectionClass}
          data-scout-row-fallback="new_menus"
        >
          <SectionHeader
            title="Food Businesses to Explore"
            linkHref="/search"
            subtitle="Local menus are still filling in."
            itemCount={newMenuFallbackSpots.length}
          />
          <div className="overflow-x-auto atmo-hide-scrollbar -mr-1">
            <ul
              className="flex gap-4 pr-5"
              role="list"
              aria-label="Rotating food spots"
            >
              {newMenuFallbackSpots.map((spot) => (
                <li
                  key={`new-menu-fallback-${
                    getScoutBusinessCardKey(
                      spot.restaurant,
                      getRestaurantProfilePath(spot.restaurant),
                    ) || spot.restaurant.id
                  }`}
                  className={`shrink-0 ${standardCardWidth}`}
                >
                  <NearbyRestaurantCard
                    restaurant={spot.restaurant}
                    viewModel={buildRestaurantResultViewModel(
                      spot.restaurant,
                      spot.scope,
                    )}
                    menuPreview={
                      menuPreviewByRestaurantId.get(
                        String(spot.restaurant.id),
                      ) ?? []
                    }
                    isSignedIn={isSignedIn}
                    currentUserId={currentUserId}
                    relationshipSnapshot={restaurantRelationships}
                  />
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {(laneId === "worth_discovering" || laneId === "late_night") &&
      visibleMoreFoodRestaurants.length > 0 ? (
        <section className={compactRailSectionClass}>
          <SectionHeader
            title={laneMoreTitle}
            linkHref={DISCOVERY_LAYERS.restaurants.href}
            subtitle={moreRailSubtitle}
            itemCount={visibleMoreFoodRestaurants.length}
            onSeeAll={
              onOpenResultsSheet
                ? () =>
                    onOpenResultsSheet({
                      title: laneMoreTitle,
                      subtitle: moreRailSubtitle,
                      items: visibleMoreFoodRestaurants,
                      renderItem: (r) => <SavedRestaurantCard restaurant={r} />,
                      getKey: (r) => String(r.id),
                    })
                : undefined
            }
          />
          <div className="overflow-x-auto atmo-hide-scrollbar -mr-1">
            <ul
              className="flex gap-4 pr-5"
              role="list"
              aria-label="Worth discovering"
            >
              {visibleMoreFoodRestaurants.slice(0, 10).map((r) => (
                <li
                  key={`restaurant-worth-${r.id}`}
                  className={`shrink-0 ${standardCardWidth}`}
                >
                  <SavedRestaurantCard restaurant={r} />
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {laneId === "late_night" && openingLaterRestaurants.length > 0 ? (
        <section className={compactRailSectionClass}>
          <SectionHeader
            title="Opening Later"
            linkHref={DISCOVERY_LAYERS.restaurants.href}
            subtitle="Places nearby that are closed right now but worth checking soon."
            itemCount={openingLaterRestaurants.length}
            onSeeAll={
              onOpenResultsSheet
                ? () =>
                    onOpenResultsSheet({
                      title: "Opening Later",
                      subtitle:
                        "Places nearby that are closed right now but worth checking soon.",
                      items: openingLaterRestaurants,
                      renderItem: (r) => <SavedRestaurantCard restaurant={r} />,
                      getKey: (r) => String(r.id),
                    })
                : undefined
            }
          />
          <div className="overflow-x-auto atmo-hide-scrollbar -mr-1">
            <ul
              className="flex gap-4 pr-5"
              role="list"
              aria-label="Opening later"
            >
              {openingLaterRestaurants.slice(0, 10).map((r) => (
                <li
                  key={`restaurant-later-${r.id}`}
                  className={`shrink-0 ${standardCardWidth}`}
                >
                  <SavedRestaurantCard restaurant={r} />
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {(laneId === "food_trucks" && visibleTrucksServingNow.length === 0) ||
      (laneId === "restaurants" && visibleOpenRestaurants.length === 0) ||
      (laneId === "deals" && visibleDeals.length === 0) ||
      (laneId === "events" &&
        visibleSceneEvents.length === 0 &&
        visibleHosts.length === 0) ||
      (laneId === "new_menus" &&
        !hasNewMenuBusinessDiversity &&
        newMenuFallbackSpots.length === 0) ||
      (laneId === "late_night" &&
        visibleOpenRestaurants.length === 0 &&
        visibleMoreFoodRestaurants.length === 0) ||
      (laneId === "worth_discovering" &&
        visibleMoreFoodRestaurants.length === 0) ||
      (laneId === "nearby_now" &&
        visibleLocalActivityItems.length === 0 &&
        visibleTrucksServingNow.length === 0 &&
        visibleOpenRestaurants.length === 0 &&
        visibleDeals.length === 0 &&
        visibleSceneEvents.length === 0 &&
        visibleHosts.length === 0) ? (
        !readIncomplete && <ScoutSceneEmptyState laneId={laneId} />
      ) : null}
    </>
  );
}

function SpatialDecisionRail({
  decisions,
  selectedMarkerId,
  onSelect,
  onExpandMap,
}: {
  decisions: Array<{ item: CravingBoardItem; marker: MapAdapterMarker }>;
  selectedMarkerId: string | null;
  onSelect: (marker: MapAdapterMarker) => void;
  onExpandMap: () => void;
}) {
  const scrollFrameRef = useRef<number | null>(null);
  if (decisions.length === 0) return null;
  const actionLabel = (item: CravingBoardItem) => {
    if (item.kind === "Menu") return "View menu";
    if (item.kind === "Truck") return "Follow truck";
    if (item.kind === "Deal") return "View deal";
    if (item.kind === "Event") return "View event";
    return "Open profile";
  };

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-20 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:left-auto md:right-4 md:w-[min(430px,42%)]"
      data-testid="scout-spatial-decision-rail"
    >
      <div className="mb-2 flex items-center justify-between px-3 md:px-0">
        <p className="text-[11px] font-black uppercase tracking-[0.13em] text-orange-100/90">
          Eat around here
        </p>
        <button
          type="button"
          onClick={onExpandMap}
          className="inline-flex items-center gap-1 rounded-full bg-[#fff7ed]/92 px-3 py-1.5 text-[11px] font-black text-[#5b230e] shadow-lg ring-1 ring-white/70 transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300 motion-reduce:transition-none"
        >
          <Maximize2 className="h-3 w-3" aria-hidden="true" />
          Expand map
        </button>
      </div>
      <ul
        className="flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-3 pb-1 [scrollbar-width:none] md:flex-col md:overflow-visible md:px-0"
        aria-label="Food shown on the map"
        role="listbox"
        onScroll={(event) => {
          if (scrollFrameRef.current !== null) {
            window.cancelAnimationFrame(scrollFrameRef.current);
          }
          const rail = event.currentTarget;
          scrollFrameRef.current = window.requestAnimationFrame(() => {
            const center = rail.getBoundingClientRect().left + rail.clientWidth / 2;
            const cards = Array.from(
              rail.querySelectorAll<HTMLElement>("[data-spatial-marker-id]"),
            );
            const nearest = cards.sort((a, b) => {
              const aRect = a.getBoundingClientRect();
              const bRect = b.getBoundingClientRect();
              return (
                Math.abs(aRect.left + aRect.width / 2 - center) -
                Math.abs(bRect.left + bRect.width / 2 - center)
              );
            })[0];
            const markerId = nearest?.dataset.spatialMarkerId;
            const decision = decisions.find(
              ({ marker }) => marker.id === markerId,
            );
            if (decision && decision.marker.id !== selectedMarkerId) {
              onSelect(decision.marker);
            }
          });
        }}
      >
        {decisions.map(({ item, marker }) => {
          const selected = marker.id === selectedMarkerId;
          const price =
            typeof item.priceCents === "number"
              ? `$${(item.priceCents / 100).toFixed(2)}`
              : null;
          const statusDotClass =
            item.freshnessMeta?.isOpen === true
              ? "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.7)]"
              : item.kind === "Deal"
                ? "bg-lime-300"
                : item.kind === "Event"
                  ? "bg-sky-300"
                  : "bg-orange-300";
          const statusLabel =
            item.freshnessMeta?.isOpen === true
              ? item.kind === "Truck"
                ? item.reason || "Serving now"
                : "Open now"
              : item.reason || "Nearby";
          return (
            <li
              key={`${item.id}-${marker.id}`}
              className={`w-[86vw] max-w-[370px] shrink-0 snap-center md:w-full ${
                selected ? "md:block" : "md:hidden"
              }`}
              role="option"
              aria-selected={selected}
              data-spatial-marker-id={marker.id}
            >
              <article
                tabIndex={0}
                onClick={() => onSelect(marker)}
                onFocus={() => onSelect(marker)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(marker);
                  }
                }}
                className={`flex min-h-[112px] cursor-pointer gap-3 overflow-hidden rounded-[1.35rem] p-2.5 text-white backdrop-blur-xl transition duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-200 motion-reduce:transition-none ${
                  selected
                    ? "translate-y-0 bg-[#32190d]/96 ring-2 ring-orange-300 shadow-[0_18px_40px_rgba(0,0,0,0.48),0_0_24px_rgba(255,111,45,0.22)]"
                    : "bg-[#160e09]/88 ring-1 ring-white/14 opacity-90"
                }`}
                data-testid={`scout-spatial-decision-${marker.id}`}
              >
                <div className="h-[92px] w-[92px] shrink-0 overflow-hidden rounded-2xl bg-orange-100/10 ring-1 ring-orange-100/20">
                  {item.imageUrl ? (
                    <img
                      src={item.imageUrl}
                      alt=""
                      className="h-full w-full object-cover"
                      loading="eager"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center bg-gradient-to-br from-orange-500/40 to-amber-200/10">
                      <Utensils className="h-7 w-7 text-orange-100" aria-hidden="true" />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1 py-0.5">
                  <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.1em] text-orange-200">
                    <span
                      className={`h-2 w-2 rounded-full ${statusDotClass}`}
                      aria-hidden="true"
                    />
                    {statusLabel}
                  </div>
                  <h2 className="mt-1 truncate text-lg font-black leading-tight">
                    {item.title}
                  </h2>
                  <p className="mt-0.5 truncate text-xs font-semibold text-white/70">
                    {item.subtitle}
                  </p>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-bold text-white/68">
                      {[item.meta, price].filter(Boolean).join(" · ")}
                    </span>
                    <Link
                      href={item.href}
                      onClick={(event) => event.stopPropagation()}
                      className="shrink-0 rounded-full bg-[#ff6a35] px-3 py-1.5 text-[11px] font-black text-white shadow-sm ring-1 ring-orange-100/30 hover:bg-[#ff7b4d] focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    >
                      {actionLabel(item)}
                    </Link>
                  </div>
                </div>
              </article>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SceneMixedFeed({ items }: { items: CravingBoardItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="px-4 pb-4">
      <ul
        className="space-y-2.5"
        role="list"
        aria-label="Today around you picks"
      >
        {items.map((item) => (
          <li key={item.id}>
            <SceneMixedFeedCard item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function SceneMixedFeedCard({ item }: { item: CravingBoardItem }) {
  const kindColor =
    item.kind === "Truck"
      ? "text-orange-200"
      : item.kind === "Menu"
        ? "text-orange-300"
        : item.kind === "Deal"
          ? "text-lime-300"
          : item.kind === "Event"
            ? "text-sky-300"
            : "text-orange-300";
  const badge =
    item.kind === "Truck"
      ? "Food truck"
      : item.kind === "Menu"
        ? "Menu item"
        : item.kind === "Deal"
          ? "Deal today"
          : item.kind === "Event"
            ? "Event today"
            : "Restaurant";
  const freshnessMeta = item.freshnessMeta || { kind: "restaurant" as const };
  const badges = [item.reason, ...getOperationalBadges(freshnessMeta)]
    .filter((label): label is string => Boolean(label))
    .filter((label, index, all) => all.indexOf(label) === index)
    .slice(0, 1);
  const shellClass =
    item.kind === "Menu"
      ? "rounded-[0.85rem] bg-[#2c1609]/82 ring-orange-200/25 hover:bg-[#351a0a]/92 hover:ring-orange-200/50"
      : item.kind === "Truck"
        ? "rounded-[1.35rem] bg-[#100806]/84 ring-orange-200/18 hover:bg-[#1a0d07]/92 hover:ring-orange-200/28"
        : item.kind === "Deal"
          ? "rounded-xl bg-[#12200f]/72 ring-lime-200/20 hover:bg-[#172913]/86 hover:ring-lime-200/30"
          : item.kind === "Event"
            ? "rounded-xl bg-[#0d1724]/72 ring-sky-200/20 hover:bg-[#111e2f]/86 hover:ring-sky-200/30"
            : "rounded-xl bg-[#0c1714]/78 ring-emerald-200/20 hover:bg-[#121f1b]/88 hover:ring-emerald-200/30";
  const thumbClass =
    item.kind === "Menu"
      ? "rounded-full bg-orange-200/10 ring-orange-100/25"
      : item.kind === "Truck"
        ? "rounded-2xl bg-orange-200/8 ring-orange-300/25"
        : item.kind === "Deal"
          ? "rounded-lg bg-lime-200/8 ring-lime-200/20"
          : item.kind === "Event"
            ? "rounded-lg bg-sky-200/8 ring-sky-200/20"
            : "rounded-lg bg-emerald-200/8 ring-emerald-200/20";

  return (
    <Link
      href={item.href}
      className={`relative flex items-center gap-3 overflow-hidden px-3 py-2.5 text-white ring-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70 ${shellClass}`}
    >
      {item.kind === "Menu" ? (
        <span
          className="absolute inset-x-3 bottom-0 border-t border-dashed border-orange-100/20"
          aria-hidden="true"
        />
      ) : null}
      <div
        className={`h-16 w-16 shrink-0 overflow-hidden ring-1 ${thumbClass}`}
      >
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            {item.kind === "Truck" ? (
              <TruckIcon
                className="h-5 w-5 text-orange-200/70"
                aria-hidden="true"
              />
            ) : item.kind === "Deal" ? (
              <Tag className="h-5 w-5 text-lime-200/70" aria-hidden="true" />
            ) : item.kind === "Event" ? (
              <CalendarDays
                className="h-5 w-5 text-sky-200/70"
                aria-hidden="true"
              />
            ) : item.kind === "Place" ? (
              <MapPin
                className="h-5 w-5 text-emerald-200/70"
                aria-hidden="true"
              />
            ) : (
              <Utensils
                className="h-5 w-5 text-orange-200/70"
                aria-hidden="true"
              />
            )}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p
          className={`text-[11px] font-black uppercase tracking-wide ${kindColor}`}
        >
          {badge}
        </p>
        <p className="truncate text-xl font-semibold leading-tight">
          {item.title}
        </p>
        <p className="truncate text-sm text-white/70">{item.subtitle}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {item.meta ? (
            <span className="text-xs font-semibold text-white/64">
              {item.meta}
            </span>
          ) : null}
          {badges.map((label) => (
            <span
              key={`${item.id}-${label}`}
              className={getFreshnessBadgeClass(freshnessMeta, label)}
            >
              {label}
            </span>
          ))}
        </div>
      </div>
      <span className="rounded-full bg-[#fff4e1]/10 px-3 py-1 text-xs font-black text-orange-100 ring-1 ring-orange-200/25">
        View
      </span>
    </Link>
  );
}

function ActiveSceneEmptyState({ laneId }: { laneId: ScoutSceneLaneId }) {
  const isForYou = laneId === "for_you";
  const title = isForYou
    ? "Nearby food is quiet right now."
    : laneId === "community"
      ? "No local favorites nearby yet."
      : laneId === "deals"
        ? "No active deals nearby right now."
        : laneId === "food_trucks"
          ? "No food trucks nearby right now."
          : laneId === "events"
            ? "No food events nearby right now."
            : "Nothing nearby yet.";
  const body = isForYou
    ? "Try Worth Discovering, New Menus, or widen your area."
    : laneId === "community"
      ? "Explore nearby and save spots to build your local favorites."
      : laneId === "deals"
        ? "Try Nearby or New Menus for fresh local options."
        : laneId === "food_trucks"
          ? "Try Restaurants, Events, or Worth Discovering."
          : laneId === "events"
            ? "Check Nearby or Worth Discovering."
            : "Try another nearby category or widen your area.";

  return (
    <section className="px-4 pb-4">
      <div className="rounded-2xl bg-white/[0.04] px-4 py-3 text-white ring-1 ring-white/10">
        <p className="text-sm font-black">{title}</p>
        <p className="mt-1 text-xs font-semibold leading-relaxed text-white/58">
          {body}
        </p>
        {isForYou ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href="/search"
              className="rounded-full bg-[#ff7945] px-3 py-1.5 text-[11px] font-black text-white ring-1 ring-white/20"
            >
              Widen Area
            </Link>
            <Link
              href="/search?q=worth%20discovering"
              className="rounded-full bg-white/[0.06] px-3 py-1.5 text-[11px] font-black text-white/90 ring-1 ring-white/20"
            >
              Worth Discovering
            </Link>
            <Link
              href="/search?q=new%20menus"
              className="rounded-full bg-white/[0.06] px-3 py-1.5 text-[11px] font-black text-white/90 ring-1 ring-white/20"
            >
              New Menus
            </Link>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ExploreSceneTiles({
  activeSceneLaneId,
  onSceneLaneSelect,
}: {
  activeSceneLaneId: ScoutSceneLaneId;
  onSceneLaneSelect: (laneId: ScoutSceneLaneId) => void;
}) {
  const lowerTiles = SCOUT_SCENE_LANES.filter((lane) =>
    [
      "community",
      "food_trucks",
      "restaurants",
      "deals",
      "events",
      "new_menus",
      "late_night",
      "worth_discovering",
    ].includes(lane.id),
  );

  return (
    <section className="px-4 pb-10">
      <h3 className="mb-2 text-xs font-black uppercase tracking-[0.14em] text-white/44">
        Explore nearby food
      </h3>
      <div className="grid grid-cols-2 gap-2.5">
        {lowerTiles.map((lane) => {
          const active = lane.id === activeSceneLaneId;
          return (
            <button
              key={lane.id}
              type="button"
              onClick={() => onSceneLaneSelect(lane.id)}
              className={[
                "rounded-2xl px-3 py-2.5 text-left text-sm font-bold ring-1 transition-colors",
                active
                  ? "bg-[#ff7945] text-white ring-white/20"
                  : "bg-white/[0.04] text-white/78 ring-white/10 hover:bg-white/[0.08]",
              ].join(" ")}
            >
              {lane.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function FilterNearbyChips({
  selectedCraving,
  onCravingSelect,
}: {
  selectedCraving: CravingCategory;
  onCravingSelect: (id: string) => void;
}) {
  const filters = [
    { id: "open-now", label: "Open" },
    { id: "food-truck", label: "Trucks" },
    { id: "deals-today", label: "Deals" },
    { id: "today", label: "Today" },
  ];

  return (
    <section className="px-4 pb-7">
      <p className="mb-2 text-[11px] font-black uppercase tracking-[0.14em] text-white/48">
        Filter nearby
      </p>
      <div className="overflow-x-auto atmo-hide-scrollbar">
        <div className="flex w-max gap-2 pr-1">
          {filters.map((filter) => {
            const isActive = selectedCraving.id === filter.id;
            return (
              <button
                key={filter.id}
                type="button"
                onClick={() => onCravingSelect(filter.id)}
                className={[
                  "min-h-8 shrink-0 rounded-full px-3 py-1.5 text-[11px] font-black ring-1 transition-colors active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/60",
                  isActive
                    ? "bg-[#ff7945] text-white ring-white/20"
                    : "bg-white/[0.04] text-white/58 ring-white/10 hover:bg-white/[0.08] hover:text-white/78",
                ].join(" ")}
                aria-pressed={isActive}
              >
                {filter.label}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function QuietNearbyNotice() {
  return (
    <section className="px-4 pb-6">
      <div className="rounded-2xl bg-white/[0.04] px-4 py-3 text-white ring-1 ring-white/10">
        <p className="text-sm font-black">
          Nearby food is quiet right now.
        </p>
        <p className="mt-1 text-xs font-semibold leading-relaxed text-white/58">
          Try Worth Discovering, New Menus, or widen your area.
        </p>
      </div>
    </section>
  );
}

function ScoutPointsBadge({ userId }: { userId: string }) {
  const { data } = useQuery<{
    level: number;
    totalFavorites: number;
    totalStories: number;
  } | null>({
    queryKey: ["/api/stories/reviewer-level", userId],
    queryFn: async () => {
      const res = await fetch(
        `/api/stories/reviewer-level/${encodeURIComponent(userId)}`,
        {
          credentials: "include",
        },
      );
      if (!res.ok) return null;
      return res.json();
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (!data) return null;
  const pts = (data.totalFavorites ?? 0) * 10 + (data.totalStories ?? 0) * 5;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#100c0a]/80 px-2.5 py-1.5 text-[11px] font-black text-amber-300 ring-1 ring-orange-200/30 backdrop-blur-xl shadow-[0_8px_20px_rgba(0,0,0,0.38)]">
      <Flame
        className="h-3 w-3 fill-amber-400 text-amber-400"
        aria-hidden="true"
      />
      {pts} pts
    </span>
  );
}

function CollapsedMapPinCard({
  marker,
  userLocation,
  onClose,
}: {
  marker: MapAdapterMarker;
  userLocation?: { lat: number; lng: number } | null;
  onClose: () => void;
}) {
  const destination =
    marker.kind === "truck"
      ? `/truck/${marker.sourceId}`
      : marker.kind === "restaurant"
        ? `/restaurant/${marker.sourceId}`
        : marker.kind === "deal"
          ? "/deals-featured"
          : marker.kind === "parking"
            ? `/events?hostId=${encodeURIComponent(String(marker.sourceId))}`
            : "/events";
  const status =
    marker.kind === "truck"
      ? "Food truck"
      : marker.kind === "restaurant"
        ? "Open place"
        : marker.kind === "deal"
          ? "Deal today"
          : marker.kind === "parking"
            ? "Event host"
            : "Event";
  const computedDistance =
    userLocation && Number.isFinite(marker.lat) && Number.isFinite(marker.lng)
      ? formatMiles(
          getDistanceMiles(userLocation, { lat: marker.lat, lng: marker.lng }),
        )
      : null;
  const originParam = userLocation
    ? `&origin=${userLocation.lat},${userLocation.lng}`
    : "";
  const directionsUrl = `https://www.google.com/maps/dir/?api=1${originParam}&destination=${marker.lat},${marker.lng}&travelmode=driving`;

  return (
    <div
      className="absolute left-3 right-3 bottom-16 z-20 rounded-2xl bg-[#0f1017]/88 px-3 py-3 text-white ring-1 ring-white/10 backdrop-blur-xl"
      style={{ boxShadow: "0 16px 36px rgba(0,0,0,0.48)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-orange-200/80">
            {status}
          </p>
          <p className="truncate text-base font-black">
            {marker.title || "Nearby place"}
          </p>
          <p className="truncate text-xs text-white/70">
            {computedDistance ? `${computedDistance} away` : "Nearby"}
          </p>
          {marker.kind === "parking" &&
          (marker.parkedTrucks?.length || 0) > 0 ? (
            <p className="mt-0.5 truncate text-xs font-black text-orange-200/90">
              🚚 {marker.parkedTrucks!.map((t) => t.name).join(", ")}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href={destination}
            className="rounded-xl bg-[#ff7945] px-3 py-1.5 text-xs font-black text-white ring-1 ring-white/20"
          >
            View
          </Link>
          <a
            href={directionsUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-xl bg-white/10 px-3 py-1.5 text-xs font-black text-white ring-1 ring-white/10"
          >
            Route
          </a>
          <button
            type="button"
            onClick={onClose}
            aria-label="Dismiss"
            className="rounded-xl px-2 py-1.5 text-xs font-bold text-white/50"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

function LocalActivityRail({
  mode,
  items,
  onOpenResultsSheet,
}: {
  mode: ScoutActivityMode;
  items: LocalActivityItem[];
  onOpenResultsSheet?: (data: ScoutResultsSheetData) => void;
}) {
  if (items.length === 0) return null;
  const isCompact = mode === "high_activity";

  return (
    <section
      className={isCompact ? "pl-4 pr-0 pt-0 pb-5" : "pl-5 pr-0 pt-1 pb-6"}
    >
      <SectionHeader
        title={getActivityRailTitle(mode)}
        linkHref="/search"
        subtitle={getActivityRailSubtitle(mode)}
        itemCount={items.length}
        onSeeAll={
          onOpenResultsSheet
            ? () =>
                onOpenResultsSheet({
                  title: getActivityRailTitle(mode),
                  subtitle: getActivityRailSubtitle(mode),
                  items,
                  renderItem: (item: LocalActivityItem) => (
                    <LocalActivityCard item={item} />
                  ),
                  getKey: (item: LocalActivityItem) => String(item.id),
                })
            : undefined
        }
      />
      <div className="overflow-x-auto atmo-hide-scrollbar -mr-1">
        <ul
          className={`flex ${isCompact ? "gap-2.5" : "gap-3"} pr-5`}
          role="list"
          aria-label="Happening nearby"
        >
          {items.map((item) => (
            <li
              key={item.id}
              className={`shrink-0 ${isCompact ? "w-[168px] sm:w-[194px]" : "w-[190px] sm:w-[220px]"}`}
            >
              <LocalActivityCard item={item} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function QuickUpdateBar() {
  // Future flow hooks: one-tap open now, one-tap location confirm,
  // quick deal posting, and quick menu updates can attach behind these links.
  const actions = [
    {
      label: "Update status",
      href: "/restaurant-owner-dashboard?src=scout&setup=status",
      icon: <Flame className="h-3.5 w-3.5" aria-hidden="true" />,
    },
    {
      label: "Confirm location",
      href: "/restaurant-owner-dashboard?src=scout&setup=location",
      icon: <Navigation2 className="h-3.5 w-3.5" aria-hidden="true" />,
    },
    {
      label: "Update menu",
      href: "/menu-builder?src=scout",
      icon: <Utensils className="h-3.5 w-3.5" aria-hidden="true" />,
    },
    {
      label: "Post deal",
      href: "/deal-creation?src=scout",
      icon: <Tag className="h-3.5 w-3.5" aria-hidden="true" />,
    },
  ];

  return (
    <section className="px-4 pb-4 -mt-1" aria-label="Quick updates">
      <div className="rounded-2xl bg-[#120805]/42 px-3 py-2.5 ring-1 ring-orange-200/10">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-orange-100/72">
            Quick updates
          </p>
          <p className="text-[10px] font-bold text-white/42">For your places</p>
        </div>
        <div className="overflow-x-auto atmo-hide-scrollbar">
          <div className="flex w-max gap-2 pr-1">
            {actions.map((action) => (
              <Link
                key={action.label}
                href={action.href}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-[#fff4e1]/10 px-2.5 py-1.5 text-[10px] font-black text-orange-50 ring-1 ring-orange-200/25 transition-colors hover:bg-[#fff4e1]/14 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70"
              >
                {action.icon}
                <span>{action.label}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function OwnerOperationalActions({
  actions,
}: {
  actions: Array<{ label: string; href: string; icon: React.ReactNode }>;
}) {
  if (actions.length === 0) return null;

  return (
    <div className="mt-2 overflow-x-auto atmo-hide-scrollbar">
      <div className="flex w-max gap-1.5 pr-1">
        {actions.map((action) => (
          <Link
            key={`${action.label}-${action.href}`}
            href={action.href}
            className="inline-flex min-h-7 shrink-0 items-center gap-1 rounded-full bg-orange-300/14 px-2 py-1 text-[10px] font-black text-orange-100 ring-1 ring-orange-200/25 transition-colors hover:bg-orange-300/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70"
          >
            {action.icon}
            <span>{action.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function LocalActivityCard({ item }: { item: LocalActivityItem }) {
  const icon =
    item.type === "menu_update" ? (
      <Utensils className="h-3.5 w-3.5" aria-hidden="true" />
    ) : item.type === "deal" ? (
      <Tag className="h-3.5 w-3.5" aria-hidden="true" />
    ) : item.type === "truck" ? (
      <Flame className="h-3.5 w-3.5" aria-hidden="true" />
    ) : item.type === "event" ? (
      <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
    ) : (
      <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
    );
  const badges = [
    item.timeLabel,
    item.sourceLabel,
    ...getOperationalBadges(item.freshnessMeta),
  ]
    .filter((label): label is string => Boolean(label))
    .filter((label, index, all) => all.indexOf(label) === index)
    .slice(0, 2);

  return (
    <Link
      href={item.href}
      className="block rounded-2xl bg-[#120805]/56 p-3 text-white ring-1 ring-white/10 transition-colors hover:bg-[#1a0d08]/78 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-orange-300/14 text-orange-200 ring-1 ring-orange-200/20">
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-black leading-tight text-white">
            {item.title}
          </p>
          <p className="mt-1 line-clamp-2 text-[11px] font-semibold leading-snug text-orange-100/64">
            {item.subtitle}
          </p>
        </div>
      </div>
      {badges.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {badges.map((badge) => (
            <span
              key={badge}
              className={getFreshnessBadgeClass(item.freshnessMeta, badge)}
            >
              {badge}
            </span>
          ))}
        </div>
      ) : null}
    </Link>
  );
}

/* ============================================================
   HERO MAP FALLBACK
   ============================================================ */

function HeroMapFallback({
  reason,
}: {
  reason: "no-key" | "denied" | "loading";
}) {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      style={{
        background:
          "linear-gradient(140deg, #070a10 0%, #0e1320 40%, #070a10 100%)",
        animation: "heroAtmosphere 8s ease-in-out infinite",
      }}
    >
      {/* CSS animation keyframes injected inline */}
      <style>{`
        @keyframes heroAtmosphere {
          0%   { background: radial-gradient(ellipse at 20% 60%, rgba(255,90,47,0.18) 0%, rgba(8,10,15,0) 55%), radial-gradient(ellipse at 75% 30%, rgba(180,83,9,0.12) 0%, rgba(8,10,15,0) 50%), linear-gradient(160deg, #080a0f 0%, #0f1117 50%, #080a0f 100%); }
          25%  { background: radial-gradient(ellipse at 55% 70%, rgba(255,90,47,0.14) 0%, rgba(8,10,15,0) 55%), radial-gradient(ellipse at 20% 25%, rgba(180,83,9,0.16) 0%, rgba(8,10,15,0) 50%), linear-gradient(160deg, #080a0f 0%, #0f1117 50%, #080a0f 100%); }
          50%  { background: radial-gradient(ellipse at 70% 50%, rgba(255,90,47,0.20) 0%, rgba(8,10,15,0) 55%), radial-gradient(ellipse at 30% 70%, rgba(180,83,9,0.10) 0%, rgba(8,10,15,0) 50%), linear-gradient(160deg, #080a0f 0%, #0f1117 50%, #080a0f 100%); }
          75%  { background: radial-gradient(ellipse at 35% 35%, rgba(255,90,47,0.15) 0%, rgba(8,10,15,0) 55%), radial-gradient(ellipse at 65% 65%, rgba(180,83,9,0.18) 0%, rgba(8,10,15,0) 50%), linear-gradient(160deg, #080a0f 0%, #0f1117 50%, #080a0f 100%); }
          100% { background: radial-gradient(ellipse at 20% 60%, rgba(255,90,47,0.18) 0%, rgba(8,10,15,0) 55%), radial-gradient(ellipse at 75% 30%, rgba(180,83,9,0.12) 0%, rgba(8,10,15,0) 50%), linear-gradient(160deg, #080a0f 0%, #0f1117 50%, #080a0f 100%); }
        }
        @keyframes heroAtmosphereGrain {
          0%   { opacity: 0.04; transform: translate(0,0); }
          20%  { opacity: 0.06; transform: translate(-1px, 1px); }
          40%  { opacity: 0.03; transform: translate(1px, -1px); }
          60%  { opacity: 0.05; transform: translate(-1px, -1px); }
          80%  { opacity: 0.04; transform: translate(1px, 1px); }
          100% { opacity: 0.04; transform: translate(0,0); }
        }
      `}</style>
      {/* Subtle noise grain overlay */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)",
          backgroundSize: "42px 42px, 42px 42px",
          opacity: 0.35,
          pointerEvents: "none",
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
          backgroundSize: "180px 180px",
          mixBlendMode: "overlay",
          animation: "heroAtmosphereGrain 3s steps(1) infinite",
          pointerEvents: "none",
        }}
      />
      <span className="sr-only">
        {reason === "no-key"
          ? "Map preview unavailable."
          : reason === "denied"
            ? "Turn on location for the map."
            : "Loading map."}
      </span>
    </div>
  );
}

/* ============================================================
   CARDS
   ============================================================ */

function LiveNowEmptyCard({
  title,
  body,
  onCta,
}: {
  title: string;
  body: string;
  onCta: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onCta}
      className="block w-full text-left rounded-2xl overflow-hidden bg-white/5 backdrop-blur-md ring-1 ring-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70"
      style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.45)" }}
      aria-label={title}
    >
      <div className="p-4">
        <div className="flex items-start gap-3 mb-3">
          <span
            className="h-9 w-9 rounded-full bg-orange-500/15 ring-1 ring-orange-300/40 flex items-center justify-center shrink-0 mt-0.5"
            aria-hidden="true"
          >
            <MapPin className="h-4 w-4 text-orange-300" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-white text-sm leading-snug">
              {title}
            </p>
            <p className="mt-1 text-xs text-white/60 leading-relaxed">{body}</p>
          </div>
        </div>
      </div>
    </button>
  );
}

function LiveTruckSkeletonCard() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-2xl bg-[#2a1b14] ring-1 ring-orange-200/14"
    >
      <div className="aspect-[4/5] w-full animate-pulse bg-white/5" />
    </div>
  );
}

function LiveTruckCard({
  truck,
  viewModel,
  currentUserId,
  relationshipSnapshot,
}: {
  truck: LiveTruckSummary;
  viewModel?: ScoutResultViewModel;
  currentUserId?: string | null;
  relationshipSnapshot: RestaurantRelationshipSnapshot;
}) {
  const truckId = String(truck.id);
  const [isFavorite, setIsFavorite] = useState(false);
  const [pendingFavorite, setPendingFavorite] = useState(false);

  useEffect(() => {
    setIsFavorite(relationshipSnapshot.favoriteIds.has(truckId));
  }, [relationshipSnapshot, truckId]);

  const toggleFavorite = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!currentUserId) {
      window.location.href = `/login?redirect=${encodeURIComponent("/scout")}`;
      return;
    }
    const nextState = !isFavorite;
    setIsFavorite(nextState);
    setPendingFavorite(true);
    try {
      const response = await fetch(
        `/api/restaurants/${encodeURIComponent(truckId)}/favorite`,
        {
          method: nextState ? "POST" : "DELETE",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: nextState ? "{}" : undefined,
        },
      );
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(
          String(data?.message || "").trim() || "Favorite action failed",
        );
      }
    } catch (error) {
      setIsFavorite(!nextState);
      if (nextState) {
        toast({
          variant: "destructive",
          description:
            error instanceof Error
              ? error.message
              : "Couldn't save this truck.",
        });
      }
    } finally {
      setPendingFavorite(false);
    }
  };

  const distance = formatDistance(truck);
  const wait = formatWait(truck);
  const vibe = getCrowdVibe(truck);
  const cardView = viewModel || buildTruckResultViewModel(truck);
  const heroImage = cardView.imageUrl;
  const cardTitle = cardView.title;
  const cardHref = cardView.href;
  const truckTone = getTruckCardTone(truck);
  const freshnessMeta: FreshnessMeta = {
    kind: "truck",
    updatedAt: readStringField(truck, ["updatedAt", "lastUpdatedAt"]),
    confirmedAt: readStringField(truck, ["confirmedAt", "lastConfirmedAt"]),
    hasDeal: Boolean(truck.activeDealCount && truck.activeDealCount > 0),
    hasDistance: Boolean(distance),
    isOpen: true,
  };
  const badges = getOperationalBadges(freshnessMeta).slice(0, 3);
  const canEdit = isOwnedByCurrentUser(truck, currentUserId);
  const actions = canEdit
    ? [
        {
          label: "Update status",
          href: getTruckUpdateHref(String(truck.id), "status"),
          icon: <Flame className="h-3 w-3" aria-hidden="true" />,
        },
        {
          label: "Confirm location",
          href: getTruckUpdateHref(String(truck.id), "location"),
          icon: <Navigation2 className="h-3 w-3" aria-hidden="true" />,
        },
      ]
    : [];

  return (
    <Link
      href={cardHref}
      className="group relative block overflow-hidden rounded-2xl bg-[#2a1b14] ring-1 ring-orange-200/18 transition duration-200 hover:-translate-y-0.5 hover:ring-orange-200/34 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70"
      aria-label={`Open ${cardTitle}`}
      style={{
        boxShadow: "0 12px 28px rgba(0,0,0,0.24)",
      }}
    >
      <div className="relative aspect-[16/11] w-full bg-[#120805]/60">
        <ScoutCardMedia
          imageUrl={heroImage || null}
          imageObjectPosition={cardView.imageObjectPosition}
          fallbackIcon={
            <TruckIcon className="h-5 w-5 text-white/80" aria-hidden="true" />
          }
          fallbackTestId="scout-live-truck-card-image-fallback"
          imageClassName="absolute inset-0 h-full w-full object-cover"
          categoryPhoto={getDishCategoryPhoto(
            truck.name,
            truck.cuisineType,
            truck.vibe,
          )}
        />
        <ScoutNetworkScopeBadge label={cardView.scopeLabel} />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(180deg, rgba(0,0,0,0) 38%, rgba(0,0,0,0.92) 100%)",
          }}
          aria-hidden="true"
        />

        <span
          className={`absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide shadow-md ring-1 ${getTruckToneClass(truckTone.tone)}`}
        >
          <TruckIcon className="h-3 w-3" aria-hidden="true" />
          <span
            className={`h-1.5 w-1.5 rounded-full ${getTruckToneDotClass(truckTone.tone)}`}
            aria-hidden="true"
          />
          {truckTone.label}
        </span>
        <span className="absolute bottom-3 left-3 inline-flex items-center rounded-full bg-black/62 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white/86 ring-1 ring-white/10">
          Food truck
        </span>

        <button
          type="button"
          aria-label={isFavorite ? "Saved" : "Save"}
          aria-pressed={isFavorite}
          onClick={toggleFavorite}
          disabled={pendingFavorite}
          className={`absolute top-2.5 right-2.5 h-9 w-9 rounded-full flex items-center justify-center backdrop-blur-sm transition-colors ${
            isFavorite
              ? "bg-orange-400/90 hover:bg-orange-400"
              : "bg-[#120805]/30 hover:bg-[#120805]/50"
          }`}
        >
          <Heart
            className={`h-5 w-5 ${isFavorite ? "text-[#1a0d08] fill-current" : "text-white"}`}
            aria-hidden="true"
          />
        </button>
      </div>
      <div className="relative border-t border-orange-200/10 bg-[#2a1b14] px-3 py-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-orange-300/10 text-orange-200 ring-1 ring-orange-200/18">
            <TruckIcon className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-black leading-tight text-orange-50">
              {cardTitle}
            </p>
            <p className="mt-1 inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-orange-200/86">
              <Navigation2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>
                {[wait, distance].filter(Boolean).join(" / ") ||
                  "Live location active"}
              </span>
            </p>
          </div>
        </div>
        <p className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-orange-50/64">
          <Flame className="h-4 w-4 text-orange-300" aria-hidden="true" />
          <span>{vibe.label}</span>
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {badges.map((badge) => (
            <span
              key={badge}
              className={getFreshnessBadgeClass(freshnessMeta, badge)}
            >
              {badge}
            </span>
          ))}
        </div>
        <OwnerOperationalActions actions={actions} />
      </div>
    </Link>
  );
}

function DealCard({
  deal,
  viewModel,
  currentUserId,
}: {
  deal: DealSummary;
  viewModel?: ScoutResultViewModel;
  currentUserId?: string | null;
}) {
  const freshnessMeta: FreshnessMeta = {
    kind: "deal",
    updatedAt: readStringField(deal, ["updatedAt", "lastUpdatedAt"]),
    confirmedAt: readStringField(deal, ["confirmedAt", "lastConfirmedAt"]),
    hasDeal: true,
  };
  const badges = getOperationalBadges(freshnessMeta).slice(0, 2);
  const canEdit = isOwnedByCurrentUser(deal, currentUserId);
  const actions = canEdit
    ? [
        {
          label: "Update status",
          href: `/deal-edit/${encodeURIComponent(String(deal.id))}`,
          icon: <Flame className="h-3 w-3" aria-hidden="true" />,
        },
      ]
    : [];
  const cardView = viewModel || buildDealResultViewModel(deal);
  const cardTitle = cardView.title;
  const cardHref = cardView.href;

  return (
    <Link
      href={cardHref}
      className="block overflow-hidden rounded-2xl bg-[#202617] ring-1 ring-lime-200/18 transition duration-200 hover:-translate-y-0.5 hover:ring-lime-200/34 focus:outline-none focus-visible:ring-2 focus-visible:ring-lime-300/70"
      style={{ boxShadow: "0 12px 28px rgba(0,0,0,0.24)" }}
      aria-label={`Open deal ${cardTitle}`}
    >
      <div className="relative aspect-[4/5] w-full bg-[#120805]/60">
        <ScoutCardMedia
          imageUrl={cardView.imageUrl}
          imageObjectPosition={cardView.imageObjectPosition}
          fallbackIcon={
            <Tag className="h-5 w-5 text-white/80" aria-hidden="true" />
          }
          fallbackTestId="scout-deal-card-image-fallback"
          imageClassName="absolute inset-0 h-full w-full object-cover"
          fallbackClassName="bg-[linear-gradient(150deg,#a3e635_0%,#65a30d_45%,#3f6212_100%)]"
          categoryPhoto={getDishCategoryPhoto(
            deal.title,
            (deal as any).description,
          )}
        />
        <ScoutNetworkScopeBadge
          label={cardView.scopeLabel}
          position="top-right"
        />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(180deg, rgba(0,0,0,0) 38%, rgba(0,0,0,0.92) 100%)",
          }}
          aria-hidden="true"
        />
        <span className="absolute top-3 left-3 inline-flex items-center gap-1 rounded-full bg-lime-300 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-[#102006] shadow-md">
          <Tag className="h-3 w-3" aria-hidden="true" />
          {deal.discountText || "Deal"}
        </span>
        <div className="absolute bottom-3 left-3 right-3">
          <p className="text-white font-bold text-lg leading-tight line-clamp-2">
            {cardTitle}
          </p>
          {deal.restaurantName && (
            <p className="mt-1 text-white/75 text-xs truncate">
              {deal.restaurantName}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-1">
            {badges.map((badge) => (
              <span
                key={badge}
                className={getFreshnessBadgeClass(freshnessMeta, badge)}
              >
                {badge}
              </span>
            ))}
          </div>
          <OwnerOperationalActions actions={actions} />
        </div>
      </div>
    </Link>
  );
}

function trackLocalMenuItemEngagement(payload: {
  eventName: "menu_item_impression" | "menu_item_click";
  itemId: string;
  restaurantId?: string | null;
  layerId?: string;
  surface?: string;
  position?: number;
  discoveryScore?: number | null;
  discoveryReasons?: string[] | null;
}) {
  void fetch("/api/menus/local-items/engagement", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    keepalive: true,
    body: JSON.stringify(payload),
  }).catch(() => {});
}

function LocalMenuItemCard({
  item,
  viewModel,
  position,
  currentUserId,
}: {
  item: LocalMenuItemFeedItem;
  viewModel?: ScoutResultViewModel;
  position: number;
  currentUserId?: string | null;
}) {
  const price =
    typeof item.priceCents === "number" && Number.isFinite(item.priceCents)
      ? `$${(item.priceCents / 100).toFixed(item.priceCents % 100 === 0 ? 0 : 2)}`
      : null;
  const distLabel =
    typeof item.distanceMiles === "number" &&
    Number.isFinite(item.distanceMiles)
      ? `${item.distanceMiles.toFixed(item.distanceMiles < 10 ? 1 : 0)} mi`
      : null;
  const userInterestCuisines = useFavoriteCuisineInterests(currentUserId);
  const displayCategory = pickDisplayCategory(
    item.cuisineType,
    userInterestCuisines,
    String(item.restaurantId || item.id),
  );
  const canEdit = isOwnedByCurrentUser(item, currentUserId);
  const actions = canEdit
    ? [
        {
          label: "Update menu",
          href: getRestaurantUpdateHref(String(item.restaurantId), "menu"),
          icon: <Utensils className="h-3 w-3" aria-hidden="true" />,
        },
      ]
    : [];
  const cardView = viewModel || buildMenuItemResultViewModel(item);
  const cardTitle = cardView.title;
  const cardHref = cardView.href;

  const [isRecommendDialogOpen, setIsRecommendDialogOpen] = useState(false);
  const [recommendComment, setRecommendComment] = useState("");
  const [recommendPhoto, setRecommendPhoto] = useState<File | null>(null);
  const [isSubmittingEnrich, setIsSubmittingEnrich] = useState(false);
  const [isRemovingRecommend, setIsRemovingRecommend] = useState(false);
  const [isTogglingRecommend, setIsTogglingRecommend] = useState(false);
  const [hasRecommended, setHasRecommended] = useState(false);

  const { data: myRecommendationData } = useQuery({
    queryKey: ["/api/menu-items", item.id, "my-recommendation", currentUserId],
    queryFn: async () => {
      // Deliberately same-origin (not apiUrl's cross-origin API host): this
      // check depends on the session cookie, which mobile/Safari privacy
      // rules strip from cross-site requests. www.mealscout.us proxies
      // /api/* to the backend, so a relative path keeps the cookie first-party.
      const res = await fetch(
        `/api/menu-items/${encodeURIComponent(item.id)}/my-recommendation`,
        { credentials: "include" },
      );
      if (!res.ok) return null;
      return res.json();
    },
    enabled: Boolean(currentUserId),
    staleTime: 60_000,
  });

  useEffect(() => {
    setHasRecommended(Boolean((myRecommendationData as any)?.recommendation));
  }, [myRecommendationData]);

  const postMenuItemRecommendation = async (opts: {
    comment?: string;
    photo?: File | null;
  }) => {
    const formData = new FormData();
    formData.append("comment", opts.comment ?? "");
    if (opts.photo) formData.append("image", opts.photo);
    // Same-origin for the same reason as the my-recommendation check above.
    return fetch(`/api/menu-items/${encodeURIComponent(item.id)}/recommend`, {
      method: "POST",
      credentials: "include",
      body: formData,
    });
  };

  const handleRecommendClick = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!currentUserId) {
      window.location.href = `/login?redirect=${encodeURIComponent("/scout")}`;
      return;
    }
    if (hasRecommended) {
      // Already recommended - reopen the popup so they can edit or remove it.
      setIsRecommendDialogOpen(true);
      return;
    }
    setIsTogglingRecommend(true);
    try {
      const res = await postMenuItemRecommendation({});
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({
          variant: "destructive",
          description:
            String(data?.message || "").trim() ||
            "Couldn't recommend this dish.",
        });
        return;
      }
      setHasRecommended(true);
      setIsRecommendDialogOpen(true);
    } finally {
      setIsTogglingRecommend(false);
    }
  };

  const submitEnrichedRecommendation = async () => {
    setIsSubmittingEnrich(true);
    try {
      const res = await postMenuItemRecommendation({
        comment: recommendComment,
        photo: recommendPhoto,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({
          variant: "destructive",
          description:
            String(data?.message || "").trim() ||
            "Couldn't save your recommendation.",
        });
        return;
      }
      toast({
        description:
          data?.photoStatus?.status === "pending"
            ? "Recommendation saved. Photo is pending approval."
            : "Recommendation saved.",
      });
      setRecommendComment("");
      setRecommendPhoto(null);
      setIsRecommendDialogOpen(false);
    } finally {
      setIsSubmittingEnrich(false);
    }
  };

  const removeRecommendation = async () => {
    setIsRemovingRecommend(true);
    try {
      const res = await fetch(
        `/api/menu-items/${encodeURIComponent(item.id)}/recommend`,
        { method: "DELETE", credentials: "include" },
      );
      if (res.ok) {
        setHasRecommended(false);
        setIsRecommendDialogOpen(false);
        setRecommendComment("");
        setRecommendPhoto(null);
      }
    } finally {
      setIsRemovingRecommend(false);
    }
  };

  useEffect(() => {
    trackLocalMenuItemEngagement({
      eventName: "menu_item_impression",
      itemId: item.id,
      restaurantId: item.restaurantId,
      layerId: "menuItems",
      surface: "scout",
      position,
      discoveryScore: item.discoveryScore,
      discoveryReasons: item.discoveryReasons,
    });
  }, [
    item.id,
    item.restaurantId,
    item.discoveryScore,
    item.discoveryReasons,
    position,
  ]);

  return (
    <Link
      href={cardHref}
      onClick={() =>
        trackLocalMenuItemEngagement({
          eventName: "menu_item_click",
          itemId: item.id,
          restaurantId: item.restaurantId,
          layerId: "menuItems",
          surface: "scout",
          position,
          discoveryScore: item.discoveryScore,
          discoveryReasons: item.discoveryReasons,
        })
      }
      className="block overflow-hidden rounded-2xl bg-[#2a1b14] ring-1 ring-orange-200/18 transition duration-200 hover:-translate-y-0.5 hover:ring-orange-200/34 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70"
      style={{ boxShadow: "0 12px 28px rgba(0,0,0,0.24)" }}
      aria-label={`Open ${cardTitle} from ${item.restaurantName || "local menu"}`}
      data-testid="scout-local-menu-item-card"
    >
      <div className="relative aspect-[16/11] bg-[#120805]/70">
        <ScoutCardMedia
          imageUrl={cardView.imageUrl}
          imageObjectPosition={cardView.imageObjectPosition}
          fallbackIcon={
            <Utensils className="h-5 w-5 text-white/80" aria-hidden="true" />
          }
          fallbackTestId="scout-local-menu-item-card-image-fallback"
          imageClassName="absolute inset-0 h-full w-full object-cover"
          fallbackClassName="bg-[linear-gradient(150deg,#fb923c_0%,#ea580c_45%,#9a3412_100%)]"
          categoryPhoto={getDishCategoryPhoto(item.name, item.description)}
        />
        <ScoutNetworkScopeBadge label={cardView.scopeLabel} />
        <div className="absolute inset-0 bg-gradient-to-b from-black/8 via-transparent to-black/58" />
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md bg-orange-300 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-[#1a0d08]">
          <Utensils className="h-3 w-3" aria-hidden="true" />
          Dish
        </span>
        {price && (
          <span className="absolute right-2 top-2 rounded-md bg-[#120805]/90 px-2 py-0.5 text-[11px] font-black text-orange-100 ring-1 ring-orange-300/24">
            {price}
          </span>
        )}
      </div>
      <div className="px-3 pb-3 pt-2.5">
        <p className="line-clamp-2 min-h-[2.25rem] text-sm font-bold leading-tight text-orange-50">
          {cardTitle}
        </p>
        <p className="mt-1 truncate text-xs font-semibold text-[#fed7aa]">
          {item.restaurantName || "Local spot"}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[#fed7aa]">
          {displayCategory && <span>{displayCategory}</span>}
          {distLabel && <span>{distLabel}</span>}
        </div>
        {item.description && (
          <p className="mt-2 line-clamp-1 text-xs leading-snug text-[#ffedd5]">
            {item.description}
          </p>
        )}
        <OwnerOperationalActions actions={actions} />
        <div className="mt-2">
          <button
            type="button"
            onClick={handleRecommendClick}
            disabled={isTogglingRecommend}
            className={`inline-flex min-h-11 min-w-11 items-center gap-1 py-2 text-[10px] font-bold uppercase tracking-wide disabled:opacity-60 ${
              hasRecommended
                ? "text-emerald-300"
                : "text-orange-300 hover:text-orange-200"
            }`}
          >
            <Heart
              className={`h-3 w-3 ${hasRecommended ? "fill-current" : ""}`}
              aria-hidden="true"
            />
            {hasRecommended ? "Recommended" : "Recommend"}
          </button>
        </div>
      </div>
      <Dialog
        open={isRecommendDialogOpen}
        onOpenChange={setIsRecommendDialogOpen}
      >
        <DialogContent
          className="max-w-sm"
          onClick={(event) => event.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle>{item.name}</DialogTitle>
            <DialogDescription>
              Tell us why you recommend it, or just close this - your
              recommendation is already saved.
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={recommendComment}
            onChange={(event) => setRecommendComment(event.target.value)}
            placeholder="What makes this dish worth it? (optional)"
            className="min-h-[72px] w-full rounded border border-[color:var(--border-subtle)] bg-black/20 px-2 py-1.5 text-sm"
          />
          <div className="flex items-center gap-2">
            <input
              type="file"
              accept="image/*"
              onChange={(event) =>
                setRecommendPhoto(event.target.files?.[0] || null)
              }
              className="flex-1 text-xs"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={removeRecommendation}
              disabled={isRemovingRecommend}
              className="text-xs text-[color:var(--text-muted)] underline hover:text-[color:var(--text-primary)] disabled:opacity-60"
            >
              Remove recommendation
            </button>
            <button
              type="button"
              onClick={submitEnrichedRecommendation}
              disabled={isSubmittingEnrich}
              className="rounded-full bg-orange-400 px-3 py-1.5 text-xs font-black text-[#1a0d08] disabled:opacity-60"
            >
              {isSubmittingEnrich ? "Saving…" : "Save"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </Link>
  );
}

function EventCard({
  event,
  viewModel,
  currentUserId,
}: {
  event: EventSummary;
  viewModel?: ScoutResultViewModel;
  currentUserId?: string | null;
}) {
  const cardView = viewModel || buildEventResultViewModel(event);
  const title = cardView.title;
  const venue = event.venueName || event.locationName || "";
  const start = event.startsAt || event.startTime;
  const startLabel = start
    ? new Date(start).toLocaleString(undefined, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
  const img = cardView.imageUrl;
  const cardHref = cardView.href;
  const freshnessMeta: FreshnessMeta = {
    kind: "event",
    startsAt: event.startsAt,
    startTime: event.startTime,
    updatedAt: readStringField(event, ["updatedAt", "lastUpdatedAt"]),
    confirmedAt: readStringField(event, ["confirmedAt", "lastConfirmedAt"]),
  };
  const badges = getOperationalBadges(freshnessMeta).slice(0, 2);
  const canEdit = isOwnedByCurrentUser(event, currentUserId);
  const actions = canEdit
    ? [
        {
          label: "Update status",
          href: `/host-dashboard?src=scout&eventId=${encodeURIComponent(String(event.id))}`,
          icon: <Flame className="h-3 w-3" aria-hidden="true" />,
        },
      ]
    : [];
  return (
    <Link
      href={cardHref}
      className="block overflow-hidden rounded-2xl bg-[#18242c] ring-1 ring-sky-200/18 transition duration-200 hover:-translate-y-0.5 hover:ring-sky-200/34 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70"
      style={{ boxShadow: "0 12px 28px rgba(0,0,0,0.24)" }}
      aria-label={`Open event ${title}`}
    >
      <div className="relative aspect-[4/5] w-full bg-[#120805]/60">
        <ScoutCardMedia
          imageUrl={img || null}
          imageObjectPosition={cardView.imageObjectPosition}
          fallbackIcon={
            <CalendarDays
              className="h-5 w-5 text-white/80"
              aria-hidden="true"
            />
          }
          fallbackTestId="scout-event-card-image-fallback"
          imageClassName="absolute inset-0 h-full w-full object-cover"
          fallbackClassName="bg-[linear-gradient(150deg,#38bdf8_0%,#2563eb_48%,#1e1b4b_100%)]"
        />
        <ScoutNetworkScopeBadge
          label={cardView.scopeLabel}
          position="top-right"
        />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(180deg, rgba(0,0,0,0) 38%, rgba(0,0,0,0.92) 100%)",
          }}
          aria-hidden="true"
        />
        <span className="absolute top-3 left-3 inline-flex items-center gap-1 rounded-full bg-sky-300 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-[#071322] shadow-md">
          <CalendarDays className="h-3 w-3" aria-hidden="true" />
          Event
        </span>
        <div className="absolute bottom-3 left-3 right-3">
          <p className="text-white font-bold text-lg leading-tight line-clamp-2">
            {title}
          </p>
          {venue && (
            <p className="mt-1 text-white/80 text-xs truncate">{venue}</p>
          )}
          {startLabel && (
            <p className="mt-1 inline-flex items-center gap-1.5 text-sky-200 text-xs font-semibold">
              <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
              {startLabel}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-1">
            {badges.map((badge) => (
              <span
                key={badge}
                className={getFreshnessBadgeClass(freshnessMeta, badge)}
              >
                {badge}
              </span>
            ))}
          </div>
          <OwnerOperationalActions actions={actions} />
        </div>
      </div>
    </Link>
  );
}

function DiscoveryEmptyRow({
  icon,
  title,
  body,
  ctaLabel,
  onCta,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  ctaLabel: string;
  onCta: () => void;
}) {
  return (
    <div className="mr-5 rounded-3xl bg-white/5 ring-1 ring-white/10 backdrop-blur-md p-5">
      <div className="flex items-start gap-4">
        <span
          className="h-10 w-10 rounded-full bg-orange-500/15 ring-1 ring-orange-300/40 flex items-center justify-center shrink-0"
          aria-hidden="true"
        >
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-white font-semibold">{title}</p>
          <p className="text-white/70 text-sm mt-1">{body}</p>
          <button
            type="button"
            onClick={onCta}
            className="mt-3 inline-flex items-center gap-1.5 text-orange-200 text-sm font-semibold"
          >
            {ctaLabel} <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}

function NearbyRestaurantCard({
  restaurant,
  viewModel,
  menuPreview = [],
  isSignedIn,
  currentUserId,
  relationshipSnapshot,
}: {
  restaurant: RestaurantSummary;
  viewModel?: ScoutResultViewModel;
  menuPreview?: MenuPreviewItem[];
  isSignedIn: boolean;
  currentUserId?: string | null;
  relationshipSnapshot: RestaurantRelationshipSnapshot;
}) {
  const cardView = viewModel || buildRestaurantResultViewModel(restaurant);
  const normalizedKind = getScoutRestaurantLikeKind(restaurant);
  const isFoodTruckEntity = normalizedKind === "food_truck";
  const isBarEntity =
    String(
      restaurant.entityType ||
        restaurant.profileType ||
        restaurant.businessType ||
        "",
    )
      .trim()
      .toLowerCase() === "bar";
  const canonicalLabel = isFoodTruckEntity
    ? "Food truck"
    : isBarEntity
      ? "Bar"
      : normalizedKind === "restaurant"
        ? "Restaurant"
        : "Local activity";
  const profileHref = cardView.href;
  const name = cardView.title || canonicalLabel;
  const img = cardView.imageUrl;
  const cuisine = restaurant.cuisineType;
  const location = restaurant.neighborhood || restaurant.city;
  const dealCount =
    restaurant.activeDealsCount ?? restaurant.activeDealCount ?? 0;
  const favoriteCount = Number(restaurant.favoriteCount || 0);
  const followCount = Number(restaurant.followCount || 0);
  const recommendationCount = Number(restaurant.recommendationCount || 0);
  const videoRecommendationCount = Number(
    restaurant.videoRecommendationCount || 0,
  );
  const communityActivityCount = Number(restaurant.communityActivityCount || 0);
  const dist =
    restaurant.distanceMiles ??
    (restaurant.distance ? restaurant.distance * 0.621371 : null);
  const distLabel =
    typeof dist === "number" && Number.isFinite(dist)
      ? `${dist.toFixed(dist < 10 ? 1 : 0)} mi`
      : null;
  const restaurantId = String(restaurant.id);
  const canEdit = isOwnedByCurrentUser(restaurant, currentUserId);
  const ownerActions = canEdit
    ? [
        {
          label: "Update status",
          href: getRestaurantUpdateHref(restaurantId, "status"),
          icon: <Flame className="h-3 w-3" aria-hidden="true" />,
        },
        {
          label: "Update menu",
          href: getRestaurantUpdateHref(restaurantId, "menu"),
          icon: <Utensils className="h-3 w-3" aria-hidden="true" />,
        },
        {
          label: "Post deal",
          href: getRestaurantUpdateHref(restaurantId, "deal"),
          icon: <Tag className="h-3 w-3" aria-hidden="true" />,
        },
      ]
    : [];
  const [isFavorite, setIsFavorite] = useState(false);
  const [isFollowed, setIsFollowed] = useState(false);
  const [isRecommended, setIsRecommended] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  useEffect(() => {
    setIsFavorite(relationshipSnapshot.favoriteIds.has(restaurantId));
    setIsFollowed(relationshipSnapshot.followIds.has(restaurantId));
    setIsRecommended(relationshipSnapshot.recommendationIds.has(restaurantId));
  }, [relationshipSnapshot, restaurantId]);

  const formatPrice = (cents?: number | null) =>
    typeof cents === "number" && Number.isFinite(cents) && cents > 0
      ? `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`
      : null;
  const communityUpdates = [
    videoRecommendationCount > 0
      ? `${videoRecommendationCount} video update${videoRecommendationCount === 1 ? "" : "s"}`
      : null,
    recommendationCount > 0
      ? `${recommendationCount} community update${recommendationCount === 1 ? "" : "s"}`
      : null,
    favoriteCount > 0
      ? `${favoriteCount} save${favoriteCount === 1 ? "" : "s"}`
      : null,
    followCount > 0
      ? `${followCount} follow${followCount === 1 ? "" : "s"}`
      : null,
    communityActivityCount > 0 ? "active buzz" : null,
  ].filter((update): update is string => Boolean(update));
  const restaurantOpenState = getRestaurantOpenState(restaurant);
  const statusLabels = [
    ...getOperationalBadges({
      kind: isFoodTruckEntity ? "truck" : "restaurant",
      updatedAt: readStringField(restaurant, ["updatedAt", "lastUpdatedAt"]),
      confirmedAt: readStringField(restaurant, [
        "confirmedAt",
        "lastConfirmedAt",
      ]),
      hasDeal: dealCount > 0,
      hasMenu: menuPreview.length > 0,
      hasCommunityUpdate: communityUpdates.length > 0,
      hasDistance: Boolean(distLabel),
      isOpen: isFoodTruckEntity
        ? isTruckServingNow(restaurant as unknown as LiveTruckSummary)
        : restaurantOpenState === "unknown"
          ? undefined
          : restaurantOpenState === "open",
    }),
  ];
  const cardShellClass = isFoodTruckEntity
    ? "group relative block overflow-hidden rounded-2xl bg-[var(--bg-card)] ring-1 ring-[color:var(--border-subtle)] transition duration-200 hover:-translate-y-0.5 hover:ring-orange-300/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70"
    : "group block overflow-hidden rounded-2xl bg-[var(--bg-card)] ring-1 ring-[color:var(--border-subtle)] transition duration-200 hover:-translate-y-0.5 hover:ring-orange-300/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70";
  const labelPillClass = isFoodTruckEntity
    ? "bg-[#120805]/72 text-orange-100 ring-orange-200/20"
    : "bg-[#1b0e08]/76 text-orange-50 ring-orange-200/24";
  const statusDotClass = isFoodTruckEntity
    ? "bg-orange-400"
    : restaurantOpenState === "open"
      ? "bg-emerald-400"
      : "bg-amber-400";
  const statusTextClass = isFoodTruckEntity
    ? "text-orange-300"
    : restaurantOpenState === "open"
      ? "text-emerald-300"
      : "text-amber-300";
  const placeIcon = isFoodTruckEntity ? (
    <TruckIcon className="h-5 w-5 text-white/80" aria-hidden="true" />
  ) : (
    <MapPin className="h-5 w-5 text-white/80" aria-hidden="true" />
  );

  const sendRestaurantAction = async (
    action: "favorite" | "follow" | "recommend",
    nextState: boolean,
  ) => {
    if (!isSignedIn) {
      window.location.href = `/login?redirect=${encodeURIComponent("/scout")}`;
      return;
    }

    const method = nextState ? "POST" : "DELETE";
    if (action === "recommend" && !nextState) return;
    setPendingAction(action);
    try {
      const response = await fetch(
        `/api/restaurants/${encodeURIComponent(restaurantId)}/${action}`,
        {
          method,
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: method === "POST" ? "{}" : undefined,
        },
      );
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(
          String(data?.message || "").trim() || "Restaurant action failed",
        );
      }
    } finally {
      setPendingAction(null);
    }
  };

  const toggleFavorite = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const nextState = !isFavorite;
    const wasFollowed = isFollowed;
    setIsFavorite(nextState);
    // Favoriting implies following; the server does this too, so mirror it
    // optimistically. Un-favoriting does not auto-unfollow.
    if (nextState) setIsFollowed(true);
    try {
      await sendRestaurantAction("favorite", nextState);
    } catch (error) {
      setIsFavorite(!nextState);
      if (nextState) setIsFollowed(wasFollowed);
      if (nextState) {
        toast({
          variant: "destructive",
          description:
            error instanceof Error
              ? error.message
              : "Couldn't save this restaurant.",
        });
      }
    }
  };

  const toggleFollow = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const nextState = !isFollowed;
    setIsFollowed(nextState);
    try {
      await sendRestaurantAction("follow", nextState);
    } catch {
      setIsFollowed(!nextState);
    }
  };

  const recommend = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (isRecommended) {
      setIsRecommendDialogOpen(true);
      return;
    }
    const wasFollowed = isFollowed;
    setIsRecommended(true);
    // Recommending implies following, same as favoriting above.
    setIsFollowed(true);
    try {
      // The tap itself is the shallow like/follow/recommend - it's already
      // saved by the time the context card opens. Closing it without adding
      // details keeps the recommendation.
      await sendRestaurantAction("recommend", true);
      setIsRecommendDialogOpen(true);
    } catch {
      setIsRecommended(false);
      setIsFollowed(wasFollowed);
    }
  };

  const [isRecommendDialogOpen, setIsRecommendDialogOpen] = useState(false);
  const [restaurantRecommendComment, setRestaurantRecommendComment] =
    useState("");
  const [restaurantRecommendPhoto, setRestaurantRecommendPhoto] =
    useState<File | null>(null);
  const [restaurantRecommendScores, setRestaurantRecommendScores] = useState({
    food: 80,
    value: 75,
    speed: 75,
    vibe: 75,
  });
  const [isSubmittingRestaurantRecommend, setIsSubmittingRestaurantRecommend] =
    useState(false);

  const submitRestaurantRecommendationDetails = async () => {
    setIsSubmittingRestaurantRecommend(true);
    try {
      const formData = new FormData();
      formData.append("comment", restaurantRecommendComment.trim());
      formData.append("scores", JSON.stringify(restaurantRecommendScores));
      if (restaurantRecommendPhoto) {
        formData.append("image", restaurantRecommendPhoto);
      }
      const response = await fetch(
        `/api/restaurants/${encodeURIComponent(restaurantId)}/recommend`,
        {
          method: "POST",
          credentials: "include",
          body: formData,
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast({
          variant: "destructive",
          description:
            String(data?.message || "").trim() ||
            "Couldn't save your recommendation.",
        });
        return;
      }
      toast({ description: "Recommendation saved." });
      setRestaurantRecommendComment("");
      setRestaurantRecommendPhoto(null);
      setIsRecommendDialogOpen(false);
    } catch {
      toast({
        variant: "destructive",
        description: "Couldn't save your recommendation.",
      });
    } finally {
      setIsSubmittingRestaurantRecommend(false);
    }
  };

  return (
    <Link
      href={profileHref}
      className={cardShellClass}
      aria-label={`Open ${name}`}
      style={{ boxShadow: "0 12px 28px rgba(0,0,0,0.24)" }}
      data-testid="scout-restaurant-card"
    >
      {/* Image */}
      <div className="relative aspect-[16/11] w-full bg-[#17100c]">
        <ScoutCardMedia
          imageUrl={img || null}
          imageObjectPosition={cardView.imageObjectPosition}
          fallbackIcon={placeIcon}
          fallbackTestId="scout-nearby-restaurant-card-image-fallback"
          imageClassName="absolute inset-0 h-full w-full object-cover"
          categoryPhoto={getDishCategoryPhoto(name, cuisine)}
        />
        <ScoutNetworkScopeBadge label={cardView.scopeLabel} />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(180deg, rgba(0,0,0,0.05), rgba(0,0,0,0.62))",
          }}
          aria-hidden="true"
        />
        {dealCount > 0 && (
          <span
            className={`absolute top-2.5 inline-flex items-center gap-1 rounded-full bg-orange-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow ${isFoodTruckEntity ? "left-4" : "left-2.5"}`}
          >
            <Tag className="h-2.5 w-2.5" aria-hidden="true" />
            {dealCount} deal{dealCount > 1 ? "s" : ""}
          </span>
        )}
        <span
          className={`absolute left-2 top-2 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${labelPillClass}`}
        >
          {isFoodTruckEntity ? (
            <TruckIcon className="h-3 w-3" aria-hidden="true" />
          ) : (
            <MapPin className="h-3 w-3" aria-hidden="true" />
          )}
          {canonicalLabel}
        </span>
      </div>
      {/* Info */}
      <div
        className={
          isFoodTruckEntity
            ? "px-3 pb-3 pt-2.5"
            : "px-3 pb-3 pt-2.5"
        }
      >
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 line-clamp-2 min-h-[2.25rem] text-sm font-bold leading-tight text-[color:var(--text-primary)]">
            {name}
          </p>
          {statusLabels.length > 0 && (
            <span
              className={`inline-flex shrink-0 items-center gap-1 text-[9px] font-bold uppercase tracking-wide ${statusTextClass}`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`}
                style={{
                  boxShadow: isFoodTruckEntity
                    ? "0 0 6px rgba(251,146,60,0.8)"
                    : restaurantOpenState === "open"
                      ? "0 0 6px rgba(52,211,153,0.7)"
                      : "0 0 6px rgba(251,191,36,0.65)",
                }}
                aria-hidden="true"
              />
              {statusLabels[0]}
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-1.5 overflow-hidden text-[11px]">
          {cuisine && (
            <span
              className="truncate text-[color:var(--action-primary)]"
            >
              {cuisine}
            </span>
          )}
          {cuisine && (location || distLabel) && (
            <span className="text-[color:var(--border-subtle)] text-[11px]">·</span>
          )}
          {location && (
            <span className="truncate text-[color:var(--text-secondary)]">
              {location}
            </span>
          )}
          {distLabel && (
            <>
              <span className="text-[color:var(--border-subtle)] text-[11px]">·</span>
              <span className="shrink-0 text-[color:var(--text-secondary)]">{distLabel}</span>
            </>
          )}
        </div>
        {menuPreview.length > 0 && (
          <div
            className="mt-2 flex items-center gap-2 rounded-xl bg-[color:var(--bg-surface-muted)] p-1.5 ring-1 ring-[color:var(--border-subtle)]"
            data-testid="scout-menu-preview"
          >
            <div className="relative h-8 w-8 shrink-0 overflow-hidden rounded-md">
              <ScoutCardMedia
                imageUrl={menuPreview[0].imageUrl || null}
                fallbackIcon={
                  <Utensils
                    className="h-3 w-3 text-orange-200"
                    aria-hidden="true"
                  />
                }
                fallbackTestId="scout-restaurant-featured-item-fallback"
                imageClassName="absolute inset-0 h-full w-full object-cover"
                categoryPhoto={getDishCategoryPhoto(
                  menuPreview[0].name,
                  menuPreview[0].description,
                )}
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] font-semibold text-[color:var(--text-primary)]">
                {menuPreview[0].name}
              </p>
            </div>
            {formatPrice(menuPreview[0].priceCents) && (
              <span className="shrink-0 text-[11px] font-semibold text-[color:var(--action-primary)]">
                {formatPrice(menuPreview[0].priceCents)}
              </span>
            )}
          </div>
        )}
        <OwnerOperationalActions actions={ownerActions} />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div
            className="flex items-center gap-2.5"
            aria-hidden={communityUpdates.length === 0}
          >
            {favoriteCount > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] font-mono text-[color:var(--text-secondary)]">
                <Bookmark className="h-2.5 w-2.5" aria-hidden="true" />
                {favoriteCount}
              </span>
            )}
            {followCount > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] font-mono text-[color:var(--text-secondary)]">
                <Heart className="h-2.5 w-2.5" aria-hidden="true" />
                {followCount}
              </span>
            )}
          </div>
          <div
            className="flex items-center gap-1.5"
            aria-label={`${name} quick actions`}
          >
            {/* Single entry point: a bare tap saves the shallow recommend.
                Tapping again opens optional context, with no duplicate actions. */}
            <button
              type="button"
              onClick={recommend}
              disabled={pendingAction === "recommend"}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-full transition ${
                isRecommended
                  ? "bg-orange-300 text-[#1a0d08]"
                  : "bg-[color:var(--bg-surface-muted)] text-[color:var(--text-secondary)] hover:bg-[color:var(--border-subtle)]"
              }`}
              aria-pressed={isRecommended}
              aria-label={
                isRecommended ? "Recommended - tap for more" : "Recommend"
              }
              title={isRecommended ? "Recommended - tap for more" : "Recommend"}
            >
              <Heart
                className={`h-3 w-3 ${isRecommended ? "fill-current" : ""}`}
                aria-hidden="true"
              />
            </button>
          </div>
        </div>
      </div>
      <Dialog
        open={isRecommendDialogOpen}
        onOpenChange={setIsRecommendDialogOpen}
      >
        <DialogContent
          className="max-w-sm"
          onClick={(event) => event.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle>{name}</DialogTitle>
            <DialogDescription>
              Add context if you want. Closing keeps your recommendation saved.
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={restaurantRecommendComment}
            onChange={(event) =>
              setRestaurantRecommendComment(event.target.value)
            }
            placeholder="What makes this place worth it? (optional)"
            className="min-h-[72px] w-full rounded border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-muted)] px-2 py-1.5 text-sm"
          />
          <input
            type="file"
            accept="image/*"
            onChange={(event) =>
              setRestaurantRecommendPhoto(event.target.files?.[0] || null)
            }
            className="text-xs"
          />
          <div className="space-y-3">
            {(
              [
                ["food", "Food"],
                ["value", "Value"],
                ["speed", "Speed"],
                ["vibe", "Vibe"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="block space-y-1">
                <span className="flex items-center justify-between text-xs font-semibold text-[color:var(--text-muted)]">
                  <span>{label}</span>
                  <span>{restaurantRecommendScores[key]}</span>
                </span>
                <input
                  type="range"
                  min="1"
                  max="100"
                  value={restaurantRecommendScores[key]}
                  onChange={(event) =>
                    setRestaurantRecommendScores((current) => ({
                      ...current,
                      [key]: Number(event.target.value),
                    }))
                  }
                  className="w-full accent-orange-400"
                />
              </label>
            ))}
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={submitRestaurantRecommendationDetails}
              disabled={isSubmittingRestaurantRecommend}
              className="rounded-full bg-orange-400 px-3 py-1.5 text-xs font-black text-[#1a0d08] disabled:opacity-60"
            >
              {isSubmittingRestaurantRecommend ? "Saving…" : "Save"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </Link>
  );
}

function SavedRestaurantCard({
  restaurant,
}: {
  restaurant: RestaurantSummary;
}) {
  const normalizedKind = getScoutRestaurantLikeKind(restaurant);
  const isFoodTruckEntity = normalizedKind === "food_truck";
  const canonicalLabel = isFoodTruckEntity
    ? "Food truck"
    : normalizedKind === "restaurant"
      ? "Restaurant"
      : "Local activity";
  const profileHref = getRestaurantProfilePath(restaurant);
  const name = restaurant.businessName || restaurant.name || canonicalLabel;
  const img = getRestaurantImage(restaurant);
  const location =
    restaurant.neighborhood || restaurant.city || restaurant.address;
  const cuisine = restaurant.cuisineType;
  const cardShellClass = isFoodTruckEntity
    ? "relative block overflow-hidden rounded-xl bg-[#100806]/86 ring-1 ring-orange-200/18 transition hover:bg-[#1a0d07]/92 hover:ring-orange-200/28 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70"
    : "block overflow-hidden rounded-xl bg-[#0c1714]/82 ring-1 ring-emerald-200/20 transition hover:bg-[#121f1b]/88 hover:ring-emerald-200/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70";
  const labelPillClass = isFoodTruckEntity
    ? "bg-[#120805]/72 text-orange-100 ring-orange-200/20"
    : "bg-[#071411]/72 text-emerald-100 ring-emerald-200/20";

  return (
    <Link
      href={profileHref}
      className={cardShellClass}
      aria-label={`Open saved ${canonicalLabel.toLowerCase()} ${name}`}
    >
      <div
        className="relative h-24 bg-[#120805]/50"
      >
        <ScoutCardMedia
          imageUrl={img || null}
          fallbackIcon={
            isFoodTruckEntity ? (
              <TruckIcon className="h-5 w-5 text-white/80" aria-hidden="true" />
            ) : (
              <MapPin className="h-5 w-5 text-white/80" aria-hidden="true" />
            )
          }
          fallbackTestId="scout-saved-restaurant-card-image-fallback"
          imageClassName="absolute inset-0 h-full w-full object-cover"
          categoryPhoto={getDishCategoryPhoto(name, cuisine)}
        />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(180deg, rgba(0,0,0,0.05), rgba(0,0,0,0.78))",
          }}
          aria-hidden="true"
        />
        <span
          className={`absolute top-2.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${isFoodTruckEntity ? "left-4" : "left-2.5"} ${labelPillClass}`}
        >
          {isFoodTruckEntity ? (
            <TruckIcon className="h-3 w-3" aria-hidden="true" />
          ) : (
            <MapPin className="h-3 w-3" aria-hidden="true" />
          )}
          {canonicalLabel}
        </span>
      </div>
      <div
        className={
          isFoodTruckEntity
            ? "border-t border-orange-200/10 bg-[#190b06]/90 px-3 py-3"
            : "border-t border-emerald-200/10 bg-[#0f1b17]/80 px-3 py-3"
        }
      >
        <p className="truncate text-sm font-semibold text-white">{name}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
          {cuisine && (
            <span
              className={
                isFoodTruckEntity ? "text-orange-200/80" : "text-emerald-200/74"
              }
            >
              {cuisine}
            </span>
          )}
          {cuisine && location && <span className="text-white/25">·</span>}
          {location && (
            <span className="truncate text-white/55">{location}</span>
          )}
        </div>
      </div>
    </Link>
  );
}

/* ============================================================
   OPEN NOW SECTION
   The first content rail under the map. Broad food view across
   any business with a public hours/schedule footprint:
     - food trucks broadcasting service
     - public events / pop-ups happening today
     - restaurants and bars with active deals
   Empty state collapses to a quiet status chip + Why? helper.
   ============================================================ */

function OpenNowSection({
  liveTrucks,
  liveTrucksLoading,
  liveTrucksError,
  restaurants,
  nearbyRestaurantsLoading,
  events,
  deals,
  locationStatus,
  onExpandMap,
  onSelectTruck,
  currentUserId,
  isSignedIn,
  menuPreviewByRestaurantId,
  relationshipSnapshot,
}: {
  liveTrucks: LiveTruckSummary[];
  liveTrucksLoading: boolean;
  liveTrucksError: boolean;
  restaurants: RestaurantSummary[];
  nearbyRestaurantsLoading: boolean;
  events: EventSummary[];
  deals: DealSummary[];
  locationStatus: "idle" | "requesting" | "ready" | "denied";
  onExpandMap: () => void;
  onSelectTruck: (truck: LiveTruckSummary) => void;
  currentUserId?: string | null;
  isSignedIn: boolean;
  menuPreviewByRestaurantId: Map<string, MenuPreviewItem[]>;
  relationshipSnapshot: RestaurantRelationshipSnapshot;
}) {
  const todaysEvents = useMemo(() => {
    const now = new Date();
    const startOfTomorrow = new Date(now);
    startOfTomorrow.setHours(24, 0, 0, 0);
    return events.filter((e) => {
      const raw = e.startsAt || e.startTime;
      if (!raw) return true; // unknown start → still surface (likely current)
      const t = new Date(raw).getTime();
      if (!Number.isFinite(t)) return true;
      return t < startOfTomorrow.getTime();
    });
  }, [events]);

  const hasAnyContent =
    liveTrucks.length > 0 ||
    restaurants.length > 0 ||
    todaysEvents.length > 0 ||
    deals.length > 0;

  // While loading and no content yet, show skeletons
  if (liveTrucksLoading && nearbyRestaurantsLoading && !hasAnyContent) {
    return (
      <section className="pl-5 pr-0 pt-2 pb-10">
        <SectionHeader
          title="Open Now"
          linkHref="/search"
          subtitle="Open restaurants, serving trucks, live deals, and food events nearby."
        />
        <div className="overflow-x-auto atmo-hide-scrollbar -mr-1">
          <ul className="flex gap-4 pr-5" role="list">
            {[0, 1, 2].map((i) => (
              <li key={i} className="shrink-0 w-[230px] sm:w-[260px]">
                <LiveTruckSkeletonCard />
              </li>
            ))}
          </ul>
        </div>
      </section>
    );
  }

  // We have local food — render a unified rail of cards.
  if (hasAnyContent) {
    const liveCount = liveTrucks.length;
    const restaurantCount = restaurants.length;
    const eventsCount = todaysEvents.length;
    const dealsCount = deals.length;
    const summaryBits = [
      restaurantCount > 0
        ? `${restaurantCount} open place${restaurantCount === 1 ? "" : "s"}`
        : null,
      liveCount > 0 ? `${liveCount} truck${liveCount === 1 ? "" : "s"}` : null,
      eventsCount > 0 ? `${eventsCount} happening today` : null,
      dealsCount > 0
        ? `${dealsCount} active deal${dealsCount === 1 ? "" : "s"}`
        : null,
    ].filter(Boolean);

    return (
      <section className="pl-5 pr-0 pt-2 pb-10">
        <SectionHeader
          title="Open Now"
          linkHref="/search"
          subtitle={
            summaryBits.length > 0
              ? summaryBits.join(" · ")
              : "Open restaurants, serving trucks, live deals, and food events nearby."
          }
        />
        <div className="overflow-x-auto atmo-hide-scrollbar -mr-1">
          <ul
            className="flex gap-4 pr-5"
            role="list"
            aria-label="Businesses, events, and deals open right now"
          >
            {liveTrucks.slice(0, 8).map((truck) => (
              <li
                key={`truck-${truck.id}`}
                className="shrink-0 w-[230px] sm:w-[260px]"
              >
                <LiveTruckCard
                  truck={truck}
                  currentUserId={currentUserId}
                  relationshipSnapshot={relationshipSnapshot}
                />
              </li>
            ))}
            {restaurants.slice(0, 8).map((restaurant) => (
              <li
                key={`restaurant-${restaurant.id}`}
                className="shrink-0 w-[230px] sm:w-[260px]"
              >
                <NearbyRestaurantCard
                  restaurant={restaurant}
                  menuPreview={
                    menuPreviewByRestaurantId.get(String(restaurant.id)) ?? []
                  }
                  isSignedIn={isSignedIn}
                  currentUserId={currentUserId}
                  relationshipSnapshot={relationshipSnapshot}
                />
              </li>
            ))}
            {todaysEvents.slice(0, 6).map((ev) => (
              <li
                key={`event-${ev.id}`}
                className="shrink-0 w-[230px] sm:w-[260px]"
              >
                <EventCard event={ev} currentUserId={currentUserId} />
              </li>
            ))}
            {deals.slice(0, 6).map((d) => (
              <li
                key={`deal-${d.id}`}
                className="shrink-0 w-[230px] sm:w-[260px]"
              >
                <DealCard deal={d} currentUserId={currentUserId} />
              </li>
            ))}
          </ul>
        </div>
      </section>
    );
  }

  // No useful local food yet: keep the page focused on the craving picker instead
  // of spending first-screen space explaining an empty feed.
  void liveTrucksError;
  void locationStatus;
  void onExpandMap;
  void onSelectTruck;
  return null;
}

/* ============================================================
   TRUCK CARD
   Shows a food truck in the Food Trucks Near You section.
   ============================================================ */

function LiveTruckMapCard({
  truck,
  userLocation,
  onClose,
}: {
  truck: LiveTruckSummary;
  userLocation?: { lat: number; lng: number } | null;
  onClose: () => void;
}) {
  const distance = formatDistance(truck);
  const wait = formatWait(truck);
  const place = formatTruckPlace(truck);
  const directionsUrl = buildTruckDirectionsUrl(truck, userLocation);

  return (
    <div
      className="absolute left-4 right-4 bottom-[calc(env(safe-area-inset-bottom)+7.25rem)] z-30 rounded-3xl bg-[#120805]/88 p-4 text-white ring-1 ring-orange-300/40 backdrop-blur-xl"
      style={{
        boxShadow:
          "0 22px 70px rgba(0,0,0,0.62), 0 0 24px rgba(255,90,47,0.18)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-orange-500/18 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-orange-200 ring-1 ring-orange-300/25">
            <span className="h-1.5 w-1.5 rounded-full bg-orange-300 animate-pulse" />
            Food truck
          </div>
          <h3 className="mt-2 truncate text-lg font-black">
            {truck.name || "Food Truck"}
          </h3>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-orange-100/80">
            <MapPin
              className="h-4 w-4 shrink-0 text-orange-300"
              aria-hidden="true"
            />
            <span className="truncate">{place}</span>
          </p>
          <p className="mt-1 text-xs text-white/60">
            {[distance, wait].filter(Boolean).join(" · ") ||
              "Center map to compare it with your location."}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full px-3 py-1 text-xs font-bold text-white/60 ring-1 ring-white/10"
        >
          Close
        </button>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <a
          href={directionsUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex flex-col items-center justify-center gap-1 rounded-2xl bg-orange-500 px-2 py-3 text-center text-xs font-black text-[#160904]"
        >
          <Navigation2 className="h-4 w-4" aria-hidden="true" />
          Directions
        </a>
        <Link
          href={getTruckProfilePath(truck)}
          className="inline-flex flex-col items-center justify-center gap-1 rounded-2xl bg-white/8 px-2 py-3 text-center text-xs font-black text-white ring-1 ring-white/10"
        >
          <Flame className="h-4 w-4 text-orange-300" aria-hidden="true" />
          Profile
        </Link>
        <Link
          href={`${getTruckProfilePath(truck)}?message=1`}
          className="inline-flex flex-col items-center justify-center gap-1 rounded-2xl bg-white/8 px-2 py-3 text-center text-xs font-black text-white ring-1 ring-white/10"
        >
          <MessageCircle
            className="h-4 w-4 text-orange-300"
            aria-hidden="true"
          />
          Message
        </Link>
      </div>
    </div>
  );
}

function MapPlaceCard({
  marker,
  userLocation,
  onClose,
}: {
  marker: MapAdapterMarker;
  userLocation?: { lat: number; lng: number } | null;
  onClose: () => void;
}) {
  const destination =
    marker.kind === "restaurant"
      ? `/restaurant/${marker.sourceId}`
      : marker.kind === "deal"
        ? "/deals-featured"
        : marker.kind === "parking"
          ? `/events?hostId=${encodeURIComponent(String(marker.sourceId))}`
          : "/events";
  const label =
    marker.kind === "restaurant"
      ? "Food spot"
      : marker.kind === "deal"
        ? "Deal today"
        : marker.kind === "parking"
          ? "Event Host"
          : "Local event";
  const action =
    marker.kind === "restaurant"
      ? "Open profile"
      : marker.kind === "deal"
        ? "View deal"
        : marker.kind === "parking"
          ? "View host"
          : "See events";
  const originParam = userLocation
    ? `&origin=${userLocation.lat},${userLocation.lng}`
    : "";
  const directionsUrl = `https://www.google.com/maps/dir/?api=1${originParam}&destination=${marker.lat},${marker.lng}&travelmode=driving`;

  if (marker.kind === "parking") {
    const parkedTrucks = marker.parkedTrucks || [];
    const hasParkedTrucks = parkedTrucks.length > 0;
    const parkingCopy = getScoutHostParkingCopy(marker.parkingStatus);
    const hostDestination = `/events?hostId=${encodeURIComponent(String(marker.sourceId))}`;

    return (
      <div
        data-scout-map-card-kind="host"
        data-parking-truth={marker.parkingStatus || "host"}
        className="absolute left-3 right-3 bottom-[calc(env(safe-area-inset-bottom)+7.25rem)] z-30 rounded-2xl bg-[#1b1008]/94 p-3 text-white ring-1 ring-amber-300/45 backdrop-blur-xl"
        style={{
          boxShadow:
            "0 18px 54px rgba(0,0,0,0.58), 0 0 22px rgba(245,158,11,0.2)",
        }}
      >
        <div className="flex items-start gap-3">
          {marker.spotImageUrl ? (
            <img
              src={marker.spotImageUrl}
              alt=""
              className="h-12 w-12 shrink-0 rounded-xl object-cover ring-1 ring-amber-200/25"
            />
          ) : (
            <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-amber-500/18 text-amber-100 ring-1 ring-amber-300/35">
              {hasParkedTrucks ? (
                <TruckIcon className="h-5 w-5" aria-hidden="true" />
              ) : (
                <MapPin className="h-5 w-5" aria-hidden="true" />
              )}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-400/20 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.12em] text-amber-100 ring-1 ring-amber-300/25">
              {parkingCopy.badge}
            </div>
            <h3 className="mt-1.5 truncate text-base font-black">
              {marker.title || "Host location"}
            </h3>
            <p className="mt-0.5 truncate text-xs font-bold text-amber-100/70">
              {marker.address || marker.subtitle || "Parking Pass host spot"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-full px-2.5 py-1 text-xs font-bold text-white/60 ring-1 ring-white/10"
          >
            Close
          </button>
        </div>

        {hasParkedTrucks ? (
          <div className="mt-3 space-y-1.5">
            {parkedTrucks.slice(0, 3).map((truck, index) => {
              const key = `${truck.id || truck.name}-${index}`;
              const content = (
                <>
                  <TruckIcon
                    className="h-3.5 w-3.5 shrink-0 text-orange-200"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{truck.name}</span>
                  {truck.slotLabel ? (
                    <span className="shrink-0 truncate text-[10px] uppercase tracking-wide text-amber-100/60">
                      {truck.slotLabel}
                    </span>
                  ) : null}
                </>
              );
              return truck.href ? (
                <Link
                  key={key}
                  href={truck.href}
                  className="flex h-9 items-center gap-2 rounded-xl bg-orange-500/10 px-3 text-xs font-black text-orange-50 ring-1 ring-orange-300/20"
                >
                  {content}
                  <ChevronRight
                    className="h-3.5 w-3.5 shrink-0 text-orange-200/70"
                    aria-hidden="true"
                  />
                </Link>
              ) : (
                <div
                  key={key}
                  className="flex h-9 items-center gap-2 rounded-xl bg-orange-500/10 px-3 text-xs font-black text-orange-50 ring-1 ring-orange-300/20"
                >
                  {content}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-3 rounded-xl bg-white/5 px-3 py-2 text-xs font-bold text-amber-50/70 ring-1 ring-white/10">
            {parkingCopy.description}
          </p>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2">
          <Link
            href={hostDestination}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-amber-400 px-3 text-center text-xs font-black text-[#1a0d03]"
          >
            View host
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          <a
            href={directionsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-white/8 px-3 text-center text-xs font-black text-white ring-1 ring-white/10"
          >
            Route
            <Navigation2
              className="h-4 w-4 text-amber-200"
              aria-hidden="true"
            />
          </a>
        </div>
      </div>
    );
  }

  return (
    <div
      className="absolute left-4 right-4 bottom-[calc(env(safe-area-inset-bottom)+7.25rem)] z-30 rounded-3xl bg-[#120805]/88 p-4 text-white ring-1 ring-orange-300/40 backdrop-blur-xl"
      style={{
        boxShadow:
          "0 22px 70px rgba(0,0,0,0.62), 0 0 24px rgba(255,90,47,0.18)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-orange-500/18 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-orange-200 ring-1 ring-orange-300/25">
            {label}
          </div>
          <h3 className="mt-2 truncate text-lg font-black">
            {marker.title || label}
          </h3>
          {marker.subtitle ? (
            <p className="mt-1 text-sm text-orange-100/75">{marker.subtitle}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full px-3 py-1 text-xs font-bold text-white/60 ring-1 ring-white/10"
        >
          Close
        </button>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Link
          href={destination}
          className="inline-flex items-center justify-center gap-2 rounded-2xl bg-orange-500 px-3 py-3 text-center text-xs font-black text-[#160904]"
        >
          {action}
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Link>
        <a
          href={directionsUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center gap-2 rounded-2xl bg-white/8 px-3 py-3 text-center text-xs font-black text-white ring-1 ring-white/10"
        >
          Directions
          <Navigation2 className="h-4 w-4 text-orange-300" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}

function MapActivityPips({
  mode,
  truckCount,
  restaurantCount,
  dealCount,
  eventCount,
}: {
  mode: ScoutActivityMode;
  truckCount: number;
  restaurantCount: number;
  dealCount: number;
  eventCount: number;
}) {
  if (mode === "low_activity") return null;

  const pips = [
    truckCount > 0
      ? { label: "Food trucks", value: truckCount, className: "bg-orange-300" }
      : null,
    restaurantCount > 0
      ? { label: "Food places", value: restaurantCount, className: "bg-emerald-300" }
      : null,
    dealCount > 0
      ? { label: "Deals", value: dealCount, className: "bg-lime-300" }
      : null,
    eventCount > 0
      ? { label: "Events", value: eventCount, className: "bg-amber-300" }
      : null,
  ].filter(
    (item): item is { label: string; value: number; className: string } =>
      Boolean(item),
  );

  if (pips.length === 0) return null;

  return (
    <div
      aria-label="Nearby discovery summary"
      data-testid="map-discovery-summary"
      className={[
        "pointer-events-none absolute left-3 top-14 z-20 flex max-w-[calc(100%-1.5rem)] flex-wrap",
        mode === "high_activity" ? "gap-2" : "gap-1.5",
      ].join(" ")}
    >
      {pips.slice(0, 4).map((pip) => (
        <span
          key={pip.label}
          className={[
            "inline-flex items-center gap-1 rounded-full font-black uppercase tracking-[0.08em] text-white ring-1 backdrop-blur-md",
            mode === "high_activity"
              ? "bg-[#120805]/78 px-2.5 py-1.5 text-[10px] ring-white/20 shadow-[0_10px_24px_rgba(0,0,0,0.34)]"
              : "bg-[#120805]/68 px-2 py-1 text-[10px] ring-white/10",
          ].join(" ")}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${pip.className}`}
            aria-hidden="true"
          />
          {pip.value} {pip.label}
        </span>
      ))}
    </div>
  );
}

function MapLayerToggles({
  layers,
  onToggle,
}: {
  layers: MapLayerState;
  onToggle: (layer: MapLayerId) => void;
}) {
  const options: Array<{
    id: MapLayerId;
    label: string;
    icon: React.ReactNode;
  }> = [
    {
      id: "openNow",
      label: "Open",
      icon: <Flame className="h-3 w-3" aria-hidden="true" />,
    },
    {
      id: "foodTrucks",
      label: "Trucks",
      icon: <Utensils className="h-3 w-3" aria-hidden="true" />,
    },
    {
      id: "deals",
      label: "Deals",
      icon: <Tag className="h-3 w-3" aria-hidden="true" />,
    },
    {
      id: "happeningToday",
      label: "Today",
      icon: <CalendarDays className="h-3 w-3" aria-hidden="true" />,
    },
  ];

  return (
    <div className="absolute left-3 right-3 top-[calc(env(safe-area-inset-top)+4.7rem)] z-20 overflow-x-auto atmo-hide-scrollbar sm:left-4 sm:right-auto sm:w-[360px]">
      <div className="flex w-max gap-1 rounded-full bg-[#120805]/66 p-1 text-[10px] font-black uppercase tracking-wide text-white/70 ring-1 ring-white/10 backdrop-blur-xl">
        {options.map((option) => {
          const isActive = layers[option.id];
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onToggle(option.id)}
              className={[
                "inline-flex h-7 items-center gap-1 rounded-full px-2 transition-colors",
                isActive
                  ? "bg-white/14 text-white ring-1 ring-white/20"
                  : "bg-transparent text-white/48 hover:bg-white/8 hover:text-white/76",
              ].join(" ")}
              aria-pressed={isActive}
            >
              {option.icon}
              <span>{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ScoutMapHud({
  locationLabel,
  marketEyebrow,
  pinCount,
  liveTruckCount,
  restaurantCount,
  eventCount,
  dealCount,
  discoveryRadiusKm,
  onRadiusChange,
  onRecenter,
}: {
  locationLabel: string;
  marketEyebrow: string;
  pinCount: number;
  liveTruckCount: number;
  restaurantCount: number;
  eventCount: number;
  dealCount: number;
  discoveryRadiusKm: number;
  onRadiusChange: (value: number) => void;
  onRecenter: () => void;
}) {
  const radiusOptions = [5, 12, 25, 40];
  const [isExpanded, setIsExpanded] = useState(false);
  const sceneCounts = [
    liveTruckCount > 0 ? `${liveTruckCount} trucks` : null,
    restaurantCount > 0 ? `${restaurantCount} food` : null,
    dealCount > 0 ? `${dealCount} deals` : null,
    eventCount > 0 ? `${eventCount} events` : null,
  ].filter((value): value is string => Boolean(value));
  const sceneLine =
    pinCount > 0
      ? sceneCounts.join(" • ") || `${pinCount} nearby places`
      : "No nearby spots yet - widen the radius or try another location";

  return (
    <div className="pointer-events-none absolute left-3 right-3 top-[calc(env(safe-area-inset-top)+4.25rem)] z-20 sm:left-4 sm:right-auto sm:w-[360px]">
      <div
        className="pointer-events-auto rounded-2xl bg-[#120805]/88 p-3 text-white ring-1 ring-orange-200/40 backdrop-blur-xl"
        style={{
          boxShadow:
            "0 18px 54px rgba(0,0,0,0.52), 0 0 26px rgba(255,90,47,0.2)",
        }}
      >
        <div className="mb-3 flex items-center justify-between gap-3 border-b border-white/10 pb-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-orange-500/15 ring-1 ring-orange-200/30">
              <img
                src={mealScoutIcon}
                alt=""
                className="h-7 w-7 object-contain"
                aria-hidden="true"
              />
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-orange-200/75">
                Map
              </p>
              <p className="truncate text-sm font-black text-white">
                Local food nearby
              </p>
            </div>
          </div>
          <span className="rounded-full bg-orange-500/16 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-orange-100 ring-1 ring-orange-200/25">
            Nearby map
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="mb-1 text-[10px] font-black uppercase tracking-[0.14em] text-orange-200/72">
              {marketEyebrow}
            </p>
            <h2 className="truncate text-base font-black text-orange-50">
              {locationLabel}
            </h2>
            <p className="text-[11px] font-semibold text-white/58">
              {sceneLine}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setIsExpanded((value) => !value)}
              className="rounded-full bg-white/8 px-3 py-2 text-xs font-black text-orange-100 ring-1 ring-orange-200/20 transition-colors hover:bg-white/12"
              aria-expanded={isExpanded}
            >
              {isExpanded ? "Less" : "Details"}
            </button>
            <button
              type="button"
              onClick={onRecenter}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[#ff5a2f] text-[#160904] ring-1 ring-orange-200/40 shadow-[0_0_18px_rgba(255,90,47,0.32)]"
              aria-label="Recenter map"
            >
              <Navigation2 className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {isExpanded && (
          <div className="mt-3">
            <p className="text-xs text-white/62">
              Tap nearby spots to jump into what's cooking near you right
              now.
            </p>
            <div className="mt-3 grid grid-cols-4 gap-2 text-center">
              <MapHudCount label="Trucks" value={liveTruckCount} />
              <MapHudCount label="Food" value={restaurantCount} />
              <MapHudCount label="Deals" value={dealCount} />
              <MapHudCount label="Events" value={eventCount} />
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5 rounded-2xl bg-black/18 px-2.5 py-2 ring-1 ring-white/10">
              <MapFreshnessKey dotClassName="bg-emerald-300" label="Updated" />
              <MapFreshnessKey
                dotClassName="bg-orange-200"
                label="Older info"
              />
            </div>
          </div>
        )}

        <div className="mt-3 flex items-center justify-between gap-2 rounded-2xl bg-white/7 px-3 py-2 ring-1 ring-orange-200/10">
          <span className="text-xs font-bold text-white/72">Radius</span>
          <div className="flex rounded-full bg-black/25 p-1">
            {radiusOptions.map((radius) => {
              const isActive = discoveryRadiusKm === radius;
              return (
                <button
                  key={radius}
                  type="button"
                  onClick={() => onRadiusChange(radius)}
                  className={[
                    "rounded-full px-2 py-1 text-[10px] font-black transition-colors",
                    isActive
                      ? "bg-[#ff5a2f] text-[#1b0b02] shadow-[0_0_14px_rgba(255,90,47,0.3)]"
                      : "text-white/58 hover:text-white",
                  ].join(" ")}
                  aria-pressed={isActive}
                >
                  {Math.round(radius * 0.621371)} mi
                </button>
              );
            })}
          </div>
        </div>

        {isExpanded && pinCount === 0 ? (
          <div className="mt-3 rounded-2xl bg-white/7 px-3 py-2 text-xs text-white/72 ring-1 ring-white/10">
            No nearby spots right here yet. Widen the radius or try another
            location.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MapHudCount({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-white/7 px-2 py-2 ring-1 ring-white/10">
      <p className="text-base font-black text-orange-200">{value}</p>
      <p className="text-[9px] font-bold uppercase tracking-wide text-white/48">
        {label}
      </p>
    </div>
  );
}

function MapFreshnessKey({
  dotClassName,
  label,
}: {
  dotClassName: string;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/6 px-2 py-1 text-[10px] font-bold text-white/62">
      <span
        className={`h-1.5 w-1.5 rounded-full ${dotClassName}`}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

function MapEdgeIndicators({
  markers,
  bounds,
  center,
  selectedId,
  onSelect,
}: {
  markers: MapAdapterMarker[];
  bounds: MapBoundsLike;
  center?: { lat: number; lng: number } | null;
  selectedId?: string | null;
  onSelect: (marker: MapAdapterMarker) => void;
}) {
  if (!center) return null;
  const offscreen = markers
    .filter((marker) => marker.kind !== "user")
    .filter(
      (marker) => marker.id !== selectedId && marker.sourceId !== selectedId,
    )
    .filter((marker) => !bounds.contains([marker.lat, marker.lng]))
    .map((marker) => {
      const dx = marker.lng - center.lng;
      const dy = marker.lat - center.lat;
      const horizontal = Math.abs(dx) > Math.abs(dy);
      const edge = horizontal
        ? dx > 0
          ? "right"
          : "left"
        : dy > 0
          ? "top"
          : "bottom";
      const distanceScore = Math.sqrt(dx * dx + dy * dy);
      return { marker, edge, distanceScore };
    })
    .sort((a, b) => a.distanceScore - b.distanceScore)
    .slice(0, 8);

  if (offscreen.length === 0) return null;

  const byEdge = offscreen.reduce<Record<string, typeof offscreen>>(
    (acc, item) => {
      acc[item.edge] = acc[item.edge] || [];
      acc[item.edge].push(item);
      return acc;
    },
    {},
  );

  const edgeClass: Record<string, string> = {
    top: "left-1/2 top-[calc(env(safe-area-inset-top)+15.5rem)] -translate-x-1/2 flex-row",
    right: "right-3 top-1/2 -translate-y-1/2 flex-col",
    bottom:
      "left-1/2 bottom-[calc(env(safe-area-inset-bottom)+12rem)] -translate-x-1/2 flex-row",
    left: "left-3 top-1/2 -translate-y-1/2 flex-col",
  };

  return (
    <>
      {Object.entries(byEdge).map(([edge, items]) => (
        <div
          key={edge}
          className={`pointer-events-none absolute z-25 flex gap-2 ${edgeClass[edge]}`}
        >
          {items.slice(0, 3).map(({ marker }) => (
            <button
              key={marker.id}
              type="button"
              onClick={() => onSelect(marker)}
              className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-[#1b0d05]/88 px-3 py-2 text-xs font-black text-orange-100 ring-1 ring-orange-300/40 backdrop-blur-xl"
              style={{
                boxShadow:
                  "0 12px 36px rgba(0,0,0,0.42), 0 0 18px rgba(255,90,47,0.16)",
              }}
              aria-label={`Show ${marker.title || marker.kind} on map`}
            >
              <span className="text-orange-300">
                {edge === "left"
                  ? "‹"
                  : edge === "right"
                    ? "›"
                    : edge === "top"
                      ? "⌃"
                      : "⌄"}
              </span>
              <span>
                {marker.kind === "truck"
                  ? "Truck"
                  : marker.kind === "restaurant"
                    ? "Food"
                    : marker.kind === "deal"
                      ? "Deal"
                      : marker.kind === "parking"
                        ? "Host"
                        : "Event"}
              </span>
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

function TruckCard({
  truck,
  viewModel,
  onSelect,
  currentUserId,
}: {
  truck: LiveTruckSummary;
  viewModel?: ScoutResultViewModel;
  onSelect?: (truck: LiveTruckSummary) => void;
  currentUserId?: string | null;
}) {
  const cardView = viewModel || buildTruckResultViewModel(truck);
  const name = cardView.title || "Food Truck";
  const cuisine = truck.cuisineType ?? null;
  const img = cardView.imageUrl;
  const cardHref = cardView.href;

  const distMiles = truck.distanceMiles;
  const distKm = truck.distance;
  let distLabel: string | null = null;
  if (typeof distMiles === "number" && Number.isFinite(distMiles)) {
    distLabel = `${distMiles.toFixed(distMiles < 10 ? 1 : 0)} mi`;
  } else if (typeof distKm === "number" && Number.isFinite(distKm)) {
    const m = distKm * 0.621371;
    distLabel = `${m.toFixed(m < 10 ? 1 : 0)} mi`;
  }

  const wait = truck.waitMinutes ?? truck.estimatedWaitMinutes;
  const waitLabel =
    typeof wait === "number" && Number.isFinite(wait) && wait > 0
      ? `~${Math.round(wait)} min`
      : null;
  const isServing = isTruckServingNow(truck);
  const truckTone = getTruckCardTone(truck);
  const freshnessMeta: FreshnessMeta = {
    kind: "truck",
    updatedAt: readStringField(truck, ["updatedAt", "lastUpdatedAt"]),
    confirmedAt: readStringField(truck, ["confirmedAt", "lastConfirmedAt"]),
    hasDeal: Boolean(truck.activeDealCount && truck.activeDealCount > 0),
    hasDistance: Boolean(distLabel),
    isOpen: isServing,
  };
  const badges = getOperationalBadges(freshnessMeta).slice(0, 3);
  const canEdit = isOwnedByCurrentUser(truck, currentUserId);
  const actions = canEdit
    ? [
        {
          label: "Update status",
          href: getTruckUpdateHref(String(truck.id), "status"),
          icon: <Flame className="h-3 w-3" aria-hidden="true" />,
        },
        {
          label: "Confirm location",
          href: getTruckUpdateHref(String(truck.id), "location"),
          icon: <Navigation2 className="h-3 w-3" aria-hidden="true" />,
        },
      ]
    : [];

  return (
    <Link
      href={cardHref}
      onClick={(event) => {
        if (!onSelect) return;
        event.preventDefault();
        onSelect(truck);
      }}
      className="relative block overflow-hidden rounded-2xl bg-[#2a1b14] ring-1 ring-orange-200/18 transition duration-200 hover:-translate-y-0.5 hover:ring-orange-200/34 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70"
      style={{
        boxShadow: "0 12px 28px rgba(0,0,0,0.24)",
      }}
    >
      {/* Hero image */}
      <div className="relative aspect-[16/9] w-full overflow-hidden bg-[#120805]/40">
        <ScoutCardMedia
          imageUrl={img || null}
          imageObjectPosition={cardView.imageObjectPosition}
          fallbackIcon={
            <TruckIcon className="h-5 w-5 text-white/80" aria-hidden="true" />
          }
          fallbackTestId="scout-truck-card-image-fallback"
          imageClassName="h-full w-full object-cover"
          categoryPhoto={getDishCategoryPhoto(
            truck.name,
            truck.cuisineType,
            truck.vibe,
          )}
        />
        <ScoutNetworkScopeBadge label={cardView.scopeLabel} />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(180deg, rgba(0,0,0,0) 40%, rgba(0,0,0,0.75) 100%)",
          }}
          aria-hidden="true"
        />
        <span
          className={`absolute top-2.5 left-3 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide shadow ring-1 ${getTruckToneClass(truckTone.tone)}`}
        >
          <TruckIcon className="h-3 w-3" aria-hidden="true" />
          <span
            className={`h-1.5 w-1.5 rounded-full ${getTruckToneDotClass(truckTone.tone)}`}
            aria-hidden="true"
          />
          {truckTone.label}
        </span>
        {truck.activeDealCount && truck.activeDealCount > 0 ? (
          <span className="absolute top-2.5 right-2.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide text-white bg-orange-600 shadow">
            <Tag className="h-2.5 w-2.5" aria-hidden="true" />
            Deal
          </span>
        ) : null}
        <span className="absolute bottom-2.5 left-4 inline-flex items-center rounded-full bg-black/62 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white/86 ring-1 ring-white/10">
          Food truck
        </span>
      </div>
      {/* Info */}
      <div className="border-t border-orange-200/10 bg-[#2a1b14] px-3 py-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-orange-300/10 text-orange-200 ring-1 ring-orange-200/18">
            <TruckIcon className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-black leading-snug text-orange-50">
              {name}
            </p>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              {cuisine && (
                <span className="text-orange-200/82 text-[11px]">
                  {cuisine}
                </span>
              )}
              {cuisine && (distLabel || waitLabel) && (
                <span className="text-white/24 text-[11px]">/</span>
              )}
              {distLabel && (
                <span className="text-orange-50/55 text-[11px]">{distLabel}</span>
              )}
              {distLabel && waitLabel && (
                <span className="text-white/24 text-[11px]">/</span>
              )}
              {waitLabel && (
                <span className="text-orange-50/48 text-[11px]">
                  {waitLabel} wait
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {badges.map((badge) => (
            <span
              key={badge}
              className={getFreshnessBadgeClass(freshnessMeta, badge)}
            >
              {badge}
            </span>
          ))}
        </div>
        <OwnerOperationalActions actions={actions} />
      </div>
    </Link>
  );
}

/* ============================================================
   HORIZONTAL SKELETON ROW
   Loading placeholder for any horizontal scroll section.
   ============================================================ */

function HorizontalSkeletonRow({
  count = 3,
  width = 200,
}: {
  count?: number;
  width?: number;
}) {
  return (
    <div className="overflow-x-auto atmo-hide-scrollbar -mr-1">
      <ul className="flex gap-4 pr-5" role="list" aria-label="Loading…">
        {Array.from({ length: count }).map((_, i) => (
          <li key={i} className="shrink-0" style={{ width }}>
            <div className="overflow-hidden rounded-2xl bg-[#2a1b14] ring-1 ring-orange-200/14">
              <div className="aspect-[4/3] w-full animate-pulse bg-white/5" />
              <div className="p-3 space-y-2">
                <div className="h-3 w-3/4 animate-pulse rounded bg-white/10" />
                <div className="h-2.5 w-1/2 animate-pulse rounded bg-white/7" />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
