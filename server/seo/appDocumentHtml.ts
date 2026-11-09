import { PUBLIC_PROFILE_APP_ASSET_BASE } from "../../shared/publicProfileAppAssetPaths";
import { buildJsonLdScript } from "./jsonLdScript";

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const nativePublicProfileAssetPath = (url: string) =>
  url.startsWith(PUBLIC_PROFILE_APP_ASSET_BASE) && !url.startsWith(`${PUBLIC_PROFILE_APP_ASSET_BASE}assets/`)
    ? `/${url.slice(PUBLIC_PROFILE_APP_ASSET_BASE.length)}`
    : null;

/**
 * The compiled template addresses every public file through the API asset
 * bridge, but only the compiled JS/CSS under assets/ is served there — the
 * icons, favicon, and brand files answer at their native public paths.
 * Rewrite those references (link/script attributes and meta image content)
 * back to the native paths; the assets/ graph keeps the bridge.
 */
export function normalizePublicProfileAssetPaths(html: string) {
  return html
    .replace(/\b(href|src)=(['"])([^'"]+)\2/g, (attribute, name, quote, url: string) => {
      const native = nativePublicProfileAssetPath(url);
      return native ? `${name}=${quote}${native}${quote}` : attribute;
    })
    .replace(/\bcontent=(['"])([^'"]+)\1/g, (attribute, quote, url: string) => {
      const native = nativePublicProfileAssetPath(url);
      return native ? `content=${quote}${native}${quote}` : attribute;
    });
}

/** Keep one native App template/asset graph for public initial documents. */
export function renderAppDocumentHtml(template: string, page: {
  markup: string; title: string; description: string; canonical: string;
  noIndex: boolean; schema?: object;
}) {
  if (!/<div\s+id=["']root["']\s*>\s*<\/div>/.test(template)) throw new Error("Native template has no empty application root");
  let html = normalizePublicProfileAssetPaths(template);
  html = html.replace(/<div\s+id=["']root["']\s*>\s*<\/div>/, () => `<div id="root">${page.markup}</div>`)
    .replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapeHtml(page.title)}</title>`);
  const tags: Array<[string, string]> = [["description", page.description], ["og:title", page.title], ["og:description", page.description], ["twitter:title", page.title], ["twitter:description", page.description]];
  for (const [name, value] of tags) {
    const matcher = new RegExp(`<meta\\s+(?:name|property)=["']${name}["']\\s+content=(["'])[\\s\\S]*?\\1\\s*\\/?\\s*>`, "i");
    html = html.replace(matcher, () => `<meta ${name.startsWith("og:") ? "property" : "name"}="${name}" content="${escapeHtml(value)}">`);
  }
  const robots = page.noIndex ? "noindex, nofollow" : "index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1";
  return html.replace(/<\/head>/i, () => `<link rel="canonical" href="${escapeHtml(page.canonical)}">\n<meta name="robots" content="${robots}">\n<meta property="og:url" content="${escapeHtml(page.canonical)}">\n${page.schema ? buildJsonLdScript(page.schema).replace('<script type="application/ld+json"', '<script type="application/ld+json" data-page-schema="true"') : ""}\n</head>`);
}
