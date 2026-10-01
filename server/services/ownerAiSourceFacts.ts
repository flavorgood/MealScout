import * as cheerio from "cheerio";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { restaurants, users } from "@shared/schema";
import { toCanonicalFoodBusinessType } from "@shared/businessTypes";
import { assertOwnerAiSourceFactBindings, OWNER_AI_SOURCE_FACT_TTL_MS, type OwnerAiSourceFact } from "@shared/ownerAiSourceFacts";
import { checkPinnedPublicSource, sourceCheckUrl } from "../utils/pinnedPublicSourceCheck";
import { projectPublicSourceUrls } from "./publicProfileSourceChecks";
import { deriveOwnerAiPublicationPolicy } from "./ownerAiProfileCapabilities";
import { loadPublicRestaurantListingVisibility } from "../publicProfiles/toPublicRestaurantListingWithVisibility";

export type OfficialSourceCapture = { sourceUrl: string; finalUrl: string; body: Buffer; contentType: string; checkedAt: string; bodyHash: string };
export function extractOfficialSourceFacts(capture: OfficialSourceCapture) {
  if (!capture.contentType.toLowerCase().includes("text/html") || new URL(capture.finalUrl).origin !== new URL(capture.sourceUrl).origin) return { fields: [] as OwnerAiSourceFact[], holds: ["UNSUPPORTED_OR_REDIRECTED_SOURCE"] };
  const $ = cheerio.load(capture.body.toString("utf8"));
  $("script,style,template,noscript,[hidden],[aria-hidden=true]").remove();
  const candidates = new Map<string, Set<string>>();
  const add = (path: string, value: string) => { if (!candidates.has(path)) candidates.set(path, new Set()); candidates.get(path)!.add(value); };
  $("a[href]").each((_i, el) => {
    if ($(el).closest('[style*="display:none"],[style*="display: none"],[style*="visibility:hidden"],[style*="visibility: hidden"]').length) return;
    const href = String($(el).attr("href") || "").trim();
    if (/^tel:[+\d ()-]+$/i.test(href)) { const phone = href.slice(4).replace(/[ ()-]/g, ""); if (/^\+?\d{7,15}$/.test(phone)) add("profile.phone", phone); return; }
    let url: URL; try { url = new URL(href, capture.finalUrl); } catch { return; }
    const safe = sourceCheckUrl(url.toString()); if (!safe) return;
    const label = $(el).text().replace(/\s+/g," ").trim();
    if (/^(menu|view menu|download menu|our menu)$/i.test(label) || (/^download$/i.test(label) && /\.pdf$/i.test(url.pathname) && ($(el).closest("section").length ? $(el).closest("section") : $(el).parent().parent()).find("h1,h2,h3,h4").toArray().some(h => /^menu$/i.test($(h).text().trim())))) add("profile.menuUrl", safe);
    if (/^(www\.)?instagram\.com$/i.test(url.hostname) && /^\/[A-Za-z0-9._]+\/?$/.test(url.pathname) && !/\/(accounts|explore|reels|p)\/?$/i.test(url.pathname)) add("profile.instagramUrl", safe);
    if (/^(www\.)?facebook\.com$/i.test(url.hostname) && !/\/(sharer|login|dialog|share|watch)(\/|$)/i.test(url.pathname) && url.pathname !== "/") add("profile.facebookPageUrl", safe);
    if (/^(www\.)?(x|twitter)\.com$/i.test(url.hostname) && /^\/[A-Za-z0-9_]+\/?$/.test(url.pathname) && !/\/(intent|home|login|share)\/?$/i.test(url.pathname)) add("profile.xUrl", safe);
  });
  const fields: OwnerAiSourceFact[] = [], holds = ["MENU_CONTENT_PRICE_AND_EFFECTIVE_DATE_REQUIRE_SEPARATE_VERIFICATION", "DATED_ATTENDANCE_YEAR_TIMEZONE_AND_PUBLIC_ACCESS_REQUIRE_SEPARATE_VERIFICATION"];
  for (const [path, values] of candidates) {
    if (values.size !== 1) { holds.push("CONFLICT:" + path); continue; }
    fields.push({ path: path as OwnerAiSourceFact["path"], value: [...values][0], sourceUrl: capture.sourceUrl, capturedAt: capture.checkedAt,
      expiresAt: new Date(Date.parse(capture.checkedAt) + OWNER_AI_SOURCE_FACT_TTL_MS).toISOString(), captureSha256: capture.bodyHash, access: "public",
      qualification: "Official page explicitly supplies this value; no claim about menu prices, inventory, availability or dated attendance." });
  }
  return { fields, holds };
}
export async function captureOfficialSource(url: string): Promise<OfficialSourceCapture> {
  let capture: OfficialSourceCapture | undefined;
  const receipt = await checkPinnedPublicSource(url, { capture: v => { capture = v; } });
  if (!capture || receipt.availability !== "reachable") throw new Error("SOURCE_FACT_UNAVAILABLE");
  return capture;
}
export async function loadSourceFactAuthority(restaurantId: string, ownerId: string, database: any = db, lock = false) {
  let query = database.select().from(restaurants).where(and(eq(restaurants.id, restaurantId), eq(restaurants.ownerId, ownerId))).limit(1);
  if (lock) query = query.for("share");
  const [restaurant] = await query;
  let oq = database.select().from(users).where(eq(users.id, ownerId)).limit(1); if (lock) oq = oq.for("share");
  const [owner] = await oq;
  if (!restaurant || owner?.isDisabled !== false || !toCanonicalFoodBusinessType(restaurant.businessType)) throw new Error("SOURCE_FACT_OWNER_OR_ADAPTER_INVALID");
  const visibility = (await loadPublicRestaurantListingVisibility([restaurant], database)).get(ownerId);
  const policy = deriveOwnerAiPublicationPolicy(restaurant, visibility);
  if (!policy.publicSurface) throw new Error("SOURCE_FACT_PUBLIC_ACCESS_REQUIRED");
  return { restaurant, urls: projectPublicSourceUrls(restaurant, owner), blockedFields: policy.blockedProfileFields };
}
export function assertSourceFactAuthority(packet: any, authority: { urls: string[]; blockedFields: string[] }, now = new Date()) {
  assertOwnerAiSourceFactBindings(packet, now);
  for (const fact of packet.sourceFacts?.fields || []) {
    if (!authority.urls.includes(fact.sourceUrl)) throw new Error("SOURCE_FACT_OFFICIAL_SOURCE_REMOVED");
    if (authority.blockedFields.includes(fact.path.split(".")[1])) throw new Error("SOURCE_FACT_FIELD_NOT_PUBLIC");
  }
}
export async function verifyOwnerAiSourceFacts(packet: any, restaurantId: string, ownerId: string, database: any = db, capture = captureOfficialSource, refreshCapture = false) {
  if (!packet.sourceFacts) return;
  const authority = await loadSourceFactAuthority(restaurantId, ownerId, database);
  assertSourceFactAuthority(packet, authority);
  const extracted = new Map<string, ReturnType<typeof extractOfficialSourceFacts>>();
  for (const fact of packet.sourceFacts.fields) {
    if (!extracted.has(fact.sourceUrl)) extracted.set(fact.sourceUrl, extractOfficialSourceFacts(await capture(fact.sourceUrl)));
    // Compare semantic field values rather than dynamic HTML bytes. The original hash
    // remains in the immutable consent packet as provenance of the first capture.
    const current = extracted.get(fact.sourceUrl)!.fields.find(f => f.path === fact.path && f.value === fact.value);
    if (!current) throw new Error("SOURCE_FACT_CHANGED_OR_CONFLICTING");
    if (fact.path === "profile.menuUrl") {
      const linked = await checkPinnedPublicSource(fact.value);
      if (linked.availability !== "reachable") throw new Error("SOURCE_FACT_LINK_UNAVAILABLE");
    }
    // Caller timestamps/hashes are declarations until replaced with this server capture.
    if (refreshCapture) Object.assign(fact, current);
  }
}
export async function proposeOwnerAiSourceFacts(restaurantId: string, ownerId: string) {
  const before = await loadSourceFactAuthority(restaurantId, ownerId);
  const fields: OwnerAiSourceFact[] = [], holds: string[] = [];
  for (const url of before.urls) {
    try { const result = extractOfficialSourceFacts(await captureOfficialSource(url)); fields.push(...result.fields); holds.push(...result.holds); }
    catch { holds.push("SOURCE_UNAVAILABLE:" + url); }
  }
  const after = await loadSourceFactAuthority(restaurantId, ownerId);
  const usable = fields.filter(f => after.urls.includes(f.sourceUrl) && !after.blockedFields.includes(f.path.split(".")[1]));
  const selected: OwnerAiSourceFact[] = [];
  for (const key of new Set(usable.map(f => f.path))) {
    const values = usable.filter(f => f.path === key);
    if (new Set(values.map(f => f.value)).size !== 1 || holds.includes("CONFLICT:" + key)) { holds.push("CONFLICT:" + key); continue; }
    selected.push(values[0]);
  }
  const profile = Object.fromEntries(selected.map(f => [f.path.split(".")[1], f.value]));
  return { packet: selected.length ? { schemaVersion: "1.0", intent: "Review values explicitly supplied by official public sources", profile, sourceFacts: { version: 1, fields: selected } } : null,
    holds: [...new Set(holds)], mutationPerformed: false, approvalRequired: true, canApply: false };
}
