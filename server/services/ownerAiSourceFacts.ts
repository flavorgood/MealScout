import * as cheerio from "cheerio";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { restaurants, users } from "@shared/schema";
import { toCanonicalFoodBusinessType } from "@shared/businessTypes";
import { assertOwnerAiSourceFactBindings, canonicalSourceSection, OWNER_AI_SOURCE_FACT_TTL_MS, type OwnerAiSourceFact, type OwnerAiSourceSection } from "@shared/ownerAiSourceFacts";
import { checkPinnedPublicSource, sourceCheckUrl } from "../utils/pinnedPublicSourceCheck";
import { projectPublicSourceUrls } from "./publicProfileSourceChecks";
import { deriveOwnerAiPublicationPolicy } from "./ownerAiProfileCapabilities";
import { loadPublicRestaurantListingVisibility } from "../publicProfiles/toPublicRestaurantListingWithVisibility";

import { extractOfficialSemanticSections } from "./officialSourceSemanticParser";

export type OfficialSourceCapture = { sourceUrl: string; finalUrl: string; body: Buffer; contentType: string; checkedAt: string; bodyHash: string };
export function extractOfficialSourceFacts(capture: OfficialSourceCapture) {
  if (!capture.contentType.toLowerCase().includes("text/html") || new URL(capture.finalUrl).origin !== new URL(capture.sourceUrl).origin) return { fields: [] as OwnerAiSourceFact[], holds: ["UNSUPPORTED_OR_REDIRECTED_SOURCE"] };
  const $ = cheerio.load(capture.body.toString("utf8"));

  const candidates = new Map<string, Set<string>>();
  const add = (path: string, value: string) => { if (!candidates.has(path)) candidates.set(path, new Set()); candidates.get(path)!.add(value); };
  // Square publishes its current page as JSON. Parse only the exact assignment;
  // never execute scripts or read hidden defaults/store settings as public facts.
  if (new URL(capture.sourceUrl).hostname.endsWith(".square.site")) {
    $("script:not([src])").each((_i, element) => {
      const text = ($(element).html() || "").trim();
      const match = /^window\.__BOOTSTRAP_STATE__\s*=\s*([\s\S]+);$/.exec(text);
      if (!match) return;
      try {
        const state = JSON.parse(match[1]);
        const visible = state?.siteData?.page?.properties?.contentAreas?.userContent;
        if (!visible || visible.hidden !== false) return;
        const visit = (node: any, depth = 0) => {
          if (!node || depth > 20 || node.hidden === true || node.properties?.hidden === true) return;
          if (node.type === "block" && node.purpose === "embed-pdf@^1.0.0") {
            const properties = node.properties;
            const description = (properties?.text?.content?.quill?.ops || []).filter((op: any) => typeof op.insert === "string").map((op: any) => op.insert).join(" ");
            if (/\bmenu\b/i.test(description) && typeof properties?.pdfSource === "string") {
              const url = new URL(properties.pdfSource, capture.finalUrl);
              const safe = sourceCheckUrl(url.toString());
              if (safe && url.origin === new URL(capture.sourceUrl).origin && /\.pdf$/i.test(url.pathname)) add("profile.menuUrl", safe);
            }
          }
          if (node.content) visit(node.content, depth + 1);
          if (Array.isArray(node.cells)) node.cells.slice(0,500).forEach((cell: any) => visit(cell, depth + 1));
        };
        visit(visible.content);
      } catch { /* Unsupported or malformed page data stays held. */ }
    });
  }
  const hiddenSelectors: string[] = ["[hidden]", "[aria-hidden=true]", ".hidden", ".d-none", ".is-hidden", ".sr-only"];
  $("style").each((_i, element) => {
    const css = $(element).text().replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(rule[2])) hiddenSelectors.push(...rule[1].split(",").map(v => v.trim()));
  });
  const hidden = (el: any) => hiddenSelectors.some(selector => { try { return $(el).closest(selector).length > 0; } catch { return true; } });
  $("script,style,template,noscript").remove();
  $("a[href]").each((_i, el) => {
    if (hidden(el) || $(el).parents().addBack().toArray().some(e => /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test($(e).attr("style") || ""))) return;
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
  if (JSON.stringify([...new Set(packet.sourceFacts.officialSources)].sort()) !== JSON.stringify([...authority.urls].sort())) throw new Error("SOURCE_FACT_OFFICIAL_SOURCE_SET_CHANGED");
  for (const fact of [...(packet.sourceFacts?.fields || []), ...(packet.sourceFacts?.sections || [])]) {
    if (!authority.urls.includes(fact.sourceUrl)) throw new Error("SOURCE_FACT_OFFICIAL_SOURCE_REMOVED");
    if (authority.blockedFields.includes(fact.path.split(".")[1])) throw new Error("SOURCE_FACT_FIELD_NOT_PUBLIC");
  }
}
function sectionMeaning(section: OwnerAiSourceSection) { return canonicalSourceSection(section.path === "menus" ? {value:section.value,effectiveFrom:section.effectiveFrom,effectiveThrough:section.effectiveThrough} : {value:section.value}); }
function semanticHeld(path: string, holds: string[]) {
  return holds.some(h=>h.startsWith("SOURCE_UNAVAILABLE:") || h === "MALFORMED_PUBLIC_STRUCTURED_CONTENT" || h === "UNSUPPORTED_STRUCTURED_CONTEXT" || h.startsWith(path === "menus" ? "MENU_CONTENT_HOLD:" : "SCHEDULE_CONTENT_HOLD:"));
}
export async function verifyOwnerAiSourceFacts(packet: any, restaurantId: string, ownerId: string, database: any = db, capture = captureOfficialSource, refreshCapture = false) {
  if (!packet.sourceFacts) return;
  const authority = await loadSourceFactAuthority(restaurantId, ownerId, database);
  assertSourceFactAuthority(packet, authority);
  const all: OwnerAiSourceFact[] = [], sections: OwnerAiSourceSection[] = [], holds: string[] = [];
  for (const sourceUrl of authority.urls) {
    try { const observation = await capture(sourceUrl); const result = extractOfficialSourceFacts(observation), semantic = extractOfficialSemanticSections(observation); all.push(...result.fields); sections.push(...semantic.sections); holds.push(...result.holds, ...semantic.holds); }
    catch { holds.push("SOURCE_UNAVAILABLE:" + sourceUrl); }
  }
  for (const fact of packet.sourceFacts.fields) {
    if (holds.includes("SOURCE_UNAVAILABLE:" + fact.sourceUrl)) throw new Error("SOURCE_FACT_UNAVAILABLE");
    const candidates = all.filter(f => f.path === fact.path);
    const current = candidates.find(f => f.sourceUrl === fact.sourceUrl && f.value === fact.value);
    if (!current || candidates.some(f => f.value !== fact.value) || holds.includes("CONFLICT:" + fact.path)) throw new Error("SOURCE_FACT_CHANGED_OR_CONFLICTING");
    if (fact.path === "profile.menuUrl") {
      const linked = await checkPinnedPublicSource(fact.value, { maxBytes: 16 * 1024 * 1024 });
      if (linked.availability !== "reachable") throw new Error("SOURCE_FACT_LINK_UNAVAILABLE");
    }
    if (refreshCapture) Object.assign(fact, current);
  }
  for (const fact of packet.sourceFacts.sections || []) {
    if (semanticHeld(fact.path,holds)) throw new Error("SOURCE_FACT_SEMANTIC_SOURCE_HELD");
    if (holds.includes("SOURCE_UNAVAILABLE:"+fact.sourceUrl)) throw new Error("SOURCE_FACT_UNAVAILABLE");
    const candidates=sections.filter(f=>f.path===fact.path), current=candidates.find(f=>f.sourceUrl===fact.sourceUrl && f.value===fact.value);
    if (!current || candidates.some(f=>sectionMeaning(f)!==sectionMeaning(current)) || (!refreshCapture && sectionMeaning(current)!==sectionMeaning(fact))) throw new Error("SOURCE_FACT_CHANGED_OR_CONFLICTING");
    if (refreshCapture) Object.assign(fact,current);
  }
  // Ownership, native publication policy and official URL binding may change
  // during network reads. Approval repeats this check under transaction locks.
  assertSourceFactAuthority(packet, await loadSourceFactAuthority(restaurantId, ownerId, database));
}
export async function proposeOwnerAiSourceFacts(restaurantId: string, ownerId: string) {
  const before = await loadSourceFactAuthority(restaurantId, ownerId);
  const fields: OwnerAiSourceFact[] = [], sections: OwnerAiSourceSection[] = [], holds: string[] = [];
  for (const url of before.urls) {
    try { const observation=await captureOfficialSource(url); const result=extractOfficialSourceFacts(observation), semantic=extractOfficialSemanticSections(observation); fields.push(...result.fields); sections.push(...semantic.sections); holds.push(...result.holds, ...semantic.holds); }
    catch { holds.push("SOURCE_UNAVAILABLE:" + url); }
  }
  const after = await loadSourceFactAuthority(restaurantId, ownerId);
  if (JSON.stringify([...before.urls].sort()) !== JSON.stringify([...after.urls].sort())) throw new Error("SOURCE_FACT_OFFICIAL_SOURCE_SET_CHANGED");
  const usable = fields.filter(f => after.urls.includes(f.sourceUrl) && !after.blockedFields.includes(f.path.split(".")[1]));
  const selected: OwnerAiSourceFact[] = [];
  for (const key of new Set(usable.map(f => f.path))) {
    const values = usable.filter(f => f.path === key);
    if (new Set(values.map(f => f.value)).size !== 1 || holds.includes("CONFLICT:" + key)) { holds.push("CONFLICT:" + key); continue; }
    selected.push(values[0]);
  }
  const selectedSections: OwnerAiSourceSection[] = [];
  for (const path of new Set(sections.map(f=>f.path))) {
    if (semanticHeld(path,holds)) { holds.push("SEMANTIC_SECTION_HELD:"+path); continue; }
    const candidates=sections.filter(f=>f.path===path && after.urls.includes(f.sourceUrl));
    if (new Set(candidates.map(sectionMeaning)).size !== 1) { holds.push("CONFLICT:"+path); continue; }
    selectedSections.push(candidates[0]);
  }
  const profile = Object.fromEntries(selected.map(f => [f.path.split(".")[1], f.value]));
  return { packet: selected.length || selectedSections.length ? { schemaVersion: "1.0", intent: "Review values explicitly supplied by official public sources", ...(selected.length ? {profile} : {}), ...Object.fromEntries(selectedSections.map(f=>[f.path,JSON.parse(f.value)])), sourceFacts: selectedSections.length ? { version: 2, officialSources: [...after.urls].sort(), fields: selected, sections:selectedSections } : { version: 1, officialSources: [...after.urls].sort(), fields: selected } } : null,
    holds: [...new Set(holds)], mutationPerformed: false, approvalRequired: true, canApply: false };
}
