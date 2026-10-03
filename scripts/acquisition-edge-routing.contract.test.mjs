/**
 * Focused contract for the four existing acquisition SSR routes.
 * Run: node --test scripts/acquisition-edge-routing.contract.test.mjs
 * This checks authored edge routing, NOT a live deployment or Google indexing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

const config = JSON.parse(
  readFileSync(process.env.ACQUISITION_ROUTING_CONFIG || "vercel.json", "utf8"),
);
const origin = "https://mealscout.onrender.com";
const paths = [
  "/for-food-trucks",
  "/for-restaurants",
  "/for-hosts",
  "/host-location-partner",
];
const crawlerAgents = [
  "Googlebot/2.1", "googlebot/2.1", "Bingbot/2.0", "bingbot/2.0",
  "DuckDuckBot/1.1", "Applebot/0.1", "OAI-SearchBot/1.3", "ChatGPT-User/1.0",
  "GPTBot/1.3", "ClaudeBot/1.0", "anthropic-ai", "cohere-ai",
  "PerplexityBot/1.0", "Yahoo! Slurp", "Example Crawler", "Example Spider",
];
const browserAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1",
  "Mozilla/5.0 Firefox/140.0", "",
];

for (const [key, source, destination, fallback] of [
  ["rewrites", "source", "destination", "/:path((?!assets/|static/).*)"],
  ["routes", "src", "dest", "/(.*)"],
]) {
  for (const path of paths) {
    test(`${key}: ${path} reaches existing SSR for crawlers without changing browser routing`, () => {
      const rules = config[key];
      assert.ok(Array.isArray(rules), `${key} must be an array`);
      const matches = rules.filter((rule) => rule[source] === path);
      assert.equal(matches.length, 1, `${path} must have exactly one dedicated ${key} rule`);
      const rule = matches[0];
      assert.equal(rule[destination], `${origin}${path}`);
      assert.equal(rule.has?.length, 1, "Preserve the existing crawler-only policy");
      const condition = rule.has[0];
      assert.equal(condition.type, "header");
      assert.equal(condition.key, "user-agent");
      const pattern = new RegExp(`^(?:${condition.value})$`);
      for (const agent of crawlerAgents) {
        assert.ok(pattern.test(agent), `${path}: crawler not forwarded: ${agent}`);
      }
      for (const agent of browserAgents) {
        assert.equal(pattern.test(agent), false, `${path}: browser must retain the SPA: ${agent}`);
      }
      const fallbackIndex = rules.findIndex((entry) => entry[source] === fallback);
      assert.ok(fallbackIndex >= 0, "Keep the existing SPA fallback");
      assert.ok(rules.indexOf(rule) < fallbackIndex, "SSR rules must precede the SPA fallback");
      assert.equal(rules[fallbackIndex][destination], "/index.html");
    });
  }

  test(`${key}: API and private dashboard forwarding remain intact`, () => {
    const rules = config[key];
    assert.equal(
      rules.find((rule) => rule[source] === "/api/(.*)")?.[destination],
      `${origin}/api/$1`,
    );
    for (const path of ["/admin", "/dashboard", "/vendor-dashboard", "/supplier-portal"]) {
      const privatePath = key === "routes" ? `${path}(/.*)?` : path;
      const rule = rules.find((entry) => entry[source] === privatePath);
      assert.ok(rule, `${privatePath} must still reach server-side access controls`);
      assert.equal(rule[destination], `${origin}${path}${key === "routes" ? "$1" : ""}`);
      assert.equal(rule.has, undefined, "Access controls must not become crawler-only");
    }
  });
}

// Exercise the actual daily callback with isolated imports and provider responses.
await import("./indexnow-scheduler.contract.test.mjs");

test("host application requires a saved receipt and preserves persistence on email failure", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "scripts/host-partner-confirmation.contract.test.mjs"], {
    encoding: "utf8", timeout: 30000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
});
