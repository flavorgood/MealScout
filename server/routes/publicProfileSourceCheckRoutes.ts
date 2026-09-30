import type { Express, RequestHandler } from "express";
import { isAuthenticated } from "../unifiedAuth";
import { readPublicProfileSourceChecks } from "../services/publicProfileSourceChecks";

export function registerPublicProfileSourceCheckRoutes(app: Express, dependencies: {
  authenticate?: RequestHandler; read?: typeof readPublicProfileSourceChecks;
} = {}) {
  app.get("/api/restaurants/:restaurantId/public-source-checks",
    (_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); },
    dependencies.authenticate || isAuthenticated,
    async (req: any, res) => {
      if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
      try {
        const { status, ...body } = await (dependencies.read || readPublicProfileSourceChecks)(String(req.user.id), req.params.restaurantId);
        return res.status(status).json(body);
      } catch { return res.status(500).json({ error: "Unable to read private link checks" }); }
    });
}
