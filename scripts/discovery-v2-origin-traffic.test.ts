import assert from "node:assert/strict";
import test from "node:test";
import { classifyDiscoveryRequest } from "../server/services/discoveryRequestSignals";
import { readAcquisitionQuality } from "../server/services/acquisitionQuality";
import { parseAcquisitionQualityReport } from "../shared/acquisitionQuality";

const browser = { "user-agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/130.0 Safari/537.36", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" };
test("v2 health and automation signals cannot enter browser-candidate acquisition", () => {
  for (const path of ["/api/health", "/health", "/api/health/", "/health/ready", "/health/payments", "/health/critical-endpoints", "/api/health/details"]) {
    const q = classifyDiscoveryRequest({path,headers:browser});
    assert.equal(q.version,2); assert.equal(q.classification,"infrastructure_monitor");
  }
  assert.equal(classifyDiscoveryRequest({path:"/health-food",headers:browser}).classification,"browser_candidate");
  assert.equal(classifyDiscoveryRequest({path:"/api/health",headers:{...browser,"x-mealscout-qa":"1"}}).classification,"qa_signal");
  assert.equal(classifyDiscoveryRequest({headers:{...browser,"user-agent":"Mozilla/5.0 HeadlessChrome Googlebot/2.1"}}).classification,"automation_signal");
  assert.equal(classifyDiscoveryRequest({headers:{"x-mealscout-traffic-class":"human"}}).classification,"unclassified");
  for (const ua of ["GPTBot/1.0", "PerplexityBot/1.0", "CCBot/2.0", "cohere-ai", "Claude-SearchBot/1.0", "Claude-User/1.0"]) {
    assert.equal(classifyDiscoveryRequest({headers:{...browser,"user-agent":ua}}).classification,"discovery_crawler",ua);
  }
});

test("real SQL supports old and new versions, retained taint, and separate origin counters", async () => {
  const modulePath=process.env.MEAL_QUALITY_PGLITE_MODULE;
  assert(modulePath,"An explicit disposable PGlite module is required");
  const {PGlite}=await import(modulePath); const db=new PGlite();
  const now=new Date("2026-09-29T18:00:00.000Z"); let sequence=0;
  try {
    await db.exec(`CREATE TABLE request_logs(id text primary key,created_at timestamp,metadata jsonb,surface text,event_type text,anonymous_actor_id text,session_id text,method text,path text,user_agent text,status_code int)`);
    const client={query:(text:string,values?:any[])=>db.query(text,values),release:()=>{}};
    async function event(journey:string,classification:string,version=2,hours=-1,eventType="profile_view",basis="server_observed_request_signals") {
      await db.query("INSERT INTO request_logs(id,created_at,metadata,surface,event_type,method) VALUES($1,$2,$3,'public_profile',$4,'EVENT')",[String(++sequence),new Date(now.getTime()+hours*3600000).toISOString(),JSON.stringify({anonymousJourneyId:journey,discoverySource:"google",trafficQuality:{version,basis,classification}}),eventType]);
    }
    await event("v1-good","browser_candidate",1);
    await event("v2-good","browser_candidate"); await event("v2-good","browser_candidate",2,-0.5,"profile_action");
    for (const classification of ["discovery_crawler","infrastructure_monitor","automation_signal","qa_signal"]) {
      await event(classification,"browser_candidate"); await event(classification,classification,2,-26,"missing_menu_viewed");
    }
    await event("old-bot","browser_candidate"); await event("old-bot","automation_signal",1,-26);
    await event("future-version","browser_candidate",999);
    await event("client-forgery","browser_candidate",2,-1,"profile_view","client_claim");
    await event("v1-invalid-new-class","discovery_crawler",1);
    await event("crawler-entry","discovery_crawler");
    await event("monitor-entry","infrastructure_monitor");
    const rawCases:[string,string|null,number,string][]=[
      ["/api/health",browser["user-agent"],200,"HEAD"],
      ["/?private=do-not-return","UptimeRobot/2.0",503,"GET"],
      ["/health/ready",browser["user-agent"],200,"GET"],
      ["/health/payments",null,200,"GET"],
      ["/truck/missing--fixture","Googlebot/2.1",404,"GET"],
      ["/sitemap.xml","ClaudeBot/1.0",200,"GET"],
      ["/robots.txt","OAI-SearchBot/1.0",200,"GET"],
      ["/robots.txt","GPTBot/1.0",200,"GET"],
      ["/robots.txt","PerplexityBot/1.0",200,"GET"],
      ["/robots.txt","CCBot/2.0",200,"GET"],
      ["/robots.txt","cohere-ai",200,"GET"],
      ["/","curl/8.0",200,"GET"],
      ["/","Mozilla/5.0 HeadlessChrome AppleWebKit/537.36",200,"GET"],
      ["/health-food",browser["user-agent"],200,"GET"],
      ["/",null,200,"GET"],
    ];
    for (const [path,ua,status,method] of rawCases) await db.query("INSERT INTO request_logs(id,created_at,metadata,surface,event_type,method,path,user_agent,status_code) VALUES($1,$2,'{}','web','page_view',$3,$4,$5,$6)",[String(++sequence),new Date(now.getTime()-3600000).toISOString(),method,path,ua,status]);
    const result=await readAcquisitionQuality(client,24,now,{includeOriginRequests:true});
    assert.equal(result.candidateJourneys,2); assert.equal(result.candidateJourneysWithAction,1);
    assert(result.quality.some((row:any)=>row.classification==="discovery_crawler"&&row.entryEvents===1));
    assert(result.quality.some((row:any)=>row.classification==="infrastructure_monitor"&&row.entryEvents===1));
    assert.equal(result.quality.find((row:any)=>row.classification==="unclassified")?.entryEvents,3);
    assert.deepEqual(result.originRequests,{totalRequests:15,infrastructureMonitorRequests:4,discoveryCrawlerRequests:7,automationRequests:2,browserShapedRequests:1,unclassifiedRequests:1,errorRequests:2,coverage:"retained_origin_requests_not_edge_pageviews"});
    assert.equal(result.verifiedPeople,null); assert.equal(result.searchClicks,null);
    assert(!JSON.stringify(result).includes("do-not-return")); assert(!JSON.stringify(result).includes(browser["user-agent"]));
    assert.throws(()=>parseAcquisitionQualityReport({...result,originRequests:{...result.originRequests,totalRequests:16}}));
    for(const hours of [6,24,48] as const) assert.equal((await readAcquisitionQuality(client,hours,now)).candidateJourneys,2);
    await db.exec("TRUNCATE request_logs");
    const empty=await readAcquisitionQuality(client,24,now,{includeOriginRequests:true});
    assert.equal(empty.originRequests?.totalRequests,0); assert.equal(empty.candidateJourneys,null);
    console.log("DISCOVERY_V2_SQL_PROOF "+JSON.stringify({passed:true,originRequests:15,monitorRequests:4,crawlerSignals:7,candidateJourneys:2,candidateActions:1,legacyCompatible:true,rawIdentifiersExposed:false}));
  } finally { await db.close(); }
});
