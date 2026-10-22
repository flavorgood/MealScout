import type { ChangeEvent, ReactNode } from "react";
import { Link } from "wouter";
import {
  CheckCircle2,
  Eye,
  Image as ImageIcon,
  Loader2,
  MapPin,
  Phone,
  Save,
  Sparkles,
  Store,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface OwnerProfileDraft {
  isActive?: boolean;
  name: string;
  description: string;
  cuisineType: string;
  businessType: string;
  address: string;
  city: string;
  state: string;
  phone: string;
  websiteUrl: string;
  facebookPageUrl: string;
  instagramUrl: string;
  xUrl: string;
  menuUrl: string;
  onlineOrderingUrl: string;
  deliveryUrl: string;
  doordashUrl: string;
  uberEatsUrl: string;
  toastUrl: string;
  squareUrl: string;
  chowNowUrl: string;
  grubhubUrl: string;
  cateringInquiryUrl: string;
  truckBookingInquiryUrl: string;
  logoUrl: string;
  coverImageUrl: string;
}

export interface OwnerProfileMediaItem {
  id: string;
  url: string;
  source?: string | null;
  category?: string | null;
  publicApproved?: boolean;
  uploadedAt?: string | null;
  lastVerifiedAt?: string | null;
}

type MediaKind = "logo" | "cover" | "gallery";

type OwnerProfileWorkspaceProps = {
  mode: "profile" | "media";
  draft: OwnerProfileDraft;
  onDraftChange: (draft: OwnerProfileDraft) => void;
  onSave: () => void;
  isSaving: boolean;
  gallery: OwnerProfileMediaItem[];
  mediaCategory: string;
  onMediaCategoryChange: (category: string) => void;
  onUpload: (file: File, kind: MediaKind, category?: string) => void;
  isUploading: boolean;
  uploadingKind?: MediaKind;
  canModerate: boolean;
  onApprovalChange: (mediaId: string, approved: boolean) => void;
  isUpdatingApproval: boolean;
  publicProfileHref?: string | null;
  photosHref: string;
  ownerAiHref?: string | null;
  isFoodTruck: boolean;
};

const GALLERY_CATEGORIES = [
  ["food", "Food"],
  ["menu", "Menu"],
  ["storefront", "Storefront"],
  ["truck", "Truck"],
  ["atmosphere", "Atmosphere"],
  ["owner_staff", "Owner or staff"],
  ["other", "Other"],
] as const;

function FieldLabel({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-bold text-[color:var(--text-primary)]">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="block text-xs leading-5 text-[color:var(--text-muted)]">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

function UploadControl({
  label,
  kind,
  disabled,
  onUpload,
}: {
  label: string;
  kind: MediaKind;
  disabled: boolean;
  onUpload: (file: File, kind: MediaKind) => void;
}) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onUpload(file, kind);
    event.currentTarget.value = "";
  };

  return (
    <label
      className={`inline-flex min-h-11 w-full cursor-pointer items-center justify-center rounded-xl border border-[color:var(--border-subtle)] bg-white px-4 text-sm font-bold text-[color:var(--text-primary)] transition-colors hover:bg-orange-50 sm:w-auto ${
        disabled ? "pointer-events-none opacity-60" : ""
      }`}
    >
      {disabled ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <Upload className="mr-2 h-4 w-4" aria-hidden="true" />
      )}
      {label}
      <input
        type="file"
        accept="image/*"
        className="sr-only"
        disabled={disabled}
        onChange={handleChange}
      />
    </label>
  );
}

export default function OwnerProfileWorkspace({
  mode,
  draft,
  onDraftChange,
  onSave,
  isSaving,
  gallery,
  mediaCategory,
  onMediaCategoryChange,
  onUpload,
  isUploading,
  uploadingKind,
  canModerate,
  onApprovalChange,
  isUpdatingApproval,
  publicProfileHref,
  photosHref,
  ownerAiHref,
  isFoodTruck,
}: OwnerProfileWorkspaceProps) {
  const update = <K extends keyof OwnerProfileDraft>(
    key: K,
    value: OwnerProfileDraft[K],
  ) => onDraftChange({ ...draft, [key]: value });

  const location = [draft.city, draft.state].filter(Boolean).join(", ");
  // Keep the same selected business as the existing manual photos continuation.
  const scheduleUrl = new URL(photosHref, "https://www.mealscout.us");
  const selectedBusinessId = scheduleUrl.searchParams.get("restaurantId");
  const scheduleHref = selectedBusinessId
    ? `/parking-pass?setup=schedule&truckId=${encodeURIComponent(selectedBusinessId)}`
    : "/restaurant-owner-dashboard?setup=schedule";
  const customerPhotos = gallery.filter((media) => {
    const category = String(media.category || "").toLowerCase();
    const source = String(media.source || "").toLowerCase();
    return (
      category !== "logo" &&
      category !== "cover" &&
      source !== "logo" &&
      source !== "cover_image"
    );
  });
  const ownerAiEntry = ownerAiHref ? (
    <section
      className="flex flex-col gap-4 rounded-2xl border border-orange-200 bg-orange-50 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
      data-testid="owner-profile-ai-entry"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-orange-600 text-white">
          <Sparkles className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <p className="font-black text-orange-950">
            Update this profile with any AI
          </p>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-orange-900/80">
            Your current free or paid AI can prepare these details, logos and
            photos, menus and prices, hours or schedules, events, deals, and
            matching social previews together. Link that AI through your
            MealScout account and connect your socials; nothing changes or
            publishes until you approve the exact revision in the AI chat or
            on MealScout.
          </p>
        </div>
      </div>
      <Button asChild className="min-h-11 shrink-0">
        <Link href={ownerAiHref}>Open AI Control</Link>
      </Button>
    </section>
  ) : null;

  if (mode === "media") {
    return (
      <div data-testid="owner-photos-workspace" className="space-y-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-700">
              Public profile
            </p>
            <h1 className="mt-1 text-2xl font-black tracking-tight text-[color:var(--text-primary)] sm:text-3xl">
              Photos
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[color:var(--text-muted)]">
              Choose clear images that help customers recognize your business
              and decide what to order. Uploads save immediately.
            </p>
          </div>
          {publicProfileHref ? (
            <Button
              asChild
              variant="outline"
              className="min-h-11 w-full sm:w-auto"
            >
              <a href={publicProfileHref} target="_blank" rel="noreferrer">
                <Eye className="mr-2 h-4 w-4" aria-hidden="true" />
                Preview profile
              </a>
            </Button>
          ) : null}
        </header>

        {ownerAiEntry}

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(15rem,0.75fr)]">
          <div className="overflow-hidden rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)]">
            <div className="relative aspect-[4/3] bg-gradient-to-br from-orange-100 via-amber-50 to-rose-100 sm:aspect-[16/7]">
              {draft.coverImageUrl ? (
                <img
                  src={draft.coverImageUrl}
                  alt="Current cover"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-orange-700">
                  <ImageIcon className="h-10 w-10" aria-hidden="true" />
                </div>
              )}
              <div className="absolute inset-x-0 bottom-0 flex flex-col items-start gap-3 bg-gradient-to-t from-black/65 to-transparent p-4 text-white sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="font-black">Cover photo</p>
                  <p className="text-xs text-white/80">
                    Shown first on your public profile
                  </p>
                </div>
                <UploadControl
                  label={draft.coverImageUrl ? "Replace" : "Add cover"}
                  kind="cover"
                  disabled={isUploading && uploadingKind === "cover"}
                  onUpload={onUpload}
                />
              </div>
            </div>
          </div>

          <div className="flex flex-col items-center justify-center rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-5 text-center">
            <div className="flex h-28 w-28 items-center justify-center overflow-hidden rounded-3xl bg-orange-100 text-3xl font-black text-orange-800 ring-1 ring-orange-200">
              {draft.logoUrl ? (
                <img
                  src={draft.logoUrl}
                  alt="Current logo"
                  className="h-full w-full object-cover"
                />
              ) : (
                draft.name.trim().charAt(0).toUpperCase() || "M"
              )}
            </div>
            <p className="mt-4 font-black text-[color:var(--text-primary)]">
              Logo
            </p>
            <p className="mt-1 text-xs text-[color:var(--text-muted)]">
              Use a square image that stays readable at small sizes.
            </p>
            <div className="mt-4">
              <UploadControl
                label={draft.logoUrl ? "Replace logo" : "Add logo"}
                kind="logo"
                disabled={isUploading && uploadingKind === "logo"}
                onUpload={onUpload}
              />
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-4 sm:p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-lg font-black text-[color:var(--text-primary)]">
                Food and business photos
              </h2>
              <p className="mt-1 text-sm text-[color:var(--text-muted)]">
                Add food, menu, storefront, truck, and atmosphere photos.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-[11rem_auto]">
              <label className="block">
                <span className="sr-only">Photo category</span>
                <select
                  value={mediaCategory}
                  onChange={(event) =>
                    onMediaCategoryChange(event.target.value)
                  }
                  className="min-h-11 w-full rounded-xl border border-[color:var(--border-subtle)] bg-white px-3 text-sm"
                >
                  {GALLERY_CATEGORIES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label
                className={`inline-flex min-h-11 cursor-pointer items-center justify-center rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground ${
                  isUploading && uploadingKind === "gallery"
                    ? "pointer-events-none opacity-60"
                    : ""
                }`}
              >
                {isUploading && uploadingKind === "gallery" ? (
                  <Loader2
                    className="mr-2 h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Upload className="mr-2 h-4 w-4" aria-hidden="true" />
                )}
                Add photo
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  disabled={isUploading && uploadingKind === "gallery"}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) onUpload(file, "gallery", mediaCategory);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            </div>
          </div>

          {customerPhotos.length ? (
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {customerPhotos
                .slice()
                .reverse()
                .map((media) => (
                  <article
                    key={media.id || media.url}
                    className="overflow-hidden rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)]"
                  >
                    <div className="aspect-square bg-orange-50">
                      <img
                        src={media.url}
                        alt={`${media.category || "Business"} photo`}
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <div className="space-y-2 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-bold capitalize text-[color:var(--text-primary)]">
                          {String(media.category || "photo").replace(/_/g, " ")}
                        </span>
                        <Badge
                          variant="outline"
                          className={
                            media.publicApproved
                              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                              : "border-amber-200 bg-amber-50 text-amber-900"
                          }
                        >
                          {media.publicApproved ? "Visible" : "Pending"}
                        </Badge>
                      </div>
                      {canModerate && media.id ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="w-full"
                          disabled={isUpdatingApproval}
                          onClick={() =>
                            onApprovalChange(
                              media.id,
                              !Boolean(media.publicApproved),
                            )
                          }
                        >
                          {media.publicApproved ? "Set pending" : "Approve"}
                        </Button>
                      ) : null}
                    </div>
                  </article>
                ))}
            </div>
          ) : (
            <div className="mt-5 flex min-h-44 flex-col items-center justify-center rounded-2xl border border-dashed border-orange-200 bg-orange-50/50 px-6 text-center">
              <ImageIcon
                className="h-8 w-8 text-orange-600"
                aria-hidden="true"
              />
              <p className="mt-3 font-black text-orange-950">
                No food or business photos yet
              </p>
              <p className="mt-1 max-w-md text-sm text-orange-900/70">
                Start with one clear photo of what customers are most likely to
                order.
              </p>
            </div>
          )}
        </section>
      </div>
    );
  }

  return (
    <div data-testid="owner-profile-workspace" className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-700">
            Public profile
          </p>
          <h1 className="mt-1 text-2xl font-black tracking-tight text-[color:var(--text-primary)] sm:text-3xl">
            What customers see
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[color:var(--text-muted)]">
            Keep the details people need to recognize your business, understand
            your food, and take the next step.
          </p>
        </div>
        {publicProfileHref ? (
          <Button
            asChild
            variant="outline"
            className="min-h-11 w-full sm:w-auto"
          >
            <a href={publicProfileHref} target="_blank" rel="noreferrer">
              <Eye className="mr-2 h-4 w-4" aria-hidden="true" />
              Preview profile
            </a>
          </Button>
        ) : null}
      </header>

      {ownerAiEntry}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <section className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-4 sm:p-5">
            <label className="mb-5 flex items-start gap-3 rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface-muted)] p-3">
              <input
                type="checkbox"
                checked={draft.isActive !== false}
                onChange={(event) => update("isActive", event.target.checked)}
                className="mt-1 h-4 w-4"
              />
              <span>
                <span className="block text-sm font-black text-[color:var(--text-primary)]">
                  Public profile visible
                </span>
                <span className="block text-xs leading-5 text-[color:var(--text-muted)]">
                  Turn this off to hide the claimed profile and pause its public website.
                </span>
              </span>
            </label>
            <div className="mb-4 flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-orange-100 text-orange-700">
                <Store className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <h2 className="font-black text-[color:var(--text-primary)]">
                  Business identity
                </h2>
                <p className="mt-1 text-sm text-[color:var(--text-muted)]">
                  Use the name and description customers know you by.
                </p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldLabel label="Business name">
                <Input
                  value={draft.name}
                  onChange={(event) => update("name", event.target.value)}
                  required
                />
              </FieldLabel>
              <FieldLabel
                label="Cuisine or food type"
                hint="Examples: Pizza, Southern, Coffee, Filipino"
              >
                <Input
                  value={draft.cuisineType}
                  onChange={(event) =>
                    update("cuisineType", event.target.value)
                  }
                />
              </FieldLabel>
              <FieldLabel
                label="Service type"
                hint="Business type changes require a reviewed identity update so schedules, permissions, and location privacy stay aligned."
              >
                <div
                  data-testid="select-business-type"
                  className="flex min-h-11 w-full items-center rounded-xl border border-input bg-[var(--bg-surface-muted)] px-3 py-2 text-sm font-semibold capitalize text-[color:var(--text-primary)]"
                >
                  {draft.businessType.replace(/_/g, " ") || "Food business"}
                </div>
              </FieldLabel>
              <FieldLabel label="Public phone">
                <Input
                  type="tel"
                  value={draft.phone}
                  onChange={(event) => update("phone", event.target.value)}
                />
              </FieldLabel>
              <div className="sm:col-span-2">
                <FieldLabel
                  label="About your business"
                  hint="Lead with the food, experience, or specialty that helps someone choose you."
                >
                  <textarea
                    value={draft.description}
                    onChange={(event) =>
                      update("description", event.target.value)
                    }
                    rows={5}
                    className="min-h-32 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </FieldLabel>
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-4 sm:p-5">
            <div className="mb-4 flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
                <MapPin className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <h2 className="font-black text-[color:var(--text-primary)]">
                  {isFoodTruck ? "Home base and service area" : "Location"}
                </h2>
                <p className="mt-1 text-sm text-[color:var(--text-muted)]">
                  {isFoodTruck
                    ? "Your live and scheduled locations are managed under Schedule."
                    : "This is the address customers use for directions."}
                </p>
              </div>
            </div>
            {isFoodTruck ? (
              <Link href={scheduleHref} className="mb-4 inline-flex min-h-11 items-center rounded-xl border border-orange-200 bg-orange-50 px-4 text-sm font-bold text-orange-900">
                Add a dated stop manually
              </Link>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <FieldLabel
                  label={
                    isFoodTruck
                      ? "Home-base address or service area"
                      : "Street address"
                  }
                >
                  <Input
                    value={draft.address}
                    onChange={(event) => update("address", event.target.value)}
                  />
                </FieldLabel>
              </div>
              <FieldLabel label="City">
                <Input
                  value={draft.city}
                  onChange={(event) => update("city", event.target.value)}
                />
              </FieldLabel>
              <FieldLabel label="State">
                <Input
                  value={draft.state}
                  onChange={(event) => update("state", event.target.value)}
                />
              </FieldLabel>
            </div>
          </section>

          <details className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-4 sm:p-5">
            <summary className="cursor-pointer font-black text-[color:var(--text-primary)]">
              Website, ordering, and inquiry links
            </summary>
            <p className="mt-2 text-sm text-[color:var(--text-muted)]">
              Only add links that are current and ready for customers.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {(
                [
                  ["websiteUrl", "Website"],
                  ["menuUrl", "External menu"],
                  ["onlineOrderingUrl", "Online ordering"],
                  ["deliveryUrl", "Delivery"],
                  ["doordashUrl", "DoorDash"],
                  ["uberEatsUrl", "Uber Eats"],
                  ["toastUrl", "Toast"],
                  ["squareUrl", "Square"],
                  ["chowNowUrl", "ChowNow"],
                  ["grubhubUrl", "Grubhub"],
                  ["cateringInquiryUrl", "Catering inquiries"],
                  ["truckBookingInquiryUrl", "Truck booking inquiries"],
                ] as Array<[keyof OwnerProfileDraft, string]>
              ).map(([key, label]) => (
                <FieldLabel key={key} label={label}>
                  <Input
                    type="url"
                    value={String(draft[key] ?? "")}
                    onChange={(event) => update(key, event.target.value)}
                    placeholder="https://"
                  />
                </FieldLabel>
              ))}
            </div>
          </details>

          <details className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] p-4 sm:p-5">
            <summary className="cursor-pointer font-black text-[color:var(--text-primary)]">
              Social links
            </summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <FieldLabel label="Facebook">
                <Input
                  type="url"
                  value={draft.facebookPageUrl}
                  onChange={(event) =>
                    update("facebookPageUrl", event.target.value)
                  }
                  placeholder="https://"
                />
              </FieldLabel>
              <FieldLabel label="Instagram">
                <Input
                  type="url"
                  value={draft.instagramUrl}
                  onChange={(event) =>
                    update("instagramUrl", event.target.value)
                  }
                  placeholder="https://"
                />
              </FieldLabel>
              <FieldLabel label="X">
                <Input
                  type="url"
                  value={draft.xUrl}
                  onChange={(event) => update("xUrl", event.target.value)}
                  placeholder="https://"
                />
              </FieldLabel>
            </div>
          </details>

          <div className="sticky bottom-[calc(4.25rem+env(safe-area-inset-bottom,0px))] z-20 flex flex-col gap-2 rounded-2xl border border-orange-200 bg-white/95 p-3 shadow-lg backdrop-blur sm:flex-row sm:items-center lg:bottom-4">
            <Button
              type="submit"
              disabled={isSaving}
              className="min-h-11 w-full sm:w-auto"
              data-testid="button-save-profile"
            >
              {isSaving ? (
                <Loader2
                  className="mr-2 h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Save className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              Save profile
            </Button>
            <Button
              asChild
              type="button"
              variant="outline"
              className="min-h-11 w-full sm:w-auto"
            >
              <Link href={photosHref}>Manage photos</Link>
            </Button>
            <p className="text-xs text-[color:var(--text-muted)] sm:ml-auto">
              Photos save separately as soon as they upload.
            </p>
          </div>
        </form>

        <aside
          className="overflow-hidden rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] lg:sticky lg:top-6"
          data-testid="owner-profile-preview"
        >
          <div className="relative h-40 bg-gradient-to-br from-orange-100 via-amber-50 to-rose-100">
            {draft.coverImageUrl ? (
              <img
                src={draft.coverImageUrl}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : null}
            <Badge className="absolute right-3 top-3 bg-white/90 text-slate-900">
              Preview
            </Badge>
          </div>
          <div className="relative px-5 pb-5 pt-12">
            <div className="absolute -top-10 left-5 flex h-20 w-20 items-center justify-center overflow-hidden rounded-3xl border-4 border-white bg-orange-100 text-2xl font-black text-orange-800 shadow-sm">
              {draft.logoUrl ? (
                <img
                  src={draft.logoUrl}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                draft.name.trim().charAt(0).toUpperCase() || "M"
              )}
            </div>
            <h2 className="text-xl font-black text-[color:var(--text-primary)]">
              {draft.name || "Your business name"}
            </h2>
            <p className="mt-1 text-sm font-bold text-orange-700">
              {draft.cuisineType || draft.businessType || "Food business"}
            </p>
            <p className="mt-3 text-sm leading-6 text-[color:var(--text-secondary)]">
              {draft.description ||
                "Add a short description that helps customers understand what makes your food and business worth a visit."}
            </p>
            <div className="mt-4 space-y-2 border-t border-[color:var(--border-subtle)] pt-4 text-sm text-[color:var(--text-secondary)]">
              <p className="flex items-center gap-2">
                <MapPin
                  className="h-4 w-4 shrink-0 text-orange-700"
                  aria-hidden="true"
                />
                {location || "Add a city and state"}
              </p>
              {draft.phone ? (
                <p className="flex items-center gap-2">
                  <Phone
                    className="h-4 w-4 shrink-0 text-orange-700"
                    aria-hidden="true"
                  />
                  {draft.phone}
                </p>
              ) : null}
              <p className="flex items-center gap-2 text-xs text-emerald-800">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                This preview includes unsaved edits
              </p>
            </div>
            <Button
              asChild
              variant="ghost"
              className="mt-3 w-full text-orange-800"
            >
              <Link href={photosHref}>Add or change photos</Link>
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );
}
