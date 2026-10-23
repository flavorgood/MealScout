import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { getScopedBusinessPermissions, isScopedBusinessOwner } from "../client/src/lib/business-access";
import ts from "typescript";
import { DEFAULT_TRUCK_BROADCAST_FRESHNESS_MS, deriveTruckPresence } from "../shared/consumerEntity";

// Execute the current page's actual closure, substituting only browser/network boundaries.
const source = readFileSync(new URL("../client/src/pages/parking-pass-content.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("parking-pass-content.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findNode(predicate: (node: ts.Node) => boolean) {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, visit); };
  visit(ast);
  return found;
}
function executeHandler(name: string, context: Record<string, any>) {
  const declaration = findNode((node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === name) as ts.VariableDeclaration | undefined;
  assert.ok(declaration?.initializer, `${name} must be the actual page handler`);
  const js = ts.transpileModule(`globalThis.handler = ${declaration.initializer.getText(ast)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  vm.runInNewContext(js, context);
  return context.handler();
}
function harness(options: { live?: boolean; gpsError?: number | "unavailable"; failure?: "stop" | "location" | "network"; malformed?: boolean; denied?: boolean } = {}) {
  const state = { live: Boolean(options.live), busy: false, manual: false, error: "", truck: null as any, requests: [] as any[], toasts: [] as any[], schedules: [] as any[], formCleared: false };
  const position = { coords: { latitude: 30.4213, longitude: -87.2169, accuracy: 12 }, timestamp: Date.now() };
  const context: Record<string, any> = {
    Promise, Date, Number, Math, Error, console,
    canManageTruckProfile: !options.denied, hasProfileTruckTools: true, canManageTruckSchedule: true, truckId: "synthetic-truck", truck: { id: "synthetic-truck", name: "Synthetic truck" },
    isLive: state.live, liveLeaveTime: "23:59", sharingLocationInFlight: { current: false },
    setIsSharingLocation: (value: boolean) => { state.busy = value; },
    setIsLive: (value: boolean) => { state.live = value; },
    setLocationError: (value: string) => { state.error = value; },
    setManualLocationFallback: (value: boolean) => { state.manual = value; },
    setTruck: (value: any) => { state.truck = typeof value === "function" ? value(context.truck) : value; },
    toast: (value: any) => { state.toasts.push(value); }, apiUrl: (path: string) => path,
    buildTruckShareLink: () => null, maybePromptSocialPost: () => {},
    navigator: options.gpsError === "unavailable" ? {} : { geolocation: { getCurrentPosition: (resolve: any, reject: any) => options.gpsError ? reject({ code: options.gpsError, message: "Synthetic location error" }) : resolve(position) } },
    deriveTruckPresence, DEFAULT_TRUCK_BROADCAST_FRESHNESS_MS,
    fetch: async (url: string, init: any = {}) => {
      const payload = init.body ? JSON.parse(init.body) : undefined;
      state.requests.push({ url, method: init.method || "GET", payload });
      if (url.includes("live-share-card")) return { ok: false };
      if (options.failure === "network") throw new Error("Synthetic network failure");
      const stopping = payload?.mobileOnline === false;
      const failed = stopping ? options.failure === "stop" : options.failure === "location" && init.method === "POST";
      const restaurant = { id: "synthetic-truck", mobileOnline: !stopping, currentLatitude: position.coords.latitude, currentLongitude: position.coords.longitude, lastBroadcastAt: new Date().toISOString(), liveUntilAt: new Date(Date.now() + 3600000).toISOString() };
      return { ok: !failed, status: failed ? 403 : 200, json: async () => failed ? { message: "Synthetic denied save" } : options.malformed ? {} : { success: true, restaurant, location: { id: "synthetic-location", restaurantId: "synthetic-truck", ...position.coords, source: "gps", recordedAt: new Date().toISOString() } } };
    },
  };
  return { state, context, run: () => executeHandler("handleShareLocation", context) };
}

test("rejected offline save retains live state and offers retry, never success", async () => {
  const h = harness({ live: true, failure: "stop" }); await h.run();
  assert.equal(h.state.live, true);
  assert.equal(h.state.busy, false);
  assert.equal(h.state.toasts.some((value) => value.title === "You are offline"), false);
  assert.match(h.state.toasts.at(-1).description, /Synthetic denied save/);
});
test("successful offline save verifies the persisted receipt before becoming offline", async () => {
  const h = harness({ live: true }); await h.run();
  assert.equal(h.state.live, false);
  assert.equal(h.state.requests.length, 1);
  assert.equal(h.state.truck?.mobileOnline, false);
});
test("Go live uses the sole location write with GPS provenance, no premature online PATCH", async () => {
  const h = harness(); await h.run();
  const writes = h.state.requests.filter((request) => request.method !== "GET");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "POST");
  assert.equal(writes[0].payload.source, "gps");
  assert.equal(writes[0].payload.accuracy, 12);
  assert.equal(h.state.live, true);
  assert.equal(h.state.truck?.mobileOnline, true);
});
test("failed location save never claims live and retry can complete", async () => {
  const h = harness({ failure: "location" }); await h.run();
  assert.equal(h.state.live, false);
  assert.equal(h.state.toasts.some((value) => value.title === "Live location shared"), false);
  assert.equal(h.state.requests.some((request) => request.payload?.mobileOnline === true), false);
  const retry = harness(); await retry.run(); assert.equal(retry.state.live, true);
});
test("HTTP success with no persisted receipt does not become a success", async () => {
  for (const live of [false, true]) {
    const h = harness({ live, malformed: true }); await h.run();
    assert.equal(h.state.live, live);
    assert.equal(h.state.toasts.some((value) => value.title === "Live location shared" || value.title === "You are offline"), false);
  }
});
for (const gpsError of [1, 2, 3, "unavailable"] as const) {
  test(`GPS failure ${gpsError} offers manual stop without publishing or losing state`, async () => {
    const h = harness({ gpsError }); await h.run();
    assert.equal(h.state.requests.length, 0);
    assert.equal(h.state.manual, true);
    assert.equal(h.state.live, false);
    assert.equal(h.state.busy, false);
  });
}
test("network uncertainty preserves state and offers manual/retry, no success toast", async () => {
  const h = harness({ failure: "network" }); await h.run();
  assert.equal(h.state.live, false); assert.equal(h.state.manual, true);
  assert.equal(h.state.toasts.some((value) => value.title === "Live location shared"), false);
});
test("profile-denied actor cannot request location or publish coordinates", async () => {
  const h = harness({ denied: true }); await h.run();
  assert.equal(h.state.requests.length, 0); assert.equal(h.state.live, false);
});
test("repeated click while a request is pending does not duplicate the write", async () => {
  const h = harness();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const fetch = h.context.fetch;
  h.context.fetch = async (...args: any[]) => { await held; return fetch(...args); };
  const first = h.run(); const second = h.run(); release(); await Promise.all([first, second]);
  assert.equal(h.state.requests.filter((request) => request.method === "POST").length, 1);
});
test("reload hydrates live/offline/stale state through the shared presence policy", () => {
  const effect = findNode((node) => ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes("deriveTruckPresence")) as ts.CallExpression | undefined;
  assert.ok(effect, "the page must hydrate live state from the selected owned truck");
  const fresh = { mobileOnline: true, currentLatitude: 30.42, currentLongitude: -87.21, lastBroadcastAt: new Date().toISOString(), liveUntilAt: new Date(Date.now() + 600000).toISOString() };
  for (const [truck, expected] of [[fresh, true], [{ ...fresh, mobileOnline: false }, false], [{ ...fresh, liveUntilAt: new Date(Date.now() - 60000).toISOString() }, false], [null, false]] as const) {
    let actual = !expected;
    const js = ts.transpileModule(`(${effect.arguments[0].getText(ast)})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    vm.runInNewContext(js, { truck, Date, Number, Math, deriveTruckPresence, DEFAULT_TRUCK_BROADCAST_FRESHNESS_MS, setIsLive: (value: boolean) => { actual = value; }, window: { setTimeout: () => 1, clearTimeout: () => {} } });
    assert.equal(actual, expected);
  }
});

test("unknown or invalid accuracy cannot be published as a GPS location", async () => {
  for (const accuracy of [undefined, null, NaN, -1, 10001]) {
    const h = harness();
    h.context.navigator.geolocation.getCurrentPosition = (resolve: any) => resolve({ coords: { latitude: 30.42, longitude: -87.21, accuracy } });
    await h.run();
    assert.equal(h.state.requests.length, 0);
    assert.equal(h.state.live, false); assert.equal(h.state.manual, true);
  }
});
test("manual stop keeps all entered data on rejected save, then requires explicit successful retry", async () => {
  const original = { date: "2026-10-21", startTime: "11:00", endTime: "14:00", locationName: "Synthetic plaza", address: "1 Synthetic Plaza", city: "Pensacola", state: "FL", notes: "Synthetic only", isPublic: false };
  let form = { ...original };
  let saved: any[] = [];
  const requests: any[] = [];
  const toasts: any[] = [];
  let fail = true;
  const context = {
    hasProfileTruckTools: true, canManageTruckSchedule: true, canManageParkingPass: true, truckId: "synthetic-truck",
    scheduleForm: form, setIsSavingSchedule: () => {},
    setScheduleForm: (update: any) => { form = update(form); },
    setManualSchedules: (update: any) => { saved = update(saved); },
    toast: (value: any) => { toasts.push(value); }, apiUrl: (path: string) => path,
    buildTruckShareLink: () => null, maybePromptSocialPost: () => {},
    format: () => "Synthetic date", truck: { name: "Synthetic truck" },
    fetch: async (url: string, init: any) => {
      requests.push({ url, payload: JSON.parse(init.body) });
      return { ok: !fail, json: async () => fail ? { message: "Synthetic schedule save denied" } : { id: "synthetic-stop", ...original, truckId: "synthetic-truck", status: "confirmed", date: "2026-10-21T00:00:00.000Z" } };
    },
  };
  await executeHandler("handleCreateSchedule", context);
  assert.deepEqual(form, original);
  assert.equal(saved.length, 0);
  assert.equal(toasts.some((value) => value.title === "Schedule saved"), false);
  fail = false;
  await executeHandler("handleCreateSchedule", context);
  assert.equal(saved.length, 1);
  assert.equal(form.address, "");
  assert.equal(toasts.at(-1).title, "Schedule saved");
  assert.equal(requests.every((request) => request.url.endsWith("/manual-schedule") && request.payload.isPublic === false && request.payload.mobileOnline === undefined), true);
});


test("malformed or mismatched manual receipts retain the draft and prior schedule without publishing", async () => {
  const original = { date: "2026-10-21", startTime: "11:00", endTime: "14:00", locationName: "Synthetic plaza", address: "1 Synthetic Plaza", city: "Pensacola", state: "FL", notes: "Synthetic only", isPublic: false };
  const valid = { id: "synthetic-stop", ...original, truckId: "synthetic-truck", status: "confirmed", date: "2026-10-21T00:00:00.000Z" };
  for (const receipt of [{}, null, { ...valid, id: "" }, { ...valid, truckId: "foreign-truck" }, { ...valid, date: "2026-10-22T00:00:00.000Z" }, { ...valid, endTime: "15:00" }, { ...valid, address: "Different address" }, { ...valid, isPublic: true }, { ...valid, status: "open" }]) {
    let form = { ...original };
    let rows: any[] = [{ id: "prior-stop" }];
    const toasts: any[] = [];
    let shared = false;
    const context = {
      hasProfileTruckTools: true, canManageTruckSchedule: true, canManageParkingPass: true, truckId: "synthetic-truck", scheduleForm: original,
      setIsSavingSchedule: () => {}, setScheduleForm: (update: any) => { form = update(form); }, setManualSchedules: (update: any) => { rows = update(rows); },
      toast: (value: any) => { toasts.push(value); }, apiUrl: (path: string) => path,
      buildTruckShareLink: () => "https://synthetic.invalid", maybePromptSocialPost: () => { shared = true; },
      fetch: async () => ({ ok: true, json: async () => receipt }),
    };
    await executeHandler("handleCreateSchedule", context);
    assert.deepEqual(form, original);
    assert.deepEqual(rows, [{ id: "prior-stop" }]);
    assert.equal(toasts.some((value) => value.title === "Schedule saved"), false);
    assert.equal(shared, false);
  }
});


test("actual selected-truck permission derivation denies B when profile access belongs only to A", async () => {
  const no = { manageDeals: false, manageParkingPass: false, viewAnalytics: false, manageProfile: false };
  const access = {
    hasAnyAccess: true,
    permissions: { ...no, manageProfile: true, manageParkingPass: true },
    restaurants: [
      { id: "truck-A", isOwner: false, permissions: { ...no, manageProfile: true } },
      { id: "synthetic-truck", isOwner: false, permissions: { ...no, manageParkingPass: true } },
    ],
  };
  const declaration = findNode((node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === "canManageTruckProfile") as ts.VariableDeclaration;
  assert.ok(declaration?.initializer);
  const derive = (businessAccess: typeof access, truckId: string, userType = "customer", isAdminOrStaff = false) => {
    const context: any = { businessAccess, truckId, user: { userType }, isAdminOrStaff,
      scopedTruckPermissions: getScopedBusinessPermissions(businessAccess, truckId),
      ownsSelectedTruck: isScopedBusinessOwner(businessAccess, truckId) };
    vm.runInNewContext(ts.transpileModule(`globalThis.allowed = ${declaration.initializer!.getText(ast)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return context.allowed;
  };
  for (const userType of ["customer", "food_truck"]) {
    const h = harness();
    h.context.canManageTruckProfile = derive(access, "synthetic-truck", userType);
    let gpsCalled = false;
    h.context.navigator.geolocation.getCurrentPosition = (resolve: any) => { gpsCalled = true; resolve({ coords: { latitude: 30.42, longitude: -87.21, accuracy: 12 }, timestamp: Date.now() }); };
    await h.run();
    assert.equal(h.context.canManageTruckProfile, false);
    assert.equal(gpsCalled, false);
    assert.equal(h.state.requests.length, 0);
    assert.equal(h.state.toasts.at(-1).title, "Profile access required");
  }
  assert.equal(derive(access, "truck-A"), true);
  const grantedB = { ...access, restaurants: [access.restaurants[0], { ...access.restaurants[1], permissions: { ...no, manageProfile: true } }] };
  const h = harness(); h.context.canManageTruckProfile = derive(grantedB, "synthetic-truck"); await h.run();
  assert.equal(h.state.live, true);
  assert.equal(h.state.requests.filter((request) => request.method === "POST").length, 1);
  assert.equal(derive({ ...access, restaurants: [{ ...access.restaurants[1], isOwner: true }] }, "synthetic-truck"), true);
  assert.equal(derive(access, "synthetic-truck", "admin", true), true);
  assert.equal(derive(access, "missing-truck"), false);
});



test("actual selected manual-stop permission denies inverse A-parking/B-profile scope before saving", async () => {
  const no = { manageDeals: false, manageParkingPass: false, viewAnalytics: false, manageProfile: false };
  const access = { hasAnyAccess: true, permissions: { ...no, manageProfile: true, manageParkingPass: true }, restaurants: [
    { id: "truck-A", isOwner: false, permissions: { ...no, manageParkingPass: true } },
    { id: "truck-B", isOwner: false, permissions: { ...no, manageProfile: true } },
  ] };
  const declaration = findNode((node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === "canManageTruckSchedule") as ts.VariableDeclaration;
  assert.ok(declaration?.initializer);
  const derive = (context: typeof access, truckId: string, isAdminOrStaff = false) => {
    const env: any = { isAdminOrStaff, ownsSelectedTruck: isScopedBusinessOwner(context, truckId), scopedTruckPermissions: getScopedBusinessPermissions(context, truckId) };
    vm.runInNewContext(ts.transpileModule(`globalThis.allowed = ${declaration.initializer!.getText(ast)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, env);
    return env.allowed;
  };
  const form = { date: "2026-10-21", startTime: "11:00", endTime: "14:00", locationName: "Synthetic plaza", address: "1 Synthetic Plaza", city: "Pensacola", state: "FL", notes: "", isPublic: false };
  let current = { ...form }; let rows: any[] = []; const requests: any[] = []; const toasts: any[] = [];
  const context: any = {
    canManageTruckSchedule: derive(access, "truck-B"), truckId: "truck-B", scheduleForm: form,
    setIsSavingSchedule: () => {}, setScheduleForm: (update: any) => { current = update(current); }, setManualSchedules: (update: any) => { rows = update(rows); },
    toast: (value: any) => { toasts.push(value); }, apiUrl: (path: string) => path,
    buildTruckShareLink: () => null, maybePromptSocialPost: () => {}, format: () => "Synthetic date", truck: { name: "Synthetic" },
    fetch: async (url: string, init: any) => { requests.push({ url, method: init.method }); return { ok: true, json: async () => ({ id: "stop-B", ...form, date: "2026-10-21T00:00:00.000Z", truckId: "truck-B", status: "confirmed" }) }; },
  };
  await executeHandler("handleCreateSchedule", context);
  assert.equal(context.canManageTruckSchedule, false);
  assert.equal(requests.length, 0); assert.deepEqual(current, form); assert.equal(rows.length, 0);
  assert.equal(toasts.at(-1).title, "Permission required");
  const granted = { ...access, restaurants: [access.restaurants[0], { ...access.restaurants[1], permissions: { ...no, manageParkingPass: true } }] };
  context.canManageTruckSchedule = derive(granted, "truck-B"); await executeHandler("handleCreateSchedule", context);
  assert.equal(requests.length, 1); assert.equal(rows.length, 1); assert.equal(current.address, "");
  assert.equal(derive(access, "truck-A"), true);
  assert.equal(derive({ ...access, restaurants: [{ ...access.restaurants[1], isOwner: true }] }, "truck-B"), true);
  assert.equal(derive(access, "truck-B", true), true);
});
test("manual form inputs and Add stop button evaluate the selected schedule permission", () => {
  const start = source.indexOf('<div id="parking-pass-manual-stop"');
  const end = source.indexOf("<Dialog", start);
  assert.ok(start > 0 && end > start);
  const expressions: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(ast) === "disabled" && node.getStart(ast) > start && node.getEnd() < end && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) expressions.push(node.initializer.expression);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(expressions.length >= 10);
  for (const canManageTruckSchedule of [false, true]) {
    for (const expression of expressions) {
      const env: any = { canManageTruckSchedule, isSavingSchedule: false };
      vm.runInNewContext(`globalThis.disabled = ${expression.getText(ast)}`, env);
      assert.equal(env.disabled, !canManageTruckSchedule);
    }
  }
});
