import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseHostPartnerReceipt, submitHostPartnerRequest, HOST_PARTNER_CONFIRMATION_UNAVAILABLE } from '../client/src/lib/hostPartnerSubmission.ts';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const input = {email:'fixture@example.invalid',businessName:'Fixture host',locationType:'office'};
const saved = {ok:true,leadId:'fixture-lead-123',emailed:true};

test('only an explicit saved reference and boolean email evidence create a receipt', () => {
  assert.deepEqual(parseHostPartnerReceipt({...saved,privateField:'not-returned'}),{leadId:saved.leadId,emailed:true});
  assert.deepEqual(parseHostPartnerReceipt({...saved,emailed:false}),{leadId:saved.leadId,emailed:false});
  for(const value of [null,[],{},true,{ok:true},{...saved,ok:'true'},{...saved,ok:false},{...saved,leadId:''},{...saved,leadId:' '},{...saved,leadId:'x'.repeat(129)},{...saved,emailed:'true'},{...saved,emailed:undefined}]) {
    assert.throws(()=>parseHostPartnerReceipt(value),new RegExp('could not confirm'));
  }
});

test('one valid request returns the exact receipt without changing the payload or endpoint', async () => {
  let calls=0;
  const receipt=await submitHostPartnerRequest(input,{fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,'/api/public/host-partner-leads');assert.equal(options.method,'POST');
    assert.equal(options.redirect,'error');assert.deepEqual(JSON.parse(options.body),input);
    assert(options.signal instanceof AbortSignal);assert.equal(options.headers.Accept,'application/json');
    return Response.json(saved);
  }});
  assert.equal(calls,1);assert.deepEqual(receipt,{leadId:saved.leadId,emailed:true});
});

for(const [label,body,contentType] of [
  ['HTML fallback','<html>not a receipt</html>','text/html'],
  ['malformed JSON','{','application/json'],
  ['empty JSON','{}','application/json'],
  ['missing content type',JSON.stringify(saved),''],
  ['declared failure',JSON.stringify({...saved,ok:false}),'application/json'],
]) test(label+' cannot become success or trigger a retry',async()=>{
  let calls=0;await assert.rejects(submitHostPartnerRequest(input,{fetchImpl:async()=>{
    calls++;return new Response(body,{status:200,headers:{'content-type':contentType}});
  }}),new RegExp('could not confirm'));
  assert.equal(calls,1);
});

for(const status of [400,429,500,503])test('HTTP '+status+' keeps failure separate from private response text',async()=>{
  let calls=0;
  await assert.rejects(submitHostPartnerRequest(input,{fetchImpl:async()=>{
    calls++;return Response.json({message:'PRIVATE_PROVIDER_DETAIL'},{status});
  }}),error=>{assert(!error.message.includes('PRIVATE'));return true;});
  assert.equal(calls,1);
});

test('transport failure makes one attempt and exposes no transport payload',async()=>{
  let calls=0;await assert.rejects(submitHostPartnerRequest(input,{fetchImpl:async()=>{calls++;throw new Error('PRIVATE_CONNECTION_DETAIL');}}),{message:HOST_PARTNER_CONFIRMATION_UNAVAILABLE});assert.equal(calls,1);
});

test('timeout aborts the request without replay',async()=>{
  let calls=0,aborted=false;
  await assert.rejects(submitHostPartnerRequest(input,{timeoutMs:10,fetchImpl:async(_url,{signal})=>{
    calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true}));
  }}),{message:HOST_PARTNER_CONFIRMATION_UNAVAILABLE});
  assert.equal(calls,1);assert.equal(aborted,true);
});

test('already cancelled navigation sends nothing',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(submitHostPartnerRequest(input,{signal:controller.signal,fetchImpl:async()=>{calls++;return Response.json(saved);}}));assert.equal(calls,0);
});

/** Load the entire authored module; only its external DB/mail boundaries are fixtures. */
function loadService(options={}) {
  const leadTable={id:'lead.id',email:'lead.email'};
  const sendTable={id:'send.id',leadId:'send.leadId',sequence:'send.sequence',step:'send.step',sentAt:'send.sentAt'};
  const calls={saves:0,sends:0,marks:0,queries:0,logs:[]};
  let persisted=null;
  const db={
    select:()=>({from:table=>({where:()=>({limit:async()=>{
      calls.queries++;
      if(table===leadTable)return options.existing?[{...input,id:'fixture-lead-123'}]:[];
      if(options.readEmailFailure)throw new Error('PRIVATE_LEDGER_READ');
      return options.recent?[{id:'sent-fixture'}]:[];
    }})})}),
    insert:table=>({values:values=>({
      returning:async()=>{calls.saves++;if(options.persistFailure)throw new Error('PERSIST_FAILED');persisted=options.missingId?{...values}:{...values,id:'fixture-lead-123'};return [persisted];},
      onConflictDoNothing:async()=>{assert.equal(table,sendTable);calls.marks++;if(options.markFailure)throw new Error('PRIVATE_LEDGER_WRITE');},
    })}),
    update:()=>({set:values=>({where:()=>({returning:async()=>{calls.saves++;persisted={...input,...values,id:'fixture-lead-123'};return [persisted];}})})}),
  };
  const source=readFileSync('server/services/hostPartnerLeadMagnet.ts','utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});
  assert.equal((compiled.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error).length,0);
  const module={exports:{}};
  const imports={
    zod:require('zod'),
    'drizzle-orm':Object.fromEntries(['and','eq','gt','ilike'].map(name=>[name,(...args)=>({name,args})])),
    '../db':{db},
    '../emailService':{emailService:{sendBasicEmail:async(...args)=>{
      assert(persisted,'Email must follow persistence');assert.equal(args.at(-1),'account');calls.sends++;
      if(options.sendFailure)throw new Error('PRIVATE_PROVIDER_DETAIL');
      return options.mailAccepted!==false;
    }}},
    '@shared/schema':{hostPartnerLeads:leadTable,hostPartnerLeadSequenceSends:sendTable},
  };
  const isolatedProcess={env:{HOST_PARTNER_LEADS_ENABLED:options.disabled?'false':'true',PUBLIC_BASE_URL:'https://www.mealscout.us'}};
  new Function('module','exports','require','process','console',compiled.outputText)(module,module.exports,name=>{
    assert(Object.hasOwn(imports,name),'Unexpected external dependency: '+name);return imports[name];
  },isolatedProcess,{error:message=>calls.logs.push(message)});
  return {run:()=>module.exports.handleHostPartnerLeadRequest(input),calls,persisted:()=>persisted};
}

test('disabled intake does not write or send',async()=>{
  const f=loadService({disabled:true});assert.deepEqual(await f.run(),{ok:false,code:'disabled'});assert.equal(f.calls.saves,0);assert.equal(f.calls.sends,0);
});

test('persistence failure still rejects and never sends',async()=>{
  const f=loadService({persistFailure:true});await assert.rejects(f.run(),/PERSIST_FAILED/);assert.equal(f.calls.sends,0);assert.equal(f.calls.marks,0);
});

test('missing saved reference cannot become an accepted request',async()=>{
  const f=loadService({missingId:true});await assert.rejects(f.run(),/saved reference/);assert.equal(f.calls.sends,0);
});

test('saved request and accepted email retain existing success evidence',async()=>{
  const f=loadService();assert.deepEqual(await f.run(),saved);assert.equal(f.calls.saves,1);assert.equal(f.calls.sends,1);assert.equal(f.calls.marks,1);
});

test('saved request survives email failure without becoming a false save failure',async()=>{
  const f=loadService({sendFailure:true});assert.deepEqual(await f.run(),{...saved,emailed:false});assert(f.persisted());assert.equal(f.calls.saves,1);assert.equal(f.calls.sends,1);assert.equal(f.calls.marks,0);assert(!JSON.stringify(f.calls.logs).includes('PRIVATE'));
});

for(const [label,options,sends,marks] of [
  ['provider returns false',{mailAccepted:false},1,0],
  ['prior-send evidence unavailable',{readEmailFailure:true},0,0],
  ['provider accepted but ledger write failed',{markFailure:true},1,1],
])test(label+' keeps the saved reference without a resend',async()=>{
  const f=loadService(options);assert.deepEqual(await f.run(),{...saved,emailed:false});assert(f.persisted());assert.equal(f.calls.saves,1);assert.equal(f.calls.sends,sends);assert.equal(f.calls.marks,marks);
});

test('recent accepted email is not sent again',async()=>{
  const f=loadService({recent:true});assert.deepEqual(await f.run(),saved);assert.equal(f.calls.sends,0);assert.equal(f.calls.marks,0);
});

test('existing lead update still returns its saved identity',async()=>{
  const f=loadService({existing:true,mailAccepted:false});assert.deepEqual(await f.run(),{...saved,emailed:false});assert.equal(f.calls.saves,1);
});
