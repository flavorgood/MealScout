import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { once } from "node:events";
import {
  classifyDiscoveryRequest, deriveDiscoverySource, deriveDiscoverySourceEvidence,
  deriveDiscoverySearchSurface, discoveryRequestActorType, discoverySourceFromReferrer,
} from "../server/services/discoveryRequestSignals";
import { registerPublicProfileQualityRoute } from "../server/routes/publicProfileQualityRoute";

const browser = {
  "user-agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
  "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors",
};
const request = (referer: unknown, query: Record<string, unknown> = {}) => ({ headers: { referer }, query });
for (const [url, source] of [
  ["https://www.google.com/search?q=food", "google"],
  ["https://maps.google.com/", "google_maps"],
  ["https://www.google.com/maps/place/example", "google_maps"],
  ["https://www.google.co.uk/search?q=food", "google"],
  ["https://www.bing.com/search?q=food", "bing"],
  ["https://chatgpt.com/", "chatgpt"],
  ["https://www.openai.com/", "chatgpt"],
  ["https://l.facebook.com/redirect", "facebook"],
  ["https://www.instagram.com/", "instagram"],
  ["HTTPS://WWW.GOOGLE.COM./search", "google"],
] as const) test(`supported referrer: ${url}`, () => assert.equal(discoverySourceFromReferrer(url), source));

for (const url of [
  "https://google.com.attacker.invalid/", "https://notgoogle.com/", "https://google.evil/",
  "https://attacker.invalid/google.com", "https://attacker.invalid/?next=https://chatgpt.com/",
  "https://maps.google.com.attacker.invalid/", "https://notchatgpt.com/",
  "https://chatgpt.com@attacker.invalid/", "https://attacker.invalid@google.com/",
  "https://google.com:444/search", "javascript:https://google.com", "//google.com/",
  "OAI-SearchBot", "https:\\google.com\\search", "https://goo\ngle.com/", "google.com",
  ["https://google.com/"], { toString: () => "https://google.com/" }, "https://google.com/" + "x".repeat(2048),
]) test(`invalid or impostor referrer ${JSON.stringify(url)}`, () => assert.equal(discoverySourceFromReferrer(url), null));

test("campaign aliases are exact labels, arrays/objects/prototype names cannot forge providers", () => {
  for (const [value, source] of [["google", "google"], [" GOOGLE ", "google"], ["google_maps", "google_maps"], ["chatgpt", "chatgpt"], ["facebook.com", "facebook"]]) {
    assert.deepEqual(deriveDiscoverySourceEvidence(request("", { utm_source: value })), { source, basis: "campaign_label" });
  }
  for (const value of ["google.com.evil", "oai-searchbot", "prefix-google.com", "https://google.com", "__proto__", "constructor", ["google"], { source: "google" }]) {
    assert.equal(deriveDiscoverySource(request("", { utm_source: value })), "unknown");
  }
  assert.equal(deriveDiscoverySource(request("https://bing.com/", { utm_source: ["google"] })), "bing");
});

test("source priority, unknowns and bounded search surfaces stay explicit", () => {
  assert.equal(deriveDiscoverySource(request("https://bing.com/", { utm_source: "google" })), "google");
  assert.deepEqual(deriveDiscoverySourceEvidence(null), { source: "unknown", basis: "unavailable" });
  assert.equal(deriveDiscoverySearchSurface(request("https://google.com/search?token=secret", { utm_medium: "web_search" })), "web_search");
  assert.equal(deriveDiscoverySearchSurface(request("https://google.com/search?token=secret", { utm_medium: "https://private.invalid/token" })), "google.com");
  assert.equal(deriveDiscoverySearchSurface(request("https://secret:password@google.com")), null);
  assert.equal(deriveDiscoverySource({ get: () => { throw new Error("header unavailable"); } }), "unknown");
});

test("browser signals never prove a human; bot and QA signals override them", () => {
  const candidate = classifyDiscoveryRequest({ headers: browser });
  assert.equal(candidate.classification, "browser_candidate");
  assert.equal(discoveryRequestActorType(candidate), "unknown");
  for (const ua of ["Googlebot/2.1", "OAI-SearchBot/1.3", "ChatGPT-User/1.0", "ClaudeBot/1.0", "facebookexternalhit/1.1", "AhrefsBot/7.0"]) {
    const quality = classifyDiscoveryRequest({ headers: { ...browser, "user-agent": ua } });
    assert.equal(quality.classification, "discovery_crawler", ua);
    assert.equal(discoveryRequestActorType(quality), "bot");
  }
  for (const ua of ["UptimeRobot/2.0", "Pingdom.com_bot_version_1.4"]) {
    const quality = classifyDiscoveryRequest({ headers: { ...browser, "user-agent": ua } });
    assert.equal(quality.classification, "infrastructure_monitor", ua);
    assert.equal(discoveryRequestActorType(quality), "bot");
  }
  for (const ua of ["Mozilla/5.0 HeadlessChrome/130", "curl/8.0", "python-requests/2", "mealscout-runtime-proof/1"]) {
    const quality = classifyDiscoveryRequest({ headers: { ...browser, "user-agent": ua } });
    assert.equal(quality.classification, "automation_signal", ua);
    assert.equal(discoveryRequestActorType(quality), "bot");
  }
  assert.equal(classifyDiscoveryRequest({ headers: { ...browser, "x-mealscout-qa": "1" } }).classification, "qa_signal");
  assert.equal(classifyDiscoveryRequest({ headers: { "x-mealscout-traffic-class": "human" } }).classification, "unclassified");
  assert.equal(classifyDiscoveryRequest({ headers: { "user-agent": browser["user-agent"] } }).classification, "unclassified");
  assert.equal(classifyDiscoveryRequest({ headers: { ...browser, "user-agent": [browser["user-agent"]] } }).classification, "unclassified");
  assert.equal(candidate.version, 2);
  assert.deepEqual(Object.keys(candidate).sort(), ["basis", "classification", "version"]);
});

test("actual Express handler keeps concurrent error reports separate, ignores forged classes, and preserves failures", async () => {
  const app = express(); app.use(express.json());
  const rows: Array<any> = [];
  registerPublicProfileQualityRoute(app, async row => { if (row.entityId === "write-fail") throw new Error("isolated writer failure"); rows.push(row); });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = async (id: string, headers: Record<string, string>, overrides = {}) => {
    const response = await fetch(origin + "/api/analytics/shell?utm_source=google", {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ type: "missing_menu_viewed", profile_id: id, profile_type: "truck", path: "/truck/proof--fixture", ...overrides }),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const cases = [
      { id: "browser", headers: browser, quality: "browser_candidate", actor: "unknown" },
      { id: "bot", headers: { ...browser, "user-agent": "Googlebot/2.1" }, quality: "discovery_crawler", actor: "bot" },
      { id: "monitor", headers: { ...browser, "user-agent": "UptimeRobot/2.0" }, quality: "infrastructure_monitor", actor: "bot" },
      { id: "qa", headers: { ...browser, "x-mealscout-qa": "1" }, quality: "qa_signal", actor: "internal" },
      { id: "unknown", headers: { "user-agent": "unknown" }, quality: "unclassified", actor: "unknown" },
    ];
    const replies = await Promise.all(cases.map(item => post(item.id, item.headers, { trafficQuality: { classification: "human" }, actorType: "human", email: "private@example.invalid" })));
    assert(replies.every(item => item.status === 202 && item.body.ok));
    for (const expected of cases) {
      const row = rows.find(value => value.entityId === expected.id); assert(row);
      assert.equal(row.actorType, expected.actor); assert.equal(row.sourceType, expected.actor);
      assert.equal(row.metadata.trafficQuality.classification, expected.quality);
      assert.equal(row.metadata.discoverySource, "google"); assert.equal(row.metadata.discoverySourceBasis, "campaign_label");
      assert.equal(row.metadata.evidenceKind, "client_reported_profile_quality");
      assert.equal(row.ip, null); assert.equal(row.userAgent, null); assert.equal(row.anonymousActorId, null);
      assert(!JSON.stringify(row).includes("private@example.invalid"));
      assert.equal(row.metadata.finalOutcome, undefined); assert.equal(row.metadata.completedAction, undefined);
    }
    const count = rows.length;
    assert.equal((await post("invalid", browser, { type: "discovery_landing" })).status, 400);
    assert.equal((await post("invalid", browser, { type: "failed_profile_image", failed_image_type: "private" })).status, 400);
    assert.equal((await post("invalid", browser, { path: null })).status, 400);
    assert.equal(rows.length, count);
    const failed = await post("write-fail", browser);
    assert.equal(failed.status, 202); assert.equal(failed.body.ok, false); assert.equal(rows.length, count);
    const host = await post("host", browser, { profile_type: "location" });
    assert.equal(host.status, 202); assert.equal(rows.at(-1).entityType, "host");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
