import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import type { Restaurant } from "@shared/schema";
import { isBarBusinessType, isTruckBusinessType } from "@shared/businessTypes";
import {
  Bell,
  Bot,
  Building2,
  CheckCircle2,
  CircleHelp,
  CreditCard,
  ExternalLink,
  Eye,
  Image,
  Link2,
  Loader2,
  LockKeyhole,
  Settings2,
  ShieldCheck,
  Share2,
  Sparkles,
  UserRound,
  Users,
} from "lucide-react";
import BusinessWorkspaceShell from "@/components/business-workspace-shell";
import { BackHeader } from "@/components/back-header";
import NotificationSettings from "@/components/notification-settings";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import {
  isScopedBusinessOwner,
  type BusinessAccessContext,
} from "@/lib/business-access";
import { buildPublicProfilePath } from "@/lib/public-profile-path";
import { buildOwnerAiHref } from "@shared/ownerAiNavigation";

type SettingsPayload = {
  accountSettings?: Record<string, unknown>;
  publicProfileSettings?: {
    showAddress?: boolean;
    showContact?: boolean;
  };
  profileLinks?: Array<{
    entity: "restaurant" | "host" | "supplier";
    id: string;
    title: string;
    path: string;
  }>;
  publicIdentityStatus?: {
    standaloneUserProfile?: {
      supported: boolean;
      public: boolean;
      reason: string;
    };
    linkedEntityProfileCount?: number;
    linkedEntityProfilesAvailable?: boolean;
    discoveryParity?: {
      tierNeutral: boolean;
      paidTierRequired: boolean;
    };
  };
};

type SettingsTab = "account" | "ai" | "notifications" | "visibility";

type SettingsAiCredential = {
  id: string;
  name?: string | null;
  scope?: string | null;
  connectionKind?: "oauth" | "legacy" | string | null;
  connectionExpiresAt?: string | null;
  isActive?: boolean | null;
  revokedAt?: string | null;
  expiresAt?: string | null;
};

type SettingsSocialConnection = {
  platform: "facebook" | "instagram" | "x";
  connected: boolean;
  displayName?: string | null;
};

const validTabs = new Set<SettingsTab>([
  "account",
  "ai",
  "notifications",
  "visibility",
]);

function SettingsLinkCard({
  href,
  icon: Icon,
  title,
  description,
  external = false,
}: {
  href: string;
  icon: typeof Settings2;
  title: string;
  description: string;
  external?: boolean;
}) {
  const content = (
    <>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-orange-100 text-orange-800">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-black text-stone-950">{title}</p>
        <p className="mt-1 text-sm leading-5 text-stone-600">{description}</p>
      </div>
      <ExternalLink className="mt-1 h-4 w-4 shrink-0 text-stone-400" aria-hidden="true" />
    </>
  );

  const className =
    "flex min-h-24 items-start gap-3 rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-4 transition hover:border-orange-200 hover:bg-orange-50/50";

  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {content}
      </a>
    );
  }

  return (
    <Link href={href} className={className}>
      {content}
    </Link>
  );
}

export default function SettingsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const requestedRestaurantId = params.get("restaurantId") || "";
  const requestedTab = String(params.get("tab") || "account") as SettingsTab;
  const activeTab = validTabs.has(requestedTab) ? requestedTab : "account";

  const businessWorkspaceUserTypes = new Set([
    "restaurant_owner",
    "food_truck",
    "admin",
    "duper_admin",
    "super_admin",
    "staff",
  ]);
  const canUseBusinessWorkspace = businessWorkspaceUserTypes.has(
    String(user?.userType || ""),
  );

  const {
    data,
    isLoading: settingsLoading,
    isError: settingsError,
    refetch,
  } = useQuery<SettingsPayload>({
    queryKey: ["/api/settings/me"],
    queryFn: async () => {
      const response = await fetch("/api/settings/me", {
        credentials: "include",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.message || "Settings could not be loaded.");
      }
      return payload as SettingsPayload;
    },
    enabled: Boolean(user),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const {
    data: businesses = [],
    isLoading: businessesLoading,
  } = useQuery<Restaurant[]>({
    queryKey: ["/api/restaurants/my-restaurants"],
    enabled: Boolean(user && canUseBusinessWorkspace),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const { data: businessAccess, isLoading: businessAccessLoading } =
    useQuery<BusinessAccessContext>({
      queryKey: ["/api/business-access/me"],
      enabled: Boolean(user && canUseBusinessWorkspace),
      retry: false,
      refetchOnWindowFocus: false,
    });

  const currentBusiness = useMemo(() => {
    if (!businesses.length) return null;
    return (
      businesses.find((business) => business.id === requestedRestaurantId) ||
      businesses[0]
    );
  }, [businesses, requestedRestaurantId]);

  const [showAddress, setShowAddress] = useState(true);
  const [showContact, setShowContact] = useState(true);
  const [savingVisibility, setSavingVisibility] = useState(false);

  useEffect(() => {
    if (!data) return;
    setShowAddress(data.publicProfileSettings?.showAddress !== false);
    setShowContact(data.publicProfileSettings?.showContact !== false);
  }, [data]);

  const publicProfileHref = currentBusiness
    ? buildPublicProfilePath({
        entityType: isTruckBusinessType(currentBusiness.businessType)
          ? "truck"
          : isBarBusinessType(currentBusiness.businessType)
            ? "bar"
            : currentBusiness.businessType === "caterer"
              ? "caterer"
              : currentBusiness.businessType === "private_chef"
                ? "private_chef"
            : "restaurant",
        id: currentBusiness.id,
        name: currentBusiness.name,
      })
    : null;

  const selectedBusinessId = currentBusiness?.id || requestedRestaurantId;
  const ownsCurrentBusiness = isScopedBusinessOwner(
    businessAccess,
    selectedBusinessId,
  );
  const ownerAiHref = buildOwnerAiHref({
    restaurantId: selectedBusinessId,
    source: "settings",
    focus: "all",
  });
  const { data: aiCredentialPayload } = useQuery<{
    credentials?: SettingsAiCredential[];
  }>({
    queryKey: ["settings-owner-ai-credentials", selectedBusinessId],
    queryFn: async () => {
      const response = await fetch(
        `/api/owner-ai/restaurants/${encodeURIComponent(selectedBusinessId)}/credentials`,
        { credentials: "include" },
      );
      if (!response.ok) return { credentials: [] };
      return response.json();
    },
    enabled: Boolean(selectedBusinessId && ownsCurrentBusiness),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const { data: socialConnectionPayload } = useQuery<{
    connections?: SettingsSocialConnection[];
  }>({
    queryKey: ["settings-social-connections", selectedBusinessId],
    queryFn: async () => {
      const response = await fetch(
        `/api/restaurants/${encodeURIComponent(selectedBusinessId)}/social-connections/status`,
        { credentials: "include" },
      );
      if (!response.ok) return { connections: [] };
      return response.json();
    },
    enabled: Boolean(selectedBusinessId && ownsCurrentBusiness),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const activeAiConnections = (aiCredentialPayload?.credentials || []).filter(
    (credential) => {
      const approvalEnabled = String(credential.scope || "")
        .split(/\s+/)
        .includes("owner_ai:drafts:approve");
      const effectiveExpiry =
        credential.connectionExpiresAt || credential.expiresAt;
      return (
        credential.connectionKind === "oauth" &&
        approvalEnabled &&
        credential.isActive !== false &&
        !credential.revokedAt &&
        (!effectiveExpiry ||
          new Date(effectiveExpiry).getTime() > Date.now())
      );
    },
  );
  const connectedSocials = (
    socialConnectionPayload?.connections || []
  ).filter((connection) => connection.connected);
  const buildBusinessHref = (
    pathname: string,
    extra?: Record<string, string>,
  ) => {
    const next = new URLSearchParams();
    if (selectedBusinessId) next.set("restaurantId", selectedBusinessId);
    Object.entries(extra || {}).forEach(([key, value]) => next.set(key, value));
    const query = next.toString();
    return `${pathname}${query ? `?${query}` : ""}`;
  };

  const handleBusinessChange = (businessId: string) => {
    const next = new URLSearchParams(search);
    next.set("restaurantId", businessId);
    setLocation(`/settings?${next.toString()}`);
  };

  const handleTabChange = (value: string) => {
    const next = new URLSearchParams(search);
    next.set("tab", value);
    if (currentBusiness?.id) next.set("restaurantId", currentBusiness.id);
    setLocation(`/settings?${next.toString()}`);
  };

  const saveVisibility = async () => {
    setSavingVisibility(true);
    try {
      const response = await fetch("/api/settings/me", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicProfileSettings: {
            showAddress,
            showContact,
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.message || "Visibility could not be saved.");
      }
      await refetch();
      toast({
        title: "Visibility saved",
        description: "Public address and contact visibility are up to date.",
      });
    } catch (error) {
      toast({
        title: "Visibility not saved",
        description:
          error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSavingVisibility(false);
    }
  };

  const renderSettingsFrame = (content: ReactNode) => {
    if (currentBusiness && canUseBusinessWorkspace) {
      return (
        <BusinessWorkspaceShell
          activeModule="settings"
          business={currentBusiness}
          businesses={businesses}
          onBusinessChange={handleBusinessChange}
          publicProfileHref={publicProfileHref}
          capabilities={{
            deals: true,
            audience: true,
            team: true,
            payments: true,
          }}
        >
          <div className="mx-auto min-h-screen max-w-6xl px-4 py-6 lg:px-6 lg:py-8">
            {content}
          </div>
        </BusinessWorkspaceShell>
      );
    }

    return (
      <div className="min-h-screen bg-[var(--bg-layered)]">
        <BackHeader
          title="Settings"
          fallbackHref="/profile"
          icon={Settings2}
          className="border-b border-[color:var(--border-subtle)] bg-[hsl(var(--background))/0.94] shadow-clean"
        />
        <main className="mx-auto max-w-5xl px-4 py-6 sm:py-8">{content}</main>
      </div>
    );
  };

  if (
    settingsLoading ||
    (canUseBusinessWorkspace && (businessesLoading || businessAccessLoading))
  ) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg-layered)] text-stone-600">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
        Loading settings…
      </div>
    );
  }

  if (settingsError || !data) {
    return renderSettingsFrame(
      <div className="mx-auto max-w-xl py-10">
        <Card className="border-amber-200 bg-amber-50 shadow-clean">
          <CardContent className="p-6 text-center">
            <LockKeyhole className="mx-auto h-9 w-9 text-amber-800" aria-hidden="true" />
            <h1 className="mt-4 text-xl font-black text-amber-950">
              Settings are unavailable
            </h1>
            <p className="mt-2 text-sm text-amber-900/80">
              Nothing was changed. Try loading the account again.
            </p>
            <Button onClick={() => refetch()} className="mt-5">
              Try again
            </Button>
          </CardContent>
        </Card>
      </div>,
    );
  }

  const accountName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    user?.email ||
    "MealScout account";
  const profileLinks = data.profileLinks || [];

  const content = (
    <div className="space-y-5" data-account-settings-shell="true">
      <section className="rounded-[1.75rem] border border-orange-200 bg-[linear-gradient(135deg,#fff7ed,#ffedd5_60%,#fef3c7)] p-6 shadow-clean sm:p-8">
        <p className="text-sm font-black uppercase tracking-[0.12em] text-orange-800">
          Account settings
        </p>
        <div className="mt-2 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <h2 className="text-3xl font-black tracking-tight text-stone-950">
              {accountName}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-700">
              Account access, AI connections, browser notifications, support,
              and public contact visibility.
            </p>
          </div>
          {user?.email ? (
            <p className="text-sm font-bold text-stone-600">{user.email}</p>
          ) : null}
        </div>
      </section>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-5">
        <TabsList className="grid h-auto w-full grid-cols-2 rounded-2xl bg-stone-100 p-1 sm:grid-cols-4">
          <TabsTrigger value="account" className="min-h-10 rounded-xl">
            Account
          </TabsTrigger>
          <TabsTrigger value="ai" className="min-h-10 rounded-xl">
            AI & apps
          </TabsTrigger>
          <TabsTrigger value="notifications" className="min-h-10 rounded-xl">
            Notifications
          </TabsTrigger>
          <TabsTrigger value="visibility" className="min-h-10 rounded-xl">
            Visibility
          </TabsTrigger>
        </TabsList>

        <TabsContent value="account" className="space-y-5">
          <Card className="border-[color:var(--border-subtle)] bg-[var(--bg-surface)] shadow-clean">
            <CardHeader>
              <CardTitle className="text-xl">Account tools</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <SettingsLinkCard
                href="/profile"
                icon={UserRound}
                title="Personal profile"
                description="Review the name and identity attached to this account."
              />
              <SettingsLinkCard
                href="/settings?tab=notifications"
                icon={Bell}
                title="Notification center"
                description="Review account notification history and delivery status."
              />
              <SettingsLinkCard
                href="/help"
                icon={CircleHelp}
                title="Help and support"
                description="Open a support request or review existing tickets."
              />
              {selectedBusinessId ? (
                <>
                  <SettingsLinkCard
                    href={buildBusinessHref("/settings", { tab: "ai" })}
                    icon={Sparkles}
                    title="AI and app access"
                    description="Link your favorite AI through MealScout sign-in and connect the social accounts it can publish to with your consent."
                  />
                  <SettingsLinkCard
                    href={buildBusinessHref("/subscribe")}
                    icon={CreditCard}
                    title="Profile access"
                    description="Review the free trial and everything included with the profile."
                  />
                </>
              ) : null}
            </CardContent>
          </Card>

          {selectedBusinessId ? (
            <Card className="border-[color:var(--border-subtle)] bg-[var(--bg-surface)] shadow-clean">
              <CardHeader>
                <CardTitle className="text-xl">Business presentation</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-4 text-sm leading-6 text-stone-600">
                  Business identity and images are managed per business so changes do not leak into another profile.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <SettingsLinkCard
                    href={buildBusinessHref("/restaurant-owner-dashboard", {
                      setup: "profile",
                    })}
                    icon={Building2}
                    title="Public profile"
                    description="Edit business details, links, and location information."
                  />
                  <SettingsLinkCard
                    href={buildBusinessHref("/restaurant-owner-dashboard", {
                      setup: "profile-media",
                    })}
                    icon={Image}
                    title="Business photos"
                    description="Manage logo, cover, food, menu, and venue images."
                  />
                  <SettingsLinkCard
                    href={buildBusinessHref("/business-team")}
                    icon={Users}
                    title="Team access"
                    description="Choose who can help manage this business."
                  />
                  {publicProfileHref ? (
                    <SettingsLinkCard
                      href={publicProfileHref}
                      icon={Eye}
                      title="Preview public profile"
                      description="See the profile customers currently receive."
                      external
                    />
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ) : null}
        </TabsContent>

        <TabsContent value="ai" className="space-y-5">
          {selectedBusinessId && currentBusiness ? (
            <>
              <Card
                className="overflow-hidden border-orange-200 bg-[linear-gradient(135deg,#fff7ed,#fffbeb)] shadow-clean"
                data-testid="settings-owner-ai-entry"
              >
                <CardContent className="p-5 sm:p-6">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                    <div className="max-w-3xl">
                      <div className="flex items-center gap-2 text-sm font-black text-orange-800">
                        <Sparkles className="h-4 w-4" aria-hidden="true" />
                        One control surface for {currentBusiness.name}
                      </div>
                      <h3 className="mt-2 text-2xl font-black tracking-tight text-stone-950">
                        Use the AI you already have
                      </h3>
                      <p className="mt-3 text-sm leading-6 text-stone-700">
                        Link any compatible free or paid AI by signing into
                        MealScout from that AI. It can prepare profile details,
                        menus, prices, logos, images, hours, schedules, events,
                        deals, and matching social descriptions and artwork as
                        one exact revision. Once you consent to that exact
                        revision in chat, the AI can approve it and tell
                        MealScout to apply and publish it.
                      </p>
                    </div>
                    {ownsCurrentBusiness ? (
                      <Button asChild className="min-h-11 shrink-0">
                        <Link href={ownerAiHref}>
                          <Bot className="mr-2 h-4 w-4" aria-hidden="true" />
                          Open AI Control
                        </Link>
                      </Button>
                    ) : null}
                  </div>

                  <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    {[
                      ["AI prepares", "Draft and previews only"],
                      ["Owner approves in chat", "Exact complete revision"],
                      ["AI calls MealScout", "Then linked socials publish"],
                    ].map(([title, detail]) => (
                      <div
                        key={title}
                        className="rounded-2xl border border-orange-200 bg-white/80 p-4"
                      >
                        <p className="text-sm font-black text-stone-950">
                          {title}
                        </p>
                        <p className="mt-1 text-xs leading-5 text-stone-600">
                          {detail}
                        </p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {ownsCurrentBusiness ? (
                <Card className="border-[color:var(--border-subtle)] bg-[var(--bg-surface)] shadow-clean">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-xl">
                      <Link2 className="h-5 w-5 text-orange-700" aria-hidden="true" />
                      Connection readiness
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-3">
                      {[
                        {
                          title: "MealScout",
                          detail: "Signed in",
                          ready: true,
                          icon: ShieldCheck,
                        },
                        {
                          title: "Favorite AI",
                          detail: activeAiConnections.length
                            ? `${activeAiConnections.length} active`
                            : "Not linked yet",
                          ready: activeAiConnections.length > 0,
                          icon: Bot,
                        },
                        {
                          title: "Social publishing",
                          detail: connectedSocials.length
                            ? connectedSocials
                                .map((connection) =>
                                  connection.platform === "x"
                                    ? "X"
                                    : connection.platform[0].toUpperCase() +
                                      connection.platform.slice(1),
                                )
                                .join(", ")
                            : "Connect at least one",
                          ready: connectedSocials.length > 0,
                          icon: Share2,
                        },
                      ].map(({ title, detail, ready, icon: Icon }) => (
                        <div
                          key={title}
                          className={`rounded-2xl border p-4 ${
                            ready
                              ? "border-emerald-200 bg-emerald-50"
                              : "border-amber-200 bg-amber-50"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <Icon className="h-5 w-5 text-stone-800" aria-hidden="true" />
                            <Badge variant={ready ? "default" : "outline"}>
                              {ready ? "Ready" : "Needed"}
                            </Badge>
                          </div>
                          <p className="mt-3 text-sm font-black text-stone-950">
                            {title}
                          </p>
                          <p className="mt-1 text-xs text-stone-600">{detail}</p>
                        </div>
                      ))}
                    </div>
                    <Button asChild>
                      <Link href={ownerAiHref}>
                        Finish AI and social connections
                      </Link>
                    </Button>
                  </CardContent>
                </Card>
              ) : null}

              <Card className="border-[color:var(--border-subtle)] bg-[var(--bg-surface)] shadow-clean">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-xl">
                    <ShieldCheck className="h-5 w-5 text-emerald-700" aria-hidden="true" />
                    Connection and approval boundary
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 text-sm leading-6 text-stone-700">
                  {ownsCurrentBusiness ? (
                    <>
                      <p>
                        A signed-in AI is bound to this exact owner and
                        business. It may apply and publish only the immutable
                        revision it showed you after you explicitly approve it
                        in that chat. Manually copied legacy keys remain
                        draft-only.
                      </p>
                      <p className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 font-semibold text-emerald-950">
                        Nothing changes in MealScout or on social media until
                        you review and approve the exact preview as the actual
                        owner—inside your AI chat or on the MealScout fallback
                        review page.
                      </p>
                    </>
                  ) : (
                    <p className="rounded-2xl border border-amber-200 bg-amber-50 p-4 font-semibold text-amber-950">
                        Only the actual owner can authorize an AI connection or
                        give per-revision consent. The signed-in AI can then
                        approve and publish that exact revision; team access does
                        not inherit this authority.
                    </p>
                  )}
                </CardContent>
              </Card>
            </>
          ) : (
            <Card className="border-amber-200 bg-amber-50 shadow-clean">
              <CardContent className="p-6 text-center">
                <Building2 className="mx-auto h-9 w-9 text-amber-800" aria-hidden="true" />
                <h3 className="mt-4 text-xl font-black text-amber-950">
                  Connect a business first
                </h3>
                <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-amber-900/80">
                  AI Control is scoped to one business you own so another
                  profile can never receive its drafts or approvals.
                </p>
                <Button asChild className="mt-5">
                  <Link href="/restaurant-signup">Connect or claim a business</Link>
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="notifications">
          <Card className="border-[color:var(--border-subtle)] bg-[var(--bg-surface)] shadow-clean">
            <CardHeader>
              <CardTitle className="text-xl">Browser notifications</CardTitle>
            </CardHeader>
            <CardContent>
              <NotificationSettings />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="visibility" className="space-y-5">
          <Card className="border-[color:var(--border-subtle)] bg-[var(--bg-surface)] shadow-clean">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl">
                <Eye className="h-5 w-5 text-orange-700" aria-hidden="true" />
                Public profile status
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-6 text-stone-700">
              <p>
                MealScout customer accounts stay private. Public identity is attached to
                owned restaurant, food-truck, bar, caterer, private-chef, host, or supplier
                profiles rather than exposing the account itself.
              </p>
              <div className="rounded-2xl bg-stone-50 p-4">
                {profileLinks.length ? (
                  <p>
                    This account currently has {profileLinks.length} linked public profile
                    {profileLinks.length === 1 ? "" : "s"}. Public discovery does not require
                    a paid profile tier.
                  </p>
                ) : (
                  <p>
                    This account has no linked public entity profile yet. The reason is
                    role-scoped public identity, not a free or default-tier restriction.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="border-[color:var(--border-subtle)] bg-[var(--bg-surface)] shadow-clean">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl">
                <ShieldCheck className="h-5 w-5 text-orange-700" aria-hidden="true" />
                Public contact visibility
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
                These two settings apply to every public profile owned by this account.
                Business-specific details and photos remain in each business workspace.
              </div>

              <div className="divide-y divide-stone-200 rounded-2xl border border-stone-200">
                <Label className="flex items-center justify-between gap-4 p-4 font-normal">
                  <span>
                    <span className="block font-black text-stone-950">Show public address</span>
                    <span className="mt-1 block text-sm leading-5 text-stone-600">
                      Allow owned public profiles to display their saved address.
                    </span>
                  </span>
                  <Switch checked={showAddress} onCheckedChange={setShowAddress} />
                </Label>
                <Label className="flex items-center justify-between gap-4 p-4 font-normal">
                  <span>
                    <span className="block font-black text-stone-950">Show public contact details</span>
                    <span className="mt-1 block text-sm leading-5 text-stone-600">
                      Allow owned public profiles to display their saved contact information.
                    </span>
                  </span>
                  <Switch checked={showContact} onCheckedChange={setShowContact} />
                </Label>
              </div>

              <Button
                onClick={saveVisibility}
                disabled={savingVisibility}
                data-testid="button-save-public-visibility"
              >
                {savingVisibility ? "Saving…" : "Save visibility"}
              </Button>
            </CardContent>
          </Card>

          <Card className="border-[color:var(--border-subtle)] bg-[var(--bg-surface)] shadow-clean">
            <CardHeader>
              <CardTitle className="text-xl">Profiles affected</CardTitle>
            </CardHeader>
            <CardContent>
              {profileLinks.length ? (
                <div className="space-y-2">
                  {profileLinks.map((profile) => (
                    <a
                      key={`${profile.entity}-${profile.id}`}
                      href={profile.path}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center justify-between gap-3 rounded-xl border border-stone-200 px-4 py-3 text-sm transition hover:bg-orange-50"
                    >
                      <span className="min-w-0 truncate font-bold text-stone-900">
                        {profile.title}
                      </span>
                      <ExternalLink className="h-4 w-4 shrink-0 text-stone-400" aria-hidden="true" />
                    </a>
                  ))}
                </div>
              ) : (
                <div className="flex gap-3 rounded-2xl bg-stone-50 p-4 text-stone-600">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                  <p className="text-sm leading-6">
                    No active owned public profiles are linked to this account yet.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );

  return renderSettingsFrame(content);
}
