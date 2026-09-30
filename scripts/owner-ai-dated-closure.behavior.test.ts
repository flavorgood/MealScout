import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableColumns, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { truckManualSchedules, restaurants, users, hosts, events, eventBookings, eventSeries } from "../shared/schema";
import { ownerAiActionPacketSchema, OWNER_AI_PACKET_JSON_SCHEMA } from "../shared/ownerAiActions";

process.env.NODE_ENV = "development";
delete process.env.DATABASE_URL;
const { applyCanonicalPacket } = await import("../server/services/ownerAiActions");
const { assembleTruckOperatingPlan } = await import("../server/services/truckOperatingPlan");
const engine = new PGlite();
for (const [name, table] of Object.entries({ truck_manual_schedules: truckManualSchedules, restaurants, users, hosts, events, event_bookings: eventBookings, event_series: eventSeries })) {
  const columns = Object.values(getTableColumns(table));
  await engine.exec(`create table ${name} (${columns.map((c) => `"${c.name}" ${/^(varchar|text|boolean|timestamp|integer|numeric|json|serial|double|real|bigint)/.test(c.getSQLType()) ? c.getSQLType() : "text"} ${c.name === "id" ? "primary key default gen_random_uuid()" : ""}`).join(",")} )`);
}
const database = drizzle(engine);
await database.insert(users).values({ id: "owner", isDisabled: false });
await database.insert(restaurants).values({ id: "selected", ownerId: "owner", isActive: true });
const now = new Date("2026-09-30T16:00:00Z");
const restaurant = { id: "selected", city: "Pensacola", state: "FL", operatingHours: { wed: [{ open: "08:00", close: "22:00" }] } };
const closure = { status: "closed", date: "2026-09-30", timezone: "America/Chicago", expiresAt: "2026-10-01T05:00:00Z", notes: "Closed for maintenance" };
const packet = (stop: object) => ownerAiActionPacketSchema.parse({ intent: "Review dated service change", schedules: [stop] });
const apply = async (stop: object) => database.transaction((tx) => applyCanonicalPacket(tx, restaurant, packet(stop), now));
const planFor = (row: any, at = now) => assembleTruckOperatingPlan({ rows: [{ ...row, sourceKind: "manual", stopId: row.id, sourceStatus: row.status }], now: at });
try {
  assert.deepEqual(OWNER_AI_PACKET_JSON_SCHEMA.$defs.schedule.properties.status.enum, ["confirmed", "closed"]);
  assert.deepEqual(OWNER_AI_PACKET_JSON_SCHEMA.$defs.schedule.allOf[0].then.required, ["timezone", "expiresAt"]);
  for (const bad of ["2026-02-29", "2026-04-31", "2026-13-01"]) assert.equal(ownerAiActionPacketSchema.safeParse({ intent: "Bad date", schedules: [{ ...closure, date: bad }] }).success, false);
  assert.equal(packet({ ...closure, date: "2028-02-29", expiresAt: "2028-03-01T06:00:00Z" }).schedules![0].date, "2028-02-29");
  for (const extra of [{ expiresAt: undefined }, { timezone: undefined }, { timezone: "Fictional/Zone" }, { startTime: "10:00" }, { endTime: "11:00" }, { locationName: "Market" }, { locationName: "" }, { address: "1 Main" }, { kind: "event_stop" }, { eventName: "Market" }]) {
    assert.equal(ownerAiActionPacketSchema.safeParse({ intent: "Invalid closure", schedules: [{ ...closure, ...extra }] }).success, false, JSON.stringify(extra));
  }
  await assert.rejects(apply({ ...closure, expiresAt: "2026-09-30T15:59:00Z" }), (error: any) => error.code === "invalid_closure_expiry");
  const beyondMidnight = packet(closure);
  beyondMidnight.schedules![0].expiresAt = "2026-10-01T05:00:01Z";
  assert.equal(ownerAiActionPacketSchema.safeParse({ intent: "Too late", schedules: [{ ...closure, expiresAt: "2026-10-01T05:00:01Z" }] }).success, false);
  await assert.rejects(database.transaction((tx) => applyCanonicalPacket(tx, restaurant, beyondMidnight, now)), (error: any) => error.code === "invalid_closure_expiry");
  for (const expiry of ["2026-10-01T05:00:00Z", "2026-11-01T04:59:59Z", "2026-11-01T05:00:00Z"]) {
    assert.equal(ownerAiActionPacketSchema.safeParse({ intent: "Reject expiry before closure day", schedules: [{ ...closure, date: "2026-11-01", expiresAt: expiry }] }).success, false, "Native schema must reject invalid expiry before preview");
    const approved = ownerAiActionPacketSchema.parse({ intent: "Reject corrupted stored expiry", schedules: [closure, { ...closure, date: "2026-11-01", expiresAt: "2026-11-02T06:00:00Z" }] });
    approved.schedules![1].expiresAt = expiry;
    await assert.rejects(database.transaction((tx) => applyCanonicalPacket(tx, restaurant, approved, now)), (error: any) => error.code === "invalid_closure_expiry", expiry + " must not expire before or at closure-local day start");
    assert.equal((await database.select().from(truckManualSchedules)).length, 0, "Invalid future expiry rolls back earlier valid closure writes");
  }
  assert.equal((await database.select().from(truckManualSchedules)).length, 0);
  const weeklyBefore = structuredClone(restaurant.operatingHours);
  await apply(closure);
  let rows = await database.select().from(truckManualSchedules);
  assert.equal(rows.length, 1);
  let row = rows[0];
  assert.equal(row.status, "closed");
  assert.equal(row.timezone, "America/Chicago");
  assert.equal(row.startTime, null); assert.equal(row.endTime, null);
  assert.equal(row.mapEligible, false); assert.equal(row.liveFeedEligible, true);
  assert.equal(row.recurring, false);
  assert.equal(row.expiresAt?.toISOString(), closure.expiresAt.replace("Z", ".000Z"));
  assert.deepEqual(restaurant.operatingHours, weeklyBefore);
  const plan = planFor(row);
  assert.equal(plan.status, "closed"); assert.equal(plan.statusLabel, "Closed"); assert.equal(plan.closedCount, 1);
  assert.equal(plan.closedStops[0].status, "closed"); assert.equal(plan.closedStops[0].directionsUrl, null);
  assert.equal(plan.currentStop, null); assert.equal(plan.todayStop, null); assert.equal(plan.nextStop, null); assert.equal(plan.upcomingCount, 0);
  assert.equal(planFor(row, new Date(closure.expiresAt)).closedCount, 0);
  assert.equal(planFor({ ...row, expiresAt: null }, new Date("2026-10-01T06:00:00Z")).closedCount, 0);
  await apply(closure); assert.equal((await database.select().from(truckManualSchedules)).length, 1, "Natural-key replay updates same closure");
  await apply({ ...closure, id: row.id, isPublic: false });
  row = (await database.select().from(truckManualSchedules))[0];
  assert.equal(planFor(row).closedCount, 0, "Private closure remains hidden");
  assert.equal(row.mapEligible, false); assert.equal(row.liveFeedEligible, false);
  await apply({ status: "closed", date: closure.date, id: row.id, operation: "archive" });
  row = (await database.select().from(truckManualSchedules))[0];
  assert.equal(row.status, "cancelled"); assert.equal(planFor(row).closedCount, 0);
  const foreignId = randomUUID();
  await database.insert(truckManualSchedules).values({ id: foreignId, truckId: "unrelated", date: new Date("2026-09-30T00:00:00Z"), locationName: "Closed", status: "confirmed" });
  const before = await database.select().from(truckManualSchedules);
  for (const proposed of [{ ...closure, id: foreignId }, { ...closure, id: foreignId, operation: "archive" }, { date: closure.date, id: foreignId, locationName: "Closed" }, { ...closure, id: randomUUID() }]) {
    await assert.rejects(apply(proposed), (error: any) => error.code === "schedule_not_found" && error.status === 409);
    assert.deepEqual(await database.select().from(truckManualSchedules), before, "Rejecting explicit IDs must neither retarget same-date local row nor insert");
  }
  await assert.rejects(database.transaction((tx) => applyCanonicalPacket(tx, restaurant, ownerAiActionPacketSchema.parse({ intent: "Atomic rollback", schedules: [closure, { ...closure, id: foreignId }] }), now)), (error: any) => error.code === "schedule_not_found");
  assert.deepEqual(await database.select().from(truckManualSchedules), before, "A later invalid explicit ID rolls back earlier writes in the same approval transaction");
  await apply({ ...closure, date: "2026-11-01", timezone: "America/New_York", expiresAt: "2026-11-02T05:00:00Z" });
  const dst = (await database.select().from(truckManualSchedules)).find((value) => value.timezone === "America/New_York")!;
  assert.equal(dst.expiresAt!.toISOString(), "2026-11-02T05:00:00.000Z", "DST next midnight is computed in the explicit timezone, not fixed 24-hour arithmetic");
  await apply({ date: "2026-10-02", startTime: "10:00", endTime: "14:00", locationName: "Existing normal stop", timezone: "America/Chicago" });
  const normal = (await database.select().from(truckManualSchedules).where(eq(truckManualSchedules.locationName, "Existing normal stop")))[0];
  assert.equal(normal.status, "confirmed"); assert.equal(normal.mapEligible, true); assert.equal(normal.liveFeedEligible, true);
  const conflictId = randomUUID();
  const service = { id: conflictId, truckId: restaurant.id, date: new Date("2026-09-30T00:00:00Z"), status: "confirmed", startTime: "10:00", endTime: "14:00", locationName: "Public lunch", timezone: "America/Chicago", isPublic: true, liveFeedEligible: true, mapEligible: true, lastConfirmedAt: now };
  await database.insert(truckManualSchedules).values(service);
  const collisionBefore = await database.select().from(truckManualSchedules);
  await assert.rejects(apply(closure), (error: any) => error.code === "closure_schedule_conflict");
  assert.deepEqual(await database.select().from(truckManualSchedules), collisionBefore, "Conflicting closure changes roll back");
  const archive = { id: conflictId, date: closure.date, operation: "archive" };
  await database.transaction((tx) => applyCanonicalPacket(tx, restaurant, ownerAiActionPacketSchema.parse({ intent: "Explicitly reviewed archive and closure", schedules: [closure, archive] }), now));
  assert.equal((await database.select().from(truckManualSchedules).where(eq(truckManualSchedules.id, conflictId)))[0].status, "cancelled");
  const overnightId = randomUUID();
  await database.insert(truckManualSchedules).values({ ...service, id: overnightId, date: new Date("2026-09-29T00:00:00Z"), startTime: "23:00", endTime: "14:00" });
  await assert.rejects(apply(closure), (error: any) => error.code === "closure_schedule_conflict", "Previous-date overnight service overlapping the closure local day also conflicts");
  await apply({ id: overnightId, date: "2026-09-29", operation: "archive" });
  await database.insert(truckManualSchedules).values({ ...service, id: randomUUID(), isPublic: false });
  await database.insert(truckManualSchedules).values({ ...service, id: randomUUID(), truckId: "unrelated" });
  await apply(closure); // Private and another profile's public stops do not block.
  await database.insert(users).values({ id: "host-user", isDisabled: false });
  await database.insert(hosts).values({ id: "host", userId: "host-user", businessName: "Garden Plaza", city: "Pensacola", state: "FL" });
  await database.insert(eventSeries).values({ id: "series", timezone: "America/Chicago" });
  await database.insert(events).values({ id: "event", hostId: "host", seriesId: "series", name: "Garden Lunch", eventType: "food_truck_night", date: service.date, startTime: "10:00", endTime: "14:00", status: "open", requiresPayment: false });
  await database.insert(eventBookings).values({ id: "booking", eventId: "event", truckId: restaurant.id, hostId: "host", status: "confirmed", bookingConfirmedAt: now });
  const beforeBookingCollision = await database.select().from(truckManualSchedules);
  await assert.rejects(apply(closure), (error: any) => error.code === "closure_schedule_conflict");
  assert.deepEqual(await database.select().from(truckManualSchedules), beforeBookingCollision);
  assert.equal((await database.select().from(eventBookings))[0].status, "confirmed", "Closure must never automatically cancel booking");
  await database.update(events).set({ eventType: "private_event" }).where(eq(events.id, "event"));
  await apply(closure); // Canonical private events do not advertise public availability.
  await database.update(events).set({ eventType: "food_truck_night" }).where(eq(events.id, "event"));
  await database.update(eventBookings).set({ truckId: "unrelated" }).where(eq(eventBookings.id, "booking"));
  await apply(closure); // Another truck's booking cannot block or be retargeted.
  // Inventory collisions must survive both the loader's 15-day horizon and
  // the UI's seven-day lookahead / 72-hour confirmation TTL.
  for (const date of ["2026-10-08", "2026-11-01"]) {
    const expiry = date === "2026-10-08" ? "2026-10-09T05:00:00Z" : "2026-11-02T06:00:00Z";
    const futureClosure = { ...closure, date, expiresAt: expiry };
    const futureId = randomUUID();
    await database.insert(truckManualSchedules).values({ ...service, id: futureId, date: new Date(date + "T00:00:00Z"), lastConfirmedAt: new Date("2026-09-01T00:00:00Z") });
    const beforeFuture = await database.select().from(truckManualSchedules);
    await assert.rejects(apply(futureClosure), (error: any) => error.code === "closure_schedule_conflict", date + " manual inventory cannot disappear behind UI horizon/TTL");
    assert.deepEqual(await database.select().from(truckManualSchedules), beforeFuture, "Future manual conflict rolls back all closure edits");
    await apply({ id: futureId, date, operation: "archive" });
    await database.update(events).set({ date: new Date(date + "T00:00:00Z") }).where(eq(events.id, "event"));
    await database.update(eventBookings).set({ truckId: restaurant.id, status: "confirmed", bookingConfirmedAt: new Date("2026-09-01T00:00:00Z") }).where(eq(eventBookings.id, "booking"));
    const beforeFutureBooking = await database.select().from(truckManualSchedules);
    await assert.rejects(apply(futureClosure), (error: any) => error.code === "closure_schedule_conflict", date + " durable confirmed booking cannot disappear behind UI horizon");
    assert.deepEqual(await database.select().from(truckManualSchedules), beforeFutureBooking);
    assert.equal((await database.select().from(eventBookings))[0].status, "confirmed");
    await database.update(eventBookings).set({ status: "cancelled" }).where(eq(eventBookings.id, "booking"));
    await apply(futureClosure);
  }
  const futureOvernightId = randomUUID();
  await database.insert(truckManualSchedules).values({ ...service, id: futureOvernightId, date: new Date("2026-10-31T00:00:00Z"), timezone: "America/New_York", startTime: "23:00", endTime: "14:00", lastConfirmedAt: new Date("2026-09-01T00:00:00Z") });
  await assert.rejects(apply({ ...closure, date: "2026-11-01", expiresAt: "2026-11-02T06:00:00Z" }), (error: any) => error.code === "closure_schedule_conflict", "Far-future overnight service in another timezone overlaps the closure day");
  await apply({ id: futureOvernightId, date: "2026-10-31", operation: "archive" });
  const boundaryId = randomUUID();
  await database.insert(truckManualSchedules).values({ ...service, id: boundaryId, date: new Date("2026-10-31T00:00:00Z"), startTime: "22:00", endTime: "00:00" });
  await apply({ ...closure, date: "2026-11-01", expiresAt: "2026-11-02T06:00:00Z" }); // End exactly at closure midnight is not overlap.
  console.log("PASS native dated-closure schema, real SQL WHERE writer/transactions, public closed projection, expiry, privacy/archive, calendar/timezone and ID isolation");
} finally { await engine.close(); }
