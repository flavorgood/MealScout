import { useState, useEffect, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ToastAction } from "@/components/ui/toast";
import { Flame, Clock, Heart, UserPlus } from "lucide-react";
import { GoldenForkIcon } from "@/components/award-badges";
import { apiRequest } from "@/lib/queryClient";
import { trackDealViewOnce } from "@/lib/dealViewTracking";
import { getAffiliateShareUrl } from "@/lib/share";
import DealShareModal from "./deal-share-modal";
import RestaurantDealsDrawer from "./restaurant-deals-drawer";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { authUrl } from "@/lib/api";
import {
  createAdaptiveImageMetadata,
  getAdaptiveImageForPlacement,
  type AdaptiveImageSource,
} from "@/lib/adaptiveImages";
import {
  DEFAULT_TRUCK_BROADCAST_FRESHNESS_MS,
  deriveTruckPresence,
} from "@shared/consumerEntity";

const SAVED_DEALS_KEY = "mealscout_saved_deals";
let followSnapshotPromise: Promise<Set<string>> | null = null;
let followSnapshotCache: Set<string> | null = null;

function getSavedDeals(): string[] {
  try {
    const raw = localStorage.getItem(SAVED_DEALS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistSavedDeals(ids: string[]) {
  try {
    localStorage.setItem(SAVED_DEALS_KEY, JSON.stringify(ids));
  } catch {
    // Best effort; ignore storage failures
  }
}

async function getFollowedRestaurantIds(): Promise<Set<string>> {
  if (followSnapshotCache) return followSnapshotCache;
  if (!followSnapshotPromise) {
    followSnapshotPromise = (async () => {
      try {
        const follows = await apiRequest("GET", "/api/following/restaurants");
        const list = Array.isArray(follows) ? follows : [];
        const ids = new Set<string>(
          list
            .map((follow: any) => follow.restaurantId || follow.restaurant?.id)
            .filter(Boolean)
        );
        followSnapshotCache = ids;
        return ids;
      } catch (error) {
        console.error("Failed to load follow snapshot:", error);
        followSnapshotCache = new Set();
        return followSnapshotCache;
      }
    })();
  }
  return followSnapshotPromise;
}

interface Deal {
  id: string;
  restaurantId: string;
  title: string;
  description: string;
  dealType: string;
  discountValue: string;
  minOrderAmount?: string;
  imageUrl?: string;
  adaptiveImage?: AdaptiveImageSource | null;
  facebookPageUrl?: string;
  isAiGenerated?: boolean;
  restaurant?: {
    name: string;
    cuisineType?: string;
    phone?: string;
    latitude?: number;
    longitude?: number;
    isFoodTruck?: boolean;
    mobileOnline?: boolean;
    liveBroadcasting?: boolean | null;
    currentLatitude?: number | string | null;
    currentLongitude?: number | string | null;
    lastBroadcastAt?: string | null;
    liveUntilAt?: string | null;
    locationSource?: string | null;
    gpsAccuracy?: number | string | null;
  };
  distance?: number;
  currentUses?: number;
  totalUsesLimit?: number;
}

interface DealCardProps {
  deal: Deal;
  popularity?: {
    tier: "hot" | "rising" | "steady" | "new";
    label: string;
    color: string;
    score: number;
  } | null;
}

function formatRelativeTime(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  const ts = date.getTime();
  if (Number.isNaN(ts)) return null;

  const deltaMs = Date.now() - ts;
  if (deltaMs < 0) return "Updated recently";
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Updated ${days}d ago`;
}

const getDefaultImage = (cuisineType?: string, title?: string) => {
  const images = {
    poke: "/images/category-fallback/craving-poke.jpg",
    smoothieBowl: "/images/category-fallback/craving-smoothie-bowl.jpg",
    sandwich: "/images/category-fallback/craving-sandwich.jpg",
    salad: "/images/category-fallback/craving-salad.jpg",
    wings: "/images/category-fallback/craving-wings.jpg",
    bbq: "/images/category-fallback/craving-bbq.jpg",
    coffee: "/images/category-fallback/craving-coffee.jpg",
    breakfast: "/images/category-fallback/craving-breakfast.jpg",
    pizza:
      "https://images.unsplash.com/photo-1565299624946-b28f40a0ca4b?w=400&h=300&fit=crop&auto=format",
    burger:
      "https://images.unsplash.com/photo-1571091718767-18b5b1457add?w=400&h=300&fit=crop&auto=format",
    mexican:
      "https://images.unsplash.com/photo-1565299507177-b0ac66763828?w=400&h=300&fit=crop&auto=format",
    asian:
      "https://images.unsplash.com/photo-1563379091339-03246963d51a?w=400&h=300&fit=crop&auto=format",
    italian:
      "https://images.unsplash.com/photo-1565299624946-b28f40a0ca4b?w=400&h=300&fit=crop&auto=format",
    chinese:
      "https://images.unsplash.com/photo-1526318896980-cf78c088247c?w=400&h=300&fit=crop&auto=format",
    indian:
      "https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=400&h=300&fit=crop&auto=format",
    cafe: "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=400&h=300&fit=crop&auto=format",
    creole:
      "https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=400&h=300&fit=crop&auto=format",
    seafood: "/images/category-fallback/craving-seafood.jpg",
    sushi:
      "https://images.unsplash.com/photo-1563379091339-03246963d51a?w=400&h=300&fit=crop&auto=format",
    deli: "https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=400&h=300&fit=crop&auto=format",
    healthy:
      "https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=400&h=300&fit=crop&auto=format",
    default:
      "https://images.unsplash.com/photo-1493770348161-369560ae357d?w=400&h=300&fit=crop&auto=format",
  };

  const lowerCuisine = cuisineType?.toLowerCase() || "";
  const lowerTitle = title?.toLowerCase() || "";

  // Title-based matching
  if (lowerTitle.includes("poke")) return images.poke;
  if (lowerTitle.includes("wing")) return images.wings;
  if (lowerTitle.includes("bbq") || lowerTitle.includes("barbecue"))
    return images.bbq;
  if (lowerTitle.includes("smoothie") || lowerTitle.includes("acai") || lowerTitle.includes("açaí"))
    return images.smoothieBowl;
  if (lowerTitle.includes("salad")) return images.salad;
  if (lowerTitle.includes("sandwich")) return images.sandwich;
  if (lowerTitle.includes("burger")) return images.burger;
  if (lowerTitle.includes("pizza")) return images.pizza;
  if (lowerTitle.includes("taco") || lowerTitle.includes("burrito"))
    return images.mexican;
  if (lowerTitle.includes("sushi") || lowerTitle.includes("roll"))
    return images.sushi;
  if (lowerTitle.includes("coffee")) return images.coffee;
  if (lowerTitle.includes("beignet") || lowerTitle.includes("pastry"))
    return images.cafe;
  if (
    lowerTitle.includes("breakfast") ||
    lowerTitle.includes("brunch") ||
    lowerTitle.includes("mimosa")
  )
    return images.breakfast;
  if (lowerTitle.includes("curry") || lowerTitle.includes("naan"))
    return images.indian;
  if (lowerTitle.includes("pasta") || lowerTitle.includes("garlic bread"))
    return images.italian;
  if (lowerTitle.includes("noodle") || lowerTitle.includes("bowl"))
    return images.asian;
  if (lowerTitle.includes("jambalaya")) return images.creole;
  if (
    lowerTitle.includes("shrimp") ||
    lowerTitle.includes("fish") ||
    lowerTitle.includes("catch")
  )
    return images.seafood;

  // Cuisine-based matching
  if (lowerCuisine.includes("bbq") || lowerCuisine.includes("barbecue"))
    return images.bbq;
  if (lowerCuisine.includes("mexican")) return images.mexican;
  if (lowerCuisine.includes("chinese") || lowerCuisine.includes("asian"))
    return images.chinese;
  if (lowerCuisine.includes("italian")) return images.italian;
  if (lowerCuisine.includes("indian")) return images.indian;
  if (lowerCuisine.includes("cafe")) return images.cafe;
  if (lowerCuisine.includes("creole")) return images.creole;
  if (lowerCuisine.includes("seafood")) return images.seafood;
  if (lowerCuisine.includes("sushi")) return images.sushi;
  if (lowerCuisine.includes("deli")) return images.deli;
  if (lowerCuisine.includes("healthy")) return images.healthy;

  return images.default;
};

export default function DealCard({ deal, popularity = null }: DealCardProps) {
  const { user, isGuest } = useAuth();
  const isLiveTruck = Boolean(
    deal.restaurant?.isFoodTruck &&
      deriveTruckPresence(
        {
          mobileOnline: deal.restaurant.mobileOnline,
          liveBroadcasting: deal.restaurant.liveBroadcasting,
          currentLatitude: deal.restaurant.currentLatitude,
          currentLongitude: deal.restaurant.currentLongitude,
          lastBroadcastAt: deal.restaurant.lastBroadcastAt,
          liveUntilAt: deal.restaurant.liveUntilAt,
          locationSource: deal.restaurant.locationSource,
          gpsAccuracy: deal.restaurant.gpsAccuracy,
        },
        { freshnessMs: DEFAULT_TRUCK_BROADCAST_FRESHNESS_MS },
      ).broadcastState === "live",
  );
  const [showShareModal, setShowShareModal] = useState(false);
  const [showDealsDrawer, setShowDealsDrawer] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const [hasTrackedView, setHasTrackedView] = useState(false);
  const viewTimerRef = useRef<number | null>(null);
  const [forkPressed, setForkPressed] = useState(false);
  const [showRecommendModal, setShowRecommendModal] = useState(false);
  const [recommendationText, setRecommendationText] = useState("");
  const [favoriteSelection, setFavoriteSelection] = useState(false);
  const [favoriteCount, setFavoriteCount] = useState<number | null>(null);
  const [isRestaurantFavorite, setIsRestaurantFavorite] = useState(false);
  const [favoriteError, setFavoriteError] = useState("");
  const [favoriteLoading, setFavoriteLoading] = useState(false);
  const [followSelection, setFollowSelection] = useState(false);
  const [isRestaurantFollowed, setIsRestaurantFollowed] = useState(false);
  const [followError, setFollowError] = useState("");
  const [followLoading, setFollowLoading] = useState(false);
  const [openedFromFollowCta, setOpenedFromFollowCta] = useState(false);
  const { toast } = useToast();
  const [recommendSelection, setRecommendSelection] = useState(false);
  const [isRestaurantRecommended, setIsRestaurantRecommended] = useState(false);
  const [recommendError, setRecommendError] = useState("");
  const [recommendSubmitting, setRecommendSubmitting] = useState(false);
  const isGoldenForkUser = Boolean(
    (user as any)?.influenceScore && (user as any)?.influenceScore > 0
  );
  const [, setLocation] = useLocation();
  const lastUpdatedLabel = formatRelativeTime(deal.restaurant?.lastBroadcastAt);
  const fallbackImageUrl = getDefaultImage(deal.restaurant?.cuisineType, deal.title);
  const cardImage = getAdaptiveImageForPlacement(
    deal.adaptiveImage ?? createAdaptiveImageMetadata(deal.imageUrl),
    "vendor_card",
    fallbackImageUrl,
  );

  // Initialize saved state from localStorage for quick UX feedback
  useEffect(() => {
    const saved = getSavedDeals();
    setIsSaved(saved.includes(deal.id));
  }, [deal.id]);

  // Track view when card becomes visible
  useEffect(() => {
    if (hasTrackedView) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
            if (viewTimerRef.current !== null) return;

            // Mark tracked immediately so we don't schedule multiple timers
            // (especially important if the server responds with 429).
            setHasTrackedView(true);

            // Small delay to ensure it's not just scrolling past
            viewTimerRef.current = window.setTimeout(() => {
              trackDealViewOnce(deal.id).catch(() => {});
              viewTimerRef.current = null;
            }, 500);
          }
        });
      },
      { threshold: 0.5 } // Track when 50% of card is visible
    );

    if (cardRef.current instanceof Element) {
      observer.observe(cardRef.current);
    }

    return () => {
      if (viewTimerRef.current !== null) {
        window.clearTimeout(viewTimerRef.current);
        viewTimerRef.current = null;
      }
      if (cardRef.current instanceof Element) {
        observer.unobserve(cardRef.current);
      }
    };
  }, [deal.id, hasTrackedView]);

  useEffect(() => {
    if (!showRecommendModal || !user) return;

    const fetchPreferenceSnapshot = async () => {
      try {
        const [favorites, follows, recommendations] = await Promise.all([
          apiRequest("GET", "/api/favorites/restaurants"),
          apiRequest("GET", "/api/following/restaurants"),
          apiRequest("GET", "/api/recommendations/restaurants"),
        ]);
        const list = Array.isArray(favorites) ? favorites : [];
        const isFav = list.some(
          (fav: any) =>
            (fav.restaurantId || fav.restaurant?.id) === deal.restaurantId
        );
        const followList = Array.isArray(follows) ? follows : [];
        const isFollowed = followList.some(
          (follow: any) =>
            (follow.restaurantId || follow.restaurant?.id) === deal.restaurantId
        );
        const recommendationList = Array.isArray(recommendations)
          ? recommendations
          : [];
        const isRecommended = recommendationList.some(
          (rec: any) =>
            (rec.restaurantId || rec.restaurant?.id) === deal.restaurantId
        );
        setFavoriteCount(list.length);
        setIsRestaurantFavorite(isFav);
        setFavoriteSelection(isFav);
        setIsRestaurantFollowed(isFollowed);
        setFollowSelection(isFollowed);
        setIsRestaurantRecommended(isRecommended);
        setRecommendSelection(isRecommended);
        setFavoriteError("");
        setFollowError("");
        setRecommendError("");
      } catch (error) {
        console.error("Failed to load preference snapshot:", error);
      }
    };

    fetchPreferenceSnapshot();
  }, [showRecommendModal, user, deal.restaurantId]);

  useEffect(() => {
    if (!user || !deal.restaurantId) return;
    let isMounted = true;

    getFollowedRestaurantIds()
      .then((ids) => {
        if (!isMounted) return;
        const isFollowed = ids.has(deal.restaurantId);
        setIsRestaurantFollowed(isFollowed);
        if (isFollowed) {
          setFollowSelection(true);
        }
      })
      .catch(() => {
        if (!isMounted) return;
      });

    return () => {
      isMounted = false;
    };
  }, [user, deal.restaurantId]);

  const formatDiscount = () => {
    // Normalize discount display for percentage vs flat amounts
    if (deal.dealType === "percentage") {
      return `${deal.discountValue}%`;
    }

    // Handle values that may already include a dollar sign
    if (deal.discountValue?.trim().startsWith("$")) {
      return deal.discountValue.trim();
    }

    return `$${deal.discountValue}`;
  };

  const handleSave = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (isGuest) {
      window.location.href = "/login";
      return;
    }

    try {
      // Toggle saved state immediately for responsiveness
      const newSavedState = !isSaved;
      setIsSaved(newSavedState);

      // Keep a lightweight client-side record so the bookmark visibly sticks
      const currentSaved = getSavedDeals();
      const updatedSaved = newSavedState
        ? Array.from(new Set([...currentSaved, deal.id]))
        : currentSaved.filter((id) => id !== deal.id);
      persistSavedDeals(updatedSaved);

      // Try to persist server-side when the endpoint is available
      try {
        if (newSavedState) {
          await apiRequest("POST", `/api/deals/${deal.id}/save`, {});
        } else {
          await apiRequest("DELETE", `/api/deals/${deal.id}/save`, {});
        }
      } catch (apiError) {
        console.debug(
          "Deal save API not available; kept client bookmark",
          apiError
        );
      }
    } catch (error) {
      console.error("Failed to save deal:", error);
      // Revert on error
      setIsSaved(!isSaved);
    }
  };

  const handleShare = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const shareUrl = await getAffiliateShareUrl(`/deal/${deal.id}`);
    const shareText = `${deal.title} at ${
      deal.restaurant?.name || "this restaurant"
    }`;

    if (navigator.share) {
      try {
          await navigator.share({
            title: "MealScout Special",
            text: shareText,
            url: shareUrl,
          });
        toast({
          title: "Shared",
          description: "Add a recommendation so locals know why it matters.",
          action: (
            <ToastAction altText="Recommend" onClick={() => setShowRecommendModal(true)}>
              Recommend
            </ToastAction>
          ),
        });
        return;
      } catch (err) {
        console.debug("Web Share failed, falling back to modal", err);
      }
    }

    setShowShareModal(true);
  };

  const handleCardClick = () => {
    setShowDealsDrawer(true);
  };

  const handleFollowCta = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setFollowSelection(true);
    setOpenedFromFollowCta(true);
    setShowRecommendModal(true);
  };

  const handleParkingClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const params = new URLSearchParams();
    if (deal.restaurantId) {
      params.set("hostId", deal.restaurantId);
    }
    params.set("source", "deal");

    setLocation(`/parking-pass?${params.toString()}`);
  };

  const MAX_FAVORITES = 3;

  const toggleRestaurantFavorite = async (
    nextSelected: boolean
  ): Promise<boolean> => {
    if (!user) {
      window.location.href = authUrl("/api/auth/facebook");
      return false;
    }

    if (favoriteLoading) return false;

    // Enforce max favorites for new additions
    if (
      nextSelected &&
      !isRestaurantFavorite &&
      favoriteCount !== null &&
      favoriteCount >= MAX_FAVORITES
    ) {
      setFavoriteError(`You can favorite up to ${MAX_FAVORITES} restaurants.`);
      setFavoriteSelection(false);
      return false;
    }

    try {
      setFavoriteLoading(true);
      setFavoriteError("");

      if (nextSelected) {
        await apiRequest(
          "POST",
          `/api/restaurants/${deal.restaurantId}/favorite`,
          {}
        );
        setIsRestaurantFavorite(true);
        setFavoriteSelection(true);
        setFavoriteCount(
          (prev) => (prev ?? 0) + (isRestaurantFavorite ? 0 : 1)
        );
      } else {
        await apiRequest(
          "DELETE",
          `/api/restaurants/${deal.restaurantId}/favorite`,
          {}
        );
        setIsRestaurantFavorite(false);
        setFavoriteSelection(false);
        setFavoriteCount((prev) => Math.max((prev ?? 1) - 1, 0));
      }
      return true;
    } catch (error: any) {
      console.error("Favorite toggle failed:", error);
      setFavoriteError(error?.message || "Unable to update favorite");
      // Reset selection to previous state on failure
      setFavoriteSelection(isRestaurantFavorite);
      return false;
    } finally {
      setFavoriteLoading(false);
    }
  };

  const toggleRestaurantFollow = async (
    nextSelected: boolean
  ): Promise<boolean> => {
    if (!user) {
      window.location.href = authUrl("/api/auth/facebook");
      return false;
    }

    if (followLoading) return false;

    try {
      setFollowLoading(true);
      setFollowError("");

      if (nextSelected) {
        await apiRequest(
          "POST",
          `/api/restaurants/${deal.restaurantId}/follow`,
          {}
        );
        setIsRestaurantFollowed(true);
        setFollowSelection(true);
        if (followSnapshotCache) {
          followSnapshotCache.add(deal.restaurantId);
        }
      } else {
        await apiRequest(
          "DELETE",
          `/api/restaurants/${deal.restaurantId}/follow`,
          {}
        );
        setIsRestaurantFollowed(false);
        setFollowSelection(false);
        if (followSnapshotCache) {
          followSnapshotCache.delete(deal.restaurantId);
        }
      }

      return true;
    } catch (error: any) {
      console.error("Follow toggle failed:", error);
      setFollowError(error?.message || "Unable to update follow");
      setFollowSelection(isRestaurantFollowed);
      return false;
    } finally {
      setFollowLoading(false);
    }
  };

  const handleRecommendSubmit = async () => {
    if (!user) {
      window.location.href = authUrl("/api/auth/facebook");
      return;
    }

    // If user opts to favorite the restaurant, enforce max rules before submitting recommendation text
    if (
      favoriteSelection &&
      !isRestaurantFavorite &&
      favoriteCount !== null &&
      favoriteCount >= MAX_FAVORITES
    ) {
      setFavoriteError(`You can favorite up to ${MAX_FAVORITES} restaurants.`);
      return;
    }

    try {
      setRecommendSubmitting(true);
      setRecommendError("");
      const shouldPromptAfterFavorite = favoriteSelection && !isRestaurantFavorite;
      const shouldPromptAfterFollow = followSelection && !isRestaurantFollowed;

      // Sync follow state
      if (followSelection !== isRestaurantFollowed) {
        const followOk = await toggleRestaurantFollow(followSelection);
        if (!followOk) return;
      }

      // Sync favorite state
      if (favoriteSelection !== isRestaurantFavorite) {
        const favoriteOk = await toggleRestaurantFavorite(favoriteSelection);
        if (!favoriteOk) return;
      }

      // Register recommendation (one per restaurant)
      if (recommendSelection && !isRestaurantRecommended) {
        await apiRequest(
          "POST",
          `/api/restaurants/${deal.restaurantId}/recommend`,
          {}
        );
        setIsRestaurantRecommended(true);
        setRecommendSelection(true);
      }

      // Optional recommendation context adds weight without creating a rating.
      if (recommendationText.trim().length > 0) {
        const formData = new FormData();
        formData.append("comment", recommendationText.trim());
        await fetch(`/api/restaurants/${encodeURIComponent(deal.restaurantId)}/recommend`, {
          method: "POST",
          credentials: "include",
          body: formData,
        });
      }

      setShowRecommendModal(false);
      setOpenedFromFollowCta(false);
      setRecommendationText("");
      if (followSelection) {
        toast({
          title: isRestaurantFollowed ? "Following" : "Now following",
          description: "You'll get notified when new specials go live.",
        });
      }
      if (!recommendSelection && (shouldPromptAfterFavorite || shouldPromptAfterFollow)) {
        toast({
          title: shouldPromptAfterFavorite
            ? "Added to your favorites"
            : "Following",
          description: shouldPromptAfterFavorite
            ? "Want to tell locals why?"
            : "Help others know what to try.",
          action: (
            <ToastAction altText="Recommend" onClick={() => setShowRecommendModal(true)}>
              Recommend
            </ToastAction>
          ),
        });
      }
    } catch (error) {
      console.error("Recommendation submit failed:", error);
      setRecommendError(
        (error as any)?.message || "Could not submit recommendation."
      );
    } finally {
      setRecommendSubmitting(false);
    }
  };

  return (
    <div>
      <Card
        ref={cardRef}
        className="deal-card transition-all duration-300 cursor-pointer group overflow-hidden"
        data-testid={`card-deal-${deal.id}`}
      >
        <CardContent className="p-0">
          {/* Image with gradient overlay - framed inside card */}
          <div className="deal-card-media relative h-24 overflow-hidden rounded-t-2xl">
            <img
              src={cardImage.url}
              alt={deal.title}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
              style={{ objectPosition: cardImage.objectPosition }}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
            />
            {/* Deal Badge - top left */}
            <div className="absolute top-1.5 left-1.5 bg-[#F59E0B] text-[#111111] px-1.5 py-0.5 rounded-lg shadow-clean-lg">
              <span className="font-bold text-sm leading-none">
                {formatDiscount()} OFF
              </span>
            </div>

            {/* Golden fork (restaurant recommendation) - top right */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowRecommendModal(true);
                setForkPressed(true);
              }}
              onMouseDown={() => setForkPressed(true)}
              onMouseUp={() => setForkPressed(false)}
              onMouseLeave={() => setForkPressed(false)}
              className="absolute top-1.5 right-1.5 w-7 h-7 bg-[var(--bg-surface)]/95 backdrop-blur-sm rounded-full flex items-center justify-center shadow-clean-lg hover:bg-[var(--bg-surface)] transition-all duration-300 hover:scale-110 z-10"
              title="Recommend this restaurant"
              aria-label="Recommend this restaurant"
            >
              <GoldenForkIcon
                className={`w-3.5 h-3.5 transition-colors duration-200 ${
                  forkPressed ? "text-[color:var(--accent-text)]" : "text-muted"
                }`}
              />
            </button>

            {/* Restaurant Name Overlay - bottom */}
            <div className="absolute bottom-0 left-0 right-0 bg-black/70 p-2">
              <div className="flex items-center justify-between gap-2">
                <h3
                  className="font-semibold text-white text-xs truncate"
                  data-testid={`text-restaurant-name-${deal.id}`}
                >
                  {deal.restaurant?.name || "Restaurant Name"}
                </h3>
                {popularity && (
                  <span
                    className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold text-white"
                    style={{ backgroundColor: popularity.color }}
                  >
                    {popularity.label}
                  </span>
                )}
              </div>
              {deal.restaurant?.cuisineType && (
                <p className="text-white/80 text-[10px] truncate">
                  {deal.restaurant.cuisineType}
                </p>
              )}
            </div>
          </div>

          {/* Content */}
          <div className="p-2" onClick={handleCardClick}>
            {/* Deal Title */}
            <p
              className="text-primary text-sm font-semibold mb-1.5 line-clamp-2 leading-tight min-h-[2.5rem]"
              data-testid={`text-restaurant-info-${deal.id}`}
            >
              {deal.title}
            </p>

            {/* Distance and activity */}
            <div className="flex items-center gap-1.5 mb-1.5 text-[11px] text-secondary">
              {isLiveTruck && (
                <div className="flex items-center gap-1 rounded-full bg-[rgba(245,158,11,0.18)] px-1.5 py-0.5 text-[11px] font-semibold text-[color:var(--accent-text)]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#F59E0B]" />
                  Live now
                </div>
              )}
              {deal.distance !== undefined && (
                <span>{deal.distance.toFixed(1)} km</span>
              )}
              {deal.minOrderAmount && (
                <>
                  <span>•</span>
                  <span className="text-[color:var(--accent-text)] font-medium">
                    ${deal.minOrderAmount} min
                  </span>
                </>
              )}
            </div>

            {/* Meta Line: Time & Popularity */}
            <div className="flex items-center gap-2 text-[11px] text-secondary mb-2">
              <div className="flex items-center gap-0.5 text-[color:var(--accent-text)]">
                <Clock className="w-3 h-3" />
                <span>View offer details</span>
              </div>
              {lastUpdatedLabel && (
                <div className="rounded-full bg-[var(--bg-surface-muted)] px-2 py-0.5 text-[10px] text-secondary">
                  {lastUpdatedLabel}
                </div>
              )}
              <div className="flex items-center gap-0.5">
                <Flame className="w-3 h-3 text-[color:var(--accent-text)]" />
                <span className="font-medium text-secondary">
                  {typeof deal.currentUses === "number" && Number.isFinite(deal.currentUses) && deal.currentUses >= 0 ? `${deal.currentUses} claimed` : "Claim count unavailable"}
                </span>
              </div>
            </div>

            {/* Action row: save + share + parking */}
            <div className="grid grid-cols-3 gap-1.5 mb-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px] px-1 text-primary border-[color:var(--border-strong)] bg-[color:var(--bg-surface-muted)] hover:bg-[color:var(--bg-surface-muted)]"
                onClick={(e) => handleSave(e)}
                aria-label={isSaved ? "Unsave deal" : "Save deal"}
              >
                {isSaved ? "Saved" : "Save"}
              </Button>

              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px] px-1 text-primary border-[color:var(--border-strong)] bg-[color:var(--bg-surface-muted)] hover:bg-[color:var(--bg-surface-muted)]"
                onClick={handleShare}
                aria-label="Share deal"
              >
                Share
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px] px-1 text-primary border-[color:var(--border-strong)] bg-[color:var(--bg-surface-muted)] hover:bg-[color:var(--bg-surface-muted)]"
                onClick={handleFollowCta}
                aria-label={isRestaurantFollowed ? "Following restaurant" : "Follow restaurant"}
              >
                {isRestaurantFollowed ? "Following" : "Follow"}
              </Button>
            </div>
            {isRestaurantFollowed && (
              <div className="mb-2 flex items-center gap-1.5 rounded-full bg-[var(--bg-surface-muted)] px-2 py-1 text-[11px] text-[color:var(--text-secondary)]">
                <UserPlus className="h-3 w-3" />
                Following for new specials
              </div>
            )}

            {/* Button */}
            <Button
              className="w-full h-11 bg-[#F59E0B] text-[#111111] font-semibold text-sm shadow-none hover:bg-[#F59E0B]"
              onClick={(e) => {
                e.stopPropagation();
                handleCardClick();
              }}
            >
              View Special
              </Button>
          </div>
        </CardContent>
      </Card>

      {/* Recommend Modal */}
      {showRecommendModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => {
              setShowRecommendModal(false);
              setOpenedFromFollowCta(false);
            }}
          />
          <div className="relative w-full max-w-md rounded-3xl shadow-clean-lg overflow-hidden border border-yellow-200/60">
            {/* Hero header */}
            <div className="bg-gradient-to-br from-yellow-200 via-amber-200 to-yellow-300 px-5 py-4 flex items-start gap-3">
              <div className="w-12 h-12 rounded-2xl bg-[var(--bg-surface)]/80 border border-yellow-300 flex items-center justify-center shadow-clean-lg">
                <GoldenForkIcon className="w-7 h-7 text-yellow-700" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-bold text-yellow-900 leading-tight">
                  Recommend this restaurant
                </h3>
                <p className="text-xs text-yellow-800/80">
                  {openedFromFollowCta
                    ? "Follow to get notified when specials go live"
                    : "Your recommendation directly affects local visibility"}
                </p>
                {isGoldenForkUser && (
                  <div className="mt-1 text-xs text-yellow-900 font-semibold flex items-center gap-1">
                    <span role="img" aria-label="golden">
                      🥇
                    </span>
                    Your recommendations carry extra weight in this area
                  </div>
                )}
              </div>
            </div>

            <div className="bg-[var(--bg-surface)] px-5 pb-5 pt-4">
              <label className="block text-sm font-semibold text-primary mb-1">
                Add context (optional)
              </label>
              <p className="text-xs text-secondary mb-2">
                What makes this spot worth recommending?
              </p>
              <textarea
                className="w-full rounded-xl border border-subtle focus:border-[color:var(--action-primary)] focus:ring-2 focus:ring-[color:var(--action-hover)] text-sm p-3 min-h-[96px] resize-none"
                placeholder="Great food, fair prices, fast service, friendly owner…"
                value={recommendationText}
                onChange={(e) => setRecommendationText(e.target.value)}
              />

              {/* Recommend toggle card */}
              <button
                type="button"
                disabled={isRestaurantRecommended}
                onClick={() => {
                  if (isRestaurantRecommended) return;
                  const next = !recommendSelection;
                  setRecommendSelection(next);
                  setRecommendError("");
                }}
                className={`mt-4 w-full rounded-xl border transition-all text-left p-3 flex items-center gap-3 ${
                  recommendSelection
                    ? "border-yellow-400 bg-yellow-50"
                    : "border-subtle bg-surface-muted"
                } ${isRestaurantRecommended ? "opacity-70 cursor-not-allowed" : ""}`}
              >
                <div
                  className={`w-9 h-9 rounded-lg flex items-center justify-center border ${
                    recommendSelection
                      ? "bg-[var(--bg-surface)] text-yellow-700 border-yellow-300"
                      : "bg-card text-muted border-subtle"
                  }`}
                >
                  <GoldenForkIcon className="w-5 h-5" />
                </div>
                <div className="flex-1">
                  <div className="font-semibold text-primary text-sm">
                    Recommend this spot
                  </div>
                  <div className="text-xs text-secondary">
                    {isRestaurantRecommended
                      ? "Already recommended"
                      : "One recommendation per restaurant"}
                  </div>
                  {recommendError && (
                    <div className="text-[color:var(--status-error)] text-xs mt-1">
                      {recommendError}
                    </div>
                  )}
                </div>
              </button>

              {/* Follow toggle card */}
              <button
                type="button"
                onClick={() => {
                  const next = !followSelection;
                  setFollowSelection(next);
                  setFollowError("");
                }}
                className={`mt-3 w-full rounded-xl border transition-all text-left p-3 flex items-center gap-3 ${
                  followSelection
                    ? "border-emerald-400 bg-emerald-50"
                    : "border-subtle bg-surface-muted"
                }`}
              >
                <div
                  className={`w-9 h-9 rounded-lg flex items-center justify-center border ${
                    followSelection
                      ? "bg-[var(--bg-surface)] text-emerald-600 border-emerald-300"
                      : "bg-card text-muted border-subtle"
                  }`}
                >
                  <UserPlus className="w-5 h-5" />
                </div>
                <div className="flex-1">
                  <div className="font-semibold text-primary text-sm">
                    Follow this restaurant
                  </div>
                  <div className="text-xs text-secondary">
                    Get updates when specials go live
                  </div>
                  {followError && (
                    <div className="text-[color:var(--status-error)] text-xs mt-1">
                      {followError}
                    </div>
                  )}
                </div>
              </button>

              {/* Favorite toggle card */}
              <button
                type="button"
                onClick={() => {
                  const next = !favoriteSelection;
                  setFavoriteSelection(next);
                  if (
                    next &&
                    favoriteCount !== null &&
                    favoriteCount >= MAX_FAVORITES &&
                    !isRestaurantFavorite
                  ) {
                    setFavoriteError(
                      `You can favorite up to ${MAX_FAVORITES} restaurants.`
                    );
                  } else {
                    setFavoriteError("");
                  }
                }}
                className={`mt-4 w-full rounded-xl border transition-all text-left p-3 flex items-center gap-3 ${
                  favoriteSelection
                    ? "border-yellow-400 bg-yellow-50"
                    : "border-subtle bg-surface-muted"
                }`}
              >
                <div
                  className={`w-9 h-9 rounded-lg flex items-center justify-center border ${
                    favoriteSelection
                      ? "bg-[var(--bg-surface)] text-yellow-600 border-yellow-300"
                    : "bg-card text-muted border-subtle"
                  }`}
                >
                  <Heart
                    className={`w-5 h-5 ${
                      favoriteSelection ? "fill-yellow-500 text-yellow-600" : ""
                    }`}
                  />
                </div>
                <div className="flex-1">
                  <div className="font-semibold text-primary text-sm">
                    Add to Favorites
                  </div>
                  <div className="text-xs text-secondary">
                    Only 3 favorites allowed
                    {favoriteSelection
                      ? " · One of your top 3 restaurants"
                      : ""}
                  </div>
                  {favoriteCount !== null && (
                    <div className="text-[11px] text-muted mt-0.5">
                      Currently using {favoriteCount}/{MAX_FAVORITES}
                    </div>
                  )}
                  {favoriteError && (
                    <div className="text-[color:var(--status-error)] text-xs mt-1">
                      {favoriteError}
                    </div>
                  )}
                </div>
              </button>

              <div className="flex justify-end gap-2 mt-5">
                <Button
                  variant="outline"
                  className="h-9 text-sm border-subtle text-secondary"
                  onClick={() => {
                    setShowRecommendModal(false);
                    setOpenedFromFollowCta(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  className="h-9 bg-yellow-500 hover:bg-yellow-600 text-white text-sm shadow-clean-lg shadow-yellow-200/80"
                  onClick={handleRecommendSubmit}
                  disabled={
                    recommendSubmitting || favoriteLoading || followLoading
                  }
                >
                  {recommendSubmitting ? "Saving..." : "Save choices"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Share Modal */}
      <DealShareModal
        isOpen={showShareModal}
        onClose={() => setShowShareModal(false)}
        deal={deal}
      />

      {/* Restaurant Deals Drawer */}
      <RestaurantDealsDrawer
        isOpen={showDealsDrawer}
        onClose={() => setShowDealsDrawer(false)}
        restaurantId={deal.restaurantId}
        restaurantName={deal.restaurant?.name || "Restaurant"}
        initialDealId={deal.id}
      />
    </div>
  );
}
