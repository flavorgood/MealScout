import type { Request, Response } from "express";
import { publicMenuPageMetadata, type PublicMenuPageFacts } from "../../shared/publicMenuPage";
import { renderMenuHtml } from "./menuHtml";

export type PublicMenuLoader = (restaurantId: string) => Promise<PublicMenuPageFacts | null>;

/** One request-local public read; the canonical API reader owns visibility. */
export async function renderPublicMenuDocument(req: Request, res: Response, template: string, restaurantId: string,
  canonicalBaseUrl: string, loadMenu: PublicMenuLoader,
) {
  let payload: PublicMenuPageFacts | null = null;
  let status = 200;
  try {
    payload = await loadMenu(restaurantId);
    if (!payload) status = 404;
  } catch {
    status = 503;
  }
  const noIndex = /noindex/i.test(String(res.getHeader("X-Robots-Tag") || ""));
  const metadata = publicMenuPageMetadata(restaurantId, payload);
  // The earlier generic tracking middleware retains functional parameters in
  // its Link canonical. Menu variants share the clean entity canonical.
  res.setHeader("Link", `<${new URL(metadata.canonicalPath, canonicalBaseUrl).toString()}>; rel="canonical"`);
  res.vary("Accept");
  res.vary("User-Agent");
  res.setHeader("Cache-Control", "private, no-store");
  if ((status !== 200 || metadata.noIndex) && !noIndex) res.setHeader("X-Robots-Tag", "noindex, nofollow");
  return { html: renderMenuHtml(template, canonicalBaseUrl, req.originalUrl, restaurantId, payload, status, noIndex), status };
}
