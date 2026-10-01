import { and, asc, eq, gt, gte, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import type { PublicEventItem } from "@shared/publicProfiles";
import { ownerAiActionPacketSchema } from "@shared/ownerAiActions";
import { assertOwnerAiSourceFactBindings } from "@shared/ownerAiSourceFacts";
import { db } from "../db";
import { buildSlotDateTimes } from "./timeIntent";
import { resolveOwnerAiNativeAdapter } from "@shared/ownerAiNativeAdapters";
import { nativeOwnerAiScheduleStorage } from "./ownerAiNativeAdapters";
import { loadSourceFactAuthority, assertSourceFactAuthority } from "./ownerAiSourceFacts";
import { buildPublicDirectionsUrl } from "../publicProfiles/publicProfileUtils";
import { isPublicDiscoveryEligibleEntity } from "@shared/publicDiscoveryIntegrity";

// Re-read current publication/owner/type policy. An appearance never creates a host booking, pickup location, live movement or payment authority.
export async function buildPublicNativeFoodAppearances(input: { restaurantRow: any; showAddress?: boolean; database?: any; now?: Date }): Promise<PublicEventItem[]> {
  const database = input.database || db, now = input.now || new Date();
  let authority;
  try { authority = await loadSourceFactAuthority(input.restaurantRow.id, input.restaurantRow.ownerId, database); } catch { return []; }
  const storage = nativeOwnerAiScheduleStorage(authority.restaurant);
  if (storage.binding.profileType === "truck" || resolveOwnerAiNativeAdapter(input.restaurantRow).adapter !== storage.binding.adapter) return [];
  const dateFloor = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const rows = await database.select().from(storage.table).where(and(storage.predicate, eq(storage.table.isPublic,true), inArray(storage.table.status,["confirmed","closed"]), gt(storage.table.expiresAt,now), gte(storage.table.date,dateFloor))).orderBy(asc(storage.table.date)).limit(1000);
  const items: PublicEventItem[] = [];
  for (const row of rows) {
    if (row.isPublic !== true || row.status !== "confirmed" || row.sourceType !== "owner_ai_approved" || !row.expiresAt || new Date(row.expiresAt) <= now || !row.timezone) continue;
    const interval = buildSlotDateTimes({ date: new Date(row.date).toISOString().slice(0,10), timeZone: row.timezone, startTime: row.startTime, endTime: row.endTime });
    if (!interval || interval.endUtc <= now) continue;
    if (rows.some((closure: any) => {
      if (closure.isPublic !== true || closure.status !== "closed" || !closure.expiresAt || new Date(closure.expiresAt) <= now) return false;
      const localDay = DateTime.fromISO(new Date(closure.date).toISOString().slice(0,10), {zone: closure.timezone || "invalid"}).startOf("day");
      return !localDay.isValid || (interval.startUtc.getTime() < localDay.plus({days:1}).toMillis() && interval.endUtc.getTime() > localDay.toMillis());
    })) continue;
    const title = String(row.locationName || "Public appearance");
    if (!isPublicDiscoveryEligibleEntity({ name: title, isActive: true }) || /private|wedding|military|invitation|invite.only/i.test(String(row.notes || ""))) continue;
    if (row.sourceEvidence) {
      try {
        const { section, officialSources } = row.sourceEvidence;
        const schedules = JSON.parse(section.value);
        const packet = ownerAiActionPacketSchema.parse({ intent: "Public appearance projection", schedules, sourceFacts: { version: 2, officialSources, fields: [], sections: [section] } });
        assertOwnerAiSourceFactBindings(packet, now); assertSourceFactAuthority(packet, authority, now);
        if (!packet.schedules?.some(stop => stop.isPublic && stop.status === "confirmed" && stop.date === new Date(row.date).toISOString().slice(0,10) && stop.startTime === row.startTime && stop.endTime === row.endTime && stop.timezone === row.timezone && stop.locationName === row.locationName && (stop.address || null) === row.address && (stop.city || null) === row.city && (stop.state || null) === row.state && stop.sourceUrl === row.sourceArtifact)) continue;
      } catch { continue; }
    }
    const address = input.showAddress === false || authority.blockedFields.includes("address") ? null : [row.address,row.city,row.state].filter(Boolean).join(", ") || null;
    const directions = address ? buildPublicDirectionsUrl({ latitude: null, longitude: null, addressPublicLabel: address }) : null;
    items.push({ id: "appearance:" + row.id, title, description: null, eventType: "pop_up", startsAt: interval.startUtc.toISOString(), endsAt: interval.endUtc.toISOString(),
      dateLabel: new Date(row.date).toISOString().slice(0,10), timeWindowLabel: row.startTime + "–" + row.endTime + " (" + row.timezone + ")", locationName: title, addressPublicLabel: address, imageUrl: null,
      actionLabel: directions ? "Get directions" : "View profile", actionHref: directions || "/p/" + storage.binding.profileType + "/" + authority.restaurant.id, actionType: directions ? "directions" : "internal" });
  }
  return items.sort((a,b)=>String(a.startsAt).localeCompare(String(b.startsAt))).slice(0,8);
}
