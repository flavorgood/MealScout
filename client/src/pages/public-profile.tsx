import { ProgressiveContactLink } from "@/components/progressive-contact-link";
import { readScoutJourney } from "@/lib/scout-journey-state";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "@/lib/api";
import { readPublicProfileJson, isMissingPublicProfile, isPrivatePublicProfile } from "@/lib/public-profile-recovery";
import { buildProgressiveAccountPath, getProgressiveAccountGate } from "@shared/progressiveOnboarding";
import { getDishCategoryPhoto } from "@/lib/dishCategoryPhoto";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import type {
  PublicCta,
  PublicLocationProfile,
  PublicMenuItem,
  PublicMenuSection,
  PublicRestaurantProfile,
  PublicSupplierProfile,
} from "@shared/publicProfiles";
import { getBusinessCapabilities } from "@shared/businessTypes";
import {
  buildCleanPublicBusinessPath,
  isLikelyCleanAffiliateTagSegment,
  parseCleanAffiliateBusinessRoute,
} from "@shared/cleanAffiliateLinks";
import {
  assessPublicMenuCompleteness,
  normalizeBusinessTypeLabel,
} from "@/lib/publicMenuCompleteness";
import { extractUuidFromSlug } from "@/lib/seo-slug";
import { slugifySeoTerm } from "@/lib/seo-city";
import { resolveCanonicalShareUrl } from "@/lib/share";
import { setAffiliateRef } from "@/lib/share";
import { SEOHead } from "@/components/seo-head";
import { ProfileErrorBoundary } from "@/components/public-profile/ProfileErrorBoundary";
import {
  ProfileHeroMedia,
  buildPublicProfileHeroAssets,
} from "@/components/public-profile/ProfileHeroMedia";
import { ElevatedTruckHero } from "@/components/public-profile/ElevatedTruckHero";
import { ElevatedProfileHero } from "@/components/public-profile/ElevatedProfileHero";
import { MobileActionDock } from "@/components/public-profile/MobileActionDock";
import { rankPublicCtas } from "@/components/public-profile/profileActionPolicy";
import { PublicProfileMenu } from "@/components/public-profile/PublicProfileMenu";
import { TruckSchedulePanel } from "@/components/public-profile/TruckSchedulePanel";
import { RestaurantHoursPanel } from "@/components/public-profile/RestaurantHoursPanel";
import { PlanYourVisitPanel } from "@/components/public-profile/PlanYourVisitPanel";
import {
  ThinProfileState,
  isThinProfile,
} from "@/components/public-profile/ThinProfileState";
import { PublicProfileDecisionBar } from "@/components/public-profile/PublicProfileDecisionBar";
import { RelatedScoutRail } from "@/components/public-profile/RelatedScoutRail";
import { isClaimedTruckProfile } from "@/components/public-profile/profileClaimPromptPolicy";
import { useAuth } from "@/hooks/useAuth";
import {
  getTruckScheduleEmptyStateLabel,
  getTruckSchedulePrimaryStop,
  getTruckScheduleRows,
  getTruckScheduleStatusBadgeLabel,
  hasTruckScheduleSignal,
} from "@/components/public-profile/truckScheduleTruth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import {
  CalendarDays,
  Check,
  Clock3,
  Copy,
  ExternalLink,
  MapPin,
  MenuSquare,
  Phone,
  Route,
  Share2,
} from "lucide-react";

type PublicProfilePayload =
  | (PublicRestaurantProfile & {
      entity: "restaurant" | "truck" | "bar" | "caterer" | "private_chef";
      title: string;
      subtitle: string | null;
      imageUrl: string | null;
      profilePath: string;
      canonicalUrl: string;
      phone: string | null;
    })
  | (PublicLocationProfile & {
      entity: "host";
      title: string;
      subtitle: string | null;
      imageUrl: string | null;
      profilePath: string;
      canonicalUrl: string;
      phone: string | null;
    })
  | (PublicSupplierProfile & {
      entity: "supplier";
      title: string;
      subtitle: string | null;
      imageUrl: string | null;
      profilePath: string;
      canonicalUrl: string;
      phone: string | null;
      metrics?: {
        activeProductCount?: number;
      };
    });

const DEFAULT_IMAGE = "/og-default.jpg";
const UUID_LIKE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PublicProfileQualitySignalType =
  | "public_profile_page_error"
  | "public_profile_not_found_viewed"
  | "missing_menu_viewed"
  | "missing_schedule_viewed"
  | "failed_profile_image";

type PublicProfileQualitySignalPayload = {
  type: PublicProfileQualitySignalType;
  profile_id?: string | null;
  profile_type?: string | null;
  path: string;
  missing_menu?: boolean;
  missing_schedule?: boolean;
  failed_image_type?: "logo" | "cover" | null;
  timestamp: string;
};

const sendPublicProfileQualitySignal = (
  payload: PublicProfileQualitySignalPayload,
  dedupeKey?: string,
) => {
  try {
    if (dedupeKey && typeof window !== "undefined") {
      const storageKey = `mealscout:public-profile-quality:${dedupeKey}`;
      if (window.sessionStorage.getItem(storageKey)) return;
      window.sessionStorage.setItem(storageKey, "1");
    }

    void fetch(apiUrl("/api/analytics/shell"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {
    // Quality telemetry must never affect public profile rendering.
  }
};

const hasStructuredPublicMenu = (profile: PublicProfilePayload) => {
  const sections = Array.isArray((profile as any).menuSections)
    ? (profile as any).menuSections
    : [];
  if (
    sections.some(
      (section: any) =>
        String(section?.name || section?.category || "").trim() ||
        (Array.isArray(section?.items) && section.items.length > 0),
    )
  ) {
    return true;
  }

  const variants = Array.isArray((profile as any).menuVariants)
    ? (profile as any).menuVariants
    : [];
  return variants.some((variant: any) =>
    Array.isArray(variant?.menuSections)
      ? variant.menuSections.some(
          (section: any) =>
            String(section?.name || section?.category || "").trim() ||
            (Array.isArray(section?.items) && section.items.length > 0),
        )
      : false,
  );
};

const hasPostedScheduleOrTimeWindow = (profile: PublicProfilePayload) => {
  if (!isRestaurantLikeEntity(profile.entity)) return true;
  const restaurant = profile as PublicRestaurantProfile;
  if (String(restaurant.operatingHoursSummary || "").trim()) return true;
  if (restaurant.profileType !== "truck") return false;

  return hasTruckScheduleSignal(restaurant.truckSchedule);
};

const normalizePublicProfileEntity = (value: string | null | undefined) => {
  const normalized = String(value || "")
    .toLowerCase()
    .trim();
  if (
    normalized === "food_truck" ||
    normalized === "food-truck" ||
    normalized === "foodtruck"
  ) {
    return "truck";
  }
  return normalized;
};

const isRestaurantLikeEntity = (entity: string | null | undefined) => {
  const normalized = normalizePublicProfileEntity(entity);
  return (
    normalized === "restaurant" ||
    normalized === "truck" ||
    normalized === "bar" ||
    normalized === "caterer" ||
    normalized === "private_chef"
  );
};

type LocationDiscoveryTruck = {
  id: string;
  name: string;
  cuisineType?: string | null;
  truckPath?: string;
  logoUrl?: string | null;
  coverImageUrl?: string | null;
  imageUrl?: string | null;
  schedules?: Array<{
    date?: string;
    startTime?: string;
    endTime?: string;
  }>;
};

type LocationDiscoveryPayload = {
  totalTrucks?: number;
  trucks?: LocationDiscoveryTruck[];
};

const asSafeCtas = (ctas: PublicCta[] | undefined) =>
  (Array.isArray(ctas) ? ctas : []).filter((cta) =>
    Boolean(cta?.safe && cta?.href),
  );

const ctaTarget = (cta: PublicCta) =>
  cta.type === "internal" || cta.type === "phone" ? undefined : "_blank";

const ctaRel = (cta: PublicCta) =>
  cta.type === "internal" || cta.type === "phone"
    ? undefined
    : "noopener noreferrer";

const isSelfProfileCta = (profile: PublicProfilePayload, cta: PublicCta) =>
  cta.type === "internal" && cta.href === profile.profilePath;

const isDetailsCta = (cta: PublicCta) =>
  /details/i.test(String(cta.label || ""));

const uniqueByHref = (ctas: PublicCta[]) => {
  const seen = new Set<string>();
  return ctas.filter((cta) => {
    const href = String(cta.href || "").trim();
    if (!href || seen.has(href)) return false;
    seen.add(href);
    return true;
  });
};

const GENERIC_PROFILE_SUMMARY_TEXT = new Set([
  "food_truck",
  "food truck",
  "truck",
  "restaurant",
  "bar",
]);

const cleanProfileCuisineTags = (tags: string[] | null | undefined) =>
  (tags ?? [])
    .map((tag) => String(tag || "").trim())
    .filter(
      (tag) => tag && !GENERIC_PROFILE_SUMMARY_TEXT.has(tag.toLowerCase()),
    )
    .slice(0, 2);

const getActionPolicyProfileType = (profile: PublicProfilePayload) =>
  profile.entity === "restaurant"
    ? profile.profileType
    : profile.entity;

const pickActionCtas = (
  profile: PublicProfilePayload,
  safeCtas: PublicCta[],
  limit = 6,
) =>
  uniqueByHref(
    rankPublicCtas(
      safeCtas.filter(
        (cta) => !isSelfProfileCta(profile, cta) && !isDetailsCta(cta),
      ),
      getActionPolicyProfileType(profile),
    ),
  ).slice(0, limit);

const locationLine = (profile: {
  addressPublicLabel?: string | null;
  city?: string | null;
  state?: string | null;
}) =>
  profile.addressPublicLabel ||
  [profile.city, profile.state].filter(Boolean).join(", ") ||
  null;

const decisionLocationLine = (profile: PublicProfilePayload) => {
  if (
    isRestaurantLikeEntity(profile.entity) &&
    profile.profileType === "truck"
  ) {
    const schedule = (profile as PublicRestaurantProfile).truckSchedule;
    const stop =
      schedule?.currentStop ||
      schedule?.todayStop ||
      schedule?.nextStop ||
      null;
    const stopLabel = stop
      ? stop.addressPublicLabel ||
        stop.locationName ||
        [stop.city, stop.state].filter(Boolean).join(", ")
      : null;
    if (stopLabel) return stopLabel;
  }
  return locationLine(profile);
};

const phoneLine = (profile: PublicProfilePayload) =>
  profile.entity === "supplier"
    ? profile.phonePublic
    : profile.entity === "restaurant"
      ? profile.phonePublic
      : profile.phone || null;

const renderCtaButton = (
  cta: PublicCta,
  variant: "default" | "outline",
  key: string,
) => (
  <ProgressiveContactLink
    key={key}
    href={cta.href}
    data-analytics-action={
      cta.type === "menu"
        ? "menu_click"
        : cta.type === "map"
          ? "directions_click"
          : cta.type === "phone"
            ? "call_click"
            : cta.type === "order"
              ? "order_click"
              : cta.type === "catering"
                ? "catering_click"
                : cta.type === "booking"
                  ? "truck_booking_click"
                  : cta.type === "social"
                    ? "social_click"
                    : cta.type === "share"
                      ? "share_click"
                      : "website_click"
    }
    data-analytics-target-type={cta.type || "unknown"}
    target={ctaTarget(cta)}
    rel={ctaRel(cta)}
    className={
      variant === "default"
        ? "inline-flex items-center justify-center rounded-md bg-orange-500 px-4 py-2 text-sm font-semibold text-black hover:bg-orange-400"
        : "inline-flex items-center justify-center rounded-md border border-white/20 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10"
    }
  >
    {cta.label}
  </ProgressiveContactLink>
);

function HeroBlock({ profile }: { profile: PublicProfilePayload }) {
  const heroAssets = buildPublicProfileHeroAssets({
    entity: profile.entity === "host" ? profile.profileType : profile.entity,
    displayName: profile.displayName,
    spotImageUrl: "spotImageUrl" in profile ? profile.spotImageUrl : null,
    coverImageUrl: "coverImageUrl" in profile ? profile.coverImageUrl : null,
    logoUrl: "logoUrl" in profile ? profile.logoUrl : null,
    profileImageUrl: (profile as any).profileImageUrl,
    truckPhotoLogo: (profile as any).truckPhotoLogo,
    imageUrl: profile.imageUrl,
  });
  const decisionLocation = decisionLocationLine(profile);
  const hours = isRestaurantLikeEntity(profile.entity)
    ? String(
        (profile as PublicRestaurantProfile).operatingHoursSummary || "",
      ).trim()
    : "";
  const truckSchedule = isRestaurantLikeEntity(profile.entity)
    ? (profile as PublicRestaurantProfile).truckSchedule
    : null;
  const liveStatus =
    profile.entity === "restaurant" && profile.openStatus
      ? profile.openStatus
      : truckSchedule?.statusLabel || null;
  const profileTypeLabel =
    profile.profileType === "location"
      ? "Location"
      : profile.profileType === "truck"
        ? "Food Truck"
      : profile.profileType === "bar"
          ? "Bar"
          : profile.profileType === "caterer"
            ? "Caterer"
            : profile.profileType === "private_chef"
              ? "Private Chef"
          : profile.profileType === "supplier"
            ? "Supplier"
            : "Restaurant";
  const cuisineSummary = isRestaurantLikeEntity(profile.entity)
    ? cleanProfileCuisineTags(
        (profile as PublicRestaurantProfile).cuisineTags,
      ).join(" · ")
    : "";

  return (
    <section className="overflow-hidden rounded-xl border border-white/10 bg-[#0f0d0b]">
      <ProfileHeroMedia
        displayName={profile.displayName}
        coverImageUrl={heroAssets.coverImageUrl}
        logoImageUrl={heroAssets.logoImageUrl}
      />
      <div className="space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {liveStatus ? <Badge variant="secondary">{liveStatus}</Badge> : null}
          <Badge
            variant="outline"
            className="border-orange-400/45 text-orange-200"
          >
            {profileTypeLabel}
          </Badge>
          {"verifiedProfile" in profile ? (
            profile.verifiedProfile ? (
              <Badge variant="outline" className="border-white/20 text-white/65">
                Verified
              </Badge>
            ) : (
              <Badge variant="outline" className="border-white/10 text-white/40">
                Unverified listing
              </Badge>
            )
          ) : null}
          {"locallyOwned" in profile && profile.locallyOwned ? (
            <Badge
              variant="outline"
              className="border-emerald-300/35 text-emerald-200/85"
            >
              Locally owned
            </Badge>
          ) : null}
        </div>
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            {profile.displayName}
          </h1>
          {cuisineSummary ? (
            <p className="text-sm font-medium text-orange-100/85">
              {cuisineSummary}
            </p>
          ) : null}
        </div>
        <div className="space-y-2 text-sm text-white/78">
          {decisionLocation ? (
            <p className="flex items-start gap-2">
              <MapPin className="mt-0.5 h-4 w-4 flex-none text-orange-200" />
              <span>{decisionLocation}</span>
            </p>
          ) : null}
          {hours ? (
            <p className="flex items-start gap-2">
              <Clock3 className="mt-0.5 h-4 w-4 flex-none text-orange-200" />
              <span>{hours}</span>
            </p>
          ) : null}
          {phoneLine(profile) ? (
            <p className="flex items-start gap-2">
              <Phone className="mt-0.5 h-4 w-4 flex-none text-orange-200" />
              <span>{phoneLine(profile)}</span>
            </p>
          ) : null}
        </div>
        {profile.description ? (
          <p className="line-clamp-3 text-sm leading-6 text-white/70">
            {profile.description}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function PublicProfileShareControls({
  profile,
  sharePath,
  title,
  description,
  onShareAction,
}: {
  profile: PublicProfilePayload;
  sharePath?: string | null;
  title: string;
  description: string;
  onShareAction: (
    actionType: string,
    targetType?: string | null,
    href?: string | null,
  ) => void;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const targetPath =
    sharePath ||
    profile.profilePath ||
    (() => {
      try {
        return new URL(profile.canonicalUrl).pathname;
      } catch {
        return typeof window !== "undefined" ? window.location.pathname : "/";
      }
    })();

  const resolveShareUrl = async () => resolveCanonicalShareUrl(targetPath);

  const copyShareUrl = async () => {
    const shareUrl = await resolveShareUrl();
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
    onShareAction("share_copy", "copy", shareUrl);
    toast({
      title: "Link copied",
      description: "Public profile link copied to clipboard.",
    });
    return shareUrl;
  };

  const handleShare = async () => {
    try {
      const shareUrl = await resolveShareUrl();
      if (navigator.share) {
        await navigator.share({
          title,
          text: description,
          url: shareUrl,
        });
        onShareAction("share_open", "native_share", shareUrl);
        return;
      }
      await navigator.clipboard.writeText(shareUrl);
      onShareAction("share_copy", "copy_fallback", shareUrl);
      toast({
        title: "Link copied",
        description:
          "Sharing is not available here, so the profile link was copied.",
      });
    } catch {
      toast({
        title: "Share failed",
        description: "Could not prepare the profile share link.",
        variant: "destructive",
      });
    }
  };

  const handleCopy = async () => {
    try {
      await copyShareUrl();
    } catch {
      toast({
        title: "Copy failed",
        description: "Could not copy the profile share link.",
        variant: "destructive",
      });
    }
  };

  return (
    <section
      aria-label="Share public profile"
      className="profile-surface flex flex-col gap-2 rounded-2xl px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-xs font-bold text-[color:var(--profile-muted)]">Share this profile</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={handleShare}
          className="profile-action-primary"
          data-testid="button-public-profile-share"
        >
          <Share2 className="mr-2 h-4 w-4" />
          Share
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={handleCopy}
          className="profile-action-secondary"
          data-testid="button-public-profile-copy-link"
        >
          {copied ? (
            <Check className="mr-2 h-4 w-4" />
          ) : (
            <Copy className="mr-2 h-4 w-4" />
          )}
          Copy Link
        </Button>
      </div>
    </section>
  );
}

function LocationNowSection({ profile }: { profile: PublicLocationProfile }) {
  const now = Number(profile.foodTrucksNow || 0);
  const tonight = Number(profile.foodTrucksTonight || 0);
  const upcoming = Number(profile.upcomingFoodTruckSlots || 0);
  const hasAny = now > 0 || tonight > 0 || upcoming > 0;

  return (
    <Card id="menu" className="border-white/10 bg-[#0f0d0b]">
      <CardHeader>
        <CardTitle className="text-xl text-white">Food here now</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasAny ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-white/10 bg-black/20 p-3">
              <p className="text-xs uppercase tracking-wide text-white/60">
                Trucks here now
              </p>
              <p className="mt-1 text-2xl font-semibold text-white">{now}</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-black/20 p-3">
              <p className="text-xs uppercase tracking-wide text-white/60">
                Trucks tonight
              </p>
              <p className="mt-1 text-2xl font-semibold text-white">
                {tonight}
              </p>
            </div>
            <div className="rounded-lg border border-white/10 bg-black/20 p-3">
              <p className="text-xs uppercase tracking-wide text-white/60">
                Upcoming
              </p>
              <p className="mt-1 text-2xl font-semibold text-white">
                {upcoming}
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-white/10 bg-black/20 p-4 text-sm text-white/75">
            No trucks listed right now. Check back soon.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function QuickActionRow({
  profile,
  safeCtas,
}: {
  profile: PublicProfilePayload;
  safeCtas: PublicCta[];
}) {
  const actions = pickActionCtas(profile, safeCtas, 16)
    .filter((cta) => cta.type !== "share" && cta.type !== "internal")
    .slice(0, 7);
  if (actions.length === 0) return null;
  const headerLabel = actions.some(
    (cta) => cta.type === "menu" || cta.type === "order",
  )
    ? "Get food"
    : "Quick links";
  return (
    <Card id="actions" className="border-white/10 bg-[#0f0d0b]">
      <CardContent className="space-y-3 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-white/60">
          {headerLabel}
        </p>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          {actions.map((cta, idx) =>
            renderCtaButton(
              cta,
              idx === 0 ? "default" : "outline",
              `${cta.href}-${idx}`,
            ),
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function TruckVisitStrip({
  profile,
  safeCtas,
}: {
  profile: PublicRestaurantProfile;
  safeCtas: PublicCta[];
}) {
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const rows = getTruckScheduleRows(profile.truckSchedule);
  const primary = getTruckSchedulePrimaryStop(profile.truckSchedule);
  const isLiveNow = profile.truckPresence?.broadcastState === "live";
  const action = pickActionCtas(
    profile as unknown as PublicProfilePayload,
    safeCtas,
    8,
  ).find((cta) => cta.type !== "share" && cta.type !== "internal");
  const stop = primary.stop;
  const stopPlace =
    stop?.locationName ||
    stop?.addressPublicLabel ||
    [profile.city, profile.state].filter(Boolean).join(", ") ||
    null;
  const stopTime = stop?.timeWindowLabel || null;
  const statusLabel = isLiveNow
    ? "Live now"
    : primary.kind === "current"
      ? "Scheduled here now"
      : primary.kind === "today"
        ? "Open today"
        : primary.kind === "next" || primary.kind === "upcoming"
          ? "Next scheduled"
          : "Schedule not posted";
  const statusClass =
    isLiveNow
      ? "border-emerald-300/35 bg-emerald-500/12 text-emerald-100"
      : rows.hasActionableSchedule
        ? "border-orange-300/35 bg-orange-500/10 text-orange-100"
        : "border-white/15 bg-white/5 text-white/60";

  return (
    <section
      aria-label="Truck visit summary"
      className="rounded-2xl border border-white/10 bg-[#100d0b] px-3 py-3 sm:px-4"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${statusClass}`}
            >
              {statusLabel}
            </span>
            {rows.hasActionableSchedule ? (
              <button
                type="button"
                onClick={() => setScheduleOpen(true)}
                className="text-xs font-semibold text-orange-200 hover:text-orange-100"
              >
                See full schedule
              </button>
            ) : null}
          </div>
          <p className="truncate text-sm font-semibold text-white">
            {stopPlace || "Base area not posted"}
          </p>
          {stopTime ? (
            <p className="text-xs text-white/55">{stopTime}</p>
          ) : null}
        </div>

        {action ? (
          <ProgressiveContactLink
            href={action.href}
            target={ctaTarget(action)}
            rel={ctaRel(action)}
            data-analytics-action="truck_visit_strip_cta"
            data-analytics-target-type={action.type}
            className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-xl bg-orange-500 px-4 text-sm font-bold text-black hover:bg-orange-400"
          >
            {action.label}
          </ProgressiveContactLink>
        ) : rows.hasActionableSchedule ? (
          <button
            type="button"
            onClick={() => setScheduleOpen(true)}
            className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-xl border border-white/15 px-4 text-sm font-bold text-white/85 hover:bg-white/8"
          >
            View schedule
          </button>
        ) : null}
      </div>

      <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
        <DialogContent className="max-h-[86vh] w-[calc(100vw-1rem)] max-w-2xl overflow-y-auto border-white/10 bg-[#0f0d0b] text-white">
          <DialogHeader>
            <DialogTitle className="text-white">
              {profile.displayName} schedule
            </DialogTitle>
          </DialogHeader>
          <TruckSchedulePanel profile={profile} />
        </DialogContent>
      </Dialog>
    </section>
  );
}

const menuSectionsForProfile = (
  profile: PublicRestaurantProfile,
): PublicMenuSection[] => {
  const variants = Array.isArray(profile.menuVariants)
    ? profile.menuVariants
    : [];
  const activeVariant =
    variants.find(
      (variant) => String(variant.id) === String(profile.activeMenuId || ""),
    ) ||
    variants[0] ||
    null;
  const sections = activeVariant?.menuSections?.length
    ? activeVariant.menuSections
    : profile.menuSections;
  return (Array.isArray(sections) ? sections : []).filter(
    (section) =>
      String(section?.name || "").trim() &&
      Array.isArray(section?.items) &&
      section.items.length > 0,
  );
};

const scoreMenuShelfItem = (
  item: PublicMenuItem,
  featuredNames: Set<string>,
  userItemNames: Set<string>,
  recommendedNames: Set<string>,
  hasRecommendationSignal: boolean,
  seedKey: string,
) => {
  const name = String(item.name || "")
    .trim()
    .toLowerCase();
  const itemAny = item as any;
  const recommendationCount = Math.max(
    0,
    Number(
      item.recommendationCount ??
        itemAny.recommendationCount ??
        itemAny.recommendationsCount ??
        itemAny.communityRecommendationCount ??
        0,
    ) || 0,
  );
  const userRecommended = Boolean(
    item.userRecommended || itemAny.userRecommended,
  );
  const hasUserSignal = userRecommended || userItemNames.size > 0;
  const stableRandom = stableUnitHash(`${seedKey}:${name}`);
  const qualityScore =
    (item.imageUrl ? 20 : 0) +
    (item.priceLabel ? 10 : 0) +
    (item.description ? 5 : 0);

  if (hasUserSignal) {
    return (
      (userRecommended ? 1200 : 0) +
      (userItemNames.has(name) ? 1000 : 0) +
      recommendationCount * 20 +
      (recommendedNames.has(name) ? 120 : 0) +
      (item.featured || featuredNames.has(name) ? 80 : 0) +
      qualityScore +
      stableRandom
    );
  }

  if (hasRecommendationSignal) {
    return (
      recommendationCount * 25 +
      (recommendedNames.has(name) ? 160 : 0) +
      (item.featured || featuredNames.has(name) ? 120 : 0) +
      qualityScore +
      stableRandom
    );
  }

  return stableRandom;
};

const stableUnitHash = (value: string) => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
};

const optionalNameSet = (...values: unknown[]) => {
  const names = new Set<string>();
  for (const value of values) {
    const list = Array.isArray(value) ? value : [];
    for (const entry of list) {
      const name =
        typeof entry === "string"
          ? entry
          : String((entry as any)?.name || (entry as any)?.menuItemName || "");
      const normalized = name.trim().toLowerCase();
      if (normalized) names.add(normalized);
    }
  }
  return names;
};

function TruckMenuShelf({ profile }: { profile: PublicRestaurantProfile }) {
  const sections = menuSectionsForProfile(profile);
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => setActiveIndex(0), [profile.id, profile.activeMenuId]);
  if (sections.length === 0) return null;

  const featuredNames = new Set(
    (profile.featuredMenuItems || [])
      .map((name) =>
        String(name || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
  const profileAny = profile as any;
  const userItemNames = optionalNameSet(
    profileAny.personalizedMenuItemNames,
    profileAny.userFavoriteItemNames,
    profileAny.userRecommendedItemNames,
    profileAny.savedMenuItemNames,
    profileAny.userMenuItems,
  );
  const recommendedNames = optionalNameSet(
    profileAny.recommendedMenuItemNames,
    profileAny.topRecommendedMenuItems,
    profileAny.communityRecommendedMenuItems,
  );
  const seen = new Set<string>();
  const uniqueItems = sections
    .flatMap((section) => section.items || [])
    .filter((item) => {
      const key = String(item.name || "")
        .trim()
        .toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const hasRecommendationSignal =
    featuredNames.size > 0 ||
    recommendedNames.size > 0 ||
    uniqueItems.some((item) => {
      const itemAny = item as any;
      return (
        Number(
          item.recommendationCount ??
            itemAny.recommendationCount ??
            itemAny.recommendationsCount ??
            itemAny.communityRecommendationCount ??
            0,
        ) > 0
      );
    });
  const topItems = uniqueItems
    .sort(
      (a, b) =>
        scoreMenuShelfItem(
          b,
          featuredNames,
          userItemNames,
          recommendedNames,
          hasRecommendationSignal,
          profile.id,
        ) -
        scoreMenuShelfItem(
          a,
          featuredNames,
          userItemNames,
          recommendedNames,
          hasRecommendationSignal,
          profile.id,
        ),
    )
    .slice(0, 8);
  const activeSection = sections[Math.min(activeIndex, sections.length - 1)];
  const activeItems = (activeSection?.items || []).filter((item) =>
    String(item.name || "").trim(),
  );

  return (
    <section aria-label="Food preview" className="space-y-4">
      {topItems.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/45">
              Top food
            </p>
          </div>
          <MenuItemSideRail items={topItems} />
        </div>
      ) : null}

      {sections.length > 1 ? (
        <div className="space-y-2">
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-none">
            {sections.map((section, index) => {
              const active = index === activeIndex;
              return (
                <button
                  key={`${section.name}:${index}`}
                  type="button"
                  onClick={() => setActiveIndex(index)}
                  className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-bold ${
                    active
                      ? "border-orange-300/60 bg-orange-500 text-black"
                      : "border-white/15 bg-white/5 text-white/70"
                  }`}
                >
                  {section.name}
                </button>
              );
            })}
          </div>
          <MenuItemSideRail items={activeItems} />
        </div>
      ) : null}
    </section>
  );
}

function MenuItemSideRail({ items }: { items: PublicMenuItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 scrollbar-none">
      {items.map((item, index) => {
        const categoryPhoto = item.imageUrl
          ? null
          : getDishCategoryPhoto(item.name, item.description);
        return (
        <article
          key={`${item.name}:${index}`}
          className="w-40 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-[#0f0d0b]"
        >
          <div className="relative h-24 bg-gradient-to-br from-[#241309] to-[#0d0a08]">
            {item.imageUrl ? (
              <img
                src={item.imageUrl}
                alt={item.name}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            ) : categoryPhoto ? (
              <img
                src={categoryPhoto.image}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_40%,rgba(251,146,60,0.2),transparent_55%)]" />
            )}
          </div>
          <div className="space-y-1 p-2.5">
            <p className="line-clamp-2 text-xs font-bold leading-snug text-white">
              {item.name}
            </p>
            {item.priceLabel ? (
              <p className="text-[11px] font-bold text-orange-200">
                {item.priceLabel}
              </p>
            ) : null}
            {item.description ? (
              <p className="line-clamp-2 text-[10px] leading-snug text-white/50">
                {item.description}
              </p>
            ) : null}
          </div>
        </article>
        );
      })}
    </div>
  );
}

function formatScheduleLabel(truck: LocationDiscoveryTruck) {
  const first = Array.isArray(truck.schedules) ? truck.schedules[0] : null;
  if (!first) return null;
  const start = String(first.startTime || "").trim();
  const end = String(first.endTime || "").trim();
  if (start && end) return `${start} - ${end}`;
  return start || end || null;
}

function LocationTruckOptionsSection({
  profile,
}: {
  profile: PublicLocationProfile;
}) {
  const hostId = String(profile.id || "").trim();
  const { data: nowData, isLoading: nowLoading } =
    useQuery<LocationDiscoveryPayload>({
      queryKey: ["/api/public/discovery/location", hostId, "now"],
      enabled: Boolean(hostId),
      queryFn: async () => {
        const res = await fetch(
          apiUrl(
            `/api/public/discovery/location/${encodeURIComponent(hostId)}/time/now`,
          ),
        );
        if (!res.ok) return { totalTrucks: 0, trucks: [] };
        return res.json();
      },
    });

  const { data: tonightData, isLoading: tonightLoading } =
    useQuery<LocationDiscoveryPayload>({
      queryKey: ["/api/public/discovery/location", hostId, "tonight"],
      enabled: Boolean(hostId),
      queryFn: async () => {
        const res = await fetch(
          apiUrl(
            `/api/public/discovery/location/${encodeURIComponent(hostId)}/time/tonight`,
          ),
        );
        if (!res.ok) return { totalTrucks: 0, trucks: [] };
        return res.json();
      },
    });

  const nowTrucks = Array.isArray(nowData?.trucks) ? nowData!.trucks! : [];
  const tonightTrucks = Array.isArray(tonightData?.trucks)
    ? tonightData!.trucks!
    : [];

  const tonightOnly = useMemo(() => {
    const nowIds = new Set(nowTrucks.map((truck) => String(truck.id)));
    return tonightTrucks.filter((truck) => !nowIds.has(String(truck.id)));
  }, [nowTrucks, tonightTrucks]);

  const hasCards = nowTrucks.length > 0 || tonightOnly.length > 0;
  const loading = nowLoading || tonightLoading;
  const featuredCurrent = nowTrucks.length > 0 ? nowTrucks[0] : null;
  const remainingCurrent = nowTrucks.length > 1 ? nowTrucks.slice(1) : [];

  const renderTruckCard = (
    truck: LocationDiscoveryTruck,
    status: "here_now" | "tonight",
    key: string,
    featured = false,
  ) => {
    const truckMedia = buildPublicProfileHeroAssets({
      ...truck,
      entity: "truck",
      displayName: truck.name,
    });
    const image = truckMedia.coverImageUrl || truckMedia.logoImageUrl;
    const scheduleLabel = formatScheduleLabel(truck);
    return (
      <div
        key={key}
        className={
          featured
            ? "rounded-xl border border-orange-400/35 bg-[linear-gradient(140deg,#20130d_0%,#17110d_55%,#120f0d_100%)] p-3"
            : "rounded-xl border border-white/10 bg-black/20 p-3"
        }
      >
        <div className="flex gap-3">
          <div className="h-16 w-16 flex-none overflow-hidden rounded-lg bg-[#1a1714]">
            {image ? (
              <img
                src={image}
                alt={truck.name}
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs font-semibold text-white/75">
                {String(truck.name || "Truck")
                  .slice(0, 2)
                  .toUpperCase()}
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">
              {truck.name}
            </p>
            {truck.cuisineType ? (
              <p className="truncate text-xs text-white/70">
                {truck.cuisineType}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">
                {status === "here_now" ? "Here now" : "Tonight"}
              </Badge>
              {scheduleLabel ? (
                <Badge
                  variant="outline"
                  className="border-white/15 text-white/80"
                >
                  {scheduleLabel}
                </Badge>
              ) : null}
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          {truck.truckPath ? (
            <ProgressiveContactLink
              href={truck.truckPath}
              data-analytics-action="profile_view"
              data-analytics-target-type="internal"
              className="inline-flex items-center rounded-md bg-orange-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-orange-400"
            >
              View
            </ProgressiveContactLink>
          ) : null}
          {locationLine(profile) ? (
            <ProgressiveContactLink
              href={`https://maps.google.com/?q=${encodeURIComponent(String(locationLine(profile) || ""))}`}
              data-analytics-action="directions_click"
              data-analytics-target-type="map"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-white/20 px-3 py-1.5 text-xs text-white/90 hover:bg-white/10"
            >
              <Route className="h-3.5 w-3.5" />
              Route
            </ProgressiveContactLink>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <Card className="border-white/10 bg-[#0f0d0b]">
      <CardHeader>
        <CardTitle className="text-xl text-white">Food options here</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="rounded-lg border border-white/10 bg-black/20 p-4 text-sm text-white/75">
            Loading nearby trucks...
          </div>
        ) : null}

        {!loading && hasCards ? (
          <div className="space-y-4">
            {featuredCurrent ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-orange-200/90">
                  Happening now
                </p>
                {renderTruckCard(
                  featuredCurrent,
                  "here_now",
                  `featured:${featuredCurrent.id}`,
                  true,
                )}
              </div>
            ) : null}
            {remainingCurrent.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-white/65">
                  Here now
                </p>
                <div className="space-y-2">
                  {remainingCurrent.map((truck) =>
                    renderTruckCard(truck, "here_now", `now:${truck.id}`),
                  )}
                </div>
              </div>
            ) : null}
            {tonightOnly.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-white/65">
                  Tonight
                </p>
                <div className="space-y-2">
                  {tonightOnly.map((truck) =>
                    renderTruckCard(truck, "tonight", `tonight:${truck.id}`),
                  )}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {!loading && !hasCards ? (
          <div className="rounded-lg border border-white/10 bg-black/20 p-4 text-sm text-white/75">
            <p>No trucks listed right now.</p>
            <p className="mt-1">Check back soon or explore nearby food.</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function LocationMapSection({ profile }: { profile: PublicLocationProfile }) {
  const hasCoords =
    typeof profile.latitude === "number" &&
    typeof profile.longitude === "number";
  const mapHref = hasCoords
    ? `https://maps.google.com/?q=${profile.latitude},${profile.longitude}`
    : null;

  return (
    <Card className="border-white/10 bg-[#0f0d0b]">
      <CardHeader>
        <CardTitle className="text-xl text-white">Map and directions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {hasCoords ? (
          <div className="rounded-xl border border-white/10 bg-gradient-to-br from-[#17120f] to-[#0f0d0b] p-3">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium text-white">Map preview</p>
              <Badge
                variant="outline"
                className="border-white/20 text-white/70"
              >
                {profile.latitude?.toFixed(4)}, {profile.longitude?.toFixed(4)}
              </Badge>
            </div>
            <div className="rounded-lg border border-white/10 bg-black/20 p-3">
              <div className="mb-2 h-16 rounded-md bg-[linear-gradient(135deg,#1b1713_0%,#13100d_55%,#100f0d_100%)]" />
              <p className="text-xs text-white/70">
                Nearby streets and food activity around this location.
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-sm text-white/75">
            Map coordinates are not available yet.
          </div>
        )}
        {locationLine(profile) ? (
          <p className="text-sm text-white/80">{locationLine(profile)}</p>
        ) : null}
        {mapHref ? (
          <ProgressiveContactLink
            href={mapHref}
            data-analytics-action="directions_click"
            data-analytics-target-type="map"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium text-orange-300 hover:text-orange-200"
          >
            Get directions <ExternalLink className="h-3.5 w-3.5" />
          </ProgressiveContactLink>
        ) : null}
      </CardContent>
    </Card>
  );
}

function LocationAmenitiesSection({
  profile,
}: {
  profile: PublicLocationProfile;
}) {
  const amenities = Array.isArray(profile.amenities) ? profile.amenities : [];
  const notes = profile.publicRules || profile.publicParkingSummary;
  if (amenities.length === 0 && !notes) return null;
  return (
    <Card className="border-white/10 bg-[#0f0d0b]">
      <CardHeader>
        <CardTitle className="text-xl text-white">
          Amenities and notes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {amenities.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {amenities.map((item) => (
              <Badge
                key={item}
                variant="outline"
                className="border-white/20 text-white/80"
              >
                {item}
              </Badge>
            ))}
          </div>
        ) : null}
        {notes ? <p className="text-sm text-white/75">{notes}</p> : null}
      </CardContent>
    </Card>
  );
}

function RestaurantSignals({ profile }: { profile: PublicRestaurantProfile }) {
  const signals: string[] = [];
  const menuCompleteness = assessPublicMenuCompleteness({
    menuSections: profile.menuSections,
    featuredMenuItems: profile.featuredMenuItems,
    menuUrl: profile.menuUrl,
    menuImageUrl: profile.menuImageUrl,
    menuPdfUrl: profile.menuPdfUrl,
  });
  if (profile.openStatus) signals.push(profile.openStatus);
  if (profile.deals.totalActive > 0) signals.push("Deal today");
  if (menuCompleteness.state === "complete") signals.push("Menu available");
  if (menuCompleteness.state === "partial") signals.push("Menu preview");
  if (
    profile.profileType === "truck" &&
    hasTruckScheduleSignal(profile.truckSchedule)
  ) {
    signals.push("Truck schedule available");
  }
  if (profile.recommendations.total > 0) signals.push("Local favorite");

  if (signals.length === 0) return null;
  return (
    <Card className="border-white/10 bg-[#0f0d0b]">
      <CardHeader>
        <CardTitle className="text-xl text-white">Why go now</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {signals.map((signal) => (
            <Badge key={signal} variant="secondary">
              {signal}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function AboutFoodStyle({ profile }: { profile: PublicRestaurantProfile }) {
  const normalizedServiceType = normalizeBusinessTypeLabel(
    profile.serviceType || "",
  );
  const seenTags = new Set<string>();
  const tags = [...profile.cuisineTags, normalizedServiceType || ""]
    .map((value) => String(value || "").trim())
    .filter((value) => {
      const key = value.toLowerCase();
      if (!key || seenTags.has(key)) return false;
      seenTags.add(key);
      return true;
    })
    .slice(0, 10);
  const hasAbout = Boolean(profile.description) || tags.length > 0;
  if (!hasAbout) return null;
  return (
    <Card className="border-white/10 bg-[#0f0d0b]">
      <CardHeader>
        <CardTitle className="text-xl text-white">About</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {profile.description ? (
          <p className="text-sm text-white/85">{profile.description}</p>
        ) : null}
        {tags.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => (
              <Badge
                key={tag}
                variant="outline"
                className="border-white/20 text-white/80"
              >
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MenuSection({
  profile,
  safeCtas,
}: {
  profile: PublicRestaurantProfile;
  safeCtas: PublicCta[];
}) {
  const [recommendingKey, setRecommendingKey] = useState<string | null>(null);
  const [recommendComment, setRecommendComment] = useState("");
  const [recommendPhoto, setRecommendPhoto] = useState<File | null>(null);
  const [submitStateByItem, setSubmitStateByItem] = useState<
    Record<string, string>
  >({});
  const [submittingItemId, setSubmittingItemId] = useState<string | null>(null);
  const menuVariants = Array.isArray(profile.menuVariants)
    ? profile.menuVariants.filter(
        (variant) => String(variant?.id || "").trim().length > 0,
      )
    : [];
  const [selectedMenuId, setSelectedMenuId] = useState<string>(
    String(profile.activeMenuId || menuVariants[0]?.id || ""),
  );
  useEffect(() => {
    setSelectedMenuId(
      String(profile.activeMenuId || menuVariants[0]?.id || ""),
    );
  }, [profile.activeMenuId, profile.id, menuVariants]);
  const activeVariant =
    (selectedMenuId &&
      menuVariants.find((variant) => String(variant.id) === selectedMenuId)) ||
    menuVariants[0] ||
    null;
  const internalMenuHref =
    profile.id && (profile.activeMenuId || activeVariant?.id)
      ? `/menu/${encodeURIComponent(profile.id)}`
      : null;
  const menuCta = safeCtas.find(
    (cta) =>
      cta.type === "menu" ||
      /menu/i.test(String(cta.label || "")) ||
      /\/menu\//i.test(String(cta.href || "")),
  );
  const featuredItems = Array.isArray(profile.featuredMenuItems)
    ? profile.featuredMenuItems.filter(Boolean)
    : [];
  const structuredSections = Array.isArray(activeVariant?.menuSections)
    ? activeVariant!.menuSections.filter(
        (section) =>
          section &&
          String(section.name || "").trim().length > 0 &&
          Array.isArray(section.items) &&
          section.items.length > 0,
      )
    : [];
  const hasStructuredMenu = structuredSections.length > 0;
  const menuCompleteness = assessPublicMenuCompleteness({
    menuSections: structuredSections,
    featuredMenuItems: featuredItems,
    menuUrl: activeVariant?.menuUrl || profile.menuUrl,
    menuImageUrl: profile.menuImageUrl,
    menuPdfUrl: profile.menuPdfUrl,
  });
  const pricedSections = structuredSections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) =>
        Boolean(String(item.priceLabel || "").trim()),
      ),
    }))
    .filter((section) => section.items.length > 0);
  const pricedItemCount = pricedSections.reduce(
    (count, section) => count + section.items.length,
    0,
  );
  const unpricedItems = structuredSections.flatMap((section) =>
    section.items
      .filter((item) => !String(item.priceLabel || "").trim())
      .map((item) => ({ sectionName: section.name, name: item.name })),
  );
  const hasSection =
    hasStructuredMenu ||
    Boolean(menuCta) ||
    Boolean(profile.menuUrl) ||
    Boolean(profile.menuImageUrl) ||
    Boolean(profile.menuPdfUrl) ||
    featuredItems.length > 0 ||
    profile.profileType === "truck";
  if (!hasSection) return null;

  const menuApproval = profile.menuApproval;
  const menuRejected = menuApproval?.status === "rejected";
  const fallbackMenuLink =
    profile.menuPdfUrl ||
    profile.menuImageUrl ||
    activeVariant?.menuUrl ||
    profile.menuUrl ||
    null;
  const updatedLabel =
    activeVariant?.menuLastUpdatedAt || profile.menuLastUpdatedAt
      ? new Date(
          activeVariant?.menuLastUpdatedAt || profile.menuLastUpdatedAt || "",
        ).toLocaleDateString()
      : null;
  const shouldCompactThinMenu =
    profile.profileType === "truck" &&
    menuCompleteness.state === "partial" &&
    pricedItemCount <= 2 &&
    featuredItems.length === 0 &&
    !fallbackMenuLink;
  const compactMenuPreviewItems = pricedSections
    .flatMap((section) =>
      section.items.map((item) => ({
        label: item.priceLabel
          ? `${item.name} · ${item.priceLabel}`
          : item.name,
      })),
    )
    .slice(0, 3);
  const menuStateLabel =
    menuCompleteness.state === "partial"
      ? shouldCompactThinMenu
        ? "Limited menu info"
        : "Menu preview"
      : null;
  const submitRecommendation = async (menuItemId: string) => {
    if (!menuItemId) return;
    setSubmittingItemId(menuItemId);
    try {
      const formData = new FormData();
      formData.append("comment", recommendComment);
      if (recommendPhoto) formData.append("image", recommendPhoto);
      const res = await fetch(
        apiUrl(`/api/menu-items/${encodeURIComponent(menuItemId)}/recommend`),
        {
          method: "POST",
          credentials: "include",
          body: formData,
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubmitStateByItem((prev) => ({
          ...prev,
          [menuItemId]:
            String(data?.message || "").trim() ||
            "Unable to submit recommendation right now.",
        }));
        return;
      }
      setSubmitStateByItem((prev) => ({
        ...prev,
        [menuItemId]:
          data?.photoStatus?.status === "pending"
            ? "Recommendation submitted. Photo is pending business review."
            : "Recommendation submitted.",
      }));
      setRecommendComment("");
      setRecommendPhoto(null);
      setRecommendingKey(null);
    } catch {
      setSubmitStateByItem((prev) => ({
        ...prev,
        [menuItemId]: "Unable to submit recommendation right now.",
      }));
    } finally {
      setSubmittingItemId(null);
    }
  };

  return (
    <Card className="border-white/10 bg-[#0f0d0b]">
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle className="text-xl text-white">
          {shouldCompactThinMenu ? "Menu preview" : "Menu"}
        </CardTitle>
        {internalMenuHref ? (
          <Link
            href={internalMenuHref}
            data-analytics-action="menu_click"
            data-analytics-target-type="menu"
            className="profile-action-secondary inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full px-3 text-xs font-black"
          >
            Full menu <MenuSquare className="h-3.5 w-3.5" />
          </Link>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {menuStateLabel ? (
          <div className="flex flex-wrap gap-2">
            <Badge
              variant="outline"
              className="border-amber-300/35 text-amber-100"
            >
              {menuStateLabel}
            </Badge>
          </div>
        ) : null}
        {menuVariants.length > 1 ? (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-white/60">
              Select menu
            </p>
            <div className="flex flex-wrap gap-2">
              {menuVariants.map((variant) => {
                const active =
                  String(variant.id) ===
                  String(selectedMenuId || activeVariant?.id || "");
                return (
                  <button
                    key={variant.id}
                    type="button"
                    onClick={() => setSelectedMenuId(String(variant.id))}
                    className={`rounded-md border px-2 py-1 text-xs ${
                      active
                        ? "border-orange-300/60 bg-orange-500/15 text-orange-100"
                        : "border-white/20 bg-black/15 text-white/75"
                    }`}
                  >
                    {variant.name}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        {profile.menuContextNote ? (
          <p className="rounded-md border border-sky-300/35 bg-sky-500/10 px-3 py-2 text-xs text-sky-100">
            {profile.menuContextNote}
          </p>
        ) : null}
        {profile.profileType === "truck" && menuApproval?.label ? (
          <p
            className={`rounded-md border px-3 py-2 text-xs ${
              menuApproval.ownerApproved || menuApproval.adminVerified
                ? "border-emerald-300/35 bg-emerald-500/10 text-emerald-100"
                : menuRejected
                  ? "border-white/15 bg-white/5 text-white/75"
                  : "border-amber-300/35 bg-amber-500/10 text-amber-100"
            }`}
          >
            {menuApproval.label}
          </p>
        ) : null}
        {menuCompleteness.state === "unavailable" ? (
          <p className="rounded-md border border-white/15 bg-white/5 px-3 py-2 text-xs text-white/75">
            {profile.profileType === "truck"
              ? "No menu posted yet."
              : "Menu unavailable right now."}
          </p>
        ) : null}
        {profile.profileType === "truck" &&
        !hasStructuredMenu &&
        menuCompleteness.state !== "unavailable" ? (
          <p className="rounded-md border border-white/15 bg-white/5 px-3 py-2 text-xs text-white/75">
            No menu posted yet.
          </p>
        ) : null}
        {updatedLabel ? (
          <p className="text-xs text-white/65">
            Menu last updated {updatedLabel}
          </p>
        ) : null}

        {shouldCompactThinMenu && compactMenuPreviewItems.length > 0 ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {compactMenuPreviewItems.map((item) => (
                <Badge
                  key={item.label}
                  variant="outline"
                  className="border-white/20 text-white/80"
                >
                  {item.label}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}

        {!shouldCompactThinMenu && pricedSections.length > 0 ? (
          <div className="space-y-4">
            {pricedSections.map((section) => (
              <div key={section.name} className="space-y-2">
                <p className="text-sm font-semibold text-white/90">
                  {section.name}
                </p>
                <div className="space-y-2">
                  {section.items.map((item, index) => (
                    <div
                      key={`${section.name}:${item.name}:${index}`}
                      className="rounded-lg border border-white/10 bg-black/20 p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-white">
                            {item.name}
                          </p>
                          {item.description ? (
                            <p className="mt-1 text-xs text-white/70">
                              {item.description}
                            </p>
                          ) : null}
                        </div>
                        {item.priceLabel ? (
                          <p className="text-sm font-semibold text-orange-200">
                            {item.priceLabel}
                          </p>
                        ) : null}
                      </div>
                      {item.menuItemId ? (
                        <div className="mt-3 space-y-2">
                          <button
                            type="button"
                            onClick={() =>
                              setRecommendingKey((current) =>
                                current === item.menuItemId
                                  ? null
                                  : item.menuItemId || null,
                              )
                            }
                            className="text-xs font-medium text-orange-300 hover:text-orange-200"
                          >
                            Recommend this item
                          </button>
                          {submitStateByItem[item.menuItemId] ? (
                            <p className="text-xs text-white/70">
                              {submitStateByItem[item.menuItemId]}
                            </p>
                          ) : null}
                          {recommendingKey === item.menuItemId ? (
                            <div className="space-y-2 rounded-md border border-white/10 bg-black/30 p-2">
                              <textarea
                                value={recommendComment}
                                onChange={(event) =>
                                  setRecommendComment(event.target.value)
                                }
                                placeholder="Why do you recommend this dish?"
                                className="min-h-[64px] w-full rounded border border-white/20 bg-black/40 px-2 py-1 text-xs text-white"
                              />
                              <div className="space-y-1">
                                <p className="text-xs text-white/65">
                                  Got a photo of this dish? Add it so others
                                  know what to expect.
                                </p>
                                <input
                                  type="file"
                                  accept="image/*"
                                  onChange={(event) =>
                                    setRecommendPhoto(
                                      event.target.files?.[0] || null,
                                    )
                                  }
                                  className="text-xs text-white/80"
                                />
                              </div>
                              <div className="flex items-center gap-2">
                                <Button
                                  size="sm"
                                  onClick={() =>
                                    submitRecommendation(
                                      String(item.menuItemId || ""),
                                    )
                                  }
                                  disabled={
                                    submittingItemId === item.menuItemId
                                  }
                                >
                                  {submittingItemId === item.menuItemId
                                    ? "Submitting..."
                                    : "Submit recommendation"}
                                </Button>
                                <button
                                  type="button"
                                  className="text-xs text-white/60 hover:text-white/80"
                                  onClick={() => setRecommendingKey(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {!shouldCompactThinMenu && unpricedItems.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-white/90">
              More items listed
            </p>
            <div className="space-y-1">
              {unpricedItems.map((item, index) => (
                <p
                  key={`${item.sectionName}:${item.name}:${index}`}
                  className="text-xs text-white/75"
                >
                  {item.sectionName}: {item.name}
                </p>
              ))}
            </div>
          </div>
        ) : null}

        {featuredItems.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-white/90">Featured items</p>
            <div className="flex flex-wrap gap-2">
              {featuredItems.map((item) => (
                <Badge
                  key={item}
                  variant="outline"
                  className="border-white/20 text-white/80"
                >
                  {item}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}
        {!internalMenuHref && menuCta ? (
          renderCtaButton(menuCta, "default", "menu-cta")
        ) : !internalMenuHref && fallbackMenuLink ? (
          <ProgressiveContactLink
            href={fallbackMenuLink}
            data-analytics-action="menu_click"
            data-analytics-target-type="menu"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium text-orange-300 hover:text-orange-200"
          >
            See menu <MenuSquare className="h-4 w-4" />
          </ProgressiveContactLink>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FullMenuSection({
  profile,
  safeCtas,
}: {
  profile: PublicRestaurantProfile;
  safeCtas: PublicCta[];
}) {
  return <MenuSection profile={profile} safeCtas={safeCtas} />;
}

function DealsSection({ profile }: { profile: PublicRestaurantProfile }) {
  const dealItems = Array.isArray(profile.deals.items)
    ? profile.deals.items.filter((item) =>
        Boolean(
          String(item?.id || "").trim() &&
          String(item?.title || "").trim() &&
          String(item?.actionHref || "").trim(),
        ),
      )
    : [];
  if (dealItems.length === 0) return null;
  const formatDealDate = (value: string | null) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString();
  };
  const dateWindowLabel = (item: (typeof dealItems)[number]) => {
    const start = formatDealDate(item.startAt);
    const end = formatDealDate(item.endAt);
    if (start && end && start !== end) return `${start} - ${end}`;
    if (start && end && start === end) return "Today";
    if (end) return `Ends ${end}`;
    if (start) return start;
    return null;
  };
  const dealTypeLabel = (dealType: string) => {
    if (dealType === "happy_hour") return "Happy hour";
    if (dealType === "limited_time") return "Limited-time";
    if (dealType === "family_meal") return "Family meal";
    if (dealType === "daily") return "Daily";
    if (dealType === "lunch") return "Lunch";
    if (dealType === "coupon") return "Coupon";
    return "Special";
  };
  return (
    <Card className="border-white/10 bg-[#0f0d0b]">
      <CardHeader>
        <CardTitle className="text-xl text-white">Deals and specials</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {dealItems.map((deal) => (
          <div
            key={deal.id}
            className="rounded-lg border border-white/10 bg-black/20 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-white">{deal.title}</p>
              <Badge
                variant="outline"
                className="border-white/20 text-white/80"
              >
                {dealTypeLabel(deal.dealType)}
              </Badge>
            </div>
            {deal.description ? (
              <p className="mt-1 text-xs text-white/75">{deal.description}</p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2">
              {dateWindowLabel(deal) ? (
                <Badge variant="secondary">{dateWindowLabel(deal)}</Badge>
              ) : null}
              {deal.timeWindowLabel ? (
                <Badge
                  variant="outline"
                  className="border-white/15 text-white/80"
                >
                  {deal.timeWindowLabel}
                </Badge>
              ) : null}
            </div>
            <div className="mt-3">
              <ProgressiveContactLink
                href={deal.actionHref}
                data-analytics-action="deal_click"
                data-analytics-target-type={deal.actionType || "deal"}
                target={
                  deal.actionType === "internal" ||
                  deal.actionType === "show_this_deal"
                    ? undefined
                    : "_blank"
                }
                rel={
                  deal.actionType === "internal" ||
                  deal.actionType === "show_this_deal"
                    ? undefined
                    : "noopener noreferrer"
                }
                className="inline-flex items-center rounded-md bg-orange-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-orange-400"
              >
                {deal.actionLabel}
              </ProgressiveContactLink>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function EventsSection({
  profile,
}: {
  profile:
    | Pick<PublicRestaurantProfile, "events">
    | Pick<PublicLocationProfile, "events">;
}) {
  const eventItems = Array.isArray(profile.events?.items)
    ? profile.events.items.filter((item) =>
        Boolean(
          String(item?.id || "").trim() &&
          String(item?.title || "").trim() &&
          String(item?.actionHref || "").trim(),
        ),
      )
    : [];
  if (eventItems.length === 0) return null;
  const typeLabel = (value: string) => {
    if (value === "live_music") return "Live music";
    if (value === "food_truck_night") return "Food truck night";
    if (value === "watch_party") return "Watch party";
    if (value === "pop_up") return "Pop-up";
    return value.replace(/_/g, " ");
  };
  return (
    <Card className="border-white/10 bg-[#0f0d0b]">
      <CardHeader>
        <CardTitle className="text-xl text-white">Events</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {eventItems.map((event) => (
          <div
            key={event.id}
            className="rounded-lg border border-white/10 bg-black/20 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-white">{event.title}</p>
              <Badge
                variant="outline"
                className="border-white/20 text-white/80 capitalize"
              >
                {typeLabel(event.eventType)}
              </Badge>
            </div>
            {event.description ? (
              <p className="mt-1 text-xs text-white/75">{event.description}</p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2">
              {event.dateLabel ? (
                <Badge variant="secondary">{event.dateLabel}</Badge>
              ) : null}
              {event.timeWindowLabel ? (
                <Badge
                  variant="outline"
                  className="border-white/15 text-white/80"
                >
                  {event.timeWindowLabel}
                </Badge>
              ) : null}
            </div>
            {event.locationName || event.addressPublicLabel ? (
              <p className="mt-2 text-xs text-white/70">
                {[event.locationName, event.addressPublicLabel]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            ) : null}
            <div className="mt-3">
              <ProgressiveContactLink
                href={event.actionHref}
                data-analytics-action="event_click"
                data-analytics-target-type={event.actionType || "event"}
                target={
                  event.actionType === "internal" || event.actionType === "rsvp"
                    ? undefined
                    : "_blank"
                }
                rel={
                  event.actionType === "internal" || event.actionType === "rsvp"
                    ? undefined
                    : "noopener noreferrer"
                }
                className="inline-flex items-center gap-1 rounded-md bg-orange-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-orange-400"
              >
                <CalendarDays className="h-3.5 w-3.5" />
                {event.actionLabel}
              </ProgressiveContactLink>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function FeaturedBartendersSection({
  profile,
}: {
  profile: PublicRestaurantProfile;
}) {
  if (profile.profileType !== "bar") return null;
  const raw = Array.isArray((profile as any).featuredBartenders)
    ? (profile as any).featuredBartenders
    : [];
  const featured = raw
    .filter(
      (entry: any) =>
        entry &&
        (entry.isActive ?? true) &&
        Boolean(String(entry.name || "").trim()),
    )
    .sort(
      (a: any, b: any) =>
        Number(a?.displayOrder || 0) - Number(b?.displayOrder || 0),
    );
  if (featured.length === 0) return null;

  return (
    <Card className="border-white/10 bg-[#0f0d0b]">
      <CardHeader>
        <CardTitle className="text-xl text-white">
          Featured bartenders
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {featured.map((entry: any, index: number) => (
          <div
            key={`${String(entry?.name || "bartender")}:${index}`}
            className="rounded-lg border border-white/10 bg-black/20 p-3"
          >
            <div className="flex items-center gap-3">
              {entry.photo ? (
                <img
                  src={String(entry.photo)}
                  alt={String(entry.name)}
                  loading="lazy"
                  className="h-12 w-12 rounded-full object-cover border border-white/15"
                />
              ) : null}
              <div>
                <p className="text-sm font-semibold text-white">
                  {String(entry.name)}
                </p>
                {entry.role || entry.title ? (
                  <p className="text-xs text-white/70">
                    {String(entry.role || entry.title)}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {entry.featuredNights ? (
                <Badge variant="secondary">
                  {String(entry.featuredNights)}
                </Badge>
              ) : null}
              {entry.signatureDrink ? (
                <Badge
                  variant="outline"
                  className="border-white/15 text-white/80"
                >
                  Signature: {String(entry.signatureDrink)}
                </Badge>
              ) : null}
              {entry.specialty ? (
                <Badge
                  variant="outline"
                  className="border-white/15 text-white/80"
                >
                  {String(entry.specialty)}
                </Badge>
              ) : null}
            </div>
            {entry.bio || entry.tagline ? (
              <p className="mt-2 text-xs text-white/75">
                {String(entry.bio || entry.tagline)}
              </p>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ProofSection({ profile }: { profile: PublicRestaurantProfile }) {
  const metrics = [
    {
      label: "Recommendations",
      value: Number(profile.recommendations.total || 0),
    },
    { label: "Recommendation notes", value: Number(profile.reviewSummary.count || 0) },
  ].filter((metric) => metric.value > 0);
  if (metrics.length === 0) return null;
  return (
    <Card className="border-white/10 bg-[#0f0d0b]">
      <CardHeader>
        <CardTitle className="text-xl text-white">From locals</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {metrics.map((metric) => (
          <div
            key={metric.label}
            className="rounded-lg border border-white/10 bg-black/20 p-3"
          >
            <p className="text-xs uppercase tracking-wide text-white/60">
              {metric.label}
            </p>
            <p className="mt-1 text-2xl font-semibold text-white">
              {metric.value}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function PublicProfileGalleryTile({
  image,
  profileName,
  index,
  label,
}: {
  image: PublicRestaurantProfile["galleryImages"][number];
  profileName: string;
  index: number;
  label: string;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <div className="relative h-28 w-44 flex-none overflow-hidden rounded-xl border border-[color:var(--profile-border)] bg-[color:var(--profile-surface-soft)]">
      {failed ? (
        <div className="flex h-full items-center justify-center px-3 text-center text-xs font-semibold text-[color:var(--profile-muted)]">
          Photo unavailable
        </div>
      ) : (
        <img
          src={image.url}
          alt={`${profileName} ${index + 1}`}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      )}
      {!failed ? (
        <span className="absolute bottom-1.5 left-1.5 rounded-full bg-black/65 px-2 py-0.5 text-[10px] font-bold text-[#fff]">
          {label}
        </span>
      ) : null}
    </div>
  );
}

function GalleryStrip({ profile }: { profile: PublicRestaurantProfile }) {
  if (
    !Array.isArray(profile.galleryImages) ||
    profile.galleryImages.length === 0
  ) {
    return null;
  }
  const images = profile.galleryImages
    .filter((image) => image.publicApproved && image.url)
    .slice(0, 12);
  if (images.length === 0) {
    // Photos were uploaded but none are approved yet — say so instead of
    // silently disappearing, which looked identical to never uploading any.
    return (
      <Card className="border-white/10 bg-[#0f0d0b]">
        <CardHeader>
          <CardTitle className="text-base font-semibold text-white/90">
            Gallery
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-white/50">Photos pending review.</p>
        </CardContent>
      </Card>
    );
  }
  const imageTypeLabel = (source: string) => {
    if (source === "cover_image") return "Cover";
    if (source === "logo") return "Logo";
    if (source === "spot_image") return "Storefront";
    if (source === "google_photo") return "Atmosphere";
    if (source === "gallery") return "Food";
    return "Photo";
  };

  return (
    <Card className="border-white/10 bg-[#0f0d0b]">
      <CardHeader>
        <CardTitle className="text-base font-semibold text-white/90">
          Gallery
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2.5 overflow-x-auto pb-1">
          {images.map((image, idx) => (
            <PublicProfileGalleryTile
              key={`${image.url}-${idx}`}
              image={image}
              profileName={profile.displayName}
              index={idx}
              label={imageTypeLabel(image.source)}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function RestaurantSchedule({ profile }: { profile: PublicRestaurantProfile }) {
  const hasHours = Boolean(
    String(profile.operatingHoursSummary || "").trim(),
  );
  const schedule =
    profile.profileType === "truck" ? profile.truckSchedule : null;
  const scheduleRows = getTruckScheduleRows(schedule);
  const currentStop = scheduleRows.currentStop;
  const todayStop = scheduleRows.todayStop;
  const nextStop = scheduleRows.nextStop;
  const upcomingStops = scheduleRows.upcomingStops.slice(0, 6);
  const closedStops = scheduleRows.closedStops.slice(0, 7);
  const hasTruckSchedule = scheduleRows.hasActionableSchedule;
  const hasTruckScheduleInfo = hasTruckSchedule || closedStops.length > 0;
  const scheduleEmptyState = getTruckScheduleEmptyStateLabel();
  const scheduleStatusBadge = getTruckScheduleStatusBadgeLabel(schedule);
  const truckEmptyScheduleLabel =
    profile.profileType === "truck" &&
    scheduleEmptyState === "No schedule posted"
      ? "No upcoming stops posted."
      : scheduleEmptyState;
  if (!hasHours && !hasTruckSchedule && profile.profileType !== "truck")
    return null;

  const stopRow = (
    label: string,
    stop: NonNullable<typeof currentStop>,
    emphasize = false,
  ) => (
    <div
      className={
        emphasize
          ? "rounded-lg border border-orange-400/35 bg-[#1b120d] p-3"
          : "rounded-lg border border-white/10 bg-black/20 p-3"
      }
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-white/65">
        {label}
      </p>
      <p className="mt-1 text-sm font-semibold text-white">
        {stop.locationName ||
          stop.addressPublicLabel ||
          (stop.status === "closed" ? "Closed" : "Location update")}
      </p>
      <p className="text-xs text-white/70">
        {[stop.date, stop.timeWindowLabel].filter(Boolean).join(" · ")}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {stop.status ? (
          <Badge variant="secondary">
            {String(stop.status).replace(/_/g, " ")}
          </Badge>
        ) : null}
        {stop.directionsUrl ? (
          <ProgressiveContactLink
            href={stop.directionsUrl}
            data-analytics-action="directions_click"
            data-analytics-target-type="map"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-white/20 px-2.5 py-1 text-xs text-white/85 hover:bg-white/10"
          >
            <Route className="h-3.5 w-3.5" />
            Get directions
          </ProgressiveContactLink>
        ) : null}
      </div>
    </div>
  );

  return (
    <Card
      id={profile.profileType === "truck" ? "truck-schedule" : undefined}
      className="border-white/10 bg-[#0f0d0b]"
    >
      <CardHeader>
        <CardTitle className="text-xl text-white">
          {profile.profileType === "truck" ? "Schedule" : "Hours and schedule"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm text-white/80">
        {hasHours ? (
          <p className="inline-flex items-center gap-1">
            <Clock3 className="h-4 w-4" />
            {profile.operatingHoursSummary}
          </p>
        ) : null}
        {profile.profileType === "truck" && hasTruckScheduleInfo ? (
          <div className="space-y-3">
            {scheduleStatusBadge ? (
              <Badge
                variant="outline"
                className="border-orange-300/35 text-orange-200"
              >
                {scheduleStatusBadge}
              </Badge>
            ) : null}
            {currentStop ? stopRow("Here now", currentStop, true) : null}
            {!currentStop && todayStop
              ? stopRow("Today's stop", todayStop)
              : null}
            {!currentStop && !todayStop && nextStop
              ? stopRow("Next stop", nextStop)
              : null}
            {upcomingStops.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-white/65">
                  Upcoming schedule
                </p>
                <div className="space-y-2">
                  {upcomingStops.map((stop, index) => (
                    <div
                      key={`${stop.stopId || stop.date || "stop"}:${index}`}
                      className="rounded-lg border border-white/10 bg-black/20 p-2.5"
                    >
                      <p className="text-sm font-medium text-white">
                        {stop.locationName ||
                          stop.addressPublicLabel ||
                          (stop.status === "closed"
                            ? "Closed"
                            : "Scheduled stop")}
                      </p>
                      <p className="text-xs text-white/70">
                        {[stop.date, stop.timeWindowLabel]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {closedStops.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-white/65">
                  Closed days
                </p>
                <div className="space-y-2">
                  {closedStops.map((stop, index) => (
                    <div
                      key={`${stop.stopId || stop.date || "closed"}:${index}`}
                      className="rounded-lg border border-white/10 bg-black/20 p-2.5"
                    >
                      <p className="text-sm font-medium text-white">Closed</p>
                      <p className="text-xs text-white/70">
                        {[stop.date, stop.timeWindowLabel]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {stop.notice ? (
                        <p className="mt-1 text-xs text-white/65">
                          {stop.notice}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {schedule?.notice ? (
              <div className="rounded-md border border-white/10 bg-black/20 p-2.5 text-xs text-white/80">
                {schedule.notice}
              </div>
            ) : null}
          </div>
        ) : null}
        {profile.profileType === "truck" && !hasTruckScheduleInfo ? (
          <p className="rounded-md border border-white/15 bg-white/5 px-3 py-2 text-xs text-white/75">
            {truckEmptyScheduleLabel}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RestaurantSocial({
  profile,
  safeCtas,
}: {
  profile: PublicRestaurantProfile;
  safeCtas: PublicCta[];
}) {
  const grouped = {
    website: safeCtas.filter(
      (cta) =>
        cta.type === "external" &&
        !/instagram|facebook|x\.com|twitter/i.test(String(cta.href || "")),
    ),
    follow: safeCtas.filter(
      (cta) => cta.type === "social",
    ),
  };
  const unique = (ctas: PublicCta[]) =>
    ctas.reduce((acc, cta) => {
      if (acc.some((x) => x.href === cta.href)) return acc;
      acc.push(cta);
      return acc;
    }, [] as PublicCta[]);
  const websiteActions = unique(grouped.website);
  const followActions = unique(grouped.follow);
  if (websiteActions.length === 0 && followActions.length === 0) {
    return null;
  }
  return (
    <Card className="border-white/10 bg-[#0f0d0b]">
      <CardHeader>
        <CardTitle className="text-xl text-white">Social links</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {websiteActions.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-white/60">
              Website
            </p>
            <div className="flex flex-wrap gap-2">
              {websiteActions.map((cta, idx) =>
                renderCtaButton(cta, "outline", `website-${cta.href}-${idx}`),
              )}
            </div>
          </div>
        ) : null}
        {followActions.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-white/60">
              Follow
            </p>
            <div className="flex flex-wrap gap-2">
              {followActions.map((cta, idx) =>
                renderCtaButton(cta, "outline", `follow-${cta.href}-${idx}`),
              )}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PublicProfileRelatedDiscoveryLinks({
  data,
  citySlug,
}: {
  data: PublicProfilePayload;
  citySlug: string | null;
}) {
  if (!data.city || !citySlug) return null;
  const encodedCitySlug = encodeURIComponent(citySlug);
  return (
    <Card className="border-white/10 bg-[#0f0d0b]">
      <CardHeader>
        <CardTitle className="text-base text-white">
          Explore more food in {data.city}
        </CardTitle>
        <CardDescription className="text-white/60">
          Find nearby restaurants, trucks, bars, and fresh local updates from
          MealScout. MealScout coverage is limited and grows as local trucks
          and places update their profiles.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <ProgressiveContactLink
          href={`/city/${encodedCitySlug}/food`}
          className="rounded-md border border-white/10 px-3 py-2 text-white/85 hover:bg-white/10"
        >
          Browse local food
        </ProgressiveContactLink>
        <ProgressiveContactLink
          href={`/food-trucks-today/${encodedCitySlug}`}
          className="rounded-md border border-white/10 px-3 py-2 text-white/85 hover:bg-white/10"
        >
          Food trucks today
        </ProgressiveContactLink>
        <ProgressiveContactLink
          href="/scout"
          className="rounded-md border border-white/10 px-3 py-2 text-white/85 hover:bg-white/10"
        >
          Scout
        </ProgressiveContactLink>
        <ProgressiveContactLink
          href="/claim-business"
          className="rounded-md border border-white/10 px-3 py-2 text-white/85 hover:bg-white/10"
        >
          Claim or update a profile
        </ProgressiveContactLink>
      </CardContent>
    </Card>
  );
}

export default function PublicProfilePage() {
  const { user, isAuthenticated, authState } = useAuth();
  const scoutJourney = readScoutJourney(authState === "loading" ? null : String(user?.id || "guest"));
  const scoutHref = scoutJourney?.route || "/scout";
  const scoutLabel = "Scout";
  const params = useParams<Record<string, string | undefined>>();
  const pathname =
    typeof window !== "undefined" ? window.location.pathname : "";
  const cleanBusinessRoute = useMemo(
    () => parseCleanAffiliateBusinessRoute(pathname),
    [pathname],
  );
  const inferredProfileType = (() => {
    if (pathname.startsWith("/truck/")) return "truck";
    if (pathname.startsWith("/bar/")) return "bar";
    if (pathname.startsWith("/caterer/")) return "caterer";
    if (pathname.startsWith("/private-chef/")) return "private_chef";
    if (pathname.startsWith("/location/")) return "location";
    if (pathname.startsWith("/supplier/")) return "supplier";
    if (pathname.startsWith("/restaurant/")) return "restaurant";
    return String(params.profileType || "").trim();
  })();
  const typedRouteSlug = String(params.slug || "").trim();
  const typedSlugNeedsResolution =
    Boolean(inferredProfileType) &&
    inferredProfileType !== "restaurant" &&
    Boolean(typedRouteSlug) &&
    !extractUuidFromSlug(typedRouteSlug);
  const cleanBusinessSlug =
    cleanBusinessRoute?.businessSlug ||
    (typedSlugNeedsResolution ? typedRouteSlug : null);
  const isCleanBusinessRoute =
    (!inferredProfileType || typedSlugNeedsResolution) &&
    Boolean(cleanBusinessSlug);
  const { data: cleanBusinessResolution, isLoading: cleanBusinessLoading, error: cleanBusinessError, isFetching: cleanBusinessFetching, refetch: retryCleanBusiness } =
    useQuery<{
      entityType:
        | "restaurant"
        | "truck"
        | "bar"
        | "caterer"
        | "private_chef"
        | "location"
        | "supplier";
      id: string;
      businessSlug: string;
    }>({
      queryKey: ["/api/public/resolve-business", cleanBusinessSlug, user?.id ?? "guest"],
      enabled: Boolean(isCleanBusinessRoute && cleanBusinessSlug),
      queryFn: ({ signal }) => readPublicProfileJson(
        apiUrl(`/api/public/resolve-business/${encodeURIComponent(String(cleanBusinessSlug || ""))}`), signal,
      ),
      retry: false,
    });
  const rawProfileId = String(
    params.profileId ||
      params.id ||
      (typedSlugNeedsResolution ? cleanBusinessResolution?.id : params.slug) ||
      cleanBusinessResolution?.id ||
      "",
  ).trim();
  const resolvedProfileId = extractUuidFromSlug(rawProfileId) || rawProfileId;
  const normalizedProfileType = normalizePublicProfileEntity(
    inferredProfileType || cleanBusinessResolution?.entityType,
  );
  const typedSlugResolvedToWrongType =
    typedSlugNeedsResolution &&
    Boolean(cleanBusinessResolution) &&
    normalizePublicProfileEntity(cleanBusinessResolution?.entityType) !==
      normalizedProfileType;
  const invalidRestaurantRoute =
    normalizedProfileType === "restaurant" &&
    Boolean(rawProfileId) &&
    !UUID_LIKE_RE.test(resolvedProfileId);

  const locationSearch =
    typeof window !== "undefined" ? window.location.search : "";
  const { data, isLoading, error: profileReadError, isFetching: profileFetching, refetch: retryProfile } = useQuery<PublicProfilePayload>({
    queryKey: [
      "/api/public/profiles",
      normalizedProfileType,
      resolvedProfileId,
      locationSearch,
      user?.id ?? "guest",
    ],
    enabled:
      !!normalizedProfileType &&
      !!resolvedProfileId &&
      !invalidRestaurantRoute &&
      !typedSlugResolvedToWrongType,
    queryFn: ({ signal }) => readPublicProfileJson<PublicProfilePayload>(
      apiUrl(`/api/public/profiles/${encodeURIComponent(String(normalizedProfileType || ""))}/${encodeURIComponent(String(resolvedProfileId || ""))}${locationSearch || ""}`), signal,
    ),
    retry: false,
  });

  useEffect(() => {
    if (!data?.id || typeof window === "undefined") return;
    const sourceRestaurantId = new URLSearchParams(window.location.search).get(
      "promoSource",
    );
    if (!sourceRestaurantId || sourceRestaurantId === data.id) return;
    const controller = new AbortController();
    void fetch(apiUrl("/api/public/promotion-attributions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      signal: controller.signal,
      body: JSON.stringify({
        sourceRestaurantId,
        targetRestaurantId: data.id,
      }),
    })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json();
      })
      .then((payload) => {
        if (payload?.token) {
          window.localStorage.setItem(
            `mealscout:promotion:${data.id}`,
            String(payload.token),
          );
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [data?.id]);

  const safeCtas = useMemo(() => asSafeCtas(data?.cta), [data?.cta]);

  // Personalization remains scoped to the signed-in account.

  // Load user's favorited restaurant IDs when authenticated
  const { data: userFavorites } = useQuery<
    Array<{ restaurantId: string; restaurant?: { id: string } }>
  >({
    queryKey: ["/api/favorites/restaurants", "profile-personalization", user?.id],
    enabled: isAuthenticated && Boolean(data?.id),
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/favorites/restaurants"), {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Saved places could not be loaded");
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  const userFavoriteIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of userFavorites ?? []) {
      const id = String(row.restaurantId || row.restaurant?.id || "").trim();
      if (id) ids.add(id);
    }
    return ids;
  }, [userFavorites]);

  const isCurrentProfileFavorited = Boolean(
    data?.id && userFavoriteIds.has(data.id),
  );

  const sentViewRef = useRef<string>("");
  const imageFailureRef = useRef<Set<string>>(new Set());
  const querySource = useMemo(() => {
    if (typeof window === "undefined") return "public_profile";
    const params = new URLSearchParams(window.location.search);
    const raw = String(params.get("utm_source") || "").toLowerCase();
    if (raw.startsWith("discovery_")) return raw;
    return raw.includes("qr") ? "qr" : "public_profile";
  }, []);

  const trackProfileEvent = useCallback(
    (actionType: string, targetType?: string | null, href?: string | null) => {
      if (!data?.id || !data?.profileType) return;
      const hrefCategory = (() => {
        const raw = String(href || "").trim();
        if (!raw) return null;
        if (raw.startsWith("tel:")) return "phone";
        if (raw.includes("maps.google.com")) return "map";
        if (raw.includes("/menu/")) return "menu";
        if (
          raw.includes("doordash") ||
          raw.includes("ubereats") ||
          raw.includes("grubhub")
        ) {
          return "delivery";
        }
        if (raw.startsWith("/")) return "internal";
        try {
          return new URL(raw).hostname.toLowerCase();
        } catch {
          return "external";
        }
      })();

      void fetch(apiUrl("/api/public/profile-analytics"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          profileEntity: data.profileType,
          profileId: data.id,
          actionType,
          targetType: targetType || null,
          targetHrefCategory: hrefCategory,
          source: querySource,
        }),
      }).catch(() => {});
    },
    [data?.id, data?.profileType, querySource],
  );

  const trackQualitySignal = useCallback(
    (
      type: PublicProfileQualitySignalType,
      extra?: Partial<
        Pick<
          PublicProfileQualitySignalPayload,
          "missing_menu" | "missing_schedule" | "failed_image_type"
        >
      >,
      dedupeSuffix?: string,
    ) => {
      const profileId =
        String(data?.id || resolvedProfileId || "").trim() || null;
      const profileType =
        String(data?.profileType || normalizedProfileType || "").trim() || null;
      const path =
        typeof window !== "undefined"
          ? window.location.pathname
          : pathname || "/";
      const dedupeKey = dedupeSuffix
        ? `${type}:${profileType || "unknown"}:${profileId || path}:${dedupeSuffix}`
        : undefined;

      sendPublicProfileQualitySignal(
        {
          type,
          profile_id: profileId,
          profile_type: profileType,
          path,
          missing_menu: extra?.missing_menu,
          missing_schedule: extra?.missing_schedule,
          failed_image_type: extra?.failed_image_type || null,
          timestamp: new Date().toISOString(),
        },
        dedupeKey,
      );
    },
    [
      data?.id,
      data?.profileType,
      normalizedProfileType,
      pathname,
      resolvedProfileId,
    ],
  );

  useEffect(() => {
    if (!data?.id || !data?.profileType) return;
    const key = `${data.profileType}:${data.id}`;
    if (sentViewRef.current === key) return;
    sentViewRef.current = key;
    trackProfileEvent("profile_view", "page", window.location.pathname);
    if (querySource === "qr") {
      const params = new URLSearchParams(window.location.search);
      const qrType = String(params.get("type") || "").toLowerCase();
      if (qrType === "menu")
        trackProfileEvent("qr_menu_open", "qr", window.location.href);
      else if (qrType === "specials")
        trackProfileEvent("qr_specials_open", "qr", window.location.href);
      else trackProfileEvent("qr_profile_open", "qr", window.location.href);
    }
  }, [data?.id, data?.profileType, querySource, trackProfileEvent]);

  useEffect(() => {
    if (isLoading || cleanBusinessLoading || data) return;
    if (!normalizedProfileType && !resolvedProfileId) return;
    const failure = cleanBusinessError || profileReadError;
    if (failure && !isMissingPublicProfile(failure)) return;
    trackQualitySignal(
      "public_profile_not_found_viewed",
      undefined,
      "not-found",
    );
  }, [
    cleanBusinessLoading,
    cleanBusinessError,
    profileReadError,
    data,
    isLoading,
    normalizedProfileType,
    resolvedProfileId,
    trackQualitySignal,
  ]);

  useEffect(() => {
    if (!data || !isRestaurantLikeEntity(data.entity)) return;
    if (!hasStructuredPublicMenu(data)) {
      trackQualitySignal(
        "missing_menu_viewed",
        { missing_menu: true },
        "missing-menu",
      );
    }
    if (!hasPostedScheduleOrTimeWindow(data)) {
      trackQualitySignal(
        "missing_schedule_viewed",
        { missing_schedule: true },
        "missing-schedule",
      );
    }
  }, [data, trackQualitySignal]);

  useEffect(() => {
    if (!data) return;
    const imageCandidates = [
      { type: "cover", url: String((data as any).coverImageUrl || "").trim() },
      { type: "logo", url: String((data as any).logoUrl || "").trim() },
    ].filter(
      (candidate): candidate is { type: "logo" | "cover"; url: string } =>
        Boolean(candidate.url),
    );

    imageCandidates.forEach((candidate) => {
      const imageKey = `${data.profileType}:${data.id}:${candidate.type}:${candidate.url}`;
      if (imageFailureRef.current.has(imageKey)) return;
      const image = new Image();
      image.onerror = () => {
        if (imageFailureRef.current.has(imageKey)) return;
        imageFailureRef.current.add(imageKey);
        trackQualitySignal(
          "failed_profile_image",
          { failed_image_type: candidate.type },
          `failed-image:${candidate.type}:${candidate.url}`,
        );
      };
      image.src = candidate.url;
    });
  }, [data, trackQualitySignal]);

  const cleanProfilePath = cleanBusinessSlug
    ? buildCleanPublicBusinessPath(`/${cleanBusinessSlug}`)
    : null;
  const resolvedCleanBusinessPath =
    String((data as any)?.cleanBusinessPath || "").trim() || cleanProfilePath;

  useEffect(() => {
    const routeRef = String(cleanBusinessRoute?.affiliateTag || "").trim();
    if (!routeRef || !resolvedCleanBusinessPath) return;
    if (!isLikelyCleanAffiliateTagSegment(routeRef)) return;
    setAffiliateRef(routeRef);
  }, [cleanBusinessRoute?.affiliateTag, resolvedCleanBusinessPath]);

  const readFailure = cleanBusinessError || profileReadError;
  const unavailable = Boolean(readFailure && !isMissingPublicProfile(readFailure));
  const accessDenied = isPrivatePublicProfile(readFailure);
  const retrying = cleanBusinessFetching || profileFetching;

  if ((isLoading || cleanBusinessLoading) && !invalidRestaurantRoute) {
    return (
      <div className="mealscout-public-profile flex min-h-screen items-center justify-center px-4">
        <div className="profile-surface w-full max-w-md rounded-[1.75rem] p-6">
          <div className="h-40 animate-pulse rounded-2xl bg-orange-100" />
          <div className="mt-5 h-7 w-2/3 animate-pulse rounded-lg bg-orange-100" />
          <div className="mt-3 h-4 w-full animate-pulse rounded bg-orange-50" />
          <p role="status" aria-live="polite" className="mt-5 text-sm font-semibold text-[color:var(--profile-muted)]">
            Loading profile…
          </p>
        </div>
      </div>
    );
  }

  if (!data || readFailure) {
    return (
      <div
        className="mealscout-public-profile flex min-h-screen items-center justify-center px-4"
        data-testid={unavailable ? "public-profile-unavailable" : "public-profile-not-found"}
      >
        <div className="profile-surface w-full max-w-lg rounded-[1.75rem] p-6 text-center sm:p-8">
          <p className="profile-section-label">MealScout</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-[color:var(--profile-ink)]">
            {unavailable ? (accessDenied ? "Profile unavailable" : "Profile temporarily unavailable") : "Profile not found"}
          </h1>
          <p className="mt-2 text-sm text-[color:var(--profile-muted)]">
            {unavailable ? (accessDenied ? "This profile is not available with your current access." : "We could not load this profile. Try again here, or return to Scout.") : "This listing may have moved or is no longer public."}
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            {unavailable && (
              <Button className="profile-action-primary min-h-11" disabled={retrying} onClick={() => { void (cleanBusinessError ? retryCleanBusiness() : retryProfile()); }}>
                {retrying ? "Retrying…" : "Retry profile"}
              </Button>
            )}
            {accessDenied && getProgressiveAccountGate(user) !== "continue" && (
              <Link href={buildProgressiveAccountPath(user ? "verify_email" : "sign_in", "restricted", `${window.location.pathname}${window.location.search}${window.location.hash}`)} className="inline-flex min-h-11 items-center px-4 font-bold">{user ? "Verify email to continue" : "Sign in to continue"}</Link>
            )}
            <Link href={scoutHref}>
              <Button className="profile-action-primary min-h-11">Scout</Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const title = data.seo?.seoTitle || `${data.displayName} on MealScout`;
  const description =
    data.seo?.seoDescription ||
    data.description ||
    "Find local food coverage, public menus, and posted schedule details on MealScout.";
  const canonicalUrl =
    (resolvedCleanBusinessPath && typeof window !== "undefined"
      ? new URL(resolvedCleanBusinessPath, window.location.origin).toString()
      : null) ||
    data.seo?.canonicalUrl ||
    data.canonicalUrl;
  const citySlug =
    String((data as any).citySlug || "").trim() ||
    slugifySeoTerm(data.city) ||
    null;
  const restaurantProfile = isRestaurantLikeEntity(data.entity)
    ? (data as PublicRestaurantProfile)
    : null;
  const showPageClaimPrompts = !isClaimedTruckProfile(restaurantProfile);
  const restaurantHasMenuSurface = Boolean(
    restaurantProfile &&
      (restaurantProfile.profileType === "truck" ||
        hasStructuredPublicMenu(data) ||
        restaurantProfile.menuUrl ||
        restaurantProfile.menuImageUrl ||
        restaurantProfile.menuPdfUrl),
  );
  const restaurantCapabilities = restaurantProfile
    ? getBusinessCapabilities(restaurantProfile.profileType)
    : null;
  const isServiceBusiness = Boolean(
    restaurantProfile &&
      (restaurantProfile.profileType === "caterer" ||
        restaurantProfile.profileType === "private_chef"),
  );
  const ogImage =
    data.seo?.ogImageUrl ||
    (data.entity === "host"
      ? data.spotImageUrl ||
        data.coverImageUrl ||
        data.logoUrl ||
        (data as any).profileImageUrl ||
        (data as any).truckPhotoLogo
      : isRestaurantLikeEntity(data.entity)
        ? (data as any).coverImageUrl ||
          (data as any).logoUrl ||
          (data as any).profileImageUrl ||
          (data as any).truckPhotoLogo
        : data.logoUrl || (data as any).profileImageUrl) ||
    DEFAULT_IMAGE;

  return (
    <div className="mealscout-public-profile" data-public-profile-shell="warm-food-led">
      <SEOHead
        title={title}
        description={description}
        canonicalUrl={canonicalUrl}
        ogType="profile"
        ogImage={ogImage}
      />

      <header className="sticky top-0 z-40 border-b border-[color:var(--profile-border)] bg-[#fffaf4]/92 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-3">
          <Link
            href="/"
            className="text-base font-black tracking-tight text-[color:var(--profile-ink)]"
          >
            MealScout
          </Link>
          <div className="flex items-center gap-2 text-xs sm:text-sm">
            <Link
              href={scoutHref}
              className="profile-action-primary inline-flex min-h-11 items-center rounded-full px-4 font-black"
            >
              {scoutLabel}
            </Link>
            {showPageClaimPrompts ? (
              <Link
                href="/claim-business"
                className="hidden font-bold text-[color:var(--profile-ink-soft)] hover:text-[color:var(--profile-accent)] sm:inline"
              >
                Claim or update
              </Link>
            ) : null}
          </div>
        </div>
      </header>

      <ProfileErrorBoundary
        key={`${user?.id ?? "guest"}:${data.profileType}:${data.id}`}
        onPageError={() =>
          trackQualitySignal(
            "public_profile_page_error",
            undefined,
            "render-error",
          )
        }
      >
        <main
          className="mx-auto max-w-5xl space-y-6 px-4 pb-28 pt-5 sm:pb-32 sm:pt-7 md:pb-10"
          onClickCapture={(event) => {
            const target = event.target as HTMLElement | null;
            const anchor = target?.closest(
              "a[data-analytics-action]",
            ) as HTMLAnchorElement | null;
            if (!anchor) return;
            const action = String(anchor.dataset.analyticsAction || "").trim();
            if (!action) return;
            trackProfileEvent(
              action,
              String(anchor.dataset.analyticsTargetType || "").trim() || null,
              anchor.getAttribute("href"),
            );
          }}
        >
          {/* Restaurant, bar, and food-truck profiles share one decision flow.
              Entity differences stay in the hero and visit-information panel. */}
          {restaurantProfile ? (
            <>
              {restaurantProfile.profileType === "truck" ? (
                <ElevatedTruckHero
                  profile={restaurantProfile as any}
                  isAuthenticated={isAuthenticated}
                  isFavorited={isCurrentProfileFavorited}
                />
              ) : (
                <ElevatedProfileHero
                  profile={restaurantProfile as any}
                  isAuthenticated={isAuthenticated}
                  isFavorited={isCurrentProfileFavorited}
                />
              )}

              {isThinProfile(restaurantProfile) ? (
                <ThinProfileState
                  profile={restaurantProfile}
                  safeCtas={safeCtas}
                  initials={restaurantProfile.displayName
                    .split(" ")
                    .map((p: string) => p[0] || "")
                    .join("")
                    .slice(0, 2)
                    .toUpperCase()}
                  isAuthenticated={isAuthenticated}
                />
              ) : null}
                <>
                  <PublicProfileDecisionBar
                    profile={restaurantProfile}
                    safeCtas={safeCtas}
                  />

                  {restaurantHasMenuSurface ? (
                    <div
                      className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(18rem,0.85fr)] lg:items-start"
                      data-public-profile-details-grid="menu-and-visit"
                    >
                      <div
                        className={`min-w-0 ${
                          restaurantProfile.profileType === "truck"
                            ? "order-2 lg:order-1"
                            : "order-1"
                        }`}
                      >
                        <PublicProfileMenu
                          profile={restaurantProfile}
                          safeCtas={safeCtas}
                        />
                      </div>

                      <aside
                        className={`min-w-0 space-y-6 lg:sticky lg:top-24 ${
                          restaurantProfile.profileType === "truck"
                            ? "order-1 lg:order-2"
                            : "order-2"
                        }`}
                      >
                        {restaurantProfile.profileType === "truck" ? (
                          <TruckSchedulePanel profile={restaurantProfile} />
                        ) : isServiceBusiness ? null : (
                          <RestaurantHoursPanel profile={restaurantProfile} />
                        )}
                        <PlanYourVisitPanel profile={restaurantProfile} />
                      </aside>
                    </div>
                  ) : (
                    <div
                      className="grid gap-6 md:grid-cols-2"
                      data-public-profile-details-grid="visit-only"
                    >
                      {isServiceBusiness ? null : (
                        <RestaurantHoursPanel profile={restaurantProfile} />
                      )}
                      <PlanYourVisitPanel profile={restaurantProfile} />
                    </div>
                  )}

                  <DealsSection profile={restaurantProfile} />
                  <EventsSection profile={restaurantProfile} />
                  <GalleryStrip profile={restaurantProfile} />
                  <AboutFoodStyle profile={restaurantProfile} />
                  <FeaturedBartendersSection profile={restaurantProfile} />
                  <ProofSection profile={restaurantProfile} />
                  <RestaurantSocial
                    profile={restaurantProfile}
                    safeCtas={safeCtas}
                  />
                  {isServiceBusiness && restaurantCapabilities?.booking ? (
                    <section
                      className="profile-surface rounded-2xl p-5"
                      aria-label="Service availability"
                    >
                      <p className="profile-section-label">Service availability</p>
                      <p className="mt-2 text-sm text-[color:var(--profile-muted)]">
                        Contact {restaurantProfile.displayName} to confirm your date,
                        service area, and event details.
                      </p>
                    </section>
                  ) : null}
                </>
            </>
          ) : data.entity === "host" ? (
            /* ── LOCATION / HOST PROFILE LAYOUT ── */
            <>
              <HeroBlock profile={data} />
              {/* Quick actions — desktop in-flow; mobile relies on the sticky MobileActionDock below to avoid duplicate CTAs */}
              <div className="hidden md:block">
                <QuickActionRow profile={data} safeCtas={safeCtas} />
              </div>
              <LocationNowSection profile={data} />
              <LocationTruckOptionsSection profile={data} />
              <EventsSection profile={data} />
              <LocationMapSection profile={data} />
              <LocationAmenitiesSection profile={data} />
            </>
          ) : (
            /* ── SUPPLIER PROFILE LAYOUT ── */
            <>
              <HeroBlock profile={data} />
              <Card className="border-white/10 bg-[#0f0d0b]">
                <CardHeader>
                  <CardTitle className="text-xl text-white">
                    Supplier profile
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-white/80">
                  {data.description ? <p>{data.description}</p> : null}
                  {typeof (data as any).metrics?.activeProductCount ===
                  "number" ? (
                    <p>
                      Active products:{" "}
                      {(data as any).metrics.activeProductCount}
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            </>
          )}

          {/* Share controls */}
          <PublicProfileShareControls
            profile={data}
            sharePath={resolvedCleanBusinessPath}
            title={title}
            description={description}
            onShareAction={trackProfileEvent}
          />

          {/* Personalized related discovery rail */}
          {restaurantProfile ? (
            <RelatedScoutRail
              profile={restaurantProfile}
              citySlug={citySlug}
              userFavoriteIds={userFavoriteIds}
              onCrossPromotionClick={(href) =>
                trackProfileEvent(
                  "cross_promotion_click",
                  "related_profile",
                  href,
                )
              }
            />
          ) : (
            <PublicProfileRelatedDiscoveryLinks
              data={data}
              citySlug={citySlug}
            />
          )}

          {/* Mobile sticky action dock — always accessible */}
          <MobileActionDock
            safeCtas={safeCtas}
            profileId={data?.id}
            profileType={data?.profileType}
            onAction={(actionType, href) =>
              trackProfileEvent(actionType, "dock", href)
            }
          />
        </main>
      </ProfileErrorBoundary>

      <footer className="mt-8 border-t border-[color:var(--profile-border)] bg-white/70 pb-28 sm:pb-32 md:pb-0">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-2 px-4 py-5 text-sm text-[color:var(--profile-muted)] sm:flex-row sm:items-center sm:justify-between">
          <p className="font-black text-[color:var(--profile-ink)]">MealScout</p>
          <div className="flex items-center gap-4">
            <Link href={scoutHref} className="font-bold hover:text-[color:var(--profile-accent)]">
              {scoutLabel}
            </Link>
            {showPageClaimPrompts ? (
              <Link href="/claim-business" className="hover:text-[color:var(--profile-accent)]">
                Business owner?
              </Link>
            ) : null}
          </div>
        </div>
      </footer>
    </div>
  );
}
