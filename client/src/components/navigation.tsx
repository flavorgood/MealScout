import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  type ComponentType,
  type PropsWithChildren,
} from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  User,
  Store,
  BarChart3,
  UserPlus,
  Clapperboard,
  Bug,
  Shield,
  Users,
  Calendar,
  LayoutDashboard,
  ParkingSquare,
  Truck,
  Share2,
  ChefHat,
  Package,
  ShoppingCart,
  Tag,
  MoreHorizontal,
  X,
  Compass,
  Heart,
  Receipt,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useI18n } from "@/lib/i18n";
import LongPressHelp from "@/components/long-press-help";
import { ScoutSearchDock } from "@/components/scout/ScoutSearchDock";
import { useScoutNavSearch } from "@/components/scout/ScoutNavSearchContext";

type NavItem = {
  path?: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick?: () => void;
  isBug?: boolean;
};

type NavigationProps = {
  scope?: "global" | "local";
};

type NavigationLane =
  | "guest"
  | "admin_staff"
  | "event"
  | "supplier"
  | "food_truck"
  | "restaurant"
  | "host"
  | "customer";

const NAV_HELP: Record<string, string> = {
  Scout: "Discover local food or see MealScout as a customer.",
  Saved: "Return to food and places you saved.",
  "Create menu": "Start a menu for a food business — design it first as a private draft.",
  Menu: "Open the menu builder for your food business.",
  Account: "Open your MealScout account and settings.",
  Overview: "See the current state of your business workspace.",
  Work: "Open the orders, requests, or bookings that need attention.",
  Manage: "Manage your public business presence and offerings.",
  Truck: "List a food truck on MealScout.",
  Claim: "Claim or update a food truck profile.",
  Login: "Sign in to your MealScout account.",
  Deals: "Find or create local food deals based on your account type.",
  "Parking Pass": "Food trucks use this to book approved host parking spots.",
  Profile: "Manage your account, saved items, and business setup.",
  More: "Open additional tools and pages for your account role.",
  "Admin Dashboard":
    "Use admin tools to manage users, businesses, and platform operations.",
};

const GlobalNavigationOwnerContext = createContext(false);

export function GlobalNavigationOwnerProvider({
  children,
}: PropsWithChildren) {
  return (
    <GlobalNavigationOwnerContext.Provider value>
      {children}
    </GlobalNavigationOwnerContext.Provider>
  );
}

export default function Navigation({ scope = "local" }: NavigationProps) {
  const isGlobalScope = scope === "global";
  const hasGlobalNavigationOwner = useContext(GlobalNavigationOwnerContext);
  const [moreOpen, setMoreOpen] = useState(false);
  const [location] = useLocation();
  const currentPath = location.split("?")[0];
  const { user } = useAuth();
  const { toast } = useToast();
  const [isReporting, setIsReporting] = useState(false);
  const { t } = useI18n();
  const sheetRef = useRef<HTMLDivElement>(null);
  const {
    searchMode,
    query: scoutSearchQuery,
    activeFilter: scoutSearchFilter,
    openSearch,
    closeSearch,
    setQuery: setScoutSearchQuery,
    setActiveFilter: setScoutSearchFilter,
  } = useScoutNavSearch();

  useEffect(() => {
    setMoreOpen(false);
  }, [location]);

  useEffect(() => {
    if (!moreOpen) return;
    const handler = (e: MouseEvent) => {
      if (sheetRef.current && !sheetRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [moreOpen]);

  const handleBugReport = async () => {
    if (isReporting) return;
    setIsReporting(true);
    try {
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(document.body, {
        useCORS: true,
        allowTaint: true,
        scale: 0.5,
        logging: false,
      });
      const screenshot = canvas.toDataURL("image/png");
      await apiRequest("POST", "/api/bug-report", {
        screenshot,
        currentUrl: window.location.href,
        userAgent: navigator.userAgent,
      });
      toast({
        title: t("toast.bugSentTitle", "Bug report sent!"),
        description: t(
          "toast.bugSentDescription",
          "Thank you for helping us improve MealScout.",
        ),
      });
    } catch {
      toast({
        title: t("toast.bugFailedTitle", "Failed to send report"),
        description: t(
          "toast.bugFailedDescription",
          "Please try again or contact support.",
        ),
        variant: "destructive",
      });
    } finally {
      setIsReporting(false);
    }
  };

  const isRestaurantOwner = user?.userType === "restaurant_owner";
  const isFoodTruck = user?.userType === "food_truck";
  const isSupplier = user?.userType === "supplier";
  const isAdmin =
    user?.userType === "admin" ||
    user?.userType === "duper_admin" ||
    user?.userType === "super_admin";
  const isStaff = user?.userType === "staff";
  const isEventCoordinator = user?.userType === "event_coordinator";
  const businessOnboardingRequired = user?.businessOnboardingRequired === true;
  const businessOnboardingPath =
    user?.businessOnboardingPath ||
    (isFoodTruck
      ? "/restaurant-signup?businessType=food_truck&source=navigation&claim=1"
      : "/restaurant-signup?businessType=restaurant&source=navigation&claim=1");

  const { data: businessAccess } = useQuery<{
    hasAnyAccess: boolean;
    permissions: {
      manageDeals: boolean;
      manageParkingPass: boolean;
      viewAnalytics: boolean;
      manageProfile: boolean;
    };
  }>({
    queryKey: ["/api/business-access/me"],
    enabled: !!user,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const hasBusinessTeamAccess = Boolean(businessAccess?.hasAnyAccess);
  const [isHost, setIsHost] = useState(false);
  useEffect(() => {
    if (!user) {
      setIsHost(false);
      return;
    }
    let cancelled = false;
    fetch("/api/hosts")
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setIsHost(false);
          return;
        }
        const hosts = await res.json().catch(() => []);
        setIsHost(Array.isArray(hosts) && hosts.length > 0);
      })
      .catch(() => {
        if (!cancelled) setIsHost(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const isWheelPage = location.startsWith("/admin/giveaway-wheel");
  const [isDocFullscreen, setIsDocFullscreen] = useState(false);
  const [isScoutMapFullscreen, setIsScoutMapFullscreen] = useState(false);
  useEffect(() => {
    const handler = () => setIsDocFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);
  useEffect(() => {
    const update = () =>
      setIsScoutMapFullscreen(
        document.body.classList.contains("mealscout-map-fullscreen"),
      );
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  if (isGlobalScope && !user && currentPath === "/") return null;
  if (isWheelPage || isDocFullscreen || isScoutMapFullscreen) return null;
  // App.tsx explicitly owns navigation on shell routes. Self-contained
  // consumer routes omit the provider and keep their page-local nav.
  if (!isGlobalScope && hasGlobalNavigationOwner) return null;

  const dashboardPath = "/dashboard";
  const isScoutRoute =
    currentPath === "/scout" ||
    currentPath.startsWith("/scout/") ||
    currentPath === "/scout-v2" ||
    currentPath === "/directory" ||
    currentPath.startsWith("/directory/");
  const isBusinessWorkspaceRoute =
    currentPath === "/restaurant-owner-dashboard" ||
    currentPath === "/menu-builder" ||
    currentPath === "/owner-ai" ||
    currentPath === "/deal-creation" ||
    currentPath.startsWith("/deal-edit/") ||
    currentPath === "/kitchen" ||
    (currentPath === "/orders" &&
      (isRestaurantOwner || isFoodTruck || isAdmin));
  const disableScoutHelpBubbles = isScoutRoute;

  const accountLane: NavigationLane = !user
    ? "guest"
    : isAdmin || isStaff
      ? "admin_staff"
      : isEventCoordinator
        ? "event"
        : isSupplier
          ? "supplier"
          : isFoodTruck
            ? "food_truck"
            : isRestaurantOwner || hasBusinessTeamAccess
              ? "restaurant"
              : isHost
                ? "host"
                : "customer";
  // Discovery intent owns the shell on Scout. An operator or admin remains a
  // diner here; business/admin navigation belongs to its own workspace.
  const lane: NavigationLane = isScoutRoute
    ? user
      ? "customer"
      : "guest"
    : accountLane;
  const isRestaurantHostCapable = lane === "restaurant" && isHost;
  // A restaurant/food_truck-laned user who also has a real host row (verified
  // owning both, e.g. a bar operator who's also a venue host) needs a path to
  // their host management surface too - /host/dashboard, not /parking-pass
  // (that's the public discovery/booking page, already handled above).
  const hasSecondaryHostLink =
    isHost && (lane === "restaurant" || lane === "food_truck");

  const primaryNavigationByLane: Record<typeof lane, NavItem[]> = {
    guest: [
      { path: "/scout", icon: Compass, label: "Scout" },
      { path: "/menu-builder", icon: ChefHat, label: "Create menu" },
      { path: "/login", icon: User, label: "Account" },
    ],
    customer: [
      { path: "/scout", icon: Compass, label: "Scout" },
      { path: "/menu-builder", icon: ChefHat, label: "Menu" },
      { path: "/profile", icon: User, label: "Account" },
    ],
    food_truck: businessOnboardingRequired
      ? [
          { path: businessOnboardingPath, icon: Store, label: "Set Up" },
          { path: "/profile", icon: User, label: "Account" },
        ]
      : [
          { path: dashboardPath, icon: LayoutDashboard, label: "Overview" },
          { path: "/orders", icon: ShoppingCart, label: "Work" },
          {
            path: "/restaurant-owner-dashboard",
            icon: Store,
            label: "Manage",
          },
        ],
    restaurant: businessOnboardingRequired
      ? [
          { path: businessOnboardingPath, icon: Store, label: "Set Up" },
          { path: "/profile", icon: User, label: "Account" },
        ]
      : [
          { path: dashboardPath, icon: LayoutDashboard, label: "Overview" },
          { path: "/orders", icon: ShoppingCart, label: "Work" },
          {
            path: "/restaurant-owner-dashboard",
            icon: Store,
            label: "Manage",
          },
        ],
    host: [
      { path: dashboardPath, icon: LayoutDashboard, label: "Overview" },
      { path: "/parking-pass", icon: ParkingSquare, label: "Work" },
      { path: "/host/dashboard", icon: Store, label: "Manage" },
    ],
    event: [
      { path: dashboardPath, icon: LayoutDashboard, label: "Overview" },
      {
        path: "/event-coordinator/dashboard?tab=requests",
        icon: Package,
        label: "Work",
      },
      { path: "/events", icon: Calendar, label: "Manage" },
    ],
    supplier: [
      { path: dashboardPath, icon: LayoutDashboard, label: "Overview" },
      { path: "/supply/orders", icon: ShoppingCart, label: "Work" },
      { path: "/suppliers", icon: Package, label: "Manage" },
    ],
    admin_staff: [
      { path: dashboardPath, icon: LayoutDashboard, label: "Dashboard" },
      { path: "/admin/control-center", icon: Shield, label: "Control" },
      {
        path: isAdmin ? "/admin/geo/heatmap" : "/staff",
        icon: BarChart3,
        label: isAdmin ? "Reports" : "Staff",
      },
    ],
  };

  const primaryNav: NavItem[] = [
    ...primaryNavigationByLane[lane],
    {
      icon: MoreHorizontal,
      label: "More",
      onClick: () => setMoreOpen((v) => !v),
    },
  ].filter(Boolean) as NavItem[];

  const dedupeByPath = (items: NavItem[]) => {
    const seen = new Set<string>();
    return items.filter((item) => {
      if (!item.path) return true;
      if (seen.has(item.path)) return false;
      seen.add(item.path);
      return true;
    });
  };

  const buildMoreItems = (): NavItem[] => {
    const items: NavItem[] = [];

    if (lane === "guest") {
      items.push(
        { path: "/favorites", icon: Heart, label: "Saved" },
        { path: "/events", icon: Calendar, label: "Events" },
        { path: "/deals", icon: Tag, label: "Deals" },
        {
          path: "/restaurant-signup?businessType=food_truck",
          icon: Store,
          label: "List a Truck",
        },
        { path: "/claim-business", icon: Truck, label: "Claim Business" },
      );
    } else if (lane === "customer") {
      items.push(
        { path: "/favorites", icon: Heart, label: "Saved" },
        { path: "/orders", icon: Receipt, label: "Activity" },
        { path: "/events", icon: Calendar, label: "Events" },
        { path: "/deals", icon: Tag, label: "Deals" },
        { path: "/video", icon: Clapperboard, label: "Video" },
        { path: "/share-hub", icon: Share2, label: "Share" },
      );
    } else if (lane === "food_truck") {
      items.push(
        { path: "/scout", icon: Compass, label: "Scout" },
        { path: dashboardPath, icon: LayoutDashboard, label: "Dashboard" },
        { path: "/parking-pass", icon: ParkingSquare, label: "Schedule" },
        { path: "/menu-builder", icon: ChefHat, label: "Menu" },
        { path: "/kitchen", icon: ChefHat, label: "Kitchen" },
        { path: "/deal-creation", icon: Tag, label: "Deals" },
        { path: "/events", icon: Calendar, label: "Events" },
        { path: "/suppliers", icon: Truck, label: "Suppliers" },
        { path: "/business-team", icon: Users, label: "Team" },
        { path: "/share-hub", icon: Share2, label: "Share" },
        { path: "/subscribe", icon: BarChart3, label: "Profile access" },
        {
          path: "/restaurant-owner-dashboard",
          icon: BarChart3,
          label: "Reports",
        },
        ...(hasSecondaryHostLink
          ? [
              {
                path: "/host/dashboard",
                icon: ParkingSquare,
                label: "Host Venue",
              } as NavItem,
            ]
          : []),
        { path: "/profile", icon: User, label: "Profile" },
      );
    } else if (lane === "restaurant") {
      items.push(
        { path: "/scout", icon: Compass, label: "Scout" },
        ...(isRestaurantHostCapable
          ? [
              {
                path: "/parking-pass",
                icon: ParkingSquare,
                label: "Parking Pass",
              } as NavItem,
            ]
          : []),
        { path: "/menu-builder", icon: ChefHat, label: "Menu" },
        { path: "/kitchen", icon: ChefHat, label: "Kitchen" },
        { path: "/deal-creation", icon: Tag, label: "Deals" },
        { path: "/events", icon: Calendar, label: "Events" },
        { path: "/suppliers", icon: Truck, label: "Suppliers" },
        { path: "/business-team", icon: Users, label: "Team" },
        { path: "/share-hub", icon: Share2, label: "Share" },
        { path: "/subscribe", icon: BarChart3, label: "Profile access" },
        {
          path: "/restaurant-owner-dashboard",
          icon: BarChart3,
          label: "Reports",
        },
        ...(hasSecondaryHostLink
          ? [
              {
                path: "/host/dashboard",
                icon: ParkingSquare,
                label: "Host Venue",
              } as NavItem,
            ]
          : []),
        { path: "/profile", icon: User, label: "Profile" },
      );
    } else if (lane === "host") {
      items.push(
        { path: "/scout", icon: Compass, label: "Scout" },
        { path: "/events", icon: Calendar, label: "Events" },
        { path: "/share-hub", icon: Share2, label: "Share" },
        { path: "/profile", icon: User, label: "Profile" },
      );
    } else if (lane === "event") {
      items.push(
        { path: "/scout", icon: Compass, label: "Scout" },
        { path: "/video", icon: Clapperboard, label: "Video" },
        { path: "/share-hub", icon: Share2, label: "Share" },
        { path: "/profile", icon: User, label: "Profile" },
      );
    } else if (lane === "supplier") {
      items.push(
        { path: "/scout", icon: Compass, label: "Scout" },
        { path: "/events", icon: Calendar, label: "Events" },
        { path: "/supplier/dashboard", icon: BarChart3, label: "Reports" },
        { path: "/share-hub", icon: Share2, label: "Share" },
        { path: "/profile", icon: User, label: "Profile" },
      );
    } else {
      items.push(
        { path: "/admin", icon: Shield, label: "Admin Dashboard" },
        { path: "/staff", icon: Users, label: "Staff" },
        {
          path: "/admin/control-center",
          icon: Shield,
          label: "Control Center",
        },
        { path: "/admin/geo/heatmap", icon: BarChart3, label: "Geo Heatmap" },
        {
          path: "/admin?tab=restaurants",
          icon: Store,
          label: "Businesses",
        },
        {
          path: "/admin?tab=trucks",
          icon: Truck,
          label: "Food Trucks",
        },
        {
          path: "/admin?tab=hosts",
          icon: ParkingSquare,
          label: "Hosts",
        },
        {
          path: "/admin?tab=events",
          icon: Calendar,
          label: "Events",
        },
        { path: "/parking-pass", icon: ParkingSquare, label: "Parking Pass" },
        { path: "/deal-creation", icon: Tag, label: "Deals" },
        ...(isAdmin
          ? [{ path: "/orders", icon: ShoppingCart, label: "Orders" } as NavItem]
          : []),
        { path: "/share-hub", icon: Share2, label: "Share" },
        { path: "/admin?tab=users", icon: UserPlus, label: "Users" },
        {
          path: "/admin/giveaway-wheel",
          icon: Clapperboard,
          label: "Giveaway Wheel",
        },
        { path: "/profile", icon: User, label: "Profile" },
      );
    }

    items.push({
      label: isReporting ? "Sending..." : "Report Bug",
      icon: Bug,
      onClick: handleBugReport,
      isBug: true,
    });

    return dedupeByPath(items);
  };

  const moreItems = buildMoreItems();
  const isActive = (path: string) => {
    const pathOnly = path.split("?")[0];
    return (
      currentPath === pathOnly ||
      currentPath.startsWith(`${pathOnly}/`)
    );
  };

  const buildOwnerToolHref = (destination: string) => {
    try {
      const url = new URL(destination, window.location.origin);
      const current = new URL(window.location.href);
      const isLeavingOwnerDashboard =
        current.pathname.startsWith("/restaurant-owner-dashboard") &&
        !url.pathname.startsWith("/restaurant-owner-dashboard");
      if (!isLeavingOwnerDashboard) return destination;
      ["setup", "ref", "setupStep", "setupPanel", "onboarding"].forEach((key) =>
        url.searchParams.delete(key),
      );
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return destination;
    }
  };

  const scoutNavSearch = isScoutRoute ? (
    <ScoutSearchDock
      placement="navigation"
      searchMode={searchMode}
      query={scoutSearchQuery}
      activeFilter={scoutSearchFilter}
      onOpen={openSearch}
      onClose={closeSearch}
      onQueryChange={setScoutSearchQuery}
      onFilterChange={setScoutSearchFilter}
    />
  ) : null;

  return (
    <>
      <header
        data-nav-root={scope}
        className={`fixed inset-x-0 top-0 z-[1100] hidden border-b border-[color:var(--border-subtle)] ${isBusinessWorkspaceRoute ? "" : "lg:block"}`}
        style={{ backgroundColor: "var(--bg-popup)" }}
      >
        <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-4 px-5 xl:px-8">
          <Link
            href="/scout"
            aria-label="Open MealScout"
            className="inline-flex items-center gap-2 text-[color:var(--text-primary)]"
          >
            <img
              src="/brand/mealscout-logo-pin.png"
              alt="MealScout"
              className="h-9 w-9 object-contain"
            />
            <span className="text-base font-black tracking-tight">MealScout</span>
          </Link>
          {isScoutRoute ? (
            <div
              className="min-w-0 flex-1 overflow-hidden rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)]/75"
              data-scout-desktop-search-nav="true"
            >
              {scoutNavSearch}
            </div>
          ) : null}
          <nav aria-label="Primary navigation" className="flex items-center gap-1">
            {primaryNav.map((item, idx) =>
              item.path ? (
                <LongPressHelp
                  disabled={disableScoutHelpBubbles}
                  key={`${item.path}-${idx}`}
                  description={
                    NAV_HELP[item.label] || `${item.label} navigation`
                  }
                >
                  <Link
                    href={buildOwnerToolHref(item.path)}
                    className={`inline-flex h-11 items-center gap-2 rounded-xl px-3 text-sm font-bold transition-all ${
                      isActive(item.path)
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-[color:var(--text-muted)] hover:bg-[var(--bg-surface-muted)] hover:text-[color:var(--text-primary)]"
                    }`}
                    aria-label={item.label}
                    aria-current={isActive(item.path) ? "page" : undefined}
                  >
                    <item.icon className="h-4 w-4" />
                    <span className="text-[12px] font-bold">
                      {item.label}
                    </span>
                  </Link>
                </LongPressHelp>
              ) : (
                <LongPressHelp
                  disabled={disableScoutHelpBubbles}
                  key={`more-${idx}`}
                  description={NAV_HELP[item.label] || `${item.label} options`}
                >
                  <button
                    type="button"
                    aria-label={item.label}
                    aria-expanded={item.label === "More" ? moreOpen : undefined}
                    onClick={item.onClick}
                    className={`inline-flex h-11 items-center gap-2 rounded-xl px-3 text-sm font-bold transition-all ${
                      item.label === "More" && moreOpen
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-[color:var(--text-muted)] hover:bg-[var(--bg-surface-muted)] hover:text-[color:var(--text-primary)]"
                    }`}
                  >
                    <item.icon className="h-4 w-4" />
                    <span className="text-[12px] font-bold">
                      {item.label}
                    </span>
                  </button>
                </LongPressHelp>
              ),
            )}
          </nav>
        </div>
      </header>

      <nav
        aria-label="Primary navigation"
        className={`${
          isBusinessWorkspaceRoute ? "hidden" : "fixed"
        } inset-x-0 bottom-0 z-[1100] ${
          isScoutRoute ? "" : "border-t border-[color:var(--border-subtle)]"
        } lg:hidden`}
        style={{ bottom: 0 }}
      >
        <div
          data-scout-mobile-nav-shell={
            isScoutRoute ? "search-and-navigation" : undefined
          }
          className={
            isScoutRoute
              ? "mx-2 mb-2 overflow-hidden rounded-[1.1rem] border border-white/10 shadow-[0_-12px_34px_rgba(0,0,0,0.38)] backdrop-blur-xl"
              : "w-full"
          }
          style={{ backgroundColor: "var(--bg-popup)" }}
        >
          {isScoutRoute ? scoutNavSearch : null}
          <div
            className={
              isScoutRoute
                ? "border-t border-[color:var(--border-subtle)]"
                : undefined
            }
          >
            <div
              className="relative flex items-stretch justify-around gap-1 px-2 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_22px_rgba(36,18,8,0.10)] [&>span]:min-w-[44px] [&>span]:flex-1"
              style={{
                height: isScoutRoute
                  ? "52px"
                  : "var(--scout-nav-height, 58px)",
              }}
            >
              {primaryNav.map((item, index) => {
                const active = item.path
                  ? isActive(item.path)
                  : item.label === "More"
                    ? moreOpen
                    : false;

                if (item.path) {
                  return (
                    <LongPressHelp
                      disabled={disableScoutHelpBubbles}
                      key={`${item.path}-${index}`}
                      description={
                        NAV_HELP[item.label] || `${item.label} navigation`
                      }
                    >
                      <Link
                        href={buildOwnerToolHref(item.path)}
                        aria-label={item.label}
                        aria-current={active ? "page" : undefined}
                        className={`flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-1 transition-colors ${
                          active
                            ? "text-primary"
                            : "text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
                        }`}
                      >
                        <item.icon
                          className="h-[18px] w-[18px]"
                          aria-hidden="true"
                        />
                        <span className="max-w-full truncate text-[10px] font-semibold leading-none">
                          {item.label}
                        </span>
                      </Link>
                    </LongPressHelp>
                  );
                }

                return (
                  <LongPressHelp
                    disabled={disableScoutHelpBubbles}
                    key={`more-${index}`}
                    description={
                      NAV_HELP[item.label] || `${item.label} options`
                    }
                  >
                    <button
                      type="button"
                      aria-label={item.label}
                      aria-expanded={
                        item.label === "More" ? moreOpen : undefined
                      }
                      onClick={item.onClick}
                      className={`flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-1 transition-colors ${
                        active
                          ? "text-primary"
                          : "text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
                      }`}
                    >
                      <item.icon
                        className="h-[18px] w-[18px]"
                        aria-hidden="true"
                      />
                      <span className="text-[10px] font-semibold leading-none">
                        {item.label}
                      </span>
                    </button>
                  </LongPressHelp>
                );
              })}
            </div>
          </div>
        </div>
      </nav>

      {moreOpen && !isBusinessWorkspaceRoute && (
        <div
          className="fixed inset-0 z-[1090]"
          aria-modal="true"
          role="dialog"
          aria-label="More options"
        >
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-sm"
            onClick={() => setMoreOpen(false)}
          />
          <div
            ref={sheetRef}
            className={`absolute left-0 right-0 mx-4 overflow-hidden rounded-3xl border border-[color:var(--border-subtle)] bg-[var(--bg-popup)]/95 shadow-[0_-16px_48px_rgba(36,18,8,0.24)] backdrop-blur-2xl ${
              isScoutRoute
                ? "bottom-[calc(env(safe-area-inset-bottom)+7rem)]"
                : "bottom-[calc(env(safe-area-inset-bottom)+5.5rem)]"
            }`}
          >
            <div className="flex items-center justify-between px-5 pt-4 pb-2">
              <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--text-muted)]">
                More
              </span>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                aria-label="Close"
                className="p-1 text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-primary)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-4 gap-0 pb-4 px-2">
              {moreItems.map((item) => {
                const active = item.path ? isActive(item.path) : false;
                const inner = (
                  <>
                    <span
                      className={`flex h-11 w-11 items-center justify-center rounded-2xl mb-1 transition-all ${
                        active
                          ? "bg-primary/20 ring-1 ring-primary/40"
                          : item.isBug
                            ? "bg-primary/10"
                            : "bg-[var(--bg-surface-muted)]"
                      }`}
                      aria-hidden="true"
                    >
                      <item.icon
                        className={`h-5 w-5 ${
                          active
                            ? "text-primary"
                            : item.isBug
                              ? "text-primary animate-pulse"
                              : "text-[color:var(--text-muted)]"
                        }`}
                      />
                    </span>
                    <span
                      className={`text-[10px] font-medium text-center leading-tight ${
                        active
                          ? "text-primary"
                          : "text-[color:var(--text-muted)]"
                      }`}
                    >
                      {item.label}
                    </span>
                  </>
                );

                return item.path ? (
                  <Link
                    key={item.path}
                    href={buildOwnerToolHref(item.path)}
                    aria-label={item.label}
                    aria-current={active ? "page" : undefined}
                    className="flex flex-col items-center justify-start rounded-2xl px-1 pt-3 transition-colors hover:bg-[var(--bg-surface-muted)]"
                    onClick={() => setMoreOpen(false)}
                  >
                    {inner}
                  </Link>
                ) : (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => {
                      item.onClick?.();
                      setMoreOpen(false);
                    }}
                    disabled={isReporting}
                    aria-label={item.label}
                    className="flex flex-col items-center justify-start rounded-2xl px-1 pt-3 transition-colors hover:bg-[var(--bg-surface-muted)] disabled:opacity-60"
                  >
                    {inner}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
