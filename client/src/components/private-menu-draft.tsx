import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { buildProgressiveAccountPath, getProgressiveAccountGate, preserveProgressiveAuthContext } from "@shared/progressiveOnboarding";
import { getGuestMenuJourneyStage } from "@/lib/menu-builder-navigation";
import {
  emptyGuestMenuDraft, emptyGuestMenuItem, GUEST_MENU_MAX_ITEMS, GUEST_MENU_CATEGORY_NOTICE,
  persistGuestMenuDraft, readGuestMenuDraft, readGuestMenuDraftSavedAt,
  type GuestMenuDraft, type GuestMenuItemDraft,
} from "@shared/guestMenuDraft";

export function PrivateMenuDraftEditor({ draft, onChange, onKeep, kept = false }: {
  draft: GuestMenuDraft; onChange: (draft: GuestMenuDraft) => void; onKeep: () => void; kept?: boolean;
}) {
  const changeItem = (index: number, field: keyof GuestMenuItemDraft, value: string) => {
    onChange({ ...draft, items: draft.items.map((item, position) => position === index ? { ...item, [field]: value } : item) });
  };
  const journeyStage = getGuestMenuJourneyStage({
    hasNamedItem: draft.items.some((item) => item.name.trim().length > 0),
    kept,
  });
  return (
    <section className="mx-auto max-w-5xl space-y-6 px-4 py-8" aria-labelledby="private-menu-title">
      <header>
        <p className="text-sm font-medium text-muted-foreground">Private draft</p>
        <h1 id="private-menu-title" className="text-3xl font-bold">Design your menu</h1>
        <p className="mt-2 text-muted-foreground">Build and preview here. Keep your work when you are ready to sign in and verify your email.</p>
        <p className="mt-3 text-sm font-medium" data-testid="menu-journey-stage">
          Step {journeyStage.step} of {journeyStage.stageCount}: {journeyStage.title}.{" "}
          {journeyStage.isComplete
            ? "Your draft is saved on this device."
            : journeyStage.hint}
        </p>
      </header>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div><Label htmlFor="private-menu-name">Menu name</Label><Input id="private-menu-name" maxLength={160} value={draft.name} onChange={event => onChange({ ...draft, name: event.target.value })} /></div>
          <div><Label htmlFor="private-menu-service">Service</Label><select id="private-menu-service" className="mt-1 h-10 w-full rounded-md border bg-background px-3" value={draft.serviceType} onChange={event => onChange({ ...draft, serviceType: event.target.value as GuestMenuDraft["serviceType"] })}>
            <option value="all">All day</option><option value="breakfast">Breakfast</option><option value="lunch">Lunch</option><option value="dinner">Dinner</option>
          </select></div>
          {draft.items.map((item, index) => (
            <fieldset key={index} className="space-y-3 rounded-xl border p-4">
              <legend className="px-1 font-medium">Item {index + 1}</legend>
              <div><Label htmlFor={`private-item-name-${index}`}>Name</Label><Input id={`private-item-name-${index}`} maxLength={160} value={item.name} onChange={event => changeItem(index, "name", event.target.value)} /></div>
              <div><Label htmlFor={`private-item-description-${index}`}>Description</Label><Textarea id={`private-item-description-${index}`} maxLength={500} value={item.description} onChange={event => changeItem(index, "description", event.target.value)} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label htmlFor={`private-item-price-${index}`}>Price ($)</Label><Input id={`private-item-price-${index}`} inputMode="decimal" maxLength={16} value={item.price} onChange={event => changeItem(index, "price", event.target.value)} /></div>
                <div><Label htmlFor={`private-item-category-${index}`}>Category (private preview)</Label><Input id={`private-item-category-${index}`} maxLength={80} value={item.category} onChange={event => changeItem(index, "category", event.target.value)} /></div>
              </div>
              <Button type="button" variant="outline" onClick={() => onChange({ ...draft, items: draft.items.filter((_item, position) => position !== index) })}>Remove item {index + 1}</Button>
            </fieldset>
          ))}
          <Button type="button" variant={journeyStage.id === "add-items" ? "default" : "outline"} disabled={draft.items.length >= GUEST_MENU_MAX_ITEMS} onClick={() => onChange({ ...draft, items: [...draft.items, emptyGuestMenuItem()] })}>Add item</Button>
        </div>
        <MenuDraftPreview draft={draft} />
      </div>
      <div className="space-y-2"><Button type="button" variant={journeyStage.id === "save-and-preview" ? "default" : "outline"} onClick={onKeep}>Keep this menu draft</Button><p className="text-sm text-muted-foreground">Your draft stays on this device. A business owner must review it before creating or importing a menu.</p></div>
    </section>
  );
}

export function MenuDraftPreview({ draft }: { draft: GuestMenuDraft }) {
  return <aside className="h-fit rounded-2xl border bg-card p-6" aria-label="Private menu preview">
    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Private preview</p>
    <h2 className="mt-2 text-2xl font-bold">{draft.name || "Your menu"}</h2>
    <p className="mt-2 text-sm text-muted-foreground">{GUEST_MENU_CATEGORY_NOTICE}</p>
    {draft.items.map((item, index) => <article key={index} className="mt-4 border-t pt-4">
      {item.category && <p className="text-sm text-muted-foreground">{item.category}</p>}
      <div className="flex justify-between gap-4"><h3 className="font-medium">{item.name || `Item ${index + 1}`}</h3><span>{item.price ? `$${item.price}` : "Price"}</span></div>
      {item.description && <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{item.description}</p>}
    </article>)}
  </aside>;
}

// Companion local record naming the account the on-device draft cache was
// last reconciled with. The draft key itself is shared and account-less by
// design (it is the pre-signup guest artifact); this marker is what stops
// one account's cached draft from being adopted by — or uploaded into — a
// different account that signs in later on the same browser.
const DRAFT_SYNC_ACCOUNT_KEY = "mealscout:guest-menu-draft:account";

export function PrivateMenuDraftPage({ user }: { user: { id?: unknown; emailVerified?: unknown } | null | undefined }) {
  const { toast } = useToast();
  const accountId = typeof user?.id === "string" ? user.id : null;
  // Snapshot the on-device draft BEFORE anything can re-stamp it. The
  // persist effect below used to run on mount and stamp Date.now() onto
  // the untouched initial state; the reconcile then read that fresh stamp,
  // concluded the local copy was the newest, and uploaded the initial
  // (empty or stale) draft over the account's saved copy. All freshness
  // comparisons in this page now use this pre-hydration snapshot.
  const bootRef = useRef<{
    localDraft: GuestMenuDraft | null;
    localSavedAt: number | null;
    foreign: boolean;
  } | null>(null);
  if (bootRef.current === null) {
    const localDraft = readGuestMenuDraft(() => window.localStorage);
    const localSavedAt = readGuestMenuDraftSavedAt(() => window.localStorage);
    let recordedAccount: string | null = null;
    try {
      recordedAccount = window.localStorage.getItem(DRAFT_SYNC_ACCOUNT_KEY);
    } catch {
      // Storage unavailable: no isolation marker; behaviour falls back to
      // the snapshot-only protections.
    }
    bootRef.current = {
      localDraft,
      localSavedAt,
      // A local draft last reconciled under a DIFFERENT account is not
      // this account's draft: it is neither adopted as the starting state
      // nor uploaded into this account.
      foreign: Boolean(
        accountId && localDraft && recordedAccount && recordedAccount !== accountId,
      ),
    };
  }
  const [draft, setDraftState] = useState<GuestMenuDraft>(() =>
    bootRef.current!.foreign
      ? emptyGuestMenuDraft()
      : bootRef.current!.localDraft || emptyGuestMenuDraft(),
  );
  const [kept, setKept] = useState(false);
  // True only when the draft changed through the editor (a real user
  // edit), as opposed to initial state or a programmatic adoption.
  const dirtyRef = useRef(false);
  const setDraft = (next: GuestMenuDraft) => {
    dirtyRef.current = true;
    setDraftState(next);
  };
  // Signed-in owners also keep this draft on their account, so it survives a
  // new phone or cleared browser data. The local copy stays as the on-device
  // cache; true guests (no account yet) keep the local-only behaviour.
  const canSyncToAccount = Boolean(user);
  const hydratedRef = useRef(!canSyncToAccount);
  const suppressNextSyncRef = useRef(false);

  // On open, reconcile with the account copy: adopt it when it is newer
  // than this device's pre-hydration snapshot; otherwise seed/refresh the
  // account with this device's newer copy. Edits the user makes while the
  // read is in flight always win — the read never adopts over them.
  useEffect(() => {
    if (!canSyncToAccount) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/settings/me/menu-draft", { credentials: "include" });
        if (!res.ok) return;
        const payload = await res.json().catch(() => null);
        const serverDraft = (payload?.draft ?? null) as GuestMenuDraft | null;
        const serverSavedAt = typeof payload?.savedAt === "number" ? payload.savedAt : null;
        if (cancelled) return;
        const boot = bootRef.current!;
        if (dirtyRef.current) {
          // The user typed while the account read was in flight. Their
          // edits are the live copy: do not adopt the account copy over
          // them, and do not upload the pre-edit snapshot either. The
          // persist effect syncs the edited draft once hydration settles.
        } else if (
          serverDraft &&
          serverSavedAt &&
          (boot.foreign || boot.localSavedAt === null || serverSavedAt > boot.localSavedAt)
        ) {
          suppressNextSyncRef.current = true;
          persistGuestMenuDraft(() => window.localStorage, serverDraft, serverSavedAt);
          setDraftState(serverDraft);
        } else if (!boot.foreign && boot.localDraft && boot.localSavedAt) {
          await fetch("/api/settings/me/menu-draft", {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ draft: boot.localDraft, savedAt: boot.localSavedAt }),
          }).catch(() => { /* the local copy remains the fallback */ });
        }
      } catch {
        // Offline or signed out mid-flight: the local copy remains the fallback.
      } finally {
        if (!cancelled) {
          hydratedRef.current = true;
          if (accountId) {
            try {
              window.localStorage.setItem(DRAFT_SYNC_ACCOUNT_KEY, accountId);
            } catch {
              // Marker is best-effort; the snapshot protections still hold.
            }
          }
        }
      }
    })();
    return () => { cancelled = true; };
  }, [canSyncToAccount]);

  useEffect(() => {
    // Gate automatic writes until hydration settles: never stamp a fresh
    // timestamp onto state the user has not touched. (A mount-time write
    // of the initial draft is what made it look newer than the account
    // copy.) Real user edits are never gated — they persist immediately,
    // locally and, once hydration has settled, to the account.
    if (canSyncToAccount && !hydratedRef.current && !dirtyRef.current) return;
    const savedAt = Date.now();
    persistGuestMenuDraft(() => window.localStorage, draft, savedAt);
    if (!canSyncToAccount || !hydratedRef.current) return;
    if (suppressNextSyncRef.current) {
      suppressNextSyncRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      void fetch("/api/settings/me/menu-draft", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft, savedAt }),
      }).catch(() => { /* the local copy remains the fallback */ });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [draft, canSyncToAccount]);
  const keep = () => {
    if (!persistGuestMenuDraft(() => window.localStorage, draft)) {
      toast({ title: "Draft stays here", description: "This browser could not save your draft. Keep this page open and enable browser storage before continuing.", variant: "destructive" });
      return;
    }
    const gate = getProgressiveAccountGate(user);
    if (gate !== "continue") {
      const params = new URLSearchParams(window.location.search);
      params.delete("design");
      params.set("reviewDraft", "1");
      window.location.href = buildProgressiveAccountPath(gate, "keep_draft", `/menu-builder?${params}${window.location.hash}`);
      return;
    }
    setKept(true);
  };
  return <main className="min-h-screen bg-background">
    <PrivateMenuDraftEditor draft={draft} onChange={value => { setDraft(value); setKept(false); }} onKeep={keep} kept={kept} />
    {getProgressiveAccountGate(user) === "continue" && <div className="mx-auto max-w-5xl px-4 pb-8">
      {kept && <p role="status" className="mb-3">Your menu draft is saved on this device.</p>}
      <p className="text-sm text-muted-foreground">Choose or set up a business to review this draft in its menu workspace.</p>
      <div className="mt-3 flex flex-wrap gap-3"><Button asChild variant="outline"><Link href="/restaurant/dashboard">Choose a business</Link></Button><Button asChild variant="outline"><Link href={preserveProgressiveAuthContext("/restaurant-signup?businessType=restaurant&intent=create&source=guest-menu", new URLSearchParams({ redirect: "/menu-builder?reviewDraft=1", reason: "keep_draft" }))}>Set up a business</Link></Button></div>
    </div>}
  </main>;
}
