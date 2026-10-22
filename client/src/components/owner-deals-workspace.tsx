import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Link } from "wouter";
import type { Deal } from "@shared/schema";
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Edit3,
  Eye,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Tag,
  Trash2,
  Users,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

type DealStatus = "live" | "scheduled" | "paused" | "expired";
type DealFilter = "all" | DealStatus;

type OwnerDealsWorkspaceProps = {
  restaurantId: string;
  businessName: string;
  canManageDeals: boolean;
  stats?: {
    totalClaims?: number | null;
  } | null;
};

const STATUS_DETAILS: Record<
  DealStatus,
  { label: string; className: string; icon: typeof CheckCircle2 }
> = {
  live: {
    label: "Live",
    className: "border-emerald-200 bg-emerald-50 text-emerald-800",
    icon: CheckCircle2,
  },
  scheduled: {
    label: "Scheduled",
    className: "border-blue-200 bg-blue-50 text-blue-800",
    icon: CalendarClock,
  },
  paused: {
    label: "Paused",
    className: "border-amber-200 bg-amber-50 text-amber-900",
    icon: Pause,
  },
  expired: {
    label: "Expired",
    className: "border-stone-200 bg-stone-100 text-stone-700",
    icon: Clock3,
  },
};

function getDealStatus(deal: Deal, now = Date.now()): DealStatus {
  const startAt = new Date(deal.startDate).getTime();
  const endAt = deal.endDate ? new Date(deal.endDate).getTime() : null;

  if (endAt !== null && Number.isFinite(endAt) && endAt < now) {
    return "expired";
  }
  if (!deal.isActive) return "paused";
  if (Number.isFinite(startAt) && startAt > now) return "scheduled";
  return "live";
}

function formatDiscount(deal: Deal) {
  const value = Number(deal.discountValue || 0);
  return deal.dealType === "percentage"
    ? `${value.toLocaleString()}% off`
    : `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} off`;
}

function formatDateRange(deal: Deal) {
  const start = format(new Date(deal.startDate), "MMM d, yyyy");
  if (deal.isOngoing || !deal.endDate) return `${start} onward`;
  return `${start} – ${format(new Date(deal.endDate), "MMM d, yyyy")}`;
}

function formatTime(time: string) {
  const [hours, minutes] = time.split(":");
  const date = new Date(2000, 0, 1, Number(hours), Number(minutes));
  return format(date, "h:mm a");
}

function formatAvailability(deal: Deal) {
  if (deal.availableDuringBusinessHours) return "During business hours";
  if (deal.startTime && deal.endTime) {
    return `${formatTime(deal.startTime)} – ${formatTime(deal.endTime)}`;
  }
  return "Time not specified";
}

export default function OwnerDealsWorkspace({
  restaurantId,
  businessName,
  canManageDeals,
  stats,
}: OwnerDealsWorkspaceProps) {
  const { toast } = useToast();
  const [filter, setFilter] = useState<DealFilter>("all");
  const ownerDealsQueryKey = [
    "/api/owner/restaurants",
    restaurantId,
    "deals",
  ] as const;
  const {
    data: deals = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<Deal[]>({
    queryKey: ownerDealsQueryKey,
    enabled: Boolean(restaurantId && canManageDeals),
  });

  const dealsWithStatus = useMemo(
    () => deals.map((deal) => ({ deal, status: getDealStatus(deal) })),
    [deals],
  );
  const counts = useMemo(
    () =>
      dealsWithStatus.reduce(
        (result, item) => {
          result[item.status] += 1;
          return result;
        },
        { live: 0, scheduled: 0, paused: 0, expired: 0 },
      ),
    [dealsWithStatus],
  );
  const filteredDeals =
    filter === "all"
      ? dealsWithStatus
      : dealsWithStatus.filter((item) => item.status === filter);
  const claims =
    stats?.totalClaims ??
    deals.reduce((sum, deal) => sum + Number(deal.currentUses || 0), 0);
  const createHref = `/deal-creation?restaurantId=${encodeURIComponent(restaurantId)}`;

  const refreshDeals = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ownerDealsQueryKey }),
      queryClient.invalidateQueries({
        queryKey: [`/api/deals/restaurant/${restaurantId}`],
      }),
      queryClient.invalidateQueries({
        queryKey: [`/api/restaurants/${restaurantId}/stats`],
      }),
    ]);
  };

  const statusMutation = useMutation({
    mutationFn: async ({ dealId, isActive }: { dealId: string; isActive: boolean }) =>
      apiRequest("PATCH", `/api/deals/${dealId}`, { isActive }),
    onSuccess: async (_response, variables) => {
      await refreshDeals();
      toast({
        title: variables.isActive ? "Special activated" : "Special paused",
        description: variables.isActive
          ? "Customers can now see this special during its scheduled window."
          : "This special is no longer visible to customers.",
      });
    },
    onError: (mutationError: Error) => {
      toast({
        title: "Unable to update special",
        description: mutationError.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (dealId: string) =>
      apiRequest("DELETE", `/api/deals/${dealId}`),
    onSuccess: async () => {
      await refreshDeals();
      toast({
        title: "Special removed from customers",
        description: "Issued claim receipts are kept. Specials with receipts remain paused in your history.",
      });
    },
    onError: (mutationError: Error) => {
      toast({
        title: "Unable to remove special",
        description: mutationError.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  if (!canManageDeals) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="flex gap-3 p-5 text-amber-950">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-bold">Deal access is not enabled</p>
              <p className="mt-1 text-sm text-amber-900/80">
                Ask the business owner to grant you permission to manage deals.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <section className="overflow-hidden rounded-3xl border border-orange-200 bg-gradient-to-br from-orange-50 via-amber-50 to-rose-50 p-5 sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2 text-sm font-black text-orange-800">
              <Tag className="h-4 w-4" aria-hidden="true" />
              Specials and deals
            </div>
            <h2 className="mt-2 text-2xl font-black tracking-tight text-stone-950">
              Give people a reason to choose {businessName}
            </h2>
            <p className="mt-2 text-sm leading-6 text-stone-700">
              Live specials can appear on your public profile and throughout MealScout discovery.
            </p>
          </div>
          <Button asChild className="shrink-0" data-testid="button-create-first-deal">
            <Link href={createHref}>
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
              New special
            </Link>
          </Button>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: "Live", value: counts.live, icon: CheckCircle2 },
            { label: "Scheduled", value: counts.scheduled, icon: CalendarClock },
            { label: "Needs attention", value: counts.paused + counts.expired, icon: AlertCircle },
            { label: "Claims", value: claims, icon: Users },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.label} className="rounded-2xl border border-white/80 bg-white/75 p-4 shadow-sm">
                <Icon className="h-4 w-4 text-orange-700" aria-hidden="true" />
                <p className="mt-3 text-2xl font-black text-stone-950">{item.value}</p>
                <p className="text-xs font-bold text-stone-600">{item.label}</p>
              </div>
            );
          })}
        </div>
      </section>

      <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label="Filter specials">
        {([
          ["all", "All", deals.length],
          ["live", "Live", counts.live],
          ["scheduled", "Scheduled", counts.scheduled],
          ["paused", "Paused", counts.paused],
          ["expired", "Expired", counts.expired],
        ] as const).map(([value, label, count]) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={filter === value ? "default" : "outline"}
            className="shrink-0 rounded-full"
            onClick={() => setFilter(value)}
            aria-pressed={filter === value}
            data-testid={`deal-filter-${value}`}
          >
            {label} <span className="ml-1 opacity-70">{count}</span>
          </Button>
        ))}
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="flex min-h-48 items-center justify-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            Loading specials…
          </CardContent>
        </Card>
      ) : isError ? (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-3 text-red-950">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <div>
                <p className="font-bold">Specials could not be loaded</p>
                <p className="mt-1 text-sm text-red-900/80">
                  {error instanceof Error ? error.message : "Please try again."}
                </p>
              </div>
            </div>
            <Button type="button" variant="outline" onClick={() => void refetch()}>
              <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : filteredDeals.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex min-h-56 flex-col items-center justify-center px-6 py-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-100 text-orange-800">
              <Tag className="h-5 w-5" aria-hidden="true" />
            </div>
            <h3 className="mt-4 text-lg font-black text-foreground">
              {deals.length === 0 ? "Create your first special" : `No ${filter} specials`}
            </h3>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              {deals.length === 0
                ? "Add a clear offer, a food photo, and the dates people can claim it."
                : "Choose another filter to review your other specials."}
            </p>
            {deals.length === 0 ? (
              <Button asChild className="mt-5">
                <Link href={createHref}>New special</Link>
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {filteredDeals.map(({ deal, status }) => {
            const statusDetails = STATUS_DETAILS[status];
            const StatusIcon = statusDetails.icon;
            const statusChangePending =
              statusMutation.isPending && statusMutation.variables?.dealId === deal.id;
            const deletePending = deleteMutation.isPending && deleteMutation.variables === deal.id;
            const editHref = `/deal-edit/${deal.id}?restaurantId=${encodeURIComponent(restaurantId)}`;

            return (
              <Card key={deal.id} className="overflow-hidden border-[color:var(--border-subtle)] shadow-sm">
                <CardContent className="p-0">
                  <div className="grid sm:grid-cols-[11rem_minmax(0,1fr)]">
                    <div className="relative min-h-40 bg-orange-50 sm:min-h-full">
                      {deal.imageUrl ? (
                        <img src={deal.imageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-orange-300">
                          <Tag className="h-8 w-8" aria-hidden="true" />
                        </div>
                      )}
                      <Badge className={`absolute left-3 top-3 gap-1 border ${statusDetails.className}`}>
                        <StatusIcon className="h-3.5 w-3.5" aria-hidden="true" />
                        {statusDetails.label}
                      </Badge>
                    </div>

                    <div className="min-w-0 p-5">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-lg font-black text-foreground">{deal.title}</h3>
                            <Badge variant="secondary">{formatDiscount(deal)}</Badge>
                          </div>
                          <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">
                            {deal.description}
                          </p>
                          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs font-medium text-[color:var(--text-secondary)]">
                            <span className="inline-flex items-center gap-1.5">
                              <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                              {formatDateRange(deal)}
                            </span>
                            <span className="inline-flex items-center gap-1.5">
                              <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
                              {formatAvailability(deal)}
                            </span>
                            <span className="inline-flex items-center gap-1.5">
                              <Users className="h-3.5 w-3.5" aria-hidden="true" />
                              {Number(deal.currentUses || 0)} claimed
                              {deal.totalUsesLimit ? ` of ${deal.totalUsesLimit}` : ""}
                            </span>
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-wrap gap-2">
                          <Button asChild variant="ghost" size="sm">
                            <a href={`/deal/${deal.id}`} target="_blank" rel="noreferrer">
                              <Eye className="mr-1.5 h-4 w-4" aria-hidden="true" />
                              Preview
                            </a>
                          </Button>
                          <Button asChild variant="outline" size="sm">
                            <Link href={editHref}>
                              <Edit3 className="mr-1.5 h-4 w-4" aria-hidden="true" />
                              {status === "expired" ? "Edit dates" : "Edit"}
                            </Link>
                          </Button>
                          {status !== "expired" ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={statusChangePending}
                              onClick={() =>
                                statusMutation.mutate({ dealId: deal.id, isActive: status === "paused" })
                              }
                              data-testid={`button-${status === "paused" ? "activate" : "pause"}-${deal.id}`}
                            >
                              {statusChangePending ? (
                                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
                              ) : status === "paused" ? (
                                <Play className="mr-1.5 h-4 w-4" aria-hidden="true" />
                              ) : (
                                <Pause className="mr-1.5 h-4 w-4" aria-hidden="true" />
                              )}
                              {status === "paused" ? "Activate" : "Pause"}
                            </Button>
                          ) : null}
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${deal.title}`}>
                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Remove this special from customers?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Customers will no longer see “{deal.title}”. Issued claim receipts are kept, so specials with receipts remain paused in your history. Specials without receipts are deleted.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Keep special</AlertDialogCancel>
                                <AlertDialogAction
                                  disabled={deletePending}
                                  onClick={() => deleteMutation.mutate(deal.id)}
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                >
                                  {deletePending ? "Removing…" : "Remove special"}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <span className="sr-only" aria-live="polite">
        {statusMutation.isPending || deleteMutation.isPending ? "Updating specials" : ""}
      </span>
    </div>
  );
}
