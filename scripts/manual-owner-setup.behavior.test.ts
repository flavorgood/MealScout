import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { resolveProgressiveBusinessSetupDestination } from "../shared/progressiveOnboarding";

const read = (file: string) => readFileSync(file, "utf8");
const service = read("server/services/loginContinuation.ts");
const signup = read("client/src/pages/restaurant-signup.tsx");
const shell = read("client/src/components/business-workspace-shell.tsx");
const parse = (source: string) => ts.createSourceFile("proof.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const initializer = (source: string, name: string) => {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === name) found = node.initializer;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(parse(source));
  assert.ok(found, `${name} must retain its actual owning implementation`);
  return found!;
};
const evaluate = (expression: string, bindings: Record<string, unknown>) => {
  const module = { exports: undefined as any };
  const code = ts.transpileModule(`module.exports = (${expression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(code, { module, URL, URLSearchParams, ...bindings }, { timeout: 2000 });
  return module.exports;
};
const completeUser = { userType: "food_truck", firstName: "Fixture", lastName: "Owner", phone: "5550100", email: "owner@example.invalid", emailVerified: true };
const baseRestaurant = { id: "business 1", name: "Isolated truck", city: "Fixture City", phone: "5550100", cuisineType: "Fixture food", logoUrl: "/fixture-logo.png", businessType: "food_truck", isFoodTruck: true, isActive: true, isVerified: true };

// Execute the actual resolver module with only imported DB/query boundaries
// replaced. No application boot, real database, authentication or provider call.
function continuationFixture(options: { restaurant?: object; user?: object; menuCount?: number; scheduleCount?: number; verified?: boolean; linkState?: string; failDb?: boolean } = {}) {
  const tables = Object.fromEntries(["restaurants", "menuItems", "verificationRequests", "truckManualSchedules"].map(name => [name, new Proxy({}, { get: (_target, field) => `${name}.${String(field)}` })]));
  const queries: Array<{ table?: unknown; conditions: unknown[] }> = [];
  const rowsFor = (table: unknown) => table === tables.restaurants ? [{ ...baseRestaurant, ...options.restaurant }]
    : table === tables.menuItems ? [{ value: options.menuCount ?? 1 }]
    : table === tables.verificationRequests ? [{ status: "pending", documents: [], licenseNumber: "" }]
    : [{ value: options.scheduleCount ?? 1 }];
  const db = { select() {
    if (options.failDb) throw new Error("fixture DB unavailable");
    const query = { table: undefined as unknown, conditions: [] as unknown[] };
    queries.push(query);
    const chain = {
      from(table: unknown) { query.table = table; return chain; },
      where(condition: unknown) { query.conditions.push(condition); return chain; },
      orderBy() { return chain; },
      limit() { return Promise.resolve(rowsFor(query.table)); },
      then(resolve: (rows: object[]) => unknown, reject: (error: unknown) => unknown) { return Promise.resolve(rowsFor(query.table)).then(resolve, reject); },
    };
    return chain;
  } };
  const parsed = parse(service);
  const withoutImports = ts.createPrinter().printFile(ts.factory.updateSourceFile(parsed, parsed.statements.filter(node => !ts.isImportDeclaration(node))));
  const code = ts.transpileModule(withoutImports, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: Record<string, any> = {};
  vm.runInNewContext(code, {
    exports, db, ...tables, URL, URLSearchParams, Date,
    and: (...values: unknown[]) => values, count: (value: unknown) => value,
    desc: (value: unknown) => value, eq: (...values: unknown[]) => ["eq", ...values], gte: (...values: unknown[]) => ["gte", ...values],
    getBusinessVerificationState: () => ({ isVerifiedForSetup: options.verified !== false }),
  }, { timeout: 2000 });
  const run = () => exports.resolveUserContinuation({
    user: { ...completeUser, ...options.user },
    businessAccessSummary: { linkState: options.linkState || "linked", primaryRestaurantId: "business 1" },
  });
  return { run, queries };
}

for (const [name, options, expectedStep, pathname, setup] of [
  ["profile", { restaurant: { name: "" } }, "profile", "/restaurant-owner-dashboard", "profile"],
  ["media", { restaurant: { logoUrl: "", coverImageUrl: "" } }, "profile_visual", "/restaurant-owner-dashboard", "profile-media"],
  ["menu", { menuCount: 0 }, "menu", "/menu-builder", null],
  ["schedule", { scheduleCount: 0 }, "schedule", "/restaurant-owner-dashboard", "schedule"],
] as const) {
  test(`actual login resolver restores manual ${name} continuation with exact business context`, async () => {
    const fixture = continuationFixture(options);
    const result = await fixture.run();
    assert.equal(result.nextRequiredStep, expectedStep);
    const url = new URL(result.continuationPath, "https://mealscout.local");
    assert.equal(url.pathname, pathname);
    assert.equal(url.searchParams.get("setup"), setup);
    assert.equal(url.searchParams.get("restaurantId"), "business 1");
    assert.ok(!result.continuationPath.includes("owner-ai"));
    assert.deepEqual(Array.from(fixture.queries[0].conditions[0] as unknown[]), ["eq", "restaurants.id", "business 1"]);
  });
}

test("account attachment, role, verification and failure boundaries stay outside the manual-default correction", async () => {
  const account = continuationFixture({ user: { firstName: "" } });
  assert.equal((await account.run()).continuationPath, "/account-setup");
  assert.equal(account.queries.length, 0);
  const unattached = continuationFixture({ linkState: "not_attached" });
  assert.equal((await unattached.run()).continuationPath, "/restaurant-signup?businessType=food_truck&source=auth&claim=1");
  assert.equal(unattached.queries.length, 0);
  for (const userType of ["admin", "host", "customer"]) {
    const otherRole = continuationFixture({ user: { userType } });
    assert.equal((await otherRole.run()).continuationPath, null);
    assert.equal(otherRole.queries.length, 0);
  }
  assert.equal((await continuationFixture().run()).continuationPath, null);
  const verification = await continuationFixture({ verified: false }).run();
  assert.equal(verification.nextRequiredStep, "verification");
  assert.equal(verification.continuationPath, "/restaurant-owner-dashboard?setup=verification");
  assert.equal((await continuationFixture({ menuCount: 0, verified: false }).run()).nextRequiredStep, "menu");
  assert.equal((await continuationFixture({ restaurant: { businessType: "restaurant", isFoodTruck: false }, scheduleCount: 0 }).run()).continuationPath, null);
  await assert.rejects(continuationFixture({ failDb: true }).run(), /fixture DB unavailable/);
});

const memo = initializer(signup, "manualSetupHref") as ts.CallExpression;
const submittedMutation = initializer(signup, "createVerificationRequestMutation") as ts.CallExpression;
const mutationOptions = submittedMutation.arguments[0] as ts.ObjectLiteralExpression;
const submitted = mutationOptions.properties.find(prop => prop.name?.getText() === "onSuccess") as ts.PropertyAssignment;
assert.ok(submitted && ts.isPropertyAssignment(submitted));
const skipped = initializer(signup, "handleSkipVerification");
for (const businessType of ["food_truck", "restaurant"] as const) {
  test(`actual ${businessType} signup callbacks preserve safe requested context and menu draft`, () => {
    const createdRestaurant = { id: "created business&2" };
    const menuSourceUrl = "https://example.invalid/menu?a=1&b=2";
    const manualSetupHref = evaluate(memo.arguments[0].getText(), { createdRestaurant, selectedBusinessType: businessType, menuSourceUrl })();
    const manual = new URL(manualSetupHref, "https://mealscout.local");
    assert.equal(manual.pathname, businessType === "food_truck" ? "/restaurant-owner-dashboard" : "/menu-builder");
    assert.equal(manual.searchParams.get("setup"), businessType === "food_truck" ? "schedule" : null);
    assert.equal(manual.searchParams.get("restaurantId"), createdRestaurant.id);
    assert.equal(manual.searchParams.get("menuSource"), menuSourceUrl);
    for (const context of ["", "reason=keep_draft&redirect=%2Fmenu-builder%3FmenuSource%3Dkept", "reason=restricted&redirect=https%3A%2F%2Fattacker.invalid", "reason=keep_draft&redirect=%2Fowner-ai%3Ffocus%3Dprofile"]) {
      const signupAuthContext = new URLSearchParams(context);
      const destinations: string[] = [], drafts: string[] = [];
      const bindings = {
        createdRestaurant, selectedBusinessType: businessType, manualSetupHref, signupAuthContext,
        resolveProgressiveBusinessSetupDestination,
        persistMenuImportDraft: (id: string) => drafts.push(id),
        trackFunnelEvent: () => undefined, FUNNEL_EVENTS: { activationStarted: "fixture" },
        toast: () => undefined,
        COPY: { notifications: { verification: { successTitle: "fixture", successDescription: "fixture", skippedTitle: "fixture", skippedDescription: "fixture" } } },
        setLocation: (href: string) => destinations.push(href),
      };
      evaluate(submitted.initializer.getText(), bindings)();
      evaluate(skipped.getText(), bindings)();
      assert.equal(destinations.length, 2);
      assert.equal(destinations[0], destinations[1]);
      assert.deepEqual(drafts, [createdRestaurant.id, createdRestaurant.id]);
      const destination = new URL(destinations[0], "https://mealscout.local");
      assert.equal(destination.origin, "https://mealscout.local");
      if (context.includes("%2Fowner-ai")) assert.equal(destination.pathname, "/owner-ai", "an explicitly requested optional AI destination is retained");
      else if (context.includes("%2Fmenu-builder")) {
        assert.equal(destination.pathname, "/menu-builder");
        assert.equal(destination.searchParams.get("restaurantId"), createdRestaurant.id);
        assert.equal(destination.searchParams.get("menuSource"), "kept");
      } else assert.equal(destinations[0], manualSetupHref);
    }
  });
}

test("native public-profile navigation is primary; optional profile-editor AI and consent capability remain", () => {
  const modules = initializer(shell, "allModules").getText();
  assert.doesNotMatch(modules, /id: "ai"|\/owner-ai/);
  assert.match(modules, /id: "profile"[\s\S]*setup: "profile"/);
  const primary = evaluate(initializer(shell, "mobilePrimaryModuleIds").getText(), {});
  assert.deepEqual(Array.from(primary), ["overview", "profile", "menu", "availability"]);
  const nativeModules = [{ id: "overview", label: "Overview" }, { id: "profile", label: "Public profile" }];
  const optionalHeader = evaluate(initializer(shell, "active").getText(), { activeModule: "ai", modules: nativeModules });
  assert.equal(optionalHeader.label, "AI control");
  assert.equal(optionalHeader.description, "Draft every update, then approve once");
  assert.equal(evaluate(initializer(shell, "active").getText(), { activeModule: "profile", modules: nativeModules }), nativeModules[1]);
  const editor = read("client/src/components/owner-profile-workspace.tsx");
  assert.match(editor, /ownerAiHref \? \(/);
  assert.match(editor, /data-testid="owner-profile-ai-entry"/);
  assert.match(editor, /nothing changes or[\s\S]*publishes until you approve the exact revision/);
  assert.doesNotMatch(read("client/src/pages/restaurant-owner-dashboard.tsx"), /owner-ai-completion-entry|Finish with AI/);
  assert.doesNotMatch(signup, /owner-ai-onboarding-handoff|ownerAiSetupHref/);
});
