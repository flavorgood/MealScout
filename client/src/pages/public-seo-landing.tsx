import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "wouter";

import { SEOHead } from "@/components/seo-head";
import { apiUrl } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  mapPublicSeoLandingPathToEndpoint,
  mapPublicSeoLandingSourcePageType,
} from "@/lib/publicSeoLandingRoute";

type Payload = {
  page: {
    routeKey: string;
    citySlug: string | null;
    cityName: string | null;
    cityState: string | null;
    cuisineSlug: string | null;
    cuisineName: string | null;
    canonicalPath: string;
    title: string;
    description: string;
    ogImage: string | null;
    emptyMessage: string;
  };
  items: Array<{
    id: string;
    profileType: string;
    displayName: string;
    slug: string;
    profilePath: string;
    city: string | null;
    state: string | null;
    imageUrl: string | null;
    cuisineTags: string[];
    statusLabel: string | null;
    summary: string | null;
    primaryCtaPath: string;
  }>;
  total: number;
};

export default function PublicSeoLandingPage() {
  const params = useParams() as Record<string, string | undefined>;
  const rawPath = window.location.pathname;
  const endpoint = useMemo(
    () => mapPublicSeoLandingPathToEndpoint(rawPath),
    [rawPath, params],
  );
  const pageViewSentRef = useRef<string>("");
  const [analyticsWindow] = useState(() => {
    if (typeof window === "undefined") return null;
    return {
      sourcePath: window.location.pathname,
      referrer: document.referrer || "",
    };
  });

  const { data, isLoading, error } = useQuery<Payload>({
    queryKey: ["public-seo-landing", endpoint],
    enabled: Boolean(endpoint),
    queryFn: async () => {
      const res = await fetch(apiUrl(String(endpoint)));
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.message || "Failed to load page");
      }
      return res.json();
    },
    staleTime: 60_000,
  });

  const title = data?.page?.title || "Local food discovery";
  const description =
    data?.page?.description ||
    "Find local food, nearby trucks, deals, and events on MealScout.";
  const canonicalUrl = data?.page?.canonicalPath
    ? `https://www.mealscout.us${data.page.canonicalPath}`
    : undefined;
  const citySlug = data?.page?.citySlug;
  const cuisineSlug = data?.page?.cuisineSlug;
  const sourcePageType = mapPublicSeoLandingSourcePageType(
    data?.page?.routeKey,
  );
  const isFoodTruckLanding = [
    "food-trucks",
    "food-trucks-cuisine",
    "food-trucks-today",
    "food-truck-catering",
    "book-food-truck",
  ].includes(String(data?.page?.routeKey || ""));

  const trackDiscoveryEvent = useCallback(
    (payload: {
      eventType: "discovery_page_view" | "discovery_card_click" | "discovery_profile_click" | "discovery_cta_click";
      profileId?: string;
      profileType?: string;
      targetPath?: string;
      displayName?: string;
    }) => {
      if (!analyticsWindow?.sourcePath) return;
      void fetch(apiUrl("/api/public/discovery-analytics"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          eventType: payload.eventType,
          sourcePageType,
          city: citySlug || null,
          cuisine: cuisineSlug || null,
          profileId: payload.profileId || null,
          profileType: payload.profileType || null,
          targetPath: payload.targetPath || null,
          sourcePath: analyticsWindow.sourcePath,
          displayName: payload.displayName || null,
          referrer: analyticsWindow.referrer || null,
        }),
      }).catch(() => {});
    },
    [analyticsWindow, citySlug, cuisineSlug, sourcePageType],
  );

  useEffect(() => {
    if (!data?.page?.canonicalPath) return;
    const key = `${sourcePageType}:${data.page.canonicalPath}`;
    if (pageViewSentRef.current === key) return;
    pageViewSentRef.current = key;
    trackDiscoveryEvent({ eventType: "discovery_page_view" });
  }, [data?.page?.canonicalPath, sourcePageType, trackDiscoveryEvent]);

  return (
    <div className="min-h-screen bg-background">
      <SEOHead
        title={title}
        description={description}
        canonicalUrl={canonicalUrl}
        ogImage={data?.page?.ogImage || undefined}
        noIndex={Boolean(error) || data?.total === 0}
      />
      <div className="mx-auto max-w-6xl px-4 py-10">
        <header className="mb-6">
          <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle>
              {isLoading ? "Loading local results..." : `${data?.total || 0} local results`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {error ? (
              <p className="text-sm text-destructive">
                {(error as any)?.message || "Failed to load local discovery results."}
              </p>
            ) : null}

            {!isLoading && (data?.items?.length || 0) === 0 ? (
              <p className="text-sm text-muted-foreground">
                {data?.page?.emptyMessage ||
                  "No local listings are available yet. Check nearby food or come back soon."}
              </p>
            ) : null}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {(data?.items || []).map((item) => (
                <Card key={item.id} className="overflow-hidden">
                  <CardContent className="pt-5">
                    <div className="space-y-2">
                      <a
                        href={`${item.profilePath}?utm_source=discovery_${sourcePageType}`}
                        className="font-semibold underline"
                        onClick={() =>
                          trackDiscoveryEvent({
                            eventType: "discovery_profile_click",
                            profileId: item.id,
                            profileType: item.profileType,
                            targetPath: item.profilePath,
                            displayName: item.displayName,
                          })
                        }
                      >
                        {item.displayName}
                      </a>
                      <p className="text-xs text-muted-foreground">
                        {[item.city, item.state].filter(Boolean).join(", ") || "Local area"}
                      </p>
                      {item.statusLabel ? (
                        <p className="text-xs font-medium text-foreground">{item.statusLabel}</p>
                      ) : null}
                      {item.summary ? (
                        <p className="text-xs text-muted-foreground">{item.summary}</p>
                      ) : null}
                      {item.cuisineTags?.length ? (
                        <p className="text-xs text-muted-foreground">
                          {item.cuisineTags.slice(0, 2).join(" • ")}
                        </p>
                      ) : null}
                      <div className="pt-1">
                        <Button asChild size="sm">
                          <a
                            href={`${item.primaryCtaPath}?utm_source=discovery_${sourcePageType}`}
                            onClick={() =>
                              trackDiscoveryEvent({
                                eventType: "discovery_card_click",
                                profileId: item.id,
                                profileType: item.profileType,
                                targetPath: item.primaryCtaPath,
                                displayName: item.displayName,
                              })
                            }
                          >
                            Open profile
                          </a>
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </CardContent>
        </Card>

        <section className="mt-6 rounded-lg border border-[var(--border-subtle)] p-4">
          <h2 className="text-sm font-semibold">Related discovery</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {isFoodTruckLanding ? (
              <Link
                href="/for-food-trucks"
                className="text-sm font-semibold underline"
                onClick={() =>
                  trackDiscoveryEvent({
                    eventType: "discovery_cta_click",
                    targetPath: "/for-food-trucks",
                  })
                }
              >
                List or claim your food truck
              </Link>
            ) : null}
            {citySlug ? (
              <>
                <Link href={`/city/${encodeURIComponent(citySlug)}/food`} className="text-sm underline">
                  City food
                </Link>
                <Link href={`/food-trucks-today/${encodeURIComponent(citySlug)}`} className="text-sm underline">
                  Food trucks today
                </Link>
                <Link href={`/food-truck-catering/${encodeURIComponent(citySlug)}`} className="text-sm underline">
                  Food truck catering
                </Link>
                <Link href={`/book-food-truck/${encodeURIComponent(citySlug)}`} className="text-sm underline">
                  Book a food truck
                </Link>
                <Link href={`/deals-today/${encodeURIComponent(citySlug)}`} className="text-sm underline">
                  Deals today
                </Link>
                <Link href={`/events-today/${encodeURIComponent(citySlug)}`} className="text-sm underline">
                  Events today
                </Link>
                <Link href={`/locations-with-trucks/${encodeURIComponent(citySlug)}`} className="text-sm underline">
                  Locations with trucks
                </Link>
              </>
            ) : null}
            {cuisineSlug ? (
              <Link href={`/cuisine/${encodeURIComponent(cuisineSlug)}`} className="text-sm underline">
                More {cuisineSlug.replace(/-/g, " ")}
              </Link>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
