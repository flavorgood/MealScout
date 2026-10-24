import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router, Route } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import MenuPage from "../../client/src/pages/online-menu";
import { PublicMenuReadError } from "../../client/src/lib/public-menu-recovery";
import { TRACKING_QUERY_KEYS } from "../../client/src/components/seo-head";
import { publicMenuPageMetadata, type PublicMenuPageFacts } from "../../shared/publicMenuPage";
import { renderAppDocumentHtml } from "./appDocumentHtml";
import { shouldServePrerender } from "./acquisitionPrerender";
import type { Request } from "express";

export function publicMenuDocumentId(req: Request): string | null {
  if (req.method !== "GET") return null;
  const accept = String(req.get("Accept") || "").toLowerCase();
  if (accept.includes("application/json") && !accept.includes("text/html")) return null;
  if (!accept.includes("text/html") && !shouldServePrerender(req)) return null;
  const match = /^\/menu\/([^/?#]+)\/?$/.exec(String(req.originalUrl || req.url).split("?")[0]);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return id && !/[\\/\s\x00-\x1f]/.test(id) ? id : null;
  } catch { return null; }
}

// Receives only the existing anonymous API payload. No raw record, session,
// provider or cart is serialized; interactive App reads remain fresh client-side.
export function renderMenuHtml(template: string, canonicalBaseUrl: string, requestUrl: string, restaurantId: string,
  payload: PublicMenuPageFacts | null, status = 200, forceNoIndex = false,
) {
  const url = new URL(requestUrl, canonicalBaseUrl);
  const metadata = publicMenuPageMetadata(restaurantId, payload, url.searchParams.get("menuId"));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } });
  const key = ["/api/menus", restaurantId];
  try {
    if (payload) queryClient.setQueryData(key, payload);
    else queryClient.getQueryCache().build(queryClient, { queryKey: key }).setState({ status: "error", fetchStatus: "idle", error: new PublicMenuReadError(status) });
    const markup = renderToStaticMarkup(h(QueryClientProvider, { client: queryClient, children: h(Router, {
      ssrPath: url.pathname, ssrSearch: url.search,
      children: h(Route, { path: "/menu/:restaurantId", component: MenuPage }),
    }) }));
    const noIndex = forceNoIndex || status !== 200 || metadata.noIndex || [...url.searchParams.keys()].some(key => TRACKING_QUERY_KEYS.has(key.toLowerCase()));
    return renderAppDocumentHtml(template, { markup, title: metadata.title, description: metadata.description,
      canonical: new URL(metadata.canonicalPath, canonicalBaseUrl).toString(), noIndex, schema: metadata.schema });
  } finally { queryClient.clear(); }
}
