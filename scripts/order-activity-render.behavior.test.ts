import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root=process.cwd();
const dir=mkdtempSync(path.join(root,'.activity-render-'));
const statuses=['out_for_delivery','delivered','payment_disputed','cancellation_pending','completed','future'];
const fixture={search:'', userType:'customer'};
const g=globalThis as any;
g.__activityFixture=fixture;
try {
 await build({entryPoints:['client/src/pages/orders.tsx'],bundle:true,platform:'node',format:'cjs',jsx:'automatic',outfile:path.join(dir,'page.cjs'),external:['react','react-dom','react/jsx-runtime','lucide-react','date-fns'],plugins:[{name:'synthetic-reads',setup(b){
 b.onResolve({filter:/^(@\/|wouter$|@tanstack\/react-query$)/},a=>a.path==='@/lib/order-activity-status'?{path:path.join(root,'client/src/lib/order-activity-status.ts')}:{path:a.path,namespace:'fixture'});
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>{
 const prefix='Object.defineProperty(exports, "__esModule", {value:true}); const React=require("react"); const fixture=globalThis.__activityFixture;';
 let text='';
 if(a.path==='wouter') text='exports.useSearch=()=>fixture.search; exports.Link=({children,...props})=>React.createElement("a",props,children);';
 else if(a.path==='@/hooks/useAuth') text='exports.useAuth=()=>({user:{id:"synthetic",userType:fixture.userType},isAuthenticated:true,isLoading:false});';
 else if(a.path==='@tanstack/react-query') text=`exports.useQuery=({queryKey})=>({data:queryKey[0]==='/api/my/orders'?{orders:${JSON.stringify(statuses)}.map((status,i)=>({id:'synthetic-'+i,status,orderType:'pickup',paymentMethod:'card',totalCents:100,createdAt:'2026-11-10T12:00:00Z'}))}:[],isLoading:false,error:null});`;
 else if(a.path.includes('owner-orders-workspace')) text='module.exports=()=>React.createElement("div",null,"OWNER WORKSPACE"); module.exports.isBusinessOrderOperator=t=>t==="restaurant_owner";';
 else if(a.path.includes('deal-claim-state')) text='exports.dealClaimStatus=()=>"Active"; exports.displayClaimStatus=s=>s; exports.isDealAuthenticationError=()=>false; exports.readClaimList=s=>s; exports.receiptDateLabel=()=>"date";';
 else if(a.path.includes('queryClient')) text='exports.apiRequest=()=>{throw new Error("No real API allowed")};';
 else if(a.path.includes('seo-head')) text='exports.SEOHead=()=>null;';
 else if(a.path.includes('deal-claim-modal')) text='module.exports=()=>null;';
 else text='for(const name of ["Button","Badge","Card","CardContent"]) exports[name]=({children,asChild,...props})=>React.createElement("div",props,children);';
 return {contents:prefix+text,loader:'js'};
 });
 }}]});
 const React=require('react'); const {renderToStaticMarkup}=require('react-dom/server');const Page=require(path.join(dir,'page.cjs')).default;
 test('real consumer page binds status labels and complete counts',()=>{
  const html=renderToStaticMarkup(React.createElement(Page));
  for(const text of ['Out for delivery','Delivered','Payment under review','Cancellation processing','Completed','Status unavailable','4 active','1 past','1 status unavailable']) assert.ok(html.includes(text),text);
  assert.ok(!html.includes('Received'));assert.equal((html.match(/View status/g)||[]).length,6);
 });
 test('business owner still receives owner workspace',()=>{fixture.userType='restaurant_owner'; assert.ok(renderToStaticMarkup(React.createElement(Page)).includes('OWNER WORKSPACE'));});
 test('owner claimed-deals route still receives customer wallet',()=>{fixture.search='?view=deals';const html=renderToStaticMarkup(React.createElement(Page));assert.ok(html.includes('No claimed deals yet'));assert.ok(!html.includes('OWNER WORKSPACE'));});
} finally { rmSync(dir,{recursive:true,force:true}); }
