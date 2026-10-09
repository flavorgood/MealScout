// Executes the real modal's recovery branch with a navigation sink. No browser,
// Stripe or HTTP substitutes are presented as full end-to-end evidence.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
const root=path.resolve(__dirname,'../..'),file='client/src/components/booking-payment-modal.tsx';
const source=fs.readFileSync(path.join(root,file),'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
assert.equal(ast.parseDiagnostics.length,0);const branches=[];
function visit(n){if(ts.isIfStatement(n)&&n.expression.getText(ast)==='data?.bookingRecovery === true')branches.push(n.getText(ast));ts.forEachChild(n,visit);}visit(ast);assert.equal(branches.length,1);
const compiled=ts.transpileModule('async function recover(data,truckId){'+branches[0]+'; return "ordinary";} globalThis.run=recover;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
let count=0;
async function test(name,fn){await fn();count++;console.log('PASS recovered navigation: '+name);}
async function invoke(data,options={}){
  const destinations=[],outcomes=[],requests=[];
  const scope={URLSearchParams,encodeURIComponent,window:{location:{assign:href=>destinations.push(href)}},
    requestScopeRef:{current:'qa-scope'},activeScope:'qa-scope',controller:new AbortController(),
    apiUrl:value=>value,handleSuccess:status=>outcomes.push(status)};
  scope.fetch=async(url,init)=>{
    requests.push({url,init});
    if(options.fetcher)return options.fetcher(scope,url,init);
    return{ok:options.ok!==false,json:async()=>({status:options.status||'pending'})};
  };
  vm.runInNewContext(compiled,scope);
  const value=await scope.run(data,options.truckId||'qa-truck');
  return{destinations,outcomes,requests,value};
}
async function main(){
  // Recovery outcome hints are not settlement evidence. The original eight
  // navigation/input assertions run with an explicit pending read fixture.
  for(const outcome of ['confirmed','pending','credited'])await test(outcome+' uses existing status page and excludes secrets',async()=>{const r=await invoke({bookingRecovery:true,paymentIntentId:'pi_existing',bookingStartDate:'2030-01-03',outcome,clientSecret:'not-in-url',redirect:'https://example.invalid'});assert.equal(r.destinations.length,1);const url=new URL(r.destinations[0],'http://localhost');assert.equal(url.pathname,'/parking-pass');assert.equal(url.searchParams.get('payment_intent'),'pi_existing');assert.equal(url.searchParams.get('truckId'),'qa-truck');assert.equal(url.searchParams.get('date'),'2030-01-03');assert.equal(url.searchParams.get('booking'),'success');assert.ok(!url.href.includes('secret'));assert.ok(!url.href.includes('example.invalid'));});
  for(const paymentIntentId of [null,'','https://example.invalid'])await test('invalid recovered reference stays in recovery: '+paymentIntentId,async()=>assert.rejects(()=>invoke({bookingRecovery:true,paymentIntentId}),/Recovered booking reference is invalid/));
  await test('malformed date is not propagated',async()=>{const r=await invoke({bookingRecovery:true,paymentIntentId:'pi_existing',bookingStartDate:'not-a-date'});assert.equal(new URL(r.destinations[0],'http://localhost').searchParams.has('date'),false);});
  await test('ordinary setup still reaches existing payment handling',async()=>{const r=await invoke({paymentIntentId:'pi_existing',clientSecret:'qa'});assert.equal(r.value,'ordinary');assert.equal(r.destinations.length,0);assert.equal(r.requests.length,0);});
  for(const status of ['confirmed','credited'])await test(status+' completes only after the read-only server status',async()=>{
    const r=await invoke({bookingRecovery:true,paymentIntentId:'pi_existing',outcome:'pending'},{status});
    assert.deepEqual(r.outcomes,[status]);assert.equal(r.destinations.length,0);assert.equal(r.requests.length,1);
  });
  for(const status of ['pending','unknown','cancelled'])await test(status+' never completes from a recovered outcome hint',async()=>{
    const r=await invoke({bookingRecovery:true,paymentIntentId:'pi_existing',outcome:'confirmed'},{status});
    assert.equal(r.outcomes.length,0);assert.equal(r.destinations.length,1);assert.equal(r.requests.length,1);
  });
  await test('denied status read retains recovery navigation without claiming settlement',async()=>{
    const r=await invoke({bookingRecovery:true,paymentIntentId:'pi_existing'},{ok:false,status:'confirmed'});
    assert.equal(r.outcomes.length,0);assert.equal(r.destinations.length,1);
  });
  await test('actor change during the status read cannot complete or navigate',async()=>{
    const r=await invoke({bookingRecovery:true,paymentIntentId:'pi_existing'},{fetcher:async scope=>{
      scope.requestScopeRef.current='another-actor';return{ok:true,json:async()=>({status:'confirmed'})};
    }});assert.equal(r.outcomes.length,0);assert.equal(r.destinations.length,0);
  });
  await test('actor change during status body parsing cannot complete or navigate',async()=>{
    const r=await invoke({bookingRecovery:true,paymentIntentId:'pi_existing'},{fetcher:async scope=>({ok:true,json:async()=>{
      scope.requestScopeRef.current='another-actor';return{status:'credited'};
    }})});assert.equal(r.outcomes.length,0);assert.equal(r.destinations.length,0);
  });
  await test('interrupted status read is not promoted to settlement',async()=>{
    await assert.rejects(()=>invoke({bookingRecovery:true,paymentIntentId:'pi_existing'},{fetcher:async()=>{throw new Error('Interrupted read');}}),/Interrupted read/);
  });
  await test('malformed status body is not promoted to settlement',async()=>{
    await assert.rejects(()=>invoke({bookingRecovery:true,paymentIntentId:'pi_existing'},{fetcher:async()=>({ok:true,json:async()=>{throw new Error('Invalid JSON');}})}),/Invalid JSON/);
  });
  await test('status read binds exact intent, truck, native credentials and cancellation signal',async()=>{
    const r=await invoke({bookingRecovery:true,paymentIntentId:'pi_existing'},{truckId:'truck /?&'});
    assert.equal(r.requests.length,1);const request=r.requests[0];
    assert.equal(request.url,'/api/bookings/payment-intent/pi_existing?truckId=truck%20%2F%3F%26');
    assert.equal(request.init.credentials,'include');assert.equal(request.init.method,undefined);
    assert.equal(request.init.body,undefined);assert.equal(request.init.signal.aborted,false);
  });
  console.log('PASS '+count+' recovered booking navigation checks.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
