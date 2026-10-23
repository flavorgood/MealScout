import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hostPartnerEmailClaims,
  hostPartnerLeads,
  hostPartnerLeadSequenceSends,
} from "../shared/schema/legacy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..");
const require = createRequire(join(source, "package.json"));
const { Client, Pool } = require("pg");
const { drizzle } = require("drizzle-orm/node-postgres");
const orm = require("drizzle-orm");
const ts = require("typescript");
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
const hash = (data) => createHash("sha256").update(data).digest("hex");
const authoredMagnet = readFileSync(join(source, "server/services/hostPartnerLeadMagnet.ts"), "utf8");
const authoredDrip = readFileSync(join(source, "server/services/hostPartnerLeadDrip.ts"), "utf8");
const migration087 = readFileSync(join(source, "migrations/087_host_partner_leads.sql"), "utf8");
const migration143 = readFileSync(join(source, "migrations/143_host_partner_email_claims.sql"), "utf8");
const database = `mealscout_claim_${Date.now()}`;
const adminUrl = process.env.MEALSCOUT_HOST_CLAIM_TEST_ADMIN_URL;
if (!adminUrl) throw new Error("MEALSCOUT_HOST_CLAIM_TEST_ADMIN_URL is required for a disposable local PostgreSQL instance");
const parsedAdminUrl = new URL(adminUrl);
if (!['localhost', '127.0.0.1', '[::1]'].includes(parsedAdminUrl.hostname)) {
  throw new Error("Host claim integration test only permits local PostgreSQL");
}
if (parsedAdminUrl.pathname !== '/postgres') {
  throw new Error("Host claim integration test requires the local postgres maintenance database");
}
const adminConfig = {
  host: parsedAdminUrl.hostname,
  port: Number(parsedAdminUrl.port || 5432),
  user: decodeURIComponent(parsedAdminUrl.username),
  password: decodeURIComponent(parsedAdminUrl.password),
  database: "postgres",
  ssl: false,
};
const admin = new Client(adminConfig);
await admin.connect();
let pool;
try {
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.query(`ALTER DATABASE ${database} SET timezone TO 'America/Chicago'`);
  pool = new Pool({ ...adminConfig, database });
  assert.equal((await pool.query("SHOW timezone")).rows[0].TimeZone, "America/Chicago");
  await pool.query(migration087);

  // Historic duplicate addresses and a possibly false-positive Step 2 marker
  // must migrate without dropping either lead or claiming Step 2 acceptance.
  const historicRows = await pool.query(`
    INSERT INTO host_partner_leads(email,business_name,location_type)
    VALUES ('History+host@example.invalid','Historic A','office'),
           (' history+host@example.invalid ','Historic B','office')
    RETURNING id
  `);
  await pool.query(
    `INSERT INTO host_partner_lead_sequence_sends(lead_id,sequence,step,sent_at)
     VALUES ($1,'host_partner_v1',1,now()-interval '2 days'),
            ($2,'host_partner_v1',1,now()-interval '2 days'),
            ($1,'host_partner_v1',2,now()-interval '1 day')`,
    [historicRows.rows[0].id, historicRows.rows[1].id],
  );

  // A recent duplicate must not inherit an older lead's accepted Step 1 time.
  // Without a lead-ID predicate, the cron would send Step 2 for the recent row.
  const oldAndRecent = await pool.query(`
    INSERT INTO host_partner_leads(email,business_name,location_type,created_at)
    VALUES ('duplicate+host@example.invalid','Old host','office',now()-interval '60 days'),
           ('DUPLICATE+host@example.invalid','Recent duplicate','office',now())
    RETURNING id
  `);
  await pool.query(
    `INSERT INTO host_partner_lead_sequence_sends(lead_id,sequence,step,sent_at)
     VALUES ($1,'host_partner_v1',1,now()-interval '6 days')`,
    [oldAndRecent.rows[0].id],
  );
  await pool.query(migration143);
  await pool.query(migration143);
  const historicClaims = await pool.query(
    "SELECT step,status,accepted_at FROM host_partner_email_claims WHERE email_normalized='history+host@example.invalid' ORDER BY step",
  );
  assert.equal(historicClaims.rowCount, 2);
  assert.equal(historicClaims.rows[0].status, "accepted");
  assert(historicClaims.rows[0].accepted_at);
  assert.equal(historicClaims.rows[1].status, "pending");
  assert.equal(historicClaims.rows[1].accepted_at, null);
  const duplicateClaim = await pool.query(
    "SELECT lead_id,status FROM host_partner_email_claims WHERE email_normalized='duplicate+host@example.invalid' AND step=1",
  );
  assert.equal(duplicateClaim.rows[0].lead_id, oldAndRecent.rows[0].id);
  assert.equal(duplicateClaim.rows[0].status, "accepted");

  const db = drizzle({ client: pool, schema: { hostPartnerLeads, hostPartnerLeadSequenceSends, hostPartnerEmailClaims } });
  const emails = [];
  const gates = new Map();
  const emailService = {
    sendBasicEmail: async (to, subject, _html, _text, category) => {
      assert(to.endsWith("@example.invalid"));
      emails.push({ to, subject, category });
      const gate = gates.get(to);
      if (gate && emails.filter((entry) => entry.to === to).length === 1) {
        gate.enter();
        await gate.wait;
      }
      if (to.startsWith("unknown+")) throw new Error("PRIVATE_PROVIDER_AMBIGUITY");
      if (to.startsWith("false+")) return false;
      if (category === "marketing" && to.startsWith("dripunknown+")) throw new Error("PRIVATE_PROVIDER_AMBIGUITY");
      if (category === "marketing" && to.startsWith("dripfalse+")) return false;
      return true;
    },
  };
  const logs = [];
  const mockConsole = { error: (message) => logs.push(String(message)) };
  const isolatedProcess = { env: { HOST_PARTNER_LEADS_ENABLED: "true", HOST_PARTNER_DRIP_ENABLED: "true", PUBLIC_BASE_URL: "http://127.0.0.1:5200" } };
  const compile = (sourceText, imports) => {
    const compiled = ts.transpileModule(sourceText, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    assert.equal((compiled.diagnostics || []).filter((item) => item.category === ts.DiagnosticCategory.Error).length, 0);
    const module = { exports: {} };
    new Function("module", "exports", "require", "process", "console", compiled.outputText)(
      module, module.exports,
      (name) => { assert(Object.hasOwn(imports, name), `Unexpected import ${name}`); return imports[name]; },
      isolatedProcess, mockConsole,
    );
    return module.exports;
  };
  const common = {
    "drizzle-orm": orm,
    "../db": { db },
    "../emailService": { emailService },
    "@shared/schema": { hostPartnerLeads, hostPartnerLeadSequenceSends, hostPartnerEmailClaims },
  };
  const magnet = compile(authoredMagnet, { ...common, zod: require("zod") });
  const drip = compile(authoredDrip, { ...common, "./hostPartnerLeadMagnet": magnet });
  const submit = magnet.handleHostPartnerLeadRequest;
  const base = { firstName: "Fixture", businessName: "Synthetic host", locationType: "office", source: "native_claim_proof", ip: "127.0.0.1", userAgent: "Native claim proof" };
  const gateFor = (email) => {
    let enter;
    let release;
    const entered = new Promise((resolve) => { enter = resolve; });
    const wait = new Promise((resolve) => { release = resolve; });
    gates.set(email, { enter, wait });
    return { entered, release };
  };
  const timeout = (promise) => Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Concurrent intake did not settle")), 5000)),
  ]);
  const count = async (table, email) => {
    const result = await pool.query(
      `SELECT count(*)::int AS count FROM ${table} WHERE lower(btrim(email))=$1`,
      [email],
    );
    return result.rows[0].count;
  };

  async function proveRace(email, existingEmail = null, firstEmail = email, secondEmail = email) {
    if (existingEmail) {
      await pool.query(
        "INSERT INTO host_partner_leads(email,business_name,location_type) VALUES ($1,'Prior synthetic host','office')",
        [existingEmail],
      );
    }
    const gate = gateFor(email);
    const first = submit({ ...base, email: firstEmail });
    await timeout(gate.entered);
    const second = await timeout(submit({ ...base, email: secondEmail, businessName: "Synthetic host updated" }));
    assert.equal(second.ok, true);
    assert.equal(second.emailed, false);
    gate.release();
    const firstResult = await timeout(first);
    assert.equal(firstResult.ok, true);
    assert.equal(firstResult.emailed, true);
    assert.equal(firstResult.leadId, second.leadId);
    assert.equal(emails.filter((entry) => entry.to === email).length, 1);
    assert.equal(await count("host_partner_leads", email), 1);
    const claim = await pool.query("SELECT status,accepted_at FROM host_partner_email_claims WHERE email_normalized=$1 AND step=1", [email]);
    assert.equal(claim.rowCount, 1);
    assert.equal(claim.rows[0].status, "accepted");
    assert(claim.rows[0].accepted_at);
    const replay = await submit({ ...base, email: secondEmail });
    assert.equal(replay.leadId, firstResult.leadId);
    assert.equal(replay.emailed, true);
    assert.equal(emails.filter((entry) => entry.to === email).length, 1);
  }

  await proveRace("first+host@example.invalid");
  await proveRace("existing+host@example.invalid", "existing+host@example.invalid");
  await proveRace(
    "case+host@example.invalid",
    " Case+Host@example.invalid ",
    "CASE+Host@example.invalid",
    "case+host@example.invalid",
  );

  for (const email of ["false+host@example.invalid", "unknown+host@example.invalid"]) {
    const first = await submit({ ...base, email });
    const replay = await submit({ ...base, email });
    assert.equal(first.ok, true);
    assert.equal(first.emailed, false);
    assert.equal(replay.emailed, false);
    assert.equal(replay.leadId, first.leadId);
    assert.equal(emails.filter((entry) => entry.to === email).length, 1);
    const claim = await pool.query("SELECT status,accepted_at FROM host_partner_email_claims WHERE email_normalized=$1 AND step=1", [email]);
    assert.equal(claim.rows[0].status, "pending");
    assert.equal(claim.rows[0].accepted_at, null);
    const marker = await pool.query(
      "SELECT count(*)::int AS count FROM host_partner_lead_sequence_sends WHERE lead_id=$1 AND step=1",
      [first.leadId],
    );
    assert.equal(marker.rows[0].count, 0);
  }

  // A provider-accepted response followed by a transactional ledger failure
  // must roll the claim back to pending, and a replay must stay silent.
  await pool.query(`
    CREATE FUNCTION reject_synthetic_host_marker() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.step = 1 AND EXISTS (
        SELECT 1 FROM host_partner_leads
        WHERE id = NEW.lead_id AND email = 'ledger+host@example.invalid'
      ) THEN
        RAISE EXCEPTION 'synthetic ledger failure';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER reject_synthetic_host_marker
      BEFORE INSERT ON host_partner_lead_sequence_sends
      FOR EACH ROW EXECUTE FUNCTION reject_synthetic_host_marker();
  `);
  const ledgerFirst = await submit({ ...base, email: "ledger+host@example.invalid" });
  const ledgerReplay = await submit({ ...base, email: "ledger+host@example.invalid" });
  assert.equal(ledgerFirst.emailed, false);
  assert.equal(ledgerReplay.emailed, false);
  assert.equal(emails.filter((entry) => entry.to === "ledger+host@example.invalid").length, 1);
  const ledgerClaim = await pool.query(
    "SELECT status,accepted_at FROM host_partner_email_claims WHERE email_normalized='ledger+host@example.invalid' AND step=1",
  );
  assert.equal(ledgerClaim.rows[0].status, "pending");
  assert.equal(ledgerClaim.rows[0].accepted_at, null);
  const ledgerMarkers = await pool.query(
    "SELECT count(*)::int AS count FROM host_partner_lead_sequence_sends WHERE lead_id=$1 AND step=1",
    [ledgerFirst.leadId],
  );
  assert.equal(ledgerMarkers.rows[0].count, 0);

  const historicReplay = await submit({ ...base, email: "history+host@example.invalid" });
  assert.equal(historicReplay.emailed, true);
  assert.equal(emails.filter((entry) => entry.to === "history+host@example.invalid").length, 0);
  assert.equal(await count("host_partner_leads", "history+host@example.invalid"), 2);

  // Only an accepted Step 1 claim may initiate follow-ups. A historical Step 2
  // pending claim and every uncertain Step 1 claim must stay silent.
  const dripLead = await pool.query(
    "INSERT INTO host_partner_leads(email,business_name,location_type) VALUES ('drip+host@example.invalid','Drip fixture','office') RETURNING id",
  );
  await pool.query(
    `INSERT INTO host_partner_email_claims(email_normalized,sequence,step,lead_id,status,accepted_at)
     VALUES ('drip+host@example.invalid','host_partner_v1',1,$1,'accepted',now()-interval '2 days')`,
    [dripLead.rows[0].id],
  );
  await pool.query(
    `INSERT INTO host_partner_lead_sequence_sends(lead_id,sequence,step,sent_at)
     VALUES ($1,'host_partner_v1',1,now()-interval '2 days')`,
    [dripLead.rows[0].id],
  );
  for (const email of ["dripfalse+host@example.invalid", "dripunknown+host@example.invalid"]) {
    const lead = await pool.query(
      "INSERT INTO host_partner_leads(email,business_name,location_type) VALUES ($1,'Ambiguous follow-up fixture','office') RETURNING id",
      [email],
    );
    await pool.query(
      `INSERT INTO host_partner_email_claims(email_normalized,sequence,step,lead_id,status,accepted_at)
       VALUES ($1,'host_partner_v1',1,$2,'accepted',now()-interval '6 days')`,
      [email, lead.rows[0].id],
    );
    await pool.query(
      `INSERT INTO host_partner_lead_sequence_sends(lead_id,sequence,step,sent_at)
       VALUES ($1,'host_partner_v1',1,now()-interval '6 days')`,
      [lead.rows[0].id],
    );
  }
  const firstDrip = await drip.runHostPartnerLeadDripCron();
  assert.equal(firstDrip.sent, 1);
  assert.equal(emails.filter((entry) => entry.category === "marketing").length, 3);
  assert.equal(emails.filter((entry) => entry.to === "drip+host@example.invalid" && entry.category === "marketing").length, 1);
  const secondDrip = await drip.runHostPartnerLeadDripCron();
  assert.equal(secondDrip.sent, 0);
  assert.equal(emails.filter((entry) => entry.category === "marketing").length, 3);
  const dripStep2 = await pool.query("SELECT status FROM host_partner_email_claims WHERE email_normalized='drip+host@example.invalid' AND step=2");
  assert.equal(dripStep2.rows[0].status, "accepted");
  for (const email of ["dripfalse+host@example.invalid", "dripunknown+host@example.invalid"]) {
    const pendingStep2 = await pool.query(
      "SELECT status,accepted_at FROM host_partner_email_claims WHERE email_normalized=$1 AND step=2",
      [email],
    );
    assert.equal(pendingStep2.rows[0].status, "pending");
    assert.equal(pendingStep2.rows[0].accepted_at, null);
    assert.equal(emails.filter((entry) => entry.to === email && entry.category === "marketing").length, 1);
  }

  const step3Lead = await pool.query(
    "INSERT INTO host_partner_leads(email,business_name,location_type) VALUES ('third+host@example.invalid','Step 3 fixture','office') RETURNING id",
  );
  await pool.query(
    `INSERT INTO host_partner_email_claims(email_normalized,sequence,step,lead_id,status,accepted_at)
     VALUES ('third+host@example.invalid','host_partner_v1',1,$1,'accepted',now()-interval '6 days'),
            ('third+host@example.invalid','host_partner_v1',2,$1,'accepted',now()-interval '5 days')`,
    [step3Lead.rows[0].id],
  );
  await pool.query(
    `INSERT INTO host_partner_lead_sequence_sends(lead_id,sequence,step,sent_at)
     VALUES ($1,'host_partner_v1',1,now()-interval '6 days'),
            ($1,'host_partner_v1',2,now()-interval '5 days')`,
    [step3Lead.rows[0].id],
  );
  const thirdDrip = await drip.runHostPartnerLeadDripCron();
  assert.equal(thirdDrip.sent, 1);
  assert.equal(emails.filter((entry) => entry.category === "marketing").length, 4);
  assert.equal(emails.filter((entry) => entry.to === "third+host@example.invalid").length, 1);
  const thirdReplay = await drip.runHostPartnerLeadDripCron();
  assert.equal(thirdReplay.sent, 0);
  assert.equal(emails.filter((entry) => entry.category === "marketing").length, 4);
  const step3Claim = await pool.query("SELECT status FROM host_partner_email_claims WHERE email_normalized='third+host@example.invalid' AND step=3");
  assert.equal(step3Claim.rows[0].status, "accepted");
  const duplicateFollowUps = await pool.query(
    "SELECT count(*)::int AS count FROM host_partner_email_claims WHERE email_normalized='duplicate+host@example.invalid' AND step IN (2,3)",
  );
  assert.equal(duplicateFollowUps.rows[0].count, 0);
  assert.equal(emails.filter((entry) => entry.to === "duplicate+host@example.invalid" && entry.category === "marketing").length, 0);
  const historicPendingAfter = await pool.query(
    "SELECT status FROM host_partner_email_claims WHERE email_normalized='history+host@example.invalid' AND step=2",
  );
  assert.equal(historicPendingAfter.rows[0].status, "pending");
  assert.equal(emails.filter((entry) => entry.to === "history+host@example.invalid" && entry.category === "marketing").length, 0);
  for (const email of ["dripfalse+host@example.invalid", "dripunknown+host@example.invalid"]) {
    const followUpClaims = await pool.query(
      "SELECT step,status FROM host_partner_email_claims WHERE email_normalized=$1 AND step IN (2,3) ORDER BY step",
      [email],
    );
    assert.deepEqual(followUpClaims.rows.map((row) => [row.step, row.status]), [[2, "pending"]]);
    assert.equal(emails.filter((entry) => entry.to === email && entry.category === "marketing").length, 1);
  }
  for (const email of ["false+host@example.invalid", "unknown+host@example.invalid", "ledger+host@example.invalid"]) {
    const followUpClaims = await pool.query(
      "SELECT count(*)::int AS count FROM host_partner_email_claims WHERE email_normalized=$1 AND step IN (2,3)",
      [email],
    );
    assert.equal(followUpClaims.rows[0].count, 0);
    assert.equal(emails.filter((entry) => entry.to === email && entry.category === "marketing").length, 0);
  }
  assert(!logs.some((entry) => entry.includes("PRIVATE_PROVIDER_AMBIGUITY")));

  const receipt = {
    schemaVersion: "mealscout.host-claim-native-proof.v1",
    observedAtUtc: new Date().toISOString(),
    sourceHead: head,
    sourceHashes: { magnet: hash(authoredMagnet), drip: hash(authoredDrip), migration143: hash(migration143) },
    postgresVersion: (await pool.query("SHOW server_version")).rows[0].server_version,
    postgresTimezone: (await pool.query("SHOW timezone")).rows[0].TimeZone,
    database,
    cases: {
      firstTimeConcurrentSameEmail: "one lead, one provider stub call, pending loser, accepted winner",
      existingLeadConcurrentSameEmail: "one lead, one provider stub call, pending loser, accepted winner",
      caseWhitespaceCollision: "historical whitespace/case address normalized before the concurrent claim and send",
      sequentialReplay: "accepted claim returned without another provider call",
      providerFalseAndException: "pending claims retained, no automatic resend or Step 1 marker",
      providerAcceptedLedgerFailure: "transaction rolled back to pending, no replay or Step 1 marker; Steps 2/3 silent",
      historicalDuplicateBackfill: "two lead rows preserved; Step 1 accepted and Step 2 pending without automatic replay",
      duplicateLeadDrip: "recent duplicate did not inherit old lead's Step 1 acceptance or receive Steps 2/3",
      drip: "accepted Step 2 and Step 3 each delivered once; provider-false/exception Step 2 claims stayed pending without replay or Step 3",
    },
    providerOriginEmail: false,
    productionWrites: 0,
    realContact: 0,
  };
  if (process.env.MEALSCOUT_HOST_CLAIM_TEST_RECEIPT_PATH) {
    writeFileSync(process.env.MEALSCOUT_HOST_CLAIM_TEST_RECEIPT_PATH, JSON.stringify(receipt, null, 2) + "\n");
  }
  console.log(JSON.stringify(receipt));
} finally {
  await pool?.end();
  await admin.end();
}
