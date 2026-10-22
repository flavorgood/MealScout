import type { PublicSupplierProfile } from "@shared/publicProfiles";
import { toPublicProfileSeo } from "./toPublicProfileSeo";
import {
  buildPublicCta,
  buildPublicDirectionsUrl,
  resolvePublicCoordinatePair,
  buildPublicProfilePath,
  joinedAddressLabel,
  normalizePublicUrl,
  toSlug,
} from "./publicProfileUtils";

export function toPublicSupplierProfile(input: {
  row: any;
  activeProductCount: number;
  baseUrl: string;
  showAddress?: boolean;
  showContact?: boolean;
}): PublicSupplierProfile {
  const row = input.row || {};
  const id = String(row.id || "");
  const displayName = String(row.businessName || "MealScout supplier");
  const slug = toSlug(displayName) || id;
  const canonicalPath = buildPublicProfilePath({
    entityType: "supplier",
    name: displayName,
    id,
  });
  const addressPublicLabel =
    input.showAddress === false
      ? null
      : joinedAddressLabel(row.address, row.city, row.state);
  const coordinates = input.showAddress !== false
    ? resolvePublicCoordinatePair(row.latitude, row.longitude) : null;
  const publicLatitude = coordinates?.latitude ?? null;
  const publicLongitude = coordinates?.longitude ?? null;
  const phonePublic =
    input.showContact === false ? null : String(row.contactPhone || "").trim() || null;
  const websiteUrl =
    input.showContact === false ? null : normalizePublicUrl(row.websiteUrl);
  const logoUrl = normalizePublicUrl(row.logoUrl, {
    allowInternalPath: true,
  });

  const cta = [
    buildPublicCta({ label: "View supplier", href: canonicalPath, type: "internal" }),
    buildPublicCta({ label: "Website", href: websiteUrl, type: "external" }),
    buildPublicCta({ label: "Get directions", href: buildPublicDirectionsUrl({
      latitude: publicLatitude, longitude: publicLongitude,
      addressPublicLabel: String(row.address || "").trim() ? addressPublicLabel : null,
    }), type: "map" }),
    buildPublicCta({ label: "Call", href: phonePublic ? `tel:${phonePublic}` : null, type: "phone" }),
  ].filter(Boolean) as PublicSupplierProfile["cta"];

  return {
    id,
    profileType: "supplier",
    displayName,
    slug,
    description:
      String(row.onlinePaymentsNotes || row.deliveryNotes || "").trim() || null,
    addressPublicLabel,
    city: String(row.city || "").trim() || null,
    state: String(row.state || "").trim() || null,
    latitude: publicLatitude,
    longitude: publicLongitude,
    phonePublic,
    websiteUrl,
    logoUrl,
    cta,
    activeProductCount: Math.max(0, Number(input.activeProductCount || 0)),
    seo: toPublicProfileSeo({
      baseUrl: input.baseUrl,
      entityType: "supplier",
      entityId: id,
      slug,
      canonicalPath,
      title: displayName,
      description:
        String(row.onlinePaymentsNotes || row.deliveryNotes || "").trim() || null,
      ogImageUrl: logoUrl,
    }),
  };
}
