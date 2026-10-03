import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useRoute } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type SharingPreview = {
  sourceId: string; publicTenantId: string; generationId: string; nativeRevision: string;
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
  const [now, setNow] = useState(Date.now);
  const [copyStatus, setCopyStatus] = useState<"copied" | "select" | null>(null);
  const linkField = useRef<HTMLInputElement>(null);
  const expiresAt = value?.expiresAt ? Date.parse(value.expiresAt) : NaN;
  useEffect(() => {
    setNow(Date.now());
    if (!Number.isFinite(expiresAt)) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(Math.max(expiresAt - Date.now(), 0), 2147483647));
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  const sharingLink = value?.eligible && value.state === "approved"
    && value.sourceId === sourceId && /^[a-zA-Z0-9_-]{1,80}$/.test(value.sourceId)
    && /^[a-f0-9]{32}$/.test(value.publicTenantId ?? "")
    && Number.isFinite(expiresAt) && expiresAt > now
    && !change.isPending && !preview.isFetching && !preview.isError
    ? `https://mealscout.onrender.com/api/ecosystem/public-links/${value.publicTenantId}/${value.sourceId}` : null;
  const currentLink = useRef(sharingLink);
  currentLink.current = sharingLink;
  useEffect(() => { setCopyStatus(null); }, [sharingLink]);
  const copySharingLink = async () => {
    if (!sharingLink || expiresAt <= Date.now()) { setNow(Date.now()); return; }
    linkField.current?.focus();
    linkField.current?.select();
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(sharingLink);
      if (currentLink.current === sharingLink) setCopyStatus("copied");
    } catch {
      if (currentLink.current === sharingLink) setCopyStatus("select");
    }
  };
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
          <p data-testid="ecosystem-sharing-state">Sharing: {value.state === "approved" && expiresAt > now ? "On" : "Off"}</p>
          {value.state === "approved" && value.expiresAt && <p className="text-sm">Ends {new Date(value.expiresAt).toLocaleString()}</p>}
          {!value.eligible && <p>This profile is currently unavailable for optional ecosystem sharing. Review its public details in MealScout.</p>}
          {sharingLink && <div className="space-y-2">
            <label htmlFor="ecosystem-sharing-link" className="block text-sm font-medium">Sharing link for TradeScout</label>
            <input id="ecosystem-sharing-link" ref={linkField} type="text" readOnly value={sharingLink}
              onClick={event => event.currentTarget.select()}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
            <p className="text-sm text-muted-foreground">Paste this link into Connected public profiles in your TradeScout profile. It shares your public name and MealScout link only.</p>
            <Button variant="outline" onClick={() => { void copySharingLink(); }}>Copy sharing link</Button>
            {copyStatus && <p role="status">{copyStatus === "copied" ? "Sharing link copied." : "Select the link above and copy it manually."}</p>}
          </div>}
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
