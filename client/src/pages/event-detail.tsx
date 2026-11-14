import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { SEOHead } from "@/components/seo-head";
import { apiUrl } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { extractIdFromSlug } from "@/lib/seo-slug";
import { generateEventSchema } from "@/lib/schema-helpers";
import { useAuth } from "@/hooks/useAuth";
import { resolveStoredFoodBusinessType } from "@shared/businessTypes";
import { formatEventCalendarDate, getEventCalendarDateKey } from "@/lib/public-event-display";

type EventTruck = {
  id: string;
  name?: string | null;
  cuisineType?: string | null;
  path?: string | null;
};

type PublicEvent = {
  id: string;
  title: string;
  description?: string | null;
  date?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  timeZone?: string | null;
  status?: string | null;
  eventType?: string | null;
  requiresPayment?: boolean;
  hostPriceCents?: number | null;
  host: {
    id: string;
    name?: string | null;
    address?: string | null;
    city?: string | null;
    state?: string | null;
    path?: string | null;
  };
  truck?: EventTruck | null;
  trucks?: EventTruck[];
  canonicalUrl?: string | null;
  noIndex?: boolean;
  ended?: boolean;
  lastConfirmedAtUtc?: string | null;
};

export default function EventDetailPage() {
  const params = useParams() as Record<string, string | undefined>;
  const eventParam = params.slug || params.id || "";
  const eventId = extractIdFromSlug(eventParam);
  const { user, isAuthenticated, authState } = useAuth();
  const currentUserId = isAuthenticated ? String(user?.id || "") : "";
  const [truckContext, setTruckContext] = useState<{
    userId: string;
    truckId: string | null;
    complete: boolean;
  }>({ userId: "", truckId: null, complete: false });

  // Resolve an exact account-scoped food truck with Parking Pass authority.
  useEffect(() => {
    let cancelled = false;
    setTruckContext({ userId: currentUserId, truckId: null, complete: false });
    if (!isAuthenticated || !currentUserId) {
      setTruckContext({ userId: currentUserId, truckId: null, complete: true });
      return;
    }
    fetch("/api/business-access/me", { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((access) => {
        if (cancelled) return;
        const restaurants = Array.isArray(access?.restaurants)
          ? access.restaurants
          : [];
        const truck = restaurants.find(
          (restaurant: any) =>
            (restaurant?.isOwner === true ||
              restaurant?.permissions?.manageParkingPass === true) &&
            resolveStoredFoodBusinessType(restaurant) === "food_truck",
        );
        setTruckContext({
          userId: currentUserId,
          truckId: truck?.id ? String(truck.id) : null,
          complete: true,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setTruckContext({
            userId: currentUserId,
            truckId: null,
            complete: true,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentUserId, isAuthenticated]);

  const waitingForOwnerContext =
    authState === "loading" ||
    (isAuthenticated &&
      (truckContext.userId !== currentUserId || !truckContext.complete));
  const truckId =
    isAuthenticated && truckContext.userId === currentUserId
      ? truckContext.truckId
      : null;

  const { data, isLoading, error } = useQuery({
    queryKey: [
      "public-event",
      eventId,
      currentUserId || "guest",
      truckId || "anonymous",
    ],
    enabled: Boolean(eventId) && !waitingForOwnerContext,
    queryFn: async () => {
      const truckQuery = truckId
        ? `?truckId=${encodeURIComponent(truckId)}`
        : "";
      const res = await fetch(
        apiUrl(
          `/api/public/events/${encodeURIComponent(String(eventId))}${truckQuery}`,
        ),
        {
          credentials: "include",
        },
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(
          payload?.message || `Failed to load event (status=${res.status})`,
        );
      }
      return (await res.json()) as PublicEvent;
    },
    staleTime: 30_000,
  });

  const dateKey = getEventCalendarDateKey(data?.date);
  const dateText = formatEventCalendarDate(data?.date);
  // A supplied array is authoritative, even when empty. Only older payloads
  // without the roster may fall back to the first-truck compatibility field.
  const confirmedTrucks = Array.isArray(data?.trucks)
    ? data.trucks
    : data?.truck ? [data.truck] : [];
  const description = data?.description?.trim();
  const publicAddress = data?.host?.address?.trim();
  const directionsUrl = publicAddress
    ? `https://www.google.com/maps/dir/?${new URLSearchParams({
        api: "1",
        destination: [publicAddress, data?.host?.city, data?.host?.state]
          .filter(Boolean).join(", "),
      }).toString()}`
    : null;
  const timeText =
    data?.startTime && data?.endTime
      ? `${data.startTime}–${data.endTime}`
      : null;

  const canBook =
    isAuthenticated &&
    Boolean(truckId) &&
    data?.eventType === "parking_pass" &&
    data?.requiresPayment === true &&
    data?.status === "open" &&
    !data?.ended;
  const eventLoading = waitingForOwnerContext || isLoading;
  const parkingCheckoutPath = canBook && data && truckId
    ? `/parking-pass?${new URLSearchParams({
        pass: data.id,
        date: String(data.date || "").slice(0, 10),
        truckId,
      }).toString()}`
    : null;

  return (
    <div className="min-h-screen bg-background">
      <SEOHead
        title={data?.title || "Event"}
        description={
          data?.description || "Food truck event details on MealScout."
        }
        canonicalUrl={data?.canonicalUrl || undefined}
        noIndex={Boolean(data?.noIndex)}
        schemaData={
          data?.id && data?.date
            ? [
                generateEventSchema({
                  id: data.id,
                  name: data.title,
                  description: data.description || null,
                  startDate: data.date,
                  url: data.canonicalUrl || undefined,
                  location: data.host
                    ? {
                        id: data.host.id,
                        name: data.host.name || "Location",
                        address: data.host.address || undefined,
                        city: data.host.city || undefined,
                        state: data.host.state || undefined,
                        url: data.host.path
                          ? `https://www.mealscout.us${data.host.path}`
                          : undefined,
                      }
                    : undefined,
                }),
                {
                  "@context": "https://schema.org",
                  "@type": "WebPage",
                  name: `${data.title || "Event"} on MealScout`,
                  url: data.canonicalUrl || undefined,
                  dateModified:
                    data?.lastConfirmedAtUtc || undefined,
                  about: {
                    "@type": "Event",
                    name: data.title,
                    identifier: data.id,
                  },
                  isPartOf: {
                    "@type": "WebSite",
                    name: "MealScout",
                    url: "https://www.mealscout.us",
                  },
                },
              ]
            : undefined
        }
      />

      <div className="max-w-3xl mx-auto px-4 py-10">
        <h1 className="text-3xl font-bold">
          {eventLoading ? "Loading..." : data?.title || "Event"}
        </h1>
        {error ? (
          <div className="text-sm text-destructive mt-3">
            {(error as any)?.message || "Failed to load event."}
          </div>
        ) : null}

        <div className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {dateText ? (
                <div className="text-sm text-muted-foreground">
                  <time dateTime={dateKey || undefined}>{dateText}</time>
                  {timeText ? ` · ${timeText}` : ""}
                  {timeText && data?.timeZone ? ` (${data.timeZone})` : ""}
                </div>
              ) : null}
              {data?.lastConfirmedAtUtc ? (
                <div className="text-xs text-muted-foreground">
                  Last confirmed:{" "}
                  {new Date(data.lastConfirmedAtUtc).toLocaleString()}
                </div>
              ) : null}
              {data?.ended ? (
                <div className="text-xs text-muted-foreground">
                  This event has ended.
                </div>
              ) : null}

              {description ? (
                <div className="text-sm">
                  <h2 className="font-semibold">About this event</h2>
                  <p className="whitespace-pre-line break-words text-muted-foreground mt-1">
                    {description}
                  </p>
                </div>
              ) : null}

              {data?.host ? (
                <div className="text-sm">
                  <h2 className="font-semibold">Location</h2>
                  <div className="text-muted-foreground">
                    {data.host.path ? (
                      <a className="underline" href={data.host.path}>
                        {data.host.name || "Host"}
                      </a>
                    ) : (
                      <span>{data.host.name || "Host"}</span>
                    )}
                  </div>
                  {publicAddress ? (
                    <p className="text-muted-foreground break-words">{publicAddress}</p>
                  ) : null}
                  <div className="text-muted-foreground">
                    {[data.host.city, data.host.state].filter(Boolean).join(", ")}
                  </div>
                </div>
              ) : null}

              {data ? (
                <section className="text-sm" aria-labelledby="event-trucks-heading">
                  <h2 id="event-trucks-heading" className="font-semibold">Booked trucks</h2>
                  {confirmedTrucks.length ? (
                    <ul className="mt-2 space-y-3">
                      {confirmedTrucks.map((truck) => (
                        <li key={truck.id} className="text-muted-foreground break-words">
                          {truck.path ? (
                            <a className="underline underline-offset-4 font-medium" href={truck.path}>
                              {truck.name || "Food truck"}
                            </a>
                          ) : (
                            <span>{truck.name || "Food truck"}</span>
                          )}
                          {truck.cuisineType ? <span> · {truck.cuisineType}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-muted-foreground mt-1">No truck booked yet.</p>
                  )}
                </section>
              ) : null}

              <div className="flex gap-2 flex-wrap">
                {parkingCheckoutPath ? (
                  <Button asChild>
                    <a href={parkingCheckoutPath}>Choose Parking Pass slots</a>
                  </Button>
                ) : null}
                <Button asChild variant={canBook ? "outline" : "default"}>
                  <a href="/events/public">Browse events</a>
                </Button>
                {data?.host?.path ? (
                  <Button variant="outline" asChild>
                    <a href={data.host.path}>View location</a>
                  </Button>
                ) : null}
                {directionsUrl ? (
                  <Button variant="outline" asChild>
                    <a href={directionsUrl}>Get directions</a>
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
