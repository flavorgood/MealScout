import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { officialSourceHoldMessage } from "@shared/ownerAiSourceHolds";

type Profile = { kind: "host" | "supplier"; id: string; name: string; aliases: string[] };
type Context = { version: string; profile: Record<string, unknown>; officialSources: string[] };
type Draft = { id: string; targetKind: Profile["kind"]; targetId: string; revision: number; status: string; contentHash: string; contextVersion: string; expiresAt: string; snapshot: Record<string, unknown>; packet: { profile: Record<string, unknown>; mediaRights?: { affirmed: true; affirmation: string }; sourceFacts?: { fields: Array<{ path: string; sourceUrl: string; capturedAt: string }> } } };

export default function NativeProfileSourceControl() {
  const profiles = useQuery<Profile[]>({ queryKey: ["/api/owner-ai/native-profiles"], retry: false });
  const [selection, setSelection] = useState("");
  // Locks outlive a selected profile's editor, including A -> B -> A switches.
  const pending = useRef(new Set<string>());
  const [busyProfiles, setBusyProfiles] = useState(new Set<string>());
  const selected = selection || (profiles.data?.[0] ? `${profiles.data[0].kind}/${profiles.data[0].id}` : "");
  const profile = profiles.data?.find(p => `${p.kind}/${p.id}` === selected);
  function begin(key: string) {
    if (pending.current.has(key)) return false;
    pending.current.add(key);
    setBusyProfiles(new Set(pending.current));
    return true;
  }
  function end(key: string) {
    pending.current.delete(key);
    setBusyProfiles(new Set(pending.current));
  }
  if (profiles.isLoading) return <p className="text-sm">Loading your location and supplier profiles.</p>;
  if (profiles.error) return <p role="status" className="text-sm">Location and supplier profiles could not load. Refresh after signing in.</p>;
  if (!profiles.data?.length) return null;
  return <Card data-testid="native-profile-source-control">
    <CardHeader><CardTitle>Reverse Osmosis</CardTitle><CardDescription>Review official source details before approving changes to your location or supplier public profile.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <label className="block text-sm">Your profile<select className="ml-3 rounded border p-2" value={selected} onChange={e => setSelection(e.target.value)}>{profiles.data.map(p => <option key={`${p.kind}/${p.id}`} value={`${p.kind}/${p.id}`}>{p.name} ({p.kind === "host" ? "host / location" : "supplier"})</option>)}</select></label>
      <p className="text-sm text-muted-foreground">Profile changes require approval here. Use your booking or purchasing workspace to manage availability, capacity and payments.</p>
      {profile ? <ProfileSourceEditor key={selected} profile={profile} busy={busyProfiles.has(selected)} begin={() => begin(selected)} end={() => end(selected)} /> : null}
    </CardContent>
  </Card>;
}

function ProfileSourceEditor({ profile, busy, begin, end }: { profile: Profile; busy: boolean; begin: () => boolean; end: () => void }) {
  const base = `/api/owner-ai/native-profiles/${profile.kind}/${profile.id}`;
  const context = useQuery<Context>({ queryKey: [base + "/context"], retry: false, staleTime: 0 });
  const drafts = useQuery<Draft[]>({ queryKey: [base + "/drafts"], retry: false, staleTime: 0 });
  const [message, setMessage] = useState("");
  const [confirmedDraft, setConfirmedDraft] = useState("");
  const [website, setWebsite] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const ready = !!context.data?.version && !!drafts.data && !context.error && !drafts.error && !context.isFetching && !drafts.isFetching;
  const openDrafts = drafts.data?.filter(d => d.status === "draft" && Date.parse(d.expiresAt) > Date.now()) || [];
  const matchesProfile = (draft: Draft) => draft.targetKind === profile.kind && draft.targetId === profile.id;
  const draft = openDrafts.find(d => matchesProfile(d) && d.contextVersion === context.data?.version) || openDrafts[0];
  const currentDraft = !!draft?.contextVersion && matchesProfile(draft) && draft.contextVersion === context.data?.version;
  const consentKey = draft ? JSON.stringify([draft.id, draft.revision, draft.contentHash, draft.contextVersion, context.data?.version]) : "";
  useEffect(() => { setWebsite(String(context.data?.profile.websiteUrl || "")); }, [context.data?.version]);
  useEffect(() => { setConfirmedDraft(""); }, [consentKey, context.isFetching, drafts.isFetching]);
  async function act(fn: () => Promise<string>) {
    if (!ready || !begin()) return;
    setMessage(""); setConfirmedDraft("");
    let result: string;
    try { result = await fn(); }
    catch (error) { result = error instanceof Error ? error.message : "Please refresh and try again."; }
    try {
      // Refresh both exact profile queries after success AND failure. A stale-version
      // response must not leave the next attempt using the rejected cached version.
      const refreshed = await Promise.all([context.refetch(), drafts.refetch()]);
      if (refreshed.some(query => query.error)) result += " Current profile details could not refresh. Refresh before trying again.";
      if (mounted.current) setMessage(result);
    } finally { end(); }
  }
  return <div className="space-y-4">
    {context.error || drafts.error ? <p role="status">Current profile details could not load. Refresh before preparing or approving a draft.</p> : null}
    <label className="block text-sm">Official website<input className="mt-1 block w-full rounded border p-2" type="url" disabled={busy || !ready} value={website} onChange={e => setWebsite(e.target.value)} placeholder="https://your-business.example" /></label>
    <Button variant="outline" disabled={busy || !ready || !website.trim()} onClick={() => void act(async () => {
      await apiRequest("POST", base + "/drafts", { expectedVersion: context.data!.version, packet: { schemaVersion: "1.0", intent: "Set my official public website", profile: { websiteUrl: website.trim() } } });
      return "Website draft prepared. Review it below before approving.";
    })}>Prepare website draft</Button>
    <Button className="ml-2" disabled={busy || !ready} onClick={() => void act(async () => {
      const result = await (await apiRequest("POST", base + "/source-draft", {})).json();
      return result.draft ? "Official-source draft prepared. Review its values and sources below." : [...new Set((Array.isArray(result.holds) && result.holds.length ? result.holds : [""]).map((hold: string) => officialSourceHoldMessage(hold)))].join(" ");
    })}>Check official sources</Button>
    {message ? <p role="status" className="text-sm">{message}</p> : null}
    {draft ? <div className="space-y-3 rounded border p-4">
      <h3 className="font-semibold">Review this draft</h3>
      {!currentDraft ? <p role="status">This draft does not match the current profile and version. Prepare a new draft and review it before approving.</p> : null}
      <dl className="space-y-2">{Object.entries(draft.packet.profile).map(([key, value]) => <div key={key}><dt className="font-medium">{key === "phone" ? "Public phone" : key === "websiteUrl" ? "Website" : key}</dt><dd className="break-words text-sm">Current: {String(context.data?.profile[key] ?? "None")}<br />{!currentDraft ? <>When drafted: {String(draft.snapshot[key] ?? "None")}<br /></> : null}Proposed: {String(value ?? "None")}</dd></div>)}</dl>
      {draft.packet.sourceFacts?.fields.map(f => <p className="break-words text-sm" key={f.path}>{f.path.split(".")[1]}: <a className="underline" href={f.sourceUrl} target="_blank" rel="noreferrer">Official source</a>, captured {new Date(f.capturedAt).toLocaleString()}</p>)}
      {(["logoUrl", "coverImageUrl"] as const).filter(field => draft.packet.profile[field]).map(field => <img className="max-h-48 rounded border" key={field} alt={field === "logoUrl" ? "Proposed logo" : "Proposed cover image"} src={`/api/owner-ai/native-profiles/drafts/${draft.id}/media/${field === "logoUrl" ? "profile-logo" : "profile-cover"}`} />)}
      {draft.packet.mediaRights ? <p className="text-sm">Image rights: {draft.packet.mediaRights.affirmation}</p> : null}
      <p className="break-words text-sm">Draft {draft.id}, revision {draft.revision}. Content hash: {draft.contentHash}</p>
      <p className="text-sm">Draft expires {new Date(draft.expiresAt).toLocaleString()}.</p>
      <label className="block text-sm"><input type="checkbox" className="mr-2" disabled={busy || !ready || !currentDraft} checked={confirmedDraft === consentKey} onChange={e => setConfirmedDraft(e.target.checked && ready && currentDraft ? consentKey : "")} />I approve the values and sources shown in this draft.</label>
      <Button disabled={busy || !ready || !currentDraft || confirmedDraft !== consentKey} onClick={() => {
        if (!currentDraft || confirmedDraft !== consentKey || Date.parse(draft.expiresAt) <= Date.now()) return;
        void act(async () => {
          await apiRequest("POST", `/api/owner-ai/native-profiles/drafts/${draft.id}/approve`, { expectedRevision: draft.revision, expectedContentHash: draft.contentHash });
          return "Approved changes saved to your native public profile.";
        });
      }}>Approve this draft</Button>
    </div> : null}
  </div>;
}
