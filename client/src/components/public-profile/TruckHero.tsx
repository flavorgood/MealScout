import { ProgressiveContactLink } from "@/components/progressive-contact-link";
import type {
  PublicCta,
  PublicRestaurantProfile,
  PublicTruckScheduleStop,
} from "@shared/publicProfiles";
import {
  assessPublicMenuCompleteness,
  normalizeBusinessTypeLabel,
} from "@/lib/publicMenuCompleteness";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ProfileHeroMedia,
  buildPublicProfileHeroAssets,
} from "@/components/public-profile/ProfileHeroMedia";
import {
  getTruckScheduleAvailabilityLabel,
  getTruckSchedulePrimaryStop,
  hasTruckScheduleCta,
} from "@/components/public-profile/truckScheduleTruth";
import { shouldShowPublicClaimPrompt } from "@/components/public-profile/profileClaimPromptPolicy";
import { CalendarDays, Clock3, MapPin, Route, Truck } from "lucide-react";

type TruckHeroProps = {
  profile: PublicRestaurantProfile;
  safeCtas: PublicCta[];
};

const stopLabel = (stop: PublicTruckScheduleStop | null | undefined) =>
  String(stop?.locationName || stop?.addressPublicLabel || "").trim();

const stopTimeLabel = (stop: PublicTruckScheduleStop | null | undefined) =>
  [stop?.date, stop?.timeWindowLabel].filter(Boolean).join(" · ");

const hasText = (value: unknown) => String(value || "").trim().length > 0;

const uniqueByHref = (ctas: PublicCta[]) => {
  const seen = new Set<string>();
  return ctas.filter((cta) => {
    const href = String(cta.href || "").trim();
    if (!href || seen.has(href)) return false;
    seen.add(href);
    return true;
  });
};

const menuTrustLabel = (profile: PublicRestaurantProfile) => {
  const menuCompleteness = assessPublicMenuCompleteness({
    menuSections: profile.menuSections,
    featuredMenuItems: profile.featuredMenuItems,
    menuUrl: profile.menuUrl,
    menuImageUrl: profile.menuImageUrl,
    menuPdfUrl: profile.menuPdfUrl,
  });
  const pricedItemCount = (
    Array.isArray(profile.menuSections) ? profile.menuSections : []
  ).reduce(
    (count, section) =>
      count +
      (Array.isArray(section?.items)
        ? section.items.filter((item) => hasText(item?.priceLabel)).length
        : 0),
    0,
  );
  const isThinPartialMenu =
    menuCompleteness.state === "partial" &&
    pricedItemCount <= 2 &&
    !(
      Array.isArray(profile.featuredMenuItems) &&
      profile.featuredMenuItems.length > 0
    ) &&
    !hasText(profile.menuUrl) &&
    !hasText(profile.menuImageUrl) &&
    !hasText(profile.menuPdfUrl);
  if (isThinPartialMenu) return "Limited menu info";
  if (menuCompleteness.state === "complete") return "Menu available";
  if (menuCompleteness.state === "partial") return "Menu partial";
  return null;
};

export function TruckHero({ profile, safeCtas }: TruckHeroProps) {
  const schedule = profile.truckSchedule;
  const heroAssets = buildPublicProfileHeroAssets({
    entity: profile.profileType,
    displayName: profile.displayName,
    coverImageUrl: profile.coverImageUrl,
    logoUrl: profile.logoUrl,
    profileImageUrl: (profile as any).profileImageUrl,
    truckPhotoLogo: (profile as any).truckPhotoLogo,
    imageUrl: (profile as any).imageUrl,
  });
  const primaryStop = getTruckSchedulePrimaryStop(schedule);
  const primaryStopName = stopLabel(primaryStop.stop);
  const primaryStopTime = stopTimeLabel(primaryStop.stop);
  const directionsHref = primaryStop.stop?.directionsUrl || null;
  const menuLabel = menuTrustLabel(profile);
  const serviceLabel =
    normalizeBusinessTypeLabel(profile.serviceType || "") || "Food Truck";
  const foodSummary = [...(profile.cuisineTags || []).slice(0, 2), serviceLabel]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" · ");
  const hasSchedule = hasTruckScheduleCta(schedule);
  const scheduleLabel = hasSchedule
    ? getTruckScheduleAvailabilityLabel(schedule)
    : null;
  const actionCtas = uniqueByHref(
    safeCtas.filter(
      (cta) =>
        cta.type === "external" ||
        cta.type === "social" ||
        cta.type === "phone",
    ),
  );
  const primaryLinkCta = actionCtas[0] || null;
  const secondaryLinkCta = actionCtas[1] || null;
  const locationSummary = [profile.city, profile.state]
    .filter(Boolean)
    .join(", ");
  const phoneLabel = String(profile.phonePublic || "").trim();
  const primaryHeroCta = hasSchedule
    ? directionsHref
      ? {
          href: directionsHref,
          label: "Get directions",
          icon: Route,
          analyticsAction: "directions_click",
          analyticsTargetType: "map",
        }
      : {
          href: "#truck-schedule",
          label: "View schedule",
          icon: CalendarDays,
          analyticsAction: undefined,
          analyticsTargetType: undefined,
        }
    : primaryLinkCta
      ? {
          href: primaryLinkCta.href,
          label: primaryLinkCta.label,
          icon: null,
          analyticsAction:
            primaryLinkCta.type === "social"
              ? "social_click"
              : primaryLinkCta.type === "phone"
                ? "call_click"
                : "website_click",
          analyticsTargetType: primaryLinkCta.type || "unknown",
          target: "_blank" as const,
          rel:
            primaryLinkCta.type === "phone"
              ? undefined
              : ("noopener noreferrer" as const),
        }
      : null;
  const secondaryHeroCta =
    hasSchedule && primaryLinkCta
      ? {
          href: primaryLinkCta.href,
          label: primaryLinkCta.label,
          analyticsAction:
            primaryLinkCta.type === "social"
              ? "social_click"
              : primaryLinkCta.type === "phone"
                ? "call_click"
                : "website_click",
          analyticsTargetType: primaryLinkCta.type || "unknown",
        }
      : !hasSchedule && secondaryLinkCta
        ? {
            href: secondaryLinkCta.href,
            label: secondaryLinkCta.label,
            analyticsAction:
              secondaryLinkCta.type === "social"
                ? "social_click"
                : secondaryLinkCta.type === "phone"
                  ? "call_click"
                  : "website_click",
            analyticsTargetType: secondaryLinkCta.type || "unknown",
          }
        : null;

  return (
    <section
      data-testid="truck-profile-hero"
      className="overflow-hidden rounded-2xl border border-orange-300/20 bg-[#0f0d0b] shadow-[0_20px_80px_rgba(0,0,0,0.28)]"
    >
      <div className="grid gap-0 md:grid-cols-[0.92fr_1.08fr]">
        <div className="relative">
          <ProfileHeroMedia
            displayName={profile.displayName}
            coverImageUrl={heroAssets.coverImageUrl}
            logoImageUrl={heroAssets.logoImageUrl}
            theme="truck"
            heightClassName={hasSchedule ? "min-h-[15rem]" : "min-h-[13rem]"}
            badge={
              <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange-100 backdrop-blur">
                <Truck className="h-3.5 w-3.5" />
                Food Truck
              </div>
            }
          />
        </div>

        <div className="space-y-5 p-5 sm:p-6">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {profile.verifiedProfile ? (
                <Badge
                  variant="outline"
                  className="border-white/20 text-white/75"
                >
                  Verified profile
                </Badge>
              ) : null}
              {menuLabel ? (
                <Badge
                  variant="outline"
                  className="border-white/20 text-white/75"
                >
                  {menuLabel}
                </Badge>
              ) : null}
              {scheduleLabel ? (
                <Badge variant="secondary">{scheduleLabel}</Badge>
              ) : null}
              {profile.locallyOwned ? (
                <Badge
                  variant="outline"
                  className="border-emerald-300/35 text-emerald-200/85"
                >
                  Locally owned
                </Badge>
              ) : null}
            </div>
            <div>
              <h1 className="text-3xl font-black tracking-tight text-white sm:text-5xl">
                {profile.displayName}
              </h1>
              {foodSummary ? (
                <p className="mt-2 text-sm font-medium text-orange-100/85">
                  {foodSummary}
                </p>
              ) : null}
              {profile.description ? (
                <p className="mt-3 max-w-2xl text-sm leading-6 text-white/72">
                  {profile.description}
                </p>
              ) : null}
            </div>
          </div>

          {hasSchedule ? (
            <div
              data-testid="truck-profile-next-stop"
              className="rounded-2xl border border-orange-300/25 bg-orange-500/10 p-4"
            >
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-orange-100/80">
                {primaryStop.label}
              </p>
              <p className="mt-2 text-xl font-bold text-white">
                {primaryStopName || primaryStop.label}
              </p>
              {primaryStopTime ? (
                <p className="mt-1 flex items-center gap-2 text-sm text-white/78">
                  <Clock3 className="h-4 w-4 text-orange-200" />
                  {primaryStopTime}
                </p>
              ) : null}
              {primaryStop.stop?.addressPublicLabel ? (
                <p className="mt-1 flex items-start gap-2 text-sm text-white/68">
                  <MapPin className="mt-0.5 h-4 w-4 flex-none text-orange-200" />
                  <span>{primaryStop.stop.addressPublicLabel}</span>
                </p>
              ) : null}
            </div>
          ) : (
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                {locationSummary ? (
                  <div className="rounded-xl border border-white/8 bg-white/5 px-3 py-2.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-white/55">
                      Based in
                    </p>
                    <p className="mt-1 text-sm font-semibold text-white">
                      {locationSummary}
                    </p>
                  </div>
                ) : null}
                {phoneLabel ? (
                  <div className="rounded-xl border border-white/8 bg-white/5 px-3 py-2.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-white/55">
                      Call
                    </p>
                    <p className="mt-1 text-sm font-semibold text-white">
                      {phoneLabel}
                    </p>
                  </div>
                ) : null}
                {!phoneLabel && foodSummary ? (
                  <div className="rounded-xl border border-white/8 bg-white/5 px-3 py-2.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-white/55">
                      Food style
                    </p>
                    <p className="mt-1 text-sm font-semibold text-white">
                      {foodSummary}
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            {primaryHeroCta ? (
              <Button
                asChild
                className="bg-orange-500 font-bold text-black hover:bg-orange-400"
              >
                <ProgressiveContactLink
                  href={primaryHeroCta.href}
                  data-analytics-action={primaryHeroCta.analyticsAction}
                  data-analytics-target-type={
                    primaryHeroCta.analyticsTargetType
                  }
                  target={primaryHeroCta.target}
                  rel={primaryHeroCta.rel}
                >
                  {primaryHeroCta.icon ? (
                    <primaryHeroCta.icon className="mr-2 h-4 w-4" />
                  ) : null}
                  {primaryHeroCta.label}
                </ProgressiveContactLink>
              </Button>
            ) : null}
            {secondaryHeroCta ? (
              <Button
                asChild
                variant="outline"
                className="border-white/20 text-white hover:bg-white/10"
              >
                <ProgressiveContactLink
                  href={secondaryHeroCta.href}
                  data-analytics-action={secondaryHeroCta.analyticsAction}
                  data-analytics-target-type={
                    secondaryHeroCta.analyticsTargetType
                  }
                  target={
                    secondaryHeroCta.href.startsWith("tel:")
                      ? undefined
                      : "_blank"
                  }
                  rel={
                    secondaryHeroCta.href.startsWith("tel:")
                      ? undefined
                      : "noopener noreferrer"
                  }
                >
                  {secondaryHeroCta.label}
                </ProgressiveContactLink>
              </Button>
            ) : null}
          </div>

          {shouldShowPublicClaimPrompt(profile) ? (
            <div className="rounded-xl border border-white/10 bg-black/15 px-3.5 py-3 text-sm text-white/68">
              <p className="font-semibold text-white/88">
                Own this truck? Add menu, schedule, logo, or hours.
              </p>
              <ProgressiveContactLink
                href="/claim-business"
                className="mt-1 inline-flex font-semibold text-orange-200 hover:text-orange-100"
              >
                Claim or update this profile
              </ProgressiveContactLink>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
