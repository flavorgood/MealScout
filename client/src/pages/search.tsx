import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { apiUrl } from "@/lib/api";
import { fetchSearchJson, searchArray, unifiedSearchResult, validSearchLocation, withinSearchRadius, type SearchLocation } from "@/lib/search-scope";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Link } from "wouter";
import Navigation from "@/components/navigation";
import DealCard from "@/components/deal-card";
import SmartSearch from "@/components/smart-search";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Card, CardContent } from "@/components/ui/card";
import {
  Search,
  Filter,
  MapPin,
  Clock,
  X,
  SlidersHorizontal,
  Utensils,
  Pizza,
  Sandwich,
  Soup,
  UtensilsCrossed,
  Salad,
  Coffee,
  Fish,
  Cake,
  Croissant,
  Beef,
  ChefHat,
  Crown,
  ArrowDownToLine,
} from "lucide-react";
import { SEOHead } from "@/components/seo-head";
import { trackUxEvent } from "@/utils/uxTelemetry";
import { useIsStandalone } from "@/hooks/useIsStandalone";

type DiscoveryCity = {
  id: string;
  name: string;
  slug: string;
  state?: string | null;
  cuisines: Array<{ slug: string; count: number }>;
};

type MenuItemSearchResult = {
  id: string;
  name: string;
  description?: string | null;
  priceCents?: number | null;
  imageUrl?: string | null;
  restaurantId: string;
  restaurantName?: string | null;
  restaurantCity?: string | null;
  restaurantState?: string | null;
  cuisineType?: string | null;
  distanceMiles?: number | null;
  dietaryTags?: string[] | null;
  discoveryReasons?: string[] | null;
  discoveryScore?: number | null;
};

function trackMenuItemSearchEngagement(payload: {
  eventName: "menu_item_click";
  itemId: string;
  restaurantId?: string | null;
  query?: string;
  position?: number;
  discoveryScore?: number | null;
  discoveryReasons?: string[] | null;
}) {
  void fetch(apiUrl("/api/menus/local-items/engagement"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    keepalive: true,
    body: JSON.stringify({
      ...payload,
      surface: "search",
      layerId: "menuItems",
    }),
  }).catch(() => {});
}

const titleCaseSlug = (value: string) =>
  value
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const DISCOVERY_RADIUS_STORAGE_KEY = "mealscout:discovery-radius-km";
const DEFAULT_DISCOVERY_RADIUS_KM = 12;
const MIN_DISCOVERY_RADIUS_KM = 3;
const MAX_DISCOVERY_RADIUS_KM = 40;

function clampDiscoveryRadiusKm(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DISCOVERY_RADIUS_KM;
  return Math.max(MIN_DISCOVERY_RADIUS_KM, Math.min(MAX_DISCOVERY_RADIUS_KM, value));
}

function readDiscoveryRadiusKm(): number {
  if (typeof window === "undefined") return DEFAULT_DISCOVERY_RADIUS_KM;
  try {
    const raw = window.localStorage.getItem(DISCOVERY_RADIUS_STORAGE_KEY);
    if (raw === null || raw.trim() === "") return DEFAULT_DISCOVERY_RADIUS_KM;
    return clampDiscoveryRadiusKm(Number(raw));
  } catch { return DEFAULT_DISCOVERY_RADIUS_KM; }
}

// Category configuration mapping (from category.tsx)
const categoryConfig = {
  pizza: { title: "Pizza", icon: Pizza, keywords: ["pizza", "italian"] },
  burgers: {
    title: "Burgers",
    icon: Sandwich,
    keywords: ["american", "burger", "sandwich"],
  },
  asian: {
    title: "Asian",
    icon: Soup,
    keywords: ["asian", "chinese", "japanese", "sushi", "noodle"],
  },
  mexican: {
    title: "Mexican",
    icon: UtensilsCrossed,
    keywords: ["mexican", "taco", "burrito"],
  },
  healthy: {
    title: "Healthy",
    icon: Salad,
    keywords: ["healthy", "salad", "smoothie"],
  },
  breakfast: {
    title: "Breakfast",
    icon: Croissant,
    keywords: ["breakfast", "brunch", "pancake", "coffee"],
  },
  seafood: {
    title: "Seafood",
    icon: Fish,
    keywords: ["seafood", "fish", "shrimp"],
  },
  coffee: {
    title: "Coffee",
    icon: Coffee,
    keywords: ["cafe", "coffee", "latte"],
  },
  dessert: {
    title: "Desserts",
    icon: Cake,
    keywords: ["dessert", "ice cream", "cake"],
  },
};

const synonymGroups = [
  ["bbq", "barbecue", "smokehouse"],
  ["burger", "burgers", "sandwich"],
  ["taco", "tacos", "burrito", "mexican"],
  ["pizza", "pizzeria", "italian"],
  ["coffee", "cafe", "latte"],
  ["dessert", "desserts", "sweet", "sweets", "bakery"],
  ["seafood", "fish", "shrimp"],
  ["vegan", "vegetarian", "plant"],
  ["breakfast", "brunch"],
];

const synonymIndex = synonymGroups.reduce<Record<string, string[]>>(
  (acc, group) => {
    group.forEach((term) => {
      acc[term] = group.filter((candidate) => candidate !== term);
    });
    return acc;
  },
  {},
);

const normalizeSearchText = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenVariants = (token: string): string[] => {
  const variants = new Set<string>();
  const normalized = normalizeSearchText(token);
  if (!normalized) return [];

  variants.add(normalized);
  if (normalized.endsWith("s") && normalized.length > 3) {
    variants.add(normalized.slice(0, -1));
  } else if (normalized.length > 3) {
    variants.add(`${normalized}s`);
  }

  (synonymIndex[normalized] || []).forEach((term) => variants.add(term));
  return Array.from(variants);
};

const buildQueryGroups = (query: string): string[][] => {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];

  const tokens = normalized.split(" ").filter((token) => token.length > 1);
  if (tokens.length === 0) return [];
  return tokens.map(tokenVariants).filter((variants) => variants.length > 0);
};

const normalizeDealFields = (deal: any) => ({
  title: normalizeSearchText(deal.title || ""),
  description: normalizeSearchText(deal.description || ""),
  restaurantName: normalizeSearchText(deal.restaurant?.name || ""),
  cuisineType: normalizeSearchText(deal.restaurant?.cuisineType || ""),
});

const matchesQueryGroups = (deal: any, queryGroups: string[][]) => {
  if (queryGroups.length === 0) return true;

  const fields = normalizeDealFields(deal);
  const haystack = `${fields.title} ${fields.description} ${fields.restaurantName} ${fields.cuisineType}`;
  return queryGroups.every((group) =>
    group.some((variant) => haystack.includes(variant)),
  );
};

const relevanceScore = (deal: any, queryGroups: string[][]) => {
  if (queryGroups.length === 0) return 0;
  const fields = normalizeDealFields(deal);
  let score = 0;

  queryGroups.forEach((group) => {
    if (group.some((variant) => fields.title.includes(variant))) score += 6;
    if (group.some((variant) => fields.restaurantName.includes(variant)))
      score += 4;
    if (group.some((variant) => fields.cuisineType.includes(variant)))
      score += 3;
    if (group.some((variant) => fields.description.includes(variant)))
      score += 2;
  });

  return score;
};

const levenshteinDistance = (a: string, b: string) => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[a.length][b.length];
};

export default function SearchPage() {
  const isStandalone = useIsStandalone();
  const [location, setLocation] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [showFilters, setShowFilters] = useState(false);
  const [priceRange, setPriceRange] = useState([0, 50]);
  const [sortBy, setSortBy] = useState("relevance");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [discoveryRadiusKm, setDiscoveryRadiusKm] = useState<number>(() =>
    readDiscoveryRadiusKm(),
  );

  // Location state management
  const [userLocation, setUserLocation] = useState<SearchLocation | null>(() => {
    try {
      const stored = JSON.parse(window.sessionStorage.getItem("mealscout:search-location") || "null");
      return validSearchLocation(stored) ? stored : null;
    } catch { return null; }
  });
  const [widerSearch, setWiderSearch] = useState(false);
  const localLocation = widerSearch ? null : userLocation;
  const [manualLocation, setManualLocation] = useState("");
  const [manualChoices, setManualChoices] = useState<Array<{lat: string; lon: string; display_name: string}>>([]);
  const [manualSearching, setManualSearching] = useState(false);
  const locationRequest = useRef(0);
  const hasCurrentSearch = searchQuery.trim().length >= 2 && searchQuery.trim() === debouncedSearchQuery;
  const saveLocation = (next: SearchLocation) => {
    locationRequest.current += 1;
    setUserLocation(next);
    setWiderSearch(false);
    setIsLocating(false);
    setManualSearching(false);
    setManualChoices([]);
    setLocationError(null);
    try { window.sessionStorage.setItem("mealscout:search-location", JSON.stringify(next)); } catch {}
  };
  const [isLocating, setIsLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  const updateDiscoveryRadiusKm = useCallback((values: number[]) => {
    const nextRadius = clampDiscoveryRadiusKm(Number(values[0]));
    setDiscoveryRadiusKm(nextRadius);
    if (typeof window !== "undefined") {
      try { window.localStorage.setItem(DISCOVERY_RADIUS_STORAGE_KEY, String(nextRadius)); } catch {}
    }
  }, []);

  // Parse URL query parameter
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const query = urlParams.get("q");
    setSearchQuery(query || "");
  }, [location]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim());
    }, 250);
    return () => clearTimeout(timeoutId);
  }, [searchQuery]);

  const requestUserLocation = () => {
    if (!navigator.geolocation) {
      setLocationError("Geolocation is not available on this device.");
      return;
    }

    const request = ++locationRequest.current;
    setIsLocating(true);
    setLocationError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (request !== locationRequest.current) return;
        const location = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };
        if (validSearchLocation(location)) saveLocation({ ...location, label: "Your location" });
        else { setLocationError("Unable to get your location."); setIsLocating(false); }
      },
      () => {
        if (request !== locationRequest.current) return;
        setLocationError("Unable to get your location.");
        setIsLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  useEffect(() => () => { locationRequest.current += 1; }, []);

  const findManualLocation = async () => {
    if (!manualLocation.trim()) return;
    const request = ++locationRequest.current;
    setIsLocating(false);
    setManualSearching(true);
    setLocationError(null);
    setManualChoices([]);
    try {
      const data = await fetchSearchJson(apiUrl(`/api/location/search?q=${encodeURIComponent(manualLocation.trim())}&limit=5`));
      const choices = searchArray(data).filter((row) =>
        typeof row.display_name === "string" && row.lat != null && row.lon != null && String(row.lat).trim() !== "" && String(row.lon).trim() !== "" &&
        validSearchLocation({ lat: Number(row.lat), lng: Number(row.lon) }),
      );
      if (request !== locationRequest.current) return;
      setManualChoices(choices);
      if (choices.length === 0) setLocationError("Location not found or lookup unavailable. Try another city or ZIP code.");
    } catch (error) {
      if (request === locationRequest.current) setLocationError(error instanceof Error ? error.message : "Location search is unavailable. Please retry.");
    } finally {
      if (request === locationRequest.current) setManualSearching(false);
    }
  };

  const scopeKey = [localLocation?.lat ?? null, localLocation?.lng ?? null, discoveryRadiusKm];
  const scopedParams = (query: string, radiusKey = "radius") => {
    const params = new URLSearchParams({ q: query });
    if (localLocation) {
      params.set("lat", String(localLocation.lat));
      params.set("lng", String(localLocation.lng));
      params.set(radiusKey, String(discoveryRadiusKm));
    }
    return params;
  };
  const fetchCollection = async (path: string, signal: AbortSignal) => {
    return searchArray(await fetchSearchJson(apiUrl(path), signal), path.startsWith("/api/restaurants/") ? ["id", "name"] : ["id", "title"]);
  };
  const nearbyQuery = useQuery<any[]>({
    queryKey: ["/api/deals/nearby", ...scopeKey],
    queryFn: ({ signal }) => fetchCollection(`/api/deals/nearby/${localLocation!.lat}/${localLocation!.lng}?radius=${discoveryRadiusKm}`, signal),
    enabled: !searchQuery.trim() && !!localLocation,
    retry: false,
  });
  const featuredQuery = useQuery<any[]>({
    queryKey: ["/api/deals/featured"],
    queryFn: ({ signal }) => fetchCollection("/api/deals/featured", signal),
    enabled: !searchQuery.trim() && !localLocation && !isLocating,
    retry: false,
  });
  const unifiedQuery = useQuery<Record<string, any[]>>({
    // The aggregate endpoint has no proximity contract. Its restaurant/deal
    // rows cannot establish membership in a local-radius search.
    queryKey: ["/api/search", debouncedSearchQuery],
    queryFn: async ({ signal }) => {
      return unifiedSearchResult(await fetchSearchJson(apiUrl(`/api/search?q=${encodeURIComponent(debouncedSearchQuery)}`), signal));
    },
    enabled: hasCurrentSearch,
    staleTime: 30_000,
    retry: false,
  });
  const restaurantQuery = useQuery<any[]>({
    queryKey: ["/api/restaurants/search", debouncedSearchQuery, ...scopeKey],
    queryFn: ({ signal }) => fetchCollection(`/api/restaurants/search?${scopedParams(debouncedSearchQuery)}`, signal),
    enabled: hasCurrentSearch,
    staleTime: 30_000,
    retry: false,
  });
  const dealSearchQuery = useQuery<any[]>({
    queryKey: ["/api/deals/search", debouncedSearchQuery, ...scopeKey],
    queryFn: ({ signal }) => fetchCollection(`/api/deals/search?${scopedParams(debouncedSearchQuery)}`, signal),
    enabled: hasCurrentSearch && !!localLocation,
    staleTime: 30_000,
    retry: false,
  });
  const menuQuery = useQuery<MenuItemSearchResult[]>({
    queryKey: ["/api/menus/local-items", debouncedSearchQuery, ...scopeKey],
    queryFn: async ({ signal }) => {
      const params = scopedParams(debouncedSearchQuery, "radiusKm");
      params.set("limit", "48");
      const data = await fetchSearchJson(apiUrl(`/api/menus/local-items?${params}`), signal) as { items?: unknown };
      return searchArray(data?.items, ["id", "name", "restaurantId"]);
    },
    enabled: hasCurrentSearch,
    staleTime: 30_000,
    retry: false,
  });
  const unifiedResults = hasCurrentSearch && !unifiedQuery.isError ? unifiedQuery.data : undefined;
  const restaurantSearchResults = hasCurrentSearch && !restaurantQuery.isError ? restaurantQuery.data || [] : [];
  const menuItemSearchResults = (hasCurrentSearch && !menuQuery.isError ? menuQuery.data || [] : []).filter((item) =>
    !localLocation || (typeof item.distanceMiles === "number" && Number.isFinite(item.distanceMiles) &&
      item.distanceMiles >= 0 && item.distanceMiles <= discoveryRadiusKm * 0.621371),
  );
  const nearbyDeals = localLocation && !nearbyQuery.isError ? nearbyQuery.data : undefined;
  const featuredDeals = localLocation || featuredQuery.isError ? undefined : featuredQuery.data;
  const activeSources = searchQuery.trim().length >= 2
    ? hasCurrentSearch ? [{ name: "Restaurants", query: restaurantQuery }, { name: "Menu items", query: menuQuery },
      { name: localLocation ? "Parking spots" : "Deals, parking, videos and events", query: unifiedQuery },
      ...(localLocation ? [{ name: "Deals", query: dealSearchQuery }] : [])] : []
    : searchQuery.trim() ? [] : [{ name: "Deals", query: localLocation ? nearbyQuery : featuredQuery }];
  const loadingSources = activeSources.filter(({ query }) => query.isFetching);
  const failedSources = activeSources.filter(({ query }) => query.isError);
  const isLoading = isLocating || (searchQuery.trim().length >= 2 && !hasCurrentSearch) || loadingSources.length > 0;
  const dealsLoading = searchQuery.trim()
    ? hasCurrentSearch && (localLocation ? dealSearchQuery.isFetching : unifiedQuery.isFetching)
    : localLocation ? nearbyQuery.isFetching : featuredQuery.isFetching;
  const dealsUnavailable = searchQuery.trim()
    ? hasCurrentSearch && (localLocation ? dealSearchQuery.isError : unifiedQuery.isError)
    : localLocation ? nearbyQuery.isError : featuredQuery.isError;


  // Function to map cuisine types and titles to category IDs
  const mapDealToCategory = (deal: any): string[] => {
    const categories: string[] = [];
    const cuisineType = normalizeSearchText(deal.restaurant?.cuisineType || "");
    const title = normalizeSearchText(deal.title || "");

    // Check each category for matches
    Object.entries(categoryConfig).forEach(([categoryId, config]) => {
      const keywords = config.keywords;
      const matches = keywords.some(
        (keyword) =>
          cuisineType.includes(normalizeSearchText(keyword)) ||
          title.includes(normalizeSearchText(keyword)),
      );
      if (matches) {
        categories.push(categoryId);
      }
    });

    return categories;
  };

  // Generate dynamic categories based on nearby deals
  const generateDynamicCategories = (deals: any[]) => {
    const categoryCounts: Record<string, number> = {};

    // Count deals per category
    deals.forEach((deal) => {
      const dealCategories = mapDealToCategory(deal);
      dealCategories.forEach((categoryId) => {
        categoryCounts[categoryId] = (categoryCounts[categoryId] || 0) + 1;
      });
    });

    // Sort categories by count and take top 5
    const sortedCategories = Object.entries(categoryCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([categoryId]) => categoryId);

    // Build category buttons
    const dynamicCategories = [{ id: "all", label: "All", icon: Utensils }];

    sortedCategories.forEach((categoryId) => {
      if (categoryConfig[categoryId as keyof typeof categoryConfig]) {
        const config =
          categoryConfig[categoryId as keyof typeof categoryConfig];
        dynamicCategories.push({
          id: categoryId,
          label: config.title,
          icon: config.icon,
        });
      }
    });

    return dynamicCategories;
  };

  // Static fallback categories
  const staticCategories = [
    { id: "all", label: "All", icon: Utensils },
    { id: "pizza", label: "Pizza", icon: Pizza },
    { id: "burgers", label: "Burgers", icon: Beef },
    { id: "asian", label: "Asian", icon: ChefHat },
    { id: "mexican", label: "Mexican", icon: Crown },
    { id: "healthy", label: "Healthy", icon: Salad },
  ];

  // Use dynamic categories when we have nearby deals, otherwise use static
  const allDeals = Array.isArray(nearbyDeals)
    ? nearbyDeals
    : Array.isArray(featuredDeals)
      ? featuredDeals
      : [];
  const searchedDeals = localLocation
    ? (hasCurrentSearch && !dealSearchQuery.isError ? dealSearchQuery.data || [] : []).filter((deal) => withinSearchRadius(deal.restaurant, localLocation, discoveryRadiusKm))
    : unifiedResults?.deals || [];
  const searchedRestaurants = Array.isArray(
    (unifiedResults as any)?.restaurants,
  )
    ? (unifiedResults as any).restaurants
    : [];
  const mergedRestaurants = useMemo(() => {
    const byId = new Map<string, any>();
    (localLocation ? [] : searchedRestaurants).forEach((restaurant: any) => {
      const id = String(restaurant?.id || "").trim();
      if (!id) return;
      byId.set(id, restaurant);
    });
    restaurantSearchResults.filter((restaurant) => !localLocation || withinSearchRadius(restaurant, localLocation, discoveryRadiusKm)).forEach((restaurant: any) => {
      const id = String(restaurant?.id || "").trim();
      if (!id) return;
      const existing = byId.get(id) || {};
      byId.set(id, {
        ...existing,
        id,
        name: restaurant?.name || existing?.name,
        cuisineType: restaurant?.cuisineType || existing?.cuisineType,
        address: restaurant?.address || existing?.address,
        businessType: restaurant?.businessType || existing?.businessType,
        logoUrl: restaurant?.logoUrl || existing?.logoUrl || null,
        coverImageUrl: restaurant?.coverImageUrl || existing?.coverImageUrl || null,
        imageUrl:
          restaurant?.coverImageUrl ||
          restaurant?.logoUrl ||
          restaurant?.imageUrl ||
          existing?.imageUrl ||
          null,
        isFoodTruck: Boolean(
          restaurant?.isFoodTruck ??
            (String(restaurant?.businessType || existing?.businessType || "")
              .toLowerCase() === "food_truck"),
        ),
        isVerified: Boolean(restaurant?.isVerified ?? existing?.isVerified),
      });
    });
    return Array.from(byId.values()).slice(0, 24);
  }, [searchedRestaurants, restaurantSearchResults, localLocation, discoveryRadiusKm]);
  const searchedParkingPassHosts = Array.isArray(
    (unifiedResults as any)?.parkingPassHosts,
  )
    ? (unifiedResults as any).parkingPassHosts.filter((host: any) => !localLocation || withinSearchRadius(host, localLocation, discoveryRadiusKm))
    : [];
  const searchedVideos = !localLocation && Array.isArray((unifiedResults as any)?.videos)
    ? (unifiedResults as any).videos
    : [];
  const searchedEvents = !localLocation && Array.isArray((unifiedResults as any)?.events)
    ? (unifiedResults as any).events
    : [];
  const totalOtherMatches =
    menuItemSearchResults.length +
    mergedRestaurants.length +
    searchedParkingPassHosts.length +
    searchedVideos.length +
    searchedEvents.length;

  const dealsForPage = searchQuery.trim() ? searchedDeals : allDeals.filter((deal: any) => !localLocation || withinSearchRadius(deal.restaurant, localLocation, discoveryRadiusKm));
  const queryGroups = buildQueryGroups(searchQuery);
  const categories =
    !searchQuery && localLocation && nearbyDeals && nearbyDeals.length > 0
      ? generateDynamicCategories(nearbyDeals)
      : staticCategories;

  // allDeals is already defined above
  const filteredDeals = useMemo(
    () =>
      dealsForPage
        .filter((deal: any) => {
          const matchesSearch =
            !searchQuery || matchesQueryGroups(deal, queryGroups);

          const matchesCategory =
            selectedCategory === "all" ||
            (selectedCategory &&
              mapDealToCategory(deal).includes(selectedCategory));

          // Apply price range filter
          const dealPrice = parseFloat(deal.minOrderAmount) || 0;
          const matchesPrice =
            dealPrice >= priceRange[0] && dealPrice <= priceRange[1];

          return matchesSearch && matchesCategory && matchesPrice;
        })
        .sort((a: any, b: any) => {
          // Apply sorting
          switch (sortBy) {
            case "price_low":
              return (
                parseFloat(a.minOrderAmount || "0") -
                parseFloat(b.minOrderAmount || "0")
              );
            case "price_high":
              return (
                parseFloat(b.minOrderAmount || "0") -
                parseFloat(a.minOrderAmount || "0")
              );
            case "discount":
              return (
                parseFloat(b.discountValue || "0") -
                parseFloat(a.discountValue || "0")
              );
            case "newest":
              return (
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime()
              );
            default:
              if (searchQuery) {
                const bScore = relevanceScore(b, queryGroups);
                const aScore = relevanceScore(a, queryGroups);
                if (bScore !== aScore) return bScore - aScore;
                return (
                  parseFloat(b.discountValue || "0") -
                  parseFloat(a.discountValue || "0")
                );
              }
              return 0;
          }
        }),
    [
      dealsForPage,
      searchQuery,
      queryGroups,
      selectedCategory,
      priceRange,
      sortBy,
    ],
  );

  const totalStructuredMatches = totalOtherMatches + filteredDeals.length;

  const suggestionTerms = useMemo(() => {
    const fromCategories = Object.values(categoryConfig).flatMap((category) =>
      category.keywords.map(normalizeSearchText),
    );
    const fromSynonyms = synonymGroups.flat().map(normalizeSearchText);
    const fromRestaurants = mergedRestaurants
      .map((restaurant: any) => normalizeSearchText(restaurant.name || ""))
      .filter((value: string) => value.length >= 3);
    const fromCuisine = mergedRestaurants
      .map((restaurant: any) =>
        normalizeSearchText(restaurant.cuisineType || ""),
      )
      .filter((value: string) => value.length >= 3);
    return Array.from(
      new Set([
        ...fromCategories,
        ...fromSynonyms,
        ...fromRestaurants,
        ...fromCuisine,
      ]),
    ).filter((value) => value.length >= 3);
  }, [mergedRestaurants]);

  const didYouMean = useMemo(() => {
    const query = normalizeSearchText(searchQuery);
    if (!query || query.length < 3) return null;
    let best: { term: string; score: number } | null = null;
    for (const term of suggestionTerms) {
      if (term === query) continue;
      const score = levenshteinDistance(query, term);
      const threshold = query.length <= 5 ? 1 : 2;
      if (score <= threshold && (!best || score < best.score)) {
        best = { term, score };
      }
    }
    return best ? best.term : null;
  }, [searchQuery, suggestionTerms]);
  const hasSearchIntent =
    searchQuery.trim().length > 0 || selectedCategory !== "all";

  const searchTitle = searchQuery
    ? `${searchQuery} - Search Results`
    : "Search";
  const searchDescription = searchQuery
    ? `Find deals, restaurants, and menu items for "${searchQuery}" on MealScout.`
    : "Search for deals, restaurants, parking pass spots, videos, and events.";
  const searchKeywordVariants = searchQuery
    ? Array.from(new Set(queryGroups.flat()).values()).slice(0, 8).join(", ")
    : "food search";
  const searchCanonicalUrl = searchQuery
    ? `https://www.mealscout.us/search?q=${encodeURIComponent(searchQuery)}`
    : "https://www.mealscout.us/search";

  const searchSchemaData = useMemo(
    () => ({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "SearchResultsPage",
          name: searchQuery
            ? `MealScout search results for ${searchQuery}`
            : "MealScout Search",
          url: searchCanonicalUrl,
          description: searchDescription,
          about: searchQuery || "local food deals",
          mainEntity: {
            "@type": "ItemList",
            name: searchQuery
              ? `Deals matching ${searchQuery}`
              : "Featured searchable deals",
            numberOfItems: filteredDeals.slice(0, 12).length,
            itemListElement: filteredDeals
              .slice(0, 12)
              .map((deal: any, index: number) => ({
                "@type": "ListItem",
                position: index + 1,
                name: deal.title,
                url: `https://www.mealscout.us/deal/${deal.id}`,
              })),
          },
        },
        {
          "@type": "WebSite",
          name: "MealScout",
          url: "https://www.mealscout.us/",
          potentialAction: {
            "@type": "SearchAction",
            target: "https://www.mealscout.us/search?q={search_term_string}",
            "query-input": "required name=search_term_string",
          },
        },
      ],
    }),
    [searchQuery, searchCanonicalUrl, searchDescription, filteredDeals],
  );
  type TrendingSearchRow = { query: string; count: number };
  const { data: trendingSearches = [] } = useQuery<TrendingSearchRow[]>({
    queryKey: ["/api/search/trending", "search-discovery"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/search/trending?limit=8"));
      if (!res.ok) throw new Error("Failed to fetch trending searches");
      return res.json();
    },
    staleTime: 30_000,
  });
  const searchExploreLinks = [
    {
      href: "/scout",
      title: "Live Food Truck Map",
      description:
        "Open the interactive map to see trucks, events, and nearby deals.",
    },
    {
      href: "/deals/featured",
      title: "Featured Food Deals",
      description: "Browse hand-picked local restaurant and food truck offers.",
    },
    {
      href: "/how-it-works",
      title: "How MealScout Works",
      description: "Learn how to discover, save, and redeem local food deals.",
    },
    {
      href: "/faq",
      title: "MealScout FAQ",
      description:
        "Get quick answers about accounts, deals, and location-based results.",
    },
  ];
  const fallbackTrending = [
    "tacos",
    "bbq",
    "wings",
    "seafood",
    "breakfast",
    "food trucks",
    "pizza",
    "coffee",
  ];
  const trendingLinks = (
    Array.isArray(trendingSearches) && trendingSearches.length > 0
      ? trendingSearches.map((row) => row?.query).filter(Boolean)
      : fallbackTrending
  )
    .slice(0, 8)
    .map((query) => ({
      href: `/search?q=${encodeURIComponent(query)}`,
      title: query,
      description:
        "See matching restaurants, trucks, deals, parking, and events.",
    }));

  async function trackSearch(query: string, source: string) {
    try {
      await fetch(apiUrl("/api/search/track"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, source }),
        keepalive: true,
      });
    } catch {
      // no-op
    }
  }

  return (
    <div className="max-w-md lg:max-w-4xl xl:max-w-6xl mx-auto bg-[var(--bg-layered)] min-h-screen relative pb-20">
      <SEOHead
        title={`${searchTitle} | MealScout`}
        description={searchDescription}
        keywords={`food deals near me, food truck search, restaurant specials, local food finder, nearby food trucks, event food vendors, ${
          searchKeywordVariants
        }, nearby restaurants, meal deals, food truck locations`}
        canonicalUrl={searchCanonicalUrl}
        schemaData={searchSchemaData}
      />
      {/* Header */}
      <header className="px-4 sm:px-6 py-6 bg-[hsl(var(--background))/0.94] border-b border-[color:var(--border-subtle)] shadow-clean">
        <div className="mb-6 flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Search</h1>
            <p className="text-sm text-muted-foreground">
              {isLocating && !searchQuery
                ? "Finding your location..."
                : localLocation && !searchQuery
                  ? "Popular deals near you"
                  : isLoading
                    ? "Searching available sources..."
                    : failedSources.length > 0
                      ? "Some search sources are unavailable"
                      : searchQuery.trim().length === 1
                        ? "Enter at least two characters"
                  : searchQuery && totalStructuredMatches > 0
                    ? "Showing restaurants, trucks, and deals that match your search"
                    : searchQuery
                      ? localLocation ? "No food matches in your selected radius" : "No matches yet"
                      : "Use location for nearby results or browse featured deals"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!isStandalone && (
              <Link href="/install">
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  data-testid="button-install"
                  onPointerDown={() => {
                    trackUxEvent("search_install_click", {
                      surface: "search_header",
                    });
                  }}
                  aria-label="Install app"
                  title="Install app"
                >
                  <ArrowDownToLine className="w-4 h-4" />
                </Button>
              </Link>
            )}
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => setShowFilters(!showFilters)}
              data-testid="button-filter"
              aria-label={showFilters ? "Hide filters" : "Show filters"}
              aria-expanded={showFilters}
            >
              <SlidersHorizontal className="w-4 h-4" />
            </Button>
          </div>
        </div>
        {locationError && (
          <p
            className="mb-4 text-xs text-[color:var(--status-error)]"
            role="alert"
          >
            {locationError}
          </p>
        )}

        <div className="mb-4 space-y-3">
          <p className="text-sm font-semibold" data-testid="search-scope">
            {localLocation
              ? `Nearby: within ${discoveryRadiusKm} km of ${localLocation.label || "your selected location"}`
              : userLocation
                ? "Wider search: all locations, including results outside your saved radius"
                : "All locations: choose a location for nearby results"}
          </p>
          {userLocation && (
            <Button variant="outline" size="sm" data-testid="button-search-wider" onClick={() => setWiderSearch(!widerSearch)}>
              {widerSearch ? "Return to nearby results" : "Search all locations"}
            </Button>
          )}
          {localLocation && searchQuery.trim() && (
            <div className="space-y-2 text-xs text-muted-foreground">
              <p data-testid="search-parking-coverage">
                Parking coverage is limited to spots included in wider search; other nearby spots may be missing. Search all locations to browse the available parking results.
              </p>
              <p>
                Videos and events do not provide a nearby location in search. Choose Search all locations to include them.
              </p>
            </div>
          )}
          <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void findManualLocation(); }}>
            <div className="min-w-0 flex-1">
              <label htmlFor="search-location" className="mb-1 block text-xs text-muted-foreground">City, ZIP code, or address</label>
              <Input id="search-location" value={manualLocation} data-testid="input-search-location" placeholder="Enter a location" onChange={(event) => {
                locationRequest.current += 1;
                setManualLocation(event.target.value);
                setManualChoices([]);
                setManualSearching(false);
                setIsLocating(false);
              }} />
            </div>
            <Button type="submit" variant="outline" className="self-end" disabled={manualSearching || !manualLocation.trim()} data-testid="button-search-location">
              {manualSearching ? "Finding..." : "Find location"}
            </Button>
          </form>
          {manualChoices.length > 0 && (
            <ul aria-label="Choose search location" className="space-y-2">
              {manualChoices.map((choice, index) => (
                <li key={`${choice.lat}-${choice.lon}-${index}`}>
                  <Button variant="outline" className="h-auto w-full whitespace-normal text-left" data-testid={`button-location-choice-${index}`} onClick={() => saveLocation({ lat: Number(choice.lat), lng: Number(choice.lon), label: choice.display_name })}>
                    {choice.display_name}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {userLocation && (
          <Card className="mb-4 bg-[var(--bg-card)] border-[color:var(--border-subtle)] shadow-clean">
            <CardContent className="p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    Search radius
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Nearby restaurants, menus, deals, and parking use this radius.
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-orange-500/10 px-3 py-1 text-xs font-bold text-orange-700 dark:text-orange-200">
                  {Math.max(1, Math.round(discoveryRadiusKm * 0.621371))} mi
                </span>
              </div>
              <Slider
                value={[discoveryRadiusKm]}
                onValueChange={updateDiscoveryRadiusKm}
                min={MIN_DISCOVERY_RADIUS_KM}
                max={MAX_DISCOVERY_RADIUS_KM}
                step={1}
                className="w-full"
                aria-label="Search radius"
              />
              <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
                <span>2 mi</span>
                <span>25 mi</span>
              </div>
            </CardContent>
          </Card>
        )}

        {!isLocating && (
          <div className="mb-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
            <Button
              variant="outline"
              size="sm"
              onClick={requestUserLocation}
              data-testid="button-search-quick-location"
              aria-label="Use my location"
              onPointerDown={() => {
                trackUxEvent("search_location_request_quick", {
                  surface: "search_quick_actions",
                });
              }}
            >
              <MapPin className="w-4 h-4 mr-1" />
              Use location
            </Button>
            <Link href="/scout">
              <Button
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                data-testid="button-search-quick-map"
                onPointerDown={() => {
                  trackUxEvent("search_open_map_quick", {
                    surface: "search_quick_actions",
                  });
                }}
              >
                <MapPin className="w-4 h-4 mr-1" />
                Scout
              </Button>
            </Link>
          </div>
        )}

        {/* Search Bar */}
        <SmartSearch
          value={searchQuery}
          onChange={setSearchQuery}
          onSearch={(query) => {
            setSearchQuery(query);
            void trackSearch(query, "search_submit");
            // Update URL with search query
            const newUrl = `/search?q=${encodeURIComponent(query)}`;
            setLocation(newUrl);
          }}
          placeholder="Search restaurants, cuisines, deals..."
          className="mb-6"
        />

        {/* Category Filters */}
        <div className="flex space-x-3 overflow-x-auto pb-2 lg:grid lg:grid-cols-6 lg:gap-3 lg:overflow-visible">
          {categories.map((category) => (
            <Button
              key={category.id}
              variant={selectedCategory === category.id ? "default" : "outline"}
              size="sm"
              onClick={() => setSelectedCategory(category.id)}
              className="flex-shrink-0 rounded-full px-4 py-2"
              data-testid={`button-category-${category.id}`}
            >
              <category.icon className="w-4 h-4 mr-2" />
              {category.label}
            </Button>
          ))}
        </div>

        {/* Advanced Filters Panel */}
        {showFilters && (
          <Card className="mb-6 bg-[var(--bg-card)] border-[color:var(--border-subtle)] shadow-clean">
            <CardContent className="p-4 space-y-4">
              {/* Sort By */}
              <div>
                <label className="block text-sm font-semibold text-foreground mb-2">
                  Sort by
                </label>
                <Select value={sortBy} onValueChange={setSortBy}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="relevance">Most Relevant</SelectItem>
                    <SelectItem value="price_low">
                      Price: Low to High
                    </SelectItem>
                    <SelectItem value="price_high">
                      Price: High to Low
                    </SelectItem>
                    <SelectItem value="discount">Best Discount</SelectItem>
                    <SelectItem value="newest">Newest First</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Price Range */}
              <div>
                <label className="block text-sm font-semibold text-foreground mb-2">
                  Price Range: ${priceRange[0]} - ${priceRange[1]}
                </label>
                <Slider
                  value={priceRange}
                  onValueChange={setPriceRange}
                  max={100}
                  step={5}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-muted-foreground mt-1">
                  <span>$0</span>
                  <span>$100+</span>
                </div>
              </div>

              {/* Clear Filters */}
              <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-sm text-muted-foreground">
                  {filteredDeals.length} deal
                  {filteredDeals.length === 1 ? "" : "s"} found
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full sm:w-auto"
                  onClick={() => {
                    setSortBy("relevance");
                    setPriceRange([0, 50]);
                    setSelectedCategory("all");
                    setSearchQuery("");
                    setLocation("/search");
                  }}
                >
                  <X className="w-3 h-3 mr-1" />
                  Clear All
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </header>

      {/* Results */}
      <div className="px-4 sm:px-6 py-6">
        {isLoading && (
          <p role="status" data-testid="search-loading-sources" className="mb-4 text-sm text-muted-foreground">
            Searching{loadingSources.length > 0 ? `: ${loadingSources.map(({ name }) => name).join(", ")}` : "..."}. Results appear as each source finishes.
          </p>
        )}
        {failedSources.length > 0 && (
          <div role="alert" data-testid="search-source-errors" className="mb-6 rounded-xl border border-[color:var(--border-subtle)] p-4">
            <p className="text-sm font-semibold">{failedSources.map(({ name }) => name).join(", ")} unavailable.</p>
            <p className="mt-1 text-sm text-muted-foreground">Search is incomplete. Available results remain below.</p>
            <Button variant="outline" className="mt-3" data-testid="button-retry-search" onClick={() => { failedSources.forEach(({ query }) => { void query.refetch(); }); }}>Retry unavailable sources</Button>
          </div>
        )}
        {/* Menu Items Section (primary food-intent result) */}
        {searchQuery && menuItemSearchResults.length > 0 && (
          <div className="mb-8">
            <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  Menu items matching "{searchQuery}"
                </h2>
                <p className="text-sm text-muted-foreground">
                  Compare the actual dishes first, then pick the place.
                </p>
              </div>
              <span className="text-sm text-muted-foreground">
                {menuItemSearchResults.length} found
              </span>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
              {menuItemSearchResults.map((item, index) => {
                const price =
                  typeof item.priceCents === "number"
                    ? `$${(item.priceCents / 100).toFixed(item.priceCents % 100 === 0 ? 0 : 2)}`
                    : null;
                const distance =
                  typeof item.distanceMiles === "number"
                    ? `${item.distanceMiles.toFixed(item.distanceMiles < 10 ? 1 : 0)} mi`
                    : null;
                return (
                  <Link
                    key={item.id}
                    href={`/restaurant/${item.restaurantId}`}
                    onClick={() =>
                      trackMenuItemSearchEngagement({
                        eventName: "menu_item_click",
                        itemId: item.id,
                        restaurantId: item.restaurantId,
                        query: searchQuery,
                        position: index,
                        discoveryScore: item.discoveryScore,
                        discoveryReasons: item.discoveryReasons,
                      })
                    }
                    data-testid={`card-menu-item-${item.id}`}
                  >
                    <Card className="bg-[var(--bg-card)] border-[color:var(--border-subtle)] shadow-clean hover:shadow-clean-lg transition-shadow cursor-pointer overflow-hidden">
                      {item.imageUrl ? (
                        <img
                          src={item.imageUrl}
                          alt=""
                          className="h-36 w-full object-cover"
                          loading="lazy"
                        />
                      ) : null}
                      <CardContent className="p-4 space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3 className="font-semibold text-foreground truncate">
                              {item.name}
                            </h3>
                            <p className="text-sm text-primary font-medium truncate">
                              {item.restaurantName || "Local spot"}
                            </p>
                          </div>
                          {price && (
                            <span className="rounded-full bg-primary/10 px-2 py-1 text-xs font-bold text-primary">
                              {price}
                            </span>
                          )}
                        </div>
                        {item.description && (
                          <p className="line-clamp-2 text-sm text-muted-foreground">
                            {item.description}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                          {item.cuisineType && <span>{item.cuisineType}</span>}
                          {item.restaurantCity && <span>{item.restaurantCity}</span>}
                          {distance && <span>{distance}</span>}
                        </div>
                        {Array.isArray(item.discoveryReasons) &&
                          item.discoveryReasons.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 pt-1">
                              {item.discoveryReasons.slice(0, 3).map((reason) => (
                                <span
                                  key={reason}
                                  className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
                                >
                                  {reason}
                                </span>
                              ))}
                            </div>
                          )}
                      </CardContent>
                    </Card>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {/* Restaurants Section (when searching) */}
        {searchQuery && mergedRestaurants.length > 0 && (
          <div className="mb-8">
            <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-lg font-semibold text-foreground">
                Restaurants & Food Trucks
              </h2>
              <span className="text-sm text-muted-foreground">
                {mergedRestaurants.length} found
              </span>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
              {mergedRestaurants.map((restaurant: any) => (
                <Link
                  key={restaurant.id}
                  href={`/restaurant/${restaurant.id}`}
                  data-testid={`card-restaurant-${restaurant.id}`}
                >
                  <Card className="bg-[var(--bg-card)] border-[color:var(--border-subtle)] shadow-clean hover:shadow-clean-lg transition-shadow cursor-pointer">
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        {restaurant.imageUrl ? (
                          <img
                            src={restaurant.imageUrl}
                            alt={restaurant.name || "Business image"}
                            className="h-14 w-14 rounded-md border object-cover"
                            loading="lazy"
                          />
                        ) : null}
                        <div className="flex-1">
                          <h3
                            className="font-semibold text-foreground mb-1"
                            data-testid={`text-restaurant-name-${restaurant.id}`}
                          >
                            {restaurant.name}
                          </h3>
                          <p className="text-sm text-muted-foreground mb-2">
                            {restaurant.isFoodTruck
                              ? "Food truck"
                              : restaurant.cuisineType}
                          </p>
                          {restaurant.address && (
                            <p className="text-xs text-muted-foreground flex items-center gap-1">
                              <MapPin className="w-3 h-3" />
                              {restaurant.address}
                            </p>
                          )}
                        </div>
                        {restaurant.isVerified && (
                          <div className="bg-primary/10 text-primary text-xs px-2 py-1 rounded-full">
                            Verified
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        )}

        {searchQuery && searchedParkingPassHosts.length > 0 && (
          <div className="mb-8">
            <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-lg font-semibold text-foreground">
                Parking Pass Spots
              </h2>
              <span className="text-sm text-muted-foreground">
                {searchedParkingPassHosts.length} found
              </span>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
              {searchedParkingPassHosts.map((host: any) => {
                const q =
                  `${host.address || ""}${host.city ? `, ${host.city}` : ""}${host.state ? `, ${host.state}` : ""}`.trim();
                return (
                  <Link
                    key={host.hostId}
                    href={`/parking-pass${q ? `?q=${encodeURIComponent(q)}` : ""}`}
                    data-testid={`card-parking-pass-${host.hostId}`}
                  >
                    <Card className="bg-[var(--bg-card)] border-[color:var(--border-subtle)] shadow-clean hover:shadow-clean-lg transition-shadow cursor-pointer">
                      <CardContent className="p-4 space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3 className="font-semibold text-foreground truncate">
                              {host.businessName || "Parking Pass spot"}
                            </h3>
                            <p className="text-xs text-muted-foreground flex items-center gap-1">
                              <MapPin className="w-3 h-3" />
                              <span className="truncate">{q}</span>
                            </p>
                          </div>
                          <div className="text-xs rounded-full bg-primary/10 text-primary px-2 py-1">
                            Bookable
                          </div>
                        </div>
                        {host.spotImageUrl ? (
                          <img
                            src={host.spotImageUrl}
                            alt="Parking spot"
                            className="w-full h-28 object-cover rounded-md border"
                            loading="lazy"
                          />
                        ) : null}
                      </CardContent>
                    </Card>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {searchQuery && searchedVideos.length > 0 && (
          <div className="mb-8">
            <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-lg font-semibold text-foreground">Videos</h2>
              <span className="text-sm text-muted-foreground">
                {searchedVideos.length} found
              </span>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
              {searchedVideos.map((story: any) => (
                <Link
                  key={story.id}
                  href={`/video/${story.id}`}
                  data-testid={`card-video-${story.id}`}
                >
                  <Card className="bg-[var(--bg-card)] border-[color:var(--border-subtle)] shadow-clean hover:shadow-clean-lg transition-shadow cursor-pointer">
                    <CardContent className="p-4 space-y-1">
                      <div className="font-semibold text-foreground truncate">
                        {story.title || "Video"}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {story.restaurantName
                          ? `From ${story.restaurantName}`
                          : "Video story"}
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        )}

        {searchQuery && searchedEvents.length > 0 && (
          <div className="mb-8">
            <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-lg font-semibold text-foreground">Events</h2>
              <span className="text-sm text-muted-foreground">
                {searchedEvents.length} found
              </span>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
              {searchedEvents.map((event: any) => (
                <Link
                  key={event.id}
                  href="/events/public"
                  data-testid={`card-event-${event.id}`}
                >
                  <Card className="bg-[var(--bg-card)] border-[color:var(--border-subtle)] shadow-clean hover:shadow-clean-lg transition-shadow cursor-pointer">
                    <CardContent className="p-4 space-y-1">
                      <div className="font-semibold text-foreground truncate">
                        {event.name || event.hostBusinessName || "Event"}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {event.hostBusinessName}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {event.hostCity}
                        {event.hostState ? `, ${event.hostState}` : ""}
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Deals Section */}
        <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-semibold text-foreground">
            {searchQuery ? `Deals matching "${searchQuery}"` : "Popular Deals"}
          </h2>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {dealsLoading ? "Loading deals..." : dealsUnavailable ? "Deal results unavailable" : `${filteredDeals.length} deals found`}
            </span>
          </div>
        </div>

        {dealsLoading || (searchQuery.trim().length >= 2 && !hasCurrentSearch) ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="bg-[var(--bg-card)] rounded-2xl overflow-hidden animate-pulse shadow-clean border border-[color:var(--border-subtle)]"
              >
                <div className="w-full h-48 bg-muted"></div>
                <div className="p-6 space-y-3">
                  <div className="h-6 bg-muted rounded-lg w-3/4"></div>
                  <div className="h-4 bg-muted rounded-lg w-1/2"></div>
                </div>
              </div>
            ))}
          </div>
        ) : filteredDeals.length > 0 ? (
          <div className="space-y-4 lg:grid lg:grid-cols-2 xl:grid-cols-3 lg:gap-6 lg:space-y-0">
            {filteredDeals.map((deal: any) => (
              <DealCard key={deal.id} deal={deal} />
            ))}
          </div>
        ) : (
          <div className="text-center py-12">
            <div className="w-20 h-20 bg-[var(--bg-surface-muted)] rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Search className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="font-bold text-lg text-foreground mb-2" data-testid="search-empty-message">
              {searchQuery.trim().length === 1
                ? "Enter at least two characters"
                : dealsUnavailable
                  ? "Deals unavailable"
                  : failedSources.length > 0 || isLoading
                    ? "Search is incomplete"
                    : searchQuery && totalStructuredMatches > 0
                ? "No deals found"
                : hasSearchIntent
                  ? localLocation ? "No nearby food matches found" : "No matches found"
                  : "Start with what sounds good"}
            </h3>
            <p className="text-muted-foreground">
              {searchQuery.trim().length === 1
                ? "Search for a dish, place, or truck."
                : dealsUnavailable
                  ? "We could not load deals. Retry the unavailable source above."
                  : failedSources.length > 0 || isLoading
                    ? "More results may appear when the remaining sources finish or recover."
                    : searchQuery && totalStructuredMatches > 0
                ? "Other matching results are listed above even without active deals."
                : hasSearchIntent
                  ? localLocation
                    ? searchQuery.trim()
                      ? "No matching restaurants, menu items, or deals returned within your radius. Parking coverage is limited; other nearby spots may be missing. Use Search all locations to browse available parking results."
                      : "No deals match your current filters within your radius. Try another dish, place, truck, or category."
                    : "Try another dish, place, truck, or category."
                  : "Search for a dish or place, choose a category, or scout."}
            </p>
            {didYouMean && (
              <div className="mt-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    trackUxEvent("search_did_you_mean_clicked", {
                      fromQuery: searchQuery,
                      suggestion: didYouMean,
                    });
                    setSearchQuery(didYouMean);
                    setLocation(`/search?q=${encodeURIComponent(didYouMean)}`);
                  }}
                  data-testid="button-did-you-mean"
                >
                  Did you mean "{didYouMean}"?
                </Button>
              </div>
            )}
            {hasSearchIntent && (
              <Button
                onClick={() => {
                  setSearchQuery("");
                  setSelectedCategory("all");
                  setLocation("/search");
                }}
                className="mt-4"
                data-testid="button-clear-search"
              >
                Clear Search
              </Button>
            )}
            {hasSearchIntent && (
              <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                {!userLocation && !isLocating && (
                  <Button
                    variant="outline"
                    onClick={requestUserLocation}
                    data-testid="button-empty-use-location"
                    onPointerDown={() => {
                      trackUxEvent("search_location_request_empty", {
                        surface: "search_empty_state",
                      });
                    }}
                  >
                    Use location
                  </Button>
                )}
                <Link href="/deals/featured">
                  <Button
                    variant="outline"
                    data-testid="button-empty-featured"
                    onPointerDown={() => {
                      trackUxEvent("search_featured_empty", {
                        surface: "search_empty_state",
                      });
                    }}
                  >
                    View featured deals
                  </Button>
                </Link>
                <Link href="/scout">
                  <Button
                    variant="outline"
                    data-testid="button-empty-map"
                    onPointerDown={() => {
                      trackUxEvent("search_open_map_empty", {
                        surface: "search_empty_state",
                      });
                    }}
                  >
                    Scout
                  </Button>
                </Link>
              </div>
            )}
          </div>
        )}

        <section className="mt-10 rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-card)] p-5 shadow-clean">
          <h2 className="text-base font-semibold text-foreground">
            Explore More Food Deals Nearby
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Keep browsing popular MealScout pages for restaurants, food trucks,
            and local deals.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {searchExploreLinks.map((link) => (
              <Link key={link.href} href={link.href}>
                <Card className="h-full border-[color:var(--border-subtle)] bg-[var(--bg-surface)] shadow-clean transition-shadow hover:shadow-clean-lg">
                  <CardContent className="p-4">
                    <div className="font-medium text-foreground">
                      {link.title}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {link.description}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
          {trendingLinks.length > 0 && (
            <>
              <h3 className="mt-5 text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Trending Searches
              </h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {trendingLinks.map((link) => (
                  <Link key={link.href} href={link.href}>
                    <Card className="h-full border-[color:var(--border-subtle)] bg-[var(--bg-surface)] shadow-clean transition-shadow hover:shadow-clean-lg">
                      <CardContent className="p-4">
                        <div className="font-medium text-foreground">
                          {link.title}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {link.description}
                        </p>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </>
          )}
        </section>
      </div>

      {!userLocation && !isLocating && (
        <section className="mt-4 md:hidden">
          <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-card)] p-3 shadow-clean">
            <p className="text-xs text-muted-foreground mb-2">
              Use your location for better nearby matches and faster results.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={requestUserLocation}
                data-testid="button-search-inline-location"
                onPointerDown={() => {
                  trackUxEvent("search_location_request_inline", {
                    surface: "search_inline_cta",
                  });
                }}
              >
                Use location
              </Button>
              <Link href="/scout">
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  data-testid="button-search-inline-map"
                  onPointerDown={() => {
                    trackUxEvent("search_open_map_inline", {
                      surface: "search_inline_cta",
                    });
                  }}
                >
                  Scout
                </Button>
              </Link>
            </div>
          </div>
        </section>
      )}

      <Navigation />
    </div>
  );
}
