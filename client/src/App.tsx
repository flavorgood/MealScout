import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/useAuth";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import Navigation, {
  GlobalNavigationOwnerProvider,
} from "@/components/navigation";
import { ScoutNavSearchProvider } from "@/components/scout/ScoutNavSearchContext";
import { apiUrl } from "@/lib/api";
import { TimeOfDayBackground } from "@/components/TimeOfDayBackground";
import { useToast } from "@/hooks/use-toast";
import { parseCleanAffiliateBusinessRoute } from "@shared/cleanAffiliateLinks";

// Eager load only critical pages (welcome, login) - everything else lazy loads
import NotFound from "@/pages/not-found";
import Login from "@/pages/login";
import Welcome from "@/pages/welcome";

// Lazy load all other pages - they only download when the user navigates to them
const CustomerSignup = lazy(() => import("@/pages/customer-signup"));
const RestaurantSignup = lazy(() => import("@/pages/restaurant-signup"));
const CityLanding = lazy(() => import("@/pages/city-landing"));
const CityDiscoveryPage = lazy(() => import("@/pages/city-discovery"));
const DealCreation = lazy(() => import("@/pages/deal-creation"));
const DealEdit = lazy(() => import("@/pages/deal-edit"));
const DealDetail = lazy(() => import("@/pages/deal-detail"));
const Subscribe = lazy(() => import("@/pages/subscribe"));
const Search = lazy(() => import("@/pages/search"));
const ReviewsPage = lazy(() => import("@/pages/reviews"));
const Favorites = lazy(() => import("@/pages/favorites"));
const Orders = lazy(() => import("@/pages/orders"));
const MerchantPromotions = lazy(() => import("@/pages/merchant-promotions"));
const Profile = lazy(() => import("@/pages/profile"));
const AdminLogin = lazy(() => import("@/pages/admin-login"));
const AdminDashboard = lazy(() => import("@/pages/admin-dashboard"));
const StaffDashboard = lazy(() => import("@/pages/staff-dashboard"));
const AdminIncidents = lazy(() => import("@/pages/AdminIncidents"));
const AdminControlCenter = lazy(() => import("@/pages/AdminControlCenter"));
const AdminSupportTickets = lazy(() => import("@/pages/AdminSupportTickets"));
const AdminModerationEvents = lazy(
  () => import("@/pages/AdminModerationEvents"),
);
const AdminModerationVideos = lazy(
  () => import("@/pages/admin-moderation-videos"),
);
const AdminGiveawayWheel = lazy(() => import("@/pages/admin-giveaway-wheel"));
const AdminModerationMetrics = lazy(
  () => import("@/pages/admin-moderation-metrics"),
);
const AdminModerationAppeals = lazy(
  () => import("@/pages/admin-moderation-appeals"),
);
const ModerationQueue = lazy(() => import("@/pages/admin/ModerationQueue"));
const ReporterReputationPage = lazy(
  () => import("@/pages/ReporterReputationPage"),
);
const ModerationPolicy = lazy(() => import("@/pages/public/ModerationPolicy"));
const AdminAuditLogs = lazy(() => import("@/pages/AdminAuditLogs"));
const AdminVacLogs = lazy(() => import("@/pages/AdminVacLogs"));
const AdminTelemetry = lazy(() => import("@/pages/admin-telemetry"));
const AdminDiscoveryObservatory = lazy(
  () => import("@/pages/admin-discovery-observatory"),
);
const AdminAffiliateManagement = lazy(
  () => import("@/pages/AdminAffiliateManagement"),
);
const AdminGeoAds = lazy(() => import("@/pages/admin-geo-ads"));
const AdminMarketHeatmap = lazy(() => import("@/pages/admin-market-heatmap"));
const AffiliateEarnings = lazy(() => import("@/pages/AffiliateEarnings"));
const CategoryPage = lazy(() => import("@/pages/category"));
const FeaturedDealsPage = lazy(() => import("@/pages/deals-featured"));
const LocationDetailPage = lazy(() => import("@/pages/location-detail"));
const LocationDiscoveryPage = lazy(() => import("@/pages/location-discovery"));
const PublicSeoLandingPage = lazy(() => import("@/pages/public-seo-landing"));
const SettingsPage = lazy(() => import("@/pages/profile/settings"));
const RestaurantOwnerDashboard = lazy(
  () => import("@/pages/restaurant-owner-dashboard"),
);
const UserDashboard = lazy(() => import("@/pages/user-dashboard"));
const DashboardSwitcher = lazy(() => import("@/components/dashboard-switcher"));
const TermsOfService = lazy(() => import("@/pages/terms-of-service"));
const PrivacyPolicy = lazy(() => import("@/pages/privacy-policy"));
const DataDeletion = lazy(() => import("@/pages/data-deletion"));
const About = lazy(() => import("@/pages/about"));
const ComparePage = lazy(() => import("@/pages/compare"));
const CompareDoorDashPage = lazy(() => import("@/pages/compare-doordash"));
const CompareUberEatsPage = lazy(() => import("@/pages/compare-uber-eats"));
const CompareGrubhubPage = lazy(() => import("@/pages/compare-grubhub"));
const ServiceCompareLandingPage = lazy(
  () => import("@/pages/service-compare-landing"),
);
const DeliveryAppAlternativesPage = lazy(
  () => import("@/pages/delivery-app-alternatives"),
);
const OnlineOrderingPlatformsPage = lazy(
  () => import("@/pages/online-ordering-platforms"),
);
const FAQ = lazy(() => import("@/pages/faq"));
const HowItWorks = lazy(() => import("@/pages/how-it-works"));
const Contact = lazy(() => import("@/pages/contact"));
const Sitemap = lazy(() => import("@/pages/sitemap"));
const InstallApp = lazy(() => import("@/pages/install"));
const ForgotPassword = lazy(() => import("@/pages/forgot-password"));
const ResetPassword = lazy(() => import("@/pages/reset-password"));
const AccountSetup = lazy(() => import("@/pages/account-setup"));
const PostVerification = lazy(() => import("@/pages/post-verification"));
const ReferralRedirect = lazy(() => import("@/pages/referral-redirect"));
const OAuthSetupGuide = lazy(() => import("@/pages/oauth-setup-guide"));
const GoldenPlateWinners = lazy(() => import("@/pages/golden-plate-winners"));
const ParkingPassPage = lazy(() => import("@/pages/parking-pass"));
const ParkingPassManage = lazy(() => import("@/pages/parking-pass-manage"));
const StatusPage = lazy(() => import("@/pages/status"));
const HostSignup = lazy(() => import("@/pages/host-signup"));
const HostDashboard = lazy(() => import("@/pages/host-dashboard"));
const EventCoordinatorDashboard = lazy(
  () => import("@/pages/event-coordinator-dashboard"),
);
const DashboardRouter = lazy(() => import("@/pages/dashboard-router"));
const TruckDiscovery = lazy(() => import("@/pages/truck-discovery"));
const EventsPage = lazy(() => import("@/pages/events"));
const EventsRouter = lazy(() => import("@/pages/events-router"));
const EventDetailPage = lazy(() => import("@/pages/event-detail"));
const VideoPage = lazy(() => import("@/pages/video"));
const VideoDetailPage = lazy(() => import("@/pages/video-detail"));
const ChangePassword = lazy(() => import("@/pages/change-password"));
const ClaimTruckPage = lazy(() => import("@/pages/claim-truck"));
const SuppliersPage = lazy(() => import("@/pages/suppliers"));
const SupplierDetailPage = lazy(() => import("@/pages/supplier-detail"));
const SupplierDashboardPage = lazy(() => import("@/pages/supplier-dashboard"));
const SupplyOrdersPage = lazy(() => import("@/pages/supply-orders"));
const PublicProfilePage = lazy(() => import("@/pages/public-profile"));
const PensacolaSpots = lazy(() => import("@/pages/pensacola-spots"));
const PensacolaReport = lazy(() => import("@/pages/pensacola-report"));
const ShareHubPage = lazy(() => import("@/pages/share-hub-page"));
const BusinessTeamPage = lazy(() => import("@/pages/business-team"));
const BusinessTeamAcceptPage = lazy(
  () => import("@/pages/business-team-accept"),
);
const MenuBuilderPage = lazy(() => import("@/pages/menu-builder"));
const OwnerAiActionsPage = lazy(() => import("@/pages/owner-ai-actions"));
const EcosystemSharingPage = lazy(() => import("@/pages/ecosystem-sharing"));
const OwnerAiAuthorizePage = lazy(() => import("@/pages/owner-ai-authorize"));
const KitchenDisplayPage = lazy(() => import("@/pages/kitchen-display"));
const OnlineMenuPage = lazy(() => import("@/pages/online-menu"));
const PickupCheckoutPage = lazy(() => import("@/pages/pickup-checkout"));
const MerchantDeliveryPage = lazy(() => import("@/pages/merchant-delivery"));
const OrderConfirmationPage = lazy(() => import("@/pages/order-confirmation"));
const ScoutPage = lazy(() => import("@/pages/explore-preview"));
const ScoutPageV2 = lazy(() => import("@/pages/explore-preview-v2"));
const FoodTruckRush = lazy(() => import("@/pages/food-truck-rush"));
const HiringPage = lazy(() => import("@/pages/hiring"));
const ForRestaurants = lazy(() => import("@/pages/for-restaurants"));
const ForFoodTrucks = lazy(() => import("@/pages/for-food-trucks"));
const ForBars = lazy(() => import("@/pages/for-bars"));
const ForHosts = lazy(() => import("@/pages/for-hosts"));
const ForEvents = lazy(() => import("@/pages/for-events"));
const ProfileSetupPage = lazy(() => import("@/pages/profile-setup"));
const HostLocationPartnerPage = lazy(
  () => import("@/pages/host-location-partner"),
);

// Loading fallback component
const PageLoader = () => (
  <div className="flex items-center justify-center min-h-screen">
    <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
  </div>
);

const RedirectToScout = () => {
  const [, setLocation] = useLocation();

  useEffect(() => {
    setLocation("/scout");
  }, [setLocation]);

  return <PageLoader />;
};

const RedirectToLogin = () => {
  const [location, setLocation] = useLocation();

  useEffect(() => {
    const redirectTarget = `${location || "/dashboard"}${window.location.search || ""}`;
    const redirect = encodeURIComponent(redirectTarget);
    setLocation(`/login?redirect=${redirect}`);
  }, [location, setLocation]);

  return (
    <main className="flex min-h-screen items-center justify-center px-4 text-center">
      <p className="text-sm text-muted-foreground">Opening sign in...</p>
    </main>
  );
};

const RedirectToSettingsNotifications = () => {
  const [, setLocation] = useLocation();

  useEffect(() => {
    setLocation("/settings?tab=notifications");
  }, [setLocation]);

  return <PageLoader />;
};

const RedirectToSettingsAccount = () => {
  const [, setLocation] = useLocation();

  useEffect(() => {
    setLocation("/settings?tab=account");
  }, [setLocation]);

  return <PageLoader />;
};

const RedirectToHelp = () => {
  const [, setLocation] = useLocation();

  useEffect(() => {
    setLocation("/help");
  }, [setLocation]);

  return <PageLoader />;
};

const RedirectToAdmin = () => {
  const [, setLocation] = useLocation();

  useEffect(() => {
    setLocation("/admin");
  }, [setLocation]);

  return <PageLoader />;
};

const CleanPublicProfileRoute = () => {
  const [location] = useLocation();
  const currentPath = location.split("?")[0];
  return parseCleanAffiliateBusinessRoute(currentPath) ? (
    <PublicProfilePage />
  ) : null;
};

const publicRoutePrefixes = [
  "/",
  "/scout",
  "/explore",
  "/explore-preview",
  "/directory",
  "/food-truck-rush",
  "/login",
  "/customer-signup",
  "/restaurant-signup",
  "/claim-business",
  "/claim-truck",
  "/deal-creation",
  "/deal/",
  "/search",
  "/trending",
  "/map",
  "/video",
  "/category/",
  "/deals",
  "/restaurant/",
  "/caterer/",
  "/private-chef/",
  "/terms-of-service",
  "/moderation-policy",
  "/privacy-policy",
  "/data-deletion",
  "/about",
  "/compare",
  "/delivery-app-alternatives",
  "/online-ordering-platforms",
  "/faq",
  "/how-it-works",
  "/contact",
  "/install",
  "/host-signup",
  "/profile-setup",
  "/for-restaurants",
  "/for-food-trucks",
  "/for-bars",
  "/for-hosts",
  "/for-events",
  "/host-location-partner",
  "/hiring",
  "/jobs",
  "/private-chefs",
  "/events",
  "/city/",
  "/food-trucks/",
  "/food-trucks-today/",
  "/food-truck-catering/",
  "/book-food-truck/",
  "/deals-today/",
  "/events-today/",
  "/locations-with-trucks/",
  "/sitemap",
  "/status",
  "/golden-plate-winners",
  "/pensacola/spots",
  "/pensacola/report",
  "/parking-pass",
  "/p/",
  "/forgot-password",
  "/reset-password",
  "/ref/",
  "/change-password",
  "/account-setup",
  "/owner/verify",
  "/post-verification",
  "/admin",
  "/business-team/accept",
  "/menu/",
  "/checkout/",
  "/order-confirmation/",
];

const isPublicPath = (path: string) =>
  path === "/food-trucks" ||
  publicRoutePrefixes.some((prefix) =>
    prefix === "/" ? path === "/" : path.startsWith(prefix),
  ) || Boolean(parseCleanAffiliateBusinessRoute(path));

const shouldRenderShellNotFound = (path: string) => {
  if (/^\/owner\/ecosystem-sharing\/[^/]+$/.test(path)) return false;
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 2) return false;
  if (isPublicPath(path)) return false;
  if (
    /^\/(restaurant|truck|bar|caterer|private-chef|location|supplier)\/[^/]+(?:\/[^/]+)?$/i.test(
      path,
    )
  ) {
    return false;
  }
  return true;
};

// Wrapper component to handle route props
function DashboardSwitcherPage() {
  const urlParams = new URLSearchParams(window.location.search);
  const view = urlParams.get("view") as "admin" | "user" | "restaurant" | null;
  return <DashboardSwitcher defaultView={view || "admin"} />;
}

function GuestProtectedRoutes() {
  return (
    <>
      <Route path="/favorites" component={RedirectToLogin} />
      <Route path="/owner/ecosystem-sharing/:sourceId" component={RedirectToLogin} />
      <Route path="/restaurant-owner-dashboard" component={RedirectToLogin} />
      <Route path="/restaurant/dashboard" component={RedirectToLogin} />
      <Route path="/deal-edit/:dealId" component={RedirectToLogin} />
      <Route path="/subscribe" component={RedirectToLogin} />
      <Route path="/host/dashboard" component={RedirectToLogin} />
      <Route path="/event-coordinator/dashboard" component={RedirectToLogin} />
      <Route path="/truck-discovery" component={RedirectToLogin} />
      <Route path="/supply/orders" component={RedirectToLogin} />
      <Route path="/orders" component={RedirectToLogin} />
      <Route path="/merchant-promotions" component={RedirectToLogin} />
      <Route path="/profile" component={RedirectToLogin} />
      <Route path="/profile/notifications" component={RedirectToLogin} />
      <Route path="/settings" component={RedirectToLogin} />
      <Route path="/profile/addresses" component={RedirectToLogin} />
      <Route path="/profile/payment" component={RedirectToLogin} />
      <Route path="/profile/help" component={RedirectToLogin} />
      <Route path="/profile/reporter-reputation" component={RedirectToLogin} />
      <Route path="/supplier/dashboard" component={RedirectToLogin} />
      <Route path="/affiliate/earnings" component={RedirectToLogin} />
      <Route path="/parking-pass-manage" component={RedirectToLogin} />
      <Route path="/business-team" component={RedirectToLogin} />
      <Route path="/menu-builder" component={RedirectToLogin} />
      <Route path="/owner-ai" component={RedirectToLogin} />
      <Route path="/owner-ai/authorize" component={RedirectToLogin} />
      <Route path="/kitchen" component={RedirectToLogin} />
    </>
  );
}

function SharedPublicRoutes() {
  return (
    <>
      <Route path="/hiring" component={HiringPage} />
      <Route path="/jobs" component={HiringPage} />
      <Route path="/private-chefs" component={HiringPage} />
      <Route path="/search" component={Search} />
      <Route path="/trending" component={RedirectToScout} />
      <Route path="/map" component={RedirectToScout} />
      <Route path="/suppliers" component={SuppliersPage} />
      <Route path="/suppliers/:supplierId" component={SupplierDetailPage} />
      <Route path="/supplier/:slug/:refTag" component={PublicProfilePage} />
      <Route path="/supplier/:slug" component={PublicProfilePage} />
      <Route path="/video" component={VideoPage} />
      <Route path="/video/:id" component={VideoDetailPage} />
      <Route path="/category/:category" component={CategoryPage} />
      <Route path="/cuisine/:type" component={PublicSeoLandingPage} />
      <Route path="/deals" component={FeaturedDealsPage} />
      <Route path="/deals/featured" component={FeaturedDealsPage} />
      <Route
        path="/restaurant/:id/:profileSlug"
        component={PublicProfilePage}
      />
      <Route path="/restaurant/:id" component={PublicProfilePage} />
      <Route path="/truck/:slug/:refTag" component={PublicProfilePage} />
      <Route path="/truck/:slug" component={PublicProfilePage} />
      <Route path="/bar/:slug/:refTag" component={PublicProfilePage} />
      <Route path="/bar/:slug" component={PublicProfilePage} />
      <Route path="/caterer/:slug/:refTag" component={PublicProfilePage} />
      <Route path="/caterer/:slug" component={PublicProfilePage} />
      <Route path="/private-chef/:slug/:refTag" component={PublicProfilePage} />
      <Route path="/private-chef/:slug" component={PublicProfilePage} />
      <Route
        path="/location/:slug/food-trucks"
        component={LocationDetailPage}
      />
      <Route
        path="/location/:slug/food-trucks-now"
        component={LocationDiscoveryPage}
      />
      <Route
        path="/location/:slug/food-trucks-tonight"
        component={LocationDiscoveryPage}
      />
      <Route path="/location/:slug/:refTag" component={PublicProfilePage} />
      <Route path="/location/:slug" component={PublicProfilePage} />
      <Route path="/city/:city/food" component={PublicSeoLandingPage} />
      <Route path="/city/:city" component={CityLanding} />
      <Route path="/city/:city/:mode" component={CityDiscoveryPage} />
      <Route path="/food-trucks-today/:city" component={PublicSeoLandingPage} />
      <Route path="/food-truck-catering/:city" component={PublicSeoLandingPage} />
      <Route path="/book-food-truck/:city" component={PublicSeoLandingPage} />
      <Route path="/deals-today/:city" component={PublicSeoLandingPage} />
      <Route path="/events-today/:city" component={PublicSeoLandingPage} />
      <Route path="/cuisine/:cuisine/:city" component={PublicSeoLandingPage} />
      <Route
        path="/locations-with-trucks/:city"
        component={PublicSeoLandingPage}
      />
      <Route path="/terms-of-service" component={TermsOfService} />
      <Route path="/moderation-policy" component={ModerationPolicy} />
      <Route path="/privacy-policy" component={PrivacyPolicy} />
      <Route path="/data-deletion" component={DataDeletion} />
      <Route path="/about" component={About} />
      <Route path="/compare" component={ComparePage} />
      <Route path="/compare/doordash" component={CompareDoorDashPage} />
      <Route path="/compare/uber-eats" component={CompareUberEatsPage} />
      <Route path="/compare/grubhub" component={CompareGrubhubPage} />
      <Route
        path="/compare/:service/local/:city/:cuisine"
        component={ServiceCompareLandingPage}
      />
      <Route
        path="/delivery-app-alternatives"
        component={DeliveryAppAlternativesPage}
      />
      <Route
        path="/online-ordering-platforms"
        component={OnlineOrderingPlatformsPage}
      />
      <Route path="/faq" component={FAQ} />
      <Route path="/how-it-works" component={HowItWorks} />
      <Route path="/contact" component={Contact} />
      <Route path="/install" component={InstallApp} />
      <Route path="/host-signup" component={HostSignup} />
      <Route path="/profile-setup" component={ProfileSetupPage} />
      <Route path="/for-restaurants" component={ForRestaurants} />
      <Route path="/for-food-trucks" component={ForFoodTrucks} />
      <Route path="/for-bars" component={ForBars} />
      <Route path="/for-hosts" component={ForHosts} />
      <Route path="/for-events" component={ForEvents} />
      <Route
        path="/host-location-partner"
        component={HostLocationPartnerPage}
      />
      <Route path="/events" component={EventsRouter} />
      <Route path="/events/public" component={EventsPage} />
      <Route path="/event/:slug" component={EventDetailPage} />
      <Route path="/dashboard" component={DashboardRouter} />
      <Route path="/user-dashboard" component={UserDashboard} />
      <Route path="/food-trucks" component={RedirectToScout} />
      <Route
        path="/food-trucks/:citySlug/:cuisineSlug"
        component={PublicSeoLandingPage}
      />
      <Route path="/food-trucks/:citySlug" component={PublicSeoLandingPage} />
      <Route path="/sitemap" component={Sitemap} />
      <Route path="/status" component={StatusPage} />
      <Route path="/golden-plate-winners" component={GoldenPlateWinners} />
      <Route path="/p/:profileType/:profileId" component={PublicProfilePage} />
      <Route
        path="/p/:profileType/:profileId/:profileSlug"
        component={PublicProfilePage}
      />
      <Route path="/pensacola/spots" component={PensacolaSpots} />
      <Route path="/pensacola/report" component={PensacolaReport} />
      <Route path="/parking-pass" component={ParkingPassPage} />
      <Route path="/share-hub" component={ShareHubPage} />
      <Route path="/business-team/accept" component={BusinessTeamAcceptPage} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      <Route path="/ref/:tag" component={ReferralRedirect} />
      <Route path="/change-password" component={ChangePassword} />
      <Route path="/account-setup" component={AccountSetup} />
      <Route path="/owner/verify" component={AccountSetup} />
      <Route path="/post-verification" component={PostVerification} />
      <Route path="/menu/:restaurantId" component={OnlineMenuPage} />
      <Route path="/checkout/:restaurantId" component={PickupCheckoutPage} />
      <Route path="/merchant-delivery" component={MerchantDeliveryPage} />
      <Route
        path="/order-confirmation/:orderId"
        component={OrderConfirmationPage}
      />
    </>
  );
}

function Router() {
  const { authState, isAuthenticated, user } = useAuth();
  const { toast } = useToast();
  const shownAnnouncementRef = useRef<string>("");
  const [location] = useLocation();
  const isLikelyPublicRoute = isPublicPath(location);
  const shouldUseGuestRoutes =
    !isAuthenticated || (authState === "loading" && isLikelyPublicRoute);

  useEffect(() => {
    const message = String((user as any)?.loginAnnouncement || "").trim();
    if (!message) return;
    if (shownAnnouncementRef.current === message) return;
    shownAnnouncementRef.current = message;
    toast({
      title: "Partner Access Activated",
      description: message,
    });
  }, [user, toast]);

  // Canonical guard: never redirect until authState resolves
  if (authState === "loading" && !isLikelyPublicRoute) {
    return <PageLoader />;
  }

  return (
    <Suspense fallback={<PageLoader />}>
      <Switch>
        {shouldUseGuestRoutes ? (
          <>
            <Route path="/" component={Welcome} />
            <Route path="/scout" component={ScoutPageV2} />
            <Route path="/scout/:refTag" component={ScoutPageV2} />
            <Route path="/explore" component={RedirectToScout} />
            <Route path="/explore-preview" component={RedirectToScout} />
            <Route path="/directory" component={ScoutPageV2} />
            <Route path="/directory/:refTag" component={ScoutPageV2} />
            <Route path="/scout-prototype" component={RedirectToScout} />
            <Route path="/scout-v2" component={ScoutPageV2} />
            <Route path="/food-truck-rush" component={FoodTruckRush} />
            <Route path="/login" component={Login} />
            <Route path="/customer-signup" component={CustomerSignup} />
            <Route path="/customer-signup/:refTag" component={CustomerSignup} />
            <Route path="/restaurant-signup" component={RestaurantSignup} />
            <Route path="/claim-business" component={ClaimTruckPage} />
            <Route path="/claim-business/:refTag" component={ClaimTruckPage} />
            <Route path="/claim-truck" component={ClaimTruckPage} />
            <Route path="/claim-truck/:refTag" component={ClaimTruckPage} />
            <Route path="/deal-creation" component={DealCreation} />
            <Route path="/deal/:id" component={DealDetail} />
            {SharedPublicRoutes()}
            <Route path="/admin" component={AdminLogin} />
            <Route path="/admin/login" component={RedirectToAdmin} />
            <Route path="/admin/dashboard" component={RedirectToAdmin} />
            {GuestProtectedRoutes()}
            <Route
              path="/:businessSlug/:refTag"
              component={CleanPublicProfileRoute}
            />
            <Route path="/:businessSlug" component={CleanPublicProfileRoute} />
          </>
        ) : (
          <>
            <Route path="/" component={RedirectToScout} />
            <Route path="/scout" component={ScoutPageV2} />
            <Route path="/scout/:refTag" component={ScoutPageV2} />
            <Route path="/explore" component={RedirectToScout} />
            <Route path="/explore-preview" component={RedirectToScout} />
            <Route path="/directory" component={ScoutPageV2} />
            <Route path="/directory/:refTag" component={ScoutPageV2} />
            <Route path="/scout-prototype" component={RedirectToScout} />
            <Route path="/scout-v2" component={ScoutPageV2} />
            <Route path="/food-truck-rush" component={FoodTruckRush} />
            <Route path="/login" component={Login} />
            <Route path="/customer-signup" component={CustomerSignup} />
            <Route path="/customer-signup/:refTag" component={CustomerSignup} />
            <Route path="/restaurant-signup" component={RestaurantSignup} />
            <Route path="/claim-business" component={ClaimTruckPage} />
            <Route path="/claim-business/:refTag" component={ClaimTruckPage} />
            <Route path="/claim-truck" component={ClaimTruckPage} />
            <Route path="/claim-truck/:refTag" component={ClaimTruckPage} />
            <Route path="/deal-creation" component={DealCreation} />
            <Route path="/deal-edit/:dealId" component={DealEdit} />
            <Route path="/deal/:id" component={DealDetail} />
            <Route path="/subscribe" component={Subscribe} />
            <Route
              path="/restaurant-owner-dashboard"
              component={RestaurantOwnerDashboard}
            />
            <Route
              path="/restaurant/dashboard"
              component={RestaurantOwnerDashboard}
            />
            <Route path="/host/dashboard" component={HostDashboard} />
            <Route
              path="/event-coordinator/dashboard"
              component={EventCoordinatorDashboard}
            />
            <Route path="/truck-discovery" component={TruckDiscovery} />
            <Route path="/supply/orders" component={SupplyOrdersPage} />
            <Route path="/favorites" component={Favorites} />
            <Route path="/orders" component={Orders} />
            <Route path="/merchant-promotions" component={MerchantPromotions} />
            <Route path="/profile" component={Profile} />
            <Route
              path="/supplier/dashboard"
              component={SupplierDashboardPage}
            />
            <Route path="/affiliate/earnings" component={AffiliateEarnings} />
            <Route path="/staff" component={StaffDashboard} />
            <Route path="/admin" component={AdminDashboard} />
            <Route path="/admin/dashboard" component={RedirectToAdmin} />
            <Route path="/admin/login" component={RedirectToAdmin} />
            <Route path="/admin/incidents" component={AdminIncidents} />
            <Route
              path="/admin/control-center"
              component={AdminControlCenter}
            />
            <Route
              path="/admin/giveaway-wheel"
              component={AdminGiveawayWheel}
            />
            <Route path="/admin/tickets" component={AdminSupportTickets} />
            <Route path="/admin/moderation" component={AdminModerationEvents} />
            <Route path="/admin/moderation/queue" component={ModerationQueue} />
            <Route
              path="/admin/moderation/videos"
              component={AdminModerationVideos}
            />
            <Route
              path="/admin/moderation/metrics"
              component={AdminModerationMetrics}
            />
            <Route
              path="/admin/moderation/appeals"
              component={AdminModerationAppeals}
            />
            <Route path="/admin/audit-logs" component={AdminAuditLogs} />
            <Route path="/admin/vac-logs" component={AdminVacLogs} />
            <Route path="/admin/telemetry" component={AdminTelemetry} />
            <Route
              path="/admin/discovery-observatory"
              component={AdminDiscoveryObservatory}
            />
            <Route path="/admin/geo-ads" component={AdminGeoAds} />
            <Route path="/admin/geo/heatmap" component={AdminMarketHeatmap} />
            <Route
              path="/admin/affiliates"
              component={AdminAffiliateManagement}
            />
            <Route path="/admin/switcher" component={DashboardSwitcherPage} />
            <Route path="/admin/oauth-setup" component={OAuthSetupGuide} />
            <Route
              path="/profile/notifications"
              component={RedirectToSettingsNotifications}
            />
            <Route path="/settings" component={SettingsPage} />
            <Route path="/profile/addresses" component={RedirectToSettingsAccount} />
            <Route path="/profile/payment" component={RedirectToSettingsAccount} />
            <Route path="/profile/help" component={RedirectToHelp} />
            <Route
              path="/profile/reporter-reputation"
              component={ReporterReputationPage}
            />
            <Route
              path="/restaurant/:restaurantId/reviews"
              component={ReviewsPage}
            />
            {SharedPublicRoutes()}
            <Route path="/parking-pass-manage" component={ParkingPassManage} />
            <Route path="/business-team" component={BusinessTeamPage} />
            <Route path="/menu-builder" component={MenuBuilderPage} />
            <Route path="/owner-ai" component={OwnerAiActionsPage} />
            <Route path="/owner/ecosystem-sharing/:sourceId" component={EcosystemSharingPage} />
            <Route path="/owner-ai/authorize" component={OwnerAiAuthorizePage} />
            <Route path="/kitchen" component={KitchenDisplayPage} />
            <Route
              path="/:businessSlug/:refTag"
              component={CleanPublicProfileRoute}
            />
            <Route path="/:businessSlug" component={CleanPublicProfileRoute} />
          </>
        )}
      </Switch>
    </Suspense>
  );
}

function App() {
  const [location] = useLocation();
  const currentPath = location.split("?")[0];
  const isShellNotFound = shouldRenderShellNotFound(currentPath);
  const isPublicProfilePath =
    currentPath.startsWith("/p/") ||
    Boolean(parseCleanAffiliateBusinessRoute(currentPath)) ||
    /^\/(restaurant|truck|bar|location|supplier)\/[^/]+(?:\/[^/]+)?$/i.test(
      currentPath,
    );
  const usesSelfContainedConsumerShell =
    isPublicProfilePath ||
    currentPath.startsWith("/menu/") ||
    currentPath.startsWith("/checkout/") ||
    currentPath.startsWith("/order-confirmation/");
  const usesCinematicBackground =
    currentPath === "/" || currentPath === "/food-truck-rush";
  const usesBusinessWorkspace =
    currentPath.startsWith("/owner/ecosystem-sharing/") ||
    currentPath === "/restaurant-owner-dashboard" ||
    currentPath === "/menu-builder" ||
    currentPath === "/owner-ai" ||
    currentPath === "/deal-creation" ||
    currentPath.startsWith("/deal-edit/") ||
    currentPath === "/orders" ||
    currentPath === "/kitchen";

  if (isShellNotFound) {
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ScoutNavSearchProvider>
            <GlobalNavigationOwnerProvider>
              <TimeOfDayBackground appearance="day" />
              <div className="app-background app-content min-h-screen pb-[calc(var(--scout-nav-height,58px)+env(safe-area-inset-bottom,0px))] lg:pb-0 lg:pt-16 relative z-10">
                <Toaster />
                <NotFound />
                <Navigation scope="global" />
              </div>
            </GlobalNavigationOwnerProvider>
          </ScoutNavSearchProvider>
        </TooltipProvider>
      </QueryClientProvider>
    );
  }

  if (usesSelfContainedConsumerShell) {
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ScoutNavSearchProvider>
            <TimeOfDayBackground appearance="day" />
            <div className="relative z-10 min-h-screen">
              <Toaster />
              <Router />
            </div>
          </ScoutNavSearchProvider>
        </TooltipProvider>
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ScoutNavSearchProvider>
          <GlobalNavigationOwnerProvider>
            <TimeOfDayBackground
              appearance={usesCinematicBackground ? "night" : "day"}
            />
            <div
              data-app-surface={usesCinematicBackground ? "cinematic" : "day"}
              className={`app-background app-content min-h-screen pb-[calc(var(--scout-nav-height,58px)+env(safe-area-inset-bottom,0px))] lg:pb-0 relative z-10 ${usesBusinessWorkspace ? "lg:pt-0" : "lg:pt-16"}`}
            >
              <Toaster />
              <Router />
              <Navigation scope="global" />
            </div>
          </GlobalNavigationOwnerProvider>
        </ScoutNavSearchProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
