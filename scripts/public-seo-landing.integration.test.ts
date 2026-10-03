import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net from "node:net";
import type { AddressInfo } from "node:net";

import { neonConfig } from "@neondatabase/serverless";
import express from "express";
import pg from "pg";
import { WebSocket, WebSocketServer } from "ws";

const OPT_IN = "MEALSCOUT_PUBLIC_SEO_DB_TEST";
const EXPECTED_DATABASE = "mealscout_public_seo_test";
const FIXTURE_NOW = new Date("2026-08-22T17:00:00.000Z");

function requireDisposableLocalDatabase() {
  assert.equal(process.env[OPT_IN], "1", `${OPT_IN}=1 is required`);
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const parsed = new URL(databaseUrl);
  assert.equal(
    parsed.hostname,
    "127.0.0.1",
    "The public SEO DB proof only accepts a loopback PostgreSQL host.",
  );
  assert.ok(parsed.port, "The disposable PostgreSQL port must be explicit.");
  assert.equal(
    parsed.pathname,
    `/${EXPECTED_DATABASE}`,
    `The disposable database must be named ${EXPECTED_DATABASE}.`,
  );
  assert.equal(
    parsed.searchParams.get("sslmode"),
    "disable",
    "The loopback disposable database must explicitly disable SSL.",
  );
  return { databaseUrl, parsed };
}

async function createLoopbackPostgresWebSocketProxy(
  expectedHost: string,
  expectedPort: number,
) {
  const proxy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    proxy.once("listening", resolve);
    proxy.once("error", reject);
  });

  proxy.on("connection", (webSocket, request) => {
    const requestUrl = new URL(request.url || "/", "ws://127.0.0.1");
    const address = String(requestUrl.searchParams.get("address") || "");
    const separator = address.lastIndexOf(":");
    const targetHost = address.slice(0, separator);
    const targetPort = Number(address.slice(separator + 1));
    if (targetHost !== expectedHost || targetPort !== expectedPort) {
      webSocket.close(1008, "Unexpected PostgreSQL target");
      return;
    }

    const tcp = net.createConnection({ host: targetHost, port: targetPort });
    webSocket.on("message", (data) => tcp.write(Buffer.from(data as any)));
    webSocket.on("close", () => tcp.end());
    webSocket.on("error", () => tcp.destroy());
    tcp.on("data", (data) => {
      if (webSocket.readyState === WebSocket.OPEN) webSocket.send(data);
    });
    tcp.on("error", () => webSocket.close(1011, "PostgreSQL failed"));
    tcp.on("close", () => webSocket.close());
  });
  return proxy;
}

function closeWebSocketProxy(proxy: WebSocketServer) {
  for (const client of proxy.clients) client.terminate();
  return new Promise<void>((resolve, reject) => {
    proxy.close((error) => (error ? reject(error) : resolve()));
  });
}

async function listen(app: express.Express) {
  return new Promise<import("node:http").Server>((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}

async function closeServer(server: import("node:http").Server | null) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function run() {
  const { databaseUrl, parsed } = requireDisposableLocalDatabase();

  process.env.NODE_ENV = "test";
  process.env.PUBLIC_BASE_URL = "https://mealscout.us";
  process.env.EMAIL_NOTIFICATIONS_MODE = "off";
  process.env.VAC_AUTO_VERIFY_ENABLED = "false";
  process.env.MERLIN_OR_ENABLED = "false";
  for (const key of [
    "BREVO_API_KEY",
    "GOOGLE_MAPS_API_KEY",
    "GOOGLE_PLACES_API_KEY",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "STRIPE_SECRET_KEY",
  ]) {
    delete process.env[key];
  }

  const wsProxy = await createLoopbackPostgresWebSocketProxy(
    parsed.hostname,
    Number(parsed.port),
  );
  const wsAddress = wsProxy.address() as AddressInfo;
  neonConfig.webSocketConstructor = WebSocket;
  neonConfig.wsProxy = (host, port) =>
    `127.0.0.1:${wsAddress.port}/v2?address=${host}:${port}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.forceDisablePgSSL = true;
  neonConfig.pipelineConnect = false;
  neonConfig.pipelineTLS = false;

  const nativePool = new pg.Pool({ connectionString: databaseUrl });
  const originalFetch = globalThis.fetch;
  let applicationPool: { end: () => Promise<void> } | null = null;
  let server: import("node:http").Server | null = null;
  let failureServer: import("node:http").Server | null = null;

  const paymentSeriesId = randomUUID();
  const pastPaymentSeriesId = randomUUID();
  const ids = {
    owner: randomUUID(),
    importOwner: randomUUID(),
    incompleteOwner: randomUUID(),
    hostOwner: randomUUID(),
    hiddenOwner: randomUUID(),
    hiddenSupplierOwner: randomUUID(),
    visibleSupplierOwner: randomUUID(),
    maliciousTruck: randomUUID(),
    legacyAccessTruck: randomUUID(),
    restaurantOnly: randomUUID(),
    otherStateTruck: randomUUID(),
    substringTruck: randomUUID(),
    importTruck: randomUUID(),
    quarantinedTruck: randomUUID(),
    rejectedRestaurant: randomUUID(),
    hiddenRestaurant: randomUUID(),
    hiddenTruck: randomUUID(),
    hiddenBar: randomUUID(),
    todayTruck: randomUUID(),
    wrongStopTruck: randomUUID(),
    yorkCollisionTruck: randomUUID(),
    homeOnlyTruck: randomUUID(),
    futureTruck: randomUUID(),
    completedTruck: randomUUID(),
    closedTruck: randomUUID(),
    syntheticTruck: randomUUID(),
    incompleteTruck: randomUUID(),
    legacyAliasTruck: randomUUID(),
    statelessStateTruck: randomUUID(),
    visitingTruck: randomUUID(),
    crossCityEventTruck: randomUUID(),
    restaurantvilleRestaurant: randomUUID(),
    duplicateOldTruck: randomUUID(),
    duplicateWinnerTruck: randomUUID(),
    bar: randomUUID(),
    truckBarConflict: randomUUID(),
    caterer: randomUUID(),
    privateChef: randomUUID(),
    combinedService: randomUUID(),
    unknownBusiness: randomUUID(),
    inactiveRestaurant: randomUUID(),
    overflowEligibleTruck: randomUUID(),
    overflowRelatedRestaurant: randomUUID(),
    blankStateSource: randomUUID(),
    host: randomUUID(),
    syntheticHost: randomUUID(),
    tomorrowHost: randomUUID(),
    hiddenSupplier: randomUUID(),
    visibleSupplier: randomUUID(),
    publicEvent: randomUUID(),
    privateEvent: randomUUID(),
    syntheticEvent: randomUUID(),
    syntheticHostEvent: randomUUID(),
    paymentSeries: paymentSeriesId,
    paymentEvent: `pp:${paymentSeriesId}:2026-08-22`,
    pastPaymentSeries: pastPaymentSeriesId,
    pastPaymentEvent: `pp:${pastPaymentSeriesId}:2026-08-22`,
    ineligibleOnlyEvent: randomUUID(),
    legacyAliasEvent: randomUUID(),
    tomorrowEvent: randomUUID(),
    unconfirmedEvent: randomUUID(),
    farFutureEvent: randomUUID(),
    endedEvent: randomUUID(),
    activeDeal: randomUUID(),
    expiredDeal: randomUUID(),
    inactiveDeal: randomUUID(),
    wrongStateDeal: randomUUID(),
    ineligibleDeal: randomUUID(),
    syntheticDeal: randomUUID(),
    hiddenRestaurantDeal: randomUUID(),
  };
  const maliciousName =
    "Harbor </script><script>globalThis.mealscoutPwned=1</script> Wagon";

  const insertRestaurant = async (input: {
    id: string;
    ownerId?: string;
    name: string;
    address: string;
    city: string;
    state: string;
    cuisine: string;
    isTruck: boolean;
    businessType?: string;
    rawData?: Record<string, unknown>;
    phone?: string | null;
    websiteUrl?: string | null;
    instagramUrl?: string | null;
    facebookPageUrl?: string | null;
    xUrl?: string | null;
    latitude?: number | null;
    longitude?: number | null;
  }) => {
    await nativePool.query(
      `insert into restaurants
        (id, owner_id, name, address, business_type, cuisine_type,
         is_food_truck, is_active, city, state, description, raw_data,
          phone, website_url, instagram_url, facebook_page_url, x_url,
          latitude, longitude)
       values ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10,
                $11::jsonb, $12, $13, $14, $15, $16, $17, $18)`,
      [
        input.id,
        input.ownerId || ids.owner,
        input.name,
        input.address,
        input.businessType || (input.isTruck ? "food_truck" : "restaurant"),
        input.cuisine,
        input.isTruck,
        input.city,
        input.state,
        `${input.name} serves local food in ${input.city}.`,
        JSON.stringify(input.rawData || {}),
        input.phone === undefined ? "+1-850-555-0199" : input.phone,
        input.websiteUrl === undefined
          ? "https://merchant.example.invalid"
          : input.websiteUrl,
        input.instagramUrl ?? null,
        input.facebookPageUrl ?? null,
        input.xUrl ?? null,
        input.latitude ?? null,
        input.longitude ?? null,
      ],
    );
  };

  try {
    const target = await nativePool.query(
      `select current_database() as database_name,
              current_setting('server_version') as server_version`,
    );
    assert.equal(target.rows[0]?.database_name, EXPECTED_DATABASE);
    assert.match(String(target.rows[0]?.server_version), /^16\./);

    const initial = await nativePool.query(`
      select
        (select count(*)::int from users) as users,
        (select count(*)::int from cities) as cities,
        (select count(*)::int from restaurants) as restaurants,
        (select count(*)::int from hosts) as hosts,
        (select count(*)::int from events) as events,
        (select count(*)::int from deals) as deals
    `);
    assert.deepEqual(initial.rows[0], {
      users: 0,
      cities: 0,
      restaurants: 0,
      hosts: 0,
      events: 0,
      deals: 0,
    });

    await nativePool.query(
      `insert into users (id, user_type, email, email_verified, public_profile_settings)
       values
         ($1, 'food_truck', $2, true, '{"showAddress":true,"showContact":true}'::jsonb),
         ($3, 'customer', 'system-import@mealscout.us', true, '{}'::jsonb),
         ($4, 'customer', null, true, '{}'::jsonb),
         ($5, 'host', $6, true, '{"showAddress":false,"showContact":false}'::jsonb),
         ($7, 'restaurant_owner', $8, true, '{"showAddress":false,"showContact":false}'::jsonb),
         ($9, 'supplier', $10, true, '{"showAddress":false,"showContact":false}'::jsonb),
         ($11, 'supplier', $12, true, '{"showAddress":true,"showContact":true}'::jsonb)`,
      [
        ids.owner,
        `public-owner-${randomUUID()}@example.invalid`,
        ids.importOwner,
        ids.incompleteOwner,
        ids.hostOwner,
        `public-host-${randomUUID()}@example.invalid`,
        ids.hiddenOwner,
        `hidden-owner-${randomUUID()}@example.invalid`,
        ids.hiddenSupplierOwner,
        `hidden-supplier-${randomUUID()}@example.invalid`,
        ids.visibleSupplierOwner,
        `visible-supplier-${randomUUID()}@example.invalid`,
      ],
    );
    await nativePool.query(
      `insert into cities (id, name, slug, state, timezone)
       values
         ($1, 'Pensacola', 'pensacola', 'FL', 'America/Chicago'),
         ($2, 'Pensacola', 'pensacola-ok', 'OK', 'America/Chicago'),
         ($3, 'York', 'york', 'PA', 'America/New_York'),
         ($4, 'Emptyville', 'emptyville', 'FL', 'America/Chicago'),
         ($5, 'Capville', 'capville', 'FL', 'America/Chicago'),
         ($6, 'Stateless', 'stateless', null, 'America/Chicago'),
         ($7, 'Visitville', 'visitville', 'FL', 'America/Chicago'),
         ($8, 'Restaurantville', 'restaurantville', 'FL', 'America/Chicago'),
         ($9, 'Overflowville', 'overflowville', 'FL', 'America/Chicago'),
         ($10, 'Tomorrowville', 'tomorrowville', 'FL', 'America/Chicago')`,
      [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );
    await nativePool.query(
      `insert into cities (id, name, slug, state, timezone, created_at)
       values
         ($1, 'DupeTown', 'dupetown', 'FL', 'America/Chicago',
          '2026-08-01T00:00:00.000Z'),
         ($2, 'DupeTown', '  DuPeToWn  ', 'AL', 'America/Chicago',
          '2026-08-02T00:00:00.000Z'),
         ($3, '   ', ' DUPETOWN ', 'TX', 'America/Chicago',
          '2026-08-03T00:00:00.000Z')`,
      [randomUUID(), randomUUID(), randomUUID()],
    );

    await insertRestaurant({
      id: ids.maliciousTruck,
      name: maliciousName,
      address: "100 Harbor Way",
      city: "Pensacola",
      state: "FL",
      cuisine: "Pizza / Sammys & Desserts",
      isTruck: true,
    });
    await nativePool.query(
      `update restaurants
          set insurance_verified = true,
              insurance_expires_at = $2
        where id = $1`,
      [
        ids.maliciousTruck,
        new Date(FIXTURE_NOW.getTime() + 24 * 60 * 60 * 1000),
      ],
    );
    await insertRestaurant({
      id: ids.legacyAccessTruck,
      name: "Legacy Flagged Owner Truck",
      address: "101 Harbor Way",
      city: "Pensacola",
      state: "FL",
      cuisine: "Legacy",
      isTruck: true,
      businessType: "restaurant",
    });
    await nativePool.query(
      `update restaurants
          set is_active = false,
              insurance_verified = true,
              insurance_expires_at = $2
        where id = $1`,
      [
        ids.legacyAccessTruck,
        new Date(FIXTURE_NOW.getTime() - 24 * 60 * 60 * 1000),
      ],
    );
    await insertRestaurant({
      id: ids.restaurantOnly,
      name: "Harbor Table",
      address: "101 Harbor Way",
      city: "Pensacola",
      state: "FL",
      cuisine: "Restaurant Only Fare",
      isTruck: false,
    });
    await insertRestaurant({
      id: ids.otherStateTruck,
      name: "Sooner State Wagon",
      address: "200 State Street",
      city: "Pensacola",
      state: "OK",
      cuisine: "Sooner Only",
      isTruck: true,
    });
    await insertRestaurant({
      id: ids.substringTruck,
      name: "Beachside Bites",
      address: "300 Beach Road",
      city: "Pensacola Beach",
      state: "FL",
      cuisine: "Seafood",
      isTruck: true,
    });
    await insertRestaurant({
      id: ids.importTruck,
      ownerId: ids.importOwner,
      name: "Registry Custody Wagon",
      address: "400 Import Road",
      city: "Pensacola",
      state: "FL",
      cuisine: "Wings",
      isTruck: true,
    });
    await insertRestaurant({
      id: ids.quarantinedTruck,
      name: "Quarantined Wagon",
      address: "500 Review Road",
      city: "Pensacola",
      state: "FL",
      cuisine: "Burgers",
      isTruck: true,
      rawData: { evidenceQuarantine: { active: true } },
    });
    await insertRestaurant({
      id: ids.rejectedRestaurant,
      name: "Rejected Contact Kitchen",
      address: "511 Rejected Street",
      city: "Pensacola",
      state: "FL",
      cuisine: "Bowls",
      isTruck: false,
      phone: "+1-850-555-0511",
      rawData: {
        evidenceQuarantine: {
          decisions: {
            contact_address: { status: "rejected" },
            contact_phone: { status: "rejected" },
          },
        },
      },
    });
    await insertRestaurant({
      id: ids.hiddenRestaurant,
      ownerId: ids.hiddenOwner,
      name: "Hidden Address Kitchen",
      address: "711 Hidden Restaurant Street",
      city: "Pensacola",
      state: "FL",
      cuisine: "Sandwiches",
      isTruck: false,
      phone: "+1-850-555-0711",
      websiteUrl: "https://hidden-restaurant.example.invalid",
      instagramUrl: "https://instagram.com/hidden-restaurant-sentinel",
      facebookPageUrl: "https://facebook.com/hidden-restaurant-sentinel",
      xUrl: "https://x.com/hidden_restaurant_sentinel",
      latitude: 30.711111,
      longitude: -87.711111,
    });
    await insertRestaurant({
      id: ids.hiddenTruck,
      ownerId: ids.hiddenOwner,
      name: "Hidden Address Wagon",
      address: "722 Hidden Truck Street",
      city: "Pensacola",
      state: "FL",
      cuisine: "Tacos",
      isTruck: true,
      phone: "+1-850-555-0722",
      websiteUrl: "https://hidden-truck.example.invalid",
      instagramUrl: "https://instagram.com/hidden-truck-sentinel",
      facebookPageUrl: "https://facebook.com/hidden-truck-sentinel",
      xUrl: "https://x.com/hidden_truck_sentinel",
      latitude: 30.722222,
      longitude: -87.722222,
      rawData: {
        profileLocations: { addressKind: "operating_location" },
      },
    });
    await nativePool.query(
       `update restaurants
          set mobile_online = true,
              current_latitude = 30.799999,
              current_longitude = -87.799999,
              last_broadcast_at = now(),
              live_until_at = now() + interval '1 hour'
        where id = $1`,
      [ids.hiddenTruck],
    );
    await insertRestaurant({
      id: ids.hiddenBar,
      ownerId: ids.hiddenOwner,
      name: "Hidden Address Taproom",
      address: "733 Hidden Bar Street",
      city: "Pensacola",
      state: "FL",
      cuisine: "Pub Fare",
      isTruck: false,
      businessType: "bar",
      phone: "+1-850-555-0733",
      websiteUrl: "https://hidden-bar.example.invalid",
      instagramUrl: "https://instagram.com/hidden-bar-sentinel",
      facebookPageUrl: "https://facebook.com/hidden-bar-sentinel",
      xUrl: "https://x.com/hidden_bar_sentinel",
      latitude: 30.733333,
      longitude: -87.733333,
    });
    await insertRestaurant({
      id: ids.todayTruck,
      name: "Milton Lunch Wagon",
      address: "600 Home Road",
      city: "Milton",
      state: "FL",
      cuisine: "Burgers",
      isTruck: true,
    });
    await insertRestaurant({
      id: ids.wrongStopTruck,
      name: "Wrong State Stop Wagon",
      address: "700 Home Road",
      city: "Milton",
      state: "FL",
      cuisine: "BBQ",
      isTruck: true,
    });
    await insertRestaurant({
      id: ids.yorkCollisionTruck,
      name: "New York Road Wagon",
      address: "800 York Road, Washington",
      city: "New York",
      state: "NY",
      cuisine: "Bagels",
      isTruck: true,
    });
    await insertRestaurant({
      id: ids.homeOnlyTruck,
      name: "Top Hat Tacos",
      address: "810 Home City Road",
      city: "Pensacola",
      state: "FL",
      cuisine: "Noodles",
      isTruck: true,
    });
    await insertRestaurant({
      id: ids.futureTruck,
      name: "Future Service Wagon",
      address: "820 Home Road",
      city: "Milton",
      state: "FL",
      cuisine: "Falafel",
      isTruck: true,
    });
    await insertRestaurant({
      id: ids.completedTruck,
      name: "Completed Service Wagon",
      address: "830 Home Road",
      city: "Milton",
      state: "FL",
      cuisine: "Pasta",
      isTruck: true,
    });
    await insertRestaurant({
      id: ids.closedTruck,
      name: "Closed Service Wagon",
      address: "840 Home Road",
      city: "Milton",
      state: "FL",
      cuisine: "Salads",
      isTruck: true,
    });
    await insertRestaurant({
      id: ids.syntheticTruck,
      name: "Test Truck 88",
      address: "850 Synthetic Road",
      city: "Pensacola",
      state: "FL",
      cuisine: "Synthetic",
      isTruck: true,
    });
    await insertRestaurant({
      id: ids.incompleteTruck,
      ownerId: ids.incompleteOwner,
      name: "Incomplete Ownership Wagon",
      address: "860 Incomplete Road",
      city: "Pensacola",
      state: "FL",
      cuisine: "Soup",
      isTruck: true,
    });
    await insertRestaurant({
      id: ids.legacyAliasTruck,
      name: "Legacy Alias Wagon",
      address: "870 Legacy Road",
      city: "Pensacola",
      state: "FL",
      cuisine: "Crepes",
      isTruck: false,
      businessType: "  Mobile_Food_Vendor  ",
    });
    await insertRestaurant({
      id: ids.statelessStateTruck,
      name: "Stateful Stateless Wagon",
      address: "880 State Road",
      city: "Stateless",
      state: "FL",
      cuisine: "Wraps",
      isTruck: true,
    });
    await insertRestaurant({
      id: ids.visitingTruck,
      name: "Visitville Visiting Wagon",
      address: "890 Home Road",
      city: "Milton",
      state: "FL",
      cuisine: "Tacos",
      isTruck: true,
    });
    await insertRestaurant({
      id: ids.crossCityEventTruck,
      name: "Cross City Event Wagon",
      address: "895 Home Road",
      city: "Milton",
      state: "FL",
      cuisine: "Tacos",
      isTruck: true,
    });
    await insertRestaurant({
      id: ids.restaurantvilleRestaurant,
      name: "Restaurantville Table",
      address: "1 Restaurantville Plaza",
      city: "Restaurantville",
      state: "FL",
      cuisine: "Southern",
      isTruck: false,
    });
    await insertRestaurant({
      id: ids.duplicateOldTruck,
      name: "Old DupeTown Wagon",
      address: "1 Old Winner Road",
      city: "DupeTown",
      state: "FL",
      cuisine: "Old Fare",
      isTruck: true,
    });
    await insertRestaurant({
      id: ids.duplicateWinnerTruck,
      name: "Canonical DupeTown Wagon",
      address: "2 Canonical Winner Road",
      city: "DupeTown",
      state: "AL",
      cuisine: "Canonical Fare",
      isTruck: true,
    });
    await insertRestaurant({
      id: ids.bar,
      name: "Bay Brewery",
      address: "3 Canonical Lane",
      city: "Pensacola",
      state: "FL",
      cuisine: "Pub Fare",
      isTruck: false,
      businessType: "bar",
    });
    await insertRestaurant({
      id: ids.truckBarConflict,
      name: "Rolling Tap Wagon",
      address: "4 Canonical Lane",
      city: "Pensacola",
      state: "FL",
      cuisine: "Pub Fare",
      isTruck: true,
      businessType: "bar",
    });
    await insertRestaurant({
      id: ids.caterer,
      name: "Bay Catering Company",
      address: "5 Service Lane",
      city: "Pensacola",
      state: "FL",
      cuisine: "Catering",
      isTruck: false,
      businessType: "caterer",
    });
    await insertRestaurant({
      id: ids.privateChef,
      name: "Bay Private Chef",
      address: "6 Service Lane",
      city: "Pensacola",
      state: "FL",
      cuisine: "Private Dining",
      isTruck: false,
      businessType: "private_chef",
    });
    await insertRestaurant({
      id: ids.combinedService,
      name: "Bay Combined Service",
      address: "7 Service Lane",
      city: "Pensacola",
      state: "FL",
      cuisine: "Combined Service",
      isTruck: false,
      businessType: "caterer_private_chef",
    });
    await insertRestaurant({
      id: ids.unknownBusiness,
      name: "Bay Unknown Venue",
      address: "8 Service Lane",
      city: "Pensacola",
      state: "FL",
      cuisine: "Unknown Venue",
      isTruck: false,
      businessType: "host_venue",
    });
    await insertRestaurant({
      id: ids.inactiveRestaurant,
      name: "Inactive Harbor Kitchen",
      address: "9 Service Lane",
      city: "Pensacola",
      state: "FL",
      cuisine: "Inactive Fare",
      isTruck: false,
      businessType: "restaurant",
    });
    await nativePool.query(`update restaurants set is_active = false where id = $1`, [
      ids.inactiveRestaurant,
    ]);
    await insertRestaurant({
      id: ids.overflowEligibleTruck,
      name: "Overflowville Public Wagon",
      address: "1 Public Way",
      city: "Overflowville",
      state: "FL",
      cuisine: "Tacos",
      isTruck: true,
    });
    await insertRestaurant({
      id: ids.overflowRelatedRestaurant,
      name: "Overflowville Neighbor Kitchen",
      address: "2 Public Way",
      city: "Overflowville",
      state: "FL",
      cuisine: "Tacos",
      isTruck: false,
    });
    await insertRestaurant({
      id: ids.blankStateSource,
      name: "Blank State Source Wagon",
      address: "3 Missing State Way",
      city: "Pensacola",
      state: "",
      cuisine: "Tacos",
      isTruck: true,
    });

    await nativePool.query(
      `insert into restaurants
        (id, owner_id, name, address, business_type, cuisine_type,
         is_food_truck, is_active, city, state, description, raw_data,
         phone, website_url, updated_at)
       select 'overflow-ineligible-' || lpad(n::text, 3, '0'), $1,
              'Overflow Imported Wagon ' || n, n || ' Import Way',
              'food_truck', 'Tacos', true, true, 'Overflowville', 'FL',
              'Imported registry custody row', '{}'::jsonb,
              '+1-850-555-0199', 'https://merchant.example.invalid',
              $2::timestamp + (n || ' seconds')::interval
       from generate_series(1, 251) n`,
      [ids.importOwner, new Date(FIXTURE_NOW.getTime() + 60 * 60 * 1000)],
    );
    await nativePool.query(
      `update restaurants
          set updated_at = case when id = $2 then $1::timestamp else $3::timestamp end,
              logo_url = case when id = $4 then 'https://rejected-media.example.invalid/logo.png' else logo_url end,
              cover_image_url = case when id = $4 then 'https://rejected-media.example.invalid/cover.png' else cover_image_url end,
              website_url = case when id = $4 then 'javascript:unsafe-website' else website_url end,
              instagram_url = case when id = $4 then 'data:text/html,unsafe-instagram' else instagram_url end,
              facebook_page_url = case when id = $4 then '//attacker.example.invalid/facebook' else facebook_page_url end,
              x_url = case when id = $4 then 'https://user:password@attacker.example.invalid/x' else x_url end
        where id in ($2, $4)`,
      [
        new Date(FIXTURE_NOW.getTime() - 60 * 60 * 1000),
        ids.overflowEligibleTruck,
        new Date(FIXTURE_NOW.getTime() - 2 * 60 * 60 * 1000),
        ids.overflowRelatedRestaurant,
      ],
    );
    await nativePool.query(
      `update restaurants
          set logo_url = case
                when id = $1 then 'https://quarantined-media.example.invalid/logo.png'
                when id = $2 then 'https://accepted-media.example.invalid/logo.png'
                else logo_url
              end,
              cover_image_url = case
                when id = $1 then 'https://quarantined-media.example.invalid/cover.png'
                when id = $2 then 'https://accepted-media.example.invalid/cover.png'
                else cover_image_url
              end
        where id in ($1, $2)`,
      [ids.quarantinedTruck, ids.restaurantOnly],
    );
    await nativePool.query(
      `update restaurants
          set logo_url = 'javascript:unsafe-event-logo',
              cover_image_url = '//attacker.example.invalid/unsafe-event-cover'
        where id = $1`,
      [ids.maliciousTruck],
    );
    await nativePool.query(
      `update restaurants
          set website_url = 'merchant.example.invalid/profile'
        where id = $1`,
      [ids.restaurantOnly],
    );

    for (let index = 1; index <= 85; index += 1) {
      await insertRestaurant({
        id: `cap-${String(index).padStart(3, "0")}`,
        name: `Capville Kitchen ${String(index).padStart(3, "0")}`,
        address: `${index} Cap Street`,
        city: "Capville",
        state: "FL",
        cuisine: index === 85 ? "Tail Only Cuisine" : "Local",
        isTruck: true,
      });
    }
    await nativePool.query(
      `update restaurants set updated_at = $1 where city = 'Capville' and state = 'FL'`,
      [FIXTURE_NOW],
    );

    const expiresAt = new Date(FIXTURE_NOW.getTime() + 24 * 60 * 60 * 1000);
    for (const [truckId, state, location] of [
      [ids.todayTruck, "FL", "Pensacola Lunch Stop"],
      [ids.wrongStopTruck, "OK", "Wrong State Lunch Stop"],
    ] as const) {
      await nativePool.query(
        `insert into truck_manual_schedules
          (id, truck_id, date, start_time, end_time, location_name, address,
           city, state, is_public, status, timezone, source_type,
           source_confidence, owner_submitted_equivalent, expires_at,
           map_eligible, live_feed_eligible, last_confirmed_at)
         values ($1, $2, $3, '00:01', '23:59', $4, '900 Stop Street',
                 'Pensacola', $5, true, 'open', 'America/Chicago',
                 'owner_manual', 'confirmed', true, $6, true, true, $7)`,
        [randomUUID(), truckId, FIXTURE_NOW, location, state, expiresAt, FIXTURE_NOW],
      );
    }
    for (const schedule of [
      {
        truckId: ids.futureTruck,
        date: "2026-08-23 12:00:00",
        start: "10:00",
        end: "12:00",
        status: "open",
        city: "Pensacola",
      },
      {
        truckId: ids.completedTruck,
        date: FIXTURE_NOW,
        start: "00:01",
        end: "00:02",
        status: "open",
        city: "Pensacola",
      },
      {
        truckId: ids.closedTruck,
        date: FIXTURE_NOW,
        start: "00:01",
        end: "23:59",
        status: "closed",
        city: "Pensacola",
      },
      {
        truckId: ids.visitingTruck,
        date: FIXTURE_NOW,
        start: "00:01",
        end: "23:59",
        status: "open",
        city: "Visitville",
      },
    ]) {
      await nativePool.query(
        `insert into truck_manual_schedules
          (id, truck_id, date, start_time, end_time, location_name, address,
           city, state, is_public, status, timezone, source_type,
           source_confidence, owner_submitted_equivalent, expires_at,
           map_eligible, live_feed_eligible, last_confirmed_at)
         values ($1, $2, $3, $4, $5, 'Schedule Edge Stop', '910 Stop Street',
                 $9, 'FL', true, $6, 'America/Chicago',
                 'owner_manual', 'confirmed', true, $7, true, true, $8)`,
        [
          randomUUID(),
          schedule.truckId,
          schedule.date,
          schedule.start,
          schedule.end,
          schedule.status,
          expiresAt,
          FIXTURE_NOW,
          schedule.city,
        ],
      );
    }
    await nativePool.query(
      `insert into truck_manual_schedules
        (id, truck_id, date, start_time, end_time, location_name, address,
         city, state, is_public, status, timezone, source_type,
         source_confidence, owner_submitted_equivalent, expires_at,
         map_eligible, live_feed_eligible, last_confirmed_at, updated_at)
       values ($1, $2, $3, '00:01', '23:59', 'Overflow Public Stop',
               '10 Public Stop Way', 'Overflowville', 'FL', true, 'open',
               'America/Chicago', 'owner_manual', 'confirmed', true, $4,
               true, true, $3, $5)`,
      [
        randomUUID(),
        ids.overflowEligibleTruck,
        FIXTURE_NOW,
        expiresAt,
        new Date(FIXTURE_NOW.getTime() - 60 * 60 * 1000),
      ],
    );
    await nativePool.query(
      `insert into truck_manual_schedules
        (id, truck_id, date, start_time, end_time, location_name, address,
         city, state, is_public, status, timezone, source_type,
         source_confidence, owner_submitted_equivalent, expires_at,
         map_eligible, live_feed_eligible, last_confirmed_at, updated_at)
       select 'overflow-stop-' || lpad(n::text, 3, '0'), $1, $2,
              '00:01', '23:59', 'Imported Overflow Stop ' || n,
              n || ' Imported Stop Way', 'Overflowville', 'FL', true, 'open',
              'America/Chicago', 'owner_manual', 'confirmed', true, $3,
              true, true, $2, $4::timestamp + (n || ' seconds')::interval
       from generate_series(1, 251) n`,
      [
        ids.importTruck,
        FIXTURE_NOW,
        expiresAt,
        new Date(FIXTURE_NOW.getTime() + 60 * 60 * 1000),
      ],
    );

    await nativePool.query(
      `insert into hosts
        (id, user_id, business_name, address, city, state, location_type,
         contact_phone, latitude, longitude, notes)
       values
        ($1, $2, 'Harbor Brewery', '100 Taproom Lane', 'Pensacola', 'FL', 'brewery',
         '+1-850-555-0100', 30.610001, -87.610001, 'INTERNAL HOST NOTE SENTINEL'),
        ($3, $2, 'asdfasdf', '200 Hidden Lane', 'Pensacola', 'FL', 'other',
         '+1-850-555-0200', 30.620001, -87.620001, null),
        ($4, $5, 'Tomorrow Market', '300 Future Lane', 'Tomorrowville', 'FL', 'market',
         '+1-850-555-0300', 30.630001, -87.630001, null)`,
      [ids.host, ids.hostOwner, ids.syntheticHost, ids.tomorrowHost, ids.owner],
    );
    await nativePool.query(
      `insert into suppliers
        (id, user_id, business_name, address, city, state, latitude, longitude,
         contact_phone, is_active, online_payments_notes)
       values
        ($1, $2, 'Hidden Supply Co', '811 Hidden Supplier Street', 'Pensacola', 'FL',
         30.811111, -87.811111, '+1-850-555-0811', true, 'Hidden supplier fixture'),
        ($3, $4, 'Visible Supply Co', '822 Visible Supplier Street', 'Pensacola', 'FL',
         30.822222, -87.822222, '+1-850-555-0822', true, 'Visible supplier fixture')`,
      [
        ids.hiddenSupplier,
        ids.hiddenSupplierOwner,
        ids.visibleSupplier,
        ids.visibleSupplierOwner,
      ],
    );

    const eventRows = [
      [ids.publicEvent, ids.host, "Best Harbor Lunch", "event"],
      [ids.privateEvent, ids.host, "Private Team Lunch", "private_event"],
      [ids.syntheticEvent, ids.host, "asdfasdf", "event"],
      [ids.syntheticHostEvent, ids.syntheticHost, "Public Lunch", "event"],
    ] as const;
    for (const [eventId, hostId, name, eventType] of eventRows) {
      await nativePool.query(
        `insert into events
          (id, host_id, name, event_type, date, start_time, end_time,
           max_trucks, status, requires_payment, last_confirmed_at)
         values ($1, $2, $3, $4, $5, '00:01', '23:59', 5, 'open', false, $6)`,
        [eventId, hostId, name, eventType, FIXTURE_NOW, FIXTURE_NOW],
      );
      await nativePool.query(
        `insert into event_bookings
          (id, event_id, truck_id, host_id, host_price_cents,
           platform_fee_cents, total_cents, status, booking_confirmed_at)
         values ($1, $2, $3, $4, 0, 0, 0, 'confirmed', $5)`,
        [randomUUID(), eventId, ids.maliciousTruck, hostId, FIXTURE_NOW],
      );
    }
    await nativePool.query(`update events set host_price_cents = 4321 where id = $1`, [
      ids.publicEvent,
    ]);
    const tomorrowFixture = new Date(
      FIXTURE_NOW.getTime() + 24 * 60 * 60 * 1000,
    );
    await nativePool.query(
      `insert into events
        (id, host_id, name, event_type, date, start_time, end_time,
         max_trucks, status, requires_payment, last_confirmed_at)
       values ($1, $2, 'Tomorrow Market Lunch', 'event', $3,
               '00:01', '23:59', 5, 'open', false, $4)`,
      [ids.tomorrowEvent, ids.tomorrowHost, tomorrowFixture, FIXTURE_NOW],
    );
    await nativePool.query(
      `insert into event_bookings
        (id, event_id, truck_id, host_id, host_price_cents,
         platform_fee_cents, total_cents, status, booking_confirmed_at)
       values ($1, $2, $3, $4, 0, 0, 0, 'confirmed', $5)`,
      [
        randomUUID(),
        ids.tomorrowEvent,
        ids.maliciousTruck,
        ids.tomorrowHost,
        FIXTURE_NOW,
      ],
    );
    await nativePool.query(
      `insert into event_bookings
        (id, event_id, truck_id, host_id, host_price_cents,
         platform_fee_cents, total_cents, status, booking_confirmed_at)
       values ($1, $2, $3, $4, 0, 0, 0, 'confirmed', $5)`,
      [
        randomUUID(),
        ids.publicEvent,
        ids.quarantinedTruck,
        ids.host,
        new Date(FIXTURE_NOW.getTime() - 2 * 60 * 1000),
      ],
    );
    for (const profileId of [
      ids.hiddenRestaurant,
      ids.hiddenBar,
      ids.crossCityEventTruck,
    ]) {
      await nativePool.query(
        `insert into event_bookings
          (id, event_id, truck_id, host_id, host_price_cents,
           platform_fee_cents, total_cents, status, booking_confirmed_at)
         values ($1, $2, $3, $4, 0, 0, 0, 'confirmed', $5)`,
        [randomUUID(), ids.publicEvent, profileId, ids.host, FIXTURE_NOW],
      );
    }
    await nativePool.query(
      `insert into event_series
        (id, host_id, name, description, timezone, start_date, end_date,
         default_start_time, default_end_time, default_max_trucks,
         default_hard_cap_enabled, series_type, parking_pass_days_of_week,
         default_daily_price_cents, default_host_price_cents, status,
         published_at, updated_at)
       values
        ($1, $2, 'Paid Team Lunch', 'Series-only paid occurrence',
         'America/Chicago', $3, $3, '13:00', '14:00', 5, true,
         'parking_pass', '[]'::jsonb, 2500, 2500, 'published', $3, $3),
        ($4, $2, 'Past Team Lunch', 'Past series-only paid occurrence',
         'America/Chicago', $3, $3, '11:00', '12:00', 5, true,
         'parking_pass', '[]'::jsonb, 2500, 2500, 'published', $3, $3)`,
      [ids.paymentSeries, ids.host, FIXTURE_NOW, ids.pastPaymentSeries],
    );
    await nativePool.query(
      `insert into events
        (id, host_id, name, event_type, date, start_time, end_time,
         max_trucks, status, requires_payment, last_confirmed_at)
       values
        ($1, $3, 'Ineligible Truck Only Lunch', 'event', $4, '00:01', '23:59', 5, 'open', false, $4),
        ($2, $3, 'Legacy Alias Lunch', 'event', $4, '00:01', '23:59', 5, 'open', false, $4)`,
      [ids.ineligibleOnlyEvent, ids.legacyAliasEvent, ids.host, FIXTURE_NOW],
    );
    for (const [eventId, truckId] of [
      [ids.ineligibleOnlyEvent, ids.syntheticTruck],
      [ids.legacyAliasEvent, ids.legacyAliasTruck],
    ] as const) {
      await nativePool.query(
        `insert into event_bookings
          (id, event_id, truck_id, host_id, host_price_cents,
           platform_fee_cents, total_cents, status, booking_confirmed_at)
         values ($1, $2, $3, $4, 0, 0, 0, 'confirmed', $5)`,
        [randomUUID(), eventId, truckId, ids.host, FIXTURE_NOW],
      );
    }
    await nativePool.query(
      `insert into event_bookings
        (id, event_id, truck_id, host_id, host_price_cents,
         platform_fee_cents, total_cents, status, booking_confirmed_at)
       values ($1, $2, $3, $4, 0, 0, 0, 'confirmed', $5)`,
      [
        randomUUID(),
        ids.publicEvent,
        ids.syntheticTruck,
        ids.host,
        new Date(FIXTURE_NOW.getTime() - 60 * 1000),
      ],
    );

    for (const [eventId, hostId] of [
      [ids.publicEvent, ids.host],
      [ids.privateEvent, ids.host],
      [ids.syntheticEvent, ids.host],
      [ids.syntheticHostEvent, ids.syntheticHost],
    ] as const) {
      await nativePool.query(
        `insert into event_bookings
          (id, event_id, truck_id, host_id, host_price_cents,
           platform_fee_cents, total_cents, status, booking_confirmed_at)
         values ($1, $2, $3, $4, 0, 0, 0, 'confirmed', $5)`,
        [randomUUID(), eventId, ids.restaurantOnly, hostId, FIXTURE_NOW],
      );
    }

    const farFutureFixture = new Date(
      FIXTURE_NOW.getTime() + 8 * 24 * 60 * 60 * 1000,
    );
    await nativePool.query(
      `insert into events
        (id, host_id, name, event_type, date, start_time, end_time,
         max_trucks, status, requires_payment, last_confirmed_at)
       values
        ($1, $4, 'Unconfirmed Public Lunch', 'event', $5, '00:01', '23:59', 5, 'open', false, $5),
        ($2, $4, 'Far Future Public Lunch', 'event', $6, '00:01', '23:59', 5, 'open', false, $5),
        ($3, $4, 'Ended Public Lunch', 'event', $5, '00:01', '00:02', 5, 'open', false, $5)`,
      [
        ids.unconfirmedEvent,
        ids.farFutureEvent,
        ids.endedEvent,
        ids.host,
        FIXTURE_NOW,
        farFutureFixture,
      ],
    );
    for (const eventId of [ids.farFutureEvent, ids.endedEvent]) {
      await nativePool.query(
        `insert into event_bookings
          (id, event_id, truck_id, host_id, host_price_cents,
           platform_fee_cents, total_cents, status, booking_confirmed_at)
         values ($1, $2, $3, $4, 0, 0, 0, 'confirmed', $5)`,
        [randomUUID(), eventId, ids.maliciousTruck, ids.host, FIXTURE_NOW],
      );
    }
    for (const profileId of [
      ids.hiddenRestaurant,
      ids.hiddenBar,
    ]) {
      await nativePool.query(
        `insert into event_bookings
          (id, event_id, truck_id, host_id, host_price_cents,
           platform_fee_cents, total_cents, status, booking_confirmed_at)
         values ($1, $2, $3, $4, 0, 0, 0, 'confirmed', $5)`,
        [randomUUID(), ids.farFutureEvent, profileId, ids.host, FIXTURE_NOW],
      );
    }

    await nativePool.query(
      `insert into events
        (id, host_id, name, event_type, date, start_time, end_time,
         max_trucks, status, requires_payment, last_confirmed_at, updated_at)
       select 'overflow-event-' || lpad(n::text, 3, '0'), $1,
              'asdfasdf', 'event', $2, '00:01', '23:59', 5, 'open', false,
              $2, $3::timestamp + (n || ' seconds')::interval
       from generate_series(1, 251) n`,
      [
        ids.host,
        FIXTURE_NOW,
        new Date(FIXTURE_NOW.getTime() + 60 * 60 * 1000),
      ],
    );
    await nativePool.query(
      `insert into event_bookings
        (id, event_id, truck_id, host_id, host_price_cents,
         platform_fee_cents, total_cents, status, booking_confirmed_at, updated_at)
       select 'overflow-booking-' || lpad(n::text, 3, '0'),
              'overflow-event-' || lpad(n::text, 3, '0'), $1, $2,
              0, 0, 0, 'confirmed', $3,
              $4::timestamp + (n || ' seconds')::interval
       from generate_series(1, 251) n`,
      [
        ids.maliciousTruck,
        ids.host,
        FIXTURE_NOW,
        new Date(FIXTURE_NOW.getTime() + 60 * 60 * 1000),
      ],
    );
    await nativePool.query(
      `update events set updated_at = $1 where id in ($2, $3)`,
      [
        new Date(FIXTURE_NOW.getTime() - 60 * 60 * 1000),
        ids.publicEvent,
        ids.legacyAliasEvent,
      ],
    );

    const dealRows = [
      [
        ids.activeDeal,
        ids.restaurantOnly,
        "Best Harbor Lunch Special",
        "2026-08-01T00:00:00.000Z",
        "2026-09-30T23:59:59.000Z",
        true,
      ],
      [
        ids.expiredDeal,
        ids.restaurantOnly,
        "Expired Harbor Special",
        "2026-07-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
        true,
      ],
      [
        ids.inactiveDeal,
        ids.restaurantOnly,
        "Inactive Harbor Special",
        "2026-08-01T00:00:00.000Z",
        "2026-09-30T23:59:59.000Z",
        false,
      ],
      [
        ids.wrongStateDeal,
        ids.otherStateTruck,
        "Sooner State Special",
        "2026-08-01T00:00:00.000Z",
        "2026-09-30T23:59:59.000Z",
        true,
      ],
      [
        ids.ineligibleDeal,
        ids.syntheticTruck,
        "Synthetic Test Special",
        "2026-08-01T00:00:00.000Z",
        "2026-09-30T23:59:59.000Z",
        true,
      ],
      [
        ids.syntheticDeal,
        ids.restaurantvilleRestaurant,
        "asdfasdf",
        "2026-08-01T00:00:00.000Z",
        "2026-09-30T23:59:59.000Z",
        true,
      ],
    ] as const;
    for (const [dealId, restaurantId, title, startDate, endDate, isActive] of
      dealRows) {
      await nativePool.query(
        `insert into deals
          (id, restaurant_id, title, description, deal_type, discount_value,
           image_url, start_date, end_date, is_active)
         values ($1, $2, $3, $4, 'percentage', 10, $5, $6, $7, $8)`,
        [
          dealId,
          restaurantId,
          title,
          `${title} fixture description`,
          "https://merchant.example.invalid/deal.jpg",
          startDate,
          endDate,
          isActive,
        ],
      );
    }
    await nativePool.query(
      `insert into deals
        (id, restaurant_id, title, description, deal_type, discount_value,
         image_url, start_date, end_date, is_active, updated_at)
       values
        ('caterer-deal', $1, 'Caterer Landing Leak', 'excluded service deal',
         'percentage', 10, 'https://merchant.example.invalid/deal.jpg', $3, $4, true, $5),
        ('private-chef-deal', $2, 'Private Chef Landing Leak', 'excluded service deal',
         'percentage', 10, 'https://merchant.example.invalid/deal.jpg', $3, $4, true, $5)`,
      [
        ids.caterer,
        ids.privateChef,
        "2026-08-01T00:00:00.000Z",
        "2026-09-30T23:59:59.000Z",
        new Date(FIXTURE_NOW.getTime() + 60 * 60 * 1000),
      ],
    );
    await nativePool.query(
      `insert into deals
        (id, restaurant_id, title, description, deal_type, discount_value,
         image_url, start_date, end_date, is_active, updated_at)
       select 'overflow-deal-' || lpad(n::text, 3, '0'), $1,
              'Synthetic Overflow Deal ' || n, 'excluded synthetic deal',
              'percentage', 10, 'https://merchant.example.invalid/deal.jpg', $2, $3, true,
              $4::timestamp + (n || ' seconds')::interval
       from generate_series(1, 65) n`,
      [
        ids.syntheticTruck,
        "2026-08-01T00:00:00.000Z",
        "2026-09-30T23:59:59.000Z",
        new Date(FIXTURE_NOW.getTime() + 60 * 60 * 1000),
      ],
    );
    await nativePool.query(
      `update deals set updated_at = $1 where id = $2`,
      [new Date(FIXTURE_NOW.getTime() - 60 * 60 * 1000), ids.activeDeal],
    );

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const raw = input instanceof Request ? input.url : String(input);
      const url = new URL(raw);
      assert.ok(
        url.hostname === "127.0.0.1" || url.hostname === "localhost",
        `Unexpected non-loopback fetch blocked: ${url.hostname}`,
      );
      return originalFetch(input, init);
    };

    const { pool } = await import("../server/db");
    applicationPool = pool;
    const { loadPublicSeoLandingData } = await import(
      "../server/services/publicSeoLandingData"
    );
    const { registerPublicSeoLandingRoutes } = await import(
      "../server/routes/publicSeoLandingRoutes"
    );
    const { registerPublicProfilePrerenderRoutes } = await import(
      "../server/seo/publicProfilePrerender"
    );
    const { registerSeoRoutes } = await import("../server/routes/seoRoutes");
    const { registerEventRoutes } = await import("../server/routes/eventRoutes");
    const { registerPublicDiscoveryRoutes } = await import(
      "../server/routes/publicDiscoveryRoutes"
    );
    const { getBusinessAccessContext } = await import(
      "../server/services/businessTeamAccess"
    );
    const {
      toPublicLocationProfile,
      toPublicRestaurantProfile,
      toPublicSupplierProfile,
    } = await import("../server/publicProfiles");
    const { buildPublicCta, normalizePublicUrl } = await import(
      "../server/publicProfiles/publicProfileUtils"
    );
    const ownerBusinessAccess = await getBusinessAccessContext(ids.owner);
    const legacyAccessTruck = ownerBusinessAccess.restaurants.find(
      (restaurant) => restaurant.id === ids.legacyAccessTruck,
    );
    assert.equal(legacyAccessTruck?.businessType, "restaurant");
    assert.equal(
      legacyAccessTruck?.isFoodTruck,
      true,
      "account-scoped business access must preserve legacy is_food_truck classification",
    );
    assert.equal(
      buildPublicCta({
        label: "Call",
        href: "tel:+1-850-555-0300",
        type: "phone",
      })?.href,
      "tel:+1-850-555-0300",
    );
    for (const unsafeHref of [
      "javascript:alert(1)",
      "data:text/html,unsafe",
      "mailto:private@example.invalid",
      "//attacker.example.invalid/path",
      "https://user:password@attacker.example.invalid/path",
    ]) {
      assert.equal(
        buildPublicCta({
          label: "Unsafe",
          href: unsafeHref,
          type: "external",
        }),
        null,
      );
      assert.equal(normalizePublicUrl(unsafeHref), null);
    }
    assert.equal(
      normalizePublicUrl("merchant.example.invalid/menu"),
      "https://merchant.example.invalid/menu",
      "a valid bare public domain must normalize to HTTPS",
    );
    assert.equal(
      normalizePublicUrl("/menu/restaurant-id", { allowInternalPath: true }),
      "/menu/restaurant-id",
    );
    assert.equal(normalizePublicUrl("/menu/restaurant-id"), null);
    const unsafeProfileProjection = toPublicRestaurantProfile({
      row: {
        id: "unsafe-public-url-profile",
        name: "Unsafe URL Fixture Kitchen",
        businessType: "restaurant",
        websiteUrl: "javascript:alert(website)",
        instagramUrl: "data:text/html,instagram",
        facebookPageUrl: "//attacker.example.invalid/facebook",
        xUrl: "https://user:password@attacker.example.invalid/x",
        menuUrl: "javascript:alert(menu)",
        menuImageUrl: "data:image/svg+xml,unsafe",
        menuPdfUrl: "//attacker.example.invalid/menu.pdf",
        ordering: { path: "javascript:alert(order)" },
        onlineOrderingUrl: "data:text/html,order",
        dealsItems: [
          {
            id: "unsafe-deal",
            title: "Unsafe deal",
            actionHref: "javascript:alert(deal)",
            actionType: "website",
          },
        ],
        eventsItems: [
          {
            id: "unsafe-event",
            title: "Unsafe event",
            actionHref: "//attacker.example.invalid/event",
            actionType: "website",
          },
        ],
      },
      baseUrl: "https://www.mealscout.us",
    });
    const unsafeProjectionText = JSON.stringify(unsafeProfileProjection);
    for (const sentinel of [
      "javascript:",
      "data:",
      "//attacker.example.invalid",
      "user:password@",
    ]) {
      assert.equal(
        unsafeProjectionText.includes(sentinel),
        false,
        `public profile projection leaked unsafe URL sentinel ${sentinel}`,
      );
    }
    assert.deepEqual(unsafeProfileProjection.deals.items, []);
    assert.deepEqual(unsafeProfileProjection.events.items, []);
    for (const projection of [
      toPublicLocationProfile({
        row: {
          id: "hidden-contact-location",
          businessName: "Hidden Contact Location",
          websiteUrl: "https://hidden-location.example.invalid",
          instagramUrl: "https://instagram.com/hidden-location-sentinel",
          facebookPageUrl: "https://facebook.com/hidden-location-sentinel",
          xUrl: "https://x.com/hidden_location_sentinel",
        },
        baseUrl: "https://www.mealscout.us",
        showContact: false,
      }),
      toPublicSupplierProfile({
        row: {
          id: "hidden-contact-supplier",
          businessName: "Hidden Contact Supplier",
          websiteUrl: "https://hidden-supplier.example.invalid",
        },
        activeProductCount: 0,
        baseUrl: "https://www.mealscout.us",
        showContact: false,
      }),
    ]) {
      const serialized = JSON.stringify(projection);
      assert.equal(serialized.includes("hidden-location.example.invalid"), false);
      assert.equal(serialized.includes("hidden-location-sentinel"), false);
      assert.equal(serialized.includes("hidden_location_sentinel"), false);
      assert.equal(serialized.includes("hidden-supplier.example.invalid"), false);
    }
    const fixedLoader = (request: any) =>
      loadPublicSeoLandingData(request, FIXTURE_NOW);

    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      if (req.get("X-Test-Unrelated-Customer") === "1") {
        req.user = { id: ids.incompleteOwner, userType: "customer" };
        req.isAuthenticated = () => true;
      }
      if (req.get("X-Test-Unverified-Food-Truck-Owner") === "1") {
        req.user = {
          id: ids.owner,
          userType: "food_truck",
          emailVerified: false,
        };
        req.isAuthenticated = () => true;
      }
      if (req.get("X-Test-Food-Truck-Owner") === "1") {
        req.user = {
          id: ids.owner,
          userType: "food_truck",
          emailVerified: true,
        };
        req.isAuthenticated = () => true;
      }
      next();
    });
    registerPublicSeoLandingRoutes(app, fixedLoader);
    registerPublicProfilePrerenderRoutes(
      app,
      "https://www.mealscout.us",
      fixedLoader,
    );
    registerSeoRoutes(app);
    registerEventRoutes(app, {
      hasCompleteProfileAccess: async () => true,
      publicEventNow: () => FIXTURE_NOW,
    });
    registerPublicDiscoveryRoutes(app);
    app.get("/events/public", (_req, res) => res.status(204).end());
    app.get("/restaurant/dashboard", (_req, res) => res.status(204).end());
    app.get("/restaurant/:restaurantId/reviews", (_req, res) =>
      res.status(204).end(),
    );
    app.get("/supplier/dashboard", (_req, res) => res.status(204).end());
    app.get("/event/:slug", (_req, res) =>
      res
        .status(200)
        .type("html")
        .send('<!DOCTYPE html><html><body data-test="spa-shell"></body></html>'),
    );
    server = await listen(app);
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const get = async (path: string) => {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { "user-agent": "Googlebot/2.1" },
      });
      const text = await response.text();
      return { response, text };
    };
    const getJson = async (path: string) => {
      const result = await get(path);
      return { ...result, body: JSON.parse(result.text) };
    };
    const getManual = async (path: string) => {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { "user-agent": "Googlebot/2.1" },
        redirect: "manual",
      });
      const text = await response.text();
      return { response, text };
    };
    const parseJsonLd = (html: string) =>
      Array.from(
        html.matchAll(
          /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
        ),
        (match) => JSON.parse(match[1]),
      );

    for (const path of ["/api/events/public", "/api/events/upcoming"]) {
      const feed = await getJson(path);
      assert.equal(feed.response.status, 200);
      assert.ok(Array.isArray(feed.body));
      const feedIds = feed.body.map((row: any) => row.id);
      assert.equal(
        feedIds.includes(ids.publicEvent),
        true,
        `${path} must preserve valid free public events`,
      );
      for (const rejectedEventId of [
        ids.privateEvent,
        ids.paymentEvent,
        ids.syntheticEvent,
        ids.syntheticHostEvent,
        ids.ineligibleOnlyEvent,
        ids.unconfirmedEvent,
        ids.farFutureEvent,
        ids.endedEvent,
      ]) {
        assert.equal(
          feedIds.includes(rejectedEventId),
          false,
          `${path} must exclude private, paid, synthetic-event, and synthetic-host rows`,
        );
      }
      assert.equal(feed.text.includes("Private Team Lunch"), false);
      assert.equal(feed.text.includes("Paid Team Lunch"), false);
      assert.equal(feed.text.includes("200 Hidden Lane"), false);
      assert.equal(feed.text.includes("100 Taproom Lane"), false);
      assert.equal(feed.text.includes("30.610001"), false);
      assert.equal(feed.text.includes("-87.610001"), false);
      for (const mediaSentinel of [
        "quarantined-media.example.invalid",
        "javascript:unsafe-event-logo",
        "attacker.example.invalid/unsafe-event-cover",
      ]) {
        assert.equal(
          feed.text.includes(mediaSentinel),
          false,
          `${path} must project confirmed-truck media through the public evidence boundary`,
        );
      }
      for (const row of feed.body) {
        for (const priceKey of [
          "hostPriceCents",
          "breakfastPriceCents",
          "lunchPriceCents",
          "dinnerPriceCents",
          "dailyPriceCents",
          "weeklyPriceCents",
          "monthlyPriceCents",
        ]) {
          assert.equal(
            Object.prototype.hasOwnProperty.call(row, priceKey),
            false,
            `${path} must strip internal ${priceKey}`,
          );
        }
        assert.equal(
          (await get(`/api/public/events/${row.id}`)).response.status,
          200,
          `${path} card ${row.id} must have anonymous JSON detail`,
        );
        const eventSlug = String(row.name || "event")
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)+/g, "");
        assert.equal(
          (await get(`/event/${eventSlug}--${row.id}`)).response.status,
          200,
          `${path} card ${row.id} must have anonymous SSR detail`,
        );
      }
    }

    const hostProfile = await getJson(
      `/api/public/profiles/location/${ids.host}`,
    );
    const syntheticHostProfile = await getJson(
      `/api/public/profiles/location/${ids.syntheticHost}`,
    );
    const restaurantProfile = await getJson(
      `/api/public/profiles/restaurant/${ids.restaurantOnly}`,
    );
    const truckEventProfile = await getJson(
      `/api/public/profiles/truck/${ids.maliciousTruck}`,
    );
    const hiddenBarEventProfile = await getJson(
      `/api/public/profiles/bar/${ids.hiddenBar}`,
    );
    for (const [label, profile] of [
      ["host", hostProfile],
      ["non-truck restaurant", restaurantProfile],
      ["truck", truckEventProfile],
      ["bar", hiddenBarEventProfile],
    ] as const) {
      assert.equal(profile.response.status, 200);
      const eventIds = profile.body.events.items.map((row: any) => row.id);
      assert.equal(
        eventIds.includes(ids.publicEvent),
        true,
        `${label} profile must retain a valid public event`,
      );
      for (const rejectedEventId of [
        ids.privateEvent,
        ids.paymentEvent,
        ids.syntheticEvent,
        ids.syntheticHostEvent,
        ids.unconfirmedEvent,
        ids.farFutureEvent,
        ids.endedEvent,
      ]) {
        assert.equal(
          eventIds.includes(rejectedEventId),
          false,
          `${label} profile event arrays must apply anonymous list eligibility`,
        );
      }
      assert.equal(profile.text.includes("Private Team Lunch"), false);
      assert.equal(profile.text.includes("Paid Team Lunch"), false);
      assert.equal(profile.text.includes("200 Hidden Lane"), false);
      assert.equal(profile.text.includes("100 Taproom Lane"), false);
      assert.equal(profile.text.includes("30.610001"), false);
      assert.equal(profile.text.includes("-87.610001"), false);
    }
    assert.equal(syntheticHostProfile.response.status, 200);
    assert.deepEqual(
      syntheticHostProfile.body.events.items,
      [],
      "a synthetic host cannot publish an otherwise valid event through its public profile",
    );

    const city = await getJson("/api/public/seo/city/pensacola/food");
    assert.equal(city.response.status, 200);
    assert.deepEqual(
      city.body.items.map((row: any) => row.id).sort(),
      [
        ids.bar,
        ids.hiddenBar,
        ids.hiddenRestaurant,
        ids.hiddenTruck,
        ids.homeOnlyTruck,
        ids.legacyAliasTruck,
        ids.maliciousTruck,
        ids.restaurantOnly,
        ids.rejectedRestaurant,
        ids.truckBarConflict,
      ].sort(),
      "city membership must exclude other-state, substring, import-custody, quarantined, synthetic, and incomplete-ownership rows",
    );
    assert.equal(city.body.total, city.body.items.length);
    assert.equal(city.text.includes("ownerEmail"), false);
    const topHatCard = city.body.items.find(
      (row: any) => row.id === ids.homeOnlyTruck,
    );
    assert.equal(
      city.body.items.find((row: any) => row.id === ids.restaurantOnly)
        ?.imageUrl,
      "https://accepted-media.example.invalid/cover.png",
      "landing cards must retain media accepted by the shared projection",
    );
    assert.equal(topHatCard?.displayName, "Top Hat Tacos");
    assert.equal(
      topHatCard?.profilePath,
      `/truck/top-hat-tacos--${ids.homeOnlyTruck}`,
    );
    const topHatHtml = await get(topHatCard.profilePath);
    assert.equal(topHatHtml.response.status, 200);
    assert.match(
      topHatHtml.text,
      /<h1>Top Hat Tacos in Pensacola, FL<\/h1>/,
    );
    assert.equal(
      JSON.stringify(parseJsonLd(topHatHtml.text)).includes('"name":"Top Hat Tacos"'),
      true,
      "stored merchant identity must survive into profile JSON-LD",
    );
    assert.equal(city.text.includes("@example.invalid"), false);
    const cityHtml = await get("/city/pensacola/food");
    assert.equal(cityHtml.response.status, 200);
    for (const mediaSentinel of [
      "quarantined-media.example.invalid",
      "javascript:unsafe-event-logo",
      "attacker.example.invalid/unsafe-event-cover",
    ]) {
      assert.equal(city.text.includes(mediaSentinel), false);
      assert.equal(cityHtml.text.includes(mediaSentinel), false);
      assert.equal(
        JSON.stringify(parseJsonLd(cityHtml.text)).includes(mediaSentinel),
        false,
        "landing JSON-LD must consume accepted public merchant media only",
      );
    }
    assert.equal(
      (cityHtml.text.match(/<li>/g) || []).length,
      city.body.total,
      "seeded city API and SSR must expose the same item count",
    );
    for (const row of city.body.items) {
      assert.ok(
        cityHtml.text.includes(`href="${row.profilePath}"`),
        `SSR city listing must include API item ${row.id}`,
      );
    }
    const legacyCityPayload = await getJson("/api/cities/pensacola");
    assert.equal(
      legacyCityPayload.response.status,
      200,
      "the allowlisted city API must remain usable instead of tripping the public response guard",
    );
    assert.deepEqual(Object.keys(legacyCityPayload.body).sort(), [
      "city",
      "cuisines",
      "events",
      "restaurants",
      "stats",
      "stories",
      "trucks",
      "updatedAt",
    ]);
    assert.deepEqual(Object.keys(legacyCityPayload.body.city).sort(), [
      "name",
      "slug",
      "state",
    ]);
    for (const row of [
      ...legacyCityPayload.body.restaurants,
      ...legacyCityPayload.body.trucks,
    ]) {
      assert.deepEqual(Object.keys(row).sort(), [
        "cuisineType",
        "id",
        "name",
        "profilePath",
        "profileType",
      ]);
    }
    for (const row of legacyCityPayload.body.events) {
      assert.deepEqual(Object.keys(row).sort(), [
        "date",
        "endTime",
        "id",
        "name",
        "startTime",
      ]);
    }
    assert.deepEqual(
      legacyCityPayload.body.trucks.map((row: any) => row.id).sort(),
      city.body.items
        .filter((row: any) => row.profileType === "truck")
        .map((row: any) => row.id)
        .sort(),
    );
    assert.deepEqual(
      legacyCityPayload.body.restaurants.map((row: any) => row.id).sort(),
      city.body.items
        .filter((row: any) => row.profileType !== "truck")
        .map((row: any) => row.id)
        .sort(),
    );
    assert.equal(
      legacyCityPayload.body.trucks.find(
        (row: any) => row.id === ids.truckBarConflict,
      )?.profilePath,
      `/truck/rolling-tap-wagon--${ids.truckBarConflict}`,
    );
    for (const excludedId of [
      ids.otherStateTruck,
      ids.substringTruck,
      ids.importTruck,
      ids.quarantinedTruck,
      ids.syntheticTruck,
      ids.incompleteTruck,
      ids.caterer,
      ids.privateChef,
      ids.combinedService,
      ids.unknownBusiness,
      ids.inactiveRestaurant,
    ]) {
      assert.equal(
        legacyCityPayload.text.includes(excludedId),
        false,
        `the allowlisted city payload must exclude ${excludedId}`,
      );
    }
    const legacyCityEventIds = legacyCityPayload.body.events.map(
      (row: any) => row.id,
    );
    assert.equal(legacyCityEventIds.includes(ids.publicEvent), true);
    for (const excludedEventId of [
      ids.privateEvent,
      ids.paymentEvent,
      ids.syntheticEvent,
      ids.syntheticHostEvent,
      ids.ineligibleOnlyEvent,
      ids.unconfirmedEvent,
      ids.farFutureEvent,
      ids.endedEvent,
    ]) {
      assert.equal(legacyCityEventIds.includes(excludedEventId), false);
    }
    for (const sentinel of [
      "INTERNAL HOST NOTE SENTINEL",
      "system-import@mealscout.us",
      "ownerId",
      "userId",
      "rawData",
      "stripe",
      "100 Taproom Lane",
      "200 Hidden Lane",
      "Private Team Lunch",
      "Paid Team Lunch",
    ]) {
      assert.equal(
        legacyCityPayload.text.toLowerCase().includes(sentinel.toLowerCase()),
        false,
        `the city payload must not expose ${sentinel}`,
      );
    }
    const cityNavigation = await getJson("/api/cities");
    const pensacolaNavigation = cityNavigation.body.find(
      (row: any) => row.slug === "pensacola",
    );
    const pensacolaOkNavigation = cityNavigation.body.find(
      (row: any) => row.slug === "pensacola-ok",
    );
    const capvilleNavigation = cityNavigation.body.find(
      (row: any) => row.slug === "capville",
    );
    assert.ok(pensacolaNavigation);
    assert.ok(pensacolaOkNavigation);
    assert.ok(capvilleNavigation);
    for (const row of cityNavigation.body) {
      assert.deepEqual(Object.keys(row).sort(), [
        "cuisines",
        "foodCuisines",
        "hasFoodTrucks",
        "id",
        "name",
        "slug",
        "state",
      ]);
      for (const cuisine of row.cuisines) {
        assert.deepEqual(Object.keys(cuisine).sort(), ["count", "slug"]);
      }
      for (const cuisine of row.foodCuisines) {
        assert.deepEqual(Object.keys(cuisine).sort(), ["count", "slug"]);
      }
    }
    const pensacolaCuisineSlugs = pensacolaNavigation.cuisines.map(
      (row: any) => row.slug,
    );
    for (const excludedCuisine of [
      "restaurant-only-fare",
      "synthetic",
      "soup",
      "combined-service",
      "unknown-venue",
      "inactive-fare",
      "sooner-only",
    ]) {
      assert.equal(pensacolaCuisineSlugs.includes(excludedCuisine), false);
    }
    assert.equal(
      pensacolaOkNavigation.cuisines.some(
        (row: any) => row.slug === "sooner-only",
      ),
      true,
      "same-name cities in another state must retain only their own eligible truck cuisines",
    );
    const restaurantvilleNavigation = cityNavigation.body.find(
      (row: any) => row.slug === "restaurantville",
    );
    assert.ok(
      restaurantvilleNavigation,
      "restaurant-only eligible cities must remain in the shared city-food navigation set",
    );
    assert.equal(restaurantvilleNavigation.hasFoodTrucks, false);
    assert.deepEqual(restaurantvilleNavigation.cuisines, []);
    assert.equal(
      restaurantvilleNavigation.foodCuisines.some(
        (row: any) => row.slug === "southern",
      ),
      true,
      "restaurant-only cuisine membership must remain available to the global cuisine navigation",
    );
    assert.equal(pensacolaNavigation.hasFoodTrucks, true);
    assert.equal(
      pensacolaNavigation.foodCuisines.some(
        (row: any) => row.slug === "restaurant-only-fare",
      ),
      true,
    );
    assert.equal(
      capvilleNavigation.cuisines.some(
        (row: any) => row.slug === "tail-only-cuisine" && row.count === 1,
      ),
      true,
      "truck cuisine navigation must scan beyond the 60-card display cap",
    );
    assert.equal(
      capvilleNavigation.foodCuisines.some(
        (row: any) => row.slug === "tail-only-cuisine" && row.count === 1,
      ),
      true,
      "human cuisine navigation must scan beyond the 80-card city display cap",
    );
    const restaurantvilleDetail = await getJson(
      "/api/cities/restaurantville",
    );
    assert.equal(restaurantvilleDetail.response.status, 200);
    assert.deepEqual(restaurantvilleDetail.body.trucks, []);
    assert.equal(restaurantvilleDetail.body.stats.trucks, 0);
    assert.deepEqual(
      restaurantvilleDetail.body.restaurants.map((row: any) => row.id),
      [ids.restaurantvilleRestaurant],
      "restaurant-only city detail must remain reachable without a food-truck claim",
    );

    const sameNameOtherState = await getJson(
      "/api/public/seo/city/pensacola-ok/food",
    );
    assert.deepEqual(
      sameNameOtherState.body.items.map((row: any) => row.id),
      [ids.otherStateTruck],
    );
    const york = await getJson("/api/public/seo/city/york/food");
    assert.equal(york.response.status, 200);
    assert.equal(york.body.total, 0);
    const stateless = await getJson("/api/public/seo/city/stateless/food");
    assert.equal(stateless.response.status, 200);
    assert.equal(
      stateless.body.total,
      0,
      "a canonical city without state must not absorb a stateful candidate",
    );
    const restaurantville = await getJson(
      "/api/public/seo/city/restaurantville/food",
    );
    assert.deepEqual(
      restaurantville.body.items.map((row: any) => row.id),
      [ids.restaurantvilleRestaurant],
    );
    const visitville = await getJson("/api/public/seo/city/visitville/food");
    assert.equal(visitville.body.total, 0);
    const duplicateSlugCity = await getJson(
      "/api/public/seo/city/dupetown/food",
    );
    assert.deepEqual(
      duplicateSlugCity.body.items.map((row: any) => row.id),
      [ids.duplicateWinnerTruck],
      "normalized duplicate city slugs must select the newest non-null timestamp winner",
    );
    assert.equal(
      duplicateSlugCity.body.page.canonicalPath,
      "/city/dupetown/food",
    );
    const duplicateSlugHtml = await get("/city/dupetown/food");
    assert.equal(duplicateSlugHtml.text.includes(ids.duplicateWinnerTruck), true);
    assert.equal(duplicateSlugHtml.text.includes(ids.duplicateOldTruck), false);

    const pensacolaTrucks = await getJson(
      "/api/public/seo/food-trucks/pensacola",
    );
    assert.equal(
      pensacolaTrucks.body.items.some(
        (row: any) => row.id === ids.legacyAliasTruck,
      ),
      true,
      "trimmed/lowercased legacy aliases must use truck classification truth",
    );
    assert.equal(
      pensacolaTrucks.body.items.some(
        (row: any) => row.id === ids.truckBarConflict && row.profileType === "truck",
      ),
      true,
      "truck truth must win a conflicting legacy bar business type",
    );
    for (const serviceId of [ids.caterer, ids.privateChef]) {
      assert.equal(
        city.body.items.some((row: any) => row.id === serviceId),
        false,
        "service profiles are excluded from restaurant landing identity in this release",
      );
    }

    const overflowCity = await getJson(
      "/api/public/seo/city/overflowville/food",
    );
    const overflowTrucks = await getJson(
      "/api/public/seo/food-trucks/overflowville",
    );
    assert.deepEqual(
      overflowCity.body.items.map((row: any) => row.id),
      [ids.overflowEligibleTruck, ids.overflowRelatedRestaurant],
      "eligible city rows must survive more than 250 newer ineligible candidates",
    );
    assert.deepEqual(
      overflowTrucks.body.items.map((row: any) => row.id),
      [ids.overflowEligibleTruck],
      "eligible truck rows must survive raw prefilter batches",
    );

    const capFirst = await getJson("/api/public/seo/food-trucks/capville");
    const capSecond = await getJson("/api/public/seo/food-trucks/capville");
    const expectedCapIds = Array.from(
      { length: 60 },
      (_, index) => `cap-${String(index + 1).padStart(3, "0")}`,
    );
    assert.equal(capFirst.body.total, 60);
    assert.equal(capFirst.body.items.length, 60);
    assert.deepEqual(
      capFirst.body.items.map((row: any) => row.id),
      expectedCapIds,
      "the 60-truck cap must retain the stable ID tie-breaker",
    );
    assert.deepEqual(
      capSecond.body.items.map((row: any) => row.id),
      expectedCapIds,
      "the bounded Capville order must be repeatable",
    );

    const cuisine = await getJson(
      "/api/public/seo/cuisine/Pizza%20%2F%20Sammys%20%26%20Desserts/pensacola",
    );
    assert.equal(cuisine.response.status, 200);
    assert.deepEqual(
      cuisine.body.items.map((row: any) => row.id),
      [ids.maliciousTruck],
    );
    assert.equal(
      cuisine.body.page.canonicalPath,
      "/cuisine/pizza-sammys-desserts/pensacola",
    );
    const truckCuisine = await getJson(
      "/api/public/seo/food-trucks/pensacola/Pizza%20%2F%20Sammys%20%26%20Desserts",
    );
    assert.equal(truckCuisine.response.status, 200);
    assert.deepEqual(
      truckCuisine.body.items.map((row: any) => row.id),
      [ids.maliciousTruck],
    );
    assert.equal(
      truckCuisine.body.page.canonicalPath,
      "/food-trucks/pensacola/pizza-sammys-desserts",
    );
    const truckCuisineHtml = await get(
      "/food-trucks/pensacola/pizza-sammys-desserts",
    );
    assert.equal(truckCuisineHtml.response.status, 200);
    assert.equal(
      (truckCuisineHtml.text.match(/<li>/g) || []).length,
      truckCuisine.body.total,
      "seeded truck-cuisine API and SSR must expose the same item count",
    );
    for (const row of truckCuisine.body.items) {
      assert.ok(
        truckCuisineHtml.text.includes(`href="${row.profilePath}"`),
        `SSR truck-cuisine listing must include API item ${row.id}`,
      );
    }
    assert.equal(
      (await get("/api/public/seo/cuisine/not-a-real-cuisine/pensacola"))
        .response.status,
      404,
    );
    assert.equal(
      (await get("/api/public/seo/food-trucks/pensacola/restaurant-only-fare"))
        .response.status,
      404,
    );

    const today = await getJson(
      "/api/public/seo/food-trucks-today/pensacola",
    );
    assert.deepEqual(
      today.body.items.map((row: any) => row.id).sort(),
      [
        ids.legacyAliasTruck,
        ids.maliciousTruck,
        ids.todayTruck,
        ids.crossCityEventTruck,
      ].sort(),
      "today must use public operating-plan evidence in the requested city/state",
    );
    for (const excludedId of [
      ids.homeOnlyTruck,
      ids.wrongStopTruck,
      ids.futureTruck,
      ids.completedTruck,
      ids.closedTruck,
    ]) {
      assert.equal(
        today.body.items.some((row: any) => row.id === excludedId),
        false,
        `today must exclude non-current evidence for ${excludedId}`,
      );
    }
    const visitvilleToday = await getJson(
      "/api/public/seo/food-trucks-today/visitville",
    );
    assert.deepEqual(
      visitvilleToday.body.items.map((row: any) => row.id),
      [ids.visitingTruck],
      "today is stop-city scoped and must include a visiting eligible truck",
    );
    assert.equal(visitvilleToday.body.items[0]?.city, "Visitville");
    assert.equal(visitvilleToday.body.items[0]?.state, "FL");
    const visitvilleTodayHtml = await get("/food-trucks-today/visitville");
    assert.match(
      visitvilleTodayHtml.text,
      /Visitville Visiting Wagon[\s\S]*Visitville, FL/,
    );
    const visitvilleTodayJsonLd = parseJsonLd(visitvilleTodayHtml.text);
    const visitingTodayListItem = visitvilleTodayJsonLd
      .flatMap((value: any) => value?.mainEntity?.itemListElement || [])
      .find((value: any) => String(value?.url || "").includes(ids.visitingTruck));
    assert.equal(visitingTodayListItem?.item?.address?.addressLocality, "Visitville");
    assert.equal(visitingTodayListItem?.item?.address?.addressRegion, "FL");
    const visitingTruckProfileHtml = await get(`/truck/${ids.visitingTruck}`);
    assert.match(
      visitingTruckProfileHtml.text,
      /Milton, FL/,
      "the stop-side landing area must not rewrite the truck profile's home identity",
    );
    const overflowToday = await getJson(
      "/api/public/seo/food-trucks-today/overflowville",
    );
    assert.deepEqual(
      overflowToday.body.items.map((row: any) => row.id),
      [ids.overflowEligibleTruck],
    );

    const dealsToday = await getJson(
      "/api/public/seo/deals-today/pensacola",
    );
    assert.equal(dealsToday.response.status, 200);
    assert.deepEqual(
      dealsToday.body.items.map((row: any) => row.id),
      [ids.restaurantOnly],
      "deals-today must retain only an active deal on an eligible exact-city profile",
    );
    assert.equal(
      dealsToday.body.items[0]?.summary,
      "Deal today: Best Harbor Lunch Special",
    );
    for (const excludedTitle of [
      "Expired Harbor Special",
      "Inactive Harbor Special",
      "Sooner State Special",
      "Synthetic Test Special",
      "asdfasdf",
    ]) {
      assert.equal(
        dealsToday.text.includes(excludedTitle),
        false,
        `Pensacola deals-today must exclude ${excludedTitle}`,
      );
    }
    const syntheticOnlyDeals = await getJson(
      "/api/public/seo/deals-today/restaurantville",
    );
    assert.equal(syntheticOnlyDeals.response.status, 200);
    assert.equal(
      syntheticOnlyDeals.body.total,
      0,
      "an eligible parent with only a synthetic deal title must not publish a deal card",
    );

    const eventsToday = await getJson(
      "/api/public/seo/events-today/pensacola",
    );
    assert.deepEqual(
      eventsToday.body.items.map((row: any) => row.id).sort(),
      [ids.legacyAliasTruck, ids.maliciousTruck, ids.crossCityEventTruck].sort(),
      "an older eligible event must survive more than 250 newer synthetic candidates",
    );
    assert.match(eventsToday.text, /Best Harbor Lunch/);
    assert.equal(
      eventsToday.body.items.some(
        (row: any) => row.summary === "Event today: Best Harbor Lunch",
      ),
      true,
      "stored event titles beginning with Best must remain factual",
    );
    assert.match(eventsToday.text, /Legacy Alias Lunch/);
    assert.equal(eventsToday.text.includes("Private Team Lunch"), false);
    assert.equal(eventsToday.text.includes("asdfasdf"), false);
    const visitingEventCard = eventsToday.body.items.find(
      (row: any) => row.id === ids.crossCityEventTruck,
    );
    assert.equal(visitingEventCard?.city, "Pensacola");
    assert.equal(visitingEventCard?.state, "FL");
    const eventsTodayHtml = await get("/events-today/pensacola");
    assert.match(
      eventsTodayHtml.text,
      /Cross City Event Wagon[\s\S]*Pensacola, FL/,
    );
    const visitingEventListItem = parseJsonLd(eventsTodayHtml.text)
      .flatMap((value: any) => value?.mainEntity?.itemListElement || [])
      .find((value: any) =>
        String(value?.url || "").includes(ids.crossCityEventTruck),
      );
    assert.equal(visitingEventListItem?.item?.address?.addressLocality, "Pensacola");
    assert.equal(visitingEventListItem?.item?.address?.addressRegion, "FL");

    const locations = await getJson(
      "/api/public/seo/locations-with-trucks/pensacola",
    );
    assert.equal(locations.body.total, 1);
    assert.equal(locations.body.items[0]?.id, ids.host);
    assert.equal(locations.body.items[0]?.summary, "3 confirmed truck stops");
    const tomorrowEventsToday = await getJson(
      "/api/public/seo/events-today/tomorrowville",
    );
    const tomorrowLocations = await getJson(
      "/api/public/seo/locations-with-trucks/tomorrowville",
    );
    assert.equal(
      tomorrowEventsToday.body.total,
      0,
      "a tomorrow-only city must not appear on the events-today landing",
    );
    assert.deepEqual(
      tomorrowLocations.body.items.map((row: any) => row.id),
      [ids.tomorrowHost],
      "the same tomorrow event must qualify the seven-day locations landing",
    );

    const emptyApi = await getJson("/api/public/seo/city/emptyville/food");
    assert.equal(emptyApi.response.status, 200);
    assert.equal(emptyApi.body.total, 0);
    assert.equal(
      (await get("/api/public/seo/city/missing-city/food")).response.status,
      404,
    );
    const emptyHtml = await get("/city/emptyville/food");
    assert.equal(emptyHtml.response.status, 200);
    assert.match(emptyHtml.text, /name="robots" content="noindex,follow"/);

    const maliciousHtml = await get(
      "/food-trucks/pensacola/pizza-sammys-desserts",
    );
    assert.equal(maliciousHtml.response.status, 200);
    assert.equal(
      maliciousHtml.text.includes("</script><script>globalThis.mealscoutPwned"),
      false,
    );
    assert.match(maliciousHtml.text, /\\u003c\/script\\u003e/);
    assert.match(
      maliciousHtml.text,
      /rel="canonical" href="https:\/\/www\.mealscout\.us\/food-trucks\/pensacola\/pizza-sammys-desserts"/,
    );
    for (const path of [
      "/food-trucks/pensacola",
      "/food-trucks/pensacola/pizza-sammys-desserts",
      "/food-trucks-today/pensacola",
    ]) {
      const truckLandingHtml = await get(path);
      assert.equal(truckLandingHtml.response.status, 200);
      assert.match(
        truckLandingHtml.text,
        /<a href="\/for-food-trucks">List or claim your food truck<\/a>/,
        `${path} must connect a terminal SSR arrival to the signup and claim funnel`,
      );
    }

    const canonicalProfileCases = [
      {
        id: ids.restaurantOnly,
        path: city.body.items.find((row: any) => row.id === ids.restaurantOnly)
          ?.profilePath,
      },
      {
        id: ids.maliciousTruck,
        path: city.body.items.find((row: any) => row.id === ids.maliciousTruck)
          ?.profilePath,
      },
      {
        id: ids.bar,
        path: city.body.items.find((row: any) => row.id === ids.bar)?.profilePath,
      },
      {
        id: ids.truckBarConflict,
        path: city.body.items.find((row: any) => row.id === ids.truckBarConflict)
          ?.profilePath,
      },
    ];
    for (const profile of canonicalProfileCases) {
      assert.ok(profile.path, `landing profile path missing for ${profile.id}`);
      const html = await get(profile.path);
      const canonicalUrl = `https://www.mealscout.us${profile.path}`;
      assert.equal(html.response.status, 200);
      assert.ok(html.text.includes(`rel="canonical" href="${canonicalUrl}"`));
      assert.ok(
        html.text.includes(`"url":"${canonicalUrl}"`),
        `JSON-LD must use the same canonical identity for ${profile.id}`,
      );
      const profileJsonLd = JSON.stringify(parseJsonLd(html.text));
      assert.equal(
        profileJsonLd.includes('"@type":"WebPage"'),
        true,
        `profile page graph missing for ${profile.id}`,
      );
      assert.equal(
        profileJsonLd.includes('"@type":"BreadcrumbList"'),
        true,
        `profile breadcrumb graph missing for ${profile.id}`,
      );
      assert.equal(
        profileJsonLd.includes(`${canonicalUrl}#business`),
        true,
        `business entity id missing for ${profile.id}`,
      );
      assert.equal(
        profileJsonLd.includes(`${canonicalUrl}#webpage`),
        true,
        `profile page entity id missing for ${profile.id}`,
      );
      assert.match(html.text, /Public profile updated: \d{4}-\d{2}-\d{2}/);
      if (String(profile.path).startsWith("/truck/")) {
        assert.match(html.text, /href="\/food-trucks\/pensacola"/);
        assert.match(html.text, /href="\/food-truck-catering\/pensacola"/);
        assert.match(html.text, /href="\/book-food-truck\/pensacola"/);
      } else {
        assert.match(html.text, /href="\/city\/pensacola\/food"/);
      }
    }

    const typedRestaurantProfileCases = [
      {
        id: ids.restaurantOnly,
        canonicalEntity: "restaurant",
        canonicalPath: `/restaurant/harbor-table--${ids.restaurantOnly}`,
      },
      {
        id: ids.bar,
        canonicalEntity: "bar",
        canonicalPath: `/bar/bay-brewery--${ids.bar}`,
      },
      {
        id: ids.truckBarConflict,
        canonicalEntity: "truck",
        canonicalPath: `/truck/rolling-tap-wagon--${ids.truckBarConflict}`,
      },
    ] as const;
    for (const profile of typedRestaurantProfileCases) {
      for (const requestedEntity of ["restaurant", "bar", "truck"] as const) {
        const resolved = await getJson(
          `/api/public/resolve/${requestedEntity}/${profile.id}`,
        );
        const typedProfile = await getJson(
          `/api/public/profiles/${requestedEntity}/${profile.id}`,
        );
        const canonicalMachineProfile = await getJson(
          `/api/public/canonical/${requestedEntity}/${profile.id}`,
        );
        const typedSsrPath =
          requestedEntity === "restaurant"
            ? `/restaurant/${profile.id}`
            : `/${requestedEntity}/${profile.id}`;
        const typedSsr = await get(typedSsrPath);
        if (requestedEntity === profile.canonicalEntity) {
          assert.equal(resolved.response.status, 200);
          assert.equal(resolved.body.entityType, profile.canonicalEntity);
          assert.equal(
            resolved.body.canonicalUrl,
            `https://www.mealscout.us${profile.canonicalPath}`,
          );
          assert.equal(typedProfile.response.status, 200);
          assert.equal(typedProfile.body.entity, profile.canonicalEntity);
          assert.equal(
            typedProfile.body.canonicalUrl,
            `https://www.mealscout.us${profile.canonicalPath}`,
          );
          assert.equal(canonicalMachineProfile.response.status, 200);
          assert.equal(
            canonicalMachineProfile.body.entityType,
            profile.canonicalEntity,
          );
          assert.equal(
            canonicalMachineProfile.body.canonicalUrl,
            `https://www.mealscout.us${profile.canonicalPath}`,
          );
          assert.equal(typedSsr.response.status, 200);
          assert.ok(
            typedSsr.text.includes(
              `rel="canonical" href="https://www.mealscout.us${profile.canonicalPath}"`,
            ),
          );
        } else {
          assert.equal(
            resolved.response.status,
            404,
            `${requestedEntity} resolver alias must not override ${profile.canonicalEntity} identity`,
          );
          assert.equal(
            typedProfile.response.status,
            404,
            `${requestedEntity} profile alias must not override ${profile.canonicalEntity} identity`,
          );
          assert.equal(
            canonicalMachineProfile.response.status,
            404,
            `${requestedEntity} canonical API alias must not override ${profile.canonicalEntity} identity`,
          );
          assert.equal(
            typedSsr.response.status,
            404,
            `${requestedEntity} SSR alias must not override ${profile.canonicalEntity} identity`,
          );
          assert.match(typedSsr.text, /name="robots" content="noindex,follow"/);
        }
      }
    }
    for (const unsupportedId of [
      ids.caterer,
      ids.privateChef,
      ids.combinedService,
      ids.unknownBusiness,
    ]) {
      for (const requestedEntity of ["restaurant", "bar", "truck"] as const) {
        assert.equal(
          (
            await get(
              `/api/public/resolve/${requestedEntity}/${unsupportedId}`,
            )
          ).response.status,
          404,
        );
        assert.equal(
          (
            await get(
              `/api/public/profiles/${requestedEntity}/${unsupportedId}`,
            )
          ).response.status,
          404,
        );
      }
      assert.equal(city.text.includes(unsupportedId), false);
    }
    const catererProfile = await get(`/caterer/${ids.caterer}`);
    assert.equal(catererProfile.response.status, 200);
    assert.match(
      catererProfile.text,
      new RegExp(`rel="canonical" href="https://www\\.mealscout\\.us/caterer/bay-catering-company--${ids.caterer}"`),
    );
    const privateChefProfile = await get(`/private-chef/${ids.privateChef}`);
    assert.equal(privateChefProfile.response.status, 200);
    assert.match(
      privateChefProfile.text,
      new RegExp(`rel="canonical" href="https://www\\.mealscout\\.us/private-chef/bay-private-chef--${ids.privateChef}"`),
    );
    const legacyChef = await getManual(`/chef/${ids.privateChef}`);
    assert.equal(legacyChef.response.status, 308);
    assert.equal(
      legacyChef.response.headers.get("location"),
      `/private-chef/bay-private-chef--${ids.privateChef}`,
    );
    for (const mismatchedChefId of [
      ids.restaurantOnly,
      ids.bar,
      ids.maliciousTruck,
      ids.caterer,
      ids.combinedService,
      ids.unknownBusiness,
    ]) {
      const mismatch = await getManual(`/chef/${mismatchedChefId}`);
      assert.equal(mismatch.response.status, 404);
      assert.match(mismatch.text, /name="robots" content="noindex,follow"/);
    }
    const overflowRelated = await getJson(
      `/api/public/profiles/truck/${ids.overflowEligibleTruck}/related`,
    );
    assert.equal(overflowRelated.response.status, 200);
    assert.equal(
      overflowRelated.body.businesses.some(
        (row: any) => row.id === ids.overflowRelatedRestaurant,
      ),
      true,
      "an older eligible related business must survive more than 32 newer ineligible rows",
    );
    assert.equal(
      overflowRelated.text.includes("rejected-media.example.invalid"),
      false,
      "related rails must not expose unprojected merchant media",
    );
    const unsafeUrlProfile = await getJson(
      `/api/public/profiles/restaurant/${ids.overflowRelatedRestaurant}`,
    );
    const unsafeUrlProfileHtml = await get(
      `/restaurant/${ids.overflowRelatedRestaurant}`,
    );
    for (const sentinel of [
      "javascript:unsafe",
      "data:text/html",
      "//attacker.example.invalid",
      "user:password@attacker.example.invalid",
    ]) {
      assert.equal(unsafeUrlProfile.text.includes(sentinel), false);
      assert.equal(
        unsafeUrlProfileHtml.text.includes(sentinel),
        false,
        `SSR/rendered anchors must not receive unsafe URL sentinel ${sentinel}`,
      );
    }
    const pensacolaRelated = await getJson(
      `/api/public/profiles/restaurant/${ids.restaurantOnly}/related`,
    );
    for (const excludedRelatedId of [
      ids.caterer,
      ids.privateChef,
      ids.combinedService,
      ids.unknownBusiness,
      ids.syntheticTruck,
      ids.incompleteTruck,
      ids.importTruck,
    ]) {
      assert.equal(pensacolaRelated.text.includes(excludedRelatedId), false);
    }
    const blankStateRelated = await getJson(
      `/api/public/profiles/truck/${ids.blankStateSource}/related`,
    );
    assert.equal(blankStateRelated.response.status, 200);
    assert.deepEqual(
      blankStateRelated.body.businesses,
      [],
      "a source without state must fail closed instead of mixing cross-state candidates",
    );

    await nativePool.query(
      `insert into deals
        (id, restaurant_id, title, description, deal_type, discount_value,
         image_url, start_date, end_date, is_active)
       values ($1, $2, 'Hidden Contact Deal', 'privacy projection fixture',
               'percentage', 10, 'https://merchant.example.invalid/deal.jpg',
               $3, $4, true)`,
      [
        ids.hiddenRestaurantDeal,
        ids.hiddenRestaurant,
        "2026-08-01T00:00:00.000Z",
        "2026-09-30T23:59:59.000Z",
      ],
    );

    const hiddenProfileCases = [
      {
        label: "restaurant",
        apiPath: `/api/public/profiles/restaurant/${ids.hiddenRestaurant}`,
        htmlPath: `/restaurant/${ids.hiddenRestaurant}`,
        sentinels: [
          "711 Hidden Restaurant Street",
          "+1-850-555-0711",
          "hidden-restaurant.example.invalid",
          "hidden-restaurant-sentinel",
          "hidden_restaurant_sentinel",
          "30.711111",
          "-87.711111",
        ],
      },
      {
        label: "bar",
        apiPath: `/api/public/profiles/bar/${ids.hiddenBar}`,
        htmlPath: `/bar/${ids.hiddenBar}`,
        sentinels: [
          "733 Hidden Bar Street",
          "+1-850-555-0733",
          "hidden-bar.example.invalid",
          "hidden-bar-sentinel",
          "hidden_bar_sentinel",
          "30.733333",
          "-87.733333",
        ],
      },
      {
        label: "location",
        apiPath: `/api/public/profiles/location/${ids.host}`,
        htmlPath: `/location/${ids.host}`,
        sentinels: [
          "100 Taproom Lane",
          "+1-850-555-0100",
          "INTERNAL HOST NOTE SENTINEL",
          "30.610001",
          "-87.610001",
        ],
      },
      {
        label: "supplier",
        apiPath: `/api/public/profiles/supplier/${ids.hiddenSupplier}`,
        htmlPath: `/supplier/${ids.hiddenSupplier}`,
        sentinels: [
          "811 Hidden Supplier Street",
          "+1-850-555-0811",
          "30.811111",
          "-87.811111",
        ],
      },
    ] as const;
    for (const profileCase of hiddenProfileCases) {
      const api = await getJson(profileCase.apiPath);
      const html = await get(profileCase.htmlPath);
      assert.equal(api.response.status, 200, `${profileCase.label} API status`);
      assert.equal(html.response.status, 200, `${profileCase.label} SSR status`);
      const jsonLd = JSON.stringify(parseJsonLd(html.text));
      for (const sentinel of profileCase.sentinels) {
        assert.equal(
          api.text.includes(sentinel),
          false,
          `${profileCase.label} API leaked ${sentinel}`,
        );
        assert.equal(
          html.text.includes(sentinel),
          false,
          `${profileCase.label} HTML leaked ${sentinel}`,
        );
        assert.equal(
          jsonLd.includes(sentinel),
          false,
          `${profileCase.label} JSON-LD leaked ${sentinel}`,
        );
      }
      assert.match(api.text, /Pensacola/);
      assert.match(jsonLd, /Pensacola/);
      assert.equal(api.text.includes("maps.google.com"), false);
      if (profileCase.label === "restaurant") {
        assert.equal(
          api.body.deals.items.some(
            (deal: any) => deal.id === ids.hiddenRestaurantDeal,
          ),
          true,
          "the hidden-contact restaurant proof must exercise the nested deal projection",
        );
      }
    }

    const hiddenTruckApi = await getJson(
      `/api/public/profiles/truck/${ids.hiddenTruck}`,
    );
    const hiddenTruckHtml = await get(`/truck/${ids.hiddenTruck}`);
    assert.equal(hiddenTruckApi.response.status, 200);
    assert.equal(hiddenTruckHtml.response.status, 200);
    for (const sentinel of [
      "722 Hidden Truck Street",
      "+1-850-555-0722",
      "hidden-truck.example.invalid",
      "hidden-truck-sentinel",
      "hidden_truck_sentinel",
      "30.722222",
      "-87.722222",
    ]) {
      assert.equal(hiddenTruckApi.text.includes(sentinel), false);
      assert.equal(hiddenTruckHtml.text.includes(sentinel), false);
      assert.equal(
        JSON.stringify(parseJsonLd(hiddenTruckHtml.text)).includes(sentinel),
        false,
      );
    }
    assert.equal(hiddenTruckApi.body.latitude, null);
    assert.equal(hiddenTruckApi.body.longitude, null);
    assert.equal(
      hiddenTruckApi.body.truckPresence?.location?.latitude,
      30.799999,
      "an independently live truck signal remains public despite hidden saved coordinates",
    );
    assert.equal(
      hiddenTruckApi.body.truckPresence?.location?.longitude,
      -87.799999,
    );

    const visibleRestaurantApi = await getJson(
      `/api/public/profiles/restaurant/${ids.restaurantOnly}`,
    );
    const visibleRestaurantHtml = await get(`/restaurant/${ids.restaurantOnly}`);
    for (const allowed of ["101 Harbor Way", "+1-850-555-0199"]) {
      assert.equal(visibleRestaurantApi.text.includes(allowed), true);
      assert.equal(
        JSON.stringify(parseJsonLd(visibleRestaurantHtml.text)).includes(allowed),
        true,
      );
    }
    assert.equal(
      visibleRestaurantApi.text.includes(
        "accepted-media.example.invalid/cover.png",
      ),
      true,
    );
    assert.equal(
      visibleRestaurantHtml.text.includes(
        "accepted-media.example.invalid/cover.png",
      ),
      true,
      "SSR must retain media allowed by the shared public profile projection",
    );
    assert.equal(
      visibleRestaurantApi.body.websiteUrl,
      "https://merchant.example.invalid/profile",
      "valid bare public domains must normalize to HTTPS before rendering",
    );
    assert.equal(
      visibleRestaurantHtml.text.includes(
        "https://merchant.example.invalid/profile",
      ),
      true,
    );
    const visibleSupplierApi = await getJson(
      `/api/public/profiles/supplier/${ids.visibleSupplier}`,
    );
    const visibleSupplierHtml = await get(`/supplier/${ids.visibleSupplier}`);
    const visibleSupplierJsonLd = JSON.stringify(parseJsonLd(visibleSupplierHtml.text));
    assert.equal(visibleSupplierJsonLd.includes('"@type":"WebPage"'), true);
    assert.equal(visibleSupplierJsonLd.includes('"@type":"BreadcrumbList"'), true);
    assert.equal(
      visibleSupplierJsonLd.includes(
        `https://www.mealscout.us/supplier/visible-supply-co--${ids.visibleSupplier}#supplier`,
      ),
      true,
    );
    assert.match(visibleSupplierHtml.text, /Public profile updated: \d{4}-\d{2}-\d{2}/);
    assert.match(visibleSupplierHtml.text, /href="\/suppliers"/);
    for (const allowed of [
      "822 Visible Supplier Street",
      "+1-850-555-0822",
    ]) {
      assert.equal(visibleSupplierApi.text.includes(allowed), true);
      assert.equal(
        JSON.stringify(parseJsonLd(visibleSupplierHtml.text)).includes(allowed),
        true,
      );
    }
    const visibleHostApi = await getJson(
      `/api/public/profiles/location/${ids.tomorrowHost}`,
    );
    const visibleHostHtml = await get(`/location/${ids.tomorrowHost}`);
    const visibleHostJsonLd = JSON.stringify(parseJsonLd(visibleHostHtml.text));
    assert.equal(visibleHostJsonLd.includes('"@type":"WebPage"'), true);
    assert.equal(visibleHostJsonLd.includes('"@type":"BreadcrumbList"'), true);
    assert.equal(visibleHostJsonLd.includes('#location'), true);
    assert.match(visibleHostHtml.text, /Public profile updated: \d{4}-\d{2}-\d{2}/);
    assert.match(visibleHostHtml.text, /href="\/city\/tomorrowville\/food"/);
    assert.equal(
      visibleHostApi.body.cta.some(
        (cta: any) =>
          cta.type === "phone" && cta.href === "tel:+1-850-555-0300",
      ),
      true,
      "showContact=true must retain a validated tel CTA",
    );
    assert.equal(
      JSON.stringify(parseJsonLd(visibleHostHtml.text)).includes(
        '"telephone":"+1-850-555-0300"',
      ),
      true,
      "showContact=true host SSR must retain JSON-LD telephone",
    );
    assert.equal(
      hostProfile.body.cta.some((cta: any) => cta.type === "phone"),
      false,
      "showContact=false must omit the call CTA",
    );
    assert.equal(
      JSON.stringify(parseJsonLd((await get(`/location/${ids.host}`)).text)).includes(
        "+1-850-555-0100",
      ),
      false,
      "showContact=false host SSR must omit JSON-LD telephone",
    );
    const canonicalHostBeforeStripe = await getJson(
      `/api/public/canonical/host/${ids.host}`,
    );
    assert.equal(canonicalHostBeforeStripe.response.status, 200);
    await nativePool.query(
      `update hosts set stripe_onboarding_completed = true where id = $1`,
      [ids.host],
    );
    const canonicalHostAfterStripe = await getJson(
      `/api/public/canonical/host/${ids.host}`,
    );
    assert.deepEqual(
      canonicalHostAfterStripe.body,
      canonicalHostBeforeStripe.body,
      "anonymous canonical host truth must not reveal payment-onboarding state",
    );
    assert.doesNotMatch(
      JSON.stringify(canonicalHostAfterStripe.body),
      /stripe|payment[_ -]?onboarding/i,
    );
    assert.equal(
      JSON.stringify(canonicalHostAfterStripe.body).includes(
        "INTERNAL HOST NOTE SENTINEL",
      ),
      false,
    );

    const staticTruckApi = await getJson(
      `/api/public/profiles/truck/${ids.maliciousTruck}`,
    );
    const staticTruckHtml = await get(`/truck/${ids.maliciousTruck}`);
    assert.equal(staticTruckApi.text.includes("100 Harbor Way"), false);
    assert.equal(staticTruckHtml.text.includes("100 Harbor Way"), false);
    assert.equal(staticTruckApi.text.includes("+1-850-555-0199"), true);
    assert.equal(
      JSON.stringify(parseJsonLd(staticTruckHtml.text)).includes(
        "+1-850-555-0199",
      ),
      true,
    );
    for (const redacted of [
      {
        entity: "truck",
        id: ids.quarantinedTruck,
        street: "500 Review Road",
        phone: "+1-850-555-0199",
      },
      {
        entity: "restaurant",
        id: ids.rejectedRestaurant,
        street: "511 Rejected Street",
        phone: "+1-850-555-0511",
      },
    ] as const) {
      const api = await getJson(
        `/api/public/profiles/${redacted.entity}/${redacted.id}`,
      );
      const html = await get(`/${redacted.entity}/${redacted.id}`);
      assert.equal(api.response.status, 200);
      assert.equal(html.response.status, 200);
      for (const sentinel of [redacted.street, redacted.phone]) {
        assert.equal(api.text.includes(sentinel), false);
        assert.equal(html.text.includes(sentinel), false);
        assert.equal(
          JSON.stringify(parseJsonLd(html.text)).includes(sentinel),
          false,
        );
      }
      if (redacted.id === ids.quarantinedTruck) {
        assert.equal(
          api.text.includes("quarantined-media.example.invalid"),
          false,
        );
        assert.equal(
          html.text.includes("quarantined-media.example.invalid"),
          false,
          "SSR must not bypass the shared media quarantine projection",
        );
        assert.equal(
          JSON.stringify(parseJsonLd(html.text)).includes(
            "quarantined-media.example.invalid",
          ),
          false,
        );
      }
    }

    const publicEventPath = `/event/best-harbor-lunch--${ids.publicEvent}`;
    const publicEventHtml = await get(publicEventPath);
    assert.equal(publicEventHtml.response.status, 200);
    assert.match(
      publicEventHtml.text,
      /<h1>Best Harbor Lunch in Pensacola, FL<\/h1>/,
    );
    assert.equal(
      JSON.stringify(parseJsonLd(publicEventHtml.text)).includes(
        '"name":"Best Harbor Lunch"',
      ),
      true,
    );
    assert.ok(
      publicEventHtml.text.includes(
        `rel="canonical" href="https://www.mealscout.us${publicEventPath}"`,
      ),
    );
    assert.equal((await get(`/events/${ids.publicEvent}`)).response.status, 200);
    assert.equal((await get("/events/public")).response.status, 204);
    assert.equal((await get("/restaurant/dashboard")).response.status, 204);
    const reviewsSpa = await get(
      `/restaurant/${ids.restaurantOnly}/reviews`,
    );
    assert.equal(reviewsSpa.response.status, 204);
    assert.equal(
      reviewsSpa.response.headers.get("x-robots-tag"),
      "noindex,nofollow,noarchive",
    );
    assert.equal(
      (
        await get(`/restaurant/${ids.restaurantOnly}/harbor-table`)
      ).response.status,
      200,
      "non-reviews legacy restaurant slug variants must still SSR",
    );
    assert.equal((await get("/supplier/dashboard")).response.status, 204);

    const dedicatedPublicEvent = await getJson(
      `/api/public/events/${ids.publicEvent}`,
    );
    const genericPublicEvent = await getJson(
      `/api/public/canonical/event/${ids.publicEvent}`,
    );
    assert.equal(dedicatedPublicEvent.response.status, 200);
    assert.equal(dedicatedPublicEvent.body.hostPriceCents, 4321);
    assert.equal(genericPublicEvent.response.status, 200);
    assert.equal(dedicatedPublicEvent.body.canonicalUrl, `https://www.mealscout.us${publicEventPath}`);
    assert.equal(genericPublicEvent.body.canonicalUrl, `https://www.mealscout.us${publicEventPath}`);
    assert.equal(dedicatedPublicEvent.text.includes(ids.syntheticTruck), false);
    assert.equal(genericPublicEvent.text.includes("Test Truck 88"), false);
    assert.match(dedicatedPublicEvent.text, new RegExp(ids.maliciousTruck));
    for (const sentinel of [
      "100 Taproom Lane",
      "30.610001",
      "-87.610001",
    ]) {
      assert.equal(dedicatedPublicEvent.text.includes(sentinel), false);
      assert.equal(genericPublicEvent.text.includes(sentinel), false);
      assert.equal(publicEventHtml.text.includes(sentinel), false);
      assert.equal(
        JSON.stringify(parseJsonLd(publicEventHtml.text)).includes(sentinel),
        false,
      );
    }
    assert.match(dedicatedPublicEvent.text, /Pensacola/);
    assert.match(genericPublicEvent.text, /Pensacola/);
    for (const rejectedEventId of [
      ids.privateEvent,
      ids.paymentEvent,
      ids.syntheticEvent,
      ids.syntheticHostEvent,
      ids.ineligibleOnlyEvent,
    ]) {
      assert.equal(
        (await get(`/api/public/events/${rejectedEventId}`)).response.status,
        404,
      );
      assert.equal(
        (await get(`/api/public/canonical/event/${rejectedEventId}`)).response.status,
        404,
      );
    }
    const unrelatedAuthenticatedPrivateEvent = await fetch(
      `${baseUrl}/api/public/events/${ids.privateEvent}`,
      {
        headers: {
          "user-agent": "Googlebot/2.1",
          "x-test-unrelated-customer": "1",
        },
      },
    );
    assert.equal(
      unrelatedAuthenticatedPrivateEvent.status,
      404,
      "an unrelated logged-in customer must not bypass the public event detail gate",
    );
    const paidEventRowsBeforeDetail = await nativePool.query(
      "select count(*)::int as count from events where id = $1",
      [ids.paymentEvent],
    );
    assert.equal(
      paidEventRowsBeforeDetail.rows[0]?.count,
      0,
      "the paid occurrence must begin as series-only truth without a stored event override",
    );
    const unrelatedAuthenticatedPaidEvent = await fetch(
      `${baseUrl}/api/public/events/${ids.paymentEvent}?truckId=${encodeURIComponent(ids.maliciousTruck)}`,
      {
        headers: {
          "user-agent": "MealScout integration test",
          "x-test-unrelated-customer": "1",
        },
      },
    );
    assert.equal(
      unrelatedAuthenticatedPaidEvent.status,
      404,
      "an unrelated authenticated user must not borrow a truck id to expose paid event detail",
    );
    const fixedRestaurantPaidEvent = await fetch(
      `${baseUrl}/api/public/events/${ids.paymentEvent}?truckId=${encodeURIComponent(ids.restaurantOnly)}`,
      {
        headers: {
          "user-agent": "MealScout integration test",
          "x-test-food-truck-owner": "1",
        },
      },
    );
    assert.equal(
      fixedRestaurantPaidEvent.status,
      404,
      "an owned fixed restaurant must not expose food-truck-only paid detail",
    );
    const legacyTruckPaidEvent = await fetch(
      `${baseUrl}/api/public/events/${ids.paymentEvent}?truckId=${encodeURIComponent(ids.legacyAccessTruck)}`,
      {
        headers: {
          "user-agent": "MealScout integration test",
          "x-test-food-truck-owner": "1",
        },
      },
    );
    assert.equal(
      legacyTruckPaidEvent.status,
      200,
      "a legacy is_food_truck row must retain authorized paid detail access",
    );
    const anonymousPaidEventHtml = await get(
      `/event/paid-team-lunch--${ids.paymentEvent}`,
    );
    assert.equal(anonymousPaidEventHtml.response.status, 404);
    assert.equal(anonymousPaidEventHtml.text.includes("spa-shell"), false);
    const ownerPaidEventHtml = await fetch(
      `${baseUrl}/event/paid-team-lunch--${ids.paymentEvent}`,
      {
        headers: {
          accept: "text/html",
          "user-agent": "MealScout integration test",
          "x-test-food-truck-owner": "1",
        },
      },
    );
    const ownerPaidEventHtmlText = await ownerPaidEventHtml.text();
    assert.equal(ownerPaidEventHtml.status, 200);
    assert.equal(
      ownerPaidEventHtml.headers.get("cache-control"),
      "private, no-store",
    );
    assert.equal(
      ownerPaidEventHtml.headers.get("x-robots-tag"),
      "noindex,nofollow,noarchive",
    );
    assert.equal(ownerPaidEventHtmlText.includes("spa-shell"), true);
    assert.equal(ownerPaidEventHtmlText.includes("Paid Team Lunch"), false);
    const ownedTruckPaidEventResponse = await fetch(
      `${baseUrl}/api/public/events/${ids.paymentEvent}?truckId=${encodeURIComponent(ids.maliciousTruck)}`,
      {
        headers: {
          "user-agent": "MealScout integration test",
          "x-test-food-truck-owner": "1",
        },
      },
    );
    const ownedTruckPaidEvent = await ownedTruckPaidEventResponse.json();
    const paidEventRowsAfterDetail = await nativePool.query(
      "select count(*)::int as count from events where id = $1",
      [ids.paymentEvent],
    );
    assert.equal(
      paidEventRowsAfterDetail.rows[0]?.count,
      0,
      "authorized detail must resolve a series-only occurrence without materializing it",
    );
    const unbookedPaidEventCount = await nativePool.query(
      "select count(*)::int as count from event_bookings where event_id = $1",
      [ids.paymentEvent],
    );
    assert.equal(
      unbookedPaidEventCount.rows[0]?.count,
      0,
      "the owner detail proof must use a genuinely unbooked paid event",
    );
    assert.equal(ownedTruckPaidEventResponse.status, 200);
    assert.equal(
      ownedTruckPaidEventResponse.headers.get("cache-control"),
      "private, no-store",
    );
    assert.equal(ownedTruckPaidEvent.hostPriceCents, 2500);
    assert.equal(ownedTruckPaidEvent.requiresPayment, true);
    assert.equal(ownedTruckPaidEvent.isPublic, false);
    assert.equal(ownedTruckPaidEvent.noIndex, true);
    const foodTruckBookingEntry = await fetch(
      `${baseUrl}/api/events/${ids.paymentEvent}/book`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "MealScout integration test",
          "x-test-food-truck-owner": "1",
        },
        body: "{}",
      },
    );
    assert.equal(
      foodTruckBookingEntry.status,
      400,
      "a food_truck account must reach the booking handler instead of failing the old role gate",
    );
    assert.deepEqual(await foodTruckBookingEntry.json(), {
      message: "truckId is required",
    });
    const fixedRestaurantBooking = await fetch(
      `${baseUrl}/api/events/${ids.paymentEvent}/book`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "MealScout integration test",
          "x-test-food-truck-owner": "1",
        },
        body: JSON.stringify({ truckId: ids.restaurantOnly }),
      },
    );
    assert.equal(fixedRestaurantBooking.status, 403);
    assert.deepEqual(await fixedRestaurantBooking.json(), {
      message: "Parking Pass bookings are only available for food trucks.",
    });
    const unverifiedEmailBooking = await fetch(
      `${baseUrl}/api/events/${ids.paymentEvent}/book`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "MealScout integration test",
          "x-test-unverified-food-truck-owner": "1",
        },
        body: JSON.stringify({ truckId: ids.maliciousTruck }),
      },
    );
    assert.equal(unverifiedEmailBooking.status, 409);
    assert.deepEqual(await unverifiedEmailBooking.json(), {
      code: "truck_verification_required",
      message:
        "Verify your email and submit business insurance to book Parking Pass spots.",
      onboardingPath:
        "/restaurant-signup?businessType=food_truck&source=parking-pass&step=verification",
      requirements: {
        emailVerified: false,
        businessInsuranceSubmitted: true,
      },
    });
    const expiredInsuranceBooking = await fetch(
      `${baseUrl}/api/events/${ids.paymentEvent}/book`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "MealScout integration test",
          "x-test-food-truck-owner": "1",
        },
        body: JSON.stringify({ truckId: ids.legacyAccessTruck }),
      },
    );
    assert.equal(expiredInsuranceBooking.status, 409);
    const expiredInsurancePayload = await expiredInsuranceBooking.json();
    assert.deepEqual(expiredInsurancePayload.requirements, {
      emailVerified: true,
      businessInsuranceSubmitted: false,
    });
    const pastSameDayBooking = await fetch(
      `${baseUrl}/api/events/${ids.pastPaymentEvent}/book`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "MealScout integration test",
          "x-test-food-truck-owner": "1",
        },
        body: JSON.stringify({ truckId: ids.maliciousTruck }),
      },
    );
    assert.equal(
      pastSameDayBooking.status,
      400,
      "a same-day slot whose zoned start has passed must be rejected before materialization",
    );
    assert.deepEqual(await pastSameDayBooking.json(), {
      message: "Event has already passed",
    });
    const pastPaidEventRows = await nativePool.query(
      "select count(*)::int as count from events where id = $1",
      [ids.pastPaymentEvent],
    );
    assert.equal(
      pastPaidEventRows.rows[0]?.count,
      0,
      "a rejected same-day-past occurrence must remain virtual",
    );
    const paidEventRowsBeforeEligibleBooking = await nativePool.query(
      "select count(*)::int as count from events where id = $1",
      [ids.paymentEvent],
    );
    assert.equal(
      paidEventRowsBeforeEligibleBooking.rows[0]?.count,
      0,
      "missing or ineligible truck requests must not materialize a virtual occurrence",
    );
    const eligibleSameDayBooking = await fetch(
      `${baseUrl}/api/events/${ids.paymentEvent}/book`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "MealScout integration test",
          "x-test-food-truck-owner": "1",
        },
        body: JSON.stringify({ truckId: ids.maliciousTruck }),
      },
    );
    assert.equal(
      eligibleSameDayBooking.status,
      503,
      "a verified truck must pass same-day slot eligibility and reach the intentionally disabled payment boundary",
    );
    assert.deepEqual(await eligibleSameDayBooking.json(), {
      message: "Payments not configured on server",
    });
    const materializedPaidEvent = await nativePool.query(
      `select id, series_id as "seriesId", event_type as "eventType",
              requires_payment as "requiresPayment", host_price_cents as "hostPriceCents",
              to_char(date, 'YYYY-MM-DD') as "dateKey",
              start_time as "startTime", end_time as "endTime"
         from events where id = $1`,
      [ids.paymentEvent],
    );
    assert.deepEqual(materializedPaidEvent.rows, [
      {
        id: ids.paymentEvent,
        seriesId: ids.paymentSeries,
        eventType: "parking_pass",
        requiresPayment: true,
        hostPriceCents: 2500,
        dateKey: "2026-08-22",
        startTime: "13:00",
        endTime: "14:00",
      },
    ]);
    const materializedPaidDetail = await fetch(
      `${baseUrl}/api/public/events/${ids.paymentEvent}?truckId=${encodeURIComponent(ids.maliciousTruck)}`,
      {
        headers: {
          "user-agent": "MealScout integration test",
          "x-test-food-truck-owner": "1",
        },
      },
    );
    assert.equal(
      materializedPaidDetail.status,
      200,
      "a materialized virtual override must retain authorized detail access",
    );
    await nativePool.query(
      "update events set status = 'cancelled' where id = $1",
      [ids.paymentEvent],
    );
    const cancelledPaidDetail = await fetch(
      `${baseUrl}/api/public/events/${ids.paymentEvent}?truckId=${encodeURIComponent(ids.maliciousTruck)}`,
      {
        headers: {
          "user-agent": "MealScout integration test",
          "x-test-food-truck-owner": "1",
        },
      },
    );
    assert.equal(
      cancelledPaidDetail.status,
      404,
      "a cancelled materialized override must not reappear as an open virtual occurrence",
    );
    const paidEventBookingsAfterRejections = await nativePool.query(
      "select count(*)::int as count from event_bookings where event_id = $1",
      [ids.paymentEvent],
    );
    assert.equal(
      paidEventBookingsAfterRejections.rows[0]?.count,
      0,
      "eligibility and payment-boundary proofs must not create a booking",
    );
    assert.equal(
      (await get(`/api/public/events/${ids.legacyAliasEvent}`)).response.status,
      200,
      "normalized legacy truck aliases must survive confirmed-event detail filtering",
    );
    for (const syntheticEventId of [
      ids.syntheticEvent,
      ids.syntheticHostEvent,
    ]) {
      const syntheticEventHtml = await get(`/event/${syntheticEventId}`);
      assert.equal(syntheticEventHtml.response.status, 404);
      assert.match(
        syntheticEventHtml.text,
        /name="robots" content="noindex,follow"/,
      );
    }

    const hostHtml = await get(`/location/${ids.host}`);
    const syntheticHostHtml = await get(`/location/${ids.syntheticHost}`);
    assert.match(hostHtml.text, /name="robots" content="index,follow/);
    assert.match(syntheticHostHtml.text, /name="robots" content="noindex,follow"/);

    const activeDealPath = `/deal/best-harbor-lunch-special--${ids.activeDeal}`;
    const activeDealHtml = await get(activeDealPath);
    assert.match(
      activeDealHtml.text,
      /<h1>Best Harbor Lunch Special - Harbor Table<\/h1>/,
    );
    assert.equal(
      JSON.stringify(parseJsonLd(activeDealHtml.text)).includes(
        '"name":"Best Harbor Lunch Special"',
      ),
      true,
    );
    const genericActiveDeal = await getJson(
      `/api/public/canonical/deal/${ids.activeDeal}`,
    );
    assert.equal(genericActiveDeal.body.canonicalUrl, `https://www.mealscout.us${activeDealPath}`);
    assert.equal(genericActiveDeal.body.active, true);
    assert.ok(activeDealHtml.text.includes(`rel="canonical" href="https://www.mealscout.us${activeDealPath}"`));
    assert.match(activeDealHtml.text, /name="robots" content="index,follow/);
    assert.equal(
      (await getJson(`/api/public/canonical/deal/${ids.expiredDeal}`)).body.active,
      false,
    );
    assert.equal(
      (await getJson(`/api/public/canonical/deal/${ids.ineligibleDeal}`)).body.active,
      false,
    );
    assert.match(
      (await get(`/deal/${ids.ineligibleDeal}`)).text,
      /name="robots" content="noindex,follow"/,
    );
    const syntheticDealCanonical = await getJson(
      `/api/public/canonical/deal/${ids.syntheticDeal}`,
    );
    assert.equal(syntheticDealCanonical.response.status, 200);
    assert.equal(syntheticDealCanonical.body.active, false);
    const syntheticDealHtml = await get(`/deal/${ids.syntheticDeal}`);
    assert.equal(syntheticDealHtml.response.status, 200);
    assert.match(
      syntheticDealHtml.text,
      /name="robots" content="noindex,follow"/,
    );

    const citiesSitemap = await get("/sitemap-cities.xml");
    assert.equal(citiesSitemap.response.status, 200);
    assert.equal(
      citiesSitemap.response.headers.get("x-mealscout-sitemap-membership"),
      "pd-v1-indexability-4",
    );
    const citiesSitemapEtag = citiesSitemap.response.headers.get("etag");
    assert.ok(citiesSitemapEtag, "Express must derive an ETag from the XML body");
    assert.match(citiesSitemap.text, /\/city\/pensacola\/food/);
    assert.equal(citiesSitemap.text.includes("/city/york/food"), false);
    assert.equal(citiesSitemap.text.includes("/city/emptyville/food"), false);
    assert.equal(citiesSitemap.text.includes("/city/stateless/food"), false);
    assert.equal(citiesSitemap.text.includes("/city/visitville/food"), false);
    assert.equal(
      (citiesSitemap.text.match(/\/city\/overflowville\/food/g) || []).length,
      1,
      "dedicated city traversal must find an older eligible row beyond 250 ineligible rows",
    );
    assert.equal(
      citiesSitemap.text.includes("/city/restaurantville/food"),
      true,
      "restaurant-only cities must remain in the city-food sitemap",
    );
    assert.equal(
      (citiesSitemap.text.match(/\/city\/dupetown\/food/g) || []).length,
      1,
      "the city sitemap must publish one normalized duplicate-slug winner",
    );
    assert.equal(citiesSitemap.text.includes("DuPeToWn"), false);
    assert.equal(
      /\/city\/pensacola<\/loc>/.test(citiesSitemap.text),
      false,
    );
    const rootSitemap = await get("/sitemap.xml");
    assert.equal(rootSitemap.response.status, 200);
    assert.match(rootSitemap.text, /<loc>https:\/\/www\.mealscout\.us\//);
    assert.equal(
      rootSitemap.text.includes("<loc>https://mealscout.us/"),
      false,
      "an apex PUBLIC_BASE_URL must not split API, SSR, and sitemap canonical hosts",
    );
    assert.equal(
      rootSitemap.response.headers.get("x-mealscout-sitemap-membership"),
      "pd-v1-indexability-4",
    );
    const rootSitemapEtag = rootSitemap.response.headers.get("etag");
    assert.ok(rootSitemapEtag, "Express must derive an ETag from the XML body");
    assert.notEqual(
      rootSitemapEtag,
      citiesSitemapEtag,
      "different sitemap bodies under one policy version must not share a validator",
    );
    const rootWithCitiesValidator = await fetch(`${baseUrl}/sitemap.xml`, {
      headers: {
        "user-agent": "Googlebot/2.1",
        "if-none-match": citiesSitemapEtag!,
      },
    });
    assert.equal(
      rootWithCitiesValidator.status,
      200,
      "a validator for a different sitemap body cannot stale-304 the root sitemap",
    );
    assert.equal(
      (rootSitemap.text.match(/\/city\/dupetown\/food/g) || []).length,
      1,
    );
    assert.equal(rootSitemap.text.includes("DuPeToWn"), false);
    assert.equal(
      (rootSitemap.text.match(/\/city\/overflowville\/food/g) || []).length,
      1,
    );
    assert.match(
      rootSitemap.text,
      /\/food-trucks\/pensacola\/pizza-sammys-desserts/,
    );
    assert.equal(
      rootSitemap.text.includes(
        "/food-trucks/capville/tail-only-cuisine",
      ),
      true,
      "root XML cuisine membership must match the uncapped human navigation aggregate",
    );
    assert.equal(
      rootSitemap.text.includes("/cuisine/tail-only-cuisine/capville"),
      true,
    );
    assert.equal(
      rootSitemap.text.includes(
        "/food-trucks/pensacola/restaurant-only-fare",
      ),
      false,
    );
    assert.match(rootSitemap.text, /\/food-trucks-today\/pensacola/);
    assert.match(rootSitemap.text, /\\/food-truck-catering\\/pensacola/);
    assert.match(rootSitemap.text, /\\/book-food-truck\\/pensacola/);
    assert.equal(
      rootSitemap.text.includes("/food-truck-catering/emptyville"),
      false,
      "commercial-intent pages must not be published for cities without eligible trucks",
    );
    assert.equal(
      rootSitemap.text.includes("/book-food-truck/emptyville"),
      false,
      "booking-intent pages must not be published for cities without eligible trucks",
    );
    assert.equal(
      (rootSitemap.text.match(/\/food-trucks-today\/visitville/g) || []).length,
      1,
      "root today membership must inspect visiting-truck stops independently of home city",
    );
    assert.equal(
      rootSitemap.text.includes("/city/visitville/food"),
      false,
      "visiting-stop evidence must not create home-city food membership",
    );
    assert.equal(
      (rootSitemap.text.match(/\/food-trucks-today\/overflowville/g) || []).length,
      1,
    );
    assert.equal(
      (rootSitemap.text.match(/\/food-trucks-today\/pensacola-ok/g) || []).length,
      1,
      "a same-name other-state active stop belongs to its exact canonical city/state page",
    );
    assert.equal(
      rootSitemap.text.includes("/deals/pensacola"),
      false,
      "the legacy city-deals SPA shell must not be a crawler discovery claim",
    );
    assert.match(rootSitemap.text, /\/deals-today\/pensacola/);
    assert.match(rootSitemap.text, /\/deals-today\/pensacola-ok/);
    assert.equal(
      rootSitemap.text.includes("/deals-today/restaurantville"),
      false,
      "a synthetic deal title on an eligible parent must not qualify root sitemap membership",
    );
    assert.equal(rootSitemap.text.includes("/deals-today/stateless"), false);
    assert.equal(
      (rootSitemap.text.match(/\/events-today\/pensacola/g) || []).length,
      1,
      "a today city must publish its events-today URL once",
    );
    assert.equal(
      (rootSitemap.text.match(/\/locations-with-trucks\/pensacola/g) || [])
        .length,
      1,
      "a today city must also publish its seven-day locations URL once",
    );
    assert.equal(
      rootSitemap.text.includes("/events-today/tomorrowville"),
      false,
      "tomorrow-only evidence must not publish an events-today URL",
    );
    assert.equal(
      (rootSitemap.text.match(/\/locations-with-trucks\/tomorrowville/g) || [])
        .length,
      1,
      "tomorrow-only evidence must publish the seven-day locations URL once",
    );
    assert.equal(
      rootSitemap.text.includes(
        `/restaurant/harbor-table--${ids.restaurantOnly}`,
      ),
      true,
    );
    const truckSitemap = await get("/sitemap-trucks.xml");
    assert.equal(truckSitemap.response.status, 200);
    assert.equal(
      truckSitemap.text.includes(ids.legacyAliasTruck),
      true,
      "the dedicated truck sitemap must retain normalized legacy aliases",
    );
    assert.equal(truckSitemap.text.includes(ids.truckBarConflict), true);
    assert.equal(
      truckSitemap.text.includes(
        `/truck/rolling-tap-wagon--${ids.truckBarConflict}`,
      ),
      true,
    );
    const barSitemap = await get("/sitemap-bars.xml");
    assert.equal(barSitemap.text.includes(ids.bar), true);
    assert.equal(
      barSitemap.text.includes(`/bar/bay-brewery--${ids.bar}`),
      true,
    );
    assert.equal(
      barSitemap.text.includes(ids.truckBarConflict),
      false,
      "a truck/bar collision must have exactly one canonical truck identity",
    );
    assert.equal(
      rootSitemap.text.includes(
        `/caterer/bay-catering-company--${ids.caterer}`,
      ),
      true,
    );
    assert.equal(
      rootSitemap.text.includes(
        `/private-chef/bay-private-chef--${ids.privateChef}`,
      ),
      true,
    );
    const serviceSitemap = await get("/sitemap-services.xml");
    assert.equal(serviceSitemap.response.status, 200);
    assert.equal(
      serviceSitemap.response.headers.get("x-mealscout-sitemap-membership"),
      "pd-v1-indexability-4",
    );
    assert.equal(
      serviceSitemap.text.includes(
        `/caterer/bay-catering-company--${ids.caterer}`,
      ),
      true,
    );
    assert.equal(
      serviceSitemap.text.includes(
        `/private-chef/bay-private-chef--${ids.privateChef}`,
      ),
      true,
    );
    assert.equal(serviceSitemap.text.includes(ids.combinedService), false);
    assert.equal(serviceSitemap.text.includes(ids.unknownBusiness), false);
    assert.equal(
      truckSitemap.response.headers.get("x-mealscout-sitemap-membership"),
      "pd-v1-indexability-4",
    );
    const eventSitemap = await get("/sitemap-events.xml");
    assert.equal(eventSitemap.response.status, 200);
    assert.match(eventSitemap.text, new RegExp(ids.publicEvent));
    assert.equal(eventSitemap.text.includes(publicEventPath), true);
    assert.equal(eventSitemap.text.includes(ids.privateEvent), false);
    assert.equal(eventSitemap.text.includes(ids.syntheticEvent), false);
    const locationSitemap = await get("/sitemap-locations.xml");
    assert.equal(locationSitemap.response.status, 200);
    assert.match(locationSitemap.text, new RegExp(ids.host));
    assert.equal(locationSitemap.text.includes(ids.syntheticHost), false);
    const dealSitemap = await get("/sitemap-deals.xml");
    assert.equal(dealSitemap.response.status, 200);
    assert.equal(dealSitemap.text.includes(ids.activeDeal), true);
    assert.equal(dealSitemap.text.includes(activeDealPath), true);
    assert.equal(dealSitemap.text.includes(ids.wrongStateDeal), true);
    assert.equal(dealSitemap.text.includes(ids.expiredDeal), false);
    assert.equal(dealSitemap.text.includes(ids.inactiveDeal), false);
    assert.equal(dealSitemap.text.includes(ids.ineligibleDeal), false);
    assert.equal(dealSitemap.text.includes(ids.syntheticDeal), false);
    assert.equal(dealSitemap.text.includes("caterer-deal"), false);
    assert.equal(dealSitemap.text.includes("private-chef-deal"), false);

    const timeSitemap = await get("/sitemap-time-pages.xml");
    assert.equal(timeSitemap.response.status, 410);
    assert.equal(
      timeSitemap.response.headers.get("cache-control"),
      "no-store",
    );
    assert.match(
      timeSitemap.response.headers.get("content-type") || "",
      /^text\/plain/,
    );
    assert.equal(timeSitemap.text, "Gone");
    const robots = await get("/robots.txt");
    const llms = await get("/llms.txt");
    assert.match(robots.text, /Allow: \/caterer\//);
    assert.match(robots.text, /Allow: \/private-chef\//);
    assert.match(robots.text, /sitemap-services\.xml/);
    assert.match(llms.text, /Pattern: \/caterer\/\{slug\}--\{id\}/);
    assert.match(llms.text, /Pattern: \/private-chef\/\{slug\}--\{id\}/);
    for (const retired of [
      "sitemap-time-pages.xml",
      "food-trucks-now",
      "food-trucks-breakfast",
      "food-trucks-lunch",
      "food-trucks-dinner",
      "food-trucks-tonight",
      "food-trucks-this-weekend",
    ]) {
      assert.equal(rootSitemap.text.includes(retired), false);
      assert.equal(robots.text.includes(retired), false);
      assert.equal(llms.text.includes(retired), false);
    }
    assert.equal(rootSitemap.text.includes("/events/public"), false);
    assert.equal(llms.text.includes("/events/public"), false);

    const failureApp = express();
    const failedLoader = async () => {
      throw new Error("injected public SEO loader failure");
    };
    registerPublicSeoLandingRoutes(failureApp, failedLoader as any);
    registerPublicProfilePrerenderRoutes(
      failureApp,
      "https://www.mealscout.us",
      failedLoader as any,
      {
        restaurantPage: async () => {
          throw new Error("injected profile loader failure");
        },
        sendPage: () => {
          throw new Error("injected profile renderer failure");
        },
      } as any,
    );
    registerEventRoutes(failureApp, {
      hasCompleteProfileAccess: async () => true,
      publicEventFeedLoader: async () => {
        throw new Error("injected public event feed failure");
      },
      publicEventDetailLoader: async () => {
        throw new Error("injected public event detail failure");
      },
      publicEventNow: () => FIXTURE_NOW,
    });
    let sitemapFailureSection: "deal" | "event" = "deal";
    registerSeoRoutes(failureApp, {
      loadRootDealCityRows: async () => {
        if (sitemapFailureSection === "deal") {
          throw new Error("injected root sitemap deal query failure");
        }
        return [];
      },
      loadRootEventCityRows: async () => {
        throw new Error("injected root sitemap event query failure");
      },
    });
    failureApp.use((_req, res) => res.status(299).send("SPA fallback"));
    failureServer = await listen(failureApp);
    const failurePort = (failureServer.address() as AddressInfo).port;
    const failureBase = `http://127.0.0.1:${failurePort}`;
    for (const path of ["/api/events/public", "/api/events/upcoming"]) {
      const failedFeed = await fetch(`${failureBase}${path}`);
      assert.equal(failedFeed.status, 503);
      assert.equal(failedFeed.headers.get("retry-after"), "60");
      assert.equal(failedFeed.headers.get("cache-control"), "no-store");
      assert.equal(failedFeed.headers.get("x-robots-tag"), "noindex,follow");
      assert.deepEqual(await failedFeed.json(), {
        message: "Events are temporarily unavailable",
      });
    }
    const failedEventDetail = await fetch(
      `${failureBase}/api/public/events/detail-id`,
    );
    assert.equal(failedEventDetail.status, 503);
    assert.equal(failedEventDetail.headers.get("retry-after"), "60");
    assert.equal(failedEventDetail.headers.get("cache-control"), "no-store");
    assert.equal(
      failedEventDetail.headers.get("x-robots-tag"),
      "noindex,follow",
    );
    const failedApi = await fetch(
      `${failureBase}/api/public/seo/city/pensacola/food`,
    );
    assert.equal(failedApi.status, 503);
    assert.equal(failedApi.headers.get("retry-after"), "60");
    assert.equal(failedApi.headers.get("cache-control"), "no-store");
    assert.equal(failedApi.headers.get("x-robots-tag"), "noindex,follow");
    const failedHtml = await fetch(`${failureBase}/city/pensacola/food`);
    const failedHtmlBody = await failedHtml.text();
    assert.equal(failedHtml.status, 503);
    assert.equal(failedHtml.headers.get("retry-after"), "60");
    assert.equal(failedHtml.headers.get("cache-control"), "no-store");
    assert.equal(failedHtml.headers.get("x-robots-tag"), "noindex,follow");
    assert.match(failedHtmlBody, /noindex,follow/);
    const failedProfile = await fetch(`${failureBase}/restaurant/profile-id`);
    assert.equal(failedProfile.status, 503);
    assert.equal(failedProfile.headers.get("retry-after"), "60");
    assert.equal(failedProfile.headers.get("cache-control"), "no-store");
    assert.equal(failedProfile.headers.get("x-robots-tag"), "noindex,follow");
    assert.match(await failedProfile.text(), /noindex,follow/);
    const failedRenderer = await fetch(`${failureBase}/location/${ids.host}`);
    assert.equal(failedRenderer.status, 503);
    assert.equal(failedRenderer.headers.get("x-robots-tag"), "noindex,follow");
    assert.notEqual(failedRenderer.status, 299, "profile failures must not reach SPA fallback");
    for (const section of ["deal", "event"] as const) {
      sitemapFailureSection = section;
      const failedSitemap = await fetch(`${failureBase}/sitemap.xml`);
      const failedSitemapBody = await failedSitemap.text();
      assert.equal(
        failedSitemap.status,
        503,
        `${section} membership query failure must terminate the root sitemap`,
      );
      assert.equal(failedSitemap.headers.get("retry-after"), "60");
      assert.equal(failedSitemap.headers.get("cache-control"), "no-store");
      assert.equal(
        failedSitemap.headers.get("x-robots-tag"),
        "noindex, follow",
      );
      assert.match(failedSitemapBody, /temporarily unavailable/);
      assert.doesNotMatch(
        failedSitemapBody,
        /<urlset|\/city\//,
        `${section} failure must not return partial cacheable membership XML`,
      );
    }

    console.log(
      "public-seo-landing.integration: PASS (fresh PostgreSQL 16; exact city/state and indexability; canonical cuisine and truck-only cuisine; truthful today schedules and deals; private/synthetic event and host exclusion; safe JSON-LD; sitemap parity; API/HTML 503 no-store failure semantics)",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await closeServer(failureServer).catch(() => undefined);
    await closeServer(server).catch(() => undefined);
    if (applicationPool) await applicationPool.end().catch(() => undefined);
    await nativePool.end().catch(() => undefined);
    await closeWebSocketProxy(wsProxy).catch(() => undefined);
  }
}

run().catch((error: any) => {
  console.error("public-seo-landing.integration: FAIL", error?.stack || error);
  if (error?.cause) console.error("database cause:", error.cause);
  process.exit(1);
});
