import { ProgressiveContactLink } from "@/components/progressive-contact-link";
/**
 * PlanYourVisitPanel
 *
 * Aggregates everything a visitor needs to actually show up:
 * - Address / location
 * - Directions link
 * - Phone number
 * - Website
 * - Social links (Instagram, Facebook, X)
 *
 * Renders nothing if there is no actionable contact or location data.
 * Does not render for trucks (they use TruckSchedulePanel for location context).
 */
import type { PublicRestaurantProfile } from "@shared/publicProfiles";
import { MapPin, Phone, Globe, ExternalLink } from "lucide-react";

type PlanYourVisitPanelProps = {
  profile: PublicRestaurantProfile;
};

export function PlanYourVisitPanel({ profile }: PlanYourVisitPanelProps) {
  const isServiceBusiness =
    profile.profileType === "caterer" || profile.profileType === "private_chef";
  const address = String(profile.addressPublicLabel || "").trim();
  const phone = String(profile.phonePublic || "").trim();
  const website = String(profile.websiteUrl || "").trim();
  const instagram = String(profile.socialLinks?.instagramUrl || "").trim();
  const facebook = String(profile.socialLinks?.facebookPageUrl || "").trim();
  const xUrl = String(profile.socialLinks?.xUrl || "").trim();

  const directionsHref =
    profile.cta.find((action) => action.type === "map")?.href || null;

  const hasAnyData = Boolean(address || phone || website || directionsHref);
  if (!hasAnyData) return null;

  const rows: Array<{
    icon: typeof MapPin;
    label: string;
    href: string | null;
    external?: boolean;
  }> = [];

  if (address) {
    rows.push({
      icon: MapPin,
      label: address,
      href: directionsHref,
      external: true,
    });
  }

  if (phone) {
    rows.push({
      icon: Phone,
      label: phone,
      href: `tel:${phone.replace(/\D/g, "")}`,
    });
  }

  if (website) {
    let displayUrl = website;
    try {
      displayUrl = new URL(website).hostname.replace(/^www\./, "");
    } catch {
      /* keep raw */
    }
    rows.push({
      icon: Globe,
      label: displayUrl,
      href: website,
      external: true,
    });
  }

  const socialLinks = [
    { label: "Instagram", href: instagram },
    { label: "Facebook", href: facebook },
    { label: "X / Twitter", href: xUrl },
  ].filter((s) => s.href);

  return (
    <section aria-label="Plan your visit" className="space-y-3">
      <p className="profile-section-label">
        {isServiceBusiness ? "Contact and service area" : "Plan your visit"}
      </p>

      <div className="profile-surface divide-y divide-[color:var(--profile-border)] overflow-hidden rounded-2xl">
        {rows.map((row, i) => {
          const Icon = row.icon;
          const inner = (
            <div className="flex items-start gap-3 px-4 py-3">
              <Icon className="mt-0.5 h-4 w-4 flex-none text-[color:var(--profile-accent)]" />
              <p className="min-w-0 break-words text-sm leading-snug text-[color:var(--profile-ink-soft)]">
                {row.label}
              </p>
              {row.href && row.external ? (
                <ExternalLink className="ml-auto mt-0.5 h-3.5 w-3.5 flex-none text-[color:var(--profile-muted)]" />
              ) : null}
            </div>
          );

          return row.href ? (
            <ProgressiveContactLink
              key={i}
              href={row.href}
              target={row.external ? "_blank" : undefined}
              rel={row.external ? "noopener noreferrer" : undefined}
              data-analytics-action={row.icon === MapPin ? "directions_click" : "contact_click"}
              data-analytics-target-type={row.icon === MapPin ? "map" : "contact"}
              className="block transition-colors hover:bg-orange-50"
            >
              {inner}
            </ProgressiveContactLink>
          ) : (
            <div key={i}>{inner}</div>
          );
        })}

        {socialLinks.length > 0 ? (
          <div className="flex flex-wrap gap-2 px-4 py-3">
            {socialLinks.map((s) => (
              <ProgressiveContactLink
                key={s.href}
                href={s.href}
                target="_blank"
                rel="noopener noreferrer"
                data-analytics-action="social_click"
                data-analytics-target-type="social"
                className="rounded-full border border-[color:var(--profile-border)] bg-white px-3 py-1 text-xs font-semibold text-[color:var(--profile-ink-soft)] hover:border-orange-200 hover:bg-orange-50 hover:text-orange-800"
              >
                {s.label}
              </ProgressiveContactLink>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
