/** Adds cancellation coverage to the existing isolated, signed HTTP executor.
 * Only test-harness wiring and provider fixtures are changed. Application modules
 * and the production ordering of the three payment routes remain canonical.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export function addParkingCancellationProof({ replace, root, registry }) {
  assert.ok(registry.includes('import { registerBookingRoutes } from "./routes/bookingRoutes";'));
  assert.ok(registry.indexOf('registerBookingRoutes(app,') < registry.indexOf('registerStripeWebhookRoutes(app,'));
  const safe = registry.includes('import { registerParkingCheckoutRoutes } from "./routes/parkingCheckoutRoutes";');
  if (safe) {
    assert.ok(registry.indexOf('registerParkingCheckoutRoutes(app,') > registry.indexOf('registerHostRoutes(app)'));
    assert.ok(registry.indexOf('registerParkingCheckoutRoutes(app,') < registry.indexOf('registerBookingRoutes(app,'));
  }
  replace('cancellation-cases-import', "import express from 'express';", "import express from 'express';\nimport { runParkingCancellationCases } from " + JSON.stringify(pathToFileURL(path.join(root, 'scripts/qa/parking-cancellation-cases.mjs')).href) + ';');
  replace('cancellation-module-exports', 'export {registerHostRoutes} from "./server/routes/hostRoutes";', 'export {registerHostRoutes} from "./server/routes/hostRoutes";export {registerBookingRoutes} from "./server/routes/bookingRoutes";' + (safe ? 'export {registerParkingCheckoutRoutes} from "./server/routes/parkingCheckoutRoutes";' : ''));
  replace('cancellation-worker-exports', 'const {registerHostRoutes,registerStripeWebhookRoutes}=', 'const {registerHostRoutes,registerStripeWebhookRoutes,registerBookingRoutes' + (safe ? ',registerParkingCheckoutRoutes' : '') + '}=');
  replace('canonical-cancellation-registration', ' registerStripeWebhookRoutes(app,{notifyHostCapacityWarning:async()=>{}});', (safe ? ' registerParkingCheckoutRoutes(app,{stripe:new globalThis.__hostRouteStripe()});\n' : '') + ' registerBookingRoutes(app,{hasCompleteProfileAccess:async()=>true});\n registerStripeWebhookRoutes(app,{notifyHostCapacityWarning:async()=>{}});');
  replace('cancellation-retrieve-scope', "retrieve:id=>call('retrieve',{id})", "retrieve:(id,_params,options)=>call('retrieve',{id,account:options?.stripeAccount})");
  replace('cancellation-write-key', "cancel:id=>call('cancel',{id})", "cancel:(id,_params,options)=>call('cancel',{id,key:options?.idempotencyKey,account:options?.stripeAccount})");
  replace('cancellation-fixture-tables', 'CREATE TABLE qa_provider_calls(id bigserial PRIMARY KEY,operation text NOT NULL,request_key text);', 'CREATE TABLE qa_provider_calls(id bigserial PRIMARY KEY,operation text NOT NULL,request_key text);CREATE TABLE qa_cancel_controls(intent_id text PRIMARY KEY,mode text NOT NULL);CREATE TABLE qa_cancel_observations(op text,intent_id text,request_key text,account text);');
  replace('cancellation-provider-failure-controls', "let payload;\n   if(op==='create'){", String.raw`let payload;
   if(id && ['retrieve','cancel'].includes(op)) {
    await pool.query('INSERT INTO qa_cancel_observations VALUES($1,$2,$3,$4)',[op,id,key||null,req.body.account||null]);
    const control=(await pool.query('SELECT mode FROM qa_cancel_controls WHERE intent_id=$1',[id])).rows[0]?.mode;
    if(req.body.account)return res.status(404).json({error:'Platform-owned intent is not on the transfer destination account'});
    if(op==='retrieve' && control==='retrieve-error')return res.status(503).json({error:'Synthetic provider read unavailable'});
    if(op==='cancel' && control==='cancel-error')return res.status(503).json({error:'Synthetic cancellation rejected before commitment'});
    if(op==='cancel' && ['cancel-lost-ack','paid-during-cancel','wrong-cancel-reply'].includes(control)) {
     const row=(await pool.query('SELECT payload FROM qa_provider_intents WHERE id=$1',[id])).rows[0];
     assert.ok(row);const original=row.payload;
     if(control==='wrong-cancel-reply')return res.json({...original,status:'canceled',amount:original.amount+1});
     const changed={...original,status:control==='paid-during-cancel'?'succeeded':'canceled',amount_received:control==='paid-during-cancel'?original.amount:0};
     await pool.query('UPDATE qa_provider_intents SET payload=$2 WHERE id=$1',[id,JSON.stringify(changed)]);
     if(control==='cancel-lost-ack'){res.destroy();return;}
     return res.status(503).json({error:'Payment succeeded before cancellation'});
    }
   }
   if(op==='create'){`);
  replace('cancellation-extra-cases', '  await runParkingWebhookCases({test,pool,workers,actor,event,request,rowsFor,effects,creates,webhookSecret,setCreateMode:mode=>{createMode=mode;}});', '  await runParkingWebhookCases({test,pool,workers,actor,event,request,rowsFor,effects,creates,webhookSecret,setCreateMode:mode=>{createMode=mode;}});\n  await runParkingCancellationCases({test,pool,workers,actor,event,request,rowsFor,webhookSecret});');
}
