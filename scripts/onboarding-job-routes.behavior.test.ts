import assert from "node:assert/strict";
import { after, test } from "node:test";
import express, { type RequestHandler } from "express";
import { registerOnboardingJobRoutes } from "../server/routes/onboardingJobRoutes";
import type { OnboardingDatabase } from "../server/services/onboardingJobs";

let databaseCalls = 0;
let enabled = false;
const database: OnboardingDatabase = {
  async transaction(work) {
    databaseCalls++;
    return work({ async execute() { return { rows: [] }; } });
  },
};
const auth: RequestHandler = (req, res, next) => {
  if (req.get("x-synthetic-owner") !== "synthetic-owner") { res.status(401).json({ error: "Synthetic authentication required" }); return; }
  (req as any).user = { id: "synthetic-owner" };
  next();
};
const app = express();
app.use(express.json());
registerOnboardingJobRoutes(app, { database, isAuthenticated: auth, limiter: (_req, _res, next) => next(), enabled: () => enabled });
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const base = "http://127.0.0.1:" + (server.address() as any).port + "/api/owner-ai/restaurants/00000000-0000-4000-8000-000000000147/onboarding";
after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
const request = async (path: string, options: { method?: string; body?: unknown; authenticated?: boolean; key?: string } = {}) => {
  const res = await fetch(base + path, {
    method: options.method || "GET",
    headers: {
      ...(options.authenticated === false ? {} : { "x-synthetic-owner": "synthetic-owner" }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.key ? { "idempotency-key": options.key } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: res.status, cache: res.headers.get("cache-control"), body: await res.json() as any };
};

test("research HTTP entry defaults disabled and performs no DB work", async () => {
  const result = await request("/jobs", { method: "POST", body: { businessName: "Synthetic", location: "Synthetic" }, key: "synthetic-key-1" });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "ONBOARDING_PERSISTENCE_DISABLED");
  assert.equal(result.cache, "private, no-store");
  assert.equal(databaseCalls, 0);
});

test("unauthenticated callers cannot reach persisted owner data", async () => {
  assert.equal((await request("/jobs/00000000-0000-4000-8000-000000000148", { authenticated: false })).status, 401);
  assert.equal(databaseCalls, 0);
});

test("service build rejects forged paid state even with research enabled", async () => {
  enabled = true;
  const result = await request("/service-build", { method: "POST", body: { paymentVerified: true, tier: 2500 } });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "SERVICE_BUILD_INTEGRATION_REQUIRED");
  assert.equal(databaseCalls, 0);
});

test("enabled research rejects unsupported fields and missing idempotency key before DB work", async () => {
  const invalid = await request("/jobs", { method: "POST", body: { businessName: "Synthetic", location: "Synthetic", ownerId: "other" }, key: "synthetic-key-2" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "ONBOARDING_REQUEST_INVALID");
  const missing = await request("/jobs", { method: "POST", body: { businessName: "Synthetic", location: "Synthetic" } });
  assert.equal(missing.status, 400);
  assert.equal(databaseCalls, 0);
});

test("enabled status crosses the service's persisted current-owner guard", async () => {
  const result = await request("/jobs/00000000-0000-4000-8000-000000000148");
  assert.equal(result.status, 403);
  assert.equal(result.body.code, "CURRENT_OWNER_REQUIRED");
  assert.equal(databaseCalls, 1);
});
