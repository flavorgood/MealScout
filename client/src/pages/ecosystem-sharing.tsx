import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRoute } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type SharingPreview = {
  sourceId: string; generationId: string; nativeRevision: string;
  authorityRevision: string; contentDigest: string | null; eligible: boolean;
  publicLabel: string | null; canonicalUrl: string | null; state: string;
  expiresAt: string | null;
};

export default function EcosystemSharingPage() {
  const [, params] = useRoute("/owner/ecosystem-sharing/:sourceId");
  const sourceId = params?.sourceId ?? "";
  const path = `/api/owner/ecosystem-links/${encodeURIComponent(sourceId)}`;
  const client = useQueryClient();
  const preview = useQuery<SharingPreview>({ queryKey: [path], enabled: Boolean(sourceId),
    queryFn: async () => (await apiRequest("GET", path)).json() });
  const change = useMutation({
    mutationFn: async (action: "approve" | "revoke") => {
      const value = preview.data;
      if (!value) throw new Error("Refresh the profile before changing sharing");
      const body = action === "approve" ? {
        generationId: value.generationId, nativeRevision: value.nativeRevision,
        authorityRevision: value.authorityRevision, contentDigest: value.contentDigest,
      } : { generationId: value.generationId, authorityRevision: value.authorityRevision };
      return (await apiRequest("POST", `${path}/${action}`, body)).json();
    },
    onSuccess: value => client.setQueryData([path], value),
    onError: () => { void client.invalidateQueries({ queryKey: [path] }); },
  });
  const value = preview.data;
  return <main className="mx-auto max-w-2xl px-4 py-8">
    <Link href="/restaurant-owner-dashboard" className="text-sm text-orange-700 underline">Back to your MealScout dashboard</Link>
    <Card className="mt-4">
      <CardHeader><CardTitle>Share your MealScout public link</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p>Help people in the TradeScout ecosystem discover your business and visit your MealScout profile. Share only the name and public link shown below.</p>
        <p className="text-sm text-muted-foreground">Your menus, bookings, orders and payments stay in MealScout. Visitors keep using MealScout. Sharing is optional and lasts seven days; profile or ownership changes can stop it sooner.</p>
        {preview.isPending && <p role="status">Loading your current public link…</p>}
        {preview.error && <p role="alert">{preview.error.message} <Link className="underline" href="/login">MealScout sign in</Link></p>}
        {value && <>
          {value.canonicalUrl && <a href={value.canonicalUrl} className="block font-medium text-orange-700 underline">{value.publicLabel}</a>}
          <p data-testid="ecosystem-sharing-state">Sharing: {value.state === "approved" ? "On" : "Off"}</p>
          {value.state === "approved" && value.expiresAt && <p className="text-sm">Ends {new Date(value.expiresAt).toLocaleString()}</p>}
          {!value.eligible && <p>This profile is currently unavailable for optional ecosystem sharing. Review its public details in MealScout.</p>}
          <div className="flex flex-wrap gap-3">
            <Button disabled={!value.eligible || change.isPending || preview.isFetching}
              onClick={() => change.mutate("approve")}>{value.state === "approved" ? "Renew sharing for seven days" : "Share this public link for seven days"}</Button>
            <Button variant="outline" disabled={value.state !== "approved" || change.isPending || preview.isFetching}
              onClick={() => change.mutate("revoke")}>Stop sharing</Button>
            <Button variant="ghost" disabled={change.isPending} onClick={() => { void preview.refetch(); }}>Refresh</Button>
          </div>
        </>}
        {change.error && <p role="alert">{change.error.message}</p>}
      </CardContent>
    </Card>
  </main>;
}
