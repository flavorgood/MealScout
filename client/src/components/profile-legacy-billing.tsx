import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

type LegacyBillingStatus = { legacySubscriptionPresent: boolean };

export default function ProfileLegacyBilling({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["profile-legacy-billing", userId];
  const submitting = useRef(false);
  const status = useQuery<LegacyBillingStatus>({
    queryKey,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/subscription/status");
      const body = await response.json();
      if (typeof body?.legacySubscriptionPresent !== "boolean") {
        throw new Error("Legacy billing status could not be verified. Please try again.");
      }
      return { legacySubscriptionPresent: body.legacySubscriptionPresent };
    },
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const cancel = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/subscription/cancel");
      const body = await response.json();
      if (typeof body?.legacySubscriptionCanceled !== "boolean" || body.legacySubscriptionPresent === true) {
        throw new Error("The response did not confirm the legacy subscription outcome. Refresh its status before trying again.");
      }
      return { canceled: body.legacySubscriptionCanceled };
    },
    retry: false,
    onSuccess: () => queryClient.setQueryData(queryKey, { legacySubscriptionPresent: false }),
    onSettled: () => { submitting.current = false; },
  });

  return (
    <Card className="border-[color:var(--border-subtle)] bg-[var(--bg-surface)] shadow-clean" data-testid="profile-legacy-billing">
      <CardHeader>
        <CardTitle className="text-xl">Legacy billing status</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm leading-6 text-stone-600">
          Profile tools never create a monthly bill. A subscription linked under
          an older plan may still need to be stopped separately.
        </p>
        {status.isPending ? (
          <p className="flex items-center gap-2 text-sm text-stone-600" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Checking for a legacy subscription…
          </p>
        ) : status.isError ? (
          <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            <p className="font-bold">Legacy billing status is unavailable</p>
            <p className="mt-1">{status.error.message}</p>
            <Button className="mt-3 min-h-11" size="sm" variant="outline" onClick={() => status.refetch()} disabled={status.isFetching}>
              Retry billing status
            </Button>
          </div>
        ) : status.data.legacySubscriptionPresent ? (
          <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4">
            <p className="flex items-center gap-2 font-black text-stone-950">
              <AlertCircle className="h-4 w-4 text-orange-700" aria-hidden="true" />
              Legacy subscription linked
            </p>
            <p className="mt-2 text-sm leading-6 text-stone-700">
              Your account has a legacy subscription record. You can stop that
              subscription here. Your complete profile access stays active.
            </p>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button className="mt-3 min-h-11" variant="outline" disabled={cancel.isPending}>
                  {cancel.isPending ? "Stopping legacy subscription…" : "Stop legacy subscription"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Stop the legacy subscription?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This stops the legacy subscription linked to this account.
                    Your complete MealScout profile and its tools remain available.
                    Separate orders and bookings keep their own charges.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it for now</AlertDialogCancel>
                  <AlertDialogAction disabled={cancel.isPending} onClick={() => {
                    if (submitting.current) return;
                    submitting.current = true;
                    cancel.mutate();
                  }}>
                    Confirm stop
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ) : (
          <p className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-bold text-emerald-950" role="status">
            {cancel.isSuccess && cancel.data.canceled ? "Legacy subscription stopped. Your complete profile access remains active." : "No legacy subscription is linked to this account."}
          </p>
        )}
        {cancel.isError ? (
          <p className="text-sm leading-6 text-red-800" role="alert">{cancel.error.message}</p>
        ) : null}
        {!status.isPending && !status.isError ? (
          <Button size="sm" className="min-h-11" variant="ghost" disabled={status.isFetching || cancel.isPending} onClick={() => { cancel.reset(); status.refetch(); }}>
            Refresh legacy billing status
          </Button>
        ) : null}
        <p className="text-xs leading-5 text-stone-500">
          Legacy billing status never determines access to your profile tools.
        </p>
      </CardContent>
    </Card>
  );
}
