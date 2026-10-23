import type { PublicRestaurantProfile } from "@shared/publicProfiles";
import { operatingHoursSchema } from "@shared/schema";
import {
  DEFAULT_TRUCK_BROADCAST_FRESHNESS_MS,
  deriveTruckPresence,
} from "@shared/consumerEntity";
import {
  getBusinessCapabilities,
  isBarBusinessType,
  isTruckBusinessType,
  toCanonicalFoodBusinessType,
} from "@shared/businessTypes";
import { toPublicProfileSeo } from "./toPublicProfileSeo";
import {
  buildPublicCta,
  buildPublicDirectionsUrl,
  buildPublicProfilePath,
  imageAsset,
  joinedAddressLabel,
  normalizePublicUrl,
  resolvePublicCoordinatePair,
  toSlug,
} from "./publicProfileUtils";
import { shouldExposeStaticTruckProfileLocation } from "../utils/truckLocationSemantics";
import { deriveProfileEvidenceQuarantineVisibility } from "../services/profileEvidenceQuarantine";

const OPERATING_HOUR_DAYS = [
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
  ["sun", "Sun"],
] as const;

export function projectPublicRestaurantMedia(rowValue: unknown) {
  const row =
    rowValue && typeof rowValue === "object"
      ? (rowValue as Record<string, any>)
      : {};
  const { hideMedia, isAccepted } =
    deriveProfileEvidenceQuarantineVisibility(row);
  const coverImageUrl = normalizePublicUrl(row.coverImageUrl, {
    allowInternalPath: true,
  });
  const logoUrl = normalizePublicUrl(row.logoUrl, {
    allowInternalPath: true,
  });
  return {
    coverImageUrl:
      hideMedia && !isAccepted("media_cover") ? null : coverImageUrl,
    logoUrl: hideMedia && !isAccepted("media_logo") ? null : logoUrl,
  };
}

const formatOperatingHourTime = (value: unknown) => {
  const match = String(value || "")
    .trim()
    .match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
};

export function formatOperatingHoursSummary(value: unknown): string | null {
  const parsed = operatingHoursSchema.safeParse(value);
  if (!parsed.success) return null;
  const operatingHours = parsed.data;
  const rows = OPERATING_HOUR_DAYS.map(([key, label]) => {
    const slots = operatingHours[key] || [];
    const slotLabel = slots
      .map((slot) => {
        const open = formatOperatingHourTime(slot?.open);
        const close = formatOperatingHourTime(slot?.close);
        return open && close ? `${open}–${close}` : null;
      })
      .filter(Boolean)
      .join(", ");
    return { label, slotLabel };
  }).filter((row) => row.slotLabel);
  if (rows.length === 0) return null;

  const groups: Array<{ start: string; end: string; slotLabel: string }> = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    const currentDayIndex = OPERATING_HOUR_DAYS.findIndex(
      ([, label]) => label === row.label,
    );
    const lastDayIndex = last
      ? OPERATING_HOUR_DAYS.findIndex(([, label]) => label === last.end)
      : -1;
    if (
      last &&
      last.slotLabel === row.slotLabel &&
      currentDayIndex === lastDayIndex + 1
    ) {
      last.end = row.label;
    } else {
      groups.push({
        start: row.label,
        end: row.label,
        slotLabel: row.slotLabel,
      });
    }
  }

  return groups
    .map(
      (group) =>
        `${group.start}${group.end !== group.start ? `–${group.end}` : ""} ${group.slotLabel}`,
    )
    .join("; ");
}

export function toPublicRestaurantProfile(input: {
  row: any;
  baseUrl: string;
  profileType?: "restaurant" | "truck" | "bar" | "caterer" | "private_chef";
  showAddress?: boolean;
  showContact?: boolean;
}): PublicRestaurantProfile {
  const row = input.row || {};
  const rawData =
    row && typeof row.rawData === "object" && row.rawData
      ? (row.rawData as Record<string, any>)
      : {};
  const {
    hidePublicTrustFields,
    hideMedia,
    isAccepted,
    isRejected,
    isAcceptedWithLegacyFallback,
    isRejectedWithLegacyFallback,
  } = deriveProfileEvidenceQuarantineVisibility(row);
  const publicActionLinks =
    row &&
    typeof row.socialAutopostSettings === "object" &&
    row.socialAutopostSettings &&
    typeof row.socialAutopostSettings.publicActionLinks === "object"
      ? row.socialAutopostSettings.publicActionLinks
      : {};
  const canonicalBusinessType = toCanonicalFoodBusinessType(row.businessType);
  const profileType =
    input.profileType ||
    (row.isFoodTruck || isTruckBusinessType(row.businessType)
      ? "truck"
      : isBarBusinessType(row.businessType)
        ? "bar"
        : canonicalBusinessType === "caterer" ||
            canonicalBusinessType === "private_chef"
          ? canonicalBusinessType
          : "restaurant");
  const capabilities = getBusinessCapabilities(
    canonicalBusinessType || profileType,
  );
  const id = String(row.id || "");
  const claimedProfile = Boolean(row.claimedProfile);
  const orderingPath = normalizePublicUrl(row?.ordering?.path, {
    allowInternalPath: true,
  });
  const nativeOrderingEnabled = Boolean(
    claimedProfile && row?.ordering?.enabled === true && orderingPath,
  );
  const displayName = String(row.name || "MealScout business");
  const slug = toSlug(displayName) || id;
  const canonicalPath = buildPublicProfilePath({
    entityType: profileType,
    name: displayName,
    id,
  });
  const { coverImageUrl, logoUrl } = projectPublicRestaurantMedia(row);
  const isPrivateChef = profileType === "private_chef";
  const addressPublicLabel =
    input.showAddress === false ||
    isPrivateChef ||
    isRejected("contact_address") ||
    (hidePublicTrustFields && !isAccepted("contact_address")) ||
    !shouldExposeStaticTruckProfileLocation(row)
      ? null
      : joinedAddressLabel(row.address, row.city, row.state);
  const exposeProfileCoordinates = Boolean(addressPublicLabel);
  const publicCoordinatePair = exposeProfileCoordinates
    ? resolvePublicCoordinatePair(row.latitude, row.longitude)
    : null;
  const publicLatitude = publicCoordinatePair?.latitude ?? null;
  const publicLongitude = publicCoordinatePair?.longitude ?? null;
  const derivedTruckPresence =
    profileType === "truck"
      ? deriveTruckPresence(
          {
            mobileOnline: row.mobileOnline,
            liveBroadcasting: row.liveBroadcasting,
            currentLatitude: row.currentLatitude,
            currentLongitude: row.currentLongitude,
            lastBroadcastAt: row.lastBroadcastAt,
            liveUntilAt: row.liveUntilAt,
            locationSource: row.liveLocationSource || row.locationSource || "unknown",
            gpsAccuracy: row.gpsAccuracy,
          },
          { freshnessMs: DEFAULT_TRUCK_BROADCAST_FRESHNESS_MS },
        )
      : null;
  const truckPresence = derivedTruckPresence
    ? derivedTruckPresence.broadcastState === "live"
      ? derivedTruckPresence
      : { ...derivedTruckPresence, location: null }
    : null;
  const directionsLatitude =
    truckPresence?.location?.latitude ?? publicLatitude;
  const directionsLongitude =
    truckPresence?.location?.longitude ?? publicLongitude;
  const directionsUrl = buildPublicDirectionsUrl({
    latitude: directionsLatitude,
    longitude: directionsLongitude,
    addressPublicLabel: String(row.address || "").trim()
      ? addressPublicLabel
      : null,
  });
  const phonePublic =
    input.showContact === false ||
    isRejected("contact_phone") ||
    (hidePublicTrustFields && !isAccepted("contact_phone"))
      ? null
      : String(row.phone || "").trim() || null;
  const menuUrl = normalizePublicUrl(row.menuUrl, { allowInternalPath: true });
  const menuImageUrl = normalizePublicUrl(row.menuImageUrl, {
    allowInternalPath: true,
  });
  const menuPdfUrl = normalizePublicUrl(row.menuPdfUrl, {
    allowInternalPath: true,
  });
  const websiteUrl =
    input.showContact === false ||
    isRejected("website_link") ||
    (hidePublicTrustFields && !isAccepted("website_link"))
      ? null
      : normalizePublicUrl(row.websiteUrl);
  const onlineOrderingUrl = normalizePublicUrl(
    (nativeOrderingEnabled ? orderingPath : null) ||
      row.onlineOrderingUrl ||
      publicActionLinks.onlineOrderingUrl ||
      row.orderingUrl ||
      row.orderUrl ||
      row.onlineOrderUrl ||
      "",
    { allowInternalPath: true },
  );
  const deliveryUrl =
    (nativeOrderingEnabled && row?.fulfillment?.delivery?.enabled === true
      ? orderingPath
      : null) ||
    normalizePublicUrl(
      row.deliveryUrl ||
        publicActionLinks.deliveryUrl ||
        row.doordashUrl ||
        publicActionLinks.doordashUrl ||
        row.uberEatsUrl ||
        publicActionLinks.uberEatsUrl ||
        row.toastUrl ||
        publicActionLinks.toastUrl ||
        row.squareUrl ||
        publicActionLinks.squareUrl ||
        row.chowNowUrl ||
        publicActionLinks.chowNowUrl ||
        row.grubhubUrl ||
        publicActionLinks.grubhubUrl ||
        "",
      { allowInternalPath: true },
    );
  const cateringUrl = normalizePublicUrl(
    publicActionLinks.cateringInquiryUrl ||
      row.cateringInquiryUrl ||
      row.cateringUrl ||
      row.cateringRequestUrl ||
      "",
    { allowInternalPath: true },
  );
  const truckBookingUrl = normalizePublicUrl(
    publicActionLinks.truckBookingInquiryUrl ||
      row.truckBookingInquiryUrl ||
      row.truckBookingUrl ||
      row.bookingInquiryUrl ||
      "",
    { allowInternalPath: true },
  );
  const instagramUrl =
    input.showContact === false ||
    isRejectedWithLegacyFallback("social_instagram", "social_links") ||
    (hidePublicTrustFields &&
      !isAcceptedWithLegacyFallback("social_instagram", "social_links"))
      ? null
      : normalizePublicUrl(row.instagramUrl);
  const facebookPageUrl =
    input.showContact === false ||
    isRejectedWithLegacyFallback("social_facebook", "social_links") ||
    (hidePublicTrustFields &&
      !isAcceptedWithLegacyFallback("social_facebook", "social_links"))
      ? null
      : normalizePublicUrl(row.facebookPageUrl);
  const xUrl =
    input.showContact === false ||
    isRejectedWithLegacyFallback("social_x", "social_links") ||
    (hidePublicTrustFields &&
      !isAcceptedWithLegacyFallback("social_x", "social_links"))
      ? null
      : normalizePublicUrl(row.xUrl);
  const hasCanonicalOperatingHours =
    row.operatingHours !== undefined && row.operatingHours !== null;
  const hoursValue = hasCanonicalOperatingHours
    ? formatOperatingHoursSummary(row.operatingHours)
    : String(
        row.hours ||
          row.businessHours ||
          row.hoursSummary ||
          row.openHours ||
          "",
      ).trim() || null;
  const openStatusValue =
    String(
      row.openStatus ||
        row.currentOpenStatus ||
        row.statusLabel ||
        row.businessOpenStatus ||
        "",
    ).trim() || null;
  const nextWindowLabelValue =
    String(
      row.nextWindowLabel ||
        row.nextServiceWindow ||
        row.truckNextWindowLabel ||
        "",
    ).trim() || null;
  const upcomingCountValue = Number(
    row.upcomingCount ??
      row.upcomingScheduleCount ??
      row.truckUpcomingCount ??
      0,
  );
  const featuredMenuItemsRaw = Array.isArray(row.featuredMenuItems)
    ? row.featuredMenuItems
    : Array.isArray(row.menuHighlights)
      ? row.menuHighlights
      : Array.isArray(row.featuredItems)
        ? row.featuredItems
        : [];
  const featuredMenuItems = featuredMenuItemsRaw
    .map((item: unknown) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 12);
  const rawGalleryImages = Array.isArray(row.galleryImages)
    ? row.galleryImages
    : Array.isArray(row?.socialAutopostSettings?.publicGalleryImages)
      ? row.socialAutopostSettings.publicGalleryImages
      : [];
  const mappedGalleryImages =
    hideMedia && !isAccepted("media_gallery")
      ? ([] as any[])
      : (rawGalleryImages
          .map((entry: any) => {
            if (!entry) return null;
            if (typeof entry === "string") {
              return imageAsset(entry, "gallery");
            }
            const url = String(entry?.url || entry?.imageUrl || "").trim();
            if (!url) return null;
            const sourceRaw = String(entry?.source || "gallery")
              .trim()
              .toLowerCase()
              .replace(/[^a-z_]/g, "_");
            const source = (
              [
                "cover_image",
                "logo",
                "gallery",
                "google_photo",
                "spot_image",
                "fallback",
              ] as const
            ).includes(sourceRaw as any)
              ? (sourceRaw as
                  | "cover_image"
                  | "logo"
                  | "gallery"
                  | "google_photo"
                  | "spot_image"
                  | "fallback")
              : "gallery";
            const publicApproved = Boolean(entry?.publicApproved);
            if (!publicApproved) return null;
            const built = imageAsset(url, source);
            if (!built) return null;
            return {
              ...built,
              publicApproved,
              lastVerifiedAt:
                String(entry?.lastVerifiedAt || "").trim() ||
                built.lastVerifiedAt,
            };
          })
          .filter(Boolean) as PublicRestaurantProfile["galleryImages"]);
  const menuSectionsRaw = Array.isArray(row.menuSections)
    ? row.menuSections
    : [];
  const menuSections = menuSectionsRaw
    .map((section: any) => {
      const sectionName = String(section?.name || "").trim();
      const itemsRaw = Array.isArray(section?.items) ? section.items : [];
      const items = itemsRaw
        .map((item: any) => {
          const itemName = String(item?.name || "").trim();
          if (!itemName) return null;
          const hasPrice =
            item?.priceCents !== null && item?.priceCents !== undefined;
          const priceValue = Number(item?.priceCents);
          const priceLabel =
            hasPrice && Number.isFinite(priceValue)
              ? `$${(priceValue / 100).toFixed(2)}`
              : null;
          return {
            menuItemId: String((item as any)?.menuItemId || "").trim() || null,
            name: itemName,
            priceCents:
              hasPrice && Number.isFinite(priceValue) ? priceValue : null,
            priceLabel,
            description: String(item?.description || "").trim() || null,
            imageUrl: normalizePublicUrl(item?.imageUrl, {
              allowInternalPath: true,
            }),
            featured: Boolean(item?.featured),
            isAvailable: item?.isAvailable !== false,
            orderable:
              item?.orderable === true ||
              (item?.isAvailable !== false &&
                hasPrice &&
                Number.isFinite(priceValue)),
            recommendationCount: Math.max(
              0,
              Number(item?.recommendationCount || 0) || 0,
            ),
            userRecommended: Boolean(item?.userRecommended),
          };
        })
        .filter(Boolean)
        .slice(
          0,
          24,
        ) as PublicRestaurantProfile["menuSections"][number]["items"];
      if (!sectionName || items.length === 0) return null;
      return {
        name: sectionName,
        items,
      };
    })
    .filter(Boolean) as PublicRestaurantProfile["menuSections"];
  const menuVariantsRaw = Array.isArray(row.menuVariants)
    ? row.menuVariants
    : [];
  const menuVariants = menuVariantsRaw
    .map((variant: any) => {
      const variantId = String(variant?.id || "").trim();
      if (!variantId) return null;
      const variantSectionsRaw = Array.isArray(variant?.menuSections)
        ? variant.menuSections
        : [];
      const variantSections = variantSectionsRaw
        .map((section: any) => {
          const sectionName = String(section?.name || "").trim();
          const itemsRaw = Array.isArray(section?.items) ? section.items : [];
          const items = itemsRaw
            .map((item: any) => {
              const itemName = String(item?.name || "").trim();
              if (!itemName) return null;
              const priceLabel = String(item?.priceLabel || "").trim() || null;
              return {
                menuItemId:
                  String((item as any)?.menuItemId || "").trim() || null,
                name: itemName,
                priceCents:
                  item?.priceCents != null &&
                  Number.isFinite(Number(item.priceCents))
                    ? Number(item.priceCents)
                    : null,
                priceLabel,
                description: String(item?.description || "").trim() || null,
                imageUrl: normalizePublicUrl(item?.imageUrl, {
                  allowInternalPath: true,
                }),
                featured: Boolean(item?.featured),
                isAvailable: item?.isAvailable !== false,
                orderable: item?.orderable === true,
                recommendationCount: Math.max(
                  0,
                  Number(item?.recommendationCount || 0) || 0,
                ),
                userRecommended: Boolean(item?.userRecommended),
              };
            })
            .filter(Boolean)
            .slice(
              0,
              24,
            ) as PublicRestaurantProfile["menuSections"][number]["items"];
          if (!sectionName || items.length === 0) return null;
          return { name: sectionName, items };
        })
        .filter(Boolean) as PublicRestaurantProfile["menuSections"];
      return {
        id: variantId,
        name: String(variant?.name || "").trim() || "Menu",
        serviceType: String(variant?.serviceType || "").trim() || null,
        menuSections: variantSections,
        menuLastUpdatedAt: variant?.menuLastUpdatedAt
          ? new Date(variant.menuLastUpdatedAt).toISOString()
          : null,
        menuUrl: normalizePublicUrl(variant?.menuUrl, {
          allowInternalPath: true,
        }),
      };
    })
    .filter(Boolean) as PublicRestaurantProfile["menuVariants"];
  const menuLastUpdatedAt = row.menuLastUpdatedAt
    ? new Date(row.menuLastUpdatedAt).toISOString()
    : null;
  const rawMenuApproval =
    rawData &&
    typeof rawData.ownerMenuApproval === "object" &&
    rawData.ownerMenuApproval
      ? (rawData.ownerMenuApproval as Record<string, any>)
      : {};
  const ownerMenuApprovalStatus = String(rawMenuApproval.status || "")
    .trim()
    .toLowerCase();
  const currentMenuRevision = String(row.menuRevision || "").trim();
  const menuRevisionCoversRenderedMenu =
    row.menuRevisionCoversRenderedMenu === true;
  const approvedMenuRevision = String(
    rawMenuApproval.approvedMenuRevision || "",
  ).trim();
  const rejectedMenuRevision = String(
    rawMenuApproval.rejectedMenuRevision || "",
  ).trim();
  const ownerMenuRejected =
    (ownerMenuApprovalStatus === "rejected" ||
      ownerMenuApprovalStatus === "not_current") &&
    (currentMenuRevision
      ? rejectedMenuRevision === currentMenuRevision
      : !rejectedMenuRevision);
  const adminMenuVerified =
    !ownerMenuRejected &&
    menuRevisionCoversRenderedMenu &&
    Boolean(currentMenuRevision) &&
    approvedMenuRevision === currentMenuRevision &&
    ownerMenuApprovalStatus === "admin_verified" &&
    rawMenuApproval.adminApproved === true;
  const ownerMenuApproved =
    !ownerMenuRejected &&
    !adminMenuVerified &&
    menuRevisionCoversRenderedMenu &&
    Boolean(currentMenuRevision) &&
    approvedMenuRevision === currentMenuRevision &&
    (ownerMenuApprovalStatus === "approved" ||
      rawMenuApproval.ownerApproved === true);
  const hasAnyMenuSurface = Boolean(
    menuSections.length > 0 ||
    menuVariants.some((variant) => variant.menuSections.length > 0) ||
    menuUrl ||
    menuImageUrl ||
    menuPdfUrl ||
    featuredMenuItems.length > 0,
  );
  const rawMenuSourceAttribution =
    rawMenuApproval &&
    typeof rawMenuApproval.sourceAttribution === "object" &&
    rawMenuApproval.sourceAttribution
      ? (rawMenuApproval.sourceAttribution as Record<string, any>)
      : {};
  const sourcedItemCount = Number(rawMenuSourceAttribution.sourcedItemCount);
  const sourceRevisionAlgorithm = String(
    rawMenuSourceAttribution.sourceRevisionAlgorithm || "",
  ).trim();
  const approvedMenuRevisionAlgorithm = String(
    rawMenuApproval.approvedMenuRevisionAlgorithm || "",
  ).trim();
  const sourceEvidenceArtifact = String(
    rawMenuSourceAttribution.evidenceArtifact || "",
  ).trim();
  const sourceEvidenceSha256 = String(
    rawMenuSourceAttribution.evidenceSha256 || "",
  )
    .trim()
    .toLowerCase();
  const menuSourceAttribution =
    !ownerMenuRejected &&
    menuRevisionCoversRenderedMenu &&
    hasAnyMenuSurface &&
    Boolean(currentMenuRevision) &&
    String(rawMenuSourceAttribution.sourceType || "")
      .trim()
      .toLowerCase() === "mealscout_sourced" &&
    String(rawMenuSourceAttribution.scope || "")
      .trim()
      .toLowerCase() === "inserted_menu_items" &&
    rawMenuSourceAttribution.ownerAuthored === false &&
    String(rawMenuSourceAttribution.sourceRevision || "").trim() ===
      currentMenuRevision &&
    sourceRevisionAlgorithm === "structured-menu-sha256-v1" &&
    sourceRevisionAlgorithm === approvedMenuRevisionAlgorithm &&
    Boolean(sourceEvidenceArtifact) &&
    /^[a-f0-9]{64}$/.test(sourceEvidenceSha256) &&
    Number.isSafeInteger(sourcedItemCount) &&
    sourcedItemCount > 0
      ? {
          sourceType: "mealscout_sourced" as const,
          scope: "inserted_menu_items" as const,
          label: `${sourcedItemCount} menu ${
            sourcedItemCount === 1 ? "item" : "items"
          } sourced by MealScout`,
          sourcedItemCount,
        }
      : null;
  const menuApproval =
    profileType === "truck" && ownerMenuRejected
      ? {
          status: "rejected" as const,
          label: "Menu unavailable / pending update",
          ownerApproved: false,
          adminVerified: false,
          ownerApprovalRequired: false,
          reviewedAt: String(rawMenuApproval.reviewedAt || "").trim() || null,
          sourceAttribution: null,
        }
      : profileType === "truck" && adminMenuVerified
        ? {
            status: "admin_verified" as const,
            label: "MealScout-verified menu",
            ownerApproved: false,
            adminVerified: true,
            ownerApprovalRequired: false,
            reviewedAt: String(rawMenuApproval.reviewedAt || "").trim() || null,
            sourceAttribution: menuSourceAttribution,
          }
        : profileType === "truck" && ownerMenuApproved
          ? {
              status: "owner_approved" as const,
              label: "Owner-approved menu",
              ownerApproved: true,
              adminVerified: false,
              ownerApprovalRequired: false,
              reviewedAt:
                String(rawMenuApproval.reviewedAt || "").trim() || null,
              sourceAttribution: menuSourceAttribution,
            }
          : profileType === "truck" && hasAnyMenuSurface
            ? {
                status: "needs_owner_confirmation" as const,
                label:
                  "Menu added from available source — needs owner confirmation",
                ownerApproved: false,
                adminVerified: false,
                ownerApprovalRequired: true,
                reviewedAt:
                  String(rawMenuApproval.reviewedAt || "").trim() || null,
                sourceAttribution: menuSourceAttribution,
              }
            : {
                status: "unavailable" as const,
                label: "Menu unavailable / pending update",
                ownerApproved: false,
                adminVerified: false,
                ownerApprovalRequired: false,
                reviewedAt: null,
                sourceAttribution: menuSourceAttribution,
              };
  const publicMenuSections =
    menuApproval.status === "rejected" ? [] : menuSections;
  const publicMenuVariants =
    menuApproval.status === "rejected" ? [] : menuVariants;
  const publicFeaturedMenuItems =
    menuApproval.status === "rejected" ? [] : featuredMenuItems;
  const publicMenuUrl = menuApproval.status === "rejected" ? null : menuUrl;
  const publicMenuImageUrl =
    menuApproval.status === "rejected" || ownerMenuApproved || adminMenuVerified
      ? null
      : menuImageUrl;
  const publicMenuPdfUrl =
    menuApproval.status === "rejected" || ownerMenuApproved || adminMenuVerified
      ? null
      : menuPdfUrl;
  const dealCount = Math.max(
    0,
    Number(
      row.dealCount ??
        row.activeDealCount ??
        row.totalActiveDeals ??
        row.dealsCount ??
        0,
    ) || 0,
  );
  const dealItemsRaw = Array.isArray(row.dealsItems) ? row.dealsItems : [];
  const dealItems = dealItemsRaw
    .map((item: any) => {
      const id = String(item?.id || "").trim();
      const title = String(item?.title || "").trim();
      const rawActionHref = String(item?.actionHref || "").trim();
      if (!id || !title || !rawActionHref) return null;
      const dealTypeRaw = String(item?.dealType || "other")
        .trim()
        .toLowerCase()
        .replace(/[^a-z_]/g, "_");
      const normalizedDealType = (
        [
          "daily",
          "happy_hour",
          "lunch",
          "family_meal",
          "limited_time",
          "coupon",
          "other",
        ] as const
      ).includes(dealTypeRaw as any)
        ? (dealTypeRaw as
            | "daily"
            | "happy_hour"
            | "lunch"
            | "family_meal"
            | "limited_time"
            | "coupon"
            | "other")
        : "other";
      const actionTypeRaw = String(item?.actionType || "show_this_deal")
        .trim()
        .toLowerCase()
        .replace(/[^a-z_]/g, "_");
      const normalizedActionType = (
        [
          "call",
          "show_this_deal",
          "order",
          "website",
          "menu",
          "internal",
        ] as const
      ).includes(actionTypeRaw as any)
        ? (actionTypeRaw as
            | "call"
            | "show_this_deal"
            | "order"
            | "website"
            | "menu"
            | "internal")
        : "show_this_deal";
      const actionHref = buildPublicCta({
        label: "Deal",
        href: rawActionHref,
        type:
          normalizedActionType === "call"
            ? "phone"
            : normalizedActionType === "website"
              ? "external"
              : normalizedActionType === "menu"
                ? "menu"
                : normalizedActionType === "order"
                  ? "order"
                  : "internal",
      })?.href;
      if (!actionHref) return null;
      return {
        id,
        title,
        description: String(item?.description || "").trim() || null,
        dealType: normalizedDealType,
        startAt: String(item?.startAt || "").trim() || null,
        endAt: String(item?.endAt || "").trim() || null,
        timeWindowLabel: String(item?.timeWindowLabel || "").trim() || null,
        imageUrl: normalizePublicUrl(item?.imageUrl, {
          allowInternalPath: true,
        }),
        actionLabel: String(item?.actionLabel || "").trim() || "View deal",
        actionHref,
        actionType: normalizedActionType,
      };
    })
    .filter(Boolean)
    .slice(0, 8) as PublicRestaurantProfile["deals"]["items"];
  const eventItemsRaw = Array.isArray(row.eventsItems) ? row.eventsItems : [];
  const eventItems = eventItemsRaw
    .map((item: any) => {
      const id = String(item?.id || "").trim();
      const title = String(item?.title || "").trim();
      const rawActionHref = String(item?.actionHref || "").trim();
      if (!id || !title || !rawActionHref) return null;
      const eventTypeRaw = String(item?.eventType || "other")
        .trim()
        .toLowerCase()
        .replace(/[^a-z_]/g, "_");
      const normalizedEventType = (
        [
          "live_music",
          "trivia",
          "karaoke",
          "pop_up",
          "food_truck_night",
          "watch_party",
          "holiday",
          "other",
        ] as const
      ).includes(eventTypeRaw as any)
        ? (eventTypeRaw as
            | "live_music"
            | "trivia"
            | "karaoke"
            | "pop_up"
            | "food_truck_night"
            | "watch_party"
            | "holiday"
            | "other")
        : "other";
      const actionTypeRaw = String(item?.actionType || "internal")
        .trim()
        .toLowerCase()
        .replace(/[^a-z_]/g, "_");
      const normalizedActionType = (
        ["rsvp", "share", "website", "directions", "internal"] as const
      ).includes(actionTypeRaw as any)
        ? (actionTypeRaw as
            "rsvp" | "share" | "website" | "directions" | "internal")
        : "internal";
      const actionHref = buildPublicCta({
        label: "Event",
        href: rawActionHref,
        type:
          normalizedActionType === "website"
            ? "external"
            : normalizedActionType === "directions"
              ? "map"
              : normalizedActionType === "share"
                ? "share"
                : "internal",
      })?.href;
      if (!actionHref) return null;
      return {
        id,
        title,
        description: String(item?.description || "").trim() || null,
        eventType: normalizedEventType,
        startsAt: String(item?.startsAt || "").trim() || null,
        endsAt: String(item?.endsAt || "").trim() || null,
        dateLabel: String(item?.dateLabel || "").trim() || null,
        timeWindowLabel: String(item?.timeWindowLabel || "").trim() || null,
        locationName: String(item?.locationName || "").trim() || null,
        addressPublicLabel:
          String(item?.addressPublicLabel || "").trim() || null,
        imageUrl: normalizePublicUrl(item?.imageUrl, {
          allowInternalPath: true,
        }),
        actionLabel: String(item?.actionLabel || "").trim() || "View event",
        actionHref,
        actionType: normalizedActionType,
      };
    })
    .filter(Boolean)
    .slice(0, 8) as PublicRestaurantProfile["events"]["items"];
  const reviewCount = Math.max(
    0,
    Number(row.reviewCount ?? row.totalReviews ?? row.ratingsCount ?? 0) || 0,
  );
  const recommendationTotal = Math.max(
    0,
    Number(
      row.recommendationCount ??
        row.totalRecommendations ??
        row.recommendationsCount ??
        0,
    ) || 0,
  );
  const recommendationLikes = Math.max(
    0,
    Number(row.recommendationLikeCount ?? row.recommendationLikes ?? 0) || 0,
  );
  const recommendationShares = Math.max(
    0,
    Number(row.recommendationShareCount ?? row.recommendationShares ?? 0) || 0,
  );

  const ctas = [
    buildPublicCta({ label: "Profile", href: canonicalPath, type: "internal" }),
    buildPublicCta({
      label: "Order online",
      href: capabilities?.onlineOrdering === false ? null : onlineOrderingUrl,
      type: "order",
      priority: 100,
    }),
    buildPublicCta({
      label: "Delivery",
      href: deliveryUrl,
      type: "order",
      priority: 96,
    }),
    buildPublicCta({
      label: "Menu",
      href: publicMenuUrl,
      type: "menu",
      priority: 94,
    }),
    buildPublicCta({
      label: "Get directions",
      href: directionsUrl,
      type: "map",
      priority: 92,
    }),
    buildPublicCta({
      label: "Call",
      href: phonePublic ? `tel:${phonePublic}` : null,
      type: "phone",
      priority: 90,
    }),
    buildPublicCta({
      label: "Website",
      href: websiteUrl,
      type: "external",
      priority: 86,
    }),
    buildPublicCta({
      label: "Instagram",
      href: instagramUrl,
      type: "social",
      priority: 82,
    }),
    buildPublicCta({
      label: "Facebook",
      href: facebookPageUrl,
      type: "social",
      priority: 81,
    }),
    buildPublicCta({ label: "X", href: xUrl, type: "social", priority: 78 }),
    buildPublicCta({
      label:
        profileType === "caterer" ? "Request catering" : "Catering inquiry",
      href: cateringUrl,
      type: "catering",
      priority: 74,
    }),
    buildPublicCta({
      label:
        profileType === "truck"
          ? "Truck booking inquiry"
          : profileType === "private_chef"
            ? "Request this chef"
            : profileType === "caterer"
              ? "Check availability"
              : "Booking inquiry",
      href: truckBookingUrl,
      type: "booking",
      priority: 72,
    }),
    buildPublicCta({
      label: "Share",
      href: `${input.baseUrl.replace(/\/$/, "")}${canonicalPath}`,
      type: "share",
      priority: 70,
    }),
  ].filter(Boolean) as PublicRestaurantProfile["cta"];

  return {
    id,
    profileType,
    displayName,
    slug,
    description: String(row.description || "").trim() || null,
    cuisineTags: String(row.cuisineType || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    serviceType: String(row.businessType || "").trim() || null,
    addressPublicLabel,
    city: String(row.city || "").trim() || null,
    state: String(row.state || "").trim() || null,
    latitude: publicLatitude,
    longitude: publicLongitude,
    distanceLabel: null,
    phonePublic,
    websiteUrl,
    socialLinks: {
      instagramUrl,
      facebookPageUrl,
      xUrl,
    },
    operatingHoursSummary: hoursValue,
    hours: hoursValue,
    openStatus: openStatusValue,
    coverImageUrl,
    logoUrl,
    galleryImages: [
      imageAsset(coverImageUrl, "cover_image"),
      imageAsset(logoUrl, "logo"),
      ...mappedGalleryImages,
    ].filter(Boolean) as PublicRestaurantProfile["galleryImages"],
    verifiedProfile:
      hidePublicTrustFields && !isAccepted("identity_verification")
        ? false
        : Boolean(row.isVerified),
    claimedProfile,
    locallyOwned: Boolean(
      row.locallyOwned ?? row.isLocallyOwned ?? row.localOwned ?? false,
    ),
    timeZone: String(row.timeZone || "").trim() || null,
    ordering: {
      path: nativeOrderingEnabled ? orderingPath : null,
      enabled: Boolean(row?.ordering?.enabled),
      unavailableReason:
        String(row?.ordering?.unavailableReason || "").trim() || null,
    },
    fulfillment: {
      pickup: {
        enabled: Boolean(row?.fulfillment?.pickup?.enabled),
        unavailableReason:
          String(row?.fulfillment?.pickup?.unavailableReason || "").trim() ||
          null,
      },
      delivery: {
        configured: Boolean(row?.fulfillment?.delivery?.configured),
        enabled: Boolean(row?.fulfillment?.delivery?.enabled),
        availableNow: Boolean(row?.fulfillment?.delivery?.availableNow),
        feeCents: Math.max(
          0,
          Number(row?.fulfillment?.delivery?.feeCents || 0) || 0,
        ),
        estimatedMinutes:
          row?.fulfillment?.delivery?.estimatedMinutes == null
            ? null
            : Math.max(
                0,
                Number(row.fulfillment.delivery.estimatedMinutes) || 0,
              ),
        unavailableReason:
          String(row?.fulfillment?.delivery?.unavailableReason || "").trim() ||
          null,
      },
    },
    menuSections: publicMenuSections,
    menuVariants: publicMenuVariants,
    activeMenuId: String(row.activeMenuId || "").trim() || null,
    menuContextNote: String(row.menuContextNote || "").trim() || null,
    menuLastUpdatedAt,
    menuApproval,
    menuImageUrl: publicMenuImageUrl,
    menuPdfUrl: publicMenuPdfUrl,
    menuUrl: publicMenuUrl,
    featuredMenuItems: publicFeaturedMenuItems,
    deals: {
      totalActive: Math.max(dealCount, dealItems.length),
      items: dealItems,
    },
    events: {
      totalUpcoming: Math.max(
        0,
        Number(row.upcomingEventCount ?? row.eventsCount ?? 0) || 0,
        eventItems.length,
      ),
      items: eventItems,
    },
    reviewSummary: { count: reviewCount },
    recommendations: {
      total: recommendationTotal,
      likes: recommendationLikes,
      shares: recommendationShares,
    },
    truckPresence,
    truckSchedule:
      profileType === "truck"
        ? {
            status: String(row?.truckSchedule?.status || "unknown") as any,
            statusLabel:
              String(row?.truckSchedule?.statusLabel || "").trim() || null,
            lastUpdatedAt:
              String(row?.truckSchedule?.lastUpdatedAt || "").trim() || null,
            notice: String(row?.truckSchedule?.notice || "").trim() || null,
            currentStop: row?.truckSchedule?.currentStop || null,
            todayStop: row?.truckSchedule?.todayStop || null,
            nextStop: row?.truckSchedule?.nextStop || null,
            upcomingStops: Array.isArray(row?.truckSchedule?.upcomingStops)
              ? row.truckSchedule.upcomingStops
              : [],
            closedStops: Array.isArray(row?.truckSchedule?.closedStops)
              ? row.truckSchedule.closedStops
              : [],
            nextWindowLabel:
              String(row?.truckSchedule?.nextWindowLabel || "").trim() ||
              nextWindowLabelValue ||
              null,
            upcomingCount: Math.max(
              0,
              Number(
                row?.truckSchedule?.upcomingCount ?? upcomingCountValue ?? 0,
              ) || 0,
            ),
            closedCount: Math.max(
              0,
              Number(row?.truckSchedule?.closedCount ?? 0) || 0,
            ),
          }
        : null,
    cta: ctas,
    seo: toPublicProfileSeo({
      baseUrl: input.baseUrl,
      entityType: profileType,
      entityId: id,
      slug,
      canonicalPath,
      title: displayName,
      description: String(row.description || "").trim() || null,
      ogImageUrl: coverImageUrl || logoUrl,
    }),
  };
}
