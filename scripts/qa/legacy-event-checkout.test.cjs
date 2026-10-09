// Focused in-memory regression for the actual changed route callbacks/effect.
// No app startup, listener, database, browser, provider API, or environment file.
// Run with normal Node defaults; --legacy-only excludes already-proved binding cases.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const Stripe = require("stripe");

const root = path.resolve(__dirname, "../..");
const sources = new Map();
const beforeSources = new Map();
const bindingOnly = process.argv.includes("--payment-binding-only");
const legacyOnly = process.argv.includes("--legacy-only");
const compareBefore = process.argv.includes("--compare-before");
assert.ok(!(legacyOnly && (bindingOnly || compareBefore)), "Choose one focused fixture mode");
const beforeRevision = process.argv.find((argument) => argument.startsWith("--before-revision="))?.split("=")[1];
const helperModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,
  "server/services/legacyParkingPaymentBinding.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText, { module: helperModule, exports: helperModule.exports }, { timeout: 1000 });
const { isLegacyParkingPaymentBound } = helperModule.exports;
if (compareBefore) {
  assert.match(beforeRevision ?? "", /^[a-f0-9]{40}$/, "Provide the exact pre-repair --before-revision for comparison");
  const { execFileSync } = require("node:child_process");
  for (const file of ["server/routes/eventRoutes.ts", "server/routes/stripeWebhookRoutes.ts"]) {
    beforeSources.set(file, execFileSync("git", ["-c", `safe.directory=${root}`, "show", `${beforeRevision}:${file}`], { cwd: root, encoding: "utf8" }));
  }
}
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
  if (condition.isNull) return row[condition.field.field] === null;
  return row[condition.field.field] === condition.value;
}
function fixture(options = {}) {
  const row = { id: "booking-fixture", eventId: "event-fixture", truckId: "truck-fixture", hostId: "host-fixture",
    status: "pending", stripePaymentIntentId: "pi_fixture", totalCents: 2500, hostPriceCents: 1500,
    platformFeeCents: 1000, stripeApplicationFeeAmount: null, stripeTransferDestination: null, ...options.row };
  const intent = { id: "pi_fixture", status: "succeeded", currency: "usd", amount: 2500, amount_received: 2500,
    metadata: { bookingId: row.id, eventId: row.eventId, truckId: row.truckId, hostId: row.hostId }, ...options.intent };
  const requestedIntentId = row.stripePaymentIntentId;
  const state = { row, intent, writes: 0, fillWrites: 0, earnings: 0, notifications: 0, reads: 0, retrievedAccounts: [] };
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
    paymentIntents: { retrieve: async (id, requestOptions) => {
      assert.equal(id, requestedIntentId);
      const account = requestOptions?.stripeAccount ?? null;
      state.retrievedAccounts.push(account);
      if ((!account && options.platformRetrieveFails) || (account && options.connectedRetrieveFails)) {
        throw new Error("local fixture retrieval unavailable");
      }
      return { ...state.intent };
    } },
    webhooks: { constructEvent: verifier.webhooks.constructEvent.bind(verifier.webhooks) },
  };
  const bindings = { ...schema, db, stripe, eq, and, isNull: (field) => ({ field, isNull: true }),
    isLegacyParkingPaymentBound, sql: () => ({}),
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
      const payload = JSON.stringify({ id: "evt_fixture", type: "payment_intent.succeeded",
        account: options.eventAccount, data: { object: state.intent } });
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
  if (!legacyOnly) {
  const destination = { row: { stripeTransferDestination: "acct_host", stripeApplicationFeeAmount: 1000 },
    intent: { application_fee_amount: 1000, transfer_data: { destination: "acct_host" } } };
  const held = { row: {}, intent: {} };
  const rejectedBindings = [
    { name: "provider fee mismatch", row: destination.row, intent: { ...destination.intent, application_fee_amount: 500 } },
    { name: "provider destination mismatch", row: destination.row, intent: { ...destination.intent, transfer_data: { destination: "acct_foreign" } } },
    { name: "stored fee contradicts booking split", row: { ...destination.row, stripeApplicationFeeAmount: 500 },
      intent: { ...destination.intent, application_fee_amount: 500 } },
    { name: "stored split mismatch", row: { hostPriceCents: 1501 } },
    { name: "negative host price", row: { hostPriceCents: -1, platformFeeCents: 2501 } },
    { name: "fractional fee", row: { hostPriceCents: 1499.5, platformFeeCents: 1000.5 } },
    { name: "missing stored fee", row: { stripeApplicationFeeAmount: undefined } },
    { name: "missing stored destination", row: { stripeTransferDestination: undefined } },
    { name: "unexpected fee on held charge", intent: { application_fee_amount: 1000 } },
    { name: "unexpected destination on held charge", intent: { transfer_data: { destination: "acct_foreign" } } },
    { name: "explicit partial transfer", row: destination.row,
      intent: { ...destination.intent, transfer_data: { destination: "acct_host", amount: 1500 } } },
    { name: "metadata cannot authorize direct scope", row: destination.row, intent: { application_fee_amount: 1000 } },
  ];
  const rejectedRaces = [
    { platformFeeCents: 900 }, { hostPriceCents: 1400 }, { totalCents: 2400 },
    { stripeApplicationFeeAmount: 500 }, { stripeTransferDestination: "acct_foreign" },
    { eventId: "event_foreign" }, { truckId: "truck_foreign" }, { hostId: "host_foreign" },
  ].map((raceAfterRead) => ({ name: `binding changed after read: ${Object.keys(raceAfterRead)[0]}`, raceAfterRead }));
  const rejects = [...rejectedBindings, ...rejectedRaces];
  for (const kind of ["receipt", "webhook"]) {
    const kindRejects = [...rejects];
    if (kind === "webhook") kindRejects.push(
      { name: "foreign signed account", ...destination, eventAccount: "acct_foreign" },
      { name: "connected scope cannot authorize destination transfer", ...destination, eventAccount: "acct_host" },
      { name: "connected scope cannot authorize platform-held charge", ...held, eventAccount: "acct_foreign" },
      { name: "confirmed retry rejects wrong fee before earnings", row: { ...destination.row, status: "confirmed" },
        intent: { ...destination.intent, application_fee_amount: 500 } },
    );
    for (const options of kindRejects) {
      const current = fixture(options), response = await current.run(kind);
      assert.ok(response.statusCode >= 400, `${kind} must withhold success: ${options.name}`);
      noFollowups(current.state); cases++;
    }
    const direct = { row: destination.row, intent: { application_fee_amount: 1000 },
      platformRetrieveFails: true, eventAccount: "acct_host" };
    for (const options of [held, destination, { ...destination,
      intent: { ...destination.intent, transfer_data: { destination: { id: "acct_host" } } } }, direct,
      { row: { ...destination.row, hostPriceCents: 2500, platformFeeCents: 0, stripeApplicationFeeAmount: 0 },
        intent: { ...destination.intent, application_fee_amount: 0 } },
      { row: { ...destination.row, hostPriceCents: 0, platformFeeCents: 2500, stripeApplicationFeeAmount: 2500 },
        intent: { ...destination.intent, application_fee_amount: 2500 } }]) {
      const current = fixture(options), response = await current.run(kind);
      assert.equal(response.statusCode, 200); assert.equal(current.state.row.status, "confirmed");
      assert.equal(current.state.writes, 1); assert.equal(current.state.fillWrites, 1);
      assert.equal(current.state.earnings, kind === "webhook" && current.state.row.hostPriceCents > 0 ? 1 : 0);
      if (options === direct && kind === "receipt") assert.deepEqual(current.state.retrievedAccounts, [null, "acct_host"]);
      cases++;
    }
  }
  let beforeAccepted = 0;
  if (compareBefore) {
    for (const [file, text] of beforeSources) sources.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
    for (const kind of ["receipt", "webhook"]) {
      for (const options of rejects) {
        const previous = fixture(options), response = await previous.run(kind);
        assert.equal(response.statusCode, 200, `${kind} baseline should expose defect: ${options.name}`);
        assert.equal(previous.state.writes, 1); beforeAccepted++;
      }
    }
    for (const file of beforeSources.keys()) sources.delete(file);
  }
  if (bindingOnly) {
    console.log(JSON.stringify({ result: "PASS", cases, beforeAccepted, beforeRevision,
      scope: "changed legacy payment callbacks with in-memory database and signed local fixtures; no provider or PostgreSQL acceptance" }));
    return;
  }
  }
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
      if (kind === "receipt") {
        assert.equal(response.statusCode, ["cancelled", "refunded"].includes(options.row?.status) ? 400 : 409,
          "The booking guard must reject the input, rather than a fixture retrieval exception");
      }
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
