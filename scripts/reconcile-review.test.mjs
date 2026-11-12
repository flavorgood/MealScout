import assert from 'node:assert/strict';
import Stripe from 'stripe';
import {reconcilePayoutTransfer} from '../server/reconcilePayoutTransfer.ts';
import {executeHostPayout} from '../server/hostPayoutExecutionService.ts';
const expected={metadataKey:'payoutRequestId',payoutId:'p1',amount:3000,currency:'usd',destination:'acct_one'};
const transfer={id:'tr_one',amount:3000,currency:'usd',destination:'acct_one',reversed:false,amount_reversed:0,metadata:{payoutRequestId:'p1'}};
let calls=[];
function client(pages){ calls=[];return new Stripe('sk_test_unused',{maxNetworkRetries:0,httpClient:{getClientName:()=> 'offline-review',makeRequest:async(host,port,path,method)=>{calls.push({path,method});assert.equal(method,'GET');assert.ok(path.startsWith('/v1/transfers?'));const page=pages.shift();if(page instanceof Error)throw page;return {getRawResponse:()=>({}),getStatusCode:()=>200,getHeaders:()=>({'request-id':'offline'}),toJSON:async()=>page};}}});}
await assert.doesNotReject(()=>reconcilePayoutTransfer(client([{data:[transfer],has_more:false}]),expected));
assert.equal(calls.length,1);
for(const patch of [{amount:1},{destination:'acct_other'},{currency:'eur'},{reversed:true},{amount_reversed:1}])await assert.rejects(()=>reconcilePayoutTransfer(client([{data:[{...transfer,...patch}],has_more:false}]),expected));
await assert.rejects(()=>reconcilePayoutTransfer(client([{data:[],has_more:false}]),expected));
await assert.rejects(()=>reconcilePayoutTransfer(client([{data:[transfer,{...transfer,id:'tr_two'}],has_more:false}]),expected));
await assert.rejects(()=>reconcilePayoutTransfer(client([new Error('offline failure')]),expected));
await assert.rejects(()=>reconcilePayoutTransfer(client([{data:[],has_more:true}]),expected));
await reconcilePayoutTransfer(client([{data:[{...transfer,id:'tr_other',metadata:{}}],has_more:true},{data:[transfer],has_more:false}]),expected);
assert.ok(calls[1].path.includes('starting_after=tr_other'));
await assert.rejects(()=>reconcilePayoutTransfer(client(Array.from({length:20},(_,i)=>({data:[{...transfer,id:'tr_'+i,metadata:{}}],has_more:true}))),expected));assert.equal(calls.length,20);
let sends=0,finalizes=0;
const outcome=await executeHostPayout({claimProcessing:async()=>null,finalizePaid:async()=>{finalizes++;return null;}},{findTransferByPayoutRequestId:async()=>null,createTransfer:async()=>{sends++;return {id:'tr_bad'}}},{request:{id:'p1',hostId:'h',userId:'u',amountCents:3000,status:'processing',notes:null},destination:{stripeConnectAccountId:'acct_one',stripePayoutsEnabled:true},stripeConfigured:true,adminUserId:'a',notes:null,manualPayoutConfirmed:false});
assert.equal(outcome.outcome,'transfer_failed');assert.equal(sends,0);assert.equal(finalizes,0);
console.log('PASS: 13 offline reconciliation cases, real SDK request construction; zero external requests or transfers.');

for (const stripeConfigured of [true,false]) {
 const r=await executeHostPayout({claimProcessing:async()=>null,finalizePaid:async()=>{throw new Error('must not finalize')}},null,{request:{id:'p1',hostId:'h',userId:'u',amountCents:3000,status:'processing',notes:null},destination:{stripeConnectAccountId:null,stripePayoutsEnabled:false},stripeConfigured,adminUserId:'a',notes:null,manualPayoutConfirmed:true});
 assert.equal(r.outcome,'transfer_failed');
}
console.log('PASS: removed destination/manual fallback held both with and without Stripe config. SDK', Stripe.PACKAGE_VERSION);

// Recorded notes never count as provider proof. Exercise real SDK retrieve
// through a transport that cannot send money, then actual host execution.
const {verifyRecordedPayoutTransfer}=await import('../server/reconcilePayoutTransfer.ts');
function retrieveClient(result){return new Stripe('sk_test_unused',{maxNetworkRetries:0,httpClient:{getClientName:()=> 'offline-retrieve',makeRequest:async(h,p,path,method)=>{assert.equal(method,'GET');assert.equal(path,'/v1/transfers/tr_one');if(result instanceof Error)throw result;return {getRawResponse:()=>({}),getStatusCode:()=>200,getHeaders:()=>({'request-id':'offline'}),toJSON:async()=>structuredClone(result)};}}});}
const ownerExpected={...expected,ownerMetadataKey:'hostId',ownerId:'host_one'};
const owned={...transfer,metadata:{...transfer.metadata,hostId:'host_one'}};
assert.deepEqual(await verifyRecordedPayoutTransfer(retrieveClient(owned),'tr_one',ownerExpected),{id:'tr_one'});
for(const patch of [{id:'tr_wrong'},{metadata:{payoutRequestId:'other',hostId:'host_one'}},{metadata:{payoutRequestId:'p1',hostId:'other'}},{amount:1},{currency:'eur'},{destination:'acct_other'},{reversed:true},{amount_reversed:1}])await assert.rejects(()=>verifyRecordedPayoutTransfer(retrieveClient({...owned,...patch}),'tr_one',ownerExpected));
await assert.rejects(()=>verifyRecordedPayoutTransfer(retrieveClient(new Error('unavailable')),'tr_one',ownerExpected));
for (const proof of [new Error('unavailable'),{...owned,metadata:{}},owned]) {
 let created=0,finished=0;
 const r=await executeHostPayout({claimProcessing:async()=>null,finalizePaid:async()=>{finished++;return {id:'p1'}}},{createTransfer:async()=>{created++;throw new Error('forbidden')},findTransferByPayoutRequestId:async()=>{throw new Error('must retrieve recorded ID')},verifyRecordedTransfer:async id=>verifyRecordedPayoutTransfer(retrieveClient(proof),id,ownerExpected)},{request:{id:'p1',hostId:'host_one',userId:'u',amountCents:3000,status:'processing',notes:'stripe_transfer:tr_one'},destination:{stripeConnectAccountId:'acct_one',stripePayoutsEnabled:true},stripeConfigured:true,adminUserId:'a',notes:null,manualPayoutConfirmed:true});
 assert.equal(created,0);assert.equal(finished,proof===owned?1:0);assert.equal(r.outcome,proof===owned?'paid':'transfer_failed');
}
console.log('PASS: recorded-transfer proof: 10 SDK cases and 3 actual host execution cases; no payment writes.');
