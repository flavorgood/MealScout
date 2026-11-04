/**
 * Own titles for private app entry pages.
 *
 * The SPA shell (client/index.html) carries the marketing homepage title, so
 * every app route served straight from it announces itself as the homepage
 * until — and unless — the page's own SEOHead effect runs. These owner pages
 * get their real titles in the SERVED document instead: the shell is rendered
 * through the same app-document renderer the homepage uses, carrying the
 * page's own title and description.
 *
 * Keep each title identical to the one the page sets for itself in the client
 * (SEOHead) so the tab title never flips after load.
 */
import { renderAppDocumentHtml } from "./appDocumentHtml";

export interface AppPageTitle {
  path: string;
  title: string;
  description: string;
}

export const APP_PAGE_TITLES: readonly AppPageTitle[] = [
  {
    path: "/dashboard",
    title: "Dashboard | MealScout",
    description: "Your MealScout dashboard.",
  },
  {
    path: "/menu-builder",
    title: "Menu Builder | MealScout",
    description: "Create and manage your online menu on MealScout.",
  },
  {
    // The page's own SEOHead title and description (client/src/pages/orders.tsx).
    // The served document must match them, not invent a second name for the
    // same page.
    path: "/orders",
    title: "Activity - MealScout",
    description: "Review your MealScout orders and claimed deals.",
  },
] as const;

export function normalizeAppPagePath(pathValue: string): string {
  const raw = String(pathValue || "/").split("?")[0].split("#")[0];
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.replace(/\/+$/, "") || "/";
  }
  return withSlash;
}

export function appPageTitleForPath(pathValue: string): AppPageTitle | undefined {
  const path = normalizeAppPagePath(pathValue).toLowerCase();
  return APP_PAGE_TITLES.find((entry) => entry.path === path);
}

/**
 * Render the SPA shell with the page's own title/description. Returns null
 * when the path has no registered title, so callers fall back to the plain
 * shell. The app root stays empty — the client app renders exactly as today.
 */
export function renderAppPageTitleDocument(
  template: string,
  pathValue: string,
  canonicalBaseUrl = "https://www.mealscout.us",
): string | null {
  const page = appPageTitleForPath(pathValue);
  if (!page) return null;
  const canonical = new URL(page.path, canonicalBaseUrl).toString();
  return renderAppDocumentHtml(template, {
    markup: "",
    title: page.title,
    description: page.description,
    canonical,
    noIndex: true,
  });
}
