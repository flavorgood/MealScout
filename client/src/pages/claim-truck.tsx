import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest } from "@/lib/queryClient";
import { BackHeader } from "@/components/back-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Truck } from "lucide-react";
import { PlaceAutocompleteInput } from "@/components/maps/place-autocomplete-input";
import { SEOHead } from "@/components/seo-head";
import {
  buildRestaurantSignupPath,
  parseBusinessSignupRouteIntent,
} from "@shared/businessSignupIntent";

type ClaimRow = {
  id: string;
  name?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  invited?: boolean;
  canClaim?: boolean;
  canRequest?: boolean;
  requestCooldownMinutes?: number;
};

function isClaimRow(value: unknown): value is ClaimRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    row.id.trim().length > 0 &&
    ["name", "address", "city", "state"].every(
      (key) => row[key] == null || typeof row[key] === "string",
    ) &&
    ["invited", "canClaim", "canRequest"].every(
      (key) => row[key] === undefined || typeof row[key] === "boolean",
    ) &&
    (row.requestCooldownMinutes === undefined ||
      (typeof row.requestCooldownMinutes === "number" &&
        Number.isFinite(row.requestCooldownMinutes) &&
        row.requestCooldownMinutes >= 0))
  );
}

type PlaceSuggestion = {
  placeId: string;
  text: string;
  mainText: string;
  secondaryText: string;
  _sessionToken?: string;
};

type PlaceDetailsResult = {
  placeId: string;
  formattedAddress: string;
  city: string;
  state: string;
  latitude: number | null;
  longitude: number | null;
};

export default function ClaimTruckPage() {
  const { user, isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const inboundIntent = useMemo(
    () => parseBusinessSignupRouteIntent(window.location.search),
    [],
  );
  const initialQuery = inboundIntent.passthrough.q || "";
  const [query, setQuery] = useState(initialQuery);
  const didAutoSearch = useRef(false);
  const searchVersion = useRef(0);
  const [loading, setLoading] = useState(false);
  const [requestingId, setRequestingId] = useState<string | null>(null);
  const [missingBusinessQuery, setMissingBusinessQuery] = useState("");
  const [missingBusinessLoading, setMissingBusinessLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [rows, setRows] = useState<ClaimRow[]>([]);

  const normalizedQuery = useMemo(() => query.trim(), [query]);

  const invalidateSearch = useCallback(() => {
    searchVersion.current += 1;
    setRows([]);
    setError("");
    setLoading(false);
  }, []);

  useEffect(() => {
    invalidateSearch();
    return () => { searchVersion.current += 1; };
  }, [invalidateSearch, user?.id]);

  const handleSearch = async () => {
    const version = ++searchVersion.current;
    const q = normalizedQuery;
    setRows([]);
    setError("");
    if (!q) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError("");
    try {
      const res = await apiRequest(
        "GET",
        `${
          isAuthenticated
            ? "/api/truck-claims/search"
            : "/api/truck-claims/public-search"
        }?q=${encodeURIComponent(q)}`,
      );
      const data: unknown = await res.json();
      if (version !== searchVersion.current) return;
      if (!Array.isArray(data) || !data.every(isClaimRow)) {
        throw new Error("Invalid claim search response");
      }
      setRows(data);
      if (data.length === 0) {
        setError(
          "No matching trucks found. Try a shorter name or the license/external ID.",
        );
      }
    } catch {
      if (version === searchVersion.current) {
        setError("Search is temporarily unavailable. Please try again.");
      }
    } finally {
      if (version === searchVersion.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (isAuthLoading || !initialQuery || didAutoSearch.current) return;
    didAutoSearch.current = true;
    void handleSearch();
    // Search the inbound q exactly once; subsequent searches are owner-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery, isAuthLoading]);

  const handleRequest = async (listingId: string) => {
    const version = searchVersion.current;
    setRequestingId(listingId);
    setError("");
    try {
      const res = await apiRequest("POST", "/api/truck-claims/request", {
        listingId,
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const message = String(data?.message || "Request failed");
        if (res.status === 429 && typeof data?.cooldownMinutes === "number") {
          toast({
            title: "Already sent recently",
            description: `Try again in about ${data.cooldownMinutes} minutes.`,
            variant: "destructive",
          });
          return;
        }
        throw new Error(message);
      }

      toast({
        title: "Setup request received",
        description:
          data?.message ||
          "If setup can be sent for this listing, the owner will receive it.",
      });

      // Refresh only if the owner is still viewing the same search.
      if (version === searchVersion.current) await handleSearch();
    } catch (err: any) {
      if (version === searchVersion.current) setError(err?.message || "Request failed.");
    } finally {
      setRequestingId(null);
    }
  };

  const goToClaimFlow = (row: ClaimRow) => {
    const q = String(row.name || "").trim();
    const next = buildRestaurantSignupPath({
      businessType: "food_truck",
      intent: "claim",
      source: inboundIntent.source || "claim-business",
      passthrough: {
        ...inboundIntent.passthrough,
        q,
        claimListingId: row.id,
      },
    });
    setLocation(next);
  };

  const goToMissingBusinessFlow = (
    suggestion: PlaceSuggestion,
    place: PlaceDetailsResult,
  ) => {
    const passthrough: Record<string, string> = {
      ...inboundIntent.passthrough,
      claimMode: "missing",
      q: suggestion.mainText || suggestion.text,
      prefillName: suggestion.mainText || suggestion.text,
      prefillAddress: place.formattedAddress || suggestion.text,
      prefillCity: place.city || "",
      prefillState: place.state || "",
      prefillPlaceId: place.placeId || suggestion.placeId,
    };

    if (typeof place.latitude === "number") {
      passthrough.prefillLat = String(place.latitude);
    }
    if (typeof place.longitude === "number") {
      passthrough.prefillLng = String(place.longitude);
    }

    setLocation(
      buildRestaurantSignupPath({
        businessType: "food_truck",
        intent: "create",
        source: inboundIntent.source || "claim-business",
        passthrough,
      }),
    );
  };

  const handleMissingBusinessSelect = async (suggestion: PlaceSuggestion) => {
    setMissingBusinessLoading(true);
    setError("");
    try {
      const detailUrl = new URL(
        `/api/map/place-details/${encodeURIComponent(suggestion.placeId)}`,
        window.location.origin,
      );
      if (suggestion._sessionToken) {
        detailUrl.searchParams.set("sessionToken", suggestion._sessionToken);
      }

      const res = await fetch(detailUrl.toString(), { credentials: "include" });
      if (!res.ok) {
        throw new Error("Could not load place details");
      }

      const data = await res.json().catch(() => ({}));
      const place = (data?.place || {}) as PlaceDetailsResult;
      goToMissingBusinessFlow(suggestion, {
        placeId: place.placeId || suggestion.placeId,
        formattedAddress: place.formattedAddress || suggestion.text,
        city: place.city || "",
        state: place.state || "",
        latitude: typeof place.latitude === "number" ? place.latitude : null,
        longitude: typeof place.longitude === "number" ? place.longitude : null,
      });
    } catch (err: any) {
      setError(err?.message || "Could not use selected business. Try again.");
    } finally {
      setMissingBusinessLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg-layered)]">
      <SEOHead
        title="Claim Your Food Truck | MealScout"
        description="Find an existing MealScout food truck listing and start the owner claim process."
        canonicalUrl="https://www.mealscout.us/claim-business"
      />
      <BackHeader
        title="Claim Your Food Truck"
        fallbackHref="/"
        icon={Truck}
        className="bg-[hsl(var(--background))/0.94] border-b border-[color:var(--border-subtle)] shadow-clean lg:top-16"
      />

      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 space-y-6">
        <Card className="border-[color:var(--border-subtle)] bg-[var(--bg-card)] shadow-clean-lg">
          <CardHeader>
            <h2 className="text-2xl font-semibold leading-none tracking-tight">
              Find your food truck
            </h2>
            <p className="text-sm text-muted-foreground">
              Search by truck name, license/external ID, city, or state. If
              your truck profile is unclaimed, you can claim it or request a setup
              reminder.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <label htmlFor="claim-truck-search" className="sr-only">
                Search by food truck name, license ID, city, or state
              </label>
              <Input
                id="claim-truck-search"
                value={query}
                onChange={(e) => {
                  invalidateSearch();
                  setQuery(e.target.value);
                }}
                placeholder="e.g. Tacos, DBPR-12345, Austin"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSearch();
                }}
              />
              <Button
                variant="outline"
                onClick={handleSearch}
                disabled={loading}
              >
                {loading ? "Searching..." : "Search"}
              </Button>
            </div>

            {error ? (
              <div
                className="text-sm text-destructive"
                role="alert"
                aria-live="polite"
              >
                {error}
              </div>
            ) : null}

            {rows.length > 0 ? (
              <div className="space-y-2">
                {rows.slice(0, 15).map((row) => {
                  const cooldown = Number(row.requestCooldownMinutes || 0);
                  const canRequest = Boolean(row.canRequest && cooldown === 0);
                  const canClaim = isAuthenticated
                    ? Boolean(row.canClaim)
                    : true;
                  return (
                    <div
                      key={row.id}
                      className="rounded-lg border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-3 space-y-2"
                    >
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="font-semibold truncate">
                              {row.name || "Unnamed truck"}
                            </div>
                            {isAuthenticated && row.invited ? (
                              <Badge variant="secondary">Invited</Badge>
                            ) : null}
                            {isAuthenticated && !row.canClaim ? (
                              <Badge variant="outline">Setup pending</Badge>
                            ) : null}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {[row.address, row.city, row.state]
                              .filter(Boolean)
                              .join(", ")}
                          </div>
                          {cooldown > 0 ? (
                            <div className="text-xs text-muted-foreground">
                              Reminder recently sent. Try again in about{" "}
                              {cooldown} minutes.
                            </div>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            onClick={() => goToClaimFlow(row)}
                            disabled={!canClaim}
                          >
                            {isAuthenticated ? "Claim" : "Sign in to claim"}
                          </Button>
                          {isAuthenticated && row.canRequest ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleRequest(row.id)}
                              disabled={!canRequest || requestingId === row.id}
                            >
                              {requestingId === row.id
                                ? "Requesting..."
                                : "Request setup"}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      {isAuthenticated && !canClaim && row.invited ? (
                        <div className="text-xs text-muted-foreground">
                          This truck already has an invited owner. Use “Request
                          setup” to remind them.
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}

            <div className="rounded-lg border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-3 space-y-2">
              <div className="text-sm font-semibold">Can&apos;t find it?</div>
              <p className="text-xs text-muted-foreground">
                Use Google autofill to start a new food truck profile. We check
                the registry again before it can be submitted.
              </p>
              <PlaceAutocompleteInput
                id="claim-missing-business"
                intent="food"
                value={missingBusinessQuery}
                onChange={setMissingBusinessQuery}
                onSelect={(suggestion) => {
                  void handleMissingBusinessSelect(
                    suggestion as PlaceSuggestion,
                  );
                }}
                placeholder="Search business name or address"
                disabled={missingBusinessLoading}
              />
              {missingBusinessLoading ? (
                <div className="text-xs text-muted-foreground">
                  Loading business details...
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
