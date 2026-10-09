import assert from 'node:assert/strict';
import http from 'node:http';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import session from 'express-session';
import { io as connectSocket } from 'socket.io-client';
import { Server as SocketIOServer } from 'socket.io';
import WebSocket from 'ws';

const nativeSource = new URL('../server/websocket.ts', import.meta.url);
const fixtureSource = new URL('./native-hosted-realtime-fixture.mjs', import.meta.url);
const substitutedImports = new Set([
  './storage', './roleAccess', './utils/realtimeMetrics',
  './publicProfiles/toPublicRestaurantListingWithVisibility',
  './services/profileEvidenceQuarantine', './utils/publicBusinessVisibility',
]);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL === nativeSource.href && substitutedImports.has(specifier)) {
    return { url: fixtureSource.href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });

const host = 'mealscout-native-fixture.example.com';
const origin = `https://${host}`;
process.env.ALLOWED_ORIGINS = origin;
const { setupWebSocketServer } = await import(nativeSource.href);
let server, io, port, cookies, gatewayServer, disposeBinding, platformIo;
let platformConnections = 0;
const gatewayRuntimePath = process.env.MEALSCOUT_HOST_GATEWAY_RUNTIME_SOURCE;
const gatewayUpgradePath = process.env.MEALSCOUT_HOST_GATEWAY_UPGRADE_SOURCE;
assert.equal(Boolean(gatewayRuntimePath), Boolean(gatewayUpgradePath), 'Supply both exact gateway modules');
const hosted = Boolean(gatewayRuntimePath);
let authorityAvailable = true;
const clients = new Set();
const sockets = new Set();

function raw(path, { cookie, requestHost = host, requestOrigin = origin } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path, agent: false,
      headers: { Host: requestHost, Origin: requestOrigin, 'X-Forwarded-Proto': 'https', ...(cookie ? { Cookie: cookie } : {}) },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode,
        headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.once('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('Owned HTTP fixture deadline')));
  });
}

function event(socket, name, trigger, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, received); reject(new Error(`Missing ${name} event`)); }, timeoutMs);
    const received = (value) => { clearTimeout(timer); socket.off(name, received); resolve(value); };
    socket.once(name, received);
    trigger?.();
  });
}

async function open(cookie, { transports = ['websocket'], extraHeaders = {} } = {}) {
  const client = connectSocket(`http://127.0.0.1:${port}`, { autoConnect: false, forceNew: true,
    reconnection: false, transports, timeout: 1500,
    extraHeaders: { Host: host, Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
  });
  clients.add(client);
  const ready = event(client, 'connect');
  client.connect();
  await ready;
  return client;
}

function disconnect(client) {
  const native = io.sockets.sockets.get(client.id);
  if (!native) { client.disconnect(); return Promise.resolve(); }
  return event(native, 'disconnect', () => client.disconnect());
}

async function subscribe(client, kind) {
  return event(client, 'subscribed', () => client.emit(`subscribe_${kind}`, { restaurantId: 'fixture-restaurant' }));
}

// Optional hosted mode runs the exact shared dispatcher and Meal relay over
// owned loopback sockets. Accounts, owner resolver and MemoryStore are fixtures.
describe(`MealScout native socket lifecycle${hosted ? ' through the pinned shared dispatcher and Meal relay' : ''}`, { concurrency: false }, () => {
  before(async () => {
    const app = express();
    app.set('trust proxy', 1);
    const nativeSession = session({ name: 'tradescout.sid', secret: 'owned-loopback-fixture-not-provider-credential',
      resave: false, saveUninitialized: false, store: new session.MemoryStore(), proxy: true,
      cookie: { secure: true, httpOnly: true, sameSite: 'none' },
    });
    app.use(nativeSession);
    app.get('/fixture-session/:userId', (req, res) => {
      req.session.passport = { user: req.params.userId };
      req.session.save((error) => error ? res.sendStatus(500) : res.send('fixture-only'));
    });
    server = http.createServer(app);
    server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    io = setupWebSocketServer(server, nativeSession);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    cookies = {};
    for (const actor of ['fixture-owner', 'fixture-other', 'fixture-disabled']) {
      const result = await raw(`/fixture-session/${actor}`);
      assert.equal(result.status, 200);
      cookies[actor] = result.headers['set-cookie'][0].split(';', 1)[0];
    }
    if (hosted) {
      const digest = (filename) => createHash('sha256').update(readFileSync(filename)).digest('hex');
      assert.equal(digest(gatewayRuntimePath), 'cd8fcbfebe199fc639c649137662df8e6416b66342aef88dcf6914b29ec7b27c');
      assert.equal(digest(gatewayUpgradePath), 'c664929930417afc54b9f4e1b0d6a0378f0da317579bcc8ed7e2df299c8d354a');
      const { createProfileHostedRuntimeRegistry, createProfileHostedRuntimeMiddleware } = await import(pathToFileURL(gatewayRuntimePath));
      const { attachProfileHostedRuntimeServer } = await import(pathToFileURL(gatewayUpgradePath));
      const { createMealScoutHostedRuntimeBinding } = await import(new URL('../server/integrations/tradeScoutHostedRuntime.ts', import.meta.url));
      const registry = createProfileHostedRuntimeRegistry();
      const authority = { host, profileId: 'fixture-routing-profile', ownerUserId: 'fixture-routing-owner', slug: 'fixture-food' };
      const resolveAuthority = async (requestedHost) => authorityAvailable && requestedHost === host ? authority : null;
      const binding = createMealScoutHostedRuntimeBinding({ ...authority,
        upstreamOrigin: `http://127.0.0.1:${port}`, nativeRealtimeAuthorization: 'mealscout-engine-session-v1' });
      disposeBinding = registry.register(binding);
      const gateway = express();
      gateway.use(createProfileHostedRuntimeMiddleware({ registry, resolveAuthority }));
      gateway.use((_req, res) => res.sendStatus(404));
      gatewayServer = http.createServer(gateway);
      // The owning shared server has its own Engine.IO upgrade listener. Use a
      // real platform Socket.IO listener to prove exclusive hosted dispatch.
      platformIo = new SocketIOServer(gatewayServer);
      platformIo.on('connection', (socket) => { platformConnections++; socket.disconnect(true); });
      attachProfileHostedRuntimeServer(gatewayServer, { registry, resolveAuthority, handleRequest: gateway });
      gatewayServer.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      await new Promise((resolve) => gatewayServer.listen(0, '127.0.0.1', resolve));
      port = gatewayServer.address().port;
    }
  });

  after(async () => {
    for (const client of clients) client.disconnect();
    disposeBinding?.();
    if (platformIo) await new Promise((resolve) => platformIo.close(resolve));
    assert.equal(platformConnections, 0, 'Hosted sockets never enter platform Engine.IO');
    await new Promise((resolve) => io.close(resolve));
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });

  for (const kind of ['kitchen', 'restaurant']) {
    test(`${kind}: another same-account disconnect cannot prevent unsubscribe`, async () => {
      const first = await open(cookies['fixture-owner']);
      const second = await open(cookies['fixture-owner']);
      try {
        const firstRoom = await subscribe(first, kind);
        const secondRoom = await subscribe(second, kind);
        assert.equal(firstRoom.room, secondRoom.room);
        const nativeSecond = io.sockets.sockets.get(second.id);
        await disconnect(first);
        const result = await event(second, 'unsubscribed', () => second.emit(
          kind === 'kitchen' ? 'unsubscribe_kitchen' : 'unsubscribe',
          kind === 'kitchen' ? { restaurantId: 'fixture-restaurant' } : { room: secondRoom.room },
        ), 300);
        assert.equal(result.room, secondRoom.room);
        assert.equal(nativeSecond.rooms.has(secondRoom.room), false);
      } finally { await disconnect(first); await disconnect(second); }
    });

    test(`${kind}: one same-account unsubscribe cannot erase another socket's room intent`, async () => {
      const first = await open(cookies['fixture-owner']);
      const second = await open(cookies['fixture-owner']);
      try {
        const room = await subscribe(first, kind);
        await subscribe(second, kind);
        const leave = (client) => event(client, 'unsubscribed', () => client.emit(
          kind === 'kitchen' ? 'unsubscribe_kitchen' : 'unsubscribe',
          kind === 'kitchen' ? { restaurantId: 'fixture-restaurant' } : { room: room.room },
        ), 300);
        await leave(first);
        assert.equal(io.sockets.sockets.get(second.id).rooms.has(room.room), true);
        await leave(second);
        assert.equal(io.sockets.sockets.get(second.id).rooms.has(room.room), false);
      } finally { await disconnect(first); await disconnect(second); }
    });
  }

  test('anonymous SDK admin hints do not grant kitchen access', async () => {
    const client = await open(undefined, { extraHeaders: { 'X-Sdk-Roles': 'admin', 'X-Forwarded-Host': host } });
    try {
      const error = await event(client, 'error', () => client.emit('subscribe_kitchen', { restaurantId: 'fixture-restaurant' }));
      assert.equal(error.message, 'Authentication required');
      assert.equal(io.sockets.sockets.get(client.id).rooms.has('kitchen:fixture-restaurant'), false);
    } finally { await disconnect(client); }
  });

  test('a real fixture native session still requires restaurant ownership', async () => {
    const client = await open(cookies['fixture-other']);
    try {
      const error = await event(client, 'error', () => client.emit('subscribe_kitchen', { restaurantId: 'fixture-restaurant' }));
      assert.equal(error.message, 'Unauthorized: kitchen access denied');
      assert.equal(io.sockets.sockets.get(client.id).rooms.has('kitchen:fixture-restaurant'), false);
    } finally { await disconnect(client); }
  });

  test('disabled native actor is rejected before WebSocket connection', async () => {
    const client = connectSocket(`http://127.0.0.1:${port}`, { autoConnect: false, forceNew: true,
      reconnection: false, transports: ['websocket'], timeout: 1500,
      extraHeaders: { Host: host, Origin: origin, Cookie: cookies['fixture-disabled'] },
    });
    clients.add(client);
    let connected = false;
    client.once('connect', () => { connected = true; });
    await event(client, 'connect_error', () => client.connect());
    assert.equal(connected, false);
    client.disconnect();
  });

  for (const mismatch of ['actor', 'missing-session', 'host', 'origin']) {
    test(`native Engine.IO sid rejects ${mismatch} mismatch on a subsequent polling request`, async () => {
      const first = await raw('/socket.io/?EIO=4&transport=polling', { cookie: cookies['fixture-owner'] });
      assert.equal(first.status, 200);
      const sid = JSON.parse(first.body.slice(1)).sid;
      const options = { cookie: cookies['fixture-owner'] };
      if (mismatch === 'actor') options.cookie = cookies['fixture-other'];
      if (mismatch === 'missing-session') options.cookie = undefined;
      if (mismatch === 'host') options.requestHost = 'other-native-fixture.example.com';
      if (mismatch === 'origin') options.requestOrigin = 'https://unapproved-native-fixture.example.com';
      const result = await raw(`/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`, options);
      assert.equal(result.status, 400);
      io.engine.clients[sid]?.close(true);
    });
  }

  test('a fresh native reconnect can subscribe and leave its own room', async () => {
    const first = await open(cookies['fixture-owner']);
    const oldId = first.id;
    await subscribe(first, 'kitchen');
    await disconnect(first);
    assert.equal(io.sockets.sockets.has(oldId), false);
    const next = await open(cookies['fixture-owner']);
    try {
      assert.notEqual(next.id, oldId);
      await subscribe(next, 'kitchen');
      await event(next, 'unsubscribed', () => next.emit('unsubscribe_kitchen', { restaurantId: 'fixture-restaurant' }));
      assert.equal(io.sockets.sockets.get(next.id).rooms.has('kitchen:fixture-restaurant'), false);
    } finally { await disconnect(next); }
  });

  test('polling upgrades to native WebSocket while preserving the actual native session', async () => {
    // Node's XHR transport rewrites Host to its loopback URL. Drive the actual
    // Engine.IO probe on owned HTTP/ws sockets with consistent public Host.
    const result = await raw('/socket.io/?EIO=4&transport=polling', { cookie: cookies['fixture-owner'] });
    assert.equal(result.status, 200);
    const sid = JSON.parse(result.body.slice(1)).sid;
    const websocket = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket&sid=${encodeURIComponent(sid)}`,
      { headers: { Host: host, Origin: origin, Cookie: cookies['fixture-owner'] } });
    try {
      await event(websocket, 'open');
      const probe = await event(websocket, 'message', () => websocket.send('2probe'));
      assert.equal(probe.toString(), '3probe');
      const upgraded = event(io.engine.clients[sid], 'upgrade');
      websocket.send('5');
      await upgraded;
      assert.equal(io.engine.clients[sid].transport.name, 'websocket');
      const acknowledgement = await event(websocket, 'message', () => websocket.send('40'));
      assert.ok(acknowledgement.toString().startsWith('40'));
      const native = io.sockets.sockets.get(JSON.parse(acknowledgement.toString().slice(2)).sid);
      assert.equal(native.userId, 'fixture-owner');
      const subscription = await event(websocket, 'message', () => websocket.send('42["subscribe_kitchen",{"restaurantId":"fixture-restaurant"}]'));
      assert.deepEqual(JSON.parse(subscription.toString().slice(2)), ['subscribed', { restaurantId: 'fixture-restaurant', room: 'kitchen:fixture-restaurant' }]);
      assert.equal(native.rooms.has('kitchen:fixture-restaurant'), true);
    } finally { websocket.terminate(); io.engine.clients[sid]?.close(true); }
  });

  if (hosted) {
    test('current shared authority denial cannot reach native polling or upgrade', async () => {
      const before = io.engine.clientsCount;
      authorityAvailable = false;
      try {
        assert.equal((await raw('/socket.io/?EIO=4&transport=polling', { cookie: cookies['fixture-owner'] })).status, 404);
        const client = connectSocket(`http://127.0.0.1:${port}`, { autoConnect: false, forceNew: true,
          reconnection: false, transports: ['websocket'], timeout: 1500,
          extraHeaders: { Host: host, Origin: origin, Cookie: cookies['fixture-owner'] } });
        clients.add(client);
        await event(client, 'connect_error', () => client.connect());
        assert.equal(io.engine.clientsCount, before);
        client.disconnect();
      } finally { authorityAvailable = true; }
    });

    test('disposing the shared host closes the native connection and its rooms', async () => {
      const client = await open(cookies['fixture-owner']);
      await subscribe(client, 'kitchen');
      const native = io.sockets.sockets.get(client.id);
      const clientClosed = event(client, 'disconnect');
      const nativeClosed = event(native, 'disconnect');
      disposeBinding();
      await Promise.all([clientClosed, nativeClosed]);
      assert.equal(io.sockets.sockets.has(native.id), false);
      assert.equal(native.rooms.size, 0);
      assert.equal((await raw('/socket.io/?EIO=4&transport=polling', { cookie: cookies['fixture-owner'] })).status, 503);
    });
  }
});
