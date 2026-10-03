import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, getTableColumns, getTableName } from "drizzle-orm";
import * as schema from "../shared/schema";
import { canonicalSourceSection } from "../shared/ownerAiSourceFacts";

// Real workflow modules against disposable PostgreSQL. No production database,
// customer session, remote capture, grant, draft, consent or canonical write.
delete process.env.DATABASE_URL;
process.env.NODE_ENV = "development";
process.env.SESSION_SECRET = "disposable-source-review-coverage-fixture-only";
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("No network in coverage fixture"); };
const engine = new PGlite();
for (const table of [schema.users, schema.restaurants, schema.hosts, schema.suppliers, schema.telemetryEvents, schema.ownerAiActionDrafts, schema.ownerAiNativeProfileDrafts]) {
  const columns = Object.values(getTableColumns(table));
  await engine.exec(`create table "${getTableName(table)}" (${columns.map(c => `"${c.name}" ${c.getSQLType()} ${c.name === "id" ? "primary key default gen_random_uuid()" : ""}`).join(",")})`);
}
const database = drizzle(engine);
(globalThis as any).__coverageFixtureDb = database;
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
(globalThis as any).__coverageDigest = digest;
registerHooks({ load(url, context, nextLoad) {
  if (/\/server\/db\.ts(?:\?|$)/.test(url)) return { format: "module", source: "export const db=globalThis.__coverageFixtureDb; export const pool=undefined;", shortCircuit: true };
  if (/\/server\/utils\/pinnedPublicSourceCheck\.ts$/.test(url)) return { format: "module", source: `export { sourceCheckUrl } from "./pinnedPublicSourceCheck.ts?actual";
    export async function checkPinnedPublicSource(url, options={}) {
      if(url.includes("unavailable")) return {availability:"unavailable"};
      const html=url.includes("empty")?"<p>Public homepage without supported facts.</p>":'<a href="tel:+15555550111">Call</a>';
      options.capture?.({sourceUrl:url,finalUrl:url,body:Buffer.from(html),contentType:"text/html",checkedAt:new Date().toISOString(),bodyHash:globalThis.__coverageDigest(html)});
      return {availability:"reachable"};
    }`, shortCircuit:true };
  return nextLoad(url, context);
}});
const food = await import("../server/services/ownerAiSourceReviews");
const native = await import("../server/services/ownerAiNativeProfiles");
const coverage = await import("../server/services/ownerAiSourceReviewCoverage");
const owner = "coverage-private-owner", disabled = "coverage-disabled-owner";
await database.insert(schema.users).values([{id:owner,isDisabled:false,userType:"restaurant_owner",publicProfileSettings:{showContact:true}}, {id:disabled,isDisabled:true,userType:"restaurant_owner"}]);
const id = (n: number) => `91000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const rows = [
 {id:id(1),ownerId:disabled,name:"Cypress Kitchen",websiteUrl:"https://valid.example/"},
 {id:id(2),ownerId:owner,name:"Cypress Garden",websiteUrl:"https://valid.example/",isActive:false},
 {id:id(3),ownerId:owner,name:"Palm Kitchen",websiteUrl:null},
 {id:id(4),ownerId:owner,name:"River Kitchen",websiteUrl:"https://unavailable.example/"},
 {id:id(5),ownerId:owner,name:"Bay Kitchen",websiteUrl:"https://empty.example/"},
 {id:id(6),ownerId:owner,name:"Sun Kitchen",websiteUrl:"https://valid.example/"},
];
await database.insert(schema.restaurants).values(rows.map(row=>({businessType:"restaurant",isFoodTruck:false,isActive:true,...row,city:"Orlando",state:"FL",updatedAt:new Date("2026-01-01")})));
await database.insert(schema.hosts).values([{id:id(11),userId:disabled,businessName:"Harbor Courtyard",address:"1 Palm Road",city:"Orlando",state:"FL",locationType:"office",updatedAt:new Date("2026-01-01")}, {id:id(12),userId:owner,businessName:"Garden Courtyard",address:"2 Palm Road",city:"Orlando",state:"FL",locationType:"office",websiteUrl:null,updatedAt:new Date("2026-01-01")}]);
await database.insert(schema.suppliers).values([{id:id(13),userId:owner,businessName:"Sunshine Produce",city:"Orlando",state:"FL",isActive:true,websiteUrl:"https://empty.example/",updatedAt:new Date("2026-01-01")}]);
const beforeFood=await database.select().from(schema.restaurants), beforeHost=await database.select().from(schema.hosts), beforeSupplier=await database.select().from(schema.suppliers);
try {
 const run = await food.runOwnerAiSourceReviews({database,restaurantIds:rows.map(row=>row.id)});
 assert.equal(run.results.length,6);assert.equal(run.coverage.persisted,true);
 assert.equal(run.coverage.summary.held,5);assert.equal(run.coverage.summary.proposals,1);
 assert.equal(run.coverage.summary.reasons.owner_or_adapter_invalid,1);
 assert.equal(run.coverage.summary.reasons.public_profile_ineligible,1);
 assert.equal(run.coverage.summary.reasons.missing_official_source,1);
 assert.equal(run.coverage.summary.reasons.source_unavailable_or_redirected,1);
 assert.equal(run.coverage.summary.heldWithReason,5);assert.equal(run.coverage.summary.heldWithoutReason,0);
 const observations=await database.select().from(schema.telemetryEvents).where(eq(schema.telemetryEvents.eventName,food.OWNER_AI_SOURCE_REVIEW_EVENT));
 assert.equal(observations.length,4); // Both early authority failures are now covered in the run receipt.
 const repeat=await food.runOwnerAiSourceReviews({database,restaurantIds:rows.map(row=>row.id)});
 assert.equal(repeat.coverage.summary.held,2);assert.equal(repeat.coverage.summary.outcomes.already_reviewed,4);
 const nativeRun=await native.runNativeOwnerSourceReviews(database);
 assert.equal(nativeRun.coverage.persisted,true);assert.equal(nativeRun.coverage.summary.total,3);assert.equal(nativeRun.coverage.summary.held,3);
 assert.equal(nativeRun.coverage.summary.reasons.owner_or_adapter_invalid,1);assert.equal(nativeRun.coverage.summary.reasons.missing_official_source,1);assert.equal(nativeRun.coverage.summary.reasons.unsupported_or_incomplete_extraction,1);
 assert.deepEqual(await database.select().from(schema.restaurants),beforeFood);assert.deepEqual(await database.select().from(schema.hosts),beforeHost);assert.deepEqual(await database.select().from(schema.suppliers),beforeSupplier);
 assert.equal((await database.select().from(schema.ownerAiActionDrafts)).length,0);assert.equal((await database.select().from(schema.ownerAiNativeProfileDrafts)).length,0);
 const summaryRows=await database.select().from(schema.telemetryEvents).where(eq(schema.telemetryEvents.eventName,coverage.SOURCE_REVIEW_RUN_EVENT));
 assert.equal(summaryRows.length,3);
 for(const row of summaryRows){const text=JSON.stringify(row.properties);assert.equal(row.userId,null);assert.ok(!text.includes(owner));assert.ok(!text.includes(disabled));assert.ok(!text.includes("https://"));assert.ok(!text.includes("91000000"));assert.ok(!text.includes("+15555550111"));}
 console.log("PASS actual food and native workflows persist all terminal reason totals, including early no-observation authority failures; repeats remain per-run/skipped, with no canonical edits, owner drafts or grants and no customer details in summaries");
 const raw = "Secret exception token https://private.example/customer";
 const unknownDb = { select:database.select.bind(database), insert:database.insert.bind(database), transaction:async()=>{throw new Error(raw);} };
 const unknown=await food.runOwnerAiSourceReviews({restaurantIds:[id(6)],database:unknownDb});
 assert.equal(unknown.coverage.summary.heldOutcomesRecorded,1);assert.equal(unknown.coverage.summary.unclassifiedHeld,1);assert.equal(unknown.coverage.summary.heldWithReason,0);assert.equal(unknown.coverage.summary.heldWithoutReason,1);
 assert.ok(!JSON.stringify(unknown.coverage).includes(raw));
 const failDb={...unknownDb,insert:()=>{throw new Error(raw);}};
 const failed=await food.runOwnerAiSourceReviews({restaurantIds:[id(6)],database:failDb});assert.equal(failed.coverage.persisted,false);assert.ok(!JSON.stringify(failed.coverage).includes(raw));
 const live=await coverage.readLatestSourceReviewRunCoverage(database);assert.equal(live.runs.food.latestValidRun?.runId,unknown.coverage.summary.runId);assert.equal(live.runs.native_content.latestValidRun?.runId,nativeRun.coverage.summary.runId);
 const original=summaryRows[0];const corrupt=structuredClone(original.properties) as any;corrupt.held=999;
 await database.insert(schema.telemetryEvents).values({id:"owner-source-run-v1:11111111-1111-4111-8111-111111111111",eventName:coverage.SOURCE_REVIEW_RUN_EVENT,userId:null,createdAt:new Date(Date.now()+1000),properties:{...corrupt,runId:"11111111-1111-4111-8111-111111111111"}});
 let checked=await coverage.readLatestSourceReviewRunCoverage(database);assert.equal(checked.runs.food.invalidReceipts,1);assert.equal(checked.runs.food.latestValidRun?.runId,unknown.coverage.summary.runId);
 const {integritySha256,...observation}=corrupt;observation.runId="22222222-2222-4222-8222-222222222222";
 await database.insert(schema.telemetryEvents).values({id:"owner-source-run-v1:"+observation.runId,eventName:coverage.SOURCE_REVIEW_RUN_EVENT,userId:null,createdAt:new Date(Date.now()+2000),properties:{...observation,integritySha256:digest(canonicalSourceSection(observation))}});
 checked=await coverage.readLatestSourceReviewRunCoverage(database);assert.equal(checked.runs.food.invalidReceipts,2);
 const historicalBefore=await food.summarizeOwnerAiSourceReviewReasons(run.day,database);
 await coverage.persistSourceReviewRunCoverage("food",run.day,[{status:"held",reason:"missing_official_source"}],new Date().toISOString(),database);
 const historicalAfter=await food.summarizeOwnerAiSourceReviewReasons(run.day,database);assert.deepEqual(historicalAfter,historicalBefore);
 assert.equal(networkCalls,0);
 console.log("PASS unknown errors remain unknown causes, failed persistence stays false, latest valid checksummed/count-consistent receipts reject corruption, and new run summaries never rewrite/reclassify historical per-profile receipts; external network calls zero");
 const source=readFileSync(new URL("../server/bootstrap/registerSchedulers.ts",import.meta.url),"utf8");
 assert.ok(source.includes('JSON.stringify(run.coverage)'));assert.ok(source.includes('JSON.stringify(native.coverage)'));
} finally {await engine.close();}
