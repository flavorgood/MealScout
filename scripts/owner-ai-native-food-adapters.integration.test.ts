import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableColumns, getTableName, eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import * as schema from "../shared/schema";
import { readOwnerAiCapabilities, previewOwnerAiPacket } from "../shared/ownerAiCapabilities";
import { ownerAiActionPacketSchema } from "../shared/ownerAiActions";

// No network/production database: replace only the canonical db module in this process.
const fixtureNativeFetch = globalThis.fetch;
process.env.SESSION_SECRET="disposable-local-session-fixture-000000000000000";
delete process.env.DATABASE_URL;
process.env.NODE_ENV = "development";
process.env.OWNER_AI_OAUTH_SECRET = "disposable-local-consent-fixture-000000000000";
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("Settings-only fixture forbids network"); };
const engine = new PGlite();
const tables = [schema.users, schema.restaurants, schema.apiKeys, schema.ownerAiActionDrafts, schema.menus, schema.menuCategories, schema.menuItems, schema.truckManualSchedules, schema.events, schema.eventBookings, schema.eventSeries, schema.hosts, schema.deals, schema.socialPostQueue, schema.socialPublishingConnections, schema.telemetryEvents];
for (const table of tables) {
  const columns = Object.values(getTableColumns(table));
  await engine.exec(`create table "${getTableName(table)}" (${columns.map(c => `"${c.name}" ${/^(varchar|text|boolean|timestamp|integer|numeric|json|serial|double|real|bigint)/.test(c.getSQLType()) ? c.getSQLType() : "text"} ${c.name === "id" ? "primary key default gen_random_uuid()" : ""}`).join(",")})`);
}
const migration144=readFileSync(new URL("../migrations/144_food_business_appearances.sql",import.meta.url),"utf8");
await engine.exec(migration144); await engine.exec(migration144);
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
const token = "disposable_source_fact_fixture_123456789";
await database.insert(schema.users).values({ id: "fixture-owner", isDisabled: false });
await database.insert(schema.restaurants).values({ id: "00000000-0000-4000-8000-000000000050", name: "Fixture", ownerId: "fixture-owner", businessType: "food_truck", isActive: true, websiteUrl: "https://official.example/", updatedAt: new Date() });
await database.insert(schema.apiKeys).values({ id: "fixture-key", userId: "fixture-owner", restaurantId: "00000000-0000-4000-8000-000000000050", keyPrefix: token.slice(0,8), keyHash: await bcrypt.hash(token, 4), purpose: "owner_ai_connector", scope: "owner_ai:context owner_ai:drafts:create owner_ai:drafts:read owner_ai:drafts:approve", isActive: true });
const principal = await actions.authenticateOwnerAiConnector(token, "owner_ai:context");
let seq=1, key=1;
const call = async (name: string, args: any, p=principal) => (await handleOwnerAiMcpRequest(p,{jsonrpc:"2.0",id:seq++,method:"tools/call",params:{name,arguments:args}}) as any).result;
const ok=(r:any)=>{assert.equal(r.isError,undefined,JSON.stringify(r));return r.structuredContent;};
const fails=(r:any,code:string)=>{assert.equal(r.isError,true,JSON.stringify(r));assert.ok(JSON.stringify(r).includes(code),JSON.stringify(r));};
const proposal = async()=>ok(await call("get_mealscout_official_source_facts",{}));
const draft=async(packet?:any)=>{const context=await actions.getOwnerAiContext(principal.restaurantId);return ok(await call("create_mealscout_draft",{idempotencyKey:"source-fixture-"+key++,request:{packet:packet||(await proposal()).packet,expectedVersions:context.expectedVersions}}));};
const prepare=async(d:any)=>ok(await call("prepare_mealscout_approval",{draftId:d.id}));
const approve=(d:any,p:any)=>call("approve_mealscout_draft",{draftId:d.id,expectedRevision:d.revision,consentHandle:p.consentHandle,ownerConfirmation:"approved"});

const { DateTime } = await import("luxon");
const { buildPublicEventsPayload } = await import("../server/routes/publicDiscoveryRoutes");
const { buildPublicTruckOperatingPlan } = await import("../server/services/truckOperatingPlan");
const { buildPublicNativeFoodAppearances } = await import("../server/services/publicFoodBusinessAppearances");
const { projectAdmittedFoodProfileLink } = await import("../server/publicProfiles/admitPublicRestaurant");
const { ownerAiProfileCapabilities } = await import("../server/services/ownerAiProfileCapabilities");
const { registerOwnerAiActionRoutes } = await import("../server/routes/ownerAiActionRoutes");
const { default: express } = await import("express");
await engine.exec("create table rate_limit_counters(scope text, identity_key text, window_start bigint, count integer, updated_at timestamp, primary key(scope,identity_key,window_start))");
const app=express(); app.use(express.json());
// Synthetic session only for disposable HTTP fixture; actual middleware and persisted current-owner guards run.
app.use((req:any,_res,next)=>{const id=req.headers["x-fixture-user"];req.user=id?{id,userType:"restaurant_owner"}:undefined;req.isAuthenticated=()=>Boolean(req.user);next();});
registerOwnerAiActionRoutes(app);
const server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
const base="http://127.0.0.1:"+(server.address() as any).port;
const request=async(path:string,body:any,user:string|undefined=principal.userId)=>{const r=await fixtureNativeFetch(base+path,{method:"POST",headers:{"content-type":"application/json",...(user?{"x-fixture-user":user}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
const now=DateTime.now().setZone("America/Chicago"),start=now.plus({days:1}).startOf("day").plus({hours:12}),end=start.plus({hours:2});
const business:any={"@type":"LocalBusiness",url:"https://official.example/",hasMenu:{"@type":"Menu",name:"Current menu",hasMenuSection:{"@type":"MenuSection",name:"Bowls",hasMenuItem:{"@type":"MenuItem",name:"Berry bowl",offers:{"@type":"Offer",price:"12.50",priceCurrency:"USD",availability:"https://schema.org/InStock",validFrom:now.minus({days:1}).toISO(),validThrough:now.plus({days:5}).toISO()}}}}};
const event:any={"@type":"FoodEvent",name:"Public market",performer:{"@type":"LocalBusiness",url:"https://official.example/"},eventStatus:"https://schema.org/EventScheduled",eventAttendanceMode:"https://schema.org/OfflineEventAttendanceMode",audience:{"@type":"Audience",audienceType:"General public"},additionalProperty:{"@type":"PropertyValue",name:"IANA timezone",value:"America/Chicago"},startDate:start.toISO(),endDate:end.toISO(),location:{"@type":"Place",name:"Market",address:{"@type":"PostalAddress",streetAddress:"1 Public Street",addressLocality:"Pensacola",addressRegion:"FL"}}};
const render=()=>'<a href="tel:+18505550100">Phone</a><script type="application/ld+json">'+JSON.stringify({"@context":"https://schema.org","@graph":[business,event]})+'</script>';
try {
  (globalThis as any).__sourceHtml=render();
  for(const type of ["food_truck","bar","caterer","private_chef","restaurant"]) {
    await database.update(schema.restaurants).set({businessType:type,isFoodTruck:false}).where(eq(schema.restaurants.id,principal.restaurantId));
    const publicType=type==="food_truck"?"truck":type;
    const context=await actions.getOwnerAiContext(principal.restaurantId);
    assert.equal(context.nativeAdapter.adapter,publicType+"_native");assert.equal(context.nativeAdapter.scheduleStorage,publicType==="truck"?"truck_manual_schedules":"food_business_appearances");
    const cap=await ownerAiProfileCapabilities.read(principal);assert.equal(cap.target.profileType,publicType);assert.equal(cap.profiles.find(p=>p.profileType===publicType)?.adapter,publicType+"_native");
    const source=await proposal();assert.equal(source.packet.sourceFacts.version,2);assert.equal(source.packet.sourceFacts.sections.length,2);assert.equal(source.packet.profile.phone,"+18505550100");
    const d=await draft(),p=await prepare(d);assert.equal(d.currentSnapshot.nativeAdapter.adapter,publicType+"_native");assert.ok(p.consentPrompt.includes(publicType+"_native"));
    fails(await call("approve_mealscout_draft",{draftId:d.id,expectedRevision:d.revision,consentHandle:p.consentHandle}),"EXPLICIT_OWNER_CONSENT_REQUIRED");
    ok(await approve(d,p));
    const [row]=await database.select().from(schema.restaurants).where(eq(schema.restaurants.id,principal.restaurantId));assert.equal(row.phone,"+18505550100");
    const items=await database.select().from(schema.menuItems);assert.equal(items[0].priceCents,1250);
    const canonicalTable=publicType==="truck"?schema.truckManualSchedules:schema.foodBusinessAppearances;
    const rows=await database.select().from(canonicalTable);const saved=rows.find((s:any)=>publicType==="truck"||s.profileType===publicType);assert.ok(saved);assert.equal(saved.timezone,"America/Chicago");assert.equal(saved.sourceArtifact,"https://official.example/");
    const appearances=await buildPublicNativeFoodAppearances({restaurantRow:row,database});
    if(publicType!=="truck") {assert.equal(appearances.length,1);assert.equal(appearances[0].startsAt,start.toUTC().toISO({suppressMilliseconds:false}));assert.equal(saved.ownerId,principal.userId);assert.equal(saved.sourceEvidence.section.captureSha256,hash(render()));}
    const owner=(await database.select().from(schema.users))[0];
    const publicSchedule=publicType==="truck" ? await buildPublicTruckOperatingPlan(row.id,{database}) : await buildPublicEventsPayload({restaurantId:row.id,restaurantRow:row,showAddress:true});
    const publicLink=projectAdmittedFoodProfileLink({...row,...publicSchedule,menuSections:[{name:"Bowls",items:[{name:items[0].name,priceCents:items[0].priceCents}]}]},owner);
    assert.equal(publicLink?.dto.profileType,publicType);assert.equal(publicLink?.dto.phonePublic,"+18505550100");assert.equal(publicLink?.dto.menuSections[0].items[0].priceCents,1250);if(publicType!=="truck")assert.equal(publicLink?.dto.events.items.length,1);else { assert.equal(publicLink?.dto.truckSchedule?.nextStop?.stopId,saved.id); assert.equal(publicLink?.dto.truckSchedule?.nextStop?.date,start.toISODate()); assert.equal(publicLink?.dto.truckSchedule?.nextStop?.startTime,"12:00"); }
    // Each type also crosses the real native HTTP owner-session create and exact-revision apply boundary.
    const path="/api/owner-ai/restaurants/"+principal.restaurantId+"/source-draft";
    assert.equal((await request(path,{},"other-owner")).status,403);
    const native=await request(path,{});assert.equal(native.status,201,JSON.stringify(native));assert.equal(native.body.draft.currentSnapshot.nativeAdapter.adapter,publicType+"_native");
    const approvalPath="/api/owner-ai/drafts/"+native.body.draft.id+"/approve";
    assert.equal((await request(approvalPath,{expectedRevision:native.body.draft.revision+1})).status,409);
    assert.equal((await request(approvalPath,{expectedRevision:native.body.draft.revision})).status,200);
    console.log("PASS "+publicType+": source provenance -> actual native HTTP/MCP drafts -> exact consent/revision -> typed canonical profile/menu/schedule -> public projection");
  }
  const d=await draft(),p=await prepare(d),before=await actions.computeOwnerAiExpectedVersions(principal.restaurantId);
  await database.update(schema.restaurants).set({businessType:"bar"}).where(eq(schema.restaurants.id,principal.restaurantId));
  assert.notEqual((await actions.computeOwnerAiExpectedVersions(principal.restaurantId)).restaurant,before.restaurant);fails(await approve(d,p),"STALE_CONTEXT");
  const row=(await database.select().from(schema.restaurants))[0],appearances=await database.select().from(schema.foodBusinessAppearances),bar=appearances.find(a=>a.profileType==="bar")!;
  const closure=await draft({schemaVersion:"1.0",intent:"Dated owner closure",schedules:[{status:"closed",date:start.toISODate(),timezone:"America/Chicago",expiresAt:start.startOf("day").plus({days:1}).toUTC().toISO(),isPublic:true}]});
  fails(await approve(closure,await prepare(closure)),"public_appearance_closure_conflict");assert.equal((await database.select().from(schema.foodBusinessAppearances)).length,4);
  await database.update(schema.users).set({publicProfileSettings:{showAddress:false}}).where(eq(schema.users.id,principal.userId));assert.equal((await buildPublicNativeFoodAppearances({restaurantRow:row,database,showAddress:true}))[0].addressPublicLabel,null);
  await database.update(schema.users).set({publicProfileSettings:null}).where(eq(schema.users.id,principal.userId));
  for(let page=0;page<2;page++)await database.insert(schema.foodBusinessAppearances).values(Array.from({length:500},(_,i)=>({id:"historical-"+(page*500+i),restaurantId:row.id,ownerId:principal.userId,profileType:"bar",date:new Date("2020-01-01T00:00:00Z"),status:"confirmed",isPublic:true,expiresAt:new Date("2020-01-02T00:00:00Z")})));
  assert.equal((await buildPublicNativeFoodAppearances({restaurantRow:row,database})).length,1);
  assert.equal((await buildPublicNativeFoodAppearances({restaurantRow:{...row,businessType:"restaurant"},database})).length,0);
  await database.update(schema.foodBusinessAppearances).set({isPublic:false}).where(eq(schema.foodBusinessAppearances.id,bar.id));
  const privateConflict=await draft();fails(await approve(privateConflict,await prepare(privateConflict)),"SOURCE_FACT_PRIVATE_SCHEDULE_CONFLICT");assert.equal((await buildPublicNativeFoodAppearances({restaurantRow:row,database})).length,0);
  await database.update(schema.foodBusinessAppearances).set({isPublic:true}).where(eq(schema.foodBusinessAppearances.id,bar.id));
  assert.equal((await buildPublicNativeFoodAppearances({restaurantRow:row,database,showAddress:false}))[0].addressPublicLabel,null);
  await database.update(schema.foodBusinessAppearances).set({sourceEvidence:{bad:true}}).where(eq(schema.foodBusinessAppearances.id,bar.id));assert.equal((await buildPublicNativeFoodAppearances({restaurantRow:row,database})).length,0);
  const transfer=await draft(),transferP=await prepare(transfer);await database.update(schema.restaurants).set({ownerId:"other-owner"}).where(eq(schema.restaurants.id,principal.restaurantId));fails(await approve(transfer,transferP),"ACTUAL_OWNER_REQUIRED");assert.equal((await buildPublicNativeFoodAppearances({restaurantRow:row,database})).length,0);
  console.log("PASS type change without timestamp, private native collision, current hidden address, historical limit exhaustion, atomic closure overlap, corrupt evidence and owner transfer hold; no production customer claim");
  await assert.rejects(engine.exec("insert into food_business_appearances(restaurant_id,owner_id,profile_type,date,status) values ('"+principal.restaurantId+"','fixture-owner','truck',now(),'confirmed')"),/check constraint/);
  await assert.rejects(engine.exec("insert into food_business_appearances(restaurant_id,owner_id,profile_type,date,status) values ('missing','fixture-owner','bar',now(),'confirmed')"),/foreign key/);
  await engine.exec(migration144);assert.equal((await database.select().from(schema.foodBusinessAppearances)).length,1004);
  console.log("PASS actual additive migration144 applies/replays without converting rows; type and native-parent foreign key constraints enforced");
} finally { await new Promise<void>(resolve=>server.close(()=>resolve()));await engine.close(); }
