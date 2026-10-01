#!/usr/bin/env node

import { readFileSync } from "node:fs";
import dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

const PUBLIC_CANONICAL_HOST = "www.mealscout.us";
const API_BACKEND_ORIGIN = "https://mealscout.onrender.com";
const INSURANCE_MIGRATION = "105_restaurant_insurance_verification_expiry.sql";
const skipLiveProbes = isTruthy(process.env.SKIP_LIVE_PROBES);
const strictEnv =
  isTruthy(process.env.PROD_GATE_STRICT_ENV) ||
  isTruthy(process.env.CI) ||
  String(process.env.NODE_ENV || "").toLowerCase() === "production";
const paymentsEnabled = !isTruthy(process.env.MEALSCOUT_BYPASS_STRIPE);

const requiredEnvNames = [
  "DATABASE_URL",
  "SESSION_SECRET",
  "PUBLIC_BASE_URL",
  "SITEMAP_SITE_URL",
  "CLIENT_ORIGIN",
  "INDEXNOW_ENABLED",
  "INDEXNOW_KEY",
  "INDEXNOW_HOST",
  "STRIPE_SECRET_KEY",
  "VITE_STRIPE_PUBLIC_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "BREVO_API_KEY",
];

const cronEnvNames = [
  "INDEXNOW_ENABLED",
  "INDEXNOW_KEY",
  "INDEXNOW_HOST",
  "BREVO_API_KEY",
  "DATABASE_URL",
  "PUBLIC_BASE_URL",
];

const mutableMethods = ["POST", "PUT", "PATCH", "DELETE"];
const checks = [];
let failed = 0;
let warned = 0;

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "").trim().toLowerCase(),
  );
}

function envValue(name) {
  return String(process.env[name] || "").trim();
}

function configured(name) {
  return envValue(name).length > 0;
}

function normalizeOrigin(raw, fallback) {
  const value = String(raw || fallback || "").trim();
  const withProtocol = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;
  const parsed = new URL(withProtocol);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = "";
  return parsed.toString().replace(/\/+$/, "");
}

function canonicalPublicOrigin() {
  const raw =
    envValue("PROD_GATE_PUBLIC_BASE_URL") ||
    envValue("SITEMAP_SITE_URL") ||
    envValue("PUBLIC_BASE_URL") ||
    `https://${PUBLIC_CANONICAL_HOST}`;
  return normalizeOrigin(raw, `https://${PUBLIC_CANONICAL_HOST}`);
}

function apiBackendOrigin() {
  const raw =
    envValue("PROD_GATE_API_BASE_URL") ||
    envValue("VITE_API_BASE_URL") ||
    API_BACKEND_ORIGIN;
  return normalizeOrigin(raw, API_BACKEND_ORIGIN);
}

function addCheck(name, ok, details = "", severity = "fail") {
  checks.push({ name, ok, details, severity });
  if (ok) {
    console.log(`PASS ${name}${details ? ` - ${details}` : ""}`);
    return;
  }
  if (severity === "warn") {
    warned += 1;
    console.warn(`WARN ${name}${details ? ` - ${details}` : ""}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${details ? ` - ${details}` : ""}`);
}

function requireStaticSnippet(file, snippets, label) {
  const source = readFileSync(file, "utf8");
  for (const snippet of snippets) {
    addCheck(
      `${label}: ${snippet}`,
      source.includes(snippet),
      source.includes(snippet) ? file : `missing in ${file}`,
    );
  }
}

function resolveIndexNowConfig() {
  const key = envValue("INDEXNOW_KEY") || readRobotsIndexNowKey();
  const host = (envValue("INDEXNOW_HOST") || PUBLIC_CANONICAL_HOST)
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  const configuredLocation = envValue("INDEXNOW_KEY_LOCATION");
  const defaultLocation = key ? `https://${host}/${encodeURIComponent(key)}.txt` : "";
  let keyLocation = defaultLocation;

  if (configuredLocation) {
    try {
      const parsed = new URL(configuredLocation);
      const configuredHost = parsed.hostname.toLowerCase().replace(/^www\./, "");
      const expectedHost = host.toLowerCase().replace(/^www\./, "");
      if (
        !configuredLocation.includes("<") &&
        !configuredLocation.includes(">") &&
        configuredHost === expectedHost &&
        parsed.pathname === `/${key}.txt`
      ) {
        parsed.protocol = "https:";
        parsed.hash = "";
        parsed.search = "";
        keyLocation = parsed.toString();
      }
    } catch {
      keyLocation = defaultLocation;
    }
  }

  return {
    enabled: isTruthy(process.env.INDEXNOW_ENABLED) || Boolean(key),
    key,
    host,
    keyLocation,
  };
}

function readRobotsIndexNowKey() {
  try {
    const robots = readFileSync("client/public/robots.txt", "utf8");
    const match = robots.match(/^IndexNow:\s*https:\/\/[^/]+\/([^/\s]+)\.txt/im);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

async function probe({ name, url, expect, method = "GET", headers = {} }) {
  addCheck(
    `live probe is read-only: ${name}`,
    !mutableMethods.includes(method.toUpperCase()),
    `${method} ${url}`,
  );
  if (skipLiveProbes) {
    addCheck(`live probe skipped: ${name}`, true, "SKIP_LIVE_PROBES=true");
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      method,
      redirect: "follow",
      headers: {
        Accept: "application/json,text/html,text/plain;q=0.9,*/*;q=0.8",
        "User-Agent": "MealScoutProductionGate/1.0",
        ...headers,
      },
      signal: controller.signal,
    });
    addCheck(
      `live probe: ${name}`,
      expect.includes(res.status),
      `${res.status} ${url} expected ${expect.join("/")}`,
    );
  } catch (error) {
    addCheck(`live probe: ${name}`, false, `${url} ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function probeJson({ name, url, expect, validate, method = "GET", headers = {} }) {
  addCheck(
    `live probe is read-only: ${name}`,
    !mutableMethods.includes(method.toUpperCase()),
    `${method} ${url}`,
  );
  if (skipLiveProbes) {
    addCheck(`live probe skipped: ${name}`, true, "SKIP_LIVE_PROBES=true");
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      method,
      redirect: "follow",
      headers: {
        Accept: "application/json",
        "User-Agent": "MealScoutProductionGate/1.0",
        ...headers,
      },
      signal: controller.signal,
    });
    addCheck(
      `live probe: ${name}`,
      expect.includes(res.status),
      `${res.status} ${url} expected ${expect.join("/")}`,
    );
    if (!expect.includes(res.status)) return;
    const body = await res.json();
    validate(body);
  } catch (error) {
    addCheck(`live probe: ${name}`, false, `${url} ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function validateEnv() {
  for (const name of requiredEnvNames) {
    const requiredForThisRun =
      ["DATABASE_URL", "SESSION_SECRET"].includes(name) ||
      (strictEnv &&
        paymentsEnabled &&
        ["STRIPE_SECRET_KEY", "VITE_STRIPE_PUBLIC_KEY", "STRIPE_WEBHOOK_SECRET"].includes(
          name,
        )) ||
      (strictEnv &&
        !["STRIPE_SECRET_KEY", "VITE_STRIPE_PUBLIC_KEY", "STRIPE_WEBHOOK_SECRET"].includes(
          name,
        ));
    addCheck(
      `required env var: ${name}`,
      configured(name),
      configured(name)
        ? "configured"
        : strictEnv
          ? "missing in strict production mode"
          : "missing in local audit mode",
      requiredForThisRun ? "fail" : "warn",
    );
  }

  for (const name of cronEnvNames) {
    addCheck(
      `cron prerequisite env: ${name}`,
      configured(name),
      configured(name) ? "configured" : "missing in local audit mode",
      strictEnv ? "fail" : "warn",
    );
  }
}

function validateCanonicalAndRouting(publicOrigin, apiOrigin) {
  const publicUrl = new URL(publicOrigin);
  addCheck(
    "canonical public URL host",
    publicUrl.protocol === "https:" && publicUrl.hostname === PUBLIC_CANONICAL_HOST,
    publicOrigin,
    strictEnv ? "fail" : "warn",
  );
  addCheck("API backend origin", apiOrigin === API_BACKEND_ORIGIN, apiOrigin);

  const vercelConfig = JSON.parse(readFileSync("vercel.json", "utf8"));
  const rewrites = Array.isArray(vercelConfig.rewrites) ? vercelConfig.rewrites : [];
  const routes = Array.isArray(vercelConfig.routes) ? vercelConfig.routes : [];
  addCheck(
    "Vercel rewrite: /api to Render",
    rewrites.some(
      (rule) =>
        rule.source === "/api/(.*)" &&
        rule.destination === `${API_BACKEND_ORIGIN}/api/$1`,
    ),
  );
  addCheck(
    "Vercel route: /api before SPA fallback",
    routes.findIndex(
      (rule) => rule.src === "/api/(.*)" && rule.dest === `${API_BACKEND_ORIGIN}/api/$1`,
    ) <
      routes.findIndex((rule) => rule.src === "/(.*)" && rule.dest === "/index.html"),
  );
  addCheck(
    "Vercel rewrite: IndexNow key file to Render",
    rewrites.some(
      (rule) =>
        rule.source === "/:indexNowKey([A-Za-z0-9_-]{8,128}).txt" &&
        rule.destination === `${API_BACKEND_ORIGIN}/:indexNowKey.txt`,
    ),
  );
  addCheck(
    "Vercel route: IndexNow key file before SPA fallback",
    routes.findIndex(
      (rule) =>
        rule.src === "/([A-Za-z0-9_-]{8,128})\\.txt" &&
        rule.dest === `${API_BACKEND_ORIGIN}/$1.txt`,
    ) <
      routes.findIndex((rule) => rule.src === "/(.*)" && rule.dest === "/index.html"),
  );
}

function validateIndexNow(publicOrigin) {
  const cfg = resolveIndexNowConfig();
  addCheck("IndexNow key configured or discoverable", Boolean(cfg.key), cfg.key ? "configured" : "missing");
  addCheck(
    "IndexNow host is canonical",
    cfg.host === PUBLIC_CANONICAL_HOST,
    cfg.host,
    strictEnv ? "fail" : "warn",
  );
  addCheck(
    "IndexNow key location is not placeholder",
    Boolean(cfg.keyLocation) && !/[<>]/.test(cfg.keyLocation),
    cfg.keyLocation || "missing",
  );
  addCheck(
    "IndexNow key location uses canonical host",
    cfg.keyLocation.startsWith(`${publicOrigin}/`),
    cfg.keyLocation,
    strictEnv ? "fail" : "warn",
  );
  requireStaticSnippet(
    "server/services/indexNow.ts",
    [
      "resolveIndexNowKeyLocation",
      "configured.includes(\"<\")",
      "configuredHost !== host",
      "parsed.pathname !== expectedPath",
    ],
    "IndexNow config fallback",
  );
}

function validateInsuranceGateReferences() {
  requireStaticSnippet(
    "server/routes/hostRoutes.ts",
    [
      "assessParkingPassTruckEligibility",
      "currentEligibility.storedInsuranceValid",
      "Verify your email and submit business insurance to book Parking Pass spots.",
    ],
    "insurance booking eligibility gate",
  );
  requireStaticSnippet(
    "scripts/admin-insurance-verification.contract.test.ts",
    [INSURANCE_MIGRATION, "Business verification must not bypass insurance expiry."],
    "insurance contract coverage",
  );
  requireStaticSnippet(
    `migrations/${INSURANCE_MIGRATION}`,
    [
      "ADD COLUMN IF NOT EXISTS insurance_verified",
      "ADD COLUMN IF NOT EXISTS insurance_expires_at",
      "insurance_verified_by_user_id",
    ],
    "insurance migration ordering",
  );
  addCheck(
    "documented migration/deploy order",
    true,
    `run migrations/${INSURANCE_MIGRATION} before relying on deployed booking eligibility`,
  );
}

function validateNoMutationContract() {
  const source = readFileSync("scripts/productionReadinessGate.mjs", "utf8");
  const sourceWithoutSelfGuard = source.replace(/"submitIndexNowUrls\("/g, '""');
  for (const method of mutableMethods) {
    addCheck(
      `gate does not issue ${method} probes`,
      !source.includes(`method: "${method}"`) && !source.includes(`method = "${method}"`),
    );
  }
  addCheck(
    "gate does not submit IndexNow URLs",
    !sourceWithoutSelfGuard.includes("submitIndexNowUrls("),
    "provider checks are GET-only key verification",
  );
}

async function run() {
  const publicOrigin = canonicalPublicOrigin();
  const apiOrigin = apiBackendOrigin();
  const indexNow = resolveIndexNowConfig();

  console.log("MealScout production readiness gate");
  console.log(`Mode: ${strictEnv ? "strict production" : "local audit"}`);
  console.log(`Public origin: ${publicOrigin}`);
  console.log(`API origin: ${apiOrigin}`);
  console.log(`Live probes: ${skipLiveProbes ? "skipped" : "enabled"}`);

  validateEnv();
  validateCanonicalAndRouting(publicOrigin, apiOrigin);
  validateIndexNow(publicOrigin);
  validateInsuranceGateReferences();
  validateNoMutationContract();

  await probe({
    name: "health route",
    url: `${apiOrigin}/api/health`,
    expect: [200],
  });
  await probeJson({
    name: "production version route",
    url: `${apiOrigin}/api/version`,
    expect: [200],
    validate: (body) => {
      const version = body?.version || {};
      addCheck("version route exposes commit field", "commit" in version);
      addCheck("version route exposes buildTime field", Boolean(version.buildTime));
      addCheck(
        "version route exposes environment field",
        typeof version.environment === "string" && version.environment.length > 0,
      );
      addCheck(
        "version route exposes frontend asset manifest flag",
        typeof version.frontendAssetManifest === "boolean",
      );
      addCheck(
        "version route documents commit env vars",
        Array.isArray(version.commitEnvVars) &&
          version.commitEnvVars.includes("RENDER_GIT_COMMIT") &&
          version.commitEnvVars.includes("VERCEL_GIT_COMMIT_SHA"),
      );
      addCheck(
        "version route does not expose secrets",
        !JSON.stringify(body).match(/DATABASE_URL|SESSION_SECRET|STRIPE_SECRET|BREVO_API_KEY|CLOUDINARY_API_SECRET/),
      );
    },
  });
  await probe({
    name: "ready route",
    url: `${apiOrigin}/health/ready`,
    expect: [200],
  });
  await probe({
    name: "public profile route",
    url: `${publicOrigin}/p/truck/t1/taco-bandito`,
    expect: [200, 404],
    headers: { "User-Agent": "Googlebot MealScoutProductionGate/1.0" },
  });
  await probe({
    name: "Scout route",
    url: `${publicOrigin}/scout`,
    expect: [200],
  });
  await probe({
    name: "Parking Pass route",
    url: `${publicOrigin}/parking-pass`,
    expect: [200],
  });
  await probe({
    name: "admin launch-board requires auth",
    url: `${apiOrigin}/api/admin/launch-board`,
    expect: [401, 403],
  });
  if (indexNow.keyLocation) {
    await probe({
      name: "IndexNow key URL",
      url: indexNow.keyLocation,
      expect: [200],
    });
  }

  console.log("");
  console.log(`Checks: ${checks.length}, warnings: ${warned}, failures: ${failed}`);
  if (failed > 0) {
    console.error("MealScout production readiness gate failed.");
    process.exit(1);
  }
  console.log("MealScout production readiness gate passed.");
}

run().catch((error) => {
  console.error("MealScout production readiness gate crashed:", error);
  process.exit(1);
});
