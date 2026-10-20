import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Eye, EyeOff, CheckCircle, KeyRound, AlertTriangle } from "lucide-react";
import { BackHeader } from "@/components/back-header";
import { SEOHead } from "@/components/seo-head";
import { useAuth } from "@/hooks/useAuth";
import { getAccountContinuationPath } from "@/lib/dashboard-route";
import {
  PASSWORD_REGEX,
  PASSWORD_REQUIREMENTS,
} from "@/utils/passwordPolicy";
import { normalizeSafeInternalPath } from "@shared/safeInternalPath";

const accountSetupSchema = z
  .object({
    password: z
      .string()
      .min(1, PASSWORD_REQUIREMENTS)
      .regex(PASSWORD_REGEX, PASSWORD_REQUIREMENTS),
    confirmPassword: z.string().min(1, "Please confirm your password"),
    firstName: z.string().min(1, "First name is required"),
    lastName: z.string().min(1, "Last name is required"),
    phone: z
      .string()
      .refine(
        (value) => value.replace(/\D/g, "").length >= 10,
        "Phone number must include at least 10 digits",
      ),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

type AccountSetupFormData = z.infer<typeof accountSetupSchema>;

const phoneOnlySetupSchema = z.object({
  phone: z
    .string()
    .refine(
      (value) => value.replace(/\D/g, "").length >= 10,
      "Phone number must include at least 10 digits",
    ),
  phoneContactConsent: z.boolean().default(true),
});

type PhoneOnlySetupFormData = z.infer<typeof phoneOnlySetupSchema>;

const getNoTokenContinuationPath = getAccountContinuationPath;

export default function AccountSetup() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user, isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [token, setToken] = useState<string | null>(() => {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get("token");
  });
  const [phoneRequired, setPhoneRequired] = useState(() => {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get("phoneRequired") === "1";
  });
  const [phoneRedirectPath, setPhoneRedirectPath] = useState(() => {
    const urlParams = new URLSearchParams(window.location.search);
    return normalizeSafeInternalPath(urlParams.get("redirect")) || "";
  });
  const [setupComplete, setSetupComplete] = useState(false);

  // Extract token from URL parameters
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const tokenParam = urlParams.get("token");
    setToken(tokenParam);
    setPhoneRequired(urlParams.get("phoneRequired") === "1");
    setPhoneRedirectPath(
      normalizeSafeInternalPath(urlParams.get("redirect")) || "",
    );
  }, []);

  useEffect(() => {
    if (token || phoneRequired || isAuthLoading || !isAuthenticated) return;
    setLocation(getNoTokenContinuationPath(user));
  }, [token, phoneRequired, isAuthLoading, isAuthenticated, user, setLocation]);

  const form = useForm<AccountSetupFormData>({
    resolver: zodResolver(accountSetupSchema),
    defaultValues: {
      password: "",
      confirmPassword: "",
      firstName: "",
      lastName: "",
      phone: "",
    },
  });

  const phoneOnlyForm = useForm<PhoneOnlySetupFormData>({
    resolver: zodResolver(phoneOnlySetupSchema),
    defaultValues: {
      phone: "",
      phoneContactConsent: true,
    },
  });

  // Validate token on mount
  const {
    data: tokenValidation,
    isLoading: isValidatingToken,
    error: tokenError,
  } = useQuery<{
    valid: boolean;
    userEmail?: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    error?: string;
  }>({
    queryKey: ["/api/auth/validate-setup-token", token],
    queryFn: async () => {
      if (!token) {
        throw new Error("No token provided");
      }
      const res = await fetch(
        `/api/auth/validate-setup-token?token=${encodeURIComponent(token)}`,
      );
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Invalid token");
      }
      return res.json();
    },
    enabled: !!token,
    retry: false,
  });

  // Pre-fill name fields if available
  useEffect(() => {
    if (tokenValidation?.firstName) {
      form.setValue("firstName", tokenValidation.firstName);
    }
    if (tokenValidation?.lastName) {
      form.setValue("lastName", tokenValidation.lastName);
    }
    if (tokenValidation?.phone) {
      form.setValue("phone", tokenValidation.phone);
    }
  }, [tokenValidation, form]);

  useEffect(() => {
    const existingPhone = String((user as any)?.phone || "");
    if (existingPhone) {
      phoneOnlyForm.setValue("phone", existingPhone);
    }
  }, [user, phoneOnlyForm]);

  const setupMutation = useMutation({
    mutationFn: async (data: AccountSetupFormData) => {
      const response = await apiRequest("POST", "/api/auth/complete-setup", {
        token,
        password: data.password,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        redirect: phoneRedirectPath || undefined,
      });
      return await response.json();
    },
    onSuccess: (payload: any) => {
      setSetupComplete(true);
      toast({
        title: "Account Setup Complete!",
        description: "Your profile is ready. Check your email to verify and continue.",
      });
      const redirectPath =
        normalizeSafeInternalPath(payload?.redirect) ||
        phoneRedirectPath ||
        "/dashboard";
      try {
        if (tokenValidation?.userEmail) {
          window.sessionStorage.setItem(
            "mealscout:lastSignupEmail",
            tokenValidation.userEmail,
          );
        }
        window.sessionStorage.setItem(
          "mealscout:post-verification-redirect",
          redirectPath,
        );
      } catch {}
      // Redirect to the unified post-verification handoff after 2 seconds
      setTimeout(() => {
        setLocation(
          `/post-verification?status=check-email&setup=complete&redirect=${encodeURIComponent(
            redirectPath,
          )}`,
        );
      }, 2000);
    },
    onError: (error: any) => {
      toast({
        title: "Setup Failed",
        description:
          error.message ||
          "Failed to complete account setup. Please try again.",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: AccountSetupFormData) => {
    setupMutation.mutate(data);
  };

  const phoneOnlySetupMutation = useMutation({
    mutationFn: async (data: PhoneOnlySetupFormData) => {
      const res = await apiRequest("POST", "/api/auth/complete-phone-setup", {
        phone: data.phone,
        phoneContactConsent: data.phoneContactConsent,
        redirect: phoneRedirectPath || getNoTokenContinuationPath(user),
      });
      return await res.json();
    },
    onSuccess: async (payload: any) => {
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
      toast({
        title: "Phone number saved",
        description: "Thanks. We'll use it for onboarding follow-up.",
      });
      setLocation(
        payload?.redirect || phoneRedirectPath || getNoTokenContinuationPath(user),
      );
    },
    onError: (error: any) => {
      toast({
        title: "Phone setup failed",
        description:
          error.message || "Failed to save phone number. Please try again.",
        variant: "destructive",
      });
    },
  });

  const onPhoneOnlySubmit = (data: PhoneOnlySetupFormData) => {
    phoneOnlySetupMutation.mutate(data);
  };

  // Get password strength info
  const password = form.watch("password");
  const getPasswordStrength = (password: string) => {
    if (!password) return { level: 0, text: "", color: "gray" };
    if (password.length < 8)
      return { level: 1, text: "Too short", color: "red" };
    if (password.length < 10)
      return { level: 2, text: "Weak", color: "orange" };
    if (
      password.length < 12 &&
      /[A-Z]/.test(password) &&
      /[0-9]/.test(password)
    )
      return { level: 3, text: "Good", color: "blue" };
    if (
      password.length >= 12 &&
      /[A-Z]/.test(password) &&
      /[0-9]/.test(password) &&
      /[^A-Za-z0-9]/.test(password)
    )
      return { level: 4, text: "Strong", color: "green" };
    return { level: 2, text: "Weak", color: "orange" };
  };

  const passwordStrength = getPasswordStrength(password);
  const strengthClass =
    passwordStrength.color === "red"
      ? "bg-[color:var(--status-error)]"
      : passwordStrength.color === "orange"
        ? "bg-[color:var(--status-warning)]"
        : passwordStrength.color === "blue"
          ? "bg-[color:var(--accent-text)]"
          : passwordStrength.color === "green"
            ? "bg-[color:var(--status-success)]"
            : "bg-[color:var(--text-muted)]";
  const strengthTextClass =
    passwordStrength.color === "red"
      ? "text-[color:var(--status-error)]"
      : passwordStrength.color === "orange"
        ? "text-[color:var(--status-warning)]"
        : passwordStrength.color === "blue"
          ? "text-[color:var(--accent-text)]"
          : passwordStrength.color === "green"
            ? "text-[color:var(--status-success)]"
            : "text-[color:var(--text-muted)]";

  if (!token && phoneRequired && (isAuthLoading || isAuthenticated)) {
    if (isAuthLoading) {
      return (
        <div className="min-h-screen bg-[var(--bg-layered)] flex items-center justify-center p-4">
          <SEOHead
            title="Continuing - MealScout"
            description="Preparing your MealScout phone setup."
            noIndex={true}
          />
          <Card className="w-full max-w-md border-[color:var(--border-subtle)] bg-[var(--bg-card)]">
            <CardContent className="pt-6 text-center">
              <p className="text-[color:var(--text-secondary)]">Loading phone setup...</p>
            </CardContent>
          </Card>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-[var(--bg-layered)]">
        <SEOHead
          title="Add Phone Number - MealScout"
          description="Add a phone number for MealScout onboarding follow-up."
          noIndex={true}
        />
        <h1 className="sr-only">Add your MealScout phone number</h1>
        <BackHeader
          title="Add Phone Number"
          fallbackHref="/login"
          icon={KeyRound}
          className="bg-[hsl(var(--background))/0.94] border-b border-[color:var(--border-subtle)] shadow-clean"
        />
        <div className="flex items-center justify-center min-h-[calc(100vh-4rem)] p-4">
          <Card className="w-full max-w-md border-[color:var(--border-subtle)] bg-[var(--bg-card)]">
            <CardHeader>
              <CardTitle>Add your phone number</CardTitle>
              <CardDescription>
                A phone number is required so MealScout can follow up on onboarding.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={phoneOnlyForm.handleSubmit(onPhoneOnlySubmit)}
                className="space-y-4"
              >
                <div className="space-y-2">
                  <Label htmlFor="phoneOnly">
                    Phone Number <span className="text-[color:var(--status-error)]">*</span>
                  </Label>
                  <Input
                    id="phoneOnly"
                    type="tel"
                    autoComplete="tel"
                    {...phoneOnlyForm.register("phone")}
                    placeholder="(555) 123-4567"
                    disabled={phoneOnlySetupMutation.isPending}
                  />
                  {phoneOnlyForm.formState.errors.phone && (
                    <p className="text-sm text-[color:var(--status-error)]">
                      {phoneOnlyForm.formState.errors.phone.message}
                    </p>
                  )}
                </div>

                <label className="flex items-start gap-2 rounded-md border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] p-3 text-sm leading-5">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4"
                    {...phoneOnlyForm.register("phoneContactConsent")}
                    defaultChecked
                  />
                  <span>
                    I agree MealScout may call or text me about onboarding. I can opt out anytime.
                  </span>
                </label>

                <Button
                  type="submit"
                  className="w-full"
                  disabled={phoneOnlySetupMutation.isPending}
                >
                  {phoneOnlySetupMutation.isPending ? "Saving..." : "Continue"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Missing setup token: authenticated OAuth/login redirects must leave this setup-link surface.
  if (!token && (isAuthLoading || isAuthenticated)) {
    return (
      <div className="min-h-screen bg-[var(--bg-layered)] flex items-center justify-center p-4">
        <SEOHead
          title="Continuing - MealScout"
          description="Routing your signed-in MealScout account."
          noIndex={true}
        />
        <Card className="w-full max-w-md border-[color:var(--border-subtle)] bg-[var(--bg-card)]">
          <CardContent className="pt-6 text-center">
            <p className="text-[color:var(--text-secondary)]">Continuing to your dashboard...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="min-h-screen bg-[var(--bg-layered)]">
        <SEOHead
          title="Setup Link Required - MealScout"
          description="A setup link token is required to complete invited account setup."
          noIndex={true}
        />
        <h1 className="sr-only">MealScout setup link required</h1>
        <BackHeader
          title="Account Setup"
          fallbackHref="/login"
          icon={KeyRound}
          className="bg-[hsl(var(--background))/0.94] border-b border-[color:var(--border-subtle)] shadow-clean"
        />
        <div className="flex items-center justify-center min-h-[calc(100vh-4rem)] p-4">
          <Card className="w-full max-w-md border-[color:var(--border-subtle)] bg-[var(--bg-card)]">
            <CardHeader>
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-[color:var(--status-warning)]" />
                <CardTitle>Setup Link Required</CardTitle>
              </div>
              <CardDescription>
                This page is only for account setup links from MealScout. If you
                just signed in with Google, Facebook, or email, continue from
                login so we can route you to the right dashboard.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button className="w-full" onClick={() => setLocation("/login")}>
                Go to Login
              </Button>
              <Button
                className="w-full"
                variant="outline"
                onClick={() =>
                  setLocation(
                    isAuthenticated
                      ? getNoTokenContinuationPath(user)
                      : "/login",
                  )
                }
              >
                {isAuthenticated ? "Continue to Dashboard" : "Continue Setup Check"}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Loading state
  if (isValidatingToken) {
    return (
      <div className="min-h-screen bg-[var(--bg-layered)] flex items-center justify-center p-4">
        <Card className="w-full max-w-md border-[color:var(--border-subtle)] bg-[var(--bg-card)]">
          <CardContent className="pt-6 text-center">
            <p className="text-[color:var(--text-secondary)]">Validating setup link...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Invalid or expired token
  if (tokenError || !tokenValidation?.valid) {
    return (
      <div className="min-h-screen bg-[var(--bg-layered)]">
        <SEOHead
          title="Invalid Setup Link - MealScout"
          description="This account setup link is invalid or has expired."
          noIndex={true}
        />
        <h1 className="sr-only">Invalid MealScout setup link</h1>
        <BackHeader
          title="Account Setup"
          fallbackHref="/login"
          icon={KeyRound}
          className="bg-[hsl(var(--background))/0.94] border-b border-[color:var(--border-subtle)] shadow-clean"
        />
        <div className="flex items-center justify-center min-h-[calc(100vh-4rem)] p-4">
          <Card className="w-full max-w-md border-[color:var(--border-subtle)] bg-[var(--bg-card)]">
            <CardHeader>
              <CardTitle className="text-[color:var(--status-error)]">Invalid Setup Link</CardTitle>
              <CardDescription>
                This account setup link has expired or has already been used.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-[color:var(--text-secondary)] mb-4">
                Please contact support or request a new setup link.
              </p>
              <Button className="w-full" onClick={() => setLocation("/login")}>
                Go to Login
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Setup complete state
  if (setupComplete) {
    return (
      <div className="min-h-screen bg-[var(--bg-layered)]">
        <SEOHead
          title="Setup Complete - MealScout"
          description="Your MealScout account is ready!"
          noIndex={true}
        />
        <h1 className="sr-only">MealScout setup complete</h1>
        <div className="flex items-center justify-center min-h-screen p-4">
          <Card className="w-full max-w-md border-[color:var(--border-subtle)] bg-[var(--bg-card)]">
            <CardHeader>
              <div className="flex items-center justify-center mb-4">
                <CheckCircle className="w-16 h-16 text-[color:var(--status-success)]" />
              </div>
              <CardTitle className="text-center text-[color:var(--status-success)]">
                Account Setup Complete!
              </CardTitle>
              <CardDescription className="text-center">
                Redirecting you to the email verification step...
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </div>
    );
  }

  // Main setup form
  return (
    <div className="min-h-screen bg-[var(--bg-layered)]">
      <SEOHead
        title="Complete Your Account - MealScout"
        description="Set up your MealScout account password and profile."
        noIndex={true}
      />
      <h1 className="sr-only">Complete your MealScout account</h1>
      <BackHeader
        title="Complete Your Account"
        fallbackHref="/login"
        icon={KeyRound}
        className="bg-[hsl(var(--background))/0.94] border-b border-[color:var(--border-subtle)] shadow-clean"
      />
      <div className="flex items-center justify-center min-h-[calc(100vh-4rem)] p-4">
        <Card className="w-full max-w-md border-[color:var(--border-subtle)] bg-[var(--bg-card)]">
          <CardHeader>
            <CardTitle>Welcome to MealScout!</CardTitle>
            <CardDescription>
              Complete your account details to unlock your dashboard and business tools.
              {tokenValidation?.userEmail && (
                <span className="block mt-1 font-medium text-[color:var(--text-primary)]">
                  {tokenValidation.userEmail}
                </span>
              )}
            </CardDescription>
            <p className="text-xs text-[color:var(--text-muted)]">
              Next step after setup: verify your email, then connect or claim your business profile if you are an owner.
            </p>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="firstName">First Name</Label>
                  <Input
                    id="firstName"
                    {...form.register("firstName")}
                    placeholder="John"
                    disabled={setupMutation.isPending}
                  />
                  {form.formState.errors.firstName && (
                    <p className="text-sm text-[color:var(--status-error)]">
                      {form.formState.errors.firstName.message}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">Last Name</Label>
                  <Input
                    id="lastName"
                    {...form.register("lastName")}
                    placeholder="Doe"
                    disabled={setupMutation.isPending}
                  />
                  {form.formState.errors.lastName && (
                    <p className="text-sm text-[color:var(--status-error)]">
                      {form.formState.errors.lastName.message}
                    </p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="phone">
                  Phone Number <span className="text-[color:var(--status-error)]">*</span>
                </Label>
                <Input
                  id="phone"
                  {...form.register("phone")}
                  placeholder="(555) 123-4567"
                  disabled={setupMutation.isPending}
                />
                {form.formState.errors.phone && (
                  <p className="text-sm text-[color:var(--status-error)]">
                    {form.formState.errors.phone.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">
                  Create Password <span className="text-[color:var(--status-error)]">*</span>
                </Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    {...form.register("password")}
                    placeholder="At least 8 characters"
                    disabled={setupMutation.isPending}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
                    disabled={setupMutation.isPending}
                  >
                    {showPassword ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
                {password && (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1 bg-[var(--bg-surface)] rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${strengthClass}`}
                        style={{
                          width: `${(passwordStrength.level / 4) * 100}%`,
                        }}
                      />
                    </div>
                    <span className={`text-xs font-medium ${strengthTextClass}`}>
                      {passwordStrength.text}
                    </span>
                  </div>
                )}
                {form.formState.errors.password && (
                  <p className="text-sm text-[color:var(--status-error)]">
                    {form.formState.errors.password.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword">
                  Confirm Password <span className="text-[color:var(--status-error)]">*</span>
                </Label>
                <div className="relative">
                  <Input
                    id="confirmPassword"
                    type={showConfirmPassword ? "text" : "password"}
                    {...form.register("confirmPassword")}
                    placeholder="Re-enter your password"
                    disabled={setupMutation.isPending}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
                    disabled={setupMutation.isPending}
                  >
                    {showConfirmPassword ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
                {form.formState.errors.confirmPassword && (
                  <p className="text-sm text-[color:var(--status-error)]">
                    {form.formState.errors.confirmPassword.message}
                  </p>
                )}
              </div>

              <Button
                type="submit"
                className="w-full"
                disabled={setupMutation.isPending}
              >
                {setupMutation.isPending ? "Setting up..." : "Complete Setup"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}







