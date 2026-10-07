// Focused in-memory regression for the actual changed route callbacks/effect.
// No app startup, listener, database, browser, provider API, or environment file.
// Run only after resource admission: node scripts/qa/legacy-event-checkout.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const Stripe = require("stripe");

const root = path.resolve(__dirname, "../..");
const sources = new Map();
function source(file) {
  if (!sources.has(file)) {
    sources.set(file, ts.createSourceFile(file, fs.readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true));
  }
  return sources.get(file);
}
function find(file, predicate) {
  let result;
  function walk(node) {
    if (result) return;
    if (predicate(node)) result = node;
    else ts.forEachChild(node, walk);
  }
  walk(source(file));
  assert.ok(result, `Missing native source node in ${file}`);
  return result;
}
function evaluate(code, bindings = {}) {
  const output = ts.transpileModule(`module.exports = ${code};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = { module: { exports: {} }, exports: {}, URLSearchParams, Buffer, console: { log() {}, warn() {}, error() {} }, ...bindings };
  vm.runInNewContext(output, context, { timeout: 1000 });
  return context.module.exports;
}
function route(file, routePath, bindings) {
  const registration = find(file, (node) => ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source(file)) === "app"
    && node.expression.name.text === "post" && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === routePath);
  if (routePath !== "/api/stripe/webhook") assert.equal(registration.arguments[1].getText(source(file)), "isAuthenticated");
  return evaluate(registration.arguments.at(-1).getText(source(file)), bindings);
}
const eventFile = "server/routes/eventRoutes.ts";
const webhookFile = "server/routes/stripeWebhookRoutes.ts";
const schema = Object.fromEntries(["eventBookings", "events", "restaurants", "hosts"].map((name) => [name,
  new Proxy({ name }, { get: (table, field) => field === "name" ? name : { table: name, field } }),
]));
const eq = (field, value) => ({ field, value });
const and = (...conditions) => ({ conditions });
function matches(row, condition) {
  if (condition.conditions) return condition.conditions.every((part) => matches(row, part));
  return row[condition.field.field] === condition.value;
}
function fixture(options = {}) {
  const row = { id: "booking-fixture", eventId: "event-fixture", truckId: "truck-fixture", hostId: "host-fixture",
    status: "pending", stripePaymentIntentId: "pi_fixture", totalCents: 2500, hostPriceCents: 1500,
    stripeTransferDestination: null, ...options.row };
  const intent = { id: "pi_fixture", status: "succeeded", currency: "usd", amount: 2500, amount_received: 2500,
    metadata: { bookingId: row.id, eventId: row.eventId, truckId: row.truckId, hostId: row.hostId }, ...options.intent };
  const state = { row, intent, writes: 0, fillWrites: 0, earnings: 0, notifications: 0, reads: 0 };
  const db = {
    select(fields) {
      let selectedTable;
      const query = {
        from(table) { selectedTable = table.name; return query; }, where() { return query; },
        limit() { return Promise.resolve(values()); }, then(resolve, reject) { return Promise.resolve(values()).then(resolve, reject); },
      };
      function values() {
        if (selectedTable === "eventBookings") {
          if (fields?.count) return [{ count: state.row.status === "confirmed" ? 1 : 0 }];
          state.reads++;
          const snapshot = { ...state.row };
          if (options.raceAfterRead) Object.assign(state.row, options.raceAfterRead);
          return [snapshot];
        }
        if (selectedTable === "events") return [{ maxTrucks: 1, hostId: row.hostId, date: null }];
        return [];
      }
      return query;
    },
    update(table) {
      let values, predicate, applied = false, returned;
      const query = {
        set(next) { values = next; return query; }, where(next) { predicate = next; return query; },
        returning() { return Promise.resolve(apply()); }, then(resolve, reject) { return Promise.resolve(apply()).then(resolve, reject); },
      };
      function apply() {
        if (applied) return returned;
        applied = true;
        returned = [];
        if (table.name === "eventBookings" && matches(state.row, predicate)) {
          Object.assign(state.row, values); state.writes++; returned = [{ id: state.row.id }];
        } else if (table.name === "events") state.fillWrites++;
        return returned;
      }
      return query;
    },
  };
  const verifier = new Stripe("local-fixture-no-provider-access");
  const stripe = options.noStripe ? null : {
    paymentIntents: { retrieve: async () => ({ ...state.intent }) },
    webhooks: { constructEvent: verifier.webhooks.constructEvent.bind(verifier.webhooks) },
  };
  const bindings = { ...schema, db, stripe, eq, and, sql: () => ({}),
    storage: { verifyRestaurantOwnership: async () => true, getUser: async () => null },
    emailService: new Proxy({}, { get: () => async () => { state.notifications++; } }),
    notifyHostCapacityWarning: async () => { state.notifications++; },
    process: { env: { NODE_ENV: "production", STRIPE_WEBHOOK_SECRET: "local-fixture-signing-secret" } },
    decideStripeWebhookVerificationMode: () => "verify_signature",
    require(name) {
      if (name === "@shared/schema") return schema;
      if (name === "../hostEarningsService") return { recordHostBookingEarnings: async () => { state.earnings++; } };
      throw new Error(`Unexpected fixture dependency ${name}`);
    },
  };
  const response = { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; } };
  async function run(kind) {
    if (kind === "receipt") {
      await route(eventFile, "/api/bookings/:bookingId/confirm", bindings)({ params: { bookingId: row.id }, user: { id: "owner-fixture" } }, response);
    } else {
      const payload = JSON.stringify({ id: "evt_fixture", type: "payment_intent.succeeded", data: { object: state.intent } });
      const signature = verifier.webhooks.generateTestHeaderString({ payload, secret: "local-fixture-signing-secret" });
      await route(webhookFile, "/api/stripe/webhook", bindings)({ body: Buffer.from(payload), headers: { "stripe-signature": signature } }, response);
    }
    return response;
  }
  return { state, run };
}
function noFollowups(state) {
  assert.equal(state.writes, 0); assert.equal(state.fillWrites, 0);
  assert.equal(state.earnings, 0); assert.equal(state.notifications, 0);
}
async function main() {
  let cases = 0;
  for (const passId of ["event-fixture", "pp:series-fixture:2026-10-09", "x&truckId=foreign"]) {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    const handler = route(eventFile, "/api/events/:eventId/book", {});
    handler({ params: { eventId: passId }, body: { truckId: "truck-fixture" } }, response);
    assert.equal(response.statusCode, 409); assert.equal(response.body.code, "canonical_checkout_required");
    const target = new URL(response.body.checkoutPath, "http://local-fixture.invalid");
    assert.equal(target.pathname, "/parking-pass"); assert.equal(target.searchParams.get("pass"), passId);
    assert.equal(target.searchParams.get("truckId"), "truck-fixture"); assert.equal(response.body.paymentPending, undefined);
    cases++;
  }
  for (const kind of ["receipt", "webhook"]) {
    for (const options of [
      { row: { status: "cancelled" } }, { row: { status: "refunded" } }, { row: { stripePaymentIntentId: null } },
      { intent: { id: "pi_foreign" } }, { intent: { amount_received: 1000 } }, { intent: { amount_received: undefined } },
      { raceAfterRead: { status: "cancelled" } }, { raceAfterRead: { stripePaymentIntentId: "pi_rebound" } },
    ]) {
      const current = fixture(options), response = await current.run(kind);
      assert.ok(response.statusCode >= 400, `${kind} must withhold success for ${JSON.stringify(options)}`);
      noFollowups(current.state); cases++;
    }
    const success = fixture(), response = await success.run(kind);
    assert.equal(response.statusCode, 200); assert.equal(success.state.row.status, "confirmed");
    assert.equal(success.state.writes, 1); assert.equal(success.state.fillWrites, 1);
    assert.equal(success.state.earnings, kind === "webhook" ? 1 : 0); cases++;
  }
  const canonical = fixture({ intent: { metadata: { bookingRequestKey: "parking-pass:fixture", passId: "pass-fixture" } } });
  assert.equal((await canonical.run("receipt")).statusCode, 409); noFollowups(canonical.state); cases++;
  const unavailable = fixture({ noStripe: true });
  assert.equal((await unavailable.run("receipt")).statusCode, 503); noFollowups(unavailable.state); cases++;
  const replay = fixture({ row: { status: "confirmed" } });
  assert.equal((await replay.run("webhook")).statusCode, 200); assert.equal(replay.state.writes, 0);
  assert.equal(replay.state.fillWrites, 0); assert.equal(replay.state.earnings, 1); cases++;

  const pageFile = "client/src/pages/parking-pass-content.tsx";
  const effect = find(pageFile, (node) => ts.isCallExpression(node) && node.expression.getText(source(pageFile)) === "useEffect"
    && node.arguments[0]?.getText(source(pageFile)).includes("if (!pendingPassId || isLoading) return;"));
  const navigation = { pass: null, date: null, cleared: 0, warnings: 0 };
  const common = { pendingPassId: "pp:series-fixture:2026-10-09",
    setActiveLocationKey: (value) => { navigation.pass = value; }, setSelectedDate: (value) => { navigation.date = value; },
    getLocationKey: (listing) => listing.id, getListingDateKey: (date) => date,
    setPendingPassId: () => { navigation.cleared++; }, toast: () => { navigation.warnings++; } };
  evaluate(effect.arguments[0].getText(source(pageFile)), { ...common, isLoading: true, passListings: [] })();
  assert.equal(navigation.cleared, 0);
  evaluate(effect.arguments[0].getText(source(pageFile)), { ...common, isLoading: false,
    passListings: [{ id: common.pendingPassId, date: "2026-10-09" }] })();
  assert.equal(navigation.pass, common.pendingPassId); assert.equal(navigation.date, "2026-10-09");
  assert.equal(navigation.cleared, 1); assert.equal(navigation.warnings, 0); cases++;
  evaluate(effect.arguments[0].getText(source(pageFile)), { ...common, isLoading: false, passListings: [] })();
  assert.equal(navigation.warnings, 1); cases++;
  console.log(JSON.stringify({ result: "PASS", cases, scope: "actual source callbacks/effect with in-memory database and signed local fixtures; no native PostgreSQL, app, or browser acceptance" }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
