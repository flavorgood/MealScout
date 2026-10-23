/** Real booking route + durable idempotency + DatabaseStorage on fresh PGlite.
 * Synthetic injected principals exercise auth guards, not native login.
 * Model tables omit production migrations except the actual request/rate stores.
 * Test-mode payment bypass and loopback-only networking; no provider calls.
 * PGlite serializes its connection: this is not concurrent PostgreSQL proof.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
const { build } = require('esbuild');

for (const key of Object.keys(process.env)) {
  if (/DATABASE_URL|STRIPE.*KEY|BREVO.*KEY|GOOGLE.*SECRET|FACEBOOK.*SECRET/i.test(key)) {
    delete process.env[key];
  }
}
process.env.NODE_ENV = 'test';
process.env.MEALSCOUT_TEST_MODE = 'true';
const blocked = [];
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = first && typeof first === 'object' ? first.host
    : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (!['127.0.0.1', '::1', 'localhost', undefined].includes(host) || first?.path) {
    blocked.push(String(host));
    throw new Error('Isolated booking test forbids external sockets');
  }
  return originalConnect.apply(this, args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname));
  return originalFetch(input, options);
};

const replacements = {
  [path.join(root, 'server/db.ts')]: `export let db, pool;
    export function initQaDatabase(value, driver) { db = value;
      const query = (text, values) => driver.query(text, values);
      pool = { query, connect: async () => ({ query, release() {} }) }; }`,
  [path.join(root, 'server/emailService.ts')]: `export const emailService = new Proxy({}, {
    get() { return async () => { throw new Error('Test email delivery forbidden'); }; } });`,
  [path.join(root, 'server/smsService.ts')]: `export async function sendSms() {
    throw new Error('Test SMS delivery forbidden'); }`,
};

const source = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { is, SQL, eq } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import * as schema from './shared/schema';
import { initQaDatabase } from './server/db';
import { registerHostRoutes } from './server/routes/hostRoutes';
import { registerEventRoutes } from './server/routes/eventRoutes';

export async function run(root) {
  const pg = new PGlite(), db = drizzle(pg, { schema });
  initQaDatabase(db, pg);
  let server;
  const checks = [];
  try {
    const quote = value => '"' + value.replaceAll('"', '""') + '"';
    const dialect = new PgDialect(), tables = new Map();
    for (const table of Object.values(schema)) {
      try { const config = getTableConfig(table);
        if (config?.name && config.columns) tables.set(config.name, config); } catch {}
    }
    function literal(value, type) {
      if (is(value, SQL)) return dialect.sqlToQuery(value).sql;
      if (typeof value === 'boolean' || typeof value === 'number') return String(value);
      if (value === null) return 'NULL';
      if (typeof value === 'object') value = type.endsWith('[]')
        ? '{' + value.map(v => '"' + String(v).replaceAll('"', '\\"') + '"').join(',') + '}'
        : JSON.stringify(value);
      return "'" + String(value).replaceAll("'", "''") + "'";
    }
    for (const config of tables.values()) {
      const columns = config.columns.map(column => {
        let text = quote(column.name) + ' ' + column.getSQLType();
        if (column.primary) text += ' PRIMARY KEY';
        if (column.notNull) text += ' NOT NULL';
        if (column.isUnique) text += ' UNIQUE';
        if (column.default !== undefined) text += ' DEFAULT ' + literal(column.default, column.getSQLType());
        return text;
      });
      for (const unique of config.uniqueConstraints || []) columns.push(
        'UNIQUE (' + unique.columns.map(column => quote(column.name)).join(',') + ')');
      await pg.exec('CREATE TABLE ' + quote(config.name) + ' (' + columns.join(',') + ')');
    }
    for (const file of ['058_idempotency_keys.sql', '059_rate_limit_counters.sql']) {
      await pg.exec(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
    }
    const principals = new Map();
    const hostOwnerId = randomUUID();
    await db.insert(schema.users).values({ id: hostOwnerId, email: 'qa-host@example.invalid',
      userType: 'restaurant_owner', emailVerified: true, isDisabled: false });
    const hostIds = [randomUUID(), randomUUID()];
    await db.insert(schema.hosts).values(hostIds.map((id, index) => ({ id, userId: hostOwnerId,
      businessName: index ? 'Harbor Plaza West' : 'Harbor Plaza East', address: (100 + index) + ' Fixture Avenue',
      city: 'Pensacola', state: 'FL', locationType: 'other',
      latitude: String(30.42 + index * .02), longitude: String(-87.22 - index * .02), spotCount: 1 })));
    async function ownerTruck(label) {
      const ownerId = randomUUID(), truckId = randomUUID();
      const [user] = await db.insert(schema.users).values({ id: ownerId,
        email: 'qa-' + ownerId + '@example.invalid', userType: 'restaurant_owner',
        emailVerified: true, isDisabled: false }).returning();
      principals.set(ownerId, user);
      await db.insert(schema.restaurants).values({ id: truckId, ownerId,
        name: 'QA ONLY ' + label, address: 'Synthetic local fixture',
        city: 'Pensacola', state: 'FL', businessType: 'food_truck', isFoodTruck: true,
        insuranceVerified: true, insuranceExpiresAt: new Date(Date.now() + 366 * 86400000), isActive: true });
      return { ownerId, truckId };
    }
    async function pass(hostIndex, dateKey, hours = ['06:00', '21:00'], maxTrucks = 1) {
      const id = randomUUID();
      await db.insert(schema.events).values({ id, hostId: hostIds[hostIndex],
        name: 'QA ONLY Parking', eventType: 'parking_pass', date: new Date(dateKey + 'T00:00:00.000Z'),
        startTime: hours[0], endTime: hours[1], requiresPayment: true, status: 'open',
        maxTrucks, hardCapEnabled: true, dailyPriceCents: 5000,
        breakfastPriceCents: 1500, lunchPriceCents: 2000, dinnerPriceCents: 2500, hostPriceCents: 5000 });
      return id;
    }
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = principals.get(String(req.headers['x-qa-user'] || ''));
      req.isAuthenticated = () => Boolean(req.user); next(); });
    app.use((req, res, next) => {
      const originalJson = res.json.bind(res);
      res.json = body => {
        // Transport fault only: the real durable guard records before calling this.
        if (req.headers['x-qa-drop-response'] === 'yes') { res.socket.destroy(); return res; }
        return originalJson(body);
      };
      next();
    });
    registerHostRoutes(app);
    registerEventRoutes(app, { hasCompleteProfileAccess: async () => true });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const base = 'http://127.0.0.1:' + server.address().port;
    async function book(label, owner, passId, slot = 'daily', key = randomUUID(), expected = 200, extra = {}) {
      const res = await fetch(base + '/api/parking-pass/' + passId + '/book', { method: 'POST',
        headers: { 'x-qa-user': owner.ownerId, 'Idempotency-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ truckId: owner.truckId, slotTypes: [slot], ...extra }) });
      const body = await res.json(); checks.push({ label, status: res.status, body });
      assert.equal(res.status, expected, label + ': ' + JSON.stringify(body));
      return body;
    }
    const day = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
    const shiftDay = offset => new Date(new Date(day + 'T00:00:00Z').getTime() + offset * 86400000).toISOString().slice(0, 10);
    const nextDay = shiftDay(1);
    const daily = await ownerTruck('Daily');
    const dailyA = await pass(0, day), dailyB = await pass(1, day), replayKey = randomUUID();
    const first = await book('first daily booking', daily, dailyA, 'daily', replayKey);
    assert.deepEqual(await book('same-reference replay', daily, dailyA, 'daily', replayKey), first);
    await book('same-host duplicate rejects', daily, dailyA, 'daily', randomUUID(), 400);
    await book('different host same daily interval rejects', daily, dailyB, 'daily', randomUUID(), 400);
    await book('consecutive calendar day accepts', daily, await pass(1, nextDay));
    const meals = await ownerTruck('Separated Meals');
    await book('breakfast first host accepts', meals, await pass(0, shiftDay(2)), 'breakfast');
    await book('dinner second host nonoverlap accepts', meals, await pass(1, shiftDay(2)), 'dinner');
    const cleanup = await ownerTruck('Cleanup Buffer');
    await book('lunch first host accepts', cleanup, await pass(0, shiftDay(3)), 'lunch');
    await book('daily within cleanup buffer rejects', cleanup, await pass(1, shiftDay(3), ['15:45', '21:00']), 'daily', randomUUID(), 400);
    const year = new Date().getUTCFullYear() + 1;
    const dstDay = new Date(Date.UTC(year, 10, 1));
    dstDay.setUTCDate(1 + (7 - dstDay.getUTCDay()) % 7);
    const dstKey = dstDay.toISOString().slice(0, 10), dst = await ownerTruck('DST Midnight');
    await book('DST intended-day first host accepts', dst, await pass(0, dstKey));
    await book('DST intended-day second host overlap rejects', dst, await pass(1, dstKey), 'daily', randomUUID(), 400);
    const invalid = await ownerTruck('Unsupported Overnight');
    await book('existing overnight prohibition preserved', invalid, await pass(0, shiftDay(4), ['21:00', '02:00']), 'daily', randomUUID(), 400);
    const hidden = await ownerTruck('PRIVATE RESERVATION IDENTITY');
    const fullPass = await pass(0, shiftDay(6));
    const partialPass = await pass(0, shiftDay(7), ['06:00', '21:00'], 2);
    await book('private truck initial full-capacity booking', hidden, fullPass);
    await book('private truck initial partial-capacity booking', hidden, partialPass);
    await db.update(schema.restaurants).set({ isActive: false }).where(eq(schema.restaurants.id, hidden.truckId));
    const feedResponse = await fetch(base + '/api/parking-pass');
    assert.equal(feedResponse.status, 200);
    assert.equal(feedResponse.headers.get('cache-control'), 'no-store');
    const feed = await feedResponse.json();
    assert.ok(Array.isArray(feed));
    assert.ok(!feed.some(row => row.id === fullPass), 'A private confirmed reservation still fills its host');
    const partial = feed.find(row => row.id === partialPass);
    assert.ok(partial, 'One remaining spot is still offered');
    assert.equal(partial.bookedSpots, 1);
    assert.deepEqual(partial.availableSpotNumbers, [2]);
    assert.deepEqual(partial.bookings, [], 'Occupancy must not disclose the private truck');
    assert.ok(!JSON.stringify(feed).includes(hidden.truckId));
    assert.ok(!JSON.stringify(feed).includes('PRIVATE RESERVATION IDENTITY'));
    assert.equal(partial.host.address, null, 'Guest exact-address redaction remains');
    assert.equal(partial.host.latitude, 30.42);
    assert.equal(partial.host.longitude, -87.22);
    assert.equal(partial.date.slice(0, 10), shiftDay(7));
    checks.push({ label: 'default feed retains hidden occupancy, location/date and privacy', status: 200,
      bookedSpots: partial.bookedSpots, availableSpotNumbers: partial.availableSpotNumbers, privateDetails: partial.bookings });
    const other = await ownerTruck('Other Authorized Truck');
    await book('other truck rejected from private occupied full spot', other, fullPass, 'daily', randomUUID(), 400);
    await book('other truck accepts actual remaining partial capacity', other, partialPass);
    const reloadedFeed = await (await fetch(base + '/api/parking-pass')).json();
    assert.ok(!reloadedFeed.some(row => row.id === partialPass), 'Reload removes newly full inventory');
    checks.push({ label: 'reload sees persisted capacity after second booking', status: 200 });
    const dropped = await ownerTruck('Dropped Response');
    const droppedPass = await pass(1, shiftDay(8)), droppedKey = randomUUID();
    await assert.rejects(fetch(base + '/api/parking-pass/' + droppedPass + '/book', {
      method: 'POST', headers: { 'x-qa-user': dropped.ownerId, 'Idempotency-Key': droppedKey,
        'Content-Type': 'application/json', 'x-qa-drop-response': 'yes' },
      body: JSON.stringify({ truckId: dropped.truckId, slotTypes: ['daily'] }) }),
      'The injected lost response must reach the client as a network failure');
    checks.push({ label: 'lost acknowledgement produces actual network failure', transportFailure: true });
    const retried = await book('same-reference retry recovers after lost acknowledgement', dropped, droppedPass, 'daily', droppedKey);
    const droppedRows = await db.select().from(schema.eventBookings).where(eq(schema.eventBookings.truckId, dropped.truckId));
    assert.equal(droppedRows.length, 1, 'Lost response retry cannot create another reservation');
    assert.deepEqual(retried.bookingIds, [droppedRows[0].id]);
    const rows = await db.select().from(schema.eventBookings);
    assert.equal(rows.length, 10, 'Only permitted bookings are persisted; replay adds none');
    assert.ok(rows.every(row => row.status === 'confirmed' && row.stripePaymentStatus === 'bypassed'));
    assert.equal((await db.select().from(schema.eventBookings).where(eq(schema.eventBookings.truckId, daily.truckId))).length, 2);
    console.log(JSON.stringify({ scope: 'actual hostRoutes, durable middleware and storage; fresh PGlite model tables; injected synthetic principal; payment bypass; no independent-session concurrency or native-login claim',
      checks, confirmedRows: rows.length, day, dstKey, realProviderCalls: 0 }));
    console.log('parking-pass-booking-overlap.integration: PASS');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await pg.close();
  }
}
`;

(async () => {
  try {
    const result = await build({ stdin: { contents: source, resolveDir: root,
      sourcefile: 'qa-parking-booking.ts', loader: 'ts' }, bundle: true, platform: 'node',
      format: 'cjs', target: 'node20', packages: 'external', write: false,
      alias: { '@shared': path.join(root, 'shared'), '@': path.join(root, 'client/src') },
      plugins: [{ name: 'isolated-qa-adapters', setup(builder) {
        builder.onResolve({ filter: /(?:^|\/)(?:db|emailService|smsService)(?:\.ts)?$/ }, args => {
          if (!args.path.startsWith('.')) return;
          const filename = path.resolve(args.resolveDir, args.path.replace(/\.ts$/, '') + '.ts');
          if (filename in replacements) return { path: filename, namespace: 'qa' };
        });
        builder.onLoad({ filter: /.*/, namespace: 'qa' }, args => ({
          contents: replacements[args.path], loader: 'js', resolveDir: root }));
      } }] });
    const mod = new Module(path.join(root, 'scripts/.parking-booking-compiled.cjs'));
    mod.filename = path.join(root, 'scripts/.parking-booking-compiled.cjs');
    mod.paths = Module._nodeModulePaths(root);
    mod._compile(result.outputFiles[0].text, mod.filename);
    await mod.exports.run(root);
    assert.deepEqual(blocked, [], 'No external socket attempts');
  } finally {
    net.Socket.prototype.connect = originalConnect;
    globalThis.fetch = originalFetch;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
