import type { Express, Request, RequestHandler } from "express";
import fs from "node:fs";
import path from "node:path";
import { shouldServePrerender } from "./acquisitionPrerender";

export function isHomepageDocumentRequest(req: Request) {
  // Express wildcard mounts strip req.path; originalUrl keeps the real route.
  const requestPath = String(req.originalUrl || req.url).split("?")[0];
  if (requestPath !== "/" || req.method !== "GET") return false;
  const accept = String(req.get("Accept") || "").toLowerCase();
  if (accept.includes("application/json") && !accept.includes("text/html")) return false;
  return accept.includes("text/html") || shouldServePrerender(req);
}

// The existing root health guard, shared by application boot and local HTTP
// proof. Only document negotiation adds named crawlers with wildcard Accept;
// HEAD, ordinary JSON probes, development fallthrough and missing-build status
// retain their previous behavior.
export function createRootHealthGuard(
  app: Express,
  indexPath = path.resolve(process.cwd(), "dist", "public", "index.html"),
): RequestHandler {
  return (req, res, next) => {
    if (req.path !== "/") return next();
    if (req.method === "HEAD") return res.status(200).end();
    if (req.method !== "GET") return next();
    res.vary("Accept");
    res.vary("User-Agent");
    if (!isHomepageDocumentRequest(req)) {
      return res.status(200).json({ status: "ok", service: "MealScout API", timestamp: new Date().toISOString() });
    }
    if (app.get("env") === "development" || fs.existsSync(indexPath)) return next();
    return res.status(200).set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    }).send(`
          <!DOCTYPE html>
          <html lang="en">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>MealScout</title>
            </head>
            <body>
              <h1>MealScout</h1>
              <p>Service is running successfully.</p>
              <p>Status: OK</p>
              <p><a href="/health">Health Check</a></p>
            </body>
          </html>
        `);
  };
}
