import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Heart, MapPin, Utensils } from "lucide-react";
import { Link } from "wouter";
import type { Restaurant } from "@shared/schema";
import {
  CollectionLoadingState,
  CollectionState,
  ConsumerCollectionShell,
} from "@/components/consumer-collection-shell";
import { SEOHead } from "@/components/seo-head";
import { useAuth } from "@/hooks/useAuth";
import { getDishCategoryPhoto } from "@/lib/dishCategoryPhoto";
import { buildPublicProfilePath } from "@/lib/public-profile-path";
import { apiRequest } from "@/lib/queryClient";

type FavoriteRestaurant = Restaurant & {
  businessType?: string | null;
  isFoodTruck?: boolean | null;
  logoUrl?: string | null;
  coverImageUrl?: string | null;
};

type FavoriteRow = {
  id: string;
  favoritedAt?: string | Date | null;
  restaurant: FavoriteRestaurant;
};

const getProfilePath = (restaurant: FavoriteRestaurant) => {
  const normalizedType = String(restaurant.businessType || "").toLowerCase();
  const entityType =
    restaurant.isFoodTruck || normalizedType === "food_truck"
      ? "truck"
      : normalizedType === "bar"
        ? "bar"
        : "restaurant";

  return (
    buildPublicProfilePath({
      entityType,
      id: restaurant.id,
      name: restaurant.name,
    }) || `/restaurant/${restaurant.id}`
  );
};

const getFavoriteImage = (restaurant: FavoriteRestaurant) =>
  restaurant.coverImageUrl ||
  restaurant.logoUrl ||
  getDishCategoryPhoto(restaurant.name, restaurant.cuisineType)?.image ||
  "/backgrounds/food-truck-day.jpg";

export default function FavoritesPage() {
  const { user, authState, isAuthenticated } = useAuth();
  const {
    data: restaurantFavorites = [],
    isLoading,
    isError,
    refetch,
  } = useQuery<FavoriteRow[]>({
    queryKey: ["/api/favorites/restaurants", user?.id],
    queryFn: async () => {
      const rows = await (await apiRequest("GET", "/api/favorites/restaurants")).json();
      if (!Array.isArray(rows) || rows.some(row => !row?.restaurant?.id)) throw new Error("Saved places could not be read");
      return rows;
    },
    enabled: isAuthenticated,
  });

  const countLabel = isAuthenticated
    ? `${restaurantFavorites.length} saved ${restaurantFavorites.length === 1 ? "place" : "places"}`
    : null;

  return (
    <ConsumerCollectionShell
      section="saved"
      title="Saved"
      description="The places you want to remember, ready when it is time to choose."
      icon={Heart}
      countLabel={countLabel}
    >
      <SEOHead
        title="Saved Places | MealScout"
        description="Return to the restaurants, food trucks, and food businesses you saved on MealScout."
        keywords="saved restaurants, favorite restaurants, saved food trucks"
        canonicalUrl="https://www.mealscout.us/favorites"
        noIndex={true}
      />

      {authState === "loading" || (isAuthenticated && isLoading) ? (
        <CollectionLoadingState label="Loading saved places" />
      ) : !isAuthenticated ? (
        <CollectionState
          icon={Heart}
          title="Sign in to keep a saved list"
          description="Save a place from its profile and return to it here without starting over."
          actionHref="/login?redirect=%2Ffavorites"
          actionLabel="Sign in"
        />
      ) : isError ? (
        <CollectionState
          icon={Heart}
          title="Saved places are unavailable"
          description="Your list is still yours. We just could not load it right now."
          onRetry={() => void refetch()}
        />
      ) : restaurantFavorites.length === 0 ? (
        <CollectionState
          icon={Heart}
          title="Nothing saved yet"
          description="Tap the heart on a business profile when something looks worth coming back to."
          actionHref="/scout"
          actionLabel="Scout"
        />
      ) : (
        <section aria-labelledby="saved-places-heading">
          <h2 id="saved-places-heading" className="sr-only">
            Saved places
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {restaurantFavorites.map((favorite) => {
              const restaurant = favorite.restaurant;
              const profilePath = getProfilePath(restaurant);
              const image = getFavoriteImage(restaurant);
              return (
                <Link
                  key={favorite.id}
                  href={profilePath}
                  className="group grid min-h-32 grid-cols-[6.5rem_minmax(0,1fr)] overflow-hidden rounded-[1.5rem] border border-[#683a1f]/15 bg-white/[0.92] shadow-[0_18px_45px_rgba(102,50,21,0.07)] transition hover:-translate-y-0.5 hover:border-[#f4512c]/35 hover:shadow-[0_22px_50px_rgba(102,50,21,0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f4512c] focus-visible:ring-offset-2 sm:grid-cols-[9rem_minmax(0,1fr)]"
                >
                  <div className="relative overflow-hidden bg-[#f2dfd2]">
                    <img
                      src={image}
                      alt=""
                      className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
                      loading="lazy"
                      decoding="async"
                      onError={(event) => {
                        event.currentTarget.src = "/backgrounds/food-truck-day.jpg";
                      }}
                    />
                    <span className="absolute left-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.92] text-[#f4512c] shadow-sm">
                      <Heart className="h-4 w-4 fill-current" aria-hidden="true" />
                    </span>
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-3 p-4 sm:p-5">
                    <div className="min-w-0">
                      <h3 className="truncate text-base font-black text-[#2b160d] sm:text-lg">
                        {restaurant.name}
                      </h3>
                      {restaurant.cuisineType ? (
                        <p className="mt-1 flex items-center gap-1.5 text-xs font-bold text-[#9a4c31]">
                          <Utensils className="h-3.5 w-3.5" aria-hidden="true" />
                          <span className="truncate">{restaurant.cuisineType}</span>
                        </p>
                      ) : null}
                      {restaurant.address ? (
                        <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-[#806657]">
                          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span className="line-clamp-2">{restaurant.address}</span>
                        </p>
                      ) : null}
                    </div>
                    <ArrowRight
                      className="h-5 w-5 shrink-0 text-[#b79a89] transition group-hover:translate-x-0.5 group-hover:text-[#f4512c]"
                      aria-hidden="true"
                    />
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}
    </ConsumerCollectionShell>
  );
}
