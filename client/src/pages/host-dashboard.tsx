import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { AlertCircle, Calendar, CreditCard, Loader2, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";

interface HostProfile {
  id: string;
  businessName: string;
  address: string;
  city?: string;
  state?: string;
  locationType: string;
  contactPhone?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  stripeConnectAccountId?: string | null;
  stripeConnectStatus?: string | null;
  stripeChargesEnabled?: boolean;
  stripePayoutsEnabled?: boolean;
  stripeOnboardingCompleted?: boolean;
  amenities?: Record<string, boolean> | null;
}

interface HostEarningsSummary {
  accruedCents: number;
  pendingPayoutCents: number;
  paidOutCents: number;
  availableCents: number;
  stripePayoutReady: boolean;
  canRequestPayout: boolean;
}

interface HostPayoutRequest {
  id: string;
  amountCents: number;
  status: "pending" | "approved" | "paid" | "rejected" | "cancelled";
  notes?: string | null;
  createdAt: string;
  paidAt?: string | null;
  reviewedAt?: string | null;
}

interface LocationDemandItem {
  id: string;
  businessName: string;
  address: string;
  demandStatus: string;
  status: string;
  interestCount: number;
  minInterestedTrucks: number;
  thresholdRemaining: number;
  thresholdReachedAt?: string | null;
}

function HostDashboard() {
  const { isAuthenticated, isLoading, user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [isLoadingPage, setIsLoadingPage] = useState(true);
  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [selectedHostId, setSelectedHostId] = useState<string>("");
  const [host, setHost] = useState<HostProfile | null>(null);
  const [isCheckingStripe, setIsCheckingStripe] = useState(false);
  const [earningsSummary, setEarningsSummary] =
    useState<HostEarningsSummary | null>(null);
  const [isLoadingEarnings, setIsLoadingEarnings] = useState(false);
  const [isRequestingPayout, setIsRequestingPayout] = useState(false);
  const [payoutRequests, setPayoutRequests] = useState<HostPayoutRequest[]>([]);
  const [isLoadingPayoutRequests, setIsLoadingPayoutRequests] = useState(false);
  const [seriesList, setSeriesList] = useState<any[]>([]);
  const [seriesError, setSeriesError] = useState("");
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [occurrenceLoadingId, setOccurrenceLoadingId] = useState<string | null>(
    null,
  );
  const [occurrencesBySeries, setOccurrencesBySeries] = useState<
    Record<string, any[]>
  >({});
  const [isCreatingSeries, setIsCreatingSeries] = useState(false);
  const [publishingSeriesId, setPublishingSeriesId] = useState<string | null>(
    null,
  );
  const [cancelingSeriesId, setCancelingSeriesId] = useState<string | null>(
    null,
  );
  const [demandQueue, setDemandQueue] = useState<LocationDemandItem[]>([]);
  const [isLoadingDemand, setIsLoadingDemand] = useState(false);
  const [ownedRestaurants, setOwnedRestaurants] = useState<any[]>([]);

  const [seriesForm, setSeriesForm] = useState({
    name: "",
    description: "",
    startDate: "",
    endDate: "",
    defaultStartTime: "11:00",
    defaultEndTime: "14:00",
    defaultMaxTrucks: 5,
    defaultHardCapEnabled: true,
    recurrenceDays: [] as string[],
  });

  const recurrenceOptions = [
    { label: "Sun", value: "SU" },
    { label: "Mon", value: "MO" },
    { label: "Tue", value: "TU" },
    { label: "Wed", value: "WE" },
    { label: "Thu", value: "TH" },
    { label: "Fri", value: "FR" },
    { label: "Sat", value: "SA" },
  ];

  useEffect(() => {
    if (isLoading) {
      return;
    }

    if (!isAuthenticated) {
      setLocation("/login?redirect=/host/dashboard");
      return;
    }

    if (user?.userType === "event_coordinator") {
      setLocation("/event-coordinator/dashboard");
      return;
    }

    const fetchData = async () => {
      try {
        const hostsRes = await fetch("/api/hosts");
        if (!hostsRes.ok) {
          throw new Error("Failed to fetch host profiles");
        }
        const hostList = await hostsRes.json();
        if (!Array.isArray(hostList) || hostList.length === 0) {
          setLocation("/host-signup");
          return;
        }

        setHosts(hostList);
        const initialHost = hostList[0];
        setSelectedHostId(initialHost.id);
        setHost(initialHost);
      } catch (error) {
        console.error(error);
      } finally {
        setIsLoadingPage(false);
      }
    };

    fetchData();
  }, [isAuthenticated, isLoading, setLocation, user]);

  useEffect(() => {
    if (!selectedHostId) return;
    const selected = hosts.find((item) => item.id === selectedHostId) || null;
    setHost(selected);
  }, [hosts, selectedHostId]);

  const loadSeries = async () => {
    setSeriesLoading(true);
    setSeriesError("");
    try {
      const res = await fetch("/api/hosts/event-series", {
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error("Failed to load event series");
      }
      const data = await res.json();
      setSeriesList(Array.isArray(data) ? data : []);
    } catch (error: any) {
      setSeriesError(error.message || "Failed to load event series.");
    } finally {
      setSeriesLoading(false);
    }
  };

  const loadHostEarnings = async () => {
    setIsLoadingEarnings(true);
    try {
      const hostId = selectedHostId || host?.id;
      const summaryUrl = hostId
        ? `/api/hosts/earnings/summary?hostId=${encodeURIComponent(hostId)}`
        : "/api/hosts/earnings/summary";
      const res = await fetch(summaryUrl, { credentials: "include" });
      if (!res.ok) {
        throw new Error("Failed to load earnings summary");
      }
      const data = await res.json();
      setEarningsSummary(data);
    } catch (error) {
      console.error("Host earnings summary error:", error);
      setEarningsSummary(null);
    } finally {
      setIsLoadingEarnings(false);
    }
  };

  const loadPayoutRequests = async () => {
    setIsLoadingPayoutRequests(true);
    try {
      const hostId = selectedHostId || host?.id;
      const url = hostId
        ? `/api/hosts/earnings/payout-requests?hostId=${encodeURIComponent(hostId)}`
        : "/api/hosts/earnings/payout-requests";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load payout requests");
      const data = await res.json();
      setPayoutRequests(Array.isArray(data?.requests) ? data.requests : []);
    } catch (error) {
      console.error("Payout request history error:", error);
      setPayoutRequests([]);
    } finally {
      setIsLoadingPayoutRequests(false);
    }
  };

  const loadDemandQueue = async () => {
    setIsLoadingDemand(true);
    try {
      const res = await fetch("/api/location-requests/demand/me?limit=25", {
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error("Failed to load demand queue");
      }
      const payload = await res.json();
      const rows = Array.isArray(payload?.queue) ? payload.queue : [];
      setDemandQueue(rows);
    } catch (error) {
      console.error("Demand queue error:", error);
      setDemandQueue([]);
    } finally {
      setIsLoadingDemand(false);
    }
  };

  const requestHostPayout = async () => {
    setIsRequestingPayout(true);
    try {
      const hostId = selectedHostId || host?.id;
      const res = await fetch("/api/hosts/earnings/payout-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ hostId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.message || "Failed to request payout");
      }

      setEarningsSummary(data.summary || null);
      void loadPayoutRequests();
      toast({
        title: "Payout requested",
        description: "Your payout request has been submitted for review. You can track its status in the Payout History section below.",
      });
    } catch (error: any) {
      toast({
        title: "Unable to request payout",
        description: error?.message || "Please try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setIsRequestingPayout(false);
    }
  };

  useEffect(() => {
    if (!host) return;
    loadSeries();
    void loadHostEarnings();
    void loadPayoutRequests();
    void loadDemandQueue();
  }, [host?.id]);

  useEffect(() => {
    if (!isAuthenticated) {
      setOwnedRestaurants([]);
      return;
    }

    let cancelled = false;
    fetch("/api/restaurants/my-restaurants", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return [];
        return res.json().catch(() => []);
      })
      .then((rows) => {
        if (cancelled) return;
        setOwnedRestaurants(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (cancelled) return;
        setOwnedRestaurants([]);
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user?.id]);

  const handleEnablePayments = async () => {
    try {
      const hostId = selectedHostId || host?.id;
      if (!hostId) {
        throw new Error("No host selected");
      }
      const res = await fetch("/api/hosts/stripe/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ hostId }),
      });
      if (!res.ok) {
        throw new Error("Failed to initiate Stripe onboarding");
      }
      const { onboardingUrl } = await res.json();
      window.location.href = onboardingUrl;
    } catch (error) {
      console.error("Stripe onboarding error:", error);
      toast({
        title: "Error",
        description: "Failed to initiate payment setup. Please try again.",
        variant: "destructive",
      });
    }
  };

  const refreshStripeStatus = async () => {
    setIsCheckingStripe(true);
    try {
      const hostId = selectedHostId || host?.id;
      const statusUrl = hostId
        ? `/api/hosts/stripe/status?hostId=${encodeURIComponent(hostId)}`
        : "/api/hosts/stripe/status";
      const res = await fetch(statusUrl, { credentials: "include" });
      if (!res.ok) {
        throw new Error("Failed to check payment status");
      }
      const data = await res.json();
      setHost((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          stripeConnectAccountId:
            data.accountId || prev.stripeConnectAccountId || null,
          stripeConnectStatus:
            data.connectStatus || prev.stripeConnectStatus || null,
          stripeChargesEnabled: data.chargesEnabled,
          stripePayoutsEnabled: data.payoutsEnabled,
          stripeOnboardingCompleted: data.onboardingCompleted,
        };
      });
      setHosts((prev) =>
        prev.map((item) =>
          item.id === (selectedHostId || host?.id)
            ? {
                ...item,
                stripeConnectAccountId:
                  data.accountId || item.stripeConnectAccountId || null,
                stripeConnectStatus:
                  data.connectStatus || item.stripeConnectStatus || null,
                stripeChargesEnabled: data.chargesEnabled,
                stripePayoutsEnabled: data.payoutsEnabled,
                stripeOnboardingCompleted: data.onboardingCompleted,
              }
            : item,
        ),
      );
      toast({
        title: "Stripe status updated",
        description:
          data.chargesEnabled && data.payoutsEnabled
            ? "Payments are enabled."
            : "Payments are still pending.",
      });
      await loadHostEarnings();
    } catch (error: any) {
      console.error("Stripe status error:", error);
      toast({
        title: "Unable to refresh status",
        description: error.message || "Please try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setIsCheckingStripe(false);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const setup = params.get("setup");
    const setupHostId = params.get("hostId");
    if (!setup) return;

    if (setupHostId && setupHostId !== selectedHostId) {
      setSelectedHostId(setupHostId);
    }

    if (setup === "complete" || setup === "refresh") {
      void refreshStripeStatus();
      const cleanUrl = `${window.location.pathname}${setupHostId ? `?hostId=${encodeURIComponent(setupHostId)}` : ""}`;
      window.history.replaceState({}, "", cleanUrl);
    }
  }, [selectedHostId]);

  const toggleRecurrenceDay = (day: string) => {
    setSeriesForm((prev) => {
      const exists = prev.recurrenceDays.includes(day);
      const nextDays = exists
        ? prev.recurrenceDays.filter((d) => d !== day)
        : [...prev.recurrenceDays, day];
      return { ...prev, recurrenceDays: nextDays };
    });
  };

  const handleCreateSeries = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsCreatingSeries(true);
    setSeriesError("");
    try {
      const recurrenceRule =
        seriesForm.recurrenceDays.length > 0
          ? `WEEKLY:${seriesForm.recurrenceDays.join(",")}`
          : null;

      const res = await fetch("/api/hosts/event-series", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: seriesForm.name,
          description: seriesForm.description || null,
          timezone: "America/New_York",
          recurrenceRule,
          startDate: seriesForm.startDate,
          endDate: seriesForm.endDate,
          defaultStartTime: seriesForm.defaultStartTime,
          defaultEndTime: seriesForm.defaultEndTime,
          defaultMaxTrucks: Number(seriesForm.defaultMaxTrucks),
          defaultHardCapEnabled: Boolean(seriesForm.defaultHardCapEnabled),
          seriesType: "open_call",
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to create series");
      }

      const created = await res.json();
      setSeriesList((prev) => [created, ...prev]);
      setSeriesForm({
        name: "",
        description: "",
        startDate: "",
        endDate: "",
        defaultStartTime: "11:00",
        defaultEndTime: "14:00",
        defaultMaxTrucks: 5,
        defaultHardCapEnabled: true,
        recurrenceDays: [],
      });
      toast({
        title: "Series created",
        description: "Draft series created. Publish when ready.",
      });
    } catch (error: any) {
      setSeriesError(error.message || "Failed to create series.");
    } finally {
      setIsCreatingSeries(false);
    }
  };

  const demandThresholdMet = demandQueue.filter(
    (row) => row.demandStatus === "threshold_met",
  );

  const handlePublishSeries = async (seriesId: string) => {
    setPublishingSeriesId(seriesId);
    try {
      const res = await fetch(`/api/hosts/event-series/${seriesId}/publish`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to publish series");
      }
      await loadSeries();
      toast({
        title: "Series published",
        description: "Occurrences generated and now visible to trucks.",
      });
    } catch (error: any) {
      toast({
        title: "Publish failed",
        description: error.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setPublishingSeriesId(null);
    }
  };

  const handleCancelSeries = async (seriesId: string) => {
    setCancelingSeriesId(seriesId);
    try {
      const res = await fetch(`/api/hosts/event-series/${seriesId}/cancel`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to cancel series");
      }
      await loadSeries();
      toast({
        title: "Series cancelled",
        description: "Future occurrences cancelled and trucks notified.",
      });
    } catch (error: any) {
      toast({
        title: "Cancellation failed",
        description: error.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setCancelingSeriesId(null);
    }
  };

  const handleLoadOccurrences = async (seriesId: string) => {
    setOccurrenceLoadingId(seriesId);
    try {
      const res = await fetch(
        `/api/hosts/event-series/${seriesId}/occurrences`,
        {
          credentials: "include",
        },
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to load occurrences");
      }
      const data = await res.json();
      setOccurrencesBySeries((prev) => ({
        ...prev,
        [seriesId]: Array.isArray(data) ? data : [],
      }));
    } catch (error: any) {
      toast({
        title: "Load failed",
        description: error.message || "Unable to load occurrences.",
        variant: "destructive",
      });
    } finally {
      setOccurrenceLoadingId(null);
    }
  };

  if (isLoading || isLoadingPage) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[var(--bg-layered)]">
        <Loader2 className="h-8 w-8 animate-spin text-[color:var(--accent-text)]" />
      </div>
    );
  }

  if (!host) return null;

  const hostStripePayoutReady = Boolean(
    host.stripeConnectAccountId &&
    host.stripeChargesEnabled &&
    host.stripePayoutsEnabled &&
    host.stripeOnboardingCompleted,
  );
  const stripeConnectionState = !host.stripeConnectAccountId
    ? "Not connected"
    : hostStripePayoutReady
      ? "Payouts enabled"
      : host.stripeOnboardingCompleted
        ? "Waiting on Stripe checks"
        : "Onboarding in progress";
  const hasHostLocation = Boolean(host.businessName && host.address);
  const hasAvailability = seriesList.length > 0;
  const hostSetupItems = [
    {
      label: "Location",
      description: hasHostLocation
        ? "Host location is ready."
        : "Add the place trucks can park or serve.",
      done: hasHostLocation,
      action: "Edit location",
      href: "/parking-pass?setup=location",
      icon: MapPin,
    },
    {
      label: "Availability",
      description: hasAvailability
        ? `${seriesList.length} open call ${seriesList.length === 1 ? "series" : "series"} created.`
        : "Create recurring or one-time food truck availability.",
      done: hasAvailability,
      action: "Create slots",
      href: "#host-event-series",
      icon: Calendar,
    },
    {
      label: "Bookings",
      description: "Review truck interest, bookings, and demand.",
      done: demandQueue.length > 0 || seriesList.length > 0,
      action: "Review demand",
      href: "#host-demand",
      icon: AlertCircle,
    },
    {
      label: "Payouts",
      description: hostStripePayoutReady
        ? "Stripe payouts are enabled."
        : "Connect Stripe so paid bookings can pay out.",
      done: hostStripePayoutReady,
      action: host.stripeConnectAccountId ? "Resume Stripe" : "Enable payouts",
      href: "#host-payouts",
      icon: CreditCard,
    },
  ];
  const hostSetupComplete = hostSetupItems.filter((item) => item.done).length;

  return (
    <div className="max-w-5xl mx-auto px-4 py-12 bg-[var(--bg-layered)] min-h-screen">
      <div className="mb-6 rounded-2xl border border-orange-200 bg-orange-50 p-4 shadow-clean">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-700">
              Host onboarding
            </p>
            <h1 className="mt-1 text-xl font-black text-orange-950">
              Finish your parking host setup
            </h1>
            <p className="mt-1 text-sm text-orange-900/75">
              Hosts are places where food trucks park or serve. Complete the
              location, availability, bookings, and payout pieces so trucks know
              when they can show up.
            </p>
          </div>
          <span className="w-fit rounded-full bg-orange-600 px-3 py-1 text-xs font-bold text-white">
            {hostSetupComplete}/{hostSetupItems.length} complete
          </span>
        </div>
        <div className="grid gap-2 md:grid-cols-4">
          {hostSetupItems.map((item) => {
            const Icon = item.icon;
            const content = (
              <div className="h-full rounded-xl border border-orange-200 bg-white p-3 text-left transition hover:border-orange-400">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <Icon className="h-4 w-4 text-orange-700" />
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    item.done
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-orange-100 text-orange-700"
                  }`}>
                    {item.done ? "Done" : "Next"}
                  </span>
                </div>
                <p className="text-sm font-black text-orange-950">{item.label}</p>
                <p className="mt-1 min-h-[2.5rem] text-xs text-orange-900/70">
                  {item.description}
                </p>
                <p className="mt-2 text-xs font-bold text-orange-700">
                  {item.action}
                </p>
              </div>
            );
            return item.href.startsWith("#") ? (
              <a key={item.label} href={item.href}>{content}</a>
            ) : (
              <Link key={item.label} href={item.href}>{content}</Link>
            );
          })}
        </div>
      </div>

      {!hostStripePayoutReady && (
        <Alert className="mb-6 border-[color:var(--status-warning)]/30 bg-[color:var(--status-warning)]/10">
          <AlertCircle className="h-4 w-4 text-[color:var(--status-warning)]" />
          <AlertTitle className="text-[color:var(--text-primary)]">
            Your parking pass is live and accepting bookings
          </AlertTitle>
          <AlertDescription className="text-[color:var(--text-secondary)]">
            <p className="mb-1">
              Trucks can book your spots right now — MealScout holds your earnings securely until you complete Stripe setup.
            </p>
            {earningsSummary && earningsSummary.accruedCents > 0 && (
              <p className="mb-3 font-semibold text-[color:var(--text-primary)]">
                💰 You have{" "}
                <span className="text-emerald-700">
                  ${(earningsSummary.accruedCents / 100).toFixed(2)}
                </span>{" "}
                in accrued earnings waiting to be unlocked. Complete Stripe setup to cash out.
              </p>
            )}
            {(!earningsSummary || earningsSummary.accruedCents === 0) && (
              <p className="mb-3">
                Complete Stripe onboarding now so your first payout is ready the moment a truck books your spot.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={handleEnablePayments}
                className="bg-[color:var(--accent-text)] hover:bg-[color:var(--action-hover)]"
              >
                {host.stripeConnectAccountId ? "Resume Stripe Setup" : "Set Up Payouts (Free)"}
              </Button>
              <Button
                variant="outline"
                onClick={refreshStripeStatus}
                disabled={isCheckingStripe}
              >
                {isCheckingStripe ? "Checking..." : "Refresh Status"}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <div id="host-payouts" className="mb-6 rounded-lg border border-[color:var(--border-subtle)] bg-[var(--bg-card)] p-4">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
              Stripe Payout Setup
            </h2>
            <p className="text-sm text-[color:var(--text-secondary)]">
              Track onboarding progress for paid bookings and host payouts.
            </p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              hostStripePayoutReady
                ? "bg-emerald-100 text-emerald-800"
                : "bg-amber-100 text-amber-900"
            }`}
          >
            {stripeConnectionState}
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md border border-[color:var(--border-subtle)] p-3">
            <p className="text-xs text-[color:var(--text-muted)]">Account</p>
            <p className="mt-1 text-sm font-semibold text-[color:var(--text-primary)]">
              {host.stripeConnectAccountId ? "Connected" : "Not started"}
            </p>
          </div>
          <div className="rounded-md border border-[color:var(--border-subtle)] p-3">
            <p className="text-xs text-[color:var(--text-muted)]">Onboarding</p>
            <p className="mt-1 text-sm font-semibold text-[color:var(--text-primary)]">
              {host.stripeOnboardingCompleted ? "Submitted" : "Incomplete"}
            </p>
          </div>
          <div className="rounded-md border border-[color:var(--border-subtle)] p-3">
            <p className="text-xs text-[color:var(--text-muted)]">Charges</p>
            <p className="mt-1 text-sm font-semibold text-[color:var(--text-primary)]">
              {host.stripeChargesEnabled ? "Enabled" : "Pending"}
            </p>
          </div>
          <div className="rounded-md border border-[color:var(--border-subtle)] p-3">
            <p className="text-xs text-[color:var(--text-muted)]">Payouts</p>
            <p className="mt-1 text-sm font-semibold text-[color:var(--text-primary)]">
              {host.stripePayoutsEnabled ? "Enabled" : "Pending"}
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            onClick={handleEnablePayments}
            className="bg-[color:var(--accent-text)] hover:bg-[color:var(--action-hover)]"
          >
            {host.stripeConnectAccountId
              ? "Resume Stripe Setup"
              : "Start Stripe Setup"}
          </Button>
          <Button
            variant="outline"
            onClick={refreshStripeStatus}
            disabled={isCheckingStripe}
          >
            {isCheckingStripe ? "Checking..." : "Refresh Stripe Status"}
          </Button>
        </div>
      </div>

      <div id="host-demand" className="mb-6 rounded-lg border border-[color:var(--border-subtle)] bg-[var(--bg-card)] p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
            Host Earnings
          </h2>
          <Button
            variant="outline"
            onClick={requestHostPayout}
            disabled={
              isRequestingPayout ||
              isLoadingEarnings ||
              !earningsSummary?.canRequestPayout
            }
          >
            {isRequestingPayout ? "Requesting..." : "Request Payout"}
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xs text-[color:var(--text-muted)]">Accrued</p>
            <p className="text-base font-semibold text-[color:var(--text-primary)]">
              {isLoadingEarnings
                ? "..."
                : `$${((earningsSummary?.accruedCents || 0) / 100).toFixed(2)}`}
            </p>
          </div>
          <div>
            <p className="text-xs text-[color:var(--text-muted)]">Available</p>
            <p className="text-base font-semibold text-[color:var(--text-primary)]">
              {isLoadingEarnings
                ? "..."
                : `$${((earningsSummary?.availableCents || 0) / 100).toFixed(2)}`}
            </p>
          </div>
          <div>
            <p className="text-xs text-[color:var(--text-muted)]">
              Pending Payouts
            </p>
            <p className="text-base font-semibold text-[color:var(--text-primary)]">
              {isLoadingEarnings
                ? "..."
                : `$${((earningsSummary?.pendingPayoutCents || 0) / 100).toFixed(2)}`}
            </p>
          </div>
          <div>
            <p className="text-xs text-[color:var(--text-muted)]">Paid Out</p>
            <p className="text-base font-semibold text-[color:var(--text-primary)]">
              {isLoadingEarnings
                ? "..."
                : `$${((earningsSummary?.paidOutCents || 0) / 100).toFixed(2)}`}
            </p>
          </div>
        </div>
      </div>

      {/* Payout Request History */}
      <div className="mb-6 rounded-lg border border-[color:var(--border-subtle)] bg-[var(--bg-card)] p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
            Payout History
          </h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadPayoutRequests()}
            disabled={isLoadingPayoutRequests}
          >
            {isLoadingPayoutRequests ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
        {isLoadingPayoutRequests ? (
          <p className="text-sm text-[color:var(--text-muted)]">Loading...</p>
        ) : payoutRequests.length === 0 ? (
          <p className="text-sm text-[color:var(--text-muted)]">
            No payout requests yet. Once you have available earnings and complete Stripe setup, you can request a payout above.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[color:var(--border-subtle)] text-left text-xs text-[color:var(--text-muted)]">
                  <th className="pb-2 pr-4">Date</th>
                  <th className="pb-2 pr-4">Amount</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2">Paid At</th>
                </tr>
              </thead>
              <tbody>
                {payoutRequests.map((req) => (
                  <tr key={req.id} className="border-b border-[color:var(--border-subtle)] last:border-0">
                    <td className="py-2 pr-4 text-[color:var(--text-secondary)]">
                      {new Date(req.createdAt).toLocaleDateString()}
                    </td>
                    <td className="py-2 pr-4 font-medium text-[color:var(--text-primary)]">
                      ${(req.amountCents / 100).toFixed(2)}
                    </td>
                    <td className="py-2 pr-4">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          req.status === "paid"
                            ? "bg-emerald-100 text-emerald-800"
                            : req.status === "approved"
                              ? "bg-blue-100 text-blue-800"
                              : req.status === "rejected" || req.status === "cancelled"
                                ? "bg-red-100 text-red-800"
                                : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        {req.status}
                      </span>
                    </td>
                    <td className="py-2 text-[color:var(--text-muted)]">
                      {req.paidAt ? new Date(req.paidAt).toLocaleDateString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mb-6 rounded-lg border border-[color:var(--border-subtle)] bg-[var(--bg-card)] p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
            Demand Queue
          </h2>
          <div className="flex items-center gap-2">
            <span className="text-xs text-[color:var(--text-muted)]">
              {demandThresholdMet.length} threshold met
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={loadDemandQueue}
              disabled={isLoadingDemand}
            >
              {isLoadingDemand ? "Refreshing..." : "Refresh"}
            </Button>
          </div>
        </div>

        {demandQueue.length === 0 ? (
          <p className="text-sm text-[color:var(--text-muted)]">
            No demand requests yet. As trucks show interest, qualified locations
            appear here.
          </p>
        ) : (
          <div className="space-y-2">
            {demandQueue.slice(0, 6).map((item) => {
              const thresholdMet = item.demandStatus === "threshold_met";
              const claimed = item.demandStatus === "claimed";
              return (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[color:var(--border-subtle)] px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[color:var(--text-primary)] truncate">
                      {item.businessName}
                    </p>
                    <p className="text-xs text-[color:var(--text-muted)] truncate">
                      {item.address}
                    </p>
                    <p className="text-xs text-[color:var(--text-muted)]">
                      {item.interestCount}/{item.minInterestedTrucks} interested
                      trucks
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-1 text-xs ${
                        claimed
                          ? "bg-slate-100 text-slate-700"
                          : thresholdMet
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-amber-100 text-amber-800"
                      }`}
                    >
                      {claimed
                        ? "claimed"
                        : thresholdMet
                          ? "threshold met"
                          : `${item.thresholdRemaining} to go`}
                    </span>
                    {thresholdMet ? (
                      <Button
                        size="sm"
                        onClick={() =>
                          setLocation("/parking-pass?setup=location")
                        }
                      >
                        Publish Slots
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4 mb-8 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-[color:var(--text-primary)]">
            {host.businessName}
          </h1>
          <p className="text-[color:var(--text-secondary)]">{host.address}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/owner-ai"><Button size="sm" variant="outline">Review AI profile updates</Button></Link>
            <Link href="/restaurant-signup?businessType=bar">
              <Button size="sm" variant="outline">
                Add Bar/Restaurant Profile
              </Button>
            </Link>
            {ownedRestaurants.length > 0 && (
              <Link href="/restaurant-owner-dashboard">
                <Button size="sm">Manage Bar/Restaurant</Button>
              </Link>
            )}
          </div>
        </div>
        {hosts.length > 1 && (
          <div className="flex items-center gap-2">
            <Label
              htmlFor="hostSelect"
              className="text-sm text-[color:var(--text-secondary)]"
            >
              Property
            </Label>
            <select
              id="hostSelect"
              value={selectedHostId}
              onChange={(event) => setSelectedHostId(event.target.value)}
              className="h-10 rounded-md border border-[color:var(--border-subtle)] bg-[var(--bg-card)] px-3 text-sm"
            >
              {hosts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.businessName} {item.address}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <section id="host-event-series" className="mb-12">
        <div className="mb-4">
          <h2 className="text-xl font-semibold text-[color:var(--text-primary)]">
            Event Series (Open Calls)
          </h2>
          <p className="text-sm text-[color:var(--text-secondary)]">
            Create multi-day or recurring events and publish when ready.
          </p>
        </div>

        <form
          onSubmit={handleCreateSeries}
          className="bg-[var(--bg-card)] border border-[color:var(--border-subtle)] rounded-xl p-6 shadow-clean space-y-4"
        >
          {seriesError && (
            <div className="p-3 bg-[color:var(--status-error)]/10 text-[color:var(--status-error)] rounded-md text-sm">
              {seriesError}
            </div>
          )}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="seriesName">Series Name</Label>
              <Input
                id="seriesName"
                value={seriesForm.name}
                onChange={(e) =>
                  setSeriesForm((prev) => ({ ...prev, name: e.target.value }))
                }
                required
                placeholder="Weekly Night Market"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="seriesMaxTrucks">Max Trucks per Day</Label>
              <Input
                id="seriesMaxTrucks"
                type="number"
                min={1}
                max={50}
                value={seriesForm.defaultMaxTrucks}
                onChange={(e) =>
                  setSeriesForm((prev) => ({
                    ...prev,
                    defaultMaxTrucks: Number(e.target.value || 1),
                  }))
                }
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="seriesDescription">Description</Label>
            <Textarea
              id="seriesDescription"
              value={seriesForm.description}
              onChange={(e) =>
                setSeriesForm((prev) => ({
                  ...prev,
                  description: e.target.value,
                }))
              }
              rows={3}
              placeholder="Set expectations for trucks: timing, power, parking, audience."
            />
          </div>

          <div className="grid md:grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label htmlFor="seriesStartDate">Start Date</Label>
              <Input
                id="seriesStartDate"
                type="date"
                value={seriesForm.startDate}
                onChange={(e) =>
                  setSeriesForm((prev) => ({
                    ...prev,
                    startDate: e.target.value,
                  }))
                }
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="seriesEndDate">End Date</Label>
              <Input
                id="seriesEndDate"
                type="date"
                value={seriesForm.endDate}
                onChange={(e) =>
                  setSeriesForm((prev) => ({
                    ...prev,
                    endDate: e.target.value,
                  }))
                }
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="seriesStartTime">Start Time</Label>
              <Input
                id="seriesStartTime"
                type="time"
                value={seriesForm.defaultStartTime}
                onChange={(e) =>
                  setSeriesForm((prev) => ({
                    ...prev,
                    defaultStartTime: e.target.value,
                  }))
                }
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="seriesEndTime">End Time</Label>
              <Input
                id="seriesEndTime"
                type="time"
                value={seriesForm.defaultEndTime}
                onChange={(e) =>
                  setSeriesForm((prev) => ({
                    ...prev,
                    defaultEndTime: e.target.value,
                  }))
                }
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Recurrence (optional)</Label>
            <div className="flex flex-wrap gap-3">
              {recurrenceOptions.map((option) => (
                <label
                  key={option.value}
                  className="flex items-center gap-2 text-sm text-[color:var(--text-secondary)]"
                >
                  <Checkbox
                    checked={seriesForm.recurrenceDays.includes(option.value)}
                    onCheckedChange={() => toggleRecurrenceDay(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
            <p className="text-xs text-[color:var(--text-muted)]">
              Leave blank for a single occurrence on the start date.
            </p>
          </div>

          <div className="flex items-center gap-2 text-sm text-[color:var(--text-secondary)]">
            <Checkbox
              checked={seriesForm.defaultHardCapEnabled}
              onCheckedChange={(value) =>
                setSeriesForm((prev) => ({
                  ...prev,
                  defaultHardCapEnabled: Boolean(value),
                }))
              }
            />
            Enforce hard capacity per occurrence
          </div>

          <div className="flex items-center justify-between text-xs text-[color:var(--text-muted)]">
            <span>Timezone: America/New_York</span>
            <span>Status: Draft on create</span>
          </div>

          <Button type="submit" disabled={isCreatingSeries}>
            {isCreatingSeries ? "Creating..." : "Create Series"}
          </Button>
        </form>

        <div className="mt-8">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold text-[color:var(--text-primary)]">
              Your Series
            </h3>
            <Button
              variant="outline"
              onClick={loadSeries}
              disabled={seriesLoading}
            >
              {seriesLoading ? "Refreshing..." : "Refresh"}
            </Button>
          </div>

          {seriesLoading ? (
            <div className="flex items-center gap-2 text-sm text-[color:var(--text-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading series...
            </div>
          ) : seriesList.length === 0 ? (
            <p className="text-sm text-[color:var(--text-muted)]">
              No event series yet. Create your first series above.
            </p>
          ) : (
            <div className="space-y-4">
              {seriesList.map((series) => (
                <div
                  key={series.id}
                  className="border border-[color:var(--border-subtle)] rounded-xl p-4 bg-[var(--bg-card)]"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h4 className="text-base font-semibold text-[color:var(--text-primary)]">
                        {series.name}
                      </h4>
                      <p className="text-xs text-[color:var(--text-muted)]">
                        {series.startDate?.slice(0, 10)} {"->"}{" "}
                        {series.endDate?.slice(0, 10)} -{" "}
                        {series.defaultStartTime}-{series.defaultEndTime}
                      </p>
                      <p className="text-xs text-[color:var(--text-muted)]">
                        Status: {series.status}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {series.status === "draft" && (
                        <Button
                          onClick={() => handlePublishSeries(series.id)}
                          disabled={publishingSeriesId === series.id}
                        >
                          {publishingSeriesId === series.id
                            ? "Publishing..."
                            : "Publish"}
                        </Button>
                      )}
                      {series.status !== "closed" && (
                        <Button
                          variant="destructive"
                          onClick={() => handleCancelSeries(series.id)}
                          disabled={cancelingSeriesId === series.id}
                        >
                          {cancelingSeriesId === series.id
                            ? "Cancelling..."
                            : "Cancel Series"}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        onClick={() => handleLoadOccurrences(series.id)}
                        disabled={occurrenceLoadingId === series.id}
                      >
                        {occurrenceLoadingId === series.id
                          ? "Loading..."
                          : "View Occurrences"}
                      </Button>
                    </div>
                  </div>

                  {occurrencesBySeries[series.id] && (
                    <div className="mt-4 border-t border-[color:var(--border-subtle)] pt-3">
                      {occurrencesBySeries[series.id].length === 0 ? (
                        <p className="text-xs text-[color:var(--text-muted)]">
                          No occurrences generated yet.
                        </p>
                      ) : (
                        <ul className="text-xs text-[color:var(--text-secondary)] space-y-1">
                          {occurrencesBySeries[series.id].map((occurrence) => (
                            <li key={occurrence.id}>
                              {occurrence.date?.slice(0, 10)} -{" "}
                              {occurrence.startTime}-{occurrence.endTime} -{" "}
                              {occurrence.status}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── Bookings section ────────────────────────────────────── */}
      {host && <HostBookingsSection hostId={host.id} />}
    </div>
  );
}

function HostBookingsSection({ hostId }: { hostId: string }) {
  const [events, setEvents] = useState<any[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>("");
  const [bookings, setBookings] = useState<any[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [loadingBookings, setLoadingBookings] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    setLoadingEvents(true);
    fetch(`/api/events?hostId=${encodeURIComponent(hostId)}`, {
      credentials: "include",
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        setEvents(
          Array.isArray(data?.events)
            ? data.events
            : Array.isArray(data)
              ? data
              : [],
        );
      })
      .catch(() => {})
      .finally(() => setLoadingEvents(false));
  }, [hostId]);

  useEffect(() => {
    if (!selectedEventId) {
      setBookings([]);
      return;
    }
    setLoadingBookings(true);
    fetch(`/api/events/${encodeURIComponent(selectedEventId)}/bookings`, {
      credentials: "include",
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => setBookings(data?.bookings ?? []))
      .catch(() => setBookings([]))
      .finally(() => setLoadingBookings(false));
  }, [selectedEventId]);

  const handleCancel = async (bookingId: string) => {
    if (!confirm("Cancel this booking? No refund will be issued.")) return;
    const res = await fetch(
      `/api/bookings/${encodeURIComponent(bookingId)}/cancel`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ reason: "Host cancelled" }),
      },
    );
    if (res.ok) {
      toast({ title: "Booking cancelled", description: "No refund issued." });
      setBookings((prev) =>
        prev.map((b) =>
          b.booking?.id === bookingId
            ? { ...b, booking: { ...b.booking, status: "cancelled" } }
            : b,
        ),
      );
    } else {
      toast({
        title: "Error",
        description: "Could not cancel booking.",
        variant: "destructive",
      });
    }
  };

  const fmtCents = (c: number) => `$${(c / 100).toFixed(2)}`;

  return (
    <section className="rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] p-6 space-y-4">
      <h2 className="text-xl font-semibold text-[color:var(--text-primary)]">
        Event Bookings
      </h2>
      <p className="text-sm text-[color:var(--text-secondary)]">
        Select an event to see which trucks have booked a spot.
      </p>

      {loadingEvents ? (
        <div className="flex items-center gap-2 text-sm text-[color:var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading events…
        </div>
      ) : (
        <select
          className="w-full rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3 py-2 text-sm"
          value={selectedEventId}
          onChange={(e) => setSelectedEventId(e.target.value)}
        >
          <option value="">Select an event…</option>
          {events.map((ev: any) => (
            <option key={ev.id} value={ev.id}>
              {ev.name || ev.id} —{" "}
              {ev.date ? new Date(ev.date).toLocaleDateString() : ""}
              {ev.requiresPayment ? " (paid)" : ""}
            </option>
          ))}
        </select>
      )}

      {selectedEventId && (
        <>
          {loadingBookings ? (
            <div className="flex items-center gap-2 text-sm text-[color:var(--text-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading bookings…
            </div>
          ) : bookings.length === 0 ? (
            <p className="text-sm text-[color:var(--text-muted)]">
              No bookings for this event yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[color:var(--border-subtle)] text-xs text-[color:var(--text-muted)] uppercase">
                    <th className="py-2 pr-4 text-left font-medium">Truck</th>
                    <th className="py-2 pr-4 text-left font-medium">Status</th>
                    <th className="py-2 pr-4 text-left font-medium">Total</th>
                    <th className="py-2 pr-4 text-left font-medium">Paid At</th>
                    <th className="py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((row: any) => {
                    const b = row.booking ?? row;
                    const truckName = row.truckName ?? "Unknown truck";
                    return (
                      <tr
                        key={b.id}
                        className="border-b border-[color:var(--border-subtle)] last:border-0"
                      >
                        <td className="py-2 pr-4">{truckName}</td>
                        <td className="py-2 pr-4">
                          <span
                            className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
                              b.status === "confirmed"
                                ? "bg-green-100 text-green-800"
                                : b.status === "pending"
                                  ? "bg-yellow-100 text-yellow-800"
                                  : "bg-gray-100 text-gray-600"
                            }`}
                          >
                            {b.status}
                          </span>
                        </td>
                        <td className="py-2 pr-4">
                          {fmtCents(b.totalCents ?? 0)}
                        </td>
                        <td className="py-2 pr-4 text-[color:var(--text-muted)]">
                          {b.paidAt
                            ? new Date(b.paidAt).toLocaleDateString()
                            : "—"}
                        </td>
                        <td className="py-2 text-right">
                          {b.status === "confirmed" ? (
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => handleCancel(b.id)}
                            >
                              Cancel Booking
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default HostDashboard;
