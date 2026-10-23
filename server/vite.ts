import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { type Server } from "http";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import { guardUnauthenticatedProtectedHtml } from "./seo/protectedHtmlRoutes";
import { renderHomepageHtml } from "./seo/homepageHtml";
import { isHomepageDocumentRequest } from "./seo/rootEntry";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

export async function setupVite(app: Express, server: Server, canonicalBaseUrl = "https://www.mealscout.us") {
  const viteModule = (await (0, eval)('import("vite")')) as typeof import("vite");
  const { createServer: createViteServer, createLogger } = viteModule;
  const viteLogger = createLogger();
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };
  const configFile = path.resolve(process.cwd(), "client", "vite.config.ts");

  const vite = await createViteServer({
    configFile,
    customLogger: {
      ...viteLogger,
        error: (msg: any, options: any) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  // Defense in depth: never transform marketing index.html for unauth protected paths.
  app.use(guardUnauthenticatedProtectedHtml);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        moduleDir,
        "..",
        "client",
        "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      if (isHomepageDocumentRequest(req)) {
        template = renderHomepageHtml(template, canonicalBaseUrl, req.originalUrl, /noindex/i.test(String(res.getHeader("X-Robots-Tag") || "")));
        res.setHeader("Cache-Control", "private, no-store");
        res.vary("Accept");
        res.vary("User-Agent");
      }
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express, options: { canonicalBaseUrl?: string; distPath?: string } = {}) {
  // Production server code is bundled into dist/server, while client assets are
  // emitted to dist/public. Keep this aligned with the startup check in index.ts.
  const distPath = options.distPath || path.resolve(process.cwd(), "dist", "public");

  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(async (req, res, next) => {
    if (!isHomepageDocumentRequest(req)) return next();
    try {
      const template = await fs.promises.readFile(path.join(distPath, "index.html"), "utf8");
      const html = renderHomepageHtml(template, options.canonicalBaseUrl || "https://www.mealscout.us", req.originalUrl, /noindex/i.test(String(res.getHeader("X-Robots-Tag") || "")));
      res.vary("Accept");
      res.vary("User-Agent");
      res.status(200).set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" }).send(html);
    } catch (error) { next(error); }
  });

  app.use(
    express.static(distPath, {
      setHeaders: (res, filePath) => {
        // Service workers and web manifests must be revalidated to allow updates.
        if (
          filePath.endsWith(`${path.sep}sw.js`) ||
          filePath.endsWith(`${path.sep}manifest.json`) ||
          filePath.endsWith(".webmanifest")
        ) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
          return;
        }
        if (filePath.endsWith(".html")) {
          res.setHeader(
            "Cache-Control",
            "no-cache, no-store, must-revalidate",
          );
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
          return;
        }
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  );

  // Never serve index.html for missing static assets/chunks.
  // If a hashed JS/CSS chunk is missing, returning HTML causes a MIME error
  // and leaves the app in a blank-screen state.
  app.use((req, res, next) => {
    const pathValue = String(req.path || "");
    const looksLikeStaticAsset =
      pathValue.startsWith("/assets/") ||
      pathValue.startsWith("/static/") ||
      /\.(js|mjs|css|map|png|jpg|jpeg|gif|svg|ico|woff|woff2|webmanifest)$/i.test(
        pathValue,
      );
    if (!looksLikeStaticAsset) {
      return next();
    }
    return res
      .status(404)
      .set({
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      })
      .send("Asset not found");
  });

  // Defense in depth: never send marketing index.html for unauth protected paths.
  app.use(guardUnauthenticatedProtectedHtml);

  // Fall through to index.html for SPA routes only.
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
