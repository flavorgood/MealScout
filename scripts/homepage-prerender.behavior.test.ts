import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { registerAcquisitionPrerenderRoutes } from "../server/seo/acquisitionPrerender";

// This boots only the actual acquisition registrar and bounded fallback probes.
// It never imports the application boot, database, provider clients or Vite.
const canonicalBase = "https://www.mealscout.us";
const browser = "Mozilla/5.0 Chrome/152.0.0.0 Safari/537.36";
const crawlers = ["Googlebot/2.1", "OAI-SearchBot/1.3"];
const app = express();
registerAcquisitionPrerenderRoutes(app, canonicalBase);
const escapedApp = express();
registerAcquisitionPrerenderRoutes(escapedApp, 'https://example.invalid/"<script>&');
app.use("/__escape", escapedApp);
app.use((req, res) => {
  // Mirror only the existing root guard's observable fallthrough contract.
  // This is not a full-application startup or health-route integration test.
  if (req.path === "/" && req.method === "HEAD") {
    return res.setHeader("X-Test-Fallback", "root-head"), res.status(200).end();
  }
  if (req.path === "/" && req.method === "GET") {
    res.setHeader("X-Test-Fallback", "root-get");
    if (!(req.get("Accept") || "").includes("text/html")) {
      return res.json({ status: "ok", service: "MealScout API" });
    }
    return res.type("html").send('<div id="root">browser SPA sentinel</div>');
  }
  res.status(404).send("unmatched test path");
});
const server = http.createServer(app);
let port = 0;
before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
const request = (path: string, ua?: string, accept?: string, method = "GET", host?: string) =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (ua !== undefined) headers["User-Agent"] = ua;
    if (accept !== undefined) headers.Accept = accept;
    if (host !== undefined) headers.Host = host;
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.once("error", reject);
    req.end();
  });
const schemaFrom = (html: string) => {
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  return JSON.parse(scripts[0][1]);
};
const assertRootVary = (headers: http.IncomingHttpHeaders) => {
  const fields = String(headers.vary).toLowerCase().split(/,\s*/);
  assert.ok(fields.includes("user-agent"));
  assert.ok(fields.includes("accept"));
};

test("homepage actual HTTP handler gives named crawlers existing public copy, links and WebSite schema", async () => {
  for (const ua of crawlers) {
    const result = await request("/", ua, "text/html");
    assert.equal(result.status, 200);
    assert.equal(result.headers["x-test-fallback"], undefined);
    assert.match(String(result.headers["content-type"]), /^text\/html/);
    assert.equal(result.headers["cache-control"], "private, no-store");
    assertRootVary(result.headers);
    assert.ok(result.body.includes("<title>MealScout | Discover Local Food Near You</title>"));
    assert.ok(result.body.includes('<link rel="canonical" href="https://www.mealscout.us/">'));
    assert.ok(result.body.includes('<meta name="description" content="Discover food trucks, restaurants, dishes, events, and local food deals near you with MealScout.">'));
    assert.ok(result.body.includes("<h1>Welcome to MealScout</h1>"));
    assert.ok(result.body.includes("Find live food trucks, deals, and what&#39;s happening in your local food scene. Log in or create your free account."));
    for (const [label, href] of [["Sign up", "/customer-signup"], ["Log in", "/login"], ["Follow The Flavor", "/scout"]]) {
      assert.ok(result.body.includes(`<a href="${href}">${label}</a>`));
    }
    assert.deepEqual(schemaFrom(result.body), {
      "@context": "https://schema.org", "@type": "WebSite", name: "MealScout",
      url: canonicalBase + "/",
      description: "Discover food trucks, restaurants, dishes, events, and local food deals near you with MealScout.",
    });
  }
});

test("crawler wildcard/absent Accept deliberately gets root HTML while ordinary browser and health probes pass through", async () => {
  for (const accept of [undefined, "*/*"]) {
    const bot = await request("/", crawlers[1], accept);
    assert.ok(bot.body.includes("<h1>Welcome to MealScout</h1>"));
    assert.equal(bot.headers["x-test-fallback"], undefined);
    const ordinary = await request("/", browser, accept);
    assert.equal(ordinary.headers["x-test-fallback"], "root-get");
    assert.equal(JSON.parse(ordinary.body).service, "MealScout API");
    assertRootVary(ordinary.headers);
  }
  const browserHtml = await request("/", browser, "text/html");
  assert.equal(browserHtml.body, '<div id="root">browser SPA sentinel</div>');
  assertRootVary(browserHtml.headers);
  const noUa = await request("/");
  assert.equal(noUa.headers["x-test-fallback"], "root-get");
  assert.equal(JSON.parse(noUa.body).status, "ok");
});

test("HEAD and explicit JSON-only Accept retain the root health fallthrough", async () => {
  const head = await request("/", crawlers[0], "text/html", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers["x-test-fallback"], "root-head");
  assert.equal(head.body, "");
  const json = await request("/", crawlers[0], "application/json");
  assert.equal(json.headers["x-test-fallback"], "root-get");
  assert.equal(JSON.parse(json.body).service, "MealScout API");
  assertRootVary(json.headers);
});

test("root canonical ignores query and request Host; explicit prerender remains bounded to registered pages", async () => {
  const forced = await request("/?prerender=1&canonical=https%3A%2F%2Fattacker.invalid%2F&path=%2Ffor-food-trucks", browser, "text/html", "GET", "attacker.invalid");
  assert.ok(forced.body.includes('<link rel="canonical" href="https://www.mealscout.us/">'));
  assert.equal(schemaFrom(forced.body).url, canonicalBase + "/");
  assert.equal(forced.headers["cache-control"], "private, no-store");
  const disabled = await request("/?prerender=0", browser, "text/html");
  assert.equal(disabled.headers["x-test-fallback"], "root-get");
  for (const path of ["/not-a-page?prerender=1", "/for-food-trucks/child?prerender=1"]) {
    const missing = await request(path, crawlers[0], "text/html");
    assert.equal(missing.status, 404);
    assert.equal(missing.body, "unmatched test path");
  }
});

test("all four existing landing HTML/schema/cache policies remain distinct from the homepage", async () => {
  for (const [path, type, service] of [
    ["/for-restaurants", "ProfessionalService", "Restaurant local discovery"],
    ["/for-food-trucks", "ProfessionalService", "Food truck profiles, schedules, and discovery"],
    ["/for-hosts", "LocalBusiness", "Host location marketplace for food trucks"],
    ["/host-location-partner", "LocalBusiness", "Host location marketplace for food trucks"],
  ]) {
    const google = await request(path, crawlers[0], "text/html");
    const oai = await request(path, crawlers[1], "text/html");
    const forced = await request(path + "?prerender=true", browser, "text/html");
    assert.equal(google.status, 200);
    assert.equal(google.body, oai.body);
    assert.equal(google.body, forced.body);
    assert.ok(google.body.includes(`<link rel="canonical" href="${canonicalBase}${path}">`));
    assert.ok(!google.body.includes("<h1>Welcome to MealScout</h1>"));
    assert.equal(google.headers["cache-control"], "public, max-age=300, s-maxage=1800");
    assert.equal(google.headers.vary, undefined);
    const schema = schemaFrom(google.body);
    assert.equal(schema["@type"], type);
    assert.equal(schema.url, canonicalBase + path);
    assert.equal(schema.areaServed, "United States");
    assert.equal(schema.serviceType, service);
    assert.equal((await request(path, browser, "text/html")).status, 404);
  }
});

test("HTML attributes and JSON-LD safely escape even a malformed configured canonical base", async () => {
  const result = await request("/__escape/", crawlers[0], "text/html");
  assert.equal(result.status, 200);
  assert.ok(result.body.includes('href="https://example.invalid/&quot;&lt;script&gt;&amp;/"'));
  assert.ok(!result.body.includes('<script>&/'));
  assert.equal(schemaFrom(result.body).url, 'https://example.invalid/"<script>&/');
});

const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
for (const [arrayKey, sourceKey, destinationKey, fallback] of [
  ["rewrites", "source", "destination", "/:path((?!assets/|static/).*)"],
  ["routes", "src", "dest", "/(.*)"],
]) {
  test(`${arrayKey}: only exact homepage crawlers reach SSR before the unchanged SPA fallback`, () => {
    const rules = config[arrayKey];
    const rootPattern = arrayKey === "routes" ? "^/$" : "/";
    const rootRules = rules.filter((rule: Record<string, unknown>) => rule[sourceKey] === rootPattern);
    assert.equal(rootRules.length, 1);
    const root = rootRules[0];
    assert.equal(root[destinationKey], "https://mealscout.onrender.com/");
    assert.equal(root.has.length, 1);
    assert.deepEqual({ type: root.has[0].type, key: root.has[0].key }, { type: "header", key: "user-agent" });
    const matcher = new RegExp(`^(?:${root.has[0].value})$`);
    for (const ua of [...crawlers, "ChatGPT-User/1.0", "GPTBot/1.3", "ClaudeBot/1.0"]) assert.ok(matcher.test(ua));
    for (const ua of [browser, "", "Python-urllib/3.12"]) assert.equal(matcher.test(ua), false);
    const fallbackRule = rules.find((rule: Record<string, unknown>) => rule[sourceKey] === fallback);
    assert.equal(fallbackRule[destinationKey], "/index.html");
    assert.ok(rules.indexOf(root) < rules.indexOf(fallbackRule));
    if (arrayKey === "routes") {
      const pathMatcher = new RegExp(root[sourceKey]);
      assert.equal(pathMatcher.test("/"), true);
      for (const path of ["/for-food-trucks", "/api/test", "/assets/app.js", "/restaurant-owner-dashboard"]) {
        assert.equal(pathMatcher.test(path), false, `homepage legacy regex must reject ${path}`);
      }
    }
    for (const path of ["/for-food-trucks", "/for-restaurants", "/for-hosts", "/host-location-partner"]) {
      const existing = rules.filter((rule: Record<string, unknown>) => rule[sourceKey] === path);
      assert.equal(existing.length, 1);
      assert.equal(existing[0][destinationKey], "https://mealscout.onrender.com" + path);
      assert.deepEqual(existing[0].has, root.has);
    }
  });
}
