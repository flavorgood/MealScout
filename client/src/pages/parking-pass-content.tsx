import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { format } from "date-fns";
import {
  PARKING_PASS_BOOKING_DAYS,
  PARKING_PASS_MEAL_WINDOWS,
  PARKING_PASS_SLOT_TYPES,
  addMinutesToTime,
  getSlotWindowMinutesWithCleanup,
  isSlotWithinHours,
} from "@shared/parkingPassSlots";
import { isStaffOrAdminUserType } from "@shared/profileAccessPolicy";
import {
  AlertCircle,
  Calendar,
  Clock,
  Loader2,
  Navigation,
  Plus,
  Share2,
  Truck,
} from "lucide-react";
import { Calendar as DatePickerCalendar } from "@/components/ui/calendar";
import { GoogleMapPicker } from "@/components/maps/GoogleMapPicker";
import type { MapPickerPin } from "@/components/maps/GoogleMapPicker";
import type {
  MapTrafficCell,
} from "@/components/maps/map-adapter.types";
import { BookingPaymentModal } from "@/components/booking-payment-modal";
import { EditOccurrenceDialog } from "@/components/edit-occurrence-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { useParkingBookedSchedule } from "@/hooks/useParkingBookedSchedule";
import { useEffectiveLocationContext } from "@/hooks/useEffectiveLocationContext";
import ShareButton from "@/components/share-button";
import LongPressHelp from "@/components/long-press-help";
import { initFacebookSDK, postToFacebook } from "@/lib/facebook";
import { apiUrl } from "@/lib/api";
import { apiRequest } from "@/lib/queryClient";
import {
  normalizeParkingPassLocationSearch,
  parkingPassLocationMatches,
} from "@/lib/parkingPassSearch";
import {
  parseParkingPassOwnerNavigation,
  reconcileParkingPassTopTab,
  selectRequestedAccessibleTruck,
  type ParkingPassHostToolsTab,
  type ParkingPassTopTab,
} from "@/lib/parkingPassOwnerNavigation";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  ParkingScheduleCalendar,
  type ParkingScheduleItem,
} from "@/components/parking-schedule-calendar";
import { PlaceAutocompleteInput } from "@/components/maps/place-autocomplete-input";
import {
  ParkingPassTripPlanner,
  type TripPlannerHost,
} from "@/components/parking-pass-trip-planner";
import { AdminRouteConversionCard, HostRouteDemandCard } from "@/components/parking-route-demand-cards";

interface Host {
  id: string;
  businessName: string;
  address: string;
  locationType: string;
  city?: string | null;
  state?: string | null;
  spotImageUrl?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  expectedFootTraffic?: string | null;
  contactPhone?: string | null;
  amenities?: Record<string, boolean> | null;
  stripeConnectAccountId?: string | null;
  stripeChargesEnabled?: boolean | null;
  stripePayoutsEnabled?: boolean | null;
  stripeOnboardingCompleted?: boolean | null;
  showFuelPrices?: boolean | null;
  fuelPrices?: {
    regularCents?: number | null;
    midgradeCents?: number | null;
    premiumCents?: number | null;
    dieselCents?: number | null;
    updatedAt?: string | null;
    source?: string | null;
  } | null;
}

interface HostPassListing {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  maxTrucks: number;
  hardCapEnabled?: boolean;
  seriesId?: string | null;
  status: string;
  requiresPayment?: boolean;
  qualityFlags?: string[];
  hostPriceCents?: number;
  breakfastPriceCents?: number | null;
  lunchPriceCents?: number | null;
  dinnerPriceCents?: number | null;
  dailyPriceCents?: number | null;
  weeklyPriceCents?: number | null;
  monthlyPriceCents?: number | null;
}

interface ParkingPassListing {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  requiresPayment?: boolean;
  paymentsEnabled?: boolean;
  lastConfirmedAt?: string | null;
  maxTrucks?: number;
  hardCapEnabled?: boolean;
  spotCount?: number;
  bookedSpots?: number;
  availableSpotNumbers?: number[];
  hostPriceCents?: number;
  breakfastPriceCents?: number | null;
  lunchPriceCents?: number | null;
  dinnerPriceCents?: number | null;
  dailyPriceCents?: number | null;
  weeklyPriceCents?: number | null;
  monthlyPriceCents?: number | null;
  host: Host;
  bookings?: Array<{
    truckId: string;
    truckName: string;
    slotType?: string | null;
    spotNumber?: number | null;
  }>;
}

type PublicMapLocation = {
  id: string;
  type: "host_location" | "event" | "supplier";
  hostId?: string | null;
  supplierId?: string | null;
  name?: string | null;
  category?: string | null;
  categoryLabel?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  profileUrl?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  spotImageUrl?: string | null;
  latitude?: string | null;
  longitude?: string | null;
};

type MapLocationsResponse = {
  hostLocations: PublicMapLocation[];
  eventLocations?: PublicMapLocation[];
  supplierLocations?: PublicMapLocation[];
};

type MapFootTrafficResponse = {
  generatedAt: string;
  windowMinutes: number;
  requestedWindowMinutes: number;
  mode: "avg" | "live";
  signalQuality?: {
    tier: "sparse" | "emerging" | "solid";
    isLowDensity: boolean;
  };
  googlePlaces?: {
    enabled: boolean;
    used: boolean;
    error: string | null;
    cells: MapTrafficCell[];
  };
  firstParty?: {
    totalPings: number;
    totalUniqueActors: number;
    cells: MapTrafficCell[];
  };
  supplySignals?: {
    cells: MapTrafficCell[];
  };
  cells: MapTrafficCell[];
};

type ParkingPassLocationGroup = {
  key: string;
  host: Host;
  listings: ParkingPassListing[];
};

interface ManualScheduleEntry {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  locationName?: string | null;
  address: string;
  city?: string | null;
  state?: string | null;
  notes?: string | null;
  isPublic?: boolean | null;
}

interface TruckScheduleEntry {
  type: "booking" | "accepted_interest" | "manual";
  status: string;
  createdAt?: string;
  bookingConfirmedAt?: string | null;
  bookingId?: string;
  slotType?: string | null;
  event?: {
    id: string;
    date: string;
    startTime: string;
    endTime: string;
    status: string;
    requiresPayment?: boolean | null;
  };
  host?: {
    id?: string;
    businessName: string;
    address: string;
    locationType: string;
  };
  manual?: {
    id: string;
    date: string;
    startTime: string;
    endTime: string;
    locationName?: string | null;
    address: string;
    city?: string | null;
    state?: string | null;
    notes?: string | null;
  };
}

interface TruckParkingReport {
  id: string;
  truckId: string;
  date: string;
  sourceType: string;
  bookingId?: string | null;
  manualScheduleId?: string | null;
  hostId?: string | null;
  locationName?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  rating?: number | null;
  arrivalCleanliness?: number | null;
  customersServed?: number | null;
  salesCents?: number | null;
  notes?: string | null;
}

type GeoPoint = { lat: number; lng: number };

type PlaceIntelligenceResponse = {
  available: boolean;
  source: "google_places";
  fetchedAt: string;
  reason?: string;
  place?: {
    placeId: string;
    name: string;
    formattedAddress: string;
    latitude: number | null;
    longitude: number | null;
    primaryType: string | null;
    types: string[];
    businessStatus: string | null;
    phone: string | null;
    websiteUri: string | null;
    googleMapsUri: string | null;
    openNow: boolean | null;
    weekdayDescriptions: string[];
    fuelPrices: {
      regularCents: number | null;
      midgradeCents: number | null;
      premiumCents: number | null;
      dieselCents: number | null;
      updatedAt: string | null;
      source: "google_places";
    } | null;
    parkingOptions: Record<string, boolean> | null;
    restroom: boolean | null;
    accessibilityOptions: Record<string, boolean> | null;
  };
};

type OperatorSupportKind = "gas" | "propane" | "supply" | "support";

type OperatorSupportPlace = {
  placeId: string;
  kind: OperatorSupportKind;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  primaryType: string | null;
  businessStatus: string | null;
  phone: string | null;
  googleMapsUri: string | null;
  straightLineMiles: number;
  driveDistanceMeters: number | null;
  driveDurationSeconds: number | null;
  source: "google_places";
};

type OperatorSupportResponse = {
  available: boolean;
  source: "google_places";
  fetchedAt: string;
  reason?: string;
  categories: Record<OperatorSupportKind, OperatorSupportPlace[]>;
};

type MapRouteSummaryResponse = {
  distanceMeters: number;
  durationSeconds: number;
  travelMode: "DRIVE" | "WALK" | "BICYCLE";
  source: "google_routes";
  encodedPolyline?: string | null;
};

type RouteCorridorHost = {
  locationId: string;
  hostId: string;
  name: string;
  address: string;
  city: string;
  state: string;
  latitude: number;
  longitude: number;
  spotImageUrl: string | null;
  distanceFromRouteMiles: number;
  routeProgressMiles: number;
  journeyDistanceMeters: number | null;
  journeyDurationSeconds: number | null;
  addedDistanceMeters: number | null;
  addedDurationSeconds: number | null;
  directionsUri: string;
  source: "mealscout_parking_pass";
};

type RouteCorridorSupportPlace = OperatorSupportPlace & {
  originToStopDistanceMeters: number | null;
  originToStopDurationSeconds: number | null;
  stopToDestinationDistanceMeters: number | null;
  stopToDestinationDurationSeconds: number | null;
  journeyDistanceMeters: number | null;
  journeyDurationSeconds: number | null;
  addedDistanceMeters: number | null;
  addedDurationSeconds: number | null;
  directionsUri: string;
};

type RouteCorridorResponse = {
  available: boolean;
  source: "google_routes_places";
  fetchedAt: string;
  route: {
    distanceMeters: number;
    durationSeconds: number;
    encodedPolyline: string;
    path: GeoPoint[];
    directionsUri: string;
  };
  parkingPassHosts: RouteCorridorHost[];
  categories: Record<OperatorSupportKind, RouteCorridorSupportPlace[]>;
  corridor: {
    hostRadiusMiles: number;
    mapHostLocationsReady: boolean;
  };
};

type OperationalSupportPin = {
  key: string;
  position: GeoPoint;
  name: string;
  addressLabel: string;
  categoryLabel: string;
  profileUrl: string | null;
  googleMapsUri: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  kind: OperatorSupportKind;
  source: "mealscout_partner" | "google_places";
  distanceMiles: number | null;
  driveDurationSeconds: number | null;
};

type PlaceDetailsResponse = {
  place?: {
    placeId: string;
    formattedAddress: string;
    city: string;
    state: string;
    latitude: number | null;
    longitude: number | null;
  };
};

type SocialAutopostSettings = {
  platforms: {
    facebook: boolean;
    instagram: boolean;
    x: boolean;
  };
  triggers: {
    schedule: boolean;
    booking: boolean;
    live: boolean;
    deal: boolean;
  };
  promptBeforePost: boolean;
};

const defaultSocialAutopostSettings: SocialAutopostSettings = {
  platforms: {
    facebook: true,
    instagram: true,
    x: true,
  },
  triggers: {
    schedule: true,
    booking: true,
    live: true,
    deal: true,
  },
  promptBeforePost: true,
};

type SocialConnectionStatus = {
  platform: "facebook" | "instagram" | "x";
  connected: boolean;
  displayName?: string | null;
  externalAccountUrl?: string | null;
  lastPublishAt?: string | null;
  lastError?: string | null;
};

type SocialPublishingConfig = {
  platforms?: Record<
    SocialConnectionStatus["platform"],
    {
      provider: "meta" | "x";
      configured: boolean;
      callbackUrl: string;
    }
  >;
  missing?: string[];
};

const SOCIAL_PREOPEN_PROMPT_MINUTES = 90;

const formatSlotLabel = (slot: string) =>
  slot.charAt(0).toUpperCase() + slot.slice(1);

const resolveEventMenuIdFromQuery = () => {
  try {
    const params = new URLSearchParams(window.location.search);
    return String(
      params.get("eventMenuId") || params.get("menuId") || "",
    ).trim();
  } catch {
    return "";
  }
};

const buildReportKey = (report: {
  bookingId?: string | null;
  manualScheduleId?: string | null;
}) => {
  if (report.bookingId) return `booking:${report.bookingId}`;
  if (report.manualScheduleId) return `manual:${report.manualScheduleId}`;
  return null;
};

const hasListingPricing = (listing: ParkingPassListing) =>
  (listing.breakfastPriceCents ?? 0) > 0 ||
  (listing.lunchPriceCents ?? 0) > 0 ||
  (listing.dinnerPriceCents ?? 0) > 0 ||
  (listing.dailyPriceCents ?? 0) > 0 ||
  (listing.weeklyPriceCents ?? 0) > 0 ||
  (listing.monthlyPriceCents ?? 0) > 0;

const isParkingPassListingPublicVisible = (listing: ParkingPassListing) => {
  const status = String(listing?.status || "").toLowerCase();
  if (
    status &&
    [
      "deleted",
      "archived",
      "inactive",
      "cancelled",
      "canceled",
      "expired",
      "unavailable",
      "draft",
    ].includes(status)
  ) {
    return false;
  }
  const hostStatus = String((listing as any)?.host?.status || "").toLowerCase();
  if (
    hostStatus &&
    [
      "deleted",
      "archived",
      "inactive",
      "cancelled",
      "canceled",
      "expired",
      "unavailable",
    ].includes(hostStatus)
  ) {
    return false;
  }
  if (
    (listing as any)?.deletedAt ||
    (listing as any)?.archivedAt ||
    (listing as any)?.cancelledAt
  ) {
    return false;
  }
  if ((listing as any)?.host?.deletedAt || (listing as any)?.host?.archivedAt) {
    return false;
  }
  return true;
};

const isValidParkingPassTruck = (business: any): boolean => {
  if (!business || !business.id) return false;
  const type = String(business.businessType || "").toLowerCase();
  return business.isFoodTruck === true || type === "food_truck";
};

const normalizeDollar = (value: string | number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed);
};

const parseOptionalDollar = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round(parsed));
};

const formatFuelCents = (value?: number | null) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return `$${(value / 100).toFixed(2)}`;
};

const distanceMilesBetween = (from: GeoPoint, to: GeoPoint) => {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(from.lat)) *
      Math.cos(toRad(to.lat)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMiles * c;
};

const formatJourneyDuration = (seconds: number) => {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
};

const formatJourneyMiles = (meters: number) =>
  `${(Math.max(0, meters) / 1609.344).toFixed(1)} mi`;

const formatJourneyDetour = (seconds: number | null) => {
  if (seconds === null || !Number.isFinite(seconds)) {
    return "Detour estimate unavailable";
  }
  if (seconds < 60) return "Under 1 min added";
  return `+${Math.max(1, Math.round(seconds / 60))} min`;
};

const buildSlotOptions = (listing: ParkingPassListing) =>
  [
    {
      label: "Breakfast",
      type: "breakfast",
      priceCents: listing.breakfastPriceCents,
    },
    {
      label: "Lunch",
      type: "lunch",
      priceCents: listing.lunchPriceCents,
    },
    {
      label: "Dinner",
      type: "dinner",
      priceCents: listing.dinnerPriceCents,
    },
    {
      label: "Daily",
      type: "daily",
      priceCents: listing.dailyPriceCents,
    },
    {
      label: "Weekly",
      type: "weekly",
      priceCents: listing.weeklyPriceCents,
    },
    {
      label: "Monthly",
      type: "monthly",
      priceCents: listing.monthlyPriceCents,
    },
  ].filter(
    (slot) =>
      slot.priceCents !== null &&
      slot.priceCents !== undefined &&
      Number.isFinite(Number(slot.priceCents)) &&
      Number(slot.priceCents) >= 0 &&
      isSlotWithinHours(
        slot.type as (typeof PARKING_PASS_SLOT_TYPES)[number],
        listing.startTime,
        listing.endTime,
      ) &&
      isSlotBookableByTime(
        listing,
        slot.type as (typeof PARKING_PASS_SLOT_TYPES)[number],
      ),
  );

const getFeeCentsForSlots = (slotTypes: string[]) => {
  if (!slotTypes.length) return 0;
  const slotType = slotTypes[0] as (typeof PARKING_PASS_SLOT_TYPES)[number];
  const bookingDays = PARKING_PASS_BOOKING_DAYS[slotType] ?? 1;
  return 1000 * bookingDays;
};

const parseCoord = (value: number | string | null | undefined) => {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeLocationValue = (value?: string | null) =>
  (value ?? "").trim().toLowerCase();

const buildLocationKey = (
  address?: string | null,
  city?: string | null,
  state?: string | null,
) =>
  [
    normalizeLocationValue(address),
    normalizeLocationValue(city),
    normalizeLocationValue(state),
  ].join("|");

const buildAddressLabel = (address?: string, city?: string, state?: string) =>
  [address, city, state, "USA"]
    .map((value) => (value ?? "").trim())
    .filter(Boolean)
    .join(", ");

const pointsMatch = (left: GeoPoint | null, right: GeoPoint | null) => {
  if (!left || !right) return false;
  return (
    Math.abs(left.lat - right.lat) < 1e-6 &&
    Math.abs(left.lng - right.lng) < 1e-6
  );
};

const buildHostAddress = (host?: Host | null) => {
  const base = (host?.address ?? "").trim();
  if (!base) return "";
  const baseLower = base.toLowerCase();
  const city = (host?.city ?? "").trim();
  const state = (host?.state ?? "").trim();
  const parts: string[] = [base];
  if (city && !baseLower.includes(city.toLowerCase())) {
    parts.push(city);
  }
  if (state && !baseLower.includes(state.toLowerCase())) {
    parts.push(state);
  }
  parts.push("USA");
  return parts.join(", ");
};

const getListingDateKey = (value: string) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes("T")) {
    const key = raw.split("T")[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return format(parsed, "yyyy-MM-dd");
};

const buildDateTimeFromKey = (date: string | Date, time: string) => {
  const dateKey =
    typeof date === "string" ? getListingDateKey(date) : format(date, "yyyy-MM-dd");
  const match = String(time || "").match(/^(\d{1,2}):(\d{2})/);
  if (!dateKey || !match) return null;
  const parsed = new Date(`${dateKey}T00:00:00`);
  parsed.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

function isSlotBookableByTime(
  listing: ParkingPassListing,
  slotType: (typeof PARKING_PASS_SLOT_TYPES)[number],
  now = new Date(),
) {
  const listingDate = new Date(listing.date);
  const listingDayStart = new Date(listingDate);
  listingDayStart.setHours(0, 0, 0, 0);

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  if (listingDayStart < todayStart) return false;
  if (listingDayStart > todayStart) return true;

  const window = getSlotWindowMinutesWithCleanup(
    slotType,
    listing.startTime,
    listing.endTime,
  );
  if (!window) return false;

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return window.startMinutes > nowMinutes;
}

const normalizeLocationPart = (value: string | null | undefined) =>
  (value || "").trim().toLowerCase().replace(/\s+/g, " ");

const getLocationKey = (listing: ParkingPassListing) => {
  const addressKey = [
    normalizeLocationPart(listing.host?.address),
    normalizeLocationPart(listing.host?.city),
    normalizeLocationPart(listing.host?.state),
  ]
    .filter(Boolean)
    .join("|");

  if (addressKey) return addressKey;
  return listing.host?.id || listing.id;
};

const defaultMapCenter = {
  lat: 39.8283,
  lng: -98.5795,
};

export default function ParkingPassPage() {
  const { isAuthenticated, user } = useAuth();
  const { effectiveLocationContext } = useEffectiveLocationContext();
  const { toast } = useToast();
  const [location, setLocation] = useLocation();
  const { data: businessAccess } = useQuery<{
    hasAnyAccess: boolean;
    linkState?: "linked" | "not_attached";
    guidance?: string | null;
    primaryRestaurant?: { id: string; name: string } | null;
    permissions: {
      manageParkingPass: boolean;
      manageProfile?: boolean;
    };
  }>({
    queryKey: ["/api/business-access/me"],
    enabled: !!user,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const isAdminOrStaff = isStaffOrAdminUserType(user?.userType);
  const [adminParkingMode, setAdminParkingMode] = useState<
    "auto" | "truck" | "host"
  >("auto");
  const canManageParkingPass =
    isAdminOrStaff ||
    user?.userType === "food_truck" ||
    businessAccess?.permissions?.manageParkingPass === true;
  const canManageTruckProfile =
    isAdminOrStaff ||
    user?.userType === "food_truck" ||
    businessAccess?.permissions?.manageProfile === true;
  const requiresBusinessAttachment =
    !isAdminOrStaff &&
    (user?.userType === "food_truck" || user?.userType === "restaurant_owner") &&
    businessAccess?.linkState === "not_attached";
  const businessSetupPath =
    user?.userType === "food_truck"
      ? "/restaurant-signup?businessType=food_truck&source=parking-pass&claim=1"
      : "/restaurant-signup?businessType=restaurant&source=parking-pass&claim=1";
  const hasProfileTruckTools = canManageParkingPass;
  const [isLoading, setIsLoading] = useState(true);
  const [passListings, setPassListings] = useState<ParkingPassListing[]>([]);
  const [ownedFoodTrucks, setOwnedFoodTrucks] = useState<any[]>([]);
  const [truckId, setTruckId] = useState<string | null>(null);
  const [truck, setTruck] = useState<any | null>(null);
  const [socialLinks, setSocialLinks] = useState({
    facebookPageUrl: "",
    instagramUrl: "",
    xUrl: "",
  });
  const [socialSettings, setSocialSettings] = useState<SocialAutopostSettings>(
    defaultSocialAutopostSettings,
  );
  const [isSavingSocialSettings, setIsSavingSocialSettings] = useState(false);
  const [postPrompt, setPostPrompt] = useState<{
    title: string;
    message: string;
    link: string;
    imageUrl?: string | null;
    selectedPlatforms: {
      facebook: boolean;
      instagram: boolean;
      x: boolean;
    };
  } | null>(null);
  const [isPostingSocial, setIsPostingSocial] = useState(false);
  const {
    data: socialConnectionPayload,
    refetch: refetchSocialConnections,
  } = useQuery<{
    restaurantId: string;
    connections: SocialConnectionStatus[];
    publishingConfig?: SocialPublishingConfig;
  }>({
    queryKey: truckId
      ? [`/api/restaurants/${truckId}/social-connections/status`]
      : ["social-connections-none"],
    enabled:
      Boolean(truckId) &&
      isAuthenticated &&
      hasProfileTruckTools &&
      canManageTruckProfile,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const { data: stripeConfig, isLoading: isStripeConfigLoading } = useQuery<{
    paymentsReady: boolean;
    publishableKey?: string;
  }>({
    queryKey: ["/api/payments/stripe-config"],
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000,
  });
  const socialConnectionByPlatform = useMemo(() => {
    const map = new Map<string, SocialConnectionStatus>();
    (socialConnectionPayload?.connections || []).forEach((connection) => {
      map.set(connection.platform, connection);
    });
    return map;
  }, [socialConnectionPayload]);
  const socialPublishingConfig = socialConnectionPayload?.publishingConfig;
  const [hasHostProfile, setHasHostProfile] = useState(false);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [selectedHostId, setSelectedHostId] = useState<string>("");
  const [host, setHost] = useState<Host | null>(null);
  const [spotImageFile, setSpotImageFile] = useState<File | null>(null);
  const [isUploadingSpotImage, setIsUploadingSpotImage] = useState(false);
  const [amenities, setAmenities] = useState<Record<string, boolean>>({
    water: false,
    electric: false,
    bathrooms: false,
    wifi: false,
    seating: false,
  });
  const [isSavingAmenities, setIsSavingAmenities] = useState(false);
  const [blackoutDateInput, setBlackoutDateInput] = useState("");
  const [blackoutDates, setBlackoutDates] = useState<string[]>([]);
  const [isSavingBlackout, setIsSavingBlackout] = useState(false);
  const [hasActiveParkingPass, setHasActiveParkingPass] = useState(false);
  const [newLocationForm, setNewLocationForm] = useState({
    businessName: "",
    address: "",
    city: "",
    state: "",
    locationType: "other",
    contactPhone: "",
  });
  const [isSavingLocation, setIsSavingLocation] = useState(false);
  const [isUpdatingLocation, setIsUpdatingLocation] = useState(false);
  const [isDeletingLocation, setIsDeletingLocation] = useState(false);
  const [pinPosition, setPinPosition] = useState<GeoPoint | null>(null);
  const [isSavingPin, setIsSavingPin] = useState(false);
  const [isGeocodingPin, setIsGeocodingPin] = useState(false);
  const [newLocationPinPosition, setNewLocationPinPosition] =
    useState<GeoPoint | null>(null);
  const [isGeocodingNewPin, setIsGeocodingNewPin] = useState(false);
  const [hostPassListings, setHostPassListings] = useState<HostPassListing[]>(
    [],
  );
  const [editHostListing, setEditHostListing] =
    useState<HostPassListing | null>(null);
  const [editHostListingOpen, setEditHostListingOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([]);
  const defaultHostStartTime: string =
    PARKING_PASS_MEAL_WINDOWS.breakfast.start;
  const defaultHostEndTime: string = PARKING_PASS_MEAL_WINDOWS.dinner.end;
  const [startTime, setStartTime] = useState<string>(defaultHostStartTime);
  const [endTime, setEndTime] = useState<string>(defaultHostEndTime);
  const [anyTime, setAnyTime] = useState(false);
  const [maxTrucks, setMaxTrucks] = useState(1);
  const hardCapEnabled = true;
  const [createError, setCreateError] = useState("");
  const [breakfastPrice, setBreakfastPrice] = useState("");
  const [lunchPrice, setLunchPrice] = useState("");
  const [dinnerPrice, setDinnerPrice] = useState("");
  const [weeklyOverride, setWeeklyOverride] = useState("");
  const [monthlyOverride, setMonthlyOverride] = useState("");
  const [manualSchedules, setManualSchedules] = useState<ManualScheduleEntry[]>(
    [],
  );
  const bookingSchedule = useParkingBookedSchedule<TruckScheduleEntry>(user?.id, truckId);
  const bookedSchedule = bookingSchedule.entries;
  const [cancelingBookingId, setCancelingBookingId] = useState<string | null>(
    null,
  );
  const [parkingReports, setParkingReports] = useState<TruckParkingReport[]>(
    [],
  );
  const [reportDraft, setReportDraft] = useState<{
    date: string;
    sourceType: "booking" | "manual" | "custom";
    bookingId?: string;
    manualScheduleId?: string;
    hostId?: string;
    locationName?: string;
    address?: string;
    city?: string;
    state?: string;
    rating?: string;
    arrivalCleanliness?: string;
    customersServed?: string;
    salesDollars?: string;
    notes?: string;
  } | null>(null);
  const [isSavingReport, setIsSavingReport] = useState(false);
  const [selectedListing, setSelectedListing] =
    useState<ParkingPassListing | null>(null);
  const [selectedSlotTypes, setSelectedSlotTypes] = useState<string[]>([]);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const dateParam = params.get("date");
    if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      return dateParam;
    }
    return format(new Date(), "yyyy-MM-dd");
  });
  const [selectedSlotsByListing, setSelectedSlotsByListing] = useState<
    Record<string, string[]>
  >({});
  const [cityQuery, setCityQuery] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return String(params.get("q") || "");
    } catch {
      return "";
    }
  });
  useEffect(() => {
    if (cityQuery.trim()) return;
    const city = String(effectiveLocationContext?.city || "").trim();
    const state = String(effectiveLocationContext?.state || "").trim();
    const nextQuery = [city, state].filter(Boolean).join(", ");
    if (nextQuery) {
      setCityQuery(nextQuery);
    }
  }, [cityQuery, effectiveLocationContext]);
  const [journeyOriginLabel, setJourneyOriginLabel] = useState("");
  const [journeyOriginCoords, setJourneyOriginCoords] =
    useState<GeoPoint | null>(null);
  const [journeyDestinationLabel, setJourneyDestinationLabel] = useState("");
  const [journeyDestinationCoords, setJourneyDestinationCoords] =
    useState<GeoPoint | null>(null);
  const [journeyResult, setJourneyResult] =
    useState<RouteCorridorResponse | null>(null);
  const [journeyError, setJourneyError] = useState("");
  const [isJourneyPlanning, setIsJourneyPlanning] = useState(false);
  const [journeySupportFilter, setJourneySupportFilter] = useState<
    "all" | OperatorSupportKind
  >("all");
  const journeyOriginInitializedRef = useRef(false);
  useEffect(() => {
    if (journeyOriginInitializedRef.current) return;
    const latitude = parseCoord(effectiveLocationContext?.latitude);
    const longitude = parseCoord(effectiveLocationContext?.longitude);
    if (latitude === null || longitude === null) return;
    journeyOriginInitializedRef.current = true;
    const locationLabel = [
      String(effectiveLocationContext?.city || "").trim(),
      String(effectiveLocationContext?.state || "").trim(),
    ]
      .filter(Boolean)
      .join(", ");
    setJourneyOriginCoords({ lat: latitude, lng: longitude });
    setJourneyOriginLabel(locationLabel || "My current area");
  }, [
    effectiveLocationContext?.city,
    effectiveLocationContext?.latitude,
    effectiveLocationContext?.longitude,
    effectiveLocationContext?.state,
  ]);
  const [cartItems, setCartItems] = useState<
    Array<{ listing: ParkingPassListing; slotTypes: string[] }>
  >([]);
  const [checkoutQueue, setCheckoutQueue] = useState<
    Array<{ listing: ParkingPassListing; slotTypes: string[] }>
  >([]);
  const [viewMode, setViewMode] = useState<"map" | "list">(() =>
    window.matchMedia("(max-width: 639px)").matches ? "list" : "map",
  );
  const [showParkingScoutHeat, setShowParkingScoutHeat] = useState(false);
  const [showGasLayer, setShowGasLayer] = useState(false);
  const [showPropaneLayer, setShowPropaneLayer] = useState(false);
  const [showSupplyLayer, setShowSupplyLayer] = useState(false);
  const [showSupportLayer, setShowSupportLayer] = useState(false);
  const [activeLocationKey, setActiveLocationKey] = useState<string | null>(
    null,
  );
  const [pendingPassId, setPendingPassId] = useState<string | null>(null);
  const [requestedHostId, setRequestedHostId] = useState<string | null>(null);
  const [bookingReturnIntentId, setBookingReturnIntentId] = useState<
    string | null
  >(null);
  const [bookingReturnHandled, setBookingReturnHandled] = useState(false);
  // While any popup is open, lock map interactions so users can read/select slots
  // without accidental pan/zoom changes behind the popup.
  const [mapPopupOpen, setMapPopupOpen] = useState(false);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [showSpotInsights, setShowSpotInsights] = useState(false);
  const [parkingCoords, setParkingCoords] = useState<Record<string, GeoPoint>>(
    {},
  );

  useEffect(() => {
    if (viewMode !== "map") {
      setMapPopupOpen(false);
    }
  }, [viewMode]);

  const mapInteractionsEnabled = !mapPopupOpen;
  const { data: mapLocationsData } = useQuery<MapLocationsResponse>({
    queryKey: ["/api/map/locations"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/map/locations"));
      if (!res.ok) {
        throw new Error("Failed to load map locations");
      }
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
  const { data: intelligenceStatusData } = useQuery<any>({
    queryKey: ["/api/parking-pass/intelligence-status"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/parking-pass/intelligence-status"));
      if (!res.ok) throw new Error("Failed to load intelligence status");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
  const MAP_LOCATIONS_CACHE_KEY = "mealscout:map:locations:v1";
  const [cachedMapLocations, setCachedMapLocations] =
    useState<MapLocationsResponse | null>(() => {
      try {
        const raw = localStorage.getItem(MAP_LOCATIONS_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as any;
        if (
          parsed &&
          Array.isArray(parsed.hostLocations) &&
          Array.isArray(parsed.eventLocations)
        ) {
          return parsed as MapLocationsResponse;
        }
        return null;
      } catch {
        return null;
      }
    });

  useEffect(() => {
    if (!mapLocationsData) return;
    setCachedMapLocations(mapLocationsData);
    try {
      localStorage.setItem(
        MAP_LOCATIONS_CACHE_KEY,
        JSON.stringify(mapLocationsData),
      );
    } catch {
      // ignore
    }
  }, [mapLocationsData]);

  const baseMapLocations: MapLocationsResponse = useMemo(() => {
    return (
      mapLocationsData ??
      cachedMapLocations ?? {
        hostLocations: [],
        eventLocations: [],
        supplierLocations: [],
      }
    );
  }, [mapLocationsData, cachedMapLocations]);

  // Show every active, mappable host. Booking inventory controls the cards and
  // checkout actions, but it must not hide a valid place where a truck can park.
  const parkingPassMapLocations = useMemo(() => {
    const hostLocations = (baseMapLocations.hostLocations || []).filter(
      (loc: any) => {
        const hostId = String(loc?.hostId || "").trim();
        if (!hostId) return false;
        const status = String(loc?.status || "").trim().toLowerCase();
        if (
          [
            "deleted",
            "archived",
            "inactive",
            "cancelled",
            "canceled",
            "expired",
            "unavailable",
            "draft",
          ].includes(status)
        ) {
          return false;
        }
        if (
          loc?.deletedAt ||
          loc?.archivedAt ||
          loc?.cancelledAt ||
          loc?.canceledAt ||
          loc?.isDeleted === true ||
          loc?.isArchived === true
        ) {
          return false;
        }
        return true;
      },
    );
    const supplierLocations = (baseMapLocations.supplierLocations || []).filter(
      (loc: any) => String(loc?.type || "").toLowerCase() === "supplier",
    );
    return { ...baseMapLocations, hostLocations, supplierLocations };
  }, [baseMapLocations]);
  const [geocodeCache, setGeocodeCache] = useState<Record<string, GeoPoint>>(
    {},
  );
  const geocodeInFlight = useRef(false);
  const [scheduleForm, setScheduleForm] = useState({
    date: format(new Date(), "yyyy-MM-dd"),
    startTime: "",
    endTime: "",
    locationName: "",
    address: "",
    city: "",
    state: "",
    notes: "",
    isPublic: true,
  });
  const [isSavingSchedule, setIsSavingSchedule] = useState(false);
  const [isSharingLocation, setIsSharingLocation] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const [dismissedPreOpenPromptKey, setDismissedPreOpenPromptKey] =
    useState<string | null>(null);
  const defaultLeaveTime = useMemo(() => {
    const date = new Date(Date.now() + 4 * 60 * 60 * 1000);
    return `${String(date.getHours()).padStart(2, "0")}:${String(
      date.getMinutes(),
    ).padStart(2, "0")}`;
  }, []);
  const [liveLeaveTime, setLiveLeaveTime] = useState(defaultLeaveTime);
  const [scheduleInitialDate] = useState(() =>
    new URLSearchParams(window.location.search).get("date") || undefined,
  );
  const [ownerNavigation] = useState(() =>
    parseParkingPassOwnerNavigation(window.location.search),
  );
  const [topTab, setTopTab] = useState<ParkingPassTopTab>(
    ownerNavigation.topTab,
  );
  const [hostToolsTab, setHostToolsTab] =
    useState<ParkingPassHostToolsTab>(ownerNavigation.hostToolsTab);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const socialStatus = params.get("social");
    if (socialStatus !== "connected" && socialStatus !== "error") return;

    toast({
      title:
        socialStatus === "connected"
          ? "Publishing connected"
          : "Connection failed",
      description:
        params.get("socialMessage") ||
        (socialStatus === "connected"
          ? "That account can now publish from MealScout."
          : "Try reconnecting from the publishing card."),
      variant: socialStatus === "error" ? "destructive" : undefined,
    });
    void refetchSocialConnections();

    params.delete("social");
    params.delete("socialMessage");
    const nextQuery = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`,
    );
  }, [refetchSocialConnections, toast]);

  const reloadHostPassListings = async (hostId: string) => {
    if (!hostId) return;
    try {
      const res = await fetch(
        apiUrl(`/api/hosts/parking-pass?hostId=${hostId}`),
      );
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setHostPassListings(data);
        }
      }
    } catch (error) {
      console.error(error);
    }
  };

  const filterBookablePassListings = (data: any) => {
    if (!Array.isArray(data)) return [];
    return data.filter((listing: any) => {
      if (!listing?.host) return false;
      if (!isParkingPassListingPublicVisible(listing)) return false;
      if (!hasListingPricing(listing)) return false;
      // Show priced locations even when fully booked so pins don't disappear from the map.
      // Booking is still gated elsewhere via `listingHasAvailability(...)`.
      return true;
    });
  };

  const reloadPassListings = async (options?: { silent?: boolean }) => {
    try {
      const listingsRes = await fetch(apiUrl("/api/parking-pass"));
      if (!listingsRes.ok) {
        throw new Error("Failed to load parking pass listings");
      }
      const data = await listingsRes.json();
      setPassListings(filterBookablePassListings(data));
    } catch (error: any) {
      if (!options?.silent) {
        toast({
          title: "Error",
          description: error.message || "Failed to load parking pass listings.",
          variant: "destructive",
        });
      }
    }
  };

  const reloadBookedSchedule = async (selectedTruckId: string, _options?: { silent?: boolean }) => {
    if (selectedTruckId !== truckId) return;
    await bookingSchedule.refresh();
  };

  const handleCancelBooking = async (bookingId: string) => {
    if (!bookingId || !truckId || bookingSchedule.loading || bookingSchedule.error) return;
    if (!window.confirm("Cancel this booking? This cannot be undone.")) {
      return;
    }

    setCancelingBookingId(bookingId);
    try {
      const res = await fetch(apiUrl(`/api/bookings/${bookingId}/cancel`), {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to cancel booking");
      }
      toast({
        title: "Booking cancelled",
        description: "Your parking pass booking has been cancelled.",
      });
      await reloadBookedSchedule(truckId, { silent: true });
    } catch (error: any) {
      toast({
        title: "Cancellation failed",
        description: error.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setCancelingBookingId(null);
    }
  };
  useEffect(() => {
    try {
      const cached = localStorage.getItem(
        "mealscout_parking_pass_geocode_cache",
      );
      if (cached) {
        const parsed = JSON.parse(cached) as Record<string, GeoPoint>;
        setGeocodeCache(parsed);
      }
    } catch {
      // ignore localStorage issues
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        "mealscout_parking_pass_geocode_cache",
        JSON.stringify(geocodeCache),
      );
    } catch {
      // ignore localStorage issues
    }
  }, [geocodeCache]);

  useEffect(() => {
    setSelectedSlotsByListing({});
  }, [selectedDate]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const passId = params.get("pass") || params.get("eventId");
    if (passId) {
      setPendingPassId(passId);
    }
    const hostId = String(
      params.get("hostId") || params.get("locationId") || "",
    ).trim();
    if (hostId) {
      setRequestedHostId(hostId);
    }
    if (params.get("booking") === "success") {
      setBookingReturnIntentId(params.get("payment_intent"));
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setOwnedFoodTrucks([]);
      setTruckId(null);
      setTruck(null);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    let cancelled = false;

    const loadData = async () => {
      setIsLoading(true);
      try {
        if (isAuthenticated) {
          const truckRes = await fetch(apiUrl("/api/restaurants/my-restaurants"));
          if (truckRes.ok) {
            const trucks = await truckRes.json();
            if (!cancelled) {
              const validFoodTrucks = Array.isArray(trucks)
                ? trucks.filter((item: any) => isValidParkingPassTruck(item))
                : [];
              setOwnedFoodTrucks(validFoodTrucks);
              if (validFoodTrucks.length > 0) {
                const selectedTruck = selectRequestedAccessibleTruck(
                  validFoodTrucks,
                  ownerNavigation.requestedTruckId,
                );
                if (!selectedTruck) return;
                setTruckId(selectedTruck.id);
                setTruck(selectedTruck);
              } else {
                setTruckId(null);
                setTruck(null);
              }
            }
          } else if (!cancelled) {
            setOwnedFoodTrucks([]);
            setTruckId(null);
            setTruck(null);
          }
          const hostRes = await fetch(apiUrl("/api/hosts"));
          if (hostRes.ok) {
            const hostList = await hostRes.json();
            if (!cancelled && Array.isArray(hostList) && hostList.length > 0) {
              setHasHostProfile(true);
              setHosts(hostList);
            } else if (!cancelled) {
              setHasHostProfile(false);
              setHosts([]);
            }
          } else if (!cancelled) {
            setHasHostProfile(false);
            setHosts([]);
          }
        }

        const listingsRes = await fetch(apiUrl("/api/parking-pass"));
        if (!listingsRes.ok) {
          throw new Error("Failed to load parking pass listings");
        }
        const data = await listingsRes.json();
        if (!cancelled) {
          setPassListings(filterBookablePassListings(data));
        }
      } catch (error: any) {
        if (!cancelled) {
          toast({
            title: "Error",
            description:
              error.message || "Failed to load parking pass listings.",
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    loadData();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, ownerNavigation.requestedTruckId, toast]);

  useEffect(() => {
    if (!truck) return;
    setSocialLinks({
      facebookPageUrl: truck.facebookPageUrl || "",
      instagramUrl: truck.instagramUrl || "",
      xUrl: truck.xUrl || "",
    });
    const existing = (truck.socialAutopostSettings ||
      {}) as Partial<SocialAutopostSettings>;
    setSocialSettings({
      ...defaultSocialAutopostSettings,
      ...existing,
      platforms: {
        ...defaultSocialAutopostSettings.platforms,
        ...(existing.platforms || {}),
      },
      triggers: {
        ...defaultSocialAutopostSettings.triggers,
        ...(existing.triggers || {}),
      },
    });
  }, [truck?.id]);

  useEffect(() => {
    if (!pendingPassId || isLoading) return;
    const match = passListings.find((listing) => listing.id === pendingPassId);
    if (match) {
      setActiveLocationKey(getLocationKey(match));
      setSelectedDate(getListingDateKey(match.date));
    } else {
      toast({
        title: "Parking Pass unavailable",
        description: "This Parking Pass could not be found. Choose an available location and date before booking.",
        variant: "destructive",
      });
    }
    setPendingPassId(null);
  }, [pendingPassId, passListings, isLoading, toast]);

  useEffect(() => {
    if (!requestedHostId) return;
    const match = passListings.find(
      (listing) => String(listing?.host?.id || "").trim() === requestedHostId,
    );
    if (!match) return;
    setActiveLocationKey(getLocationKey(match));
    setSelectedDate(getListingDateKey(match.date));
  }, [requestedHostId, passListings]);

  useEffect(() => {
    if (bookingReturnHandled) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("booking") !== "success") return;
    if (!truckId) return;

    setBookingReturnHandled(true);
    const intentId = bookingReturnIntentId || params.get("payment_intent");

    const run = async () => {
      try {
        let status: "pending" | "confirmed" | "credited" = "pending";
        if (intentId) {
          const res = await fetch(apiUrl(`/api/bookings/payment-intent/${encodeURIComponent(
              intentId,
            )}?truckId=${encodeURIComponent(truckId)}`),
          );
          if (res.ok) {
            const data = await res.json();
            if (data?.status === "confirmed") status = "confirmed";
            if (data?.status === "credited") status = "credited";
          }
        }

        if (status === "credited") {
          toast({
            title: "Booking Unavailable",
            description:
              "Payment succeeded but the spot was no longer available. Credits were issued to your account.",
            variant: "destructive",
          });
        } else {
          toast({
            title: "Payment received",
            description:
              status === "confirmed"
                ? "Your booking is confirmed."
                : "Your booking will appear shortly.",
          });
        }
      } catch {
        toast({
          title: "Payment received",
          description: "Your booking will appear shortly.",
        });
      } finally {
        void reloadPassListings({ silent: true });
        void reloadBookedSchedule(truckId, { silent: true });

        const nextParams = new URLSearchParams(window.location.search);
        nextParams.delete("booking");
        nextParams.delete("payment_intent");
        nextParams.delete("payment_intent_client_secret");
        const nextQuery = nextParams.toString();
        window.history.replaceState(
          {},
          "",
          nextQuery
            ? `${window.location.pathname}?${nextQuery}`
            : window.location.pathname,
        );
      }
    };

    void run();
  }, [bookingReturnHandled, bookingReturnIntentId, toast, truckId]);

  useEffect(() => {
    if (!hosts.length) {
      setHost(null);
      setSelectedHostId("");
      return;
    }
    if (!selectedHostId) {
      setSelectedHostId(hosts[0].id);
    }
  }, [hosts, selectedHostId]);

  useEffect(() => {
    if (!selectedHostId) {
      setHost(null);
      return;
    }
    const selected = hosts.find((item) => item.id === selectedHostId) || null;
    setHost(selected);
    if (selected) {
      setAmenities((current) => ({
        ...current,
        ...(selected.amenities ?? {}),
      }));
    }
  }, [hosts, selectedHostId]);

  useEffect(() => {
    if (!selectedHostId) {
      setHostPassListings([]);
      setEditHostListing(null);
      setEditHostListingOpen(false);
      return;
    }
    setEditHostListing(null);
    setEditHostListingOpen(false);
    void reloadHostPassListings(selectedHostId);
  }, [selectedHostId]);

  useEffect(() => {
    if (!selectedHostId) {
      setBlackoutDates([]);
      setHasActiveParkingPass(false);
      return;
    }
    const fetchBlackouts = async () => {
      try {
        const res = await fetch(apiUrl(`/api/hosts/${selectedHostId}/blackout-dates`));
        if (res.status === 404) {
          setBlackoutDates([]);
          setHasActiveParkingPass(false);
          return;
        }
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            const dates = data
              .map(
                (row) =>
                  String((row as any)?.dateKey || "").trim() ||
                  getListingDateKey((row as any)?.date),
              )
              .filter(Boolean)
              .sort();
            setBlackoutDates(dates);
            setHasActiveParkingPass(true);
          }
        }
      } catch (error) {
        console.error(error);
      }
    };

    fetchBlackouts();
  }, [selectedHostId]);

  useEffect(() => {
    if (!host) {
      setPinPosition(null);
      return;
    }
    const lat = parseCoord(host.latitude);
    const lng = parseCoord(host.longitude);
    if (lat !== null && lng !== null) {
      setPinPosition({ lat, lng });
    } else {
      setPinPosition(null);
    }
  }, [host?.id, host?.latitude, host?.longitude]);

  const savedHost = host
    ? (hosts.find((item) => item.id === host.id) ?? null)
    : null;
  const savedLat = parseCoord(savedHost?.latitude);
  const savedLng = parseCoord(savedHost?.longitude);
  const savedPoint =
    savedLat !== null && savedLng !== null
      ? { lat: savedLat, lng: savedLng }
      : null;
  const addressNeedsPin =
    !!host &&
    !!savedHost &&
    buildLocationKey(host.address, host.city, host.state) !==
      buildLocationKey(savedHost.address, savedHost.city, savedHost.state);

  useEffect(() => {
    if (!addressNeedsPin) return;
    if (!pinPosition || !savedPoint) return;
    if (pointsMatch(pinPosition, savedPoint)) {
      setPinPosition(null);
    }
  }, [
    addressNeedsPin,
    pinPosition?.lat,
    pinPosition?.lng,
    savedPoint?.lat,
    savedPoint?.lng,
  ]);

  useEffect(() => {
    setNewLocationPinPosition((current) => (current ? null : current));
  }, [newLocationForm.address, newLocationForm.city, newLocationForm.state]);

  const settingsMapCenter =
    pinPosition ??
    (addressNeedsPin ? defaultMapCenter : (savedPoint ?? defaultMapCenter));
  const settingsMapZoom = pinPosition
    ? 15
    : addressNeedsPin
      ? 4
      : savedPoint
        ? 12
        : 4;
  const newLocationMapCenter = newLocationPinPosition ?? defaultMapCenter;
  const newLocationMapZoom = newLocationPinPosition ? 15 : 4;

  useEffect(() => {
    if (!truckId || !hasProfileTruckTools) {
      setManualSchedules([]);
      return;
    }
    let cancelled = false;
    const loadManualSchedules = async () => {
      try {
        const res = await fetch(apiUrl(`/api/trucks/${truckId}/manual-schedule`));
        if (!res.ok) {
          throw new Error("Failed to load schedule");
        }
        const data = await res.json();
        if (!cancelled && Array.isArray(data)) {
          setManualSchedules(data);
        }
      } catch (error) {
        if (!cancelled) {
          toast({
            title: "Schedule Error",
            description:
              error instanceof Error
                ? error.message
                : "Failed to load your schedule.",
            variant: "destructive",
          });
        }
      }
    };

    loadManualSchedules();
    return () => {
      cancelled = true;
    };
  }, [hasProfileTruckTools, toast, truckId]);

  useEffect(() => {
    if (!truckId) {
      setParkingReports([]);
      return;
    }
    let cancelled = false;

    const loadReports = async () => {
      try {
        const start = new Date();
        start.setDate(start.getDate() - 120);
        const startKey = format(start, "yyyy-MM-dd");
        const res = await fetch(apiUrl(`/api/trucks/${truckId}/parking-reports?startDate=${startKey}`),
        );
        if (!res.ok) {
          throw new Error("Failed to load reports");
        }
        const data = await res.json();
        if (!cancelled && Array.isArray(data)) {
          setParkingReports(data);
        }
      } catch {
        if (!cancelled) {
          setParkingReports([]);
        }
      }
    };

    loadReports();

    return () => {
      cancelled = true;
    };
  }, [truckId]);

  const handleScheduleFieldChange = (
    field: keyof typeof scheduleForm,
    value: string | boolean,
  ) => {
    setScheduleForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const hydrateFromPlaceDetails = async (
    placeId: string,
    sessionToken?: string,
  ) => {
    const params = new URLSearchParams();
    if (sessionToken) params.set("sessionToken", sessionToken);
    const query = params.toString();
    const res = await fetch(apiUrl(`/api/map/place-details/${encodeURIComponent(placeId)}${query ? `?${query}` : ""}`),
      {
        credentials: "include",
      },
    );
    if (!res.ok) {
      throw new Error("Unable to load place details");
    }
    const payload = (await res.json()) as PlaceDetailsResponse;
    return payload.place;
  };

  const handleJourneyPlaceSelect = async (
    field: "origin" | "destination",
    suggestion: {
      placeId: string;
      text: string;
      sessionToken?: string;
    },
  ) => {
    try {
      const place = await hydrateFromPlaceDetails(
        suggestion.placeId,
        suggestion.sessionToken,
      );
      if (
        !place ||
        typeof place.latitude !== "number" ||
        typeof place.longitude !== "number"
      ) {
        throw new Error("Place coordinates unavailable");
      }
      const label = place.formattedAddress || suggestion.text;
      const coords = { lat: place.latitude, lng: place.longitude };
      if (field === "origin") {
        journeyOriginInitializedRef.current = true;
        setJourneyOriginLabel(label);
        setJourneyOriginCoords(coords);
      } else {
        setJourneyDestinationLabel(label);
        setJourneyDestinationCoords(coords);
      }
      setJourneyResult(null);
      setJourneyError("");
    } catch {
      setJourneyError(
        "Choose a mapped address so MealScout can plan the route.",
      );
    }
  };

  const handleUseJourneyCurrentLocation = () => {
    const latitude = parseCoord(effectiveLocationContext?.latitude);
    const longitude = parseCoord(effectiveLocationContext?.longitude);
    if (latitude === null || longitude === null) {
      setJourneyError(
        "Share a current location first, or search for a starting address.",
      );
      return;
    }
    const label = [
      String(effectiveLocationContext?.city || "").trim(),
      String(effectiveLocationContext?.state || "").trim(),
    ]
      .filter(Boolean)
      .join(", ");
    journeyOriginInitializedRef.current = true;
    setJourneyOriginLabel(label || "My current area");
    setJourneyOriginCoords({ lat: latitude, lng: longitude });
    setJourneyResult(null);
    setJourneyError("");
  };

  const handlePlanJourney = async () => {
    if (!journeyOriginCoords || !journeyDestinationCoords) {
      setJourneyError("Select both a starting point and destination.");
      return;
    }
    setIsJourneyPlanning(true);
    setJourneyError("");
    try {
      const params = new URLSearchParams({
        originLat: String(journeyOriginCoords.lat),
        originLng: String(journeyOriginCoords.lng),
        destLat: String(journeyDestinationCoords.lat),
        destLng: String(journeyDestinationCoords.lng),
      });
      const response = await fetch(
        apiUrl(`/api/map/route-corridor?${params.toString()}`),
        { credentials: "include" },
      );
      const payload = (await response.json().catch(() => null)) as
        | (RouteCorridorResponse & { message?: string })
        | null;
      if (!response.ok || !payload?.available) {
        throw new Error(
          payload?.message || "This route is unavailable right now.",
        );
      }
      setJourneyResult(payload);
      setJourneySupportFilter("all");
      setViewMode("map");
    } catch (error) {
      setJourneyResult(null);
      setJourneyError(
        error instanceof Error
          ? error.message
          : "This route is unavailable right now.",
      );
    } finally {
      setIsJourneyPlanning(false);
    }
  };

  const handleNewLocationAddressSelect = async (suggestion: {
    placeId: string;
    text: string;
    sessionToken?: string;
  }) => {
    try {
      const place = await hydrateFromPlaceDetails(
        suggestion.placeId,
        suggestion.sessionToken,
      );
      if (!place) return;
      setNewLocationForm((current) => ({
        ...current,
        address: place.formattedAddress || suggestion.text,
        city: place.city || current.city,
        state: place.state || current.state,
      }));

      if (
        typeof place.latitude === "number" &&
        typeof place.longitude === "number"
      ) {
        setNewLocationPinPosition({
          lat: place.latitude,
          lng: place.longitude,
        });
      }
    } catch {
      // Fall back to manual address entry when place details are unavailable.
    }
  };

  const handleScheduleAddressSelect = async (suggestion: {
    placeId: string;
    text: string;
    sessionToken?: string;
  }) => {
    try {
      const place = await hydrateFromPlaceDetails(
        suggestion.placeId,
        suggestion.sessionToken,
      );
      if (!place) return;
      setScheduleForm((current) => ({
        ...current,
        address: place.formattedAddress || suggestion.text,
        city: place.city || current.city,
        state: place.state || current.state,
      }));
    } catch {
      // Fall back to manual address entry when place details are unavailable.
    }
  };

  const handleCreateSchedule = async () => {
    if (!hasProfileTruckTools) {
      toast({
        title: canManageParkingPass
          ? "Business Distribution access required"
          : "Permission required",
        description: canManageParkingPass
          ? "Start or restore Business Distribution access before publishing a dated stop."
          : "This account cannot manage the selected truck's schedule.",
        variant: "destructive",
      });
      return;
    }

    if (!truckId) {
      toast({
        title: "Missing truck",
        description: "Select a food truck before adding a schedule stop.",
        variant: "destructive",
      });
      return;
    }
    if (
      !scheduleForm.date ||
      !scheduleForm.startTime ||
      !scheduleForm.endTime
    ) {
      toast({
        title: "Missing time",
        description: "Date, start time, and end time are required.",
        variant: "destructive",
      });
      return;
    }
    if (!scheduleForm.address) {
      toast({
        title: "Missing address",
        description: "Address is required for schedule entries.",
        variant: "destructive",
      });
      return;
    }
    if (!scheduleForm.city || !scheduleForm.state) {
      toast({
        title: "Missing city/state",
        description:
          "City and state are required so MealScout can show the stop in the correct local time.",
        variant: "destructive",
      });
      return;
    }

    setIsSavingSchedule(true);
    try {
      const res = await fetch(apiUrl(`/api/trucks/${truckId}/manual-schedule`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: scheduleForm.date,
          startTime: scheduleForm.startTime,
          endTime: scheduleForm.endTime,
          locationName: scheduleForm.locationName || undefined,
          address: scheduleForm.address,
          city: scheduleForm.city || undefined,
          state: scheduleForm.state || undefined,
          notes: scheduleForm.notes || undefined,
          isPublic: scheduleForm.isPublic,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Failed to save schedule");
      }
      const created = await res.json();
      setManualSchedules((prev) => [...prev, created]);
      setScheduleForm((current) => ({
        ...current,
        startTime: "",
        endTime: "",
        locationName: "",
        address: "",
        city: "",
        state: "",
        notes: "",
      }));
      toast({
        title: "Schedule saved",
        description: "Your stop is now on your schedule.",
      });
      const shareDate = scheduleForm.date
        ? format(new Date(`${scheduleForm.date}T00:00:00`), "EEE, MMM d")
        : "today";
      const timeLabel =
        scheduleForm.startTime && scheduleForm.endTime
          ? `${scheduleForm.startTime} - ${scheduleForm.endTime}`
          : "Time TBD";
      const locationLabel =
        scheduleForm.locationName || scheduleForm.address || "a new stop";
      const shareMessage = `${
        truck?.name || "We"
      } are parked at ${locationLabel} on ${shareDate} (${timeLabel}). Find us on MealScout.`;
      const shareLink = buildTruckShareLink();
      if (shareLink) {
        maybePromptSocialPost("schedule", {
          title: "Share your updated schedule",
          message: shareMessage,
          link: shareLink,
        });
      }
    } catch (error) {
      toast({
        title: "Save failed",
        description:
          error instanceof Error
            ? error.message
            : "Failed to save schedule entry.",
        variant: "destructive",
      });
    } finally {
      setIsSavingSchedule(false);
    }
  };

  const handleDeleteSchedule = async (scheduleId: string) => {
    if (!hasProfileTruckTools) {
      toast({
        title: "Permission required",
        description: "This account cannot manage the selected truck's schedule.",
        variant: "destructive",
      });
      return;
    }

    if (!truckId) return;
    try {
      const res = await fetch(apiUrl(`/api/trucks/${truckId}/manual-schedule/${scheduleId}`),
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Failed to delete schedule");
      }
      setManualSchedules((prev) =>
        prev.filter((entry) => entry.id !== scheduleId),
      );
      toast({
        title: "Schedule removed",
      });
    } catch (error) {
      toast({
        title: "Delete failed",
        description:
          error instanceof Error
            ? error.message
            : "Failed to delete schedule entry.",
        variant: "destructive",
      });
    }
  };

  const reportByKey = useMemo(() => {
    const map = new Map<string, TruckParkingReport>();
    parkingReports.forEach((report) => {
      const key = buildReportKey(report);
      if (key) {
        map.set(key, report);
      }
    });
    return map;
  }, [parkingReports]);

  const reportLookup = useMemo(() => {
    const lookup: Record<string, boolean> = {};
    reportByKey.forEach((report, key) => {
      lookup[key] = !!report.id;
    });
    return lookup;
  }, [reportByKey]);

  const parkingScheduleItems = useMemo<ParkingScheduleItem[]>(() => {
    const bookingItems = bookedSchedule
      .map((entry) => {
        if (!entry.event) return null;
        const reportKey = entry.bookingId ? `booking:${entry.bookingId}` : null;
        return {
          id: `booking-${entry.event.id}-${entry.slotType || "slot"}`,
          date: entry.event.date,
          startTime: entry.event.startTime,
          endTime: entry.event.endTime,
          cleanupEndTime: addMinutesToTime(entry.event.endTime, 30),
          title: entry.host?.businessName || "Parking Pass",
          subtitle: entry.host?.address || "",
          type: "booking" as const,
          slotLabel: entry.slotType ? formatSlotLabel(entry.slotType) : null,
          isPublic: true,
          bookingId: entry.bookingId,
          hostId: entry.host?.id,
          locationName: entry.host?.businessName,
          address: entry.host?.address,
          reportKey: reportKey ?? undefined,
        };
      })
      .filter(Boolean) as ParkingScheduleItem[];

    const manualItems = manualSchedules.map((entry) => ({
      id: `manual-${entry.id}`,
      manualId: entry.id,
      date: entry.date,
      startTime: entry.startTime,
      endTime: entry.endTime,
      title: entry.locationName || "Manual stop",
      subtitle: [entry.address, entry.city, entry.state]
        .filter(Boolean)
        .join(", "),
      type: "manual" as const,
      isPublic: entry.isPublic,
      locationName: entry.locationName ?? "Manual stop",
      address: entry.address,
      city: entry.city,
      state: entry.state,
      reportKey: `manual:${entry.id}`,
    }));

    return [...bookingItems, ...manualItems].sort((a, b) => {
      const dateA = new Date(a.date).getTime();
      const dateB = new Date(b.date).getTime();
      if (dateA !== dateB) return dateA - dateB;
      return (a.startTime || "").localeCompare(b.startTime || "");
    });
  }, [bookedSchedule, manualSchedules]);

  const preOpenPrompt = useMemo(() => {
    const now = new Date();
    const upcoming = parkingScheduleItems
      .map((item) => {
        const startsAt = buildDateTimeFromKey(item.date, item.startTime || "");
        if (!startsAt) return null;
        const minutesUntil = Math.round(
          (startsAt.getTime() - now.getTime()) / 60_000,
        );
        if (
          minutesUntil < 0 ||
          minutesUntil > SOCIAL_PREOPEN_PROMPT_MINUTES
        ) {
          return null;
        }
        return { item, startsAt, minutesUntil };
      })
      .filter(Boolean) as Array<{
      item: ParkingScheduleItem;
      startsAt: Date;
      minutesUntil: number;
    }>;

    upcoming.sort(
      (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
    );
    const next = upcoming[0];
    if (!next) return null;
    const key = `${next.item.type}:${next.item.bookingId || next.item.manualId || next.item.id}`;
    if (key === dismissedPreOpenPromptKey) return null;
    const locationName =
      next.item.locationName || next.item.title || "today's stop";
    const dateLabel = format(next.startsAt, "EEE, MMM d");
    const timeLabel = `${next.item.startTime} - ${next.item.endTime}`;
    return {
      key,
      item: next.item,
      locationName,
      dateLabel,
      timeLabel,
      minutesUntil: next.minutesUntil,
      message: `${
        truck?.name || "We"
      } at ${locationName}. ${dateLabel}, ${timeLabel}. Live location + menu:`,
    };
  }, [dismissedPreOpenPromptKey, parkingScheduleItems, truck?.name]);

  const handleOpenReport = (item: ParkingScheduleItem) => {
    if (!item.reportKey) return;
    const existing = reportByKey.get(item.reportKey);
    const dateKey =
      typeof item.date === "string"
        ? item.date.split("T")[0]
        : format(item.date, "yyyy-MM-dd");
    setReportDraft({
      date: dateKey,
      sourceType: item.type === "booking" ? "booking" : "manual",
      bookingId: item.bookingId,
      manualScheduleId: item.manualId,
      hostId: item.hostId,
      locationName: item.locationName || item.title,
      address: item.address || item.subtitle || "",
      city: item.city ?? undefined,
      state: item.state ?? undefined,
      rating: existing?.rating ? String(existing.rating) : "",
      arrivalCleanliness: existing?.arrivalCleanliness
        ? String(existing.arrivalCleanliness)
        : "",
      customersServed: existing?.customersServed
        ? String(existing.customersServed)
        : "",
      salesDollars: existing?.salesCents
        ? String((existing.salesCents / 100).toFixed(2))
        : "",
      notes: existing?.notes || "",
    });
  };

  const handleReportFieldChange = (
    field:
      | "rating"
      | "arrivalCleanliness"
      | "customersServed"
      | "salesDollars"
      | "notes",
    value: string,
  ) => {
    setReportDraft((current) =>
      current ? { ...current, [field]: value } : current,
    );
  };

  const handleSaveReport = async () => {
    if (!truckId || !reportDraft) return;
    setIsSavingReport(true);
    try {
      const salesValue = reportDraft.salesDollars?.trim();
      const salesCents =
        salesValue && Number.isFinite(Number(salesValue))
          ? Math.max(0, Math.round(Number(salesValue) * 100))
          : undefined;
      const payload = {
        date: reportDraft.date,
        sourceType: reportDraft.sourceType,
        bookingId: reportDraft.bookingId,
        manualScheduleId: reportDraft.manualScheduleId,
        hostId: reportDraft.hostId,
        locationName: reportDraft.locationName,
        address: reportDraft.address,
        city: reportDraft.city,
        state: reportDraft.state,
        rating: reportDraft.rating ? Number(reportDraft.rating) : undefined,
        arrivalCleanliness: reportDraft.arrivalCleanliness
          ? Number(reportDraft.arrivalCleanliness)
          : undefined,
        customersServed: reportDraft.customersServed
          ? Number(reportDraft.customersServed)
          : undefined,
        salesCents,
        notes: reportDraft.notes?.trim() || undefined,
      };

      const res = await fetch(apiUrl(`/api/trucks/${truckId}/parking-reports`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Failed to save report");
      }
      const saved = (await res.json()) as TruckParkingReport;
      setParkingReports((prev) => {
        const index = prev.findIndex((item) => item.id === saved.id);
        if (index >= 0) {
          const next = [...prev];
          next[index] = saved;
          return next;
        }
        return [saved, ...prev];
      });
      toast({
        title: "Report saved",
        description: "Thanks for sharing your day details.",
      });
      setReportDraft(null);
    } catch (error) {
      toast({
        title: "Report failed",
        description:
          error instanceof Error ? error.message : "Unable to save report.",
        variant: "destructive",
      });
    } finally {
      setIsSavingReport(false);
    }
  };

  const handlePostPromptToggle = (
    platform: keyof SocialAutopostSettings["platforms"],
  ) => {
    setPostPrompt((current) => {
      if (!current) return current;
      return {
        ...current,
        selectedPlatforms: {
          ...current.selectedPlatforms,
          [platform]: !current.selectedPlatforms[platform],
        },
      };
    });
  };

  const handlePostPromptMessage = (message: string) => {
    setPostPrompt((current) => (current ? { ...current, message } : current));
  };

  const handleConnectSocialPlatform = (
    platform: SocialConnectionStatus["platform"],
  ) => {
    if (!truckId) return;
    const providerConfig = socialPublishingConfig?.platforms?.[platform];
    if (providerConfig && !providerConfig.configured) {
      toast({
        title: "Publishing setup needed",
        description:
          platform === "x"
            ? "Add X_CLIENT_ID before owners connect X."
            : "Add FACEBOOK_APP_ID and FACEBOOK_APP_SECRET before owners connect Meta.",
        variant: "destructive",
      });
      return;
    }
    const provider = platform === "x" ? "x" : "meta";
    const redirect = encodeURIComponent("/parking-pass?tab=schedule");
    const platformParam = encodeURIComponent(platform);
    window.location.href = apiUrl(
      `/api/restaurants/${truckId}/social-connections/${provider}/start?platform=${platformParam}&redirect=${redirect}`,
    );
  };

  const handleDisconnectSocialPlatform = async (
    platform: SocialConnectionStatus["platform"],
  ) => {
    if (!truckId) return;
    try {
      await apiRequest(
        "DELETE",
        `/api/restaurants/${truckId}/social-connections/${platform}`,
      );
      await refetchSocialConnections();
      toast({
        title: "Publishing disconnected",
        description: "MealScout will use manual share handoff for that account.",
      });
    } catch (error) {
      toast({
        title: "Disconnect failed",
        description:
          error instanceof Error ? error.message : "Unable to disconnect.",
        variant: "destructive",
      });
    }
  };

  const handlePostPromptShare = async (payload?: {
    title?: string;
    message: string;
    link: string;
    imageUrl?: string | null;
    selectedPlatforms: {
      facebook: boolean;
      instagram: boolean;
      x: boolean;
    };
  }) => {
    const activePrompt = payload ?? postPrompt;
    if (!activePrompt) return;
    setIsPostingSocial(true);
    try {
      const shouldClear = !payload;
      let queuedCount = 0;
      let manualRequiredCount = 0;
      if (truckId) {
        try {
          const queueRes = await fetch(apiUrl(`/api/restaurants/${truckId}/social-posts`), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              message: activePrompt.message,
              link: activePrompt.link,
              imageUrl: activePrompt.imageUrl || null,
              source: activePrompt.title || "owner_prompt",
              platforms: activePrompt.selectedPlatforms,
            }),
          });
          if (queueRes.ok) {
            const queueData = await queueRes.json().catch(() => ({}));
            queuedCount = Number(queueData?.queuedForPublishing || 0);
            manualRequiredCount = Number(queueData?.manualRequiredCount || 0);
          } else {
            const queueData = await queueRes.json().catch(() => ({}));
            console.warn(
              "Social post queue failed:",
              queueData?.message || queueRes.statusText,
            );
          }
        } catch (queueError) {
          console.warn("Social post queue failed:", queueError);
        }
      }
      let shared = false;
      if (activePrompt.selectedPlatforms.facebook) {
        await initFacebookSDK();
        await postToFacebook({
          message: activePrompt.message,
          link: activePrompt.link,
        });
        shared = true;
      }
      if (activePrompt.selectedPlatforms.x) {
        const shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
          activePrompt.message,
        )}&url=${encodeURIComponent(activePrompt.link)}`;
        window.open(shareUrl, "_blank", "width=600,height=500");
        shared = true;
      }
      if (activePrompt.selectedPlatforms.instagram) {
        const copyText = [
          activePrompt.message,
          activePrompt.link,
          activePrompt.imageUrl ? `Photo: ${activePrompt.imageUrl}` : "",
        ]
          .filter(Boolean)
          .join(" ")
          .trim();
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(copyText);
        }
        window.open("https://www.instagram.com/", "_blank");
        shared = true;
      }
      if (shared) {
        toast({
          title:
            queuedCount > 0
              ? "Publishing queued"
              : manualRequiredCount > 0
                ? "Manual share opened"
                : "Share opened",
          description: activePrompt.imageUrl
            ? queuedCount > 0
              ? "Connected platforms will publish. Finish any manual shares opened."
              : "Caption copied with photo link. Finish the post."
            : queuedCount > 0
              ? "Connected platforms will publish. Finish any manual shares opened."
              : "Finish the post in the new window.",
        });
      }
      if (shouldClear) {
        setPostPrompt(null);
      }
    } catch (error) {
      toast({
        title: "Share failed",
        description:
          error instanceof Error ? error.message : "Unable to share.",
        variant: "destructive",
      });
    } finally {
      setIsPostingSocial(false);
    }
  };

  const getCartTotals = () => {
    return cartItems.reduce(
      (totals, item) => {
        const slotTotal = item.slotTypes.reduce((sum, slotType) => {
          const price =
            (slotType === "breakfast" && item.listing.breakfastPriceCents) ||
            (slotType === "lunch" && item.listing.lunchPriceCents) ||
            (slotType === "dinner" && item.listing.dinnerPriceCents) ||
            (slotType === "daily" && item.listing.dailyPriceCents) ||
            (slotType === "weekly" && item.listing.weeklyPriceCents) ||
            (slotType === "monthly" && item.listing.monthlyPriceCents) ||
            0;
          return sum + price;
        }, 0);
        const fee = getFeeCentsForSlots(item.slotTypes);
        totals.hostCents += slotTotal;
        totals.feeCents += fee;
        totals.totalCents += slotTotal + fee;
        return totals;
      },
      { hostCents: 0, feeCents: 0, totalCents: 0 },
    );
  };

  const geocodeAddress = async (address: string): Promise<GeoPoint | null> => {
    if (!address) return null;
    const res = await fetch(apiUrl(`/api/location/search?q=${encodeURIComponent(address)}&limit=1`),
    );
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ lat: string; lon: string }>;
    if (!data.length) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  };

  const handleAmenitiesSave = async () => {
    if (!host) return;
    setIsSavingAmenities(true);
    try {
      const res = await fetch(apiUrl(`/api/hosts/${host.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amenities }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Failed to update amenities");
      }
      const updated = await res.json();
      setHosts((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setHost(updated);
      toast({
        title: "Amenities saved",
        description: "Your parking pass amenities are saved.",
      });
    } catch (error: any) {
      toast({
        title: "Unable to save amenities",
        description: error.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSavingAmenities(false);
    }
  };

  const handleGeocodeNewLocationPin = async () => {
    const addressLabel = buildAddressLabel(
      newLocationForm.address,
      newLocationForm.city,
      newLocationForm.state,
    );
    if (!addressLabel) {
      toast({
        title: "Missing address",
        description: "Add the address details first.",
        variant: "destructive",
      });
      return;
    }

    setIsGeocodingNewPin(true);
    try {
      const coords = await geocodeAddress(addressLabel).catch(() => null);
      if (!coords) {
        throw new Error("Unable to find that address.");
      }
      setNewLocationPinPosition(coords);
      toast({
        title: "Pin set from address",
        description: "Review the pin and adjust if needed.",
      });
    } catch (error: any) {
      toast({
        title: "Pin update failed",
        description: error.message || "Unable to set pin from address.",
        variant: "destructive",
      });
    } finally {
      setIsGeocodingNewPin(false);
    }
  };

  const handleCreateLocation = async () => {
    if (!newLocationForm.businessName || !newLocationForm.address) {
      toast({
        title: "Missing details",
        description: "Business name and address are required.",
        variant: "destructive",
      });
      return;
    }
    if (!newLocationForm.city || !newLocationForm.state) {
      toast({
        title: "Missing city/state",
        description: "City and state are required to save a location.",
        variant: "destructive",
      });
      return;
    }
    if (!newLocationPinPosition) {
      toast({
        title: "Pin required",
        description: "Set the map pin before adding a new location.",
        variant: "destructive",
      });
      return;
    }

    setIsSavingLocation(true);
    try {
      const res = await fetch(apiUrl("/api/hosts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName: newLocationForm.businessName,
          address: newLocationForm.address,
          city: newLocationForm.city,
          state: newLocationForm.state,
          locationType: newLocationForm.locationType,
          contactPhone: newLocationForm.contactPhone || null,
          latitude: newLocationPinPosition.lat,
          longitude: newLocationPinPosition.lng,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Failed to create host location");
      }
      const created = await res.json();
      setHosts((current) => [created, ...current]);
      setSelectedHostId(created.id);
      setHasHostProfile(true);
      setNewLocationForm({
        businessName: "",
        address: "",
        city: "",
        state: "",
        locationType: "other",
        contactPhone: "",
      });
      setNewLocationPinPosition(null);
      toast({
        title: "Location added",
        description: "You can edit this location any time.",
      });
    } catch (error: any) {
      toast({
        title: "Unable to save location",
        description: error.message || "Failed to create location.",
        variant: "destructive",
      });
    } finally {
      setIsSavingLocation(false);
    }
  };

  const handleUpdateLocation = async () => {
    if (!host) return;
    if (!pinPosition) {
      toast({
        title: "Pin required",
        description: "Set the map pin before saving this location.",
        variant: "destructive",
      });
      return;
    }
    setIsUpdatingLocation(true);
    try {
      const res = await fetch(apiUrl(`/api/hosts/${host.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName: host.businessName,
          address: host.address,
          city: host.city,
          state: host.state,
          locationType: host.locationType,
          contactPhone: host.contactPhone || null,
          latitude: pinPosition.lat,
          longitude: pinPosition.lng,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Failed to update location");
      }
      const updated = await res.json();
      setHosts((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setHost(updated);
      toast({ title: "Location updated" });
    } catch (error: any) {
      toast({
        title: "Update failed",
        description: error.message || "Failed to update location.",
        variant: "destructive",
      });
    } finally {
      setIsUpdatingLocation(false);
    }
  };

  const handleUploadSpotImage = async () => {
    if (!host) return;
    if (!spotImageFile) {
      toast({
        title: "Choose an image",
        description: "Select a photo of your parking spot first.",
        variant: "destructive",
      });
      return;
    }

    setIsUploadingSpotImage(true);
    try {
      const formData = new FormData();
      formData.append("image", spotImageFile);

      const res = await fetch(apiUrl(`/api/hosts/${host.id}/spot-image`), {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Failed to upload photo");
      }

      const updated = await res.json();
      setHosts((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setHost(updated);
      setSpotImageFile(null);
      toast({ title: "Photo uploaded" });
    } catch (error: any) {
      toast({
        title: "Upload failed",
        description: error.message || "Failed to upload photo.",
        variant: "destructive",
      });
    } finally {
      setIsUploadingSpotImage(false);
    }
  };

  const handleSavePin = async () => {
    if (!host || !pinPosition) return;
    setIsSavingPin(true);
    try {
      const res = await fetch(apiUrl(`/api/hosts/${host.id}/coordinates`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latitude: pinPosition.lat,
          longitude: pinPosition.lng,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Failed to update pin");
      }
      const updated = await res.json();
      setHosts((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setHost(updated);
      toast({ title: "Pin updated", description: "Map location saved." });
    } catch (error: any) {
      toast({
        title: "Pin update failed",
        description: error.message || "Failed to update pin.",
        variant: "destructive",
      });
    } finally {
      setIsSavingPin(false);
    }
  };

  const handleGeocodePin = async () => {
    if (!host) return;
    const addressLabel = buildAddressLabel(
      host.address ?? undefined,
      host.city ?? undefined,
      host.state ?? undefined,
    );
    if (!addressLabel) {
      toast({
        title: "Missing address",
        description: "Add the address details first.",
        variant: "destructive",
      });
      return;
    }
    setIsGeocodingPin(true);
    try {
      const coords = await geocodeAddress(addressLabel).catch(() => null);
      if (!coords) {
        throw new Error("Unable to find that address.");
      }
      setPinPosition(coords);
      toast({
        title: "Pin set from address",
        description: "Review the pin and save the location to keep it.",
      });
    } catch (error: any) {
      toast({
        title: "Pin update failed",
        description: error.message || "Failed to set pin from address.",
        variant: "destructive",
      });
    } finally {
      setIsGeocodingPin(false);
    }
  };

  const handleDeleteLocation = async () => {
    if (!host) return;
    const confirmed = window.confirm(
      `Delete ${host.businessName}? This removes the location and its listings.`,
    );
    if (!confirmed) return;

    setIsDeletingLocation(true);
    try {
      const res = await fetch(apiUrl(`/api/hosts/${host.id}`), { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Failed to delete location");
      }

      const nextHosts = hosts.filter((item) => item.id !== host.id);
      setHosts(nextHosts);
      setHasHostProfile(nextHosts.length > 0);

      if (!nextHosts.length) {
        setHost(null);
        setSelectedHostId("");
        toast({
          title: "Location deleted",
          description: "Your location has been removed.",
        });
        return;
      }

      const nextHost = nextHosts[0];
      setSelectedHostId(nextHost.id);
      setHost(nextHost);
      toast({
        title: "Location deleted",
        description: "Your location has been removed.",
      });
    } catch (error: any) {
      toast({
        title: "Delete failed",
        description: error.message || "Failed to delete location.",
        variant: "destructive",
      });
    } finally {
      setIsDeletingLocation(false);
    }
  };

  const handleAddBlackout = async () => {
    if (!host || !blackoutDateInput || !hasActiveParkingPass) return;
    setIsSavingBlackout(true);
    try {
      const res = await fetch(apiUrl(`/api/hosts/${host.id}/blackout-dates`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: blackoutDateInput }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to add blackout date");
      }
      const dateKey = blackoutDateInput;
      setBlackoutDates((current) =>
        current.includes(dateKey) ? current : [...current, dateKey].sort(),
      );
      setBlackoutDateInput("");
      toast({
        title: "Blackout added",
        description: "Trucks will not be able to book that date.",
      });
    } catch (error: any) {
      toast({
        title: "Unable to add blackout",
        description: error.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSavingBlackout(false);
    }
  };

  const handleRemoveBlackout = async (dateKey: string) => {
    if (!host) return;
    setIsSavingBlackout(true);
    try {
      const res = await fetch(apiUrl(`/api/hosts/${host.id}/blackout-dates`), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: dateKey }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to remove blackout date");
      }
      setBlackoutDates((current) => current.filter((item) => item !== dateKey));
      toast({
        title: "Blackout removed",
      });
    } catch (error: any) {
      toast({
        title: "Remove failed",
        description: error.message || "Failed to remove blackout date.",
        variant: "destructive",
      });
    } finally {
      setIsSavingBlackout(false);
    }
  };

  const hasPassPricing = (event: HostPassListing) =>
    (event.breakfastPriceCents ?? 0) > 0 ||
    (event.lunchPriceCents ?? 0) > 0 ||
    (event.dinnerPriceCents ?? 0) > 0 ||
    (event.dailyPriceCents ?? 0) > 0 ||
    (event.weeklyPriceCents ?? 0) > 0 ||
    (event.monthlyPriceCents ?? 0) > 0;

  const hasActiveHostPass = hostPassListings.some((item) => {
    if (!item.requiresPayment) return false;
    if (!hasPassPricing(item)) return false;
    const itemDate = new Date(item.date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return itemDate >= today;
  });

  const groupParkingPassListings = (items: HostPassListing[]) => {
    const sorted = [...items].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );
    const grouped = new Map<string, HostPassListing>();
    sorted.forEach((item) => {
      const key = item.seriesId || item.id;
      if (!grouped.has(key)) {
        grouped.set(key, item);
      }
    });
    return Array.from(grouped.values());
  };

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const upcomingListings = groupParkingPassListings(
    hostPassListings.filter(
      (event) => event.requiresPayment && new Date(event.date) >= todayStart,
    ),
  );

  const pastListings = groupParkingPassListings(
    hostPassListings.filter(
      (event) => event.requiresPayment && new Date(event.date) < todayStart,
    ),
  );

  const handleCreatePass = async (formEvent: React.FormEvent) => {
    formEvent.preventDefault();
    setCreateError("");
    if (!selectedHostId) {
      setCreateError("Select a location before creating a pass.");
      return;
    }
    if (hasActiveHostPass) {
      setCreateError(
        "You already have a parking pass for this address. Edit the existing listing.",
      );
      return;
    }
    const finalStartTime = anyTime ? "00:00" : startTime;
    const finalEndTime = anyTime ? "23:59" : endTime;
    const breakfast = normalizeDollar(breakfastPrice);
    const lunch = normalizeDollar(lunchPrice);
    const dinner = normalizeDollar(dinnerPrice);
    const hasSlotPrice = breakfast > 0 || lunch > 0 || dinner > 0;

    const invalidSlotLabels: string[] = [];
    if (
      breakfast > 0 &&
      !isSlotWithinHours("breakfast", finalStartTime, finalEndTime)
    ) {
      invalidSlotLabels.push("Breakfast");
    }
    if (
      lunch > 0 &&
      !isSlotWithinHours("lunch", finalStartTime, finalEndTime)
    ) {
      invalidSlotLabels.push("Lunch");
    }
    if (
      dinner > 0 &&
      !isSlotWithinHours("dinner", finalStartTime, finalEndTime)
    ) {
      invalidSlotLabels.push("Dinner");
    }
    if (invalidSlotLabels.length > 0) {
      setCreateError(
        `Parking hours must fully cover priced slots: ${invalidSlotLabels.join(
          ", ",
        )}.`,
      );
      return;
    }

    if (daysOfWeek.length === 0) {
      setCreateError("Select at least one day of the week.");
      return;
    }

    try {
      const res = await fetch(apiUrl("/api/hosts/parking-pass"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostId: selectedHostId,
          daysOfWeek,
          startTime: finalStartTime,
          endTime: finalEndTime,
          maxTrucks: Number(maxTrucks),
          hardCapEnabled,
          requiresPayment: true,
          breakfastPriceCents: breakfast ? breakfast * 100 : 0,
          lunchPriceCents: lunch ? lunch * 100 : 0,
          dinnerPriceCents: dinner ? dinner * 100 : 0,
          ...(weeklyOverrideValue !== null
            ? { weeklyPriceCents: weeklyOverrideValue * 100 }
            : {}),
          ...(monthlyOverrideValue !== null
            ? { monthlyPriceCents: monthlyOverrideValue * 100 }
            : {}),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to create listing");
      }

      const newListing = await res.json();
      const newListings = Array.isArray(newListing) ? newListing : [newListing];
      setHostPassListings((current) => [...current, ...newListings]);
      setIsCreating(false);
      setDaysOfWeek([]);
      setStartTime(defaultHostStartTime);
      setEndTime(defaultHostEndTime);
      setAnyTime(false);
      setMaxTrucks(1);
      setBreakfastPrice("");
      setLunchPrice("");
      setDinnerPrice("");
      setWeeklyOverride("");
      setMonthlyOverride("");
    } catch (error: any) {
      setCreateError(error.message);
    }
  };

  const formatCents = (value?: number | null) => {
    if (value === null || value === undefined) return "—";
    const cents = Number(value);
    if (!Number.isFinite(cents)) return "—";
    if (cents === 0) return "Free";
    return cents > 0 ? `$${(cents / 100).toFixed(2)}` : "—";
  };

  const breakfastValue = normalizeDollar(breakfastPrice);
  const lunchValue = normalizeDollar(lunchPrice);
  const dinnerValue = normalizeDollar(dinnerPrice);
  const slotSum = breakfastValue + lunchValue + dinnerValue;
  const dailyEstimate = slotSum ? slotSum + 10 : 0;
  const weeklyHostEstimate = slotSum ? slotSum * 7 : 0;
  const monthlyHostEstimate = slotSum ? slotSum * 30 : 0;
  const weeklyEstimate = weeklyHostEstimate ? weeklyHostEstimate + 70 : 0;
  const monthlyEstimate = monthlyHostEstimate ? monthlyHostEstimate + 300 : 0;
  const weeklyOverrideValue = parseOptionalDollar(weeklyOverride);
  const monthlyOverrideValue = parseOptionalDollar(monthlyOverride);
  const weeklyFinal =
    weeklyOverrideValue !== null ? weeklyOverrideValue + 70 : weeklyEstimate;
  const monthlyFinal =
    monthlyOverrideValue !== null
      ? monthlyOverrideValue + 300
      : monthlyEstimate;

  const getLocationCoords = (host?: Host | null) => {
    if (!host) return null;
    const lat = parseCoord(host.latitude);
    const lng = parseCoord(host.longitude);
    if (lat === null || lng === null) return null;
    return { lat, lng };
  };

  const handleSelect = (listing: ParkingPassListing, slotType: string) => {
    if (!listingHasAvailability(listing)) {
      toast({
        title: "Location unavailable",
        description:
          "That location is currently unavailable. Pick another open location.",
        variant: "destructive",
      });
      return;
    }
    if (
      !isSlotBookableByTime(
        listing,
        slotType as (typeof PARKING_PASS_SLOT_TYPES)[number],
      )
    ) {
      return;
    }

    setSelectedSlotsByListing((prev) => {
      const existing = prev[listing.id] || [];
      const durationSlots = new Set(["daily", "weekly", "monthly"]);
      const isDuration = durationSlots.has(slotType);
      const existingDuration = existing.find((type) => durationSlots.has(type));
      let updated = existing;
      if (isDuration) {
        updated = existingDuration === slotType ? [] : [slotType];
      } else if (existingDuration) {
        updated = [slotType];
      } else {
        updated = existing.includes(slotType)
          ? existing.filter((type) => type !== slotType)
          : [...existing, slotType];
      }
      return { ...prev, [listing.id]: updated };
    });
  };

  const handleBookSelected = (listing: ParkingPassListing) => {
    if (!canStartTruckCheckout) {
      toast({
        title: "Food truck profile required",
        description: "Only food trucks can book Parking Pass spots.",
        variant: "destructive",
      });
      return;
    }
    if (!listingHasAvailability(listing)) {
      toast({
        title: "Location unavailable",
        description:
          "That location is currently unavailable. Pick another open location.",
        variant: "destructive",
      });
      return;
    }
    const slotTypes = (selectedSlotsByListing[listing.id] || []).filter(
      (slot) =>
        isSlotBookableByTime(
          listing,
          slot as (typeof PARKING_PASS_SLOT_TYPES)[number],
        ),
    );
    if (slotTypes.length === 0) {
      toast({
        title: "Select a booking slot",
        description:
          "Choose breakfast, lunch, dinner, daily, weekly, or monthly before booking.",
      });
      return;
    }

    setCartItems((prev) => {
      const rest = prev.filter((item) => item.listing.id !== listing.id);
      return [...rest, { listing, slotTypes }];
    });
    setCheckoutQueue([]);
    setSelectedListing(listing);
    setSelectedSlotTypes(slotTypes);
    setPaymentOpen(true);
  };

  const removeCartItem = (listingId: string) => {
    setCartItems((prev) =>
      prev.filter((item) => item.listing.id !== listingId),
    );
  };

  const startCheckout = () => {
    if (requiresBusinessAttachment) {
      toast({
        title: "Connect your business first",
        description:
          businessAccess?.guidance ||
          "Connect or claim your business to continue.",
        variant: "destructive",
      });
      setLocation(businessSetupPath);
      return;
    }
    if (!hasFoodTruckBusiness || !truckId) {
      toast({
        title: "Food truck profile required",
        description:
          "Complete or claim your food truck profile before booking Parking Pass spots.",
        variant: "destructive",
      });
      setLocation("/restaurant-signup?businessType=food_truck&source=parking-pass&claim=1");
      return;
    }
    if (cartItems.length === 0) {
      toast({
        title: "No booking selected",
        description: "Pick a location and slot first, then try checkout.",
      });
      return;
    }
    const [first, ...rest] = cartItems;
    setCheckoutQueue(rest);
    setSelectedListing(first.listing);
    setSelectedSlotTypes(first.slotTypes);
    setPaymentOpen(true);
  };

  const buildTruckShareLink = () => {
    if (!truckId) return "";
    const eventMenuId = resolveEventMenuIdFromQuery();
    if (!eventMenuId) return `${window.location.origin}/restaurant/${truckId}`;
    return `${window.location.origin}/restaurant/${truckId}?eventMenuId=${encodeURIComponent(eventMenuId)}`;
  };

  const maybePromptSocialPost = (
    trigger: keyof SocialAutopostSettings["triggers"],
    options: { title: string; message: string; link: string; imageUrl?: string | null },
  ) => {
    if (!hasProfileTruckTools) return;
    if (!socialSettings.triggers[trigger]) return;
    const selectedPlatforms = { ...socialSettings.platforms };
    if (
      !selectedPlatforms.facebook &&
      !selectedPlatforms.instagram &&
      !selectedPlatforms.x
    ) {
      return;
    }
    if (!socialSettings.promptBeforePost) {
      void handlePostPromptShare({
        message: options.message,
        link: options.link,
        imageUrl: options.imageUrl,
        selectedPlatforms,
      });
      return;
    }
    setPostPrompt({
      title: options.title,
      message: options.message,
      link: options.link,
      imageUrl: options.imageUrl,
      selectedPlatforms,
    });
  };

  const handleShareUpcomingStop = () => {
    if (!preOpenPrompt) return;
    const shareLink = buildTruckShareLink();
    if (!shareLink) return;
    maybePromptSocialPost(preOpenPrompt.item.type === "booking" ? "booking" : "schedule", {
      title: "Post next stop",
      message: preOpenPrompt.message,
      link: shareLink,
      imageUrl: truck?.coverImageUrl || truck?.logoUrl || null,
    });
  };

  const handleSaveSocialSettings = async () => {
    if (!canManageTruckProfile) {
      toast({
        title: "Profile access required",
        description:
          "Your team access allows Parking Pass actions, but not social/profile settings.",
        variant: "destructive",
      });
      return;
    }
    if (!hasProfileTruckTools) {
      toast({
        title: "Permission required",
        description: "This account cannot manage the selected truck's social settings.",
        variant: "destructive",
      });
      return;
    }

    if (!truckId) return;
    setIsSavingSocialSettings(true);
    try {
      const res = await fetch(apiUrl(`/api/restaurants/${truckId}/social-settings`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          facebookPageUrl: socialLinks.facebookPageUrl,
          instagramUrl: socialLinks.instagramUrl,
          xUrl: socialLinks.xUrl,
          socialAutopostSettings: socialSettings,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Failed to update social settings");
      }
      const data = await res.json();
      if (data?.restaurant) {
        setTruck(data.restaurant);
      }
      toast({
        title: "Social settings saved",
        description: "Your sharing preferences are updated.",
      });
    } catch (error) {
      toast({
        title: "Save failed",
        description:
          error instanceof Error
            ? error.message
            : "Failed to update social settings.",
        variant: "destructive",
      });
    } finally {
      setIsSavingSocialSettings(false);
    }
  };

  const handleSuccess = (outcome: "confirmed" | "pending" | "credited") => {
    const bookedListing = selectedListing;
    const bookedSlots = [...selectedSlotTypes];
    if (selectedListing) {
      removeCartItem(selectedListing.id);
    }

    if (checkoutQueue.length > 0) {
      const [next, ...rest] = checkoutQueue;
      setCheckoutQueue(rest);
      setSelectedListing(next.listing);
      setSelectedSlotTypes(next.slotTypes);
      setPaymentOpen(true);
    } else {
      setPaymentOpen(false);
      setSelectedListing(null);
      setSelectedSlotTypes([]);
    }

    const shouldReloadSchedule = outcome !== "credited";
    const shouldShare = outcome === "confirmed";

    if (shouldShare && bookedListing) {
      const hostName = bookedListing.host?.businessName || "a host location";
      const dateLabel = format(
        new Date(`${bookedListing.date}T00:00:00`),
        "EEE, MMM d",
      );
      const slotLabel = bookedSlots.length
        ? bookedSlots.map(formatSlotLabel).join(", ")
        : "Spot";
      const shareMessage = `${
        truck?.name || "We"
      } just booked ${slotLabel} at ${hostName} for ${dateLabel}. Track us on MealScout.`;
      const shareLink = buildTruckShareLink();
      if (shareLink) {
        maybePromptSocialPost("booking", {
          title: "Share your booking",
          message: shareMessage,
          link: shareLink,
        });
      }
    }

    void reloadPassListings({ silent: true });
    if (shouldReloadSchedule && truckId) {
      void reloadBookedSchedule(truckId, { silent: true });
    }
  };

  const handleShareLocation = async () => {
    if (!canManageTruckProfile) {
      toast({
        title: "Profile access required",
        description:
          "Your team access allows Parking Pass actions, but not live profile/location updates.",
        variant: "destructive",
      });
      return;
    }
    if (!hasProfileTruckTools) {
      toast({
        title: "Permission required",
        description: "This account cannot share the selected truck's live location.",
        variant: "destructive",
      });
      return;
    }

    if (!truckId) {
      toast({
        title: "Missing truck",
        description: "Select a food truck before sharing location.",
        variant: "destructive",
      });
      return;
    }

    setIsSharingLocation(true);
    try {
      const computeLiveMinutes = () => {
        const match = liveLeaveTime.match(/^(\d{2}):(\d{2})$/);
        if (!match) return 240;
        const leaveAt = new Date();
        leaveAt.setHours(Number(match[1]), Number(match[2]), 0, 0);
        if (leaveAt.getTime() <= Date.now()) {
          leaveAt.setDate(leaveAt.getDate() + 1);
        }
        return Math.round((leaveAt.getTime() - Date.now()) / 60_000);
      };
      const safeLiveMinutes = Math.max(15, Math.min(240, computeLiveMinutes()));
      if (isLive) {
        await fetch(apiUrl(`/api/restaurants/${truckId}/mobile-settings`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mobileOnline: false }),
        });
        setIsLive(false);
        toast({ title: "You are offline" });
        return;
      }

      if (!navigator.geolocation) {
        throw new Error("Location services are not available.");
      }

      const position = await new Promise<GeolocationPosition>(
        (resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 10000,
          });
        },
      );

      await fetch(apiUrl(`/api/restaurants/${truckId}/mobile-settings`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobileOnline: true }),
      });

      const locationRes = await fetch(apiUrl(`/api/restaurants/${truckId}/location`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          source: "manual",
          liveForMinutes: safeLiveMinutes,
        }),
      });

      if (!locationRes.ok) {
        const data = await locationRes.json().catch(() => ({}));
        throw new Error(data.message || "Failed to share location");
      }

      setIsLive(true);
      toast({
        title: "Live location shared",
        description: `You are visible for up to ${Math.round(
          safeLiveMinutes / 60,
        )}h unless you go offline first.`,
      });
      let shareCard: {
        title?: string;
        message?: string;
        link?: string;
        imageUrl?: string | null;
      } | null = null;
      try {
        const cardRes = await fetch(apiUrl(`/api/restaurants/${truckId}/live-share-card`),
          { credentials: "include" },
        );
        if (cardRes.ok) {
          shareCard = await cardRes.json();
        }
      } catch {
        // Use the local fallback below.
      }
      const shareMessage =
        shareCard?.message ||
        `${truck?.name || "We"} is serving now. Live location + menu:`;
      const shareLink = shareCard?.link || buildTruckShareLink();
      const shareImage =
        shareCard?.imageUrl || truck?.coverImageUrl || truck?.logoUrl || null;
      if (shareLink) {
        maybePromptSocialPost("live", {
          title: shareCard?.title || "Share your live location",
          message: shareMessage,
          link: shareLink,
          imageUrl: shareImage,
        });
      }
    } catch (error) {
      toast({
        title: "Location update failed",
        description:
          error instanceof Error ? error.message : "Unable to share location.",
        variant: "destructive",
      });
    } finally {
      setIsSharingLocation(false);
    }
  };

  useEffect(() => {
    if (!isAdminOrStaff) {
      setAdminParkingMode("auto");
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const mode = String(params.get("adminMode") || "")
      .trim()
      .toLowerCase();
    if (mode === "truck" || mode === "host") {
      setAdminParkingMode(mode);
    } else {
      setAdminParkingMode("auto");
    }
  }, [isAdminOrStaff, location]);

  const setAdminMode = (mode: "auto" | "truck" | "host") => {
    if (!isAdminOrStaff) return;
    setAdminParkingMode(mode);
    const url = new URL(window.location.href);
    if (mode === "auto") {
      url.searchParams.delete("adminMode");
    } else {
      url.searchParams.set("adminMode", mode);
    }
    window.history.replaceState({}, "", url.toString());
  };

  const hasFoodTruckBusiness = ownedFoodTrucks.length > 0;
  const canUseTruckSide =
    hasFoodTruckBusiness || (isAdminOrStaff && adminParkingMode === "truck");
  const canUseHostSide =
    hasHostProfile || (isAdminOrStaff && adminParkingMode === "host");
  const isTruckViewUser = Boolean(canUseTruckSide);
  const showHostParkingPass = isAuthenticated && canUseHostSide;
  const canScheduleTab = Boolean(canUseTruckSide);
  const canHostTab = Boolean(canUseHostSide);
  const canStartTruckCheckout =
    hasFoodTruckBusiness && Boolean(truckId) && canManageParkingPass;
  const availableTabs = useMemo(
    () =>
      [
        "book",
        canScheduleTab ? "schedule" : null,
        canHostTab ? "host" : null,
      ].filter(Boolean) as ParkingPassTopTab[],
    [canHostTab, canScheduleTab],
  );

  useEffect(() => {
    const nextTab = reconcileParkingPassTopTab({
      currentTab: topTab,
      accessIsLoading: isLoading,
      availableTabs,
      canUseTruckSide,
      canUseHostSide: canHostTab,
    });
    if (nextTab !== topTab) setTopTab(nextTab);
  }, [availableTabs, canHostTab, canUseTruckSide, isLoading, topTab]);
  const normalizedCityQuery = normalizeParkingPassLocationSearch(cityQuery);
  const locationGroups = useMemo(() => {
    const byHost = new Map<string, ParkingPassLocationGroup>();
    passListings.forEach((listing) => {
      const key = getLocationKey(listing);
      const existing = byHost.get(key);
      if (existing) {
        existing.listings.push(listing);
      } else {
        byHost.set(key, { key, host: listing.host, listings: [listing] });
      }
    });
    for (const group of byHost.values()) {
      group.listings.sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
      );
    }
    return Array.from(byHost.values());
  }, [passListings]);

  const filteredLocations = useMemo(() => {
    const filtered = normalizedCityQuery
      ? locationGroups.filter((group) =>
          parkingPassLocationMatches(normalizedCityQuery, [
            group.host.city,
            group.host.state,
            group.host.address,
            group.host.businessName,
          ]),
        )
      : locationGroups;

    return [...filtered].sort((a, b) => {
      const cityA = (a.host.city || "").toLowerCase();
      const cityB = (b.host.city || "").toLowerCase();
      if (cityA && cityB && cityA !== cityB) {
        return cityA.localeCompare(cityB);
      }
      return a.host.businessName.localeCompare(b.host.businessName);
    });
  }, [locationGroups, normalizedCityQuery]);

  const activeLocation =
    filteredLocations.find((group) => group.key === activeLocationKey) ||
    filteredLocations[0] ||
    null;

  const focusLocation = (key: string, scroll = false) => {
    setActiveLocationKey(key);
    if (!scroll) return;
    // Mobile UX: avoid forced auto-scroll jumps when switching locations.
    // Keep user context stable and let them expand details intentionally.
    return;
  };

  const activeListingDateKeys = useMemo(() => {
    if (!activeLocation) return [];
    const keys = activeLocation.listings.map((listing) =>
      getListingDateKey(listing.date),
    );
    return Array.from(new Set(keys)).sort();
  }, [activeLocation]);
  const activeListingDateKeySet = useMemo(
    () => new Set(activeListingDateKeys),
    [activeListingDateKeys],
  );
  const fullListingDates = useMemo(() => {
    if (!activeLocation) return [] as Date[];
    const hasAvailability = (listing: any) => {
      if (!listing) return false;
      if (listing.status !== "open") return false;
      const spots = listing.availableSpotNumbers;
      return Array.isArray(spots) ? spots.length > 0 : true;
    };
    const byKey = new Map<string, ParkingPassListing>();
    for (const listing of activeLocation.listings) {
      byKey.set(getListingDateKey(listing.date), listing);
    }
    const fullKeys = Array.from(byKey.entries())
      .filter(([, listing]) => !hasAvailability(listing))
      .map(([key]) => key);
    return fullKeys.map((key) => new Date(`${key}T00:00:00`));
  }, [activeLocation]);

  const activeListingForDate = activeLocation
    ? activeLocation.listings.find(
        (listing) => getListingDateKey(listing.date) === selectedDate,
      )
    : null;

  const activeListing =
    activeListingForDate ||
    activeLocation?.listings.find(
      (listing) => getListingDateKey(listing.date) >= selectedDate,
    ) ||
    activeLocation?.listings[0] ||
    null;
  const selectedSpotHost =
    (activeListingForDate || activeListing)?.host ||
    activeLocation?.host ||
    null;
  const selectedSpotCoords = useMemo<GeoPoint | null>(() => {
    const lat = parseCoord(selectedSpotHost?.latitude);
    const lng = parseCoord(selectedSpotHost?.longitude);
    if (lat === null || lng === null) return null;
    return { lat, lng };
  }, [selectedSpotHost?.latitude, selectedSpotHost?.longitude]);
  const selectedSpotAddressLabel = selectedSpotHost
    ? buildAddressLabel(
        selectedSpotHost.address,
        selectedSpotHost.city || "",
        selectedSpotHost.state || "",
      )
    : "";
  const { data: placeIntelligenceData, isFetching: isPlaceIntelligenceFetching } =
    useQuery<PlaceIntelligenceResponse>({
      queryKey: [
        "/api/map/place-intelligence",
        selectedSpotHost?.id || null,
        selectedSpotHost?.businessName || null,
        selectedSpotAddressLabel,
        selectedSpotCoords?.lat || null,
        selectedSpotCoords?.lng || null,
      ],
      enabled: Boolean(selectedSpotHost && selectedSpotAddressLabel),
      queryFn: async () => {
        const params = new URLSearchParams({
          name: String(selectedSpotHost?.businessName || ""),
          address: selectedSpotAddressLabel,
        });
        if (selectedSpotCoords) {
          params.set("lat", String(selectedSpotCoords.lat));
          params.set("lng", String(selectedSpotCoords.lng));
        }
        const response = await fetch(
          apiUrl(`/api/map/place-intelligence?${params.toString()}`),
        );
        if (!response.ok) throw new Error("Failed to load place intelligence");
        return response.json();
      },
      staleTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
    });
  const { data: operatorSupportData, isFetching: isOperatorSupportFetching } =
    useQuery<OperatorSupportResponse>({
      queryKey: [
        "/api/map/operator-support",
        selectedSpotCoords?.lat || null,
        selectedSpotCoords?.lng || null,
      ],
      enabled: Boolean(selectedSpotCoords),
      queryFn: async () => {
        const params = new URLSearchParams({
          lat: String(selectedSpotCoords!.lat),
          lng: String(selectedSpotCoords!.lng),
        });
        const response = await fetch(
          apiUrl(`/api/map/operator-support?${params.toString()}`),
        );
        if (!response.ok) throw new Error("Failed to load operator support");
        return response.json();
      },
      staleTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
    });
  const travelOriginCoords = useMemo<GeoPoint | null>(() => {
    const lat = parseCoord(effectiveLocationContext?.latitude);
    const lng = parseCoord(effectiveLocationContext?.longitude);
    if (lat === null || lng === null) return null;
    return { lat, lng };
  }, [
    effectiveLocationContext?.latitude,
    effectiveLocationContext?.longitude,
  ]);
  const { data: selectedSpotRouteSummary, isFetching: isRouteSummaryFetching } =
    useQuery<MapRouteSummaryResponse>({
      queryKey: [
        "/api/map/route-summary",
        travelOriginCoords?.lat || null,
        travelOriginCoords?.lng || null,
        selectedSpotCoords?.lat || null,
        selectedSpotCoords?.lng || null,
      ],
      enabled: Boolean(travelOriginCoords && selectedSpotCoords),
      queryFn: async () => {
        const params = new URLSearchParams({
          originLat: String(travelOriginCoords!.lat),
          originLng: String(travelOriginCoords!.lng),
          destLat: String(selectedSpotCoords!.lat),
          destLng: String(selectedSpotCoords!.lng),
          travelMode: "DRIVE",
        });
        const response = await fetch(
          apiUrl(`/api/map/route-summary?${params.toString()}`),
        );
        if (!response.ok) throw new Error("Failed to load route summary");
        return response.json();
      },
      staleTime: 10 * 60 * 1000,
      refetchOnWindowFocus: false,
    });
  const selectedSpotTravelSummary = selectedSpotRouteSummary
    ? `${Math.max(1, Math.round(selectedSpotRouteSummary.durationSeconds / 60))} min · ${(selectedSpotRouteSummary.distanceMeters / 1609.344).toFixed(1)} mi drive`
    : isRouteSummaryFetching
      ? "Calculating drive time…"
      : travelOriginCoords
        ? "Drive time unavailable"
        : "Share a current location to calculate drive time";
  const journeyVisibleSupport = useMemo(() => {
    if (!journeyResult) return [] as RouteCorridorSupportPlace[];
    if (journeySupportFilter !== "all") {
      return journeyResult.categories[journeySupportFilter] || [];
    }
    const kinds: OperatorSupportKind[] = [
      "gas",
      "propane",
      "supply",
      "support",
    ];
    return kinds.flatMap((kind) =>
      (journeyResult.categories[kind] || []).slice(0, 2),
    );
  }, [journeyResult, journeySupportFilter]);
  const journeyPlannerHosts = useMemo<TripPlannerHost[]>(() => {
    if (!journeyResult) return [];
    const isPlannerListingAvailable = (listing: ParkingPassListing) => {
      if (String(listing.status || "").toLowerCase() !== "open") return false;
      if (!listing.hardCapEnabled) return true;
      return !Array.isArray(listing.availableSpotNumbers) || listing.availableSpotNumbers.length > 0;
    };
    return journeyResult.parkingPassHosts.map((host) => {
      const matchingGroup = locationGroups.find(
        (group) => String(group.host.id) === String(host.hostId),
      );
      const matchingListing = matchingGroup?.listings.find(
        (listing) => getListingDateKey(listing.date) === selectedDate,
      ) || matchingGroup?.listings.find(isPlannerListingAvailable) || null;
      const prices = matchingListing
        ? [
            matchingListing.breakfastPriceCents,
            matchingListing.lunchPriceCents,
            matchingListing.dinnerPriceCents,
            matchingListing.dailyPriceCents,
          ].filter((value): value is number => typeof value === "number" && value > 0)
        : [];
      const trafficText = String(matchingGroup?.host.expectedFootTraffic || "").toLowerCase();
      const traffic: TripPlannerHost["traffic"] = trafficText.includes("high")
        ? "high"
        : trafficText.includes("medium") || trafficText.includes("moderate")
          ? "medium"
          : trafficText.includes("low")
            ? "low"
            : "unknown";
      return {
        locationId: host.locationId,
        hostId: host.hostId,
        name: host.name,
        address: host.address,
        city: host.city,
        state: host.state,
        distanceFromRouteMiles: host.distanceFromRouteMiles,
        routeProgressMiles: host.routeProgressMiles,
        addedDurationSeconds: host.addedDurationSeconds,
        directionsUri: host.directionsUri,
        latitude: host.latitude,
        longitude: host.longitude,
        available: Boolean(matchingListing && isPlannerListingAvailable(matchingListing)),
        priceCents: prices.length > 0 ? Math.min(...prices) : null,
        traffic,
      };
    });
  }, [journeyResult, locationGroups, selectedDate]);
  const journeyMapCenter =
    journeyOriginCoords || journeyDestinationCoords || defaultMapCenter;
  const journeyMapPins = useMemo<MapPickerPin[]>(() => {
    if (!journeyResult || !journeyOriginCoords || !journeyDestinationCoords) {
      return [];
    }
    const supportIcon: Record<OperatorSupportKind, string> = {
      gas: "⛽",
      propane: "🔥",
      supply: "📦",
      support: "🛠️",
    };
    return [
      {
        key: "journey-origin",
        position: journeyOriginCoords,
        popup: (
          <div className="space-y-1 text-xs">
            <p className="font-semibold text-orange-600">Trip start</p>
            <p className="text-[color:var(--text-muted)]">
              {journeyOriginLabel}
            </p>
          </div>
        ),
      },
      {
        key: "journey-destination",
        position: journeyDestinationCoords,
        popup: (
          <div className="space-y-1 text-xs">
            <p className="font-semibold text-orange-600">Destination</p>
            <p className="text-[color:var(--text-muted)]">
              {journeyDestinationLabel}
            </p>
          </div>
        ),
      },
      ...journeyResult.parkingPassHosts.map(
        (host): MapPickerPin => ({
          key: `journey-host:${host.locationId}`,
          position: { lat: host.latitude, lng: host.longitude },
          popup: (
            <div className="space-y-1.5 text-xs">
              <p className="font-semibold text-orange-600">
                Parking Pass · {host.name}
              </p>
              <p className="text-[color:var(--text-muted)]">
                {buildAddressLabel(host.address, host.city, host.state)}
              </p>
              <p className="font-medium text-[color:var(--text-primary)]">
                {formatJourneyDetour(host.addedDurationSeconds)} ·{" "}
                {host.distanceFromRouteMiles.toFixed(1)} mi from route
              </p>
              <a
                href={host.directionsUri}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-orange-600 underline"
              >
                Open trip with this stop
              </a>
            </div>
          ),
        }),
      ),
      ...journeyVisibleSupport.map(
        (place): MapPickerPin => ({
          key: `journey-support:${place.kind}:${place.placeId}`,
          position: { lat: place.latitude, lng: place.longitude },
          occupied: true,
          popup: (
            <div className="space-y-1.5 text-xs">
              <p className="font-semibold text-orange-600">
                {supportIcon[place.kind]} {place.name}
              </p>
              <p className="text-[color:var(--text-muted)]">{place.address}</p>
              <p className="font-medium text-[color:var(--text-primary)]">
                {formatJourneyDetour(place.addedDurationSeconds)}
              </p>
              <a
                href={place.directionsUri}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-orange-600 underline"
              >
                Open trip with this stop
              </a>
            </div>
          ),
        }),
      ),
    ];
  }, [
    journeyDestinationCoords,
    journeyDestinationLabel,
    journeyOriginCoords,
    journeyOriginLabel,
    journeyResult,
    journeyVisibleSupport,
  ]);
  const selectedDateLabel = format(
    new Date(`${selectedDate}T00:00:00`),
    "EEE, MMM d",
  );
  const selectedDateAvailable = Boolean(activeListingForDate);
  const activeListingBookings = Array.isArray(activeListing?.bookings)
    ? activeListing.bookings
    : [];
  const activeListingAvailability = activeListing?.availableSpotNumbers
    ? !activeListing.hardCapEnabled
      ? "Open"
      : activeListing.availableSpotNumbers.length > 0
      ? `Open spots: ${activeListing.availableSpotNumbers.join(", ")}`
      : "Fully booked"
    : activeListing?.status
      ? activeListing.status === "open"
        ? "Open"
        : "Closed"
      : null;
  const hostLocationsByHostId = useMemo(() => {
    const map = new Map<
      string,
      Array<PublicMapLocation & { coords: GeoPoint; addressLabel: string }>
    >();
    const locations = parkingPassMapLocations?.hostLocations ?? [];
    locations.forEach((loc: PublicMapLocation) => {
      if (loc.type !== "host_location" || !loc.hostId) return;
      const lat = parseCoord(loc.latitude);
      const lng = parseCoord(loc.longitude);
      if (lat === null || lng === null) return;
      const entry = {
        ...loc,
        coords: { lat, lng },
        addressLabel: buildAddressLabel(
          loc.address ?? "",
          loc.city ?? "",
          loc.state ?? "",
        ),
      };
      const existing = map.get(loc.hostId);
      if (existing) {
        existing.push(entry);
      } else {
        map.set(loc.hostId, [entry]);
      }
    });
    return map;
  }, [parkingPassMapLocations]);

  const mapPins = useMemo(
    () =>
      filteredLocations
        .flatMap((group) => {
          const hostLocations = hostLocationsByHostId.get(group.host.id);
          if (hostLocations && hostLocations.length > 0) {
            return hostLocations.map((loc) => ({
              key: `${group.key}:${loc.id}`,
              group,
              coords: loc.coords,
              addressLabel: loc.addressLabel,
            }));
          }

          // Prefer address-keyed coordinates so multi-address hosts don't collapse to one pin.
          const coords =
            parkingCoords[group.key] || getLocationCoords(group.host) || null;
          if (!coords) return [];
          return [
            {
              key: group.key,
              group,
              coords,
              addressLabel: buildAddressLabel(
                group.host.address,
                group.host.city ?? "",
                group.host.state ?? "",
              ),
            },
          ];
        })
        .filter(
          (
            item,
          ): item is {
            key: string;
            group: ParkingPassLocationGroup;
            coords: GeoPoint;
            addressLabel: string;
          } => item !== null,
        ),
    [filteredLocations, hostLocationsByHostId, parkingCoords],
  );
  const fallbackHostPins = useMemo(
    () =>
      (parkingPassMapLocations?.hostLocations ?? [])
        .map((loc) => {
          const lat = parseCoord(loc.latitude);
          const lng = parseCoord(loc.longitude);
          if (lat === null || lng === null) return null;

          const hostId = String(loc.hostId || "").trim();
          if (!hostId) return null;

          if (
            normalizedCityQuery &&
            !parkingPassLocationMatches(normalizedCityQuery, [
              loc.name,
              loc.address,
              loc.city,
              loc.state,
            ])
          ) {
              return null;
          }

          return {
            key: `host:${loc.id}`,
            hostId,
            name: String(loc.name || "Host location"),
            coords: { lat, lng },
            addressLabel: buildAddressLabel(
              loc.address ?? "",
              loc.city ?? "",
              loc.state ?? "",
            ),
            spotImageUrl: loc.spotImageUrl ?? null,
          };
        })
        .filter(
          (
            item,
          ): item is {
            key: string;
            hostId: string;
            name: string;
            coords: GeoPoint;
            addressLabel: string;
            spotImageUrl: string | null;
          } => item !== null,
        ),
    [parkingPassMapLocations, normalizedCityQuery],
  );
  const representedMapHostIds = useMemo(
    () => new Set(filteredLocations.map((group) => String(group.host.id))),
    [filteredLocations],
  );
  const unlistedHostPins = useMemo(
    () =>
      fallbackHostPins.filter(
        (pin) => !representedMapHostIds.has(String(pin.hostId)),
      ),
    [fallbackHostPins, representedMapHostIds],
  );
  const parkingPassHostPinCount = mapPins.length + unlistedHostPins.length;
  const partnerSupportPins = useMemo<OperationalSupportPin[]>(() => {
    const raw = Array.isArray(parkingPassMapLocations?.supplierLocations)
      ? parkingPassMapLocations.supplierLocations
      : [];
    return raw
      .map((loc): OperationalSupportPin | null => {
        const lat = parseCoord(loc.latitude);
        const lng = parseCoord(loc.longitude);
        if (lat === null || lng === null) return null;
        const category = String(loc.category || "").trim().toLowerCase();
        const isPropane = category === "propane_dealer";
        const isSupply =
          category === "supplier" || category === "equipment_supplier";
        const kind: OperatorSupportKind = isPropane
          ? "propane"
          : isSupply
            ? "supply"
            : "support";
        return {
          key: `supplier:${String(loc.id || loc.supplierId || `${lat}:${lng}`)}`,
          position: { lat, lng },
          name: String(loc.name || "Operator support"),
          addressLabel: buildAddressLabel(
            String(loc.address || ""),
            String(loc.city || ""),
            String(loc.state || ""),
          ),
          categoryLabel: String(loc.categoryLabel || "Operator support"),
          profileUrl: String(loc.profileUrl || "").trim() || null,
          googleMapsUri: null,
          contactPhone: String(loc.contactPhone || "").trim() || null,
          contactEmail: String(loc.contactEmail || "").trim() || null,
          kind,
          source: "mealscout_partner" as const,
          distanceMiles: null,
          driveDurationSeconds: null,
        };
      })
      .filter(
        (item): item is OperationalSupportPin => item !== null,
      );
  }, [parkingPassMapLocations?.supplierLocations]);
  const discoveredSupportPins = useMemo<OperationalSupportPin[]>(() => {
    const categories = operatorSupportData?.categories;
    const kinds: OperatorSupportKind[] = [
      "gas",
      "propane",
      "supply",
      "support",
    ];
    const labelByKind: Record<OperatorSupportKind, string> = {
      gas: "Nearby gas station",
      propane: "Nearby propane supplier",
      supply: "Nearby restaurant supply",
      support: "Nearby kitchen repair",
    };
    return kinds.flatMap((kind) =>
      (categories?.[kind] || []).map((place) => ({
        key: `google-support:${kind}:${place.placeId}`,
        position: { lat: place.latitude, lng: place.longitude },
        name: place.name,
        addressLabel: place.address,
        categoryLabel: labelByKind[kind],
        profileUrl: null,
        googleMapsUri: place.googleMapsUri,
        contactPhone: place.phone,
        contactEmail: null,
        kind,
        source: "google_places" as const,
        distanceMiles: place.straightLineMiles,
        driveDurationSeconds: place.driveDurationSeconds,
      })),
    );
  }, [operatorSupportData?.categories]);
  const allOperationalSupportPins = useMemo(
    () => [...partnerSupportPins, ...discoveredSupportPins],
    [discoveredSupportPins, partnerSupportPins],
  );
  const operationalSupportPins = useMemo(
    () =>
      allOperationalSupportPins.filter((pin) => {
        if (pin.kind === "gas") return showGasLayer;
        if (pin.kind === "propane") return showPropaneLayer;
        if (pin.kind === "supply") return showSupplyLayer;
        return showSupportLayer;
      }),
    [
      allOperationalSupportPins,
      showGasLayer,
      showPropaneLayer,
      showSupplyLayer,
      showSupportLayer,
    ],
  );
  const supplierLayerCounts = useMemo(() => {
    let gas = 0;
    let propane = 0;
    let supply = 0;
    let support = 0;
    allOperationalSupportPins.forEach((pin) => {
      if (pin.kind === "gas") gas += 1;
      if (pin.kind === "propane") propane += 1;
      if (pin.kind === "supply") supply += 1;
      if (pin.kind === "support") support += 1;
    });
    return { gas, propane, supply, support };
  }, [allOperationalSupportPins]);
  const supplierLayerSummary = useMemo(() => {
    const statusFor = (count: number) =>
      count > 0
        ? String(count)
        : isOperatorSupportFetching
          ? "Loading"
          : "Unavailable";
    return {
      gas: statusFor(supplierLayerCounts.gas),
      propane: statusFor(supplierLayerCounts.propane),
      supply: statusFor(supplierLayerCounts.supply),
      support: statusFor(supplierLayerCounts.support),
    };
  }, [
    isOperatorSupportFetching,
    supplierLayerCounts.gas,
    supplierLayerCounts.propane,
    supplierLayerCounts.supply,
    supplierLayerCounts.support,
  ]);
  const gasPricePins = useMemo(() => {
    const raw = Array.isArray(parkingPassMapLocations?.hostLocations)
      ? parkingPassMapLocations.hostLocations
      : [];
    return raw
      .map((loc) => {
        const lat = parseCoord(loc.latitude);
        const lng = parseCoord(loc.longitude);
        if (lat === null || lng === null) return null;
        const fuelPrices = (loc as any)?.fuelPrices || null;
        if ((loc as any)?.showFuelPrices !== true || !fuelPrices) return null;
        const regular = formatFuelCents(fuelPrices.regularCents);
        const midgrade = formatFuelCents(fuelPrices.midgradeCents);
        const premium = formatFuelCents(fuelPrices.premiumCents);
        const diesel = formatFuelCents(fuelPrices.dieselCents);
        const hasPrice = Boolean(regular || midgrade || premium || diesel);
        if (!hasPrice) return null;
        return {
          key: `gas:${String(loc.id || `${lat}:${lng}`)}`,
          position: { lat, lng },
          name: String(loc.name || "Gas station"),
          addressLabel: buildAddressLabel(
            String(loc.address || ""),
            String(loc.city || ""),
            String(loc.state || ""),
          ),
          regular,
          midgrade,
          premium,
          diesel,
          updatedAt: String(fuelPrices.updatedAt || "").trim() || null,
        };
      })
      .filter(
        (
          item,
        ): item is {
          key: string;
          position: GeoPoint;
          name: string;
          addressLabel: string;
          regular: string | null;
          midgrade: string | null;
          premium: string | null;
          diesel: string | null;
          updatedAt: string | null;
        } => item !== null,
      );
  }, [parkingPassMapLocations?.hostLocations]);
  // The gas layer includes provider results AND host-published fuel prices.
  const gasLayerCount = supplierLayerCounts.gas + gasPricePins.length;
  const gasLayerSummary = gasLayerCount > 0
    ? String(gasLayerCount)
    : isOperatorSupportFetching ? "Loading" : "Unavailable";
  const fallbackMapCenter = useMemo(() => {
    const requestedPin = requestedHostId
      ? fallbackHostPins.find((pin) => pin.hostId === requestedHostId)
      : null;
    return (
      requestedPin?.coords || fallbackHostPins[0]?.coords || defaultMapCenter
    );
  }, [fallbackHostPins, requestedHostId]);
  const mapCenter = useMemo(() => {
    const activeHostLocations = activeLocation
      ? hostLocationsByHostId.get(activeLocation.host.id)
      : null;
    const activeCoords =
      (activeLocation
        ? parkingCoords[activeLocation.key] ||
          getLocationCoords(activeLocation.host) ||
          null
        : null) ||
      (activeHostLocations && activeHostLocations.length > 0
        ? activeHostLocations[0].coords
        : null);
    return (
      activeCoords ||
      mapPins[0]?.coords ||
      unlistedHostPins[0]?.coords ||
      defaultMapCenter
    );
  }, [
    activeLocation,
    hostLocationsByHostId,
    mapPins,
    parkingCoords,
    unlistedHostPins,
  ]);

  useEffect(() => {
    if (geocodeInFlight.current) return;
    const queue = filteredLocations
      .filter((group) => {
        const hasMappedCoords = hostLocationsByHostId.has(group.host.id);
        if (hasMappedCoords) return false;
        return (
          !parkingCoords[group.key] && Boolean(buildHostAddress(group.host))
        );
      })
      .slice(0, 20);

    if (!queue.length) return;

    geocodeInFlight.current = true;
    (async () => {
      try {
        for (const group of queue) {
          const address = buildHostAddress(group.host);
          if (!address) continue;
          const cached = geocodeCache[address];
          if (cached) {
            setParkingCoords((prev) => ({ ...prev, [group.key]: cached }));
            continue;
          }
          const point = await geocodeAddress(address).catch(() => null);
          if (!point) {
            continue;
          }
          setParkingCoords((prev) => ({ ...prev, [group.key]: point }));
          setGeocodeCache((prev) => ({ ...prev, [address]: point }));
          await new Promise((r) => setTimeout(r, 1100));
        }
      } finally {
        geocodeInFlight.current = false;
      }
    })();
  }, [filteredLocations, hostLocationsByHostId, parkingCoords, geocodeCache]);

  useEffect(() => {
    if (!activeLocation) {
      setActiveLocationKey(null);
      return;
    }
    if (activeLocationKey && activeLocationKey === activeLocation.key) {
      return;
    }
    setActiveLocationKey(activeLocation.key);
  }, [activeLocation, activeLocationKey]);

  const cartTotals = getCartTotals();
  const hasCartTotal = cartItems.length > 0 && cartTotals.totalCents > 0;
  const todayDateKey = useMemo(() => format(new Date(), "yyyy-MM-dd"), []);

  // Trucks pay MealScout (platform payments). Hosts can optionally enable Stripe Connect payouts (cashout).
  // If host payouts aren't configured, host earnings are held as credit.
  const platformPaymentsReady =
    stripeConfig?.paymentsReady ??
    (isStripeConfigLoading ? true : Boolean(import.meta.env.VITE_STRIPE_PUBLIC_KEY));

  const listingHasAvailability = (
    listing: ParkingPassListing | null | undefined,
  ): boolean => {
    if (!listing) return false;
    if (listing.status !== "open") return false;
    if (!listing.hardCapEnabled) return true;
    const spots = listing.availableSpotNumbers;
    return Array.isArray(spots) ? spots.length > 0 : true;
  };

  const listingHasBookableSlots = (
    listing: ParkingPassListing | null | undefined,
  ): boolean => {
    if (!listingHasAvailability(listing)) return false;
    return listing ? buildSlotOptions(listing).length > 0 : false;
  };

  const listingDayIsSelectable = (
    listing: ParkingPassListing | null | undefined,
  ): boolean => {
    if (!listingHasAvailability(listing)) return false;
    if (!listing) return false;

    const listingDate = new Date(listing.date);
    const listingDayStart = new Date(listingDate);
    listingDayStart.setHours(0, 0, 0, 0);

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    if (listingDayStart < todayStart) return false;
    if (listingDayStart > todayStart) return true;

    // Same-day rule: keep day selectable until the 3rd meal window (dinner) starts.
    const [dinnerHour, dinnerMinute] = PARKING_PASS_MEAL_WINDOWS.dinner.start
      .split(":")
      .map(Number);
    const dinnerStartMinutes = dinnerHour * 60 + dinnerMinute;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    return nowMinutes < dinnerStartMinutes;
  };

  const selectedDateHasOpenSpots = Boolean(
    activeListingForDate && listingDayIsSelectable(activeListingForDate),
  );
  const weatherListing = activeListingForDate || activeListing || null;
  const weatherLat = Number(
    weatherListing?.host?.latitude ?? activeLocation?.host?.latitude,
  );
  const weatherLng = Number(
    weatherListing?.host?.longitude ?? activeLocation?.host?.longitude,
  );
  const weatherDate = weatherListing
    ? getListingDateKey(weatherListing.date)
    : selectedDate;
  const weatherStartTime =
    String(weatherListing?.startTime || "").trim() || "11:00";
  const weatherEndTime =
    String(weatherListing?.endTime || "").trim() || "14:00";
  const scheduleWindowMinutes = (() => {
    const [startHour, startMinute] = weatherStartTime
      .split(":")
      .map((value) => Number.parseInt(value, 10));
    const [endHour, endMinute] = weatherEndTime
      .split(":")
      .map((value) => Number.parseInt(value, 10));
    if (
      !Number.isFinite(startHour) ||
      !Number.isFinite(startMinute) ||
      !Number.isFinite(endHour) ||
      !Number.isFinite(endMinute)
    ) {
      return 240;
    }
    const start = startHour * 60 + startMinute;
    const end = endHour * 60 + endMinute;
    const span = end > start ? end - start : 240;
    return Math.max(60, Math.min(720, span));
  })();
  const canLoadBookingWeather =
    Number.isFinite(weatherLat) &&
    Number.isFinite(weatherLng) &&
    Boolean(weatherDate);
  const { data: bookingWeatherData, isFetching: isBookingWeatherFetching } =
    useQuery<any>({
      queryKey: [
        "/api/parking-pass/weather",
        weatherLat,
        weatherLng,
        weatherDate,
        weatherStartTime,
        weatherEndTime,
      ],
      enabled: canLoadBookingWeather,
      queryFn: async () => {
        const params = new URLSearchParams({
          lat: String(weatherLat),
          lng: String(weatherLng),
          date: String(weatherDate),
          startTime: weatherStartTime,
          endTime: weatherEndTime,
        });
        const res = await fetch(
          apiUrl(`/api/parking-pass/weather?${params.toString()}`),
        );
        if (!res.ok) throw new Error("Failed to load booking weather");
        return res.json();
      },
      staleTime: 10 * 60 * 1000,
      refetchOnWindowFocus: false,
    });
  const canLoadScheduleFootTraffic =
    Number.isFinite(weatherLat) && Number.isFinite(weatherLng);
  const { data: scheduleFootTrafficData, isFetching: isScheduleFootTrafficFetching } =
    useQuery<MapFootTrafficResponse>({
      queryKey: [
        "/api/map/foot-traffic",
        "parking-pass-schedule",
        weatherLat,
        weatherLng,
        scheduleWindowMinutes,
      ],
      enabled: canLoadScheduleFootTraffic,
      queryFn: async () => {
        const lat = Number(weatherLat);
        const lng = Number(weatherLng);
        const delta = 0.015;
        const params = new URLSearchParams({
          north: String(lat + delta),
          south: String(lat - delta),
          east: String(lng + delta),
          west: String(lng - delta),
          zoom: "14",
          windowMinutes: String(scheduleWindowMinutes),
          includeGoogle: "true",
        });
        const res = await fetch(apiUrl(`/api/map/foot-traffic?${params.toString()}`));
        if (!res.ok) throw new Error("Failed to load schedule foot traffic");
        return res.json();
      },
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    });
  const selectedSpotFuelPrices =
    selectedSpotHost?.showFuelPrices === true && selectedSpotHost?.fuelPrices
      ? selectedSpotHost.fuelPrices
      : placeIntelligenceData?.place?.fuelPrices || null;
  const selectedSpotFuelSource =
    selectedSpotHost?.showFuelPrices === true && selectedSpotHost?.fuelPrices
      ? "MealScout host"
      : placeIntelligenceData?.place?.fuelPrices
        ? "Google Places"
        : null;
  const selectedSpotGasPriceSummary = useMemo(() => {
    if (!activeLocation) {
      return "Select a spot to view gas prices.";
    }
    if (!selectedSpotFuelPrices) {
      return isPlaceIntelligenceFetching
        ? "Checking Google Places for current prices…"
        : "No current provider prices were found for this spot.";
    }
    const regular = formatFuelCents(selectedSpotFuelPrices.regularCents);
    const midgrade = formatFuelCents(selectedSpotFuelPrices.midgradeCents);
    const premium = formatFuelCents(selectedSpotFuelPrices.premiumCents);
    const diesel = formatFuelCents(selectedSpotFuelPrices.dieselCents);
    const parts = [
      regular ? `Regular ${regular}` : null,
      midgrade ? `Midgrade ${midgrade}` : null,
      premium ? `Premium ${premium}` : null,
      diesel ? `Diesel ${diesel}` : null,
    ].filter(Boolean) as string[];
    if (!parts.length) {
      return "No current provider prices were found for this spot.";
    }
    return `${parts.join(" · ")} · ${selectedSpotFuelSource || "provider"}`;
  }, [
    activeLocation,
    isPlaceIntelligenceFetching,
    selectedSpotFuelPrices,
    selectedSpotFuelSource,
  ]);
  const nearestOperationalSupport = useMemo(() => {
    if (!selectedSpotCoords) {
      return {
        gas: "Select a spot",
        propane: "Select a spot",
        supply: "Select a spot",
        support: "Select a spot",
      };
    }
    const nearestLabel = (
      points: Array<{
        name: string;
        position: GeoPoint;
        driveDurationSeconds?: number | null;
      }>,
      fallback: string,
    ) => {
      if (!points.length) return fallback;
      const ranked = points
        .map((point) => ({
          ...point,
          miles: distanceMilesBetween(selectedSpotCoords, point.position),
        }))
        .sort((left, right) => {
          if (left.driveDurationSeconds && right.driveDurationSeconds) {
            return left.driveDurationSeconds - right.driveDurationSeconds;
          }
          return left.miles - right.miles;
        });
      const nearest = ranked[0];
      const travelLabel = nearest.driveDurationSeconds
        ? `${Math.max(1, Math.round(nearest.driveDurationSeconds / 60))} min drive`
        : `${nearest.miles.toFixed(1)} mi`;
      return `${nearest.name} · ${travelLabel}`;
    };
    const byKind = (kind: OperatorSupportKind) =>
      allOperationalSupportPins
        .filter((pin) => pin.kind === kind)
        .map((pin) => ({
          name: pin.name,
          position: pin.position,
          driveDurationSeconds: pin.driveDurationSeconds,
        }));
    const propanePoints = byKind("propane");
    const supplyPoints = byKind("supply");
    const supportPoints = byKind("support");
    const gasPoints = [
      ...byKind("gas"),
      ...gasPricePins.map((pin) => ({
        name: pin.name,
        position: pin.position,
        driveDurationSeconds: null,
      })),
    ];
    return {
      gas: nearestLabel(
        gasPoints,
        isOperatorSupportFetching ? "Searching nearby" : "Unavailable",
      ),
      propane: nearestLabel(
        propanePoints,
        isOperatorSupportFetching ? "Searching nearby" : "Unavailable",
      ),
      supply: nearestLabel(
        supplyPoints,
        isOperatorSupportFetching ? "Searching nearby" : "Unavailable",
      ),
      support: nearestLabel(
        supportPoints,
        isOperatorSupportFetching ? "Searching nearby" : "Unavailable",
      ),
    };
  }, [
    allOperationalSupportPins,
    gasPricePins,
    isOperatorSupportFetching,
    selectedSpotCoords,
  ]);
  const spotFootTrafficCells = useMemo<MapTrafficCell[]>(() => {
    if (!showParkingScoutHeat || !canManageParkingPass || !activeLocation) return [];
    return (scheduleFootTrafficData?.cells || []).slice(0, 120).map((cell) => {
      const color =
        cell.source === "first_party"
          ? "#2563eb"
          : cell.source === "supply_signal"
            ? "#f97316"
            : "#8b5cf6";
      return { ...cell, color };
    });
  }, [
    activeLocation,
    canManageParkingPass,
    scheduleFootTrafficData?.cells,
    showParkingScoutHeat,
  ]);
  const spotFootTrafficCellCount = spotFootTrafficCells.length;
  const spotActivityBreakdown = useMemo(
    () => ({
      mealScoutPings: scheduleFootTrafficData?.firstParty?.totalPings || 0,
      mealScoutCells: scheduleFootTrafficData?.firstParty?.cells?.length || 0,
      scheduledCells: scheduleFootTrafficData?.supplySignals?.cells?.length || 0,
      destinationCells: scheduleFootTrafficData?.googlePlaces?.cells?.length || 0,
    }),
    [scheduleFootTrafficData],
  );
  const spotActivityTitle =
    spotActivityBreakdown.mealScoutCells > 0
      ? "MealScout and area activity"
      : spotActivityBreakdown.destinationCells > 0
        ? "Food destination density"
        : spotActivityBreakdown.scheduledCells > 0
          ? "Scheduled area activity"
          : "No area activity signals yet";
  const spotActivitySummary = `${spotActivityBreakdown.mealScoutPings} MealScout pings · ${spotActivityBreakdown.scheduledCells} scheduled cells · ${spotActivityBreakdown.destinationCells} food-destination cells`;

  const nextBookableDateByGroup = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const group of filteredLocations) {
      const next = group.listings.find((listing) => {
        const dateKey = getListingDateKey(listing.date);
        if (dateKey < todayDateKey) return false;
        // Spots should be discoverable even if the host hasn't enabled payments yet.
        return listingDayIsSelectable(listing);
      });
      map.set(group.key, next ? getListingDateKey(next.date) : null);
    }
    return map;
  }, [filteredLocations, todayDateKey]);

  const nextBookableListingByGroup = useMemo(() => {
    const map = new Map<string, ParkingPassListing | null>();
    for (const group of filteredLocations) {
      const next = group.listings.find((listing) => {
        const dateKey = getListingDateKey(listing.date);
        if (dateKey < todayDateKey) return false;
        // Spots should be discoverable even if the host hasn't enabled payments yet.
        return listingDayIsSelectable(listing);
      });
      map.set(group.key, next || null);
    }
    return map;
  }, [filteredLocations, todayDateKey]);

  const activeBookableDates = useMemo(() => {
    if (!activeLocation) return [];
    const keys = activeLocation.listings
      .filter((listing) => listingDayIsSelectable(listing))
      .map((listing) => getListingDateKey(listing.date));
    return Array.from(new Set(keys)).sort();
  }, [activeLocation]);

  const lastActiveLocationKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeLocation) return;
    if (lastActiveLocationKeyRef.current === activeLocation.key) return;
    lastActiveLocationKeyRef.current = activeLocation.key;

    const next = nextBookableDateByGroup.get(activeLocation.key) || null;
    if (next) {
      setSelectedDate(next);
    } else if (activeLocation.listings.length > 0) {
      setSelectedDate(getListingDateKey(activeLocation.listings[0].date));
    }
  }, [activeLocation, nextBookableDateByGroup]);

  useEffect(() => {
    if (!activeLocation) return;
    if (activeListingDateKeys.length === 0) return;
    if (activeListingDateKeys.includes(selectedDate)) return;
    setSelectedDate(activeListingDateKeys[0]);
  }, [activeListingDateKeys, activeLocation, selectedDate]);

  return (
    <div className="min-h-screen bg-transparent parking-pass-page">
      <div className="mx-auto max-w-[1520px] space-y-4 px-4 py-5 sm:px-6 sm:py-6 xl:px-8">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-[color:var(--text-primary)]">
            Parking Pass
          </h1>
          <p className="text-sm text-[color:var(--text-muted)]">
            Book a host location or manage your parking availability.
          </p>
          {isAdminOrStaff && (
            <details className="mt-3 rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] px-3 py-2 text-xs text-[color:var(--text-secondary)]">
              <summary className="cursor-pointer font-semibold text-[color:var(--text-primary)]">
                Admin view: {adminParkingMode === "auto" ? "Automatic" : adminParkingMode === "truck" ? "Food truck" : "Host"}
              </summary>
              <p className="mt-2 text-[11px] text-[color:var(--text-muted)]">
                {isAdminOrStaff ? "Admin access" : "Operator access"}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={adminParkingMode === "auto" ? "default" : "outline"}
                  onClick={() => setAdminMode("auto")}
                >
                  Automatic
                </Button>
                <Button
                  size="sm"
                  variant={adminParkingMode === "truck" ? "default" : "outline"}
                  onClick={() => setAdminMode("truck")}
                >
                  Food truck
                </Button>
                <Button
                  size="sm"
                  variant={adminParkingMode === "host" ? "default" : "outline"}
                  onClick={() => setAdminMode("host")}
                >
                  Host
                </Button>
              </div>
            </details>
          )}
        </div>

        <Tabs value={topTab} onValueChange={(value) => setTopTab(value as any)}>
          <TabsList
            className="grid w-full rounded-xl p-1 pp-glass-muted"
            style={{
              gridTemplateColumns: `repeat(${availableTabs.length}, minmax(0, 1fr))`,
            }}
          >
            <TabsTrigger value="book" className="text-xs sm:text-sm">
              Find & Book
            </TabsTrigger>
            {canScheduleTab && (
              <TabsTrigger value="schedule" className="text-xs sm:text-sm">
                My Schedule
              </TabsTrigger>
            )}
            {canHostTab && (
              <TabsTrigger value="host" className="text-xs sm:text-sm">
                Host tools
              </TabsTrigger>
            )}
          </TabsList>
        </Tabs>

        {isAdminOrStaff && <AdminRouteConversionCard />}

        {topTab === "host" && canHostTab && (
          <div className="grid gap-3 md:grid-cols-2">
              <HostRouteDemandCard />
              <Card className="rounded-2xl border border-[color:var(--border-subtle)] pp-glass">
                <CardContent className="p-4 space-y-3">
                  <div>
                    <p className="text-sm font-semibold text-[color:var(--text-primary)]">
                        Host tools
                      </p>
                    <p className="text-xs text-[color:var(--text-muted)]">
                      Publish where trucks can park, set pricing and
                      availability, block blackout dates, and manage payout
                      readiness.
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[11px] text-[color:var(--text-primary)]">
                    <span className="rounded-lg pp-glass-muted px-2 py-1">
                      {hosts.length} host location
                      {hosts.length === 1 ? "" : "s"}
                    </span>
                    <span className="rounded-lg pp-glass-muted px-2 py-1">
                      {hostPassListings.length} pass listing
                      {hostPassListings.length === 1 ? "" : "s"}
                    </span>
                    <span className="rounded-lg pp-glass-muted px-2 py-1">
                      {hasActiveParkingPass
                        ? "Availability live"
                        : "No active pass"}
                    </span>
                    <span className="rounded-lg pp-glass-muted px-2 py-1">
                      {host?.stripeConnectAccountId &&
                      host?.stripePayoutsEnabled
                        ? "Payouts enabled"
                        : "Payouts optional"}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        setTopTab("host");
                        setHostToolsTab("listings");
                      }}
                    >
                      Publish availability
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setTopTab("host");
                        setHostToolsTab("location");
                      }}
                    >
                      Location/settings
                    </Button>
                  </div>
                </CardContent>
              </Card>
          </div>
        )}

        <div className="flex flex-col gap-6">
          {topTab === "host" && showHostParkingPass && !host && (
            <div className="rounded-2xl border border-[color:var(--status-warning)]/30 bg-orange-50/70 p-4 text-sm text-[color:var(--status-warning)]">
              Loading your host tools...
            </div>
          )}

          {topTab === "host" && showHostParkingPass && (
            <div className="rounded-2xl pp-glass p-4 shadow-clean space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-base font-semibold text-slate-900 font-display">
                    Host tools
                  </p>
                  <p className="text-xs text-slate-500">
                    Listings, location details, and payout status.
                  </p>
                </div>
                {host ? (
                  <span
                    className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${
                      host.stripeConnectAccountId && host.stripePayoutsEnabled
                        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                        : "border-amber-200 bg-amber-50 text-amber-800"
                    }`}
                  >
                    {host.stripeConnectAccountId && host.stripePayoutsEnabled
                      ? "Payouts enabled"
                      : "Payouts not enabled"}
                  </span>
                ) : null}
              </div>

              {host
                ? (() => {
                    const uniqueFlags = new Set<string>();
                    hostPassListings.forEach((item: any) => {
                      const flags = Array.isArray(item?.qualityFlags)
                        ? item.qualityFlags
                        : [];
                      flags.forEach((flag: any) =>
                        uniqueFlags.add(String(flag)),
                      );
                    });
                    const flags = Array.from(uniqueFlags.values());
                    const payoutsEnabled = Boolean(
                      host.stripeConnectAccountId && host.stripePayoutsEnabled,
                    );
                    const hasSpotPhoto = Boolean(host.spotImageUrl);
                    const hasAddress = Boolean(
                      host.address && String(host.address).trim().length > 0,
                    );

                    // Non-blocking flags should not prevent map visibility.
                    const NON_BLOCKING_FLAGS = new Set([
                      "payments_disabled",
                      "missing_coords",
                      "invalid_coords",
                    ]);
                    const blockingFlags = flags.filter(
                      (flag) => !NON_BLOCKING_FLAGS.has(flag),
                    );
                    const publicReady =
                      hasAddress && blockingFlags.length === 0;

                    const checklist = [
                      {
                        ok: platformPaymentsReady,
                        label: "Platform payments enabled",
                      },
                      { ok: hasAddress, label: "Address set (street)" },
                      {
                        ok: !blockingFlags.includes("missing_price"),
                        label: "Pricing added (at least one slot)",
                      },
                      {
                        ok:
                          !blockingFlags.includes("missing_spots") &&
                          !blockingFlags.includes("invalid_spots"),
                        label: "Spot count set",
                      },
                      {
                        ok: !blockingFlags.includes("invalid_time_window"),
                        label: "Hours set (start/end time)",
                      },
                      { ok: hasSpotPhoto, label: "Spot photo uploaded" },
                      {
                        ok: payoutsEnabled,
                        label:
                          "Host payouts enabled (optional — bookings work without this)",
                        optional: true,
                      },
                    ] as { ok: boolean; label: string; optional?: boolean }[];
                    const total = checklist.length;
                    const done = checklist.filter((item) => item.ok).length;
                    const pct = Math.round((done / Math.max(1, total)) * 100);

                    return (
                      <div className="rounded-xl border border-slate-200 bg-white/70 p-4 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="text-sm font-semibold text-slate-900">
                            Setup checklist
                          </div>
                          <span
                            className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${
                              publicReady
                                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                                : "border-amber-200 bg-amber-50 text-amber-800"
                            }`}
                          >
                            {publicReady
                              ? "Visible on map"
                              : "Not visible on map"}
                          </span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                          <div
                            className={`h-full ${
                              publicReady ? "bg-emerald-500" : "bg-amber-500"
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className="text-xs text-slate-600">
                          {done}/{total} complete
                          {flags.length > 0 && !publicReady ? (
                            <span>
                              {" "}
                              - Fix the missing items below to go live.
                            </span>
                          ) : null}
                        </div>
                        {flags.length > 0 && (
                          <div className="flex flex-wrap gap-2 pt-1">
                            {flags.slice(0, 10).map((flag) => (
                              <span
                                key={flag}
                                className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900"
                              >
                                {flag}
                              </span>
                            ))}
                            {flags.length > 10 ? (
                              <span className="text-[11px] text-amber-900">
                                +{flags.length - 10} more
                              </span>
                            ) : null}
                          </div>
                        )}
                        <div className="grid gap-1 sm:grid-cols-2">
                          {checklist.map((item) => (
                            <div
                              key={item.label}
                              className="flex items-center gap-2 text-xs"
                            >
                              <span
                                className={`inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] font-bold ${
                                  item.ok
                                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                    : item.optional
                                      ? "border-blue-200 bg-blue-50 text-blue-700"
                                      : "border-amber-200 bg-amber-50 text-amber-800"
                                }`}
                              >
                                {item.ok ? "OK" : item.optional ? "–" : "!"}
                              </span>
                              <span
                                className={
                                  item.ok
                                    ? "text-slate-700"
                                    : item.optional
                                      ? "text-blue-800"
                                      : "text-amber-900"
                                }
                              >
                                {item.label}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()
                : null}

              <Tabs
                value={hostToolsTab}
                onValueChange={(value) => setHostToolsTab(value as any)}
              >
                <TabsList className="w-full justify-start pp-glass-muted rounded-xl p-1">
                  <TabsTrigger value="listings" className="text-sm">
                    Listings
                  </TabsTrigger>
                  <TabsTrigger value="location" className="text-sm">
                    Location
                  </TabsTrigger>
                  <TabsTrigger value="payments" className="text-sm">
                    Payments
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          )}

          {topTab === "host" &&
            hostToolsTab === "payments" &&
            showHostParkingPass && (
              <div className="rounded-2xl pp-glass p-5 shadow-clean space-y-3">
                <div>
                  <p className="text-base font-semibold text-slate-900 font-display">
                    Payments
                  </p>
                  <p className="text-xs text-slate-500">
                    Stripe payouts are optional. Trucks can still book your
                    Parking Pass listings; if payouts are disabled, your
                    earnings are held as credit until you enable payouts.
                  </p>
                </div>

                {!host ? (
                  <div className="rounded-xl pp-glass-muted p-4 text-sm text-slate-700">
                    Loading payment status...
                  </div>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div
                      className={`rounded-xl border p-4 text-sm ${
                        platformPaymentsReady
                          ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                          : "border-amber-200 bg-amber-50 text-amber-900"
                      }`}
                    >
                      <p className="font-semibold">Platform payments</p>
                      <p className="text-xs opacity-90">
                        {platformPaymentsReady
                          ? "Enabled. Paid bookings can be processed."
                          : "Not enabled. Paid bookings may fail even if your listing is visible."}
                      </p>
                    </div>

                    {host.stripeConnectAccountId &&
                    host.stripePayoutsEnabled ? (
                      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                        <p className="font-semibold">Host payouts</p>
                        <p className="text-xs opacity-90">
                          Enabled. You can cash out automatically.
                        </p>
                      </div>
                    ) : (
                      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
                        <p className="text-sm font-semibold text-amber-900">
                          Host payouts are not enabled yet.
                        </p>
                        <p className="text-xs text-amber-800">
                          Finish Stripe onboarding to enable cashout. This does
                          not block listing visibility or bookings.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            onClick={() => setLocation("/host/dashboard")}
                          >
                            Enable payouts
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setLocation("/host/dashboard?setup=refresh")
                            }
                          >
                            Check status
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          {topTab === "host" &&
            hostToolsTab === "location" &&
            showHostParkingPass &&
            host && (
              <div
                id="parking-pass-settings"
                className="rounded-2xl border border-[color:var(--status-warning)]/30 bg-orange-50/70 p-4"
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-orange-900">
                      Parking Pass settings
                    </p>
                    <p className="text-xs text-orange-700">
                      Manage location details, availability, blackout dates,
                      pricing, and amenities for places where food trucks can
                      park.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {hosts.length > 1 && (
                      <div className="flex items-center gap-2">
                        <Label
                          htmlFor="hostSelect"
                          className="text-xs text-orange-900"
                        >
                          Location
                        </Label>
                        <select
                          id="hostSelect"
                          value={selectedHostId}
                          onChange={(event) =>
                            setSelectedHostId(event.target.value)
                          }
                          className="h-9 rounded-md border border-[color:var(--status-warning)]/30 bg-[var(--bg-surface)] px-2 text-xs"
                        >
                          {hosts.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.businessName} · {item.address}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <Button
                      size="sm"
                      onClick={() => setIsCreating(!isCreating)}
                    >
                      {isCreating ? (
                        "Cancel"
                      ) : (
                        <>
                          <Plus className="mr-2 h-4 w-4" /> New Parking Pass
                        </>
                      )}
                    </Button>
                  </div>
                </div>
                {!host ? (
                  <div className="mt-4 rounded-xl border border-[color:var(--status-warning)]/30 bg-[var(--bg-surface)]/60 p-4 text-xs text-[color:var(--status-warning)]">
                    Loading your parking pass locations...
                  </div>
                ) : (
                  <div className="mt-4 grid gap-6 lg:grid-cols-[1.35fr_0.65fr]">
                    <div className="space-y-4">
                      <div className="rounded-xl border border-[color:var(--status-warning)]/30 bg-[var(--bg-surface)] p-4 space-y-3">
                        <div>
                          <p className="text-sm font-semibold text-orange-900">
                            Blackout dates
                          </p>
                          <p className="text-xs text-orange-700">
                            Block specific days when trucks cannot park. This is
                            your Parking Pass schedule control.
                          </p>
                        </div>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                          <Input
                            type="date"
                            value={blackoutDateInput}
                            onChange={(event) =>
                              setBlackoutDateInput(event.target.value)
                            }
                            min={format(new Date(), "yyyy-MM-dd")}
                            disabled={!hasActiveParkingPass}
                          />
                          <Button
                            type="button"
                            onClick={handleAddBlackout}
                            disabled={
                              !hasActiveParkingPass ||
                              !blackoutDateInput ||
                              isSavingBlackout
                            }
                            size="sm"
                          >
                            {isSavingBlackout
                              ? "Saving..."
                              : "Add blackout date"}
                          </Button>
                        </div>
                        {!hasActiveParkingPass && (
                          <p className="text-xs text-orange-700">
                            Create a parking pass to manage blackout dates for
                            that pass.
                          </p>
                        )}
                        {blackoutDates.length === 0 ? (
                          <p className="text-xs text-orange-700">
                            No blackout dates set.
                          </p>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {blackoutDates.map((dateKey) => (
                              <button
                                key={dateKey}
                                type="button"
                                onClick={() => handleRemoveBlackout(dateKey)}
                                className="rounded-full border border-[color:var(--status-warning)]/30 bg-orange-50 px-3 py-1 text-xs text-orange-900 hover:bg-orange-100"
                                disabled={
                                  isSavingBlackout ||
                                  dateKey <= format(new Date(), "yyyy-MM-dd")
                                }
                              >
                                {format(new Date(dateKey), "MMM d, yyyy")}{" "}
                                (remove)
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="rounded-xl border border-[color:var(--status-warning)]/30 bg-[var(--bg-surface)] p-4 space-y-4">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <h3 className="text-base font-semibold text-orange-900">
                              Location details
                            </h3>
                            <p className="text-xs text-orange-700">
                              Keep each parking address accurate for trucks.
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              onClick={handleUpdateLocation}
                              disabled={isUpdatingLocation || !pinPosition}
                              size="sm"
                            >
                              {isUpdatingLocation
                                ? "Saving..."
                                : "Save location"}
                            </Button>
                            <Button
                              variant="outline"
                              onClick={handleDeleteLocation}
                              disabled={isDeletingLocation}
                              size="sm"
                            >
                              {isDeletingLocation
                                ? "Deleting..."
                                : "Delete location"}
                            </Button>
                          </div>
                        </div>
                        <div className="grid gap-3 md:grid-cols-2">
                          <div className="space-y-2">
                            <Label htmlFor="hostBusinessName">
                              Location name
                            </Label>
                            <Input
                              id="hostBusinessName"
                              value={host.businessName}
                              onChange={(event) =>
                                setHost((current) =>
                                  current
                                    ? {
                                        ...current,
                                        businessName: event.target.value,
                                      }
                                    : current,
                                )
                              }
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="hostContactPhone">
                              Contact phone
                            </Label>
                            <Input
                              id="hostContactPhone"
                              value={host.contactPhone || ""}
                              onChange={(event) =>
                                setHost((current) =>
                                  current
                                    ? {
                                        ...current,
                                        contactPhone: event.target.value,
                                      }
                                    : current,
                                )
                              }
                            />
                          </div>
                          <div className="space-y-2 md:col-span-2">
                            <Label htmlFor="hostAddress">Address</Label>
                            <Input
                              id="hostAddress"
                              value={host.address}
                              onChange={(event) =>
                                setHost((current) =>
                                  current
                                    ? {
                                        ...current,
                                        address: event.target.value,
                                      }
                                    : current,
                                )
                              }
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="hostCity">City</Label>
                            <Input
                              id="hostCity"
                              value={host.city || ""}
                              onChange={(event) =>
                                setHost((current) =>
                                  current
                                    ? { ...current, city: event.target.value }
                                    : current,
                                )
                              }
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="hostState">State</Label>
                            <Input
                              id="hostState"
                              value={host.state || ""}
                              onChange={(event) =>
                                setHost((current) =>
                                  current
                                    ? { ...current, state: event.target.value }
                                    : current,
                                )
                              }
                            />
                          </div>
                          <div className="space-y-2 md:col-span-2">
                            <Label htmlFor="hostSpotPhoto">Spot photo</Label>
                            {host.spotImageUrl && (
                              <img
                                src={host.spotImageUrl}
                                alt={`${host.businessName} parking spot`}
                                className="h-40 w-full rounded-xl border border-border/60 object-cover"
                                loading="lazy"
                              />
                            )}
                            <input
                              id="hostSpotPhoto"
                              type="file"
                              accept="image/*"
                              className="block w-full text-sm text-slate-700 file:mr-4 file:rounded-md file:border-0 file:bg-orange-100 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-orange-900 hover:file:bg-orange-200"
                              onChange={(event) =>
                                setSpotImageFile(
                                  event.target.files?.[0] ?? null,
                                )
                              }
                            />
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={handleUploadSpotImage}
                                disabled={
                                  !spotImageFile || isUploadingSpotImage
                                }
                              >
                                {isUploadingSpotImage
                                  ? "Uploading..."
                                  : "Upload photo"}
                              </Button>
                              <p className="text-[11px] text-orange-700">
                                Shows when trucks click your spot on the map.
                              </p>
                            </div>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="hostType">Location type</Label>
                            <select
                              id="hostType"
                              value={host.locationType || "other"}
                              onChange={(event) =>
                                setHost((current) =>
                                  current
                                    ? {
                                        ...current,
                                        locationType: event.target.value,
                                      }
                                    : current,
                                )
                              }
                              className="w-full rounded-md border border-[color:var(--status-warning)]/30 bg-[var(--bg-surface)] px-3 py-2 text-sm"
                            >
                              <option value="office">Office</option>
                              <option value="bar">Bar</option>
                              <option value="brewery">Brewery</option>
                              <option value="restaurant">Restaurant</option>
                              <option value="other">Other</option>
                            </select>
                          </div>
                        </div>
                        <div className="rounded-2xl border border-[color:var(--status-warning)]/30 bg-[var(--bg-surface)] p-4 space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <p className="text-sm font-semibold text-orange-900">
                                Pin location
                              </p>
                              <p className="text-xs text-orange-700">
                                Drag the pin or click the map to adjust the
                                exact spot.
                              </p>
                            </div>
                            {addressNeedsPin && (
                              <span className="rounded-full bg-amber-100 px-3 py-1 text-[11px] font-semibold text-amber-700">
                                Address changed - reset the pin
                              </span>
                            )}
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={handleGeocodePin}
                                disabled={isGeocodingPin}
                              >
                                {isGeocodingPin
                                  ? "Setting pin..."
                                  : "Use address"}
                              </Button>
                              <Button
                                size="sm"
                                onClick={handleSavePin}
                                disabled={!pinPosition || isSavingPin}
                              >
                                {isSavingPin ? "Saving pin..." : "Save pin"}
                              </Button>
                            </div>
                          </div>
                          <div className="relative h-64 w-full overflow-hidden rounded-xl border border-[color:var(--status-warning)]/30 bg-orange-100/20">
                            <GoogleMapPicker
                              center={settingsMapCenter}
                              zoom={settingsMapZoom}
                              onMapClick={(point) => setPinPosition(point)}
                              pins={
                                pinPosition
                                  ? [
                                      {
                                        key: "settings-pin",
                                        position: pinPosition,
                                        draggable: true,
                                      } satisfies MapPickerPin,
                                    ]
                                  : []
                              }
                              onPinDrag={(_key, point) => setPinPosition(point)}
                              className="h-full w-full"
                            />
                            {!pinPosition && (
                              <div className="absolute inset-0 flex items-center justify-center text-xs text-orange-700 pointer-events-none">
                                {addressNeedsPin
                                  ? "Address updated. Click the map or use the address button."
                                  : "No pin yet. Click the map or use the address button."}
                              </div>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2 text-xs text-orange-700">
                            <span>
                              Lat:{" "}
                              {pinPosition ? pinPosition.lat.toFixed(6) : "--"}
                            </span>
                            <span>
                              Lng:{" "}
                              {pinPosition ? pinPosition.lng.toFixed(6) : "--"}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-[color:var(--status-warning)]/30 pp-glass-muted p-4 space-y-3">
                        <p className="text-sm font-semibold text-orange-900">
                          Add another parking location
                        </p>
                        <div className="grid gap-3 md:grid-cols-2">
                          <div className="space-y-2">
                            <Label htmlFor="newHostName">Location name</Label>
                            <Input
                              id="newHostName"
                              value={newLocationForm.businessName}
                              onChange={(event) =>
                                setNewLocationForm((current) => ({
                                  ...current,
                                  businessName: event.target.value,
                                }))
                              }
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="newHostPhone">Contact phone</Label>
                            <Input
                              id="newHostPhone"
                              value={newLocationForm.contactPhone}
                              onChange={(event) =>
                                setNewLocationForm((current) => ({
                                  ...current,
                                  contactPhone: event.target.value,
                                }))
                              }
                            />
                          </div>
                          <div className="space-y-2 md:col-span-2">
                            <Label htmlFor="newHostAddress">Address</Label>
                            <PlaceAutocompleteInput
                              id="newHostAddress"
                              value={newLocationForm.address}
                              onChange={(value) =>
                                setNewLocationForm((current) => ({
                                  ...current,
                                  address: value,
                                }))
                              }
                              onSelect={handleNewLocationAddressSelect}
                              placeholder="123 Main St, City, State"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="newHostCity">City</Label>
                            <Input
                              id="newHostCity"
                              value={newLocationForm.city}
                              onChange={(event) =>
                                setNewLocationForm((current) => ({
                                  ...current,
                                  city: event.target.value,
                                }))
                              }
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="newHostState">State</Label>
                            <Input
                              id="newHostState"
                              value={newLocationForm.state}
                              onChange={(event) =>
                                setNewLocationForm((current) => ({
                                  ...current,
                                  state: event.target.value,
                                }))
                              }
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="newHostType">Location type</Label>
                            <select
                              id="newHostType"
                              value={newLocationForm.locationType}
                              onChange={(event) =>
                                setNewLocationForm((current) => ({
                                  ...current,
                                  locationType: event.target.value,
                                }))
                              }
                              className="w-full rounded-md border border-[color:var(--status-warning)]/30 bg-[var(--bg-surface)] px-3 py-2 text-sm"
                            >
                              <option value="office">Office</option>
                              <option value="bar">Bar</option>
                              <option value="brewery">Brewery</option>
                              <option value="restaurant">Restaurant</option>
                              <option value="other">Other</option>
                            </select>
                          </div>
                          <div className="flex items-end">
                            <Button
                              variant="outline"
                              onClick={handleCreateLocation}
                              disabled={
                                isSavingLocation || !newLocationPinPosition
                              }
                              size="sm"
                            >
                              {isSavingLocation ? "Saving..." : "Add location"}
                            </Button>
                          </div>
                        </div>
                        <div className="mt-4 rounded-xl border border-[color:var(--status-warning)]/30 bg-[var(--bg-surface)] p-3 space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <p className="text-xs font-semibold text-orange-900">
                                Pin preview
                              </p>
                              <p className="text-[11px] text-orange-700">
                                Pin required before adding a new location.
                              </p>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={handleGeocodeNewLocationPin}
                              disabled={isGeocodingNewPin}
                            >
                              {isGeocodingNewPin
                                ? "Setting pin..."
                                : "Use address"}
                            </Button>
                          </div>
                          <div className="relative h-56 w-full overflow-hidden rounded-lg border border-[color:var(--status-warning)]/30 bg-orange-100/20">
                            <GoogleMapPicker
                              center={newLocationMapCenter}
                              zoom={newLocationMapZoom}
                              onMapClick={(point) =>
                                setNewLocationPinPosition(point)
                              }
                              pins={
                                newLocationPinPosition
                                  ? [
                                      {
                                        key: "new-location-pin",
                                        position: newLocationPinPosition,
                                        draggable: true,
                                      } satisfies MapPickerPin,
                                    ]
                                  : []
                              }
                              onPinDrag={(_key, point) =>
                                setNewLocationPinPosition(point)
                              }
                              className="h-full w-full"
                            />
                            {!newLocationPinPosition && (
                              <div className="absolute inset-0 flex items-center justify-center text-xs text-orange-700 pointer-events-none">
                                Click the map or use the address to set a pin.
                              </div>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2 text-xs text-orange-700">
                            <span>
                              Lat:{" "}
                              {newLocationPinPosition
                                ? newLocationPinPosition.lat.toFixed(6)
                                : "--"}
                            </span>
                            <span>
                              Lng:{" "}
                              {newLocationPinPosition
                                ? newLocationPinPosition.lng.toFixed(6)
                                : "--"}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-xl border border-[color:var(--status-warning)]/30 bg-[var(--bg-surface)] p-4 space-y-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <h3 className="text-base font-semibold text-orange-900">
                            On-site amenities
                          </h3>
                          <p className="text-xs text-orange-700">
                            Share what trucks can expect at your location.
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleAmenitiesSave}
                          disabled={isSavingAmenities}
                        >
                          {isSavingAmenities ? "Saving..." : "Save amenities"}
                        </Button>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {[
                          { key: "water", label: "Water" },
                          { key: "electric", label: "Electric" },
                          { key: "bathrooms", label: "Bathrooms" },
                          { key: "wifi", label: "Wi-Fi" },
                          { key: "seating", label: "Seating" },
                        ].map((amenity) => (
                          <label
                            key={amenity.key}
                            className="flex items-center gap-2 text-sm text-orange-900"
                          >
                            <input
                              type="checkbox"
                              className="h-4 w-4"
                              checked={amenities[amenity.key] ?? false}
                              onChange={(event) =>
                                setAmenities((prev) => ({
                                  ...prev,
                                  [amenity.key]: event.target.checked,
                                }))
                              }
                            />
                            {amenity.label}
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

          {topTab === "host" &&
            hostToolsTab === "listings" &&
            showHostParkingPass &&
            host && (
              <>
                {isCreating && (
                  <div className="bg-[var(--bg-surface)] p-6 rounded-2xl border border-[color:var(--status-warning)]/30 shadow-clean">
                    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                      <div>
                        <h2 className="text-2xl font-semibold text-slate-900">
                          Post a Parking Pass
                        </h2>
                        <p className="text-sm text-slate-500">
                          Set parking hours and what each slot costs.
                        </p>
                      </div>
                      <div className="rounded-full border border-[var(--border-subtle)] px-3 py-1 text-xs text-[color:var(--text-muted)]">
                        {host.businessName}
                      </div>
                    </div>
                    <form
                      onSubmit={handleCreatePass}
                      className="mt-6 space-y-6"
                    >
                      {createError && (
                        <div className="p-3 bg-rose-50 text-rose-700 rounded-md text-sm">
                          {createError}
                        </div>
                      )}
                      {hasActiveHostPass && (
                        <div className="p-3 bg-amber-50 text-amber-700 rounded-md text-sm">
                          You already have a parking pass for this address. Edit
                          the existing listing instead of creating a new one.
                        </div>
                      )}

                      <div className="grid gap-4 md:grid-cols-[1.2fr_1fr]">
                        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/70 p-4">
                          <div className="flex items-center justify-between mb-4">
                            <div>
                              <h3 className="text-base font-semibold text-slate-900">
                                When trucks can park
                              </h3>
                              <p className="text-xs text-slate-500">
                                Pick the days and parking hours (or choose Any
                                time).
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Switch
                                id="anyTime"
                                checked={anyTime}
                                onCheckedChange={setAnyTime}
                              />
                              <Label
                                htmlFor="anyTime"
                                className="text-xs text-[color:var(--text-muted)]"
                              >
                                Any time
                              </Label>
                            </div>
                          </div>
                          <div className="grid gap-3 md:grid-cols-2">
                            <div className="space-y-2">
                              <Label>Days of the week</Label>
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                {[
                                  { label: "Mon", value: 1 },
                                  { label: "Tue", value: 2 },
                                  { label: "Wed", value: 3 },
                                  { label: "Thu", value: 4 },
                                  { label: "Fri", value: 5 },
                                  { label: "Sat", value: 6 },
                                  { label: "Sun", value: 0 },
                                ].map((day) => {
                                  const selected = daysOfWeek.includes(
                                    day.value,
                                  );
                                  return (
                                    <button
                                      key={day.value}
                                      type="button"
                                      className={`rounded-md border px-3 py-2 text-xs font-medium transition ${
                                        selected
                                          ? "border-orange-300 bg-orange-100 text-orange-900"
                                          : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[color:var(--text-muted)] hover:bg-[var(--bg-surface)]"
                                      }`}
                                      onClick={() =>
                                        setDaysOfWeek((current) =>
                                          current.includes(day.value)
                                            ? current.filter(
                                                (item) => item !== day.value,
                                              )
                                            : [...current, day.value],
                                        )
                                      }
                                    >
                                      {day.label}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="maxTrucks">Number of spots</Label>
                              <Input
                                id="maxTrucks"
                                type="number"
                                min="1"
                                max="10"
                                value={maxTrucks}
                                onChange={(event) =>
                                  setMaxTrucks(Number(event.target.value))
                                }
                                required
                              />
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="startTime">Start</Label>
                              <Input
                                id="startTime"
                                type="time"
                                value={startTime}
                                onChange={(event) =>
                                  setStartTime(event.target.value)
                                }
                                disabled={anyTime}
                                required
                              />
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="endTime">End</Label>
                              <Input
                                id="endTime"
                                type="time"
                                value={endTime}
                                onChange={(event) =>
                                  setEndTime(event.target.value)
                                }
                                disabled={anyTime}
                                required
                              />
                            </div>
                          </div>
                          {anyTime && (
                            <p className="mt-3 text-xs text-slate-500">
                              Any time means trucks can park 24/7.
                            </p>
                          )}
                        </div>

                        <div className="rounded-xl border border-[color:var(--status-warning)]/30 bg-orange-50/60 p-4">
                          <h3 className="text-base font-semibold text-orange-900">
                            Price preview
                          </h3>
                          <p className="text-xs text-orange-700 mb-4">
                            Daily = slot total + $10. Weekly = (slot total x 7)
                            + $70. Monthly = (slot total x 30) + $300.
                          </p>
                          <div className="space-y-2 text-sm text-orange-900">
                            <div className="flex items-center justify-between">
                              <span>Slot total</span>
                              <span className="font-semibold">
                                {slotSum ? `$${slotSum.toFixed(2)}` : "-"}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span>Daily</span>
                              <span className="font-semibold">
                                {dailyEstimate
                                  ? `$${dailyEstimate.toFixed(2)}`
                                  : "-"}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span>
                                Weekly{" "}
                                {weeklyOverrideValue !== null
                                  ? "(custom)"
                                  : "(auto)"}
                              </span>
                              <span className="font-semibold">
                                {weeklyFinal
                                  ? `$${weeklyFinal.toFixed(2)}`
                                  : "-"}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span>
                                Monthly{" "}
                                {monthlyOverrideValue !== null
                                  ? "(custom)"
                                  : "(auto)"}
                              </span>
                              <span className="font-semibold">
                                {monthlyFinal
                                  ? `$${monthlyFinal.toFixed(2)}`
                                  : "-"}
                              </span>
                            </div>
                          </div>
                          <p className="mt-4 text-xs text-[color:var(--status-warning)]">
                            Trucks see your price plus the MealScout fee.
                          </p>
                        </div>
                      </div>

                      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
                        <h3 className="text-base font-semibold text-slate-900 mb-2">
                          Set slot pricing
                        </h3>
                        <p className="text-xs text-slate-500 mb-4">
                          Set any slot to $0 if you don't want to offer it.
                        </p>
                        <div className="grid gap-4 md:grid-cols-3">
                          <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 space-y-2">
                            <Label htmlFor="breakfastPrice">Breakfast</Label>
                            <Input
                              id="breakfastPrice"
                              type="number"
                              min="0"
                              step="1"
                              inputMode="numeric"
                              value={breakfastPrice}
                              onChange={(event) =>
                                setBreakfastPrice(event.target.value)
                              }
                              placeholder="0"
                            />
                            <p className="text-xs text-slate-500">
                              Early shift pricing.
                            </p>
                          </div>
                          <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 space-y-2">
                            <Label htmlFor="lunchPrice">Lunch</Label>
                            <Input
                              id="lunchPrice"
                              type="number"
                              min="0"
                              step="1"
                              inputMode="numeric"
                              value={lunchPrice}
                              onChange={(event) =>
                                setLunchPrice(event.target.value)
                              }
                              placeholder="0"
                            />
                            <p className="text-xs text-slate-500">
                              Peak traffic slot.
                            </p>
                          </div>
                          <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 space-y-2">
                            <Label htmlFor="dinnerPrice">Dinner</Label>
                            <Input
                              id="dinnerPrice"
                              type="number"
                              min="0"
                              step="1"
                              inputMode="numeric"
                              value={dinnerPrice}
                              onChange={(event) =>
                                setDinnerPrice(event.target.value)
                              }
                              placeholder="0"
                            />
                            <p className="text-xs text-slate-500">
                              Evening coverage.
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
                        <h3 className="text-base font-semibold text-slate-900 mb-2">
                          Weekly & monthly rates (optional)
                        </h3>
                        <p className="text-xs text-slate-500 mb-4">
                          Leave blank to use the auto-calculated weekly and
                          monthly totals.
                        </p>
                        <div className="grid gap-4 md:grid-cols-2">
                          <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 space-y-2">
                            <Label htmlFor="weeklyOverride">Weekly rate</Label>
                            <Input
                              id="weeklyOverride"
                              type="number"
                              min="0"
                              step="1"
                              inputMode="numeric"
                              value={weeklyOverride}
                              onChange={(event) =>
                                setWeeklyOverride(event.target.value)
                              }
                              placeholder={
                                weeklyHostEstimate
                                  ? `$${weeklyHostEstimate.toFixed(0)}`
                                  : "Auto"
                              }
                            />
                            <p className="text-xs text-slate-500">
                              Auto weekly:{" "}
                              {weeklyHostEstimate
                                ? `$${weeklyHostEstimate.toFixed(0)}`
                                : "—"}
                            </p>
                          </div>
                          <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 space-y-2">
                            <Label htmlFor="monthlyOverride">
                              Monthly rate
                            </Label>
                            <Input
                              id="monthlyOverride"
                              type="number"
                              min="0"
                              step="1"
                              inputMode="numeric"
                              value={monthlyOverride}
                              onChange={(event) =>
                                setMonthlyOverride(event.target.value)
                              }
                              placeholder={
                                monthlyHostEstimate
                                  ? `$${monthlyHostEstimate.toFixed(0)}`
                                  : "Auto"
                              }
                            />
                            <p className="text-xs text-slate-500">
                              Auto monthly:{" "}
                              {monthlyHostEstimate
                                ? `$${monthlyHostEstimate.toFixed(0)}`
                                : "—"}
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
                        <p className="text-sm font-semibold text-slate-900">
                          {maxTrucks} truck{" "}
                          {maxTrucks === 1 ? "spot" : "spots"} available per
                          time slot
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          Booking closes automatically when every spot is
                          reserved.
                        </p>
                      </div>

                      <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-xs text-slate-500">
                          You can edit times later if plans change.
                        </p>
                        <Button
                          type="submit"
                          className="w-full px-6 sm:w-auto"
                          disabled={hasActiveHostPass}
                        >
                          Publish Parking Pass
                        </Button>
                      </div>
                    </form>
                  </div>
                )}

                <div className="space-y-6">
                  <Tabs defaultValue="upcoming" className="w-full">
                    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <h2 className="text-xl font-semibold text-slate-900">
                        Your Parking Pass Listings
                      </h2>
                      <TabsList className="w-full sm:w-auto">
                        <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
                        <TabsTrigger value="past">Past</TabsTrigger>
                      </TabsList>
                    </div>

                    <TabsContent value="upcoming" className="space-y-4">
                      {upcomingListings.length === 0 ? (
                        <div className="text-center py-12 bg-[var(--bg-surface)] rounded-xl border border-dashed border-slate-300">
                          <Calendar className="mx-auto h-12 w-12 text-slate-300 mb-3" />
                          <h3 className="text-lg font-medium text-slate-900">
                            No upcoming parking pass listings
                          </h3>
                          <p className="text-slate-500 mb-4">
                            Create a parking pass listing for trucks.
                          </p>
                          <Button
                            variant="outline"
                            onClick={() => setIsCreating(true)}
                          >
                            Create Parking Pass Listing
                          </Button>
                        </div>
                      ) : (
                        <div className="grid gap-4">
                          {upcomingListings.map((listing) => (
                            <div
                              key={listing.id}
                              className="bg-[var(--bg-surface)] p-6 rounded-xl border border-[var(--border-subtle)] shadow-clean flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
                            >
                              <div className="flex items-start gap-4 sm:items-center sm:gap-6">
                                <div className="flex flex-col items-center justify-center w-16 h-16 bg-rose-50 rounded-lg text-rose-700">
                                  <span className="text-xs font-bold uppercase">
                                    {format(new Date(listing.date), "MMM")}
                                  </span>
                                  <span className="text-2xl font-bold">
                                    {format(new Date(listing.date), "d")}
                                  </span>
                                </div>

                                <div>
                                  <div className="mb-1 flex flex-wrap items-center gap-2 sm:gap-4 text-sm text-[color:var(--text-muted)]">
                                    <span className="flex items-center gap-1">
                                      <Clock className="h-4 w-4" />
                                      {listing.startTime === "00:00" &&
                                      listing.endTime === "23:59"
                                        ? "Any time"
                                        : `${listing.startTime} - ${listing.endTime}`}
                                    </span>
                                    <span className="flex items-center gap-1">
                                      <Truck className="h-4 w-4" />
                                      {listing.maxTrucks} Spot
                                      {listing.maxTrucks !== 1 ? "s" : ""}
                                    </span>
                                    {listing.requiresPayment && (
                                      <span className="text-xs text-orange-700 bg-orange-50 border border-[color:var(--status-warning)]/30 rounded-full px-2 py-0.5">
                                        Daily{" "}
                                        {formatCents(listing.dailyPriceCents)} /
                                        Weekly{" "}
                                        {formatCents(listing.weeklyPriceCents)}{" "}
                                        / Monthly{" "}
                                        {formatCents(listing.monthlyPriceCents)}
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2 mt-2">
                                    <span
                                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                        listing.status === "open"
                                          ? "bg-emerald-100 text-emerald-800"
                                          : listing.status === "filled"
                                            ? "bg-[color:var(--accent-text)]/12 text-[color:var(--accent-text)]"
                                            : "bg-slate-100 text-slate-800"
                                      }`}
                                    >
                                      {listing.status.charAt(0).toUpperCase() +
                                        listing.status.slice(1)}
                                    </span>
                                  </div>
                                  {Array.isArray(listing.qualityFlags) &&
                                    listing.qualityFlags.length > 0 && (
                                      <div className="mt-2 text-xs text-amber-800">
                                        Needs fixes:{" "}
                                        {listing.qualityFlags.join(", ")}
                                      </div>
                                    )}
                                </div>
                              </div>

                              <div className="flex w-full items-center gap-2 sm:w-auto">
                                <Badge variant="secondary">Listing</Badge>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="ml-auto sm:ml-0"
                                  onClick={() => {
                                    setEditHostListing(listing);
                                    setEditHostListingOpen(true);
                                  }}
                                >
                                  Edit
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </TabsContent>

                    <TabsContent value="past" className="space-y-4">
                      {pastListings.length === 0 ? (
                        <div className="text-center py-12 bg-[var(--bg-surface)] rounded-xl border border-dashed border-slate-300">
                          <Clock className="mx-auto h-12 w-12 text-slate-300 mb-3" />
                          <h3 className="text-lg font-medium text-slate-900">
                            No past parking pass listings
                          </h3>
                          <p className="text-slate-500">
                            Your parking pass history will appear here.
                          </p>
                        </div>
                      ) : (
                        <div className="grid gap-4 opacity-75">
                          {pastListings.map((listing) => (
                            <div
                              key={listing.id}
                              className="bg-[var(--bg-surface)] p-6 rounded-xl border border-[var(--border-subtle)] flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
                            >
                              <div className="flex items-start gap-4 sm:items-center sm:gap-6">
                                <div className="flex flex-col items-center justify-center w-16 h-16 bg-slate-200 rounded-lg text-[color:var(--text-muted)]">
                                  <span className="text-xs font-bold uppercase">
                                    {format(new Date(listing.date), "MMM")}
                                  </span>
                                  <span className="text-2xl font-bold">
                                    {format(new Date(listing.date), "d")}
                                  </span>
                                </div>

                                <div>
                                  <div className="mb-1 flex flex-wrap items-center gap-2 sm:gap-4 text-sm text-slate-500">
                                    <span className="flex items-center gap-1">
                                      <Clock className="h-4 w-4" />
                                      {listing.startTime} - {listing.endTime}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2 mt-2">
                                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-200 text-[color:var(--text-muted)]">
                                      Completed
                                    </span>
                                  </div>
                                </div>
                              </div>

                              <Button
                                variant="ghost"
                                size="sm"
                                className="w-full sm:w-auto"
                                disabled
                              >
                                Archived
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </TabsContent>
                  </Tabs>
                </div>

                <EditOccurrenceDialog
                  event={editHostListing}
                  seriesName={
                    host ? `Parking Pass - ${host.businessName}` : undefined
                  }
                  open={editHostListingOpen}
                  onOpenChange={(open) => {
                    setEditHostListingOpen(open);
                    if (!open) {
                      setEditHostListing(null);
                    }
                  }}
                  onEventUpdated={() => {
                    if (selectedHostId) {
                      void reloadHostPassListings(selectedHostId);
                    }
                  }}
                />
              </>
            )}

          {topTab === "schedule" && isTruckViewUser && (
            <Card className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
              <CardContent className="p-5 space-y-4">
                {!canManageParkingPass && (
                  <div className="rounded-xl border border-[color:var(--accent-text)]/25 bg-[color:var(--accent-text)]/8 p-4 text-sm text-[color:var(--text-secondary)]">
                    Ask the business owner to grant schedule and profile
                    permissions for this truck.
                  </div>
                )}
                {hasProfileTruckTools && !canManageTruckProfile && (
                  <div className="rounded-xl border border-[color:var(--status-warning)]/30 bg-amber-50 p-4 text-sm text-amber-900">
                    You can manage Parking Pass bookings and schedules, but live
                    location and social/profile settings require profile access.
                  </div>
                )}
                {preOpenPrompt && hasProfileTruckTools && canManageTruckProfile && (
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-semibold text-emerald-950">
                          {preOpenPrompt.locationName}
                        </p>
                        <p className="text-xs text-emerald-800">
                          {preOpenPrompt.dateLabel} · {preOpenPrompt.timeLabel}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={handleShareUpcomingStop}
                          disabled={!truckId}
                        >
                          Share stop
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleShareLocation}
                          disabled={isSharingLocation || isLive || !truckId}
                        >
                          Go live
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setDismissedPreOpenPromptKey(preOpenPrompt.key)
                          }
                        >
                          Later
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      Live share
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Share your live location and open a social handoff.
                    </p>
                  </div>
                  {!isLive && (
                    <div className="flex items-center gap-2 rounded-full border border-[color:var(--border-subtle)] bg-[var(--bg-card)] px-3 py-1.5">
                      <Label
                        htmlFor="live-leave-time"
                        className="text-xs text-muted-foreground"
                      >
                        Leaving
                      </Label>
                      <Input
                        id="live-leave-time"
                        type="time"
                        value={liveLeaveTime}
                        onChange={(event) =>
                          setLiveLeaveTime(event.target.value)
                        }
                        className="h-7 w-[92px] rounded-full border-0 bg-transparent p-0 text-xs"
                      />
                    </div>
                  )}
                  <Button
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={handleShareLocation}
                    disabled={
                      isSharingLocation ||
                      !truckId ||
                      !hasProfileTruckTools ||
                      !canManageTruckProfile
                    }
                  >
                    <Share2 className="h-4 w-4 mr-1" />
                    {isSharingLocation
                      ? "Working..."
                      : isLive
                        ? "Go offline"
                        : "Go live + share"}
                  </Button>
                </div>
                {(truck?.instagramUrl ||
                  truck?.facebookPageUrl ||
                  truck?.xUrl) && (
                  <div className="flex flex-wrap gap-2">
                    {truck?.instagramUrl && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          window.open(truck.instagramUrl, "_blank")
                        }
                      >
                        Open Instagram
                      </Button>
                    )}
                    {truck?.facebookPageUrl && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          window.open(truck.facebookPageUrl, "_blank")
                        }
                      >
                        Open Facebook
                      </Button>
                    )}
                    {truck?.xUrl && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => window.open(truck.xUrl, "_blank")}
                      >
                        Open X
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {topTab === "schedule" && isTruckViewUser && (
            <Card className="rounded-2xl pp-glass shadow-clean">
              <CardContent className="p-5 space-y-6">
                <div>
                  <p className="text-sm font-semibold text-[color:var(--text-primary)]">
                    Social share prompts
                  </p>
                  <p className="text-xs text-[color:var(--text-muted)]">
                    Link your socials and choose which updates should open a
                    share prompt.
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="social-facebook">Facebook URL</Label>
                    <Input
                      id="social-facebook"
                      className="pp-field"
                      placeholder="https://facebook.com/yourpage"
                      value={socialLinks.facebookPageUrl}
                      disabled={!hasProfileTruckTools || !canManageTruckProfile}
                      onChange={(event) =>
                        setSocialLinks((current) => ({
                          ...current,
                          facebookPageUrl: event.target.value,
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="social-instagram">Instagram URL</Label>
                    <Input
                      id="social-instagram"
                      className="pp-field"
                      placeholder="https://instagram.com/yourtruck"
                      value={socialLinks.instagramUrl}
                      disabled={!hasProfileTruckTools || !canManageTruckProfile}
                      onChange={(event) =>
                        setSocialLinks((current) => ({
                          ...current,
                          instagramUrl: event.target.value,
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="social-x">X URL</Label>
                    <Input
                      id="social-x"
                      className="pp-field"
                      placeholder="https://x.com/yourtruck"
                      value={socialLinks.xUrl}
                      disabled={!hasProfileTruckTools || !canManageTruckProfile}
                      onChange={(event) =>
                        setSocialLinks((current) => ({
                          ...current,
                          xUrl: event.target.value,
                        }))
                      }
                    />
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-xl pp-glass-muted p-4 space-y-3">
                    <p className="text-xs font-semibold text-slate-700">
                      Platforms
                    </p>
                    {(
                      [
                        { key: "facebook", label: "Facebook" },
                        { key: "instagram", label: "Instagram" },
                        { key: "x", label: "X" },
                      ] as const
                    ).map((platform) => (
                      <div
                        key={platform.key}
                        className="flex items-center justify-between text-sm"
                      >
                        <span>{platform.label}</span>
                        <Switch
                          checked={socialSettings.platforms[platform.key]}
                          disabled={
                            !hasProfileTruckTools || !canManageTruckProfile
                          }
                          onCheckedChange={(checked) =>
                            setSocialSettings((current) => ({
                              ...current,
                              platforms: {
                                ...current.platforms,
                                [platform.key]: checked,
                              },
                            }))
                          }
                        />
                      </div>
                    ))}
                  </div>
                  <div className="rounded-xl pp-glass-muted p-4 space-y-3">
                    <p className="text-xs font-semibold text-slate-700">
                      Share prompts
                    </p>
                    {(
                      [
                        { key: "schedule", label: "Schedule updates" },
                        { key: "booking", label: "Parking pass bookings" },
                        { key: "live", label: "Go live" },
                        { key: "deal", label: "New deals" },
                      ] as const
                    ).map((trigger) => (
                      <div
                        key={trigger.key}
                        className="flex items-center justify-between text-sm"
                      >
                        <span>{trigger.label}</span>
                        <Switch
                          checked={socialSettings.triggers[trigger.key]}
                          disabled={
                            !hasProfileTruckTools || !canManageTruckProfile
                          }
                          onCheckedChange={(checked) =>
                            setSocialSettings((current) => ({
                              ...current,
                              triggers: {
                                ...current.triggers,
                                [trigger.key]: checked,
                              },
                            }))
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl pp-glass-muted p-4 space-y-2">
                  <p className="text-xs font-semibold text-slate-700">
                    Publishing connections
                  </p>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {(
                      [
                        { key: "facebook", label: "Facebook" },
                        { key: "instagram", label: "Instagram" },
                        { key: "x", label: "X" },
                      ] as const
                    ).map((platform) => {
                      const connection = socialConnectionByPlatform.get(
                        platform.key,
                      );
                      const providerReady =
                        socialPublishingConfig?.platforms?.[platform.key]
                          ?.configured !== false;
                      return (
                        <div
                          key={platform.key}
                          className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2 text-xs"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span>{platform.label}</span>
                            <Badge
                              variant={connection?.connected ? "default" : "outline"}
                            >
                              {!providerReady
                                ? "Setup"
                                : connection?.connected
                                  ? "Connected"
                                  : "Manual"}
                            </Badge>
                          </div>
                          <p className="mt-1 truncate text-[color:var(--text-muted)]">
                            {!providerReady
                              ? "Setup needed"
                              : connection?.connected
                              ? connection.displayName ||
                                connection.externalAccountUrl ||
                                "Ready to publish"
                              : "Opens share handoff"}
                          </p>
                          {connection?.lastError && (
                            <p className="mt-1 line-clamp-2 text-red-700">
                              {connection.lastError}
                            </p>
                          )}
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              disabled={
                                !hasProfileTruckTools ||
                                !canManageTruckProfile ||
                                !providerReady
                              }
                              onClick={() =>
                                handleConnectSocialPlatform(platform.key)
                              }
                            >
                              {connection?.connected
                                ? "Reconnect"
                                : providerReady
                                  ? "Connect"
                                  : "Setup"}
                            </Button>
                            {connection?.connected && (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs text-red-700 hover:text-red-800"
                                disabled={
                                  !hasProfileTruckTools ||
                                  !canManageTruckProfile
                                }
                                onClick={() =>
                                  handleDisconnectSocialPlatform(platform.key)
                                }
                              >
                                Disconnect
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs text-slate-700">
                    <Switch
                      checked={socialSettings.promptBeforePost}
                      disabled={!hasProfileTruckTools || !canManageTruckProfile}
                      onCheckedChange={(checked) =>
                        setSocialSettings((current) => ({
                          ...current,
                          promptBeforePost: checked,
                        }))
                      }
                    />
                    <span>Always prompt before sharing</span>
                  </div>
                  <Button
                    size="sm"
                    onClick={handleSaveSocialSettings}
                    disabled={
                      isSavingSocialSettings ||
                      !hasProfileTruckTools ||
                      !canManageTruckProfile
                    }
                  >
                    {isSavingSocialSettings ? "Saving..." : "Save settings"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {topTab === "schedule" && isTruckViewUser && (
            <Card className="order-[-9998] rounded-2xl pp-glass border border-[color:var(--border-subtle)]">
              <CardContent className="p-5 space-y-6">
                <section aria-label="Booked stops status" className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] p-4 space-y-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div role="status" aria-live="polite">
                      <p className="text-sm font-semibold">{!truckId ? "Choose a truck to view booked stops" : bookingSchedule.loading ? "Checking booked stops…" : bookingSchedule.error ? "Booked stops need verification" : "Bookings up to date"}</p>
                      {bookingSchedule.updatedAt ? <p className="text-xs text-[color:var(--text-muted)]">Last checked {new Date(bookingSchedule.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</p> : null}
                    </div>
                    <Button type="button" variant="outline" disabled={bookingSchedule.loading || !truckId} onClick={() => void bookingSchedule.refresh()}>{bookingSchedule.loading ? "Checking bookings…" : bookingSchedule.error ? "Retry booked stops" : "Refresh bookings"}</Button>
                  </div>
                  {bookingSchedule.error ? <div role="alert" className="space-y-1 text-sm"><p>{bookingSchedule.error}</p><p>{bookingSchedule.updatedAt ? "Last-known booked stops remain visible and may have changed. Refresh before cancelling a booking." : "We cannot confirm whether you have booked stops. This is not an empty-schedule confirmation."}</p></div> : null}
                </section>
                <ParkingScheduleCalendar
                  initialDate={scheduleInitialDate}
                  onDateChange={(date) => {
                    const params = new URLSearchParams(window.location.search);
                    params.set("date", date);
                    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params}${window.location.hash}`);
                  }}
                  bookingsState={bookingSchedule.error ? "unavailable" : bookingSchedule.loading ? "loading" : "ready"}
                  bookingActionsDisabled={bookingSchedule.loading || Boolean(bookingSchedule.error)}
                  items={parkingScheduleItems}
                  allowManualEdits={hasProfileTruckTools}
                  onDeleteManual={handleDeleteSchedule}
                  onCancelBooking={handleCancelBooking}
                  cancelingBookingId={cancelingBookingId}
                  reportLookup={reportLookup}
                  onAddReport={handleOpenReport}
                />
                <p className="text-xs text-[color:var(--text-muted)]">
                  Every booking includes a 30-minute cleanup window after the
                  end time.
                </p>

                <div className="rounded-2xl border border-[color:var(--border-subtle)] pp-glass-muted p-4 space-y-4">
                  <div>
                    <p className="text-sm font-semibold text-[color:var(--text-primary)]">
                      Add manual stop
                    </p>
                    <p className="text-xs text-[color:var(--text-muted)]">
                      Share where you will be parked even if it isn’t a Parking
                      Pass location.
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="schedule-date">Date</Label>
                      <Input
                        id="schedule-date"
                        type="date"
                        value={scheduleForm.date}
                        disabled={!hasProfileTruckTools}
                        onChange={(event) =>
                          handleScheduleFieldChange("date", event.target.value)
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="schedule-location">Location name</Label>
                      <Input
                        id="schedule-location"
                        placeholder="Downtown plaza"
                        value={scheduleForm.locationName}
                        disabled={!hasProfileTruckTools}
                        onChange={(event) =>
                          handleScheduleFieldChange(
                            "locationName",
                            event.target.value,
                          )
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="schedule-start">Start time</Label>
                      <Input
                        id="schedule-start"
                        type="time"
                        value={scheduleForm.startTime}
                        disabled={!hasProfileTruckTools}
                        onChange={(event) =>
                          handleScheduleFieldChange(
                            "startTime",
                            event.target.value,
                          )
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="schedule-end">End time</Label>
                      <Input
                        id="schedule-end"
                        type="time"
                        value={scheduleForm.endTime}
                        disabled={!hasProfileTruckTools}
                        onChange={(event) =>
                          handleScheduleFieldChange(
                            "endTime",
                            event.target.value,
                          )
                        }
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="schedule-address">Address</Label>
                    <PlaceAutocompleteInput
                      id="schedule-address"
                      placeholder="123 Main St, City"
                      value={scheduleForm.address}
                      disabled={!hasProfileTruckTools}
                      onChange={(value) =>
                        handleScheduleFieldChange("address", value)
                      }
                      onSelect={handleScheduleAddressSelect}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="schedule-city">City *</Label>
                      <Input
                        id="schedule-city"
                        placeholder="City"
                        value={scheduleForm.city}
                        required
                        disabled={!hasProfileTruckTools}
                        onChange={(event) =>
                          handleScheduleFieldChange("city", event.target.value)
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="schedule-state">State *</Label>
                      <Input
                        id="schedule-state"
                        placeholder="State"
                        value={scheduleForm.state}
                        required
                        disabled={!hasProfileTruckTools}
                        onChange={(event) =>
                          handleScheduleFieldChange("state", event.target.value)
                        }
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="schedule-notes">Notes</Label>
                    <Textarea
                      id="schedule-notes"
                      placeholder="Optional notes for this stop."
                      value={scheduleForm.notes}
                      disabled={!hasProfileTruckTools}
                      onChange={(event) =>
                        handleScheduleFieldChange("notes", event.target.value)
                      }
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 text-xs text-[color:var(--text-muted)]">
                      <input
                        type="checkbox"
                        checked={scheduleForm.isPublic}
                        disabled={!hasProfileTruckTools}
                        onChange={(event) =>
                          handleScheduleFieldChange(
                            "isPublic",
                            event.target.checked,
                          )
                        }
                      />
                      Show on public profile
                    </label>
                    <Button
                      size="sm"
                      onClick={handleCreateSchedule}
                      disabled={isSavingSchedule || !hasProfileTruckTools}
                    >
                      {isSavingSchedule ? "Saving..." : "Add stop"}
                    </Button>
                  </div>
                </div>
                <Dialog
                  open={!!reportDraft}
                  onOpenChange={(open) => {
                    if (!open) setReportDraft(null);
                  }}
                >
                  <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                      <DialogTitle>Day report</DialogTitle>
                      <DialogDescription>
                        Optional but powerful. This helps us keep locations
                        clean, reward great hosts, and back you up if issues
                        happen.
                      </DialogDescription>
                    </DialogHeader>
                    {reportDraft && (
                      <div className="space-y-4">
                        <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 text-xs text-[color:var(--text-muted)]">
                          <p className="font-semibold text-[color:var(--text-primary)]">
                            {reportDraft.locationName || "Parking stop"}
                          </p>
                          <p className="text-[color:var(--text-muted)]">
                            {[
                              reportDraft.address,
                              reportDraft.city,
                              reportDraft.state,
                            ]
                              .filter(Boolean)
                              .join(", ")}
                          </p>
                          <p className="text-[color:var(--text-muted)]">
                            {reportDraft.date}
                          </p>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-2">
                            <Label>Stop score (0-100)</Label>
                            <Input
                              type="number"
                              min={0}
                              max={100}
                              value={reportDraft.rating || ""}
                              onChange={(event) =>
                                handleReportFieldChange(
                                  "rating",
                                  event.target.value,
                                )
                              }
                              placeholder="Optional"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Arrival cleanliness (0-100)</Label>
                            <Input
                              type="number"
                              min={0}
                              max={100}
                              value={reportDraft.arrivalCleanliness || ""}
                              onChange={(event) =>
                                handleReportFieldChange(
                                  "arrivalCleanliness",
                                  event.target.value,
                                )
                              }
                              placeholder="Optional"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Customers served</Label>
                            <Input
                              type="number"
                              min={0}
                              value={reportDraft.customersServed || ""}
                              onChange={(event) =>
                                handleReportFieldChange(
                                  "customersServed",
                                  event.target.value,
                                )
                              }
                              placeholder="Optional"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Sales total ($)</Label>
                            <Input
                              type="number"
                              min={0}
                              step="0.01"
                              value={reportDraft.salesDollars || ""}
                              onChange={(event) =>
                                handleReportFieldChange(
                                  "salesDollars",
                                  event.target.value,
                                )
                              }
                              placeholder="Optional"
                            />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label>Notes</Label>
                          <Textarea
                            value={reportDraft.notes || ""}
                            onChange={(event) =>
                              handleReportFieldChange(
                                "notes",
                                event.target.value,
                              )
                            }
                            placeholder="Optional notes about the day, host, or issues."
                          />
                        </div>
                      </div>
                    )}
                    <DialogFooter className="gap-2 sm:gap-0">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setReportDraft(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        onClick={handleSaveReport}
                        disabled={isSavingReport}
                      >
                        {isSavingReport ? "Saving..." : "Save report"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                <Dialog
                  open={!!postPrompt}
                  onOpenChange={(open) => {
                    if (!open) setPostPrompt(null);
                  }}
                >
                  <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                      <DialogTitle>
                        {postPrompt?.title || "Share update"}
                      </DialogTitle>
                      <DialogDescription>
                        Choose where to share this update. You can edit the
                        message first.
                      </DialogDescription>
                    </DialogHeader>
                    {postPrompt && (
                      <div className="space-y-4">
                        {postPrompt.imageUrl && (
                          <img
                            src={postPrompt.imageUrl}
                            alt="Social post preview"
                            className="h-28 w-full rounded-lg border border-[color:var(--border-subtle)] object-cover"
                          />
                        )}
                        <div className="space-y-2">
                          <Label>Message</Label>
                          <Textarea
                            value={postPrompt.message}
                            onChange={(event) =>
                              handlePostPromptMessage(event.target.value)
                            }
                          />
                          <p className="text-xs text-[color:var(--text-muted)]">
                            Link: {postPrompt.link}
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label>Share to</Label>
                          <div className="grid gap-2 sm:grid-cols-3">
                            {(
                              [
                                { key: "facebook", label: "Facebook" },
                                { key: "instagram", label: "Instagram" },
                                { key: "x", label: "X" },
                              ] as const
                            ).map((platform) => (
                              <label
                                key={platform.key}
                                className="flex items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2 text-xs"
                              >
                                <input
                                  type="checkbox"
                                  checked={
                                    postPrompt.selectedPlatforms[platform.key]
                                  }
                                  onChange={() =>
                                    handlePostPromptToggle(platform.key)
                                  }
                                />
                                {platform.label}
                              </label>
                            ))}
                          </div>
                          <p className="text-xs text-[color:var(--text-muted)]">
                            Instagram will open with the caption copied to your
                            clipboard.
                          </p>
                        </div>
                      </div>
                    )}
                    <DialogFooter className="gap-2 sm:gap-0">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setPostPrompt(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        onClick={() => void handlePostPromptShare()}
                        disabled={isPostingSocial}
                      >
                        {isPostingSocial ? "Sharing..." : "Share update"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </CardContent>
            </Card>
          )}

          {topTab === "book" && (
            <div
              className={`space-y-4 pb-24 lg:pb-10${isTruckViewUser ? " order-first" : ""}`}
            >
              {!isAdminOrStaff &&
                isTruckViewUser &&
                truck &&
                truck.isVerified === false && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                  <p className="font-semibold">Verification pending</p>
                  <p className="text-[11px]">
                    You can still continue booking while verification is in
                    progress.
                  </p>
                  <a
                    href="/restaurant-signup"
                    className="text-[11px] font-semibold underline underline-offset-2 hover:no-underline"
                  >
                    Complete verification
                  </a>
                </div>
                )}
              {!canStartTruckCheckout && !isAdminOrStaff && (
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 text-sm text-[color:var(--text-primary)]">
                  <p className="font-semibold">Food truck profile required</p>
                  <p className="text-xs text-[color:var(--text-muted)]">
                    Only food trucks can book Parking Pass spots.
                  </p>
                </div>
              )}
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <p className="text-lg font-semibold text-[color:var(--text-primary)] font-display">
                    Find a parking spot
                  </p>
                  <p className="max-w-2xl text-sm text-[color:var(--text-muted)]">
                    Search any city or address, then choose a host location,
                    date, and available time. Results are not limited to your
                    current location.
                  </p>
                </div>
                <div className="hidden rounded-2xl pp-glass-muted px-4 py-3 text-xs text-[color:var(--text-muted)] shadow-clean lg:grid lg:grid-cols-3 lg:gap-5">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide">
                      Locations
                    </p>
                    <p className="mt-1 text-lg font-semibold text-[color:var(--text-primary)]">
                      {filteredLocations.length}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide">
                      Host pins
                    </p>
                    <p className="mt-1 text-lg font-semibold text-[color:var(--text-primary)]">
                      {viewMode === "map"
                        ? parkingPassHostPinCount
                        : filteredLocations.length}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide">
                      Cart
                    </p>
                    <p className="mt-1 text-lg font-semibold text-[color:var(--text-primary)]">
                      {cartItems.length}
                    </p>
                  </div>
                </div>
              </div>
              <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_430px]">
                <div className="min-w-0 space-y-4 order-1 lg:order-none">
                  <div className="space-y-3 rounded-2xl pp-glass p-3 shadow-clean sm:p-4 lg:p-5">
                    <div className="flex items-center justify-between gap-3">
                      <Label
                        htmlFor="parking-pass-location-search"
                        className="text-xs font-semibold text-[color:var(--text-primary)]"
                      >
                        City or address
                      </Label>
                      <span className="text-[11px] text-[color:var(--text-muted)]">
                        {filteredLocations.length} of {locationGroups.length} locations
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        id="parking-pass-location-search"
                        type="search"
                        className="pp-field"
                        placeholder="City, state, or street address"
                        value={cityQuery}
                        onChange={(event) => setCityQuery(event.target.value)}
                      />
                      {normalizedCityQuery && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="shrink-0"
                          onClick={() => setCityQuery("")}
                        >
                          View all
                        </Button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:max-w-sm">
                      <Button
                        type="button"
                        size="sm"
                        variant={viewMode === "map" ? "default" : "outline"}
                        onClick={() => setViewMode("map")}
                      >
                        Map
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={viewMode === "list" ? "default" : "outline"}
                        onClick={() => setViewMode("list")}
                      >
                        List
                      </Button>
                    </div>
                    {viewMode === "map" && (
                      <details className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] px-3 py-2 text-xs text-[color:var(--text-secondary)]">
                        <summary className="cursor-pointer font-semibold text-[color:var(--text-primary)]">
                          Map tools
                        </summary>
                        <div className="mt-3 space-y-2">
                          <Button
                            type="button"
                            size="sm"
                            variant={showParkingScoutHeat ? "default" : "outline"}
                            onClick={() =>
                              setShowParkingScoutHeat((value) => !value)
                            }
                            className="w-full sm:w-auto"
                          >
                            Area activity
                          </Button>
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                            <Button
                              type="button"
                              size="sm"
                              variant={showGasLayer ? "default" : "outline"}
                              onClick={() => setShowGasLayer((value) => !value)}
                              disabled={gasLayerCount === 0}
                              className="w-full"
                            >
                              {`Gas (${gasLayerSummary})`}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant={showPropaneLayer ? "default" : "outline"}
                              onClick={() => setShowPropaneLayer((value) => !value)}
                              disabled={supplierLayerCounts.propane === 0}
                              className="w-full"
                            >
                              {`Propane (${supplierLayerSummary.propane})`}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant={showSupplyLayer ? "default" : "outline"}
                              onClick={() => setShowSupplyLayer((value) => !value)}
                              disabled={supplierLayerCounts.supply === 0}
                              className="w-full"
                            >
                              {`Supply (${supplierLayerSummary.supply})`}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant={showSupportLayer ? "default" : "outline"}
                              onClick={() => setShowSupportLayer((value) => !value)}
                              disabled={supplierLayerCounts.support === 0}
                              className="w-full"
                            >
                              {`Support (${supplierLayerSummary.support})`}
                            </Button>
                          </div>
                          <p className="text-[11px] text-[color:var(--text-muted)]">
                            Blue is MealScout movement, orange is scheduled
                            host/truck activity, and purple is nearby food
                            destination density. These are opportunity signals,
                            not measured pedestrian counts. {" "}
                            {bookingWeatherData?.available
                              ? "Weather is available for the selected booking window."
                              : "Weather is not available for this booking window."}{" "}
                            Gas: {selectedSpotGasPriceSummary}.
                          </p>
                        </div>
                      </details>
                    )}
                    <div className="rounded-xl border border-orange-200/80 bg-orange-50/70 p-3 sm:p-4">
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 rounded-full bg-orange-600 p-2 text-white">
                          <Navigation className="h-4 w-4" />
                        </span>
                        <div>
                          <p className="text-sm font-semibold text-orange-950">
                            Plan along your route
                          </p>
                          <p className="mt-0.5 text-xs text-orange-800">
                            Travel is a food truck’s advantage. Find Parking
                            Pass hosts, fuel, propane, supplies, and repairs
                            anywhere between start and destination.
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <Label
                              htmlFor="parking-pass-journey-origin"
                              className="text-xs font-semibold text-orange-950"
                            >
                              Start
                            </Label>
                            <button
                              type="button"
                              className="text-[11px] font-semibold text-orange-700 underline underline-offset-2"
                              onClick={handleUseJourneyCurrentLocation}
                            >
                              Use my location
                            </button>
                          </div>
                          <PlaceAutocompleteInput
                            id="parking-pass-journey-origin"
                            value={journeyOriginLabel}
                            onChange={(value) => {
                              journeyOriginInitializedRef.current = true;
                              setJourneyOriginLabel(value);
                              setJourneyOriginCoords(null);
                              setJourneyResult(null);
                              setJourneyError("");
                            }}
                            onSelect={(suggestion) =>
                              void handleJourneyPlaceSelect(
                                "origin",
                                suggestion,
                              )
                            }
                            intent="destination"
                            placeholder="Starting address or city"
                            inputClassName="bg-white"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label
                            htmlFor="parking-pass-journey-destination"
                            className="text-xs font-semibold text-orange-950"
                          >
                            Destination
                          </Label>
                          <PlaceAutocompleteInput
                            id="parking-pass-journey-destination"
                            value={journeyDestinationLabel}
                            onChange={(value) => {
                              setJourneyDestinationLabel(value);
                              setJourneyDestinationCoords(null);
                              setJourneyResult(null);
                              setJourneyError("");
                            }}
                            onSelect={(suggestion) =>
                              void handleJourneyPlaceSelect(
                                "destination",
                                suggestion,
                              )
                            }
                            intent="destination"
                            placeholder="Where are you headed?"
                            inputClassName="bg-white"
                          />
                        </div>
                      </div>
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-[11px] text-orange-800">
                          Select a suggested place so the route uses exact map
                          coordinates.
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          className="shrink-0"
                          onClick={() => void handlePlanJourney()}
                          disabled={
                            isJourneyPlanning ||
                            !journeyOriginCoords ||
                            !journeyDestinationCoords
                          }
                        >
                          {isJourneyPlanning ? (
                            <>
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              Finding stops…
                            </>
                          ) : (
                            "Find stops on my route"
                          )}
                        </Button>
                      </div>
                      {journeyError && (
                        <p className="mt-2 text-xs font-medium text-red-700">
                          {journeyError}
                        </p>
                      )}
                    </div>
                  </div>

                  {journeyResult && (
                    <div className="overflow-hidden rounded-2xl border border-orange-200 pp-glass shadow-clean">
                      <div className="flex flex-col gap-3 border-b border-orange-200/70 bg-orange-50/60 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="text-sm font-semibold text-orange-950">
                            Your mobile service corridor
                          </p>
                          <p className="mt-1 text-xs text-orange-800">
                            {formatJourneyDuration(
                              journeyResult.route.durationSeconds,
                            )}
                            {" · "}
                            {formatJourneyMiles(
                              journeyResult.route.distanceMeters,
                            )}
                            {" · "}
                            {journeyResult.parkingPassHosts.length} Parking Pass
                            {journeyResult.parkingPassHosts.length === 1
                              ? " host"
                              : " hosts"}{" "}
                            near this route
                          </p>
                        </div>
                        <a
                          href={journeyResult.route.directionsUri}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex shrink-0 items-center justify-center rounded-md border border-orange-300 bg-white px-3 py-2 text-xs font-semibold text-orange-800 hover:bg-orange-50"
                        >
                          Open full trip
                        </a>
                      </div>
                      <div className="h-[320px] w-full bg-slate-100/60 sm:h-[400px]">
                        <GoogleMapPicker
                          center={journeyMapCenter}
                          zoom={9}
                          fitPins
                          pins={journeyMapPins}
                          routePath={journeyResult.route.path}
                          className="h-full w-full"
                        />
                      </div>
                      <div className="space-y-4 border-t border-[color:var(--border-subtle)] p-4">
                        <ParkingPassTripPlanner
                          hosts={journeyPlannerHosts}
                          origin={journeyOriginLabel}
                          destination={journeyDestinationLabel}
                          routeMiles={journeyResult.route.distanceMeters / 1609.344}
                          routeDurationSeconds={journeyResult.route.durationSeconds}
                          originCoords={journeyOriginCoords!}
                          destinationCoords={journeyDestinationCoords!}
                          selectedDate={selectedDate}
                          onSeeAvailability={(host) => {
                            const matchingGroup = locationGroups.find(
                              (group) => String(group.host.id) === String(host.hostId),
                            );
                            if (!matchingGroup) return;
                            setCityQuery([host.city, host.state].filter(Boolean).join(", "));
                            setActiveLocationKey(matchingGroup.key);
                            setViewMode("list");
                          }}
                        />
                        <div>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm font-semibold text-[color:var(--text-primary)]">
                              Parking Pass hosts along the way
                            </p>
                            <span className="text-[11px] text-[color:var(--text-muted)]">
                              Within {journeyResult.corridor.hostRadiusMiles} mi
                              of the route
                            </span>
                          </div>
                          {journeyResult.parkingPassHosts.length > 0 ? (
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              {journeyResult.parkingPassHosts.map((host) => {
                                const matchingGroup = locationGroups.find(
                                  (group) =>
                                    String(group.host.id) ===
                                    String(host.hostId),
                                );
                                return (
                                  <div
                                    key={host.locationId}
                                    className="rounded-xl border border-orange-200/70 bg-white/80 p-3"
                                  >
                                    <div className="flex items-start justify-between gap-3">
                                      <div className="min-w-0">
                                        <p className="truncate text-sm font-semibold text-[color:var(--text-primary)]">
                                          {host.name}
                                        </p>
                                        <p className="mt-0.5 text-[11px] text-[color:var(--text-muted)]">
                                          {buildAddressLabel(
                                            host.address,
                                            host.city,
                                            host.state,
                                          )}
                                        </p>
                                      </div>
                                      <span className="shrink-0 rounded-full bg-orange-100 px-2 py-1 text-[11px] font-semibold text-orange-800">
                                        {formatJourneyDetour(
                                          host.addedDurationSeconds,
                                        )}
                                      </span>
                                    </div>
                                    <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
                                      <span className="text-[color:var(--text-muted)]">
                                        {host.distanceFromRouteMiles.toFixed(1)}{" "}
                                        mi from route
                                      </span>
                                      {matchingGroup ? (
                                        <button
                                          type="button"
                                          className="font-semibold text-orange-700 underline underline-offset-2"
                                          onClick={() => {
                                            setCityQuery(
                                              [host.city, host.state]
                                                .filter(Boolean)
                                                .join(", "),
                                            );
                                            setActiveLocationKey(
                                              matchingGroup.key,
                                            );
                                            setViewMode("list");
                                          }}
                                        >
                                          See availability
                                        </button>
                                      ) : (
                                        <span className="font-medium text-[color:var(--text-muted)]">
                                          Host pin · no open pass yet
                                        </span>
                                      )}
                                      <a
                                        href={host.directionsUri}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="font-semibold text-orange-700 underline underline-offset-2"
                                      >
                                        Add stop
                                      </a>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <p className="mt-2 rounded-xl bg-[var(--bg-surface-muted)] p-3 text-xs text-[color:var(--text-muted)]">
                              No current Parking Pass host pins fall within this
                              route corridor yet. Essential stops are still
                              shown below.
                            </p>
                          )}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-[color:var(--text-primary)]">
                            Truck essentials by added time
                          </p>
                          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
                            {(
                              [
                                { key: "all", label: "All stops" },
                                { key: "gas", label: "⛽ Gas" },
                                { key: "propane", label: "🔥 Propane" },
                                { key: "supply", label: "📦 Supply" },
                                { key: "support", label: "🛠️ Repairs" },
                              ] as const
                            ).map((option) => (
                              <Button
                                key={option.key}
                                type="button"
                                size="sm"
                                variant={
                                  journeySupportFilter === option.key
                                    ? "default"
                                    : "outline"
                                }
                                onClick={() =>
                                  setJourneySupportFilter(option.key)
                                }
                                className="w-full"
                              >
                                {option.label}
                              </Button>
                            ))}
                          </div>
                          {journeyVisibleSupport.length > 0 ? (
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              {journeyVisibleSupport.map((place) => (
                                <a
                                  key={place.kind + ":" + place.placeId}
                                  href={place.directionsUri}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-3 transition hover:border-orange-300 hover:bg-orange-50/50"
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <p className="truncate text-sm font-semibold text-[color:var(--text-primary)]">
                                        {place.name}
                                      </p>
                                      <p className="mt-0.5 line-clamp-2 text-[11px] text-[color:var(--text-muted)]">
                                        {place.address}
                                      </p>
                                    </div>
                                    <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-700">
                                      {formatJourneyDetour(
                                        place.addedDurationSeconds,
                                      )}
                                    </span>
                                  </div>
                                </a>
                              ))}
                            </div>
                          ) : (
                            <p className="mt-2 text-xs text-[color:var(--text-muted)]">
                              No provider-backed stops were found in this
                              category along the route.
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {isLoading ? (
                    <div className="flex flex-col items-center justify-center py-8 space-y-3">
                      <Loader2 className="h-8 w-8 animate-spin text-orange-600" />
                      <p className="text-sm text-slate-700">
                        Loading parking pass spots...
                      </p>
                    </div>
                  ) : passListings.length === 0 ? (
                    viewMode === "map" && fallbackHostPins.length > 0 ? (
                      <div className="space-y-3">
                        <div className="rounded-2xl pp-glass shadow-clean overflow-hidden">
                          <div className="relative h-[320px] w-full bg-slate-100/60 sm:h-[380px] lg:h-[min(68vh,640px)] xl:h-[min(72vh,720px)]">
                            <GoogleMapPicker
                              center={fallbackMapCenter}
                              zoom={13}
                              fitPins
                              interactionsEnabled={mapInteractionsEnabled}
                              trafficCells={spotFootTrafficCells}
                              pins={[
                                ...fallbackHostPins.map(
                                  ({
                                    key,
                                    hostId,
                                    name,
                                    coords,
                                    addressLabel,
                                    spotImageUrl,
                                  }) =>
                                    ({
                                      key,
                                      position: coords,
                                      popup: (
                                        <div className="space-y-2 text-xs">
                                          <p className="font-semibold text-orange-600">
                                            {name}
                                          </p>
                                          <p className="text-[color:var(--text-muted)]">
                                            {addressLabel}
                                          </p>
                                          {spotImageUrl && (
                                            <img
                                              src={spotImageUrl}
                                              alt={`${name} parking spot`}
                                              className="h-24 w-full rounded-lg border border-border/50 object-cover"
                                              loading="lazy"
                                            />
                                          )}
                                          <p className="text-[11px] text-[color:var(--text-muted)]">
                                            No active parking pass listing is
                                            open here right now.
                                          </p>
                                        </div>
                                      ),
                                    }) satisfies MapPickerPin,
                                ),
                                ...operationalSupportPins.map((pin) => ({
                                  key: pin.key,
                                  position: pin.position,
                                  occupied: true,
                                  popup: (
                                    <div className="space-y-1.5 text-xs">
                                      <p className="font-semibold text-orange-600">
                                        {pin.kind === "gas"
                                          ? "⛽ "
                                          : pin.kind === "propane"
                                          ? "🔥 "
                                          : pin.kind === "supply"
                                            ? "📦 "
                                            : "🛠️ "}
                                        {pin.name}
                                      </p>
                                      <p className="text-[color:var(--text-muted)]">
                                        {pin.categoryLabel}
                                      </p>
                                      <p className="text-[color:var(--text-muted)]">
                                        {pin.addressLabel || "Address unavailable"}
                                      </p>
                                      {pin.contactPhone && (
                                        <p className="text-[color:var(--text-muted)]">
                                          {pin.contactPhone}
                                        </p>
                                      )}
                                      {pin.contactEmail && (
                                        <p className="text-[color:var(--text-muted)]">
                                          {pin.contactEmail}
                                        </p>
                                      )}
                                      <p className="text-[11px] text-[color:var(--text-muted)]">
                                        {pin.source === "google_places"
                                          ? "Nearby place from Google"
                                          : "MealScout partner"}
                                        {pin.driveDurationSeconds
                                          ? ` · ${Math.max(1, Math.round(pin.driveDurationSeconds / 60))} min drive`
                                          : pin.distanceMiles !== null
                                            ? ` · ${pin.distanceMiles.toFixed(1)} mi away`
                                            : ""}
                                      </p>
                                      {pin.googleMapsUri && (
                                        <a
                                          href={pin.googleMapsUri}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="font-semibold text-orange-600 underline"
                                        >
                                          Open directions
                                        </a>
                                      )}
                                    </div>
                                  ),
                                })),
                                ...(showGasLayer ? gasPricePins : []).map((pin) => ({
                                  key: pin.key,
                                  position: pin.position,
                                  occupied: true,
                                  popup: (
                                    <div className="space-y-1.5 text-xs">
                                      <p className="font-semibold text-orange-600">
                                        ⛽ {pin.name}
                                      </p>
                                      <p className="text-[color:var(--text-muted)]">
                                        {pin.addressLabel || "Address unavailable"}
                                      </p>
                                      <p className="text-[color:var(--text-muted)]">
                                        {[
                                          pin.regular ? `Regular ${pin.regular}` : null,
                                          pin.midgrade ? `Midgrade ${pin.midgrade}` : null,
                                          pin.premium ? `Premium ${pin.premium}` : null,
                                          pin.diesel ? `Diesel ${pin.diesel}` : null,
                                        ]
                                          .filter(Boolean)
                                          .join(" · ")}
                                      </p>
                                    </div>
                                  ),
                                })),
                              ]}
                              className="h-full w-full"
                            />
                            {showParkingScoutHeat && (
                              <div className="pointer-events-none absolute bottom-3 left-3 max-w-[min(270px,calc(100%-1.5rem))] rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-card)]/95 px-3 py-2 text-xs text-[color:var(--text-primary)] shadow-clean backdrop-blur">
                                <p className="font-semibold">
                                  {isScheduleFootTrafficFetching
                                    ? "Loading area activity"
                                    : spotFootTrafficCellCount > 0
                                    ? spotActivityTitle
                                      : activeLocation
                                        ? "No area activity signals yet"
                                        : "Select a spot to view area activity"}
                                </p>
                                <p className="mt-1 text-[color:var(--text-muted)]">
                                  {spotFootTrafficCellCount > 0
                                    ? spotActivitySummary
                                    : activeLocation
                                      ? "No provider or MealScout activity signals were found for this spot yet."
                                      : "Select a spot to view area activity."}
                                </p>
                                <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
                                  <span className="inline-flex items-center gap-1">
                                    <span className="h-2.5 w-2.5 rounded-full bg-blue-600" />
                                    MealScout movement
                                  </span>
                                  <span className="inline-flex items-center gap-1">
                                    <span className="h-2.5 w-2.5 rounded-full bg-orange-500" />
                                    Scheduled activity
                                  </span>
                                  <span className="inline-flex items-center gap-1">
                                    <span className="h-2.5 w-2.5 rounded-full bg-violet-500" />
                                    Food destinations
                                  </span>
                                </div>
                                {spotFootTrafficCellCount === 0 && (
                                  <p className="mt-1 text-[11px] text-[color:var(--text-muted)]">
                                    {String(
                                      intelligenceStatusData?.layers?.footTraffic?.status ||
                                        "unavailable",
                                    ) === "available"
                                      ? "Area activity is available when MealScout or provider signals exist."
                                      : "Area activity providers are unavailable right now."}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="border-t border-[color:var(--border-subtle)] px-4 py-2 text-xs text-[color:var(--text-muted)]">
                            {requestedHostId
                              ? "This host is visible on the map, but has no active parking pass listing yet."
                              : "Host locations are visible, but no active parking pass listings are open right now."}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="rounded-2xl pp-glass-muted p-6 text-center text-sm text-slate-700">
                          No available spots right now. Try another date or area.
                        </div>
                      </div>
                    )
                  ) : viewMode === "map" ? (
                    <div className="space-y-3">
                      <div className="rounded-2xl pp-glass shadow-clean overflow-hidden">
                        <div className="relative h-[320px] w-full bg-slate-100/60 sm:h-[380px] lg:h-[min(68vh,640px)] xl:h-[min(72vh,720px)]">
                          <GoogleMapPicker
                            center={mapCenter}
                            zoom={13}
                            fitPins
                            interactionsEnabled={mapInteractionsEnabled}
                            trafficCells={spotFootTrafficCells}
                            onPinClick={(pinKey) => {
                              const hit = mapPins.find((p) => p.key === pinKey);
                              if (hit) setActiveLocationKey(hit.group.key);
                            }}
                            pins={[
                              ...mapPins.map(
                                ({ key, group, coords, addressLabel }) => {
                                const effectiveDateKey =
                                  group.key === activeLocationKey
                                    ? selectedDate
                                    : nextBookableDateByGroup.get(group.key);
                                const listingForDate = effectiveDateKey
                                  ? group.listings.find(
                                      (listing) =>
                                        getListingDateKey(listing.date) ===
                                        effectiveDateKey,
                                    )
                                  : null;
                                const fallbackDateKey =
                                  effectiveDateKey || todayDateKey;
                                const displayListing =
                                  listingForDate ||
                                  group.listings.find(
                                    (listing) =>
                                      getListingDateKey(listing.date) >=
                                      fallbackDateKey,
                                  ) ||
                                  group.listings[0] ||
                                  null;
                                const bookingListing =
                                  listingForDate || displayListing;
                                const popupDateKeys = Array.from(
                                  new Set(
                                    group.listings.map((listing) =>
                                      getListingDateKey(listing.date),
                                    ),
                                  ),
                                ).sort();
                                const paymentsReady = Boolean(
                                  platformPaymentsReady,
                                );
                                const bookings = Array.isArray(
                                  bookingListing?.bookings,
                                )
                                  ? (bookingListing?.bookings ?? [])
                                  : [];
                                const slotOptions = listingForDate
                                  ? buildSlotOptions(listingForDate)
                                  : [];
                                const selectedSlots = listingForDate
                                  ? selectedSlotsByListing[listingForDate.id] ||
                                    []
                                  : [];
                                const selectedTotalCents = selectedSlots.reduce(
                                  (sum, slot) => {
                                    const price =
                                      slotOptions.find(
                                        (item) => item.type === slot,
                                      )?.priceCents || 0;
                                    return sum + price;
                                  },
                                  0,
                                );
                                const selectedFeeCents =
                                  getFeeCentsForSlots(selectedSlots);
                                const selectedTotalWithFee =
                                  selectedSlots.length > 0
                                    ? selectedTotalCents + selectedFeeCents
                                    : 0;
                                const availability = listingForDate
                                  ? !listingForDate.hardCapEnabled
                                    ? "Open"
                                    : listingForDate.availableSpotNumbers
                                    ? listingForDate.availableSpotNumbers
                                        .length > 0
                                      ? `Open spots: ${listingForDate.availableSpotNumbers.join(
                                          ", ",
                                        )}`
                                      : "Fully booked"
                                    : listingForDate.status === "open"
                                      ? "Open"
                                      : "Closed"
                                  : "Choose this spot to see available dates";
                                const hasAvailability = Boolean(
                                  listingForDate &&
                                  listingHasAvailability(listingForDate),
                                );
                                const canBook = Boolean(
                                  paymentsReady &&
                                    hasAvailability &&
                                    canStartTruckCheckout,
                                );

                                const pinPopup = (
                                  <div className="space-y-2 text-xs">
                                    <p className="font-semibold text-orange-600">
                                      {group.host.businessName}
                                    </p>
                                    <p className="text-[color:var(--text-muted)]">
                                      {addressLabel}
                                    </p>
                                    {group.host.spotImageUrl && (
                                      <img
                                        src={group.host.spotImageUrl}
                                        alt={`${group.host.businessName} parking spot`}
                                        className="h-24 w-full rounded-lg border border-border/50 object-cover"
                                        loading="lazy"
                                      />
                                    )}
                                    {displayListing && (
                                      <p className="text-[color:var(--text-muted)]">
                                        {format(
                                          new Date(displayListing.date),
                                          "EEE, MMM d",
                                        )}{" "}
                                        -{" "}
                                        {displayListing.startTime === "00:00" &&
                                        displayListing.endTime === "23:59"
                                          ? "Any time"
                                          : `${displayListing.startTime} - ${displayListing.endTime}`}
                                      </p>
                                    )}
                                    {popupDateKeys.length > 0 && (
                                      <div className="space-y-1.5">
                                        <span className="text-[11px] text-[color:var(--text-muted)]">
                                          Pick date
                                        </span>
                                        <div className="flex flex-wrap gap-1.5">
                                          {popupDateKeys.slice(0, 6).map((dateKey) => {
                                            const isSelected =
                                              selectedDate === dateKey;
                                            return (
                                              <Button
                                                key={`${group.key}-${dateKey}`}
                                                size="sm"
                                                type="button"
                                                variant={
                                                  isSelected ? "default" : "outline"
                                                }
                                                className="h-7 px-2 text-[10px]"
                                                onClick={(event) => {
                                                  event.preventDefault();
                                                  event.stopPropagation();
                                                  setSelectedDate(dateKey);
                                                  focusLocation(group.key);
                                                }}
                                              >
                                                {format(
                                                  new Date(`${dateKey}T00:00:00`),
                                                  "EEE M/d",
                                                )}
                                              </Button>
                                            );
                                          })}
                                        </div>
                                        {popupDateKeys.length > 6 && (
                                          <p className="text-[10px] text-[color:var(--text-muted)]">
                                            Open the spot card to view all available
                                            dates.
                                          </p>
                                        )}
                                      </div>
                                    )}
                                    {!listingForDate && (
                                      <p className="text-[11px] text-amber-700">
                                        {group.key === activeLocationKey
                                          ? `No slots on ${format(
                                              new Date(
                                                `${selectedDate}T00:00:00`,
                                              ),
                                              "EEE, MMM d",
                                            )}.`
                                          : "No open dates right now."}
                                      </p>
                                    )}
                                    <p className="text-[color:var(--text-muted)]">
                                      {availability}
                                    </p>
                                    {(() => {
                                      const lastConfirmedAt =
                                        listingForDate?.lastConfirmedAt ??
                                        displayListing?.lastConfirmedAt ??
                                        null;
                                      const relative = lastConfirmedAt
                                        ? formatRelativeTime(lastConfirmedAt)
                                        : null;
                                      if (!relative) return null;
                                      return (
                                        <p className="text-[11px] text-[color:var(--text-muted)]">
                                          Last confirmed: {relative}
                                        </p>
                                      );
                                    })()}
                                    {listingForDate &&
                                    slotOptions.length > 0 ? (
                                      <div className="space-y-2">
                                        <div className="grid grid-cols-2 gap-2">
                                          {slotOptions.map((slot) => {
                                            const feeCents =
                                              getFeeCentsForSlots([slot.type]);
                                            const totalPrice =
                                              ((slot.priceCents || 0) +
                                                feeCents) /
                                              100;
                                            const isSelected =
                                              selectedSlots.includes(slot.type);
                                            return (
                                              <Button
                                                key={slot.type}
                                                variant={
                                                  isSelected
                                                    ? "default"
                                                    : "outline"
                                                }
                                                size="sm"
                                                className="justify-between text-[11px]"
                                                disabled={!hasAvailability}
                                                onClick={() =>
                                                  handleSelect(
                                                    listingForDate,
                                                    slot.type,
                                                  )
                                                }
                                              >
                                                <span>{slot.label}</span>
                                                <span>
                                                  ${totalPrice.toFixed(2)}
                                                </span>
                                              </Button>
                                            );
                                          })}
                                        </div>
                                        <div className="flex items-center justify-between">
                                          <span className="text-[11px] text-[color:var(--text-muted)]">
                                            Includes a $10/day MealScout fee.
                                            Cleanup time is 30 minutes after the
                                            end time.
                                          </span>
                                          <Button
                                            size="sm"
                                            onClick={() =>
                                              handleBookSelected(listingForDate)
                                            }
                                            disabled={
                                              !paymentsReady ||
                                              selectedSlots.length === 0
                                            }
                                          >
                                            Book spot
                                            {selectedTotalWithFee > 0 && (
                                              <span className="ml-2 text-[11px]">
                                                $
                                                {(
                                                  (selectedTotalWithFee || 0) /
                                                  100
                                                ).toFixed(2)}
                                              </span>
                                            )}
                                          </Button>
                                        </div>
                                      </div>
                                    ) : (
                                      <p className="text-[11px] text-[color:var(--text-muted)]">
                                        Choose a day with availability.
                                      </p>
                                    )}
                                    {!isStripeConfigLoading &&
                                      !platformPaymentsReady && (
                                      <p className="pt-1 text-[11px] text-[color:var(--status-error)]">
                                        Payments are temporarily unavailable.
                                      </p>
                                    )}
                                    {bookings.length > 0 ? (
                                      <div className="pt-1 text-[11px] text-[color:var(--text-muted)] space-y-1">
                                        {bookings.slice(0, 3).map((booking) => (
                                          <div
                                            key={`${booking.truckId}-${booking.slotType || "slot"}`}
                                          >
                                            {booking.truckName}
                                            {booking.slotType
                                              ? ` - ${formatSlotLabel(
                                                  booking.slotType,
                                                )}`
                                              : ""}
                                          </div>
                                        ))}
                                        {bookings.length > 3 && (
                                          <div>+{bookings.length - 3} more</div>
                                        )}
                                      </div>
                                    ) : (
                                      <p className="pt-1 text-[11px] text-[color:var(--text-muted)]">
                                        No bookings yet
                                      </p>
                                    )}
                                  </div>
                                );
                                  return {
                                    key,
                                    position: coords,
                                    occupied:
                                      group.key === activeLocationKey || bookings.length > 0,
                                    popup: pinPopup,
                                  } satisfies MapPickerPin;
                                },
                              ),
                              ...unlistedHostPins.map((pin) => ({
                                key: pin.key,
                                position: pin.coords,
                                popup: (
                                  <div className="space-y-2 text-xs">
                                    <p className="font-semibold text-orange-600">
                                      {pin.name}
                                    </p>
                                    <p className="text-[color:var(--text-muted)]">
                                      {pin.addressLabel}
                                    </p>
                                    {pin.spotImageUrl && (
                                      <img
                                        src={pin.spotImageUrl}
                                        alt={`${pin.name} parking spot`}
                                        className="h-24 w-full rounded-lg border border-border/50 object-cover"
                                        loading="lazy"
                                      />
                                    )}
                                    <p className="text-[11px] text-[color:var(--text-muted)]">
                                      Parking Pass host location. Open dates appear
                                      in the list when inventory is available.
                                    </p>
                                  </div>
                                ),
                              } satisfies MapPickerPin)),
                              ...operationalSupportPins.map((pin) => ({
                                key: pin.key,
                                position: pin.position,
                                occupied: true,
                                popup: (
                                  <div className="space-y-1.5 text-xs">
                                    <p className="font-semibold text-orange-600">
                                      {pin.kind === "gas"
                                        ? "⛽ "
                                        : pin.kind === "propane"
                                        ? "🔥 "
                                        : pin.kind === "supply"
                                          ? "📦 "
                                          : "🛠️ "}
                                      {pin.name}
                                    </p>
                                    <p className="text-[color:var(--text-muted)]">
                                      {pin.categoryLabel}
                                    </p>
                                    <p className="text-[color:var(--text-muted)]">
                                      {pin.addressLabel || "Address unavailable"}
                                    </p>
                                    {pin.contactPhone && (
                                      <p className="text-[color:var(--text-muted)]">
                                        {pin.contactPhone}
                                      </p>
                                    )}
                                    {pin.contactEmail && (
                                      <p className="text-[color:var(--text-muted)]">
                                        {pin.contactEmail}
                                      </p>
                                    )}
                                    <p className="text-[11px] text-[color:var(--text-muted)]">
                                      {pin.source === "google_places"
                                        ? "Nearby place from Google"
                                        : "MealScout partner"}
                                      {pin.driveDurationSeconds
                                        ? ` · ${Math.max(1, Math.round(pin.driveDurationSeconds / 60))} min drive`
                                        : pin.distanceMiles !== null
                                          ? ` · ${pin.distanceMiles.toFixed(1)} mi away`
                                          : ""}
                                    </p>
                                    {pin.googleMapsUri && (
                                      <a
                                        href={pin.googleMapsUri}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="font-semibold text-orange-600 underline"
                                      >
                                        Open directions
                                      </a>
                                    )}
                                  </div>
                                ),
                              })),
                              ...(showGasLayer ? gasPricePins : []).map((pin) => ({
                                key: pin.key,
                                position: pin.position,
                                occupied: true,
                                popup: (
                                  <div className="space-y-1.5 text-xs">
                                    <p className="font-semibold text-orange-600">
                                      ⛽ {pin.name}
                                    </p>
                                    <p className="text-[color:var(--text-muted)]">
                                      {pin.addressLabel || "Address unavailable"}
                                    </p>
                                    <p className="text-[color:var(--text-muted)]">
                                      {[
                                        pin.regular ? `Regular ${pin.regular}` : null,
                                        pin.midgrade ? `Midgrade ${pin.midgrade}` : null,
                                        pin.premium ? `Premium ${pin.premium}` : null,
                                        pin.diesel ? `Diesel ${pin.diesel}` : null,
                                      ]
                                        .filter(Boolean)
                                        .join(" · ")}
                                    </p>
                                  </div>
                                ),
                              })),
                            ]}
                            className="h-full w-full"
                          />
                          {showParkingScoutHeat && (
                            <div className="pointer-events-none absolute bottom-3 left-3 max-w-[min(270px,calc(100%-1.5rem))] rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-card)]/95 px-3 py-2 text-xs text-[color:var(--text-primary)] shadow-clean backdrop-blur">
                              <p className="font-semibold">
                                {isScheduleFootTrafficFetching
                                  ? "Loading area activity"
                                  : spotFootTrafficCellCount > 0
                                    ? spotActivityTitle
                                    : activeLocation
                                      ? "No area activity signals yet"
                                      : "Select a spot to view area activity"}
                              </p>
                              <p className="mt-1 text-[color:var(--text-muted)]">
                                {spotFootTrafficCellCount > 0
                                  ? spotActivitySummary
                                  : activeLocation
                                    ? "No provider or MealScout activity signals were found for this spot yet."
                                    : "Select a spot to view area activity."}
                              </p>
                              <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
                                <span className="inline-flex items-center gap-1">
                                  <span className="h-2.5 w-2.5 rounded-full bg-blue-600" />
                                  MealScout movement
                                </span>
                                <span className="inline-flex items-center gap-1">
                                  <span className="h-2.5 w-2.5 rounded-full bg-orange-500" />
                                  Scheduled activity
                                </span>
                                <span className="inline-flex items-center gap-1">
                                  <span className="h-2.5 w-2.5 rounded-full bg-violet-500" />
                                  Food destinations
                                </span>
                              </div>
                              {spotFootTrafficCellCount === 0 && (
                                <p className="mt-1 text-[11px] text-[color:var(--text-muted)]">
                                  {String(
                                    intelligenceStatusData?.layers?.footTraffic?.status ||
                                      "unavailable",
                                  ) === "available"
                                    ? "Area activity is available when MealScout or provider signals exist."
                                    : "Area activity providers are unavailable right now."}
                                </p>
                              )}
                            </div>
                          )}
                          {parkingPassHostPinCount === 0 && (
                            <div className="absolute inset-0 flex items-center justify-center text-sm text-[color:var(--text-muted)] pointer-events-none">
                              No mappable locations yet.
                            </div>
                          )}
                        </div>
                        <div className="border-t border-[color:var(--border-subtle)] px-4 py-2 text-xs text-[color:var(--text-muted)]">
                          Select a location below to update the map and the details panel.
                        </div>
                      </div>
                      <div className="grid gap-3 xl:grid-cols-2">
                        {filteredLocations.map((group) => {
                          const effectiveDateKey =
                            group.key === activeLocationKey
                              ? selectedDate
                              : nextBookableDateByGroup.get(group.key);
                          const groupDateKeys = Array.from(
                            new Set(
                              group.listings.map((listing) =>
                                getListingDateKey(listing.date),
                              ),
                            ),
                          ).sort();
                          const selectedGroupDateKey =
                            effectiveDateKey ||
                            groupDateKeys[0] ||
                            selectedDate;
                          const listingForDate = effectiveDateKey
                            ? group.listings.find(
                                (listing) =>
                                  getListingDateKey(listing.date) ===
                                  effectiveDateKey,
                              )
                            : null;
                          const fallbackDateKey =
                            effectiveDateKey || todayDateKey;
                          const displayListing =
                            listingForDate ||
                            group.listings.find(
                              (listing) =>
                                getListingDateKey(listing.date) >=
                                fallbackDateKey,
                            ) ||
                            group.listings[0] ||
                            null;
                          const bookingListing =
                            listingForDate || displayListing;
                          const paymentsReady = Boolean(platformPaymentsReady);
                          const slotOptions = listingForDate
                            ? buildSlotOptions(listingForDate)
                            : [];
                          const selectedSlots = listingForDate
                            ? selectedSlotsByListing[listingForDate.id] || []
                            : [];
                          const selectedTotalCents = selectedSlots.reduce(
                            (sum, slot) => {
                              const price =
                                slotOptions.find((item) => item.type === slot)
                                  ?.priceCents || 0;
                              return sum + price;
                            },
                            0,
                          );
                          const selectedFeeCents =
                            getFeeCentsForSlots(selectedSlots);
                          const selectedTotalWithFee =
                            selectedSlots.length > 0
                              ? selectedTotalCents + selectedFeeCents
                              : 0;
                          const hasAvailability = Boolean(
                            listingForDate &&
                            listingHasAvailability(listingForDate),
                          );
                          const bookingModeLabel = canStartTruckCheckout
                            ? hasAvailability && listingForDate?.status === "open"
                              ? "Bookable"
                              : listingForDate
                                ? "Requestable"
                                : "View only"
                            : "View only";
                          const canBook = Boolean(
                            paymentsReady &&
                              hasAvailability &&
                              canStartTruckCheckout,
                          );
                          const bookings = Array.isArray(
                            bookingListing?.bookings,
                          )
                            ? (bookingListing?.bookings ?? [])
                            : [];
                          const isActive = activeLocation?.key === group.key;
                          const groupCoords =
                            parkingCoords[group.key] ||
                            getLocationCoords(group.host) ||
                            null;
                          const routeUrl = groupCoords
                            ? `https://www.google.com/maps/dir/?api=1&destination=${groupCoords.lat},${groupCoords.lng}&travelmode=driving`
                            : null;
                          const shareDate = displayListing
                            ? getListingDateKey(displayListing.date)
                            : selectedDate;
                          const shareListingId = displayListing?.id || "";

                          return (
                            <div
                              key={group.key}
                              role="button"
                              tabIndex={0}
                              aria-pressed={isActive}
                              onClick={() => focusLocation(group.key, true)}
                              onKeyDown={(keyboardEvent) => {
                                if (
                                  keyboardEvent.key === "Enter" ||
                                  keyboardEvent.key === " "
                                ) {
                                  keyboardEvent.preventDefault();
                                  setActiveLocationKey(group.key);
                                }
                              }}
                              className={`w-full rounded-2xl border px-4 py-3 space-y-2 transition cursor-pointer shadow-clean ${
                                isActive
                                  ? "border-orange-300 pp-glass ring-2 ring-orange-200"
                                  : "border-[color:var(--border-subtle)] pp-glass-muted hover:opacity-95"
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <div>
                                  <span className="text-[15px] font-semibold text-orange-500 font-display">
                                    {group.host.businessName}
                                  </span>
                                  <div className="text-xs text-[color:var(--text-muted)]">
                                    {displayListing
                                      ? format(
                                          new Date(displayListing.date),
                                          "EEE, MMM d",
                                        )
                                      : "No dates listed"}
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      focusLocation(group.key, true);
                                    }}
                                  >
                                    View Host
                                  </Button>
                                  {routeUrl ? (
                                    <a
                                      href={routeUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="inline-flex h-8 items-center rounded-md border border-[color:var(--border-subtle)] px-3 text-xs font-medium text-[color:var(--text-primary)]"
                                      onClick={(event) => event.stopPropagation()}
                                    >
                                      Route
                                    </a>
                                  ) : null}
                                </div>
                              </div>
                              {groupDateKeys.length > 1 && (
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[11px] text-[color:var(--text-muted)]">
                                    Date
                                  </span>
                                  <select
                                    className="rounded-lg border border-[color:var(--border-subtle)] bg-[var(--bg-card)] px-2 py-1 text-xs text-[color:var(--text-primary)]"
                                    value={selectedGroupDateKey}
                                    onClick={(event) => event.stopPropagation()}
                                    onChange={(event) => {
                                      event.stopPropagation();
                                      setSelectedDate(event.target.value);
                                      focusLocation(group.key, true);
                                    }}
                                  >
                                    {groupDateKeys.slice(0, 14).map((key) => (
                                      <option key={key} value={key}>
                                        {format(
                                          new Date(`${key}T00:00:00`),
                                          "EEE, MMM d",
                                        )}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              )}
                              <div className="text-xs text-slate-700 space-y-1">
                                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                                  <span className="rounded-full pp-chip px-2 py-0.5 text-[10px] font-semibold">
                                    {bookingModeLabel}
                                  </span>
                                  {displayListing?.maxTrucks ? (
                                    <span className="rounded-full pp-chip px-2 py-0.5 text-[10px] font-semibold">
                                      Capacity {displayListing.maxTrucks}
                                    </span>
                                  ) : null}
                                  {slotOptions.length > 0 ? (
                                    <span className="rounded-full pp-chip px-2 py-0.5 text-[10px] font-semibold">
                                      {`From $${(((slotOptions[0]?.priceCents || 0) + getFeeCentsForSlots([slotOptions[0]?.type || "daily"])) / 100).toFixed(2)}`}
                                    </span>
                                  ) : null}
                                </div>
                                <p>{group.host.address}</p>
                                {displayListing && (
                                  <p>
                                    {displayListing.startTime === "00:00" &&
                                    displayListing.endTime === "23:59"
                                      ? "Any time"
                                      : `${displayListing.startTime} - ${displayListing.endTime}`}
                                  </p>
                                )}
                                {!listingForDate && (
                                  <p className="text-[11px] text-amber-700">
                                    {effectiveDateKey
                                      ? `No slots on ${format(
                                          new Date(
                                            `${effectiveDateKey}T00:00:00`,
                                          ),
                                          "EEE, MMM d",
                                        )}.`
                                      : "No open dates right now."}
                                  </p>
                                )}
                                {listingForDate?.hardCapEnabled &&
                                  listingForDate?.availableSpotNumbers && (
                                  <p className="text-[11px] text-[color:var(--text-muted)]">
                                    {listingForDate.availableSpotNumbers
                                      .length > 0
                                      ? `Open spot${listingForDate.availableSpotNumbers.length > 1 ? "s" : ""}: ${listingForDate.availableSpotNumbers.join(", ")}`
                                      : "Fully booked"}
                                  </p>
                                )}
                                {bookings.length > 0 ? (
                                  <div className="text-[11px] text-[color:var(--text-muted)]">
                                    Booked trucks:{" "}
                                    {bookings
                                      .slice(0, 2)
                                      .map((booking) => booking.truckName)
                                      .join(", ")}
                                    {bookings.length > 2
                                      ? ` +${bookings.length - 2} more`
                                      : ""}
                                  </div>
                                ) : (
                                  <div className="text-[11px] text-[color:var(--text-muted)]">
                                    No bookings yet
                                  </div>
                                )}
                              </div>
                              {shareListingId && (
                                <div>
                                  <ShareButton
                                    url={`/parking-pass?date=${encodeURIComponent(
                                      shareDate,
                                    )}&pass=${shareListingId}`}
                                    title={`Parking Pass at ${group.host.businessName}`}
                                    description={`${group.host.address}${
                                      group.host.city
                                        ? `, ${group.host.city}`
                                        : ""
                                    }${group.host.state ? `, ${group.host.state}` : ""}`}
                                    size="sm"
                                    variant="outline"
                                  />
                                </div>
                              )}
                              {isActive &&
                                listingForDate &&
                                slotOptions.length > 0 && (
                                  <div className="grid grid-cols-2 gap-2 pt-1">
                                    {slotOptions.map((slot) => {
                                      const feeCents = getFeeCentsForSlots([
                                        slot.type,
                                      ]);
                                      const totalPrice =
                                        ((slot.priceCents || 0) + feeCents) /
                                        100;
                                      const isSelected = selectedSlots.includes(
                                        slot.type,
                                      );
                                      return (
                                        <Button
                                          key={slot.type}
                                          variant={
                                            isSelected ? "default" : "outline"
                                          }
                                          size="sm"
                                          className="justify-between"
                                          disabled={!hasAvailability}
                                          onClick={() =>
                                            handleSelect(
                                              listingForDate,
                                              slot.type,
                                            )
                                          }
                                        >
                                          <span>{slot.label}</span>
                                          <span>${totalPrice.toFixed(2)}</span>
                                        </Button>
                                      );
                                    })}
                                  </div>
                                )}
                              {hasAvailability ? (
                                <div className="flex items-center justify-between gap-3 pt-2">
                                  <p className="text-[11px] text-[color:var(--text-muted)]">
                                    Includes a $10/day MealScout fee per host.
                                    Cleanup time is 30 minutes after the end
                                    time.
                                  </p>
                                  {isActive && listingForDate && (
                                    <LongPressHelp description="Reserve this selected slot and continue to checkout.">
                                      <Button
                                        size="sm"
                                        type="button"
                                        onClick={(event) => {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          handleBookSelected(listingForDate);
                                        }}
                                        disabled={selectedSlots.length === 0}
                                      >
                                        Book Spot
                                        {selectedTotalWithFee > 0 && (
                                          <span className="ml-2 text-xs">
                                            $
                                            {(
                                              (selectedTotalWithFee || 0) / 100
                                            ).toFixed(2)}
                                          </span>
                                        )}
                                      </Button>
                                    </LongPressHelp>
                                  )}
                                </div>
                              ) : (
                                <div className="flex items-center justify-between gap-3">
                                  <p className="text-[11px] text-[color:var(--text-muted)]">
                                    {listingForDate
                                      ? "Fully booked."
                                      : "No open dates right now."}
                                  </p>
                                  {canStartTruckCheckout && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      type="button"
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        toast({
                                          title: "Request Spot",
                                          description:
                                            "Use View Host to request this location.",
                                        });
                                      }}
                                    >
                                      Request Spot
                                    </Button>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                        {filteredLocations.length === 0 && (
                          <div className="rounded-2xl pp-glass-muted p-6 text-center text-sm text-slate-700">
                            No host spots match that search.
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="grid gap-3 xl:grid-cols-2">
                      {filteredLocations.map((group) => {
                        const effectiveDateKey =
                          group.key === activeLocationKey
                            ? selectedDate
                            : nextBookableDateByGroup.get(group.key);
                        const groupDateKeys = Array.from(
                          new Set(
                            group.listings.map((listing) =>
                              getListingDateKey(listing.date),
                            ),
                          ),
                        ).sort();
                        const selectedGroupDateKey =
                          effectiveDateKey || groupDateKeys[0] || selectedDate;
                        const listingForDate = effectiveDateKey
                          ? group.listings.find(
                              (listing) =>
                                getListingDateKey(listing.date) ===
                                effectiveDateKey,
                            )
                          : null;
                        const fallbackDateKey =
                          effectiveDateKey || todayDateKey;
                        const displayListing =
                          listingForDate ||
                          group.listings.find(
                            (listing) =>
                              getListingDateKey(listing.date) >=
                              fallbackDateKey,
                          ) ||
                          group.listings[0] ||
                          null;
                        const bookingListing = listingForDate || displayListing;
                        const paymentsReady = Boolean(platformPaymentsReady);
                        const slotOptions = listingForDate
                          ? buildSlotOptions(listingForDate)
                          : [];
                        const selectedSlots = listingForDate
                          ? selectedSlotsByListing[listingForDate.id] || []
                          : [];
                        const selectedTotalCents = selectedSlots.reduce(
                          (sum, slot) => {
                            const price =
                              slotOptions.find((item) => item.type === slot)
                                ?.priceCents || 0;
                            return sum + price;
                          },
                          0,
                        );
                        const selectedFeeCents =
                          getFeeCentsForSlots(selectedSlots);
                        const selectedTotalWithFee =
                          selectedSlots.length > 0
                            ? selectedTotalCents + selectedFeeCents
                            : 0;

                        const hasAvailability = Boolean(
                          listingForDate &&
                          listingHasAvailability(listingForDate),
                        );
                        const bookingModeLabel = canStartTruckCheckout
                          ? hasAvailability && listingForDate?.status === "open"
                            ? "Bookable"
                            : listingForDate
                              ? "Requestable"
                              : "View only"
                          : "View only";
                        const canBook = Boolean(
                          paymentsReady &&
                            hasAvailability &&
                            canStartTruckCheckout,
                        );
                        const bookings = Array.isArray(bookingListing?.bookings)
                          ? (bookingListing?.bookings ?? [])
                          : [];
                        const isActive = activeLocation?.key === group.key;
                        const groupCoords =
                          parkingCoords[group.key] ||
                          getLocationCoords(group.host) ||
                          null;
                        const routeUrl = groupCoords
                          ? `https://www.google.com/maps/dir/?api=1&destination=${groupCoords.lat},${groupCoords.lng}&travelmode=driving`
                          : null;
                        const shareDate = displayListing
                          ? getListingDateKey(displayListing.date)
                          : selectedDate;
                        const shareListingId = displayListing?.id || "";

                        return (
                          <div
                            key={group.key}
                            role="button"
                            tabIndex={0}
                            aria-pressed={isActive}
                            onClick={() => focusLocation(group.key, true)}
                            onKeyDown={(keyboardEvent) => {
                              if (
                                keyboardEvent.key === "Enter" ||
                                keyboardEvent.key === " "
                              ) {
                                keyboardEvent.preventDefault();
                                focusLocation(group.key, true);
                              }
                            }}
                            className={`w-full text-left rounded-2xl border px-4 py-3 space-y-2 transition cursor-pointer shadow-clean ${
                              isActive
                                ? "border-orange-300 pp-glass ring-2 ring-orange-200"
                                : "border-[color:var(--border-subtle)] pp-glass-muted hover:opacity-95"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div>
                                <span className="text-[15px] font-semibold text-orange-500 font-display">
                                  {group.host.businessName}
                                </span>
                                <p className="text-xs text-[color:var(--text-muted)]">
                                  {displayListing
                                    ? format(
                                        new Date(displayListing.date),
                                        "EEE, MMM d",
                                      )
                                    : "No dates listed"}
                                </p>
                              </div>
                              <div className="flex items-center gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    focusLocation(group.key, true);
                                  }}
                                >
                                  View Host
                                </Button>
                                {routeUrl ? (
                                  <a
                                    href={routeUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex h-8 items-center rounded-md border border-[color:var(--border-subtle)] px-3 text-xs font-medium text-[color:var(--text-primary)]"
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    Route
                                  </a>
                                ) : null}
                              </div>
                            </div>
                            {groupDateKeys.length > 1 && (
                              <div className="flex items-center justify-between gap-2 pt-1">
                                <span className="text-[11px] text-[color:var(--text-muted)]">
                                  Date
                                </span>
                                <select
                                  className="rounded-lg border border-[color:var(--border-subtle)] bg-[var(--bg-card)] px-2 py-1 text-xs text-[color:var(--text-primary)]"
                                  value={selectedGroupDateKey}
                                  onClick={(event) => event.stopPropagation()}
                                  onChange={(event) => {
                                    event.stopPropagation();
                                    setSelectedDate(event.target.value);
                                    focusLocation(group.key, true);
                                  }}
                                >
                                  {groupDateKeys.slice(0, 14).map((key) => (
                                    <option key={key} value={key}>
                                      {format(
                                        new Date(`${key}T00:00:00`),
                                        "EEE, MMM d",
                                      )}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                            <div className="text-xs text-slate-700">
                              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                                <span className="rounded-full pp-chip px-2 py-0.5 text-[10px] font-semibold">
                                  {bookingModeLabel}
                                </span>
                                {displayListing?.maxTrucks ? (
                                  <span className="rounded-full pp-chip px-2 py-0.5 text-[10px] font-semibold">
                                    Capacity {displayListing.maxTrucks}
                                  </span>
                                ) : null}
                                {slotOptions.length > 0 ? (
                                  <span className="rounded-full pp-chip px-2 py-0.5 text-[10px] font-semibold">
                                    {`From $${(((slotOptions[0]?.priceCents || 0) + getFeeCentsForSlots([slotOptions[0]?.type || "daily"])) / 100).toFixed(2)}`}
                                  </span>
                                ) : null}
                              </div>
                              <p>{group.host.address}</p>
                              {(group.host.city || group.host.state) && (
                                <p>
                                  {[group.host.city, group.host.state]
                                    .filter(Boolean)
                                    .join(", ")}
                                </p>
                              )}
                              {displayListing && (
                                <p>
                                  {displayListing.startTime === "00:00" &&
                                  displayListing.endTime === "23:59"
                                    ? "Any time"
                                    : `${displayListing.startTime} - ${displayListing.endTime}`}
                                </p>
                              )}
                              {!listingForDate && (
                                <p className="text-[11px] text-amber-700">
                                  {effectiveDateKey
                                    ? `No slots on ${format(
                                        new Date(
                                          `${effectiveDateKey}T00:00:00`,
                                        ),
                                        "EEE, MMM d",
                                      )}.`
                                    : "No open dates right now."}
                                </p>
                              )}
                              {!isActive &&
                                nextBookableDateByGroup.get(group.key) && (
                                  <p className="text-[11px] text-[color:var(--text-muted)]">
                                    Next open:{" "}
                                    {format(
                                      new Date(
                                        `${nextBookableDateByGroup.get(group.key)}T00:00:00`,
                                      ),
                                      "EEE, MMM d",
                                    )}
                                  </p>
                                )}
                              {listingForDate?.hardCapEnabled &&
                                listingForDate?.availableSpotNumbers && (
                                <p className="text-[11px] text-[color:var(--text-muted)]">
                                  {listingForDate.availableSpotNumbers.length >
                                  0
                                    ? `Open spot${listingForDate.availableSpotNumbers.length > 1 ? "s" : ""}: ${listingForDate.availableSpotNumbers.join(", ")}`
                                    : "Fully booked"}
                                </p>
                              )}
                            </div>
                            {shareListingId && (
                              <div>
                                <ShareButton
                                  url={`/parking-pass?date=${encodeURIComponent(
                                    shareDate,
                                  )}&pass=${shareListingId}`}
                                  title={`Parking Pass at ${group.host.businessName}`}
                                  description={`${group.host.address}${
                                    group.host.city
                                      ? `, ${group.host.city}`
                                      : ""
                                  }${group.host.state ? `, ${group.host.state}` : ""}`}
                                  size="sm"
                                  variant="outline"
                                />
                              </div>
                            )}
                            {isActive &&
                              listingForDate &&
                              slotOptions.length > 0 && (
                                <div className="grid grid-cols-2 gap-2 pt-1">
                                  {slotOptions.map((slot) => {
                                    const feeCents = getFeeCentsForSlots([
                                      slot.type,
                                    ]);
                                    const totalPrice =
                                      ((slot.priceCents || 0) + feeCents) / 100;
                                    const isSelected = selectedSlots.includes(
                                      slot.type,
                                    );
                                    return (
                                      <Button
                                        key={slot.type}
                                        variant={
                                          isSelected ? "default" : "outline"
                                        }
                                        size="sm"
                                        className="justify-between"
                                        disabled={!hasAvailability}
                                        onClick={() =>
                                          handleSelect(
                                            listingForDate,
                                            slot.type,
                                          )
                                        }
                                      >
                                        <span>{slot.label}</span>
                                        <span>${totalPrice.toFixed(2)}</span>
                                      </Button>
                                    );
                                  })}
                                </div>
                              )}
                            {hasAvailability ? (
                              <div className="flex items-center justify-between gap-3 pt-2">
                                <p className="text-[11px] text-[color:var(--text-muted)]">
                                  Includes a $10/day MealScout fee per host.
                                  Cleanup time is 30 minutes after the end time.
                                </p>
                                {isActive &&
                                  listingForDate &&
                                  canStartTruckCheckout && (
                                  <LongPressHelp description="Reserve this selected slot and continue to checkout.">
                                    <Button
                                      size="sm"
                                      type="button"
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        handleBookSelected(listingForDate);
                                      }}
                                      disabled={
                                        !canBook || selectedSlots.length === 0
                                      }
                                    >
                                      Book Spot
                                      {selectedTotalWithFee > 0 && (
                                        <span className="ml-2 text-xs">
                                          $
                                          {(
                                            (selectedTotalWithFee || 0) / 100
                                          ).toFixed(2)}
                                        </span>
                                      )}
                                    </Button>
                                  </LongPressHelp>
                                )}
                              </div>
                            ) : (
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-[11px] text-[color:var(--text-muted)]">
                                  {listingForDate
                                    ? "Fully booked."
                                    : "No open dates right now."}
                                </p>
                                {canStartTruckCheckout && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    type="button"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      toast({
                                        title: "Request Spot",
                                        description:
                                          "Use View Host to request this location.",
                                      });
                                    }}
                                  >
                                    Request Spot
                                  </Button>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {filteredLocations.length === 0 && (
                        <div className="rounded-2xl pp-glass-muted p-6 text-center text-sm text-[color:var(--text-secondary)]">
                          <p>No parking spots match that search.</p>
                          {normalizedCityQuery && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="mt-3"
                              onClick={() => setCityQuery("")}
                            >
                              View all {locationGroups.length} locations
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="space-y-4 order-2 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto lg:pr-1 lg:order-none">
                  {canStartTruckCheckout && cartItems.length > 0 && (
                    <div className="rounded-2xl pp-glass p-4 shadow-clean space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-semibold text-[color:var(--text-primary)]">
                            Booking cart
                          </p>
                          <p className="text-xs text-[color:var(--text-muted)]">
                            Separate charges per host.
                          </p>
                        </div>
                        <Button
                          size="sm"
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            startCheckout();
                          }}
                        >
                          Checkout {cartItems.length}
                        </Button>
                      </div>
                      <div className="space-y-2">
                        {cartItems.map((item) => (
                          <div
                            key={item.listing.id}
                            className="rounded-xl pp-glass-muted px-3 py-2 text-xs text-slate-700"
                          >
                            <div className="flex items-center justify-between text-sm text-[color:var(--text-primary)]">
                              <span className="text-orange-500">
                                {item.listing.host.businessName}
                              </span>
                              <button
                                type="button"
                                className="text-xs text-[color:var(--text-muted)] underline"
                                onClick={() => removeCartItem(item.listing.id)}
                              >
                                remove
                              </button>
                            </div>
                            <p>
                              {format(
                                new Date(item.listing.date),
                                "EEE, MMM d",
                              )}{" "}
                              - {item.slotTypes.join(", ")}
                            </p>
                          </div>
                        ))}
                      </div>
                      {cartTotals.totalCents > 0 && (
                        <div className="rounded-xl pp-glass-muted p-3 text-xs text-slate-700">
                          <div className="flex items-center justify-between">
                            <span>Host total</span>
                            <span>
                              ${(cartTotals.hostCents / 100).toFixed(2)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span>MealScout fee</span>
                            <span>
                              ${(cartTotals.feeCents / 100).toFixed(2)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between font-semibold text-[color:var(--text-primary)]">
                            <span>Total</span>
                            <span>
                              ${(cartTotals.totalCents / 100).toFixed(2)}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  <Card
                    id="parking-pass-details"
                    className="hidden rounded-2xl pp-glass shadow-clean lg:block"
                  >
                    <CardContent className="p-5 space-y-3">
                      <div>
                        <p className="text-base font-semibold text-slate-900 font-display">
                          {activeLocation?.host.businessName ||
                            "Select a location"}
                        </p>
                        <p className="text-xs text-[color:var(--text-muted)]">
                          {activeLocation?.host.address ||
                            "Choose a spot to see details."}
                        </p>
                      </div>
                      {activeListing && (
                        <>
                          <div className="flex flex-wrap gap-2 text-xs text-[color:var(--text-muted)]">
                            <span className="rounded-full pp-chip px-2 py-1">
                              {activeListing.host.locationType || "Location"}
                            </span>
                            <span className="rounded-full pp-chip px-2 py-1">
                              Host traffic estimate:{" "}
                              {activeListing.host.expectedFootTraffic ||
                                "Not shared"}
                            </span>
                            <span className="rounded-full pp-chip px-2 py-1">
                              {activeListing.startTime === "00:00" &&
                              activeListing.endTime === "23:59"
                                ? "Any time"
                                : `${activeListing.startTime} - ${activeListing.endTime}`}
                            </span>
                          </div>
                          <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs font-semibold text-[color:var(--text-primary)]">
                                Booking essentials
                              </p>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-[11px]"
                                onClick={() =>
                                  setShowSpotInsights((prev) => !prev)
                                }
                              >
                                {showSpotInsights ? "Hide insights" : "Show insights"}
                              </Button>
                            </div>
                            <div className="mt-1 text-[11px] text-[color:var(--text-muted)]">
                              {isBookingWeatherFetching
                                ? "Weather loading..."
                                : bookingWeatherData?.available
                                  ? `Weather: ${bookingWeatherData.summary}`
                                  : "Weather unavailable"}{" "}
                              ·{" "}
                              {isScheduleFootTrafficFetching
                                ? "Area activity loading..."
                                : typeof scheduleFootTrafficData?.cells?.length ===
                                      "number" &&
                                    scheduleFootTrafficData.cells.length > 0
                                  ? `Area activity: ${spotActivitySummary}`
                                  : "Area activity unavailable"}
                              <span className="block pt-1">
                                Travel: {selectedSpotTravelSummary}
                              </span>
                            </div>
                          </div>
                          {showSpotInsights && (
                            <>
                              <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2 text-xs">
                                <p className="font-semibold text-[color:var(--text-primary)]">
                                  Booking-date weather
                                </p>
                                {isBookingWeatherFetching ? (
                                  <p className="mt-1 text-[color:var(--text-muted)]">
                                    Loading weather for this booking window...
                                  </p>
                                ) : bookingWeatherData?.available ? (
                                  <div className="mt-1 space-y-1 text-[color:var(--text-muted)]">
                                    <p>{bookingWeatherData.summary}</p>
                                    <p>
                                      Temp: {bookingWeatherData.temperatureF ?? "n/a"}°F · Rain risk:{" "}
                                      {bookingWeatherData.rainRiskPercent ?? "n/a"}% · Wind:{" "}
                                      {bookingWeatherData.windMph ?? "n/a"} mph
                                    </p>
                                    <p>
                                      Severe weather:{" "}
                                      {bookingWeatherData.severeWeatherWarning ? "Warning" : "None"}
                                    </p>
                                  </div>
                                ) : (
                                  <p className="mt-1 text-[color:var(--text-muted)]">
                                    {bookingWeatherData?.message ||
                                      "Weather forecast unavailable for this booking window."}
                                  </p>
                                )}
                              </div>
                              <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2 text-xs">
                                <p className="font-semibold text-[color:var(--text-primary)]">
                                  Provider-backed place details
                                </p>
                                {isPlaceIntelligenceFetching ? (
                                  <p className="mt-1 text-[color:var(--text-muted)]">
                                    Matching this host with Google Places…
                                  </p>
                                ) : placeIntelligenceData?.available &&
                                  placeIntelligenceData.place ? (
                                  <div className="mt-1 space-y-1 text-[color:var(--text-muted)]">
                                    <p>
                                      {placeIntelligenceData.place.name ||
                                        selectedSpotHost?.businessName}
                                      {placeIntelligenceData.place.businessStatus
                                        ? ` · ${placeIntelligenceData.place.businessStatus.toLowerCase().replace(/_/g, " ")}`
                                        : ""}
                                      {typeof placeIntelligenceData.place.openNow ===
                                      "boolean"
                                        ? placeIntelligenceData.place.openNow
                                          ? " · open now"
                                          : " · closed now"
                                        : ""}
                                    </p>
                                    <p>
                                      Parking: {placeIntelligenceData.place.parkingOptions
                                        ? Object.entries(
                                            placeIntelligenceData.place.parkingOptions,
                                          )
                                            .filter(([, enabled]) => enabled)
                                            .map(([key]) =>
                                              key.replace(/([A-Z])/g, " $1").toLowerCase(),
                                            )
                                            .join(", ") || "not listed"
                                        : "not listed"}
                                      {" · "}Restroom: {placeIntelligenceData.place.restroom ===
                                      true
                                        ? "yes"
                                        : placeIntelligenceData.place.restroom === false
                                          ? "no"
                                          : "not listed"}
                                    </p>
                                    <p>
                                      Source: Google Places · refreshed {formatRelativeTime(
                                        placeIntelligenceData.fetchedAt,
                                      )}
                                    </p>
                                  </div>
                                ) : (
                                  <p className="mt-1 text-[color:var(--text-muted)]">
                                    No provider profile matched this host yet.
                                  </p>
                                )}
                              </div>
                              <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2 text-xs">
                                <p className="font-semibold text-[color:var(--text-primary)]">
                                  Intelligence layers
                                </p>
                                <div className="mt-1 space-y-1 text-[color:var(--text-muted)]">
                                  <p>
                                    Area activity:{" "}
                                    {isScheduleFootTrafficFetching
                                      ? "loading"
                                      : typeof scheduleFootTrafficData?.cells?.length === "number"
                                        ? scheduleFootTrafficData.cells.length > 0
                                          ? spotActivitySummary
                                          : "unavailable for this schedule window"
                                        : String(
                                            intelligenceStatusData?.layers?.footTraffic?.status ||
                                              "unavailable",
                                          )}
                                  </p>
                                  <p>
                                    Gas prices: {selectedSpotGasPriceSummary}
                                  </p>
                                  <p>
                                    Propane suppliers:{" "}
                                    {supplierLayerSummary.propane}
                                  </p>
                                  <p>
                                    Restaurant supply stores:{" "}
                                    {supplierLayerSummary.supply}
                                  </p>
                                  <p>
                                    Operator-support POIs:{" "}
                                    {supplierLayerSummary.support}
                                  </p>
                                </div>
                              </div>
                              <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2 text-xs">
                                <p className="font-semibold text-[color:var(--text-primary)]">
                                  Nearest operational support
                                </p>
                                <div className="mt-1 space-y-1 text-[color:var(--text-muted)]">
                                  <p>{`Nearest gas: ${nearestOperationalSupport.gas}`}</p>
                                  <p>{`Nearest propane: ${nearestOperationalSupport.propane}`}</p>
                                  <p>{`Nearest supply: ${nearestOperationalSupport.supply}`}</p>
                                  <p>{`Nearest support: ${nearestOperationalSupport.support}`}</p>
                                </div>
                              </div>
                            </>
                          )}
                          <div className="rounded-xl pp-glass-muted p-3 text-xs text-slate-700 space-y-2">
                            <p className="text-[11px] font-semibold text-slate-700">
                              Schedule
                            </p>
                            {!selectedDateAvailable && (
                              <p className="text-[11px] text-amber-700">
                                No listing on {selectedDateLabel}. Showing the
                                next scheduled day.
                              </p>
                            )}
                            {selectedDateAvailable &&
                              !selectedDateHasOpenSpots && (
                                <p className="text-[11px] text-amber-700">
                                  Fully booked on {selectedDateLabel}. Select
                                  another date to see other days.
                                </p>
                              )}
                            <div className="flex items-center justify-between">
                              <span>Date</span>
                              {activeListingDateKeys.length > 0 ? (
                                <Popover
                                  open={datePickerOpen}
                                  onOpenChange={setDatePickerOpen}
                                >
                                  <PopoverTrigger asChild>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      className="h-8 px-2 text-[11px]"
                                    >
                                      {format(
                                        new Date(`${selectedDate}T00:00:00`),
                                        "EEE, MMM d",
                                      )}
                                    </Button>
                                  </PopoverTrigger>
                                  <PopoverContent
                                    align="end"
                                    className="w-auto p-0"
                                  >
                                    <DatePickerCalendar
                                      mode="single"
                                      selected={
                                        new Date(`${selectedDate}T00:00:00`)
                                      }
                                      onSelect={(value) => {
                                        if (!value) return;
                                        const next = format(
                                          value,
                                          "yyyy-MM-dd",
                                        );
                                        if (!activeListingDateKeySet.has(next))
                                          return;
                                        setSelectedDate(next);
                                        setDatePickerOpen(false);
                                      }}
                                      disabled={(date) => {
                                        const key = format(date, "yyyy-MM-dd");
                                        return !activeListingDateKeySet.has(
                                          key,
                                        );
                                      }}
                                      modifiers={{ full: fullListingDates }}
                                      modifiersClassNames={{
                                        full: "opacity-60",
                                      }}
                                      initialFocus
                                    />
                                  </PopoverContent>
                                </Popover>
                              ) : (
                                <span>
                                  {format(
                                    new Date(`${selectedDate}T00:00:00`),
                                    "EEE, MMM d",
                                  )}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center justify-between">
                              <span>Time</span>
                              <span>
                                {activeListing.startTime === "00:00" &&
                                activeListing.endTime === "23:59"
                                  ? "Any time"
                                  : `${activeListing.startTime} - ${activeListing.endTime}`}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span>Status</span>
                              <span className="capitalize">
                                {activeListing.status}
                              </span>
                            </div>
                            {activeListingAvailability && (
                              <div className="flex items-center justify-between">
                                <span>Availability</span>
                                <span>{activeListingAvailability}</span>
                              </div>
                            )}
                          </div>
                          {activeListingBookings.length > 0 ? (
                            <div className="rounded-xl pp-glass-muted p-3 text-xs text-slate-700 space-y-2">
                              <p className="text-[11px] font-semibold text-slate-700">
                                Booked trucks
                              </p>
                              <div className="space-y-1">
                                {activeListingBookings
                                  .slice(0, 5)
                                  .map((booking) => (
                                    <div
                                      key={`${booking.truckId}-${booking.slotType || "slot"}`}
                                      className="flex items-center justify-between"
                                    >
                                      <span>{booking.truckName}</span>
                                      <span className="text-[11px] text-[color:var(--text-muted)]">
                                        {booking.slotType
                                          ? formatSlotLabel(booking.slotType)
                                          : "Booked"}
                                        {booking.spotNumber
                                          ? ` - Spot ${booking.spotNumber}`
                                          : ""}
                                      </span>
                                    </div>
                                  ))}
                                {activeListingBookings.length > 5 && (
                                  <div className="text-[11px] text-[color:var(--text-muted)]">
                                    +{activeListingBookings.length - 5} more
                                  </div>
                                )}
                              </div>
                            </div>
                          ) : (
                            <p className="text-[11px] text-[color:var(--text-muted)]">
                              No bookings yet.
                            </p>
                          )}
                          {selectedDateAvailable && activeListingForDate ? (
                            <>
                              <div className="space-y-2">
                                <p className="text-xs font-semibold text-[color:var(--text-secondary)]">
                                  Slot pricing
                                </p>
                                <div className="grid grid-cols-2 gap-2">
                                  {buildSlotOptions(activeListingForDate).map(
                                    (slot) => {
                                      const feeCents = getFeeCentsForSlots([
                                        slot.type,
                                      ]);
                                      const totalPrice =
                                        ((slot.priceCents || 0) + feeCents) /
                                        100;
                                      const selectedSlots =
                                        selectedSlotsByListing[
                                          activeListingForDate.id
                                        ] || [];
                                      const isSelected = selectedSlots.includes(
                                        slot.type,
                                      );
                                      return (
                                        <Button
                                          key={slot.type}
                                          variant={
                                            isSelected ? "default" : "outline"
                                          }
                                          size="sm"
                                          className="justify-between"
                                          disabled={
                                            activeListingForDate.status !==
                                            "open"
                                          }
                                          onClick={() =>
                                            handleSelect(
                                              activeListingForDate,
                                              slot.type,
                                            )
                                          }
                                        >
                                          <span>{slot.label}</span>
                                          <span>${totalPrice.toFixed(2)}</span>
                                        </Button>
                                      );
                                    },
                                  )}
                                </div>
                              </div>
                              {activeListingForDate.status === "open" && (
                                <div className="flex items-center justify-between gap-3 pt-2">
                                  <p className="text-[11px] text-[color:var(--text-muted)]">
                                    Includes a $10/day MealScout fee per host.
                                    Cleanup time is 30 minutes after the end
                                    time.
                                  </p>
                                  {canStartTruckCheckout && (
                                    <LongPressHelp description="Reserve this selected slot and continue to checkout.">
                                      <Button
                                        size="sm"
                                        type="button"
                                        onClick={(event) => {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          handleBookSelected(activeListingForDate);
                                        }}
                                        disabled={
                                          (
                                            selectedSlotsByListing[
                                              activeListingForDate.id
                                            ] || []
                                          ).length === 0
                                        }
                                      >
                                        Book Spot
                                      </Button>
                                    </LongPressHelp>
                                  )}
                                </div>
                              )}
                            </>
                          ) : (
                            <p className="text-[11px] text-[color:var(--text-muted)]">
                              Pick a day with availability to view slot pricing.
                            </p>
                          )}
                        </>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </div>

              {canStartTruckCheckout && hasCartTotal && (
                <div className="fixed left-0 right-0 z-[1200] px-4 lg:hidden pointer-events-none bottom-[calc(4.75rem+env(safe-area-inset-bottom))]">
                  <div className="mx-auto max-w-md rounded-2xl pp-glass shadow-clean-lg p-3 flex items-center justify-between gap-3 pointer-events-auto">
                    <div className="min-w-0">
                      <p className="text-[11px] text-[color:var(--text-muted)]">
                        Cart ({cartItems.length})
                      </p>
                      <p className="text-base font-semibold text-slate-900">
                        ${(cartTotals.totalCents / 100).toFixed(2)}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        startCheckout();
                      }}
                    >
                      Checkout
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {selectedListing &&
          hasFoodTruckBusiness &&
          truckId &&
          selectedSlotTypes.length > 0 && (
          <BookingPaymentModal
            open={paymentOpen}
            onOpenChange={setPaymentOpen}
            passId={selectedListing.id}
            truckId={truckId}
            slotTypes={selectedSlotTypes}
            selectedDates={selectedListing?.date ? [selectedListing.date] : []}
            eventDetails={{
              name: "Parking Pass",
              date: format(new Date(selectedListing.date), "MMMM d, yyyy"),
              startTime: selectedListing.startTime,
              endTime: selectedListing.endTime,
              hostName: selectedListing.host.businessName,
              hostPrice: selectedListing.hostPriceCents,
              slotSummary: selectedSlotTypes.map(formatSlotLabel).join(", "),
            }}
            bookingContext={{
              weather: {
                loading: isBookingWeatherFetching,
                summary: isBookingWeatherFetching
                  ? "Loading weather for this booking window..."
                  : bookingWeatherData?.available
                    ? `Temp ${bookingWeatherData.temperatureF ?? "n/a"}°F · Rain ${bookingWeatherData.rainRiskPercent ?? "n/a"}% · Wind ${bookingWeatherData.windMph ?? "n/a"} mph`
                    : String(
                        bookingWeatherData?.message ||
                          "Weather forecast unavailable for this booking window.",
                      ),
              },
              footTraffic: {
                loading: isScheduleFootTrafficFetching,
                summary: isScheduleFootTrafficFetching
                  ? "Loading area activity signals..."
                  : typeof scheduleFootTrafficData?.cells?.length === "number"
                    ? scheduleFootTrafficData.cells.length > 0
                      ? `${spotActivitySummary}. This is opportunity context, not measured pedestrian traffic.`
                      : "No area activity signals detected for this schedule window"
                    : "Area activity unavailable",
              },
              truckActivity: {
                summary:
                  Array.isArray(selectedListing.bookings) &&
                  selectedListing.bookings.length > 0
                    ? `${selectedListing.bookings.length} truck(s) currently booked at this spot`
                    : "No trucks currently booked at this spot",
              },
              truckReviews: {
                summary:
                  "Truck-to-truck spot reviews are not yet available in checkout. We'll surface this here once shared report data is live.",
              },
            }}
            onSuccess={({ outcome }) => {
              handleSuccess(outcome);
            }}
          />
        )}
      </div>
    </div>
  );
}
