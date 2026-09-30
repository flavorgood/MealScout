// Render and the edge frontend compile independently. Render's complete Vite
// graph must use the existing API proxy instead of the edge's /assets files.
export const PUBLIC_PROFILE_APP_ASSET_BASE = "/api/public-profile/app-assets/";
export const PUBLIC_PROFILE_APP_ASSET_PATH = `${PUBLIC_PROFILE_APP_ASSET_BASE}assets`;
