import { useEffect } from "react";

interface SEOHeadProps {
  title: string;
  description: string;
  keywords?: string;
  canonicalUrl?: string;
  ogImage?: string;
  ogType?: string;
  schemaData?: object;
  noIndex?: boolean;
}

const TRACKING_QUERY_KEYS = new Set([
  "ref",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "msclkid",
  "twclid",
  "dclid",
  "yclid",
  "mc_cid",
  "mc_eid",
]);

const PRIVATE_NOINDEX_PREFIXES = [
  "/admin",
  "/staff",
  "/profile",
  "/settings",
  "/orders",
  "/favorites",
  "/user-dashboard",
  "/restaurant-owner-dashboard",
  "/owner-ai",
  "/host/dashboard",
  "/event-coordinator/dashboard",
  "/supplier/dashboard",
  "/account-setup",
];

export function SEOHead({
  title,
  description,
  keywords,
  canonicalUrl,
  ogImage = "/og-default.jpg",
  ogType = "website",
  schemaData,
  noIndex = false
}: SEOHeadProps) {
  useEffect(() => {
    // Set page title
    document.title = title;

    // Helper function to set meta tag
    const setMetaTag = (name: string, content: string, isProperty = false) => {
      const attribute = isProperty ? "property" : "name";
      let meta = document.querySelector(`meta[${attribute}="${name}"]`);
      if (!meta) {
        meta = document.createElement("meta");
        meta.setAttribute(attribute, name);
        document.head.appendChild(meta);
      }
      meta.setAttribute("content", content);
    };
    const removeMetaTag = (name: string, isProperty = false) => {
      const attribute = isProperty ? "property" : "name";
      const meta = document.querySelector(`meta[${attribute}="${name}"]`);
      if (meta) {
        meta.remove();
      }
    };

    // Set canonical URL
    const setCanonical = (url: string) => {
      let link = document.querySelector('link[rel="canonical"]');
      if (!link) {
        link = document.createElement("link");
        link.setAttribute("rel", "canonical");
        document.head.appendChild(link);
      }
      link.setAttribute("href", url);
    };

    const resolveCanonicalUrl = (url?: string) => {
      if (!url) return "";
      if (typeof window === "undefined") return url;

      const absolute = url.startsWith("http")
        ? new URL(url)
        : new URL(url, window.location.origin);

      // Keep functional query params (e.g. search?q=...) but remove tracking params
      // so affiliate/share URLs don't fragment indexation.
      const cleanedParams = new URLSearchParams();
      absolute.searchParams.forEach((value, key) => {
        if (!TRACKING_QUERY_KEYS.has(key.toLowerCase())) {
          cleanedParams.append(key, value);
        }
      });
      absolute.search = cleanedParams.toString()
        ? `?${cleanedParams.toString()}`
        : "";
      absolute.hash = "";
      absolute.protocol = "https:";
      absolute.hostname = "www.mealscout.us";
      return absolute.toString();
    };

    const resolvedCanonical = resolveCanonicalUrl(
      canonicalUrl ||
        (typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : undefined),
    );
    const currentPath =
      typeof window !== "undefined"
        ? window.location.pathname.toLowerCase()
        : "";
    const currentSearchParams =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : new URLSearchParams();
    const autoNoIndex =
      PRIVATE_NOINDEX_PREFIXES.some((prefix) => currentPath.startsWith(prefix)) ||
      Array.from(currentSearchParams.keys()).some((key) =>
        TRACKING_QUERY_KEYS.has(String(key).toLowerCase()),
      );
    const effectiveNoIndex = noIndex || autoNoIndex;

    const resolveOgImage = (imageUrl: string) => {
      if (!imageUrl) return "";
      if (imageUrl.startsWith("http")) return imageUrl;
      if (typeof window === "undefined") return imageUrl;
      return `${window.location.origin}${imageUrl.startsWith("/") ? "" : "/"}${imageUrl}`;
    };

    const resolvedOgImage = ogImage ? resolveOgImage(ogImage) : "";

    // Basic meta tags
    setMetaTag("description", description);
    // The legacy keywords tag is ignored by modern search engines and can
    // produce misleading SEO audit warnings, so we explicitly remove it.
    removeMetaTag("keywords");
    
    // Robots meta
    if (effectiveNoIndex) {
      setMetaTag("robots", "noindex, nofollow");
    } else {
      setMetaTag(
        "robots",
        "index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1"
      );
    }

    // Open Graph tags
    setMetaTag("og:title", title, true);
    setMetaTag("og:description", description, true);
    setMetaTag("og:type", ogType, true);
    setMetaTag("og:site_name", "MealScout", true);
    if (resolvedOgImage) {
      setMetaTag("og:image", resolvedOgImage, true);
    }
    if (resolvedCanonical) {
      setMetaTag("og:url", resolvedCanonical, true);
      setCanonical(resolvedCanonical);
    }

    // Twitter Card tags
    setMetaTag("twitter:card", "summary_large_image");
    setMetaTag("twitter:title", title);
    setMetaTag("twitter:description", description);
    setMetaTag("twitter:site", "@mealscout");
    if (resolvedOgImage) {
      setMetaTag("twitter:image", resolvedOgImage);
    }

    // Structured data (JSON-LD)
    let pageSchema: HTMLScriptElement | null = null;
    if (schemaData) {
      // Remove any existing page-specific schema
      const existingPageSchema = document.querySelector('script[type="application/ld+json"][data-page-schema="true"]');
      if (existingPageSchema) {
        existingPageSchema.remove();
      }
      
      // Create new page-specific schema
      pageSchema = document.createElement("script");
      pageSchema.setAttribute("type", "application/ld+json");
      pageSchema.setAttribute("data-page-schema", "true");
      pageSchema.textContent = JSON.stringify(schemaData);
      document.head.appendChild(pageSchema);
    }

    // Cleanup function
    return () => {
      // Route changes and failed/private reads must not retain the previous
      // public entity's structured data in the shared document head.
      pageSchema?.remove();
    };
  }, [title, description, keywords, canonicalUrl, ogImage, ogType, schemaData, noIndex]);

  return null; // This component doesn't render anything
}

