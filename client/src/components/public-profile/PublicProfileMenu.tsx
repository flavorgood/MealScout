import { menuProfileReturnPath } from "@/lib/public-menu-recovery";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Heart, MenuSquare } from "lucide-react";
import type {
  PublicCta,
  PublicMenuItem,
  PublicRestaurantProfile,
} from "@shared/publicProfiles";
import { apiUrl } from "@/lib/api";
import { getDishCategoryPhoto } from "@/lib/dishCategoryPhoto";
import { assessPublicMenuCompleteness } from "@/lib/publicMenuCompleteness";
import {
  buildPublicMenuPreview,
  organizePublicMenuSections,
  partitionPublicMenuSections,
} from "@/lib/publicProfileMenu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type PublicProfileMenuProps = {
  profile: PublicRestaurantProfile;
  safeCtas: PublicCta[];
};

const GENERIC_SECTION_NAME = /^(menu|menu items|items)$/i;

const externalTarget = (href: string) =>
  /^https?:\/\//i.test(href) ? "_blank" : undefined;

function PublicProfileMenuItem({
  item,
  submitState,
  isRecommending,
  isSubmitting,
  recommendComment,
  recommendPhoto,
  onToggleRecommend,
  onCommentChange,
  onPhotoChange,
  onSubmit,
  onCancel,
}: {
  item: PublicMenuItem;
  submitState: string | null;
  isRecommending: boolean;
  isSubmitting: boolean;
  recommendComment: string;
  recommendPhoto: File | null;
  onToggleRecommend: () => void;
  onCommentChange: (value: string) => void;
  onPhotoChange: (file: File | null) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const categoryPhoto = getDishCategoryPhoto(item.name, item.description);
  const categoryPhotoImage = categoryPhoto?.image || null;
  const [imageMode, setImageMode] = useState<"primary" | "category" | "none">(
    () =>
      item.imageUrl?.trim()
        ? "primary"
        : categoryPhotoImage
          ? "category"
          : "none",
  );
  useEffect(() => {
    setImageMode(
      item.imageUrl?.trim()
        ? "primary"
        : categoryPhotoImage
          ? "category"
          : "none",
    );
  }, [categoryPhotoImage, item.imageUrl]);
  const imageSrc =
    imageMode === "primary"
      ? item.imageUrl
      : imageMode === "category"
        ? categoryPhotoImage
        : null;

  return (
    <article
      className="overflow-hidden rounded-2xl border border-[color:var(--profile-border)] bg-white"
      data-public-menu-item={item.menuItemId || item.name}
    >
      <div className="grid min-h-32 grid-cols-[minmax(0,1fr)_6.5rem] gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_7.5rem]">
        <div className="flex min-w-0 flex-col py-0.5">
          <div className="flex flex-col items-start gap-1">
            <h3 className="min-w-0 break-words text-sm font-black leading-snug text-[color:var(--profile-ink)] sm:text-base">
              {item.name}
            </h3>
            {item.isAvailable === false ? (
              <Badge className="shrink-0 border-0 bg-stone-100 text-stone-700 hover:bg-stone-100">
                Sold out
              </Badge>
            ) : null}
            {item.priceLabel ? (
              <span className="shrink-0 text-sm font-black text-[color:var(--profile-accent)]">
                {item.priceLabel}
              </span>
            ) : null}
          </div>
          {item.description ? (
            <p className="mt-1 line-clamp-3 text-xs leading-5 text-[color:var(--profile-muted)] sm:text-sm">
              {item.description}
            </p>
          ) : null}
          {item.menuItemId ? (
            <button
              type="button"
              onClick={onToggleRecommend}
              className="mt-auto inline-flex min-h-8 w-fit items-center gap-1.5 pt-2 text-xs font-black text-[color:var(--profile-accent)] hover:text-[color:var(--profile-accent-hover)]"
            >
              <Heart className="h-3.5 w-3.5" aria-hidden="true" />
              Recommend
            </button>
          ) : null}
        </div>

        <div className="relative min-h-28 overflow-hidden rounded-xl bg-[color:var(--profile-surface-soft)]">
          {imageSrc ? (
            <>
              <img
                src={imageSrc}
                alt={imageMode === "primary" ? item.name : ""}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
                onError={() =>
                  setImageMode((current) =>
                    current === "primary" && categoryPhotoImage
                      ? "category"
                      : "none",
                  )
                }
              />
              {imageMode === "category" ? (
                <span className="absolute inset-x-1 bottom-1 rounded-full bg-[#2c1c14]/82 px-1.5 py-1 text-center text-[8px] font-black uppercase tracking-wide text-white backdrop-blur-sm">
                  {categoryPhoto?.label || "Dish"} · photo coming soon
                </span>
              ) : null}
            </>
          ) : (
            <div className="flex h-full min-h-28 items-center justify-center bg-[linear-gradient(145deg,#ffe5cf,#fff3e5)] px-2 text-center text-[9px] font-black uppercase tracking-[0.12em] text-[#8a5b3f]">
              Photo coming soon
            </div>
          )}
        </div>
      </div>

      {submitState ? (
        <p className="border-t border-[color:var(--profile-border)] bg-[color:var(--profile-surface-soft)] px-3 py-2 text-xs text-[color:var(--profile-muted)]">
          {submitState}
        </p>
      ) : null}

      {isRecommending && item.menuItemId ? (
        <div className="space-y-3 border-t border-[color:var(--profile-border)] bg-[color:var(--profile-surface-soft)] p-3">
          <label className="block text-xs font-black text-[color:var(--profile-ink-soft)]">
            Why do you recommend {item.name}?
            <textarea
              value={recommendComment}
              onChange={(event) => onCommentChange(event.target.value)}
              className="mt-1 min-h-20 w-full rounded-xl border border-[color:var(--profile-border-strong)] bg-white px-3 py-2 text-sm font-medium text-[color:var(--profile-ink)] outline-none focus:border-[color:var(--profile-accent)]"
            />
          </label>
          <label className="block text-xs font-black text-[color:var(--profile-ink-soft)]">
            Add a photo (optional)
            <input
              type="file"
              accept="image/*"
              onChange={(event) =>
                onPhotoChange(event.target.files?.[0] || null)
              }
              className="mt-1 block w-full text-xs font-medium text-[color:var(--profile-muted)]"
            />
          </label>
          {recommendPhoto ? (
            <p className="text-xs text-[color:var(--profile-muted)]">
              {recommendPhoto.name}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={onSubmit}
              disabled={isSubmitting}
              className="rounded-full bg-[color:var(--profile-accent)] px-4 font-black text-white hover:bg-[color:var(--profile-accent-hover)]"
            >
              {isSubmitting ? "Submitting..." : "Submit recommendation"}
            </Button>
            <button
              type="button"
              onClick={onCancel}
              className="min-h-9 px-2 text-xs font-black text-[color:var(--profile-muted)] hover:text-[color:var(--profile-ink)]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function PublicProfileMenu({
  profile,
  safeCtas,
}: PublicProfileMenuProps) {
  const [recommendingKey, setRecommendingKey] = useState<string | null>(null);
  const [recommendComment, setRecommendComment] = useState("");
  const [recommendPhoto, setRecommendPhoto] = useState<File | null>(null);
  const [submitStateByItem, setSubmitStateByItem] = useState<
    Record<string, string>
  >({});
  const [submittingItemId, setSubmittingItemId] = useState<string | null>(null);
  const menuVariants = useMemo(
    () =>
      (Array.isArray(profile.menuVariants) ? profile.menuVariants : []).filter(
        (variant) => String(variant?.id || "").trim().length > 0,
      ),
    [profile.menuVariants],
  );
  const [selectedMenuId, setSelectedMenuId] = useState(
    String(profile.activeMenuId || menuVariants[0]?.id || ""),
  );

  useEffect(() => {
    setSelectedMenuId(
      String(profile.activeMenuId || menuVariants[0]?.id || ""),
    );
  }, [menuVariants, profile.activeMenuId, profile.id]);

  const activeVariant =
    menuVariants.find(
      (variant) => String(variant.id) === String(selectedMenuId),
    ) ||
    menuVariants[0] ||
    null;
  const sourceSections = activeVariant?.menuSections?.length
    ? activeVariant.menuSections
    : profile.menuSections;
  const organizedSections = useMemo(
    () => organizePublicMenuSections(sourceSections),
    [sourceSections],
  );
  const { primarySections, supportingSections } = useMemo(
    () => partitionPublicMenuSections(organizedSections),
    [organizedSections],
  );
  const menuReturn = typeof window === "undefined" ? null : menuProfileReturnPath(window.location.pathname + window.location.search + window.location.hash, profile.id);
  const internalMenuHref =
    profile.id && (profile.activeMenuId || activeVariant?.id)
      ? `/menu/${encodeURIComponent(profile.id)}?menuId=${encodeURIComponent(String(activeVariant?.id || profile.activeMenuId))}${menuReturn ? `&returnTo=${encodeURIComponent(menuReturn)}` : ""}`
      : null;
  const preview = useMemo(
    () =>
      internalMenuHref
        ? buildPublicMenuPreview(primarySections)
        : { sections: primarySections, hiddenItemCount: 0 },
    [internalMenuHref, primarySections],
  );
  const supportingPreview = useMemo(
    () =>
      internalMenuHref
        ? buildPublicMenuPreview(supportingSections, {
            maxItems: 6,
            maxPerSection: 2,
          })
        : { sections: supportingSections, hiddenItemCount: 0 },
    [internalMenuHref, supportingSections],
  );
  const hiddenItemCount =
    preview.hiddenItemCount + supportingPreview.hiddenItemCount;
  const featuredItems = Array.isArray(profile.featuredMenuItems)
    ? profile.featuredMenuItems.filter((item) => String(item || "").trim())
    : [];
  const displayedNames = new Set(
    organizedSections.flatMap((section) =>
      section.items.map((item) => item.name.trim().toLowerCase()),
    ),
  );
  const extraFeaturedItems = featuredItems.filter(
    (item) => !displayedNames.has(item.trim().toLowerCase()),
  );
  const menuCta = safeCtas.find(
    (cta) =>
      cta.type === "menu" ||
      /menu/i.test(String(cta.label || "")) ||
      /\/menu\//i.test(String(cta.href || "")),
  );
  const fallbackMenuHref =
    menuCta?.href ||
    profile.menuPdfUrl ||
    profile.menuImageUrl ||
    activeVariant?.menuUrl ||
    profile.menuUrl ||
    null;
  const menuActionHref = internalMenuHref || fallbackMenuHref;
  const nativeOrderHref = profile.ordering?.path || null;
  const menuCompleteness = assessPublicMenuCompleteness({
    menuSections: organizedSections,
    featuredMenuItems: featuredItems,
    menuUrl: activeVariant?.menuUrl || profile.menuUrl,
    menuImageUrl: profile.menuImageUrl,
    menuPdfUrl: profile.menuPdfUrl,
  });
  const hasMenuSurface =
    organizedSections.length > 0 ||
    featuredItems.length > 0 ||
    Boolean(menuActionHref) ||
    profile.profileType === "truck";
  if (!hasMenuSurface) return null;

  const updatedAt =
    activeVariant?.menuLastUpdatedAt || profile.menuLastUpdatedAt || null;
  const updatedDate = updatedAt ? new Date(updatedAt) : null;
  const updatedLabel =
    updatedDate && !Number.isNaN(updatedDate.getTime())
      ? updatedDate.toLocaleDateString()
      : null;
  const menuApproval = profile.menuApproval;
  const showMenuApproval = Boolean(
    profile.profileType === "truck" &&
    menuApproval?.label &&
    menuApproval.status !== "unavailable" &&
    menuCompleteness.state !== "unavailable",
  );
  const showMenuSourceAttribution = Boolean(
    menuApproval?.sourceAttribution?.label &&
    menuCompleteness.state !== "unavailable",
  );
  const hasTrustDetails = Boolean(
    menuCompleteness.state === "partial" ||
    profile.menuContextNote ||
    showMenuApproval ||
    showMenuSourceAttribution ||
    updatedLabel,
  );

  const submitRecommendation = async (menuItemId: string) => {
    if (!menuItemId) return;
    setSubmittingItemId(menuItemId);
    try {
      const formData = new FormData();
      formData.append("comment", recommendComment);
      if (recommendPhoto) formData.append("image", recommendPhoto);
      const response = await fetch(
        apiUrl(`/api/menu-items/${encodeURIComponent(menuItemId)}/recommend`),
        {
          method: "POST",
          credentials: "include",
          body: formData,
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSubmitStateByItem((current) => ({
          ...current,
          [menuItemId]:
            String(data?.message || "").trim() ||
            "Unable to submit recommendation right now.",
        }));
        return;
      }
      setSubmitStateByItem((current) => ({
        ...current,
        [menuItemId]:
          data?.photoStatus?.status === "pending"
            ? "Recommendation submitted. Photo is pending business review."
            : "Recommendation submitted.",
      }));
      setRecommendComment("");
      setRecommendPhoto(null);
      setRecommendingKey(null);
    } catch {
      setSubmitStateByItem((current) => ({
        ...current,
        [menuItemId]: "Unable to submit recommendation right now.",
      }));
    } finally {
      setSubmittingItemId(null);
    }
  };

  return (
    <section
      id="menu"
      aria-labelledby="public-profile-menu-title"
      className="min-w-0 scroll-mt-24 space-y-3"
      data-public-profile-menu="organized"
    >
      <div className="flex items-center justify-between gap-3">
        <p id="public-profile-menu-title" className="profile-section-label">
          Menu
        </p>
        {menuActionHref ? (
          internalMenuHref ? (
            <Link
              href={internalMenuHref}
              data-analytics-action="menu_click"
              data-analytics-target-type="menu"
              className="profile-action-secondary inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-black"
            >
              View full menu <MenuSquare className="h-3.5 w-3.5" />
            </Link>
          ) : (
            <a
              href={menuActionHref}
              target={externalTarget(menuActionHref)}
              rel={
                externalTarget(menuActionHref)
                  ? "noopener noreferrer"
                  : undefined
              }
              data-analytics-action="menu_click"
              data-analytics-target-type="menu"
              className="profile-action-secondary inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-black"
            >
              {menuCta?.label || "View menu"}{" "}
              <MenuSquare className="h-3.5 w-3.5" />
            </a>
          )
        ) : null}
      </div>

      {profile.claimedProfile ? (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[color:var(--profile-border)] bg-[color:var(--profile-surface-soft)] px-4 py-3 text-xs font-bold text-[color:var(--profile-ink-soft)]">
          <Badge variant={profile.fulfillment?.pickup.enabled ? "default" : "outline"}>
            {profile.fulfillment?.pickup.enabled
              ? "Pickup available"
              : "Pickup unavailable"}
          </Badge>
          <Badge variant={profile.fulfillment?.delivery.enabled ? "default" : "outline"}>
            {profile.fulfillment?.delivery.enabled
              ? "Merchant delivery available"
              : "Merchant delivery unavailable"}
          </Badge>
          {nativeOrderHref && profile.ordering?.enabled ? (
            <Link
              href={nativeOrderHref}
              data-analytics-action="order_click"
              data-analytics-target-type="claimed_profile_ordering"
              className="ml-auto inline-flex min-h-9 items-center rounded-full bg-[color:var(--profile-accent)] px-4 font-black text-white"
            >
              Start order
            </Link>
          ) : (
            <span className="w-full text-[color:var(--profile-muted)]">
              {profile.ordering?.unavailableReason ||
                "Online ordering is not available right now."}
            </span>
          )}
        </div>
      ) : null}

      <div className="profile-surface overflow-hidden rounded-[1.75rem]">
        {menuVariants.length > 1 ? (
          <div className="border-b border-[color:var(--profile-border)] bg-[color:var(--profile-surface-soft)] px-4 py-3">
            <p className="mb-2 text-[10px] font-black uppercase tracking-[0.16em] text-[color:var(--profile-muted)]">
              Choose a menu
            </p>
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
              {menuVariants.map((variant) => {
                const active = String(variant.id) === String(activeVariant?.id);
                return (
                  <button
                    key={variant.id}
                    type="button"
                    onClick={() => setSelectedMenuId(String(variant.id))}
                    className={`min-h-9 shrink-0 rounded-full border px-3 text-xs font-black transition-colors ${
                      active
                        ? "border-[color:var(--profile-accent)] bg-[color:var(--profile-accent)] text-white"
                        : "border-[color:var(--profile-border)] bg-white text-[color:var(--profile-ink-soft)] hover:border-[color:var(--profile-accent)]"
                    }`}
                  >
                    {variant.name}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="space-y-6 p-4 sm:p-5" data-public-menu-items="true">
          {preview.sections.map((section) => {
            const showHeading =
              preview.sections.length > 1 ||
              !GENERIC_SECTION_NAME.test(section.name);
            return (
              <div key={section.name} className="space-y-3">
                {showHeading ? (
                  <h2 className="text-base font-black tracking-tight text-[color:var(--profile-ink)]">
                    {section.name}
                  </h2>
                ) : null}
                <div className="grid gap-3 xl:grid-cols-2">
                  {section.items.map((item) => {
                    const itemKey =
                      item.menuItemId ||
                      `${section.name}:${item.name}:${item.priceLabel || ""}`;
                    return (
                      <PublicProfileMenuItem
                        key={itemKey}
                        item={item}
                        submitState={
                          item.menuItemId
                            ? submitStateByItem[item.menuItemId] || null
                            : null
                        }
                        isRecommending={recommendingKey === item.menuItemId}
                        isSubmitting={submittingItemId === item.menuItemId}
                        recommendComment={recommendComment}
                        recommendPhoto={recommendPhoto}
                        onToggleRecommend={() => {
                          setRecommendComment("");
                          setRecommendPhoto(null);
                          setRecommendingKey((current) =>
                            current === item.menuItemId
                              ? null
                              : item.menuItemId || null,
                          );
                        }}
                        onCommentChange={setRecommendComment}
                        onPhotoChange={setRecommendPhoto}
                        onSubmit={() =>
                          submitRecommendation(String(item.menuItemId || ""))
                        }
                        onCancel={() => setRecommendingKey(null)}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}

          {supportingPreview.sections.length > 0 ? (
            <div
              id="menu-extras"
              className="scroll-mt-24 space-y-3 rounded-2xl bg-[color:var(--profile-surface-soft)] p-3 sm:p-4"
              data-public-menu-supporting="true"
            >
              <h2 className="text-sm font-black tracking-tight text-[color:var(--profile-ink)]">
                Sides, drinks & extras
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {supportingPreview.sections.map((section) => (
                  <section
                    key={section.name}
                    className="overflow-hidden rounded-xl border border-[color:var(--profile-border)] bg-white"
                  >
                    <h3 className="border-b border-[color:var(--profile-border)] px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-[color:var(--profile-muted)]">
                      {section.name}
                    </h3>
                    <div className="divide-y divide-[color:var(--profile-border)]">
                      {section.items.map((item) => (
                        <div
                          key={
                            item.menuItemId ||
                            `${section.name}:${item.name}:${item.priceLabel || ""}`
                          }
                          className="flex items-start justify-between gap-3 px-3 py-2.5"
                        >
                          <span className="text-sm font-bold leading-snug text-[color:var(--profile-ink)]">
                            {item.name}
                          </span>
                          {item.priceLabel ? (
                            <span className="shrink-0 text-sm font-black text-[color:var(--profile-accent)]">
                              {item.priceLabel}
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          ) : null}

          {extraFeaturedItems.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm font-black text-[color:var(--profile-ink)]">
                Also featured
              </p>
              <div className="flex flex-wrap gap-2">
                {extraFeaturedItems.map((item) => (
                  <span
                    key={item}
                    className="rounded-full border border-[color:var(--profile-border)] bg-[color:var(--profile-surface-soft)] px-3 py-1.5 text-xs font-bold text-[color:var(--profile-ink-soft)]"
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {menuCompleteness.state === "unavailable" ? (
            <div className="rounded-2xl bg-[color:var(--profile-surface-soft)] px-4 py-5 text-center">
              <p className="text-sm font-bold text-[color:var(--profile-muted)]">
                {profile.profileType === "truck"
                  ? "No menu posted yet."
                  : "Menu unavailable right now."}
              </p>
            </div>
          ) : null}

          {hiddenItemCount > 0 && internalMenuHref ? (
            <p className="text-center text-xs font-bold text-[color:var(--profile-muted)]">
              {hiddenItemCount} more {hiddenItemCount === 1 ? "item" : "items"}{" "}
              on the full menu
            </p>
          ) : null}
        </div>

        {hasTrustDetails ? (
          <div
            className="space-y-1.5 border-t border-[color:var(--profile-border)] bg-[color:var(--profile-surface-soft)] px-4 py-3 text-xs text-[color:var(--profile-muted)] sm:px-5"
            data-public-menu-trust="true"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-bold">
              {menuCompleteness.state === "partial" ? (
                <span className="text-[color:var(--profile-warning)]">
                  Limited menu
                </span>
              ) : null}
              {updatedLabel ? <span>Updated {updatedLabel}</span> : null}
            </div>
            {profile.menuContextNote ? <p>{profile.menuContextNote}</p> : null}
            {showMenuSourceAttribution &&
            menuApproval?.sourceAttribution?.label ? (
              <p data-public-menu-source="mealscout_sourced">
                {menuApproval.sourceAttribution.label}
              </p>
            ) : null}
            {showMenuApproval && menuApproval?.label ? (
              <p
                className={
                  menuApproval.ownerApproved || menuApproval.adminVerified
                    ? "text-[color:var(--profile-success)]"
                    : menuApproval.status === "rejected"
                      ? "text-[color:var(--profile-muted)]"
                      : "text-[color:var(--profile-warning)]"
                }
              >
                {menuApproval.label}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
