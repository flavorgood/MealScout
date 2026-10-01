import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableColumns, getTableName, eq } from "drizzle-orm";
import * as schema from "../shared/schema";

// Real MealScout middleware/controllers/core/native transactions. Only transport,
// persistence backing and image-hosting are disposable fixtures. No live consent.
const nativeFetch = globalThis.fetch;
delete process.env.DATABASE_URL;
process.env.NODE_ENV = "development";
process.env.SESSION_SECRET = "disposable-reverse-osmosis-session-fixture-000000000";
process.env.OWNER_AI_OAUTH_SECRET = "disposable-reverse-osmosis-consent-fixture-000000000";
process.env.FACEBOOK_APP_ID = "222222";
process.env.FACEBOOK_APP_SECRET = "SYNTHETIC_APP_SECRET_NEVER_REAL";
const pg = new PGlite();
const tables = [schema.users,schema.restaurants,schema.apiKeys,schema.ownerAiActionDrafts,schema.menus,schema.menuCategories,schema.menuItems,schema.truckManualSchedules,schema.foodBusinessAppearances,schema.deals,schema.socialPostQueue,schema.socialPublishingConnections,schema.telemetryEvents];
for (const table of tables) {
  const columns = Object.values(getTableColumns(table));
  await pg.exec(`create table "${getTableName(table)}" (${columns.map(c => `"${c.name}" ${/^(varchar|text|boolean|timestamp|integer|numeric|json|serial|double|real|bigint)/.test(c.getSQLType()) ? c.getSQLType() : "text"} ${c.name === "id" ? "primary key default gen_random_uuid()" : ""}`).join(",")})`);
}
const migration = readFileSync(new URL("../migrations/146_reverse_osmosis_operations.sql",import.meta.url),"utf8");
await pg.exec(migration); await pg.exec(migration);
await pg.exec("create unique index social_owner_draft_platform on social_post_queue(owner_ai_action_draft_id,platform) where owner_ai_action_draft_id is not null");
await pg.exec("create table rate_limit_counters(scope text,identity_key text,window_start bigint,count integer,updated_at timestamp,primary key(scope,identity_key,window_start))");
const database = drizzle(pg);
(globalThis as any).__roFixtureDatabase = database;
(globalThis as any).__roHostedImages = 0;
registerHooks({load(url,context,nextLoad) {
  if (/\/server\/db\.ts(?:\?|$)/.test(url)) return {format:"module",source:"export const db=globalThis.__roFixtureDatabase;export const pool=undefined;",shortCircuit:true};
  if (/\/server\/imageUpload\.ts$/.test(url)) return {format:"module",source:`export * from "./imageUpload.ts?actual";export function isCloudinaryConfigured(){return true;}export async function uploadGeneratedSocialCardToCloudinary(svg,id){globalThis.__roHostedImages++;if(globalThis.__roHostingUncertain)throw Error("synthetic hosting interrupted");return "https://images.mealscout-fixture.net/"+id+".png";}`,shortCircuit:true};
  return nextLoad(url,context);
}});
const owner = "synthetic-owner";
const business = "00000000-0000-4000-8000-000000000080";
const page = "111111";
const connectionId = "synthetic-connection";
const stamp = new Date("2026-09-30T12:00:00Z");
await database.insert(schema.users).values([{id:owner,isDisabled:false},{id:"synthetic-other-owner",isDisabled:false}]);
await database.insert(schema.restaurants).values({id:business,ownerId:owner,name:"Synthetic food business",businessType:"restaurant",isActive:true,updatedAt:stamp});
await database.insert(schema.socialPublishingConnections).values({id:connectionId,restaurantId:business,createdByUserId:owner,platform:"facebook",externalAccountId:page,accessToken:"SYNTHETIC_PAGE_TOKEN_NEVER_REAL",refreshToken:"SYNTHETIC_USER_TOKEN_NEVER_REAL",scopes:["pages_manage_posts","pages_read_engagement"],metadata:{provider:"meta",pageId:page},status:"active",updatedAt:stamp});
let postSequence = 4000;
let selectedPost = "";
let message = "Menu: https://menus.mealscout-fixture.net/current";
let personal = false;
let revoked = false;
let uncertain = false;
let providerAcknowledgementOverride: Record<string,unknown> | null = null;
let postWrites = 0;
let providerReads = 0;
let lastPublished = "";
globalThis.fetch = async (input,init) => {
  const url = new URL(String(input));
  assert.equal(url.origin,"https://graph.facebook.com","no unrecognized external transport");
  const id=url.pathname.split("/").at(-1);
  if(init?.method === "POST") {
    assert.ok(id === "photos" || id === "feed");
    assert.equal(url.pathname.split("/").at(-2),page,"only exact approved Page is published");
    postWrites++;
    if(uncertain) throw Error("synthetic provider lost response after request initiation");
    if(providerAcknowledgementOverride !== null) return Response.json(providerAcknowledgementOverride);
    lastPublished=`${page}_${9000+postWrites}`;
    return Response.json({post_id:lastPublished});
  }
  assert.equal(init?.method,"GET");providerReads++;
  if(id === "me") return Response.json(personal ? {id:page,name:"Synthetic personal feed"} : {id:page,category:"Restaurant",tasks:["MANAGE","CREATE_CONTENT"]});
  if(id === "debug_token") return Response.json({data:{is_valid:!revoked,type:"PAGE",profile_id:page,app_id:"222222",user_id:"333333",scopes:["pages_read_engagement","pages_manage_posts"],expires_at:0,data_access_expires_at:0}});
  if(id === "settings") { assert.equal(url.pathname.split("/").at(-2),page); return Response.json({data:[{setting:"IS_PUBLISHED",value:true},{setting:"AGE_RESTRICTIONS",value:"Public"},{setting:"COUNTRY_RESTRICTIONS",value:{restriction_type:"blacklist",countries:[]}}]}); }
  assert.equal(id,selectedPost,"provider capture requests exactly the selected post");
  return Response.json({id:selectedPost,from:{id:page},message,permalink_url:`https://www.facebook.com/${page}/posts/${selectedPost.split("_")[1]}`,is_published:true,privacy:{value:"EVERYONE"},targeting:{},feed_targeting:{},is_hidden:false,is_expired:false,scheduled_publish_time:0,created_time:"2026-09-30T12:00:00Z",updated_time:"2026-09-30T12:00:00Z"});
};
const {registerOwnerAiActionRoutes}=await import("../server/routes/ownerAiActionRoutes");
const {mealScoutReverseOsmosisHash}=await import("../server/services/reverseOsmosis");
const {default:express}=await import("express");
const app=express();app.use(express.json());
app.use((req:any,_res,next)=>{const id=req.headers["x-fixture-user"];req.user=id?{id,userType:"restaurant_owner"}:undefined;req.isAuthenticated=()=>Boolean(req.user);next();});
registerOwnerAiActionRoutes(app);
app.use((error:any,_req:any,res:any,_next:any)=>res.status(500).json({error:String(error?.message || error)}));
const server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
const base="http://127.0.0.1:"+(server.address() as any).port;
const request=async(path:string,body?:any,user:string|null=owner,method=body===undefined?"GET":"POST")=>{
  const r=await nativeFetch(base+path,{method,headers:{"content-type":"application/json",...(user?{"x-fixture-user":user}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};
};
const sourcePath=`/api/owner-ai/restaurants/${business}/reverse-osmosis/source-draft`;
const success=(r:any,status=201)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body.draft;};
const held=(r:any)=>assert.ok(r.status>=400 && r.status<500,JSON.stringify(r));
async function source(publish=false) {selectedPost=`${page}_${++postSequence}`;return success(await request(sourcePath,{postId:`https://www.facebook.com/${page}/posts/${postSequence}`,publishPlatforms:publish?["facebook"]:[]}));}
const approve=(d:any,revision=d.revision)=>request(`/api/owner-ai/drafts/${d.id}/approve`,{expectedRevision:revision});
const outcomes=(d:any)=>request(`/api/owner-ai/drafts/${d.id}/reverse-osmosis`);
async function resetLimits(){await pg.exec("delete from rate_limit_counters");}
try {
  await resetLimits();
  held(await request(sourcePath,{postId:"111111_4001"},null));
  held(await request(sourcePath,{postId:"111111_4001"},"synthetic-other-owner"));
  held(await request(sourcePath,{postId:"111111_4001",ownerId:"synthetic-other-owner"}));
  held(await request(sourcePath,{postId:"https://personal.example/posts/4001"}));
  assert.equal(providerReads,0);
  console.log("PASS actual authenticated routes reject no-session, wrong-owner, caller identity and untrusted post URL before transport");

  const inboundOnly=await source();
  assert.equal(inboundOnly.packet.reverseOsmosis.core.sourceRevision,"b5cdef4187b9e21981c7bf004fb15fd34edd73cf");
  assert.equal(inboundOnly.packet.reverseOsmosis.outbound.length,0);
  assert.equal((await database.select().from(schema.reverseOsmosisOperations)).length,0);
  assert.equal((await database.select().from(schema.socialPostQueue)).length,0);
  assert.equal((await database.select().from(schema.restaurants))[0].socialAutopostSettings,null);
  held(await approve(inboundOnly,2));
  success(await approve(inboundOnly),200);
  assert.equal(postWrites,0);
  assert.equal((await outcomes(inboundOnly)).body.outcomes[0].status,"completed");
  console.log("PASS captured provenance and shared-core proposal are bound into real immutable native draft; exact revision applies without unselected publication");

  const complete=await source(true);
  assert.equal(complete.packet.reverseOsmosis.outbound.length,1);
  assert.equal(complete.packet.reverseOsmosis.outbound[0].expectedNativeVersion,complete.packet.reverseOsmosis.inbound.expectedNativeVersion);
  success(await approve(complete),200);
  const proof=await outcomes(complete);assert.equal(proof.status,200,JSON.stringify(proof.body));
  assert.equal(proof.body.outcomes.length,2);assert.ok(proof.body.outcomes.every((o:any)=>o.status==="completed"));
  assert.equal(postWrites,1);
  assert.equal((await database.select().from(schema.socialPostQueue))[0].status,"posted");
  const originalBinding=(await database.select().from(schema.socialPublishingConnections))[0].updatedAt;
  assert.equal(originalBinding?.toISOString(),stamp.toISOString());
  success(await approve(complete,complete.revision+1),200);assert.equal(postWrites,1);
  const operations=await database.select().from(schema.reverseOsmosisOperations);
  const inbound=operations.find((o:any)=>o.draftId===complete.id && (o.proposal as any).direction==="social-to-native")!;
  assert.equal((inbound.receipt as any).packetDigest,mealScoutReverseOsmosisHash(complete.packet));
  assert.notEqual((inbound.receipt as any).completedNativeVersion,complete.packet.reverseOsmosis.inbound.expectedNativeVersion);
  console.log("PASS actual native HTTP draft -> exact consent transaction -> canonical menu link -> shared-core durable outbound claim -> same-Page provider receipt; replay posts once");

  const reflected=await request(sourcePath,{postId:lastPublished,publishPlatforms:["facebook"]});held(reflected);
  assert.ok(JSON.stringify(reflected).includes("reflection"));assert.equal(postWrites,1);
  console.log("PASS trusted stored same-Page publication receipt blocks inbound reflection without trusting caller origin labels");

  await resetLimits();
  const changed=await source();message="Menu: https://menus.mealscout-fixture.net/changed";held(await approve(changed));message="Menu: https://menus.mealscout-fixture.net/current";
  assert.equal((await database.select().from(schema.ownerAiActionDrafts).where(eq(schema.ownerAiActionDrafts.id,changed.id)))[0].status,"draft");
  const stale=await source();await database.insert(schema.menus).values({id:"00000000-0000-4000-8000-000000000090",restaurantId:business,name:"Synthetic changed native menu",updatedAt:new Date()});held(await approve(stale));
  const dateVersion=await source();await database.update(schema.restaurants).set({updatedAt:new Date(Date.now()+1000)}).where(eq(schema.restaurants.id,business));held(await approve(dateVersion));
  const revokedDraft=await source();revoked=true;held(await approve(revokedDraft));revoked=false;
  const personalDraft=await source();personal=true;held(await approve(personalDraft));personal=false;
  const bindingDraft=await source();await database.update(schema.socialPublishingConnections).set({updatedAt:new Date()}).where(eq(schema.socialPublishingConnections.id,connectionId));held(await approve(bindingDraft));
  await database.update(schema.users).set({publicProfileSettings:{showContact:false}}).where(eq(schema.users.id,owner));
  selectedPost=`${page}_${++postSequence}`;held(await request(sourcePath,{postId:selectedPost}));
  await database.update(schema.users).set({publicProfileSettings:{}}).where(eq(schema.users.id,owner));
  assert.equal(postWrites,1);
  console.log("PASS exact post recapture, full child/native Date versions, revoked/personal asset and changed binding hold before native effects");

  await resetLimits();
  const uncertainDraft=await source(true);uncertain=true;success(await approve(uncertainDraft),200);uncertain=false;
  assert.equal(postWrites,2);
  const uncertainOutcome=await outcomes(uncertainDraft);assert.equal(uncertainOutcome.status,200,JSON.stringify(uncertainOutcome.body));
  assert.ok(uncertainOutcome.body.outcomes.some((o:any)=>o.status==="held"));
  success(await approve(uncertainDraft,uncertainDraft.revision+1),200);assert.equal(postWrites,2);
  const reconcile=await request(`/api/owner-ai/drafts/${uncertainDraft.id}/reverse-osmosis/reconcile`,{});assert.equal(reconcile.status,200,JSON.stringify(reconcile.body));assert.ok(reconcile.body.outcomes.some((o:any)=>o.status==="held"));
  held(await request(`/api/owner-ai/drafts/${uncertainDraft.id}/reverse-osmosis/reconcile`,{delivered:false}));
  assert.equal(postWrites,2);
  console.log("PASS uncertain provider delivery persists durable held outcome; repeated approval/reconciliation never blindly retries or accepts caller absence claims");

  const originalNow=Date.now;Date.now=()=>originalNow()+25*60*60_000;
  try { const historical=await outcomes(uncertainDraft);assert.equal(historical.status,200,JSON.stringify(historical.body));assert.ok(historical.body.outcomes.some((o:any)=>o.status==="held")); }
  finally {Date.now=originalNow;}
  await database.update(schema.users).set({publicProfileSettings:{showContact:false}}).where(eq(schema.users.id,owner));
  const privateOutcome=await outcomes(uncertainDraft);assert.equal(privateOutcome.status,200,JSON.stringify(privateOutcome.body));assert.ok(privateOutcome.body.outcomes.some((o:any)=>o.status==="held"));
  await database.update(schema.users).set({publicProfileSettings:{}}).where(eq(schema.users.id,owner));
  assert.equal(postWrites,2);
  console.log("PASS current authorized owner can read held historical receipts after source expiry or native privacy hide without gaining new effect authority");

  const malformedAcknowledgements: Array<[string,Record<string,unknown>]> = [
    ["missing-id",{}], ["numeric-post-id",{post_id:9001}], ["numeric-id",{id:9001}],
    ["empty-id",{post_id:""}], ["blank-id",{post_id:" \n\t "}],
    ["boolean-id",{post_id:true}], ["object-id",{post_id:{id:"111111_9001"}}], ["array-id",{post_id:["111111_9001"]}],
  ];
  for(const [name,response] of malformedAcknowledgements){
    await resetLimits();const draft=await source(true);const before=postWrites;
    providerAcknowledgementOverride=response;success(await approve(draft),200);providerAcknowledgementOverride=null;
    const initial=await outcomes(draft);assert.equal(initial.status,200,JSON.stringify(initial.body));
    assert.deepEqual(initial.body.outcomes.filter((o:any)=>o.operationKey===draft.packet.reverseOsmosis.outbound[0].operationKey).map((o:any)=>o.status),["held"],name+" durable held");
    const queue=(await database.select().from(schema.socialPostQueue).where(eq(schema.socialPostQueue.ownerAiActionDraftId,draft.id)))[0];
    assert.equal(queue.status,"manual_required",name+" queue held");assert.equal(queue.providerPostId,null,name+" no verified receipt");
    assert.equal(postWrites,before+1,name+" one initial provider POST");
    success(await approve(draft,draft.revision+1),200);assert.equal(postWrites,before+1,name+" replay never posts");
    const reconciled=await request(`/api/owner-ai/drafts/${draft.id}/reverse-osmosis/reconcile`,{});
    assert.equal(reconciled.status,200,JSON.stringify(reconciled.body));
    assert.deepEqual(reconciled.body.outcomes.filter((o:any)=>o.operationKey===draft.packet.reverseOsmosis.outbound[0].operationKey).map((o:any)=>o.status),["held"],name+" reconciliation remains held");
    assert.equal(postWrites,before+1,name+" reconciliation never posts");
    console.log("PASS malformed acknowledgement "+name+": held/manual_required, one POST, no replay/reconcile POST");
  }
  await resetLimits();const validAfterHeld=await source(true);const validBefore=postWrites;success(await approve(validAfterHeld),200);
  const validProof=await outcomes(validAfterHeld);assert.equal(validProof.status,200,JSON.stringify(validProof.body));
  assert.ok(validProof.body.outcomes.every((o:any)=>o.status==="completed"),"valid string acknowledgement remains completed");
  const validQueue=(await database.select().from(schema.socialPostQueue).where(eq(schema.socialPostQueue.ownerAiActionDraftId,validAfterHeld.id)))[0];
  assert.equal(validQueue.status,"posted");assert.equal(typeof validQueue.providerPostId,"string");assert.equal(postWrites,validBefore+1);
  success(await approve(validAfterHeld,validAfterHeld.revision+1),200);assert.equal(postWrites,validBefore+1);
  console.log("PASS malformed receipt counterexamples retain native held/queue manual_required and valid string happy path/replay");
  const beforeTransfer=postWrites;
  const transfer=await source();await database.update(schema.restaurants).set({ownerId:"synthetic-other-owner"}).where(eq(schema.restaurants.id,business));held(await approve(transfer));
  held(await outcomes(complete));held(await request(`/api/owner-ai/drafts/${complete.id}/reverse-osmosis`,undefined,"synthetic-other-owner"));
  assert.equal(postWrites,beforeTransfer);
  console.log("PASS current owner transfer prevents native application and old/new-owner receipt disclosure; no customer/provider acceptance claimed");
  await assert.rejects(pg.exec("update reverse_osmosis_operations set status='absent'"),/check constraint/);
  await pg.exec(migration);
  console.log("PASS actual additive migration replays and enforces durable operation status/foreign-key contract");
} finally { await new Promise<void>(resolve=>server.close(()=>resolve()));await pg.close(); }
