// node --test scripts/mealscout-tradescout-sso-identity.behavior.test.cjs
// Optional: MEALSCOUT_TEST_DEPENDENCY_ROOT points to an existing dependency checkout.
// Optional: MEALSCOUT_TEST_SOURCE_ROOT selects a read-only baseline checkout.
// Compile the actual module, register its routes, and invoke only the SSO handler.
// All persistence/session effects are explicit local fixtures; JWT verification
// and response sanitization use the real implementations. No HTTP server is opened.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const net = require("node:net");
const path = require("node:path");
const tls = require("node:tls");
const { after, before, test } = require("node:test");

const root = process.env.MEALSCOUT_TEST_SOURCE_ROOT || path.resolve(__dirname, "..");
const dependencyRoot = process.env.MEALSCOUT_TEST_DEPENDENCY_ROOT || root;
const dependencyRequire = Module.createRequire(path.join(dependencyRoot, "package.json"));
const ts = dependencyRequire("typescript");
const jwt = dependencyRequire("jsonwebtoken");
const secret = crypto.randomBytes(32).toString("hex");
const originalEnv = process.env;
const originalConnect = net.Socket.prototype.connect;
const originalTlsConnect = tls.connect;
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
let handler;
let effects = [];
let upserts = [];
let verifications = [];
let fixtureErrors = [];
let networkAttempts = 0;

function unexpected(label) {
  return () => {
    fixtureErrors.push(label);
    throw new Error(`Unexpected dependency call: ${label}`);
  };
}

function compileModule(relativePath, imports = {}) {
  const filename = path.join(root, relativePath);
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  });
  assert.deepEqual(
    (compiled.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error),
    [],
    `TypeScript syntax diagnostics in ${relativePath}`,
  );
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.require = (name) => {
    assert.ok(Object.hasOwn(imports, name), `Unapproved import: ${name}`);
    return imports[name];
  };
  loaded._compile(compiled.outputText, filename);
  return loaded.exports;
}

function signedPayload(payload, signingSecret = secret) {
  // Raw JSON also exercises validly signed non-object payloads that jwt.sign
  // deliberately refuses to construct. Verification still uses jsonwebtoken.
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = `${header}.${body}`;
  const signature = crypto.createHmac("sha256", signingSecret).update(input).digest("base64url");
  return `${input}.${signature}`;
}

before(async () => {
  process.env = {
    NODE_ENV: "test",
    PUBLIC_BASE_URL: "https://mealscout-fixture.invalid",
    TRADESCOUT_JWT_SECRET: secret,
  };
  const blockNetwork = () => {
    networkAttempts++;
    throw new Error("Network access is forbidden in this local SSO fixture");
  };
  net.Socket.prototype.connect = blockNetwork;
  tls.connect = blockNetwork;
  globalThis.fetch = blockNetwork;
  // Expected failures log verification errors; never print tokens or fixture secrets.
  console.error = () => {};
  console.warn = () => {};
  const { sanitizeUser } = compileModule("server/utils/sanitize.ts");
  const roles = compileModule("server/roleAccess.ts");
  const storage = {
    // setupUnifiedAuth performs this startup read. It sees no real account.
    getUserByEmail: async () => null,
    updateUserType: unexpected("startup account upgrade"),
    upsertUserByAuth: async (provider, data, userType) => {
      effects.push("upsert");
      upserts.push({ provider, data, userType });
      return {
        id: "fixture-user",
        userType,
        email: data.email,
        tradescoutId: data.tradescoutId,
        passwordHash: "fixture-password-hash",
        googleAccessToken: "fixture-google-token",
        facebookAccessToken: "fixture-facebook-token",
        stripeCustomerId: "fixture-stripe-customer",
        stripeSubscriptionId: "fixture-stripe-subscription",
        affiliateTag: "fixture-existing-tag",
      };
    },
  };
  const passport = {
    serializeUser: () => {},
    deserializeUser: () => {},
    use: unexpected("OAuth strategy registration"),
    authenticate: unexpected("OAuth authentication"),
  };
  const { setupUnifiedAuth } = compileModule("server/unifiedAuth.ts", {
    passport,
    "passport-google-oauth20": { Strategy: unexpected("Google strategy") },
    "passport-facebook": { Strategy: unexpected("Facebook strategy") },
    bcryptjs: { hash: unexpected("password hashing") },
    jsonwebtoken: {
      ...jwt,
      verify(...args) {
        verifications.push({ argumentCount: args.length, secret: args[1] });
        return jwt.verify(...args);
      },
    },
    "express-session": unexpected("session store"),
    "connect-pg-simple": unexpected("Postgres session store"),
    "./storage": { storage },
    "./services/businessTeamAccess": {
      hasBusinessPermissionForRestaurant: unexpected("business permission"),
      getBusinessAccessContext: unexpected("business access"),
    },
    "./services/loginContinuation": { resolveUserContinuation: unexpected("login continuation") },
    "./emailService": { emailService: {} },
    "./smsService": { sendSms: unexpected("SMS") },
    crypto,
    "./utils/sanitize": { sanitizeUser },
    "./utils/passwordPolicy": { isPasswordStrong: unexpected("password policy"), PASSWORD_REQUIREMENTS: "fixture" },
    "./db": {
      db: { select: unexpected("database select"), update: unexpected("database update"), insert: unexpected("database insert") },
    },
    "@shared/schema": { emailSequenceSends: {}, users: {} },
    "drizzle-orm": {
      and: unexpected("database and"), eq: unexpected("database eq"),
      or: unexpected("database or"), sql: unexpected("database sql"),
    },
    "./affiliateTagService": {
      ensureAffiliateTag: unexpected("affiliate tag creation"),
      resolveAffiliateUserId: async () => {
        effects.push("resolveReferral");
        return null;
      },
    },
    "./roleAccess": roles,
    "./utils/authLog": { authLog: unexpected("auth log") },
    "@shared/safeInternalPath": { normalizeSafeInternalPath: unexpected("continuation path") },
    "@shared/businessSignupIntent": { resolveBusinessAuthProvisioningUserType: unexpected("business signup") },
    "./services/accountSetupCompletion": {
      ACCOUNT_SETUP_ALREADY_COMPLETED_CODE: "fixture",
      completeAccountSetupTransaction: unexpected("account setup transaction"),
    },
    "./middleware/distributedRateLimit": { distributedRateLimit: () => unexpected("unrelated rate limiter") },
  });
  const routes = [];
  const app = {
    get: (route, ...callbacks) => routes.push({ method: "GET", route, callbacks }),
    post: (route, ...callbacks) => routes.push({ method: "POST", route, callbacks }),
  };
  await setupUnifiedAuth(app);
  const matches = routes.filter((r) => r.method === "POST" && r.route === "/api/auth/tradescout/sso");
  assert.equal(matches.length, 1, "exactly one SSO route must be registered");
  assert.equal(matches[0].callbacks.length, 1);
  handler = matches[0].callbacks[0];
  assert.deepEqual(fixtureErrors, []);
});

after(() => {
  process.env = originalEnv;
  net.Socket.prototype.connect = originalConnect;
  tls.connect = originalTlsConnect;
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
  assert.equal(networkAttempts, 0, "no provider, database, or session network access");
});

async function invoke(token, { bearer = false } = {}) {
  effects = [];
  upserts = [];
  verifications = [];
  fixtureErrors = [];
  let loggedInUser;
  const req = {
    headers: bearer ? { authorization: `Bearer ${token}` } : {},
    body: { ...(bearer ? {} : { token }), referralId: "fixture-referral" },
    cookies: {},
    session: {
      regenerate(callback) { effects.push("regenerate"); callback(); },
      save(callback) { effects.push("save"); callback(); },
    },
    login(user, callback) { effects.push("login"); loggedInUser = user; callback(); },
  };
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { assert.equal(this.body, undefined, "handler responds once"); this.body = body; return this; },
  };
  await handler(req, res);
  assert.deepEqual(fixtureErrors, [], "no hidden dependency failures");
  assert.equal(networkAttempts, 0);
  return { res, loggedInUser };
}

function assertRejected(result, code, error, { verified = true } = {}) {
  assert.equal(result.res.statusCode, code);
  assert.deepEqual(result.res.body, { error });
  assert.deepEqual(effects, [], "rejection precedes upsert, referral, and every session effect");
  assert.deepEqual(upserts, []);
  assert.equal(result.loggedInUser, undefined);
  assert.equal(verifications.length, verified ? 1 : 0);
  if (verified) assert.deepEqual(verifications, [{ argumentCount: 2, secret }]);
}

const invalidIdentities = [
  ["all identity aliases missing", {}],
  ["a second missing identity cannot share a synthetic user", { email: "second@example.invalid" }],
  ["all identity aliases null", { sub: null, id: null, userId: null }],
  ["all identity aliases empty", { sub: "", id: "", userId: "" }],
  ["whitespace subject", { sub: " \t\n" }],
  ["object subject", { sub: { id: "hidden" }, id: "must-not-downgrade" }],
  ["array subject", { sub: ["hidden"], id: "must-not-downgrade" }],
  ["boolean subject", { sub: true }],
  ["false without a fallback", { sub: false }],
  ["object id fallback", { id: { value: "hidden" } }],
  ["array userId fallback", { userId: [] }],
  ["boolean userId fallback", { userId: false }],
  ["null JWT payload rejected by the existing verifier", null, 401],
  ["array JWT payload", []],
  ["string JWT payload", "fixture-string"],
  ["number JWT payload", 42],
  ["boolean JWT payload", true],
];
for (const [label, payload, status = 400] of invalidIdentities) {
  test(`rejects ${label} before effects`, async () => {
    const claims = payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? { email: "first@example.invalid", ...payload }
      : payload;
    assertRejected(await invoke(signedPayload(claims)), status,
      status === 401 ? "Invalid SSO token" : "SSO token missing subject (sub)");
  });
}

// sub/id/userId and their selection order are existing route compatibility.
// Preserve finite numeric identities already converted by that route, including
// its existing truthy fallback semantics; never stringify objects or booleans.
const validIdentities = [
  ["subject string", { sub: "subject-123" }, "subject-123"],
  ["id fallback", { id: "legacy-id-123" }, "legacy-id-123"],
  ["userId fallback", { userId: "legacy-user-123" }, "legacy-user-123"],
  ["null subject falls back", { sub: null, id: "legacy-id" }, "legacy-id"],
  ["empty aliases fall back", { sub: "", id: "", userId: "legacy-user" }, "legacy-user"],
  ["subject precedes aliases", { sub: "preferred", id: "other", userId: "last" }, "preferred"],
  ["id precedes userId", { id: "preferred-id", userId: "last" }, "preferred-id"],
  ["opaque identity is not trimmed", { sub: " subject-123 " }, " subject-123 "],
  ["numeric subject compatibility", { sub: 123 }, "123"],
  ["numeric id compatibility", { id: 456 }, "456"],
  ["numeric userId compatibility", { userId: 789 }, "789"],
  ["numeric zero final fallback compatibility", { userId: 0 }, "0"],
  ["existing zero subject fallback order", { sub: 0, id: "fallback" }, "fallback"],
];
for (const [label, claims, expectedId] of validIdentities) {
  test(`valid sign-in preserves ${label}`, async () => {
    const result = await invoke(signedPayload({ ...claims, email: "fixture@example.invalid", name: "Local Fixture" }));
    assert.equal(result.res.statusCode, 200);
    assert.equal(result.res.body.message, "TradeScout SSO login successful");
    assert.deepEqual(upserts, [{
      provider: "tradescout",
      data: { tradescoutId: expectedId, email: "fixture@example.invalid", firstName: "Local", lastName: "Fixture", roles: null },
      userType: "customer",
    }]);
    assert.deepEqual(effects, ["upsert", "resolveReferral", "regenerate", "login", "save"]);
    assert.equal(result.loggedInUser.id, "fixture-user");
    assert.equal(result.loggedInUser.tradescoutId, expectedId);
    assert.deepEqual(result.res.body.user, {
      id: "fixture-user", userType: "customer", email: "fixture@example.invalid", affiliateTag: "fixture-existing-tag",
    });
    assert.deepEqual(verifications, [{ argumentCount: 2, secret }]);
  });
}

test("valid bearer sign-in preserves existing role mapping", async () => {
  const result = await invoke(signedPayload({ sub: "merchant-id", role: "merchant" }), { bearer: true });
  assert.equal(result.res.statusCode, 200);
  assert.equal(upserts[0].userType, "restaurant_owner");
  assert.deepEqual(upserts[0].data.roles, ["merchant"]);
  assert.deepEqual(effects, ["upsert", "resolveReferral", "regenerate", "login", "save"]);
});

test("existing super-admin storage mapping is unchanged", async () => {
  const result = await invoke(signedPayload({ sub: "fixture-admin", roles: ["mealscout_super_admin"] }));
  assert.equal(result.res.statusCode, 200);
  assert.equal(upserts[0].userType, "admin");
  assert.deepEqual(effects, ["upsert", "regenerate", "login", "save"]);
});

const goodToken = signedPayload({ sub: "valid-subject" });
const [goodHeader, , goodSignature] = goodToken.split(".");
const tamperedBody = Buffer.from(JSON.stringify({ sub: "changed-subject" })).toString("base64url");
const unsignedHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
for (const [label, token] of [
  ["wrong signature secret", signedPayload({ sub: "valid-subject" }, "wrong-local-secret")],
  ["tampered payload", `${goodHeader}.${tamperedBody}.${goodSignature}`],
  ["unsigned token", `${unsignedHeader}.${tamperedBody}.`],
  ["expired token", signedPayload({ sub: "valid-subject", exp: 1 })],
  ["malformed token", "not-a-jwt"],
]) {
  test(`preserves 401 for ${label}`, async () => {
    assertRejected(await invoke(token), 401, "Invalid SSO token");
  });
}

test("missing token still fails before verification", async () => {
  assertRejected(await invoke(undefined), 400, "SSO token is required", { verified: false });
});

test("missing configured secret still fails before verification", async () => {
  delete process.env.TRADESCOUT_JWT_SECRET;
  try {
    const { res, loggedInUser } = await invoke(goodToken);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, "TradeScout SSO not configured");
    assert.deepEqual(effects, []);
    assert.equal(loggedInUser, undefined);
    assert.deepEqual(verifications, []);
  } finally {
    process.env.TRADESCOUT_JWT_SECRET = secret;
  }
});
