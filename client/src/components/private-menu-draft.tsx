import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { buildProgressiveAccountPath, getProgressiveAccountGate, preserveProgressiveAuthContext } from "@shared/progressiveOnboarding";
import {
  emptyGuestMenuDraft, emptyGuestMenuItem, GUEST_MENU_MAX_ITEMS, GUEST_MENU_CATEGORY_NOTICE,
  persistGuestMenuDraft, readGuestMenuDraft,
  type GuestMenuDraft, type GuestMenuItemDraft,
} from "@shared/guestMenuDraft";

export function PrivateMenuDraftEditor({ draft, onChange, onKeep }: {
  draft: GuestMenuDraft; onChange: (draft: GuestMenuDraft) => void; onKeep: () => void;
}) {
  const changeItem = (index: number, field: keyof GuestMenuItemDraft, value: string) => {
    onChange({ ...draft, items: draft.items.map((item, position) => position === index ? { ...item, [field]: value } : item) });
  };
  return (
    <section className="mx-auto max-w-5xl space-y-6 px-4 py-8" aria-labelledby="private-menu-title">
      <header>
        <p className="text-sm font-medium text-muted-foreground">Private draft</p>
        <h1 id="private-menu-title" className="text-3xl font-bold">Design your menu</h1>
        <p className="mt-2 text-muted-foreground">Build and preview here. Keep your work when you are ready to sign in and verify your email.</p>
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
          <Button type="button" variant="outline" disabled={draft.items.length >= GUEST_MENU_MAX_ITEMS} onClick={() => onChange({ ...draft, items: [...draft.items, emptyGuestMenuItem()] })}>Add item</Button>
        </div>
        <MenuDraftPreview draft={draft} />
      </div>
      <div className="space-y-2"><Button type="button" onClick={onKeep}>Keep this menu draft</Button><p className="text-sm text-muted-foreground">Your draft stays on this device. A business owner must review it before creating or importing a menu.</p></div>
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

export function PrivateMenuDraftPage({ user }: { user: { emailVerified?: unknown } | null | undefined }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState(() => readGuestMenuDraft(() => window.localStorage) || emptyGuestMenuDraft());
  const [kept, setKept] = useState(false);
  useEffect(() => { persistGuestMenuDraft(() => window.localStorage, draft); }, [draft]);
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
    <PrivateMenuDraftEditor draft={draft} onChange={value => { setDraft(value); setKept(false); }} onKeep={keep} />
    {getProgressiveAccountGate(user) === "continue" && <div className="mx-auto max-w-5xl px-4 pb-8">
      {kept && <p role="status" className="mb-3">Your menu draft is saved on this device.</p>}
      <p className="text-sm text-muted-foreground">Choose or set up a business to review this draft in its menu workspace.</p>
      <div className="mt-3 flex flex-wrap gap-3"><Button asChild variant="outline"><Link href="/restaurant/dashboard">Choose a business</Link></Button><Button asChild variant="outline"><Link href={preserveProgressiveAuthContext("/restaurant-signup?businessType=restaurant&intent=create&source=guest-menu", new URLSearchParams({ redirect: "/menu-builder?reviewDraft=1", reason: "keep_draft" }))}>Set up a business</Link></Button></div>
    </div>}
  </main>;
}
