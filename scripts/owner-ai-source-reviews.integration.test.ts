import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableColumns, getTableName, eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import * as schema from "../shared/schema";
import { readOwnerAiCapabilities, previewOwnerAiPacket } from "../shared/ownerAiCapabilities";
import { ownerAiActionPacketSchema } from "../shared/ownerAiActions";

// No network/production database: replace only the canonical db module in this process.
const fixtureNativeFetch=globalThis.fetch;
process.env.SESSION_SECRET="disposable-local-session-fixture-000000000000000";
delete process.env.DATABASE_URL;
process.env.NODE_ENV = "development";
process.env.OWNER_AI_OAUTH_SECRET = "disposable-local-consent-fixture-000000000000";
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("Settings-only fixture forbids network"); };
const engine = new PGlite();
const tables = [schema.users, schema.restaurants, schema.apiKeys, schema.ownerAiActionDrafts, schema.menus, schema.menuCategories, schema.menuItems, schema.truckManualSchedules, schema.deals, schema.socialPostQueue, schema.socialPublishingConnections, schema.telemetryEvents];
for (const table of tables) {
  const columns = Object.values(getTableColumns(table));
  await engine.exec(`create table "${getTableName(table)}" (${columns.map(c => `"${c.name}" ${/^(varchar|text|boolean|timestamp|integer|numeric|json|serial|double|real|bigint)/.test(c.getSQLType()) ? c.getSQLType() : "text"} ${c.name === "id" ? "primary key default gen_random_uuid()" : ""}`).join(",")})`);
}
const database = drizzle(engine);
(globalThis as any).__ownerAiFixtureDb = database;
registerHooks({ load(url, context, nextLoad) {
  if (/\/server\/db\.ts(?:\?|$)/.test(url)) return { format: "module", source: "export const db = globalThis.__ownerAiFixtureDb; export const pool = undefined;", shortCircuit: true };
  if (/\/server\/utils\/pinnedPublicSourceCheck\.ts$/.test(url)) return { format: "module", source: `export { sourceCheckUrl } from "./pinnedPublicSourceCheck.ts?actual";
    export async function checkPinnedPublicSource(url, options={}) {
      const html=globalThis.__sourceHtmlByUrl?.[url] || globalThis.__sourceHtml;
      if (globalThis.__duringSourceCapture) await globalThis.__duringSourceCapture();
      if (globalThis.__sourceUnavailable) return { sourceUrl:url, availability:"unavailable" };
      if (options.capture) options.capture({ sourceUrl:url, finalUrl:url, body:Buffer.from(html), contentType:"text/html", checkedAt:new Date().toISOString(), bodyHash:globalThis.__fixtureHash(html) });
      return { sourceUrl:url, availability:"reachable", bodyHash:globalThis.__fixtureHash(html) };
    }`, shortCircuit: true };
  return nextLoad(url, context);
}});

const actions = await import("../server/services/ownerAiActions");
const sources = await import("../server/services/ownerAiSourceFacts");
const { handleOwnerAiMcpRequest } = await import("../server/services/ownerAiMcp");
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
(globalThis as any).__fixtureHash = hash;
const html = '<section><h2>Menu</h2><div><a href="/menu.pdf">Download</a></div></section>';
(globalThis as any).__sourceHtml = html;
const reviews = await import("../server/services/ownerAiSourceReviews");
const { registerOwnerAiActionRoutes } = await import("../server/routes/ownerAiActionRoutes");
const { default: express } = await import("express");
const ownerId = "source-review-fixture-owner", nextOwnerId = "source-review-next-owner";
const ids = [1,2,3,4,5].map(i => `00000000-0000-4000-8000-${String(i).padStart(12,"0")}`);
const types = ["restaurant","food_truck","bar","caterer","private_chef"];
await engine.exec("create table rate_limit_counters(scope text, identity_key text, window_start bigint, count integer, updated_at timestamp, primary key(scope,identity_key,window_start))");
await database.insert(schema.users).values([{ id: ownerId, isDisabled: false }, { id: nextOwnerId, isDisabled: false }, { id: "fixture-admin", isDisabled: false, userType: "super_admin" }]);
for (const [index,id] of ids.entries()) await database.insert(schema.restaurants).values({ id, ownerId, name: types[index], businessType: types[index], isActive: true, websiteUrl: "https://official.example/", updatedAt: new Date("2026-01-01T00:00:00Z") });
// More than one page, including an unsupported table row after the food rows.
for (let i=0;i<101;i++) await database.insert(schema.restaurants).values({ id: `10000000-0000-4000-8000-${String(i).padStart(12,"0")}`, ownerId, name: "Unsupported fixture", businessType: "supplier", isActive: true });
let captureCalls=0;
const capture = async (url:string) => { captureCalls++; return { sourceUrl:url, finalUrl:url, body:Buffer.from(html), contentType:"text/html", checkedAt:new Date().toISOString(), bodyHash:hash(html) }; };
const app=express();app.use(express.json());
// Synthetic upstream session for this local-only HTTP boundary proof. The real
// isAuthenticated middleware and persisted actual-owner checks are unchanged.
app.use((req:any,_res,next)=>{const id=req.headers["x-fixture-user"];req.user=id?{id,userType:id==="fixture-admin"?"super_admin":"restaurant_owner"}:undefined;req.isAuthenticated=()=>Boolean(req.user);next();});
registerOwnerAiActionRoutes(app);
const server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
const address=server.address() as any, base=`http://127.0.0.1:${address.port}`;
const request = async (suffix:string, user?:string, body?:any) => {
  const response=await fixtureNativeFetch(base+`/api/owner-ai/restaurants/${ids[0]}/`+suffix,{method:body===undefined?"GET":"POST",headers:{...(user?{"x-fixture-user":user}:{}),...(body===undefined?{}:{"content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json(),cache:response.headers.get("cache-control")};
};
try {
  assert.deepEqual(reviews.ownerAiSourceReviewSchedule(),{expression:"0 0 * * *",timezone:"America/Chicago",mode:"private_semantic_proposals",scope:"active_public_native_food_profiles",createsOwnerDrafts:false,publishes:false,approvalRequired:true});
  const diagnosticDatabase={select:database.select.bind(database),transaction:(fn:any,c:any)=>database.transaction(async(tx:any)=>{try{return await fn(tx);}catch(error){console.error("Source-review fixture transaction failure:",error);throw error;}},c)};
  const run=await reviews.runOwnerAiSourceReviews({database:diagnosticDatabase,capture});
  assert.equal(run.results.length,5);assert.ok(run.results.every(r=>r.status==="proposal_ready"));assert.equal(captureCalls,5);
  const repeat=await reviews.runOwnerAiSourceReviews({database,capture});assert.ok(repeat.results.every(r=>r.status==="already_reviewed"));assert.equal(captureCalls,5);
  const receipts=await database.select().from(schema.telemetryEvents);
  assert.equal(receipts.length,5);assert.ok(receipts.every((r:any)=>r.userId===null&&r.properties.createsOwnerDrafts===false&&r.properties.publishes===false));
  assert.equal((await database.select().from(schema.ownerAiActionDrafts)).length,0);assert.equal((await database.select().from(schema.menuItems)).length,0);assert.equal((await database.select().from(schema.truckManualSchedules)).length,0);
  assert.equal((await database.select().from(schema.restaurants).where(eq(schema.restaurants.id,ids[0])))[0].updatedAt?.toISOString(),"2026-01-01T00:00:00.000Z");
  assert.equal((await reviews.readOwnerAiSourceReviews(ownerId,ids[0],database)).reviews.length,1);
  assert.equal((await request("source-reviews")).status,401);assert.equal((await request("source-draft",undefined,{})).status,401);
  assert.equal((await request("source-reviews","fixture-admin")).status,403);assert.equal((await request("source-draft","fixture-admin",{})).status,403);
  const bad=await request("source-draft",ownerId,{userId:nextOwnerId,packet:{profile:{menuUrl:"https://forged.example/"}}});assert.equal(bad.status,400);
  const native=await request("source-draft",ownerId,{});assert.equal(native.status,201,JSON.stringify(native.body));assert.equal(native.cache,"private, no-store");assert.equal(native.body.approvalRequired,true);assert.equal(native.body.canonicalMutationPerformed,false);
  assert.equal(native.body.draft.packet.profile.menuUrl,"https://official.example/menu.pdf");assert.equal(native.body.draft.createdByUserId,ownerId);assert.equal(native.body.draft.status,"draft");
  assert.equal((await database.select().from(schema.ownerAiActionDrafts)).length,1);assert.equal((await database.select().from(schema.restaurants).where(eq(schema.restaurants.id,ids[0])))[0].socialAutopostSettings,null);
  console.log("PASS all-five-type paged automatic semantic proposals are private observations, retry-idempotent and canonical-write free; real owner routes enforce anonymous/admin/forged-payload boundaries and create an evidence-bound native draft only for the fixture owner");

  await database.update(schema.users).set({publicProfileSettings:{showContact:false}}).where(eq(schema.users.id,ownerId));
  assert.equal((await reviews.readOwnerAiSourceReviews(ownerId,ids[0],database)).reviews.length,0);
  await database.update(schema.users).set({publicProfileSettings:{showContact:true}}).where(eq(schema.users.id,ownerId));
  const [saved]=await database.select().from(schema.telemetryEvents).where(eq(schema.telemetryEvents.id,reviews.ownerAiSourceReviewId(ids[0],run.day)));
  const damaged=structuredClone(saved.properties) as any;damaged.proposal.packet.profile.menuUrl="https://corrupt.example/";
  await database.update(schema.telemetryEvents).set({properties:damaged}).where(eq(schema.telemetryEvents.id,saved.id));
  assert.equal((await reviews.readOwnerAiSourceReviews(ownerId,ids[0],database)).reviews.length,0);
  assert.equal((await reviews.runOwnerAiSourceReviews({restaurantIds:[ids[0]],database,capture})).results[0].status,"held_authority_or_capture_changed");
  const stale=structuredClone(saved.properties) as any;stale.proposal.packet.sourceFacts.fields[0].expiresAt=new Date(Date.now()-1000).toISOString();
  const {canonicalSourceSection}=await import("../shared/ownerAiSourceFacts");const {integritySha256,...staleObservation}=stale;stale.integritySha256=hash(canonicalSourceSection(staleObservation));
  await database.update(schema.telemetryEvents).set({properties:stale}).where(eq(schema.telemetryEvents.id,saved.id));
  const expired=await reviews.readOwnerAiSourceReviews(ownerId,ids[0],database);assert.equal(expired.reviews[0].packet,null);assert.ok(expired.reviews[0].holds.includes("SOURCE_REVIEW_EXPIRED_OR_VISIBILITY_CHANGED"));
  await database.update(schema.restaurants).set({ownerId:nextOwnerId}).where(eq(schema.restaurants.id,ids[0]));
  await assert.rejects(reviews.readOwnerAiSourceReviews(ownerId,ids[0],database),/owner/i);assert.equal((await reviews.readOwnerAiSourceReviews(nextOwnerId,ids[0],database)).reviews.length,0);
  assert.equal((await reviews.runOwnerAiSourceReviews({restaurantIds:[ids[0]],database,capture})).results[0].status,"prior_owner_review");
  await database.update(schema.restaurants).set({ownerId}).where(eq(schema.restaurants.id,ids[0]));
  const beforeDrafts=(await database.select().from(schema.ownerAiActionDrafts)).length;
  (globalThis as any).__duringSourceCapture=async()=>{(globalThis as any).__duringSourceCapture=undefined;await database.update(schema.restaurants).set({updatedAt:new Date()}).where(eq(schema.restaurants.id,ids[0]));};
  const raced=await request("source-draft",ownerId,{});assert.equal(raced.status,409,JSON.stringify(raced.body));assert.equal(raced.body.code,"STALE_CONTEXT");assert.equal((await database.select().from(schema.ownerAiActionDrafts)).length,beforeDrafts);
  const transaction=database.transaction.bind(database);let lateOwnerRace=true;
  (database as any).transaction=(fn:any,config:any)=>transaction(async(tx:any)=>{if(!config&&lateOwnerRace){lateOwnerRace=false;await tx.update(schema.users).set({isDisabled:true}).where(eq(schema.users.id,ownerId));}return fn(tx);},config);
  await assert.rejects(reviews.createOwnerAiOfficialSourceDraft(ownerId,ids[0]),/Source authority changed/);assert.equal((await database.select().from(schema.ownerAiActionDrafts)).length,beforeDrafts);
  (database as any).transaction=transaction;
  (globalThis as any).__sourceHtml="<p>No supported menu or dated event facts.</p>";
  const held=await request("source-draft",ownerId,{});assert.equal(held.status,200);assert.equal(held.body.draft,null);assert.equal((await database.select().from(schema.ownerAiActionDrafts)).length,beforeDrafts);
  await database.update(schema.users).set({isDisabled:true}).where(eq(schema.users.id,ownerId));
  await assert.rejects(reviews.readOwnerAiSourceReviews(ownerId,ids[0],database),/owner/i);assert.equal((await request("source-draft",ownerId,{})).status,409);
  console.log("PASS hidden/removed and expired historical evidence withheld; transferred/disabled owners denied; source-time native version race and final-insert disabled-owner race hold with no extra draft; unavailable facts return explicit holds, never a nonexistent draft");
  console.log("PASS synthetic disposable session/owners only; no live customer owner, database, draft, credentials, canonical application or social publishing claimed");
} finally {await new Promise<void>(resolve=>server.close(()=>resolve()));await engine.close();}
