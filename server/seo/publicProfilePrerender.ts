import type { Express, NextFunction, Request, Response } from "express";
import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";

import { db } from "../db";
import {
  cities,
  deals,
  events,
  hosts,
  menus,
  menuItems,
  restaurants,
  suppliers,
  users,
} from "@shared/schema";
import { buildOfficialSocialEntityMetaTags } from "./officialSocialEntity";
import {
  toCanonicalFoodBusinessType,
} from "@shared/businessTypes";
import {
  filterPublicConfirmedEventTrucks,
  loadConfirmedEventTrucks,
} from "../services/confirmedEventTrucks";
import { resolveCityTimeZoneSync } from "../services/cityTimeZone";
import { buildSlotDateTimes } from "../services/timeIntent";
import { isSlotPublic } from "../services/publicSlotGate";
import { canExposeAnonymousEventDetail } from "../publicProfiles/publicEventDetailAccess";
import {
  isPublicDiscoveryEligibleEntity,
  isSyntheticPublicEntityName,
} from "@shared/publicDiscoveryIntegrity";
import {
  PUBLIC_RESTAURANT_INDEXABLE_ROBOTS,
  PUBLIC_RESTAURANT_NOINDEX_ROBOTS,
  publicRestaurantRobotsDirective,
} from "./publicRestaurantIndexability";
import {
  toPublicLocationProfile,
  toPublicRestaurantProfile,
  toPublicSupplierProfile,
} from "../publicProfiles";
import { buildJsonLdScript } from "./jsonLdScript";
import { loadPublicSeoLandingData } from "../services/publicSeoLandingData";
import {
  projectPublicSeoLandingForHtml,
  isPublicSeoLandingRestaurantEligible,
  publicSeoBusinessProfileType,
  publicSeoCityRequest,
  publicSeoCuisineRequest,
  publicSeoFoodTruckCuisineRequest,
  type PublicSeoLandingRequest,
} from "../services/publicSeoLandingModel";
import {
  buildPublicProfilePath,
  resolvePublicProfileVisibility,
} from "../publicProfiles/publicProfileUtils";
import { isPublicBusinessVisible } from "../utils/publicBusinessVisibility";

type PageLink = { label: string; href: string };

type PrerenderPage = {
  title: string;
  description: string;
  canonicalPath: string;
  imageUrl?: string | null;
  robots?: string;
  schema: object | object[];
  links: PageLink[];
  body: string[];
  listingHtml?: string;
  selectiveIntelligence?: {
    manifestUrl: string;
    mcpUrl: string;
  };
};

type PublicVideo = {
  title: string | null;
  description: string | null;
  fileUrl: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  createdAt: Date | null;
  isFeatured: boolean;
};

const escapeHtml = (value: string | null | undefined) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const defaultSocialImagePath = "/og-default.jpg?v=20260506";

// Unclaimed, import-seeded listings should stay out of Google's index until a
// real owner claims them - indexing thousands of thin, identical-template
// pages en masse dilutes crawl budget and search quality for the pages that
// matter (claimed, real businesses).
async function resolveOwnerPublicProfile(ownerId: string | null) {
  if (!ownerId) {
    return {
      email: null,
      ownerEnabled: false,
      ...resolvePublicProfileVisibility(null),
    };
  }
  const [owner] = await db
    .select({
      email: users.email,
      isDisabled: users.isDisabled,
      publicProfileSettings: users.publicProfileSettings,
    })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  return {
    email: owner?.email ? String(owner.email) : null,
    ownerEnabled: owner?.isDisabled === false,
    ...resolvePublicProfileVisibility(owner?.publicProfileSettings),
  };
}

const toSlug = (value: string | null | undefined) =>
  String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 80);

async function resolveCanonicalProfileCity(input: {
  city?: string | null;
  state?: string | null;
}) {
  const cityName = cleanText(input.city);
  const stateName = cleanText(input.state);
  if (!cityName || !stateName) return null;
  const [row] = await db
    .select({ id: cities.id, name: cities.name, slug: cities.slug, state: cities.state })
    .from(cities)
    .where(
      and(
        sql`lower(btrim(coalesce(${cities.name}, ''))) = ${cityName.toLowerCase()}`,
        sql`lower(btrim(coalesce(${cities.state}, ''))) = ${stateName.toLowerCase()}`,
        sql`btrim(coalesce(${cities.slug}, '')) <> ''`,
      ),
    )
    .orderBy(sql`${cities.createdAt} desc nulls last`, asc(cities.id))
    .limit(1);
  if (!row) return null;
  return {
    name: cleanText(row.name, cityName),
    state: cleanText(row.state, stateName),
    slug: cleanText(row.slug).toLowerCase(),
  };
}

const LEGACY_CITY_DEAL_REDIRECT_QUERY_KEYS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "source",
  "ref",
  "reftag",
  "promosource",
]);

const legacyCityDealRedirectQuery = (req: Request) => {
  const incoming = new URL(
    req.originalUrl || req.url || "/",
    "https://www.mealscout.us",
  );
  const safe = new URLSearchParams();
  let retained = 0;
  incoming.searchParams.forEach((value, key) => {
    if (retained >= 12) return;
    const normalizedKey = String(key || "").trim().toLowerCase();
    const normalizedValue = String(value || "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 200);
    if (
      !LEGACY_CITY_DEAL_REDIRECT_QUERY_KEYS.has(normalizedKey) ||
      !normalizedValue
    ) {
      return;
    }
    safe.append(normalizedKey, normalizedValue);
    retained += 1;
  });
  const serialized = safe.toString();
  return serialized ? `?${serialized}` : "";
};

const extractId = (value: string | null | undefined) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const marker = raw.lastIndexOf("--");
  if (marker >= 0) return raw.slice(marker + 2);
  const uuid = raw.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  return uuid?.[0] || raw;
};

const cleanText = (value: unknown, fallback = "") =>
  String(value || fallback)
    .replace(/\s+/g, " ")
    .trim();

const cleanMultilineText = (value: unknown, fallback = "") =>
  String(value || fallback)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();

const absoluteUrl = (baseUrl: string, pathOrUrl: string | null | undefined) => {
  const value = String(pathOrUrl || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `${baseUrl}${value.startsWith("/") ? "" : "/"}${value}`;
};

const externalUrl = (value: string | null | undefined) => {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw.replace(/^\/+/, "")}`;
};

const isoDate = (value: unknown) => {
  if (!value) return undefined;
  const parsed = new Date(value as any);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
};

const paragraph = (value: string | null | undefined) => {
  const text = cleanMultilineText(value);
  if (!text) return "";
  return `<p>${escapeHtml(text).replace(/\n+/g, "<br>")}</p>`;
};

const employmentTypeForSchema = (value: string | null | undefined) => {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "full_time") return "FULL_TIME";
  if (normalized === "part_time") return "PART_TIME";
  if (normalized === "contract" || normalized === "gig") return "CONTRACTOR";
  if (normalized === "seasonal") return "TEMPORARY";
  return "OTHER";
};

const labelize = (value: string | null | undefined) =>
  String(value || "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const indexableRobots = PUBLIC_RESTAURANT_INDEXABLE_ROBOTS;
const noindexRobots = PUBLIC_RESTAURANT_NOINDEX_ROBOTS;

const friendlyLocationTypeLabel = (value: string | null | undefined) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "";
  if (normalized === "private_residence") return "Private event location";
  if (normalized === "business") return "Business";
  if (normalized === "other") return "Host location";
  return labelize(normalized);
};

const moneyFromCents = (value: unknown) => {
  const cents = Number(value);
  return Number.isFinite(cents) && cents > 0 ? Math.round(cents) / 100 : null;
};

const payRangeLabel = (row: {
  compensationLabel?: string | null;
  payMinCents?: number | null;
  payMaxCents?: number | null;
}) => {
  if (row.compensationLabel) return cleanText(row.compensationLabel);
  const min = moneyFromCents(row.payMinCents);
  const max = moneyFromCents(row.payMaxCents);
  if (min && max && min !== max) return `$${min}-$${max}/hr`;
  if (min) return `$${min}/hr`;
  if (max) return `Up to $${max}/hr`;
  return "";
};

const baseSalarySchema = (row: {
  payMinCents?: number | null;
  payMaxCents?: number | null;
}) => {
  const minValue = moneyFromCents(row.payMinCents);
  const maxValue = moneyFromCents(row.payMaxCents);
  if (!minValue && !maxValue) return undefined;
  return {
    "@type": "MonetaryAmount",
    currency: "USD",
    value: {
      "@type": "QuantitativeValue",
      ...(minValue ? { minValue } : {}),
      ...(maxValue ? { maxValue } : {}),
      ...(!maxValue && minValue ? { value: minValue } : {}),
      unitText: "HOUR",
    },
  };
};

const firstPhotoUrl = (value: unknown) => {
  if (!Array.isArray(value)) return "";
  const first = value.find((item) => item && typeof item === "object") as any;
  return String(first?.url || first?.src || first?.photoUrl || "");
};

const resolveRestaurantImage = (
  baseUrl: string,
  publicProfile: ReturnType<typeof toPublicRestaurantProfile>,
) =>
  absoluteUrl(
    baseUrl,
    publicProfile.coverImageUrl ||
      publicProfile.logoUrl ||
      defaultSocialImagePath,
  );

const resolveHostImage = (baseUrl: string, row: any) =>
  absoluteUrl(
    baseUrl,
    row.spotImageUrl ||
      row.facebookCoverUrl ||
      firstPhotoUrl(row.googlePhotos) ||
      defaultSocialImagePath,
  );

async function publicVideosFor(
  _ownerType: string,
  _ownerId: string,
): Promise<PublicVideo[]> {
  return [];
}

const videoSchemas = (
  baseUrl: string,
  videos: PublicVideo[],
  fallbackName: string,
) =>
  videos.map((video: PublicVideo, index: number) => ({
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: cleanText(video.title, `${fallbackName} video ${index + 1}`),
    description: cleanText(
      video.description,
      `Public video from ${fallbackName}`,
    ),
    contentUrl: video.fileUrl,
    thumbnailUrl: absoluteUrl(
      baseUrl,
      video.thumbnailUrl || defaultSocialImagePath,
    ),
    uploadDate: video.createdAt
      ? new Date(video.createdAt as any).toISOString()
      : undefined,
    duration: video.durationSeconds
      ? `PT${Math.max(1, Number(video.durationSeconds || 0))}S`
      : undefined,
  }));

const menuSnippetForRestaurant = async (restaurantId: string) => {
  try {
    const [row] = await db
      .select({
        itemCount:
          sql<number>`count(${menuItems.id}) filter (where ${menuItems.isAvailable} = true)`.mapWith(
            Number,
          ),
        itemNames: sql<string>`string_agg(distinct ${menuItems.name}, ', ') filter (where ${menuItems.isAvailable} = true)`,
      })
      .from(menus)
      .leftJoin(menuItems, eq(menuItems.menuId, menus.id))
      .where(
        and(eq(menus.restaurantId, restaurantId), eq(menus.isActive, true)),
      )
      .groupBy(menus.restaurantId);

    const itemNames = String(row?.itemNames || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 8);
    return {
      itemCount: Number(row?.itemCount || 0),
      itemNames,
    };
  } catch (error) {
    console.warn("[seo-prerender] menu snippet unavailable", {
      restaurantId,
      error,
    });
    return { itemCount: 0, itemNames: [] as string[] };
  }
};

const buildHtml = (baseUrl: string, page: PrerenderPage) => {
  const canonicalUrl = absoluteUrl(baseUrl, page.canonicalPath);
  const image = absoluteUrl(baseUrl, page.imageUrl || defaultSocialImagePath);
  const isDefaultSocialImage = /\/og-default\.jpg(?:$|\?)/i.test(image);
  const schema = Array.isArray(page.schema) ? page.schema : [page.schema];
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(page.title)}</title>
  <meta name="description" content="${escapeHtml(page.description)}">
  <meta name="robots" content="${escapeHtml(page.robots || "index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1")}">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  ${
    page.selectiveIntelligence
      ? `<meta name="selective-intelligence-trigger" content="profile-link">
  <meta name="selective-intelligence-product" content="MealScout">
  <link rel="alternate" type="application/vnd.selective-intelligence+json" title="Selective Intelligence" href="${escapeHtml(page.selectiveIntelligence.manifestUrl)}">
  <link rel="alternate" type="application/mcp+json" title="MealScout owner actions" href="${escapeHtml(page.selectiveIntelligence.mcpUrl)}">`
      : ""
  }
  <meta property="og:title" content="${escapeHtml(page.title)}">
  <meta property="og:description" content="${escapeHtml(page.description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:image" content="${escapeHtml(image)}">
  <meta property="og:image:url" content="${escapeHtml(image)}">
  <meta property="og:image:secure_url" content="${escapeHtml(image)}">
  ${isDefaultSocialImage ? '<meta property="og:image:type" content="image/jpeg">\n  <meta property="og:image:width" content="1200">\n  <meta property="og:image:height" content="630">' : ""}
  <meta property="og:image:alt" content="${escapeHtml(page.title)}">
  <meta property="og:site_name" content="MealScout">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(page.title)}">
  <meta name="twitter:description" content="${escapeHtml(page.description)}">
  <meta name="twitter:image" content="${escapeHtml(image)}">
  <meta name="twitter:image:alt" content="${escapeHtml(page.title)}">
  <link rel="image_src" href="${escapeHtml(image)}">
  ${buildOfficialSocialEntityMetaTags()}
  ${schema
    .map((entry) => buildJsonLdScript(entry))
    .join("\n  ")}
  <style>
    body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif; margin: 0; color: #111827; background: #fffaf2; }
    main { max-width: 860px; margin: 0 auto; padding: 28px 18px 44px; }
    h1 { font-size: 34px; line-height: 1.15; margin: 0 0 12px; }
    p { font-size: 16px; line-height: 1.65; margin: 0 0 14px; }
    img { max-width: 100%; border-radius: 12px; margin: 14px 0; }
    .links { margin-top: 20px; padding-top: 14px; border-top: 1px solid #fed7aa; }
    .links a { display: inline-block; margin: 8px 12px 0 0; color: #9a3412; font-weight: 700; text-decoration: none; }
    .listing-results { margin-top: 24px; }
    .listing-results ul { display: grid; grid-template-columns: repeat(auto-fit,minmax(230px,1fr)); gap: 14px; padding: 0; list-style: none; }
    .listing-results li { border: 1px solid #fed7aa; border-radius: 12px; padding: 14px; background: #fff; }
    .listing-results li > a, .listing-results li > span { display: block; margin-bottom: 8px; }
    .listing-results li > a { color: #9a3412; }
    .listing-results li p { font-size: 14px; margin-bottom: 6px; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(page.title.replace(/\s+\|\s+MealScout$/, ""))}</h1>
    <p>${escapeHtml(page.description)}</p>
    ${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(page.title)}">` : ""}
    ${page.body.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n    ")}
    ${page.listingHtml || ""}
    <div class="links">
      ${page.links
        .map(
          (link) =>
            `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`,
        )
        .join("\n      ")}
    </div>
  </main>
</body>
</html>`;
};

async function restaurantPage(
  baseUrl: string,
  restaurantId: string,
  expectedProfileType?: "restaurant" | "truck" | "bar" | "caterer" | "private_chef",
) {
  const [row] = await db
    .select()
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1);
  if (!row || !row.isActive) return null;
  const publicProfileType = publicSeoBusinessProfileType(row);
  const canonicalBusinessType = toCanonicalFoodBusinessType(row.businessType);
  const strictRouteProfileType =
    publicProfileType ||
    (canonicalBusinessType === "caterer" ||
    canonicalBusinessType === "private_chef"
      ? canonicalBusinessType
      : null);
  if (expectedProfileType && strictRouteProfileType !== expectedProfileType) {
    return null;
  }
  const ownerProfile = await resolveOwnerPublicProfile(row.ownerId);
  if (!ownerProfile.ownerEnabled || !isPublicBusinessVisible(row)) return null;

  const name = cleanText(row.name, "MealScout business");
  const robots = publicRestaurantRobotsDirective({
    name,
    isActive: row.isActive,
    ownerId: row.ownerId,
    ownerEmail: ownerProfile.email,
    address: row.address,
    cuisineType: row.cuisineType,
    description: row.description,
    city: row.city,
    state: row.state,
    rawData: row.rawData,
    phone: row.phone,
    websiteUrl: row.websiteUrl,
  });
  const cityState = [row.city, row.state]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .join(", ");
  const canonicalCity = await resolveCanonicalProfileCity({
    city: row.city,
    state: row.state,
  });
  const isTruck = publicProfileType === "truck";
  const isBar = publicProfileType === "bar";
  const isCaterer = canonicalBusinessType === "caterer";
  const isPrivateChef = canonicalBusinessType === "private_chef";
  const isServiceProfile = isCaterer || isPrivateChef;
  const projectedProfileType =
    publicProfileType ||
    (canonicalBusinessType === "private_chef" ||
    canonicalBusinessType === "caterer"
      ? canonicalBusinessType
      : "restaurant");
  const publicProfile = toPublicRestaurantProfile({
    row,
    baseUrl,
    profileType: projectedProfileType,
    showAddress: ownerProfile.showAddress,
    showContact: ownerProfile.showContact,
  });
  const ownerType = isTruck ? "food_truck" : "restaurant";
  const rawCateringDetails =
    row.cateringDetails && typeof row.cateringDetails === "object"
      ? (row.cateringDetails as Record<string, any>)
      : {};
  const offersCatering = Boolean(
    row.offersCatering || canonicalBusinessType === "caterer" || isPrivateChef,
  );
  const cateringHeadline = cleanText(
    rawCateringDetails.headline || rawCateringDetails.title,
    isPrivateChef
      ? `${name} private chef bookings`
      : `${name} catering${isTruck ? " and events" : ""}`,
  );
  const cateringDescription = cleanText(
    rawCateringDetails.description || rawCateringDetails.notes,
    `${name} can support local catering, events, offices, private parties, and pop-ups through MealScout.`,
  );
  const cateringArea = cleanText(
    rawCateringDetails.serviceArea || rawCateringDetails.serviceAreaLabel,
    cityState,
  );
  const canonicalPath = isTruck
    ? buildPublicProfilePath({ entityType: "truck", name, id: row.id })
    : isBar
      ? buildPublicProfilePath({ entityType: "bar", name, id: row.id })
      : isCaterer
        ? buildPublicProfilePath({ entityType: "caterer", name, id: row.id })
        : isPrivateChef
          ? buildPublicProfilePath({ entityType: "private_chef", name, id: row.id })
          : publicProfileType === "restaurant"
            ? buildPublicProfilePath({ entityType: "restaurant", name, id: row.id })
            : `/restaurant/${encodeURIComponent(row.id)}/${encodeURIComponent(toSlug(name) || row.id)}`;
  const canonicalProfileUrl = absoluteUrl(baseUrl, canonicalPath);
  const profileEntityId = `${canonicalProfileUrl}#business`;
  const profilePageId = `${canonicalProfileUrl}#webpage`;
  const cuisineSlug = toSlug(row.cuisineType);
  const profileUpdatedAt = isoDate(row.updatedAt);

  const videos = await publicVideosFor(ownerType, row.id);
  const menuSnippet = await menuSnippetForRestaurant(row.id);
  const image =
    videos[0]?.thumbnailUrl || resolveRestaurantImage(baseUrl, publicProfile);
  const menuHighlights = menuSnippet.itemNames.slice(0, 5);
  const menuSentence = menuHighlights.length
    ? ` Menu highlights include ${menuHighlights.join(", ")}.`
    : "";
  const baseDescription = cleanText(
    row.description || row.facebookAbout,
    `${name}${cityState ? ` in ${cityState}` : ""} on MealScout. View profile details, specials, videos, menu information, and location updates.${menuSentence}`,
  );
  const cateringSentence = offersCatering
    ? isPrivateChef
      ? ` Private chef bookings, menus, service area, and booking details are available from this profile.`
      : ` Catering is available for local events and private bookings.`
    : "";
  const description = cleanText(
    `${baseDescription}${baseDescription.includes(menuHighlights[0] || "__none__") ? "" : menuSentence}${cateringSentence}`,
  );

  const localBusiness = {
    "@context": "https://schema.org",
    "@id": profileEntityId,
    "@type": isTruck
      ? "FoodTruck"
      : isBar
        ? "BarOrPub"
        : isServiceProfile
          ? "FoodEstablishment"
          : "Restaurant",
    name,
    description,
    url: canonicalProfileUrl,
    mainEntityOfPage: { "@id": profilePageId },
    image,
    telephone: publicProfile.phonePublic || undefined,
    servesCuisine: row.cuisineType || undefined,
    hasMenu: row.menuUrl
      ? externalUrl(row.menuUrl)
      : menuSnippet.itemNames.length
        ? {
            "@type": "Menu",
            name: `${name} menu`,
            hasMenuItem: menuSnippet.itemNames.slice(0, 8).map((item) => ({
              "@type": "MenuItem",
              name: item,
            })),
          }
        : undefined,
    makesOffer: offersCatering
      ? {
          "@type": "Offer",
          itemOffered: {
            "@type": "Service",
            name: cateringHeadline,
            description: cateringDescription,
            areaServed: cateringArea || cityState || undefined,
          },
        }
      : undefined,
    address: {
      "@type": "PostalAddress",
      streetAddress: publicProfile.addressPublicLabel
        ? row.address || undefined
        : undefined,
      addressLocality: row.city || undefined,
      addressRegion: row.state || undefined,
      addressCountry: "US",
    },
    sameAs: [
      publicProfile.websiteUrl,
      publicProfile.socialLinks.instagramUrl,
      publicProfile.socialLinks.facebookPageUrl,
      publicProfile.socialLinks.xUrl,
    ].filter(Boolean),
  };

  const profilePageSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": profilePageId,
    name: `${name}${cityState ? ` in ${cityState}` : ""}${isPrivateChef ? " | MealScout Private Chef" : isCaterer ? " | MealScout Caterer" : " | MealScout"}`,
    description,
    url: canonicalProfileUrl,
    dateModified: profileUpdatedAt,
    mainEntity: { "@id": profileEntityId },
    isPartOf: {
      "@type": "WebSite",
      name: "MealScout",
      url: baseUrl,
    },
  };

  const breadcrumbItems = [
    {
      "@type": "ListItem",
      position: 1,
      name: "MealScout",
      item: baseUrl,
    },
    ...(canonicalCity && !isServiceProfile
      ? [{
          "@type": "ListItem",
          position: 2,
          name: isTruck
            ? `Food trucks in ${canonicalCity.name}`
            : `Food in ${canonicalCity.name}`,
          item: absoluteUrl(
            baseUrl,
            isTruck
              ? `/food-trucks/${encodeURIComponent(canonicalCity.slug)}`
              : `/city/${encodeURIComponent(canonicalCity.slug)}/food`,
          ),
        }]
      : []),
    {
      "@type": "ListItem",
      position: canonicalCity && !isServiceProfile ? 3 : 2,
      name,
      item: canonicalProfileUrl,
    },
  ];

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: breadcrumbItems,
  };

  const discoveryLinks: PageLink[] = [
    { label: "Open profile", href: canonicalPath },
    ...(offersCatering
      ? [{ label: "Catering", href: `${canonicalPath}?service=catering` }]
      : []),
    ...(canonicalCity && !isServiceProfile
      ? [
          {
            label: isTruck
              ? `Food trucks in ${canonicalCity.name}`
              : `Food in ${canonicalCity.name}`,
            href: isTruck
              ? `/food-trucks/${encodeURIComponent(canonicalCity.slug)}`
              : `/city/${encodeURIComponent(canonicalCity.slug)}/food`,
          },
          ...(isTruck
            ? [
                {
                  label: `Food truck catering in ${canonicalCity.name}`,
                  href: `/food-truck-catering/${encodeURIComponent(canonicalCity.slug)}`,
                },
                {
                  label: `Book a food truck in ${canonicalCity.name}`,
                  href: `/book-food-truck/${encodeURIComponent(canonicalCity.slug)}`,
                },
              ]
            : []),
          ...(cuisineSlug
            ? [{
                label: `${cleanText(row.cuisineType)} in ${canonicalCity.name}`,
                href: isTruck
                  ? `/food-trucks/${encodeURIComponent(canonicalCity.slug)}/${encodeURIComponent(cuisineSlug)}`
                  : `/cuisine/${encodeURIComponent(cuisineSlug)}/${encodeURIComponent(canonicalCity.slug)}`,
              }]
            : []),
        ]
      : []),
    ...(isServiceProfile
      ? [{ label: "Plan food for an event", href: "/for-events" }]
      : []),
    { label: "Find food nearby", href: "/search" },
    { label: "Scout", href: "/scout" },
  ];

  return {
    title: `${name}${cityState ? ` in ${cityState}` : ""}${isPrivateChef ? " | MealScout Private Chef" : isCaterer ? " | MealScout Caterer" : " | MealScout"}`,
    description,
    canonicalPath,
    imageUrl: image,
    robots,
    schema: [
      profilePageSchema,
      localBusiness,
      breadcrumbSchema,
      ...videoSchemas(baseUrl, videos, name),
    ],
    links: discoveryLinks,
    body: [
      row.cuisineType ? `Cuisine: ${row.cuisineType}` : "",
      cityState ? `Area: ${cityState}` : "",
      profileUpdatedAt
        ? `Public profile updated: ${profileUpdatedAt.slice(0, 10)}`
        : "",
      menuSnippet.itemCount
        ? `Menu on MealScout: ${menuSnippet.itemCount} item${menuSnippet.itemCount === 1 ? "" : "s"}${menuHighlights.length ? ` including ${menuHighlights.join(", ")}` : ""}.`
        : row.menuUrl
          ? "Menu link available on this MealScout profile."
          : "",
      offersCatering
        ? `${cateringHeadline}: ${cateringDescription}${cateringArea ? ` Area served: ${cateringArea}.` : ""}`
        : "",
      videos.length
        ? `${videos.length} public video${videos.length === 1 ? "" : "s"} available on this profile.`
        : "",
    ].filter(Boolean),
    selectiveIntelligence: {
      manifestUrl: absoluteUrl(
        baseUrl,
        `/api/owner-ai/profiles/${encodeURIComponent(row.id)}/selective-intelligence`,
      ),
      mcpUrl: absoluteUrl(
        baseUrl,
        `/api/owner-ai/profiles/${encodeURIComponent(row.id)}/mcp`,
      ),
    },
  } satisfies PrerenderPage;
}

async function hostPage(baseUrl: string, hostId: string) {
  const [row] = await db
    .select()
    .from(hosts)
    .where(eq(hosts.id, hostId))
    .limit(1);
  if (!row) return null;
  const ownerProfile = await resolveOwnerPublicProfile(row.userId);
  if (
    !ownerProfile.ownerEnabled ||
    !isPublicDiscoveryEligibleEntity({
      name: row.businessName,
      isActive: true,
    }) ||
    !isPublicBusinessVisible({
      name: row.businessName,
      city: row.city,
      state: row.state,
    })
  ) {
    return null;
  }
  const publicProfile = toPublicLocationProfile({
    row,
    baseUrl,
    showAddress: ownerProfile.showAddress,
    showContact: ownerProfile.showContact,
  });
  const publicPhoneHref = publicProfile.cta.find(
    (cta) => cta.type === "phone",
  )?.href;
  const publicPhone = publicPhoneHref?.replace(/^tel:/i, "") || null;
  const name = cleanText(row.businessName, "MealScout host location");
  const cityState = [row.city, row.state]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .join(", ");
  const canonicalCity = await resolveCanonicalProfileCity({
    city: row.city,
    state: row.state,
  });
  const canonicalPath = `/location/${encodeURIComponent(`${toSlug(name) || row.id}--${row.id}`)}`;
  const canonicalProfileUrl = absoluteUrl(baseUrl, canonicalPath);
  const profileEntityId = `${canonicalProfileUrl}#location`;
  const profilePageId = `${canonicalProfileUrl}#webpage`;
  const profileUpdatedAt = isoDate(row.updatedAt);
  const videos = await publicVideosFor("host", row.id);
  const image = videos[0]?.thumbnailUrl || resolveHostImage(baseUrl, row);
  const description = cleanText(
    publicProfile.description,
    `${name}${cityState ? ` in ${cityState}` : ""} is a MealScout host location for food truck parking and events.`,
  );
  const locationTypeLabel = friendlyLocationTypeLabel(row.locationType);
  const hostIndexable = isPublicDiscoveryEligibleEntity({
    name: row.businessName,
    isActive: true,
  });

  const locationSchema = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    "@id": profileEntityId,
    name,
    description,
    url: canonicalProfileUrl,
    mainEntityOfPage: { "@id": profilePageId },
    image,
    telephone: publicPhone || undefined,
    sameAs: [
      publicProfile.websiteUrl,
      publicProfile.socialLinks.instagramUrl,
      publicProfile.socialLinks.facebookPageUrl,
      publicProfile.socialLinks.xUrl,
    ].filter(Boolean),
    address: {
      "@type": "PostalAddress",
      streetAddress: publicProfile.addressPublicLabel
        ? row.address || undefined
        : undefined,
      addressLocality: row.city || undefined,
      addressRegion: row.state || undefined,
      addressCountry: "US",
    },
  };
  const profilePageSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": profilePageId,
    name: `${name} Food Truck Location${cityState ? ` in ${cityState}` : ""} | MealScout`,
    description,
    url: canonicalProfileUrl,
    dateModified: profileUpdatedAt,
    mainEntity: { "@id": profileEntityId },
    isPartOf: { "@type": "WebSite", name: "MealScout", url: baseUrl },
  };
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "MealScout", item: baseUrl },
      ...(canonicalCity
        ? [{
            "@type": "ListItem",
            position: 2,
            name: `Food in ${canonicalCity.name}`,
            item: absoluteUrl(baseUrl, `/city/${encodeURIComponent(canonicalCity.slug)}/food`),
          }]
        : []),
      {
        "@type": "ListItem",
        position: canonicalCity ? 3 : 2,
        name,
        item: canonicalProfileUrl,
      },
    ],
  };

  return {
    title: `${name} Food Truck Location${cityState ? ` in ${cityState}` : ""} | MealScout`,
    description,
    canonicalPath,
    imageUrl: image,
    robots: hostIndexable
      ? PUBLIC_RESTAURANT_INDEXABLE_ROBOTS
      : PUBLIC_RESTAURANT_NOINDEX_ROBOTS,
    schema: [
      profilePageSchema,
      locationSchema,
      breadcrumbSchema,
      ...videoSchemas(baseUrl, videos, name),
    ],
    links: [
      { label: "Open location", href: canonicalPath },
      ...(canonicalCity
        ? [{
            label: `Food in ${canonicalCity.name}`,
            href: `/city/${encodeURIComponent(canonicalCity.slug)}/food`,
          }]
        : []),
      { label: "Host food trucks", href: "/parking-pass" },
      { label: "Explore nearby food", href: "/scout" },
    ],
    body: [
      locationTypeLabel ? `Location type: ${locationTypeLabel}` : "",
      cityState ? `Area: ${cityState}` : "",
      profileUpdatedAt
        ? `Public profile updated: ${profileUpdatedAt.slice(0, 10)}`
        : "",
      videos.length
        ? `${videos.length} public video${videos.length === 1 ? "" : "s"} available for this location.`
        : "",
    ].filter(Boolean),
  } satisfies PrerenderPage;
}

async function eventPage(baseUrl: string, eventId: string) {
  const [row] = await db
    .select({
      id: events.id,
      name: events.name,
      description: events.description,
      eventType: events.eventType,
      date: events.date,
      startTime: events.startTime,
      endTime: events.endTime,
      status: events.status,
      requiresPayment: events.requiresPayment,
      updatedAt: events.updatedAt,
      hostId: events.hostId,
      hostName: hosts.businessName,
      hostCity: hosts.city,
      hostState: hosts.state,
    })
    .from(events)
    .innerJoin(hosts, eq(events.hostId, hosts.id))
    .innerJoin(users, eq(hosts.userId, users.id))
    .where(and(eq(events.id, eventId), eq(users.isDisabled, false)))
    .limit(1);
  if (!row || row.eventType === "private_event" || row.requiresPayment) {
    return null;
  }
  if (
    !isPublicDiscoveryEligibleEntity({ name: row.name, isActive: true }) ||
    !isPublicDiscoveryEligibleEntity({ name: row.hostName, isActive: true })
  ) {
    return null;
  }
  const confirmedTrucks = filterPublicConfirmedEventTrucks(
    (await loadConfirmedEventTrucks([String(row.id)])).get(String(row.id)) ||
      [],
  );
  const primaryTruck = confirmedTrucks[0] || null;
  const timeZone = resolveCityTimeZoneSync({
    city: row.hostCity || null,
    state: row.hostState || null,
  });
  const eventInterval = buildSlotDateTimes({
    timeZone,
    date: row.date,
    startTime: String(row.startTime || ""),
    endTime: String(row.endTime || ""),
  });
  const slotIsPublic = Boolean(
    primaryTruck?.bookingConfirmedAt &&
    eventInterval &&
    isSlotPublic({
      slot: {
        source: "parking_pass_booking",
        status: "confirmed",
        startsAtUtc: eventInterval.startUtc,
        endsAtUtc: eventInterval.endUtc,
        lastConfirmedAtUtc: primaryTruck.bookingConfirmedAt,
      },
      ttlHours: 24 * 365 * 100,
    }),
  );
  if (
    !canExposeAnonymousEventDetail({
      eventType: row.eventType,
      requiresPayment: row.requiresPayment,
      status: row.status,
      slotIsPublic,
    })
  ) {
    return null;
  }

  const title = cleanText(
    row.name || row.hostName,
    "MealScout food truck event",
  );
  const cityState = [row.hostCity, row.hostState]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .join(", ");
  const canonicalPath = `/event/${encodeURIComponent(`${toSlug(title) || row.id}--${row.id}`)}`;
  const videos = await publicVideosFor("event", row.id);
  const description = cleanText(
    row.description,
    `${title}${cityState ? ` in ${cityState}` : ""} on MealScout. See event details, host location, and food truck availability.`,
  );
  const eventDate = eventInterval?.startUtc || null;
  const ended = eventInterval
    ? eventInterval.endUtc.getTime() < Date.now()
    : true;
  const eventIndexable =
    Boolean(primaryTruck?.isPublicIndexable) &&
    isPublicDiscoveryEligibleEntity({ name: row.hostName, isActive: true }) &&
    isPublicDiscoveryEligibleEntity({ name: row.name, isActive: true });

  return {
    title: `${title}${cityState ? ` in ${cityState}` : ""} | MealScout`,
    description,
    canonicalPath,
    imageUrl: videos[0]?.thumbnailUrl || defaultSocialImagePath,
    robots:
      ended || row.status === "cancelled" || !eventIndexable
        ? "noindex,follow"
        : "index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1",
    schema: [
      {
        "@context": "https://schema.org",
        "@type": "Event",
        name: title,
        description,
        url: absoluteUrl(baseUrl, canonicalPath),
        startDate: eventInterval?.startUtc.toISOString(),
        endDate: eventInterval?.endUtc.toISOString(),
        eventStatus:
          row.status === "cancelled"
            ? "https://schema.org/EventCancelled"
            : "https://schema.org/EventScheduled",
        location: {
          "@type": "Place",
          name: row.hostName || undefined,
          address: cityState || undefined,
        },
        performer:
          confirmedTrucks.length > 0
            ? confirmedTrucks.map((truck) => ({
                "@type": "FoodTruck",
                name: truck.name,
              }))
            : undefined,
      },
      ...videoSchemas(baseUrl, videos, title),
    ],
    links: [
      { label: "Open event", href: canonicalPath },
      { label: "Browse events", href: "/events" },
      { label: "Find food trucks", href: "/truck-discovery" },
    ],
    body: [
      eventDate
        ? `Date: ${new Intl.DateTimeFormat("en-US", {
            timeZone,
            year: "numeric",
            month: "long",
            day: "numeric",
          }).format(eventDate)}`
        : "",
      row.startTime && row.endTime
        ? `Time: ${row.startTime} - ${row.endTime}`
        : "",
      confirmedTrucks.length > 0
        ? `Confirmed truck${confirmedTrucks.length === 1 ? "" : "s"}: ${confirmedTrucks
            .map((truck) => truck.name)
            .join(", ")}`
        : "",
    ].filter(Boolean),
  } satisfies PrerenderPage;
}

async function dealPage(baseUrl: string, dealId: string) {
  const now = new Date();
  const [row] = await db
    .select({
      id: deals.id,
      title: deals.title,
      description: deals.description,
      imageUrl: deals.imageUrl,
      startDate: deals.startDate,
      endDate: deals.endDate,
      isActive: deals.isActive,
      discountValue: deals.discountValue,
      dealType: deals.dealType,
      restaurantId: deals.restaurantId,
      restaurantName: restaurants.name,
      city: restaurants.city,
      state: restaurants.state,
      cuisineType: restaurants.cuisineType,
      restaurantIsFoodTruck: restaurants.isFoodTruck,
      restaurantBusinessType: restaurants.businessType,
      restaurantIsActive: restaurants.isActive,
      restaurantOwnerId: restaurants.ownerId,
      restaurantOwnerEmail: users.email,
      restaurantOwnerDisabled: users.isDisabled,
      restaurantAddress: restaurants.address,
      restaurantDescription: restaurants.description,
      restaurantRawData: restaurants.rawData,
      restaurantPhone: restaurants.phone,
      restaurantWebsiteUrl: restaurants.websiteUrl,
    })
    .from(deals)
    .innerJoin(restaurants, eq(deals.restaurantId, restaurants.id))
    .innerJoin(users, eq(restaurants.ownerId, users.id))
    .where(eq(deals.id, dealId))
    .limit(1);
  if (!row || row.restaurantOwnerDisabled !== false) return null;
  const active =
    Boolean(row.isActive) &&
    (!row.startDate ||
      new Date(row.startDate as any).getTime() <= now.getTime()) &&
    (!row.endDate || new Date(row.endDate as any).getTime() >= now.getTime());
  const parentIndexable = isPublicSeoLandingRestaurantEligible({
    name: row.restaurantName,
    isActive: row.restaurantIsActive,
    ownerId: row.restaurantOwnerId,
    ownerEmail: row.restaurantOwnerEmail,
    address: row.restaurantAddress,
    cuisineType: row.cuisineType,
    description: row.restaurantDescription,
    city: row.city,
    state: row.state,
    rawData: row.restaurantRawData,
    phone: row.restaurantPhone,
    websiteUrl: row.restaurantWebsiteUrl,
    isFoodTruck: row.restaurantIsFoodTruck,
    businessType: row.restaurantBusinessType,
  });
  const titleEligible = isPublicDiscoveryEligibleEntity({
    name: row.title,
    isActive: true,
  });
  const title = cleanText(row.title, "MealScout food deal");
  const canonicalPath = `/deal/${encodeURIComponent(`${toSlug(title) || row.id}--${row.id}`)}`;
  const cityState = [row.city, row.state]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .join(", ");
  const description = cleanText(
    row.description,
    `${title} from ${row.restaurantName || "a local MealScout restaurant"}${cityState ? ` in ${cityState}` : ""}.`,
  );

  return {
    title: `${title} - ${row.restaurantName || "MealScout"} | MealScout`,
    description,
    canonicalPath,
    imageUrl: row.imageUrl || defaultSocialImagePath,
    robots: active && parentIndexable && titleEligible
      ? "index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1"
      : "noindex,follow",
    schema: {
      "@context": "https://schema.org",
      "@type": "Offer",
      name: title,
      description,
      url: absoluteUrl(baseUrl, canonicalPath),
      image: absoluteUrl(baseUrl, row.imageUrl || defaultSocialImagePath),
      validFrom: row.startDate
        ? new Date(row.startDate as any).toISOString()
        : undefined,
      validThrough: row.endDate
        ? new Date(row.endDate as any).toISOString()
        : undefined,
      availability: active
        ? "https://schema.org/InStock"
        : "https://schema.org/OutOfStock",
      offeredBy: {
        "@type": "Restaurant",
        name: row.restaurantName || undefined,
        servesCuisine: row.cuisineType || undefined,
      },
    },
    links: [
      { label: "Open deal", href: canonicalPath },
      { label: "Featured deals", href: "/deals/featured" },
      { label: "Find food nearby", href: "/search" },
    ],
    body: [
      row.restaurantName ? `Restaurant: ${row.restaurantName}` : "",
      cityState ? `Area: ${cityState}` : "",
      row.discountValue
        ? `Discount: ${row.discountValue}${row.dealType === "percentage" ? "% off" : " off"}`
        : "",
    ].filter(Boolean),
  } satisfies PrerenderPage;
}

async function jobPage(_baseUrl: string, _jobId: string) {
  return null;
}

async function supplierPage(baseUrl: string, supplierId: string) {
  const [row] = await db
    .select()
    .from(suppliers)
    .where(eq(suppliers.id, supplierId))
    .limit(1);
  if (!row || !row.isActive) return null;
  const ownerProfile = await resolveOwnerPublicProfile(row.userId);
  if (
    !ownerProfile.ownerEnabled ||
    !isPublicBusinessVisible({
      name: row.businessName,
      city: row.city,
      state: row.state,
      description: [row.onlinePaymentsNotes, row.deliveryNotes]
        .filter(Boolean)
        .join(" "),
    })
  ) {
    return null;
  }
  const publicProfile = toPublicSupplierProfile({
    row,
    activeProductCount: 0,
    baseUrl,
    showAddress: ownerProfile.showAddress,
    showContact: ownerProfile.showContact,
  });
  const name = cleanText(row.businessName, "MealScout supplier");
  const isSyntheticTestEntity = isSyntheticPublicEntityName(name);
  const cityState = [row.city, row.state]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .join(", ");
  const canonicalCity = await resolveCanonicalProfileCity({
    city: row.city,
    state: row.state,
  });
  const canonicalPath = `/supplier/${encodeURIComponent(`${toSlug(name) || row.id}--${row.id}`)}`;
  const canonicalProfileUrl = absoluteUrl(baseUrl, canonicalPath);
  const profileEntityId = `${canonicalProfileUrl}#supplier`;
  const profilePageId = `${canonicalProfileUrl}#webpage`;
  const profileUpdatedAt = isoDate(row.updatedAt);
  const description = `${name}${cityState ? ` in ${cityState}` : ""} is listed on MealScout Supply Scout for food businesses and operators.`;
  const supplierSchema = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    "@id": profileEntityId,
    name,
    description,
    url: canonicalProfileUrl,
    mainEntityOfPage: { "@id": profilePageId },
    telephone: publicProfile.phonePublic || undefined,
    sameAs: [publicProfile.websiteUrl].filter(Boolean),
    address: {
      "@type": "PostalAddress",
      streetAddress: publicProfile.addressPublicLabel
        ? row.address || undefined
        : undefined,
      addressLocality: row.city || undefined,
      addressRegion: row.state || undefined,
      addressCountry: "US",
    },
  };
  const profilePageSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": profilePageId,
    name: `${name}${cityState ? ` in ${cityState}` : ""} | MealScout Supplier`,
    description,
    url: canonicalProfileUrl,
    dateModified: profileUpdatedAt,
    mainEntity: { "@id": profileEntityId },
    isPartOf: { "@type": "WebSite", name: "MealScout", url: baseUrl },
  };
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "MealScout", item: baseUrl },
      { "@type": "ListItem", position: 2, name: "Suppliers", item: absoluteUrl(baseUrl, "/suppliers") },
      { "@type": "ListItem", position: 3, name, item: canonicalProfileUrl },
    ],
  };

  return {
    title: `${name}${cityState ? ` in ${cityState}` : ""} | MealScout Supplier`,
    description,
    canonicalPath,
    imageUrl: publicProfile.logoUrl || defaultSocialImagePath,
    robots: isSyntheticTestEntity ? noindexRobots : indexableRobots,
    schema: [profilePageSchema, supplierSchema, breadcrumbSchema],
    links: [
      { label: "Open supplier", href: canonicalPath },
      { label: "Browse suppliers", href: "/suppliers" },
      ...(canonicalCity
        ? [{
            label: `Food in ${canonicalCity.name}`,
            href: `/city/${encodeURIComponent(canonicalCity.slug)}/food`,
          }]
        : []),
    ],
    body: [
      cityState ? `Area: ${cityState}` : "",
      profileUpdatedAt
        ? `Public profile updated: ${profileUpdatedAt.slice(0, 10)}`
        : "",
      row.offersDelivery ? "Delivery available" : "",
    ].filter(Boolean),
  } satisfies PrerenderPage;
}

async function seoLandingPage(
  baseUrl: string,
  input: PublicSeoLandingRequest & {
    links: PageLink[];
  },
  loadLanding: typeof loadPublicSeoLandingData = loadPublicSeoLandingData,
) {
  const resolution = await loadLanding(input);
  if (resolution.kind === "not_found") return null;

  const { payload } = resolution;
  const listing = projectPublicSeoLandingForHtml(payload, input.links);
  const containsSyntheticPathSegment = payload.page.canonicalPath
    .split("/")
    .some((segment) => isSyntheticPublicEntityName(segment));

  return {
    title: `${payload.page.title} | MealScout`,
    description: payload.page.description,
    canonicalPath: payload.page.canonicalPath,
    imageUrl: payload.page.ogImage,
    robots:
      containsSyntheticPathSegment || payload.total === 0
        ? noindexRobots
        : indexableRobots,
    schema: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: payload.page.title,
      description: payload.page.description,
      url: absoluteUrl(baseUrl, payload.page.canonicalPath),
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: payload.total,
        itemListElement: payload.items.map((item, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: item.displayName,
          url: absoluteUrl(baseUrl, item.profilePath),
          description: item.summary || undefined,
          item: {
            "@type": item.profileType === "truck"
              ? "FoodTruck"
              : item.profileType === "bar"
                ? "BarOrPub"
                : "LocalBusiness",
            name: item.displayName,
            url: absoluteUrl(baseUrl, item.profilePath),
            address: item.city || item.state
              ? {
                  "@type": "PostalAddress",
                  addressLocality: item.city || undefined,
                  addressRegion: item.state || undefined,
                }
              : undefined,
          },
        })),
      },
    },
    links: listing.links,
    body: listing.body,
    listingHtml: listing.listingHtml,
  } satisfies PrerenderPage;
}

const sendPage = (
  baseUrl: string,
  res: Response,
  page: PrerenderPage | null,
) => {
  if (!page) {
    res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      '<!DOCTYPE html><html><head><title>Not found | MealScout</title><meta name="robots" content="noindex,follow"></head><body>Not found</body></html>',
    );
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Owner disable/privacy changes must revoke public HTML, JSON-LD, address,
  // and contact data on the next request; do not retain profile pages in a
  // browser or shared cache.
  res.setHeader("Cache-Control", "no-store");
  res.send(buildHtml(baseUrl, page));
};

const sendPrerenderUnavailable = (res: Response) => {
  res
    .status(503)
    .setHeader("Content-Type", "text/html; charset=utf-8")
    .setHeader("Retry-After", "60")
    .setHeader("Cache-Control", "no-store")
    .setHeader("X-Robots-Tag", "noindex,follow")
    .send(
      '<!DOCTYPE html><html><head><title>Temporarily unavailable | MealScout</title><meta name="robots" content="noindex,follow"></head><body>Temporarily unavailable</body></html>',
    );
};

/**
 * Public discovery profile routes serve entity SSR HTML for every GET, not only
 * crawler UAs. Authenticated app surfaces (/admin, /dashboard, etc.) are not
 * registered here and keep the SPA / auth interstitial path.
 */
export function registerPublicProfilePrerenderRoutes(
  app: Express,
  canonicalBaseUrl: string,
  loadLanding: typeof loadPublicSeoLandingData = loadPublicSeoLandingData,
  dependencies: {
    restaurantPage?: typeof restaurantPage;
    sendPage?: typeof sendPage;
  } = {},
) {
  const loadRestaurantPage = dependencies.restaurantPage || restaurantPage;
  const renderPage = dependencies.sendPage || sendPage;
  const gate =
    (handler: (req: Request) => Promise<PrerenderPage | null>) =>
    async (req: Request, res: Response) => {
      try {
        renderPage(canonicalBaseUrl, res, await handler(req));
      } catch (error) {
        console.error("[seo-prerender] failed", error);
        sendPrerenderUnavailable(res);
      }
    };

  // Search engines retain old MealScout profile URLs after a business changes
  // classification (restaurant -> truck, truck -> restaurant, etc.). Preserve
  // that accumulated discovery authority by redirecting a stale typed URL to
  // the entity's current canonical profile instead of returning a dead 404.
  const canonicalRestaurantGate =
    (
      expectedProfileType:
        | "restaurant"
        | "truck"
        | "bar"
        | "caterer"
        | "private_chef",
      idFromRequest: (req: Request) => string,
    ) =>
    async (req: Request, res: Response) => {
      try {
        const id = idFromRequest(req);
        const expected = await loadRestaurantPage(
          canonicalBaseUrl,
          id,
          expectedProfileType,
        );
        if (expected) {
          return renderPage(canonicalBaseUrl, res, expected);
        }

        const current = await loadRestaurantPage(canonicalBaseUrl, id);
        if (current) {
          return safeCanonicalRedirect(req, res, current);
        }

        return renderPage(canonicalBaseUrl, res, null);
      } catch (error) {
        console.error("[seo-prerender] canonical profile recovery failed", error);
        return sendPrerenderUnavailable(res);
      }
    };

  const legacyProfileRedirectQuery = (req: Request) =>
    legacyCityDealRedirectQuery(req);

  const safeCanonicalRedirect = (
    req: Request,
    res: Response,
    page: PrerenderPage,
    preserveAttribution = false,
  ) => {
    const target =
      page.canonicalPath +
      (preserveAttribution ? legacyProfileRedirectQuery(req) : "");
    const incomingPath = String(req.path || "").replace(/\/+$/, "") || "/";
    const targetPath = page.canonicalPath.replace(/\/+$/, "") || "/";
    if (incomingPath === targetPath) {
      return renderPage(canonicalBaseUrl, res, null);
    }
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("X-Robots-Tag", "noindex,follow");
    return res.redirect(308, target);
  };

  const landingGate =
    (handler: (req: Request) => Promise<PrerenderPage | null>) =>
    async (req: Request, res: Response) => {
      try {
        renderPage(canonicalBaseUrl, res, await handler(req));
      } catch (error) {
        console.error("[seo-prerender] landing page failed", error);
        sendPrerenderUnavailable(res);
      }
    };

  const restaurantDetailGate = canonicalRestaurantGate(
    "restaurant",
    (req) => extractId(req.params.id),
  );
  app.get(
    "/restaurant/:id/:slug",
    (req: Request, res: Response, next: NextFunction) => {
      if (String(req.params.slug || "").trim().toLowerCase() === "reviews") {
        res.setHeader("X-Robots-Tag", "noindex,nofollow,noarchive");
        return next();
      }
      return restaurantDetailGate(req, res);
    },
  );
  app.get(
    "/restaurant/:id",
    (req: Request, res: Response, next: NextFunction) => {
      if (String(req.params.id || "").trim().toLowerCase() === "dashboard") {
        return next();
      }
      return restaurantDetailGate(req, res);
    },
  );
  app.get(
    "/truck/:slug",
    canonicalRestaurantGate(
      "truck",
      (req) => extractId(req.params.slug),
    ),
  );
  app.get(
    "/bar/:slug",
    canonicalRestaurantGate(
      "bar",
      (req) => extractId(req.params.slug),
    ),
  );
  app.get(
    "/caterer/:slug",
    canonicalRestaurantGate(
      "caterer",
      (req) => extractId(req.params.slug),
    ),
  );
  app.get(
    "/private-chef/:slug",
    canonicalRestaurantGate(
      "private_chef",
      (req) => extractId(req.params.slug),
    ),
  );
  app.get("/chef/:slug", async (req: Request, res: Response) => {
    try {
      const page = await loadRestaurantPage(
        canonicalBaseUrl,
        extractId(req.params.slug),
        "private_chef",
      );
      if (!page) {
        return renderPage(canonicalBaseUrl, res, null);
      }
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.redirect(308, page.canonicalPath);
    } catch (error) {
      console.error("[seo-prerender] legacy chef redirect failed", error);
      return sendPrerenderUnavailable(res);
    }
  });
  app.get(
    "/location/:slug",
    gate((req) => hostPage(canonicalBaseUrl, extractId(req.params.slug))),
  );
  const eventDetailGate = gate((req) =>
    eventPage(canonicalBaseUrl, extractId(req.params.slug)),
  );
  app.get(
    "/event/:slug",
    (req: Request, res: Response, next: NextFunction) => {
      // Paid event facts stay unavailable to anonymous HTML requests. An
      // authenticated navigation may continue to the SPA shell; the private
      // event API still requires exact manageParkingPass authorization.
      if (req.isAuthenticated?.()) {
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("X-Robots-Tag", "noindex,nofollow,noarchive");
        return next();
      }
      return eventDetailGate(req, res);
    },
  );
  app.get(
    "/events/:slug",
    (req: Request, res: Response, next: NextFunction) => {
      if (String(req.params.slug || "").trim().toLowerCase() === "public") {
        return next();
      }
      return eventDetailGate(req, res);
    },
  );
  app.get(
    "/deals/:city",
    (req: Request, res: Response, next: NextFunction) => {
      const citySlug = toSlug(req.params.city);
      if (!citySlug || citySlug === "featured") return next();
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.redirect(
        308,
        `/deals-today/${encodeURIComponent(citySlug)}${legacyCityDealRedirectQuery(req)}`,
      );
    },
  );
  app.get(
    "/deal/:slug",
    gate((req) => dealPage(canonicalBaseUrl, extractId(req.params.slug))),
  );
  app.get(
    ["/jobs/:jobId", "/jobs/:jobId/:jobSlug"],
    gate((req) => jobPage(canonicalBaseUrl, extractId(req.params.jobId))),
  );
  const supplierDetailGate = gate((req) =>
      supplierPage(
        canonicalBaseUrl,
        extractId(req.params.slug || req.params.supplierId),
      ),
    );
  app.get("/suppliers/:supplierId", supplierDetailGate);
  app.get(
    "/supplier/:slug",
    (req: Request, res: Response, next: NextFunction) => {
      if (String(req.params.slug || "").trim().toLowerCase() === "dashboard") {
        return next();
      }
      return supplierDetailGate(req, res);
    },
  );
  app.get(
    ["/p/:profileType/:profileId", "/p/:profileType/:profileId/:profileSlug"],
    async (req: Request, res: Response) => {
      try {
        const type = String(req.params.profileType || "").toLowerCase();
        const id = extractId(req.params.profileId);
        let page: PrerenderPage | null = null;
        if (type === "restaurant") {
          page = await loadRestaurantPage(canonicalBaseUrl, id, "restaurant");
        } else if (type === "food_truck" || type === "truck") {
          page = await loadRestaurantPage(canonicalBaseUrl, id, "truck");
        } else if (type === "bar") {
          page = await loadRestaurantPage(canonicalBaseUrl, id, "bar");
        } else if (type === "caterer") {
          page = await loadRestaurantPage(canonicalBaseUrl, id, "caterer");
        } else if (
          type === "private_chef" ||
          type === "private-chef" ||
          type === "chef"
        ) {
          page = await loadRestaurantPage(canonicalBaseUrl, id, "private_chef");
        } else if (type === "host" || type === "location") {
          page = await hostPage(canonicalBaseUrl, id);
        } else if (type === "supplier") {
          page = await supplierPage(canonicalBaseUrl, id);
        } else if (type === "event") {
          page = await eventPage(canonicalBaseUrl, id);
        }

        // /p/... is a legacy public identity shape. If the entity is still
        // public, consolidate every surviving legacy URL onto its canonical
        // profile so search engines transfer signals instead of indexing two
        // competing URL forms.
        if (page) {
          return safeCanonicalRedirect(req, res, page, true);
        }

        // A restaurant-table entity may have changed type since the legacy URL
        // was indexed. Retry without the historical type before declaring it
        // missing.
        if (
          ["restaurant", "food_truck", "truck", "bar", "caterer", "private_chef", "private-chef", "chef"].includes(type)
        ) {
          const current = await loadRestaurantPage(canonicalBaseUrl, id);
          if (current) {
            return safeCanonicalRedirect(req, res, current, true);
          }
        }

        return renderPage(canonicalBaseUrl, res, null);
      } catch (error) {
        console.error("[seo-prerender] legacy profile recovery failed", error);
        return sendPrerenderUnavailable(res);
      }
    },
  );
  app.get(
    "/food-trucks/:city/:cuisine",
    landingGate((req) =>
      seoLandingPage(
        canonicalBaseUrl,
        {
          ...publicSeoFoodTruckCuisineRequest(
            req.params.city,
            req.params.cuisine,
          ),
          links: [
            {
              label: "List or claim your food truck",
              href: "/for-food-trucks",
            },
            {
              label: "All food trucks in this city",
              href: `/food-trucks/${encodeURIComponent(String(req.params.city ?? ""))}`,
            },
          ],
        },
        loadLanding,
      ),
    ),
  );
  app.get(
    "/food-trucks/:city",
    landingGate((req) =>
      seoLandingPage(
        canonicalBaseUrl,
        {
          ...publicSeoCityRequest("food-trucks", req.params.city),
          links: [
            {
              label: "List or claim your food truck",
              href: "/for-food-trucks",
            },
            {
              label: "Food trucks today",
              href: `/food-trucks-today/${encodeURIComponent(String(req.params.city || ""))}`,
            },
            {
              label: "Open Scout",
              href: "/scout",
            },
          ],
        },
        loadLanding,
      ),
    ),
  );
  app.get(
    "/food-trucks-today/:city",
    landingGate((req) =>
      seoLandingPage(
        canonicalBaseUrl,
        {
          ...publicSeoCityRequest("food-trucks-today", req.params.city),
          links: [
            {
              label: "List or claim your food truck",
              href: "/for-food-trucks",
            },
            {
              label: "Open city food",
              href: `/city/${encodeURIComponent(String(req.params.city || ""))}/food`,
            },
          ],
        },
        loadLanding,
      ),
    ),
  );
  app.get(
    "/food-truck-catering/:city",
    landingGate((req) =>
      seoLandingPage(
        canonicalBaseUrl,
        {
          ...publicSeoCityRequest("food-truck-catering", req.params.city),
          links: [
            {
              label: "Book a food truck",
              href: `/book-food-truck/${encodeURIComponent(String(req.params.city || ""))}`,
            },
            {
              label: "Browse food trucks in this city",
              href: `/food-trucks/${encodeURIComponent(String(req.params.city || ""))}`,
            },
            {
              label: "List or claim your food truck",
              href: "/for-food-trucks",
            },
          ],
        },
        loadLanding,
      ),
    ),
  );
  app.get(
    "/book-food-truck/:city",
    landingGate((req) =>
      seoLandingPage(
        canonicalBaseUrl,
        {
          ...publicSeoCityRequest("book-food-truck", req.params.city),
          links: [
            {
              label: "Food truck catering",
              href: `/food-truck-catering/${encodeURIComponent(String(req.params.city || ""))}`,
            },
            {
              label: "Browse food trucks in this city",
              href: `/food-trucks/${encodeURIComponent(String(req.params.city || ""))}`,
            },
            {
              label: "List or claim your food truck",
              href: "/for-food-trucks",
            },
          ],
        },
        loadLanding,
      ),
    ),
  );
  app.get(
    "/deals-today/:city",
    landingGate((req) =>
      seoLandingPage(
        canonicalBaseUrl,
        {
          ...publicSeoCityRequest("deals-today", req.params.city),
          links: [
            {
              label: "Open city food",
              href: `/city/${encodeURIComponent(String(req.params.city || ""))}/food`,
            },
          ],
        },
        loadLanding,
      ),
    ),
  );
  app.get(
    "/events-today/:city",
    landingGate((req) =>
      seoLandingPage(
        canonicalBaseUrl,
        {
          ...publicSeoCityRequest("events-today", req.params.city),
          links: [{ label: "Explore nearby food", href: "/scout" }],
        },
        loadLanding,
      ),
    ),
  );
  app.get(
    "/city/:city/food",
    landingGate((req) =>
      seoLandingPage(
        canonicalBaseUrl,
        {
          ...publicSeoCityRequest("city", req.params.city),
          links: [
            {
              label: "Food trucks today",
              href: `/food-trucks-today/${encodeURIComponent(String(req.params.city || ""))}`,
            },
            {
              label: "Deals today",
              href: `/deals-today/${encodeURIComponent(String(req.params.city || ""))}`,
            },
            {
              label: "Events today",
              href: `/events-today/${encodeURIComponent(String(req.params.city || ""))}`,
            },
          ],
        },
        loadLanding,
      ),
    ),
  );
  app.get(
    "/cuisine/:cuisine/:city?",
    async (req: Request, res: Response) => {
      try {
        const page = await seoLandingPage(
          canonicalBaseUrl,
          {
            ...publicSeoCuisineRequest(req.params.cuisine, req.params.city),
            links:
              req.params.city === undefined
                ? [{ label: "Open search", href: "/search" }]
                : [
                    {
                      label: "Open city food",
                      href: `/city/${encodeURIComponent(String(req.params.city))}/food`,
                    },
                  ],
          },
          loadLanding,
        );
        if (page) {
          return renderPage(canonicalBaseUrl, res, page);
        }

        // Historical global cuisine URLs were broadly published before cuisine
        // membership became evidence-backed. Retire empty legacy URLs as Gone
        // so crawlers stop spending budget retrying permanent dead ends.
        res
          .status(410)
          .setHeader("Content-Type", "text/html; charset=utf-8")
          .setHeader("Cache-Control", "public, max-age=300")
          .setHeader("X-Robots-Tag", "noindex,follow");
        return res.send(
          '<!DOCTYPE html><html><head><title>Gone | MealScout</title><meta name="robots" content="noindex,follow"></head><body>This discovery page is no longer published.</body></html>',
        );
      } catch (error) {
        console.error("[seo-prerender] cuisine recovery failed", error);
        return sendPrerenderUnavailable(res);
      }
    },
  );
  app.get(
    "/locations-with-trucks/:city",
    landingGate((req) =>
      seoLandingPage(
        canonicalBaseUrl,
        {
          ...publicSeoCityRequest(
            "locations-with-trucks",
            req.params.city,
          ),
          links: [
            {
              label: "Open city food",
              href: `/city/${encodeURIComponent(String(req.params.city || ""))}/food`,
            },
          ],
        },
        loadLanding,
      ),
    ),
  );
}
