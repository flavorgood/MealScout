import type { Express, RequestHandler } from "express";
import { ZodError } from "zod";
import { PublicLinkError, type PublicLinkAuthority } from "../services/ecosystemPublicLinkAuthority";

// Auth middleware is supplied by the native runtime; no ecosystem role or
// TradeScout identity can substitute for actual source ownership.
export function registerEcosystemPublicLinkRoutes(app: Express, options: {
  authority: PublicLinkAuthority;
  isAuthenticated: RequestHandler;
  enabled: () => boolean;
  readLimit?: RequestHandler;
  writeLimit?: RequestHandler;
}) {
  const fail = (res: any, error: unknown) => {
    if (error instanceof ZodError) return res.status(400).json({ error: "Invalid sharing request" });
    if (error instanceof PublicLinkError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(503).json({ error: "MealScout sharing is temporarily unavailable" });
  };
  const available: RequestHandler = (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!options.enabled()) return res.status(503).json({ error: "MealScout sharing is temporarily unavailable" });
    next();
  };
  const noLimit: RequestHandler = (_req, _res, next) => { next(); };
  app.get("/api/ecosystem/public-links/:tenantId/:sourceId", available, options.readLimit ?? noLimit, async (req, res) => {
    try {
      const value = await options.authority.readPublicLink(String(req.params.tenantId), String(req.params.sourceId));
      return value ? res.json(value) : res.status(404).json({ error: "Public link unavailable" });
    } catch (error) { return fail(res, error); }
  });
  const ownerBase = "/api/owner/ecosystem-links/:sourceId";
  app.get(ownerBase, available, options.isAuthenticated, async (req, res) => {
    try { return res.json(await options.authority.getOwnerPreview(String(req.params.sourceId), String((req.user as any)?.id ?? ""))); }
    catch (error) { return fail(res, error); }
  });
  app.post(`${ownerBase}/approve`, available, options.isAuthenticated, options.writeLimit ?? noLimit, async (req, res) => {
    try { return res.json(await options.authority.approve(String(req.params.sourceId), String((req.user as any)?.id ?? ""), req.body)); }
    catch (error) { return fail(res, error); }
  });
  app.post(`${ownerBase}/revoke`, available, options.isAuthenticated, options.writeLimit ?? noLimit, async (req, res) => {
    try { return res.json(await options.authority.revoke(String(req.params.sourceId), String((req.user as any)?.id ?? ""), req.body)); }
    catch (error) { return fail(res, error); }
  });
}
