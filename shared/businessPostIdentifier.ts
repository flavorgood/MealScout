// Select one supported public post; never select an account, owner or profile.
export function businessPostIdentifier(value: string): string {
  if (/^\d+(?:_\d+)?$/.test(value)) return value;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("BUSINESS_POST_LINK_REQUIRED"); }
  if (url.protocol !== "https:" || !["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"].includes(url.hostname) || url.username || url.password || url.port) throw new Error("BUSINESS_POST_LINK_REQUIRED");
  const story = url.searchParams.get("story_fbid");
  const page = url.searchParams.get("id");
  if (story && /^\d+$/.test(story)) return page && /^\d+$/.test(page) ? `${page}_${story}` : story;
  const match = url.pathname.match(/^\/([^/]+)\/posts\/(\d+)\/?$/);
  if (match) return /^\d+$/.test(match[1]) ? `${match[1]}_${match[2]}` : match[2];
  throw new Error("BUSINESS_POST_LINK_REQUIRED");
}
