import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { Heart, MapPin, Phone, Share2, Tag } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest } from "@/lib/queryClient";
import { trackDealViewOnce } from "@/lib/dealViewTracking";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import DealClaimModal from "@/components/deal-claim-modal";
import DealShareModal from "@/components/deal-share-modal";
import { BackHeader } from "@/components/back-header";
import { SEOHead } from "@/components/seo-head";
import { extractUuidFromSlug } from "@/lib/seo-slug";
import { dealClaimStatus, displayClaimStatus, isDealAuthenticationError, dealDirectionsHref, dealIntentPath, dealPhoneHref, readClaimList, type DealClaimReceipt } from "@/lib/deal-claim-state";

type Restaurant = { id: string; name: string; address?: string | null; phone?: string | null; cuisineType?: string | null; };
type Deal = {
  id: string; restaurantId: string; title: string; description?: string | null;
  dealType: string; discountValue: string; minOrderAmount?: string | null;
  imageUrl?: string | null; startDate?: string | null; endDate?: string | null;
  startTime?: string | null; endTime?: string | null; isActive?: boolean;
  isOngoing?: boolean; availableDuringBusinessHours?: boolean; currentUses?: number;
  totalUsesLimit?: number | null; perCustomerLimit?: number; distance?: number;
  restaurant?: Restaurant;
};
type Favorite = { restaurantId?: string; restaurant?: { id: string } };
type Review = { id: string; comment?: string | null; reviewText?: string | null; createdAt?: string; user?: { firstName?: string | null } | null };

function timeLabel(value?: string | null) {
  if (!value || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) return null;
  const [hours, minutes] = value.split(":");
  const hour = Number(hours);
  return `${hour % 12 || 12}:${minutes} ${hour >= 12 ? "PM" : "AM"}`;
}

export default function DealDetail() {
  const params = useParams() as Record<string, string | undefined>;
  const dealParam = params.id || params.slug || "";
  const dealId = extractUuidFromSlug(dealParam) || dealParam;
  const { user, isAuthenticated, authState } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showClaimModal, setShowClaimModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [newClaim, setNewClaim] = useState<{ userId: string; claim: DealClaimReceipt }>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveContinuation, setSaveContinuation] = useState(false);
  const saveBusy = useRef(false);
  const saveGeneration = useRef(0);
  const [now, setNow] = useState(Date.now());
  const currentPath = () => window.location.pathname + window.location.search + window.location.hash;

  const dealQuery = useQuery<Deal>({
    queryKey: ["/api/deals", dealId],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/deals/${encodeURIComponent(dealId)}`);
      const value = await response.json();
      if (!value || value.id !== dealId || typeof value.restaurantId !== "string" || typeof value.title !== "string") throw new Error("Special details could not be read");
      return value;
    },
    enabled: !!dealId, retry: false, staleTime: 0,
  });
  const deal = dealQuery.data;
  const restaurant = deal?.restaurant;
  const reviewsQuery = useQuery<Review[]>({
    queryKey: ["/api/reviews/restaurant", deal?.restaurantId],
    queryFn: async () => {
      const rows = await (await apiRequest("GET", `/api/reviews/restaurant/${encodeURIComponent(deal!.restaurantId)}`)).json();
      if (!Array.isArray(rows)) throw new Error("Reviews could not be read");
      return rows;
    },
    enabled: !!deal?.restaurantId, retry: false,
  });
  const claimsQuery = useQuery<DealClaimReceipt[]>({
    queryKey: ["/api/deals/claimed", user?.id],
    queryFn: async () => readClaimList(await (await apiRequest("GET", "/api/deals/claimed")).json()),
    enabled: isAuthenticated, retry: false, staleTime: 0,
  });
  const favoritesQuery = useQuery<Favorite[]>({
    queryKey: ["/api/favorites/restaurants", user?.id],
    queryFn: async () => {
      const rows = await (await apiRequest("GET", "/api/favorites/restaurants")).json();
      if (!Array.isArray(rows)) throw new Error("Saved places could not be read");
      return rows;
    },
    enabled: isAuthenticated, retry: false, staleTime: 0,
  });
  const saved = favoritesQuery.data?.some((row) => (row.restaurantId || row.restaurant?.id) === deal?.restaurantId) || false;
  const existingClaim = (newClaim?.userId === user?.id && newClaim?.claim.dealId === dealId ? newClaim.claim : undefined) || claimsQuery.data?.find((claim) => claim.dealId === dealId);
  const end = deal?.endDate ? Date.parse(deal.endDate) : null;
  const start = deal?.startDate ? Date.parse(deal.startDate) : null;
  const unavailable = !deal || deal.isActive !== true ||
    (end !== null && (!Number.isFinite(end) || end <= now)) ||
    (start !== null && (!Number.isFinite(start) || start > now)) ||
    (deal.totalUsesLimit != null && Number(deal.currentUses) >= deal.totalUsesLimit);
  const phoneHref = dealPhoneHref(restaurant?.phone);
  const directionsHref = dealDirectionsHref(restaurant?.address);
  const startTime = timeLabel(deal?.startTime);
  const endTime = timeLabel(deal?.endTime);

  useEffect(() => {
    setNewClaim(undefined); setShowClaimModal(false); setSaveError(""); setSaveContinuation(false);
    saveGeneration.current += 1; saveBusy.current = false; setSaving(false);
    return () => { saveGeneration.current += 1; };
  }, [dealId, user?.id]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!deal) return;
    const timer = window.setTimeout(() => { void trackDealViewOnce(dealId).catch(() => {}); }, 1000);
    return () => window.clearTimeout(timer);
  }, [dealId, deal?.id]);
  useEffect(() => {
    if (!isAuthenticated || !deal || claimsQuery.isLoading || claimsQuery.isError) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("intent") !== "claim") return;
    setShowClaimModal(true);
    url.searchParams.delete("intent");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  }, [isAuthenticated, deal?.id, claimsQuery.isLoading, claimsQuery.isError]);
  useEffect(() => {
    if (!isAuthenticated || !deal || favoritesQuery.isLoading || favoritesQuery.isError) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("intent") !== "save") return;
    setSaveContinuation(true);
    url.searchParams.delete("intent");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  }, [isAuthenticated, deal?.id, favoritesQuery.isLoading, favoritesQuery.isError]);

  const startClaim = () => {
    if (!isAuthenticated) {
      window.location.href = `/login?redirect=${encodeURIComponent(dealIntentPath(currentPath(), "claim"))}`;
      return;
    }
    setShowClaimModal(true);
  };
  const toggleSave = async () => {
    if (!deal) return;
    if (!isAuthenticated) {
      window.location.href = `/login?redirect=${encodeURIComponent(dealIntentPath(currentPath(), "save"))}`;
      return;
    }
    if (saveBusy.current || !favoritesQuery.data) return;
    saveBusy.current = true;
    const generation = saveGeneration.current;
    setSaving(true); setSaveError("");
    try {
      await apiRequest(saved ? "DELETE" : "POST", `/api/restaurants/${encodeURIComponent(deal.restaurantId)}/favorite`);
      if (generation !== saveGeneration.current) return;
      await queryClient.invalidateQueries({ queryKey: ["/api/favorites/restaurants"] });
      toast({ title: saved ? "Place removed from Saved" : "Place saved", description: "Your saved places are available from Saved." });
    } catch (error) {
      if (generation !== saveGeneration.current) return;
      const message = error instanceof Error ? error.message : "Save not confirmed";
      if (isDealAuthenticationError(message)) {
        window.location.href = `/login?redirect=${encodeURIComponent(dealIntentPath(currentPath(), "save"))}`;
        return;
      }
      setSaveError(`${message}. Refresh your saved places before retrying.`);
    } finally {
      if (generation === saveGeneration.current) { saveBusy.current = false; setSaving(false); }
    }
  };
  const saveDisabled = saving || authState === "loading" || (isAuthenticated && !favoritesQuery.data);
  const saveLabel = saving ? "Saving…" : saved ? "Saved place" : "Save place";

  if (dealQuery.isLoading) return <div className="min-h-screen bg-[var(--bg-layered)] p-8" role="status">Loading special…</div>;
  if (dealQuery.isError || !deal) return (
    <div className="min-h-screen bg-[var(--bg-layered)] p-6">
      <Card className="mx-auto max-w-md"><CardContent className="space-y-4 p-6 text-center">
        <h1 className="text-xl font-bold">{/not found/i.test(String(dealQuery.error?.message)) ? "Special unavailable" : "Special could not be loaded"}</h1>
        <p className="text-sm text-muted-foreground">This special may have ended, or its details may be temporarily unavailable.</p>
        <Button onClick={() => void dealQuery.refetch()}>Retry</Button>
        <Button asChild variant="outline"><Link href="/search">Find food</Link></Button>
      </CardContent></Card>
    </div>
  );

  return (
    <div className="mx-auto min-h-screen max-w-3xl bg-[var(--bg-layered)] pb-36 lg:pt-16">
      <SEOHead title={`${deal.title} | MealScout`} description={deal.description || "View this MealScout special."} canonicalUrl={`https://www.mealscout.us/deal/${dealId}`} />
      <BackHeader title="Special details" fallbackHref="/search" icon={Tag} />
      <div className="flex items-center justify-end gap-2 px-4 py-3">
        <Button variant="outline" onClick={() => setShowShareModal(true)} data-testid="button-share"><Share2 className="mr-2 h-4 w-4" />Share</Button>
        <Button variant="outline" disabled={saveDisabled} onClick={() => void toggleSave()} aria-pressed={saved} data-testid="button-favorite"><Heart className={`mr-2 h-4 w-4 ${saved ? "fill-current" : ""}`} />{saveLabel}</Button>
      </div>
      {deal.imageUrl && <img src={deal.imageUrl} alt="" className="h-56 w-full object-cover sm:h-72" />}
      <main className="space-y-5 px-4 py-6 sm:px-6">
        {saveContinuation && <div role="status" className="rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm text-stone-900">{saved ? "This place is already in your saved places." : "You’re back at your special. Tap Save place to keep this business in your saved places."}</div>}
        <div>
          <p className="text-sm font-bold text-orange-700" data-testid="text-discount-badge">{deal.dealType === "percentage" ? `${deal.discountValue}% off` : `$${deal.discountValue} off`}</p>
          <h1 className="mt-1 text-3xl font-black" data-testid="text-deal-title">{deal.title}</h1>
          {restaurant?.name && <p className="mt-2 font-semibold" data-testid="text-restaurant-name">{restaurant.name}</p>}
          {deal.description && <p className="mt-3 text-sm leading-6 text-muted-foreground" data-testid="text-deal-description">{deal.description}</p>}
        </div>
        <Card><CardContent className="space-y-3 p-5 text-sm">
          <p data-testid="text-deal-time">{startTime && endTime ? `Offer hours: ${startTime} – ${endTime}` : deal.availableDuringBusinessHours ? "Available during business hours" : "Offer hours not provided"}</p>
          {deal.minOrderAmount && <p data-testid="text-min-order">Minimum order: ${deal.minOrderAmount}</p>}
          <p data-testid="text-pickup-time">Pickup timing: confirm with the business</p>
          <p data-testid="text-deal-expires">{deal.endDate && Number.isFinite(Date.parse(deal.endDate)) ? `Ends ${new Date(deal.endDate).toLocaleString()}` : deal.isOngoing ? "Ongoing special" : "Expiry not provided"}</p>
          {unavailable && <p role="status" className="font-semibold text-red-700">This special is not currently available to claim.</p>}
        </CardContent></Card>
        <div className="grid gap-3 sm:grid-cols-2">
          <Card><CardContent className="p-4">
            {phoneHref ? <a href={phoneHref} className="inline-flex min-h-11 items-center gap-2 font-bold" data-testid="button-call"><Phone className="h-4 w-4" />Call business</a> : <p className="font-semibold">Phone not provided</p>}
            {phoneHref && <p className="text-sm text-muted-foreground" data-testid="text-restaurant-phone">{restaurant?.phone}</p>}
          </CardContent></Card>
          <Card><CardContent className="p-4">
            {directionsHref ? <a href={directionsHref} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 font-bold" data-testid="button-directions"><MapPin className="h-4 w-4" />Directions</a> : <p className="font-semibold">Address not provided</p>}
            {restaurant?.address && <p className="text-sm text-muted-foreground" data-testid="text-directions">{restaurant.address}</p>}
          </CardContent></Card>
        </div>
        <p className="text-sm text-muted-foreground">Saving keeps this business in your <Link href="/favorites" className="underline">saved places</Link>. Claiming keeps a receipt in <Link href="/orders?view=deals" className="underline">claimed deals</Link>.</p>
        {reviewsQuery.data && reviewsQuery.data.length > 0 && <section aria-labelledby="deal-reviews-heading" className="space-y-3">
          <h2 id="deal-reviews-heading" className="text-lg font-bold">Recent recommendations</h2>
          {reviewsQuery.data.slice(0, 2).map((review) => <Card key={review.id}><CardContent className="space-y-2 p-4">
            <p className="text-sm font-semibold">{review.user?.firstName || "MealScout customer"}</p>
            {(review.comment || review.reviewText) && <p className="text-sm text-muted-foreground">{review.comment || review.reviewText}</p>}
            {review.createdAt && Number.isFinite(Date.parse(review.createdAt)) && <p className="text-xs text-muted-foreground">{new Date(review.createdAt).toLocaleDateString()}</p>}
          </CardContent></Card>)}
        </section>}
        {reviewsQuery.isError && <p className="text-sm text-muted-foreground">Recommendations are temporarily unavailable.</p>}
        {(saveError || favoritesQuery.isError) && <div role="alert" className="space-y-2 text-sm text-red-700"><p>{saveError || "Saved places could not be loaded."}</p><Button variant="outline" onClick={() => void favoritesQuery.refetch()}>Refresh saved places</Button></div>}
        {isAuthenticated && claimsQuery.isError && <div role="alert" className="space-y-2 text-sm text-red-700"><p>Claim history could not be loaded. Check it before claiming again.</p><Button variant="outline" onClick={() => void claimsQuery.refetch()}>Retry claim history</Button></div>}
      </main>
      <div className="fixed bottom-0 left-1/2 z-40 w-full max-w-3xl -translate-x-1/2 border-t border-[color:var(--border-subtle)] bg-[var(--bg-popup)] px-4 py-4 shadow-clean">
        <div className="flex gap-3">
          <Button className="min-h-11 flex-1" onClick={startClaim} disabled={authState === "loading" || (isAuthenticated && (claimsQuery.isLoading || claimsQuery.isError)) || (!existingClaim && unavailable)} data-testid="button-claim-deal">{existingClaim ? `View claim · ${displayClaimStatus(dealClaimStatus(existingClaim, now))}` : isAuthenticated ? "Claim special" : "Sign in to claim"}</Button>
          <Button variant="outline" disabled={saveDisabled} onClick={() => void toggleSave()} aria-pressed={saved} data-testid="button-save-deal">{saveLabel}</Button>
        </div>
        <p className="mt-2 text-center text-xs text-muted-foreground">No purchase or social post is made by claiming.</p>
      </div>
      <DealClaimModal key={`${dealId}:${user?.id || "guest"}`} dealId={dealId} isOpen={showClaimModal} onClose={() => setShowClaimModal(false)} existingClaim={existingClaim} onClaimed={(claim) => { if (user?.id) setNewClaim({ userId: user.id, claim }); }} />
      <DealShareModal isOpen={showShareModal} onClose={() => setShowShareModal(false)} deal={{ id: deal.id, title: deal.title, description: deal.description || "", discountValue: deal.discountValue, minOrderAmount: deal.minOrderAmount || undefined, restaurant: { name: restaurant?.name || "Food business", cuisineType: restaurant?.cuisineType || undefined } }} />
    </div>
  );
}
