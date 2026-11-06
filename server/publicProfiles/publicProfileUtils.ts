import type { PublicCta, PublicCtaType, PublicImageAsset } from "@shared/publicProfiles";
import { resolveCoordinatePair } from "@shared/consumerEntity";

export const toSlug = (value: unknown) =>
  String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 80);

export const toPublicRouteSlug = (name: unknown, id: unknown) => {
  const baseSlug = toSlug(name);
  const safeId = String(id || "").trim();
  if (baseSlug && safeId) return `${baseSlug}--${safeId}`;
  return baseSlug || safeId;
};

export const buildPublicProfilePath = (input: {
  entityType:
    | "restaurant"
    | "truck"
    | "bar"
    | "caterer"
    | "private_chef"
    | "location"
    | "supplier";
  name: unknown;
  id: unknown;
}) => {
  const routeSlug = toPublicRouteSlug(input.name, input.id);
  if (!routeSlug) return "/";

  if (input.entityType === "truck") return `/truck/${routeSlug}`;
  if (input.entityType === "bar") return `/bar/${routeSlug}`;
  if (input.entityType === "caterer") return `/caterer/${routeSlug}`;
  if (input.entityType === "private_chef") return `/private-chef/${routeSlug}`;
  if (input.entityType === "location") return `/location/${routeSlug}`;
  if (input.entityType === "supplier") return `/supplier/${routeSlug}`;
  return `/restaurant/${routeSlug}`;
};

const isSafeInternalPath = (value: string) =>
  /^\/(?!\/)[a-z0-9\-/_?=&%.]*$/i.test(value);

/**
 * Canonical public URL projection. Public profile fields are rendered directly
 * into anchors as well as CTAs, so unsafe values must be removed before they
 * leave the server rather than relying on a particular client component.
 */
export const normalizePublicUrl = (
  value: unknown,
  options: { allowInternalPath?: boolean } = {},
) => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(raw) || raw.startsWith("//")) {
    return null;
  }
  if (raw.startsWith("/")) {
    return options.allowInternalPath && isSafeInternalPath(raw) ? raw : null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) {
    return null;
  }
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      !parsed.hostname
    ) {
      return null;
    }
    return /^https?:\/\//i.test(raw) ? raw : candidate;
  } catch {
    return null;
  }
};

/**
 * Resolve a stored image value into a share-image URL a crawler can fetch.
 * Stored image fields can hold values that are not URLs at all — most
 * importantly inline `data:` URIs pasted or uploaded as image data. A data
 * URI is not fetchable, and prefixing it with the site origin produces a
 * malformed og:image hundreds of thousands of characters long. Anything
 * normalizePublicUrl rejects (non-http(s) schemes such as data:/blob:,
 * protocol-relative values, control characters) falls back to the given
 * default share image path.
 */
export const resolvePublicShareImageUrl = (
  value: unknown,
  fallbackPath: string,
): string => normalizePublicUrl(value, { allowInternalPath: true }) ?? fallbackPath;

const isSafeExternal = (value: string) => /^https?:\/\//i.test(value);

const isSafePhone = (value: string) => /^tel:[+\d][\d\s\-().]+$/i.test(value);

export const buildPublicCta = (input: {
  label: string;
  href: unknown;
  type: PublicCtaType;
  priority?: number;
}): PublicCta | null => {
  const rawHref = String(input.href || "").trim();
  const allowInternalPath = [
    "internal",
    "menu",
    "order",
    "catering",
    "booking",
    "share",
  ].includes(input.type);
  const href =
    input.type === "phone"
      ? isSafePhone(rawHref)
        ? rawHref
        : null
      : normalizePublicUrl(rawHref, { allowInternalPath });
  if (!href) return null;
  const safe =
    (allowInternalPath && isSafeInternalPath(href)) ||
    ((input.type === "external" ||
      input.type === "map" ||
      input.type === "menu" ||
      input.type === "order" ||
      input.type === "social" ||
      input.type === "catering" ||
      input.type === "booking" ||
      input.type === "share") &&
      isSafeExternal(href)) ||
    (input.type === "phone" && isSafePhone(href));
  if (!safe) return null;
  return {
    label: String(input.label || "").trim(),
    href,
    type: input.type,
    safe,
    priority:
      typeof input.priority === "number" && Number.isFinite(input.priority)
        ? input.priority
        : undefined,
  };
};

export const imageAsset = (
  url: unknown,
  source: PublicImageAsset["source"],
): PublicImageAsset | null => {
  const raw = String(url || "").trim();
  let normalized: string | null = null;
  if (/^\/(?!\/)/.test(raw)) {
    normalized = raw;
  } else if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      normalized =
        ["http:", "https:"].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password
          ? parsed.toString()
          : null;
    } catch {
      normalized = null;
    }
  }
  if (!normalized) return null;
  return {
    url: normalized,
    source,
    lastVerifiedAt: null,
    publicApproved: true,
  };
};

export const joinedAddressLabel = (
  address: unknown,
  city: unknown,
  state: unknown,
) =>
  [String(address || "").trim(), String(city || "").trim(), String(state || "").trim()]
    .filter(Boolean)
    .join(", ") || null;

export const resolvePublicCoordinatePair = (
  latitudeValue: unknown,
  longitudeValue: unknown,
) => resolveCoordinatePair(latitudeValue, longitudeValue);

export const buildPublicDirectionsUrl = (input: {
  latitude: unknown;
  longitude: unknown;
  addressPublicLabel?: unknown;
}) => {
  const coordinates = resolvePublicCoordinatePair(
    input.latitude,
    input.longitude,
  );
  if (coordinates) {
    return `https://maps.google.com/?q=${coordinates.latitude},${coordinates.longitude}`;
  }
  const address = String(input.addressPublicLabel || "").trim();
  return address
    ? `https://maps.google.com/?q=${encodeURIComponent(address)}`
    : null;
};

export const resolvePublicProfileVisibility = (settings: unknown) => {
  const value =
    settings && typeof settings === "object"
      ? (settings as { showAddress?: unknown; showContact?: unknown })
      : {};
  return {
    showAddress: value.showAddress !== false,
    showContact: value.showContact !== false,
  };
};
