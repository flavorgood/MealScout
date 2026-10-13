import { ProgressiveContactLink } from "@/components/progressive-contact-link";
/**
 * MobileActionDock
 *
 * A sticky bottom dock on mobile that keeps the most important actions
 * (Directions, Order, Call, Menu) always reachable without scrolling.
 * Renders nothing on larger screens — desktop has the QuickActionRow in-flow.
 *
 * Respects the existing PublicCta safe-flag contract: only renders CTAs
 * where cta.safe === true.
 */
import type { PublicCta } from "@shared/publicProfiles";
import { ExternalLink, MapPin, Phone, MenuSquare, ShoppingBag, CalendarDays } from "lucide-react";
import { rankPublicCtas } from "./profileActionPolicy";

type DockAction = {
  cta: PublicCta;
  icon: typeof MapPin;
  label: string;
};

const CTA_TYPE_ICON: Record<string, typeof MapPin> = {
  map: MapPin,
  phone: Phone,
  menu: MenuSquare,
  order: ShoppingBag,
  booking: CalendarDays,
  catering: CalendarDays,
  external: ExternalLink,
};

function shortLabel(cta: PublicCta): string {
  const raw = String(cta.label || "").trim();
  // Shorten common labels for the dock
  if (/directions/i.test(raw)) return "Directions";
  if (/order/i.test(raw)) return "Order";
  if (/menu/i.test(raw)) return "Menu";
  if (/call/i.test(raw)) return "Call";
  if (/book/i.test(raw)) return "Book";
  if (/catering/i.test(raw)) return "Catering";
  if (/website/i.test(raw)) return "Website";
  if (raw.length > 12) return raw.slice(0, 12).trim() + "…";
  return raw;
}

function isSelfProfileAction(cta: PublicCta, profileId?: string | null): boolean {
  if (cta.type !== "internal") return false;
  const href = String(cta.href || "");
  const label = String(cta.label || "").trim().toLowerCase();
  if (profileId && href.includes(String(profileId))) return true;
  return label === "profile" || label === "details" || /\/(truck|restaurant|bar|cafe)\//.test(href);
}

export function MobileActionDock({
  safeCtas,
  profileId,
  profileType,
  onAction,
}: {
  safeCtas: PublicCta[];
  profileId?: string | null;
  profileType?: string | null;
  onAction?: (actionType: string, href: string) => void;
}) {
  if (safeCtas.length === 0) return null;

  // Deduplicate by href, sort by priority, take top 4
  const seen = new Set<string>();
  const actions: DockAction[] = rankPublicCtas(safeCtas, profileType)
    .filter((cta) => cta.type !== "share" && cta.type !== "social" && !isSelfProfileAction(cta, profileId))
    .reduce<DockAction[]>((acc, cta) => {
      if (seen.has(cta.href)) return acc;
      seen.add(cta.href);
      acc.push({
        cta,
        icon: CTA_TYPE_ICON[cta.type] ?? ExternalLink,
        label: shortLabel(cta),
      });
      return acc;
    }, [])
    .slice(0, 4);

  if (actions.length === 0) return null;

  const primary = actions[0];
  const rest = actions.slice(1);
  const gridClass =
    rest.length >= 3
      ? "grid-cols-4"
      : rest.length === 2
        ? "grid-cols-3"
        : rest.length === 1
          ? "grid-cols-2"
          : "grid-cols-1";

  return (
    // Only visible on mobile (< md). Uses safe-area-inset for notched phones.
    <div
      className="fixed bottom-0 inset-x-0 z-50 md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      aria-label="Quick actions"
      data-mobile-action-dock="true"
    >
      <div className="border-t border-[color:var(--profile-border)] bg-white/95 px-3 py-2.5 shadow-[0_-12px_34px_rgba(96,46,20,0.12)] backdrop-blur-md">
        <div className={`grid gap-2 ${gridClass}`}>
          {/* Primary action — full orange */}
          <ProgressiveContactLink
            href={primary.cta.href}
            target={primary.cta.type === "external" || primary.cta.type === "map" ? "_blank" : undefined}
            rel={primary.cta.type === "external" || primary.cta.type === "map" ? "noopener noreferrer" : undefined}
            onClick={() => onAction?.(primary.cta.type, primary.cta.href)}
            className="profile-action-primary flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-bold active:opacity-90"
          >
            <primary.icon className="h-4 w-4 flex-none" />
            <span className="truncate">{primary.label}</span>
          </ProgressiveContactLink>

          {/* Secondary actions — outlined */}
          {rest.map((action, i) => (
            <ProgressiveContactLink
              key={`${action.cta.href}-${i}`}
              href={action.cta.href}
              target={action.cta.type === "external" || action.cta.type === "map" ? "_blank" : undefined}
              rel={action.cta.type === "external" || action.cta.type === "map" ? "noopener noreferrer" : undefined}
              onClick={() => onAction?.(action.cta.type, action.cta.href)}
              className="profile-action-secondary flex flex-col items-center justify-center gap-0.5 rounded-xl px-2 py-2 active:bg-orange-50"
            >
              <action.icon className="h-4 w-4 flex-none" />
              <span className="text-[10px] font-semibold leading-none truncate max-w-full">
                {action.label}
              </span>
            </ProgressiveContactLink>
          ))}
        </div>
      </div>
    </div>
  );
}
