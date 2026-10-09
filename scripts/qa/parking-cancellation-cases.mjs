/** Actual registered cancellation + booking + signed-webhook HTTP on disposable
 * PostgreSQL. Provider transport and identity are explicit fixtures, not Stripe.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
export async function runParkingCancellationCases(c) {
  const {test,pool,workers,actor,event,request,rowsFor,webhookSecret}=c;
  const cancel=async(b,index=1,who=b.a.user.id)=>{
    const r=await fetch(`http://127.0.0.1:${workers[index].ready.port}/api/bookings/payment-intent/${b.id}/cancel?truckId=${b.a.truck.id}`,{method:'POST',headers:who?{'X-QA-User':who}:{},signal:AbortSignal.timeout(20000)});
    return {status:r.status,body:await r.json()};
  };
  const book=async(extra={})=>{
    const a=await actor(),e=await event(),reply=await request(workers[0],a,e,randomUUID(),extra);
    assert.equal(reply.status,200,JSON.stringify(reply));
    return {a,e,id:reply.body.paymentIntentId,original:await rowsFor(a)};
  };
  const control=(b,mode)=>pool.query('INSERT INTO qa_cancel_controls VALUES($1,$2) ON CONFLICT(intent_id) DO UPDATE SET mode=$2',[b.id,mode]);
  const ops=async b=>(await pool.query('SELECT op,request_key,account FROM qa_cancel_observations WHERE intent_id=$1',[b.id])).rows;
  const financial=async b=>({credits:(await pool.query('SELECT row_to_json(c) row FROM credit_ledger c WHERE source_id=$1 ORDER BY id',[b.id])).rows,earnings:(await pool.query('SELECT row_to_json(e) row FROM host_earnings_ledger e WHERE stripe_payment_intent_id=$1 ORDER BY id',[b.id])).rows});
  const intent=async b=>(await pool.query('SELECT payload FROM qa_provider_intents WHERE id=$1',[b.id])).rows[0].payload;
  const setIntent=(b,value)=>pool.query('UPDATE qa_provider_intents SET payload=$2 WHERE id=$1',[b.id,JSON.stringify(value)]);
  const assertUnchanged=async(b,before,ledger)=>{assert.deepEqual(await rowsFor(b.a),before,'Cancellation altered original booking history');assert.deepEqual(await financial(b),ledger,'Cancellation altered financial ledgers');};
  await test('cancel: provider retrieval failure retains the original holds and ledgers',async()=>{
    const b=await book(),before=await rowsFor(b.a),ledger=await financial(b);await control(b,'retrieve-error');const r=await cancel(b);
    assert.equal(r.status,503,JSON.stringify(r));await assertUnchanged(b,before,ledger);assert.equal((await ops(b)).filter(x=>x.op==='cancel').length,0);
    return {status:r.status,holdsUnchanged:true,cancelCalls:0};
  });
  await test('cancel: uncertain cancellation without positive readback retains capacity',async()=>{
    const b=await book(),before=await rowsFor(b.a),ledger=await financial(b);await control(b,'cancel-error');const r=await cancel(b);
    assert.equal(r.status,503,JSON.stringify(r));await assertUnchanged(b,before,ledger);assert.equal((await ops(b)).filter(x=>x.op==='cancel').length,1);
    return {status:r.status,holdsUnchanged:true,cancelCalls:1};
  });
  await test('cancel: lost acknowledgement recovers a positively cancelled unpaid intent without another cancellation',async()=>{
    const b=await book(),ledger=await financial(b);await control(b,'cancel-lost-ack');const r=await cancel(b);
    assert.equal(r.status,200,JSON.stringify(r));const rows=await rowsFor(b.a);assert.deepEqual(rows.map(x=>x.id),b.original.map(x=>x.id));assert.ok(rows.every(x=>x.status==='cancelled'&&x.stripe_payment_status==='canceled'&&!x.paid_at));
    assert.equal((await intent(b)).status,'canceled');assert.equal((await ops(b)).filter(x=>x.op==='cancel').length,1);assert.deepEqual(await financial(b),ledger);
    assert.equal((await cancel(b,2)).status,200);assert.deepEqual(await rowsFor(b.a),rows);assert.equal((await ops(b)).filter(x=>x.op==='cancel').length,1);
    return {status:200,cancelCalls:1,replayHistoryUnchanged:true};
  });
  await test('cancel: a successful payment cannot release its pending reservation',async()=>{
    const b=await book(),before=await rowsFor(b.a),ledger=await financial(b),p=await intent(b);await setIntent(b,{...p,status:'succeeded',amount_received:p.amount});const r=await cancel(b);
    assert.equal(r.status,409,JSON.stringify(r));await assertUnchanged(b,before,ledger);assert.equal((await ops(b)).filter(x=>x.op==='cancel').length,0);
    return {status:409,paidReservationRetained:true};
  });
  await test('cancel: payment winning the provider race still confirms the original reservation through the signed webhook',async()=>{
    const b=await book(),before=await rowsFor(b.a),ledger=await financial(b);await control(b,'paid-during-cancel');const r=await cancel(b);
    assert.equal(r.status,409,JSON.stringify(r));await assertUnchanged(b,before,ledger);
    const p=await intent(b);assert.equal(p.status,'succeeded');const sdk=new Stripe('sk_test_signature_only');
    const payload=JSON.stringify({id:'evt_qa_'+randomUUID(),object:'event',type:'payment_intent.succeeded',created:Math.floor(Date.now()/1000),livemode:false,data:{object:p}});
    const signature=sdk.webhooks.generateTestHeaderString({payload,secret:webhookSecret});
    const delivered=await fetch(`http://127.0.0.1:${workers[3].ready.port}/api/stripe/webhook`,{method:'POST',headers:{'content-type':'application/json','stripe-signature':signature},body:payload,signal:AbortSignal.timeout(20000)});
    assert.equal(delivered.status,200,await delivered.text());const rows=await rowsFor(b.a);assert.deepEqual(rows.map(x=>x.id),before.map(x=>x.id));assert.ok(rows.every(x=>x.status==='confirmed'&&!x.cancelled_at));
    const after=await financial(b);assert.equal(after.credits.length,0);assert.equal(after.earnings.length,rows.length);
    return {cancelStatus:409,webhookStatus:200,originalReservationConfirmed:true,credits:0};
  });
  await test('cancel: mismatched cancellation response cannot release original holds',async()=>{
    const b=await book(),before=await rowsFor(b.a),ledger=await financial(b);await control(b,'wrong-cancel-reply');const r=await cancel(b);
    assert.ok(r.status>=400,JSON.stringify(r));await assertUnchanged(b,before,ledger);return {status:r.status,holdsUnchanged:true};
  });
  await test('cancel: concurrent requests perform one provider cancellation and retain the exact terminal history',async()=>{
    const b=await book(),ledger=await financial(b);const replies=await Promise.all(Array.from({length:8},(_,i)=>cancel(b,i%4)));assert.ok(replies.every(x=>x.status===200),JSON.stringify(replies));
    const operations=await ops(b),writes=operations.filter(x=>x.op==='cancel');assert.equal(writes.length,1);assert.match(writes[0].request_key||'',/^parking-pass-checkout-cancel:[a-f0-9]{64}$/);
    const rows=await rowsFor(b.a);assert.ok(rows.every(x=>x.status==='cancelled'&&x.stripe_payment_status==='canceled'));assert.deepEqual(await financial(b),ledger);assert.equal((await cancel(b)).status,200);assert.deepEqual(await rowsFor(b.a),rows);
    return {requests:9,cancelCalls:1,terminalReplayUnchanged:true};
  });
  await test('cancel: platform-owned destination charge is never retrieved from the host transfer account',async()=>{
    const b=await book(),p=await intent(b),destination='acct_qa_host_destination';
    // Existing destination-charge records; provider account scoping is observed, not inferred from the transfer destination.
    await pool.query('UPDATE event_bookings SET stripe_transfer_destination=$2 WHERE stripe_payment_intent_id=$1',[b.id,destination]);
    await setIntent(b,{...p,transfer_data:{destination},application_fee_amount:b.original.reduce((n,x)=>n+x.platform_fee_cents,0)});
    const r=await cancel(b);assert.equal(r.status,200,JSON.stringify(r));assert.equal((await intent(b)).status,'canceled');assert.ok((await ops(b)).every(x=>x.account===null));
    return {status:200,providerScope:'platform',hostDestinationUnchanged:true};
  });
  await test('cancel: revoked and anonymous actors cannot mutate bookings or call the provider',async()=>{
    const b=await book(),before=await rowsFor(b.a),ledger=await financial(b);await pool.query('UPDATE qa_authority SET allowed=false WHERE truck_id=$1',[b.a.truck.id]);
    assert.equal((await cancel(b)).status,403);assert.equal((await cancel(b,2,null)).status,401);await assertUnchanged(b,before,ledger);assert.equal((await ops(b)).length,0);
    return {revokedStatus:403,anonymousStatus:401,providerCalls:0};
  });
  await test('cancel: sparse multi-day checkout releases its whole unpaid group once',async()=>{
    const a=await actor(),first=await event();await event();const last=await event();const reply=await request(workers[0],a,first,randomUUID(),{slotType:'weekly',selectedDates:[first.date.toISOString().slice(0,10),last.date.toISOString().slice(0,10)]});assert.equal(reply.status,200);
    const b={a,e:first,id:reply.body.paymentIntentId,original:await rowsFor(a)};assert.equal(b.original.length,2);const ledger=await financial(b),r=await cancel(b);assert.equal(r.status,200,JSON.stringify(r));
    const rows=await rowsFor(a);assert.deepEqual(rows.map(x=>x.id),b.original.map(x=>x.id));assert.ok(rows.every(x=>x.status==='cancelled'&&x.stripe_payment_status==='canceled'));assert.equal((await ops(b)).filter(x=>x.op==='cancel').length,1);assert.deepEqual(await financial(b),ledger);
    return {status:200,originalRows:2,cancelCalls:1};
  });
}
