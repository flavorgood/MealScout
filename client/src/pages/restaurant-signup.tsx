import { useReducer, useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/useAuth";
import { GuestBusinessDraft } from "@/components/guest-business-draft";
import {
  buildGuestBusinessSignupPath,
  buildProgressiveAccountPath,
  getProgressiveAccountGate,
  getGuestBusinessDraftIntent,
  getGuestClaimPrefillValue,
  persistGuestBusinessDraft,
  shouldRestoreGuestBusinessDraft,
  preserveProgressiveAuthContext,
  resolveProgressiveBusinessSetupDestination,
} from "@shared/progressiveOnboarding";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { isUnauthorizedError } from "@/lib/authUtils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Mail,
  Eye,
  EyeOff,
  ArrowLeft,
  ArrowRight,
  Sparkles,
  Store,
  Truck,
} from "lucide-react";
import DocumentUpload from "@/components/document-upload";
import { BackHeader } from "@/components/back-header";
import { SEOHead } from "@/components/seo-head";
import {
  FUNNEL_EVENTS,
  trackFunnelEvent,
  trackFunnelEventOncePerSession,
} from "@/utils/funnelTelemetry";
import { HOST_ONBOARDING_COPY as COPY } from "@/copy/hostOnboarding.copy";
import { PASSWORD_REGEX, PASSWORD_REQUIREMENTS } from "@/utils/passwordPolicy";
import { authUrl } from "@/lib/api";
import { buildOwnerAiHref } from "@shared/ownerAiNavigation";
import {
  buildRestaurantSignupPath,
  buildRestaurantSignupContinuationPath,
  parseBusinessSignupRouteIntent,
} from "@shared/businessSignupIntent";

/**
 * Host Onboarding v1  COPY LOCK
 * User-facing strings must come from HOST_ONBOARDING_COPY.
 * No inline labels, helper text, or validation messages.
 */

const restaurantSchema = z
  .object({
    name: z.string().min(1, COPY.validation.restaurant.nameRequired),
    address: z.string().min(1, COPY.validation.restaurant.addressRequired),
    city: z.string().min(1, "City is required"),
    state: z.string().min(2, "State is required"),
    phone: z
      .string()
      .refine(
        (value) => value.replace(/\D/g, "").length >= 10,
        COPY.validation.restaurant.phoneInvalid,
      ),
    businessType: z.enum(
      ["restaurant", "bar", "food_truck", "caterer", "private_chef"],
      {
        required_error: COPY.validation.restaurant.businessTypeRequired,
      },
    ),
    confirmNotFoodTruck: z.boolean().default(false),
    cuisineType: z.string().min(1, COPY.validation.restaurant.cuisineRequired),
    description: z
      .string()
      .max(500, "Description must be less than 500 characters")
      .optional(),
    websiteUrl: z
      .string()
      .url("Must be a valid URL")
      .optional()
      .or(z.literal("")),
    instagramUrl: z
      .string()
      .url("Must be a valid URL")
      .optional()
      .or(z.literal("")),
    facebookPageUrl: z
      .string()
      .url("Must be a valid URL")
      .optional()
      .or(z.literal("")),
    hasParking: z.boolean().default(false),
    hasWifi: z.boolean().default(false),
    hasOutdoorSeating: z.boolean().default(false),
    placeEvidence: z
      .object({
        placeId: z.string().max(240).optional().nullable(),
        formattedAddress: z.string().max(500).optional().nullable(),
        latitude: z.number().min(-90).max(90).optional().nullable(),
        longitude: z.number().min(-180).max(180).optional().nullable(),
      })
      .optional()
      .nullable(),
    acceptTerms: z
      .boolean()
      .refine(
        (val) => val === true,
        COPY.validation.restaurant.acceptTermsRequired,
      ),
  })
  .superRefine((data, ctx) => {
    if (
      data.businessType !== "food_truck" &&
      data.confirmNotFoodTruck !== true
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmNotFoodTruck"],
        message: COPY.validation.restaurant.confirmNotFoodTruckRequired,
      });
    }
  });

const signupSchema = z
  .object({
    email: z.string().email(COPY.validation.signup.emailInvalid),
    firstName: z.string().min(1, COPY.validation.signup.firstNameRequired),
    lastName: z.string().min(1, COPY.validation.signup.lastNameRequired),
    phone: z
      .string()
      .refine(
        (value) => value.replace(/\D/g, "").length >= 10,
        COPY.validation.signup.phoneInvalid,
      ),
    phoneContactConsent: z.boolean().default(true),
    password: z
      .string()
      .min(1, PASSWORD_REQUIREMENTS)
      .regex(PASSWORD_REGEX, COPY.validation.signup.passwordTooShort),
    confirmPassword: z
      .string()
      .min(1, COPY.validation.signup.confirmPasswordRequired),
    acceptTerms: z
      .boolean()
      .refine(
        (val) => val === true,
        COPY.validation.restaurant.acceptTermsRequired,
      ),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: COPY.validation.signup.passwordsMismatch,
    path: ["confirmPassword"],
  });

const loginSchema = z.object({
  email: z.string().email(COPY.validation.login.emailInvalid),
  password: z.string().min(1, COPY.validation.login.passwordRequired),
});

type RestaurantFormData = z.infer<typeof restaurantSchema>;
type SignupFormData = z.infer<typeof signupSchema>;
type LoginFormData = z.infer<typeof loginSchema>;
type RestaurantSubmissionData = Omit<RestaurantFormData, "confirmNotFoodTruck">;

const normalizeListingIdentity = (value: unknown) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const isLikelySameTruckListing = (
  listing: any,
  submitted: RestaurantSubmissionData,
) => {
  const listingName = normalizeListingIdentity(listing?.name);
  const submittedName = normalizeListingIdentity(submitted.name);
  if (!listingName || listingName !== submittedName) return false;

  const listingAddress = normalizeListingIdentity(listing?.address);
  const submittedAddress = normalizeListingIdentity(submitted.address);
  if (listingAddress && listingAddress === submittedAddress) return true;

  const listingStreetNumber = listingAddress.match(/^\d+/)?.[0] || "";
  const submittedStreetNumber = submittedAddress.match(/^\d+/)?.[0] || "";
  return Boolean(
    listingStreetNumber &&
      listingStreetNumber === submittedStreetNumber &&
      normalizeListingIdentity(listing?.city) ===
        normalizeListingIdentity(submitted.city) &&
      normalizeListingIdentity(listing?.state) ===
        normalizeListingIdentity(submitted.state),
  );
};

type HostOnboardingStep = "restaurant" | "verification";

interface HostOnboardingState {
  step: HostOnboardingStep;
}

type HostOnboardingEvent =
  | { type: "GO_TO_VERIFICATION" }
  | { type: "BACK_TO_RESTAURANT" };

function assertNever(x: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(x)}`);
}

function hostOnboardingTransition(
  state: HostOnboardingState,
  event: HostOnboardingEvent,
): HostOnboardingState {
  switch (state.step) {
    case "restaurant":
      if (event.type === "GO_TO_VERIFICATION") {
        return { step: "verification" };
      }
      return state;
    case "verification":
      if (event.type === "BACK_TO_RESTAURANT") {
        return { step: "restaurant" };
      }
      return state;
    default:
      return assertNever(state as never);
  }
}

function getSafeFreeProfileErrorMessage(
  message: string | undefined,
  fallback: string,
): string {
  const normalized = String(message || "").trim();
  if (!normalized) return fallback;

  const lower = normalized.toLowerCase();
  if (
    lower.includes("zoderror") ||
    lower.includes("invalid_type") ||
    lower.includes("received undefined") ||
    lower.includes('path: ["password"]') ||
    lower.includes("expected: string")
  ) {
    return "Please complete the required fields.";
  }

  return normalized;
}

const BLANK_RESTAURANT_FORM_VALUES: RestaurantFormData = {
  name: "",
  address: "",
  city: "",
  state: "",
  phone: "",
  businessType: "restaurant",
  confirmNotFoodTruck: false,
  cuisineType: "",
  description: "",
  websiteUrl: "",
  instagramUrl: "",
  facebookPageUrl: "",
  hasParking: false,
  hasWifi: false,
  hasOutdoorSeating: false,
  placeEvidence: null,
  acceptTerms: false,
};

const SIGNUP_TERMS_ACCEPTANCE_KEY =
  "mealscout:restaurant-signup-accepted-terms";
const RESTAURANT_ONBOARDING_ATTEMPT_KEY =
  "mealscout:restaurant-onboarding-attempt-id";

function createOnboardingAttemptId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

function getOrCreateOnboardingAttemptId() {
  if (typeof window === "undefined") return createOnboardingAttemptId();
  try {
    const stored = String(
      window.localStorage.getItem(RESTAURANT_ONBOARDING_ATTEMPT_KEY) || "",
    ).trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored)) {
      return stored;
    }
    const created = createOnboardingAttemptId();
    window.localStorage.setItem(RESTAURANT_ONBOARDING_ATTEMPT_KEY, created);
    return created;
  } catch {
    return createOnboardingAttemptId();
  }
}

function getStoredSignupTermsAccepted() {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.sessionStorage.getItem(SIGNUP_TERMS_ACCEPTANCE_KEY) === "true"
    );
  } catch {
    return false;
  }
}

function setStoredSignupTermsAccepted(accepted: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (accepted) {
      window.sessionStorage.setItem(SIGNUP_TERMS_ACCEPTANCE_KEY, "true");
    } else {
      window.sessionStorage.removeItem(SIGNUP_TERMS_ACCEPTANCE_KEY);
    }
  } catch {
    // Legal-gate carryover is a convenience for the same session only.
  }
}

export default function RestaurantSignup() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user, isAuthenticated, isLoading } = useAuth();
  const queryClient = useQueryClient();
  const [authMode, setAuthMode] = useState<"signup" | "login">("signup");
  const [accountRequested, setAccountRequested] = useState(
    () => new URLSearchParams(window.location.search).get("keepDraft") === "1",
  );
  const signupRouteIntent = useMemo(
    () => parseBusinessSignupRouteIntent(window.location.search),
    [],
  );
  const currentClaimDraftListingIdRef = useRef(signupRouteIntent.passthrough.claimListingId || "");
  const signupAuthContext = useMemo(() => new URLSearchParams(window.location.search), []);
  const continuationPath = preserveProgressiveAuthContext(
    buildRestaurantSignupContinuationPath(getGuestBusinessDraftIntent(signupRouteIntent, currentClaimDraftListingIdRef.current)),
    signupAuthContext,
  );
  const isFoodTruckRoute = signupRouteIntent.businessType === "food_truck";
  const isMissingListingFlow =
    isFoodTruckRoute &&
    signupRouteIntent.intent === "create" &&
    signupRouteIntent.passthrough.claimMode === "missing";
  const createTruckProfilePath = buildRestaurantSignupPath({
    businessType: "food_truck",
    intent: "create",
    source: signupRouteIntent.source || "restaurant-signup",
  });
  const routePresentation = isFoodTruckRoute
    ? COPY.routePresentation.foodTruck
    : COPY.routePresentation.restaurant;
  const unauthHero = isFoodTruckRoute
    ? signupRouteIntent.isClaim
      ? COPY.routePresentation.foodTruck.claimHero
      : COPY.routePresentation.foodTruck.createHero
    : COPY.routePresentation.restaurant.hero;

  // Redirect admin/staff away from this flow to their dashboard
  useEffect(() => {
    if (!isAuthenticated || !user) return;
    if (
      user.userType === "admin" ||
      user.userType === "duper_admin" ||
      user.userType === "super_admin" ||
      user.userType === "staff"
    ) {
      setLocation("/restaurant-owner-dashboard");
    }
  }, [isAuthenticated, user, setLocation]);

  // Logged-out visitors stay on this page so they can lead with the
  // "import from your website" step, which prefills the business profile
  // draft before they create an account. Account creation still happens here
  // via the signup form; the imported details persist in the restaurant draft
  // (RESTAURANT_DRAFT_KEY) and are applied once the owner returns authenticated
  // and verified. The restaurant itself is created on that authenticated
  // submit (the server ignores restaurant data for unauthenticated signups).

  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [claimQuery, setClaimQuery] = useState("");
  const [claimResults, setClaimResults] = useState<any[]>([]);
  const [claimLoading, setClaimLoading] = useState(false);
  const [claimSelection, setClaimSelection] = useState<any | null>(null);
  const [claimError, setClaimError] = useState("");
  const [claimRequestingId, setClaimRequestingId] = useState<string | null>(
    null,
  );
  const [claimAutoSearch, setClaimAutoSearch] = useState(false);
  const [claimSearchCompleted, setClaimSearchCompleted] = useState(false);
  const [pendingClaimListingId, setPendingClaimListingId] = useState(() =>
    signupRouteIntent.isClaim
      ? signupRouteIntent.passthrough.claimListingId || ""
      : "",
  );
  const claimSearchVersion = useRef(0);
  const invalidateClaimSearch = useCallback(() => {
    claimSearchVersion.current += 1;
    setClaimSelection(null);
    setClaimResults([]);
    setClaimError("");
    setClaimSearchCompleted(false);
    setClaimLoading(false);
  }, []);
  const [licenseNumber, setLicenseNumber] = useState("");
  const [websiteImportLoading, setWebsiteImportLoading] = useState(false);
  const [importedFields, setImportedFields] = useState<string[]>([]);
  const [onboardingState, dispatchOnboarding] = useReducer(
    hostOnboardingTransition,
    {
      step: "restaurant",
    } as HostOnboardingState,
  );
  const [createdRestaurant, setCreatedRestaurant] = useState<any>(null);
  const [onboardingAttemptId, setOnboardingAttemptId] = useState(
    getOrCreateOnboardingAttemptId,
  );
  const rotateOnboardingAttemptId = () => {
    const nextAttemptId = createOnboardingAttemptId();
    setOnboardingAttemptId(nextAttemptId);
    try {
      window.localStorage.setItem(
        RESTAURANT_ONBOARDING_ATTEMPT_KEY,
        nextAttemptId,
      );
    } catch {
      // The in-memory attempt remains safe for this page session.
    }
  };
  const [verificationDocuments, setVerificationDocuments] = useState<string[]>(
    [],
  );
  const currentStep: HostOnboardingStep = onboardingState.step;

  const RESTAURANT_DRAFT_KEY = "mealscout:restaurant-signup-draft";
  const MENU_IMPORT_DRAFT_KEY = "mealscout:menu-import-draft";
  const RESTAURANT_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const [restoredDraftAt, setRestoredDraftAt] = useState<Date | null>(null);

  const menuSourceUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    try {
      const stored = window.localStorage.getItem(RESTAURANT_DRAFT_KEY);
      if (!stored) return "";
      const parsed = JSON.parse(stored) as {
        menuSourceUrl?: string;
        businessType?: string;
      };
      if (
        !shouldRestoreGuestBusinessDraft(signupRouteIntent, parsed)
      ) {
        return "";
      }
      return String(parsed.menuSourceUrl || "").trim();
    } catch {
      return "";
    }
  }, [
    signupRouteIntent.businessType,
    signupRouteIntent.hasExplicitBusinessType,
    signupRouteIntent.isClaim,
  ]);

  const persistMenuImportDraft = (restaurantId?: string | null) => {
    if (typeof window === "undefined") return;
    if (!menuSourceUrl && !restaurantId) return;
    try {
      window.localStorage.setItem(
        MENU_IMPORT_DRAFT_KEY,
        JSON.stringify({
          sourceUrl: menuSourceUrl,
          restaurantId: restaurantId || createdRestaurant?.id || null,
          createdAt: new Date().toISOString(),
        }),
      );
    } catch {
      // Menu import source is a convenience; never block onboarding.
    }
  };

  const restoredGuestDraftRef = useRef<Record<string, unknown> | null>(null);
  const restaurantDefaultValues = useMemo<RestaurantFormData>(() => {
    const base: RestaurantFormData = {
      ...BLANK_RESTAURANT_FORM_VALUES,
      businessType: signupRouteIntent.businessType,
    };

    if (typeof window === "undefined") return base;

    try {
      const stored = window.localStorage.getItem(RESTAURANT_DRAFT_KEY);
      if (!stored) return base;
      const parsed = JSON.parse(stored) as Partial<RestaurantFormData> & {
        __savedAt?: number;
        __guestClaim?: unknown;
      };
      const savedAt = parsed.__savedAt;
      if (
        typeof savedAt === "number" &&
        Date.now() - savedAt > RESTAURANT_DRAFT_MAX_AGE_MS
      ) {
        // Stale draft (older than a week) — don't silently prefill with
        // data the owner probably doesn't remember entering.
        window.localStorage.removeItem(RESTAURANT_DRAFT_KEY);
        return base;
      }
      const { __savedAt, __guestClaim, ...draftFields } = parsed;
      if (
        !shouldRestoreGuestBusinessDraft(signupRouteIntent, parsed)
      ) {
        return base;
      }
      if (signupRouteIntent.isClaim) restoredGuestDraftRef.current = parsed;
      return {
        ...base,
        ...draftFields,
        // Explicit route intent wins before telemetry/first paint; a generic
        // resume keeps the owner's valid in-progress business type.
        businessType: signupRouteIntent.hasExplicitBusinessType
          ? signupRouteIntent.businessType
          : draftFields.businessType || "restaurant",
      };
    } catch {
      return base;
    }
  }, [
    signupRouteIntent.businessType,
    signupRouteIntent.hasExplicitBusinessType,
    signupRouteIntent.isClaim,
  ]);

  // Let the owner know their in-progress details were restored, rather than
  // silently prefilling a form they may not remember filling out before.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(RESTAURANT_DRAFT_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as { __savedAt?: number };
      if (typeof parsed.__savedAt === "number") {
        setRestoredDraftAt(new Date(parsed.__savedAt));
      }
    } catch {
      // ignore
    }
    // Only check once on mount; the draft is re-saved continuously after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const form = useForm<RestaurantFormData>({
    resolver: zodResolver(restaurantSchema),
    defaultValues: restaurantDefaultValues,
  });

  const signupForm = useForm<SignupFormData>({
    resolver: zodResolver(signupSchema),
    defaultValues: {
      email: "",
      firstName: "",
      lastName: "",
      phone: "",
      phoneContactConsent: true,
      password: "",
      confirmPassword: "",
      acceptTerms: getStoredSignupTermsAccepted(),
    },
  });

  const loginForm = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  const selectedBusinessType = form.watch("businessType");
  useEffect(() => {
    invalidateClaimSearch();
    return () => { claimSearchVersion.current += 1; };
  }, [user?.id, isAuthenticated, selectedBusinessType, invalidateClaimSearch]);
  const ownerAiSetupHref = useMemo(
    () =>
      buildOwnerAiHref({
        restaurantId: createdRestaurant?.id,
        source: "onboarding",
        focus:
          selectedBusinessType === "food_truck"
            ? "schedule"
            : selectedBusinessType === "restaurant"
              ? "menu"
              : "all",
        menuSource: menuSourceUrl,
      }),
    [createdRestaurant?.id, menuSourceUrl, selectedBusinessType],
  );
  const signupAcceptedTerms = signupForm.watch("acceptTerms");
  const mainHero =
    selectedBusinessType === "food_truck"
      ? COPY.main.hero.foodTruck
      : COPY.main.hero.restaurant;
  const profileNotification =
    selectedBusinessType === "food_truck"
      ? COPY.notifications.foodTruck
      : COPY.notifications.restaurant;

  useEffect(() => {
    // Allow deep links like `/restaurant-signup?businessType=food_truck&claim=1`
    // so a user can go straight into the claim flow after creating an account.
    try {
      const params = new URLSearchParams(window.location.search);
      if (signupRouteIntent.isClaim || isMissingListingFlow) {
        const q = String(params.get("q") || "").trim();
        if (q) {
          setClaimQuery(q);
        }
        if (q || signupRouteIntent.passthrough.claimListingId) {
          setClaimAutoSearch(true);
        }

        const prefillName = String(params.get("prefillName") || "").trim();
        const prefillAddress = String(
          params.get("prefillAddress") || "",
        ).trim();
        const prefillCity = String(params.get("prefillCity") || "").trim();
        const prefillState = String(params.get("prefillState") || "").trim();
        const prefillPlaceId = String(
          params.get("prefillPlaceId") || "",
        ).trim();
        const prefillLatitudeRaw = String(params.get("prefillLat") || "").trim();
        const prefillLongitudeRaw = String(
          params.get("prefillLng") || "",
        ).trim();
        const prefillLatitude = prefillLatitudeRaw
          ? Number(prefillLatitudeRaw)
          : null;
        const prefillLongitude = prefillLongitudeRaw
          ? Number(prefillLongitudeRaw)
          : null;

        for (const [field, value] of [["name", prefillName], ["address", prefillAddress], ["city", prefillCity], ["state", prefillState]] as const) {
          if (value) form.setValue(field, getGuestClaimPrefillValue(signupRouteIntent, restoredGuestDraftRef.current, form.getValues(field), value));
        }
        if (
          prefillPlaceId ||
          prefillAddress ||
          (typeof prefillLatitude === "number" &&
            Number.isFinite(prefillLatitude) &&
            typeof prefillLongitude === "number" &&
            Number.isFinite(prefillLongitude))
        ) {
          form.setValue("placeEvidence", {
            placeId: prefillPlaceId || null,
            formattedAddress: prefillAddress || null,
            latitude:
              typeof prefillLatitude === "number" &&
              Number.isFinite(prefillLatitude)
              ? prefillLatitude
              : null,
            longitude:
              typeof prefillLongitude === "number" &&
              Number.isFinite(prefillLongitude)
              ? prefillLongitude
              : null,
          });
        }
        window.setTimeout(() => {
          const input = document.querySelector<HTMLInputElement>(
            '[data-testid="input-claim-search"]',
          );
          input?.focus();
        }, 250);
      }
    } catch {
      // ignore
    }
  }, [
    form,
    isMissingListingFlow,
    signupRouteIntent.isClaim,
    signupRouteIntent.passthrough.claimListingId,
  ]);

  useEffect(() => {
    trackFunnelEventOncePerSession(
      FUNNEL_EVENTS.activationStarted,
      `restaurant_signup_view:${selectedBusinessType}:${signupRouteIntent.intent}`,
      {
        page: "restaurant-signup",
        stage: "business_onboarding_view",
        businessType: selectedBusinessType,
        authMode,
        intent: signupRouteIntent.intent,
        source: signupRouteIntent.source,
      },
    );
  }, [
    selectedBusinessType,
    authMode,
    signupRouteIntent.intent,
    signupRouteIntent.source,
  ]);

  useEffect(() => {
    if (selectedBusinessType !== "food_truck" && claimSelection) {
      setClaimSelection(null);
      setClaimResults([]);
      setClaimQuery("");
      setClaimError("");
    }
  }, [selectedBusinessType, claimSelection]);

  useEffect(() => {
    if (selectedBusinessType === "food_truck") {
      form.setValue("confirmNotFoodTruck", false);
      form.setValue("hasParking", false);
      form.setValue("hasWifi", false);
      form.setValue("hasOutdoorSeating", false);
    }
  }, [selectedBusinessType, form]);

  // Persist restaurant business details so owners can resume onboarding
  useEffect(() => {
    const subscription = form.watch((value) => {
      try {
        persistGuestBusinessDraft(() => window.localStorage, value, Date.now(), getGuestBusinessDraftIntent(signupRouteIntent, currentClaimDraftListingIdRef.current));
      } catch {
        // ignore storage errors
      }
    });
    return () => subscription.unsubscribe();
  }, [form, signupRouteIntent]);

  useEffect(() => {
    const subscription = signupForm.watch((value, info) => {
      if (info.name !== "acceptTerms") return;
      setStoredSignupTermsAccepted(value.acceptTerms === true);
    });
    return () => subscription.unsubscribe();
  }, [signupForm]);

  useEffect(() => {
    if (!isAuthenticated || form.getValues("acceptTerms")) return;
    if (!getStoredSignupTermsAccepted()) return;
    form.setValue("acceptTerms", true, { shouldValidate: true });
  }, [form, isAuthenticated]);

  const signupMutation = useMutation({
    mutationFn: async (data: SignupFormData) => {
      const { confirmPassword, ...signupData } = data;
      const res = await apiRequest(
        "POST",
        "/api/auth/restaurant/register",
        {
          ...signupData,
          businessType: signupRouteIntent.businessType,
          intendedNextPath: continuationPath,
        },
      );
      return await res.json();
    },
    onSuccess: async (payload: any) => {
      toast({
        title: "Verify your email",
        description:
          payload?.message ||
          "We sent a verification link to your email. Verify it, then log in to continue.",
      });
      try {
        window.sessionStorage.setItem(
          "mealscout:lastSignupEmail",
          signupForm.getValues("email") || "",
        );
      } catch {}
      window.location.href = `/login?redirect=${encodeURIComponent(
        continuationPath,
      )}&signup=1`;
    },
    onError: (error) => {
      toast({
        title: COPY.notifications.signup.errorTitle,
        description: getSafeFreeProfileErrorMessage(
          error.message,
          COPY.notifications.signup.errorDescription,
        ),
        variant: "destructive",
      });
    },
  });

  const loginMutation = useMutation({
    mutationFn: async (data: LoginFormData) => {
      // Existing diners can legitimately create or claim a truck; profile
      // success, not login, is where their business role is synchronized.
      return await apiRequest("POST", "/api/auth/restaurant/login", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
      toast({
        title: COPY.notifications.login.successTitle,
        description: COPY.notifications.login.successDescription,
      });
      // Continue with the exact safe create/claim route after auth refresh.
      window.location.href = continuationPath;
    },
    onError: (error) => {
      toast({
        title: COPY.notifications.login.errorTitle,
        description: error.message || COPY.notifications.login.errorDescription,
        variant: "destructive",
      });
    },
  });

  const createRestaurantMutation = useMutation({
    mutationFn: async (data: RestaurantSubmissionData) => {
      if (claimSelection && data.businessType === "food_truck") {
        const res = await apiRequest("POST", "/api/truck-claims", {
          listingId: claimSelection.id,
          restaurantData: data,
        });
        const payload = await res.json();
        return {
          restaurant: payload?.restaurant || payload,
          created: payload?.created === true,
          completionKind: "claim" as const,
        };
      }
      // The restaurant payload is identical either way; only userData
      // differs between an already-authenticated owner and a brand new
      // signup. Building it once here avoids the two branches drifting.
      const restaurantData = {
        onboardingAttemptId,
        name: data.name,
        address: data.address,
        city: data.city,
        state: data.state,
        phone: data.phone,
        businessType: data.businessType,
        cuisineType: data.cuisineType,
        description: data.description,
        websiteUrl: data.websiteUrl,
        instagramUrl: data.instagramUrl,
        facebookPageUrl: data.facebookPageUrl,
        acceptTerms: data.acceptTerms,
        amenities: {
          parking: data.hasParking,
          wifi: data.hasWifi,
          outdoor_seating: data.hasOutdoorSeating,
        },
        placeEvidence: data.placeEvidence || null,
      };

      const signupData = signupForm.getValues();
      const requestData = isAuthenticated && user
        ? {
            userData: {
              email: user.email,
              firstName: user.firstName,
              lastName: user.lastName,
              phone: user.phone || data.phone, // Use restaurant phone if user doesn't have one
              // No password needed for authenticated users
            },
            restaurantData,
          }
        : {
            userData: {
              email: signupData.email,
              firstName: signupData.firstName,
              lastName: signupData.lastName,
              phone: signupData.phone,
              phoneContactConsent: signupData.phoneContactConsent,
              password: signupData.password,
            },
            restaurantData,
          };

      const res = await apiRequest(
        "POST",
        "/api/restaurants/signup",
        requestData,
      );
      const payload = await res.json();
      return {
        restaurant: payload?.restaurant || payload,
        created: payload?.created === true,
        completionKind: "create" as const,
      };
    },
    onSuccess: async (result: any) => {
      const restaurant = result?.restaurant;
      const created = result?.created === true;
      if (restaurant?.requiresEmailVerification) {
        toast({
          title: "Verify your email",
          description:
            restaurant?.message ||
            "We sent a verification link to your email. Verify it, then log in to continue.",
        });
        try {
          window.sessionStorage.setItem(
            "mealscout:lastSignupEmail",
            signupForm.getValues("email") || "",
          );
        } catch {}
        window.location.href = `/login?redirect=${encodeURIComponent(
          continuationPath,
        )}&signup=1`;
        return;
      }

      // A claim or profile promotion changes the server's role and scoped
      // business access. Refresh even inactive caches before the SPA handoff;
      // the mutation response itself must not grant client-side permissions.
      // Read failures stay stale for normal query recovery and must not turn
      // an already committed claim into a failed, retryable write.
      await Promise.all(
        ["/api/auth/user", "/api/business-access/me", "/api/restaurants/my-restaurants"].map(
          (key) => queryClient.invalidateQueries({ queryKey: [key], exact: true, refetchType: "all" }),
        ),
      );

      trackFunnelEvent(FUNNEL_EVENTS.activationStarted, {
        page: "restaurant-signup",
        stage: "restaurant_profile_ready",
        businessType: selectedBusinessType,
        created,
        completionKind: result?.completionKind || null,
      });

      if (
        created &&
        selectedBusinessType === "food_truck" &&
        restaurant?.id &&
        restaurant?.ownerId &&
        restaurant.ownerId === user?.id
      ) {
        trackFunnelEvent(FUNNEL_EVENTS.signupCompleted, {
          page: "restaurant-signup",
          stage: "owner_linked_truck_profile_completed",
          businessType: "food_truck",
          intent: signupRouteIntent.intent,
          source: signupRouteIntent.source,
          completionKind: result?.completionKind || null,
        });
      }

      setStoredSignupTermsAccepted(false);
      try {
        // The imported/entered business details have now been saved to the
        // restaurant profile, so drop the local draft to avoid stale prefill
        // on a future signup.
        window.localStorage.removeItem(RESTAURANT_DRAFT_KEY);
        window.localStorage.removeItem(RESTAURANT_ONBOARDING_ATTEMPT_KEY);
      } catch {}
      setCreatedRestaurant(restaurant);
      dispatchOnboarding({ type: "GO_TO_VERIFICATION" });
      toast({
        title: profileNotification.successTitle,
        description: profileNotification.successDescription,
      });
    },
    onError: (error) => {
      if (
        String(error.message || "").includes(
          "Onboarding attempt belongs to a different owner",
        )
      ) {
        rotateOnboardingAttemptId();
      }
      if (isUnauthorizedError(error)) {
        toast({
          title: profileNotification.unauthorizedTitle,
          description:
            error.message ||
            profileNotification.unauthorizedDescription,
          variant: "destructive",
        });
        setTimeout(() => {
          const oauthParams = new URLSearchParams({
            userType: isFoodTruckRoute ? "food_truck" : "restaurant_owner",
            redirect: continuationPath,
          });
          window.location.href = authUrl(
            `/api/auth/google/restaurant?${oauthParams.toString()}`,
          );
        }, 500);
        return;
      }
      toast({
        title: profileNotification.errorTitle,
        description: getSafeFreeProfileErrorMessage(
          error.message,
          profileNotification.errorDescription,
        ),
        variant: "destructive",
      });
    },
  });

  const createVerificationRequestMutation = useMutation({
    mutationFn: async () => {
      if (!createdRestaurant || verificationDocuments.length === 0) {
        throw new Error("Restaurant or documents missing");
      }
      return await apiRequest(
        "POST",
        `/api/restaurants/${createdRestaurant.id}/verification/request`,
        {
          documents: verificationDocuments,
          licenseNumber:
            selectedBusinessType === "food_truck" &&
            (createdRestaurant as any)?.claimedFromImportId
              ? licenseNumber.trim()
              : undefined,
        },
      );
    },
    onSuccess: () => {
      trackFunnelEvent(FUNNEL_EVENTS.activationStarted, {
        page: "restaurant-signup",
        stage: "verification_submitted",
        businessType: selectedBusinessType,
      });

      persistMenuImportDraft(createdRestaurant?.id || null);
      toast({
        title: COPY.notifications.verification.successTitle,
        description: COPY.notifications.verification.successDescription,
      });
      setLocation(resolveProgressiveBusinessSetupDestination(signupAuthContext, ownerAiSetupHref, createdRestaurant?.id));
    },
    onError: (error) => {
      toast({
        title: COPY.notifications.verification.errorTitle,
        description:
          error.message || COPY.notifications.verification.errorDescription,
        variant: "destructive",
      });
    },
  });

  const onSubmit = async (data: RestaurantFormData) => {
    const accountGate = getProgressiveAccountGate(user);
    if (accountGate !== "continue") {
      const currentIntent = getGuestBusinessDraftIntent(signupRouteIntent, currentClaimDraftListingIdRef.current);
      if (!persistGuestBusinessDraft(() => window.localStorage, form.getValues(), Date.now(), currentIntent)) {
        toast({ title: COPY.guestDraft.storageErrorTitle, description: COPY.guestDraft.storageErrorDescription, variant: "destructive" });
        return;
      }
      window.location.href = buildProgressiveAccountPath(accountGate, "keep_draft", buildGuestBusinessSignupPath(currentIntent, data.businessType, signupAuthContext));
      return;
    }
    const { confirmNotFoodTruck, ...restaurantData } = data;

    if (signupRouteIntent.isClaim && !claimSelection) {
      setClaimError(COPY.forms.restaurant.claimSelectionRequiredDescription);
      toast({
        title: COPY.forms.restaurant.claimSelectionRequiredTitle,
        description:
          COPY.forms.restaurant.claimSelectionRequiredDescription,
        variant: "destructive",
      });
      window.setTimeout(() => {
        document
          .querySelector<HTMLInputElement>(
            '[data-testid="input-claim-search"]',
          )
          ?.focus();
      }, 0);
      return;
    }

    if (isMissingListingFlow) {
      const matchingListingExists = claimResults.some((listing) =>
        isLikelySameTruckListing(listing, restaurantData),
      );
      if (!claimSearchCompleted || claimLoading || matchingListingExists) {
        setClaimError(
          matchingListingExists
            ? COPY.forms.restaurant.claimRegistryMatchDescription
            : COPY.forms.restaurant.claimRegistryCheckDescription,
        );
        toast({
          title: matchingListingExists
            ? COPY.forms.restaurant.claimRegistryMatchTitle
            : COPY.forms.restaurant.claimRegistryCheckTitle,
          description: matchingListingExists
            ? COPY.forms.restaurant.claimRegistryMatchDescription
            : COPY.forms.restaurant.claimRegistryCheckDescription,
          variant: "destructive",
        });
        window.setTimeout(() => {
          document
            .querySelector<HTMLInputElement>(
              '[data-testid="input-claim-search"]',
            )
            ?.focus();
        }, 0);
        return;
      }
    }

    trackFunnelEvent(FUNNEL_EVENTS.signupSubmitted, {
      page: "restaurant-signup",
      stage: "restaurant_onboarding_submit",
      businessType: selectedBusinessType,
      authMode,
      isAuthenticated,
      intent: signupRouteIntent.intent,
      source: signupRouteIntent.source,
    });

    try {
      await createRestaurantMutation.mutateAsync(restaurantData);
    } catch (error: any) {
      console.error("Error in restaurant signup:", error);
      // Error handling is already done in the mutation
    }
  };

  const handleRestaurantInvalid = (errors: Record<string, any>) => {
    const firstError = Object.values(errors)[0] as any;
    toast({
      title: "Check the form",
      description: firstError?.message || "Please fix the highlighted fields.",
      variant: "destructive",
    });
  };

  const handleVerificationSubmit = () => {
    if (verificationDocuments.length === 0) {
      toast({
        title: COPY.notifications.verification.missingDocsTitle,
        description: COPY.notifications.verification.missingDocsDescription,
        variant: "destructive",
      });
      return;
    }
    if (
      selectedBusinessType === "food_truck" &&
      (createdRestaurant as any)?.claimedFromImportId &&
      !licenseNumber.trim()
    ) {
      toast({
        title: "License number required",
        description:
          "Enter the license number from your document to verify this imported truck.",
        variant: "destructive",
      });
      return;
    }
    createVerificationRequestMutation.mutate();
  };

  const handleSkipVerification = () => {
    persistMenuImportDraft(createdRestaurant?.id || null);
    toast({
      title: COPY.notifications.verification.skippedTitle,
      description: COPY.notifications.verification.skippedDescription,
    });
    setLocation(resolveProgressiveBusinessSetupDestination(signupAuthContext, ownerAiSetupHref, createdRestaurant?.id));
  };

  const isAutoBusinessVerified = Boolean(
    createdRestaurant?.isVerified &&
    (createdRestaurant as any)?.claimedFromImportId &&
    selectedBusinessType === "food_truck",
  );

  const handleRequestTruck = async (listingId: string) => {
    setClaimRequestingId(listingId);
    setClaimError("");
    try {
      const res = await apiRequest("POST", "/api/truck-claims/request", {
        listingId,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || "Failed to send reminder");
      }
      toast({
        title: "Setup request received",
        description:
          data?.message ||
          "If setup can be sent for this listing, the owner will receive it.",
      });
    } catch (error: any) {
      setClaimError(error.message || COPY.forms.restaurant.claimNoResults);
    } finally {
      setClaimRequestingId(null);
    }
  };

  const [claimDisputingId, setClaimDisputingId] = useState<string | null>(
    null,
  );

  // "Request this truck" only re-notifies whoever is already on file as the
  // invited owner, which is a dead end for a legitimate owner when that
  // invite is stale or wrong. This routes them to a human via the existing
  // support ticket system instead of leaving no path forward.
  const handleDisputeClaim = async (listing: any) => {
    if (!isAuthenticated) {
      toast({
        title: "Create your account first",
        description:
          "Finish creating your MealScout account below, then come back to dispute this claim so we know who to follow up with.",
      });
      return;
    }
    setClaimDisputingId(listing.id);
    setClaimError("");
    try {
      const res = await apiRequest("POST", "/api/support/tickets", {
        subject: `Truck claim dispute: ${listing.name || listing.id}`,
        description: `I searched for "${listing.name || listing.id}" (listing ${listing.id}) while trying to claim my food truck on MealScout, but it already has an invited owner on file. I believe that's incorrect and I'm the actual owner. Please review and reassign.`,
        category: "business_profile",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Failed to submit dispute");
      }
      toast({
        title: "Sent to MealScout support",
        description:
          "We'll review this claim and follow up by email. This usually takes 1 business day.",
      });
    } catch (error: any) {
      setClaimError(error.message || "Failed to submit dispute. Please try again.");
    } finally {
      setClaimDisputingId(null);
    }
  };

  const handleClaimSearch = async () => {
    const query = claimQuery.trim();
    const claimListingId = signupRouteIntent.isClaim
      ? pendingClaimListingId
      : "";
    invalidateClaimSearch();
    const version = claimSearchVersion.current;
    if (!query && !claimListingId) {
      return;
    }

    setClaimLoading(true);
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (claimListingId) params.set("listingId", claimListingId);
      const res = await apiRequest(
        "GET",
        `/api/truck-claims/search?${params.toString()}`,
      );
      const data = await res.json();
      if (version !== claimSearchVersion.current) return;
      const rows = Array.isArray(data) ? data : [];
      setClaimResults(rows);
      setClaimSearchCompleted(true);

      if (claimListingId) {
        // The route-carried exact ID is a one-time authenticated handoff.
        // Manual recovery searches must use the owner's current query.
        setPendingClaimListingId("");
        const exactListing = rows.find(
          (listing: any) => String(listing?.id || "") === claimListingId,
        );
        if (!exactListing || exactListing.canClaim === false) {
          setClaimSelection(null);
          setClaimError(COPY.forms.restaurant.claimUnavailable);
          return;
        }
        currentClaimDraftListingIdRef.current = String(exactListing.id);
        setClaimSelection(exactListing);
        setClaimResults([]);
        setClaimQuery(exactListing.externalId || exactListing.name || query);
        for (const field of ["name", "address", "city", "state", "phone"] as const) {
          form.setValue(field, getGuestClaimPrefillValue(signupRouteIntent, restoredGuestDraftRef.current, form.getValues(field), String(exactListing[field] || ""), String(exactListing.id)));
        }
        return;
      }

      if (rows.length === 0) {
        setClaimError(
          isMissingListingFlow
            ? COPY.forms.restaurant.claimMissingNoResults
            : COPY.forms.restaurant.claimNoResults,
        );
      }
    } catch (error: any) {
      if (version === claimSearchVersion.current) {
        setClaimSearchCompleted(false);
        setClaimError(error.message || COPY.forms.restaurant.claimNoResults);
      }
    } finally {
      if (version === claimSearchVersion.current) setClaimLoading(false);
    }
  };

  useEffect(() => {
    if (!claimAutoSearch) return;
    if (!isAuthenticated) return;
    if (selectedBusinessType !== "food_truck") return;
    if (
      !claimQuery.trim() &&
      !pendingClaimListingId
    ) {
      return;
    }
    setClaimAutoSearch(false);
    void handleClaimSearch();
  }, [
    claimAutoSearch,
    isAuthenticated,
    selectedBusinessType,
    claimQuery,
    pendingClaimListingId,
  ]);

  const applyClaimSelection = (listing: any) => {
    if (listing?.canClaim === false) {
      setClaimError(
        'This truck already has an invited owner. Use "Request this truck" to notify them to finish setup.',
      );
      return;
    }
    // Update before setValue emits synchronous autosave notifications.
    currentClaimDraftListingIdRef.current = String(listing.id);
    setClaimSelection(listing);
    setClaimResults([]);
    setClaimQuery(listing.externalId || listing.name || "");
    for (const field of ["name", "address", "city", "state", "phone"] as const) {
      form.setValue(field, getGuestClaimPrefillValue(signupRouteIntent, restoredGuestDraftRef.current, form.getValues(field), String(listing[field] || ""), String(listing.id)));
    }
  };

  const handleWebsiteImport = async () => {
    const url = form.getValues("websiteUrl")?.trim();
    if (!url) {
      toast({
        title: "Add your website first",
        description:
          "Paste your website link into the Website field, then try again.",
        variant: "destructive",
      });
      return;
    }

    setWebsiteImportLoading(true);
    try {
      const res = await apiRequest("POST", "/api/restaurants/import-from-url", {
        url,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || "Couldn't read that website.");
      }

      const filled: string[] = [];
      const fillIfEmpty = (
        field: keyof RestaurantFormData,
        value: string | undefined,
        label: string,
      ) => {
        if (!value) return;
        if (form.getValues(field)) return;
        form.setValue(field, value);
        filled.push(label);
      };

      fillIfEmpty("name", data.name, "business name");
      fillIfEmpty("description", data.description, "description");
      fillIfEmpty("phone", data.phone, "phone");
      fillIfEmpty("address", data.address, "address");
      fillIfEmpty("city", data.city, "city");
      fillIfEmpty("state", data.state, "state");
      fillIfEmpty("instagramUrl", data.instagramUrl, "Instagram");
      fillIfEmpty("facebookPageUrl", data.facebookPageUrl, "Facebook");
      setImportedFields(filled);

      toast({
        title: filled.length
          ? "Filled in from your website"
          : "Nothing new to fill in",
        description: filled.length
          ? "Review what we found below and adjust anything before submitting."
          : "We couldn't find extra details on that page, or every field is already filled in.",
      });
    } catch (error: any) {
      toast({
        title: "Couldn't read that website",
        description:
          error.message || "You can still fill in the details manually.",
        variant: "destructive",
      });
    } finally {
      setWebsiteImportLoading(false);
    }
  };

  const onSignup = (data: SignupFormData) => {
    trackFunnelEvent(FUNNEL_EVENTS.signupSubmitted, {
      page: "restaurant-signup",
      stage: "owner_account_submit",
      businessType: signupRouteIntent.businessType,
      intent: signupRouteIntent.intent,
      source: signupRouteIntent.source,
    });
    signupMutation.mutate(data);
  };

  const onLogin = (data: LoginFormData) => {
    loginMutation.mutate(data);
  };

  const handleSignupInvalid = (errors: Record<string, any>) => {
    const firstError = Object.values(errors)[0] as any;
    toast({
      title: "Check the form",
      description: firstError?.message || "Please fix the highlighted fields.",
      variant: "destructive",
    });
  };

  const handleGoogleSignup = () => {
    if (authMode === "signup" && !signupForm.getValues("acceptTerms")) {
      signupForm.setError("acceptTerms", {
        type: "manual",
        message: COPY.validation.restaurant.acceptTermsRequired,
      });
      toast({
        title: "Check the form",
        description: COPY.validation.restaurant.acceptTermsRequired,
        variant: "destructive",
      });
      return;
    }

    trackFunnelEvent(FUNNEL_EVENTS.signupSubmitted, {
      page: "restaurant-signup",
      stage:
        authMode === "signup"
          ? "owner_account_google_submit"
          : "owner_account_google_login",
      authMode,
      provider: "google",
      businessType: signupRouteIntent.businessType,
      intent: signupRouteIntent.intent,
      source: signupRouteIntent.source,
    });

    const oauthParams = new URLSearchParams({
      userType: isFoodTruckRoute ? "food_truck" : "restaurant_owner",
      redirect: continuationPath,
    });
    window.location.href = authUrl(
      `/api/auth/google/restaurant?${oauthParams.toString()}`,
    );
  };

  if (isLoading) {
    return (
      <div className="max-w-md mx-auto bg-background min-h-screen flex items-center justify-center">
        <div className="animate-spin w-12 h-12 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!isAuthenticated) {
    if (!accountRequested) {
      return (
        <div className="min-h-screen bg-[var(--bg-layered)]">
          <SEOHead title={routePresentation.metaTitle} description={routePresentation.metaDescription} canonicalUrl={COPY.meta.canonicalUrl} />
          <BackHeader title={routePresentation.headerTitle} fallbackHref="/" icon={isFoodTruckRoute ? Truck : Store} />
          <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
            <GuestBusinessDraft
              draft={form.watch()}
              onChange={(field, value) => form.setValue(field, value, { shouldDirty: true })}
              canChangeBusinessType={!signupRouteIntent.isClaim}
              onKeep={() => {
                const currentIntent = getGuestBusinessDraftIntent(signupRouteIntent, currentClaimDraftListingIdRef.current);
                if (!persistGuestBusinessDraft(() => window.localStorage, form.getValues(), Date.now(), currentIntent)) {
                  toast({ title: COPY.guestDraft.storageErrorTitle, description: COPY.guestDraft.storageErrorDescription, variant: "destructive" });
                  return;
                }
                const businessType = form.getValues("businessType");
                if (businessType !== signupRouteIntent.businessType || currentIntent.passthrough.claimListingId !== signupRouteIntent.passthrough.claimListingId) {
                  window.location.href = buildGuestBusinessSignupPath(currentIntent, businessType, signupAuthContext);
                  return;
                }
                setAccountRequested(true);
              }}
            />
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-screen bg-[var(--bg-layered)]">
        <SEOHead
          title={routePresentation.metaTitle}
          description={routePresentation.metaDescription}
          canonicalUrl={COPY.meta.canonicalUrl}
        />
        <BackHeader
          title={routePresentation.headerTitle}
          fallbackHref="/"
          icon={isFoodTruckRoute ? Truck : Store}
          className="bg-[hsl(var(--background))/0.94] border-b border-[color:var(--border-subtle)] shadow-clean lg:top-16"
        />

        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
          <div className="mb-6 rounded-xl border bg-card p-4" data-testid="guest-draft-account-gate">
            <h1 className="text-xl font-bold">{COPY.guestDraft.accountTitle}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{COPY.guestDraft.accountDescription}</p>
            <Button type="button" variant="outline" className="mt-3" onClick={() => setAccountRequested(false)}>{COPY.guestDraft.edit}</Button>
          </div>
          <div className="grid items-start gap-6 lg:grid-cols-[1.1fr_1fr]">
            <Card className="border-[color:var(--border-subtle)] bg-[var(--bg-card)] shadow-clean-lg">
              <CardContent className="p-6 sm:p-8">
                <div className="inline-flex items-center rounded-full border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--text-secondary)]">
                  {unauthHero.badge}
                </div>
                <h1 className="mt-4 text-3xl font-black leading-tight text-[color:var(--text-primary)] sm:text-4xl">
                  {unauthHero.title}
                </h1>
                <p className="mt-3 max-w-xl text-sm leading-relaxed text-[color:var(--text-secondary)] sm:text-base">
                  {unauthHero.subtitle}
                </p>
                <div className="mt-8 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-3 text-xs text-[color:var(--text-secondary)]">
                    {routePresentation.benefits[0]}
                  </div>
                  <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-3 text-xs text-[color:var(--text-secondary)]">
                    {routePresentation.benefits[1]}
                  </div>
                  <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-3 text-xs text-[color:var(--text-secondary)]">
                    {routePresentation.benefits[2]}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card
              className="border-[color:var(--border-subtle)] bg-[var(--bg-card)] shadow-clean-lg"
              data-signup-section
            >
              <CardContent className="p-6">
                <div className="mb-5 grid grid-cols-2 rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-1">
                  <Button
                    type="button"
                    data-testid="button-signup-toggle"
                    onClick={() => setAuthMode("signup")}
                    className={authMode === "signup" ? "action-primary" : ""}
                    variant={authMode === "signup" ? "default" : "ghost"}
                  >
                    {COPY.unauth.toggles.signup}
                  </Button>
                  <Button
                    type="button"
                    data-testid="button-login-toggle"
                    onClick={() => setAuthMode("login")}
                    className={authMode === "login" ? "action-primary" : ""}
                    variant={authMode === "login" ? "default" : "ghost"}
                  >
                    {COPY.unauth.toggles.login}
                  </Button>
                </div>

                <Button
                  type="button"
                  data-testid="button-google-signin"
                  variant="outline"
                  onClick={handleGoogleSignup}
                  className="mb-4 w-full justify-center gap-2 border-[color:var(--border-subtle)]"
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24">
                    <path
                      fill="#4285f4"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="#34a853"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="#fbbc05"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    />
                    <path
                      fill="#ea4335"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    />
                  </svg>
                  {COPY.unauth.oauth.button}
                </Button>

                <div className="relative mb-4">
                  <div className="border-t border-[color:var(--border-subtle)]" />
                  <span className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 bg-[var(--bg-card)] px-3 text-xs text-[color:var(--text-secondary)]">
                    {COPY.unauth.divider.or}
                  </span>
                </div>

                {authMode === "signup" && (
                  <div className="mb-4 rounded-xl border border-[color:var(--action-primary)] bg-[var(--bg-surface-muted)] p-4">
                    <p className="text-sm font-semibold text-[color:var(--text-primary)]">
                      {COPY.forms.restaurant.websiteImportLeadTitle}
                    </p>
                    <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                      {COPY.forms.restaurant.websiteImportLeadHelp}
                    </p>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <Input
                        type="url"
                        inputMode="url"
                        placeholder="https://your-business.com"
                        value={form.watch("websiteUrl") || ""}
                        onChange={(event) =>
                          form.setValue("websiteUrl", event.target.value)
                        }
                        data-testid="input-import-website"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        className="shrink-0 border-[color:var(--border-subtle)]"
                        disabled={websiteImportLoading}
                        onClick={handleWebsiteImport}
                        data-testid="button-import-website"
                      >
                        {websiteImportLoading
                          ? COPY.forms.restaurant.websiteImportButtonPending
                          : COPY.forms.restaurant.websiteImportButton}
                      </Button>
                    </div>
                    {importedFields.length > 0 && (
                      <p className="mt-2 text-xs font-medium text-[color:var(--text-primary)]">
                        {COPY.forms.restaurant.websiteImportCapturedPrefix}{" "}
                        {importedFields.join(", ")}.{" "}
                        {COPY.forms.restaurant.websiteImportCapturedSuffix}
                      </p>
                    )}
                  </div>
                )}

                {authMode === "signup" && (
                  <div className="mb-4 rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-4">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        id="restaurant-signup-terms"
                        checked={signupAcceptedTerms}
                        onCheckedChange={(checked) => {
                          signupForm.setValue("acceptTerms", checked === true, {
                            shouldDirty: true,
                            shouldValidate: true,
                          });
                          if (checked === true) {
                            signupForm.clearErrors("acceptTerms");
                          }
                        }}
                        className="mt-1"
                        data-testid="checkbox-signup-terms"
                        aria-label="Agree to the Terms of Service and Privacy Policy"
                      />
                      <div className="space-y-1">
                        <p
                          className="text-sm text-[color:var(--text-secondary)]"
                          data-testid="label-signup-terms"
                        >
                          {COPY.terms.labelPrefix}{" "}
                          <Link href="/terms-of-service">
                            <span className="cursor-pointer text-[color:var(--accent-text)] underline">
                              {COPY.terms.termsText}
                            </span>
                          </Link>{" "}
                          {COPY.terms.andText}{" "}
                          <Link href="/privacy-policy">
                            <span className="cursor-pointer text-[color:var(--accent-text)] underline">
                              {COPY.terms.privacyText}
                            </span>
                          </Link>
                        </p>
                        {signupForm.formState.errors.acceptTerms?.message ? (
                          <p className="text-sm text-[color:var(--status-error)]">
                            {signupForm.formState.errors.acceptTerms.message}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </div>
                )}

                {authMode === "signup" ? (
                  <Form {...signupForm}>
                    <form
                      onSubmit={signupForm.handleSubmit(
                        onSignup,
                        handleSignupInvalid,
                      )}
                      className="space-y-4"
                    >
                      <div className="grid gap-4 sm:grid-cols-2">
                        <FormField
                          control={signupForm.control}
                          name="firstName"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>
                                {COPY.forms.signup.firstNameLabel}
                              </FormLabel>
                              <FormControl>
                                <Input
                                  data-testid="input-first-name"
                                  autoComplete="given-name"
                                  placeholder={
                                    COPY.forms.signup.firstNamePlaceholder
                                  }
                                  {...field}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={signupForm.control}
                          name="lastName"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>
                                {COPY.forms.signup.lastNameLabel}
                              </FormLabel>
                              <FormControl>
                                <Input
                                  data-testid="input-last-name"
                                  autoComplete="family-name"
                                  placeholder={
                                    COPY.forms.signup.lastNamePlaceholder
                                  }
                                  {...field}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>

                      <FormField
                        control={signupForm.control}
                        name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              {COPY.forms.signup.emailLabel}
                            </FormLabel>
                            <FormControl>
                              <div className="relative">
                                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--text-secondary)]" />
                                <Input
                                  data-testid="input-email"
                                  type="email"
                                  autoComplete="email"
                                  placeholder={
                                    COPY.forms.signup.emailPlaceholder
                                  }
                                  className="pl-9"
                                  {...field}
                                />
                              </div>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={signupForm.control}
                        name="phone"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              {COPY.forms.signup.phoneLabel}{" "}
                              <span className="text-[color:var(--status-error)]">
                                *
                              </span>
                            </FormLabel>
                            <FormControl>
                              <Input
                                data-testid="input-phone"
                                type="tel"
                                autoComplete="tel"
                                placeholder={COPY.forms.signup.phonePlaceholder}
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={signupForm.control}
                        name="phoneContactConsent"
                        render={({ field }) => (
                          <FormItem className="rounded-md border p-3">
                            <div className="flex items-start gap-2">
                              <FormControl>
                                <input
                                  type="checkbox"
                                  checked={field.value}
                                  onChange={(event) =>
                                    field.onChange(event.target.checked)
                                  }
                                  className="mt-1 h-4 w-4"
                                  data-testid="checkbox-phone-contact-consent"
                                />
                              </FormControl>
                              <FormLabel className="text-sm font-normal leading-5">
                                I agree MealScout may call or text me about
                                onboarding. I can opt out anytime.
                              </FormLabel>
                            </div>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={signupForm.control}
                        name="password"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              {COPY.forms.signup.passwordLabel}
                            </FormLabel>
                            <FormControl>
                              <div className="relative">
                                <Input
                                  data-testid="input-password"
                                  type={showPassword ? "text" : "password"}
                                  autoComplete="new-password"
                                  placeholder={
                                    COPY.forms.signup.passwordPlaceholder
                                  }
                                  className="pr-10"
                                  {...field}
                                />
                                <button
                                  type="button"
                                  aria-label={
                                    showPassword
                                      ? "Hide password"
                                      : "Show password"
                                  }
                                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[color:var(--text-secondary)]"
                                  onClick={() => setShowPassword(!showPassword)}
                                >
                                  {showPassword ? (
                                    <EyeOff className="h-4 w-4" />
                                  ) : (
                                    <Eye className="h-4 w-4" />
                                  )}
                                </button>
                              </div>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={signupForm.control}
                        name="confirmPassword"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              {COPY.forms.signup.confirmPasswordLabel}
                            </FormLabel>
                            <FormControl>
                              <div className="relative">
                                <Input
                                  data-testid="input-confirm-password"
                                  type={
                                    showConfirmPassword ? "text" : "password"
                                  }
                                  autoComplete="new-password"
                                  placeholder={
                                    COPY.forms.signup.confirmPasswordPlaceholder
                                  }
                                  className="pr-10"
                                  {...field}
                                />
                                <button
                                  type="button"
                                  aria-label={
                                    showConfirmPassword
                                      ? "Hide confirmation password"
                                      : "Show confirmation password"
                                  }
                                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[color:var(--text-secondary)]"
                                  onClick={() =>
                                    setShowConfirmPassword(!showConfirmPassword)
                                  }
                                >
                                  {showConfirmPassword ? (
                                    <EyeOff className="h-4 w-4" />
                                  ) : (
                                    <Eye className="h-4 w-4" />
                                  )}
                                </button>
                              </div>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <Button
                        type="submit"
                        className="w-full action-primary hover:bg-[color:var(--action-hover)]"
                        disabled={signupMutation.isPending}
                        data-testid="button-signup-submit"
                      >
                        {signupMutation.isPending
                          ? routePresentation.signupPending
                          : routePresentation.signupButton}
                      </Button>
                    </form>
                  </Form>
                ) : (
                  <Form {...loginForm}>
                    <form
                      onSubmit={loginForm.handleSubmit(onLogin)}
                      className="space-y-4"
                    >
                      <FormField
                        control={loginForm.control}
                        name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{COPY.forms.login.emailLabel}</FormLabel>
                            <FormControl>
                              <div className="relative">
                                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--text-secondary)]" />
                                <Input
                                  data-testid="input-login-email"
                                  type="email"
                                  autoComplete="email"
                                  placeholder={
                                    COPY.forms.login.emailPlaceholder
                                  }
                                  className="pl-9"
                                  {...field}
                                />
                              </div>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={loginForm.control}
                        name="password"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              {COPY.forms.login.passwordLabel}
                            </FormLabel>
                            <FormControl>
                              <div className="relative">
                                <Input
                                  data-testid="input-login-password"
                                  type={showLoginPassword ? "text" : "password"}
                                  autoComplete="current-password"
                                  placeholder={
                                    COPY.forms.login.passwordPlaceholder
                                  }
                                  className="pr-10"
                                  {...field}
                                />
                                <button
                                  type="button"
                                  aria-label={
                                    showLoginPassword
                                      ? "Hide password"
                                      : "Show password"
                                  }
                                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[color:var(--text-secondary)]"
                                  onClick={() =>
                                    setShowLoginPassword(!showLoginPassword)
                                  }
                                >
                                  {showLoginPassword ? (
                                    <EyeOff className="h-4 w-4" />
                                  ) : (
                                    <Eye className="h-4 w-4" />
                                  )}
                                </button>
                              </div>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <Button
                        type="submit"
                        className="w-full action-primary hover:bg-[color:var(--action-hover)]"
                        disabled={loginMutation.isPending}
                        data-testid="button-login-submit"
                      >
                        {loginMutation.isPending
                          ? routePresentation.loginPending
                          : routePresentation.loginButton}
                      </Button>
                    </form>
                  </Form>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg-layered)]">
      <SEOHead
        title={routePresentation.metaTitle}
        description={routePresentation.metaDescription}
        keywords={COPY.meta.keywords}
        canonicalUrl={COPY.meta.canonicalUrl}
      />
      <BackHeader
        title={isFoodTruckRoute ? routePresentation.headerTitle : COPY.main.backHeaderTitle}
        fallbackHref="/"
        icon={isFoodTruckRoute ? Truck : Store}
        className="bg-[hsl(var(--background))/0.94] border-b border-[color:var(--border-subtle)] shadow-clean lg:top-16"
      />

      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        {isAuthenticated &&
          user &&
          user.userType !== "admin" &&
          user.userType !== "duper_admin" &&
          user.userType !== "super_admin" &&
          user.userType !== "staff" && (
            <Card className="mb-4 border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] shadow-clean">
              <CardContent className="p-4">
                <p className="text-sm font-semibold text-[color:var(--text-primary)]">
                  {COPY.main.authenticatedBanner.title}
                </p>
                <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                  {COPY.main.authenticatedBanner.body}
                </p>
                <p className="mt-2 text-xs text-[color:var(--text-secondary)]">
                  {COPY.main.authenticatedBanner.freeLine}
                </p>
                <p className="mt-1 text-xs font-semibold text-[color:var(--text-primary)]">
                  {COPY.main.authenticatedBanner.paidLine}
                </p>
              </CardContent>
            </Card>
          )}

        <Card className="mb-6 border-[color:var(--border-subtle)] bg-[var(--bg-card)] shadow-clean-lg">
          <CardContent className="p-6">
            <div className="inline-flex items-center rounded-full border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--text-secondary)]">
              {COPY.main.hero.badge}
            </div>
            <h1 className="mt-3 text-2xl font-black leading-tight text-[color:var(--text-primary)] sm:text-3xl">
              {mainHero.title}
            </h1>
            <p className="mt-2 text-sm text-[color:var(--text-secondary)] sm:text-base">
              {mainHero.subtitle}
            </p>
          </CardContent>
        </Card>

        <div className="mb-5 flex items-center justify-center gap-4">
          <div
            className={`flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${currentStep === "restaurant" ? "border-[color:var(--action-primary)] bg-[var(--bg-surface-muted)] text-[color:var(--action-primary)]" : "border-[color:var(--border-subtle)] text-[color:var(--text-secondary)]"}`}
          >
            <span className="font-bold">1</span>
            <span>{COPY.steps.businessDetails}</span>
          </div>
          <div className="h-px w-8 bg-[color:var(--border-subtle)]" />
          <div
            className={`flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${currentStep === "verification" ? "border-[color:var(--action-primary)] bg-[var(--bg-surface-muted)] text-[color:var(--action-primary)]" : "border-[color:var(--border-subtle)] text-[color:var(--text-secondary)]"}`}
          >
            <span className="font-bold">2</span>
            <span>{COPY.steps.businessVerification}</span>
          </div>
        </div>

        {currentStep === "restaurant" && (
          <Card className="border-[color:var(--border-subtle)] bg-[var(--bg-card)] shadow-clean-lg">
            <CardContent className="p-6">
              <Form {...form}>
                <form
                  onSubmit={form.handleSubmit(
                    onSubmit,
                    handleRestaurantInvalid,
                  )}
                  className="space-y-6"
                >
                  {restoredDraftAt && (
                    <div
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] p-3 text-xs text-[color:var(--text-secondary)]"
                      data-testid="banner-restored-draft"
                    >
                      <span>
                        We restored details you started on{" "}
                        {restoredDraftAt.toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                        .
                      </span>
                      <button
                        type="button"
                        className="font-medium text-[color:var(--action-primary)] underline"
                        onClick={() => {
                          try {
                            window.localStorage.removeItem(RESTAURANT_DRAFT_KEY);
                          } catch {
                            // ignore
                          }
                          rotateOnboardingAttemptId();
                          form.reset({
                            ...BLANK_RESTAURANT_FORM_VALUES,
                            businessType: signupRouteIntent.businessType,
                          });
                          setRestoredDraftAt(null);
                        }}
                        data-testid="button-clear-restored-draft"
                      >
                        Start over instead
                      </button>
                    </div>
                  )}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel data-testid="label-business-name">
                            {COPY.forms.restaurant.nameLabel}
                          </FormLabel>
                          <FormControl>
                            <Input
                              placeholder={
                                COPY.forms.restaurant.namePlaceholder
                              }
                              data-testid="input-business-name"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="businessType"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel data-testid="label-business-type">
                            {COPY.forms.restaurant.businessTypeLabel}
                          </FormLabel>
                          <Select
                            onValueChange={field.onChange}
                            defaultValue={field.value}
                            disabled={isFoodTruckRoute}
                          >
                            <FormControl>
                              <SelectTrigger data-testid="select-business-type">
                                <SelectValue
                                  placeholder={
                                    COPY.forms.restaurant
                                      .businessTypePlaceholder
                                  }
                                />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="food_truck">
                                Food Truck
                              </SelectItem>
                              <SelectItem value="restaurant">
                                Restaurant
                              </SelectItem>
                              <SelectItem value="bar">Bar</SelectItem>
                              <SelectItem value="caterer">Caterer</SelectItem>
                              <SelectItem value="private_chef">
                                Private Chef
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="text-xs text-[color:var(--text-secondary)]">
                            {COPY.forms.restaurant.businessTypeHelp}
                          </p>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  {selectedBusinessType !== "food_truck" && (
                    <FormField
                      control={form.control}
                      name="confirmNotFoodTruck"
                      render={({ field }) => (
                        <FormItem>
                          <label className="flex items-start gap-2 rounded-md border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] p-3 text-sm text-[color:var(--text-primary)]">
                            <FormControl>
                              <Checkbox
                                checked={Boolean(field.value)}
                                onCheckedChange={(checked) =>
                                  field.onChange(Boolean(checked))
                                }
                              />
                            </FormControl>
                            <span>
                              {COPY.forms.restaurant.stationaryConfirmLabel}
                            </span>
                          </label>
                          <p className="text-xs text-[color:var(--text-secondary)]">
                            {COPY.forms.restaurant.stationaryWarning}
                          </p>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}

                  {selectedBusinessType === "food_truck" &&
                    isMissingListingFlow && (
                      <div className="space-y-1 rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] p-4">
                        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">
                          {COPY.forms.restaurant.claimMissingTitle}
                        </h3>
                        <p className="text-xs text-[color:var(--text-secondary)]">
                          {COPY.forms.restaurant.claimMissingDescription}
                        </p>
                      </div>
                    )}

                  {selectedBusinessType === "food_truck" &&
                    (signupRouteIntent.isClaim || isMissingListingFlow) && (
                    <div className="space-y-3 rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] p-4">
                      <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">
                        {isMissingListingFlow
                          ? COPY.forms.restaurant.claimRegistryCheckTitle
                          : COPY.forms.restaurant.claimTitle}
                      </h3>
                      <p className="text-xs text-[color:var(--text-secondary)]">
                        {isMissingListingFlow
                          ? COPY.forms.restaurant.claimRegistryCheckDescription
                          : COPY.forms.restaurant.claimDescription}
                      </p>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Input
                          value={claimQuery}
                          onChange={(e) => {
                            invalidateClaimSearch();
                            setClaimQuery(e.target.value);
                            setPendingClaimListingId("");
                          }}
                          placeholder={
                            COPY.forms.restaurant.claimSearchPlaceholder
                          }
                          data-testid="input-claim-search"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleClaimSearch}
                          disabled={claimLoading}
                          data-testid="button-claim-search"
                        >
                          {COPY.forms.restaurant.claimSearchButton}
                        </Button>
                      </div>
                      {claimSelection && (
                        <div className="rounded-lg border border-[color:var(--border-subtle)] bg-[var(--bg-card)] p-3 text-xs">
                          <p className="font-semibold text-[color:var(--text-primary)]">
                            {COPY.forms.restaurant.claimSelectedLabel}
                          </p>
                          <p className="text-[color:var(--text-secondary)]">
                            {claimSelection.name}
                          </p>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              invalidateClaimSearch();
                              setPendingClaimListingId("");
                            }}
                            data-testid="button-claim-clear"
                          >
                            {COPY.forms.restaurant.claimClearButton}
                          </Button>
                        </div>
                      )}
                      {claimResults.length > 0 && !claimSelection && (
                        <div className="space-y-2">
                          {claimResults.map((listing) => (
                            <div
                              key={listing.id}
                              className="flex items-center justify-between rounded-lg border border-[color:var(--border-subtle)] bg-[var(--bg-card)] p-3 text-xs"
                            >
                              <div>
                                <p className="font-medium text-[color:var(--text-primary)]">
                                  {listing.name}
                                </p>
                                {listing.invited && (
                                  <p className="text-[11px] text-[color:var(--text-secondary)]">
                                    This truck has an invited owner.
                                  </p>
                                )}
                              </div>
                              {isMissingListingFlow ? (
                                <a
                                  href={buildRestaurantSignupPath({
                                    businessType: "food_truck",
                                    intent: "claim",
                                    source:
                                      signupRouteIntent.source ||
                                      "restaurant-signup",
                                    passthrough: {
                                      q: listing.externalId || listing.name,
                                      claimListingId: listing.id,
                                    },
                                  })}
                                  className="inline-flex h-9 items-center justify-center rounded-md bg-[color:var(--action-primary)] px-3 text-xs font-semibold text-white"
                                >
                                  Claim this listing
                                </a>
                              ) : listing.canClaim !== false ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  onClick={() => applyClaimSelection(listing)}
                                  data-testid={`button-claim-select-${listing.id}`}
                                >
                                  {COPY.forms.restaurant.claimSelectButton}
                                </Button>
                              ) : (
                                <div className="flex flex-col items-end gap-1">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={
                                      claimRequestingId === listing.id ||
                                      Number(
                                        listing.requestCooldownMinutes || 0,
                                      ) > 0
                                    }
                                    onClick={() => handleRequestTruck(listing.id)}
                                    data-testid={`button-claim-request-${listing.id}`}
                                  >
                                    {Number(listing.requestCooldownMinutes || 0) >
                                    0
                                      ? `Try again in ${listing.requestCooldownMinutes}m`
                                      : claimRequestingId === listing.id
                                        ? "Sending..."
                                        : "Request this truck"}
                                  </Button>
                                  <button
                                    type="button"
                                    className="text-[11px] font-medium text-[color:var(--action-primary)] underline disabled:opacity-50"
                                    disabled={claimDisputingId === listing.id}
                                    onClick={() => handleDisputeClaim(listing)}
                                    data-testid={`button-claim-dispute-${listing.id}`}
                                  >
                                    {claimDisputingId === listing.id
                                      ? "Sending..."
                                      : "That's not right — I'm the owner"}
                                  </button>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      {claimError && (
                        <p
                          className="text-xs text-[color:var(--text-secondary)]"
                          role="alert"
                          aria-live="polite"
                        >
                          {claimError}
                        </p>
                      )}
                      {signupRouteIntent.isClaim && (
                        <a
                          href={createTruckProfilePath}
                          className="inline-flex text-xs font-semibold text-[color:var(--action-primary)] underline"
                        >
                          {COPY.forms.restaurant.claimCreateInstead}
                        </a>
                      )}
                    </div>
                  )}

                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="address"
                      render={({ field }) => (
                        <FormItem className="sm:col-span-2">
                          <FormLabel data-testid="label-address">
                            {COPY.forms.restaurant.addressLabel}
                          </FormLabel>
                          <FormControl>
                            <Input
                              placeholder={
                                COPY.forms.restaurant.addressPlaceholder
                              }
                              data-testid="input-address"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="city"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel data-testid="label-city">
                            {COPY.forms.restaurant.cityLabel}
                          </FormLabel>
                          <FormControl>
                            <Input
                              placeholder={
                                COPY.forms.restaurant.cityPlaceholder
                              }
                              data-testid="input-city"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="state"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel data-testid="label-state">
                            {COPY.forms.restaurant.stateLabel}
                          </FormLabel>
                          <FormControl>
                            <Input
                              placeholder={
                                COPY.forms.restaurant.statePlaceholder
                              }
                              data-testid="input-state"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="phone"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel data-testid="label-phone">
                            {COPY.forms.restaurant.phoneLabel}{" "}
                            <span className="text-[color:var(--status-error)]">
                              *
                            </span>
                          </FormLabel>
                          <FormControl>
                            <Input
                              type="tel"
                              placeholder={
                                COPY.forms.restaurant.phonePlaceholder
                              }
                              data-testid="input-phone"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="cuisineType"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel data-testid="label-cuisine-type">
                            {COPY.forms.restaurant.cuisineLabel}
                          </FormLabel>
                          <Select
                            onValueChange={field.onChange}
                            defaultValue={field.value}
                          >
                            <FormControl>
                              <SelectTrigger data-testid="select-cuisine">
                                <SelectValue
                                  placeholder={
                                    COPY.forms.restaurant.cuisinePlaceholder
                                  }
                                />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="american">American</SelectItem>
                              <SelectItem value="bbq">BBQ</SelectItem>
                              <SelectItem value="breakfast">
                                Breakfast
                              </SelectItem>
                              <SelectItem value="burgers">Burgers</SelectItem>
                              <SelectItem value="cajun">Cajun</SelectItem>
                              <SelectItem value="caribbean">
                                Caribbean
                              </SelectItem>
                              <SelectItem value="coffee">
                                Coffee & Café
                              </SelectItem>
                              <SelectItem value="dessert">Dessert</SelectItem>
                              <SelectItem value="healthy">
                                Healthy & Bowls
                              </SelectItem>
                              <SelectItem value="keto">
                                Keto & Low-Carb
                              </SelectItem>
                              <SelectItem value="paleo">Paleo</SelectItem>
                              <SelectItem value="other">Other</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="space-y-4 rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-4">
                    <FormField
                      control={form.control}
                      name="description"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            About Your Business{" "}
                            <span className="font-normal text-[color:var(--text-secondary)]">
                              (Optional)
                            </span>
                          </FormLabel>
                          <FormControl>
                            <textarea
                              placeholder={
                                selectedBusinessType === "food_truck"
                                  ? "Tell customers what makes your food truck unique..."
                                  : "Tell customers what makes your restaurant unique..."
                              }
                              rows={4}
                              maxLength={500}
                              className="w-full rounded-md border border-[color:var(--border-strong)] bg-[color:var(--field-bg)] px-3 py-2 text-sm text-[color:var(--text-primary)]"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <div className="grid gap-4 sm:grid-cols-3">
                      <FormField
                        control={form.control}
                        name="websiteUrl"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Website</FormLabel>
                            <FormControl>
                              <Input
                                type="url"
                                placeholder="https://..."
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="instagramUrl"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Instagram</FormLabel>
                            <FormControl>
                              <Input
                                type="url"
                                placeholder="https://..."
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="facebookPageUrl"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Facebook</FormLabel>
                            <FormControl>
                              <Input
                                type="url"
                                placeholder="https://..."
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={websiteImportLoading}
                        onClick={handleWebsiteImport}
                      >
                        {websiteImportLoading
                          ? COPY.forms.restaurant.websiteImportButtonPending
                          : COPY.forms.restaurant.websiteImportButton}
                      </Button>
                      <span className="text-xs text-[color:var(--text-secondary)]">
                        {COPY.forms.restaurant.websiteImportHelp}
                      </span>
                    </div>
                    {selectedBusinessType !== "food_truck" && (
                      <div className="grid gap-2 sm:grid-cols-3">
                        <FormField
                          control={form.control}
                          name="hasParking"
                          render={({ field }) => (
                            <FormItem className="flex items-center gap-2 rounded-md border border-[color:var(--border-subtle)] bg-[var(--bg-card)] p-3">
                              <FormControl>
                                <Checkbox
                                  checked={field.value}
                                  onCheckedChange={field.onChange}
                                />
                              </FormControl>
                              <FormLabel className="m-0">
                                Parking Available
                              </FormLabel>
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="hasWifi"
                          render={({ field }) => (
                            <FormItem className="flex items-center gap-2 rounded-md border border-[color:var(--border-subtle)] bg-[var(--bg-card)] p-3">
                              <FormControl>
                                <Checkbox
                                  checked={field.value}
                                  onCheckedChange={field.onChange}
                                />
                              </FormControl>
                              <FormLabel className="m-0">Free Wi-Fi</FormLabel>
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="hasOutdoorSeating"
                          render={({ field }) => (
                            <FormItem className="flex items-center gap-2 rounded-md border border-[color:var(--border-subtle)] bg-[var(--bg-card)] p-3">
                              <FormControl>
                                <Checkbox
                                  checked={field.value}
                                  onCheckedChange={field.onChange}
                                />
                              </FormControl>
                              <FormLabel className="m-0">
                                Outdoor Seating
                              </FormLabel>
                            </FormItem>
                          )}
                        />
                      </div>
                    )}
                  </div>

                  <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] p-4">
                    <p className="text-sm font-medium text-[color:var(--text-primary)]">
                      {COPY.pricing.formCard.title}
                    </p>
                    <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                      {COPY.pricing.formCard.badge}
                    </p>
                    <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                      {COPY.pricing.formCard.freeProfileLine}
                    </p>
                    <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                      {COPY.pricing.formCard.trialLine}
                    </p>
                    <p className="mt-1 text-xs font-semibold text-[color:var(--text-primary)]">
                      {COPY.pricing.formCard.paidLine}
                    </p>
                    <p className="mt-2 text-xs text-[color:var(--text-secondary)]">
                      {COPY.pricing.formCard.transactionDisclosure}
                    </p>
                  </div>

                  <FormField
                    control={form.control}
                    name="acceptTerms"
                    render={({ field }) => (
                      <FormItem className="flex items-start gap-3 rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-4">
                        <FormControl>
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={field.onChange}
                            className="mt-1"
                            data-testid="checkbox-terms"
                          />
                        </FormControl>
                        <div className="space-y-1">
                          <FormLabel
                            className="text-sm text-[color:var(--text-secondary)]"
                            data-testid="label-terms"
                          >
                            {COPY.terms.labelPrefix}{" "}
                            <Link href="/terms-of-service">
                              <span className="cursor-pointer text-[color:var(--accent-text)] underline">
                                {COPY.terms.termsText}
                              </span>
                            </Link>{" "}
                            {COPY.terms.andText}{" "}
                            <Link href="/privacy-policy">
                              <span className="cursor-pointer text-[color:var(--accent-text)] underline">
                                {COPY.terms.privacyText}
                              </span>
                            </Link>
                          </FormLabel>
                          <FormMessage />
                        </div>
                      </FormItem>
                    )}
                  />

                  <Button
                    type="submit"
                    className="w-full action-primary hover:bg-[color:var(--action-hover)]"
                    disabled={createRestaurantMutation.isPending}
                    data-testid="button-start-trial"
                  >
                    {createRestaurantMutation.isPending
                      ? COPY.cta.restaurantSubmit.pending
                      : COPY.cta.restaurantSubmit.idle}
                  </Button>
                </form>
              </Form>
            </CardContent>
          </Card>
        )}

        {currentStep === "verification" && createdRestaurant && (
          <Card className="border-[color:var(--border-subtle)] bg-[var(--bg-card)] shadow-clean-lg">
            <CardHeader className="pb-2">
              <CardTitle className="text-base font-semibold text-[color:var(--text-primary)]">
                {COPY.verification.title}
              </CardTitle>
              <p className="text-xs text-[color:var(--text-secondary)]">
                {COPY.verification.intro}
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {isAutoBusinessVerified && (
                <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-900">
                  <div className="font-semibold">✓ Business Verified</div>
                  <div className="mt-1 text-xs">
                    Your business was automatically verified. You can now book
                    parking passes and access all features. You still need to
                    confirm your email to log in.
                  </div>
                </div>
              )}
              {!isAutoBusinessVerified && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                  <strong>Verification recommended</strong> —{" "}
                  {COPY.verification.pendingBanner} You can skip this step and
                  submit documents later. Profile tools remain available during
                  the free trial.
                </div>
              )}
              <div className="rounded-xl border border-dashed border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] p-4">
                <ul className="list-disc space-y-1 pl-4 text-xs text-[color:var(--text-secondary)]">
                  {COPY.verification.bullets.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div
                className="rounded-xl border border-orange-200 bg-orange-50 p-4"
                data-testid="owner-ai-onboarding-handoff"
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-600 text-white">
                    <Sparkles className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div>
                    <p className="text-sm font-black text-orange-950">
                      {COPY.verification.aiSetupTitle}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-orange-900/80">
                      {COPY.verification.aiSetupDescription}
                    </p>
                    <p className="mt-2 text-xs font-semibold leading-5 text-orange-950">
                      {COPY.verification.aiSetupSafety}
                    </p>
                  </div>
                </div>
              </div>
              {!isAutoBusinessVerified && (
                <>
                  {selectedBusinessType === "food_truck" &&
                    (createdRestaurant as any)?.claimedFromImportId && (
                      <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] p-4">
                        <div className="text-xs font-semibold text-[color:var(--text-primary)]">
                          License number (required)
                        </div>
                        <div className="mt-1 text-xs text-[color:var(--text-secondary)]">
                          Enter the license number exactly as it appears on your
                          document.
                        </div>
                        <Input
                          className="mt-3"
                          value={licenseNumber}
                          onChange={(e) => setLicenseNumber(e.target.value)}
                          placeholder="License #"
                          data-testid="input-license-number"
                        />
                      </div>
                    )}
                  <DocumentUpload
                    onDocumentsChange={setVerificationDocuments}
                    maxFiles={5}
                    maxFileSize={10 * 1024 * 1024}
                    acceptedTypes={[
                      "image/jpeg",
                      "image/jpg",
                      "image/png",
                      "application/pdf",
                    ]}
                  />
                </>
              )}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    dispatchOnboarding({ type: "BACK_TO_RESTAURANT" })
                  }
                  data-testid="button-back-to-restaurant"
                >
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  {COPY.verification.backButton}
                </Button>
                <div className="flex flex-col gap-2 sm:flex-row">
                  {
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleSkipVerification}
                      data-testid="button-skip-verification"
                    >
                      {isAutoBusinessVerified
                        ? "Continue"
                        : COPY.verification.skipButton}
                    </Button>
                  }
                  {!isAutoBusinessVerified ? (
                    <Button
                      type="button"
                      onClick={handleVerificationSubmit}
                      disabled={
                        createVerificationRequestMutation.isPending ||
                        verificationDocuments.length === 0
                      }
                      className="action-primary hover:bg-[color:var(--action-hover)]"
                      data-testid="button-submit-verification"
                    >
                      {createVerificationRequestMutation.isPending ? (
                        <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      ) : (
                        <ArrowRight className="mr-2 h-4 w-4" />
                      )}
                      {createVerificationRequestMutation.isPending
                        ? COPY.verification.submitPending
                        : COPY.verification.submitIdle}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      onClick={handleSkipVerification}
                      className="action-primary hover:bg-[color:var(--action-hover)]"
                      data-testid="button-continue-verified"
                    >
                      <ArrowRight className="mr-2 h-4 w-4" />
                      {COPY.verification.continueAiButton}
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
