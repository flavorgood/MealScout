import { useState, useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Beer,
  Building2,
  CalendarDays,
  ChefHat,
  Eye,
  EyeOff,
  Mail,
  MapPinned,
  Package,
  Truck,
  UserPlus,
  UtensilsCrossed,
  type LucideIcon,
} from "lucide-react";
import { BackHeader } from "@/components/back-header";
import { SEOHead } from "@/components/seo-head";
import { PASSWORD_REGEX, PASSWORD_REQUIREMENTS } from "@/utils/passwordPolicy";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import {
  FUNNEL_EVENTS,
  toSafeFunnelDestinationPath,
  trackFunnelEvent,
  trackFunnelEventOncePerSession,
} from "@/utils/funnelTelemetry";
import { getStoredAffiliateRef, setAffiliateRef } from "@/lib/share";
import {
  buildRestaurantSignupPath,
  parseBusinessSignupRouteIntent,
  type BusinessSignupIntent,
} from "@shared/businessSignupIntent";

const signupSchema = z
  .object({
    email: z.string().email("Valid email is required"),
    firstName: z.string().min(1, "First name is required"),
    lastName: z.string().min(1, "Last name is required"),
    phone: z
      .string()
      .refine(
        (value) => value.replace(/\D/g, "").length >= 10,
        "Phone number must include at least 10 digits",
      ),
    phoneContactConsent: z.boolean().default(true),
    acceptTerms: z.boolean().default(false),
    otpCode: z.string().optional(),
    password: z
      .string()
      .min(1, PASSWORD_REQUIREMENTS)
      .regex(PASSWORD_REGEX, PASSWORD_REQUIREMENTS),
    confirmPassword: z.string().min(1, "Please confirm your password"),
    businessName: z.string().optional(),
    businessCity: z.string().optional(),
    businessState: z.string().optional(),
    menuSourceUrl: z.string().optional(),
    eventName: z.string().optional(),
    hostLocationName: z.string().optional(),
    supplierBusinessName: z.string().optional(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

type SignupFormData = z.infer<typeof signupSchema>;

type AccountType =
  | "diner"
  | "host"
  | "event_organizer"
  | "business"
  | "supplier";
type BusinessSubType =
  | "restaurant"
  | "bar"
  | "food_truck"
  | "caterer"
  | "private_chef";

const BUSINESS_SUBTYPE_LABELS: Record<BusinessSubType, string> = {
  restaurant: "Restaurant owner",
  bar: "Bar owner",
  food_truck: "Food truck owner",
  caterer: "Caterer owner",
  private_chef: "Private chef owner",
};

const getBusinessProfileActionLabel = (businessSubType: BusinessSubType) =>
  `Create ${BUSINESS_SUBTYPE_LABELS[businessSubType]
    .replace(/\s+owner$/i, "")
    .toLowerCase()} profile`;

const buildRestaurantSignupHref = (
  businessSubType: BusinessSubType,
  source = "customer-signup",
  intent: BusinessSignupIntent = "create",
  passthrough?: Record<string, string>,
) => {
  return buildRestaurantSignupPath({
    businessType: businessSubType,
    source,
    intent,
    passthrough,
  });
};

type SignupFlowOption = {
  id: string;
  accountType: AccountType;
  businessSubType?: BusinessSubType;
  label: string;
  description: string;
  href: string;
  icon: LucideIcon;
};

const normalizeSignupRole = (value: string | null): AccountType | null => {
  const role = String(value || "")
    .trim()
    .toLowerCase();
  if (role === "diner" || role === "customer") return "diner";
  if (role === "host") return "host";
  if (role === "event" || role === "event_coordinator")
    return "event_organizer";
  if (role === "business") return "business";
  if (role === "supplier") return "supplier";
  return null;
};

const extractCustomerSignupPathRef = () => {
  if (typeof window === "undefined") return "";
  const match = window.location.pathname.match(
    /^\/customer-signup\/([^/?#\/]+)\/?$/i,
  );
  if (!match) return "";
  try {
    return decodeURIComponent(String(match[1] || "")).trim();
  } catch {
    return String(match[1] || "").trim();
  }
};

const signupFlowOptions: SignupFlowOption[] = [
  {
    id: "diner",
    accountType: "diner",
    label: "Find Food",
    description: "Save favorite spots, deals, and local food finds.",
    href: "/customer-signup?role=diner",
    icon: UserPlus,
  },
  {
    id: "event_organizer",
    accountType: "event_organizer",
    label: "Event Organizer",
    description: "Coordinate vendors, events, and truck demand.",
    href: "/customer-signup?role=event_coordinator",
    icon: CalendarDays,
  },
  {
    id: "food_truck",
    accountType: "business",
    businessSubType: "food_truck",
    label: "Food Truck",
    description: "Create your truck profile and get discovered around town.",
    href: buildRestaurantSignupHref("food_truck"),
    icon: Truck,
  },
  {
    id: "restaurant",
    accountType: "business",
    businessSubType: "restaurant",
    label: "Restaurant",
    description: "Create your profile, menu, and local deal surfaces.",
    href: buildRestaurantSignupHref("restaurant"),
    icon: Building2,
  },
  {
    id: "bar",
    accountType: "business",
    businessSubType: "bar",
    label: "Bar",
    description: "Promote food, drinks, specials, and events.",
    href: buildRestaurantSignupHref("bar"),
    icon: Beer,
  },
  {
    id: "caterer",
    accountType: "business",
    businessSubType: "caterer",
    label: "Caterer",
    description: "Build a catering profile for local bookings.",
    href: buildRestaurantSignupHref("caterer"),
    icon: UtensilsCrossed,
  },
  {
    id: "private_chef",
    accountType: "business",
    businessSubType: "private_chef",
    label: "Private Chef",
    description: "Get discovered for private meals and events.",
    href: buildRestaurantSignupHref("private_chef"),
    icon: ChefHat,
  },
  {
    id: "host",
    accountType: "host",
    label: "Host",
    description: "Offer parking or event space to food trucks.",
    href: "/customer-signup?role=host",
    icon: MapPinned,
  },
  {
    id: "supplier",
    accountType: "supplier",
    label: "Supplier",
    description: "Sell products to restaurants and food trucks.",
    href: "/customer-signup?role=supplier",
    icon: Package,
  },
];

export default function CustomerSignup() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user, isAuthenticated, isLoading } = useAuth();
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [otpSending, setOtpSending] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const requirePhoneVerification = false;

  const searchParams = useMemo(
    () => new URLSearchParams(window.location.search),
    [],
  );
  const inboundBusinessIntent = useMemo(
    () => parseBusinessSignupRouteIntent(searchParams),
    [searchParams],
  );
  const normalizedRole = normalizeSignupRole(searchParams.get("role"));
  const urlReferralTag = String(
    searchParams.get("ref") || extractCustomerSignupPathRef() || "",
  ).trim();
  const initialAccountType: AccountType = normalizedRole || "diner";
  const businessTypeParam = searchParams.get("businessType");
  const initialBusinessSubType: BusinessSubType =
    businessTypeParam === "food_truck" ||
    businessTypeParam === "bar" ||
    businessTypeParam === "caterer" ||
    businessTypeParam === "private_chef"
      ? businessTypeParam
      : "restaurant";
  const hasExplicitSignupFlow = Boolean(normalizedRole || businessTypeParam);
  const [signupFlowSelected, setSignupFlowSelected] = useState(
    hasExplicitSignupFlow,
  );
  const [accountType, setAccountType] =
    useState<AccountType>(initialAccountType);
  const [businessSubType, setBusinessSubType] = useState<BusinessSubType>(
    initialAccountType === "business" ? initialBusinessSubType : "restaurant",
  );
  const SIGNUP_DRAFT_KEY = "mealscout:customer-signup-draft";
  const POST_VERIFICATION_REDIRECT_KEY = "mealscout:post-verification-redirect";
  const RESTAURANT_DRAFT_KEY = "mealscout:restaurant-signup-draft";
  const HOST_SIGNUP_DRAFT_KEY = "mealscout:host-signup-draft";
  const EVENT_SIGNUP_DRAFT_KEY = "mealscout:event-signup-draft";
  const SUPPLIER_SIGNUP_DRAFT_KEY = "mealscout:supplier-signup-draft";

  useEffect(() => {
    if (urlReferralTag) {
      setAffiliateRef(urlReferralTag);
    }
  }, [urlReferralTag]);

  const getCustomerRedirectPath = () =>
    accountType === "host"
      ? "/host-signup"
      : accountType === "event_organizer"
        ? "/event-coordinator/dashboard?setup=onboarding"
        : accountType === "business"
          ? getBusinessRedirectPath()
          : "/scout";

  const getBusinessRedirectPath = () => {
    const intent: BusinessSignupIntent =
      businessSubType === "food_truck" && inboundBusinessIntent.isClaim
        ? "claim"
        : "create";
    return buildRestaurantSignupHref(
      businessSubType,
      inboundBusinessIntent.source || "post-verification",
      intent,
      inboundBusinessIntent.passthrough,
    );
  };

  const getRegistrationUserType = () =>
    accountType === "host"
      ? "host"
      : accountType === "event_organizer"
        ? "event_coordinator"
        : "customer";

  const getReferralId = () =>
    String(urlReferralTag || getStoredAffiliateRef() || "").trim() || undefined;

  const preserveReferralHref = (href: string) => {
    const ref = getReferralId();
    if (!ref) return href;
    const url = new URL(href, window.location.origin);
    if (!url.searchParams.has("ref")) {
      url.searchParams.set("ref", ref);
    }
    return `${url.pathname}${url.search}${url.hash}`;
  };

  const selectSignupFlow = (option: SignupFlowOption) => {
    setAccountType(option.accountType);
    setBusinessSubType(option.businessSubType || "restaurant");
    setSignupFlowSelected(true);
    setLocation(preserveReferralHref(option.href));
  };

  useEffect(() => {
    if (accountType !== "business") return;
    setLocation(
      preserveReferralHref(
        buildRestaurantSignupHref(
          businessSubType,
          inboundBusinessIntent.source || "customer-signup-redirect",
          businessSubType === "food_truck" && inboundBusinessIntent.isClaim
            ? "claim"
            : "create",
          inboundBusinessIntent.passthrough,
        ),
      ),
    );
  }, [
    accountType,
    businessSubType,
    inboundBusinessIntent.isClaim,
    inboundBusinessIntent.passthrough,
    inboundBusinessIntent.source,
    setLocation,
    urlReferralTag,
  ]);

  const goToVerificationHandoff = (redirectPath: string) => {
    try {
      window.sessionStorage.setItem(
        POST_VERIFICATION_REDIRECT_KEY,
        redirectPath,
      );
    } catch {}
    window.location.href = `/post-verification?status=check-email&redirect=${encodeURIComponent(
      redirectPath,
    )}`;
  };

  const redirectExistingAccountToLogin = () => {
    const redirectPath = getCustomerRedirectPath();
    try {
      window.sessionStorage.setItem(
        POST_VERIFICATION_REDIRECT_KEY,
        redirectPath,
      );
      window.sessionStorage.setItem(
        "mealscout:lastSignupEmail",
        form.getValues("email") || "",
      );
    } catch {}
    setLocation(`/login?redirect=${encodeURIComponent(redirectPath)}`);
  };

  const handleSignupError = (error: any, fallbackTitle = "Signup failed") => {
    const message = String(error?.message || "");
    if (/already exists|already has an account|email already/i.test(message)) {
      toast({
        title: "That email already has an account",
        description:
          "Log in to continue. If the account still needs verification, resend it from login.",
      });
      redirectExistingAccountToLogin();
      return;
    }

    toast({
      title: fallbackTitle,
      description: message || "Failed to create account",
      variant: "destructive",
    });
  };

  useEffect(() => {
    trackFunnelEventOncePerSession(
      FUNNEL_EVENTS.signupStarted,
      "customer_signup_view",
      {
        page: "customer-signup",
        accountType: initialAccountType,
        businessSubType: initialBusinessSubType,
        stage: "signup_view",
      },
    );
  }, [initialAccountType, initialBusinessSubType]);

  const defaultValues = useMemo<SignupFormData>(() => {
    const base: SignupFormData = {
      email: "",
      firstName: "",
      lastName: "",
      phone: "",
      phoneContactConsent: true,
      acceptTerms: false,
      otpCode: "",
      password: "",
      confirmPassword: "",
      businessName: "",
      businessCity: "",
      businessState: "",
      menuSourceUrl: "",
      eventName: "",
      hostLocationName: "",
      supplierBusinessName: "",
    };

    if (typeof window === "undefined") return base;

    try {
      const stored = window.localStorage.getItem(SIGNUP_DRAFT_KEY);
      if (!stored) return base;
      const parsed = JSON.parse(stored) as Partial<SignupFormData>;
      // Never pre-fill passwords from storage for safety
      delete (parsed as any).password;
      delete (parsed as any).confirmPassword;
      return { ...base, ...parsed };
    } catch {
      return base;
    }
  }, []);

  const form = useForm<SignupFormData>({
    resolver: zodResolver(signupSchema),
    defaultValues,
  });

  const writeRoleSetupDraft = (data: SignupFormData) => {
    if (typeof window === "undefined") return;

    try {
      if (accountType === "business") {
        const existing = JSON.parse(
          window.localStorage.getItem(RESTAURANT_DRAFT_KEY) || "{}",
        );
        window.localStorage.setItem(
          RESTAURANT_DRAFT_KEY,
          JSON.stringify({
            ...existing,
            name: data.businessName || existing.name || "",
            city: data.businessCity || existing.city || "",
            state: data.businessState || existing.state || "",
            phone: data.phone || existing.phone || "",
            businessType: businessSubType,
            menuSourceUrl: data.menuSourceUrl || existing.menuSourceUrl || "",
            acceptTerms: data.acceptTerms === true,
          }),
        );
      } else if (accountType === "host") {
        const existing = JSON.parse(
          window.localStorage.getItem(HOST_SIGNUP_DRAFT_KEY) || "{}",
        );
        window.localStorage.setItem(
          HOST_SIGNUP_DRAFT_KEY,
          JSON.stringify({
            ...existing,
            businessName: data.hostLocationName || existing.businessName || "",
            city: data.businessCity || existing.city || "",
            state: data.businessState || existing.state || "",
            contactName:
              `${data.firstName || ""} ${data.lastName || ""}`.trim() ||
              existing.contactName ||
              "",
            contactEmail: data.email || existing.contactEmail || "",
            contactPhone: data.phone || existing.contactPhone || "",
          }),
        );
      } else if (accountType === "event_organizer") {
        const existing = JSON.parse(
          window.localStorage.getItem(EVENT_SIGNUP_DRAFT_KEY) || "{}",
        );
        window.localStorage.setItem(
          EVENT_SIGNUP_DRAFT_KEY,
          JSON.stringify({
            ...existing,
            eventName: data.eventName || existing.eventName || "",
            city: data.businessCity || existing.city || "",
            contactEmail: data.email || existing.contactEmail || "",
            contactPhone: data.phone || existing.contactPhone || "",
          }),
        );
      } else if (accountType === "supplier") {
        window.localStorage.setItem(
          SUPPLIER_SIGNUP_DRAFT_KEY,
          JSON.stringify({
            businessName: data.supplierBusinessName || "",
            contactEmail: data.email || "",
            contactPhone: data.phone || "",
          }),
        );
      }
    } catch {
      // Drafts are a convenience only; never block account creation on storage.
    }
  };

  // Persist non-sensitive draft so interrupted users can resume later
  useEffect(() => {
    const subscription = form.watch((value) => {
      try {
        const { password, confirmPassword, ...rest } = value;
        window.localStorage.setItem(SIGNUP_DRAFT_KEY, JSON.stringify(rest));
      } catch {
        // ignore storage errors
      }
    });
    return () => subscription.unsubscribe();
  }, [form]);

  useEffect(() => {
    if (accountType !== "business") {
      setBusinessSubType("restaurant");
    }
  }, [accountType]);

  const customerSignupMutation = useMutation({
    mutationFn: async (data: SignupFormData) => {
      const { confirmPassword, ...signupData } = data;
      const res = await apiRequest("POST", "/api/auth/customer/register", {
        ...signupData,
        accountType: getRegistrationUserType(),
        referralId: getReferralId(),
        intendedNextPath: getCustomerRedirectPath(),
      });
      return await res.json();
    },
    onSuccess: async (payload: any) => {
      try {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(SIGNUP_DRAFT_KEY);
        }
      } catch {
        // Optional draft cleanup must not interrupt a successful registration.
      }
      const redirectAfterLogin = getCustomerRedirectPath();
      try {
        window.sessionStorage.setItem(
          "mealscout:lastSignupEmail",
          form.getValues("email") || "",
        );
      } catch {}
      toast({
        title: "Verify your email",
        description:
          payload?.message ||
          "We sent a verification link to your email. Verify it, then log in to continue.",
      });
      trackFunnelEvent(FUNNEL_EVENTS.signupCompleted, {
        page: "customer-signup",
        accountType: "diner_or_host",
        stage: "signup_success",
      });
      trackFunnelEvent(FUNNEL_EVENTS.activationStarted, {
        page: "customer-signup",
        stage: "redirect_to_email_handoff",
        redirectPath: toSafeFunnelDestinationPath(redirectAfterLogin),
      });
      goToVerificationHandoff(redirectAfterLogin);
    },
    onError: (error) => handleSignupError(error, "Signup failed"),
  });

  const businessSignupMutation = useMutation({
    mutationFn: async (data: SignupFormData) => {
      const { confirmPassword, ...signupData } = data;
      const res = await apiRequest("POST", "/api/auth/restaurant/register", {
        ...signupData,
        businessType: businessSubType,
        menuSourceUrl: signupData.menuSourceUrl || undefined,
        referralId: getReferralId(),
        intendedNextPath: getBusinessRedirectPath(),
      });
      return await res.json();
    },
    onSuccess: async (payload: any) => {
      try {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(SIGNUP_DRAFT_KEY);
        }
      } catch {
        // Optional draft cleanup must not interrupt a successful registration.
      }
      try {
        window.sessionStorage.setItem(
          "mealscout:lastSignupEmail",
          form.getValues("email") || "",
        );
      } catch {}
      toast({
        title: "Verify your email",
        description:
          payload?.message ||
          "We sent a verification link to your email. Verify it, then log in to continue.",
      });
      if (businessSubType !== "food_truck") {
        trackFunnelEvent(FUNNEL_EVENTS.signupCompleted, {
          page: "customer-signup",
          accountType: "business",
          businessSubType,
          stage: "signup_success",
        });
      }
      const businessRedirect = getBusinessRedirectPath();
      trackFunnelEvent(FUNNEL_EVENTS.activationStarted, {
        page: "customer-signup",
        stage: "redirect_to_email_handoff",
        redirectPath: toSafeFunnelDestinationPath(businessRedirect),
        accountType: "business",
        businessSubType,
        intent: inboundBusinessIntent.intent,
        source: inboundBusinessIntent.source,
      });
      goToVerificationHandoff(businessRedirect);
    },
    onError: (error) => handleSignupError(error, "Signup failed"),
  });

  const supplierSignupMutation = useMutation({
    mutationFn: async (data: SignupFormData) => {
      const { confirmPassword, ...signupData } = data;
      const res = await apiRequest("POST", "/api/auth/supplier/register", {
        ...signupData,
        referralId: getReferralId(),
        intendedNextPath: "/supplier/dashboard",
      });
      return await res.json();
    },
    onSuccess: async (payload: any) => {
      try {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(SIGNUP_DRAFT_KEY);
        }
      } catch {
        // Optional draft cleanup must not interrupt a successful registration.
      }
      try {
        window.sessionStorage.setItem(
          "mealscout:lastSignupEmail",
          form.getValues("email") || "",
        );
      } catch {}
      toast({
        title: "Verify your email",
        description:
          payload?.message ||
          "We sent a verification link to your email. Verify it, then log in to continue.",
      });
      trackFunnelEvent(FUNNEL_EVENTS.signupCompleted, {
        page: "customer-signup",
        accountType: "supplier",
        stage: "signup_success",
      });
      trackFunnelEvent(FUNNEL_EVENTS.activationStarted, {
        page: "customer-signup",
        stage: "redirect_to_email_handoff",
        redirectPath: toSafeFunnelDestinationPath("/supplier/dashboard"),
        accountType: "supplier",
      });
      goToVerificationHandoff("/supplier/dashboard");
    },
    onError: (error) => handleSignupError(error, "Supplier signup failed"),
  });

  const activateSupplierProfileMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/supplier/profile/activate", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok)
        throw new Error(data?.message || "Failed to activate supplier profile");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
      queryClient.invalidateQueries({ queryKey: ["/api/supplier/me"] });
      toast({
        title: "Supplier profile created",
        description: "Your supplier profile was added to this account.",
      });
      setLocation("/supplier/dashboard");
    },
    onError: (error: any) => {
      toast({
        title: "Unable to create supplier profile",
        description: error?.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const hasRequiredPhone = (phone: unknown) =>
    String(phone || "").replace(/\D/g, "").length >= 10;

  const getExistingAccountContinuationPath = () => {
    if (accountType === "host") {
      return "/host-signup";
    }
    if (accountType === "event_organizer") {
      return "/event-coordinator/dashboard?setup=onboarding";
    }

    if (accountType === "business") {
      return getBusinessRedirectPath();
    }

    if (accountType === "supplier") {
      return "/supplier/dashboard";
    }

    return "/dashboard";
  };

  const continueWithExistingAccount = () => {
    const continuationPath = getExistingAccountContinuationPath();
    if (!hasRequiredPhone((user as any)?.phone)) {
      setLocation(
        `/account-setup?phoneRequired=1&redirect=${encodeURIComponent(
          continuationPath,
        )}`,
      );
      return;
    }

    if (accountType === "supplier") {
      activateSupplierProfileMutation.mutate();
      return;
    }

    setLocation(continuationPath);
  };

  const onSubmit = (data: SignupFormData) => {
    if (isAuthenticated) {
      trackFunnelEvent(FUNNEL_EVENTS.activationStarted, {
        page: "customer-signup",
        stage: "continue_with_existing_account",
        accountType,
        businessSubType,
      });
      continueWithExistingAccount();
      return;
    }

    trackFunnelEvent(FUNNEL_EVENTS.signupSubmitted, {
      page: "customer-signup",
      accountType,
      businessSubType: accountType === "business" ? businessSubType : null,
      stage: "signup_submit",
      isAuthenticated,
    });

    if (accountType === "business") {
      if (!String(data.businessName || "").trim()) {
        form.setError("businessName", {
          type: "manual",
          message: "Business name is required",
        });
        return;
      }
      const digitsOnly = (data.phone || "").replace(/\D/g, "");
      if (!digitsOnly || digitsOnly.length < 10) {
        form.setError("phone", {
          type: "manual",
          message:
            "Valid phone number is required for business profile managers",
        });
        return;
      }
      if (requirePhoneVerification && !data.otpCode) {
        form.setError("otpCode", {
          type: "manual",
          message: "Verification code is required",
        });
        return;
      }
      if (!data.acceptTerms) {
        form.setError("acceptTerms", {
          type: "manual",
          message: "You must accept the Terms of Service and Privacy Policy",
        });
        return;
      }
      writeRoleSetupDraft(data);
      businessSignupMutation.mutate(data);
    } else if (accountType === "host") {
      if (!String(data.hostLocationName || "").trim()) {
        form.setError("hostLocationName", {
          type: "manual",
          message: "Host location name is required",
        });
        return;
      }
      if (requirePhoneVerification && !data.otpCode) {
        form.setError("otpCode", {
          type: "manual",
          message: "Verification code is required",
        });
        return;
      }
      writeRoleSetupDraft(data);
      customerSignupMutation.mutate(data);
    } else if (accountType === "event_organizer") {
      if (!String(data.eventName || "").trim()) {
        form.setError("eventName", {
          type: "manual",
          message: "Event or organization name is required",
        });
        return;
      }
      if (requirePhoneVerification && !data.otpCode) {
        form.setError("otpCode", {
          type: "manual",
          message: "Verification code is required",
        });
        return;
      }
      writeRoleSetupDraft(data);
      customerSignupMutation.mutate(data);
    } else if (accountType === "supplier") {
      if (!String(data.supplierBusinessName || "").trim()) {
        form.setError("supplierBusinessName", {
          type: "manual",
          message: "Supplier business name is required",
        });
        return;
      }
      if (requirePhoneVerification && !data.otpCode) {
        form.setError("otpCode", {
          type: "manual",
          message: "Verification code is required",
        });
        return;
      }
      writeRoleSetupDraft(data);
      supplierSignupMutation.mutate(data);
    } else {
      if (requirePhoneVerification && !data.otpCode) {
        form.setError("otpCode", {
          type: "manual",
          message: "Verification code is required",
        });
        return;
      }
      customerSignupMutation.mutate(data);
    }
  };

  const handleSendOtp = async () => {
    const phone = form.getValues("phone") || "";
    const digitsOnly = phone.replace(/\D/g, "");
    if (!digitsOnly || digitsOnly.length < 10) {
      form.setError("phone", {
        type: "manual",
        message: "Enter a valid phone number before sending a code",
      });
      return;
    }

    setOtpSending(true);
    try {
      await apiRequest("POST", "/api/auth/phone/send-code", {
        phone: digitsOnly,
      });
      setOtpSent(true);
      toast({
        title: "Code sent",
        description: "Check your phone for the verification code.",
      });
    } catch (error: any) {
      toast({
        title: "Failed to send code",
        description: error.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setOtpSending(false);
    }
  };

  const isSubmitting =
    customerSignupMutation.isPending ||
    businessSignupMutation.isPending ||
    supplierSignupMutation.isPending ||
    activateSupplierProfileMutation.isPending;

  const existingAccountActionLabel =
    accountType === "host"
      ? "Create host profile"
      : accountType === "event_organizer"
        ? "Create event organizer profile"
        : accountType === "business"
          ? getBusinessProfileActionLabel(businessSubType)
          : accountType === "supplier"
            ? "Create supplier profile"
            : "Go to dashboard";

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[var(--bg-layered)] flex items-center justify-center">
        <div className="animate-spin w-10 h-10 border-4 border-[color:var(--action-primary)] border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!signupFlowSelected) {
    return (
      <div className="min-h-screen bg-[var(--bg-layered)] flex flex-col">
        <SEOHead
          title="Sign Up - MealScout | Choose Account Type"
          description="Choose the MealScout account path that fits you: customer, food truck, restaurant, chef, host, event organizer, or supplier."
          canonicalUrl="https://www.mealscout.us/customer-signup"
          noIndex={true}
        />
        <BackHeader
          title="Choose Account Type"
          fallbackHref="/"
          icon={UserPlus}
          className="bg-[hsl(var(--background))/0.94] border-b border-[color:var(--border-subtle)] shadow-clean"
        />
        <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 py-5">
          <div className="mb-4 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)] shadow-clean-lg">
              <UserPlus className="h-6 w-6" aria-hidden="true" />
            </div>
            <h1 className="text-2xl font-black uppercase tracking-tight text-[color:var(--text-primary)]">
              What are you here to do?
            </h1>
            <p className="mt-1 text-sm text-[color:var(--text-secondary)]">
              Pick your path first so MealScout can send you to the right setup.
            </p>
          </div>

          <div className="grid flex-1 grid-cols-2 gap-2">
            {signupFlowOptions.map((option) => {
              const Icon = option.icon;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => selectSignupFlow(option)}
                  className="group flex min-h-[104px] flex-col rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-card)] p-3 text-left shadow-clean transition hover:border-[color:var(--action-primary)] hover:bg-[var(--bg-surface-muted)]"
                  data-testid={`button-signup-flow-${option.id}`}
                >
                  <span className="mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)] shadow-clean">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="text-sm font-black text-[color:var(--text-primary)]">
                    {option.label}
                  </span>
                  <span className="mt-1 text-[11px] leading-snug text-[color:var(--text-secondary)]">
                    {option.description}
                  </span>
                </button>
              );
            })}
          </div>
        </main>
      </div>
    );
  }

  if (isAuthenticated) {
    return (
      <div className="min-h-screen bg-[var(--bg-layered)] flex flex-col">
        <BackHeader
          title="Account Setup"
          fallbackHref="/dashboard"
          icon={UserPlus}
          className="bg-[hsl(var(--background))/0.94] border-b border-[color:var(--border-subtle)] shadow-clean"
        />
        <main className="flex-1 px-4 py-6 max-w-md mx-auto w-full">
          <div className="bg-[var(--bg-card)] border border-[color:var(--border-subtle)] rounded-2xl shadow-clean-lg p-4 space-y-4">
            <div className="text-center">
              <h1 className="text-xl font-bold text-[color:var(--text-primary)]">
                You are already signed in
              </h1>
              <p className="text-sm text-[color:var(--text-secondary)] mt-1">
                Add another profile to this same account instead of creating a
                new login.
              </p>
            </div>

            <div className="inline-flex rounded-full bg-[var(--bg-surface)] border border-[color:var(--border-subtle)] shadow-clean text-[11px] font-medium text-[color:var(--text-secondary)] overflow-hidden w-full">
              <button
                type="button"
                onClick={() => setAccountType("business")}
                className={`flex-1 px-3 py-1 border-l border-[color:var(--border-subtle)] transition-colors ${
                  accountType === "business"
                    ? "bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)]"
                    : "bg-transparent text-[color:var(--text-secondary)] hover:bg-[var(--bg-surface-muted)]"
                }`}
              >
                Business
              </button>
              <button
                type="button"
                onClick={() => setAccountType("diner")}
                className={`flex-1 px-3 py-1 border-l border-[color:var(--border-subtle)] transition-colors ${
                  accountType === "diner"
                    ? "bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)]"
                    : "bg-transparent text-[color:var(--text-secondary)] hover:bg-[var(--bg-surface-muted)]"
                }`}
              >
                Find Food
              </button>
              <button
                type="button"
                onClick={() => setAccountType("host")}
                className={`flex-1 px-3 py-1 border-l border-[color:var(--border-subtle)] transition-colors ${
                  accountType === "host"
                    ? "bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)]"
                    : "bg-transparent text-[color:var(--text-secondary)] hover:bg-[var(--bg-surface-muted)]"
                }`}
              >
                Host
              </button>
              <button
                type="button"
                onClick={() => setAccountType("event_organizer")}
                className={`flex-1 px-3 py-1 border-l border-[color:var(--border-subtle)] transition-colors ${
                  accountType === "event_organizer"
                    ? "bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)]"
                    : "bg-transparent text-[color:var(--text-secondary)] hover:bg-[var(--bg-surface-muted)]"
                }`}
              >
                Event Organizer
              </button>
              <button
                type="button"
                onClick={() => setAccountType("supplier")}
                className={`flex-1 px-3 py-1 border-l border-[color:var(--border-subtle)] transition-colors ${
                  accountType === "supplier"
                    ? "bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)]"
                    : "bg-transparent text-[color:var(--text-secondary)] hover:bg-[var(--bg-surface-muted)]"
                }`}
              >
                Supplier
              </button>
            </div>

            {accountType === "business" && (
              <div className="inline-flex w-full overflow-hidden rounded-full border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] text-[11px] font-semibold text-[color:var(--text-secondary)] shadow-clean">
                <button
                  type="button"
                  onClick={() => setBusinessSubType("restaurant")}
                  className={`flex-1 px-3 py-2 transition-colors ${
                    businessSubType === "restaurant"
                      ? "bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)]"
                      : "bg-transparent hover:bg-[var(--bg-surface-muted)]"
                  }`}
                >
                  Restaurant
                </button>
                <button
                  type="button"
                  onClick={() => setBusinessSubType("food_truck")}
                  className={`flex-1 border-l border-[color:var(--border-subtle)] px-3 py-2 transition-colors ${
                    businessSubType === "food_truck"
                      ? "bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)]"
                      : "bg-transparent hover:bg-[var(--bg-surface-muted)]"
                  }`}
                >
                  Food Truck
                </button>
              </div>
            )}

            <Button
              type="button"
              onClick={continueWithExistingAccount}
              disabled={isSubmitting}
              className="w-full py-3 font-semibold text-base rounded-2xl bg-[color:var(--action-primary)] hover:bg-[color:var(--action-hover)] text-[color:var(--action-primary-text)] border-0 shadow-clean"
            >
              {isSubmitting ? "Working..." : existingAccountActionLabel}
            </Button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg-layered)] flex flex-col">
      <SEOHead
        title="Sign Up - MealScout | Create Free Account"
        description="Join MealScout for free and start discovering exclusive food deals from local restaurants. Save your favorites, track deals, and never miss amazing dining discounts."
        keywords="sign up, create account, register, join mealscout, free account, food deals signup"
        canonicalUrl="https://www.mealscout.us/customer-signup"
        noIndex={true}
      />
      <h1 className="sr-only">Create a MealScout account</h1>
      <BackHeader
        title="Create Account"
        fallbackHref="/"
        icon={UserPlus}
        className="bg-[hsl(var(--background))/0.94] border-b border-[color:var(--border-subtle)] shadow-clean"
      />

      <main className="flex-1 px-4 py-2 max-w-md mx-auto flex flex-col justify-between">
        {/* Top: hero + form */}
        <div>
          {/* Welcome Section (highly compressed) */}
          <div className="text-center mb-2">
            <div className="w-10 h-10 bg-gradient-to-br from-red-500 via-orange-500 to-yellow-500 rounded-2xl mb-1 flex items-center justify-center mx-auto shadow-clean-lg ring-2 ring-white/70">
              <UserPlus className="w-5 h-5 text-white drop-shadow" />
            </div>
            <h2 className="text-lg font-bold text-[color:var(--text-primary)] mb-1 tracking-tight">
              Create Your MealScout Account
            </h2>
            <p className="text-[color:var(--text-secondary)] text-xs leading-snug max-w-sm mx-auto">
              {accountType === "business"
                ? "Create your personal login first. Then we’ll attach and finish the business profile you manage."
                : accountType === "host"
                  ? "Post and manage parking-host locations for trucks and local customers."
                  : accountType === "event_organizer"
                    ? "Publish events, coordinate vendor attendance, and manage event demand."
                    : accountType === "supplier"
                      ? "Set up your supplier profile, publish products, and accept orders from food trucks and restaurants."
                      : "Save favorite deals and never miss new drops from local spots."}
            </p>
          </div>

          {/* Signup Form */}
          <div className="bg-[var(--bg-card)] border border-[color:var(--border-subtle)] rounded-2xl shadow-clean-lg p-4">
            {/* Account type selection inside form */}
            <div className="mb-4 rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] p-3">
              <div className="text-xs font-black uppercase tracking-[0.16em] text-[color:var(--text-muted)]">
                Selected path
              </div>
              <div className="mt-1 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-black text-[color:var(--text-primary)]">
                    {accountType === "business"
                      ? BUSINESS_SUBTYPE_LABELS[businessSubType]
                      : accountType === "host"
                        ? "Parking pass host"
                        : accountType === "event_organizer"
                          ? "Event organizer"
                          : accountType === "supplier"
                            ? "Supplier"
                            : "Customer"}
                  </div>
                  <p className="text-xs text-[color:var(--text-secondary)]">
                    Need a different path? Go back to the role picker.
                  </p>
                </div>
                <Link
                  href={preserveReferralHref("/customer-signup")}
                  onClick={() => setSignupFlowSelected(false)}
                  className="shrink-0 rounded-full border border-[color:var(--border-subtle)] px-3 py-1 text-xs font-bold text-[color:var(--text-primary)] hover:bg-[var(--bg-surface)]"
                >
                  Change
                </Link>
              </div>
            </div>

            <div className="hidden justify-center mb-4">
              <div className="inline-flex rounded-full bg-[var(--bg-surface)] border border-[color:var(--border-subtle)] shadow-clean text-[11px] font-medium text-[color:var(--text-secondary)] overflow-hidden">
                <button
                  type="button"
                  onClick={() => setAccountType("business")}
                  className={`px-3 py-1 transition-colors ${
                    accountType === "business"
                      ? "bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)]"
                      : "bg-transparent text-[color:var(--text-secondary)] hover:bg-[var(--bg-surface-muted)]"
                  }`}
                >
                  Restaurant / Food Truck
                </button>
                <button
                  type="button"
                  onClick={() => setAccountType("diner")}
                  className={`px-3 py-1 border-l border-[color:var(--border-subtle)] transition-colors ${
                    accountType === "diner"
                      ? "bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)]"
                      : "bg-transparent text-[color:var(--text-secondary)] hover:bg-[var(--bg-surface-muted)]"
                  }`}
                >
                  Find Food
                </button>
                <button
                  type="button"
                  onClick={() => setAccountType("host")}
                  className={`px-3 py-1 border-l border-[color:var(--border-subtle)] transition-colors ${
                    accountType === "host"
                      ? "bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)]"
                      : "bg-transparent text-[color:var(--text-secondary)] hover:bg-[var(--bg-surface-muted)]"
                  }`}
                >
                  Host
                </button>
                <button
                  type="button"
                  onClick={() => setAccountType("event_organizer")}
                  className={`px-3 py-1 border-l border-[color:var(--border-subtle)] transition-colors ${
                    accountType === "event_organizer"
                      ? "bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)]"
                      : "bg-transparent text-[color:var(--text-secondary)] hover:bg-[var(--bg-surface-muted)]"
                  }`}
                >
                  Event Organizer
                </button>
                <button
                  type="button"
                  onClick={() => setAccountType("supplier")}
                  className={`px-3 py-1 border-l border-[color:var(--border-subtle)] transition-colors ${
                    accountType === "supplier"
                      ? "bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)]"
                      : "bg-transparent text-[color:var(--text-secondary)] hover:bg-[var(--bg-surface-muted)]"
                  }`}
                >
                  Supplier
                </button>
              </div>
            </div>

            {accountType === "business" && (
              <div className="mb-4 rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] p-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--text-secondary)]">
                  Business Type
                </div>
                <div className="mt-2 grid grid-cols-2 overflow-hidden rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] text-[11px] font-semibold text-[color:var(--text-secondary)] shadow-clean">
                  <button
                    type="button"
                    onClick={() => setBusinessSubType("restaurant")}
                    className={`px-3 py-2 transition-colors ${
                      businessSubType === "restaurant"
                        ? "bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)]"
                        : "bg-transparent hover:bg-[var(--bg-surface-muted)]"
                    }`}
                    data-testid="button-business-type-restaurant"
                  >
                    Restaurant
                  </button>
                  <button
                    type="button"
                    onClick={() => setBusinessSubType("food_truck")}
                    className={`border-l border-[color:var(--border-subtle)] px-3 py-2 transition-colors ${
                      businessSubType === "food_truck"
                        ? "bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)]"
                        : "bg-transparent hover:bg-[var(--bg-surface-muted)]"
                    }`}
                    data-testid="button-business-type-food-truck"
                  >
                    Food Truck
                  </button>
                  <button
                    type="button"
                    onClick={() => setBusinessSubType("bar")}
                    className={`border-t border-[color:var(--border-subtle)] px-3 py-2 transition-colors ${
                      businessSubType === "bar"
                        ? "bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)]"
                        : "bg-transparent hover:bg-[var(--bg-surface-muted)]"
                    }`}
                    data-testid="button-business-type-bar"
                  >
                    Bar
                  </button>
                  <button
                    type="button"
                    onClick={() => setBusinessSubType("caterer")}
                    className={`border-l border-t border-[color:var(--border-subtle)] px-3 py-2 transition-colors ${
                      businessSubType === "caterer"
                        ? "bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)]"
                        : "bg-transparent hover:bg-[var(--bg-surface-muted)]"
                    }`}
                    data-testid="button-business-type-caterer"
                  >
                    Caterer
                  </button>
                  <button
                    type="button"
                    onClick={() => setBusinessSubType("private_chef")}
                    className={`col-span-2 border-t border-[color:var(--border-subtle)] px-3 py-2 transition-colors ${
                      businessSubType === "private_chef"
                        ? "bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)]"
                        : "bg-transparent hover:bg-[var(--bg-surface-muted)]"
                    }`}
                    data-testid="button-business-type-private-chef"
                  >
                    Private Chef
                  </button>
                </div>
                {businessSubType === "food_truck" && (
                  <div className="mt-2 text-xs text-[color:var(--text-secondary)]">
                    Create your account, then finish your truck profile. If you
                    followed a claim link, we’ll keep that claim intent through
                    email verification and sign-in.
                  </div>
                )}
              </div>
            )}

            <div className="text-center mb-4">
              <h3 className="text-lg font-bold text-[color:var(--text-primary)] mb-1">
                {accountType === "business"
                  ? "Create Your Personal Login"
                  : "Sign Up with Email"}
              </h3>
              <p className="text-[color:var(--text-secondary)] text-xs">
                {accountType === "business"
                  ? "Your login belongs to you. The business profile is attached next, so teams, ownership, and future locations stay clean."
                  : accountType === "host"
                    ? "This login lets you manage host locations and parking availability."
                    : accountType === "event_organizer"
                      ? "This login gives you event coordinator tools and vendor scheduling access."
                      : accountType === "supplier"
                        ? "This login powers your supplier dashboard, products, and incoming orders."
                        : "Create your account to get started with local food deals."}
              </p>
            </div>

            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="space-y-3"
              >
                {accountType === "business" && (
                  <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] p-3 space-y-3">
                    <div>
                      <div className="text-sm font-black text-[color:var(--text-primary)]">
                        Business profile seed
                      </div>
                      <p className="text-xs text-[color:var(--text-secondary)]">
                        These details start the profile attached to your
                        personal login. You’ll finish the full setup after email
                        verification.
                      </p>
                    </div>
                    <FormField
                      control={form.control}
                      name="businessName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            {businessSubType === "food_truck"
                              ? "Truck Name"
                              : businessSubType === "private_chef"
                                ? "Chef / Brand Name"
                                : "Business Name"}
                          </FormLabel>
                          <FormControl>
                            <Input
                              data-testid="input-business-name"
                              placeholder={
                                businessSubType === "food_truck"
                                  ? "Your food truck"
                                  : businessSubType === "private_chef"
                                    ? "Chef or brand name"
                                    : "Your business"
                              }
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <div className="grid grid-cols-[1fr_5rem] gap-3">
                      <FormField
                        control={form.control}
                        name="businessCity"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>City</FormLabel>
                            <FormControl>
                              <Input
                                data-testid="input-business-city"
                                placeholder="Pensacola"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="businessState"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>State</FormLabel>
                            <FormControl>
                              <Input
                                data-testid="input-business-state"
                                placeholder="FL"
                                maxLength={2}
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </div>
                )}

                {accountType === "host" && (
                  <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] p-3 space-y-3">
                    <div>
                      <div className="text-sm font-black text-[color:var(--text-primary)]">
                        Host location basics
                      </div>
                      <p className="text-xs text-[color:var(--text-secondary)]">
                        Hosts are places where food trucks can park or serve.
                      </p>
                    </div>
                    <FormField
                      control={form.control}
                      name="hostLocationName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Location Name</FormLabel>
                          <FormControl>
                            <Input
                              data-testid="input-host-location-name"
                              placeholder="Venue, lot, church, brewery, office park"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <div className="grid grid-cols-[1fr_5rem] gap-3">
                      <FormField
                        control={form.control}
                        name="businessCity"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>City</FormLabel>
                            <FormControl>
                              <Input placeholder="Pensacola" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="businessState"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>State</FormLabel>
                            <FormControl>
                              <Input
                                placeholder="FL"
                                maxLength={2}
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </div>
                )}

                {accountType === "event_organizer" && (
                  <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] p-3 space-y-3">
                    <div>
                      <div className="text-sm font-black text-[color:var(--text-primary)]">
                        Event basics
                      </div>
                      <p className="text-xs text-[color:var(--text-secondary)]">
                        Start the account now, then finish event details after
                        verification.
                      </p>
                    </div>
                    <FormField
                      control={form.control}
                      name="eventName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Event or Organization Name</FormLabel>
                          <FormControl>
                            <Input
                              data-testid="input-event-name"
                              placeholder="Market, festival, venue, or organization"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="businessCity"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Primary City</FormLabel>
                          <FormControl>
                            <Input placeholder="Pensacola" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                )}

                {accountType === "supplier" && (
                  <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] p-3 space-y-3">
                    <div>
                      <div className="text-sm font-black text-[color:var(--text-primary)]">
                        Supplier basics
                      </div>
                      <p className="text-xs text-[color:var(--text-secondary)]">
                        Tell restaurants and trucks who they will buy from.
                      </p>
                    </div>
                    <FormField
                      control={form.control}
                      name="supplierBusinessName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Supplier Business Name</FormLabel>
                          <FormControl>
                            <Input
                              data-testid="input-supplier-business-name"
                              placeholder="Your supplier company"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="firstName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>First Name</FormLabel>
                        <FormControl>
                          <Input
                            data-testid="input-first-name"
                            autoComplete="given-name"
                            placeholder="John"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="lastName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Last Name</FormLabel>
                        <FormControl>
                          <Input
                            data-testid="input-last-name"
                            autoComplete="family-name"
                            placeholder="Doe"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 text-[color:var(--text-muted)] w-4 h-4" />
                          <Input
                            data-testid="input-email"
                            type="email"
                            autoComplete="email"
                            placeholder="john@example.com"
                            className="pl-10"
                            {...field}
                          />
                        </div>
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
                      <FormLabel>
                        Phone <span className="text-[color:var(--status-error)]">*</span>
                      </FormLabel>
                      <FormControl>
                        <div className="flex gap-2">
                          <Input
                            data-testid="input-phone"
                            type="tel"
                            autoComplete="tel"
                            placeholder="(555) 123-4567"
                            {...field}
                          />
                          {requirePhoneVerification && (
                            <Button
                              type="button"
                              variant="outline"
                              onClick={handleSendOtp}
                              disabled={otpSending}
                            >
                              {otpSending
                                ? "Sending..."
                                : otpSent
                                  ? "Resend"
                                  : "Send code"}
                            </Button>
                          )}
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {requirePhoneVerification && (
                  <FormField
                    control={form.control}
                    name="otpCode"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Verification Code</FormLabel>
                        <FormControl>
                          <InputOTP
                            maxLength={6}
                            value={field.value}
                            onChange={field.onChange}
                          >
                            <InputOTPGroup>
                              {[0, 1, 2, 3, 4, 5].map((index) => (
                                <InputOTPSlot key={index} index={index} />
                              ))}
                            </InputOTPGroup>
                          </InputOTP>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                <FormField
                  control={form.control}
                  name="phoneContactConsent"
                  render={({ field }) => (
                    <FormItem className="rounded-md border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] p-3">
                      <div className="flex items-start gap-2">
                        <FormControl>
                          <input
                            type="checkbox"
                            checked={field.value}
                            onChange={(event) => field.onChange(event.target.checked)}
                            className="mt-1 h-4 w-4"
                            data-testid="checkbox-phone-contact-consent"
                          />
                        </FormControl>
                        <FormLabel className="text-sm font-normal leading-5">
                          I agree MealScout may call or text me about onboarding.
                          I can opt out anytime.
                        </FormLabel>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Password</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Input
                            data-testid="input-password"
                            type={showPassword ? "text" : "password"}
                            autoComplete="new-password"
                            placeholder="Enter password"
                            {...field}
                          />
                          <button
                            data-testid="button-toggle-password"
                            type="button"
                            onClick={() => setShowPassword(!showPassword)}
                            className="absolute right-3 top-1/2 transform -translate-y-1/2 text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
                          >
                            {showPassword ? (
                              <EyeOff className="w-4 h-4" />
                            ) : (
                              <Eye className="w-4 h-4" />
                            )}
                          </button>
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="confirmPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Confirm Password</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Input
                            data-testid="input-confirm-password"
                            type={showConfirmPassword ? "text" : "password"}
                            autoComplete="new-password"
                            placeholder="Confirm password"
                            {...field}
                          />
                          <button
                            data-testid="button-toggle-confirm-password"
                            type="button"
                            onClick={() =>
                              setShowConfirmPassword(!showConfirmPassword)
                            }
                            className="absolute right-3 top-1/2 transform -translate-y-1/2 text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
                          >
                            {showConfirmPassword ? (
                              <EyeOff className="w-4 h-4" />
                            ) : (
                              <Eye className="w-4 h-4" />
                            )}
                          </button>
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {accountType === "business" && (
                  <FormField
                    control={form.control}
                    name="acceptTerms"
                    render={({ field }) => (
                      <FormItem className="rounded-md border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] p-3">
                        <div className="flex items-start gap-2">
                          <FormControl>
                            <input
                              type="checkbox"
                              checked={field.value}
                              onChange={(event) => field.onChange(event.target.checked)}
                              className="mt-1 h-4 w-4"
                              data-testid="checkbox-terms"
                            />
                          </FormControl>
                          <FormLabel className="text-sm font-normal leading-5">
                            I agree to the{" "}
                            <Link href="/terms-of-service">
                              <span className="text-[color:var(--accent-text)] underline cursor-pointer">
                                Terms of Service
                              </span>
                            </Link>{" "}
                            and{" "}
                            <Link href="/privacy-policy">
                              <span className="text-[color:var(--accent-text)] underline cursor-pointer">
                                Privacy Policy
                              </span>
                            </Link>
                          </FormLabel>
                        </div>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                <Button
                  data-testid="button-create-account"
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full py-3 font-semibold text-base rounded-2xl bg-[color:var(--action-primary)] hover:bg-[color:var(--action-hover)] text-[color:var(--action-primary-text)] border-0 shadow-clean hover:shadow-clean-lg transform hover:scale-[1.01] active:scale-[0.98] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
                >
                  {isSubmitting ? (
                    <div className="animate-spin w-5 h-5 mr-3 border-2 border-white border-t-transparent rounded-full" />
                  ) : null}
                  {accountType === "business" &&
                  businessSubType === "food_truck"
                    ? "Create Account & Claim Food Truck"
                    : "Create Account"}
                </Button>
              </form>
            </Form>

            {/* Divider + Login Link (compressed) */}
            <div className="mt-3 flex items-center justify-between text-xs text-[color:var(--text-secondary)]">
              <span>Already have an account?</span>
              <Link href="/login">
                <button
                  type="button"
                  className="text-[color:var(--accent-text)] underline hover:text-[color:var(--accent-text)]"
                  data-testid="button-sign-in"
                >
                  Sign in
                </button>
              </Link>
            </div>

            {/* Trust indicators (compressed) */}
            <div className="mt-3 border-t border-[color:var(--border-subtle)] pt-2 flex items-center justify-center gap-4 text-[11px] leading-tight text-[color:var(--text-muted)]">
              <div className="flex items-center space-x-1">
                <svg
                  className="w-3 h-3 text-[color:var(--status-success)]"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                <span>
                  {accountType === "business"
                    ? "Transparent pricing"
                    : "Local restaurants & trucks"}
                </span>
              </div>
              <div className="flex items-center space-x-1">
                <svg
                  className="w-3 h-3 text-[color:var(--status-success)]"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                  />
                </svg>
                <span>
                  {accountType === "business"
                    ? "You control every discount"
                    : "Secure"}
                </span>
              </div>
              <div className="flex items-center space-x-1">
                <svg
                  className="w-3 h-3 text-[color:var(--status-success)]"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M13 10V3L4 14h7v7l9-11h-7z"
                  />
                </svg>
                <span>
                  {accountType === "business"
                    ? "Local customers get the savings"
                    : "Instant Access"}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom: Legal Links */}
        <div className="mt-2 text-center">
          <p className="text-[11px] text-[color:var(--text-muted)]">
            By creating an account, you agree to our{" "}
            <Link href="/terms-of-service">
              <span className="text-[color:var(--accent-text)] underline hover:text-[color:var(--accent-text)] cursor-pointer">
                Terms of Service
              </span>
            </Link>{" "}
            and{" "}
            <Link href="/privacy-policy">
              <span className="text-[color:var(--accent-text)] underline hover:text-[color:var(--accent-text)] cursor-pointer">
                Privacy Policy
              </span>
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
