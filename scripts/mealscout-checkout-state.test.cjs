/** Executes the actual checkout component in a deterministic hook harness.
 * UI primitives, routing, storage and network are fixtures. This is not a React
 * renderer, a browser test, a Stripe transaction or a database-backed E2E test.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const filename = "client/src/pages/pickup-checkout.tsx";
const source = fs.readFileSync(path.join(root, filename), "utf8");
assert.equal(ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true).parseDiagnostics.length, 0);
const compile = (text) => ts.transpileModule(text, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const phoneModule = { exports: {} };
vm.runInNewContext(compile(fs.readFileSync(path.join(root, "shared/orderContact.ts"), "utf8")), {
  module: phoneModule, exports: phoneModule.exports,
});
const compiled = compile(source.replace("import.meta.env.VITE_STRIPE_PUBLIC_KEY", "__stripeKey"));
const item = { restaurantId: "truck-a", menuId: "menu-a", menuItemId: "dish-a", itemName: "Taco", quantity: 2, lineTotalCents: 1200 };
const readyMenu = (overrides = {}) => ({
  menus: [{ id: "menu-a", isActive: true, orderingEnabled: true, pricesIncludeTax: true,
    hidePlatformFee: false, paymentMethods: { card: true }, ...overrides }],
  readiness: { restaurantName: "Fixture Truck", blockingReasons: [] },
});
const saved = () => ({
  version: 1, restaurantId: "truck-a", checkoutRequestId: "same-request", customerAccessToken: "same-access",
  orderId: "order-a", clientSecret: "old-secret-never-trusted", serverTotals: { totalCents: 999 },
  checkoutPayload: { restaurantId: "truck-a", menuId: "menu-a", checkoutRequestId: "same-request",
    customerAccessToken: "same-access", customerName: "Fixture", customerEmail: "fixture@example.test",
    orderType: "pickup", paymentMethod: "card", items: [{ menuItemId: "dish-a", quantity: 2 }] },
});
const paymentResponse = { order: { id: "order-a", status: "pending", subtotalCents: 2000, totalCents: 2100,
  mealscoutFeeCents: 50, processingFeeCents: 50, merchantNameSnapshot: "Verified Truck" },
  clientSecret: "server-verified-secret", customerAccessToken: "same-access" };
// The fixture cart is 2 x Taco with a 1200-cent line total. The totals
// preview is the server pricing that exact cart (subtotal + card fees);
// the component only requires the response shape, and no scenario asserts
// these specific fee amounts.
const previewTotals = { subtotalCents: 1200, mealscoutFeeCents: 50,
  processingFeeCents: 35, platformFeeCents: 0, totalCents: 1285, feePaidByBusiness: false };
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...nodes(tree.props?.children)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join(" ");
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  return tree && typeof tree === "object" ? text(tree.props?.children) : "";
}
function harness({ cart = [item], recovery = null, stripe = true, hostile = false } = {}) {
  const slots = [], effects = [], requests = [], writes = [], routes = [], session = new Map();
  let index = 0, tree, dirty = false, restaurantId = "truck-a", id = 0, reloads = 0, recoveryClears = 0;
  const store = new Map([["mealscout_cart", JSON.stringify(cart)]]);
  const storage = (map) => ({ getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: (key) => map.delete(key) });
  const hooks = {
    useState(initial) {
      const n = index++;
      if (!(n in slots)) slots[n] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[n].value, (next) => { slots[n].value = typeof next === "function" ? next(slots[n].value) : next; dirty = true; }];
    },
    useRef(initial) { const n = index++; if (!(n in slots)) slots[n] = { current: initial }; return slots[n]; },
    useEffect(fn, deps) {
      const n = index++, old = slots[n];
      if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        slots[n] = { deps, fn, cleanup: old?.cleanup };
        effects.push(() => { slots[n].cleanup?.(); slots[n].cleanup = fn(); });
      }
    },
  };
  const jsx = (type, props, key) => ({ type, props: props || {}, key });
  const navigate = (destination) => routes.push(destination);
  const imports = {
    react: hooks, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    wouter: { Link: "Link", useParams: () => ({ restaurantId }), useLocation: () => ["/checkout/" + restaurantId, navigate] },
    "@stripe/stripe-js": { loadStripe: () => ({ fixture: true }) },
    "@stripe/react-stripe-js": { Elements: "Elements", PaymentElement: "PaymentElement", useStripe: () => null, useElements: () => null },
    "@/components/public-ordering/PublicOrderingTopBar": { PublicOrderingTopBar: "PublicOrderingTopBar" },
    "@shared/orderContact": phoneModule.exports,
    "@/components/payment-browser-gate": { default: "PaymentBrowserGate" },
    "@/lib/inAppBrowser": { isPaymentHostileBrowser: () => hostile },
    "@/lib/pickupCheckoutTruth": { toAuthoritativePaymentOrder: (order) => order },
    "@/lib/pickupCheckoutRecovery": {
      readPickupCheckoutRecovery: () => recovery,
      writePickupCheckoutRecovery: (record) => writes.push(JSON.parse(JSON.stringify(record))),
      clearPickupCheckoutRecovery: () => { recoveryClears++; },
    },
  };
  for (const [file, names] of Object.entries({ button: ["Button"], input: ["Input"], label: ["Label"],
    card: ["Card", "CardContent", "CardHeader", "CardTitle"], "radio-group": ["RadioGroup", "RadioGroupItem"] })) {
    imports[`@/components/ui/${file}`] = Object.fromEntries(names.map((name) => [name, name]));
  }
  imports["lucide-react"] = Object.fromEntries(["Loader2", "ShoppingCart", "AlertCircle", "CreditCard", "ArrowLeft", "MapPin"].map((name) => [name, name]));
  const mod = { exports: {} };
  const window = { localStorage: storage(store), sessionStorage: storage(session), location: {
    origin: "https://fixture.test", href: "https://fixture.test/checkout/truck-a", reload: () => { reloads++; },
  } };
  vm.runInNewContext(compiled, {
    module: mod, exports: mod.exports, __stripeKey: stripe ? "pk_test_fixture" : "",
    require: (name) => { assert.ok(name in imports, `Unstubbed import ${name}`); return imports[name]; },
    window, localStorage: window.localStorage,
    crypto: { randomUUID: () => `new-request-${++id}`, getRandomValues: (array) => array.fill(7) },
    fetch: (url, options = {}) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    console, setTimeout, clearTimeout,
  });
  let renderKey;
  function render() {
    index = 0; dirty = false; tree = mod.exports.default();
    // Follow the keyed session wrapper without discarding any old assertions.
    if (typeof tree?.type === "function") {
      if (renderKey !== tree.key) {
        slots.forEach((slot) => slot?.cleanup?.());
        slots.length = 0; effects.length = 0; index = 0; renderKey = tree.key;
      }
      tree = tree.type(tree.props);
    }
    return tree;
  }
  async function reconnectEffects() {
    const current = slots.filter((slot) => slot?.fn);
    current.forEach((slot) => slot.cleanup?.());
    current.forEach((slot) => { slot.cleanup = slot.fn(); });
    await flush();
  }
  async function flush() {
    for (let iteration = 0; iteration < 25; iteration++) {
      if (dirty) render();
      while (effects.length) effects.shift()();
      await Promise.resolve();
    }
    if (dirty) render();
  }
  function find(predicate) { const found = nodes(tree).find(predicate); assert.ok(found, "Expected element not found"); return found; }
  function button(label) { return find((n) => n.type === "Button" && text(n).includes(label)); }
  function input(id) { return find((n) => n.props.id === id); }
  async function fill(id, value) { input(id).props.onChange({ target: { value } }); await flush(); }
  async function respond(request, body, status = 200) { request.resolve({ ok: status < 400, status, json: async () => body }); await flush(); }
  render();
  return { render, flush, reconnectEffects, find, button, input, fill, respond, requests, writes, routes, session, store,
    text: () => text(tree), nodes: () => nodes(tree),
    navigateRestaurant: async (next) => { restaurantId = next; render(); await flush(); },
    reloads: () => reloads, recoveryClears: () => recoveryClears,
  };
}
async function run() {
  let count = 0;
  async function test(name, check) { await check(); count++; console.log(`PASS checkout: ${name}`); }
  async function makeReady(h) {
    await h.flush(); await h.respond(h.requests[0], readyMenu());
    await h.fill("customer-name", "Fixture"); await h.fill("customer-email", "fixture@example.test");
    h.find((n) => n.type === "RadioGroup" && typeof n.props.onValueChange === "function").props.onValueChange("pickup");
    await h.flush();
    // Readiness alone no longer enables Continue: the component prices the
    // cart through POST /api/pickup-orders/totals-preview and keeps Continue
    // disabled until the preview lands. The component fires that request
    // itself; completing the flow means answering it, as the real UI does.
    const preview = h.requests.find((r) => r.options.method === "POST" && r.url === "/api/pickup-orders/totals-preview");
    assert.ok(preview, "Expected the component to request a totals preview once readiness resolves");
    await h.respond(preview, previewTotals);
  }
  await test("first render keeps the cart and distinguishes pending availability", async () => {
    const h = harness();
    assert.match(h.text(), /Checking menu and payment availability/);
    assert.doesNotMatch(h.text(), /Your cart is empty|Online ordering is not available/);
    assert.ok(h.button("Continue to secure payment").props.disabled);
    await h.flush(); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].options.method, undefined);
  });
  await test("verified readiness plus valid contact/pickup enables continue", async () => {
    const h = harness(); await makeReady(h); assert.equal(h.button("Continue to secure payment").props.disabled, false);
  });
  await test("failed lookup retries without losing contact, cart or request identity", async () => {
    const h = harness(); await h.flush(); await h.fill("customer-name", "Keep me");
    const before = h.writes.at(-1).checkoutRequestId;
    h.requests[0].reject(new Error("offline")); await h.flush();
    assert.match(h.text(), /Payment availability could not be verified/);
    assert.doesNotMatch(h.text(), /Online ordering is not available/);
    h.button("Retry availability").props.onClick(); await h.flush();
    assert.equal(h.input("customer-name").props.value, "Keep me");
    assert.ok(h.button("Continue to secure payment").props.disabled);
    await h.respond(h.requests[1], readyMenu());
    assert.equal(h.writes.at(-1).checkoutRequestId, before);
    // The totals preview is a pricing POST fired once readiness resolves,
    // not an order; only an order-creation POST would fail this scenario.
    assert.equal(h.requests.filter((r) => r.options.method === "POST" && r.url === "/api/pickup-orders").length, 0);
    assert.equal(JSON.parse(h.store.get("mealscout_cart"))[0].menuItemId, "dish-a");
  });
  await test("known unavailable menu is not conflated with a network error", async () => {
    const h = harness(); await h.flush(); await h.respond(h.requests[0], readyMenu({ orderingEnabled: false }));
    assert.match(h.text(), /Online ordering is not available/); assert.doesNotMatch(h.text(), /Retry availability/);
  });
  await test("old restaurant response cannot enable the new restaurant", async () => {
    const h = harness(); await h.flush(); const old = h.requests[0];
    await h.navigateRestaurant("truck-b");
    await h.respond(old, readyMenu());
    assert.ok(!h.nodes().some((n) => n.type === "Button" && n.props.disabled === false));
    await h.respond(h.requests[1], readyMenu()); assert.match(h.text(), /Your cart is empty/);
  });
  await test("mixed-menu new carts remain blocked", async () => {
    const h = harness({ cart: [item, { ...item, menuId: "menu-b" }] });
    assert.match(h.text(), /Choose one menu per order/); await h.flush();
    assert.equal(h.requests.filter((r) => r.options.method === "POST").length, 0);
  });
  for (const cart of [[], null, {}, [null]]) {
    await test(`safe empty/corrupt cart ${JSON.stringify(cart)}`, async () => {
      const h = harness({ cart }); assert.match(h.text(), /Your cart is empty/); await h.flush();
    });
  }
  await test("saved checkout with an empty cart replays the exact existing request", async () => {
    const recovery = saved(), h = harness({ cart: [], recovery });
    assert.match(h.text(), /Checking your saved checkout/); assert.doesNotMatch(h.text(), /Your cart is empty/);
    await h.flush(); const request = h.requests.find((r) => r.options.method === "POST");
    assert.deepEqual(JSON.parse(request.options.body), recovery.checkoutPayload);
    assert.ok(!h.nodes().some((n) => n.type === "Elements"), "Never trust the stored client secret");
    await h.respond(request, paymentResponse);
    assert.equal(h.find((n) => n.type === "Elements").props.options.clientSecret, "server-verified-secret");
    assert.match(h.text(), /\$21\.00/); assert.doesNotMatch(h.text(), /Your cart is empty/);
  });
  await test("saved request, not a changed mixed cart, controls restored payment", async () => {
    const recovery = saved(), h = harness({ cart: [item, { ...item, menuId: "changed" }], recovery });
    await h.flush(); const request = h.requests.find((r) => r.options.method === "POST");
    assert.deepEqual(JSON.parse(request.options.body), recovery.checkoutPayload);
    await h.respond(request, paymentResponse); assert.doesNotMatch(h.text(), /Choose one menu per order/);
    assert.match(h.text(), /\$21\.00/);
  });
  await test("failed restore exposes recovery and status without clearing the durable request", async () => {
    const h = harness({ cart: [], recovery: saved() }); await h.flush();
    h.requests.find((r) => r.options.method === "POST").reject(new Error("network interrupted")); await h.flush();
    assert.match(h.text(), /Your checkout needs attention|network interrupted/);
    assert.doesNotMatch(h.text(), /Your cart is empty/); assert.equal(h.recoveryClears(), 0);
    h.button("Retry saved checkout").props.onClick(); assert.equal(h.reloads(), 1);
    h.button("Check order status").props.onClick();
    assert.equal(h.session.get("mealscout:order-access:order-a"), "same-access");
    assert.deepEqual(h.routes, ["/order-confirmation/order-a"]);
  });
  await test("expired recovery still invokes the existing reset policy", async () => {
    const h = harness({ cart: [], recovery: saved() }); await h.flush();
    await h.respond(h.requests.find((r) => r.options.method === "POST"), { code: "CHECKOUT_EXPIRED", message: "Expired" }, 409);
    assert.equal(h.recoveryClears(), 1); assert.match(h.text(), /Your cart is empty/);
  });
  await test("processing recovery navigates to order status with its original access token", async () => {
    const h = harness({ cart: [], recovery: saved() }); await h.flush();
    await h.respond(h.requests.find((r) => r.options.method === "POST"), { code: "PAYMENT_PROCESSING" }, 409);
    assert.deepEqual(h.routes, ["/order-confirmation/order-a"]);
    assert.equal(h.session.get("mealscout:order-access:order-a"), "same-access");
  });
  await test("missing Stripe configuration gives a visible reason", async () => {
    const h = harness({ stripe: false }); await h.flush(); await h.respond(h.requests[0], readyMenu());
    assert.match(h.text(), /Secure card payment is unavailable/); assert.ok(h.button("Continue to secure payment").props.disabled);
  });
  await test("in-app browser gate is visible before disabled checkout", async () => {
    const h = harness({ hostile: true }); await h.flush(); await h.respond(h.requests[0], readyMenu());
    assert.ok(h.nodes().some((n) => n.type === "PaymentBrowserGate"));
    assert.ok(h.button("Continue to secure payment").props.disabled);
  });
  await test("name/phone feedback uses associated fields and existing phone normalization", async () => {
    const h = harness(); await h.flush();
    h.input("customer-name").props.onBlur(); await h.flush();
    assert.equal(h.input("customer-name").props["aria-describedby"], "customer-name-error");
    await h.fill("customer-phone", "12"); h.input("customer-phone").props.onBlur(); await h.flush();
    assert.equal(h.input("customer-phone").props["aria-invalid"], true);
    await h.fill("customer-phone", "(985) 555-0100");
    assert.equal(h.input("customer-phone").props["aria-invalid"], undefined);
  });
  await test("missing contact channel has an accessible inline explanation", async () => {
    const h = harness(); h.input("customer-email").props.onBlur(); await h.flush();
    assert.equal(h.input("customer-email").props["aria-describedby"], "customer-contact-error");
    assert.match(h.text(), /Add an email address or phone number/);
  });
  await test("same-tick repeated submit creates one request with unchanged payload shape", async () => {
    const h = harness(); await makeReady(h); const onClick = h.button("Continue to secure payment").props.onClick;
    const first = onClick(), second = onClick(); await h.flush();
    const posts = h.requests.filter((r) => r.options.method === "POST" && r.url === "/api/pickup-orders"); assert.equal(posts.length, 1);
    const payload = JSON.parse(posts[0].options.body);
    assert.equal(payload.customerName, "Fixture"); assert.equal(payload.menuId, "menu-a");
    assert.equal(payload.paymentMethod, "card"); assert.equal(payload.orderType, "pickup");
    assert.equal(payload.checkoutRequestId, h.writes.at(-1).checkoutRequestId);
    assert.ok(h.button("Continue to secure payment").props.disabled);
    await h.respond(posts[0], paymentResponse); await Promise.all([first, second]);
    assert.match(h.text(), /\$21\.00/);
  });
  await test("invoking continue before readiness cannot create an order", async () => {
    const h = harness(); await h.button("Continue to secure payment").props.onClick(); await h.flush();
    assert.equal(h.requests.filter((r) => r.options.method === "POST").length, 0);
  });
  await test("effect cleanup/setup reattaches saved recovery without a second POST", async () => {
    const h = harness({ cart: [], recovery: saved() }); await h.flush();
    const request = h.requests.find((r) => r.options.method === "POST");
    await h.reconnectEffects();
    assert.equal(h.requests.filter((r) => r.options.method === "POST").length, 1);
    await h.respond(request, paymentResponse);
    assert.equal(h.find((n) => n.type === "Elements").props.options.clientSecret, "server-verified-secret");
  });
  console.log(`PASS: ${count} checkout state scenarios (stubbed hook/UI/network harness; no real transactions).`);
}
module.exports = run;
if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
