/**
 * ElevatedProfileHero
 *
 * The premium hero for restaurant and bar public profiles.
 * Distinct from TruckHero — this is for brick-and-mortar businesses.
 *
 * Answers immediately:
 *   - What is this place?
 *   - Is it open?
 *   - Where is it?
 *   - What type of food?
 *
 * Design:
 *   - Full-width cover image with gradient overlay
 *   - Logo/avatar anchored bottom-left
 *   - Name, type badge, cuisine tags
 *   - Open/closed status pill
 *   - Address line
 *   - Favorite button (authenticated users)
 *
 * Falls back gracefully when images are missing.
 */
import type { PublicRestaurantProfile } from "@shared/publicProfiles";
import { ProfileHeroMedia, buildPublicProfileHeroAssets } from "./ProfileHeroMedia";
import { getDishCategoryPhoto } from "@/lib/dishCategoryPhoto";
import { ProfileFavoriteButton } from "./ProfileFavoriteButton";
import { ProfileRecommendButton } from "./ProfileRecommendButton";
import { normalizeBusinessTypeLabel } from "@/lib/publicMenuCompleteness";
import { MapPin, Clock3 } from "lucide-react";

type ElevatedProfileHeroProps = {
  profile: PublicRestaurantProfile & {
    entity: string;
    profilePath?: string;
  };
  isAuthenticated?: boolean;
  isFavorited?: boolean;
};

function openStatusStyle(openStatus: string | null): {
  dot: string;
  text: string;
  bg: string;
  border: string;
} {
  if (!openStatus) return { dot: "bg-stone-300", text: "text-[color:var(--profile-muted)]", bg: "bg-stone-50", border: "border-stone-200" };
  const lower = openStatus.toLowerCase();
  if (/open/i.test(lower) && !/closed/i.test(lower)) {
    return { dot: "bg-emerald-500", text: "text-emerald-800", bg: "bg-emerald-50", border: "border-emerald-200" };
  }
  if (/closed/i.test(lower)) {
    return { dot: "bg-stone-400", text: "text-stone-600", bg: "bg-stone-50", border: "border-stone-200" };
  }
  return { dot: "bg-amber-500", text: "text-amber-800", bg: "bg-amber-50", border: "border-amber-200" };
}

export function ElevatedProfileHero({
  profile,
  isAuthenticated = false,
  isFavorited = false,
}: ElevatedProfileHeroProps) {
  const heroAssets = buildPublicProfileHeroAssets({
    entity: profile.entity,
    displayName: profile.displayName,
    coverImageUrl: profile.coverImageUrl,
    logoUrl: profile.logoUrl,
    profileImageUrl: (profile as any).profileImageUrl,
  });

  const typeLabel = normalizeBusinessTypeLabel(profile.profileType);

  const categoryPhoto = heroAssets.coverImageUrl
    ? null
    : getDishCategoryPhoto(
        profile.displayName,
        ...(profile.cuisineTags ?? []),
      );

  // serviceType is just businessType again (e.g. "restaurant") — already
  // shown as the type badge above, so it's dropped here to avoid showing
  // the same thing twice (once as a badge, once as raw, unformatted text).
  // "other" is likewise dropped: it is the stored placeholder for "no real
  // category was ever set", not a cuisine a visitor can act on.
  const cuisineSummary = (profile.cuisineTags ?? [])
    .filter((tag) => Boolean(tag) && tag.trim().toLowerCase() !== "other")
    .slice(0, 2)
    .join(" · ");

  const statusStyle = openStatusStyle(profile.openStatus);

  // addressPublicLabel is already the server's display-safe, locality-aware
  // address. Appending city/state again produces repetitions such as
  // "Milton, FL, Milton, FL" on real profiles.
  const locationLine =
    String(profile.addressPublicLabel || "").trim() ||
    [profile.city, profile.state].filter(Boolean).join(", ");

  return (
    <section
      aria-label={`${profile.displayName} profile hero`}
      className="profile-surface overflow-hidden rounded-[1.75rem]"
      data-public-profile-hero="fixed-location"
    >
      {/* Cover + logo */}
      <ProfileHeroMedia
        displayName={profile.displayName}
        coverImageUrl={heroAssets.coverImageUrl}
        logoImageUrl={heroAssets.logoImageUrl}
        categoryPhoto={categoryPhoto}
        theme="default"
        heightClassName="h-48 md:h-72"
        badge={
          <ProfileFavoriteButton
            restaurantId={profile.id}
            isAuthenticated={isAuthenticated}
            initialIsFavorited={isFavorited}
            profilePath={profile.profilePath}
          />
        }
      />

      {/* Info block */}
      <div className="space-y-3 p-4 sm:p-5">
        {/* Type badge + open status */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-orange-200 bg-orange-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-orange-800">
            {typeLabel}
          </span>
          {profile.verifiedProfile ? (
            <span className="rounded-full border border-[color:var(--profile-border)] bg-white px-2.5 py-1 text-[10px] font-semibold text-[color:var(--profile-muted)]">
              Verified
            </span>
          ) : null}
          {profile.locallyOwned ? (
            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold text-emerald-800">
              Locally owned
            </span>
          ) : null}
          {profile.openStatus ? (
            <span
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${statusStyle.bg} ${statusStyle.border}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${statusStyle.dot}`} />
              <span className={statusStyle.text}>{profile.openStatus}</span>
            </span>
          ) : null}
        </div>

        {/* Name */}
        <h1 className="text-3xl font-black tracking-tight text-[color:var(--profile-ink)] sm:text-4xl">
          {profile.displayName}
        </h1>

        {/* Cuisine / service type */}
        {cuisineSummary ? (
          <p className="text-sm font-bold text-[#ad3a20]">{cuisineSummary}</p>
        ) : null}

        {/* Location + hours inline */}
        <div className="space-y-1.5 text-sm text-[color:var(--profile-ink-soft)]">
          {locationLine ? (
            <p className="flex items-start gap-2">
              <MapPin className="mt-0.5 h-4 w-4 flex-none text-[color:var(--profile-accent)]" />
              <span>{locationLine}</span>
            </p>
          ) : null}
          {profile.operatingHoursSummary ? (
            <p className="flex items-start gap-2">
              <Clock3 className="mt-0.5 h-4 w-4 flex-none text-[color:var(--profile-accent)]" />
              <span className="line-clamp-2">
                {profile.operatingHoursSummary}
              </span>
            </p>
          ) : null}
        </div>

        {/* Description */}
        {profile.description ? (
          <p className="line-clamp-3 text-sm leading-6 text-[color:var(--profile-muted)]">
            {profile.description}
          </p>
        ) : null}

        {/* Recommend — always available, independent of any specific dish */}
        <ProfileRecommendButton
          restaurantId={profile.id}
          isAuthenticated={isAuthenticated}
          profilePath={profile.profilePath}
        />
      </div>
    </section>
  );
}
