/** Extend the existing native executor with real signed webhook HTTP.
 * Only the TEST harness is adapted. No application source is transformed.
 * The complete canonical migration chain and actual earnings ledger are used.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareNativeExtensions } from './parking-host-native-tooling.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const hash=x=>createHash('sha256').update(x).digest('hex');
export async function runParkingWebhookNativeProof() {
  assert.equal(process.env.MEALSCOUT_HOST_ROUTE_PROOF,'1');
  const out=path.join(root,'.qa-evidence/host-route-native');fs.mkdirSync(out,{recursive:true});
  const source=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  assert.equal(source,process.env.RENDER_GIT_COMMIT);
  const canonical=fs.readFileSync(path.join(root,'scripts/qa/parking-host-route-core.mjs'),'utf8');
  assert.equal(hash(canonical),'edcba7d94ea34a64ad5878546d9b41e667031ae4e53ea510faf9eb03612459e9');
  const registry=fs.readFileSync(path.join(root,'server/routes.ts'),'utf8');
  const webhookModule=registry.match(/import \{ registerStripeWebhookRoutes \} from "(\.\/routes\/[A-Za-z]+)";/)?.[1];
  assert.ok(webhookModule,'Use the actual production webhook registry import');
  const edits=[];let text=canonical;
  function replace(name,before,after) {
    assert.equal(text.split(before).length-1,1,'Unique harness anchor: '+name);
    text=text.replace(before,after);edits.push({name,beforeSha256:hash(before),afterSha256:hash(after)});
  }
  replace('derived-root',"root = path.resolve(path.dirname(file), '../..')",'root = '+JSON.stringify(root));
  replace('signature-and-cases-imports',"import express from 'express';","import express from 'express';\nimport RealStripe from 'stripe';\nimport { runParkingWebhookCases } from "+JSON.stringify(pathToFileURL(path.join(root,'scripts/qa/parking-webhook-cases.mjs')).href)+';');
  replace('signature-verification-sdk'," process.env.STRIPE_SECRET_KEY='sk_test_mealscout_isolated_fixture';"," globalThis.__hostRouteStripe.prototype.webhooks=new RealStripe('sk_test_local_signature_only').webhooks;\n process.env.STRIPE_WEBHOOK_SECRET=config.webhookSecret;\n process.env.STRIPE_SECRET_KEY='sk_test_mealscout_isolated_fixture';");
  replace('worker-register-exports','const {registerHostRoutes}=','const {registerHostRoutes,registerStripeWebhookRoutes}=');
  replace('raw-signature-body','const app=express();app.use(express.json());','const app=express();app.use("/api/stripe/webhook",express.raw({type:"application/json"}));app.use(express.json());');
  replace('actual-webhook-registration',' registerHostRoutes(app);',' registerHostRoutes(app);\n registerStripeWebhookRoutes(app,{notifyHostCapacityWarning:async()=>{}});');
  const tableStart=text.indexOf("  const quote=s=>"),tableEnd=text.indexOf('  const stubSources={',tableStart);
  assert.ok(tableStart>0&&tableEnd>tableStart);
  replace('full-canonical-schema-not-model-ddl',text.slice(tableStart,tableEnd),'  report.tables=[];\n');
  replace('native-migration-transport','  const stubSources={','  const stubSources={\n   nativeNeon:\'export { Pool } from "pg";export const neonConfig={};\',');
  replace('deny-unrelated-staff-access','message:"Synthetic authentication required"});\',','message:"Synthetic authentication required"});export const isStaffOrAdmin=(_req,res)=>res.status(403).json({message:"Staff access not part of fixture"});\',');
  replace('actual-host-earnings-code',"   hostEarningsService:'export const getHostEarningsSummary=()=>{throw Error(\"Unexpected earnings side effect\");};'\n",'');
  replace('native-wire-resolver',"const key=a.path==='stripe'?'stripe':","const key=a.path==='@neondatabase/serverless'?'nativeNeon':a.path==='stripe'?'stripe':");
  replace('fixture-package-resolution',"contents:stubSources[a.path],loader:'js'","contents:stubSources[a.path],loader:'js',resolveDir:root");
  replace('actual-application-exports','export {registerHostRoutes} from "./server/routes/hostRoutes";export {runMigrationFile} from "./scripts/runSqlMigration";','export {registerHostRoutes} from "./server/routes/hostRoutes";export {registerStripeWebhookRoutes} from "./server/'+webhookModule.slice(2)+'";export {runDeployMigrations} from "./scripts/runDeployMigrations";export {runMigrationFile} from "./scripts/runSqlMigration";');
  replace('actual-migration-chain',"  await api.runMigrationFile(path.join(root,'migrations/058_idempotency_keys.sql'),{quiet:true});await api.runMigrationFile(path.join(root,'migrations/142_parking_pass_active_booking_uniqueness.sql'),{quiet:true});",String.raw`  process.env.MIGRATION_DATABASE_URL=url;
  try { await api.runDeployMigrations(); } finally { delete process.env.MIGRATION_DATABASE_URL; }
  report.fullSchema={bootstrap:(await pool.query('SELECT count(*)::int n FROM mealscout_schema_bootstrap_migrations')).rows[0].n,release:(await pool.query('SELECT count(*)::int n FROM mealscout_release_migrations')).rows[0].n,foreignKeys:(await pool.query("SELECT count(*)::int n FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace")).rows[0].n};
  assert.equal(report.fullSchema.bootstrap,124);assert.equal(report.fullSchema.release,24);assert.equal(report.fullSchema.foreignKeys,278);
  await pool.query('CREATE TABLE qa_authority(truck_id text,user_id text,capability text,allowed boolean,PRIMARY KEY(truck_id,user_id,capability));CREATE TABLE qa_provider_intents(id text PRIMARY KEY,request_key text UNIQUE NOT NULL,payload jsonb NOT NULL);CREATE TABLE qa_provider_calls(id bigserial PRIMARY KEY,operation text NOT NULL,request_key text);');`);
  replace('local-signing-secret','  const configPath=',"  const webhookSecret='whsec_'+randomUUID();\n  const configPath=");
  replace('worker-secret-config','schema:schemaFile,bundle}),{mode:0o600}','schema:schemaFile,bundle,webhookSecret}),{mode:0o600}');
  replace('full-schema-host-foreign-key',"  const host=await seed(schema.hosts,{id:randomUUID(),userId:randomUUID(),name:'QA route host',city:'Chicago',state:'IL'});","  const hostUser=await seed(schema.users,{id:randomUUID(),email:'host-'+randomUUID()+'@example.invalid',userType:'host'});\n  const host=await seed(schema.hosts,{id:randomUUID(),userId:hostUser.id,businessName:'QA route host',city:'Chicago',state:'IL'});");
  const casesStart=text.indexOf("  await test('four distinct OS processes"),casesEnd=text.indexOf("  report.result=report.cases.every",casesStart);
  assert.ok(casesStart>0&&casesEnd>casesStart);
  replace('new-webhook-cases-only',text.slice(casesStart,casesEnd),"  await runParkingWebhookCases({test,pool,workers,actor,event,request,rowsFor,effects,creates,webhookSecret,setCreateMode:mode=>{createMode=mode;}});\n");
  replace('precise-receipt-scope',"scope:'Actual registered POST /api/parking-pass/:passId/book, native PostgreSQL, four independent OS workers. Authentication and exact manageParkingPass grants are database-backed fixtures; external provider transport is a loopback fixture. Model-derived relevant tables, not complete production migration-chain or live Stripe acceptance.'","scope:'Actual registered booking and signed Stripe webhook routes across four independent OS workers; complete canonical native PostgreSQL schema and actual earnings/credit ledger code. Authentication, grants and provider transport are explicit loopback fixtures. Stripe SDK verifies raw-body signatures using an ephemeral local secret. No live Stripe delivery, charge, settlement or production mutation.'");
  const cancellationProof=process.env.MEALSCOUT_PARKING_CANCEL_PROOF==='1';
  if(cancellationProof){const {addParkingCancellationProof}=await import('./parking-cancellation-adapter.mjs');addParkingCancellationProof({replace,root,registry});}
  const derived=path.join(out,'signed-webhook-derived.mjs');fs.writeFileSync(derived,text);
  const tooling=prepareNativeExtensions({root,out});
  const result=spawnSync(process.execPath,[derived],{cwd:root,env:process.env,encoding:'utf8',timeout:180000,maxBuffer:32*1024*1024});
  fs.writeFileSync(path.join(out,'signed-webhook.log'),String(result.stdout||'')+String(result.stderr||''));
  const receiptPath=path.join(out,'receipt.json');
  const report=fs.existsSync(receiptPath)?JSON.parse(fs.readFileSync(receiptPath,'utf8')):{source,result:'fail',harnessFailure:result.error?.message||String(result.stderr||'No receipt')};
  report.kind=cancellationProof?'signed-webhook-and-cancellation-native-full-schema':'signed-webhook-native-full-schema';report.source=source;
  report.adapter={canonicalCoreSha256:hash(canonical),derivedCoreSha256:hash(text),edits};
  report.nativeTooling=tooling;report.exitCode=result.status;
  report.files ||= {};
  for(const file of ['server/routes.ts','scripts/qa/parking-webhook-native.mjs','scripts/qa/parking-webhook-cases.mjs','scripts/qa/parking-host-route-native.mjs',...(cancellationProof?['scripts/qa/parking-cancellation-adapter.mjs','scripts/qa/parking-cancellation-cases.mjs']:[])])report.files[file]=hash(fs.readFileSync(path.join(root,file)));
  if(cancellationProof)report.scope+=' Also executes the actual registered checkout cancellation route before the webhook, in canonical registration order.';
  report.productionMutations=0;report.liveProviderAcceptance=false;
  if(result.status!==0)report.result='fail';
  fs.writeFileSync(receiptPath,JSON.stringify(report,null,2)+'\n');
  const summary={...report,filesManifest:{count:Object.keys(report.files).length,sha256:hash(JSON.stringify(report.files))},adapter:{canonicalCoreSha256:hash(canonical),derivedCoreSha256:hash(text)},rawReceiptSha256:hash(fs.readFileSync(receiptPath))};
  delete summary.tables;delete summary.files;delete summary.nativeTooling;
  console.log('PARKING_SIGNED_WEBHOOK_RECEIPT '+JSON.stringify(summary));
  if(report.harnessFailure)console.error(String(result.stderr||'').slice(-3000));
  process.exitCode=report.result==='pass'?0:1;
}
