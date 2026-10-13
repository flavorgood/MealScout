import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { HOST_ONBOARDING_COPY as COPY } from "@/copy/hostOnboarding.copy";

export type GuestBusinessDraftField =
  | "name" | "businessType" | "cuisineType" | "description"
  | "address" | "city" | "state" | "websiteUrl";

export type GuestBusinessDraftValues = Partial<Record<GuestBusinessDraftField, string>>;

const inputFields = [
  ["name", "name", 160],
  ["cuisineType", "cuisine", 120],
  ["address", "address", 300],
  ["city", "city", 120],
  ["state", "state", 80],
  ["websiteUrl", "website", 2000],
] as const;

export function GuestBusinessDraft({
  draft,
  onChange,
  onKeep,
  canChangeBusinessType = true,
}: {
  draft: GuestBusinessDraftValues;
  onChange: (field: GuestBusinessDraftField, value: string) => void;
  onKeep: () => void;
  canChangeBusinessType?: boolean;
}) {
  const copy = COPY.guestDraft;
  return (
    <section aria-labelledby="guest-draft-title" data-testid="guest-business-draft">
      <h1 id="guest-draft-title" className="text-3xl font-black">{copy.title}</h1>
      <p className="mt-3 text-sm text-muted-foreground">{copy.description}</p>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="guest-draft-businessType">{copy.businessType}</Label>
            <select
              id="guest-draft-businessType"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={draft.businessType || "restaurant"}
              disabled={!canChangeBusinessType}
              onChange={(event) => onChange("businessType", event.target.value)}
            >
              {Object.entries(copy.businessTypes).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
          {inputFields.map(([field, label, maxLength]) => (
            <div key={field} className="space-y-2">
              <Label htmlFor={`guest-draft-${field}`}>{copy[label]}</Label>
              <Input
                id={`guest-draft-${field}`}
                value={draft[field] || ""}
                maxLength={maxLength}
                onChange={(event) => onChange(field, event.target.value)}
              />
            </div>
          ))}
          <div className="space-y-2">
            <Label htmlFor="guest-draft-description">{copy.about}</Label>
            <Textarea
              id="guest-draft-description"
              value={draft.description || ""}
              maxLength={500}
              onChange={(event) => onChange("description", event.target.value)}
            />
          </div>
        </div>
        <div className="rounded-2xl border bg-card p-6" data-testid="private-draft-preview">
          <p className="text-xs font-bold uppercase tracking-wide">{copy.previewTitle}</p>
          <h2 className="mt-4 text-2xl font-black">{draft.name || copy.namePlaceholder}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{draft.cuisineType}</p>
          <p className="mt-4 whitespace-pre-wrap text-sm">{draft.description || copy.aboutPlaceholder}</p>
          <p className="mt-4 text-sm">{[draft.address, draft.city, draft.state].filter(Boolean).join(", ")}</p>
          <p className="mt-2 break-all text-sm">{draft.websiteUrl}</p>
          <p className="mt-6 text-xs text-muted-foreground">{copy.privacy}</p>
        </div>
      </div>
      <div className="mt-6 space-y-2">
        <Button type="button" onClick={onKeep} data-testid="button-keep-guest-draft">{copy.keep}</Button>
        <p className="text-xs text-muted-foreground">{copy.accountExplanation}</p>
      </div>
    </section>
  );
}
