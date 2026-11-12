import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import Stripe from 'stripe';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import * as orm from 'drizzle-orm';
import {getTableConfig} from 'drizzle-orm/pg-core';
import * as schema from '../shared/schema.ts';
import * as reconciliation from '../server/reconcilePayoutTransfer.ts';
import * as hostService from '../server/hostPayoutExecutionService.ts';
// Real disposable PostgreSQL engine, real Drizzle table definitions and routes.
// Fixture DDL deliberately excludes unrelated foreign keys/defaults; this is
// route/write/transaction proof, not full-migration or multi-process lock proof.
const pg=new PGlite();const db=drizzle(pg);
for(const table of [schema.hostPayoutRequests,schema.hostEarningsLedger,schema.affiliateWithdrawals]) {
 const cfg=getTableConfig(table);await pg.exec(`CREATE TABLE "${cfg.name}" (${cfg.columns.map(c=>`"${c.name}" ${c.getSQLType()}${c.primary?' PRIMARY KEY DEFAULT gen_random_uuid()':''}${c.notNull?' NOT NULL':''}`).join(',')})`);
}
await pg.exec('CREATE TABLE hosts(id varchar PRIMARY KEY, stripe_connect_account_id varchar, stripe_payouts_enabled boolean);');
await pg.exec("INSERT INTO hosts VALUES ('h1','acct_one',true)");
let transfers=new Map(),creates=0,gets=0,failAfterSend=false;
const stripe=new Stripe('sk_test_unused',{maxNetworkRetries:0,httpClient:{getClientName:()=> 'offline-postgres',makeRequest:async(h,p,path,method,headers,body)=>{
 let result;
 if(method==='POST') {
  assert.equal(path,'/v1/transfers');creates++;
  const params=new URLSearchParams(body);const key=headers['Idempotency-Key'];
  result=transfers.get(key);if(!result){result={id:'tr_'+(transfers.size+1),amount:Number(params.get('amount')),currency:params.get('currency'),destination:params.get('destination'),reversed:false,amount_reversed:0,metadata:Object.fromEntries([...params].filter(([k])=>k.startsWith('metadata[')).map(([k,v])=>[k.slice(9,-1),v]))};transfers.set(key,result);}
  if(failAfterSend){failAfterSend=false;throw new Error('simulated response loss after provider accepted');}
 } else {assert.equal(method,'GET');gets++;result=path.includes('?')?{data:[...transfers.values()],has_more:false}:[...transfers.values()].find(t=>path.endsWith('/'+t.id));if(!result)throw new Error('missing provider transfer');}
 return {getRawResponse:()=>({}),getStatusCode:()=>200,getHeaders:()=>({}),toJSON:async()=>structuredClone(result)};
}}});
function loadRoute(file,kind){
 const source=fs.readFileSync(new URL('../server/'+file,import.meta.url),'utf8');const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports={};const require=p=>{if(p.endsWith('reconcilePayoutTransfer'))return reconciliation;if(p.endsWith('hostPayoutExecutionService'))return hostService;if(p.endsWith('hostEarningsService'))return {getHostEarningsSummary:async()=>({fixtureResponseSummary:true})};if(p==='stripe')return class{constructor(){return stripe}};if(p.endsWith('/db'))return {db};if(p.endsWith('unifiedAuth'))return {isAuthenticated:()=>{},isStaffOrAdmin:()=>{},isAdmin:()=>{}};if(p==='@shared/schema')return schema;if(p==='drizzle-orm')return orm;throw new Error('Unexpected '+p)};
 vm.runInNewContext(js,{exports,require,process:{env:{STRIPE_SECRET_KEY:'fixture'}},console,Date});
 const routes=new Map();const app={get:()=>{},post:(p,...h)=>routes.set(p,h.at(-1)),patch:(p,...h)=>routes.set(p,h.at(-1))};
 if(kind==='host')exports.registerHostPayoutAdminRoutes(app);else exports.registerAffiliateAdminRoutes(app,{requireAdminUser:()=>true});
 return routes.get(kind==='host'?'/api/admin/host-payout-requests/:requestId':'/api/admin/affiliate-payouts/:id/mark-paid');
}
const host=loadRoute('routes/hostPayoutAdminRoutes.ts','host');const affiliate=loadRoute('routes/admin/affiliateAdminRoutes.ts','affiliate');
async function call(handler,id,extra={}){const res={code:200,body:null,status(n){this.code=n;return this},json(b){this.body=b;return this}};await handler({params:{id,requestId:id},body:{status:'paid',...extra},user:{id:'admin'}},res);return res;}
async function row(table,id){return (await pg.query(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows[0]}
await db.insert(schema.hostPayoutRequests).values({id:'hpay1',hostId:'h1',userId:'u1',amountCents:3000,status:'approved'});
const race=await Promise.all([call(host,'hpay1'),call(host,'hpay1')]);assert.equal(race.filter(r=>r.code===200).length,1);assert.equal(creates,1);assert.equal((await row('host_payout_requests','hpay1')).status,'paid');assert.equal((await pg.query('SELECT count(*)::int n FROM host_earnings_ledger')).rows[0].n,1);
await db.insert(schema.hostPayoutRequests).values({id:'hpay2',hostId:'h1',userId:'u1',amountCents:3000,status:'approved'});
failAfterSend=true;assert.notEqual((await call(host,'hpay2')).code,200);assert.equal((await row('host_payout_requests','hpay2')).status,'processing');const sent=creates;assert.equal((await call(host,'hpay2')).code,200);assert.equal(creates,sent);
await db.insert(schema.hostPayoutRequests).values({id:'hpay3',hostId:'h1',userId:'u1',amountCents:3000,status:'processing',notes:'stripe_transfer:tr_fabricated'});assert.notEqual((await call(host,'hpay3',{manualPayoutConfirmed:true})).code,200);assert.equal((await row('host_payout_requests','hpay3')).status,'processing');
const approval={rail:'stripe_transfer',destination:'acct_one',amount:'30.00',currency:'usd',approvedBy:'admin',approvedAt:new Date().toISOString()};
await db.insert(schema.affiliateWithdrawals).values({id:'apay1',userId:'u1',amount:'30.00',method:'stripe',status:'approved',methodDetails:{approvedExecution:approval}});
const before=creates;const arace=await Promise.all([call(affiliate,'apay1'),call(affiliate,'apay1')]);assert.equal(arace.filter(r=>r.code===200).length,1);assert.equal(creates,before+1);assert.equal((await row('affiliate_withdrawals','apay1')).status,'paid');
await db.insert(schema.affiliateWithdrawals).values({id:'apay2',userId:'u1',amount:'30.00',method:'stripe',status:'approved',methodDetails:{approvedExecution:approval}});failAfterSend=true;assert.notEqual((await call(affiliate,'apay2')).code,200);const afterLost=creates;assert.equal((await call(affiliate,'apay2')).code,200);assert.equal(creates,afterLost);
// Force the ledger insert to fail after row update inside the actual transaction.
await pg.exec("CREATE FUNCTION fail_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture ledger failure'; END $$; CREATE TRIGGER fail_ledger BEFORE INSERT ON host_earnings_ledger FOR EACH ROW EXECUTE FUNCTION fail_ledger();");
await db.insert(schema.hostPayoutRequests).values({id:'hpay4',hostId:'h1',userId:'u1',amountCents:3000,status:'approved'});
assert.notEqual((await call(host,'hpay4')).code,200);assert.equal((await row('host_payout_requests','hpay4')).status,'processing');
const rollbackSends=creates;await pg.exec('DROP TRIGGER fail_ledger ON host_earnings_ledger;');
assert.equal((await call(host,'hpay4')).code,200);assert.equal(creates,rollbackSends);
assert.equal((await pg.query("SELECT count(*)::int n FROM host_earnings_ledger WHERE description LIKE '%hpay4%'")).rows[0].n,1);
console.log('PASS: actual SQL transaction rollback after ledger failure, retry reconciles without new send.');
await pg.close();console.log('PASS: actual host/affiliate routes + disposable PGlite PostgreSQL: concurrent approved claims, real SQL ledger/finalization, lost response reconciliation, fabricated note hold. Single-engine concurrency only; zero external Stripe calls.');
