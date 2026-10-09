// Actual registered legacy receipt and signed webhook routes, native PostgreSQL,
// separate OS workers, and the real earnings service/index. All actors, grants
// and provider responses are disposable fixtures; no financial provider writes.
// Opt in with MEALSCOUT_LEGACY_NATIVE_TEST=1 and existing PG binary directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import readline from 'node:readline';
import { spawn, fork, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import express from 'express';
import Stripe from 'stripe';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, is, SQL } from 'drizzle-orm';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { build } from 'esbuild';

const file = fileURLToPath(import.meta.url), root = path.resolve(path.dirname(file), '../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', ['-c', `safe.directory=${root}`, ...args], { cwd: root, encoding: 'utf8' }).trim();
const safeEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|Path|HOME|TMPDIR|TMP|TEMP|LANG|LC_ALL|SystemRoot|WINDIR|USERPROFILE|APPDATA|LOCALAPPDATA|COMSPEC|PATHEXT)$/.test(key)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; await delay(25); }
  throw Error(label + ' timed out');
}
async function closed(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => { socket.destroy(); resolve(error.code === 'ECONNREFUSED'); });
    socket.setTimeout(2000, () => { socket.destroy(); resolve(false); });
  });
}

async function workerMain() {
  assert.equal(process.env.MEALSCOUT_LEGACY_NATIVE_TEST, '1');
  const config = JSON.parse(fs.readFileSync(process.env.MEALSCOUT_LEGACY_NATIVE_CONFIG, 'utf8'));
  const url = new URL(config.url), provider = new URL(config.provider);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/mealscout_legacy_binding_test');
  assert.equal(provider.hostname, '127.0.0.1');
  const pool = new pg.Pool({ connectionString: config.url, max: 4, application_name: 'mealscout-legacy-worker-' + process.pid });
  const schema = createRequire(import.meta.url)(config.schema);
  const notify = value => { if (process.connected) process.send(value, error => { if (error) console.error('Fixture IPC closed:', error.code); }); };
  let gate = null;
  const originalQuery = pool.query.bind(pool);
  pool.query = async (...args) => {
    const query = args[0], text = typeof query === 'string' ? query : query.text;
    const values = typeof query === 'string' ? args[1] : query.values ?? args[1];
    const result = await originalQuery(...args);
    if (/^\s*update\s+"event_bookings"/i.test(text)) {
      notify({ type: 'cas', sqlSha256: sha(text), affected: result.rowCount });
    }
    if (gate && !gate.seen && /^\s*select\b/i.test(text) && /from\s+"event_bookings"/i.test(text) && /\blimit\b/i.test(text) && values?.includes(gate.bookingId)) {
      const selected = gate; selected.seen = true;
      notify({ type: 'read-gate', id: selected.id, bookingId: selected.bookingId });
      await selected.promise;
    }
    return result;
  };
  globalThis.__legacyNativeDb = drizzle(pool);
  const db = globalThis.__legacyNativeDb;
  const one = async (table, id) => (await db.select().from(table).where(eq(table.id, id)).limit(1))[0];
  globalThis.__legacyNativeStorage = {
    verifyRestaurantOwnership: async (truck, owner, capability) => (await originalQuery('SELECT 1 FROM qa_ownership WHERE truck_id=$1 AND owner_id=$2 AND capability=$3 AND allowed', [truck, owner, capability])).rowCount === 1,
    getUser: id => one(schema.users, id),
  };
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (input, options = {}) => {
    const target = new URL(typeof input === 'string' ? input : input.url ?? input.href);
    assert.equal(target.origin, provider.origin, 'Foreign HTTP is forbidden');
    assert.equal(options.method ?? 'GET', 'GET', 'Provider writes are forbidden');
    return fetchOriginal(input, options);
  };
  for (const transport of [http, https]) {
    const original = transport.request.bind(transport);
    transport.request = (...args) => {
      const input = args[0], hostname = typeof input === 'string' || input instanceof URL ? new URL(input).hostname : input.hostname ?? input.host;
      assert.equal(hostname, '127.0.0.1', 'External Node HTTP is forbidden');
      return original(...args);
    };
  }
  const signature = new Stripe('sk_test_signature_only_no_transport').webhooks;
  globalThis.__legacyNativeStripe = {
    paymentIntents: { retrieve: async (id, options) => {
      const response = await fetch(`${config.provider}/v1/payment_intents/${encodeURIComponent(id)}`, { method: 'GET', headers: options?.stripeAccount ? { 'Stripe-Account': options.stripeAccount } : {}, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error('Synthetic provider read ' + response.status);
      return response.json();
    } },
    webhooks: signature,
  };
  process.env.NODE_ENV = 'production';
  process.env.STRIPE_SECRET_KEY = 'sk_test_local_native_fixture';
  process.env.STRIPE_WEBHOOK_SECRET = config.secret;
  const api = createRequire(import.meta.url)(config.bundle);
  const app = express();
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use(async (req, res, next) => { try { req.user = req.get('X-QA-User') ? await one(schema.users, req.get('X-QA-User')) : null; next(); } catch (error) { next(error); } });
  api.registerEventRoutes(app, { hasCompleteProfileAccess: async () => true });
  api.registerStripeWebhookRoutes(app, { notifyHostCapacityWarning: async () => {} });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  notify({ type: 'ready', pid: process.pid, port: server.address().port });
  process.on('message', message => {
    if (message.op === 'arm') {
      assert.ok(!gate || gate.released, 'A read gate must be released before reuse');
      gate = { id: message.id, bookingId: message.bookingId, seen: false, released: false };
      gate.promise = new Promise(resolve => { gate.resolve = resolve; });
    } else if (message.op === 'release') {
      if (gate) { gate.released = true; gate.resolve(); }
    } else throw Error('Unexpected worker control');
    notify({ type: 'control', id: message.id });
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    try { if (gate) gate.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await pool.end(); process.exit(0); }
    catch (error) { console.error('Fixture worker shutdown failed:', error); process.exit(1); }
  };
  process.once('SIGTERM', stop); process.once('disconnect', stop);
}

async function main() {
  assert.equal(process.env.MEALSCOUT_LEGACY_NATIVE_TEST, '1', 'Explicit disposable-fixture opt-in required');
  for (const [key, value] of Object.entries(process.env)) {
    if (/DATABASE_URL|^PG(?:HOST|PORT|USER|PASSWORD|DATABASE)|STRIPE|BREVO|SMTP|SENDGRID|RESEND|TWILIO|SESSION_SECRET|OWNER_PASSWORD/.test(key)) assert.ok(!value, 'Forbidden ambient configuration: ' + key);
  }
  for (const directory of [root, path.join(root, 'client'), path.join(root, 'server')]) {
    assert.ok(!fs.readdirSync(directory).some(name => /^\.env(?:\.|$)/.test(name) && !name.endsWith('.example')), 'Loadable environment files are forbidden');
  }
  const source = git('rev-parse', 'HEAD'); assert.equal(git('status', '--porcelain'), '', 'Commit the fixture before recording native execution');
  const out = process.env.MEALSCOUT_LEGACY_NATIVE_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'mealscout-legacy-evidence-'));
  fs.mkdirSync(out, { recursive: true });
  const report = { source, startedAt: new Date().toISOString(), scope: 'Actual registered receipt/signed webhook routes, native PostgreSQL CAS and canonical earnings index/service, separate OS workers. Synthetic actors/grants and GET-only loopback provider. No live payment, refund, customer or production database action.', result: 'running', cases: [], workers: [], files: {}, cleanup: {}, providerWrites: 0, productionMutations: 0 };
  const workers = [], providerReads = [];
  let postgres, database, databaseCleanup, pool, providerServer, helperError;
  const emit = value => console.log('LEGACY_NATIVE ' + JSON.stringify(value));
  const rpc = async (worker, op, bookingId) => {
    assert.equal(worker.child.connected, true, 'Owned worker IPC must be connected');
    const id = randomUUID(); let sendError;
    worker.child.send({ id, op, bookingId }, error => { sendError = error; });
    await until(() => {
      if (sendError || worker.errors.length) throw sendError ?? Error(worker.errors.join('\n'));
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) throw Error('Owned worker exited during control');
      return worker.messages.find(message => message.type === 'control' && message.id === id);
    }, 'worker ' + op);
    return id;
  };
  async function test(name, fn) {
    const start = Date.now();
    try { const evidence = await fn(); report.cases.push({ name, result: 'pass', elapsedMs: Date.now() - start, evidence }); }
    catch (error) { report.cases.push({ name, result: 'fail', error: error.stack || String(error), elapsedMs: Date.now() - start }); }
    finally { await Promise.all(workers.filter(worker => worker.child.connected).map(worker => rpc(worker, 'release').catch(() => {}))); if (pool) await pool.query('UPDATE qa_ledger_failure SET enabled=false'); }
    emit(report.cases.at(-1));
  }
  try {
    const helper = path.join(root, 'scripts/qa/legacy-parking-postgres.mjs');
    const options = { env: { ...safeEnv(), MEALSCOUT_LEGACY_NATIVE_TEST: '1', MEALSCOUT_LEGACY_PG_BIN: process.env.MEALSCOUT_LEGACY_PG_BIN }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
    if (process.platform === 'win32') {
      const linuxNode = process.env.MEALSCOUT_LEGACY_WSL_NODE;
      assert.ok(linuxNode?.startsWith('/'), 'Existing WSL Node executable required');
      const linuxHelper = '/mnt/' + helper[0].toLowerCase() + helper.slice(2).replaceAll('\\', '/');
      postgres = spawn('wsl.exe', ['-d', 'Ubuntu', '--', '/usr/bin/env', 'MEALSCOUT_LEGACY_NATIVE_TEST=1', 'MEALSCOUT_LEGACY_PG_BIN=' + process.env.MEALSCOUT_LEGACY_PG_BIN, linuxNode, linuxHelper], options);
    } else postgres = spawn(process.execPath, [helper], options);
    const helperLogs = [];
    postgres.stderr.on('data', value => helperLogs.push(value.toString()));
    readline.createInterface({ input: postgres.stdout }).on('line', line => {
      try { const value = JSON.parse(line); if (value.type === 'postgres-ready') database = value; else if (value.type === 'postgres-cleanup') databaseCleanup = value; else helperLogs.push(line); } catch { helperLogs.push(line); }
    });
    postgres.once('error', error => { helperError = error; helperLogs.push(String(error)); });
    postgres.stdin?.on('error', error => { helperError = error; helperLogs.push('Fixture helper stdin: ' + error.code); });
    await until(() => { if (helperError) throw helperError; if (postgres.exitCode !== null || postgres.signalCode !== null) throw Error(helperLogs.join('\n')); return database; }, 'owned PostgreSQL ready', 60000);
    const databaseUrl = new URL(database.url);
    assert.equal(databaseUrl.hostname, '127.0.0.1'); assert.equal(databaseUrl.pathname, '/mealscout_legacy_binding_test'); assert.equal(databaseUrl.port, String(database.port));
    pool = new pg.Pool({ connectionString: database.url, max: 8, application_name: 'mealscout-legacy-coordinator' });
    await until(async () => { try { await pool.query('SELECT 1'); return true; } catch (error) { if (error.code !== 'ECONNREFUSED') throw error; return false; } }, 'native database loopback forwarding');
    assert.equal((await pool.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n, 0);
    report.database = { version: database.version, port: database.port, listen: database.listen, initialPublicTables: 0 };
    const schemaFile = path.join(out, 'schema.cjs'), bundle = path.join(out, 'routes.cjs');
    // Evidence can live outside the checkout. Resolve the existing packages
    // explicitly so bundles reuse those dependencies without installing any.
    const resolvePackage = createRequire(path.join(root, 'package.json'));
    const existingPackages = { name: 'existing-fixture-packages', setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, args => {
        if (args.kind === 'entry-point' || path.isAbsolute(args.path) || args.path.startsWith('@shared')) return;
        return { path: resolvePackage.resolve(args.path), external: true };
      });
    } };
    await build({ entryPoints: [path.join(root, 'shared/schema.ts')], outfile: schemaFile, bundle: true, platform: 'node', format: 'cjs', packages: 'external', alias: { '@shared': path.join(root, 'shared') }, plugins: [existingPackages] });
    const schema = createRequire(import.meta.url)(schemaFile), db = drizzle(pool), dialect = new PgDialect(), enums = new Set();
    const quote = value => '"' + value.replaceAll('"', '""') + '"';
    report.modelTables = [];
    for (const name of ['users', 'restaurants', 'hosts', 'events', 'eventBookings']) {
      const config = getTableConfig(schema[name]);
      for (const column of config.columns) if (column.enum?.enumName && !enums.has(column.enum.enumName)) { await pool.query('CREATE TYPE ' + quote(column.enum.enumName) + ' AS ENUM (' + column.enum.enumValues.map(value => "'" + value.replaceAll("'", "''") + "'").join(',') + ')'); enums.add(column.enum.enumName); }
      const definitions = config.columns.map(column => {
        let value = quote(column.name) + ' ' + column.getSQLType();
        if (column.primary) value += ' PRIMARY KEY'; if (column.notNull) value += ' NOT NULL';
        if (column.default !== undefined) { const d = column.default; value += ' DEFAULT ' + (is(d, SQL) ? dialect.sqlToQuery(d).sql : typeof d === 'string' ? "'" + d.replaceAll("'", "''") + "'" : typeof d === 'object' ? "'" + JSON.stringify(d).replaceAll("'", "''") + "'" : String(d)); }
        return value;
      });
      await pool.query('CREATE TABLE ' + quote(config.name) + '(' + definitions.join(',') + ')');
      report.modelTables.push({ model: name, table: config.name, columns: config.columns.map(column => column.name) });
    }
    const earningsMigration = 'migrations/074_add_host_earnings_and_payout_requests.sql';
    await pool.query(fs.readFileSync(path.join(root, earningsMigration), 'utf8'));
    report.earningsIndex = (await pool.query("SELECT indisunique,indisvalid,pg_get_expr(indpred,indrelid) predicate FROM pg_index WHERE indexrelid='uq_host_earnings_booking_entry'::regclass")).rows[0];
    assert.equal(report.earningsIndex.indisunique, true); assert.equal(report.earningsIndex.indisvalid, true); assert.match(report.earningsIndex.predicate, /booking_id IS NOT NULL/);
    await pool.query('CREATE TABLE qa_ownership(truck_id text,owner_id text,capability text,allowed boolean,PRIMARY KEY(truck_id,owner_id,capability));CREATE TABLE qa_intents(id text,account text,payload jsonb,PRIMARY KEY(id,account));CREATE TABLE qa_ledger_failure(enabled boolean);INSERT INTO qa_ledger_failure VALUES(false);');
    await pool.query("CREATE FUNCTION qa_reject_earning() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT enabled FROM qa_ledger_failure) THEN RAISE EXCEPTION 'Synthetic ledger outage' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;CREATE TRIGGER qa_earning_outage BEFORE INSERT ON host_earnings_ledger FOR EACH ROW EXECUTE FUNCTION qa_reject_earning();");
    const stubs = {
      db: 'export const db=new Proxy({}, {get(_t,k){const d=globalThis.__legacyNativeDb,v=d[k];return typeof v==="function"?v.bind(d):v;}});',
      storage: 'export const storage=new Proxy({}, {get(_t,k){const value=globalThis.__legacyNativeStorage[k];return value??(()=>{throw Error("Unexpected fixture storage call "+String(k));});}});',
      unifiedAuth: 'export const isAuthenticated=(req,res,next)=>req.user?next():res.status(401).json({message:"Synthetic authentication required"});export const isRestaurantOwner=isAuthenticated;export const isStaffOrAdmin=(_req,res)=>res.status(403).json({message:"Staff operations are outside fixture"});',
      stripe: 'export default class {constructor(){return globalThis.__legacyNativeStripe;}};',
      emailService: 'export const emailService=new Proxy({}, {get(){return async()=>{};}});',
      distributedRateLimit: 'export const distributedRateLimit=()=>((_req,_res,next)=>next());',
      geocoding: 'export const forwardGeocode=()=>{throw Error("External geocoding forbidden");};export const reverseGeocode=forwardGeocode;',
      truckEventMatchService: 'export const notifyNearbyTrucksOfEventRequest=()=>{throw Error("Unrelated matching forbidden");};',
    };
    const overrides = new Set();
    const compiled = await build({ stdin: { contents: 'export {registerEventRoutes} from "./server/routes/eventRoutes";export {registerStripeWebhookRoutes} from "./server/routes/stripeWebhookRoutes";', resolveDir: root, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external', metafile: true, alias: { '@shared': path.join(root, 'shared') }, plugins: [{ name: 'explicit-native-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => { const key = args.path === 'stripe' ? 'stripe' : args.path.startsWith('.') ? path.basename(args.path).replace(/\.[jt]s$/, '') : null; if (key && Object.hasOwn(stubs, key)) { overrides.add(args.path); return { path: key, namespace: 'fixture' }; } });
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'js', resolveDir: root }));
    } }, existingPackages] });
    report.fixtureOverrides = [...overrides].sort();
    for (const input of Object.keys(compiled.metafile.inputs)) if (!input.startsWith('fixture:')) { const absolute = path.resolve(root, input); if (fs.existsSync(absolute)) report.files[path.relative(root, absolute).replaceAll('\\', '/')] = sha(fs.readFileSync(absolute)); }
    for (const name of [earningsMigration, 'scripts/qa/legacy-parking-native.test.mjs', 'scripts/qa/legacy-parking-postgres.mjs']) report.files[name] = sha(fs.readFileSync(path.join(root, name)));
    for (const name of ['server/routes/eventRoutes.ts', 'server/routes/stripeWebhookRoutes.ts', 'server/services/legacyParkingPaymentBinding.ts', 'server/hostEarningsService.ts', 'server/utils/stripeWebhookVerification.ts']) assert.ok(report.files[name], 'Actual source required: ' + name);
    const providerApp = express();
    providerApp.get('/v1/payment_intents/:id', async (req, res) => {
      const account = req.get('Stripe-Account') ?? ''; providerReads.push({ id: req.params.id, account: account || null, method: 'GET' });
      const row = (await pool.query('SELECT payload FROM qa_intents WHERE id=$1 AND account=$2', [req.params.id, account])).rows[0];
      return row ? res.json(row.payload) : res.status(404).json({ error: 'Synthetic intent absent in requested account' });
    });
    providerApp.use((_req, res) => { report.providerWrites++; res.status(405).json({ error: 'Provider operations are GET only' }); });
    providerServer = providerApp.listen(0, '127.0.0.1'); await new Promise(resolve => providerServer.once('listening', resolve));
    const secret = 'whsec_local_' + randomUUID(), configPath = path.join(out, 'worker-config.json');
    fs.writeFileSync(configPath, JSON.stringify({ url: database.url, provider: 'http://127.0.0.1:' + providerServer.address().port, schema: schemaFile, bundle, secret }), { mode: 0o600 });
    for (let index = 0; index < 4; index++) {
      const child = fork(file, ['--worker'], { cwd: root, env: { ...safeEnv(), MEALSCOUT_LEGACY_NATIVE_TEST: '1', MEALSCOUT_LEGACY_NATIVE_CONFIG: configPath }, execArgv: [], windowsHide: true, silent: true });
      const worker = { child, messages: [], logs: [], errors: [] }; workers.push(worker);
      child.on('error', error => worker.errors.push(String(error)));
      child.on('message', value => worker.messages.push(value)); child.stdout.on('data', value => worker.logs.push(value.toString())); child.stderr.on('data', value => worker.logs.push(value.toString()));
      const ready = await until(() => { if (worker.errors.length) throw Error(worker.errors.join('\n')); if (child.exitCode !== null || child.signalCode !== null) throw Error(worker.logs.join('')); return worker.messages.find(value => value.type === 'ready'); }, 'route worker ready');
      worker.port = ready.port; report.workers.push(ready);
    }
    async function seed(model, supplied) {
      const table = schema[model], values = { ...supplied };
      for (const column of getTableConfig(table).columns) {
        const key = Object.entries(table).find(([, value]) => value === column)?.[0];
        if (!key || values[key] !== undefined || !column.notNull || column.default !== undefined || column.hasDefault) continue;
        values[key] = column.enum?.enumValues[0] ?? (column.dataType === 'number' ? 0 : column.dataType === 'boolean' ? false : column.dataType === 'date' ? new Date() : column.dataType === 'json' ? {} : column.dataType === 'array' ? [] : 'QA ' + key);
      }
      return (await db.insert(table).values(values).returning())[0];
    }
    async function fixture(strategy = 'platform') {
      const owner = await seed('users', { id: randomUUID(), email: randomUUID() + '@example.invalid', userType: 'restaurant_owner', isDisabled: false });
      const hostOwner = await seed('users', { id: randomUUID(), email: randomUUID() + '@example.invalid', userType: 'host', isDisabled: false });
      const truck = await seed('restaurants', { id: randomUUID(), ownerId: owner.id, name: 'Native QA truck' });
      const host = await seed('hosts', { id: randomUUID(), userId: hostOwner.id, businessName: 'Native QA host' });
      const event = await seed('events', { id: randomUUID(), hostId: host.id, name: 'Native QA legacy occurrence', eventType: 'parking_pass', maxTrucks: 1, date: new Date(Date.now() + 14 * 86400000), status: 'open' });
      const account = strategy === 'platform' ? null : 'acct_native_' + randomUUID().replaceAll('-', '');
      const booking = await seed('eventBookings', { id: randomUUID(), eventId: event.id, truckId: truck.id, hostId: host.id, status: 'pending', hostPriceCents: 1500, platformFeeCents: 1000, totalCents: 2500, stripePaymentIntentId: 'pi_native_' + randomUUID(), stripeApplicationFeeAmount: account ? 1000 : null, stripeTransferDestination: account, stripePaymentStatus: 'pending' });
      const intent = { id: booking.stripePaymentIntentId, status: 'succeeded', currency: 'usd', amount: 2500, amount_received: 2500, metadata: { bookingId: booking.id, eventId: event.id, truckId: truck.id, hostId: host.id }, ...(account ? { application_fee_amount: 1000 } : {}), ...(strategy === 'destination' ? { transfer_data: { destination: { id: account } } } : {}) };
      await pool.query('INSERT INTO qa_intents VALUES($1,$2,$3)', [intent.id, strategy === 'direct' ? account : '', JSON.stringify(intent)]);
      await pool.query("INSERT INTO qa_ownership VALUES($1,$2,'manageParkingPass',true)", [truck.id, owner.id]);
      return { owner, event, booking, intent, account: strategy === 'direct' ? account : undefined };
    }
    const signer = new Stripe('sk_test_signature_only_no_transport');
    async function request(worker, kind, value, options = {}) {
      const payload = JSON.stringify({ id: options.eventId ?? 'evt_native_' + value.booking.id, type: 'payment_intent.succeeded', account: value.account, data: { object: value.intent } });
      const response = await fetch('http://127.0.0.1:' + worker.port + (kind === 'receipt' ? '/api/bookings/' + value.booking.id + '/confirm' : '/api/stripe/webhook'), { method: 'POST', headers: kind === 'receipt' ? { 'Content-Type': 'application/json', 'X-QA-User': options.ownerId ?? value.owner.id } : { 'Content-Type': 'application/json', 'Stripe-Signature': options.badSignature ? 'invalid' : signer.webhooks.generateTestHeaderString({ payload, secret }) }, body: kind === 'receipt' ? '{}' : payload, signal: AbortSignal.timeout(20000) });
      const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
      return { status: response.status, body };
    }
    const row = async value => (await pool.query('SELECT * FROM event_bookings WHERE id=$1', [value.booking.id])).rows[0];
    const earnings = async value => (await pool.query('SELECT * FROM host_earnings_ledger WHERE booking_id=$1', [value.booking.id])).rows;
    async function earningOnce(value) { const rows = await earnings(value); assert.equal(rows.length, 1); assert.equal(rows[0].amount_cents, 1500); assert.equal(rows[0].entry_type, 'booking_earned'); assert.equal(rows[0].stripe_payment_intent_id, value.intent.id); return rows[0]; }
    const gateReached = (worker, id) => until(() => worker.messages.find(message => message.type === 'read-gate' && message.id === id), 'booking snapshot selected');
    for (const strategy of ['platform', 'destination', 'direct']) await test('native receipt/provider account binding and webhook earnings: ' + strategy, async () => {
      const value = await fixture(strategy), before = providerReads.length;
      assert.equal((await request(workers[0], 'receipt', value)).status, 200);
      assert.equal((await row(value)).status, 'confirmed'); assert.equal((await earnings(value)).length, 0);
      assert.equal((await request(workers[1], 'webhook', value)).status, 200); await earningOnce(value);
      const reads = providerReads.slice(before);
      assert.deepEqual(reads.map(read => read.account), strategy === 'direct' ? [null, value.account] : [null]);
      return { receiptStatus: 200, webhookStatus: 200, earnings: 1, retrieveAccounts: reads.map(read => read.account) };
    });
    const drifts = [
      ['cancellation', 'platform', "status='cancelled'"],
      ['intent rebind', 'platform', "stripe_payment_intent_id='pi_rebound'"],
      ['split change', 'platform', 'host_price_cents=1300,platform_fee_cents=1200'],
      ['fee null to value', 'platform', 'stripe_application_fee_amount=1000'],
      ['destination null to value', 'platform', "stripe_transfer_destination='acct_rebound'"],
      ['fee value to null', 'destination', 'stripe_application_fee_amount=NULL'],
      ['destination value to null', 'destination', 'stripe_transfer_destination=NULL'],
    ];
    for (const kind of ['receipt', 'webhook']) for (const [name, strategy, change] of drifts) await test('native ' + kind + ' CAS rejects post-read ' + name, async () => {
      const value = await fixture(strategy), worker = workers[kind === 'receipt' ? 0 : 1];
      const id = await rpc(worker, 'arm', value.booking.id), pending = request(worker, kind, value);
      await gateReached(worker, id);
      await pool.query('UPDATE event_bookings SET ' + change + ' WHERE id=$1', [value.booking.id]);
      const changed = await row(value); await rpc(worker, 'release'); const response = await pending;
      assert.equal(response.status, kind === 'receipt' ? 409 : 500, JSON.stringify(response));
      assert.deepEqual(await row(value), changed); assert.equal((await earnings(value)).length, 0);
      assert.equal((await pool.query('SELECT status FROM events WHERE id=$1', [value.event.id])).rows[0].status, 'open');
      return { status: response.status, bookingRetained: true, earnings: 0 };
    });
    for (const winner of ['receipt', 'webhook', 'simultaneous']) await test('native receipt/webhook race: ' + winner, async () => {
      const value = await fixture(), receiptWorker = workers[0], webhookWorker = workers[1];
      const ids = await Promise.all([rpc(receiptWorker, 'arm', value.booking.id), rpc(webhookWorker, 'arm', value.booking.id)]);
      const receipt = request(receiptWorker, 'receipt', value), webhook = request(webhookWorker, 'webhook', value);
      await Promise.all([gateReached(receiptWorker, ids[0]), gateReached(webhookWorker, ids[1])]);
      if (winner === 'receipt') { await rpc(receiptWorker, 'release'); await receipt; await rpc(webhookWorker, 'release'); }
      else if (winner === 'webhook') { await rpc(webhookWorker, 'release'); await webhook; await rpc(receiptWorker, 'release'); }
      else await Promise.all([rpc(receiptWorker, 'release'), rpc(webhookWorker, 'release')]);
      const results = await Promise.all([receipt, webhook]);
      assert.equal(results.filter(result => result.status === 200).length, 1, JSON.stringify(results));
      if (winner === 'receipt') assert.deepEqual(results.map(result => result.status), [200, 500]);
      if (winner === 'webhook') assert.deepEqual(results.map(result => result.status), [409, 200]);
      assert.ok([200, 409].includes(results[0].status)); assert.ok([200, 500].includes(results[1].status));
      assert.equal((await row(value)).status, 'confirmed');
      const stable = await row(value);
      const replays = await Promise.all(Array.from({ length: 16 }, (_, index) => request(workers[index % workers.length], 'webhook', value)));
      assert.ok(replays.every(result => result.status === 200), JSON.stringify(replays));
      await earningOnce(value); assert.deepEqual(await row(value), stable);
      return { initialStatuses: results.map(result => result.status), concurrentReplays: 16, finalEarnings: 1, confirmationSnapshotStable: true };
    });
    await test('native ledger outage returns retry and confirmed replay repairs exactly one earning', async () => {
      const value = await fixture(); await pool.query('UPDATE qa_ledger_failure SET enabled=true');
      assert.equal((await request(workers[0], 'webhook', value)).status, 500);
      const confirmed = await row(value); assert.equal(confirmed.status, 'confirmed'); assert.equal((await earnings(value)).length, 0);
      await pool.query('UPDATE qa_ledger_failure SET enabled=false');
      assert.equal((await request(workers[1], 'webhook', value)).status, 200); await earningOnce(value);
      assert.equal((await request(workers[2], 'webhook', value)).status, 200); await earningOnce(value);
      assert.deepEqual(await row(value), confirmed);
      return { firstStatus: 500, retryStatus: 200, earnings: 1, confirmationSnapshotStable: true };
    });
    await test('native registered route rejects invalid signature and unowned receipt without writes', async () => {
      const value = await fixture(), before = await row(value);
      assert.equal((await request(workers[0], 'webhook', value, { badSignature: true })).status, 400);
      const other = await seed('users', { id: randomUUID(), email: randomUUID() + '@example.invalid', isDisabled: false });
      assert.equal((await request(workers[1], 'receipt', value, { ownerId: other.id })).status, 403);
      assert.deepEqual(await row(value), before); assert.equal((await earnings(value)).length, 0);
      return { invalidSignature: 400, unownedReceipt: 403, earnings: 0 };
    });
    report.nativeWorkerConnections = (await pool.query("SELECT count(DISTINCT application_name)::int n FROM pg_stat_activity WHERE application_name LIKE 'mealscout-legacy-worker-%'")).rows[0].n;
    assert.equal(report.nativeWorkerConnections, 4); assert.equal(report.providerWrites, 0);
    report.casStatements = workers.flatMap(worker => worker.messages.filter(message => message.type === 'cas'));
    assert.ok(report.casStatements.some(statement => statement.affected === 0)); assert.ok(report.casStatements.some(statement => statement.affected === 1));
    report.providerReads = providerReads; report.result = report.cases.every(value => value.result === 'pass') ? 'pass' : 'fail';
  } catch (error) { report.result = 'fail'; report.harnessFailure = error.stack || String(error); }
  finally {
    for (const worker of workers) {
      try {
        if (worker.child.connected) worker.child.disconnect();
        await until(() => worker.child.exitCode !== null || worker.child.signalCode !== null || !worker.child.pid, 'owned worker stop', 10000);
        assert.equal(worker.child.exitCode, 0, 'Owned worker must shut down successfully');
        assert.equal(worker.child.signalCode, null, 'Owned worker must not require signal termination');
        assert.equal(worker.errors.length, 0, 'Owned worker must have no captured process errors');
        if (worker.port) assert.equal(await closed(worker.port), true);
      } catch (error) {
        report.cleanup.workerFailure = String(error); report.result = 'fail';
        if (worker.child.pid && worker.child.exitCode === null && worker.child.signalCode === null) {
          worker.child.kill('SIGKILL');
          try { await until(() => worker.child.exitCode !== null || worker.child.signalCode !== null, 'owned worker termination', 10000); }
          catch (terminationError) { report.cleanup.workerTerminationFailure = String(terminationError); }
        }
      }
      fs.writeFileSync(path.join(out, 'worker-' + worker.child.pid + '.log'), worker.logs.join(''));
    }
    if (providerServer) { providerServer.closeAllConnections(); await new Promise(resolve => providerServer.close(resolve)); }
    if (pool) await pool.end();
    if (postgres) {
      try {
        if (postgres.stdin?.writable && !postgres.stdin.destroyed) postgres.stdin.end('stop\n');
        await until(() => postgres.exitCode !== null || postgres.signalCode !== null || !postgres.pid, 'owned PostgreSQL helper stop', 60000);
        assert.equal(postgres.exitCode, 0); assert.equal(databaseCleanup?.stopped, true); assert.equal(databaseCleanup?.postgresStatus, 3); assert.equal(databaseCleanup?.ownedDirectoryRemoved, true);
        // WSL's Windows TCP relay may outlive the stopped Linux listener.
        // Native pg_ctl status above is the ownership/stop assertion.
        if (database) report.cleanup.windowsTcpRelayClosed = await closed(database.port);
      }
      catch (error) { report.cleanup.postgresFailure = String(error); report.result = 'fail'; }
    }
    report.cleanup.postgres = databaseCleanup;
    report.finalSourceClean = git('rev-parse', 'HEAD') === source && git('status', '--porcelain') === '';
    if (!report.finalSourceClean) report.result = 'fail';
    report.finishedAt = new Date().toISOString(); report.passed = report.cases.filter(value => value.result === 'pass').length; report.failed = report.cases.filter(value => value.result === 'fail').length;
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(report, null, 2) + '\n');
    emit({ result: report.result, source, passed: report.passed, failed: report.failed, harnessFailure: report.harnessFailure, cleanup: report.cleanup, finalSourceClean: report.finalSourceClean });
    process.exitCode = report.result === 'pass' ? 0 : 1;
  }
}
if (process.argv.includes('--worker')) await workerMain(); else await main();
