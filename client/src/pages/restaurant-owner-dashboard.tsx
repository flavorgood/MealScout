import { useState, useEffect, useRef } from "react";
import {
  isBarBusinessType,
  isTruckBusinessType,
  resolveStoredFoodBusinessType,
} from "@shared/businessTypes";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  resolveCanonicalShareUrl,
  resolveCanonicalShareUrlSync,
} from "@/lib/share";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useLocation, useSearch } from "wouter";
import ShareButton from "@/components/share-button";
import {
  Store,
  Plus,
  TrendingUp,
  Users,
  DollarSign,
  Eye,
  ShoppingCart,
  Heart,
  Calendar,
  Settings,
  CreditCard,
  BarChart3,
  MapPin,
  Clock,
  Edit,
  Download,
  Calendar as CalendarIcon,
  RefreshCw,
  Truck,
  Radio,
  WifiOff,
  AlertCircle,
  CheckCircle,
  Play,
  Square,
  Loader2,
  Zap,
  Save,
  RotateCcw,
  Trash2,
  QrCode,
  Copy,
  Sparkles,
} from "lucide-react";
import BusinessWorkspaceShell, {
  type BusinessWorkspaceModuleId,
} from "@/components/business-workspace-shell";
import OwnerProfileWorkspace, {
  type OwnerProfileDraft,
  type OwnerProfileMediaItem,
} from "@/components/owner-profile-workspace";
import OwnerProfileEvidenceReview from "@/components/owner-profile-evidence-review";
import OwnerDealsWorkspace from "@/components/owner-deals-workspace";
import OwnerAudienceWorkspace from "@/components/owner-audience-workspace";
import { format, subDays, startOfMonth, endOfMonth } from "date-fns";
import { useFoodTruckSocket } from "@/hooks/useFoodTruckSocket";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { z } from "zod";
import type { Restaurant } from "@shared/schema";
import type { PublicRestaurantProfile } from "@shared/publicProfiles";
import type {
  ProfileEvidenceOwnerReviewDto,
  ProfileEvidenceReviewField,
} from "@shared/profileEvidenceReview";
import type { ProfileCompletionTruth } from "@shared/profileCompletionStatus";
import { SEOHead } from "@/components/seo-head";
import { buildPublicProfilePath } from "@/lib/public-profile-path";
import {
  fetchOwnerValueAttribution,
  type OwnerValueAttributionEntity,
  type OwnerValueAttributionResponse,
} from "@/lib/owner-value-attribution-client";
import LongPressHelp from "@/components/long-press-help";
import {
  getScopedBusinessPermissions,
  isScopedBusinessOwner,
  type BusinessAccessContext,
} from "@/lib/business-access";
import { buildOwnerAiHref } from "@shared/ownerAiNavigation";

interface DashboardStats {
  totalDeals: number;
  activeDeals: number;
  totalViews: number;
  totalClaims: number;
  conversionRate: number;
}

interface FavoritesAnalytics {
  totalFavorites: number;
  newFavorites: number;
  favoritesGrowth: number;
}

interface RecommendationsAnalytics {
  totalRecommendations: number;
  clickThroughRate: number;
  impressions: number;
  clicks: number;
}

interface TruckBookingItem {
  id: string;
  eventId: string;
  truckId: string;
  status: string;
  totalCents: number;
  hostPriceCents: number;
  platformFeeCents: number;
  bookingConfirmedAt?: string | null;
  cancelledAt?: string | null;
  createdAt?: string | null;
  event?: {
    id: string;
    date?: string | null;
    startTime?: string | null;
    endTime?: string | null;
    status?: string | null;
    host?: {
      businessName?: string | null;
      address?: string | null;
      locationType?: string | null;
    };
  } | null;
}

const buildOwnerProfileDraft = (
  restaurant: Restaurant | Record<string, any>,
): OwnerProfileDraft => {
  const row: any = restaurant;
  const actionLinks =
    row?.socialAutopostSettings &&
    typeof row.socialAutopostSettings === "object" &&
    typeof row.socialAutopostSettings.publicActionLinks === "object"
      ? row.socialAutopostSettings.publicActionLinks
      : {};
  return {
    isActive: row?.isActive !== false,
    name: String(row?.name || ""),
    description: String(row?.description || ""),
    cuisineType: String(row?.cuisineType || ""),
    businessType: resolveStoredFoodBusinessType(row) || "restaurant",
    address: String(row?.address || ""),
    city: String(row?.city || ""),
    state: String(row?.state || ""),
    phone: String(row?.phone || ""),
    websiteUrl: String(row?.websiteUrl || ""),
    facebookPageUrl: String(row?.facebookPageUrl || ""),
    instagramUrl: String(row?.instagramUrl || ""),
    xUrl: String(row?.xUrl || ""),
    menuUrl: String(row?.menuUrl || ""),
    onlineOrderingUrl: String(
      row?.onlineOrderingUrl || actionLinks?.onlineOrderingUrl || "",
    ),
    deliveryUrl: String(row?.deliveryUrl || actionLinks?.deliveryUrl || ""),
    doordashUrl: String(row?.doordashUrl || actionLinks?.doordashUrl || ""),
    uberEatsUrl: String(row?.uberEatsUrl || actionLinks?.uberEatsUrl || ""),
    toastUrl: String(row?.toastUrl || actionLinks?.toastUrl || ""),
    squareUrl: String(row?.squareUrl || actionLinks?.squareUrl || ""),
    chowNowUrl: String(row?.chowNowUrl || actionLinks?.chowNowUrl || ""),
    grubhubUrl: String(row?.grubhubUrl || actionLinks?.grubhubUrl || ""),
    cateringInquiryUrl: String(
      row?.cateringInquiryUrl || actionLinks?.cateringInquiryUrl || "",
    ),
    truckBookingInquiryUrl: String(
      row?.truckBookingInquiryUrl ||
        actionLinks?.truckBookingInquiryUrl ||
        "",
    ),
    logoUrl: String(row?.logoUrl || ""),
    coverImageUrl: String(row?.coverImageUrl || ""),
  };
};

type PublicProfileQrPayload = Pick<
  PublicRestaurantProfile,
  "seo" | "menuSections" | "menuUrl" | "menuPdfUrl" | "menuImageUrl" | "deals"
>;

export default function RestaurantOwnerDashboard() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const dashboardSearch = useSearch();
  const { toast } = useToast();
  const [selectedRestaurant, setSelectedRestaurant] = useState<string>("");
  const dashboardParams = new URLSearchParams(dashboardSearch);
  const requestedRestaurantId = dashboardParams.get("restaurantId");
  const setupMode = dashboardParams.get("setup");
  const workspaceMode = dashboardParams.get("workspace");
  const [analyticsDateRange, setAnalyticsDateRange] = useState({
    start: format(subDays(new Date(), 30), "yyyy-MM-dd"),
    end: format(new Date(), "yyyy-MM-dd"),
  });
  const [ownerValueWindow, setOwnerValueWindow] = useState<"7d" | "30d">("30d");
  const [comparisonPeriod, setComparisonPeriod] = useState<
    "week" | "month" | "quarter"
  >("month");
  const [profileDraft, setProfileDraft] = useState<OwnerProfileDraft>({
    isActive: true,
    name: "",
    description: "",
    cuisineType: "",
    businessType: "",
    address: "",
    city: "",
    state: "",
    phone: "",
    websiteUrl: "",
    facebookPageUrl: "",
    instagramUrl: "",
    xUrl: "",
    menuUrl: "",
    onlineOrderingUrl: "",
    deliveryUrl: "",
    doordashUrl: "",
    uberEatsUrl: "",
    toastUrl: "",
    squareUrl: "",
    chowNowUrl: "",
    grubhubUrl: "",
    cateringInquiryUrl: "",
    truckBookingInquiryUrl: "",
    logoUrl: "",
    coverImageUrl: "",
  });
  const [profileDraftNeedsRefresh, setProfileDraftNeedsRefresh] =
    useState(false);
  const [mediaCategory, setMediaCategory] = useState<string>("food");
  const setupPanelRef = useRef<HTMLDivElement | null>(null);

  // Food truck state
  const [isBroadcasting, setIsBroadcasting] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<{
    lat: number;
    lng: number;
    accuracy?: number;
    timestamp?: number;
  } | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [gpsWatchId, setGpsWatchId] = useState<number | null>(null);
  const [lastBroadcast, setLastBroadcast] = useState<Date | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<
    "connected" | "disconnected" | "connecting"
  >("disconnected");
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [bookingToCancel, setBookingToCancel] =
    useState<TruckBookingItem | null>(null);
  const hasWarnedFallbackAccuracyRef = useRef(false);

  const isRestaurantOwner = user?.userType === "restaurant_owner";
  const isFoodTruck = user?.userType === "food_truck";
  const isHost = user?.userType === "host";
  const isAdmin =
    user?.userType === "admin" ||
    user?.userType === "duper_admin" ||
    user?.userType === "super_admin";
  const isStaff = user?.userType === "staff";
  const { data: businessAccess } = useQuery<BusinessAccessContext>({
    queryKey: ["/api/business-access/me"],
    enabled: !!user,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const scopedBusinessPermissions = getScopedBusinessPermissions(
    businessAccess,
    selectedRestaurant,
  );
  const ownsSelectedBusiness = isScopedBusinessOwner(
    businessAccess,
    selectedRestaurant,
  );
  const canManageDeals =
    isAdmin ||
    isStaff ||
    ownsSelectedBusiness ||
    scopedBusinessPermissions.manageDeals;
  const canManageParkingPass =
    isAdmin ||
    isStaff ||
    ownsSelectedBusiness ||
    scopedBusinessPermissions.manageParkingPass;
  const canViewAnalytics =
    isAdmin ||
    isStaff ||
    ownsSelectedBusiness ||
    scopedBusinessPermissions.viewAnalytics;
  const canManageProfile =
    isAdmin ||
    isStaff ||
    ownsSelectedBusiness ||
    scopedBusinessPermissions.manageProfile;

  useEffect(() => {
    if (!user) return;

    // Restaurant owners and food trucks share this dashboard, plus staff/admin access.
    const hasTeamAccess = Boolean(businessAccess?.hasAnyAccess);
    if (
      !isRestaurantOwner &&
      !isFoodTruck &&
      !isHost &&
      !isAdmin &&
      !isStaff &&
      !hasTeamAccess
    ) {
      setLocation("/");
    }
  }, [
    user,
    isRestaurantOwner,
    isFoodTruck,
    isHost,
    isAdmin,
    isStaff,
    businessAccess?.hasAnyAccess,
    setLocation,
  ]);

  // Location update state
  const [isUpdatingLocation, setIsUpdatingLocation] = useState(false);
  const [locationUpdateError, setLocationUpdateError] = useState<string | null>(
    null,
  );

  // WebSocket integration for real-time updates
  const {
    subscribeToRestaurant,
    connect: connectWS,
    disconnect: disconnectWS,
  } = useFoodTruckSocket({
    onLocationUpdate: (location) => {
      console.log("Received location update:", location);
      // Update UI with real-time location data from other sources if needed
    },
    onStatusUpdate: (status) => {
      console.log("Received status update:", status);
      // Handle status updates from server
    },
    autoConnect: false,
  });

  // Fetch user's restaurants
  const {
    data: restaurants = [],
    isLoading: loadingRestaurants,
    refetch: refetchRestaurants,
  } = useQuery<Restaurant[]>({
    queryKey: ["/api/restaurants/my-restaurants"],
    enabled: !!user,
  });

  const hasProfileLocationTools = canManageParkingPass;
  const hasAnalyticsAccess = canViewAnalytics;
  // The routed Audience workspace owns served analytics. Keep the legacy query
  // definitions inert until their hidden JSX is removed in the cleanup pass.
  const legacyAnalyticsEnabled = false;
  const canManageBilling = isAdmin || isStaff || ownsSelectedBusiness;

  // Fetch favorites analytics for paid users
  const { data: favoritesAnalytics, isLoading: loadingFavorites } =
    useQuery<FavoritesAnalytics>({
      queryKey: [
        `/api/restaurants/${selectedRestaurant}/analytics/favorites`,
        analyticsDateRange,
      ],
      queryFn: async () => {
        const response = await fetch(
          `/api/restaurants/${selectedRestaurant}/analytics/favorites?start=${encodeURIComponent(
            analyticsDateRange.start,
          )}&end=${encodeURIComponent(analyticsDateRange.end)}`,
          { credentials: "include" },
        );
        if (!response.ok) throw new Error("Failed to load favorites analytics");
        return response.json();
      },
      enabled:
        legacyAnalyticsEnabled && !!selectedRestaurant && hasAnalyticsAccess,
    });

  // Fetch recommendations analytics for paid users
  const { data: recommendationsAnalytics, isLoading: loadingRecommendations } =
    useQuery<RecommendationsAnalytics>({
      queryKey: [
        `/api/restaurants/${selectedRestaurant}/analytics/recommendations`,
        analyticsDateRange,
      ],
      queryFn: async () => {
        const response = await fetch(
          `/api/restaurants/${selectedRestaurant}/analytics/recommendations?start=${encodeURIComponent(
            analyticsDateRange.start,
          )}&end=${encodeURIComponent(analyticsDateRange.end)}`,
          { credentials: "include" },
        );
        if (!response.ok) {
          throw new Error("Failed to load recommendations analytics");
        }
        return response.json();
      },
      enabled:
        legacyAnalyticsEnabled && !!selectedRestaurant && hasAnalyticsAccess,
    });

  const {
    data: truckBookings = [],
    isLoading: loadingTruckBookings,
    isError: truckBookingsFailed,
  } = useQuery<TruckBookingItem[]>({
      queryKey: ["/api/bookings/my-truck", selectedRestaurant],
      queryFn: async () => {
        const response = await fetch(
          `/api/bookings/my-truck?truckId=${encodeURIComponent(selectedRestaurant)}`,
          { credentials: "include" },
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.message || "Failed to load booked stops");
        }
        return Array.isArray(payload) ? payload : [];
      },
      enabled: !!user && !!selectedRestaurant && canManageParkingPass,
    });

  // Fetch dashboard stats
  const { data: stats } = useQuery<DashboardStats>({
    queryKey: [`/api/restaurants/${selectedRestaurant}/stats`],
    enabled:
      !!selectedRestaurant &&
      (canManageDeals || canViewAnalytics || canManageProfile),
  });

  // Fetch advanced analytics
  const { data: analyticsSummary, isLoading: loadingAnalytics } = useQuery({
    queryKey: [
      "/api/restaurants",
      selectedRestaurant,
      "analytics/summary",
      analyticsDateRange,
    ],
    queryFn: async () => {
      const response = await fetch(
        `/api/restaurants/${selectedRestaurant}/analytics/summary?start=${encodeURIComponent(
          analyticsDateRange.start,
        )}&end=${encodeURIComponent(analyticsDateRange.end)}`,
        { credentials: "include" },
      );
      if (!response.ok) throw new Error("Failed to load analytics summary");
      return response.json();
    },
    enabled:
      legacyAnalyticsEnabled && !!selectedRestaurant && hasAnalyticsAccess,
  });

  const { data: analyticsTimeseries } = useQuery({
    queryKey: [
      "/api/restaurants",
      selectedRestaurant,
      "analytics/timeseries",
      analyticsDateRange,
    ],
    queryFn: async () => {
      const response = await fetch(
        `/api/restaurants/${selectedRestaurant}/analytics/timeseries?startDate=${encodeURIComponent(
          analyticsDateRange.start,
        )}&endDate=${encodeURIComponent(analyticsDateRange.end)}`,
        { credentials: "include" },
      );
      if (response.status === 400) return [];
      if (!response.ok) throw new Error("Failed to load analytics timeseries");
      return response.json();
    },
    enabled:
      legacyAnalyticsEnabled && !!selectedRestaurant && hasAnalyticsAccess,
  });

  const { data: customerInsights } = useQuery({
    queryKey: [
      "/api/restaurants",
      selectedRestaurant,
      "analytics/customers",
      analyticsDateRange,
    ],
    queryFn: async () => {
      const response = await fetch(
        `/api/restaurants/${selectedRestaurant}/analytics/customers?start=${encodeURIComponent(
          analyticsDateRange.start,
        )}&end=${encodeURIComponent(analyticsDateRange.end)}`,
        { credentials: "include" },
      );
      if (!response.ok) throw new Error("Failed to load customer insights");
      return response.json();
    },
    enabled:
      legacyAnalyticsEnabled && !!selectedRestaurant && hasAnalyticsAccess,
  });

  const { data: comparison } = useQuery({
    queryKey: [
      "/api/restaurants",
      selectedRestaurant,
      "analytics/compare",
      comparisonPeriod,
    ],
    queryFn: () => {
      const currentEnd = new Date(analyticsDateRange.end);
      const currentStart = new Date(analyticsDateRange.start);
      const daysDiff = Math.ceil(
        (currentEnd.getTime() - currentStart.getTime()) / (1000 * 60 * 60 * 24),
      );
      const previousStart = new Date(
        currentStart.getTime() - daysDiff * 24 * 60 * 60 * 1000,
      );
      const previousEnd = new Date(
        currentStart.getTime() - 24 * 60 * 60 * 1000,
      );

      return apiRequest(
        "GET",
        `/api/restaurants/${selectedRestaurant}/analytics/compare?currentStart=${currentStart.toISOString()}&currentEnd=${currentEnd.toISOString()}&previousStart=${previousStart.toISOString()}&previousEnd=${previousEnd.toISOString()}`,
      );
    },
    enabled:
      legacyAnalyticsEnabled && !!selectedRestaurant && hasAnalyticsAccess,
  });

  // Calculate distance between two GPS coordinates
  const getDistance = (
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ) => {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lng2 - lng1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Distance in meters
  };

  // Food truck mutations - declared early to avoid hoisting issues
  const updateLocationMutation = useMutation({
    mutationFn: async (location: {
      lat: number;
      lng: number;
      accuracy?: number;
      heading?: number;
      speed?: number;
    }) => {
      return await apiRequest(
        "POST",
        `/api/restaurants/${selectedRestaurant}/location`,
        {
          sessionId,
          latitude: location.lat,
          longitude: location.lng,
          accuracy: location.accuracy,
          heading: location.heading,
          speed: location.speed,
          source: "gps",
        },
      );
    },
    onSuccess: () => {
      setLastBroadcast(new Date());
    },
    onError: (error: any) => {
      console.error("Location update failed:", error);
      setLocationError("Failed to update location");
    },
  });

  const stopFoodTruckSessionMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest(
        "POST",
        `/api/restaurants/${selectedRestaurant}/truck-session/end`,
        {
          sessionId,
        },
      );
    },
    onSuccess: () => {
      setIsBroadcasting(false);
      setSessionId(null);
      setConnectionStatus("disconnected");

      // Disconnect WebSocket
      disconnectWS();

      if (gpsWatchId) {
        navigator.geolocation.clearWatch(gpsWatchId);
        setGpsWatchId(null);
      }
      toast({
        title: "Live location stopped",
        description: "Customers will now see your saved location instead.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Could not stop live location",
        description: error.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  // Set default restaurant
  useEffect(() => {
    if (
      requestedRestaurantId &&
      restaurants.some((restaurant) => restaurant.id === requestedRestaurantId)
    ) {
      setSelectedRestaurant(requestedRestaurantId);
      return;
    }
    if (restaurants.length > 0 && !selectedRestaurant) {
      setSelectedRestaurant(restaurants[0].id);
    }
  }, [requestedRestaurantId, restaurants, selectedRestaurant]);

  useEffect(() => {
    if (setupMode !== "menu") return;
    const hasCurrentRestaurant = restaurants.some(
      (restaurant) => restaurant.id === selectedRestaurant,
    );
    if (!hasCurrentRestaurant) return;
    const frame = window.requestAnimationFrame(() => {
      if (setupPanelRef.current) {
        setupPanelRef.current.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [setupMode, restaurants, selectedRestaurant]);

  useEffect(() => {
    if (workspaceMode !== "deals" && workspaceMode !== "audience") return;
    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById("owner-workspace-operations")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [workspaceMode, selectedRestaurant]);

  // Get current restaurant data
  const currentRestaurant = restaurants.find(
    (r) => r.id === selectedRestaurant,
  );
  const currentIsTruckBusiness = Boolean(
    currentRestaurant?.isFoodTruck ||
    isTruckBusinessType(currentRestaurant?.businessType),
  );
  const currentIsBarBusiness = isBarBusinessType(
    currentRestaurant?.businessType,
  );
  const currentPublicEntityType = currentIsTruckBusiness
    ? "truck"
    : currentIsBarBusiness
      ? "bar"
      : currentRestaurant?.businessType === "caterer"
        ? "caterer"
        : currentRestaurant?.businessType === "private_chef"
          ? "private_chef"
      : "restaurant";
  const currentPublicProfileHref = currentRestaurant
    ? buildPublicProfilePath({
        entityType: currentPublicEntityType,
        id: currentRestaurant.id,
        name: currentRestaurant.name,
      })
    : null;
  const currentDatedStopScheduleHref = `/parking-pass?setup=schedule&truckId=${encodeURIComponent(
    String(selectedRestaurant),
  )}`;
  const activeWorkspaceModule: BusinessWorkspaceModuleId =
    setupMode === "profile"
      ? "profile"
      : setupMode === "profile-media"
        ? "media"
        : setupMode === "schedule" || setupMode === "bookings"
          ? "availability"
          : setupMode === "menu"
            ? "menu"
            : workspaceMode === "deals"
              ? "deals"
              : workspaceMode === "audience" || setupMode === "analytics"
                ? "audience"
                : "overview";
  const workspaceCapabilities = {
    overview: canManageProfile,
    profile: canManageProfile,
    menu: canManageProfile,
    availability: canManageParkingPass,
    media: canManageProfile,
    deals: canManageDeals,
    work: canManageParkingPass,
    audience: canViewAnalytics,
    team: canManageBilling,
    payments: canManageBilling,
    settings: canManageProfile,
  };
  const canOpenActiveWorkspaceModule =
    workspaceCapabilities[activeWorkspaceModule] !== false;
  const {
    data: profileEvidenceReview,
    isLoading: loadingProfileEvidenceReview,
    isFetching: refreshingProfileEvidenceReview,
    isError: profileEvidenceReviewError,
    error: profileEvidenceReviewErrorDetail,
    refetch: refetchProfileEvidenceReview,
  } = useQuery<ProfileEvidenceOwnerReviewDto>({
    queryKey: [
      "/api/restaurants",
      selectedRestaurant,
      "profile-evidence-review",
    ],
    enabled: Boolean(
      selectedRestaurant &&
        canManageProfile &&
        (activeWorkspaceModule === "overview" || setupMode === "profile"),
    ),
    queryFn: async () => {
      const response = await apiRequest(
        "GET",
        `/api/restaurants/${encodeURIComponent(String(selectedRestaurant))}/profile-evidence-review`,
      );
      return (await response.json()) as ProfileEvidenceOwnerReviewDto;
    },
    staleTime: 30_000,
  });
  const currentMenuApproval = (currentRestaurant as any)?.menuApproval || null;
  const menuApprovalRequired = Boolean(
    currentMenuApproval?.ownerApprovalRequired && currentIsTruckBusiness,
  );
  const { data: publicProfileForQr } = useQuery<PublicProfileQrPayload | null>({
    queryKey: [
      "/api/public/profiles",
      currentPublicEntityType,
      selectedRestaurant,
      "qr-kit",
    ],
    enabled: Boolean(selectedRestaurant),
    queryFn: async () => {
      const response = await fetch(
        `/api/public/profiles/${encodeURIComponent(currentPublicEntityType)}/${encodeURIComponent(String(selectedRestaurant))}`,
      );
      if (!response.ok) return null;
      return response.json();
    },
    staleTime: 60_000,
  });
  const {
    data: ownerValueAttribution,
    isLoading: loadingOwnerValueAttribution,
    isError: ownerValueAttributionError,
  } = useQuery<OwnerValueAttributionResponse>({
    queryKey: ["/api/owner/value-attribution", ownerValueWindow],
    enabled: Boolean(selectedRestaurant),
    queryFn: () => fetchOwnerValueAttribution(ownerValueWindow),
    staleTime: 60_000,
  });

  const buildQrImageUrl = (targetUrl: string) =>
    `https://api.qrserver.com/v1/create-qr-code/?size=512x512&margin=16&data=${encodeURIComponent(targetUrl)}`;
  const trackOwnerCompletionAction = async (params: {
    entityId: string;
    entityType: "restaurant" | "truck" | "bar";
    missingItemKey: string;
  }) => {
    try {
      await fetch("/api/owner/profile-completion-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityId: params.entityId,
          entityType: params.entityType,
          missingItemKey: params.missingItemKey,
        }),
        keepalive: true,
      });
    } catch {
      // tracking must never block owner navigation
    }
  };
  const downloadQrPng = (targetUrl: string, filename: string) => {
    const link = document.createElement("a");
    link.href = buildQrImageUrl(targetUrl);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  const downloadBrandedQrAsset = async (options: {
    title: string;
    subtitle: string;
    targetUrl: string;
    filename: string;
  }) => {
    const qrUrl = buildQrImageUrl(options.targetUrl);
    const businessName = String(
      currentRestaurant?.name || "MealScout Business",
    );
    try {
      const qrImage = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("QR image failed to load."));
        img.src = qrUrl;
      });

      const canvas = document.createElement("canvas");
      canvas.width = 1200;
      canvas.height = 1800;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable.");

      const gradient = ctx.createLinearGradient(
        0,
        0,
        canvas.width,
        canvas.height,
      );
      gradient.addColorStop(0, "#0f0d0b");
      gradient.addColorStop(1, "#1a120d");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = "#15100b";
      ctx.strokeStyle = "rgba(249,115,22,0.38)";
      ctx.lineWidth = 4;
      const cardX = 64;
      const cardY = 64;
      const cardW = canvas.width - 128;
      const cardH = canvas.height - 128;
      ctx.beginPath();
      ctx.roundRect(cardX, cardY, cardW, cardH, 44);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#fb923c";
      ctx.font = "800 52px Inter, Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("MealScout", canvas.width / 2, 200);

      ctx.fillStyle = "#ffffff";
      ctx.font = "900 64px Inter, Arial, sans-serif";
      ctx.fillText(options.title, canvas.width / 2, 300);
      ctx.font = "500 34px Inter, Arial, sans-serif";
      ctx.fillStyle = "#fcd9be";
      ctx.fillText(options.subtitle, canvas.width / 2, 360);

      const qrFrameX = 300;
      const qrFrameY = 440;
      const qrFrameSize = 600;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.roundRect(qrFrameX, qrFrameY, qrFrameSize, qrFrameSize, 30);
      ctx.fill();
      ctx.drawImage(
        qrImage,
        qrFrameX + 48,
        qrFrameY + 48,
        qrFrameSize - 96,
        qrFrameSize - 96,
      );

      ctx.fillStyle = "#ffffff";
      ctx.font = "800 54px Inter, Arial, sans-serif";
      ctx.fillText(businessName, canvas.width / 2, 1160);
      ctx.fillStyle = "#fcd9be";
      ctx.font = "500 30px Inter, Arial, sans-serif";
      ctx.fillText("Open your camera and scan", canvas.width / 2, 1230);
      ctx.fillText(
        "Profile, menu, specials, and local discovery",
        canvas.width / 2,
        1274,
      );

      const pngUrl = canvas.toDataURL("image/png");
      const link = document.createElement("a");
      link.href = pngUrl;
      link.download = options.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error: any) {
      toast({
        title: "Asset download failed",
        description:
          error?.message || "Unable to generate branded print asset.",
        variant: "destructive",
      });
    }
  };
  const downloadAllBrandedQrAssets = async (
    assets: Array<{
      title: string;
      subtitle: string;
      targetUrl: string;
      filename: string;
    }>,
  ) => {
    if (!assets.length) {
      toast({
        title: "No assets available",
        description: "Add profile content first to unlock downloadable assets.",
      });
      return;
    }

    for (const asset of assets) {
      await downloadBrandedQrAsset(asset);
      await new Promise((resolve) => setTimeout(resolve, 220));
    }

    toast({
      title: "Batch export started",
      description: `Downloaded ${assets.length} available assets.`,
    });
  };
  const downloadSocialQrGraphic = async (options: {
    title: string;
    subtitle: string;
    cta: string;
    targetUrl: string;
    filename: string;
    format: "square" | "story" | "portrait";
  }) => {
    const qrUrl = buildQrImageUrl(options.targetUrl);
    const businessName = String(
      currentRestaurant?.name || "MealScout Business",
    );
    const sizeByFormat: Record<
      "square" | "story" | "portrait",
      { width: number; height: number; tag: string }
    > = {
      square: { width: 1080, height: 1080, tag: "Square post" },
      story: { width: 1080, height: 1920, tag: "Story" },
      portrait: { width: 1080, height: 1350, tag: "Portrait" },
    };

    try {
      const qrImage = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("QR image failed to load."));
        img.src = qrUrl;
      });

      const size = sizeByFormat[options.format];
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable.");

      const gradient = ctx.createLinearGradient(
        0,
        0,
        canvas.width,
        canvas.height,
      );
      gradient.addColorStop(0, "#0f0d0b");
      gradient.addColorStop(1, "#1a120d");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const pad = Math.round(Math.min(canvas.width, canvas.height) * 0.06);
      const cardX = pad;
      const cardY = pad;
      const cardW = canvas.width - pad * 2;
      const cardH = canvas.height - pad * 2;
      ctx.fillStyle = "#15100b";
      ctx.strokeStyle = "rgba(249,115,22,0.36)";
      ctx.lineWidth = Math.max(3, Math.round(canvas.width * 0.0035));
      ctx.beginPath();
      ctx.roundRect(
        cardX,
        cardY,
        cardW,
        cardH,
        Math.round(canvas.width * 0.04),
      );
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = "center";
      ctx.fillStyle = "#fb923c";
      ctx.font = `800 ${Math.round(canvas.width * 0.048)}px Inter, Arial, sans-serif`;
      ctx.fillText(
        "MealScout",
        canvas.width / 2,
        cardY + Math.round(canvas.height * 0.1),
      );

      ctx.fillStyle = "#ffffff";
      ctx.font = `900 ${Math.round(canvas.width * 0.058)}px Inter, Arial, sans-serif`;
      ctx.fillText(
        options.title,
        canvas.width / 2,
        cardY + Math.round(canvas.height * 0.155),
      );
      ctx.fillStyle = "#fcd9be";
      ctx.font = `600 ${Math.round(canvas.width * 0.03)}px Inter, Arial, sans-serif`;
      ctx.fillText(
        options.subtitle,
        canvas.width / 2,
        cardY + Math.round(canvas.height * 0.195),
      );

      const qrFrame = Math.round(Math.min(canvas.width, canvas.height) * 0.48);
      const qrFrameX = Math.round((canvas.width - qrFrame) / 2);
      const qrFrameY =
        options.format === "story"
          ? Math.round(canvas.height * 0.39)
          : Math.round(canvas.height * 0.29);
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.roundRect(
        qrFrameX,
        qrFrameY,
        qrFrame,
        qrFrame,
        Math.round(canvas.width * 0.025),
      );
      ctx.fill();
      const qrPad = Math.round(qrFrame * 0.09);
      ctx.drawImage(
        qrImage,
        qrFrameX + qrPad,
        qrFrameY + qrPad,
        qrFrame - qrPad * 2,
        qrFrame - qrPad * 2,
      );

      const footerY =
        options.format === "story"
          ? Math.round(canvas.height * 0.84)
          : Math.round(canvas.height * 0.83);
      ctx.fillStyle = "#ffffff";
      ctx.font = `800 ${Math.round(canvas.width * 0.046)}px Inter, Arial, sans-serif`;
      ctx.fillText(businessName, canvas.width / 2, footerY);
      ctx.fillStyle = "#fcd9be";
      ctx.font = `600 ${Math.round(canvas.width * 0.032)}px Inter, Arial, sans-serif`;
      ctx.fillText(
        options.cta,
        canvas.width / 2,
        footerY + Math.round(canvas.height * 0.048),
      );
      ctx.fillStyle = "#fb923c";
      ctx.font = `700 ${Math.round(canvas.width * 0.022)}px Inter, Arial, sans-serif`;
      ctx.fillText(
        size.tag,
        canvas.width / 2,
        footerY + Math.round(canvas.height * 0.085),
      );

      const pngUrl = canvas.toDataURL("image/png");
      const link = document.createElement("a");
      link.href = pngUrl;
      link.download = options.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error: any) {
      toast({
        title: "Social graphic failed",
        description: error?.message || "Unable to generate social graphic.",
        variant: "destructive",
      });
    }
  };
  const copyQrLink = async (targetUrl: string, label: string) => {
    try {
      await navigator.clipboard.writeText(targetUrl);
      toast({ title: `${label} link copied` });
    } catch (error: any) {
      toast({
        title: "Copy failed",
        description: error?.message || "Unable to copy link.",
        variant: "destructive",
      });
    }
  };
  useEffect(() => {
    if (!currentRestaurant) return;
    setProfileDraft(buildOwnerProfileDraft(currentRestaurant));
    setProfileDraftNeedsRefresh(false);
  }, [currentRestaurant?.id]);
  const visibleTruckBookings = truckBookings;
  const liveShareUrl = currentPublicProfileHref
    ? `${currentPublicProfileHref}?live=1`
    : "/scout";
  const liveShareTitle = currentRestaurant?.name
    ? `${currentRestaurant.name} is live on MealScout`
    : "We are live on MealScout";
  const liveShareDescription =
    "See our current location and profile on MealScout.";

  // GPS fallback function using IP geolocation
  const tryFallbackLocation = async (): Promise<{
    lat: number;
    lng: number;
    accuracy?: number;
  } | null> => {
    try {
      // Try IP-based geolocation as fallback
      const response = await fetch("https://ipapi.co/json/");
      if (response.ok) {
        const data = await response.json();
        if (data.latitude && data.longitude) {
          return {
            lat: parseFloat(data.latitude),
            lng: parseFloat(data.longitude),
            accuracy: 10000, // IP location is less accurate
          };
        }
      }
    } catch (error) {
      console.warn("IP geolocation fallback failed:", error);
    }

    // Final fallback: use restaurant's base location if available
    if (currentRestaurant?.latitude && currentRestaurant?.longitude) {
      return {
        lat: parseFloat(currentRestaurant.latitude),
        lng: parseFloat(currentRestaurant.longitude),
        accuracy: 5000, // Restaurant location accuracy estimate
      };
    }

    return null;
  };

  // A quiet inline error string is easy to miss, and "approximate location"
  // undersells that customers could be sent miles from the truck's real
  // spot. Surface it once per broadcast session as a toast too.
  const warnFallbackAccuracy = (accuracyMeters: number) => {
    if (hasWarnedFallbackAccuracyRef.current) return;
    hasWarnedFallbackAccuracyRef.current = true;
    const accuracyMiles = accuracyMeters / 1609;
    toast({
      title: "Using an approximate location",
      description: `Customers may see your truck up to ${accuracyMiles.toFixed(1)} miles from where you are. Allow precise location access for a better pin.`,
      variant: "destructive",
    });
  };

  // GPS tracking effect with fallback
  useEffect(() => {
    if (isBroadcasting && sessionId) {
      if (!navigator.geolocation) {
        setLocationError("GPS not supported. Trying fallback location...");

        // Use fallback location when GPS is not supported
        tryFallbackLocation().then((fallbackLocation) => {
          if (fallbackLocation) {
            setCurrentLocation(fallbackLocation);
            setGpsAccuracy(fallbackLocation.accuracy || 10000);
            setLocationError("Using approximate location (GPS unavailable)");
            setConnectionStatus("connected");
            warnFallbackAccuracy(fallbackLocation.accuracy || 10000);

            updateLocationMutation.mutate({
              lat: fallbackLocation.lat,
              lng: fallbackLocation.lng,
              accuracy: fallbackLocation.accuracy || 10000,
            });
          } else {
            setLocationError(
              "Unable to determine location. Please check your settings.",
            );
            setConnectionStatus("disconnected");
          }
        });
        return;
      }

      const watchId = navigator.geolocation.watchPosition(
        (position) => {
          const newLocation = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: position.timestamp,
          };

          // Update location state
          setCurrentLocation(newLocation);
          setGpsAccuracy(position.coords.accuracy);
          setLocationError(null);
          setConnectionStatus("connected");
          hasWarnedFallbackAccuracyRef.current = false;

          // Only send updates if location changed significantly (50m threshold)
          if (
            !lastBroadcast ||
            Date.now() - lastBroadcast.getTime() > 30000 || // 30 seconds minimum
            (currentLocation &&
              getDistance(
                currentLocation.lat,
                currentLocation.lng,
                newLocation.lat,
                newLocation.lng,
              ) > 50)
          ) {
            updateLocationMutation.mutate({
              lat: newLocation.lat,
              lng: newLocation.lng,
              accuracy: position.coords.accuracy,
              heading: position.coords.heading || undefined,
              speed: position.coords.speed || undefined,
            });
          }
        },
        async (error) => {
          console.error("GPS error:", error);

          // Try fallback location when GPS fails
          let fallbackMessage = "GPS error. ";
          if (error.code === error.PERMISSION_DENIED) {
            fallbackMessage += "Location access denied. ";
          } else if (error.code === error.POSITION_UNAVAILABLE) {
            fallbackMessage += "Location unavailable. ";
          } else if (error.code === error.TIMEOUT) {
            fallbackMessage += "Location timeout. ";
          }

          setLocationError(fallbackMessage + "Trying fallback...");
          setConnectionStatus("connecting");

          const fallbackLocation = await tryFallbackLocation();
          if (fallbackLocation) {
            setCurrentLocation(fallbackLocation);
            setGpsAccuracy(fallbackLocation.accuracy || 10000);
            setLocationError(fallbackMessage + "Using approximate location.");
            setConnectionStatus("connected");
            warnFallbackAccuracy(fallbackLocation.accuracy || 10000);

            updateLocationMutation.mutate({
              lat: fallbackLocation.lat,
              lng: fallbackLocation.lng,
              accuracy: fallbackLocation.accuracy || 10000,
            });
          } else {
            setLocationError(fallbackMessage + "Unable to determine location.");
            setConnectionStatus("disconnected");
          }
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 5000,
        },
      );

      setGpsWatchId(watchId);

      return () => {
        navigator.geolocation.clearWatch(watchId);
      };
    }
  }, [
    isBroadcasting,
    sessionId,
    lastBroadcast,
    currentLocation,
    updateLocationMutation,
    currentRestaurant,
  ]);

  // Warn, then auto-stop broadcasting after 2 minutes of inactivity.
  // A silent auto-stop is easy to miss if the owner has put the phone
  // down or switched tabs, so this surfaces a toast at both stages
  // instead of only updating the (easy to miss) inline error box.
  useEffect(() => {
    if (isBroadcasting && lastBroadcast) {
      const warningTimeout = setTimeout(() => {
        if (Date.now() - lastBroadcast.getTime() > 90000) {
          toast({
            title: "Your live location hasn't updated in a while",
            description:
              "MealScout will stop broadcasting your truck as live in about 30 seconds unless a new location comes in.",
            variant: "destructive",
          });
        }
      }, 90000);

      const stopTimeout = setTimeout(() => {
        if (Date.now() - lastBroadcast.getTime() > 120000) {
          // 2 minutes
          stopFoodTruckSessionMutation.mutate();
          setLocationError("Session timed out due to inactivity");
          toast({
            title: "You've gone offline on MealScout",
            description:
              "No location update was received for 2 minutes, so your truck was taken off the live map. Start broadcasting again when you're ready.",
            variant: "destructive",
          });
        }
      }, 125000); // Check after 2 minutes 5 seconds

      return () => {
        clearTimeout(warningTimeout);
        clearTimeout(stopTimeout);
      };
    }
  }, [lastBroadcast, isBroadcasting, stopFoodTruckSessionMutation, toast]);

  // Operating hours form schema
  const operatingHoursSchema = z.object({
    mon: z
      .array(
        z.object({
          open: z
            .string()
            .regex(
              /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/,
              "Time must be in HH:MM format",
            ),
          close: z
            .string()
            .regex(
              /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/,
              "Time must be in HH:MM format",
            ),
        }),
      )
      .optional(),
    tue: z
      .array(
        z.object({
          open: z
            .string()
            .regex(
              /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/,
              "Time must be in HH:MM format",
            ),
          close: z
            .string()
            .regex(
              /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/,
              "Time must be in HH:MM format",
            ),
        }),
      )
      .optional(),
    wed: z
      .array(
        z.object({
          open: z
            .string()
            .regex(
              /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/,
              "Time must be in HH:MM format",
            ),
          close: z
            .string()
            .regex(
              /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/,
              "Time must be in HH:MM format",
            ),
        }),
      )
      .optional(),
    thu: z
      .array(
        z.object({
          open: z
            .string()
            .regex(
              /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/,
              "Time must be in HH:MM format",
            ),
          close: z
            .string()
            .regex(
              /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/,
              "Time must be in HH:MM format",
            ),
        }),
      )
      .optional(),
    fri: z
      .array(
        z.object({
          open: z
            .string()
            .regex(
              /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/,
              "Time must be in HH:MM format",
            ),
          close: z
            .string()
            .regex(
              /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/,
              "Time must be in HH:MM format",
            ),
        }),
      )
      .optional(),
    sat: z
      .array(
        z.object({
          open: z
            .string()
            .regex(
              /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/,
              "Time must be in HH:MM format",
            ),
          close: z
            .string()
            .regex(
              /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/,
              "Time must be in HH:MM format",
            ),
        }),
      )
      .optional(),
    sun: z
      .array(
        z.object({
          open: z
            .string()
            .regex(
              /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/,
              "Time must be in HH:MM format",
            ),
          close: z
            .string()
            .regex(
              /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/,
              "Time must be in HH:MM format",
            ),
        }),
      )
      .optional(),
  });

  type OperatingHoursFormData = z.infer<typeof operatingHoursSchema>;

  // Operating hours form
  const operatingHoursForm = useForm<OperatingHoursFormData>({
    resolver: zodResolver(operatingHoursSchema),
    defaultValues: {
      mon: (currentRestaurant?.operatingHours as any)?.mon || [],
      tue: (currentRestaurant?.operatingHours as any)?.tue || [],
      wed: (currentRestaurant?.operatingHours as any)?.wed || [],
      thu: (currentRestaurant?.operatingHours as any)?.thu || [],
      fri: (currentRestaurant?.operatingHours as any)?.fri || [],
      sat: (currentRestaurant?.operatingHours as any)?.sat || [],
      sun: (currentRestaurant?.operatingHours as any)?.sun || [],
    },
  });

  // Reset form when restaurant changes
  useEffect(() => {
    if (currentRestaurant) {
      operatingHoursForm.reset({
        mon: (currentRestaurant.operatingHours as any)?.mon || [],
        tue: (currentRestaurant.operatingHours as any)?.tue || [],
        wed: (currentRestaurant.operatingHours as any)?.wed || [],
        thu: (currentRestaurant.operatingHours as any)?.thu || [],
        fri: (currentRestaurant.operatingHours as any)?.fri || [],
        sat: (currentRestaurant.operatingHours as any)?.sat || [],
        sun: (currentRestaurant.operatingHours as any)?.sun || [],
      });
    }
  }, [currentRestaurant, operatingHoursForm]);

  // Start broadcasting handler
  const handleStartBroadcasting = () => {
    if (!hasProfileLocationTools) {
      toast({
        title: "Permission required",
        description: "This account cannot broadcast this truck's location.",
        variant: "destructive",
      });
      return;
    }

    if (!navigator.geolocation) {
      toast({
        title: "Location unavailable",
        description: "This device cannot share its current location.",
        variant: "destructive",
      });
      return;
    }

    setConnectionStatus("connecting");
    hasWarnedFallbackAccuracyRef.current = false;

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const location = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };

        setCurrentLocation({
          ...location,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp,
        });

        startFoodTruckSessionMutation.mutate(location);
      },
      (error) => {
        setLocationError(error.message);
        setConnectionStatus("disconnected");
        toast({
          title: "Location unavailable",
          description: "Allow location access for MealScout, then try again.",
          variant: "destructive",
        });
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000,
      },
    );
  };

  // Stop broadcasting handler
  const handleStopBroadcasting = () => {
    stopFoodTruckSessionMutation.mutate();
  };

  // Handle restaurant location update
  const handleUpdateRestaurantLocation = () => {
    if (!hasProfileLocationTools) {
      toast({
        title: "Permission required",
        description: "This account cannot update this business location.",
        variant: "destructive",
      });
      return;
    }

    if (!navigator.geolocation) {
      toast({
        title: "Location unavailable",
        description: "This device cannot share its current location.",
        variant: "destructive",
      });
      return;
    }

    setIsUpdatingLocation(true);
    setLocationUpdateError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const location = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };

        updateRestaurantLocationMutation.mutate(location);
      },
      (error) => {
        setLocationUpdateError(error.message);
        setIsUpdatingLocation(false);
        toast({
          title: "Location unavailable",
          description: "Allow location access for MealScout, then try again.",
          variant: "destructive",
        });
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000,
      },
    );
  };

  // Handle operating hours form submission
  const handleOperatingHoursSubmit = (data: OperatingHoursFormData) => {
    updateOperatingHoursMutation.mutate(data);
  };

  // Helper function to add time slot
  const addTimeSlot = (day: keyof OperatingHoursFormData) => {
    const currentSlots = operatingHoursForm.getValues(day) || [];
    if (currentSlots.length < 3) {
      operatingHoursForm.setValue(
        day,
        [...currentSlots, { open: "09:00", close: "17:00" }],
        {
          shouldDirty: true,
          shouldValidate: true,
        },
      );
    }
  };

  // Helper function to remove time slot
  const removeTimeSlot = (day: keyof OperatingHoursFormData, index: number) => {
    const currentSlots = operatingHoursForm.getValues(day) || [];
    const newSlots = currentSlots.filter((_, i) => i !== index);
    operatingHoursForm.setValue(day, newSlots, {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  // Food truck mutations
  const startFoodTruckSessionMutation = useMutation({
    mutationFn: async (location: { lat: number; lng: number }) => {
      return await apiRequest(
        "POST",
        `/api/restaurants/${selectedRestaurant}/truck-session/start`,
        {
          latitude: location.lat,
          longitude: location.lng,
          deviceId: navigator.userAgent || "web-browser",
        },
      );
    },
    onSuccess: (data: any) => {
      setSessionId(data?.session?.id || null);
      setIsBroadcasting(true);
      setConnectionStatus("connected");

      // Connect to WebSocket and subscribe to restaurant updates
      connectWS();
      setTimeout(() => {
        subscribeToRestaurant(selectedRestaurant);
      }, 1000);

      toast({
        title: "Your truck is live",
        description:
          "Customers can now see your current location on MealScout.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Could not share your location",
        description: error.message || "Check location access and try again.",
        variant: "destructive",
      });
    },
  });

  // Restaurant location update mutation (different from food truck location)
  const updateRestaurantLocationMutation = useMutation({
    mutationFn: async (location: { latitude: number; longitude: number }) => {
      return await apiRequest(
        "PATCH",
        `/api/restaurants/${selectedRestaurant}/location`,
        location,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/restaurants/my-restaurants"],
      });
      setLocationUpdateError(null);
      setIsUpdatingLocation(false);
      toast({
        title: currentIsTruckBusiness
          ? "Saved location updated"
          : "Restaurant location updated",
        description: "The map pin on your public profile has been refreshed.",
      });
    },
    onError: (error: any) => {
      setLocationUpdateError(error.message || "Failed to update location");
      setIsUpdatingLocation(false);
      toast({
        title: "Could not update location",
        description: error.message || "Check location access and try again.",
        variant: "destructive",
      });
    },
  });

  // Operating hours update mutation
  const updateOperatingHoursMutation = useMutation({
    mutationFn: async (operatingHours: OperatingHoursFormData) => {
      return await apiRequest(
        "PATCH",
        `/api/restaurants/${selectedRestaurant}/operating-hours`,
        {
          operatingHours,
        },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/restaurants/my-restaurants"],
      });
      toast({
        title: currentIsTruckBusiness ? "Schedule saved" : "Hours saved",
        description: currentIsTruckBusiness
          ? "Customers will see these weekly service hours on your profile."
          : "Customers will see these hours on your profile.",
      });
    },
    onError: (error: any) => {
      toast({
        title: currentIsTruckBusiness
          ? "Could not save schedule"
          : "Could not save hours",
        description: error.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const updateProfileBasicsMutation = useMutation({
    mutationFn: async (payload: OwnerProfileDraft) => {
      // Media uploads persist through their dedicated endpoints. Never send
      // a possibly stale image URL with a later profile-text save.
      const {
        logoUrl: _logoUrl,
        coverImageUrl: _coverImageUrl,
        businessType: _businessType,
        ...profileBasics
      } = payload;
      return await apiRequest(
        "PATCH",
        `/api/restaurants/${selectedRestaurant}/profile-basics`,
        profileBasics,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/restaurants/my-restaurants"],
      });
      toast({
        title: "Business Profile Updated",
        description: "Public-facing profile details have been saved.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Unable to save profile",
        description: error?.message || "Please check the fields and try again.",
        variant: "destructive",
      });
    },
  });

  const updateMenuApprovalMutation = useMutation({
    mutationFn: async (payload: { action: "approve" | "reject" | "skip" }) => {
      return await apiRequest(
        "PATCH",
        `/api/restaurants/${selectedRestaurant}/menu-approval`,
        payload,
      );
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["/api/restaurants/my-restaurants"],
      });
      queryClient.invalidateQueries({
        queryKey: [
          "/api/public/profiles",
          currentPublicEntityType,
          selectedRestaurant,
          "qr-kit",
        ],
      });
      toast({
        title:
          variables.action === "approve"
            ? "Menu approved"
            : variables.action === "reject"
              ? "Menu marked not current"
              : "Menu review skipped",
        description:
          variables.action === "skip"
            ? "The reminder will stay active until you approve or mark the menu not current."
            : "Your public menu trust label has been updated.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Unable to update menu review",
        description: error?.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const uploadProfileMediaMutation = useMutation({
    mutationFn: async (payload: {
      file: File;
      kind: "logo" | "cover" | "gallery";
      category?: string;
    }) => {
      const formData = new FormData();
      formData.append("image", payload.file);
      formData.append("restaurantId", selectedRestaurant);
      if (payload.kind === "gallery") {
        formData.append("category", payload.category || "food");
      }
      const endpoint =
        payload.kind === "logo"
          ? "/api/upload/restaurant-logo"
          : payload.kind === "cover"
            ? "/api/upload/restaurant-cover"
            : "/api/upload/restaurant-gallery";
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.message || "Failed to upload media");
      }
      return body;
    },
    onSuccess: async (payload, variables) => {
      queryClient.setQueryData<Restaurant[]>(
        ["/api/restaurants/my-restaurants"],
        (current = []) =>
          current.map((restaurant) => {
            if (String(restaurant.id) !== String(selectedRestaurant)) {
              return restaurant;
            }
            if (variables.kind === "logo" && payload?.url) {
              return { ...restaurant, logoUrl: String(payload.url) };
            }
            if (variables.kind === "cover" && payload?.url) {
              return { ...restaurant, coverImageUrl: String(payload.url) };
            }
            if (variables.kind === "gallery" && payload?.media) {
              const currentSettings =
                restaurant.socialAutopostSettings &&
                typeof restaurant.socialAutopostSettings === "object"
                  ? {
                      ...(restaurant.socialAutopostSettings as Record<
                        string,
                        unknown
                      >),
                    }
                  : {};
              const currentGallery = Array.isArray(
                (currentSettings as any).publicGalleryImages,
              )
                ? ([...(currentSettings as any).publicGalleryImages] as any[])
                : [];
              const nextMediaId = String(payload.media.id || "");
              const nextGallery = currentGallery.some(
                (media) => String(media?.id || "") === nextMediaId,
              )
                ? currentGallery
                : [...currentGallery, payload.media];
              return {
                ...restaurant,
                socialAutopostSettings: {
                  ...currentSettings,
                  publicGalleryImages: nextGallery,
                },
              } as Restaurant;
            }
            return restaurant;
          }),
      );
      // Keep the local preview in sync immediately; the profile-text mutation
      // deliberately omits these URLs, while the query invalidation below
      // reconciles the persisted business record from the database.
      if (variables.kind === "logo" && payload?.url) {
        setProfileDraft((prev) => ({ ...prev, logoUrl: String(payload.url) }));
      } else if (variables.kind === "cover" && payload?.url) {
        setProfileDraft((prev) => ({
          ...prev,
          coverImageUrl: String(payload.url),
        }));
      }
      toast({
        title:
          variables.kind === "gallery"
            ? "Photo added"
            : variables.kind === "cover"
              ? "Cover photo updated"
              : "Logo updated",
        description:
          variables.kind === "gallery"
            ? payload?.approvalStatus === "pending"
              ? "The upload is saved and waiting for approval before customers see it."
              : "The upload is saved and visible on your business profile."
            : "The new image is saved to your business profile.",
      });
      await queryClient.invalidateQueries({
        queryKey: ["/api/restaurants/my-restaurants"],
      });
    },
    onError: (error: any) => {
      toast({
        title: "Upload failed",
        description: error?.message || "Unable to upload image.",
        variant: "destructive",
      });
    },
  });

  const approveProfileMediaMutation = useMutation({
    mutationFn: async (payload: { mediaId: string; approved: boolean }) => {
      const response = await fetch(
        `/api/restaurants/${encodeURIComponent(String(selectedRestaurant))}/media-gallery/${encodeURIComponent(payload.mediaId)}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publicApproved: payload.approved }),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.message || "Failed to update media approval");
      }
      return body;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/restaurants/my-restaurants"],
      });
      toast({
        title: "Media approval updated",
        description: "Public approval state has been saved.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Unable to update media",
        description: error?.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const formatTime = (time: string) => {
    const [hours, minutes] = time.split(":");
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? "PM" : "AM";
    const displayHour = hour % 12 || 12;
    return `${displayHour}:${minutes} ${ampm}`;
  };

  const bookingCancelMutation = useMutation({
    mutationFn: async (bookingId: string) => {
      const response = await fetch(`/api/bookings/${bookingId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ reason: "Cancelled by truck owner" }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.message || "Failed to cancel booking");
      }

      return response.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["/api/bookings/my-truck"],
      });
      setBookingToCancel(null);
      toast({
        title: "Booking cancelled",
        description: "Your booking was cancelled. No refund was issued.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Unable to cancel booking",
        description: error?.message || "Please try again.",
        variant: "destructive",
      });
    },
  });
  const availableTabs = [
    ...(canManageParkingPass ? (["foodtruck"] as const) : []),
    ...(canManageParkingPass && currentIsTruckBusiness
      ? (["bookings"] as const)
      : []),
  ];
  const requestedDefaultTab =
    setupMode === "schedule" || dashboardParams.get("truck") === "1"
          ? "foodtruck"
          : setupMode === "bookings"
            ? "bookings"
            : null;
  const defaultTab =
    requestedDefaultTab && availableTabs.includes(requestedDefaultTab as any)
      ? requestedDefaultTab
      : (availableTabs[0] ?? "foodtruck");
  const buildOwnerToolHref = (
    destination: string,
    extras?: Record<string, string>,
  ) => {
    const url = new URL(destination, "https://www.mealscout.us");
    const params = new URLSearchParams(url.search);
    ["setup", "ref", "onboarding", "setupStep", "setupPanel"].forEach((key) =>
      params.delete(key),
    );
    if (selectedRestaurant) {
      params.set("restaurantId", String(selectedRestaurant));
    }
    if (extras) {
      for (const [key, value] of Object.entries(extras)) {
        if (value) params.set(key, value);
      }
    }
    const query = params.toString();
    return `${url.pathname}${query ? `?${query}` : ""}`;
  };
  const buildOwnerSetupHref = (
    setup: "profile" | "profile-media" | "schedule" | "menu",
    extras?: Record<string, string>,
  ) => {
    const params = new URLSearchParams();
    params.set("setup", setup);
    params.set("restaurantId", String(selectedRestaurant));
    if (extras) {
      for (const [key, value] of Object.entries(extras)) {
        if (value) params.set(key, value);
      }
    }
    return `/restaurant-owner-dashboard?${params.toString()}`;
  };
  const buildDashboardHref = () => {
    return buildOwnerToolHref("/restaurant-owner-dashboard");
  };
  const menuBuilderHref = (() => {
    return buildOwnerToolHref("/menu-builder", { src: "onboarding" });
  })();
  const handleWorkspaceBusinessChange = (businessId: string) => {
    setSelectedRestaurant(businessId);
    const params = new URLSearchParams(window.location.search);
    params.set("restaurantId", businessId);
    const query = params.toString();
    setLocation(`${window.location.pathname}${query ? `?${query}` : ""}`);
  };
  const ownerHeaderActions = (
    <div className="flex flex-nowrap items-center gap-2">
      {activeWorkspaceModule === "overview" && canManageBilling ? (
        <Link href={buildOwnerToolHref("/subscribe")}>
          <Button
            size="sm"
            variant="outline"
            data-testid="button-profile-access"
          >
            Profile access
          </Button>
        </Link>
      ) : null}
      {activeWorkspaceModule === "overview" && canManageDeals ? (
        <Link href={buildOwnerToolHref("/hiring?tab=owner")}>
          <Button
            size="sm"
            variant="outline"
            data-testid="button-hiring-marketplace"
          >
            Hiring
          </Button>
        </Link>
      ) : null}
    </div>
  );

  if (currentRestaurant && !canOpenActiveWorkspaceModule) {
    return (
      <BusinessWorkspaceShell
        activeModule={activeWorkspaceModule}
        business={currentRestaurant}
        businesses={restaurants}
        onBusinessChange={handleWorkspaceBusinessChange}
        publicProfileHref={currentPublicProfileHref}
        capabilities={workspaceCapabilities}
      >
        <div className="mx-auto flex min-h-[70vh] max-w-lg items-center px-4 py-10">
          <Card className="w-full border-amber-200 bg-amber-50">
            <CardContent className="p-6 text-center">
              <h2 className="text-lg font-bold text-amber-950">
                Permission required
              </h2>
              <p className="mt-2 text-sm text-amber-900/80">
                Ask the business owner to grant access to this workspace area.
              </p>
            </CardContent>
          </Card>
        </div>
      </BusinessWorkspaceShell>
    );
  }

  if (loadingRestaurants) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[var(--bg-layered)]">
        <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (restaurants.length === 0) {
    return (
      <div className="container mx-auto px-4 py-8 bg-[var(--bg-layered)] min-h-screen">
        <div className="max-w-2xl mx-auto text-center space-y-6">
          <Store className="h-16 w-16 mx-auto text-muted-foreground" />
          <h1 className="text-3xl font-bold">No Food Business Found</h1>
          <p className="text-muted-foreground">
            Register your food business first to manage its public profile and offers.
          </p>
          <Link href="/restaurant-signup">
            <Button size="lg" data-testid="button-register-restaurant">
              Register Your Food Business
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  if (!currentRestaurant) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg-layered)]">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <BusinessWorkspaceShell
      activeModule={activeWorkspaceModule}
      business={currentRestaurant}
      businesses={restaurants}
      onBusinessChange={handleWorkspaceBusinessChange}
      publicProfileHref={currentPublicProfileHref}
      capabilities={workspaceCapabilities}
      headerActions={ownerHeaderActions}
    >
      <div className="mx-auto min-h-screen max-w-7xl px-4 py-6 lg:px-6 lg:py-8">
        <SEOHead
          title="Business Profile - MealScout | Manage Your Public Presence"
          description="Manage your MealScout business profile, availability, menu, offers, customer actions, and performance."
          keywords="food business profile, MealScout profile, menu, availability, offers, customer insights"
          canonicalUrl="https://www.mealscout.us/restaurant-owner-dashboard"
          noIndex={true}
        />
        {currentRestaurant &&
          activeWorkspaceModule === "overview" &&
          (() => {
            // The full completion checklist lives further down the page, under
            // "Profile value" analytics. Owners were landing here with no
            // first-screen signal of what's missing before they go live, so
            // this gives a compact summary up top that links straight to it.
            const topCompletionTruth = (currentRestaurant as any)
              .profileCompletionTruth as ProfileCompletionTruth | null;
            const topCompletionChecks = [
              topCompletionTruth?.menuState === "approved_current",
              topCompletionTruth?.mediaState === "ready",
              topCompletionTruth?.availabilityReady === true,
              topCompletionTruth?.publicRouteState === "published",
            ];
            const topCompletionDoneCount = topCompletionChecks.filter(Boolean).length;
            const topCompletionTotal = topCompletionChecks.length;
            const isComplete = topCompletionTruth?.publicProfileReady === true;
            const pendingEvidenceCount =
              profileEvidenceReview?.restaurantId ===
              String(selectedRestaurant)
                ? profileEvidenceReview.pendingCount
                : 0;

            return (
              <Card
                className={`mb-6 ${isComplete ? "border-[color:var(--status-success)]/30 bg-[color:var(--status-success)]/5" : "border-amber-300 bg-amber-50"}`}
                data-testid="card-top-profile-completion"
              >
                <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div>
                    <p
                      className={`text-sm font-semibold ${isComplete ? "text-[color:var(--status-success)]" : "text-amber-900"}`}
                    >
                      {isComplete
                        ? "Your public profile is ready"
                        : `Profile setup: ${topCompletionDoneCount}/${topCompletionTotal} complete`}
                    </p>
                    <p
                      className={`mt-1 text-xs ${isComplete ? "text-[color:var(--status-success)]/80" : "text-amber-900/80"}`}
                    >
                      {isComplete
                        ? "Keep details current as your business changes."
                        : "Complete the required menu, approved media, availability, and publication steps below."}
                    </p>
                  </div>
                  <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap">
                    {pendingEvidenceCount > 0 ? (
                      <Link
                        href={`${buildOwnerSetupHref("profile")}#owner-profile-evidence-review`}
                      >
                        <div
                          className="flex min-h-10 items-center justify-center rounded-md border border-orange-400 bg-orange-600 px-3 py-1.5 text-center text-xs font-semibold text-white hover:bg-orange-700"
                          data-testid="link-review-profile-evidence"
                        >
                          Review {pendingEvidenceCount} profile{" "}
                          {pendingEvidenceCount === 1
                            ? "suggestion"
                            : "suggestions"}
                        </div>
                      </Link>
                    ) : null}
                    {!isComplete && (
                      <a
                        href="#profile-completion-details"
                        className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-center text-xs font-semibold text-amber-900 hover:bg-amber-100"
                        data-testid="link-jump-to-completion-details"
                      >
                        See what's missing
                      </a>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })()}

        {currentRestaurant &&
        activeWorkspaceModule === "overview" &&
        menuApprovalRequired ? (
          <Card
            className="mb-6 border-amber-300 bg-amber-50"
            data-testid="truck-menu-owner-approval-task"
          >
            <CardHeader>
              <CardTitle className="text-base text-amber-950">
                Review your public menu
              </CardTitle>
              <CardDescription className="text-amber-900/80">
                This truck has menu details visible on MealScout, but they still
                need owner confirmation before we call them owner-approved.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-amber-950">
                Public label now:{" "}
                {String(
                  currentMenuApproval?.label || "Needs owner confirmation",
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() =>
                    updateMenuApprovalMutation.mutate({ action: "approve" })
                  }
                  disabled={updateMenuApprovalMutation.isPending}
                >
                  Approve menu as current
                </Button>
                <Link href={menuBuilderHref}>
                  <Button type="button" size="sm" variant="outline">
                    Edit menu items/prices
                  </Button>
                </Link>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    updateMenuApprovalMutation.mutate({ action: "reject" })
                  }
                  disabled={updateMenuApprovalMutation.isPending}
                >
                  Mark menu not current
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    updateMenuApprovalMutation.mutate({ action: "skip" })
                  }
                  disabled={updateMenuApprovalMutation.isPending}
                >
                  Skip for now
                </Button>
              </div>
              <p className="text-xs text-amber-900/75">
                Skipping keeps this reminder active. Viewing this page never
                approves the menu automatically.
              </p>
            </CardContent>
          </Card>
        ) : null}

        {currentRestaurant &&
          setupMode &&
          !["schedule", "bookings"].includes(setupMode) && (
          <div
            className={
              setupMode === "menu"
                ? "mb-6 rounded-2xl border border-orange-200 bg-orange-50 p-4 shadow-clean"
                : "mb-6"
            }
          >
            {setupMode === "menu" ? (
              <>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-700">
                      Business onboarding
                    </p>
                    <h2 className="mt-1 text-lg font-black text-orange-950">
                      Finish {currentRestaurant.name || "your business"} setup
                    </h2>
                    <p className="mt-1 text-sm text-orange-900/75">
                      Your personal account is active. Now complete the business
                      pieces customers actually use: profile, menu,
                      schedule/live status, and bookings.
                    </p>
                  </div>
                  <Badge className="w-fit bg-orange-600 text-white">
                    {currentIsTruckBusiness
                      ? "Truck setup workspace"
                      : currentIsBarBusiness
                        ? "Bar setup workspace"
                        : "Business setup workspace"}
                  </Badge>
                </div>

                <div className="mt-4 grid gap-2 sm:grid-cols-4">
                  <Link href={buildOwnerSetupHref("profile")}>
                    <div className="flex w-full items-center gap-2 rounded-md border border-orange-200 bg-white px-3 py-2 text-orange-900 hover:bg-orange-100">
                      <Store className="h-4 w-4 text-orange-900" />
                      <span className="text-sm font-semibold text-orange-900">
                        {currentIsBarBusiness
                          ? "Complete bar profile"
                          : currentIsTruckBusiness
                            ? "Complete truck profile"
                            : "Complete business profile"}
                      </span>
                    </div>
                  </Link>
                  <Link href={buildOwnerSetupHref("menu")}>
                    <div className="flex w-full items-center gap-2 rounded-md border border-orange-200 bg-white px-3 py-2 text-orange-900 hover:bg-orange-100">
                      <ShoppingCart className="h-4 w-4 text-orange-900" />
                      <span className="text-sm font-semibold text-orange-900">
                        Open menu builder
                      </span>
                    </div>
                  </Link>
                  <Link
                    href={
                      currentIsTruckBusiness
                        ? currentDatedStopScheduleHref
                        : buildOwnerSetupHref("schedule")
                    }
                  >
                    <div className="flex w-full items-center gap-2 rounded-md border border-orange-200 bg-white px-3 py-2 text-orange-900 hover:bg-orange-100">
                      <Clock className="h-4 w-4 text-orange-900" />
                      <span className="text-sm font-semibold text-orange-900">
                        Set schedule/live status
                      </span>
                    </div>
                  </Link>
                  <Link href={buildOwnerSetupHref("profile-media")}>
                    <div className="flex w-full items-center gap-2 rounded-md border border-orange-200 bg-white px-3 py-2 text-orange-900 hover:bg-orange-100">
                      <Calendar className="h-4 w-4 text-orange-900" />
                      <span className="text-sm font-semibold text-orange-900">
                        Add photos or logo
                      </span>
                    </div>
                  </Link>
                </div>
                {setupMode ? (
                  <div className="mt-3 flex items-center justify-end">
                    <Link href={buildDashboardHref()}>
                      <Button
                        variant="outline"
                        data-testid="button-exit-setup-mode"
                      >
                        Exit setup
                      </Button>
                    </Link>
                  </div>
                ) : null}
              </>
            ) : null}

            {setupMode === "profile" || setupMode === "profile-media" ? (
              <div ref={setupPanelRef} className="scroll-mt-24">
                {setupMode === "profile" ? (
                  <OwnerProfileEvidenceReview
                    key={String(selectedRestaurant)}
                    restaurantId={String(selectedRestaurant)}
                    review={profileEvidenceReview}
                    isLoading={loadingProfileEvidenceReview}
                    isRefreshing={refreshingProfileEvidenceReview}
                    isError={profileEvidenceReviewError}
                    errorMessage={
                      profileEvidenceReviewErrorDetail instanceof Error
                        ? profileEvidenceReviewErrorDetail.message
                        : undefined
                    }
                    onRefresh={async () => {
                      await refetchProfileEvidenceReview();
                    }}
                    onProfileRefresh={async (
                      field: ProfileEvidenceReviewField,
                    ) => {
                      setProfileDraftNeedsRefresh(true);
                      const refreshed = await refetchRestaurants();
                      if (refreshed.error) throw refreshed.error;
                      const authoritativeRestaurant = refreshed.data?.find(
                        (restaurant) =>
                          String(restaurant.id) === String(selectedRestaurant),
                      );
                      if (!authoritativeRestaurant) {
                        throw new Error("Updated business profile was not returned.");
                      }
                      const authoritativeDraft = buildOwnerProfileDraft(
                        authoritativeRestaurant,
                      );
                      setProfileDraft((currentDraft) => ({
                        ...currentDraft,
                        [field]: authoritativeDraft[field],
                      }));
                      setProfileDraftNeedsRefresh(false);
                    }}
                  />
                ) : null}
                <OwnerProfileWorkspace
                  mode={setupMode === "profile-media" ? "media" : "profile"}
                  draft={profileDraft}
                  onDraftChange={setProfileDraft}
                  onSave={() => {
                    if (profileDraftNeedsRefresh) {
                      toast({
                        title: "Reload profile before saving",
                        description:
                          "A reviewed suggestion was applied, but the editable profile has not refreshed yet.",
                        variant: "destructive",
                      });
                      return;
                    }
                    updateProfileBasicsMutation.mutate(profileDraft);
                  }}
                  isSaving={
                    updateProfileBasicsMutation.isPending ||
                    profileDraftNeedsRefresh
                  }
                  gallery={(() => {
                    const settings =
                      currentRestaurant &&
                      typeof currentRestaurant.socialAutopostSettings ===
                        "object"
                        ? currentRestaurant.socialAutopostSettings
                        : {};
                    return Array.isArray((settings as any)?.publicGalleryImages)
                      ? ((settings as any)
                          .publicGalleryImages as OwnerProfileMediaItem[])
                      : [];
                  })()}
                  mediaCategory={mediaCategory}
                  onMediaCategoryChange={setMediaCategory}
                  onUpload={(file, kind, category) =>
                    uploadProfileMediaMutation.mutate({ file, kind, category })
                  }
                  isUploading={uploadProfileMediaMutation.isPending}
                  uploadingKind={uploadProfileMediaMutation.variables?.kind}
                  canModerate={isAdmin || isStaff}
                  onApprovalChange={(mediaId, approved) =>
                    approveProfileMediaMutation.mutate({ mediaId, approved })
                  }
                  isUpdatingApproval={approveProfileMediaMutation.isPending}
                  publicProfileHref={currentPublicProfileHref}
                  photosHref={buildOwnerSetupHref("profile-media")}
                  ownerAiHref={
                    ownsSelectedBusiness
                      ? buildOwnerAiHref({
                          restaurantId: String(selectedRestaurant),
                          source: "profile-editor",
                          focus:
                            setupMode === "profile-media" ? "media" : "profile",
                        })
                      : null
                  }
                  isFoodTruck={currentIsTruckBusiness}
                />

                {setupMode === "profile" ? (
                  <details
                    className="mt-6 rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-4 sm:p-5"
                    data-testid="owner-profile-tools"
                  >
                    <summary className="cursor-pointer font-black text-[color:var(--text-primary)]">
                      QR assets and profile activity
                    </summary>
                    <p className="mt-2 text-sm text-[color:var(--text-muted)]">
                      Open these tools when you need printed QR assets or
                      profile performance details.
                    </p>
                    <div className="mt-4 space-y-4">
                      {publicProfileForQr?.seo?.canonicalUrl ? (
                        <div className="mt-4 rounded-lg border border-orange-200 bg-orange-50/60 p-4">
                          <div className="mb-2 flex items-center gap-2">
                            <QrCode className="h-4 w-4 text-orange-700" />
                            <h4 className="text-sm font-black uppercase tracking-[0.12em] text-orange-800">
                              QR Kit
                            </h4>
                          </div>
                          <p className="mb-3 text-xs text-orange-900/80">
                            Print or share these QR codes for profile, menu, and
                            specials.
                          </p>
                          {(() => {
                            const shareBaseTarget =
                              String(
                                (publicProfileForQr as any)
                                  ?.cleanBusinessPath || "",
                              ).trim() || publicProfileForQr.seo.canonicalUrl;
                            const canonicalUrl =
                              resolveCanonicalShareUrlSync(shareBaseTarget);
                            const hasStructuredMenu = Array.isArray(
                              publicProfileForQr.menuSections,
                            )
                              ? publicProfileForQr.menuSections.some(
                                  (section) =>
                                    section &&
                                    Array.isArray(section.items) &&
                                    section.items.length > 0,
                                )
                              : false;
                            const hasMenuFallback = Boolean(
                              publicProfileForQr.menuUrl ||
                              publicProfileForQr.menuPdfUrl ||
                              publicProfileForQr.menuImageUrl,
                            );
                            const menuTarget =
                              publicProfileForQr.menuUrl ||
                              publicProfileForQr.menuPdfUrl ||
                              publicProfileForQr.menuImageUrl ||
                              (hasStructuredMenu
                                ? `${canonicalUrl}#menu`
                                : null);
                            const specialsTarget =
                              Number(
                                publicProfileForQr.deals?.totalActive || 0,
                              ) > 0
                                ? `${canonicalUrl}#deals`
                                : null;
                            const isTruckProfile = currentIsTruckBusiness;

                            const options: Array<{
                              id: string;
                              label: string;
                              target: string | null;
                              note: string;
                            }> = [
                              {
                                id: "profile",
                                label: "Profile QR",
                                target: canonicalUrl,
                                note: "Scan to view your full MealScout profile.",
                              },
                              {
                                id: "menu",
                                label: "Menu QR",
                                target:
                                  hasStructuredMenu || hasMenuFallback
                                    ? menuTarget
                                    : null,
                                note: "Scan for menu and featured items.",
                              },
                              {
                                id: "specials",
                                label: "Specials QR",
                                target: specialsTarget,
                                note: "Scan for active deals and specials.",
                              },
                            ];

                            const batchMarketingAssets: Array<{
                              id: string;
                              title: string;
                              subtitle: string;
                              targetUrl: string;
                              filename: string;
                            }> = [
                              {
                                id: "window",
                                title: "Find us on MealScout",
                                subtitle: "Scan to view profile and updates",
                                targetUrl: canonicalUrl,
                                filename: `window-sticker-${selectedRestaurant}.png`,
                              },
                              ...(menuTarget
                                ? [
                                    {
                                      id: "menu",
                                      title: "Scan for menu",
                                      subtitle:
                                        "See featured items and latest menu",
                                      targetUrl: String(menuTarget),
                                      filename: `table-tent-menu-${selectedRestaurant}.png`,
                                    },
                                  ]
                                : []),
                              ...(specialsTarget
                                ? [
                                    {
                                      id: "specials",
                                      title: "Today's specials",
                                      subtitle:
                                        "Active deals and limited-time offers",
                                      targetUrl: String(specialsTarget),
                                      filename: `specials-asset-${selectedRestaurant}.png`,
                                    },
                                  ]
                                : []),
                              ...(isTruckProfile
                                ? [
                                    {
                                      id: "truck",
                                      title: "Schedule + menu",
                                      subtitle:
                                        "Find stops, hours, and food updates",
                                      targetUrl: String(
                                        menuTarget || canonicalUrl,
                                      ),
                                      filename: `truck-asset-${selectedRestaurant}.png`,
                                    },
                                  ]
                                : []),
                            ];
                            const socialTargets: Array<{
                              id: string;
                              label: string;
                              targetUrl: string;
                              title: string;
                              subtitle: string;
                              cta: string;
                            }> = [
                              {
                                id: "profile",
                                label: "Profile",
                                targetUrl: canonicalUrl,
                                title: "Find us on MealScout",
                                subtitle:
                                  "Local updates, hours, and highlights",
                                cta: "Find us on MealScout",
                              },
                              ...(menuTarget
                                ? [
                                    {
                                      id: "menu",
                                      label: "Menu",
                                      targetUrl: String(menuTarget),
                                      title: "Scan for menu",
                                      subtitle:
                                        "See featured items and latest menu",
                                      cta: "Scan for menu",
                                    },
                                  ]
                                : []),
                              ...(specialsTarget
                                ? [
                                    {
                                      id: "specials",
                                      label: "Specials",
                                      targetUrl: String(specialsTarget),
                                      title: "Today's specials",
                                      subtitle:
                                        "Active deals and limited-time offers",
                                      cta: "Scan for today's specials",
                                    },
                                  ]
                                : []),
                              ...(isTruckProfile
                                ? [
                                    {
                                      id: "truck",
                                      label: "Truck schedule",
                                      targetUrl: String(
                                        menuTarget || canonicalUrl,
                                      ),
                                      title: "Schedule + menu",
                                      subtitle:
                                        "Find stops, hours, and food updates",
                                      cta: "Scan for schedule + menu",
                                    },
                                  ]
                                : []),
                            ];

                            return (
                              <div className="space-y-3">
                                <div className="grid gap-3 sm:grid-cols-3">
                                  {options
                                    .filter((option) => Boolean(option.target))
                                    .map((option) => (
                                      <div
                                        key={option.id}
                                        className="rounded-lg border border-orange-200 bg-white p-3"
                                      >
                                        <p className="text-xs font-bold uppercase tracking-[0.08em] text-orange-800">
                                          {option.label}
                                        </p>
                                        <img
                                          src={buildQrImageUrl(
                                            String(option.target),
                                          )}
                                          alt={`${option.label} code`}
                                          className="my-2 h-28 w-28 rounded border border-orange-100 bg-white object-contain"
                                          loading="lazy"
                                        />
                                        <p className="mb-2 text-[11px] text-orange-900/75">
                                          {option.note}
                                        </p>
                                        <div className="flex flex-wrap gap-2">
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            onClick={() =>
                                              downloadQrPng(
                                                String(option.target),
                                                `${option.id}-qr-${selectedRestaurant}.png`,
                                              )
                                            }
                                          >
                                            Download PNG
                                          </Button>
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={() =>
                                              copyQrLink(
                                                String(option.target),
                                                option.label,
                                              )
                                            }
                                          >
                                            <Copy className="mr-1 h-3.5 w-3.5" />
                                            Copy link
                                          </Button>
                                        </div>
                                      </div>
                                    ))}
                                </div>

                                <div className="rounded-lg border border-orange-200 bg-white p-3">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <h5 className="text-xs font-black uppercase tracking-[0.12em] text-orange-800">
                                      Marketing kit
                                    </h5>
                                    {batchMarketingAssets.length > 0 ? (
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                          downloadAllBrandedQrAssets(
                                            batchMarketingAssets,
                                          )
                                        }
                                      >
                                        <Download className="mr-1 h-3.5 w-3.5" />
                                        Download {batchMarketingAssets.length}{" "}
                                        assets
                                      </Button>
                                    ) : null}
                                  </div>
                                  <p className="mt-1 text-[11px] text-orange-900/75">
                                    Branded templates for counter cards,
                                    windows, and truck-side signage.
                                  </p>
                                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                    <div className="rounded-md border border-orange-100 bg-orange-50/40 p-2">
                                      <p className="text-[11px] font-bold text-orange-900">
                                        Window sticker
                                      </p>
                                      <p className="text-[11px] text-orange-900/70">
                                        Find us on MealScout
                                      </p>
                                      <div className="mt-2 inline-flex items-center gap-2 rounded-md border border-orange-100 bg-white px-2 py-1">
                                        <img
                                          src={buildQrImageUrl(
                                            String(canonicalUrl),
                                          )}
                                          alt="Window sticker QR preview"
                                          className="h-10 w-10 rounded border border-orange-100 bg-white object-contain"
                                          loading="lazy"
                                        />
                                        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-orange-800">
                                          Preview asset
                                        </span>
                                      </div>
                                      <div className="mt-2 flex gap-2">
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          onClick={() =>
                                            downloadBrandedQrAsset({
                                              title: "Find us on MealScout",
                                              subtitle:
                                                "Scan to view profile and updates",
                                              targetUrl: canonicalUrl,
                                              filename: `window-sticker-${selectedRestaurant}.png`,
                                            })
                                          }
                                        >
                                          <Download className="mr-1 h-3.5 w-3.5" />
                                          Download
                                        </Button>
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="ghost"
                                          onClick={() =>
                                            copyQrLink(canonicalUrl, "Profile")
                                          }
                                        >
                                          <Copy className="mr-1 h-3.5 w-3.5" />
                                          Copy
                                        </Button>
                                      </div>
                                    </div>

                                    {menuTarget ? (
                                      <div className="rounded-md border border-orange-100 bg-orange-50/40 p-2">
                                        <p className="text-[11px] font-bold text-orange-900">
                                          Table tent / menu card
                                        </p>
                                        <p className="text-[11px] text-orange-900/70">
                                          Scan for menu
                                        </p>
                                        <div className="mt-2 inline-flex items-center gap-2 rounded-md border border-orange-100 bg-white px-2 py-1">
                                          <img
                                            src={buildQrImageUrl(
                                              String(menuTarget),
                                            )}
                                            alt="Menu card QR preview"
                                            className="h-10 w-10 rounded border border-orange-100 bg-white object-contain"
                                            loading="lazy"
                                          />
                                          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-orange-800">
                                            Preview asset
                                          </span>
                                        </div>
                                        <div className="mt-2 flex gap-2">
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            onClick={() =>
                                              downloadBrandedQrAsset({
                                                title: "Scan for menu",
                                                subtitle:
                                                  "See featured items and latest menu",
                                                targetUrl: String(menuTarget),
                                                filename: `table-tent-menu-${selectedRestaurant}.png`,
                                              })
                                            }
                                          >
                                            <Download className="mr-1 h-3.5 w-3.5" />
                                            Download
                                          </Button>
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant="ghost"
                                            onClick={() =>
                                              copyQrLink(
                                                String(menuTarget),
                                                "Menu",
                                              )
                                            }
                                          >
                                            <Copy className="mr-1 h-3.5 w-3.5" />
                                            Copy
                                          </Button>
                                        </div>
                                      </div>
                                    ) : null}

                                    {specialsTarget ? (
                                      <div className="rounded-md border border-orange-100 bg-orange-50/40 p-2">
                                        <p className="text-[11px] font-bold text-orange-900">
                                          Specials card
                                        </p>
                                        <p className="text-[11px] text-orange-900/70">
                                          Scan for today&apos;s specials
                                        </p>
                                        <div className="mt-2 inline-flex items-center gap-2 rounded-md border border-orange-100 bg-white px-2 py-1">
                                          <img
                                            src={buildQrImageUrl(
                                              String(specialsTarget),
                                            )}
                                            alt="Specials card QR preview"
                                            className="h-10 w-10 rounded border border-orange-100 bg-white object-contain"
                                            loading="lazy"
                                          />
                                          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-orange-800">
                                            Preview asset
                                          </span>
                                        </div>
                                        <div className="mt-2 flex gap-2">
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            onClick={() =>
                                              downloadBrandedQrAsset({
                                                title: "Today's specials",
                                                subtitle:
                                                  "Active deals and limited-time offers",
                                                targetUrl:
                                                  String(specialsTarget),
                                                filename: `specials-asset-${selectedRestaurant}.png`,
                                              })
                                            }
                                          >
                                            <Download className="mr-1 h-3.5 w-3.5" />
                                            Download
                                          </Button>
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant="ghost"
                                            onClick={() =>
                                              copyQrLink(
                                                String(specialsTarget),
                                                "Specials",
                                              )
                                            }
                                          >
                                            <Copy className="mr-1 h-3.5 w-3.5" />
                                            Copy
                                          </Button>
                                        </div>
                                      </div>
                                    ) : null}

                                    {isTruckProfile ? (
                                      <div className="rounded-md border border-orange-100 bg-orange-50/40 p-2">
                                        <p className="text-[11px] font-bold text-orange-900">
                                          Food truck counter card
                                        </p>
                                        <p className="text-[11px] text-orange-900/70">
                                          Scan for schedule + menu
                                        </p>
                                        <div className="mt-2 inline-flex items-center gap-2 rounded-md border border-orange-100 bg-white px-2 py-1">
                                          <img
                                            src={buildQrImageUrl(
                                              String(
                                                menuTarget || canonicalUrl,
                                              ),
                                            )}
                                            alt="Food truck card QR preview"
                                            className="h-10 w-10 rounded border border-orange-100 bg-white object-contain"
                                            loading="lazy"
                                          />
                                          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-orange-800">
                                            Preview asset
                                          </span>
                                        </div>
                                        <div className="mt-2 flex gap-2">
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            onClick={() =>
                                              downloadBrandedQrAsset({
                                                title: "Schedule + menu",
                                                subtitle:
                                                  "Find stops, hours, and food updates",
                                                targetUrl: String(
                                                  menuTarget || canonicalUrl,
                                                ),
                                                filename: `truck-asset-${selectedRestaurant}.png`,
                                              })
                                            }
                                          >
                                            <Download className="mr-1 h-3.5 w-3.5" />
                                            Download
                                          </Button>
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant="ghost"
                                            onClick={() =>
                                              copyQrLink(
                                                String(
                                                  menuTarget || canonicalUrl,
                                                ),
                                                "Truck",
                                              )
                                            }
                                          >
                                            <Copy className="mr-1 h-3.5 w-3.5" />
                                            Copy
                                          </Button>
                                        </div>
                                      </div>
                                    ) : null}
                                  </div>

                                  {socialTargets.length > 0 ? (
                                    <div className="mt-4 rounded-md border border-orange-100 bg-orange-50/40 p-2.5">
                                      <h6 className="text-[11px] font-black uppercase tracking-[0.1em] text-orange-800">
                                        Social graphics
                                      </h6>
                                      <p className="mt-1 text-[11px] text-orange-900/70">
                                        Ready-to-post assets sized for square
                                        and story formats.
                                      </p>
                                      <div className="mt-2 space-y-2">
                                        {socialTargets.map((target) => (
                                          <div
                                            key={`social-${target.id}`}
                                            className="rounded-md border border-orange-100 bg-white p-2"
                                          >
                                            <div className="flex flex-wrap items-center justify-between gap-2">
                                              <p className="text-[11px] font-semibold text-orange-900">
                                                {target.label}
                                              </p>
                                              <Button
                                                type="button"
                                                size="sm"
                                                variant="ghost"
                                                onClick={() =>
                                                  copyQrLink(
                                                    target.targetUrl,
                                                    `${target.label} social`,
                                                  )
                                                }
                                              >
                                                <Copy className="mr-1 h-3.5 w-3.5" />
                                                Copy link
                                              </Button>
                                            </div>
                                            <div className="mt-2 flex flex-wrap gap-2">
                                              <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                onClick={() =>
                                                  downloadSocialQrGraphic({
                                                    title: target.title,
                                                    subtitle: target.subtitle,
                                                    cta: target.cta,
                                                    targetUrl: target.targetUrl,
                                                    filename: `${target.id}-social-square-${selectedRestaurant}.png`,
                                                    format: "square",
                                                  })
                                                }
                                              >
                                                <Download className="mr-1 h-3.5 w-3.5" />
                                                Download Square
                                              </Button>
                                              <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                onClick={() =>
                                                  downloadSocialQrGraphic({
                                                    title: target.title,
                                                    subtitle: target.subtitle,
                                                    cta: target.cta,
                                                    targetUrl: target.targetUrl,
                                                    filename: `${target.id}-social-story-${selectedRestaurant}.png`,
                                                    format: "story",
                                                  })
                                                }
                                              >
                                                <Download className="mr-1 h-3.5 w-3.5" />
                                                Download Story
                                              </Button>
                                              <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                onClick={() =>
                                                  downloadSocialQrGraphic({
                                                    title: target.title,
                                                    subtitle: target.subtitle,
                                                    cta: target.cta,
                                                    targetUrl: target.targetUrl,
                                                    filename: `${target.id}-social-portrait-${selectedRestaurant}.png`,
                                                    format: "portrait",
                                                  })
                                                }
                                              >
                                                <Download className="mr-1 h-3.5 w-3.5" />
                                                Download Portrait
                                              </Button>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            );
                          })()}
                          <p className="mt-3 text-[11px] text-orange-900/75">
                            Print guidance: use Profile QR for window signage,
                            Menu QR for table tents, Specials QR for daily
                            promos, and the truck card at your counter or
                            service window.
                          </p>
                        </div>
                      ) : null}

                      <div
                        id="profile-completion-details"
                        className="rounded-lg border border-border p-4 scroll-mt-24"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold">
                              Profile value
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Real customer actions from your public MealScout
                              profile.
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant={
                                ownerValueWindow === "7d"
                                  ? "default"
                                  : "outline"
                              }
                              onClick={() => setOwnerValueWindow("7d")}
                            >
                              7 days
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant={
                                ownerValueWindow === "30d"
                                  ? "default"
                                  : "outline"
                              }
                              onClick={() => setOwnerValueWindow("30d")}
                            >
                              30 days
                            </Button>
                          </div>
                        </div>
                        <p className="mt-2 text-[11px] text-muted-foreground">
                          {ownerValueAttribution?.generatedAt
                            ? `Last updated ${new Date(ownerValueAttribution.generatedAt).toLocaleString()}`
                            : "Last updated just now"}
                        </p>

                        {(() => {
                          if (loadingOwnerValueAttribution) {
                            return (
                              <div className="mt-3 rounded-md border border-border p-4">
                                <p className="text-sm text-muted-foreground">
                                  Loading owner analytics...
                                </p>
                              </div>
                            );
                          }
                          if (ownerValueAttributionError) {
                            return (
                              <div className="mt-3 rounded-md border border-border p-4">
                                <p className="text-sm font-medium">
                                  Owner analytics could not be loaded right now.
                                </p>
                              </div>
                            );
                          }
                          const entities = Array.isArray(
                            ownerValueAttribution?.entities,
                          )
                            ? ownerValueAttribution.entities
                            : [];
                          const selectedEntity = entities.find(
                            (item) =>
                              String(item.entityId) ===
                              String(selectedRestaurant),
                          ) as OwnerValueAttributionEntity | undefined;
                          const fallbackEntity = entities[0] as
                            OwnerValueAttributionEntity | undefined;
                          const entity = selectedEntity || fallbackEntity;
                          const totals = entity || {
                            profileViews: 0,
                            discoveryImpressions: 0,
                            ctaClicks: 0,
                            shareOpens: 0,
                            highIntentActions: 0,
                            topSources: [],
                            lastActivityAt: null,
                            entityType: currentPublicEntityType,
                            entityId: selectedRestaurant,
                          };
                          const hasAnyData =
                            Number(totals.profileViews || 0) > 0 ||
                            Number(totals.discoveryImpressions || 0) > 0 ||
                            Number(totals.ctaClicks || 0) > 0 ||
                            Number(totals.shareOpens || 0) > 0 ||
                            Number(totals.highIntentActions || 0) > 0;
                          const completionTruth = (currentRestaurant as any)
                            .profileCompletionTruth as ProfileCompletionTruth | null;
                          const canonicalMenuItemCount = Math.max(
                            Number(
                              (currentRestaurant as any)?.menuItemCount || 0,
                            ),
                            Number(
                              (currentRestaurant as any)?.publicMenuItemCount ||
                                0,
                            ),
                          );
                          const isMenuGatedFromScoutDiscoverability =
                            canonicalMenuItemCount <= 0;
                          const completionItems = [
                            {
                              id: "menu",
                              label:
                                completionTruth?.menuState ===
                                "present_needs_confirmation"
                                  ? "Menu needs owner confirmation"
                                  : completionTruth?.menuState === "rejected"
                                    ? "Menu needs an approved current version"
                                    : "Menu missing",
                              why: "A menu counts as complete only when it is public and owner-approved.",
                              done:
                                completionTruth?.menuState ===
                                "approved_current",
                              href: `/menu-builder?restaurantId=${encodeURIComponent(String(selectedRestaurant))}`,
                            },
                            {
                              id: "photos",
                              label: "Approved profile media missing",
                              why: "A logo, cover image, or explicitly approved gallery image is required.",
                              done: completionTruth?.mediaState === "ready",
                              href: `/restaurant-owner-dashboard?setup=profile-media&restaurantId=${encodeURIComponent(String(selectedRestaurant))}`,
                            },
                            {
                              id: "hours",
                              label: currentIsTruckBusiness
                                ? "Dated truck stop missing"
                                : "Weekly business hours missing",
                              why: currentIsTruckBusiness
                                ? "Food-truck availability requires a real dated stop; weekly hours or a recent edit do not count."
                                : "Publish at least one valid weekly hours window.",
                              done: completionTruth?.availabilityReady === true,
                              href: currentIsTruckBusiness
                                ? currentDatedStopScheduleHref
                                : `/restaurant-owner-dashboard?setup=schedule&restaurantId=${encodeURIComponent(String(selectedRestaurant))}`,
                            },
                            {
                              id: "publication",
                              label: "Public profile is not published",
                              why: "Content readiness and public publication are separate states.",
                              done:
                                completionTruth?.publicRouteState === "published",
                              href: `/restaurant-owner-dashboard?setup=profile&restaurantId=${encodeURIComponent(String(selectedRestaurant))}`,
                            },
                          ];
                          const profileStrength = completionItems.filter(
                            (item) => item.done,
                          ).length;
                          const missingCompletionItems = completionItems.filter(
                            (item) => !item.done,
                          );
                          const nextCompletionCta =
                            missingCompletionItems[0]?.href ||
                            `/restaurant-owner-dashboard?setup=profile&restaurantId=${encodeURIComponent(String(selectedRestaurant))}`;
                          const completionActionLabels: Record<string, string> =
                            {
                              menu: "Menu update clicked",
                              photos: "Photos update clicked",
                              hours: "Availability update clicked",
                              publication: "Publication update clicked",
                            };
                          const completionActions = Array.isArray(
                            (totals as any).completionActions,
                          )
                            ? ((totals as any).completionActions as Array<{
                                missingItemKey: string;
                                count: number;
                              }>)
                            : [];
                          const completionReconciliation = Array.isArray(
                            (totals as any).completionActionReconciliation,
                          )
                            ? ((totals as any)
                                .completionActionReconciliation as Array<{
                                missingItemKey: string;
                                clicked: number;
                                nowComplete: number;
                                stillMissing: number;
                              }>)
                            : [];
                          if (!hasAnyData) {
                            const publicProfilePath = (() => {
                              const canonicalUrl = String(
                                publicProfileForQr?.seo?.canonicalUrl || "",
                              ).trim();
                              if (!canonicalUrl) return null;
                              try {
                                const url = new URL(
                                  canonicalUrl,
                                  window.location.origin,
                                );
                                const path = `${url.pathname}${url.search}${url.hash}`;
                                return path.startsWith("/p/") ? path : null;
                              } catch {
                                return canonicalUrl.startsWith("/p/")
                                  ? canonicalUrl
                                  : null;
                              }
                            })();
                            const hasPublicProfile = Boolean(publicProfilePath);
                            return (
                              <div className="mt-3 rounded-md border border-dashed border-border p-4">
                                <p className="text-sm font-medium">
                                  No discovery activity yet.
                                </p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  Your profile is ready to receive views,
                                  clicks, and shares as people find you through
                                  MealScout.
                                </p>
                                <div className="mt-3 flex flex-wrap gap-2">
                                  <Link
                                    href={`/restaurant-owner-dashboard?setup=profile&restaurantId=${encodeURIComponent(String(selectedRestaurant))}`}
                                  >
                                    <Button type="button" size="sm">
                                      Open QR Kit
                                    </Button>
                                  </Link>
                                  {hasPublicProfile ? (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      onClick={async () => {
                                        if (!publicProfilePath) return;
                                        const shareUrl =
                                          await resolveCanonicalShareUrl(
                                            publicProfilePath,
                                          );
                                        await navigator.clipboard.writeText(
                                          shareUrl,
                                        );
                                        toast({
                                          title: "Profile link copied",
                                          description:
                                            "Canonical public profile link copied to clipboard.",
                                        });
                                      }}
                                    >
                                      Copy public profile link
                                    </Button>
                                  ) : (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      disabled
                                    >
                                      No public profile yet
                                    </Button>
                                  )}
                                </div>
                                <div className="mt-4 rounded-md border border-border bg-background p-3">
                                  <p className="text-sm font-semibold">
                                    Profile completion loop
                                  </p>
                                  {isMenuGatedFromScoutDiscoverability ? (
                                    <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2">
                                      <p className="text-xs font-semibold text-amber-900">
                                        Not discoverable in Scout yet.
                                      </p>
                                      <p className="mt-1 text-xs text-amber-800">
                                        Add at least one menu item so customers
                                        can discover your business.
                                      </p>
                                    </div>
                                  ) : null}
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    Complete profiles are easier for people to
                                    evaluate when they find you through
                                    MealScout.
                                  </p>
                                  <p className="mt-2 text-xs text-muted-foreground">
                                    Profile strength: {profileStrength}/
                                    {completionItems.length}
                                  </p>
                                  {missingCompletionItems.length ? (
                                    <div className="mt-2 space-y-2">
                                      {missingCompletionItems
                                        .slice(0, 4)
                                        .map((item) => (
                                          <div
                                            key={item.id}
                                            className="rounded border border-border p-2"
                                          >
                                            <p className="text-sm font-medium">
                                              {item.label}
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                              {item.why}
                                            </p>
                                          </div>
                                        ))}
                                      <Link href={nextCompletionCta}>
                                        <Button
                                          type="button"
                                          size="sm"
                                          className="mt-1"
                                          onClick={() =>
                                            void trackOwnerCompletionAction({
                                              entityId:
                                                String(selectedRestaurant),
                                              entityType:
                                                currentPublicEntityType as
                                                  | "restaurant"
                                                  | "truck"
                                                  | "bar",
                                              missingItemKey: String(
                                                missingCompletionItems[0]?.id ||
                                                  "menu",
                                              ),
                                            })
                                          }
                                        >
                                          Update next missing item
                                        </Button>
                                      </Link>
                                    </div>
                                  ) : (
                                    <p className="mt-2 text-xs text-muted-foreground">
                                      Profile completion looks strong. Keep
                                      details current as your business updates.
                                    </p>
                                  )}
                                  <div className="mt-3 rounded border border-border p-2">
                                    <p className="text-xs font-semibold">
                                      Profile actions taken
                                    </p>
                                    {(completionActions || []).length ? (
                                      <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                                        {completionActions
                                          .slice(0, 3)
                                          .map((action) => (
                                            <p
                                              key={`completion-empty-${action.missingItemKey}`}
                                            >
                                              {completionActionLabels[
                                                action.missingItemKey
                                              ] ||
                                                `${action.missingItemKey} update clicked`}{" "}
                                              — {Number(action.count || 0)}
                                            </p>
                                          ))}
                                      </div>
                                    ) : (
                                      <p className="mt-1 text-xs text-muted-foreground">
                                        No completion actions recorded yet.
                                      </p>
                                    )}
                                  </div>
                                  <div className="mt-3 rounded border border-border p-2">
                                    <p className="text-xs font-semibold">
                                      Completion outcomes after clicks
                                    </p>
                                    {(completionReconciliation || []).length ? (
                                      <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                                        {completionReconciliation
                                          .slice(0, 3)
                                          .map((action) => (
                                            <p
                                              key={`completion-outcome-empty-${action.missingItemKey}`}
                                            >
                                              {String(action.missingItemKey)}:
                                              clicked{" "}
                                              {Number(action.clicked || 0)} •
                                              now complete{" "}
                                              {Number(action.nowComplete || 0)}{" "}
                                              • still missing{" "}
                                              {Number(action.stillMissing || 0)}
                                            </p>
                                          ))}
                                      </div>
                                    ) : (
                                      <p className="mt-1 text-xs text-muted-foreground">
                                        No completion outcomes recorded yet.
                                      </p>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          }

                          return (
                            <>
                              <div className="mt-3 rounded-md border border-border p-2.5">
                                <p className="text-[11px] text-muted-foreground">
                                  Entity
                                </p>
                                <p className="text-base font-semibold">
                                  {currentRestaurant?.name || "Owned profile"}
                                </p>
                                <p className="mt-0.5 text-[11px] text-muted-foreground">
                                  {String(
                                    totals.entityType ||
                                      currentPublicEntityType,
                                  )}
                                </p>
                              </div>
                              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                {[
                                  [
                                    "Profile views",
                                    Number(totals.profileViews || 0),
                                  ],
                                  [
                                    "Discovery impressions",
                                    Number(totals.discoveryImpressions || 0),
                                  ],
                                  ["CTA clicks", Number(totals.ctaClicks || 0)],
                                  [
                                    "Share opens",
                                    Number(totals.shareOpens || 0),
                                  ],
                                  [
                                    "High-intent actions",
                                    Number(totals.highIntentActions || 0),
                                  ],
                                ].map(([label, count]) => (
                                  <div
                                    key={String(label)}
                                    className="rounded-md border border-border p-2.5"
                                  >
                                    <p className="text-[11px] text-muted-foreground">
                                      {String(label)}
                                    </p>
                                    <p className="text-base font-semibold">
                                      {Number(count)}
                                    </p>
                                  </div>
                                ))}
                                <div className="rounded-md border border-border p-2.5">
                                  <p className="text-[11px] text-muted-foreground">
                                    Last activity
                                  </p>
                                  <p className="text-base font-semibold">
                                    {totals.lastActivityAt
                                      ? new Date(
                                          totals.lastActivityAt,
                                        ).toLocaleString()
                                      : "No activity yet"}
                                  </p>
                                </div>
                              </div>

                              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                                <div className="rounded-md border border-border p-3">
                                  <p className="text-sm font-semibold">
                                    Top sources
                                  </p>
                                  <div className="mt-2 space-y-1.5 text-sm">
                                    {(totals.topSources || []).length ? (
                                      (totals.topSources || []).map(
                                        (item: any, idx: number) => (
                                          <p key={`${item.source}-${idx}`}>
                                            {idx + 1}.{" "}
                                            {String(item.source || "unknown")} -{" "}
                                            {Number(item.count || 0)}
                                          </p>
                                        ),
                                      )
                                    ) : (
                                      <p className="text-muted-foreground">
                                        No top sources yet.
                                      </p>
                                    )}
                                  </div>
                                </div>

                                <div className="rounded-md border border-border p-3">
                                  <p className="text-sm font-semibold">
                                    Attribution summary
                                  </p>
                                  <div className="mt-2 space-y-2">
                                    <p className="text-sm text-muted-foreground">
                                      Discovery traffic and profile actions are
                                      shown from real activity only.
                                    </p>
                                    <p className="text-sm text-muted-foreground">
                                      Completing your menu, photos, and action
                                      links helps people take the next step when
                                      they discover your profile.
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                      Window:{" "}
                                      {ownerValueWindow === "7d"
                                        ? "Last 7 days"
                                        : "Last 30 days"}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                      Use this panel weekly to track what
                                      changed and decide your next profile
                                      update.
                                    </p>
                                  </div>
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    <Link
                                      href={`/restaurant-owner-dashboard?setup=profile&restaurantId=${encodeURIComponent(String(selectedRestaurant))}`}
                                    >
                                      <Button type="button" size="sm">
                                        Complete profile basics
                                      </Button>
                                    </Link>
                                    <Link
                                      href={`/restaurant-owner-dashboard?setup=menu&restaurantId=${encodeURIComponent(String(selectedRestaurant))}`}
                                    >
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                      >
                                        Update menu and links
                                      </Button>
                                    </Link>
                                  </div>
                                </div>
                                <div className="rounded-md border border-border p-3">
                                  <p className="text-sm font-semibold">
                                    Profile completion loop
                                  </p>
                                  {isMenuGatedFromScoutDiscoverability ? (
                                    <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2">
                                      <p className="text-xs font-semibold text-amber-900">
                                        Not discoverable in Scout yet.
                                      </p>
                                      <p className="mt-1 text-xs text-amber-800">
                                        Add at least one menu item so customers
                                        can discover your business.
                                      </p>
                                    </div>
                                  ) : null}
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    Complete profiles are easier for people to
                                    evaluate when they find you through
                                    MealScout.
                                  </p>
                                  <p className="mt-2 text-xs text-muted-foreground">
                                    Profile strength: {profileStrength}/
                                    {completionItems.length}
                                  </p>
                                  {missingCompletionItems.length ? (
                                    <div className="mt-2 space-y-2">
                                      {missingCompletionItems
                                        .slice(0, 5)
                                        .map((item) => (
                                          <div
                                            key={item.id}
                                            className="rounded border border-border p-2"
                                          >
                                            <p className="text-sm font-medium">
                                              {item.label}
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                              {item.why}
                                            </p>
                                          </div>
                                        ))}
                                      <Link href={nextCompletionCta}>
                                        <Button
                                          type="button"
                                          size="sm"
                                          className="mt-1"
                                          onClick={() =>
                                            void trackOwnerCompletionAction({
                                              entityId:
                                                String(selectedRestaurant),
                                              entityType:
                                                currentPublicEntityType as
                                                  | "restaurant"
                                                  | "truck"
                                                  | "bar",
                                              missingItemKey: String(
                                                missingCompletionItems[0]?.id ||
                                                  "menu",
                                              ),
                                            })
                                          }
                                        >
                                          Update next missing item
                                        </Button>
                                      </Link>
                                    </div>
                                  ) : (
                                    <p className="mt-2 text-xs text-muted-foreground">
                                      Profile completion looks strong. Keep
                                      details current as your business updates.
                                    </p>
                                  )}
                                  <div className="mt-3 rounded border border-border p-2">
                                    <p className="text-xs font-semibold">
                                      Profile actions taken
                                    </p>
                                    {(completionActions || []).length ? (
                                      <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                                        {completionActions
                                          .slice(0, 5)
                                          .map((action) => (
                                            <p
                                              key={`completion-data-${action.missingItemKey}`}
                                            >
                                              {completionActionLabels[
                                                action.missingItemKey
                                              ] ||
                                                `${action.missingItemKey} update clicked`}{" "}
                                              — {Number(action.count || 0)}
                                            </p>
                                          ))}
                                      </div>
                                    ) : (
                                      <p className="mt-1 text-xs text-muted-foreground">
                                        No completion actions recorded yet.
                                      </p>
                                    )}
                                  </div>
                                  <div className="mt-3 rounded border border-border p-2">
                                    <p className="text-xs font-semibold">
                                      Completion outcomes after clicks
                                    </p>
                                    {(completionReconciliation || []).length ? (
                                      <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                                        {completionReconciliation
                                          .slice(0, 5)
                                          .map((action) => (
                                            <p
                                              key={`completion-outcome-data-${action.missingItemKey}`}
                                            >
                                              {String(action.missingItemKey)}:
                                              clicked{" "}
                                              {Number(action.clicked || 0)} •
                                              now complete{" "}
                                              {Number(action.nowComplete || 0)}{" "}
                                              • still missing{" "}
                                              {Number(action.stillMissing || 0)}
                                            </p>
                                          ))}
                                      </div>
                                    ) : (
                                      <p className="mt-1 text-xs text-muted-foreground">
                                        No completion outcomes recorded yet.
                                      </p>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  </details>
                ) : null}
              </div>
            ) : setupMode === "menu" ? (
              <div
                ref={setupPanelRef}
                className="mt-4 scroll-mt-64 rounded-xl border border-orange-200 bg-white p-4 lg:scroll-mt-6"
              >
                <h3 className="text-sm font-black uppercase tracking-[0.14em] text-orange-800">
                  MealScout menu builder
                </h3>
                <p className="mt-1 text-xs text-orange-900/75">
                  Add menu items directly in MealScout. External menu URLs are
                  optional and do not replace this setup step.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link href={menuBuilderHref}>
                    <Button>Open menu builder</Button>
                  </Link>
                  <Link href={buildOwnerSetupHref("profile")}>
                    <Button variant="outline">Back to profile basics</Button>
                  </Link>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {/* Canonical business onboarding checklist */}
        {activeWorkspaceModule === "overview" &&
          currentRestaurant &&
          (() => {
            const completionTruth = (currentRestaurant as any)
              .profileCompletionTruth as ProfileCompletionTruth | null;
            const profileSetupHref = buildOwnerSetupHref("profile");
            const availabilitySetupHref = currentIsTruckBusiness
              ? currentDatedStopScheduleHref
              : buildOwnerSetupHref("schedule");
            const checklistItems = [
              {
                id: "menu",
                label:
                  completionTruth?.menuState === "approved_current"
                    ? "Approved current menu"
                    : completionTruth?.menuState ===
                        "present_needs_confirmation"
                      ? "Menu needs owner confirmation"
                      : completionTruth?.menuState === "rejected"
                        ? "Menu needs an approved current version"
                        : "Approved current menu missing",
                done:
                  completionTruth?.menuState === "approved_current",
                href: menuBuilderHref,
              },
              {
                id: "media",
                label:
                  completionTruth?.mediaState === "ready"
                    ? "Approved profile media ready"
                    : "Approved profile media missing",
                done: completionTruth?.mediaState === "ready",
                href: buildOwnerSetupHref("profile-media"),
              },
              {
                id: "availability",
                label: currentIsTruckBusiness
                  ? completionTruth?.availabilityReady === true
                    ? "Dated truck stops published"
                    : "Dated truck stops missing"
                  : completionTruth?.availabilityReady === true
                    ? "Weekly business hours published"
                    : "Weekly business hours missing",
                done: completionTruth?.availabilityReady === true,
                href: availabilitySetupHref,
              },
              {
                id: "publication",
                label:
                  completionTruth?.publicRouteState === "published"
                    ? "Public profile published"
                    : "Public profile is not published",
                done:
                  completionTruth?.publicRouteState === "published",
                href: profileSetupHref,
              },
            ] as const;
            const completedCount = checklistItems.filter(
              (item) => item.done,
            ).length;
            if (completedCount === checklistItems.length) return null;

            const completionPercent = Math.round(
              (completedCount / checklistItems.length) * 100,
            );
            const livePresenceCopy =
              completionTruth?.livePresenceState === "live"
                ? "Live now"
                : completionTruth?.livePresenceState === "stale"
                  ? "Last live signal is stale"
                  : completionTruth?.livePresenceState === "offline"
                    ? "Currently offline"
                    : "Live status unknown";
            const verificationState = (currentRestaurant as any)
              .verificationState;
            const verificationCopy =
              verificationState?.verificationLabel === "verified"
                ? "Verified"
                : verificationState?.verificationLabel === "review_required"
                  ? "Review required"
                  : verificationState?.verificationLabel === "inactive"
                    ? "Inactive"
                    : "Verification pending";

            return (
              <div
                className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4"
                data-testid="canonical-profile-completion-checklist"
              >
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-blue-900">
                      Finish setting up your business
                    </h2>
                    <p className="mt-0.5 text-xs text-blue-700">
                      {completedCount} of {checklistItems.length} required steps
                      complete
                    </p>
                  </div>
                  <span className="text-xs font-medium text-blue-600">
                    {completionPercent}%
                  </span>
                </div>
                <div
                  className="mb-3 h-1.5 w-full rounded-full bg-blue-200"
                  role="progressbar"
                  aria-label="Required profile setup completion"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={completionPercent}
                >
                  <div
                    className="h-1.5 rounded-full bg-blue-500 transition-all"
                    style={{ width: completionPercent + "%" }}
                  />
                </div>
                {ownsSelectedBusiness ? (
                  <div
                    className="mb-3 flex flex-col gap-3 rounded-lg border border-orange-200 bg-orange-50 p-3 sm:flex-row sm:items-center sm:justify-between"
                    data-testid="owner-ai-completion-entry"
                  >
                    <div className="flex items-start gap-2.5">
                      <Sparkles
                        className="mt-0.5 h-4 w-4 shrink-0 text-orange-700"
                        aria-hidden="true"
                      />
                      <p className="text-xs leading-5 text-orange-950">
                        Use any free or paid AI to prepare every missing setup
                        item plus the matching social previews. You approve the
                        complete draft before MealScout changes anything.
                      </p>
                    </div>
                    <Button asChild size="sm" className="shrink-0">
                      <Link
                        href={buildOwnerAiHref({
                          restaurantId: String(selectedRestaurant),
                          source: "completion",
                          focus: "all",
                        })}
                      >
                        Finish with AI
                      </Link>
                    </Button>
                  </div>
                ) : null}
                {ownsSelectedBusiness && currentRestaurant && (
                  <a className="mb-3 block text-sm text-orange-700 underline"
                    href={`/owner/ecosystem-sharing/${encodeURIComponent(String(currentRestaurant.id))}`}>
                    Manage optional TradeScout ecosystem sharing
                  </a>
                )}
                <ul className="space-y-2">
                  {checklistItems.map((item) => (
                    <li key={item.id} className="flex items-center gap-3">
                      {item.done ? (
                        <CheckCircle
                          className="h-4 w-4 shrink-0 text-emerald-600"
                          aria-hidden="true"
                        />
                      ) : (
                        <div
                          className="h-4 w-4 shrink-0 rounded-full border-2 border-blue-400"
                          aria-hidden="true"
                        />
                      )}
                      {item.done ? (
                        <span className="text-sm text-blue-700 line-through opacity-60">
                          {item.label}
                        </span>
                      ) : (
                        <Link href={item.href}>
                          <span className="cursor-pointer text-sm font-medium text-blue-800 underline underline-offset-2 hover:text-blue-600">
                            {item.label}
                          </span>
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
                {currentIsTruckBusiness ? (
                  <p
                    className="mt-3 rounded-md border border-blue-200 bg-white/70 px-3 py-2 text-xs text-blue-800"
                    data-testid="truck-live-presence-information"
                  >
                    Live presence: {livePresenceCopy}. This is informational and
                    does not affect profile completion.
                  </p>
                ) : null}
                <p
                  className="mt-3 rounded-md border border-blue-200 bg-white/70 px-3 py-2 text-xs text-blue-800"
                  data-testid="business-verification-information"
                >
                  Verification: {verificationCopy}. Verification is shown
                  separately and does not affect the four profile-completion
                  steps.
                </p>
              </div>
            );
          })()}

        {/* Stats Cards */}
        {activeWorkspaceModule === "deals" ? (
          <OwnerDealsWorkspace
            restaurantId={selectedRestaurant}
            businessName={currentRestaurant.name}
            canManageDeals={canManageDeals}
            stats={stats}
          />
        ) : null}

        {activeWorkspaceModule === "audience" ? (
          <OwnerAudienceWorkspace
            restaurantId={selectedRestaurant}
            businessName={currentRestaurant.name}
            businessType={currentRestaurant.businessType}
            canViewAnalytics={canViewAnalytics}
            publicProfileHref={currentPublicProfileHref}
          />
        ) : null}

        {/* Stats Cards */}
        {activeWorkspaceModule === "overview" &&
          (canManageDeals || canViewAnalytics) && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-2">
                    <BarChart3 className="h-4 w-4" />
                    Active Specials
                  </CardDescription>
                  <CardTitle className="text-3xl">
                    {stats?.activeDeals || 0}
                  </CardTitle>
                </CardHeader>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-2">
                    <Eye className="h-4 w-4" />
                    Total Views
                  </CardDescription>
                  <CardTitle className="text-3xl">
                    {stats?.totalViews || 0}
                  </CardTitle>
                </CardHeader>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-2">
                    <ShoppingCart className="h-4 w-4" />
                    Claims
                  </CardDescription>
                  <CardTitle className="text-3xl">
                    {stats?.totalClaims || 0}
                  </CardTitle>
                </CardHeader>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4" />
                    Conversion Rate
                  </CardDescription>
                  <CardTitle className="text-3xl">
                    {stats?.conversionRate?.toFixed(1) || 0}%
                  </CardTitle>
                </CardHeader>
              </Card>
            </div>
          )}

        {/* Business operations */}
        {activeWorkspaceModule === "availability" &&
        availableTabs.length > 0 ? (
          <Tabs
            id="owner-workspace-operations"
            key={defaultTab}
            defaultValue={defaultTab}
            className="scroll-mt-64 space-y-4 lg:scroll-mt-24"
          >
            {currentIsTruckBusiness ? (
              <TabsList className="grid w-full grid-cols-2 rounded-2xl bg-orange-50 p-1 sm:max-w-md">
                {canManageParkingPass ? (
                  <TabsTrigger value="foodtruck" data-testid="tab-food-truck">
                    {currentIsTruckBusiness ? (
                      <Truck className="mr-1 hidden h-4 w-4 sm:block" />
                    ) : (
                      <Clock className="mr-1 hidden h-4 w-4 sm:block" />
                    )}
                    Schedule &amp; live
                  </TabsTrigger>
                ) : null}
                {canManageParkingPass ? (
                  <TabsTrigger value="bookings">Booked stops</TabsTrigger>
                ) : null}
              </TabsList>
            ) : null}

            {canViewAnalytics ? (
              <TabsContent value="analytics">
                <div className="space-y-6">
                  {/* Analytics Header with Date Range */}
                  <Card>
                    <CardHeader>
                      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                        <div>
                          <CardTitle className="flex items-center gap-2">
                            <BarChart3 className="h-5 w-5" />
                            Performance Analytics
                          </CardTitle>
                          <CardDescription>
                            Comprehensive insights into your specials
                            performance and customer engagement
                          </CardDescription>
                        </div>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <div className="flex gap-2">
                            <input
                              type="date"
                              value={analyticsDateRange.start}
                              onChange={(e) =>
                                setAnalyticsDateRange((prev) => ({
                                  ...prev,
                                  start: e.target.value,
                                }))
                              }
                              className="px-3 py-2 border rounded-md text-sm"
                              data-testid="input-analytics-start-date"
                            />
                            <input
                              type="date"
                              value={analyticsDateRange.end}
                              onChange={(e) =>
                                setAnalyticsDateRange((prev) => ({
                                  ...prev,
                                  end: e.target.value,
                                }))
                              }
                              className="px-3 py-2 border rounded-md text-sm"
                              data-testid="input-analytics-end-date"
                            />
                          </div>
                          {hasAnalyticsAccess && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                const url = `/api/restaurants/${selectedRestaurant}/analytics/export?startDate=${analyticsDateRange.start}&endDate=${analyticsDateRange.end}&format=csv`;
                                window.open(url, "_blank");
                              }}
                              data-testid="button-export-analytics"
                            >
                              <Download className="h-4 w-4 mr-2" />
                              Export CSV
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardHeader>
                  </Card>

                  {/* Performance Overview Cards */}
                  {loadingAnalytics ? (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      {[...Array(4)].map((_, i) => (
                        <Card key={i}>
                          <CardContent className="p-6">
                            <div className="animate-pulse space-y-2">
                              <div className="h-4 bg-muted rounded w-3/4"></div>
                              <div className="h-8 bg-muted rounded w-1/2"></div>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <Card>
                        <CardContent className="p-6">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm text-muted-foreground">
                                Total Views
                              </p>
                              <p
                                className="text-2xl font-bold"
                                data-testid="text-total-views"
                              >
                                {(
                                  analyticsSummary as any
                                )?.totalViews?.toLocaleString() || 0}
                              </p>
                            </div>
                            <Eye className="h-8 w-8 text-[color:var(--accent-text)]" />
                          </div>
                          {comparison &&
                            (comparison as any)?.changes &&
                            typeof (comparison as any).changes.viewsChange ===
                              "number" && (
                              <div className="mt-2 flex items-center text-xs">
                                <TrendingUp
                                  className={`h-3 w-3 mr-1 ${
                                    (comparison as any).changes.viewsChange >= 0
                                      ? "text-[color:var(--status-success)]"
                                      : "text-[color:var(--status-error)]"
                                  }`}
                                />
                                <span
                                  className={
                                    (comparison as any).changes.viewsChange >= 0
                                      ? "text-[color:var(--status-success)]"
                                      : "text-[color:var(--status-error)]"
                                  }
                                >
                                  {(comparison as any).changes.viewsChange >= 0
                                    ? "+"
                                    : ""}
                                  {(
                                    comparison as any
                                  ).changes.viewsChange.toFixed(1)}
                                  %
                                </span>
                                <span className="text-muted-foreground ml-1">
                                  vs previous period
                                </span>
                              </div>
                            )}
                        </CardContent>
                      </Card>

                      <Card>
                        <CardContent className="p-6">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm text-muted-foreground">
                                Total Claims
                              </p>
                              <p
                                className="text-2xl font-bold"
                                data-testid="text-total-claims"
                              >
                                {(
                                  analyticsSummary as any
                                )?.totalClaims?.toLocaleString() || 0}
                              </p>
                            </div>
                            <ShoppingCart className="h-8 w-8 text-[color:var(--status-success)]" />
                          </div>
                          {comparison &&
                            (comparison as any)?.changes &&
                            typeof (comparison as any).changes.claimsChange ===
                              "number" && (
                              <div className="mt-2 flex items-center text-xs">
                                <TrendingUp
                                  className={`h-3 w-3 mr-1 ${
                                    (comparison as any).changes.claimsChange >=
                                    0
                                      ? "text-[color:var(--status-success)]"
                                      : "text-[color:var(--status-error)]"
                                  }`}
                                />
                                <span
                                  className={
                                    (comparison as any).changes.claimsChange >=
                                    0
                                      ? "text-[color:var(--status-success)]"
                                      : "text-[color:var(--status-error)]"
                                  }
                                >
                                  {(comparison as any).changes.claimsChange >= 0
                                    ? "+"
                                    : ""}
                                  {(
                                    comparison as any
                                  ).changes.claimsChange.toFixed(1)}
                                  %
                                </span>
                                <span className="text-muted-foreground ml-1">
                                  vs previous period
                                </span>
                              </div>
                            )}
                        </CardContent>
                      </Card>

                      <Card>
                        <CardContent className="p-6">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm text-muted-foreground">
                                Total Revenue
                              </p>
                              <p
                                className="text-2xl font-bold"
                                data-testid="text-total-revenue"
                              >
                                $
                                {(
                                  analyticsSummary as any
                                )?.totalRevenue?.toLocaleString() || 0}
                              </p>
                            </div>
                            <DollarSign className="h-8 w-8 text-yellow-500" />
                          </div>
                          {comparison &&
                            (comparison as any)?.changes &&
                            typeof (comparison as any).changes.revenueChange ===
                              "number" && (
                              <div className="mt-2 flex items-center text-xs">
                                <TrendingUp
                                  className={`h-3 w-3 mr-1 ${
                                    (comparison as any).changes.revenueChange >=
                                    0
                                      ? "text-[color:var(--status-success)]"
                                      : "text-[color:var(--status-error)]"
                                  }`}
                                />
                                <span
                                  className={
                                    (comparison as any).changes.revenueChange >=
                                    0
                                      ? "text-[color:var(--status-success)]"
                                      : "text-[color:var(--status-error)]"
                                  }
                                >
                                  {(comparison as any).changes.revenueChange >=
                                  0
                                    ? "+"
                                    : ""}
                                  {(
                                    comparison as any
                                  ).changes.revenueChange.toFixed(1)}
                                  %
                                </span>
                                <span className="text-muted-foreground ml-1">
                                  vs previous period
                                </span>
                              </div>
                            )}
                        </CardContent>
                      </Card>

                      <Card>
                        <CardContent className="p-6">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm text-muted-foreground">
                                Conversion Rate
                              </p>
                              <p
                                className="text-2xl font-bold"
                                data-testid="text-conversion-rate"
                              >
                                {(
                                  analyticsSummary as any
                                )?.conversionRate?.toFixed(1) || 0}
                                %
                              </p>
                            </div>
                            <TrendingUp className="h-8 w-8 text-purple-500" />
                          </div>
                          {comparison &&
                            (comparison as any)?.changes &&
                            typeof (comparison as any).changes
                              .conversionRateChange === "number" && (
                              <div className="mt-2 flex items-center text-xs">
                                <TrendingUp
                                  className={`h-3 w-3 mr-1 ${
                                    (comparison as any).changes
                                      .conversionRateChange >= 0
                                      ? "text-[color:var(--status-success)]"
                                      : "text-[color:var(--status-error)]"
                                  }`}
                                />
                                <span
                                  className={
                                    (comparison as any).changes
                                      .conversionRateChange >= 0
                                      ? "text-[color:var(--status-success)]"
                                      : "text-[color:var(--status-error)]"
                                  }
                                >
                                  {(comparison as any).changes
                                    .conversionRateChange >= 0
                                    ? "+"
                                    : ""}
                                  {(
                                    comparison as any
                                  ).changes.conversionRateChange.toFixed(1)}
                                  %
                                </span>
                                <span className="text-muted-foreground ml-1">
                                  vs previous period
                                </span>
                              </div>
                            )}
                        </CardContent>
                      </Card>
                    </div>
                  )}

                  {/* Audience analytics cards */}
                  {hasAnalyticsAccess ? (
                    <div className="grid grid-cols-2 gap-4 mt-4">
                      <Card className="border-yellow-200 dark:border-yellow-800">
                        <CardContent className="p-6">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm text-muted-foreground flex items-center gap-1">
                                <Heart className="h-3 w-3" />
                                Total Favorites
                              </p>
                              <p
                                className="text-2xl font-bold"
                                data-testid="text-total-favorites"
                              >
                                {loadingFavorites ? (
                                  <div className="animate-pulse bg-muted rounded w-16 h-8"></div>
                                ) : (
                                  favoritesAnalytics?.totalFavorites?.toLocaleString() ||
                                  0
                                )}
                              </p>
                            </div>
                            <Heart className="h-8 w-8 text-yellow-500" />
                          </div>
                          <p className="text-xs text-muted-foreground mt-2">
                            People who saved your business
                          </p>
                        </CardContent>
                      </Card>

                      <Card className="border-[color:var(--border-subtle)] dark:border-blue-800">
                        <CardContent className="p-6">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm text-muted-foreground flex items-center gap-1">
                                <Zap className="h-3 w-3" />
                                Recommendations
                              </p>
                              <p
                                className="text-2xl font-bold"
                                data-testid="text-total-recommendations"
                              >
                                {loadingRecommendations ? (
                                  <div className="animate-pulse bg-muted rounded w-16 h-8"></div>
                                ) : (
                                  recommendationsAnalytics?.totalRecommendations?.toLocaleString() ||
                                  0
                                )}
                              </p>
                            </div>
                            <Zap className="h-8 w-8 text-[color:var(--accent-text)]" />
                          </div>
                          <p className="text-xs text-muted-foreground mt-2">
                            Times shown in recommendations •{" "}
                            {recommendationsAnalytics?.clickThroughRate?.toFixed(
                              1,
                            ) || 0}
                            % CTR
                          </p>
                        </CardContent>
                      </Card>
                    </div>
                  ) : (
                    <Card className="mt-4 border-dashed border-2">
                      <CardContent className="p-6 text-center">
                        <div className="flex flex-col items-center gap-3">
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <CreditCard className="h-5 w-5" />
                            <span className="text-sm font-medium">
                              Audience analytics
                            </span>
                          </div>
                          <p className="text-sm text-muted-foreground max-w-md">
                            Ask the business owner for analytics permission.
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* Charts Section */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Revenue Timeline Chart */}
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-lg">
                          Revenue Over Time
                        </CardTitle>
                        <CardDescription>
                          Daily revenue and special performance trends
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        {analyticsTimeseries &&
                        (analyticsTimeseries as any[]).length > 0 ? (
                          <ResponsiveContainer width="100%" height={300}>
                            <LineChart data={analyticsTimeseries as any[]}>
                              <CartesianGrid strokeDasharray="3 3" />
                              <XAxis dataKey="date" />
                              <YAxis />
                              <Tooltip />
                              <Line
                                type="monotone"
                                dataKey="revenue"
                                stroke="#8884d8"
                                strokeWidth={2}
                              />
                              <Line
                                type="monotone"
                                dataKey="claims"
                                stroke="#82ca9d"
                                strokeWidth={2}
                              />
                            </LineChart>
                          </ResponsiveContainer>
                        ) : (
                          <div className="h-[300px] flex items-center justify-center text-muted-foreground">
                            No data available for selected period
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    {/* Views vs Claims Chart */}
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-lg">
                          Views vs Claims
                        </CardTitle>
                        <CardDescription>
                          Daily views and conversion tracking
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        {analyticsTimeseries &&
                        (analyticsTimeseries as any[]).length > 0 ? (
                          <ResponsiveContainer width="100%" height={300}>
                            <BarChart data={analyticsTimeseries as any[]}>
                              <CartesianGrid strokeDasharray="3 3" />
                              <XAxis dataKey="date" />
                              <YAxis />
                              <Tooltip />
                              <Bar dataKey="views" fill="#8884d8" />
                              <Bar dataKey="claims" fill="#82ca9d" />
                            </BarChart>
                          </ResponsiveContainer>
                        ) : (
                          <div className="h-[300px] flex items-center justify-center text-muted-foreground">
                            No data available for selected period
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>

                  {/* Top Deals Performance */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg">
                        Top Performing Specials
                      </CardTitle>
                      <CardDescription>
                        Your most successful specials ranked by views and
                        revenue
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      {(analyticsSummary as any)?.topDeals?.length > 0 ? (
                        <div className="space-y-4">
                          {(analyticsSummary as any).topDeals.map(
                            (deal: any, index: number) => (
                              <div
                                key={deal.dealId}
                                className="flex items-center justify-between p-4 border rounded-lg"
                              >
                                <div className="flex items-center gap-3">
                                  <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">
                                    {index + 1}
                                  </div>
                                  <div>
                                    <p className="font-medium">{deal.title}</p>
                                    <p className="text-sm text-muted-foreground">
                                      Deal ID: {deal.dealId}
                                    </p>
                                  </div>
                                </div>
                                <div className="flex gap-6 text-sm">
                                  <div className="text-center">
                                    <p className="font-medium">{deal.views}</p>
                                    <p className="text-muted-foreground">
                                      Views
                                    </p>
                                  </div>
                                  <div className="text-center">
                                    <p className="font-medium">{deal.claims}</p>
                                    <p className="text-muted-foreground">
                                      Claims
                                    </p>
                                  </div>
                                  <div className="text-center">
                                    <p className="font-medium">
                                      ${deal.revenue}
                                    </p>
                                    <p className="text-muted-foreground">
                                      Revenue
                                    </p>
                                  </div>
                                </div>
                              </div>
                            ),
                          )}
                        </div>
                      ) : (
                        <div className="text-center py-8 text-muted-foreground">
                          No special performance data available
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Customer Insights */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-lg">
                          Customer Insights
                        </CardTitle>
                        <CardDescription>
                          Understanding your customer behavior
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <p className="text-sm text-muted-foreground">
                              Repeat Customers
                            </p>
                            <p className="text-2xl font-bold">
                              {(customerInsights as any)?.repeatCustomers || 0}
                            </p>
                          </div>
                          <div>
                            <p className="text-sm text-muted-foreground">
                              Avg Order Value
                            </p>
                            <p className="text-2xl font-bold">
                              $
                              {(
                                customerInsights as any
                              )?.averageOrderValue?.toFixed(2) || 0}
                            </p>
                          </div>
                        </div>

                        {(customerInsights as any)?.peakHours?.length > 0 && (
                          <div>
                            <p className="text-sm text-muted-foreground mb-2">
                              Peak Hours
                            </p>
                            <div className="space-y-1">
                              {(customerInsights as any).peakHours
                                .slice(0, 3)
                                .map((hour: any, index: number) => (
                                  <div
                                    key={hour.hour}
                                    className="flex justify-between items-center"
                                  >
                                    <span className="text-sm">
                                      {hour.hour}:00 - {hour.hour + 1}:00
                                    </span>
                                    <span className="text-sm font-medium">
                                      {hour.count} orders
                                    </span>
                                  </div>
                                ))}
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardTitle className="text-lg">Demographics</CardTitle>
                        <CardDescription>
                          Customer age and gender breakdown
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        {(customerInsights as any)?.demographics ? (
                          <div className="space-y-4">
                            {(customerInsights as any).demographics.ageGroups
                              .length > 0 && (
                              <div>
                                <p className="text-sm text-muted-foreground mb-2">
                                  Age Groups
                                </p>
                                <div className="space-y-1">
                                  {(
                                    customerInsights as any
                                  ).demographics.ageGroups.map((group: any) => (
                                    <div
                                      key={group.range}
                                      className="flex justify-between items-center"
                                    >
                                      <span className="text-sm">
                                        {group.range}
                                      </span>
                                      <span className="text-sm font-medium">
                                        {group.count}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {(customerInsights as any).demographics
                              .genderBreakdown.length > 0 && (
                              <div>
                                <p className="text-sm text-muted-foreground mb-2">
                                  Gender Distribution
                                </p>
                                <div className="space-y-1">
                                  {(
                                    customerInsights as any
                                  ).demographics.genderBreakdown.map(
                                    (gender: any) => (
                                      <div
                                        key={gender.gender}
                                        className="flex justify-between items-center"
                                      >
                                        <span className="text-sm capitalize">
                                          {gender.gender}
                                        </span>
                                        <span className="text-sm font-medium">
                                          {gender.count}
                                        </span>
                                      </div>
                                    ),
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="text-center py-8 text-muted-foreground">
                            No demographic data available
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                </div>
              </TabsContent>
            ) : null}

            {canManageParkingPass && currentIsTruckBusiness ? (
              <TabsContent value="bookings" className="space-y-6">
                <Card
                  className="overflow-hidden border-orange-100 bg-white/95 shadow-clean"
                  data-testid="owner-booked-stops-workspace"
                >
                  <CardHeader className="border-b border-orange-100 bg-gradient-to-br from-orange-50 via-amber-50/70 to-white">
                    <CardTitle className="flex items-center gap-2">
                      <Calendar className="h-5 w-5 text-orange-700" />
                      Booked stops
                    </CardTitle>
                    <CardDescription className="max-w-2xl">
                      Review the paid host stops tied to this truck. Cancelling
                      releases the stop but does not issue a refund.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5 p-4 sm:p-6">
                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="rounded-2xl border border-orange-100 bg-orange-50/45 p-4">
                        <p className="text-xs font-bold uppercase tracking-wide text-orange-800">
                          All stops
                        </p>
                        <p className="mt-2 text-2xl font-black text-stone-950">
                          {visibleTruckBookings.length}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-emerald-100 bg-emerald-50/60 p-4">
                        <p className="text-xs font-bold uppercase tracking-wide text-emerald-800">
                          Confirmed
                        </p>
                        <p className="mt-2 text-2xl font-black text-stone-950">
                          {
                            visibleTruckBookings.filter(
                              (booking) => booking.status === "confirmed",
                            ).length
                          }
                        </p>
                      </div>
                      <div className="rounded-2xl border border-amber-100 bg-amber-50/60 p-4">
                        <p className="text-xs font-bold uppercase tracking-wide text-amber-800">
                          Upcoming spend
                        </p>
                        <p className="mt-2 text-2xl font-black text-stone-950">
                          $
                          {(
                            visibleTruckBookings
                              .filter(
                                (booking) =>
                                  booking.status === "confirmed" ||
                                  booking.status === "pending",
                              )
                              .reduce(
                                (sum, booking) =>
                                  sum + Number(booking.totalCents || 0),
                                0,
                              ) / 100
                          ).toFixed(2)}
                        </p>
                      </div>
                    </div>

                    {loadingTruckBookings ? (
                      <div className="flex items-center justify-center rounded-2xl border border-orange-100 bg-orange-50/30 py-10 text-sm text-stone-600">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading booked stops…
                      </div>
                    ) : truckBookingsFailed ? (
                      <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-900">
                        Booked stops could not be loaded. Your schedule and live
                        status are unaffected.
                      </div>
                    ) : visibleTruckBookings.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-orange-200 bg-orange-50/25 p-8 text-center">
                        <Calendar className="mx-auto h-8 w-8 text-orange-500" />
                        <p className="mt-3 font-black text-stone-950">
                          No booked stops yet
                        </p>
                        <p className="mt-1 text-sm text-stone-600">
                          Paid host stops for this truck will appear here.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {visibleTruckBookings.map((booking) => {
                          const canCancel =
                            booking.status === "pending" ||
                            booking.status === "confirmed";
                          const eventDate = booking.event?.date
                            ? new Date(booking.event.date)
                            : null;

                          return (
                            <div
                              key={booking.id}
                              className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"
                            >
                              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                                <div className="space-y-2">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p className="font-black text-stone-950">
                                      {booking.event?.host?.businessName ||
                                        "Host venue"}
                                    </p>
                                    <Badge
                                      variant={
                                        booking.status === "confirmed"
                                          ? "default"
                                          : booking.status === "pending"
                                            ? "secondary"
                                            : "outline"
                                      }
                                    >
                                      {booking.status}
                                    </Badge>
                                  </div>
                                  {booking.event?.host?.address ? (
                                    <div className="flex items-center gap-2 text-sm text-stone-600">
                                      <MapPin className="h-4 w-4" />
                                      <span>{booking.event.host.address}</span>
                                    </div>
                                  ) : null}
                                  {eventDate ? (
                                    <div className="flex items-center gap-2 text-sm text-stone-600">
                                      <Clock className="h-4 w-4" />
                                      <span>
                                        {format(eventDate, "EEE, MMM d")}
                                        {booking.event?.startTime
                                          ? ` at ${booking.event.startTime}`
                                          : ""}
                                        {booking.event?.endTime
                                          ? ` - ${booking.event.endTime}`
                                          : ""}
                                      </span>
                                    </div>
                                  ) : null}
                                </div>

                                <div className="space-y-2 text-sm lg:text-right">
                                  <p className="font-black text-stone-950">
                                    $
                                    {(
                                      Number(booking.totalCents || 0) / 100
                                    ).toFixed(2)}{" "}
                                    total
                                  </p>
                                  <p className="text-stone-500">
                                    Host fee $
                                    {(
                                      Number(booking.hostPriceCents || 0) / 100
                                    ).toFixed(2)}{" "}
                                    + platform fee $
                                    {(
                                      Number(booking.platformFeeCents || 0) /
                                      100
                                    ).toFixed(2)}
                                  </p>
                                  {canCancel ? (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      disabled={bookingCancelMutation.isPending}
                                      onClick={() => setBookingToCancel(booking)}
                                    >
                                      Cancel stop
                                    </Button>
                                  ) : null}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </CardContent>
                </Card>

                <AlertDialog
                  open={Boolean(bookingToCancel)}
                  onOpenChange={(open) => {
                    if (!open && !bookingCancelMutation.isPending) {
                      setBookingToCancel(null);
                    }
                  }}
                >
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Cancel this booked stop?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This releases the stop at {bookingToCancel?.event?.host?.businessName || "the host venue"}.
                        The booking payment will not be refunded.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={bookingCancelMutation.isPending}>
                        Keep stop
                      </AlertDialogCancel>
                      <AlertDialogAction
                        disabled={bookingCancelMutation.isPending || !bookingToCancel}
                        onClick={(event) => {
                          event.preventDefault();
                          if (bookingToCancel) {
                            bookingCancelMutation.mutate(bookingToCancel.id);
                          }
                        }}
                        className="bg-red-700 text-white hover:bg-red-800"
                      >
                        {bookingCancelMutation.isPending
                          ? "Cancelling…"
                          : "Cancel without refund"}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </TabsContent>
            ) : null}

            {canManageParkingPass ? (
              <TabsContent value="foodtruck" className="space-y-6">
                <Card
                  className="overflow-hidden border-orange-100 bg-white/95 shadow-clean"
                  data-testid="owner-availability-workspace"
                >
                  <CardHeader className="border-b border-orange-100 bg-gradient-to-br from-orange-50 via-amber-50/70 to-white">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <CardTitle className="flex items-center gap-2 text-xl">
                          {currentIsTruckBusiness ? (
                            <Truck className="h-5 w-5 text-orange-700" />
                          ) : (
                            <Clock className="h-5 w-5 text-orange-700" />
                          )}
                          {currentIsTruckBusiness
                            ? "Schedule & live"
                            : "Hours & location"}
                        </CardTitle>
                        <CardDescription className="mt-1 max-w-2xl">
                          {currentIsTruckBusiness
                            ? "Keep your weekly service hours, saved location, and live pin current."
                            : "Keep the hours and map location on your public profile current."}
                        </CardDescription>
                      </div>
                      <Badge
                        variant="outline"
                        className="border-orange-200 bg-white text-orange-900"
                      >
                        {currentIsTruckBusiness
                          ? "Food truck"
                          : "Restaurant"}
                      </Badge>
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-5 p-4 sm:p-6">
                    <div className="grid gap-4 lg:grid-cols-2">
                      {currentIsTruckBusiness ? (
                        <section
                          className="rounded-2xl border border-orange-100 bg-orange-50/45 p-4 sm:p-5"
                          data-testid="owner-live-location-panel"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="flex min-w-0 items-start gap-3">
                              <span
                                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${
                                  isBroadcasting
                                    ? "bg-emerald-100 text-emerald-700"
                                    : connectionStatus === "connecting"
                                      ? "bg-amber-100 text-amber-700"
                                      : "bg-white text-orange-700 ring-1 ring-orange-100"
                                }`}
                              >
                                {connectionStatus === "connecting" ? (
                                  <Loader2 className="h-5 w-5 animate-spin" />
                                ) : isBroadcasting ? (
                                  <Radio className="h-5 w-5" />
                                ) : (
                                  <WifiOff className="h-5 w-5" />
                                )}
                              </span>
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <h3 className="font-black text-[color:var(--text-primary)]">
                                    Live location
                                  </h3>
                                  <Badge
                                    className={
                                      isBroadcasting
                                        ? "bg-emerald-600 text-white"
                                        : connectionStatus === "connecting"
                                          ? "bg-amber-500 text-white"
                                          : "bg-stone-200 text-stone-800"
                                    }
                                    data-testid="text-connection-status"
                                  >
                                    {connectionStatus === "connecting"
                                      ? "Finding location"
                                      : isBroadcasting
                                        ? "Live"
                                        : "Not live"}
                                  </Badge>
                                </div>
                                <p className="mt-1 text-sm text-[color:var(--text-muted)]">
                                  {connectionStatus === "connecting"
                                    ? "Keep this page open while MealScout finds your current stop."
                                    : isBroadcasting
                                      ? "Customers can see your current truck location."
                                      : "Share your current stop while you are serving."}
                                </p>
                              </div>
                            </div>
                          </div>

                          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                            {!isBroadcasting ? (
                              <Button
                                onClick={handleStartBroadcasting}
                                disabled={
                                  startFoodTruckSessionMutation.isPending
                                }
                                className="min-h-11 flex-1 bg-emerald-600 text-white hover:bg-emerald-700"
                                data-testid="button-start-broadcasting"
                              >
                                {startFoodTruckSessionMutation.isPending ? (
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                ) : (
                                  <Play className="mr-2 h-4 w-4" />
                                )}
                                {hasProfileLocationTools
                                  ? "Go live"
                                  : "Location permission required"}
                              </Button>
                            ) : (
                              <Button
                                onClick={handleStopBroadcasting}
                                disabled={
                                  stopFoodTruckSessionMutation.isPending
                                }
                                variant="destructive"
                                className="min-h-11 flex-1"
                                data-testid="button-stop-broadcasting"
                              >
                                {stopFoodTruckSessionMutation.isPending ? (
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                ) : (
                                  <Square className="mr-2 h-4 w-4" />
                                )}
                                Stop sharing
                              </Button>
                            )}
                            {isBroadcasting ? (
                              <ShareButton
                                url={liveShareUrl}
                                title={liveShareTitle}
                                description={liveShareDescription}
                                variant="outline"
                                size="sm"
                                className="min-h-11 flex-1 sm:flex-none"
                              />
                            ) : null}
                          </div>

                          {currentLocation ? (
                            <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-emerald-100 bg-white p-3">
                              <div className="flex min-w-0 items-center gap-2">
                                <MapPin className="h-4 w-4 shrink-0 text-emerald-700" />
                                <div className="min-w-0">
                                  <p className="text-sm font-bold">
                                    Current pin captured
                                  </p>
                                  <p
                                    className="text-xs text-[color:var(--text-muted)]"
                                    data-testid="text-last-broadcast"
                                  >
                                    {lastBroadcast
                                      ? `Updated ${format(lastBroadcast, "p")}`
                                      : "Ready to send when sharing starts"}
                                  </p>
                                </div>
                              </div>
                              {gpsAccuracy ? (
                                <Badge
                                  variant="outline"
                                  className="shrink-0 bg-white"
                                >
                                  {gpsAccuracy > 1000
                                    ? "Approximate pin"
                                    : "Precise pin"}
                                </Badge>
                              ) : null}
                            </div>
                          ) : null}

                          {locationError ? (
                            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3">
                              <div className="flex items-start gap-2">
                                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-700" />
                                <p
                                  className="text-sm text-red-900"
                                  data-testid="text-location-error"
                                >
                                  {/approximate/i.test(locationError)
                                    ? "MealScout is using an approximate pin. Turn on precise location for a better result."
                                    : /denied|permission/i.test(locationError)
                                      ? "Location access is off. Allow location access for MealScout and try again."
                                      : "MealScout could not refresh your live pin. Check location access and your connection, then try again."}
                                </p>
                              </div>
                            </div>
                          ) : null}

                          <p className="mt-4 text-xs leading-5 text-[color:var(--text-muted)]">
                            Keep this page open while you are live. MealScout
                            stops sharing when location updates stop.
                          </p>
                        </section>
                      ) : null}

                      <section
                        className={`rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-4 sm:p-5 ${
                          currentIsTruckBusiness ? "" : "lg:col-span-2"
                        }`}
                        data-testid="owner-saved-location-panel"
                      >
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                          <div className="flex min-w-0 items-start gap-3">
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-orange-100 text-orange-700">
                              <MapPin className="h-5 w-5" />
                            </span>
                            <div className="min-w-0">
                              <h3 className="font-black text-[color:var(--text-primary)]">
                                {currentIsTruckBusiness
                                  ? "Saved location"
                                  : "Restaurant location"}
                              </h3>
                              <p className="mt-1 text-sm text-[color:var(--text-muted)]">
                                {currentIsTruckBusiness
                                  ? "Customers see this location whenever your truck is not live."
                                  : "Use your device to refresh the map pin for this address."}
                              </p>
                            </div>
                          </div>
                          <Button
                            onClick={handleUpdateRestaurantLocation}
                            disabled={
                              isUpdatingLocation ||
                              updateRestaurantLocationMutation.isPending
                            }
                            variant="outline"
                            className="min-h-11 w-full sm:w-auto"
                            data-testid="button-update-location"
                          >
                            {isUpdatingLocation ||
                            updateRestaurantLocationMutation.isPending ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="mr-2 h-4 w-4" />
                            )}
                            {hasProfileLocationTools
                              ? "Use current location"
                              : "Location permission required"}
                          </Button>
                        </div>

                        <div className="mt-4 rounded-xl bg-[var(--bg-surface-muted)] p-3">
                          <p className="text-xs font-bold uppercase tracking-[0.1em] text-[color:var(--text-muted)]">
                            Saved on profile
                          </p>
                          <p
                            className="mt-1 text-sm font-bold text-[color:var(--text-primary)]"
                            data-testid="text-restaurant-location"
                          >
                            {[currentRestaurant?.city, currentRestaurant?.state]
                              .filter(Boolean)
                              .join(", ") || "No saved city or state"}
                          </p>
                        </div>

                        {locationUpdateError ? (
                          <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3">
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-700" />
                            <p
                              className="text-sm text-red-900"
                              data-testid="text-location-update-error"
                            >
                              {/denied|permission/i.test(locationUpdateError)
                                ? "Location access is off. Allow location access for MealScout and try again."
                                : "MealScout could not update this location. Check location access and try again."}
                            </p>
                          </div>
                        ) : null}

                        {currentIsTruckBusiness ? (
                          <div className="mt-4 border-t border-[color:var(--border-subtle)] pt-4">
                            <p className="text-sm font-bold">Booked stops</p>
                            <p className="mt-1 text-xs text-[color:var(--text-muted)]">
                              Manage host bookings and scheduled parking
                              separately from your weekly service hours.
                            </p>
                            <Button
                              asChild
                              variant="ghost"
                              className="mt-2 px-0 text-orange-800"
                            >
                              <Link href={currentDatedStopScheduleHref}>
                                Manage booked stops
                              </Link>
                            </Button>
                          </div>
                        ) : null}
                      </section>
                    </div>

                    <section
                      className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-4 sm:p-5"
                      data-testid="owner-weekly-hours-panel"
                    >
                      <div className="mb-4 flex items-start gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
                          <Clock className="h-5 w-5" />
                        </span>
                        <div>
                          <h3 className="font-black text-[color:var(--text-primary)]">
                            {currentIsTruckBusiness
                              ? "Weekly service hours"
                              : "Weekly hours"}
                          </h3>
                          <p className="mt-1 text-sm text-[color:var(--text-muted)]">
                            {currentIsTruckBusiness
                              ? "Set the usual days and times customers can find your truck."
                              : "Set the opening and closing hours shown on your public profile."}
                          </p>
                        </div>
                      </div>

                      <Form {...operatingHoursForm}>
                        <form
                          onSubmit={operatingHoursForm.handleSubmit(
                            handleOperatingHoursSubmit,
                          )}
                          className="space-y-4"
                        >
                          <div className="grid gap-3 lg:grid-cols-2">
                            {[
                              "mon",
                              "tue",
                              "wed",
                              "thu",
                              "fri",
                              "sat",
                              "sun",
                            ].map((day) => {
                              const dayName = {
                                mon: "Monday",
                                tue: "Tuesday",
                                wed: "Wednesday",
                                thu: "Thursday",
                                fri: "Friday",
                                sat: "Saturday",
                                sun: "Sunday",
                              }[day];
                              const timeSlots =
                                operatingHoursForm.watch(
                                  day as keyof OperatingHoursFormData,
                                ) || [];

                              return (
                                <div
                                  key={day}
                                  className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)]/55 p-3"
                                >
                                  <div className="flex min-h-9 items-center justify-between gap-3">
                                    <FormLabel className="text-sm font-black">
                                      {dayName}
                                    </FormLabel>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={() =>
                                        addTimeSlot(
                                          day as keyof OperatingHoursFormData,
                                        )
                                      }
                                      disabled={timeSlots.length >= 3}
                                      data-testid={`button-add-${day}-hours`}
                                    >
                                      <Plus className="mr-1 h-4 w-4" />
                                      Add time
                                    </Button>
                                  </div>

                                  {timeSlots.length === 0 ? (
                                    <p
                                      className="mt-2 text-sm text-[color:var(--text-muted)]"
                                      data-testid={`text-${day}-closed`}
                                    >
                                      Closed
                                    </p>
                                  ) : (
                                    <div className="mt-2 space-y-2">
                                      {timeSlots.map((slot, index) => (
                                        <div
                                          key={index}
                                          className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-start gap-2"
                                        >
                                          <FormField
                                            control={operatingHoursForm.control}
                                            name={`${day}.${index}.open` as any}
                                            render={({ field }) => (
                                              <FormItem>
                                                <FormControl>
                                                  <Input
                                                    {...field}
                                                    type="time"
                                                    aria-label={`${dayName} opening time`}
                                                    data-testid={`input-${day}-${index}-open`}
                                                  />
                                                </FormControl>
                                                <FormMessage />
                                              </FormItem>
                                            )}
                                          />
                                          <span className="pt-2 text-sm text-[color:var(--text-muted)]">
                                            to
                                          </span>
                                          <FormField
                                            control={operatingHoursForm.control}
                                            name={
                                              `${day}.${index}.close` as any
                                            }
                                            render={({ field }) => (
                                              <FormItem>
                                                <FormControl>
                                                  <Input
                                                    {...field}
                                                    type="time"
                                                    aria-label={`${dayName} closing time`}
                                                    data-testid={`input-${day}-${index}-close`}
                                                  />
                                                </FormControl>
                                                <FormMessage />
                                              </FormItem>
                                            )}
                                          />
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="h-10 w-10"
                                            aria-label={`Remove ${dayName} time`}
                                            onClick={() =>
                                              removeTimeSlot(
                                                day as keyof OperatingHoursFormData,
                                                index,
                                              )
                                            }
                                            data-testid={`button-remove-${day}-${index}-hours`}
                                          >
                                            <Trash2 className="h-4 w-4" />
                                          </Button>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>

                          <div className="flex flex-col gap-3 border-t border-[color:var(--border-subtle)] pt-4 sm:flex-row sm:items-center">
                            <Button
                              type="submit"
                              disabled={updateOperatingHoursMutation.isPending}
                              className="min-h-11 w-full sm:w-auto"
                              data-testid="button-save-operating-hours"
                            >
                              {updateOperatingHoursMutation.isPending ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <Save className="mr-2 h-4 w-4" />
                              )}
                              {currentIsTruckBusiness
                                ? "Save schedule"
                                : "Save hours"}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => operatingHoursForm.reset()}
                              className="min-h-11 w-full sm:w-auto"
                              data-testid="button-reset-operating-hours"
                            >
                              <RotateCcw className="mr-2 h-4 w-4" />
                              Discard changes
                            </Button>
                          </div>
                        </form>
                      </Form>
                    </section>

                  </CardContent>
                </Card>
              </TabsContent>
            ) : null}
          </Tabs>
        ) : null}
      </div>
    </BusinessWorkspaceShell>
  );
}
