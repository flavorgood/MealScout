import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

// Execute the complete published scheduler and IndexNow service, not an
// extracted function. Only cron/import/network boundaries are isolated.
const paths = ["", "/scout", "/deals/featured", "/for-restaurants", "/for-food-trucks", "/for-bars", "/for-events", "/for-hosts", "/host-location-partner"];
function compile(file, globals, requireImpl) {
  const source = readFileSync(file, "utf8");
  const result = ts.transpileModule(source, {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  assert.equal((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const exports = {};
  const context = vm.createContext({ ...globals, exports, module: { exports }, require: requireImpl });
  new vm.Script(result.outputText, { filename: file }).runInContext(context, { timeout: 2000 });
  return exports;
}
function fixture(options = {}) {
  const env = { INDEXNOW_ENABLED: "true", INDEXNOW_KEY: "0123456789abcdef0123456789abcdef", INDEXNOW_HOST: "www.mealscout.us", ...options.env };
  const logs = [], posts = [], jobs = [], registrations = [], outreach = [];
  const logger = Object.fromEntries(["log", "info", "warn", "error"].map(level => [level, (...args) => logs.push({ level, text: args.map(String).join(" ") })]));
  const unexpected = name => () => { throw new Error("Unrelated dependency invoked: " + name); };
  const common = { process: { env }, console: logger, URL };
  const service = compile("server/services/indexNow.ts", {
    ...common,
    fetch: async (url, init) => {
      posts.push({ url, method: init.method, headers: init.headers, payload: JSON.parse(init.body) });
      if (options.networkFailure) throw new Error("isolated provider failure");
      return new Response(options.body || "", { status: options.status || 200 });
    },
  }, name => { throw new Error("Unexpected service dependency: " + name); });
  const modules = {
    "node-cron": { schedule: (expression, callback, config) => { jobs.push({ expression, callback, config }); return {}; } },
    "../digestService": { DigestService: { getInstance: () => ({ sendWeeklyDigests: async () => { outreach.push("weekly-digest"); } }) } }, "../dinerDigestService": {}, "../onboardingDripService": {}, "../restaurantActivationService": {},
    "../eventNotificationCron": { notifyUnbookedEvents: async () => { outreach.push("event-outreach"); return { sent: 0 }; } }, "../parkingPassReminder": {}, "../services/locationDemandActivation": {},
    "../services/supplyMarketIntel": {}, "../services/hostPartnerLeadDrip": {}, "../services/socialQueueProcessor": {},
    "../services/indexNow": service,
    "../services/ownerAiSourceReviewCoverage": { readLatestSourceReviewRunCoverage: async () => ({}) },
    "../services/ownerAiNativeProfiles": { runNativeOwnerSourceReviews: async () => ({ day: "isolated", results: [] }) },
    "../services/ownerAiSourceReviews": {
      summarizeOwnerAiSourceReviewReasons: async () => ({}),
      ownerAiSourceReviewSchedule: () => ({ expression: "0 5 * * *", timezone: "America/Chicago" }),
      runOwnerAiSourceReviews: async () => ({ day: "isolated", results: [], coverage: {} }),
    },
    "../services/publicProfileSourceChecks": {
      sourceCheckDay: () => "isolated",
      publicSourceCheckSchedule: () => ({ expression: "0 0 * * *", timezone: "America/Chicago" }),
      runPublicProfileSourceChecks: async () => ({}),
    },
    "../storiesCronJobs": { registerStoryCronJobs: () => registrations.push("stories") },
    "../featuredVideoCron": { registerFeaturedVideoCronJobs: async () => registrations.push("featured") },
    "../utils/marketingEmailWindow": {
      MARKETING_EMAIL_TIMEZONE: "America/Chicago", MARKETING_EMAIL_WINDOW_START_HOUR: 8, MARKETING_EMAIL_WINDOW_END_HOUR: 19,
      areAutomatedMarketingEmailsEnabled: () => options.marketingEnabled ?? false, describeAutomatedMarketingEmailFlag: () => "isolated",
      isWithinMarketingEmailWindow: options.inWindow ? () => true : unexpected("marketing dispatch"),
    },
    "../db": { db: new Proxy({}, { get: unexpected("database") }) },
    "@shared/schema": {}, "drizzle-orm": {},
  };
  const scheduler = compile("server/bootstrap/registerSchedulers.ts", common, name => {
    assert(Object.hasOwn(modules, name), "Unexpected scheduler import: " + name);
    return modules[name];
  });
  return { env, logs, posts, jobs, registrations, outreach, register: () => scheduler.registerSchedulers({}) };
}
async function registered(options) {
  const f = fixture(options); await f.register();
  const matching = f.jobs.filter(job => job.expression === "0 4 * * *");
  assert.equal(matching.length, 1, "Existing daily job is registered exactly once");
  assert.equal(matching[0].config.timezone, "America/Chicago");
  assert.deepEqual(f.registrations, ["stories", "featured"]);
  assert.equal(f.posts.length, 0, "Registration itself never notifies a provider");
  return { ...f, run: matching[0].callback };
}

test("scheduled callback delivers all nine reviewed public URLs through the actual submission service", async () => {
  const f = await registered(); await f.run();
  assert.equal(f.posts.length, 1);
  const request = f.posts[0];
  assert.equal(request.url, "https://api.indexnow.org/indexnow");
  assert.equal(request.method, "POST");
  assert.equal(request.payload.host, "www.mealscout.us");
  assert.equal(request.payload.keyLocation, "https://www.mealscout.us/" + f.env.INDEXNOW_KEY + ".txt");
  assert.deepEqual(request.payload.urlList, paths.map(path => "https://www.mealscout.us" + path), "Host pages must reach the actual scheduled payload");
  assert.equal(new Set(request.payload.urlList).size, 9);
  for (const url of request.payload.urlList) {
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://www.mealscout.us");
    assert.equal(parsed.search, ""); assert.equal(parsed.hash, "");
    assert(!/^\/(api|admin|dashboard|vendor-dashboard|supplier-portal|location|truck)(\/|$)/.test(parsed.pathname));
  }
  assert(f.logs.some(row => row.text.includes("9 URLs, status 200")));
});

test("explicitly disabled integration registers no submission job", async () => {
  const f = fixture({ env: { INDEXNOW_ENABLED: "false" } }); await f.register();
  assert.equal(f.jobs.filter(job => job.expression === "0 4 * * *").length, 0);
  assert.equal(f.posts.length, 0);
});

test("unset or empty flag registers the submission job (on by default)", async () => {
  for (const enabled of ["", undefined]) {
    const f = fixture({ env: { INDEXNOW_ENABLED: enabled } }); await f.register();
    assert.equal(f.jobs.filter(job => job.expression === "0 4 * * *").length, 1);
    assert.equal(f.posts.length, 0);
  }
});

test("missing key produces no provider request", async () => {
  const f = await registered({ env: { INDEXNOW_KEY: "" } }); await f.run(); assert.equal(f.posts.length, 0);
});

test("configuration disabled after registration stops delivery", async () => {
  const f = await registered(); f.env.INDEXNOW_ENABLED = "false"; await f.run(); assert.equal(f.posts.length, 0);
});

test("provider rejection remains a visible rejection and does not trigger repeat submissions", async () => {
  const f = await registered({ status: 403, body: "Site verification failed" }); await f.run();
  assert.equal(f.posts.length, 1);
  assert(f.logs.some(row => row.text.includes("status 403") && row.text.includes("Site verification failed")));
});

test("pending provider validation is reported as 202, not an indexing success", async () => {
  const f = await registered({ status: 202 }); await f.run();
  assert.equal(f.posts.length, 1);
  assert(f.logs.some(row => row.text.includes("status 202")));
  assert(!f.logs.some(row => /indexed successfully|ranking improved|organic visitor/i.test(row.text)));
});

test("network failure is surfaced with one attempt and no unrelated scheduler execution", async () => {
  const f = await registered({ networkFailure: true }); await f.run();
  assert.equal(f.posts.length, 1);
  assert(f.logs.some(row => row.level === "error" && row.text.includes("[indexnow] daily cron failed:")));
});

// Essential-only switch: the weekly host digest and the event outreach send
// with no mail-layer category, so the scheduler gate is the only place the
// master switch (AUTOMATED_MARKETING_EMAILS_ENABLED=false) can stop them.
// With the switch off the callbacks must return before the window check and
// before either sender runs; the fixture's window mock throws if reached.
function jobByExpression(f, expression) {
  const matching = f.jobs.filter(job => job.expression === expression);
  assert.equal(matching.length, 1, `job ${expression} is registered exactly once`);
  return matching[0];
}

test("weekly digest does not run while automated marketing emails are disabled", async () => {
  const f = fixture(); await f.register();
  await jobByExpression(f, "0 8 * * 1").callback();
  assert.deepEqual(f.outreach, []);
});

test("event outreach does not run while automated marketing emails are disabled", async () => {
  const f = fixture(); await f.register();
  await jobByExpression(f, "0 * * * *").callback();
  assert.deepEqual(f.outreach, []);
});

test("weekly digest and event outreach still run when the switch is on inside the window", async () => {
  const f = fixture({ marketingEnabled: true, inWindow: true }); await f.register();
  await jobByExpression(f, "0 8 * * 1").callback();
  await jobByExpression(f, "0 * * * *").callback();
  assert.deepEqual(f.outreach, ["weekly-digest", "event-outreach"]);
});
