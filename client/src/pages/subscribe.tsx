import { Link, useLocation, useSearch } from "wouter";
import { Check, Clock3, CreditCard, ShieldCheck, Store } from "lucide-react";

import { BackHeader } from "@/components/back-header";
import ProfileLegacyBilling from "@/components/profile-legacy-billing";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/hooks/useAuth";
import { authUrl } from "@/lib/api";

const includedProfileTools = [
  "Complete public business profile",
  "Menus, photos, links, and business details",
  "Schedules, current locations, and availability",
  "Deals, audience activity, and profile analytics",
  "Ordering, delivery, booking, and event tools when configured",
];

const accessPromises = [
  { icon: Clock3, label: "No expiration" },
  { icon: CreditCard, label: "No card required" },
  { icon: ShieldCheck, label: "No monthly bill for profile tools" },
];

export default function ProfileAccess() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const params = new URLSearchParams(search);
  const restaurantId = String(params.get("restaurantId") || "").trim();
  const dashboardParams = new URLSearchParams();
  if (restaurantId) dashboardParams.set("restaurantId", restaurantId);
  const dashboardHref = `/restaurant-owner-dashboard${
    dashboardParams.toString() ? `?${dashboardParams.toString()}` : ""
  }`;
  const profileParams = new URLSearchParams(dashboardParams);
  profileParams.set("setup", "profile");
  const profileHref = `/restaurant-owner-dashboard?${profileParams.toString()}`;

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg-layered)] text-sm text-stone-600">
        Loading profile access…
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg-layered)] px-4">
        <Card className="w-full max-w-md border-[color:var(--border-subtle)] bg-[var(--bg-surface)] shadow-clean">
          <CardContent className="p-6 text-center">
            <ShieldCheck className="mx-auto h-10 w-10 text-orange-700" aria-hidden="true" />
            <h1 className="mt-4 text-xl font-black text-stone-950">
              Sign in to open your profile
            </h1>
            <p className="mt-2 text-sm leading-6 text-stone-600">
              Your complete MealScout profile is included under the free trial.
            </p>
            <Button
              className="mt-5 w-full"
              onClick={() =>
                (window.location.href = authUrl("/api/auth/google/restaurant"))
              }
            >
              Sign in
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg-layered)]">
      <BackHeader
        title="Profile access"
        subtitle="Your complete MealScout profile is included"
        fallbackHref={dashboardHref}
        icon={Store}
        className="border-b border-[color:var(--border-subtle)] bg-[hsl(var(--background))/0.94] shadow-clean"
      />

      <main className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:py-8">
        <section
          className="overflow-hidden rounded-[1.75rem] border border-orange-200 bg-[linear-gradient(135deg,#fff7ed,#ffedd5_60%,#fef3c7)] p-6 shadow-clean sm:p-8"
          data-testid="profile-access-free-trial"
        >
          <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-start">
            <div>
              <div className="flex items-center gap-2 text-sm font-black text-orange-800">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                Free trial active
              </div>
              <h1 className="mt-3 text-3xl font-black tracking-tight text-stone-950">
                The profile is the product.
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-stone-700">
                Every profile tool is available. The free trial has no expiration,
                requires no card, and never turns into a monthly charge.
              </p>
            </div>
            <Button
              className="shrink-0"
              onClick={() => setLocation(profileHref)}
              data-testid="button-open-complete-profile"
            >
              Open my profile
            </Button>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {accessPromises.map(({ icon: Icon, label }) => (
              <div
                key={label}
                className="flex items-center gap-2 rounded-2xl bg-white/75 px-4 py-3 text-sm font-bold text-stone-800"
              >
                <Icon className="h-4 w-4 text-orange-700" aria-hidden="true" />
                {label}
              </div>
            ))}
          </div>
        </section>

        {user?.id ? <ProfileLegacyBilling key={user.id} userId={user.id} /> : null}

        <Card className="border-[color:var(--border-subtle)] bg-[var(--bg-surface)] shadow-clean">
          <CardHeader>
            <CardTitle className="text-xl">Included with every profile</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {includedProfileTools.map((tool) => (
              <div key={tool} className="flex items-start gap-3 text-sm text-stone-700">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" aria-hidden="true" />
                <span>{tool}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="border-[color:var(--border-subtle)] bg-[var(--bg-surface)] shadow-clean">
          <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-black text-stone-950">Separate paid actions stay separate</h2>
              <p className="mt-1 text-sm leading-6 text-stone-600">
                An order, delivery, booking, or other paid transaction may have
                its own clearly shown charges. Those charges never unlock or
                restrict the profile.
              </p>
            </div>
            <Button asChild variant="outline" className="shrink-0">
              <Link href={dashboardHref}>Return to workspace</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
