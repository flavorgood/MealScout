import assert from 'node:assert/strict';
import http from 'node:http';
import { registerHooks } from 'node:module';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import session from 'express-session';
import { io as connectSocket } from 'socket.io-client';

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
let server, io, port, cookies;
const clients = new Set();
const sockets = new Set();

function raw(path, { cookie, requestHost = host, requestOrigin = origin } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path, agent: false,
      headers: { Host: requestHost, Origin: requestOrigin, ...(cookie ? { Cookie: cookie } : {}) },
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

// Direct native listener only: this does not execute the TradeScout dispatcher,
// HTTP/private relay, PgSession, production identities or Render network.
describe('MealScout native socket lifecycle on actual local Socket.IO and session middleware', { concurrency: false }, () => {
  before(async () => {
    const app = express();
    const nativeSession = session({ name: 'tradescout.sid', secret: 'owned-loopback-fixture-not-provider-credential',
      resave: false, saveUninitialized: false, store: new session.MemoryStore(),
      cookie: { secure: false, httpOnly: true, sameSite: 'lax' },
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
  });

  after(async () => {
    for (const client of clients) client.disconnect();
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
});
