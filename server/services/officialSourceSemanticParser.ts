import * as cheerio from "cheerio";
import { DateTime } from "luxon";
import { ownerAiMenuSchema, ownerAiScheduleStopSchema } from "@shared/ownerAiActions";
import { canonicalSourceSection, OWNER_AI_SOURCE_FACT_TTL_MS, type OwnerAiSourceSection } from "@shared/ownerAiSourceFacts";
import { sourceCheckUrl } from "../utils/pinnedPublicSourceCheck";
import { buildSlotDateTimes } from "./timeIntent";
import type { OfficialSourceCapture } from "./ownerAiSourceFacts";

const list = (v: any): any[] => v == null ? [] : Array.isArray(v) ? v : [v];
const text = (v: unknown, max: number): string => { if (typeof v !== "string" || !v.trim() || v.trim().length > max) throw Error("MISSING_OR_INVALID_TEXT"); return v.trim(); };
const type = (v: any, name: string) => list(v?.["@type"]).some(t => t === name || t === "https://schema.org/" + name);
const instant = (v: unknown): number => { if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(v)) throw Error("ABSOLUTE_DATE_OFFSET_REQUIRED"); const d = DateTime.fromISO(v, { setZone: true }); if (!d.isValid) throw Error("INVALID_DATE"); return d.toMillis(); };
function unsupportedContext(value:any,depth=0): boolean {
  if (depth>20) return true;
  if (!value || typeof value !== "object") return false;
  if (Object.hasOwn(value,"@context") && value["@context"] !== "https://schema.org" && value["@context"] !== "https://schema.org/") return true;
  return Object.values(value).some(v=>unsupportedContext(v,depth+1));
}
const sameIdentity = (node: any, source: string) => sourceCheckUrl(node?.url || node?.["@id"]) === sourceCheckUrl(source);
const enumUrl = (v: unknown, name: string) => v === "https://schema.org/" + name;

// Only standard JSON-LD on the current public page. No executable scripts,
// remote contexts, linked documents, store defaults or generic event calendars.
export function extractOfficialSemanticSections(capture: OfficialSourceCapture) {
  const sections: OwnerAiSourceSection[] = [], holds: string[] = [];
  if (!capture.contentType.toLowerCase().includes("text/html") || new URL(capture.finalUrl).origin !== new URL(capture.sourceUrl).origin) return { sections, holds: ["SEMANTIC_SOURCE_FORMAT_OR_REDIRECT_HELD"] };
  const $ = cheerio.load(capture.body.toString("utf8"));
  const now = Date.parse(capture.checkedAt), ttl = now + OWNER_AI_SOURCE_FACT_TTL_MS;
  const hiddenSelectors=["[hidden]",'[aria-hidden="true"]',".hidden",".d-none",".is-hidden",".sr-only","template"];
  $("style").each((_i,element)=>{for(const rule of $(element).text().replace(/\/\*[\s\S]*?\*\//g,"").matchAll(/([^{}]+)\{([^{}]*)\}/g)) if(/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(rule[2])) hiddenSelectors.push(...rule[1].split(",").map(v=>v.trim()));});
  const hidden=(el:any)=>hiddenSelectors.some(selector=>{try{return $(el).closest(selector).length>0;}catch{return true;}}) || $(el).parents().addBack().toArray().some(e=>/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test($(e).attr("style") || ""));
  const entities: any[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    if (hidden(el)) return;
    try {
      const raw = JSON.parse($(el).text());
      for (const node of list(raw)) {
        if (unsupportedContext(node) || (node?.["@context"] !== "https://schema.org" && node?.["@context"] !== "https://schema.org/")) { holds.push("UNSUPPORTED_STRUCTURED_CONTEXT"); continue; }
        entities.push(...list(node["@graph"] || node));
      }
    } catch { holds.push("MALFORMED_PUBLIC_STRUCTURED_CONTENT"); }
  });
  const evidence = (path: "menus" | "schedules", value: any[], from: number, through: number): OwnerAiSourceSection => ({
    path, value: canonicalSourceSection(value), sourceUrl: capture.sourceUrl, capturedAt: capture.checkedAt,
    expiresAt: new Date(Math.min(ttl, through)).toISOString(), captureSha256: capture.bodyHash, access: "public",
    qualification: "Official public structured content supplies the complete proposed section. Explicit dates, identity and public access were checked; exact owner consent remains required.",
    effectiveFrom: new Date(from).toISOString(), effectiveThrough: new Date(through).toISOString(),
  });
  const menuCandidates: any[] = [], intervals: [number,number][] = [];
  let menuHeld = false;
  for (const business of entities.filter(n => ["Restaurant", "FoodTruck", "BarOrPub", "FoodEstablishment", "LocalBusiness"].some(t => type(n,t)) && sameIdentity(n,capture.sourceUrl))) {
    for (const menu of list(business.hasMenu)) {
      try {
        if (!type(menu,"Menu")) throw Error("MENU_CONTENT_NOT_EMBEDDED");
        const categories = list(menu.hasMenuSection).map(section => {
          if (!type(section,"MenuSection")) throw Error("MENU_SECTION_TYPE_REQUIRED");
          const items = list(section.hasMenuItem).map(item => {
            if (!type(item,"MenuItem")) throw Error("MENU_ITEM_TYPE_REQUIRED");
            const offers = list(item.offers);
            if (offers.length !== 1 || !type(offers[0],"Offer")) throw Error("SINGLE_EXPLICIT_PRICE_OFFER_REQUIRED");
            const offer = offers[0];
            if (offer.priceCurrency !== "USD" || !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(String(offer.price))) throw Error("EXACT_USD_PRICE_REQUIRED");
            const from = instant(offer.validFrom), through = instant(offer.validThrough);
            if (from > now || through <= now || through <= from) throw Error("MENU_EFFECTIVE_DATE_NOT_CURRENT");
            if (!enumUrl(offer.availability,"InStock")) throw Error("MENU_OFFER_UNAVAILABLE");
            intervals.push([from,through]);
            return {name:text(item.name,200), ...(item.description == null ? {} : {description:text(item.description,3000)}), priceCents:Math.round(Number(offer.price)*100)};
          });
          if (!items.length || items.length > 100 || new Set(items.map(i => i.name)).size !== items.length) throw Error("EMPTY_OR_AMBIGUOUS_MENU_ITEMS");
          return {name:text(section.name,160), items};
        });
        if (!categories.length || categories.length > 25 || new Set(categories.map(c => c.name)).size !== categories.length) throw Error("EMPTY_OR_AMBIGUOUS_MENU_SECTIONS");
        menuCandidates.push(ownerAiMenuSchema.parse({name:text(menu.name,160),categories}));
      } catch (error) { menuHeld=true; holds.push("MENU_CONTENT_HOLD:"+(error as Error).message); }
    }
  }
  if (menuCandidates.length && !menuHeld && menuCandidates.length <= 25 && new Set(menuCandidates.map(m=>m.name)).size === menuCandidates.length) sections.push(evidence("menus",menuCandidates,Math.max(...intervals.map(v=>v[0])),Math.min(...intervals.map(v=>v[1]))));
  const stops: any[] = []; let scheduleHeld=false;
  for (const event of entities.filter(n => type(n,"Event") || type(n,"FoodEvent"))) {
    try {
      if (!list(event.performer).some(p=>sameIdentity(p,capture.sourceUrl))) throw Error("EXACT_BUSINESS_ATTENDANCE_REQUIRED");
      if (!enumUrl(event.eventStatus,"EventScheduled") || !enumUrl(event.eventAttendanceMode,"OfflineEventAttendanceMode")) throw Error("CONFIRMED_PHYSICAL_EVENT_REQUIRED");
      const audiences=list(event.audience);
      const accessSignals=[event.name,event.description,event.location?.name,event.location?.description,JSON.stringify(event.location?.address || {}),...audiences.map(a=>JSON.stringify(a))].join(" ");
      if (!audiences.length || !audiences.every(a=>type(a,"Audience") && /^(?:public|general public)$/i.test(String(a.audienceType))) || event.isPublic === false || event.publicAccess === false || event.location?.isPublic === false || event.location?.publicAccess === false || /\b(?:private|invitation|invited|invite.only|restricted|military|wedding)\b/i.test(accessSignals)) throw Error("EXPLICIT_PUBLIC_EVENT_ACCESS_REQUIRED");
      const timezone = text(list(event.additionalProperty).find(p=>type(p,"PropertyValue") && p.name === "IANA timezone")?.value,100);
      const startMs = instant(event.startDate), endMs = instant(event.endDate);
      const start = DateTime.fromMillis(startMs,{zone:timezone}), end = DateTime.fromMillis(endMs,{zone:timezone});
      if (!start.isValid || !end.isValid || start.getPossibleOffsets().length !== 1 || end.getPossibleOffsets().length !== 1 || start.toFormat("ss.SSS") !== "00.000" || end.toFormat("ss.SSS") !== "00.000" || startMs < now || endMs <= startMs || endMs-startMs > 24*60*60*1000 || DateTime.fromISO(event.startDate,{setZone:true}).offset !== start.offset || DateTime.fromISO(event.endDate,{setZone:true}).offset !== end.offset) throw Error("DATE_YEAR_TIMEZONE_OR_EXPIRY_HELD");
      const nativeInterval=buildSlotDateTimes({date:start.toISODate()!,timeZone:timezone,startTime:start.toFormat("HH:mm"),endTime:end.toFormat("HH:mm")});
      if (!nativeInterval || nativeInterval.startUtc.getTime() !== startMs || nativeInterval.endUtc.getTime() !== endMs) throw Error("NATIVE_EVENT_INTERVAL_NOT_REPRESENTABLE");
      const location=event.location; if (!type(location,"Place") || !type(location.address,"PostalAddress")) throw Error("EXPLICIT_PUBLIC_LOCATION_REQUIRED");
      stops.push(ownerAiScheduleStopSchema.parse({kind:"event_stop",status:"confirmed",eventName:text(event.name,200),date:start.toISODate(),startTime:start.toFormat("HH:mm"),endTime:end.toFormat("HH:mm"),locationName:text(location.name,240),address:text(location.address.streetAddress,500),city:text(location.address.addressLocality,120),state:text(location.address.addressRegion,80),timezone,isPublic:true,sourceUrl:capture.sourceUrl,expiresAt:end.toUTC().toISO()}));
    } catch(error) { scheduleHeld=true; holds.push("SCHEDULE_CONTENT_HOLD:"+(error as Error).message); }
  }
  if (stops.length && !scheduleHeld && stops.length <= 365 && new Set(stops.map(s=>[s.date,s.locationName].join("|"))).size === stops.length) sections.push(evidence("schedules",stops,now,Math.min(ttl,...stops.map(s=>Date.parse(s.expiresAt)))));
  if (!sections.some(s=>s.path==="menus")) holds.push("NO_CURRENT_COMPLETE_STRUCTURED_MENU");
  if (!sections.some(s=>s.path==="schedules")) holds.push("NO_VERIFIED_PUBLIC_DATED_BUSINESS_ATTENDANCE");
  return {sections,holds};
}
