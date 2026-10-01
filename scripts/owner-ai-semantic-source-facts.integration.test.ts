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
delete process.env.DATABASE_URL;
process.env.NODE_ENV = "development";
process.env.OWNER_AI_OAUTH_SECRET = "disposable-local-consent-fixture-000000000000";
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("Settings-only fixture forbids network"); };
const engine = new PGlite();
const tables = [schema.users, schema.restaurants, schema.apiKeys, schema.ownerAiActionDrafts, schema.menus, schema.menuCategories, schema.menuItems, schema.truckManualSchedules, schema.foodBusinessAppearances, schema.deals, schema.socialPostQueue, schema.socialPublishingConnections, schema.telemetryEvents];
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
const token = "disposable_source_fact_fixture_123456789";
await database.insert(schema.users).values({ id: "fixture-owner", isDisabled: false });
await database.insert(schema.restaurants).values({ id: "fixture-business", name: "Fixture", ownerId: "fixture-owner", businessType: "food_truck", isActive: true, websiteUrl: "https://official.example/", updatedAt: new Date() });
await database.insert(schema.apiKeys).values({ id: "fixture-key", userId: "fixture-owner", restaurantId: "fixture-business", keyPrefix: token.slice(0,8), keyHash: await bcrypt.hash(token, 4), purpose: "owner_ai_connector", scope: "owner_ai:context owner_ai:drafts:create owner_ai:drafts:read owner_ai:drafts:approve", isActive: true });
const principal = await actions.authenticateOwnerAiConnector(token, "owner_ai:context");
let seq=1, key=1;
const call = async (name: string, args: any, p=principal) => (await handleOwnerAiMcpRequest(p,{jsonrpc:"2.0",id:seq++,method:"tools/call",params:{name,arguments:args}}) as any).result;
const ok=(r:any)=>{assert.equal(r.isError,undefined,JSON.stringify(r));return r.structuredContent;};
const fails=(r:any,code:string)=>{assert.equal(r.isError,true,JSON.stringify(r));assert.ok(JSON.stringify(r).includes(code),JSON.stringify(r));};
const proposal = async()=>ok(await call("get_mealscout_official_source_facts",{}));
const draft=async(packet?:any)=>{const context=await actions.getOwnerAiContext(principal.restaurantId);return ok(await call("create_mealscout_draft",{idempotencyKey:"source-fixture-"+key++,request:{packet:packet||(await proposal()).packet,expectedVersions:context.expectedVersions}}));};
const prepare=async(d:any)=>ok(await call("prepare_mealscout_approval",{draftId:d.id}));
const approve=(d:any,p:any)=>call("approve_mealscout_draft",{draftId:d.id,expectedRevision:d.revision,consentHandle:p.consentHandle,ownerConfirmation:"approved"});

try {
  const {DateTime}=await import('luxon');
  const {canonicalSourceSection,assertOwnerAiSourceFactBindings}=await import('../shared/ownerAiSourceFacts');
  const {extractOfficialSemanticSections}=await import('../server/services/officialSourceSemanticParser');
  const now=DateTime.now().setZone('America/Chicago');
  const start=now.plus({days:1}).startOf('day').plus({hours:12}),end=start.plus({hours:2});
  const business:any={'@type':'FoodTruck',url:'https://official.example/',hasMenu:{'@type':'Menu',name:'Current Menu',hasMenuSection:{'@type':'MenuSection',name:'Bowls',hasMenuItem:{'@type':'MenuItem',name:'Berry bowl',description:'Berries and granola',offers:{'@type':'Offer',price:'12.50',priceCurrency:'USD',availability:'https://schema.org/InStock',validFrom:now.minus({days:1}).toISO(),validThrough:now.plus({days:5}).toISO()}}}}};
  const event:any={'@type':'FoodEvent',name:'Public market',performer:{'@type':'FoodTruck',url:'https://official.example/'},eventStatus:'https://schema.org/EventScheduled',eventAttendanceMode:'https://schema.org/OfflineEventAttendanceMode',audience:{'@type':'Audience',audienceType:'General public'},additionalProperty:{'@type':'PropertyValue',name:'IANA timezone',value:'America/Chicago'},startDate:start.toISO(),endDate:end.toISO(),location:{'@type':'Place',name:'Market',address:{'@type':'PostalAddress',streetAddress:'1 Public Street',addressLocality:'Pensacola',addressRegion:'FL'}}};
  const render=(b=business,e=event)=>'<script type="application/ld+json">'+JSON.stringify({'@context':'https://schema.org','@graph':[b,e]})+'</script>';
  const capture=(body:string)=>({sourceUrl:'https://official.example/',finalUrl:'https://official.example/',body:Buffer.from(body),contentType:'text/html',checkedAt:new Date().toISOString(),bodyHash:hash(body)});
  (globalThis as any).__sourceHtml=render();
  const source=await proposal();
  assert.equal(source.packet.sourceFacts.version,2);assert.equal(source.packet.sourceFacts.sections.length,2);
  assert.equal(source.packet.menus[0].categories[0].items[0].priceCents,1250);
  assert.equal(source.packet.schedules[0].timezone,'America/Chicago');assert.equal(source.packet.schedules[0].date,start.toISODate());
  assert.equal(source.mutationPerformed,false);assert.equal((await database.select().from(schema.ownerAiActionDrafts)).length,0);
  for(const section of source.packet.sourceFacts.sections)assert.equal(section.value,canonicalSourceSection(source.packet[section.path]));
  const forged=structuredClone(source.packet);forged.menus[0].categories[0].items[0].priceCents=1;
  await assert.rejects(draft(forged),/SOURCE_FACT_VALUE_MISMATCH/);
  const d=await draft(), p=await prepare(d);
  assert.ok(p.consentPrompt.includes('Official source field evidence'));assert.deepEqual(p.packet.sourceFacts,d.packet.sourceFacts);
  fails(await call('approve_mealscout_draft',{draftId:d.id,expectedRevision:d.revision,consentHandle:p.consentHandle}),'EXPLICIT_OWNER_CONSENT_REQUIRED');
  ok(await approve(d,p));
  assert.equal((await database.select().from(schema.menuItems))[0].priceCents,1250);
  const stop=(await database.select().from(schema.truckManualSchedules))[0];
  assert.equal(stop.timezone,'America/Chicago');assert.equal(stop.sourceArtifact,'https://official.example/');assert.equal(stop.isPublic,true);
  console.log('PASS real authenticated MCP proposal -> native menu/schedule draft -> evidence-bound exact consent -> canonical in-memory menu price and public dated stop writes');
  const changed=await draft(),changedP=await prepare(changed);
  business.hasMenu.hasMenuSection.hasMenuItem.offers.price='13.00';(globalThis as any).__sourceHtml=render();
  fails(await approve(changed,changedP),'SOURCE_FACT_CHANGED_OR_CONFLICTING');
  business.hasMenu.hasMenuSection.hasMenuItem.offers.price='12.50';
  const negatives:any[]=[];
  const bad=(edit:(b:any,e:any)=>void,section:string)=>{const b=structuredClone(business),e=structuredClone(event);edit(b,e);negatives.push({body:render(b,e),section});};
  bad(b=>{delete b.hasMenu.hasMenuSection.hasMenuItem.offers.validFrom},'menus');
  bad(b=>{b.hasMenu.hasMenuSection.hasMenuItem.offers.priceCurrency='EUR'},'menus');
  bad(b=>{b.hasMenu.hasMenuSection.hasMenuItem.offers.validThrough=now.minus({days:1}).toISO()},'menus');
  bad(b=>{b.hasMenu.hasMenuSection.hasMenuItem.offers.price='12.999'},'menus');
  bad((b,e)=>{e.performer.url='https://other.example/'},'schedules');
  bad((b,e)=>{delete e.audience},'schedules');
  bad((b,e)=>{e.name='Private wedding'},'schedules');
  bad((b,e)=>{e.startDate='October 2 at noon'},'schedules');
  bad((b,e)=>{e.additionalProperty.value='UTC'},'schedules');
  bad((b,e)=>{e.eventStatus='https://schema.org/EventCancelled'},'schedules');
  for(const probe of negatives)assert.equal(extractOfficialSemanticSections(capture(probe.body)).sections.some(s=>s.path===probe.section),false,probe.body);
  const expired=structuredClone(source.packet);expired.sourceFacts.sections[0].expiresAt=now.minus({seconds:1}).toUTC().toISO();assert.throws(()=>assertOwnerAiSourceFactBindings(expired),/SOURCE_FACT_EXPIRED/);
  const smuggled=structuredClone(source.packet);smuggled.settings={socialPosting:{promptBeforePost:false}};assert.throws(()=>assertOwnerAiSourceFactBindings(smuggled),/SOURCE_FACT_UNSUPPORTED_CHANGE/);
  console.log('PASS changed-after-consent prices and forged section values fail; missing/current dates, USD precision, expired offers, wrong performer, missing public access, private wedding, guessed dates, mismatched zone and cancelled events held');

  (globalThis as any).__sourceHtml=render();
  const itemRow=(await database.select().from(schema.menuItems))[0],categoryRow=(await database.select().from(schema.menuCategories))[0],menuRow=(await database.select().from(schema.menus))[0];
  await database.update(schema.menuItems).set({imageUrl:'https://owner.example/image.png',dietaryTags:['owner-tag'],allergens:['owner-allergen'],sortOrder:7}).where(eq(schema.menuItems.id,itemRow.id));
  await database.update(schema.menuCategories).set({description:'Owner category description',sortOrder:9}).where(eq(schema.menuCategories.id,categoryRow.id));
  await database.update(schema.menus).set({availableFrom:'11:00',availableTo:'14:00'}).where(eq(schema.menus.id,menuRow.id));
  const preserveDraft=await draft();assert.ok(preserveDraft.normalizedPlan.some((n:any)=>n.mergePolicy?.includes('omitted owner metadata')));ok(await approve(preserveDraft,await prepare(preserveDraft)));
  const itemSaved=(await database.select().from(schema.menuItems))[0],catSaved=(await database.select().from(schema.menuCategories))[0],menuSaved=(await database.select().from(schema.menus))[0];
  assert.equal(itemSaved.imageUrl,'https://owner.example/image.png');assert.deepEqual(itemSaved.dietaryTags,['owner-tag']);assert.deepEqual(itemSaved.allergens,['owner-allergen']);assert.equal(itemSaved.sortOrder,7);assert.equal(catSaved.description,'Owner category description');assert.equal(catSaved.sortOrder,9);assert.equal(menuSaved.availableFrom,'11:00');assert.equal(menuSaved.availableTo,'14:00');
  await database.update(schema.menuItems).set({itemType:'drink'}).where(eq(schema.menuItems.id,itemRow.id));
  const classification=await draft();fails(await approve(classification,await prepare(classification)),'SOURCE_FACT_MENU_TYPE_CONFLICT');assert.equal((await database.select().from(schema.menuItems))[0].itemType,'drink');
  await database.update(schema.menuItems).set({itemType:'food'}).where(eq(schema.menuItems.id,itemRow.id));
  await database.update(schema.truckManualSchedules).set({isPublic:false}).where(eq(schema.truckManualSchedules.id,stop.id));
  const privateConflict=await draft();fails(await approve(privateConflict,await prepare(privateConflict)),'SOURCE_FACT_PRIVATE_SCHEDULE_CONFLICT');assert.equal((await database.select().from(schema.truckManualSchedules))[0].isPublic,false);
  await database.update(schema.truckManualSchedules).set({isPublic:true}).where(eq(schema.truckManualSchedules.id,stop.id));
  const intervalChanged=await draft(),intervalP=await prepare(intervalChanged);business.hasMenu.hasMenuSection.hasMenuItem.offers.validThrough=now.plus({days:4}).toISO();(globalThis as any).__sourceHtml=render();fails(await approve(intervalChanged,intervalP),'SOURCE_FACT_CHANGED_OR_CONFLICTING');
  business.hasMenu.hasMenuSection.hasMenuItem.offers.validThrough=now.plus({days:5}).toISO();(globalThis as any).__sourceHtml=render();
  const nested=structuredClone(business);nested['@context']='https://other.example/';assert.equal(extractOfficialSemanticSections(capture(render(nested,event))).sections.length,0);
  console.log('PASS omitted owner menu metadata retained; native classification/private-row conflicts roll back; exact effective-date changes and scoped foreign context held');

  console.log('PASS disposable local owners only; no production DB, customer drafts, credentials or canonical customer writes');
} finally { await engine.close(); }
