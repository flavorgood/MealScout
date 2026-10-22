import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Link, useSearch } from "wouter";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Loader2,
  Receipt,
  Tag,
  XCircle,
} from "lucide-react";
import OwnerOrdersWorkspace, {
  isBusinessOrderOperator,
} from "@/components/owner-orders-workspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SEOHead } from "@/components/seo-head";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest } from "@/lib/queryClient";
import DealClaimModal from "@/components/deal-claim-modal";
import { dealClaimStatus, displayClaimStatus, isDealAuthenticationError, receiptDateLabel, readClaimList, type DealClaimReceipt } from "@/lib/deal-claim-state";

type ActivityTab = "orders" | "deals";

type ConsumerOrder = {
  id: string;
  status: string;
  orderType: string;
  paymentMethod: string;
  totalCents: number;
  scheduledFor?: string | null;
  createdAt: string;
};

type ClaimedDeal = DealClaimReceipt;

const ORDER_STATUS: Record<
  string,
  { label: string; className: string; icon: typeof Clock3 }
> = {
  pending: {
    label: "Received",
    className: "border-amber-200 bg-amber-50 text-amber-900",
    icon: Clock3,
  },
  confirmed: {
    label: "Confirmed",
    className: "border-blue-200 bg-blue-50 text-blue-800",
    icon: CheckCircle2,
  },
  preparing: {
    label: "Preparing",
    className: "border-orange-200 bg-orange-50 text-orange-800",
    icon: Clock3,
  },
  ready: {
    label: "Ready",
    className: "border-emerald-200 bg-emerald-50 text-emerald-800",
    icon: CheckCircle2,
  },
  completed: {
    label: "Completed",
    className: "border-stone-200 bg-stone-100 text-stone-700",
    icon: CheckCircle2,
  },
  cancelled: {
    label: "Cancelled",
    className: "border-red-200 bg-red-50 text-red-800",
    icon: XCircle,
  },
};

function formatMoneyFromCents(cents: number | null | undefined) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function formatClaimMoney(value?: string | number | null) {
  if (value === null || value === undefined) return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : null;
}

function formatDiscount(claim: ClaimedDeal) {
  if (claim.discountValue == null || claim.discountValue === "") return "Deal claimed";
  const value = Number(claim.discountValue);
  if (!Number.isFinite(value)) return "Deal claimed";
  return claim.dealType === "fixed"
    ? `$${value.toFixed(2)} off`
    : `${value}% off`;
}

function ConsumerActivity() {
  const { user, isAuthenticated } = useAuth();
  const [selectedClaim, setSelectedClaim] = useState<ClaimedDeal>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(timer); }, []);
  const search = useSearch();
  const requestedView = new URLSearchParams(search).get("view");
  const [activeTab, setActiveTab] = useState<ActivityTab>(
    requestedView === "deals" ? "deals" : "orders",
  );

  useEffect(() => {
    setActiveTab(requestedView === "deals" ? "deals" : "orders");
  }, [requestedView]);

  const ordersQuery = useQuery<{ orders: ConsumerOrder[] }>({
    queryKey: ["/api/my/orders"],
    enabled: isAuthenticated,
    retry: false,
  });
  const dealsQuery = useQuery<ClaimedDeal[]>({
    queryKey: ["/api/deals/claimed", user?.id],
    queryFn: async () => readClaimList(await (await apiRequest("GET", "/api/deals/claimed")).json()),
    enabled: isAuthenticated,
    staleTime: 0,
    retry: false,
  });
  const orders = Array.isArray(ordersQuery.data?.orders)
    ? ordersQuery.data.orders
    : [];
  const claims = Array.isArray(dealsQuery.data) ? dealsQuery.data : [];
  const activeClaims = claims.filter((claim) => dealClaimStatus(claim, now) === "Active");
  const expiredClaims = claims.filter((claim) => dealClaimStatus(claim, now) === "Expired");
  const unavailableClaims = claims.filter((claim) => ["Unavailable", "Upcoming"].includes(dealClaimStatus(claim, now)));
  const completedClaims = claims.filter((claim) => dealClaimStatus(claim, now) === "Used");
  const isLoading = activeTab === "orders" ? ordersQuery.isLoading : dealsQuery.isLoading;
  const error = activeTab === "orders" ? ordersQuery.error : dealsQuery.error;

  const orderCounts = useMemo(
    () => ({
      active: orders.filter((order) =>
        ["pending", "confirmed", "preparing", "ready"].includes(order.status),
      ).length,
      complete: orders.filter((order) =>
        ["completed", "cancelled"].includes(order.status),
      ).length,
    }),
    [orders],
  );

  return (
    <div className="min-h-screen bg-[var(--bg-layered)] lg:pt-16">
      <SEOHead
        title="Activity - MealScout"
        description="Review your MealScout orders and claimed deals."
        canonicalUrl="https://www.mealscout.us/orders"
        noIndex
      />
      <header className="sticky top-0 z-40 border-b border-[color:var(--border-subtle)] bg-[var(--bg-popup)]/95 px-4 py-3 backdrop-blur lg:top-16">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.14em] text-orange-700">
              Your MealScout
            </p>
            <h1 className="text-xl font-black text-[color:var(--text-primary)]">
              Activity
            </h1>
          </div>
          <Button asChild variant="ghost" size="sm">
            <Link href="/scout">Scout</Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6 sm:py-7">
        <div className="grid grid-cols-2 gap-2 rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-1.5 shadow-clean">
          <Button
            type="button"
            variant={activeTab === "orders" ? "default" : "ghost"}
            className="rounded-xl"
            onClick={() => setActiveTab("orders")}
            data-testid="tab-customer-orders"
          >
            <Receipt className="mr-2 h-4 w-4" />
            Orders {orders.length}
          </Button>
          <Button
            type="button"
            variant={activeTab === "deals" ? "default" : "ghost"}
            className="rounded-xl"
            onClick={() => setActiveTab("deals")}
            data-testid="tab-customer-deals"
          >
            <Tag className="mr-2 h-4 w-4" />
            Claimed deals {claims.length}
          </Button>
        </div>

        {activeTab === "orders" && orders.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2 text-xs text-[color:var(--text-muted)]">
            <span className="rounded-full bg-orange-50 px-3 py-1.5 font-semibold text-orange-900">
              {orderCounts.active} active
            </span>
            <span className="rounded-full bg-stone-100 px-3 py-1.5 font-semibold text-stone-700">
              {orderCounts.complete} past
            </span>
          </div>
        ) : null}

        {activeTab === "deals" && claims.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2 text-xs text-[color:var(--text-muted)]">
            <span className="rounded-full bg-orange-50 px-3 py-1.5 font-semibold text-orange-900">
              {activeClaims.length} current claims
            </span>
            <span className="rounded-full bg-stone-100 px-3 py-1.5 font-semibold text-stone-700">
              {completedClaims.length} used
            </span>
            <span>{expiredClaims.length} expired</span>
            <span>{unavailableClaims.length} unavailable or upcoming</span>
          </div>
        ) : null}

        {!isAuthenticated ? (
          <Card className="mt-6"><CardContent className="space-y-3 p-6 text-center"><h2 className="font-bold">Sign in to see your activity</h2><Button asChild><Link href="/login?redirect=%2Forders%3Fview%3Ddeals">Sign in</Link></Button></CardContent></Card>
        ) : isLoading ? (
          <div className="mt-6 space-y-3">
            {[0, 1, 2].map((item) => (
              <div
                key={item}
                className="h-36 animate-pulse rounded-3xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)]"
              />
            ))}
          </div>
        ) : error ? (
          <Card className="mt-6 border-red-200 bg-red-50">
            <CardContent className="flex flex-col items-center px-6 py-10 text-center">
              <AlertCircle className="h-9 w-9 text-red-700" />
              <h2 className="mt-3 text-lg font-black text-red-950">
                Activity could not be loaded
              </h2>
              <p className="mt-1 text-sm text-red-800">
                {(error as Error).message || "Please try again."}
              </p>
              <Button className="mt-4" data-testid="button-retry-deals" onClick={() => void (activeTab === "deals" ? dealsQuery.refetch() : ordersQuery.refetch())}>Retry</Button>
              {isDealAuthenticationError(String((error as Error).message || "")) && <Button asChild variant="outline" className="mt-3"><a href={`/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)}`}>Sign in again</a></Button>}
            </CardContent>
          </Card>
        ) : activeTab === "orders" && orders.length > 0 ? (
          <div className="mt-6 space-y-3">
            {orders.map((order) => {
              const details = ORDER_STATUS[order.status] || ORDER_STATUS.pending;
              const Icon = details.icon;
              const createdAt = new Date(order.createdAt);
              return (
                <Card key={order.id} className="border-[color:var(--border-subtle)] bg-[var(--bg-surface)] shadow-clean">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-black text-[color:var(--text-primary)]">
                          Order #{order.id.slice(-6).toUpperCase()}
                        </p>
                        <p className="mt-1 text-sm capitalize text-[color:var(--text-muted)]">
                          {order.orderType.replace("_", " ")} · {order.paymentMethod}
                        </p>
                      </div>
                      <Badge variant="outline" className={`gap-1 ${details.className}`}>
                        <Icon className="h-3.5 w-3.5" />
                        {details.label}
                      </Badge>
                    </div>
                    <div className="mt-4 flex items-end justify-between gap-3 border-t border-[color:var(--border-subtle)] pt-4">
                      <div>
                        <p className="font-black text-[color:var(--text-primary)]">
                          {formatMoneyFromCents(order.totalCents)}
                        </p>
                        <p className="mt-0.5 text-xs text-[color:var(--text-muted)]">
                          {Number.isNaN(createdAt.getTime())
                            ? "Date unavailable"
                            : format(createdAt, "MMM d, yyyy · h:mm a")}
                        </p>
                      </div>
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/order-confirmation/${order.id}`}>View status</Link>
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : activeTab === "deals" && claims.length > 0 ? (
          <div className="mt-6 space-y-3">
            {claims.map((claim) => {
              const claimedAt = new Date(claim.claimedAt);
              const claimStatus = dealClaimStatus(claim, now);
              return (
                <Card key={claim.id} data-testid={`claimed-deal-${claim.id}`} className="border-[color:var(--border-subtle)] bg-[var(--bg-surface)] shadow-clean">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-black text-[color:var(--text-primary)]">
                          {claim.restaurantName || "Food business"}
                        </p>
                        <p className="mt-1 text-sm text-[color:var(--text-muted)]">
                          {claim.dealTitle || "Claimed deal"}
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className={
                          claimStatus !== "Active"
                            ? "border-stone-200 bg-stone-100 text-stone-700"
                            : "border-orange-200 bg-orange-50 text-orange-800"
                        }
                      >
                        <span data-testid={`claim-status-${claim.id}`}>{displayClaimStatus(claimStatus)}</span>
                      </Badge>
                    </div>
                    <div className="mt-4 flex items-end justify-between gap-3 border-t border-[color:var(--border-subtle)] pt-4">
                      <div>
                        <p className="font-black text-orange-800">
                          {formatDiscount(claim)}
                        </p>
                        <p className="mt-1 break-all text-xs text-muted-foreground">Receipt: {claim.id}</p>
                        {claim.endDate && <p className="mt-1 text-xs text-muted-foreground">Expires {receiptDateLabel(claim.endDate)}</p>}
                        <p className="mt-0.5 text-xs text-[color:var(--text-muted)]">
                          {formatClaimMoney(claim.orderAmount)
                            ? `${formatClaimMoney(claim.orderAmount)} order · `
                            : ""}
                          {Number.isNaN(claimedAt.getTime())
                            ? "Date unavailable"
                            : format(claimedAt, "MMM d, yyyy")}
                        </p>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => setSelectedClaim(claim)}>View receipt</Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <Card className="mt-6 border-dashed border-orange-200 bg-[var(--bg-surface)]">
            <CardContent className="px-6 py-14 text-center">
              {activeTab === "orders" ? (
                <Receipt className="mx-auto h-10 w-10 text-orange-600" />
              ) : (
                <Tag className="mx-auto h-10 w-10 text-orange-600" />
              )}
              <h2 className="mt-4 text-xl font-black text-[color:var(--text-primary)]">
                {activeTab === "orders" ? "No orders yet" : "No claimed deals yet"}
              </h2>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-[color:var(--text-muted)]">
                {activeTab === "orders"
                  ? "Orders placed through a MealScout menu will appear here."
                  : "Your claim receipts stay here, including used and expired specials."}
              </p>
              <Button asChild className="mt-6">
                <Link href="/scout">Scout</Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </main>
      <DealClaimModal key={selectedClaim?.id || "none"} dealId={selectedClaim?.dealId || ""} isOpen={!!selectedClaim} existingClaim={selectedClaim} onClose={() => setSelectedClaim(undefined)} />
    </div>
  );
}

export default function OrdersPage() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg-layered)]">
        <Loader2 className="h-7 w-7 animate-spin text-orange-600" />
      </div>
    );
  }

  if (isBusinessOrderOperator(user?.userType)) {
    return <OwnerOrdersWorkspace view="orders" />;
  }

  return <ConsumerActivity key={user?.id || "guest"} />;
}
