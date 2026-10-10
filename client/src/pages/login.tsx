import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/hooks/useAuth";
import { fetchJsonWithRetry } from "@/lib/resilientFetch";
import { Card, CardContent } from "@/components/ui/card";
import { BackHeader } from "@/components/back-header";
import { UserCheck, Eye, EyeOff } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { authUrl } from "@/lib/api";
import { CANONICAL_DASHBOARD_ENTRY_PATH } from "@/lib/dashboard-route";
import { SEOHead } from "@/components/seo-head";
import {
  FUNNEL_EVENTS,
  toSafeFunnelDestinationPath,
  trackFunnelEvent,
  trackFunnelEventOncePerSession,
} from "@/utils/funnelTelemetry";
import { getStoredAffiliateRef, setAffiliateRef } from "@/lib/share";
import { normalizeSafeInternalPath } from "@shared/safeInternalPath";
import { preserveProgressiveAuthContext } from "@shared/progressiveOnboarding";

const getSafeRedirectPath = (): string | null => {
  try {
    const params = new URLSearchParams(window.location.search);
    return normalizeSafeInternalPath(params.get("redirect"));
  } catch {
    return null;
  }
};

export default function Login() {
  const { isAuthenticated, isLoading } = useAuth();
  const { toast } = useToast();
  const [isProcessing, setIsProcessing] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [isResendingVerification, setIsResendingVerification] = useState(false);
  const [showEmailLogin, setShowEmailLogin] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [showRecoveryHelp, setShowRecoveryHelp] = useState(false);
  const redirectPath = getSafeRedirectPath();
  const buildAuthPath = (basePath: string) => {
    const params = new URLSearchParams(window.location.search);
    const urlReferralTag = String(params.get("ref") || "").trim();
    const storedRef = String(urlReferralTag || getStoredAffiliateRef() || "").trim();
    const url = new URL(basePath, window.location.origin);
    if (redirectPath) url.searchParams.set("redirect", redirectPath);
    if (storedRef && !url.searchParams.has("ref")) url.searchParams.set("ref", storedRef);
    return preserveProgressiveAuthContext(`${url.pathname}${url.search}${url.hash}`, params);
  };

  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get("ref")?.trim();
    if (ref) setAffiliateRef(ref);
  }, []);

  const attemptLoginWithRetry = async () =>
    fetchJsonWithRetry<Record<string, any>>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    }, {
      attempts: 2,
      retryStatuses: [503],
      baseDelayMs: 800,
      timeoutMs: 10000,
      fallbackValue: {},
    });

  useEffect(() => {
    trackFunnelEventOncePerSession(FUNNEL_EVENTS.signupStarted, "login_view", {
      page: "login",
      stage: "login_view",
    });
  }, []);

  useEffect(() => {
    if (email) return;
    try {
      const stored = window.sessionStorage.getItem("mealscout:lastSignupEmail");
      if (stored) setEmail(stored);
    } catch {}
  }, [email]);

  const handleGoogleLogin = () => {
    const googleLoginUrl = authUrl(buildAuthPath("/api/auth/google/customer"));
    trackFunnelEvent(FUNNEL_EVENTS.primaryCtaClick, {
      page: "login",
      cta: "google_login",
      destination: toSafeFunnelDestinationPath(googleLoginUrl),
    });
    window.location.href = googleLoginUrl;
  };

  const handleFacebookLogin = () => {
    const facebookLoginUrl = authUrl(
      buildAuthPath("/api/auth/facebook?userType=customer"),
    );
    trackFunnelEvent(FUNNEL_EVENTS.primaryCtaClick, {
      page: "login",
      cta: "facebook_login",
      destination: toSafeFunnelDestinationPath(facebookLoginUrl),
    });
    window.location.href = facebookLoginUrl;
  };

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    trackFunnelEvent(FUNNEL_EVENTS.signupSubmitted, {
      page: "login",
      stage: "email_login_submit",
    });
    if (!email || !password) {
      toast({
        title: "Missing Information",
        description: "Please enter both email and password.",
        variant: "destructive",
      });
      return;
    }

    setIsLoggingIn(true);
    setNeedsVerification(false);
    setShowRecoveryHelp(false);
    try {
      const { response, data: payload } = await attemptLoginWithRetry();

      if (!response.ok) {
        if (payload?.code === "google_auth_required") {
          toast({
            title: "Continue with Google",
            description:
              payload?.error ||
              "This email is linked to Google. Redirecting now...",
          });
          const nextAuthPath =
            typeof payload?.authUrl === "string" && payload.authUrl.startsWith("/")
              ? payload.authUrl
              : "/api/auth/google/customer";
          window.location.href = authUrl(buildAuthPath(nextAuthPath));
          return;
        }
        if (payload?.code === "email_not_verified") {
          setNeedsVerification(true);
        }
        if (response.status === 503) {
          throw new Error(
            "MealScout is temporarily unavailable. Please retry in a few seconds.",
          );
        }
        throw new Error(payload?.error || "Login failed");
      }
      // Refresh auth state before redirect to prevent showing guest view
      try {
        await queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
        await queryClient.refetchQueries({ queryKey: ["/api/auth/user"] });
      } catch {}
      // Small delay to ensure cookie/session propagation
      await new Promise((r) => setTimeout(r, 200));
      // Redirect after login (many flows pass `?redirect=` to /login)
      trackFunnelEvent(FUNNEL_EVENTS.activationStarted, {
        page: "login",
        stage: "post_login_redirect",
        redirectPath: toSafeFunnelDestinationPath(
          redirectPath || CANONICAL_DASHBOARD_ENTRY_PATH,
        ),
      });
      try {
        window.sessionStorage.removeItem("mealscout:post-verification-redirect");
      } catch {}
      window.location.href = redirectPath || CANONICAL_DASHBOARD_ENTRY_PATH;
    } catch (error: any) {
      setShowRecoveryHelp(true);
      toast({
        title: "Login Failed",
        description:
          error.message ||
          "Invalid email or password. If you cannot sign in, reset your password.",
        variant: "destructive",
      });
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleResendVerification = async () => {
    if (!email) {
      toast({
        title: "Email Required",
        description: "Enter your email first so we know where to send the link.",
        variant: "destructive",
      });
      return;
    }

    setIsResendingVerification(true);
    try {
      await apiRequest("POST", "/api/auth/resend-verification", {
        email,
        ...(redirectPath ? { intendedNextPath: redirectPath } : {}),
      });
      toast({
        title: "Verification Sent",
        description:
          "If that account exists and still needs verification, a fresh link is on the way.",
      });
    } catch (error: any) {
      toast({
        title: "Unable to Send Link",
        description:
          error.message || "We couldn't resend the verification email right now.",
        variant: "destructive",
      });
    } finally {
      setIsResendingVerification(false);
    }
  };

  // Redirect to home if already authenticated
  useEffect(() => {
    if (isAuthenticated) {
      try {
        window.sessionStorage.removeItem("mealscout:post-verification-redirect");
      } catch {}
      window.location.href = redirectPath || CANONICAL_DASHBOARD_ENTRY_PATH;
    }
  }, [isAuthenticated, redirectPath]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("verified") === "1") {
      toast({
        title: "Email Verified",
        description: "Your email is verified. Log in to continue.",
      });
    }
    if (params.get("error") === "session_not_completed") {
      toast({
        title: "Login Session Not Completed",
        description:
          "MealScout could not confirm your signed-in session. Please log in again.",
        variant: "destructive",
      });
    }
  }, [toast]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[var(--bg-layered)] flex items-center justify-center">
        <div className="animate-spin w-12 h-12 border-4 border-[color:var(--action-primary)] border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg-layered)]">
      <SEOHead
        title="Login - MealScout | Access Your Account"
        description="Log in to MealScout to discover exclusive food deals, save your favorite restaurants, and track your claimed deals. Join thousands of users finding amazing dining discounts."
        keywords="login, sign in, mealscout account, food deals login, restaurant deals access"
        canonicalUrl="https://www.mealscout.us/login"
        noIndex={true}
      />
      <h1 className="sr-only">Login to MealScout</h1>
      <BackHeader
        title="Log In"
        fallbackHref="/"
        icon={UserCheck}
        className="bg-[hsl(var(--background))/0.94] border-b border-[color:var(--border-subtle)] shadow-clean"
      />

      <div className="px-4 sm:px-6 py-8 max-w-md mx-auto">
        {/* Welcome Section */}
        <div className="text-center mb-8">
          <h2 className="text-2xl font-bold text-[color:var(--text-primary)] mb-2">
            Welcome Back
          </h2>
          <p className="text-[color:var(--text-secondary)] text-sm">
            Log in to access your saved deals and favorites
          </p>
        </div>

        {/* Login Card */}
        <div className="bg-[var(--bg-card)] border border-[color:var(--border-subtle)] rounded-2xl shadow-clean-lg p-8">
          <div className="text-center mb-6">
            <h3 className="text-xl font-bold text-[color:var(--text-primary)] mb-2">
              Sign In
            </h3>
            <p className="text-[color:var(--text-secondary)] text-sm">
              Choose your preferred method
            </p>
          </div>
          {/* Google Login */}
          <button
            onClick={handleGoogleLogin}
            disabled={isProcessing}
            className="w-full py-4 px-6 font-semibold text-lg rounded-xl bg-[var(--bg-surface)] border border-[color:var(--border-subtle)] text-[color:var(--text-primary)] hover:bg-[var(--bg-surface-muted)] transition-all duration-200 mb-4 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center shadow-clean"
            data-testid="button-google-signin"
          >
            {isProcessing ? (
              <div className="animate-spin w-5 h-5 mr-3 border-2 border-[color:var(--text-secondary)] border-t-transparent rounded-full" />
            ) : (
              <svg className="w-5 h-5 mr-3" viewBox="0 0 24 24">
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
            )}
            Continue with Google
          </button>

          {/* Facebook Login */}
          <button
            onClick={handleFacebookLogin}
            disabled={isProcessing}
            className="w-full py-4 px-6 font-semibold text-lg rounded-xl bg-[#1877F2] text-white hover:bg-[#166fe5] transition-all duration-200 mb-6 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center shadow-clean"
            data-testid="button-facebook-login"
          >
            {isProcessing ? (
              <div className="animate-spin w-5 h-5 mr-3 border-2 border-white border-t-transparent rounded-full" />
            ) : (
              <svg
                className="w-5 h-5 mr-3"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
              </svg>
            )}
            Continue with Facebook
          </button>

          {/* Divider */}
          <div className="relative mb-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-[color:var(--border-subtle)]"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="bg-[var(--bg-card)] px-4 text-[color:var(--text-secondary)]">
                Or continue with email
              </span>
            </div>
          </div>

          {/* Toggle between email login and signup */}
          {!showEmailLogin ? (
            <div className="space-y-4">
              <button
                onClick={() => setShowEmailLogin(true)}
                className="w-full py-4 px-6 font-semibold text-lg rounded-xl border border-[color:var(--border-subtle)] text-[color:var(--text-primary)] hover:bg-[var(--bg-surface-muted)] transition-all duration-200 flex items-center justify-center shadow-clean"
                data-testid="button-email-login"
              >
                Sign In with Email
              </button>

              <Link href={buildAuthPath("/customer-signup")}>
                <button
                  data-testid="button-customer-signup"
                  className="w-full py-3 px-4 font-medium text-sm rounded-lg border border-[color:var(--action-primary)] text-[color:var(--action-primary)] hover:bg-[var(--bg-surface-muted)] transition-all duration-200 flex items-center justify-center"
                >
                  Create Account
                </button>
              </Link>

              <div className="text-center">
                <Link
                  href="/forgot-password"
                  className="text-[color:var(--accent-text)] hover:text-[color:var(--accent-text-hover)] text-sm underline underline-offset-4"
                  data-testid="link-forgot-password-options"
                  data-recovery-action="navigate-only"
                >
                  Forgot or need to reset your password?
                </Link>
              </div>
            </div>
          ) : (
            <form onSubmit={handleEmailLogin} className="space-y-4">
              <div>
                <input
                  type="email"
                  placeholder="Email address"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl border border-[color:var(--border-subtle)] bg-[var(--field-bg)] focus:outline-none focus:ring-2 focus:ring-[color:var(--action-primary)] text-lg"
                  data-testid="input-email"
                  required
                />
              </div>

              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl border border-[color:var(--border-subtle)] bg-[var(--field-bg)] focus:outline-none focus:ring-2 focus:ring-[color:var(--action-primary)] text-lg pr-12"
                  data-testid="input-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)]"
                  data-testid="button-toggle-password"
                >
                  {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>

              <button
                type="submit"
                disabled={isLoggingIn}
                className="w-full py-4 px-6 font-semibold text-lg rounded-xl bg-[color:var(--action-primary)] text-[color:var(--action-primary-text)] hover:bg-[color:var(--action-hover)] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center shadow-clean"
                data-testid="button-login-submit"
              >
                {isLoggingIn ? (
                  <div className="animate-spin w-5 h-5 mr-3 border-2 border-white border-t-transparent rounded-full" />
                ) : null}
                {isLoggingIn ? "Signing In..." : "Sign In"}
              </button>

              {showRecoveryHelp ? (
                <div
                  className="rounded-xl border border-[color:var(--status-warning)]/40 bg-[color:var(--status-warning)]/10 p-4 text-sm"
                  data-testid="login-recovery-help"
                >
                  <p className="font-medium text-[color:var(--text-primary)]">
                    Having trouble signing in?
                  </p>
                  <p className="mt-1 text-[color:var(--text-secondary)]">
                    If your password is not working, request a secure reset link.
                  </p>
                  <Link
                    href="/forgot-password"
                    className="mt-3 inline-block text-[color:var(--accent-text)] underline underline-offset-4 hover:text-[color:var(--accent-text-hover)]"
                    data-testid="link-login-error-reset-password"
                    data-recovery-action="navigate-only"
                  >
                    Reset your password
                  </Link>
                </div>
              ) : null}

              {needsVerification ? (
                <div className="rounded-xl border border-[color:var(--status-warning)]/40 bg-[color:var(--status-warning)]/10 p-4 text-sm">
                  <p className="font-medium text-[color:var(--text-primary)]">
                    Verify your email to finish signing in.
                  </p>
                  <p className="mt-1 text-[color:var(--text-secondary)]">
                    Your account exists, but email verification is still pending.
                  </p>
                  <button
                    type="button"
                    onClick={handleResendVerification}
                    disabled={isResendingVerification}
                    className="mt-3 text-[color:var(--accent-text)] underline underline-offset-4 hover:text-[color:var(--accent-text-hover)] disabled:opacity-60"
                    data-testid="button-resend-verification"
                  >
                    {isResendingVerification
                      ? "Sending verification link..."
                      : "Resend verification email"}
                  </button>
                </div>
              ) : null}

              <button
                type="button"
                onClick={() => setShowEmailLogin(false)}
                className="w-full text-center text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)] transition-colors"
                data-testid="button-back-to-options"
              >
                Back to login options
              </button>

              <div className="text-center">
                <Link
                  href="/forgot-password"
                  className="text-[color:var(--accent-text)] hover:text-[color:var(--accent-text-hover)] text-sm"
                  data-recovery-action="navigate-only"
                >
                  Forgot your password?
                </Link>
              </div>
            </form>
          )}

          {/* Trust indicators */}
          <div className="pt-4 border-t border-[color:var(--border-subtle)]">
            <div className="flex items-center justify-center space-x-6 text-xs text-[color:var(--text-secondary)]">
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
                <span>100% Free</span>
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
                <span>Secure</span>
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
                <span>Instant Access</span>
              </div>
            </div>
          </div>
        </div>

        {/* Business Link */}
        <div className="mt-8 text-center">
          <p className="text-[color:var(--text-secondary)] text-sm mb-3">
            Looking to promote your business?
          </p>
          <Link href={buildAuthPath("/customer-signup?role=business")}>
            <button
              className="py-2 px-4 font-medium text-[color:var(--action-primary)] border border-[color:var(--action-primary)] hover:bg-[var(--bg-surface-muted)] rounded-lg transition-all duration-200"
              data-testid="link-business-signup"
            >
              Business Sign Up -&gt;
            </button>
          </Link>
        </div>

        {/* Legal Links */}
        <div className="mt-6 text-center">
          <p className="text-xs text-[color:var(--text-secondary)]">
            By using MealScout, you agree to our{" "}
            <Link href="/terms-of-service">
              <span className="text-[color:var(--accent-text)] underline hover:text-[color:var(--accent-text-hover)] cursor-pointer">
                Terms of Service
              </span>
            </Link>{" "}
            and{" "}
            <Link href="/privacy-policy">
              <span className="text-[color:var(--accent-text)] underline hover:text-[color:var(--accent-text-hover)] cursor-pointer">
                Privacy Policy
              </span>
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
