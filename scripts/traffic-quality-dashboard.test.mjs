import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { parseAcquisitionHours, parseAcquisitionQualityReport } from '../shared/acquisitionQuality.ts';
import { ACQUISITION_QUALITY_SQL, readAcquisitionQuality } from '../server/services/acquisitionQuality.ts';
import { acquireQualityClient, registerAcquisitionQualityRoutes } from '../server/routes/acquisitionQualityRoutes.ts';

const now = new Date('2026-09-22T02:00:00Z');
function fixture() {
  return { version: 1, product: 'mealscout', hours: 24, from: '2026-09-21T02:00:00.000Z', toExclusive: now.toISOString(), recordedRows: 5, entryEvents: 2, actionEvents: 1, profileQualityReports: 2, otherRecords: 0, classifiedAcquisitionEvents: 2, candidateJourneys: 1, candidateJourneysWithAction: 1, quality: [{ classification: 'browser_candidate', entryEvents: 1, actionEvents: 1, qualityReports: 0, otherRecords: 0 }, { classification: 'legacy_unclassified', entryEvents: 1, actionEvents: 0, qualityReports: 1, otherRecords: 0 }, { classification: 'qa_signal', entryEvents: 0, actionEvents: 0, qualityReports: 1, otherRecords: 0 }], sources: [{ source: 'search_labeled', journeys: 1, journeysWithAction: 1 }], verifiedPeople: null, searchImpressions: null, searchClicks: null, verifiedCustomerOutcomes: null, coverage: 'available_retained_records_not_guaranteed_complete' };
}
test('window and projection accept only bounded scalar inputs and reconciled aggregate facts', () => {
  assert.equal(parseAcquisitionHours(undefined),24);
  for (const h of ['6','24','48']) assert.equal(parseAcquisitionHours(h),Number(h));
  for (const h of ['30',24,['24'],{},'',null]) assert.throws(()=>parseAcquisitionHours(h));
  const r = parseAcquisitionQualityReport({...fixture(),privateIdentifier:'secret'});
  assert.equal(r.candidateJourneys,1); assert(!JSON.stringify(r).includes('secret'));
  for (const change of [r=>r.entryEvents=-1,r=>r.entryEvents='2',r=>r.verifiedPeople=1,r=>r.searchImpressions=0,r=>r.quality.push(r.quality[0]),r=>r.sources[0].journeysWithAction=3,r=>r.classifiedAcquisitionEvents=4,r=>r.hours=48,r=>r.coverage='complete',r=>r.sources[0].source='private email']) {const r=fixture();change(r);assert.throws(()=>parseAcquisitionQualityReport(r));}
});
test('historical and quality-only records cannot become zero-person estimates', () => {
  const r={...fixture(),recordedRows:2,entryEvents:1,actionEvents:0,profileQualityReports:1,classifiedAcquisitionEvents:0,candidateJourneys:null,candidateJourneysWithAction:null,quality:[{classification:'legacy_unclassified',entryEvents:1,actionEvents:0,qualityReports:1,otherRecords:0}],sources:[]};
  assert.equal(parseAcquisitionQualityReport(r).candidateJourneys,null);
  assert.throws(()=>parseAcquisitionQualityReport({...r,candidateJourneys:0}));
});
async function http(options, work) {
  const app=express(),queries=[];let connects=0,releases=0;
  const pool=options.noPool?undefined:{connect:async()=>{connects++;if(options.failConnect)throw new Error('private pool password');return {release:()=>releases++,query:async(text,values)=>{queries.push([text,values]);if(text===ACQUISITION_QUALITY_SQL){if(options.failQuery)throw new Error('private SQL detail');return {rows:[{report:options.badPayload?{}:fixture()}]};}return {rows:[]};}};}};
  const authorize=(req,res,next)=>req.headers['x-fixture-admin']==='yes'?next():res.status(req.headers['x-fixture-role']?403:401).json({message:'denied'});
  registerAcquisitionQualityRoutes(app,authorize,pool);
  app.use((_req,res)=>res.status(404).end());
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const get=(query='hours=24',headers={'x-fixture-admin':'yes'})=>fetch(base+'/api/admin/discovery-observatory/traffic-quality?'+query,{headers,signal:AbortSignal.timeout(3000)});
  try{await work({get,queries,base,counts:()=>({connects,releases})});}finally{await new Promise(resolve=>server.close(resolve));}
}
test('registered HTTP route denies non-admin access before parsing or database use',()=>http({},async({get,counts})=>{
  assert.equal((await get('hours=bad',{})).status,401);
  assert.equal((await get('hours=bad',{'x-fixture-role':'member','x-mealscout-qa':'1'})).status,403);
  assert.deepEqual(counts(),{connects:0,releases:0});
}));
test('registered HTTP route runs a bounded readonly transaction and releases its client',()=>http({},async({get,queries,counts})=>{
  const response=await get();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal((await response.json()).report.candidateJourneys,1);
  assert.equal(queries[0][0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert(queries.some(([sql])=>sql==="SET LOCAL TIME ZONE 'UTC'"));assert(queries.some(([sql])=>sql.includes("statement_timeout='8s'")));
  const values=queries.find(([sql])=>sql===ACQUISITION_QUALITY_SQL)[1];assert.equal(Date.parse(values[1])-Date.parse(values[0]),86400000);
  assert.equal(queries.at(-1)[0],'COMMIT');assert.deepEqual(counts(),{connects:1,releases:1});
}));
test('bad or repeated parameters and wrong methods do not acquire a connection',()=>http({},async({get,counts,base})=>{
  for(const query of ['hours=720','hours=24&hours=48','hours[x]=24','hours=bad'])assert.equal((await get(query)).status,400);
  assert.equal((await fetch(base+'/api/admin/discovery-observatory/traffic-quality',{method:'POST'})).status,404);
  assert.deepEqual(counts(),{connects:0,releases:0});
}));
for(const kind of ['noPool','failConnect','failQuery','badPayload'])test(kind+' returns unavailable, never private errors or zero totals',()=>http({[kind]:true},async({get,queries,counts})=>{
  const response=await get();assert.equal(response.status,503);const text=await response.text();assert(!text.includes('private'));assert(!text.includes('candidateJourneys'));
  if(['failQuery','badPayload'].includes(kind)){assert.equal(queries.at(-1)[0],'ROLLBACK');assert.equal(counts().releases,1);}
}));
test('late pool acquisition is released after timeout',async()=>{
  let resolve,releases=0;const promise=acquireQualityClient({connect:()=>new Promise(r=>resolve=r)},5);
  await assert.rejects(promise);resolve({query:async()=>({}),release:()=>releases++});await new Promise(r=>setTimeout(r,5));assert.equal(releases,1);
});
test('real SQL excludes quality reports, tainted journeys, repeats and out-of-window activity',async()=>{
  assert(process.env.MEAL_QUALITY_PGLITE_MODULE,'Explicit disposable SQL fixture tooling is required');
  const {PGlite}=await import(process.env.MEAL_QUALITY_PGLITE_MODULE);const db=new PGlite();
  try{
    await db.exec('CREATE TABLE request_logs(id text primary key,created_at timestamp,metadata jsonb,surface text,event_type text,anonymous_actor_id text,session_id text)');
    let id=0;
    async function row(journey,event,classification,minute,extra={},surface='public_profile'){
      const metadata={anonymousJourneyId:journey,discoverySource:'google',...extra};
      if(classification)metadata.trafficQuality={version:1,basis:'server_observed_request_signals',classification};
      await db.query('INSERT INTO request_logs VALUES($1,$2,$3,$4,$5,NULL,NULL)',[String(++id),new Date(now.getTime()-3600000+minute*60000).toISOString(),JSON.stringify(metadata),surface,event]);
    }
    await row('real','profile_view','browser_candidate',0);await row('real','profile_view','browser_candidate',1);await row('real','profile_action','browser_candidate',2);
    await row('tainted','profile_view','browser_candidate',3);await row('tainted','missing_menu_viewed','qa_signal',4,{discoveryStage:'entry'});
    await row('bot','profile_view','browser_candidate',5);await row('bot','profile_action','automation_signal',6);
    await row('history','profile_view',null,7);await row('quality-only','failed_profile_image','browser_candidate',8,{discoveryStage:'action'});
    await row('later','profile_action','browser_candidate',9);await row('later','profile_view','browser_candidate',10);
    await row('same-end','profile_view','browser_candidate',60);await row('expired','profile_view','browser_candidate',-3000);
    const client={query:(text,values)=>db.query(text,values),release:()=>{}};
    const r=await readAcquisitionQuality(client,24,now);
    assert.equal(r.recordedRows,11);assert.equal(r.entryEvents,6);assert.equal(r.actionEvents,3);assert.equal(r.profileQualityReports,2);assert.equal(r.candidateJourneys,2);assert.equal(r.candidateJourneysWithAction,1);
    const relaxed=ACQUISITION_QUALITY_SQL.replace(/AND NOT EXISTS\(\s*SELECT 1 FROM public\.request_logs bad[\s\S]*?\n    \)/,'');
    assert.notEqual(relaxed,ACQUISITION_QUALITY_SQL);
    await db.query('BEGIN READ ONLY');
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    const negative=await db.query(relaxed,[r.from,r.toExclusive]);
    await db.query('COMMIT');
    assert(negative.rows[0].report.candidateJourneys>r.candidateJourneys);
    await db.exec('DELETE FROM request_logs');await row('legacy','profile_view',null,1);await row('error','missing_menu_viewed','qa_signal',2,{discoveryStage:'entry'});
    const historical=await readAcquisitionQuality(client,24,now);assert.equal(historical.classifiedAcquisitionEvents,0);assert.equal(historical.candidateJourneys,null);assert.equal(historical.profileQualityReports,1);
    console.log('MEAL_TRAFFIC_SQL '+JSON.stringify({passed:true,rawRows:11,entryEvents:6,actions:3,excludedQuality:2,candidates:2,withAction:1,negativeControlDetected:true,historicalUnknown:true}));
  }finally{await db.close();}
});
test('legacy analytics, discovery and evidence UI retain exact content modulo checkout line endings; new route keeps existing admin authority',()=>{
  const base='d64ef420f537b78e00fc93c8d8aa1baba84a976f';
  const original=p=>execFileSync('git',['show',base+':'+p],{encoding:'utf8'});
  const checkedOut=p=>readFileSync(p,'utf8').replace(/\r\n/g,'\n');
  assert.equal(checkedOut('server/routes/analyticsEvidenceRoutes.ts'),original('server/routes/analyticsRoutes.ts'));
  assert.equal(checkedOut('server/routes/discoveryObservatoryRoutes.ts'),original('server/routes/discoveryObservatoryRoutes.ts'));
  assert.equal(checkedOut('client/src/pages/admin-discovery-evidence.tsx'),original('client/src/pages/admin-discovery-observatory.tsx'));
  const registration=readFileSync('server/routes/analyticsRoutes.ts','utf8');assert(registration.includes('registerAcquisitionQualityRoutes(app, isAdmin, pool)'));assert(registration.includes('registerEvidenceAnalyticsRoutes(app)'));
});

test('retained-taint admission is independent of reporting window, with scoped identities', async t => {
  assert(process.env.MEAL_QUALITY_PGLITE_MODULE, 'Explicit disposable SQL fixture tooling is required');
  const { PGlite } = await import(process.env.MEAL_QUALITY_PGLITE_MODULE);
  const db = new PGlite();
  try {
    await db.exec('CREATE TABLE request_logs(id text primary key,created_at timestamp,metadata jsonb,surface text,event_type text,anonymous_actor_id text,session_id text)');
    let sequence = 0;
    const quality = classification => ({ version: 1, basis: 'server_observed_request_signals', classification });
    async function add(journey, event, offsetHours, metadata = {}, surface = 'public_profile', actor = null, session = null) {
      await db.query('INSERT INTO request_logs VALUES($1,$2,$3,$4,$5,$6,$7)', [
        String(++sequence), new Date(now.getTime() + offsetHours * 3600000).toISOString(),
        JSON.stringify({ anonymousJourneyId: journey, discoverySource: 'google', ...metadata }), surface, event, actor, session,
      ]);
    }
    async function seed() {
      await db.exec('TRUNCATE request_logs');
      for (const offset of [-1,-0.9]) await add('fixture-journey', 'profile_view', offset, { trafficQuality: quality('browser_candidate') });
      await add('fixture-journey', 'profile_action', -0.5, { trafficQuality: quality('browser_candidate') });
    }
    const client = { query: (text, values) => db.query(text, values), release: () => {} };
    const scenarios = [
      { name: 'pre-window automation still excludes a recent candidate', hours: -26, classification: 'automation_signal', excluded: true },
      { name: 'retained 47-hour diagnostic excludes even in the 6-hour report', hours: -47, classification: 'qa_signal', excluded: true },
      { name: 'later retained diagnostic revises the earlier candidate', hours: 1, classification: 'qa_signal', excluded: true },
      { name: 'quality errors retain exclusion authority without becoming entries', hours: -2, event: 'missing_menu_viewed', classification: 'qa_signal', excluded: true },
      { name: 'a different journey is not merged', hours: -26, journey: 'different-journey', classification: 'qa_signal', excluded: false },
      { name: 'unrelated operational surfaces are not joined', hours: -26, surface: 'unrelated_operations', classification: 'qa_signal', excluded: false },
      { name: 'unsupported version stays unknown', hours: -26, classification: 'qa_signal', override: { version: 999 }, excluded: false },
      { name: 'client-claimed classification has no server authority', hours: -26, classification: 'qa_signal', override: { basis: 'client_claim' }, excluded: false },
      { name: 'unclassified events are not invented as known automation', hours: -26, classification: 'unclassified', excluded: false },
      { name: 'an anonymous diagnostic without identity does not taint everyone', hours: -26, journey: null, classification: 'qa_signal', excluded: false },
      { name: 'existing anonymous actor fallback is preserved', hours: -26, journey: null, actor: 'fixture-journey', classification: 'qa_signal', excluded: true },
      { name: 'existing session fallback is preserved', hours: -26, journey: null, session: 'fixture-journey', classification: 'qa_signal', excluded: true },
      { name: 'explicit journey identity wins over a conflicting actor fallback', hours: -26, journey: 'different-journey', actor: 'fixture-journey', classification: 'qa_signal', excluded: false },
    ];
    for (const scenario of scenarios) await t.test(scenario.name, async () => {
      await seed();
      await add(Object.hasOwn(scenario, 'journey') ? scenario.journey : 'fixture-journey', scenario.event || 'share_link_copied', scenario.hours,
        { trafficQuality: { ...quality(scenario.classification), ...scenario.override } }, scenario.surface, scenario.actor, scenario.session);
      for (const hours of [6,24,48]) {
        const r = await readAcquisitionQuality(client, hours, now);
        const countedTaint = scenario.surface !== 'unrelated_operations' && scenario.hours >= -hours && scenario.hours < 0;
        assert.equal(r.recordedRows, 3 + Number(countedTaint), 'Raw facts remain bounded to the selected window');
        assert.equal(r.entryEvents, 2);
        assert.equal(r.actionEvents, 1);
        assert.equal(r.candidateJourneys, scenario.excluded ? 0 : 1, 'retained-taint admission');
        assert.equal(r.candidateJourneysWithAction, scenario.excluded ? 0 : 1);
        assert.equal(r.sources.length, scenario.excluded ? 0 : 1);
        for (const field of ['verifiedPeople','searchImpressions','searchClicks','verifiedCustomerOutcomes']) assert.equal(r[field], null);
        assert(!JSON.stringify(r).includes('fixture-journey'), 'No raw identifiers in aggregate output');
      }
    });
    await t.test('retained out-of-window signals cannot establish a missing acquisition baseline', async () => {
      await db.exec('TRUNCATE request_logs');
      await add('fixture-journey','share_link_copied',-26,{trafficQuality:quality('qa_signal')});
      const r = await readAcquisitionQuality(client,24,now);
      assert.equal(r.recordedRows,0);assert.equal(r.classifiedAcquisitionEvents,0);
      assert.equal(r.candidateJourneys,null);assert.deepEqual(r.sources,[]);
    });
  } finally { await db.close(); }
});
