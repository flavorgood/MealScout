import express, { type Express } from "express";
import path from "node:path";
import { PUBLIC_PROFILE_APP_ASSET_PATH } from "../../shared/publicProfileAppAssetPaths";

export function registerPublicProfileAppAssets(
  app: Express,
  assetsDirectory = path.resolve(process.cwd(), "dist", "public", "assets"),
) {
  // Only already-public compiled assets are exposed. Never mount dist/server,
  // the repository, a directory index, or the ordinary API/SPA fallback.
  app.use(PUBLIC_PROFILE_APP_ASSET_PATH, express.static(assetsDirectory, {
    dotfiles: "deny",
    index: false,
    redirect: false,
    fallthrough: true,
    maxAge: "1y",
    immutable: true,
    setHeaders(res) { res.setHeader("X-Content-Type-Options", "nosniff"); },
  }));
  app.use(PUBLIC_PROFILE_APP_ASSET_PATH, (_req, res) => {
    res.status(404).set({
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    }).send("Asset not found");
  });
}
