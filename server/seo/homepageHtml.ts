import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import Welcome from "../../client/src/pages/welcome";
import { TRACKING_QUERY_KEYS } from "../../client/src/components/seo-head";
import { WELCOME_CONTENT } from "../../shared/welcomeContent";

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Render the existing native Welcome, keeping its styles, background and links.
// The original template retains the normal App scripts and compiled asset base.
// No owner, session, business record or API/provider is read during this render.
export function renderHomepageHtml(
  template: string,
  canonicalBaseUrl: string,
  requestUrl = "/",
  forceNoIndex = false,
) {
  if (!/<div\s+id=["']root["']\s*>\s*<\/div>/.test(template)) {
    throw new Error("Native homepage template has no empty application root");
  }
  const url = new URL(requestUrl, "https://www.mealscout.us");
  const noIndex = forceNoIndex || Array.from(url.searchParams.keys()).some(key => TRACKING_QUERY_KEYS.has(key.toLowerCase()));
  const markup = renderToStaticMarkup(createElement(Router, { ssrPath: "/", children: createElement(Welcome) }));
  const canonical = new URL("/", canonicalBaseUrl).toString();
  const robots = noIndex ? "noindex, nofollow" : "index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1";
  return template
    .replace(/<div\s+id=["']root["']\s*>\s*<\/div>/, `<div id="root">${markup}</div>`)
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(WELCOME_CONTENT.title)}</title>`)
    .replace(/<meta\s+name=["']description["']\s+content=["'][^"']*["']\s*\/?\s*>/i, `<meta name="description" content="${escapeHtml(WELCOME_CONTENT.description)}">`)
    .replace(/<\/head>/i, `<link rel="canonical" href="${escapeHtml(canonical)}">\n<meta name="robots" content="${robots}">\n</head>`);
}
