import type { ReactNode } from "react";
import { Link } from "wouter";
import {
  BarChart3,
  Clock3,
  CreditCard,
  Eye,
  Image,
  LayoutDashboard,
  MapPin,
  MoreHorizontal,
  Radio,
  Settings,
  ShoppingBag,
  Store,
  Tag,
  Users,
  UtensilsCrossed,
  type LucideIcon,
} from "lucide-react";
import { toCanonicalFoodBusinessType } from "@shared/businessTypes";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type BusinessWorkspaceModuleId =
  | "overview"
  | "ai"
  | "profile"
  | "menu"
  | "availability"
  | "media"
  | "deals"
  | "promotions"
  | "work"
  | "delivery"
  | "audience"
  | "team"
  | "payments"
  | "settings";

export type BusinessWorkspaceIdentity = {
  id: string;
  name: string;
  businessType?: string | null;
  isFoodTruck?: boolean | null;
  city?: string | null;
  state?: string | null;
  logoUrl?: string | null;
  coverImageUrl?: string | null;
};

type WorkspaceCapabilities = {
  overview?: boolean;
  profile?: boolean;
  menu?: boolean;
  availability?: boolean;
  media?: boolean;
  deals?: boolean;
  promotions?: boolean;
  work?: boolean;
  delivery?: boolean;
  audience?: boolean;
  team?: boolean;
  payments?: boolean;
  settings?: boolean;
};

type BusinessWorkspaceShellProps = {
  activeModule: BusinessWorkspaceModuleId;
  business: BusinessWorkspaceIdentity;
  businesses?: BusinessWorkspaceIdentity[];
  onBusinessChange?: (businessId: string) => void;
  publicProfileHref?: string | null;
  capabilities?: WorkspaceCapabilities;
  headerActions?: ReactNode;
  children: ReactNode;
};

type WorkspaceModule = {
  id: BusinessWorkspaceModuleId;
  label: string;
  description: string;
  href: string;
  icon: LucideIcon;
  visible: boolean;
};

const BUSINESS_TYPE_LABELS: Record<string, string> = {
  restaurant: "Restaurant",
  bar: "Bar",
  food_truck: "Food truck",
  caterer: "Caterer",
  private_chef: "Private chef",
};

function buildWorkspaceHref(
  pathname: string,
  businessId: string,
  values?: Record<string, string>,
) {
  const params = new URLSearchParams();
  if (businessId) params.set("restaurantId", businessId);
  Object.entries(values || {}).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}`;
}

export default function BusinessWorkspaceShell({
  activeModule,
  business,
  businesses = [],
  onBusinessChange,
  publicProfileHref,
  capabilities = {},
  headerActions,
  children,
}: BusinessWorkspaceShellProps) {
  const canonicalType =
    toCanonicalFoodBusinessType(business.businessType) ||
    (business.isFoodTruck ? "food_truck" : "restaurant");
  const isFoodTruck = canonicalType === "food_truck";
  const availabilityLabel = isFoodTruck
    ? "Schedule & live"
    : canonicalType === "caterer" || canonicalType === "private_chef"
      ? "Availability"
      : "Hours";
  const availabilityDescription = isFoodTruck
    ? "Manage stops and live location"
    : canonicalType === "caterer" || canonicalType === "private_chef"
      ? "Set when customers can book"
      : "Keep opening hours current";
  const locationLabel = [business.city, business.state]
    .filter(Boolean)
    .join(", ");
  const identityImage = business.logoUrl || business.coverImageUrl || null;
  const typeLabel = BUSINESS_TYPE_LABELS[canonicalType] || "Food business";

  const allModules: WorkspaceModule[] = [
    {
      id: "overview",
      label: "Overview",
      description: "What needs attention now",
      href: buildWorkspaceHref("/restaurant-owner-dashboard", business.id),
      icon: LayoutDashboard,
      visible: capabilities.overview !== false,
    },
    {
      id: "profile",
      label: "Public profile",
      description: "Identity, details, and links",
      href: buildWorkspaceHref("/restaurant-owner-dashboard", business.id, {
        setup: "profile",
      }),
      icon: Store,
      visible: capabilities.profile !== false,
    },
    {
      id: "menu",
      label: "Menu",
      description: "Menus, items, and availability",
      href: buildWorkspaceHref("/menu-builder", business.id),
      icon: UtensilsCrossed,
      visible: capabilities.menu !== false,
    },
    {
      id: "availability",
      label: availabilityLabel,
      description: availabilityDescription,
      href: buildWorkspaceHref("/restaurant-owner-dashboard", business.id, {
        setup: "schedule",
        ...(isFoodTruck ? { truck: "1" } : {}),
      }),
      icon: isFoodTruck ? Radio : Clock3,
      visible: capabilities.availability !== false,
    },
    {
      id: "media",
      label: "Photos",
      description: "Logo, cover, food, and venue",
      href: buildWorkspaceHref("/restaurant-owner-dashboard", business.id, {
        setup: "profile-media",
      }),
      icon: Image,
      visible: capabilities.media !== false,
    },
    {
      id: "deals",
      label: "Deals",
      description: "Run and review promotions",
      href: buildWorkspaceHref("/restaurant-owner-dashboard", business.id, {
        workspace: "deals",
      }),
      icon: Tag,
      visible: capabilities.deals !== false,
    },
    {
      id: "promotions",
      label: "Cross-promotion",
      description: "Approvals, attribution, and results",
      href: buildWorkspaceHref("/merchant-promotions", business.id),
      icon: BarChart3,
      visible: capabilities.promotions !== false,
    },
    {
      id: "work",
      label: "Orders",
      description: "Orders that need attention",
      href: buildWorkspaceHref("/orders", business.id),
      icon: ShoppingBag,
      visible: capabilities.work !== false,
    },
    {
      id: "delivery",
      label: "Delivery",
      description: "Zones, fees, minimums, and capacity",
      href: buildWorkspaceHref("/merchant-delivery", business.id),
      icon: ShoppingBag,
      // Native checkout is deliberately pickup-only for the verified pilot.
      // Keep the unfinished delivery controls out of the owner workspace.
      visible: false,
    },
    {
      id: "audience",
      label: "Audience",
      description: "Reach and profile activity",
      href: buildWorkspaceHref("/restaurant-owner-dashboard", business.id, {
        workspace: "audience",
      }),
      icon: BarChart3,
      visible: capabilities.audience !== false,
    },
    {
      id: "team",
      label: "Team",
      description: "People and permissions",
      href: buildWorkspaceHref("/business-team", business.id),
      icon: Users,
      visible: capabilities.team !== false,
    },
    {
      id: "payments",
      label: "Profile access",
      description: "Free trial status and included tools",
      href: buildWorkspaceHref("/subscribe", business.id),
      icon: CreditCard,
      visible: capabilities.payments !== false,
    },
    {
      id: "settings",
      label: "Settings",
      description: "Account, AI access, visibility, and help",
      href: buildWorkspaceHref("/settings", business.id),
      icon: Settings,
      visible: capabilities.settings !== false,
    },
  ];
  const modules = allModules.filter((module) => module.visible);
  const mobilePrimaryModuleIds = new Set<BusinessWorkspaceModuleId>([
    "overview",
    "profile",
    "menu",
    "availability",
  ]);
  const mobilePrimaryModules = modules.filter((module) =>
    mobilePrimaryModuleIds.has(module.id),
  );
  const mobileSecondaryModules = modules.filter(
    (module) => !mobilePrimaryModuleIds.has(module.id),
  );
  const isMobileSecondaryActive = mobileSecondaryModules.some(
    (module) => module.id === activeModule,
  );

  const active = activeModule === "ai"
    ? { label: "AI control", description: "Draft every update, then approve once" }
    : modules.find((module) => module.id === activeModule) || modules[0];

  const identityControl = (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-orange-100 text-lg font-black text-orange-800 ring-1 ring-orange-200">
        {identityImage ? (
          <img
            src={identityImage}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          business.name.trim().charAt(0).toUpperCase() || "M"
        )}
      </div>
      <div className="min-w-0 flex-1">
        {businesses.length > 1 && onBusinessChange ? (
          <label className="block">
            <span className="sr-only">Selected business</span>
            <select
              value={business.id}
              onChange={(event) => onBusinessChange(event.target.value)}
              className="w-full truncate border-0 bg-transparent p-0 text-sm font-black text-[color:var(--text-primary)] outline-none focus:ring-0"
              data-testid="workspace-business-selector"
            >
              {businesses.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="truncate text-sm font-black text-[color:var(--text-primary)]">
            {business.name}
          </p>
        )}
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-[color:var(--text-muted)]">
          <span>{typeLabel}</span>
          {locationLabel ? (
            <>
              <span aria-hidden="true">·</span>
              <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{locationLabel}</span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );

  const destinationActions = (
    <div className="flex shrink-0 items-center gap-2">
      {publicProfileHref ? (
        <Button asChild variant="outline" size="sm">
          <a
            href={publicProfileHref}
            target="_blank"
            rel="noreferrer"
            aria-label="Preview profile"
          >
            <Eye className="h-4 w-4 sm:mr-1.5" aria-hidden="true" />
            <span className="hidden sm:inline">Preview profile</span>
          </a>
        </Button>
      ) : null}
      <Button asChild variant="ghost" size="sm">
        <Link href="/scout">Scout</Link>
      </Button>
    </div>
  );

  return (
    <div
      data-business-workspace-shell="true"
      data-workspace-module={activeModule}
      className="min-h-screen bg-[var(--bg-layered)] lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]"
    >
      <aside
        data-workspace-desktop-sidebar="true"
        className="sticky top-0 hidden h-screen flex-col border-r border-[color:var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-5 lg:flex"
      >
        <Link
          href="/dashboard"
          className="mb-5 inline-flex items-center gap-2 px-2 text-sm font-black tracking-tight text-[color:var(--text-primary)]"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Store className="h-4 w-4" aria-hidden="true" />
          </span>
          MealScout Business
        </Link>
        <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] p-3">
          {identityControl}
        </div>
        <nav
          aria-label="Business workspace"
          className="mt-5 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1"
        >
          {modules.map((module) => {
            const Icon = module.icon;
            const isActive = module.id === activeModule;
            return (
              <Link
                key={module.id}
                href={module.href}
                aria-current={isActive ? "page" : undefined}
                className={`group flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors ${
                  isActive
                    ? "bg-orange-100 text-orange-950"
                    : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-surface-muted)] hover:text-[color:var(--text-primary)]"
                }`}
                data-testid={`workspace-nav-${module.id}`}
              >
                <Icon
                  className={`mt-0.5 h-4 w-4 shrink-0 ${isActive ? "text-orange-700" : "text-[color:var(--text-muted)]"}`}
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-bold">
                    {module.label}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-4 opacity-70">
                    {module.description}
                  </span>
                </span>
              </Link>
            );
          })}
        </nav>
        <div className="mt-4 border-t border-[color:var(--border-subtle)] pt-4">
          {destinationActions}
        </div>
      </aside>

      <section className="min-w-0 pb-[calc(var(--scout-nav-height,58px)+env(safe-area-inset-bottom,0px))] lg:pb-0">
        <div className="sticky top-0 z-50 border-b border-[color:var(--border-subtle)] bg-[var(--bg-popup)]/95 px-4 py-3 backdrop-blur lg:hidden">
          {identityControl}
          <div className="mt-3 flex items-center justify-between gap-2">
            <p className="min-w-0 flex-1 truncate text-sm font-bold text-[color:var(--text-primary)]">
              {active.label}
            </p>
            {destinationActions}
          </div>
          {headerActions ? (
            <div className="mt-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {headerActions}
            </div>
          ) : null}
        </div>

        <header className="sticky top-0 z-40 hidden min-h-20 items-center justify-between gap-4 border-b border-[color:var(--border-subtle)] bg-[var(--bg-popup)]/95 px-6 py-3 backdrop-blur lg:flex">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-orange-700">
              {typeLabel} workspace
            </p>
            <h1 className="truncate text-xl font-black text-[color:var(--text-primary)]">
              {active.label}
            </h1>
            <p className="text-sm text-[color:var(--text-muted)]">
              {active.description}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {headerActions}
            {destinationActions}
          </div>
        </header>

        <main className="min-w-0">{children}</main>
      </section>

      <nav
        data-workspace-mobile-switcher="true"
        aria-label="Business workspace"
        className="fixed inset-x-0 bottom-0 z-[1100] border-t border-[color:var(--border-subtle)] bg-[var(--bg-popup)] lg:hidden"
      >
        <div
          className="flex items-stretch px-1 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_22px_rgba(36,18,8,0.10)]"
          style={{ height: "var(--scout-nav-height, 58px)" }}
        >
          {mobilePrimaryModules.map((module) => {
            const Icon = module.icon;
            const isActive = module.id === activeModule;
            const mobileLabel =
              module.id === "profile"
                ? "Profile"
                : module.id === "availability" && isFoodTruck
                  ? "Schedule"
                  : module.label;
            return (
              <Link
                key={module.id}
                href={module.href}
                aria-current={isActive ? "page" : undefined}
                className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 transition-colors ${
                  isActive
                    ? "text-orange-700"
                    : "text-[color:var(--text-muted)]"
                }`}
                data-testid={`workspace-mobile-nav-${module.id}`}
              >
                <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
                <span className="max-w-full truncate text-[10px] font-semibold leading-none">
                  {mobileLabel}
                </span>
              </Link>
            );
          })}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 transition-colors ${
                  isMobileSecondaryActive
                    ? "text-orange-700"
                    : "text-[color:var(--text-muted)]"
                }`}
                aria-label="More business tools"
                aria-current={isMobileSecondaryActive ? "page" : undefined}
                data-testid="workspace-mobile-nav-more"
              >
                <MoreHorizontal className="h-[18px] w-[18px]" aria-hidden="true" />
                <span className="text-[10px] font-semibold leading-none">More</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="end"
              sideOffset={10}
              className="mb-[env(safe-area-inset-bottom)] w-72 rounded-2xl p-2"
            >
              <DropdownMenuLabel className="px-3 py-2 text-xs uppercase tracking-[0.12em] text-[color:var(--text-muted)]">
                Business tools
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {mobileSecondaryModules.map((module) => {
                const Icon = module.icon;
                const isActive = module.id === activeModule;
                return (
                  <DropdownMenuItem key={module.id} asChild>
                    <Link
                      href={module.href}
                      aria-current={isActive ? "page" : undefined}
                      className={`flex min-h-12 items-center gap-3 rounded-xl px-3 py-2 ${
                        isActive ? "bg-orange-50 text-orange-950" : ""
                      }`}
                      data-testid={`workspace-mobile-more-${module.id}`}
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block text-sm font-bold">
                          {module.label}
                        </span>
                        <span className="block truncate text-xs text-[color:var(--text-muted)]">
                          {module.description}
                        </span>
                      </span>
                    </Link>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </nav>
    </div>
  );
}
