import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  CheckCircle2,
  MailCheck,
  MapPin,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { SEOHead } from "@/components/seo-head";
import { CANONICAL_DASHBOARD_ENTRY_PATH } from "@/lib/dashboard-route";
import {
  getProgressiveAccountGate,
  preserveProgressiveAuthContext,
  resolveProgressivePostVerificationDestination,
} from "@shared/progressiveOnboarding";

const REDIRECT_STORAGE_KEY = "mealscout:post-verification-redirect";
const EMAIL_STORAGE_KEY = "mealscout:lastSignupEmail";

function getStoredValue(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function getBestRedirect(params: URLSearchParams): string {
  return resolveProgressivePostVerificationDestination(
    params,
    params.get("redirect"),
    getStoredValue(REDIRECT_STORAGE_KEY),
    CANONICAL_DASHBOARD_ENTRY_PATH,
  );
}

function getLoginHref(redirectPath: string, verified: boolean, source: URLSearchParams) {
  const params = new URLSearchParams();
  if (verified) params.set("verified", "1");
  params.set("redirect", redirectPath);
  return preserveProgressiveAuthContext(`/login?${params.toString()}`, source);
}

type SetupBrief = {
  label: string;
  description: string;
  steps: string[];
  optionalSteps: string[];
};

function getSetupBrief(redirectPath: string): SetupBrief {
  const lowerRedirectPath = redirectPath.toLowerCase();
  const signupPath = redirectPath.startsWith("/restaurant-signup")
    ? new URLSearchParams(redirectPath.split("?")[1] || "")
    : null;
  const redirectBusinessType = String(
    signupPath?.get("businessType") || "",
  ).toLowerCase();
  const isFoodTruckSetup =
    redirectPath.startsWith("/truck-onboarding") ||
    (redirectPath.startsWith("/restaurant-signup") &&
      lowerRedirectPath.includes("businesstype=food_truck"));
  const isBarSetup =
    redirectPath.startsWith("/restaurant-signup") &&
    redirectBusinessType === "bar";

  if (isFoodTruckSetup) {
    return {
      label: "Food truck setup",
      description:
        "Claim or create the truck, then use any free or paid AI to prepare the menu, prices, images, schedule, events, and matching social previews together.",
      steps: ["Personal login", "Truck profile", "AI-prepared setup", "Owner approval"],
      optionalSteps: ["Manual profile, menu, and schedule tools remain available"],
    };
  }
  if (isBarSetup) {
    return {
      label: "Bar setup",
      description:
        "Finish the bar profile with any AI you already use, then approve its complete preview for hours, events or specials, images, and matching social posts.",
      steps: ["Personal login", "Bar profile", "AI-prepared setup", "Owner approval"],
      optionalSteps: [
        "Food menu (if serves food)",
        "Host food trucks (if enabled)",
        "Staff showcase",
      ],
    };
  }
  if (redirectPath.startsWith("/restaurant-signup")) {
    return {
      label: "Business setup",
      description:
        "Connect the business, then use any free or paid AI to prepare the profile, menu and prices, images, hours, deals, and matching social previews together.",
      steps: ["Personal login", "Business profile", "AI-prepared setup", "Owner approval"],
      optionalSteps: ["Manual profile, menu, photo, and hours tools remain available"],
    };
  }
  if (redirectPath.startsWith("/host-signup")) {
    return {
      label: "Parking host setup",
      description:
        "Create the host location where food trucks can park, set availability, and publish only when the listing is ready.",
      steps: ["Personal login", "Host location", "Availability", "Publish"],
      optionalSteps: [],
    };
  }
  if (
    redirectPath.startsWith("/event-coordinator/dashboard")
  ) {
    return {
      label: "Event organizer setup",
      description:
        "Create the organizer profile, add the first event, and invite or request food vendors without skipping account ownership.",
      steps: ["Personal login", "Organizer profile", "First event", "Vendor needs"],
      optionalSteps: [],
    };
  }
  if (redirectPath.startsWith("/supplier")) {
    return {
      label: "Supplier setup",
      description:
        "Finish the supplier profile, add product/service areas, and connect with local restaurants and trucks.",
      steps: ["Personal login", "Supplier profile", "Products", "Service area"],
      optionalSteps: [],
    };
  }
  return {
    label: "Scout dashboard",
    description:
      "Scout is your local food dashboard for live trucks, restaurants, menus, deals, hosts, and saved spots.",
    steps: ["Personal login", "Location", "Preferences", "Scout"],
    optionalSteps: [],
  };
}

export default function PostVerification() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const { toast } = useToast();
  const [isResending, setIsResending] = useState(false);
  const [isCheckingVerification, setIsCheckingVerification] = useState(false);

  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const redirectPath = useMemo(() => getBestRedirect(params), [params]);
  const canContinue = isAuthenticated && getProgressiveAccountGate(user) === "continue";
  const email = user?.email || getStoredValue(EMAIL_STORAGE_KEY) || "";
  const mode = params.get("status") || "";
  const isSetupComplete = params.get("setup") === "complete";
  const isVerified = canContinue || (!isAuthenticated && params.get("verified") === "1");
  const needsEmailCheck = mode === "check-email" || isSetupComplete || (isAuthenticated && !canContinue);
  const loginHref = getLoginHref(redirectPath, isVerified, params);
  const setupBrief = useMemo(() => getSetupBrief(redirectPath), [redirectPath]);
  const showsOwnerAiHandoff =
    redirectPath.startsWith("/truck-onboarding") ||
    redirectPath.startsWith("/restaurant-signup");

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const clearStoredRedirect = () => {
    try {
      window.sessionStorage.removeItem(REDIRECT_STORAGE_KEY);
    } catch {}
  };

  const handleResendVerification = async () => {
    if (!email) {
      toast({
        title: "Email needed",
        description: "Use the login page to enter your email and resend the verification link.",
        variant: "destructive",
      });
      return;
    }

    setIsResending(true);
    try {
      await apiRequest("POST", "/api/auth/resend-verification", {
        email,
        intendedNextPath: redirectPath,
      });
      toast({
        title: "Verification sent",
        description: "If that account still needs verification, a fresh link is on the way.",
      });
    } catch (error: any) {
      toast({
        title: "Could not resend",
        description: error?.message || "Please try again from the login page.",
        variant: "destructive",
      });
    } finally {
      setIsResending(false);
    }
  };

  const handleVerifiedContinue = async () => {
    if (!email) {
      toast({
        title: "Email needed",
        description: "Use the login page with your signup email to continue.",
        variant: "destructive",
      });
      return;
    }

    setIsCheckingVerification(true);
    try {
      const response = await apiRequest("POST", "/api/auth/verification-status", {
        email,
      });
      const payload = await response.json();
      if (!payload?.verified) {
        toast({
          title: "Email not verified yet",
          description:
            "Please click the verification link in your inbox first, then try again.",
          variant: "destructive",
        });
        return;
      }
      clearStoredRedirect();
      window.location.href = loginHref;
    } catch (error: any) {
      toast({
        title: "Could not verify status",
        description: error?.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsCheckingVerification(false);
    }
  };

  const headline = canContinue
    ? "You are ready to continue."
    : needsEmailCheck
      ? isSetupComplete
        ? "Account setup is complete."
        : "Check your email."
      : isVerified
        ? "Email verified."
        : "Finish your MealScout setup.";

  const body = canContinue
    ? "Your account is active. Continue to the next step MealScout picked for this account."
    : needsEmailCheck
      ? "Verify your email, then continue to your saved destination. You can request a fresh link below."
      : isVerified
        ? "Your email is verified. Log in once and we will take you to the next step for your account."
        : "Use this page as your checkpoint after signup, email verification, or account setup.";

  const statusLabel = canContinue
    ? "Signed in"
    : isVerified
      ? "Verified"
      : "Email step";

  return (
    <div className="min-h-screen overflow-hidden bg-[#07090d] text-white">
      <SEOHead
        title="Continue Setup - MealScout"
        description="Continue your MealScout account setup after email verification."
        noIndex={true}
      />

      <div className="fixed inset-0" aria-hidden="true">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_15%,rgba(245,158,11,0.24),transparent_34%),radial-gradient(circle_at_80%_0%,rgba(249,115,22,0.16),transparent_28%),linear-gradient(180deg,#080a0f_0%,#050608_100%)]" />
        <div className="absolute left-1/2 top-24 h-72 w-72 -translate-x-1/2 rounded-full bg-amber-500/10 blur-3xl" />
        <div className="absolute inset-x-0 bottom-0 h-72 bg-gradient-to-t from-black via-black/50 to-transparent" />
      </div>

      <main className="relative z-10 flex min-h-screen items-center justify-center px-5 py-10">
        <section className="w-full max-w-lg rounded-[2rem] border border-white/10 bg-white/[0.075] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.55)] backdrop-blur-2xl sm:p-8">
          <div className="mb-8 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-400 text-black shadow-[0_0_30px_rgba(251,191,36,0.45)]">
                {isVerified || canContinue ? (
                  <CheckCircle2 className="h-5 w-5" />
                ) : (
                  <MailCheck className="h-5 w-5" />
                )}
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.22em] text-amber-200/80">
                  MealScout
                </p>
                <p className="text-sm text-white/55">Account handoff</p>
              </div>
            </div>
            <span className="rounded-full border border-amber-300/25 bg-amber-300/10 px-3 py-1 text-xs font-bold text-amber-200">
              {statusLabel}
            </span>
          </div>

          <h1 className="mb-4 text-4xl font-black leading-none tracking-tight sm:text-5xl">
            {headline}
          </h1>
          <p className="mb-8 text-base leading-7 text-white/70">{body}</p>

          <div className="mb-8 rounded-2xl border border-white/10 bg-black/30 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-bold text-white">
              <MapPin className="h-4 w-4 text-amber-300" />
              {setupBrief.label}
            </div>
            <p className="text-sm text-white/60">
              {setupBrief.description}
            </p>
            {showsOwnerAiHandoff ? (
              <div
                className="mt-3 flex gap-2 rounded-xl border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-xs leading-5 text-amber-100"
                data-testid="post-verification-owner-ai-handoff"
              >
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  Sign your favorite AI into MealScout and connect the social
                  accounts you use. It prepares the exact preview, then can
                  apply and publish only after the actual owner approves that
                  revision in the AI chat or on MealScout.
                </span>
              </div>
            ) : null}
            <div className="mt-4 grid grid-cols-2 gap-2">
              {setupBrief.steps.map((step, index) => (
                <div
                  key={step}
                  className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2"
                >
                  <div className="text-[10px] font-black uppercase tracking-[0.18em] text-amber-200/60">
                    Step {index + 1}
                  </div>
                  <div className="text-xs font-bold text-white/85">{step}</div>
                </div>
              ))}
            </div>
            {setupBrief.optionalSteps.length > 0 ? (
              <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
                <div className="text-[10px] font-black uppercase tracking-[0.18em] text-amber-200/60">
                  Optional
                </div>
                <div className="mt-1 text-xs font-medium text-white/70">
                  {setupBrief.optionalSteps.join(" • ")}
                </div>
              </div>
            ) : null}
          </div>

          {isLoading ? (
            <div className="flex h-14 items-center justify-center rounded-2xl bg-white/10">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-amber-300 border-t-transparent" />
            </div>
          ) : canContinue ? (
            <Link
              href={redirectPath}
              onClick={clearStoredRedirect}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-amber-400 font-black text-black shadow-[0_12px_40px_rgba(251,191,36,0.28)] transition active:scale-[0.98]"
            >
              Continue
              <ArrowRight className="h-5 w-5" />
            </Link>
          ) : needsEmailCheck ? (
            <div className="space-y-3">
              <button
                type="button"
                onClick={handleVerifiedContinue}
                disabled={isCheckingVerification}
                className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-amber-400 font-black text-black shadow-[0_12px_40px_rgba(251,191,36,0.28)] transition active:scale-[0.98]"
              >
                {isCheckingVerification ? "Checking verification..." : "I verified, log in"}
                <ArrowRight className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={handleResendVerification}
                disabled={isResending}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/10 font-bold text-white/80 transition hover:bg-white/15 disabled:opacity-60"
              >
                <RefreshCw className={`h-4 w-4 ${isResending ? "animate-spin" : ""}`} />
                {isResending ? "Sending..." : "Resend verification email"}
              </button>
            </div>
          ) : (
            <Link
              href={loginHref}
              onClick={clearStoredRedirect}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-amber-400 font-black text-black shadow-[0_12px_40px_rgba(251,191,36,0.28)] transition active:scale-[0.98]"
            >
              Log in to continue
              <ArrowRight className="h-5 w-5" />
            </Link>
          )}

          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-white/40">
            <Link href="/scout" className="hover:text-amber-200">
              Explore Scout
            </Link>
            <span aria-hidden="true">/</span>
            <Link href={loginHref} className="hover:text-amber-200">
              Login help
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
