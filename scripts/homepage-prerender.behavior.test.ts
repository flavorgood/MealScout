import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { registerAcquisitionPrerenderRoutes } from "../server/seo/acquisitionPrerender";
import { createRootHealthGuard } from "../server/seo/rootEntry";
import { guardUnauthenticatedProtectedHtml } from "../server/seo/protectedHtmlRoutes";
import { serveStatic } from "../server/vite";
import { WELCOME_CONTENT } from "../shared/welcomeContent";

// Real boot ordering and real static/document handlers; only an owned temporary
// build directory is supplied. No database, session, provider or application boot.
const canonicalBase = "https://www.mealscout.us";
const browser = "Mozilla/5.0 Chrome/152.0.0.0 Safari/537.36";
const crawlers = ["Googlebot/2.1", "OAI-SearchBot/1.3"];
const template = readFileSync(new URL("../client/index.html", import.meta.url), "utf8");
const directory = mkdtempSync(path.join(os.tmpdir(), "mealscout-homepage-http-"));
const indexPath = path.join(directory, "index.html");
writeFileSync(indexPath, template);
const app = express();
app.set("env", "production");
app.use((req, res, next) => {
  // Model the existing preview middleware's response header, never a real host.
  if (req.get("Host") === "preview.example.test") res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  next();
});
registerAcquisitionPrerenderRoutes(app, canonicalBase);
app.use(guardUnauthenticatedProtectedHtml);
app.use("/", createRootHealthGuard(app, indexPath));
serveStatic(app, { canonicalBaseUrl: canonicalBase, distPath: directory });
app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).type("text").send("Homepage temporarily unavailable");
});
const server = http.createServer(app);
let port = 0;
before(async () => {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  port = (server.address() as AddressInfo).port;
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(directory, { recursive: true, force: true });
});
const request = (requestPath: string, ua?: string, accept?: string, method = "GET", host?: string) =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (ua !== undefined) headers["User-Agent"] = ua;
    if (accept !== undefined) headers.Accept = accept;
    if (host !== undefined) headers.Host = host;
    const req = http.request({ hostname: "127.0.0.1", port, path: requestPath, method, headers }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.once("error", reject); req.end();
  });
const schemas = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));
const assertDocument = (result: Awaited<ReturnType<typeof request>>) => {
  assert.equal(result.status, 200);
  assert.match(String(result.headers["content-type"]), /^text\/html/);
  assert.equal(result.headers["cache-control"], "private, no-store");
  const vary = String(result.headers.vary).toLowerCase();
  assert.ok(vary.includes("accept") && vary.includes("user-agent"));
  assert.ok(result.body.includes(`<h1 class="sr-only">${WELCOME_CONTENT.title}</h1>`));
  assert.ok(result.body.includes(WELCOME_CONTENT.description.replace(/'/g, "&#x27;")));
  for (const href of ["/customer-signup", "/login", "/scout"]) assert.ok(result.body.includes(`href="${href}"`));
  assert.ok(result.body.includes('<link rel="canonical" href="https://www.mealscout.us/">'));
  assert.ok(result.body.includes('<script type="module" src="/src/main.tsx"></script>'));
  assert.deepEqual(schemas(result.body).map(schema => schema["@type"]), ["Organization", "WebSite"]);
};

test("humans and named crawlers receive the same real native first-response content before JavaScript", async () => {
  const human = await request("/", browser, "text/html");
  assertDocument(human);
  for (const ua of crawlers) {
    for (const accept of ["text/html", "*/*", undefined]) {
      const bot = await request("/", ua, accept);
      assertDocument(bot);
      assert.equal(bot.body, human.body);
    }
  }
});
test("HEAD, JSON, ordinary wildcard and no-UA probes retain actual root health behavior", async () => {
  for (const ua of [browser, ...crawlers, undefined]) {
    const head = await request("/", ua, "text/html", "HEAD");
    assert.equal(head.status, 200); assert.equal(head.body, "");
    const json = await request("/", ua, "application/json");
    assert.equal(json.status, 200); assert.equal(JSON.parse(json.body).service, "MealScout API");
  }
  for (const accept of [undefined, "*/*"]) {
    assert.equal(JSON.parse((await request("/", browser, accept)).body).status, "ok");
  }
  assert.equal(JSON.parse((await request("/")).body).status, "ok");
});
test("canonical is configured, query-insensitive and host-independent; forced documents respect JSON", async () => {
  assertDocument(await request("/?prerender=1&canonical=https://attacker.invalid&path=/for-food-trucks", browser, "*/*", "GET", "attacker.invalid"));
  assertDocument(await request("/?prerender=0", browser, "text/html"));
  assert.equal(JSON.parse((await request("/?prerender=true", browser, "application/json")).body).service, "MealScout API");
});
test("tracking variants and preview headers preserve noindex, canonical and shared public facts", async () => {
  for (const [requestPath, host] of [["/?ref=synthetic", undefined], ["/?utm_source=synthetic", undefined], ["/", "preview.example.test"]]) {
    const result = await request(requestPath!, browser, "text/html", "GET", host);
    assertDocument(result);
    assert.ok(result.body.includes('<meta name="robots" content="noindex, nofollow">'));
  }
});
test("root renderer does not escape its exact route or expose protected workspaces", async () => {
  for (const requestPath of ["/admin", "/restaurant-owner-dashboard", "/staff/orders"]) {
    for (const ua of [browser, ...crawlers]) {
      const result = await request(requestPath, ua, "text/html");
      assert.equal(result.status, 401);
      assert.match(String(result.headers["x-robots-tag"]), /noindex/);
      assert.ok(result.body.includes("Sign in required"));
      assert.ok(!result.body.includes("welcome-landing") && !result.body.includes("application/ld+json"));
    }
  }
  for (const requestPath of ["/not-a-page?prerender=1", "/for-food-trucks/child?prerender=1"]) {
    const result = await request(requestPath, crawlers[0], "text/html");
    assert.equal(result.status, 200); // existing SPA fallback policy, not an indexable homepage
    assert.ok(result.body.includes('<div id="root"></div>'));
    assert.ok(!result.body.includes("welcome-landing") && !result.body.includes('rel="canonical"'));
  }
  const asset = await request("/assets/missing.js", browser, "*/*");
  assert.equal(asset.status, 404); assert.equal(asset.body, "Asset not found");
});
test("all four existing acquisition HTML, schema, pricing and cache policies stay unchanged", async () => {
  for (const [requestPath, type, service] of [
    ["/for-restaurants", "ProfessionalService", "Restaurant local discovery"],
    ["/for-food-trucks", "ProfessionalService", "Food truck profiles, schedules, and discovery"],
    ["/for-hosts", "LocalBusiness", "Host location marketplace for food trucks"],
    ["/host-location-partner", "LocalBusiness", "Host location marketplace for food trucks"],
  ]) {
    const google = await request(requestPath, crawlers[0], "text/html");
    const oai = await request(requestPath, crawlers[1], "text/html");
    const forced = await request(requestPath + "?prerender=true", browser, "text/html");
    assert.equal(google.status, 200); assert.equal(google.body, oai.body); assert.equal(google.body, forced.body);
    assert.equal(google.headers["cache-control"], "public, max-age=300, s-maxage=1800");
    const [schema] = schemas(google.body);
    assert.equal(schema["@type"], type); assert.equal(schema.url, canonicalBase + requestPath);
    assert.equal(schema.serviceType, service); assert.equal(schema.areaServed, "United States");
    assert.ok(!(await request(requestPath, browser, "text/html")).body.includes("welcome-landing"));
  }
});
test("malformed build fails explicitly and recovers on the next read without a restart", async () => {
  try {
    writeFileSync(indexPath, "<html><head></head><body>Incomplete build</body></html>");
    const failed = await request("/", browser, "text/html");
    assert.equal(failed.status, 500); assert.equal(failed.body, "Homepage temporarily unavailable");
  } finally { writeFileSync(indexPath, template); }
  assertDocument(await request("/", browser, "text/html"));
});
const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
for (const [arrayKey, sourceKey, destinationKey, fallback] of [
  ["rewrites", "source", "destination", "/:path((?!assets/|static/).*)"],
  ["routes", "src", "dest", "/(.*)"],
]) {
  test(`${arrayKey}: exact homepage uses the same backend for all agents and leaves all other rules bounded`, () => {
    const rules = config[arrayKey];
    const rootPattern = arrayKey === "routes" ? "^/$" : "/";
    const roots = rules.filter((rule: Record<string, unknown>) => rule[sourceKey] === rootPattern);
    assert.equal(roots.length, 1);
    assert.equal(roots[0][destinationKey], "https://mealscout.onrender.com/");
    assert.equal(roots[0].has, undefined);
    assert.ok(rules.indexOf(roots[0]) < rules.findIndex((rule: Record<string, unknown>) => rule[sourceKey] === fallback));
    for (const requestPath of ["/for-food-trucks", "/for-restaurants", "/for-hosts", "/host-location-partner"]) {
      const existing = rules.filter((rule: Record<string, unknown>) => rule[sourceKey] === requestPath);
      assert.equal(existing.length, 1);
      assert.equal(existing[0][destinationKey], "https://mealscout.onrender.com" + requestPath);
      assert.equal(existing[0].has?.[0]?.key, "user-agent");
    }
    if (arrayKey === "routes") assert.ok(rules.some((rule: Record<string, unknown>) => String(rule[sourceKey]).includes("robots")));
    assert.equal(rules.find((rule: Record<string, unknown>) => rule[sourceKey] === fallback)?.[destinationKey], "/index.html");
  });
}
