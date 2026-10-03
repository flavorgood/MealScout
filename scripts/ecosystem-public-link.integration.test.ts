import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import express from "express";
import { createPublicLinkAuthority, isNativeFoodProfileDestination, type LinkDatabase } from "../server/services/ecosystemPublicLinkAuthority";
import { registerEcosystemPublicLinkRoutes } from "../server/routes/ecosystemPublicLinkRoutes";
import { projectAdmittedRestaurantLink, isNativePublicRestaurant, projectAdmittedFoodProfileLink, canonicalPublicRestaurantProfileEntity } from "../server/publicProfiles/admitPublicRestaurant";

const migration = await readFile(new URL("../migrations/143_ecosystem_public_link_authority.sql", import.meta.url), "utf8");
const sourceRevision = "3b14686ed1cb9b88c502d071513e38cc5774e84d";
const fixtureSql = `CREATE TABLE users (id VARCHAR PRIMARY KEY, is_disabled BOOLEAN DEFAULT false,
  public_profile_settings JSONB DEFAULT '{}', private_email TEXT);
  CREATE TABLE restaurants (id VARCHAR PRIMARY KEY, owner_id VARCHAR NOT NULL REFERENCES users(id),
    name TEXT NOT NULL, is_active BOOLEAN DEFAULT true, business_type TEXT DEFAULT 'restaurant',
    is_food_truck BOOLEAN DEFAULT false, city TEXT, state TEXT, cuisine_type TEXT,
    description TEXT, raw_data JSONB DEFAULT '{}', address TEXT, phone TEXT, email TEXT, website_url TEXT,
    stripe_connect_account_id TEXT, private_notes TEXT);
  CREATE TABLE native_payments (id TEXT PRIMARY KEY, restaurant_id TEXT, amount INTEGER);
  INSERT INTO users VALUES ('native-owner', false, '{}', 'private-owner-canary'),
    ('other-owner', false, '{}', 'other-private-canary');
  INSERT INTO restaurants (id, owner_id, name, city, state, address, phone, stripe_connect_account_id, private_notes)
    VALUES ('meal-one', 'native-owner', 'Cedar Kitchen', 'Nashville', 'TN',
      'Secret Address', 'PRIVATE_PHONE_CANARY', 'PRIVATE_STRIPE_CANARY', 'PRIVATE_NOTE_CANARY');
  INSERT INTO native_payments VALUES ('payment-one', 'meal-one', 1700);`;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "meal-public-authority-"));
  const pg = await PGlite.create(dir);
  await pg.exec(fixtureSql);
  await pg.exec(migration);
  const database: LinkDatabase = {
    query: (sql, params) => pg.query(sql, params),
    transaction: action => pg.transaction(tx => action(tx)),
  };
  const authority = createPublicLinkAuthority(database, { sourceRevision });
  return { dir, pg, database, authority };
}
const approval = (preview: any) => ({ generationId: preview.generationId,
  nativeRevision: preview.nativeRevision, authorityRevision: preview.authorityRevision,
  contentDigest: preview.contentDigest });
const revocation = (preview: any) => ({ generationId: preview.generationId,
  authorityRevision: preview.authorityRevision });
async function approve(f: Awaited<ReturnType<typeof fixture>>) {
  return f.authority.approve("meal-one", "native-owner", approval(await f.authority.getOwnerPreview("meal-one", "native-owner")));
}

test("real Postgres migration is repeatable; approval and revocation survive disk restart", async () => {
  const f = await fixture();
  try {
    const before = await f.authority.getOwnerPreview("meal-one", "native-owner");
    assert.equal(before.state, "unapproved");
    assert.equal(await f.authority.readPublicLink(before.publicTenantId, "meal-one"), null);
    const granted = await approve(f);
    const link = await f.authority.readPublicLink(granted.publicTenantId, "meal-one");
    assert.equal(link?.publicLabel, "Cedar Kitchen");
    assert.equal(link?.canonicalUrl, "https://www.mealscout.us/restaurant/cedar-kitchen--meal-one");
    assert.doesNotMatch(JSON.stringify(link), /PRIVATE_|private-owner|native-owner|ownerId|phone|stripe|address/i);
    await f.pg.exec(migration);
    assert.equal((await f.authority.getOwnerPreview("meal-one", "native-owner")).state, "approved");
    await f.pg.close();
    const reopened = await PGlite.create(f.dir);
    try {
      const authority = createPublicLinkAuthority({ query: (sql, params) => reopened.query(sql, params),
        transaction: action => reopened.transaction(tx => action(tx)) }, { sourceRevision });
      assert.equal((await authority.readPublicLink(granted.publicTenantId, "meal-one"))?.publicLabel, "Cedar Kitchen");
      await authority.revoke("meal-one", "native-owner", revocation(granted));
      const audit = await reopened.query("SELECT state, approval_owner_id FROM mealscout_public_link_authority_events ORDER BY event_id");
      assert.deepEqual(audit.rows.map((row: any) => row.state), ["unapproved", "approved", "revoked"]);
      assert.equal(audit.rows[1].approval_owner_id, "native-owner");
    } finally { await reopened.close(); }
    const again = await PGlite.create(f.dir);
    try { assert.equal((await again.query("SELECT state FROM mealscout_public_link_authority")).rows[0].state, "revoked"); }
    finally { await again.close(); }
  } finally { if (!f.pg.closed) await f.pg.close(); }
});

test("current actual native owner alone may approve; strict body rejects forged scope/admin/tenant", async () => {
  const f = await fixture();
  try {
    const preview = await f.authority.getOwnerPreview("meal-one", "native-owner");
    await assert.rejects(f.authority.getOwnerPreview("meal-one", "other-owner"), (e: any) => e.status === 403);
    await assert.rejects(f.authority.approve("meal-one", "other-owner", approval(preview)), (e: any) => e.status === 403);
    await assert.rejects(f.authority.approve("meal-one", "native-owner", { ...approval(preview), scope: "admin", tenantId: "other", ownerId: "other-owner" }));
    assert.equal((await f.authority.getOwnerPreview("meal-one", "native-owner")).state, "unapproved");
  } finally { await f.pg.close(); }
});

test("approval is compare-and-set: concurrent same-preview grants permit one; stale digest rejects", async () => {
  const f = await fixture();
  try {
    const preview = await f.authority.getOwnerPreview("meal-one", "native-owner");
    const outcomes = await Promise.allSettled([f.authority.approve("meal-one", "native-owner", approval(preview)),
      f.authority.approve("meal-one", "native-owner", approval(preview))]);
    assert.equal(outcomes.filter(v => v.status === "fulfilled").length, 1);
    assert.equal((outcomes.find(v => v.status === "rejected") as PromiseRejectedResult).reason.status, 409);
    await f.pg.query("UPDATE restaurants SET name = 'Cedar Supper' WHERE id = 'meal-one'");
    await assert.rejects(f.authority.approve("meal-one", "native-owner", approval(preview)), (e: any) => e.status === 409);
    assert.equal(await f.authority.readPublicLink(preview.publicTenantId, "meal-one"), null);
  } finally { await f.pg.close(); }
});

test("native disable/re-enable, owner disable/re-enable, ownership transfer and recreation cannot revive approval", async () => {
  const f = await fixture();
  try {
    let grant = await approve(f);
    await f.pg.query("UPDATE restaurants SET is_active = false WHERE id = 'meal-one'");
    await f.pg.query("UPDATE restaurants SET is_active = true WHERE id = 'meal-one'");
    assert.equal(await f.authority.readPublicLink(grant.publicTenantId, "meal-one"), null);
    grant = await approve(f);
    await f.pg.query("UPDATE users SET is_disabled = true WHERE id = 'native-owner'");
    await f.pg.query("UPDATE users SET is_disabled = false WHERE id = 'native-owner'");
    assert.equal(await f.authority.readPublicLink(grant.publicTenantId, "meal-one"), null);
    grant = await approve(f);
    await f.pg.query("UPDATE restaurants SET owner_id = 'other-owner' WHERE id = 'meal-one'");
    const transferred = await f.authority.getOwnerPreview("meal-one", "other-owner");
    assert.notEqual(transferred.generationId, grant.generationId);
    assert.notEqual(transferred.publicTenantId, grant.publicTenantId);
    await assert.rejects(f.authority.revoke("meal-one", "native-owner", revocation(grant)), (e: any) => e.status === 403);
    await f.pg.query("DELETE FROM restaurants WHERE id = 'meal-one'");
    assert.equal((await f.pg.query("SELECT state FROM mealscout_public_link_authority WHERE source_id='meal-one'")).rows[0].state, "deleted");
    await f.pg.query("INSERT INTO restaurants (id,owner_id,name,city,state) VALUES ('meal-one','native-owner','Cedar Kitchen','Nashville','TN')");
    const recreated = await f.authority.getOwnerPreview("meal-one", "native-owner");
    assert.notEqual(recreated.generationId, transferred.generationId);
    assert.equal(await f.authority.readPublicLink(grant.publicTenantId, "meal-one"), null);
    await assert.rejects(f.authority.approve("meal-one", "native-owner", approval(grant)), (e: any) => e.status === 409);
  } finally { await f.pg.close(); }
});

test("native public owner settings revoke exports; quarantined public profiles stay admitted and redacted", async () => {
  const f = await fixture();
  try {
    const grant = await approve(f);
    await f.pg.query("UPDATE users SET public_profile_settings = '{\"showContact\":false}' WHERE id='native-owner'");
    assert.equal(await f.authority.readPublicLink(grant.publicTenantId, "meal-one"), null);
    await f.pg.query("UPDATE restaurants SET raw_data = '{\"evidenceQuarantine\":{\"active\":true}}' WHERE id='meal-one'");
    const row = (await f.pg.query("SELECT * FROM restaurants WHERE id='meal-one'")).rows[0] as any;
    const native = projectAdmittedRestaurantLink({ ...row, ownerId: row.owner_id,
      isActive: row.is_active, businessType: row.business_type, isFoodTruck: row.is_food_truck, rawData: row.raw_data },
      { id: "native-owner", isDisabled: false, publicProfileSettings: {} });
    assert.ok(native);
    assert.equal(native.dto.phonePublic, null);
    assert.equal((await f.authority.getOwnerPreview("meal-one", "native-owner")).eligible, false);
    await assert.rejects(approve(f), (e: any) => e.status === 409);
  } finally { await f.pg.close(); }
});

test("expiry, mismatched partition, unsafe native IDs and fresh snapshot deadline fail closed", async () => {
  const f = await fixture();
  try {
    const grant = await approve(f);
    assert.equal(await f.authority.readPublicLink("f".repeat(32), "meal-one"), null);
    assert.equal(await f.authority.readPublicLink(grant.publicTenantId, "../meal-one"), null);
    const expired = createPublicLinkAuthority(f.database, { sourceRevision, nowMs: () => Date.now() + 8 * 86400000 });
    assert.equal(await expired.readPublicLink(grant.publicTenantId, "meal-one"), null);
    const slow = createPublicLinkAuthority({ ...f.database, async query(sql, params) {
      const result = await f.database.query(sql, params);
      await new Promise(resolve => setTimeout(resolve, 1050));
      return result;
    } }, { sourceRevision });
    assert.equal(await slow.readPublicLink(grant.publicTenantId, "meal-one"), null);
  } finally { await f.pg.close(); }
});

test("Postgres constraints reject approved-null fields and bigint counters retain exact precision", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.pg.query("UPDATE mealscout_public_link_authority SET state='approved' WHERE source_id='meal-one'"));
    await f.pg.query("UPDATE mealscout_public_link_authority SET native_revision=9007199254740993, authority_revision=9007199254740993 WHERE source_id='meal-one'");
    const preview = await f.authority.getOwnerPreview("meal-one", "native-owner");
    assert.equal(preview.nativeRevision, "9007199254740993");
    const grant = await approve(f);
    assert.equal(grant.authorityRevision, "9007199254740994");
    assert.ok((await f.authority.readPublicLink(grant.publicTenantId, "meal-one"))?.publicationRevision.includes("_a9007199254740994"));
  } finally { await f.pg.close(); }
});

test("native canonical type/visibility admission is preserved; ambiguous IDs cannot be approved for export", async () => {
  const f = await fixture();
  try {
    for (const fields of [{ isActive: false }, { name: "Test Restaurant" },
      { businessType: "bar" }, { isFoodTruck: true }, { businessType: "private_chef" }]) {
      assert.equal(isNativePublicRestaurant({ id: "meal-one", name: "Cedar Kitchen",
        isActive: true, businessType: "restaurant", ...fields }), false);
    }
    await f.pg.query("INSERT INTO restaurants (id,owner_id,name,city,state) VALUES ('other--meal-one','native-owner','Cedar Kitchen','Nashville','TN')");
    const ambiguous = await f.authority.getOwnerPreview("other--meal-one", "native-owner");
    assert.equal(ambiguous.eligible, false);
    await assert.rejects(f.authority.approve("other--meal-one", "native-owner", approval(ambiguous)), (e: any) => e.status === 409);
  } finally { await f.pg.close(); }
});

test("quarantine identity anchor removal and restoration never revives an old approval", async () => {
  const f = await fixture();
  try {
    const anchors = [
      { column: "phone", extracted: "phone", initial: "6151112222", changed: "6153334444" },
      { column: "email", extracted: "email", initial: "owner@example.invalid", changed: "other@example.invalid" },
      { column: "website_url", extracted: "website", initial: "https://cedar.example.invalid", changed: "https://other.example.invalid" },
      { column: "address", extracted: "address", initial: "11 Cedar Way", changed: "55 Ocean Way" },
    ];
    for (const anchor of anchors) {
      await f.pg.query("UPDATE restaurants SET phone=NULL,email=NULL,website_url=NULL,address=NULL,city=NULL,state=NULL WHERE id='meal-one'");
      await f.pg.query(`UPDATE restaurants SET ${anchor.column}=$1, raw_data=$2 WHERE id='meal-one'`,
        [anchor.initial, JSON.stringify({ evidenceIngest: { extracted: { business_name: "Ocean Palace", [anchor.extracted]: anchor.initial } } })]);
      const grant = await approve(f);
      await f.pg.query(`UPDATE restaurants SET ${anchor.column}=$1 WHERE id='meal-one'`, [anchor.changed]);
      const withdrawn = await f.authority.getOwnerPreview("meal-one", "native-owner");
      assert.equal(withdrawn.eligible, false, anchor.column);
      assert.equal(withdrawn.state, "revoked", anchor.column);
      await f.pg.query(`UPDATE restaurants SET ${anchor.column}=$1 WHERE id='meal-one'`, [anchor.initial]);
      const restored = await f.authority.getOwnerPreview("meal-one", "native-owner");
      assert.equal(restored.eligible, true, anchor.column);
      assert.equal(restored.state, "revoked", anchor.column);
      assert.notEqual(restored.nativeRevision, grant.nativeRevision);
      assert.equal(await f.authority.readPublicLink(grant.publicTenantId, "meal-one"), null);
      await assert.rejects(f.authority.approve("meal-one", "native-owner", approval(grant)), (e: any) => e.status === 409);
    }
  } finally { await f.pg.close(); }
});

test("under-budget executor delay cannot renew the snapshot freshness budget", async () => {
  const f = await fixture();
  try {
    const grant = await approve(f);
    let statementStartedAt = 0;
    const delayed = createPublicLinkAuthority({ ...f.database, async query(sql, params) {
      statementStartedAt = Date.now();
      return f.pg.query(`WITH snapshot AS MATERIALIZED (${sql}),
        delay AS MATERIALIZED (SELECT pg_sleep(0.65))
        SELECT snapshot.*,clock_timestamp() AS read_at FROM snapshot CROSS JOIN delay`, params);
    } }, { sourceRevision });
    const link = await delayed.readPublicLink(grant.publicTenantId, "meal-one");
    assert.ok(link);
    // Even a late clock expression from a provider cannot refresh a view's life.
    assert.ok(Date.parse(link.expiresAt) <= statementStartedAt + 1000);
    assert.ok(Date.parse(link.expiresAt) - Date.now() < 500);
  } finally { await f.pg.close(); }
});

test("ownership transfer between precheck and owner/restaurant locks is rejected after the native lock", async () => {
  const f = await fixture();
  try {
    const preview = await f.authority.getOwnerPreview("meal-one", "native-owner");
    const events: string[] = [];
    const raced = createPublicLinkAuthority({ ...f.database, transaction: action => f.pg.transaction(tx => action({
      async query(sql, params) {
        if (sql.includes("FROM users") && sql.includes("FOR SHARE")) {
          events.push("owner-share");
          await tx.query("UPDATE restaurants SET owner_id='other-owner' WHERE id='meal-one'");
        }
        if (sql.includes("FROM restaurants") && sql.includes("FOR UPDATE")) events.push("restaurant-update");
        return tx.query(sql, params);
      },
    })) }, { sourceRevision });
    await assert.rejects(raced.approve("meal-one", "native-owner", approval(preview)), (e: any) => e.status === 403);
    assert.deepEqual(events, ["owner-share", "restaurant-update"]);
    assert.equal((await f.authority.getOwnerPreview("meal-one", "native-owner")).state, "unapproved");
  } finally { await f.pg.close(); }
});

test("actual native140 owner and source triggers acquire restaurant dependencies before optional authority", async () => {
  const f = await fixture();
  try {
    await f.pg.exec(`ALTER TABLE users ADD COLUMN email TEXT, ADD COLUMN email_verified BOOLEAN;
      ALTER TABLE restaurants ADD COLUMN ordering_authority_version INTEGER DEFAULT 0;
      CREATE TABLE hosts(id VARCHAR, user_id VARCHAR);
      CREATE TABLE events(id VARCHAR, host_id VARCHAR);
      CREATE TABLE event_bookings(event_id VARCHAR, truck_id VARCHAR);
      INSERT INTO restaurants (id,owner_id,name,city,state) VALUES
        ('meal-two','native-owner','Second Kitchen','Nashville','TN'),
        ('host-linked','other-owner','Host Kitchen','Nashville','TN');
      INSERT INTO hosts VALUES ('host-one','native-owner');
      INSERT INTO events VALUES ('event-one','host-one');
      INSERT INTO event_bookings VALUES ('event-one','host-linked');`);
    const native140 = await readFile(new URL("../migrations/140_restaurant_ordering_authority_version.sql", import.meta.url), "utf8");
    const start = native140.indexOf("CREATE OR REPLACE FUNCTION mealscout_owner_ordering_authority_after_update()");
    const end = native140.indexOf("CREATE OR REPLACE FUNCTION mealscout_direct_restaurant_dependency_authority()", start);
    assert.ok(start >= 0 && end > start);
    // Execute the real native function and trigger, not a rewritten simulation.
    await f.pg.exec(native140.slice(start, end));
    await f.pg.exec(`CREATE TABLE native_lock_trace(seq SERIAL,kind TEXT,source_id TEXT);
      CREATE FUNCTION native_trace_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO native_lock_trace(kind,source_id) VALUES(TG_TABLE_NAME,
          COALESCE(to_jsonb(NEW)->>'id',to_jsonb(NEW)->>'source_id'));
        RETURN NEW; END $$;
      CREATE TRIGGER native_trace BEFORE UPDATE ON restaurants FOR EACH ROW EXECUTE FUNCTION native_trace_update();
      CREATE TRIGGER native_trace BEFORE UPDATE ON mealscout_public_link_authority FOR EACH ROW EXECUTE FUNCTION native_trace_update();`);
    await f.pg.exec(migration);
    const triggers = await f.pg.query<{ tgname: string }>("SELECT tgname FROM pg_trigger WHERE tgrelid='users'::regclass AND NOT tgisinternal ORDER BY tgname");
    assert.deepEqual(triggers.rows.map(row => row.tgname),
      ["trigger_owner_ordering_authority_after_update", "zz_mealscout_public_link_owner"]);
    const grant = await approve(f);
    await f.pg.exec("TRUNCATE native_lock_trace");
    await f.pg.query("UPDATE users SET is_disabled=true WHERE id='native-owner'");
    const owner = (await f.pg.query<{ kind: string; source_id: string }>("SELECT kind,source_id FROM native_lock_trace ORDER BY seq")).rows;
    const firstAuthority = owner.findIndex(row => row.kind === "mealscout_public_link_authority");
    assert.equal(firstAuthority, 3);
    assert.deepEqual(owner.slice(0, firstAuthority).map(row => row.source_id).sort(), ["host-linked", "meal-one", "meal-two"]);
    assert.ok(owner.slice(firstAuthority).every(row => row.kind === "mealscout_public_link_authority"));
    assert.equal(await f.authority.readPublicLink(grant.publicTenantId, "meal-one"), null);
    await f.pg.exec("TRUNCATE native_lock_trace");
    await f.pg.query("UPDATE restaurants SET name='Changed Host Kitchen' WHERE id='host-linked'");
    const source = (await f.pg.query<{ kind: string }>("SELECT kind FROM native_lock_trace ORDER BY seq")).rows;
    assert.deepEqual(source.map(row => row.kind), ["restaurants", "mealscout_public_link_authority"]);
    assert.equal((await f.pg.query<{ ordering_authority_version: number }>("SELECT ordering_authority_version FROM restaurants WHERE id='host-linked'")).rows[0].ordering_authority_version, 1);
  } finally { await f.pg.close(); }
});

test("actual native API registration: anonymous/other-owner isolation, approved GET, revoke, feature-off and source outage", async () => {
  const f = await fixture();
  let enabled = true;
  const app = express();
  app.use(express.json());
  const auth: express.RequestHandler = (req, res, next) => {
    const userId = req.headers["x-fixture-user"];
    if (!userId) return res.sendStatus(401);
    req.user = { id: String(userId) }; next();
  };
  // Fixture identities exercise the route's supplied native-session seam.
  // Production uses its existing session middleware + global Origin CSRF gate.
  registerEcosystemPublicLinkRoutes(app, { authority: f.authority, isAuthenticated: auth, enabled: () => enabled });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const ownerPath = "/api/owner/ecosystem-links/meal-one";
  try {
    assert.equal((await fetch(base + ownerPath)).status, 401);
    assert.equal((await fetch(base + ownerPath, { headers: { "x-fixture-user": "other-owner" } })).status, 403);
    const previewResponse = await fetch(base + ownerPath, { headers: { "x-fixture-user": "native-owner" } });
    assert.equal(previewResponse.headers.get("cache-control"), "no-store");
    const preview = await previewResponse.json();
    const approvedResponse = await fetch(base + ownerPath + "/approve", { method: "POST",
      headers: { "x-fixture-user": "native-owner", "content-type": "application/json" }, body: JSON.stringify(approval(preview)) });
    assert.equal(approvedResponse.status, 200, await approvedResponse.clone().text());
    const grant = await approvedResponse.json();
    const publicPath = `/api/ecosystem/public-links/${grant.publicTenantId}/meal-one`;
    assert.equal((await fetch(base + publicPath)).status, 200);
    const nativeBefore = await f.pg.query("SELECT * FROM native_payments");
    const revokeResponse = await fetch(base + ownerPath + "/revoke", { method: "POST",
      headers: { "x-fixture-user": "native-owner", "content-type": "application/json" }, body: JSON.stringify(revocation(grant)) });
    assert.equal(revokeResponse.status, 200);
    assert.equal((await fetch(base + publicPath)).status, 404);
    assert.deepEqual((await f.pg.query("SELECT * FROM native_payments")).rows, nativeBefore.rows);
    enabled = false;
    assert.equal((await fetch(base + publicPath)).status, 503);
    const row = (await f.pg.query("SELECT * FROM restaurants WHERE id='meal-one'")).rows[0] as any;
    assert.equal(isNativePublicRestaurant({ ...row, isActive: row.is_active, businessType: row.business_type }), true);
    enabled = true;
    await f.pg.close();
    assert.equal((await fetch(base + publicPath)).status, 503);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (!f.pg.closed) await f.pg.close();
  }
});

test("five native food profiles voluntarily approve with matching types; grants fail closed on native changes", async () => {
  const f = await fixture();
  try {
    // These are synthetic database owners and profiles, never customer identity evidence.
    const types = ["restaurant", "truck", "bar", "caterer", "private_chef"] as const;
    for (const type of types) {
      const id = `fixture-${type.replace("_", "-")}`;
      const businessType = type === "truck" ? "food_truck" : type;
      await f.pg.query("INSERT INTO restaurants(id,owner_id,name,business_type,address,phone,private_notes) VALUES($1,'native-owner','Cedar Kitchen',$2,'PRIVATE_ADDRESS','PRIVATE_PHONE','PRIVATE_NOTES')", [id, businessType]);
      const native = () => projectAdmittedFoodProfileLink({ id, ownerId: "native-owner", name: "Cedar Kitchen", isActive: true, businessType, address: "PRIVATE_ADDRESS", phone: "PRIVATE_PHONE" }, { id: "native-owner", isDisabled: false, publicProfileSettings: { showContact: false, showAddress: false } });
      assert.equal(native()?.dto.profileType, type);
      assert.equal(native()?.dto.seo.entityType, type);
      assert.equal(native()?.dto.phonePublic, null);
      assert.equal(native()?.dto.addressPublicLabel, null);
      if (type !== "restaurant") assert.equal(projectAdmittedRestaurantLink({ id, ownerId: "native-owner", name: "Cedar Kitchen", isActive: true, businessType }, { id: "native-owner", isDisabled: false }), null);
      const preview = await f.authority.getOwnerPreview(id, "native-owner");
      assert.equal(preview.eligible, true, type);
      assert.equal(await f.authority.readPublicLink(preview.publicTenantId, id), null);
      await assert.rejects(f.authority.approve(id, "other-owner", approval(preview)), (e: any) => e.status === 403);
      const grant = await f.authority.approve(id, "native-owner", approval(preview));
      const link = await f.authority.readPublicLink(grant.publicTenantId, id);
      const prefix = type === "private_chef" ? "private-chef" : type;
      assert.equal(link?.canonicalUrl, `https://www.mealscout.us/${prefix}/cedar-kitchen--${id}`);
      assert.doesNotMatch(JSON.stringify(link), /PRIVATE_|ownerId|phone|address|private_notes/);
      assert.equal(isNativeFoodProfileDestination(link!.canonicalUrl, id, type), true);
      for (const other of types.filter(value => value !== type)) assert.equal(isNativeFoodProfileDestination(link!.canonicalUrl, id, other), false);
      for (const bad of [link!.canonicalUrl + "?q=1", link!.canonicalUrl + "#hash", link!.canonicalUrl.replace("www.mealscout", "mealscout"), link!.canonicalUrl.replace("https://", "https://user@"), link!.canonicalUrl.replace("cedar-kitchen", "%63edar-kitchen"), link!.canonicalUrl.replace(`/${prefix}/`, `/${prefix}//`), link!.canonicalUrl.replace(`/${prefix}/`, `/restaurant/../${prefix}/`), link!.canonicalUrl.replace(id, "other-id")]) assert.equal(isNativeFoodProfileDestination(bad, id, type), false, bad);
      const expiry = createPublicLinkAuthority(f.database, { sourceRevision, nowMs: () => Date.now() + 8 * 86400000 });
      assert.equal(await expiry.readPublicLink(grant.publicTenantId, id), null);
      await f.pg.query("UPDATE restaurants SET raw_data='{\"evidenceQuarantine\":{\"active\":true}}' WHERE id=$1", [id]);
      assert.equal((await f.authority.getOwnerPreview(id, "native-owner")).eligible, false);
      assert.equal(await f.authority.readPublicLink(grant.publicTenantId, id), null);
      await f.pg.query("UPDATE restaurants SET raw_data='{}' WHERE id=$1", [id]);
      assert.equal(await f.authority.readPublicLink(grant.publicTenantId, id), null);
      const fresh = await f.authority.approve(id, "native-owner", approval(await f.authority.getOwnerPreview(id, "native-owner")));
      await f.pg.query("UPDATE restaurants SET business_type=$2 WHERE id=$1", [id, type === "restaurant" ? "bar" : "restaurant"]);
      assert.equal(await f.authority.readPublicLink(fresh.publicTenantId, id), null);
      await assert.rejects(f.authority.approve(id, "native-owner", approval(fresh)), (e: any) => e.status === 409);
      const retyped = await f.authority.approve(id, "native-owner", approval(await f.authority.getOwnerPreview(id, "native-owner")));
      assert.ok((await f.authority.readPublicLink(retyped.publicTenantId, id))?.canonicalUrl.includes(type === "restaurant" ? "/bar/" : "/restaurant/"));
      await f.pg.query("UPDATE users SET is_disabled=true WHERE id='native-owner'");
      assert.equal(await f.authority.readPublicLink(retyped.publicTenantId, id), null);
      await f.pg.query("UPDATE users SET is_disabled=false WHERE id='native-owner'");
      const enabled = await f.authority.approve(id, "native-owner", approval(await f.authority.getOwnerPreview(id, "native-owner")));
      await f.pg.query("UPDATE restaurants SET owner_id='other-owner' WHERE id=$1", [id]);
      assert.equal(await f.authority.readPublicLink(enabled.publicTenantId, id), null);
      const transferred = await f.authority.getOwnerPreview(id, "other-owner");
      assert.notEqual(transferred.generationId, enabled.generationId);
      await f.pg.query("UPDATE restaurants SET is_active=false WHERE id=$1", [id]);
      assert.equal((await f.authority.getOwnerPreview(id, "other-owner")).eligible, false);
    }
    for (const businessType of ["food_truck", "truck", "food-truck", "foodtruck", "mobile_food_vendor"]) assert.equal(canonicalPublicRestaurantProfileEntity({ businessType }), "truck");
    for (const businessType of ["bar", "brewery", "taproom", "brewery_taproom", "nightlife", "venue"]) assert.equal(canonicalPublicRestaurantProfileEntity({ businessType }), "bar");
    assert.equal(canonicalPublicRestaurantProfileEntity({ businessType: "private_chef", isFoodTruck: true }), "truck");
    for (const businessType of ["host_venue", "supplier", "event", "location"]) assert.equal(canonicalPublicRestaurantProfileEntity({ businessType }), null);
    assert.equal(projectAdmittedFoodProfileLink({ id: "hidden", ownerId: "native-owner", name: "Test Restaurant", isActive: true, businessType: "truck" }, { id: "native-owner", isDisabled: false }), null);
  } finally { await f.pg.close(); }
});
