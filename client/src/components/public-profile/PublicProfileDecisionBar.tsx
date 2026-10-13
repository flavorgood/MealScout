import { ProgressiveContactLink } from "@/components/progressive-contact-link";
import type {
  PublicCta,
  PublicMenuItem,
  PublicMenuSection,
  PublicRestaurantProfile,
} from "@shared/publicProfiles";
import { normalizeBusinessTypeLabel } from "@/lib/publicMenuCompleteness";
import { getTruckSchedulePrimaryStop } from "./truckScheduleTruth";
import { Clock3, ExternalLink, MapPin, MenuSquare, Route, Truck, Utensils } from "lucide-react";

type DecisionAction = {
  label: string;
  href: string;
  type: PublicCta["type"];
};

const hasText = (value: unknown) => String(value || "").trim().length > 0;

const clean = (value: unknown) => String(value || "").trim();

const uniqueMenuItems = (sections: PublicMenuSection[] | null | undefined) => {
  const seen = new Set<string>();
  const items: PublicMenuItem[] = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    for (const item of Array.isArray(section?.items) ? section.items : []) {
      const name = clean(item?.name);
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return items;
};

const getProfileMenuSections = (profile: PublicRestaurantProfile) => {
  const activeVariant =
    Array.isArray(profile.menuVariants) && profile.menuVariants.length > 0
      ? profile.menuVariants.find((variant) => String(variant.id) === String(profile.activeMenuId || "")) ||
        profile.menuVariants[0]
      : null;
  return activeVariant?.menuSections?.length ? activeVariant.menuSections : profile.menuSections;
};

const pickMenuAnswer = (profile: PublicRestaurantProfile) => {
  const featuredNames = new Set(
    (profile.featuredMenuItems || []).map((name) => clean(name).toLowerCase()).filter(Boolean),
  );
  const items = uniqueMenuItems(getProfileMenuSections(profile));
  const ranked = items
    .map((item) => ({
      item,
      score:
        (item.featured ? 50 : 0) +
        (featuredNames.has(clean(item.name).toLowerCase()) ? 40 : 0) +
        (item.imageUrl ? 15 : 0) +
        (item.priceLabel ? 10 : 0) +
        (item.description ? 5 : 0),
    }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.item || null;
};

const pickDecisionAction = (
  profile: PublicRestaurantProfile,
  safeCtas: PublicCta[],
): DecisionAction | null => {
  const wanted: PublicCta["type"][] =
    profile.profileType === "truck"
      ? ["map", "menu", "order", "phone", "external"]
      : ["order", "menu", "map", "phone", "external", "booking"];

  for (const type of wanted) {
    const cta = safeCtas.find((candidate) => candidate.type === type && hasText(candidate.href));
    if (cta) return { label: cta.label, href: cta.href, type: cta.type };
  }
  return null;
};

const locationAnswer = (profile: PublicRestaurantProfile) => {
  if (profile.profileType === "truck") {
    const primary = getTruckSchedulePrimaryStop(profile.truckSchedule);
    if (primary.stop) {
      const place = clean(primary.stop.locationName || primary.stop.addressPublicLabel);
      const time = clean(primary.stop.timeWindowLabel);
      if (place || time) {
        return {
          label: primary.label,
          value: place || time,
          detail: place && time ? time : clean(primary.stop.addressPublicLabel),
        };
      }
    }
  }

  const address = clean(profile.addressPublicLabel);
  const cityState = [profile.city, profile.state].map(clean).filter(Boolean).join(", ");
  return {
    label: profile.profileType === "truck" ? "Base area" : "Location",
    value: address || cityState || "Location not posted yet",
    detail: address && cityState ? cityState : null,
  };
};

const availabilityAnswer = (profile: PublicRestaurantProfile) => {
  if (profile.profileType === "truck") {
    const primary = getTruckSchedulePrimaryStop(profile.truckSchedule);
    if (primary.kind === "current") return { label: "Live now", value: "Here right now" };
    if (primary.kind === "today") return { label: "Serving today", value: "Scheduled today" };
    if (primary.kind === "next" || primary.kind === "upcoming") {
      return { label: "Scheduled", value: primary.label };
    }
    // No actionable schedule — say so instead of silently dropping the
    // tile, same honest-label pattern used for menu/location above.
    return { label: "Schedule", value: "Schedule not posted yet" };
  }

  const openStatus = clean(profile.openStatus);
  if (!openStatus && !clean(profile.operatingHoursSummary)) {
    return { label: "Hours", value: "Hours not posted yet" };
  }
  return {
    label: "Open status",
    value: openStatus,
    detail: clean(profile.operatingHoursSummary) || null,
  };
};

export function PublicProfileDecisionBar({
  profile,
  safeCtas,
}: {
  profile: PublicRestaurantProfile;
  safeCtas: PublicCta[];
}) {
  const menuItem = pickMenuAnswer(profile);
  const action = pickDecisionAction(profile, safeCtas);
  const availability = availabilityAnswer(profile);
  const location = locationAnswer(profile);
  const typeLabel =
    profile.profileType === "truck"
      ? "Food truck"
      : normalizeBusinessTypeLabel(profile.profileType);
  const orderValue = menuItem
    ? clean(menuItem.name)
    : profile.menuUrl || profile.menuImageUrl || profile.menuPdfUrl
      ? "Menu link available"
      : "Menu not posted yet";
  const orderDetail = menuItem?.priceLabel || menuItem?.description || null;
  const ActionIcon = action?.type === "map" ? Route : action?.type === "menu" ? MenuSquare : ExternalLink;
  const tiles = [
    {
      icon: profile.profileType === "truck" ? Truck : Utensils,
      label: "Type",
      value: typeLabel,
    },
    availability
      ? {
          icon: Clock3,
          label: availability.label,
          value: availability.value,
          detail: availability.detail,
        }
      : null,
    {
      icon: MapPin,
      label: location.label,
      value: location.value,
      detail: location.detail,
    },
    {
      icon: MenuSquare,
      label: "What to order",
      value: orderValue,
      detail: orderDetail,
    },
  ].filter(Boolean);

  return (
    <section
      aria-label="Profile decision summary"
      className="profile-surface rounded-[1.5rem] p-4 sm:p-5"
      data-public-profile-decision-bar="true"
      data-profile-kind={profile.profileType}
    >
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="profile-section-label">At a glance</p>
        </div>
        {action ? (
          <ProgressiveContactLink
            href={action.href}
            target={action.type === "external" || action.type === "map" ? "_blank" : undefined}
            rel={action.type === "external" || action.type === "map" ? "noopener noreferrer" : undefined}
            data-analytics-action="decision_bar_cta"
            data-analytics-target-type={action.type}
            className="profile-action-primary hidden min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-bold md:inline-flex md:min-w-36"
          >
            <ActionIcon className="h-4 w-4" />
            <span className="truncate">{action.label}</span>
          </ProgressiveContactLink>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <DecisionTile
            key={`${tile!.label}:${tile!.value}`}
            icon={tile!.icon}
            label={tile!.label}
            value={tile!.value}
            detail={tile!.detail}
          />
        ))}
      </div>
    </section>
  );
}

function DecisionTile({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof MapPin;
  label: string;
  value: string;
  detail?: string | null;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-[color:var(--profile-border)] bg-[color:var(--profile-surface-soft)] p-3">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 flex-none text-[color:var(--profile-accent)]" />
        <p className="truncate text-[10px] font-bold uppercase tracking-[0.18em] text-[color:var(--profile-muted)]">
          {label}
        </p>
      </div>
      <p className="mt-2 line-clamp-2 text-sm font-bold leading-snug text-[color:var(--profile-ink)]">
        {value}
      </p>
      {detail ? (
        <p className="mt-1 line-clamp-2 text-xs leading-snug text-[color:var(--profile-muted)]">{detail}</p>
      ) : null}
    </div>
  );
}
