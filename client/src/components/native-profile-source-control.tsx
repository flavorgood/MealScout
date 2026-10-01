import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Profile = { kind: "host" | "supplier"; id: string; name: string; aliases: string[] };
type Draft = { id: string; revision: number; status: string; contentHash: string; expiresAt: string; snapshot: Record<string, unknown>; packet: { profile: Record<string, unknown>; mediaRights?: { affirmed: true; affirmation: string }; sourceFacts?: { fields: Array<{ path: string; sourceUrl: string; capturedAt: string }> } } };
export default function NativeProfileSourceControl() {
  const profiles = useQuery<Profile[]>({ queryKey: ["/api/owner-ai/native-profiles"], retry: false });
  const [selection, setSelection] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmedHash, setConfirmedHash] = useState("");
  const [website, setWebsite] = useState("");
  const profile = profiles.data?.find(p => `${p.kind}/${p.id}` === selection);
  const base = profile ? `/api/owner-ai/native-profiles/${profile.kind}/${profile.id}` : "";
  const context = useQuery<{ version: string; profile: Record<string, unknown>; officialSources: string[] }>({ queryKey: [base + "/context"], enabled: !!base, retry: false, staleTime: 0 });
  const drafts = useQuery<Draft[]>({ queryKey: [base + "/drafts"], enabled: !!base, retry: false, staleTime: 0 });
  const draft = drafts.data?.find(d => d.status === "draft" && Date.parse(d.expiresAt) > Date.now());
  useEffect(() => { if (!selection && profiles.data?.length) setSelection(`${profiles.data[0].kind}/${profiles.data[0].id}`); }, [profiles.data, selection]);
  useEffect(() => { setWebsite(String(context.data?.profile.websiteUrl || "")); setConfirmedHash(""); }, [selection, context.data?.version]);
  useEffect(() => { setMessage(""); }, [selection]);
  useEffect(() => { setConfirmedHash(""); }, [draft?.contentHash]);
  async function act(fn: () => Promise<string>) {
    setBusy(true); setMessage(""); setConfirmedHash("");
    try { setMessage(await fn()); await Promise.all([context.refetch(), drafts.refetch()]); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Please refresh and try again."); }
    finally { setBusy(false); }
  }
  if (profiles.isLoading) return <p className="text-sm">Loading your location and supplier profiles…</p>;
  if (profiles.error) return <p role="status" className="text-sm">Location and supplier profiles could not load. Refresh after signing in.</p>;
  if (!profiles.data?.length) return null;
  return <Card data-testid="native-profile-source-control">
    <CardHeader><CardTitle>Location and supplier profile updates</CardTitle><CardDescription>Review verified official contact details before approving changes to your public profile.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <label className="block text-sm">Your profile<select className="ml-3 rounded border p-2" value={selection} onChange={e => setSelection(e.target.value)}>{profiles.data.map(p => <option key={`${p.kind}/${p.id}`} value={`${p.kind}/${p.id}`}>{p.name} ({p.kind === "host" ? "host / location" : "supplier"})</option>)}</select></label>
      <p className="text-sm text-muted-foreground">Profile changes require approval here. Use your booking or purchasing workspace to manage availability, capacity and payments.</p>
      {context.error || drafts.error ? <p role="status">Current profile details could not load. Refresh before preparing a draft.</p> : null}
      <label className="block text-sm">Official website<input className="mt-1 block w-full rounded border p-2" type="url" value={website} onChange={e => setWebsite(e.target.value)} placeholder="https://your-business.example" /></label>
      <Button variant="outline" disabled={busy || !context.data || !website.trim()} onClick={() => void act(async () => {
        await apiRequest("POST", base + "/drafts", { expectedVersion: context.data!.version, packet: { schemaVersion: "1.0", intent: "Set my official public website", profile: { websiteUrl: website.trim() } } });
        return "Website draft prepared. Review it below before approving.";
      })}>Prepare website draft</Button>
      <Button className="ml-2" disabled={busy || !context.data} onClick={() => void act(async () => {
        const result = await (await apiRequest("POST", base + "/source-draft", {})).json();
        return result.draft ? "Official-source draft prepared. Review its values and sources below." : result.holds.includes("MISSING_OFFICIAL_SOURCE") ? "Approve an official website first, then check it for verified details." : "The source does not yet supply supported, conflict-free public details. Your profile is unchanged.";
      })}>Check official sources</Button>
      {message ? <p role="status" className="text-sm">{message}</p> : null}
      {draft ? <div className="space-y-3 rounded border p-4">
        <h3 className="font-semibold">Review this draft</h3>
        <dl className="space-y-2">{Object.entries(draft.packet.profile).map(([key, value]) => <div key={key}><dt className="font-medium">{key === "phone" ? "Public phone" : key === "websiteUrl" ? "Website" : key}</dt><dd className="break-words text-sm">Current: {String(draft.snapshot[key] ?? "None")}<br />Proposed: {String(value ?? "None")}</dd></div>)}</dl>
        {draft.packet.sourceFacts?.fields.map(f => <p className="break-words text-sm" key={f.path}>{f.path.split(".")[1]}: <a className="underline" href={f.sourceUrl} target="_blank" rel="noreferrer">Official source</a>, captured {new Date(f.capturedAt).toLocaleString()}</p>)}
        {(["logoUrl", "coverImageUrl"] as const).filter(field => draft.packet.profile[field]).map(field => <img className="max-h-48 rounded border" key={field} alt={field === "logoUrl" ? "Proposed logo" : "Proposed cover image"} src={`/api/owner-ai/native-profiles/drafts/${draft.id}/media/${field === "logoUrl" ? "profile-logo" : "profile-cover"}`} />)}
        {draft.packet.mediaRights ? <p className="text-sm">Image rights: {draft.packet.mediaRights.affirmation}</p> : null}
        <p className="text-sm">Draft expires {new Date(draft.expiresAt).toLocaleString()}.</p>
        <label className="block text-sm"><input type="checkbox" className="mr-2" checked={confirmedHash === draft.contentHash} onChange={e => setConfirmedHash(e.target.checked ? draft.contentHash : "")} />I approve the values and sources shown in this draft.</label>
        <Button disabled={busy || confirmedHash !== draft.contentHash} onClick={() => void act(async () => {
          await apiRequest("POST", `/api/owner-ai/native-profiles/drafts/${draft.id}/approve`, { expectedRevision: draft.revision, expectedContentHash: draft.contentHash });
          return "Approved changes saved to your native public profile.";
        })}>Approve this draft</Button>
      </div> : null}
    </CardContent>
  </Card>;
}
