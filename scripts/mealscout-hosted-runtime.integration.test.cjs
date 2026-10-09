const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { createRequire, Module } = require("node:module");

async function runHostedRuntimeTests() {
  const dependencyRoot = process.env.MEALSCOUT_TEST_DEPENDENCY_ROOT;
  const contractSource = process.env.MEALSCOUT_HOST_CONTRACT_SOURCE;
  assert.ok(dependencyRoot && contractSource, "Pinned installed dependencies and Trade contract required");
  const requireDependencies = createRequire(path.join(dependencyRoot, "package.json"));
  const ts = requireDependencies("typescript");
  const express = requireDependencies("express");
  const session = requireDependencies("express-session");
  const Stripe = requireDependencies("stripe");
  const repo = path.resolve(__dirname, "..");
  const contractSha = crypto.createHash("sha256").update(fs.readFileSync(contractSource)).digest("hex");
  // Exact v2 owning contract at tradescoutAI 93b1f25d; this suite still tests
  // its HTTP boundary. Native upgrade acceptance has its own socket suite.
  assert.equal(contractSha, "cd8fcbfebe199fc639c649137662df8e6416b66342aef88dcf6914b29ec7b27c");
  function loadTs(filename) {
    const result = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      fileName: filename, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    });
    assert.equal((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = module.paths;
    loaded._compile(result.outputText, filename);
    return loaded.exports;
  }
  const { createMealScoutHostedRuntimeBinding } = loadTs(path.join(repo, "server/integrations/tradeScoutHostedRuntime.ts"));
  const { createProfileHostedRuntimeRegistry, createProfileHostedRuntimeMiddleware } = loadTs(contractSource);
  const host = "food.consumer.example";
  const profileId = "fixture-existing-routing-profile";
  const ownerUserId = "fixture-existing-routing-owner";
  const authority = { host, profileId, ownerUserId, slug: "fixture-food" };
  const servers = [];
  const listens = [];
  const checks = [];
  const started = Date.now();
  let nativeRequests = 0;
  let cancellations = 0;
  let signatureChecks = 0;
  const stripe = new Stripe("sk_test_FIXTURE_NOT_REAL_TRANSPORT_ONLY");
  const signatureKey = "whsec_FIXTURE_NOT_REAL_TRANSPORT_ONLY";
  const native = express();
  native.disable("x-powered-by");
  native.set("trust proxy", 1);
  native.use((_req, _res, next) => { nativeRequests++; next(); });
  native.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
    try {
      const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], signatureKey);
      signatureChecks++;
      res.json({ received: true, id: event.id, rawSha256: crypto.createHash("sha256").update(req.body).digest("hex") });
    } catch { res.status(400).send("Native signature rejected"); }
  });
  // Actual session middleware with a disposable MemoryStore. This tests relay
  // transparency, never native production PgSession/owner/SSO acceptance.
  native.use(session({
    name: "tradescout.sid", secret: "FIXTURE_SESSION_NOT_REAL", resave: false,
    saveUninitialized: false, proxy: true,
    cookie: { secure: true, httpOnly: true, sameSite: "none" },
  }));
  native.get("/__transport/session/write", (req, res) => {
    req.session.transportMarker = "native-only";
    res.send("saved");
  });
  native.get("/__transport/session/read", (req, res) => {
    if (req.session.transportMarker !== "native-only") return res.status(401).send("Native session required");
    res.send("native-only");
  });
  native.all("/__transport/headers", (req, res) => {
    res.json({ method: req.method, originalUrl: req.originalUrl, headers: req.headers, protocol: req.protocol });
  });
  native.all("/__transport/body", (req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.once("end", () => {
      const body = Buffer.concat(chunks);
      res.json({ method: req.method, bytes: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex") });
    });
  });
  native.post("/__transport/early-denial", (_req, res) => res.status(403).end("Native early denial"));
  native.get("/auth/native/callback", (req, res) => res.redirect(302, "/restaurant-owner-dashboard?native=1"));
  native.get("/assets/native.js", (_req, res) => {
    res.type("application/javascript").send("window.nativeMealAsset=true;");
  });
  const compressed = zlib.gzipSync(Buffer.from("native media transport bytes"));
  native.get("/media/native", (req, res) => {
    assert.equal(req.headers.range, "bytes=0-9");
    res.status(206).set({
      "Content-Range": "bytes 0-9/100", "Content-Encoding": "gzip",
      "Content-Type": "application/octet-stream",
    }).send(compressed);
  });
  native.get("/__transport/cookies", (_req, res) => {
    res.setHeader("Set-Cookie", [
      "tradescout.sid=native-test; Path=/; Secure; HttpOnly; SameSite=None",
      "native_marker=two; Path=/; HttpOnly",
    ]);
    res.end("cookies");
  });
  native.get("/__transport/transfer-coding", (_req, res) => {
    res.setHeader("Transfer-Encoding", "gzip, chunked");
    res.write(compressed);
    res.end();
  });
  native.post("/__transport/trailers", (req, res) => {
    req.resume();
    req.once("end", () => {
      res.setHeader("Trailer", "Native-Result");
      res.write(JSON.stringify(req.trailers));
      res.addTrailers({ "Native-Result": "preserved" });
      res.end();
    });
  });
  native.get("/__transport/abort", (req) => req.socket.destroy());
  native.get("/__transport/hang", () => {});
  native.get("/__transport/stream", (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.write("data: native-start\n\n");
    const timer = setInterval(() => res.write("data: native-heartbeat\n\n"), 25);
    res.once("close", () => { clearInterval(timer); cancellations++; });
  });
  native.use((_req, res) => res.status(404).send("Native app route missing"));

  async function listen(app) {
    const server = http.createServer(app);
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    listens.push({ host: "127.0.0.1", port, owned: true });
    return port;
  }
  function request(port, options = {}) {
    return new Promise((resolve, reject) => {
      const client = http.request({
        hostname: "127.0.0.1", port, method: options.method || "GET",
        path: options.path || "/", agent: false,
        headers: { Host: host, ...(options.headers || {}) },
      }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () => resolve({
          status: response.statusCode, headers: response.headers,
          rawHeaders: response.rawHeaders, trailers: response.trailers,
          body: Buffer.concat(chunks),
        }));
      });
      client.setTimeout(2000, () => client.destroy(new Error("Owned fixture request timeout")));
      client.once("error", reject);
      if (options.body !== undefined) client.write(options.body);
      if (options.trailers) client.addTrailers(options.trailers);
      client.end();
    });
  }
  async function check(name, operation) {
    await operation();
    checks.push(name);
    console.log("ok " + checks.length + " - " + name);
  }
  try {
    const nativePort = await listen(native);
    const options = { host, profileId, ownerUserId, upstreamOrigin: "http://127.0.0.1:" + nativePort, responseIdleTimeoutMs: 200 };
    await check("Fixed operator origin and exact routing inputs reject unsafe configuration", () => {
      for (const upstreamOrigin of [
        "http://outside.example", "https://user:secret@native.example",
        "https://native.example/path", "https://native.example?target=other", "https://" + host,
      ]) assert.throws(() => createMealScoutHostedRuntimeBinding({ ...options, upstreamOrigin }));
      for (const badHost of ["*.food.example", "https://food.example", "thetradescout.com", "food.example:999"]) {
        assert.throws(() => createMealScoutHostedRuntimeBinding({ ...options, host: badHost }));
      }
      assert.throws(() => createMealScoutHostedRuntimeBinding({ ...options, ownerUserId: "" }));
    });
    const registry = createProfileHostedRuntimeRegistry();
    const binding = createMealScoutHostedRuntimeBinding(options);
    assert.equal(binding.appId, "mealscout");
    assert.ok(Object.isFrozen(binding));
    const dispose = registry.register(binding);
    let currentAuthority = authority;
    const gateway = express();
    gateway.use(createProfileHostedRuntimeMiddleware({ registry, resolveAuthority: async () => currentAuthority }));
    gateway.use((_req, res) => res.status(418).send("TradeScout fallback fixture"));
    const gatewayPort = await listen(gateway);
    await check("All methods, encoded route/query and native request credentials use the fixed runtime", async () => {
      const route = "/__transport/headers?next=%2Forders%3Fa%3D1&duplicate=1&duplicate=2";
      const result = await request(gatewayPort, {
        method: "PATCH", path: route,
        headers: { Cookie: "native_cookie=one; second=two", Authorization: "Bearer fixture-native", Origin: "https://" + host },
        body: "original-body",
      });
      assert.equal(result.status, 200);
      const received = JSON.parse(result.body);
      assert.equal(received.method, "PATCH"); assert.equal(received.originalUrl, route);
      assert.equal(received.headers.cookie, "native_cookie=one; second=two");
      assert.equal(received.headers.authorization, "Bearer fixture-native");
      assert.equal(received.headers.origin, "https://" + host);
    });
    await check("Forwarding claims cannot select an upstream or native proxy identity", async () => {
      const result = await request(gatewayPort, {
        path: "/__transport/headers",
        headers: { Forwarded: "host=attacker.example;proto=http", "X-Forwarded-Host": "attacker.example", "X-Forwarded-Proto": "http", "X-Forwarded-For": "owner", "X-Forwarded-Port": "1" },
      });
      const received = JSON.parse(result.body);
      assert.equal(received.headers.host, host);
      assert.equal(received.headers["x-forwarded-host"], host);
      assert.equal(received.headers["x-forwarded-proto"], "https");
      assert.equal(received.headers["x-forwarded-for"], "127.0.0.1");
      assert.equal(received.headers.forwarded, undefined);
      assert.equal(received.headers["x-forwarded-port"], undefined);
      assert.equal(received.protocol, "https");
    });
    await check("Chunked GET and DELETE bodies retain their raw payload framing", async () => {
      const body = Buffer.from([0, 1, 255, 10, 200]);
      const expected = crypto.createHash("sha256").update(body).digest("hex");
      for (const method of ["GET", "DELETE"]) {
        const result = await request(gatewayPort, { method, path: "/__transport/body", headers: { "Transfer-Encoding": "chunked" }, body });
        assert.equal(result.status, 200);
        assert.deepEqual(JSON.parse(result.body), { method, bytes: body.length, sha256: expected });
      }
    });
    await check("A flowing upload beyond ten seconds retains the configured idle allowance", async () => {
      const result = await new Promise((resolve, reject) => {
        let timer;
        const client = http.request({ hostname: "127.0.0.1", port: gatewayPort, method: "POST", path: "/__transport/body", agent: false, headers: { Host: host, "Transfer-Encoding": "chunked" } }, response => {
          const chunks = [];
          response.on("data", chunk => chunks.push(chunk));
          response.once("end", () => {
            clearInterval(timer);
            if (!client.writableEnded) client.end();
            resolve({ status: response.statusCode, body: Buffer.concat(chunks), elapsedMs: Date.now() - uploadStarted });
          });
          response.once("error", reject);
        });
        const uploadStarted = Date.now();
        let written = 0;
        client.once("error", error => { clearInterval(timer); reject(error); });
        timer = setInterval(() => {
          client.write("x");
          written++;
          if (written === 105) { clearInterval(timer); client.end(); }
        }, 100);
      });
      assert.ok(result.elapsedMs > 10_000);
      assert.equal(result.status, 200); assert.equal(JSON.parse(result.body).bytes, 105);
    });
    await check("An early native denial completes independently of the incoming upload", async () => {
      const result = await new Promise((resolve, reject) => {
        const client = http.request({ hostname: "127.0.0.1", port: gatewayPort, method: "POST", path: "/__transport/early-denial", agent: false, headers: { Host: host, "Transfer-Encoding": "chunked" } }, response => {
          const chunks = [];
          response.on("data", chunk => chunks.push(chunk));
          response.once("end", () => { client.end(); resolve({ status: response.statusCode, body: Buffer.concat(chunks) }); });
          response.once("error", reject);
        });
        client.once("error", reject);
        client.write("partial upload");
      });
      assert.equal(result.status, 403); assert.equal(result.body.toString(), "Native early denial");
    });
    await check("Native session cookies round-trip through real express-session without gateway login", async () => {
      assert.equal((await request(gatewayPort, { path: "/__transport/session/read" })).status, 401);
      const login = await request(gatewayPort, { path: "/__transport/session/write" });
      assert.equal(login.status, 200);
      const cookie = login.headers["set-cookie"][0];
      assert.match(cookie, /^tradescout\.sid=/); assert.match(cookie, /Secure/);
      assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=None/);
      const authenticated = await request(gatewayPort, { path: "/__transport/session/read", headers: { Cookie: cookie.split(";")[0] } });
      assert.equal(authenticated.status, 200); assert.equal(authenticated.body.toString(), "native-only");
    });
    await check("Signed raw webhook bytes reach actual Stripe SDK verification unchanged", async () => {
      const payload = '{\n  "id": "evt_transport_only", "object": "event", "type": "transport.unhandled", "data": {"object": {"note":"exact spacing"}}\n}';
      const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: signatureKey });
      const headers = { "Content-Type": "application/json", "Stripe-Signature": signature };
      const result = await request(gatewayPort, { method: "POST", path: "/api/stripe/webhook", headers, body: payload });
      assert.equal(result.status, 200);
      assert.equal(JSON.parse(result.body).rawSha256, crypto.createHash("sha256").update(payload).digest("hex"));
      assert.equal(signatureChecks, 1);
      assert.equal((await request(gatewayPort, { method: "POST", path: "/api/stripe/webhook", headers, body: payload + " " })).status, 400);
      assert.equal((await request(gatewayPort, { method: "POST", path: "/api/stripe/webhook", headers: { "Content-Type": "application/json" }, body: payload })).status, 400);
    });
    await check("Native callback redirects and assets retain their paths and responses", async () => {
      const callback = await request(gatewayPort, { path: "/auth/native/callback?state=encoded%2Bnative" });
      assert.equal(callback.status, 302); assert.equal(callback.headers.location, "/restaurant-owner-dashboard?native=1");
      const asset = await request(gatewayPort, { path: "/assets/native.js" });
      assert.equal(asset.status, 200); assert.equal(asset.body.toString(), "window.nativeMealAsset=true;");
    });
    await check("Media range status, encoding and binary response remain native", async () => {
      const result = await request(gatewayPort, { path: "/media/native", headers: { Range: "bytes=0-9" } });
      assert.equal(result.status, 206); assert.equal(result.headers["content-range"], "bytes 0-9/100");
      assert.equal(result.headers["content-encoding"], "gzip"); assert.deepEqual(result.body, compressed);
    });
    await check("Additional request and response transfer codings fail explicitly", async () => {
      const before = nativeRequests;
      const inbound = await request(gatewayPort, { method: "POST", path: "/__transport/body", headers: { "Transfer-Encoding": "gzip, chunked" }, body: compressed });
      assert.equal(inbound.status, 501); assert.equal(nativeRequests, before);
      const outbound = await request(gatewayPort, { path: "/__transport/transfer-coding" });
      assert.equal(outbound.status, 502);
    });
    await check("Multiple native Set-Cookie headers retain separate values", async () => {
      const result = await request(gatewayPort, { path: "/__transport/cookies" });
      assert.deepEqual(result.headers["set-cookie"], [
        "tradescout.sid=native-test; Path=/; Secure; HttpOnly; SameSite=None",
        "native_marker=two; Path=/; HttpOnly",
      ]);
    });
    await check("HTTP request and response trailers survive stream reframing", async () => {
      const result = await request(gatewayPort, { method: "POST", path: "/__transport/trailers", headers: { Trailer: "Native-Input" }, body: "chunk", trailers: { "Native-Input": "original" } });
      assert.equal(result.status, 200); assert.equal(JSON.parse(result.body)["native-input"], "original");
      assert.equal(result.trailers["native-result"], "preserved");
    });
    await check("Native route denial cannot fall through into TradeScout routes", async () => {
      const result = await request(gatewayPort, { path: "/api/native-missing" });
      assert.equal(result.status, 404); assert.equal(result.body.toString(), "Native app route missing");
    });
    await check("Revoked or transferred public authority denies every native route before transport", async () => {
      const before = nativeRequests;
      currentAuthority = null;
      assert.equal((await request(gatewayPort, { path: "/assets/native.js" })).status, 404);
      currentAuthority = { ...authority, ownerUserId: "other-fixture-owner" };
      assert.equal((await request(gatewayPort, { path: "/__transport/session/read" })).status, 404);
      assert.equal(nativeRequests, before);
      currentAuthority = authority;
    });
    await check("Absolute request targets and malformed registered hosts cannot redirect transport", async () => {
      const before = nativeRequests;
      assert.equal((await request(gatewayPort, { path: "http://attacker.example/api" })).status, 400);
      assert.equal((await request(gatewayPort, { path: "/assets/native.js", headers: { Host: host + ":999" } })).status, 404);
      assert.equal(nativeRequests, before);
    });
    await check("Consumed request bodies are rejected before native signature transport", async () => {
      const parsed = express(); parsed.use(express.json()); parsed.use(binding.handle);
      const parsedPort = await listen(parsed);
      const before = nativeRequests;
      const result = await request(parsedPort, { method: "POST", path: "/api/stripe/webhook", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(result.status, 503); assert.equal(nativeRequests, before);
    });
    await check("HTTP upgrade headers remain an explicit unsupported gap", async () => {
      const before = nativeRequests;
      const result = await request(gatewayPort, { headers: { Upgrade: "websocket" } });
      assert.equal(result.status, 426); assert.equal(nativeRequests, before);
    });
    await check("Upstream reset and idle timeout fail closed without platform fallback", async () => {
      assert.equal((await request(gatewayPort, { path: "/__transport/abort" })).status, 503);
      assert.equal((await request(gatewayPort, { path: "/__transport/hang" })).status, 503);
    });
    await check("Client disconnect cancels the owned native response stream", async () => {
      await new Promise((resolve, reject) => {
        const client = http.request({ hostname: "127.0.0.1", port: gatewayPort, path: "/__transport/stream", headers: { Host: host }, agent: false }, response => {
          response.once("data", () => { response.destroy(); client.destroy(); resolve(); });
        });
        client.once("error", reject); client.end();
      });
      const limit = Date.now() + 1000;
      while (!cancellations && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(cancellations, 1);
    });
    await check("Registry disposer removes only the owned routing registration", () => {
      dispose(); assert.equal(registry.find(host), undefined);
    });
    return {
      passed: checks.length, failed: 0, checks, durationMs: Date.now() - started,
      contractModuleSha256: contractSha, listens,
      actualExpressHttp: true, actualExpressSession: true, sessionStore: "isolated MemoryStore",
      actualStripeSdkCrypto: true, nativeSignatureVerifications: signatureChecks,
      nativeMealEntryStarted: false, nativePgSessionOwnerSsoPaymentJournalAccepted: false,
      authority: "synthetic exact resolver passed to actual pinned TradeScout gateway",
      realCustomerProviderDatabaseExternalCalls: 0, upgradeAcceptance: false,
    };
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => {
      server.close(resolve); server.closeAllConnections();
    })));
  }
}

module.exports = { runHostedRuntimeTests };
if (require.main === module) {
  runHostedRuntimeTests().then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}
