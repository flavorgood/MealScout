import type { Express, Request, Response, NextFunction } from "express";

import { buildJsonLdScript } from "./jsonLdScript";
import { roleAcquisitionGuides, type RoleAcquisitionGuide } from "../../shared/roleAcquisitionContent";

type AcquisitionPageConfig = {
  path: string;
  title: string;
  description: string;
  h1: string;
  body: string[];
  ctaLinks: Array<{ label: string; href: string }>;
  schemaType: "ProfessionalService" | "LocalBusiness";
  guide?: RoleAcquisitionGuide;
};

const BOT_UA_PATTERN =
  /(bot|crawler|spider|slurp|googlebot|bingbot|duckduckbot|applebot|gptbot|oai-searchbot|chatgpt-user|claudebot|anthropic-ai|perplexitybot|bytespider|ccbot|cohere-ai)/i;

export const shouldServePrerender = (req: Request) => {
  const force = String(req.query?.prerender || "").toLowerCase();
  if (force === "1" || force === "true") return true;
  const ua = String(req.get("user-agent") || "");
  return BOT_UA_PATTERN.test(ua);
};

const escapeHtml = (value: string) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const buildPageHtml = (
  canonicalBaseUrl: string,
  page: AcquisitionPageConfig,
) => {
  const canonical = `${canonicalBaseUrl}${page.path}`;
  const schema = {
    "@context": "https://schema.org",
    "@type": page.schemaType,
    name: "MealScout",
    url: canonical,
    description: page.description,
    areaServed: "United States",
    serviceType:
      page.path === "/for-restaurants"
        ? "Restaurant local discovery"
        : page.path === "/for-food-trucks"
          ? "Food truck profiles, schedules, and discovery"
        : "Host location marketplace for food trucks",
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(page.title)}</title>
  <meta name="description" content="${escapeHtml(page.description)}">
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <meta property="og:title" content="${escapeHtml(page.title)}">
  <meta property="og:description" content="${escapeHtml(page.description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  <meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1">
  ${buildJsonLdScript(schema)}
  <style>
    body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif; margin: 0; background: #fffaf2; color: #111827; }
    main { max-width: 840px; margin: 0 auto; padding: 28px 18px 44px; }
    h1 { font-size: 32px; margin: 0 0 14px; }
    p { line-height: 1.6; margin: 0 0 14px; }
    .card { background: #ffffff; border: 1px solid #fed7aa; border-radius: 14px; padding: 16px; margin-top: 16px; }
    .links a { display: inline-block; margin: 8px 10px 0 0; color: #9a3412; text-decoration: none; font-weight: 600; }
    .links a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(page.h1)}</h1>
    ${page.body.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n")}
    ${page.guide ? `
      <p class="links"><a href="${escapeHtml(page.guide.listingLink.href)}">${escapeHtml(page.guide.listingLink.label)}</a></p>
      ${page.guide.sections.map(section => `<section class="card"><h2>${escapeHtml(section.title)}</h2>${section.paragraphs.map(paragraph => `<p>${escapeHtml(paragraph)}</p>`).join("\n")}</section>`).join("\n")}
      ${page.guide.examples.map(example => `<section class="card"><h2>${escapeHtml(example.title)}</h2><p>${escapeHtml(example.copy)}</p></section>`).join("\n")}
      <section class="card"><h2>Questions before you get started</h2>${page.guide.questions.map(item => `<h3>${escapeHtml(item.question)}</h3><p>${escapeHtml(item.answer)}</p>`).join("\n")}</section>
    ` : ""}
    <div class="card">
      <strong>Important links</strong>
      <div class="links">
        ${page.ctaLinks
          .map(
            (link) =>
              `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`,
          )
          .join("\n")}
      </div>
    </div>
  </main>
</body>
</html>`;
};

export function registerAcquisitionPrerenderRoutes(
  app: Express,
  canonicalBaseUrl: string,
) {
  const pages: AcquisitionPageConfig[] = [
    {
      path: "/for-restaurants",
      title: "MealScout for Restaurants",
      description:
        "MealScout helps restaurants publish complete local profiles, menus, specials, and current business information.",
      h1: "Help local diners find your restaurant",
      body: [
        "MealScout gives restaurant owners a public profile for menus, photos, hours, and specials.",
        "Keep your information current so local diners can understand what you serve before they visit.",
        "The complete profile tools require no card and do not become a monthly bill. Separate paid transactions show their charges before payment.",
      ],
      ctaLinks: [
        { label: "List a Restaurant", href: "/restaurant-signup?businessType=restaurant&intent=create&source=for-restaurants" },
        { label: "For Food Trucks", href: "/for-food-trucks" },
        { label: "Scout Local Dashboard", href: "/scout" },
        { label: "Sitemap", href: "/sitemap" },
      ],
      schemaType: "ProfessionalService",
    },
    {
      path: "/for-food-trucks",
      title: roleAcquisitionGuides.truck.title,
      description: roleAcquisitionGuides.truck.description,
      h1: roleAcquisitionGuides.truck.headline,
      body: [roleAcquisitionGuides.truck.intro],
      guide: roleAcquisitionGuides.truck,
      ctaLinks: [
        roleAcquisitionGuides.truck.listingLink,
        ...roleAcquisitionGuides.truck.relatedLinks,
        { label: "Find Food Trucks", href: "/scout" },
        { label: "Sitemap", href: "/sitemap" },
      ],
      schemaType: "ProfessionalService",
    },
    {
      path: "/for-hosts",
      title: roleAcquisitionGuides.hosts.title,
      description: roleAcquisitionGuides.hosts.description,
      h1: roleAcquisitionGuides.hosts.headline,
      body: [roleAcquisitionGuides.hosts.intro],
      guide: roleAcquisitionGuides.hosts,
      ctaLinks: [
        roleAcquisitionGuides.hosts.listingLink,
        ...roleAcquisitionGuides.hosts.relatedLinks,
        { label: "Explore nearby food", href: "/scout" },
        { label: "Sitemap", href: "/sitemap" },
      ],
      schemaType: "LocalBusiness",
    },
    {
      path: "/host-location-partner",
      title: "Host Location Partner Request | MealScout",
      description:
        "Apply to become a MealScout host location if your business has truck-friendly parking space and wants recurring bookings.",
      h1: "Apply to become a MealScout host location partner",
      body: [
        "If your business has available parking, you can qualify as a MealScout host location.",
        "We work with non-food businesses that want to attract foot traffic and earn recurring revenue from hosted food truck bookings.",
        "Submit your location and our team will validate fit, setup readiness, and booking potential.",
      ],
      ctaLinks: [
        { label: "Start Host Application", href: "/host-location-partner" },
        { label: "For Hosts Overview", href: "/for-hosts" },
        { label: "For Restaurants", href: "/for-restaurants" },
        { label: "Sitemap", href: "/sitemap" },
      ],
      schemaType: "LocalBusiness",
    },
  ];

  for (const page of pages) {
    app.get(page.path, (req: Request, res: Response, next: NextFunction) => {
      if (!shouldServePrerender(req)) {
        return next();
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=1800");
      res.send(buildPageHtml(canonicalBaseUrl, page));
    });
  }
}
