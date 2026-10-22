import { and, desc, eq, getTableColumns, gte, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { deals, restaurants } from "@shared/schema";

export type LocatedDealScope = { userLat: number; userLng: number; radiusKm: number };

export function locatedDealBounds(scope: LocatedDealScope) {
  const { userLat, userLng, radiusKm } = scope;
  if (!Number.isFinite(userLat) || Math.abs(userLat) > 90 ||
      !Number.isFinite(userLng) || Math.abs(userLng) > 180 ||
      !Number.isFinite(radiusKm) || radiusKm <= 0) {
    throw new Error("Invalid coordinates or radius");
  }
  const angular = Math.min(Math.PI, radiusKm / 6371);
  const latitude = userLat * Math.PI / 180;
  const minLat = Math.max(-90, (latitude - angular) * 180 / Math.PI);
  const maxLat = Math.min(90, (latitude + angular) * 180 / Math.PI);
  const spansPole = minLat <= -90 || maxLat >= 90;
  const longitudeSpan = spansPole ? 180 :
    Math.asin(Math.min(1, Math.sin(angular) / Math.cos(latitude))) * 180 / Math.PI;
  const wrap = (value: number) => ((value + 540) % 360) - 180;
  return { minLat, maxLat, west: spansPole ? -180 : wrap(userLng - longitudeSpan),
    east: spansPole ? 180 : wrap(userLng + longitudeSpan), allLongitudes: spansPole };
}

export async function getLocatedActiveDealCandidates(database: any, scope: LocatedDealScope, now = new Date()) {
  const bounds = locatedDealBounds(scope);
  const inBounds = (latitude: SQL, longitude: SQL) => and(
    sql`${latitude} between ${bounds.minLat} and ${bounds.maxLat}`,
    bounds.allLongitudes ? sql`true` : bounds.west <= bounds.east
      ? sql`${longitude} between ${bounds.west} and ${bounds.east}`
      : sql`(${longitude} >= ${bounds.west} or ${longitude} <= ${bounds.east})`,
  );
  const currentTime = now.toTimeString().slice(0, 5);
  // This is a conservative SQL candidate box, never a publication decision.
  // The canonical public projection chooses live vs static coordinates,
  // applies privacy/visibility, and checks the exact radius before any cap.
  return database.select(getTableColumns(deals)).from(deals)
    .innerJoin(restaurants, eq(deals.restaurantId, restaurants.id))
    .where(and(
      eq(deals.isActive, true),
      lte(deals.startDate, now),
      or(and(isNull(deals.endDate), eq(deals.isOngoing, true)), gte(deals.endDate, now)),
      or(eq(deals.availableDuringBusinessHours, true), sql`(
        (${deals.startTime} <= ${deals.endTime} and ${deals.startTime} <= ${currentTime} and ${currentTime} <= ${deals.endTime})
        or (${deals.startTime} > ${deals.endTime} and (${currentTime} >= ${deals.startTime} or ${currentTime} <= ${deals.endTime}))
      )`),
      or(
        inBounds(sql`${restaurants.latitude}`, sql`${restaurants.longitude}`),
        inBounds(sql`${restaurants.currentLatitude}`, sql`${restaurants.currentLongitude}`),
      ),
    )).orderBy(desc(deals.createdAt), desc(deals.id));
}
