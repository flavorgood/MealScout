import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import Stripe from 'stripe';
import * as reconciliation from '../server/reconcilePayoutTransfer.ts';
const source=fs.readFileSync(new URL('../server/routes/admin/affiliateAdminRoutes.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText;
const proven={id:'tr_one',amount:3000,currency:'usd',destination:'acct_one',reversed:false,amount_reversed:0,metadata:{affiliateWithdrawalId:'p1',affiliateUserId:'u1'}};
for (const result of [proven,{...proven,metadata:{}},{...proven,destination:'acct_wrong'},{...proven,reversed:true},new Error('provider unavailable')]) {
 let updates=0,requests=0;
 const stripe=new Stripe('sk_test_unused',{maxNetworkRetries:0,httpClient:{getClientName:()=> 'offline-route',makeRequest:async(h,p,path,method)=>{requests++;assert.equal(method,'GET');assert.equal(path,'/v1/transfers/tr_one');if(result instanceof Error)throw result;return {getRawResponse:()=>({}),getStatusCode:()=>200,getHeaders:()=>({}),toJSON:async()=>structuredClone(result)};}}});
 const existing={id:'p1',userId:'u1',status:'processing',notes:'stripe_transfer:tr_one',methodDetails:{executionClaim:{rail:'stripe_transfer',destination:'acct_one',amountCents:3000,currency:'usd',idempotencyKey:'affiliate_withdrawal_p1'}}};
 const db={select:()=>({from:()=>({where:()=>({limit:async()=>[existing]})})}),update:()=>{updates++;return {set:()=>({where:()=>({returning:async()=>[{...existing,status:'paid'}]})})}}};
 const schema=new Proxy({}, {get:(_,name)=>({id:String(name)+'.id',status:String(name)+'.status'})});
 const exports={};const require=p=>{
 if(p==='../../reconcilePayoutTransfer')return reconciliation;
 if(p==='stripe')return class {constructor(){return stripe;}};
 if(p==='../../db')return {db};
 if(p==='../../unifiedAuth')return {isAuthenticated:()=>{},isStaffOrAdmin:()=>{}};
 if(p==='@shared/schema')return schema;
 if(p==='drizzle-orm')return {eq:()=>true,and:()=>true,or:()=>true,sql:()=>{},desc:()=>{},isNull:()=>{}};
 throw new Error('Unexpected import '+p);
 };
 vm.runInNewContext(js,{exports,require,process:{env:{STRIPE_SECRET_KEY:'sk_test_unused'}},console,Date});
 const routes=new Map();const app={get:()=>{},post:(path,...handlers)=>routes.set(path,handlers.at(-1)),patch:()=>{}};
 exports.registerAffiliateAdminRoutes(app,{requireAdminUser:()=>true});
 const res={code:200,body:null,status(n){this.code=n;return this},json(b){this.body=b;return this}};
 await routes.get('/api/admin/affiliate-payouts/:id/mark-paid')({params:{id:'p1'},user:{id:'admin'}},res);
 assert.equal(requests,1);assert.equal(updates,result===proven?1:0);assert.equal(res.code,result===proven?200:502);
}
console.log('PASS: 5 actual affiliate route cases through real SDK18.5 offline transport; unproven refs never mark paid.');
