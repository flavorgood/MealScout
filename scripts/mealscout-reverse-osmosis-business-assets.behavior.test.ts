import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureMealScoutBusinessPost, connectionBindingRevision, verifyMealScoutBusinessAsset,
  type SocialPublishingConnection,
} from "../server/services/reverseOsmosisBusinessAssets";
import type { ProposalInput, Scope } from "@tradescout-infinity/reverse-osmosis";

// Entirely synthetic provider fixtures. No provider calls, customer data or valid credentials.
const scope: Scope = {
  product: "mealscout", tenantId: "mealscout", businessId: "synthetic-restaurant",
  subjectId: "synthetic-restaurant", ownerId: "synthetic-owner", provider: "facebook", accountId: "111111",
};
const proposal: ProposalInput = {
  scope, direction: "social-to-native", eventId: "synthetic-event", sourceVersion: "synthetic-version",
  expectedNativeVersion: "synthetic-native-version", fields: {},
};
function connection(): SocialPublishingConnection {
  return {
    id: "synthetic-connection", restaurantId: scope.businessId, createdByUserId: scope.ownerId,
    platform: "facebook", displayName: "Synthetic fixture only", externalAccountId: scope.accountId,
    externalAccountUrl: null, accessToken: "SYNTHETIC_PAGE_TOKEN_NEVER_REAL", refreshToken: "SYNTHETIC_USER_TOKEN_NEVER_REAL",
    tokenExpiresAt: new Date(Date.now() + 60 * 60_000), scopes: ["pages_read_engagement", "pages_manage_posts"],
    metadata: { provider: "meta", pageId: scope.accountId }, status: "active", lastPublishAt: null,
    lastError: null, createdAt: new Date("2025-01-01T00:00:00Z"), updatedAt: new Date("2025-01-01T00:00:00Z"),
  };
}
function fixtures() {
  return {
    me: { id: scope.accountId, category: "Restaurant", tasks: ["MANAGE", "CREATE_CONTENT"] },
    debug: { data: { is_valid: true, type: "PAGE", profile_id: scope.accountId, app_id: "222222", user_id: "333333",
      scopes: ["pages_read_engagement", "pages_manage_posts"], expires_at: 0, data_access_expires_at: 0,
      granular_scopes: [{ scope: "pages_read_engagement", target_ids: [scope.accountId] }] } },
    post: { id: "111111_444444", from: { id: scope.accountId }, message: "Menu: https://menus.mealscout-fixture.net/current",
      permalink_url: "https://www.facebook.com/111111/posts/444444", is_published: true,
      privacy: { value: "EVERYONE", allow: "", deny: "" }, targeting: {}, feed_targeting: {},
      is_hidden: false, is_expired: false, scheduled_publish_time: null as number | null,
      created_time: "2020-01-01T00:00:00Z", updated_time: "2020-01-01T00:00:00Z" },
    settings: { data: [
      { setting: "IS_PUBLISHED", value: true as unknown },
      { setting: "AGE_RESTRICTIONS", value: "Public" as unknown },
      { setting: "COUNTRY_RESTRICTIONS", value: { restriction_type: "blacklist", countries: [] } as unknown },
    ] },
  };
}
async function mocked<T>(data: ReturnType<typeof fixtures>, action: (calls: URL[]) => Promise<T>, response?: (url: URL) => Response): Promise<T> {
  const originalFetch = globalThis.fetch;
  const oldId = process.env.FACEBOOK_APP_ID;
  const oldSecret = process.env.FACEBOOK_APP_SECRET;
  const calls: URL[] = [];
  process.env.FACEBOOK_APP_ID = "222222";
  process.env.FACEBOOK_APP_SECRET = "SYNTHETIC_APP_SECRET_NEVER_REAL";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    assert.equal(url.origin, "https://graph.facebook.com");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    assert.ok(new Headers(init?.headers).get("authorization")?.startsWith("Bearer "));
    assert.equal(url.searchParams.has("access_token"), false);
    if (response) return response(url);
    const path = url.pathname.split("/").at(-1);
    assert.ok(["me", "debug_token", "111111_444444", "settings"].includes(path || ""), "no all-pages or caller URL request");
    if (path === "settings") assert.equal(url.pathname, "/v24.0/111111/settings");
    const payload = path === "me" ? data.me : path === "debug_token" ? data.debug : path === "settings" ? data.settings : data.post;
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  try { return await action(calls); }
  finally {
    globalThis.fetch = originalFetch;
    if (oldId === undefined) delete process.env.FACEBOOK_APP_ID; else process.env.FACEBOOK_APP_ID = oldId;
    if (oldSecret === undefined) delete process.env.FACEBOOK_APP_SECRET; else process.env.FACEBOOK_APP_SECRET = oldSecret;
  }
}

test("Page evidence is provider-authenticated, exact and bounded", async () => {
  await mocked(fixtures(), async calls => {
    const c = connection();
    const evidence = await verifyMealScoutBusinessAsset(proposal, c, scope.ownerId);
    assert.equal(evidence.providerAssetId, scope.accountId);
    assert.equal(evidence.assetKind, "business-page");
    assert.equal(evidence.bindingRevision, connectionBindingRevision(c, scope.ownerId));
    assert.ok(evidence.expiresAt <= evidence.verifiedAt + 5 * 60_000);
    assert.deepEqual(calls.map(url => url.pathname), ["/v24.0/me", "/v24.0/debug_token"]);
    assert.ok(!JSON.stringify(evidence).includes(c.accessToken!));
  });
});

test("binding hash changes for every authority input and canonicalizes metadata object keys", () => {
  const c = connection(); const initial = connectionBindingRevision(c, scope.ownerId);
  const changes: Partial<SocialPublishingConnection>[] = [
    { id: "different" }, { restaurantId: "different" }, { createdByUserId: "different" },
    { platform: "x" }, { externalAccountId: "999999" }, { updatedAt: new Date("2025-02-01") },
    { status: "revoked" }, { accessToken: "ROTATED_SYNTHETIC_TOKEN" }, { refreshToken: "ROTATED_SYNTHETIC_REFRESH" },
    { scopes: [] }, { metadata: { provider: "meta", pageId: "999999" } },
    { tokenExpiresAt: new Date(Date.now() + 2 * 60 * 60_000) },
  ];
  for (const change of changes) assert.notEqual(connectionBindingRevision({ ...c, ...change }, scope.ownerId), initial);
  assert.notEqual(connectionBindingRevision(c, "new-owner"), initial);
  assert.equal(connectionBindingRevision({ ...c, metadata: { pageId: scope.accountId, provider: "meta" } }, scope.ownerId), initial);
});

test("native scope, ownership, revoked/expired connections and unsupported providers reject before provider calls", async () => {
  await mocked(fixtures(), async calls => {
    for (const c of [
      { ...connection(), createdByUserId: "previous-owner" }, { ...connection(), createdByUserId: null },
      { ...connection(), status: "revoked" }, { ...connection(), accessToken: null },
      { ...connection(), tokenExpiresAt: new Date(0) }, { ...connection(), metadata: { provider: "meta", pageId: "999999" } },
    ]) await assert.rejects(verifyMealScoutBusinessAsset(proposal, c, scope.ownerId));
    for (const platform of ["x", "instagram"]) {
      const c = { ...connection(), platform };
      await assert.rejects(verifyMealScoutBusinessAsset({ ...proposal, scope: { ...scope, provider: platform } }, c, scope.ownerId));
    }
    for (const key of ["product", "tenantId", "businessId", "subjectId", "ownerId", "provider", "accountId"] as const) {
      await assert.rejects(verifyMealScoutBusinessAsset({ ...proposal, scope: { ...scope, [key]: "wrong" } }, connection(), scope.ownerId));
    }
    assert.equal(calls.length, 0);
  });
});

test("personal, wrong Page, unknown authority, invalid grant and wrong app token evidence fails closed", async () => {
  const cases: Array<(f: ReturnType<typeof fixtures>) => void> = [
    f => { f.me.id = "999999"; }, f => { f.me.category = ""; }, f => { f.me.tasks = []; },
    f => { f.me.category = "Public figure"; }, f => { f.me.category = "Personal blog"; },
    f => { f.me.category = "Unclassified"; },
    f => { f.debug.data.type = "USER"; }, f => { f.debug.data.profile_id = "999999"; },
    f => { f.debug.data.is_valid = false; }, f => { f.debug.data.app_id = "999999"; },
    f => { f.debug.data.user_id = ""; }, f => { f.debug.data.scopes = ["public_profile"]; },
    f => { f.debug.data.expires_at = 1; }, f => { f.debug.data.data_access_expires_at = 1; },
    f => { f.debug.data.granular_scopes[0]!.target_ids = ["999999"]; },
  ];
  for (const mutate of cases) {
    const f = fixtures(); mutate(f);
    await mocked(f, () => assert.rejects(verifyMealScoutBusinessAsset(proposal, connection(), scope.ownerId)));
  }
  const f = fixtures(); delete (f.me as Partial<typeof f.me>).tasks;
  await mocked(f, () => assert.rejects(verifyMealScoutBusinessAsset(proposal, connection(), scope.ownerId)));
});

test("outbound requires actual publishing grant and content task", async () => {
  const outbound = { ...proposal, direction: "native-to-social" as const };
  const f = fixtures(); f.me.tasks = ["MANAGE"];
  await mocked(f, () => assert.rejects(verifyMealScoutBusinessAsset(outbound, connection(), scope.ownerId)));
  f.me.tasks = ["MANAGE", "CREATE_CONTENT"]; f.debug.data.scopes = ["pages_read_engagement"];
  await mocked(f, () => assert.rejects(verifyMealScoutBusinessAsset(outbound, connection(), scope.ownerId)));
});

test("outbound verification checks current Page visibility before publishing authority", async () => {
  const outbound = { ...proposal, direction: "native-to-social" as const };
  await mocked(fixtures(), async calls => {
    await verifyMealScoutBusinessAsset(outbound, connection(), scope.ownerId);
    assert.equal(calls.at(-1)!.pathname, "/v24.0/111111/settings");
  });
  for (const index of [0, 1, 2]) {
    const f = fixtures();
    f.settings.data[index]!.value = index === 0 ? false : index === 1 ? "People 18 and over" : { restriction_type: "blacklist", countries: ["US"] };
    await mocked(f, () => assert.rejects(verifyMealScoutBusinessAsset(outbound, connection(), scope.ownerId)));
  }
});

test("exact old undated Page post produces immutable Menu URL capture and body hash", async () => {
  await mocked(fixtures(), async calls => {
    const capture = await captureMealScoutBusinessPost(scope, connection(), scope.ownerId, "111111_444444");
    assert.deepEqual(capture.profile, { menuUrl: "https://menus.mealscout-fixture.net/current" });
    assert.deepEqual(capture.holds, []);
    assert.equal(capture.expiresAt - capture.capturedAt, 24 * 60 * 60_000);
    assert.equal(capture.bodyHash, capture.providerBodyHash);
    assert.notEqual(capture.bodyHash, capture.sourceVersion, "source version also binds Page-level public settings");
    assert.equal(capture.providerCreatedAt, "2020-01-01T00:00:00Z");
    assert.equal(calls.at(-2)!.pathname, "/v24.0/111111_444444");
    assert.equal(calls.at(-1)!.pathname, "/v24.0/111111/settings");
    assert.match(calls.at(-2)!.searchParams.get("fields")!, /privacy,targeting,feed_targeting,is_hidden,is_expired,scheduled_publish_time/);
  });
  const f = fixtures();
  const first = await mocked(f, () => captureMealScoutBusinessPost(scope, connection(), scope.ownerId, "111111_444444"));
  f.post.message += "\nUpdated.";
  const next = await mocked(f, () => captureMealScoutBusinessPost(scope, connection(), scope.ownerId, "111111_444444"));
  assert.notEqual(first.sourceVersion, next.sourceVersion, "root compares exact recapture before apply");
});

test("caller post IDs cannot select another asset or endpoint", async () => {
  await mocked(fixtures(), async calls => {
    for (const id of ["999999_444444", "444444", "me", "111111_444444?fields=access_token", "https://evil.net/post"]) {
      await assert.rejects(captureMealScoutBusinessPost(scope, connection(), scope.ownerId, id));
    }
    assert.equal(calls.length, 0);
  });
});

test("published Page posts without explicit unrestricted public visibility are rejected", async () => {
  const cases: Array<(f: ReturnType<typeof fixtures>) => void> = [
    f => { f.post.privacy.value = "SELF"; }, f => { f.post.privacy.value = "ALL_FRIENDS"; },
    f => { f.post.privacy.value = "CUSTOM"; }, f => { f.post.privacy.allow = "999999"; },
    f => { f.post.privacy.deny = "999999"; }, f => { f.post.privacy = {} as typeof f.post.privacy; },
    f => { f.post.targeting = { countries: ["US"] }; }, f => { f.post.feed_targeting = { age_min: 21 }; },
    f => { f.post.targeting = null as unknown as typeof f.post.targeting; },
    f => { f.post.feed_targeting = [] as unknown as typeof f.post.feed_targeting; },
    f => { f.post.is_hidden = true; }, f => { f.post.is_expired = true; },
    f => { f.post.scheduled_publish_time = Date.now() / 1000 + 60_000; },
    f => { f.post.scheduled_publish_time = 1; },
  ];
  for (const mutate of cases) {
    const f = fixtures(); mutate(f);
    await mocked(f, () => assert.rejects(captureMealScoutBusinessPost(scope, connection(), scope.ownerId, "111111_444444")));
  }
  for (const field of ["privacy", "targeting", "feed_targeting", "is_hidden", "is_expired", "scheduled_publish_time"] as const) {
    const f = fixtures(); delete (f.post as Partial<typeof f.post>)[field];
    await mocked(f, () => assert.rejects(captureMealScoutBusinessPost(scope, connection(), scope.ownerId, "111111_444444")));
  }
});

test("public post on private, restricted, unpublished or unverified Page cannot capture", async () => {
  const cases: Array<(f: ReturnType<typeof fixtures>) => void> = [
    f => { f.settings.data[0]!.value = false; },
    f => { f.settings.data[1]!.value = "People 21 and over"; },
    f => { f.settings.data[1]!.value = null; },
    f => { f.settings.data[2]!.value = { restriction_type: "blacklist", countries: ["US"] }; },
    f => { f.settings.data[2]!.value = { restriction_type: "whitelist", countries: [] }; },
    f => { f.settings.data[2]!.value = { restriction_type: "whitelist", countries: ["US"] }; },
    f => { f.settings.data[2]!.value = {}; }, f => { f.settings.data = []; },
    f => { f.settings.data.pop(); },
    f => { f.settings.data.push({ setting: "AGE_RESTRICTIONS", value: "Public" }); },
    f => { f.settings.data.push({ setting: "UNKNOWN_VISIBILITY_RESTRICTION", value: "none" }); },
  ];
  for (const mutate of cases) {
    const f = fixtures(); mutate(f);
    await mocked(f, () => assert.rejects(captureMealScoutBusinessPost(scope, connection(), scope.ownerId, "111111_444444")));
  }
});

test("source version binds exact raw post body and provider public-proof hash independently", async () => {
  const f = fixtures();
  const first = await mocked(f, () => captureMealScoutBusinessPost(scope, connection(), scope.ownerId, "111111_444444"));
  assert.match(first.publicProofHash, /^[0-9a-f]{64}$/);
  f.settings.data.reverse(); // Even provider raw proof changes preserve conservative exact recapture semantics.
  const changed = await mocked(f, () => captureMealScoutBusinessPost(scope, connection(), scope.ownerId, "111111_444444"));
  assert.equal(first.bodyHash, changed.bodyHash);
  assert.notEqual(first.publicProofHash, changed.publicProofHash);
  assert.notEqual(first.sourceVersion, changed.sourceVersion);
});

test("provider post wrong author/id, unpublished/private/unknown, and invalid timestamps reject", async () => {
  const cases: Array<(f: ReturnType<typeof fixtures>) => void> = [
    f => { f.post.from.id = "999999"; }, f => { f.post.id = "999999_444444"; },
    f => { f.post.is_published = false; }, f => { f.post.updated_time = "not-a-date"; },
    f => { f.post.created_time = "2026-01-01T00:00:00Z"; },
    f => { f.post.permalink_url = "https://evil.net/post"; },
    f => { f.post.message = "x".repeat(16 * 1024 + 1); },
  ];
  for (const mutate of cases) {
    const f = fixtures(); mutate(f);
    await mocked(f, () => assert.rejects(captureMealScoutBusinessPost(scope, connection(), scope.ownerId, "111111_444444")));
  }
});

test("ambiguous, dated, priced, private-event and unsafe URL posts produce holds and no profile edits", async () => {
  for (const message of [
    "Our menu is wonderful https://menus.mealscout-fixture.net/current",
    "Menu: https://menus.mealscout-fixture.net/a\nMenu: https://menus.mealscout-fixture.net/b",
    "Menu: https://menus.mealscout-fixture.net/current\nToday only", "Menu: https://menus.mealscout-fixture.net/current\nValid until 12/31/2026",
    "Menu: https://menus.mealscout-fixture.net/current\n$5 lunch", "Menu: https://menus.mealscout-fixture.net/current\nPrivate wedding event",
    "Menu: https://menus.mealscout-fixture.net/current\nOld menu", "Menu: javascript:alert(1)",
    "Menu: http://127.0.0.1/menu", "Menu: http://localhost/menu", "Menu: http://[::1]/menu",
    "Menu: https://user:password@menus.mealscout-fixture.net/current", "Menu: https://menu.internal/current",
    "Menu: https://menus.mealscout-fixture.net/current?access_token=SYNTHETIC_PRIVATE_TOKEN",
    "Menu: https://menus.mealscout-fixture.net/current\nDo not use this menu",
  ]) {
    const f = fixtures(); f.post.message = message;
    await mocked(f, async () => {
      const capture = await captureMealScoutBusinessPost(scope, connection(), scope.ownerId, "111111_444444");
      assert.deepEqual(capture.profile, {}); assert.ok(capture.holds.length > 0);
    });
  }
});

test("provider errors, redirects, malformed and oversized bodies reject without exposing secrets", async () => {
  for (const make of [
    () => new Response(JSON.stringify({ error: { message: "SYNTHETIC_PAGE_TOKEN_NEVER_REAL" } }), { status: 403 }),
    () => new Response("not json"), () => new Response("[]"),
    () => new Response("x", { headers: { "content-length": "65537" } }),
    () => new Response("x".repeat(65537)),
    () => new Response(JSON.stringify({ error: { message: "SYNTHETIC_PAGE_TOKEN_NEVER_REAL" } })),
    () => new Response(null, { status: 302, headers: { location: "https://evil.net" } }),
  ]) {
    await mocked(fixtures(), () => assert.rejects(verifyMealScoutBusinessAsset(proposal, connection(), scope.ownerId), error => {
      assert.ok(error instanceof Error); assert.ok(!error.message.includes("SYNTHETIC")); return true;
    }), make);
  }
});

test("a connection changing while Meta verification runs cannot mint evidence", async () => {
  const c = connection(); const f = fixtures();
  await mocked(f, () => assert.rejects(verifyMealScoutBusinessAsset(proposal, c, scope.ownerId)), url => {
    const path = url.pathname.split("/").at(-1);
    if (path === "debug_token") c.accessToken = "ROTATED_SYNTHETIC_TOKEN";
    return new Response(JSON.stringify(path === "me" ? f.me : f.debug));
  });
});

test("provider deadline aborts a stalled response-body stream", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await mocked(fixtures(), async () => {
      const pending = verifyMealScoutBusinessAsset(proposal, connection(), scope.ownerId);
      await Promise.resolve(); await Promise.resolve();
      context.mock.timers.tick(10_001);
      await assert.rejects(pending, /reverse-osmosis:provider-timeout/);
    }, () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })));
  } finally { context.mock.timers.reset(); }
});
