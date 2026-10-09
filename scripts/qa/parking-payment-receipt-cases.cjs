// Exact component lifecycle regressions. API, Stripe and storage remain fixtures;
// cancellation acknowledgments are intentionally NOT treated as provider proof.
const assert = require('node:assert/strict');
module.exports = async ({ test, paymentSetup }) => {
  const receipts = page => page.evaluate(() => [...window.__storage.entries()]
    .filter(([key]) => key.startsWith('mealscout:parking-request:')).map(([key, value]) => ({key, row: JSON.parse(value)})));
  const bookCalls = calls => calls.filter(c => c.url.endsWith('/book'));
  const goPay = async page => {
    await page.getByRole('button', {name:'Continue', exact:true}).click();
    await page.getByTestId('card-field').waitFor();
  };
  const retry = async page => page.getByRole('button', {name:'Retry same booking request', exact:true}).click();
  const pay = async page => page.getByRole('button', {name:'Pay $21.00', exact:true}).click();
  const idle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const common = url => ({body:url === '/api/payout/balance' ? {balance:5} : url.endsWith('/book') ? paymentSetup : {status:'confirmed'}});

  await test('payment setup retains only the original request, never a client secret', async ({page,calls,start}) => {
    await start();await goPay(page);const rows=await receipts(page);assert.equal(rows.length,1);
    assert.equal(rows[0].row.requestId,bookCalls(calls)[0].headers['Idempotency-Key']);
    assert.deepEqual(rows[0].row.body,bookCalls(calls)[0].body);
    assert.ok(!JSON.stringify(rows).includes(paymentSetup.clientSecret));
    assert.ok(!JSON.stringify(rows).includes(paymentSetup.paymentIntentId));
    assert.equal(await page.evaluate(()=>window.__stripeCalls.length),0);
  });
  await test('remount after payment setup reuses the same key and input without charging', async ({page,calls,start}) => {
    await start();await page.locator('#parking-pass-promo').fill('ORIGINAL');await goPay(page);
    await page.evaluate(()=>window.__remount());await retry(page);await page.getByTestId('card-field').waitFor();
    const [a,b]=bookCalls(calls);assert.equal(bookCalls(calls).length,2);
    assert.equal(a.headers['Idempotency-Key'],b.headers['Idempotency-Key']);assert.deepEqual(a.body,b.body);
    assert.equal(await page.evaluate(()=>window.__stripeCalls.length),0);
  });
  await test('pending after payment keeps the request across close and remount', async ({page,calls,setHandler,start}) => {
    setHandler(async url=>url.includes('/bookings/payment-intent/')?{body:{status:'pending'}}:common(url));
    await start();await goPay(page);await pay(page);await page.waitForFunction(()=>window.__outcomes.length===1);
    assert.deepEqual(await page.evaluate(()=>window.__outcomes),[{outcome:'pending'}]);assert.equal((await receipts(page)).length,1);
    await page.evaluate(()=>window.__remount());await page.getByRole('button',{name:'Retry same booking request',exact:true}).waitFor();
    assert.equal(bookCalls(calls).length,1);assert.equal(await page.evaluate(()=>window.__stripeCalls.length),1);
  });
  for(const status of ['confirmed','credited']) await test(status+' retires the matching receipt only after the server result', async ({page,calls,setHandler,start})=>{
    let resolveStatus;setHandler(async url=>url.includes('/bookings/payment-intent/')?new Promise(resolve=>{resolveStatus=resolve;}):common(url));
    await start();await goPay(page);await pay(page);await page.waitForFunction(()=>window.__stripeCalls.length===1);
    await idle(page);assert.equal((await receipts(page)).length,1);assert.equal(await page.evaluate(()=>window.__outcomes.length),0);
    assert.ok(resolveStatus);resolveStatus({body:{status}});await page.waitForFunction(()=>window.__outcomes.length===1);
    assert.equal((await receipts(page)).length,0);assert.deepEqual(await page.evaluate(()=>window.__outcomes),[{outcome:status}]);
    assert.equal(bookCalls(calls).length,1);
  });
  await test('server bypass confirmation retires its request without a Stripe call',async({page,setHandler,start})=>{
    setHandler(async url=>url.endsWith('/book')?{body:{bypassed:true}}:common(url));await start();
    await page.getByRole('button',{name:'Continue',exact:true}).click();await page.waitForFunction(()=>window.__outcomes.length===1);
    assert.equal((await receipts(page)).length,0);assert.deepEqual(await page.evaluate(()=>window.__outcomes),[{outcome:'confirmed'}]);
    assert.equal(await page.evaluate(()=>window.__stripeCalls.length),0);
  });
  for(const [name,result] of [
    ['legacy success acknowledgment',{body:{ok:true}}],['HTTP 409',{status:409,body:{message:'Payment pending'}}],
    ['HTTP 503',{status:503,body:{message:'Unavailable'}}],['lost cancellation response',{abort:true}],
    ['malformed success response',{body:{}}],
  ]) await test(name+' cannot retire the payment request',async({page,calls,setHandler,start})=>{
    setHandler(async url=>url.includes('/cancel?')?result:common(url));await start();await goPay(page);
    const expected=bookCalls(calls)[0].headers['Idempotency-Key'];await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.waitForFunction(()=>window.__closes.length>0);await idle(page);
    assert.equal((await receipts(page))[0]?.row.requestId,expected);assert.equal(calls.filter(c=>c.url.includes('/cancel?')).length,1);
    assert.equal(await page.evaluate(()=>window.__outcomes.length),0);await page.evaluate(()=>window.__remount());
    await page.getByRole('button',{name:'Retry same booking request',exact:true}).waitFor();
    assert.equal(calls.filter(c=>c.url.includes('/cancel?')).length,1);assert.equal(bookCalls(calls).length,1);
  });
  await test('closing an uncertain payment preserves recovery without cancellation',async({page,calls,start})=>{
    await start();await goPay(page);await page.evaluate(()=>window.__confirm=async()=>{throw new Error('Lost acknowledgment');});
    await pay(page);await page.getByRole('button',{name:'Close checkout',exact:true}).click();
    assert.equal((await receipts(page)).length,1);assert.equal(calls.filter(c=>c.url.includes('/cancel?')).length,0);
    assert.equal(await page.evaluate(()=>window.__stripeCalls.length),1);
  });
  for(const [field,value] of [['__userId','qa-user-b'],['__passId','pass-b'],['__truckId','truck-b']]) {
    await test('same-mounted '+field+' change unmounts the old payment form',async({page,calls,start})=>{
      await start();await goPay(page);await page.evaluate(([field,value])=>{window[field]=value;window.__rerender();},[field,value]);
      await page.getByRole('button',{name:'Continue',exact:true}).waitFor();assert.equal(await page.getByTestId('card-field').count(),0);
      assert.equal(await page.getByText('Unfinished booking request',{exact:true}).count(),0);
      assert.equal((await receipts(page)).length,1);assert.equal(bookCalls(calls).length,1);assert.equal(calls.filter(c=>c.url.includes('/cancel?')).length,0);
    });
  }
  await test('late Stripe acknowledgment cannot complete a closed then reopened checkout',async({page,calls,start})=>{
    await start();await goPay(page);await page.evaluate(()=>window.__confirm=()=>new Promise(resolve=>{window.__resolveConfirm=resolve;}));await pay(page);
    await page.evaluate(()=>window.__setOpen(false));await page.getByRole('dialog').waitFor({state:'detached'});
    await page.evaluate(()=>window.__setOpen(true));await page.getByRole('dialog').waitFor();
    await page.evaluate(()=>window.__resolveConfirm({paymentIntent:{status:'succeeded'}}));await idle(page);
    assert.equal(await page.evaluate(()=>window.__outcomes.length),0);assert.equal(calls.filter(c=>c.url.includes('/bookings/payment-intent/')).length,0);
    assert.equal((await receipts(page)).length,1);assert.equal(await page.getByTestId('card-field').count(),0);
  });
  await test('late booking-status response cannot complete a different signed-in account',async({page,calls,setHandler,start})=>{
    let resolveStatus;setHandler(async url=>url.includes('/bookings/payment-intent/')?new Promise(resolve=>{resolveStatus=resolve;}):common(url));
    await start();await goPay(page);await pay(page);await idle(page);assert.ok(resolveStatus);
    await page.evaluate(()=>{window.__userId='qa-user-b';window.__rerender();});await idle(page);
    resolveStatus({body:{status:'confirmed'}});await idle(page);
    assert.equal(await page.evaluate(()=>window.__outcomes.length),0);assert.equal(calls.filter(c=>c.url==='/api/parking-pass/routes/events').length,0);
    assert.equal((await receipts(page)).length,1);assert.equal(await page.getByTestId('card-field').count(),0);
  });
  await test('late setup response cannot reopen payment after close and reopen of the same scope',async({page,calls,setHandler,start})=>{
    let resolveSetup;setHandler(async url=>url.endsWith('/book')?new Promise(resolve=>{resolveSetup=resolve;}):common(url));
    await start();await page.getByRole('button',{name:'Continue',exact:true}).click();await idle(page);assert.ok(resolveSetup);
    await page.evaluate(()=>window.__setOpen(false));await page.getByRole('dialog').waitFor({state:'detached'});
    await page.evaluate(()=>window.__setOpen(true));await page.getByRole('dialog').waitFor();
    resolveSetup({body:paymentSetup});await idle(page);
    assert.equal(await page.getByTestId('card-field').count(),0);assert.equal(bookCalls(calls).length,1);assert.equal((await receipts(page)).length,1);
    assert.ok(!(await page.getByRole('button',{name:'Retry same booking request',exact:true}).isDisabled()));
  });
  await test('receipt cleanup storage failure cannot erase the confirmed outcome',async({page,start})=>{
    await start();await goPay(page);await page.evaluate(()=>{sessionStorage.removeItem=()=>{throw new Error('Storage denied');};});
    await pay(page);await page.waitForFunction(()=>window.__outcomes.length===1);
    assert.deepEqual(await page.evaluate(()=>window.__outcomes),[{outcome:'confirmed'}]);assert.equal((await receipts(page)).length,1);
  });
  await test('completion cannot erase a newer saved request in the same scope',async({page,start})=>{
    await start();await goPay(page);await page.evaluate(()=>{for(const [key,value] of window.__storage){if(key.startsWith('mealscout:parking-request:')){const row=JSON.parse(value);row.requestId='newer-request';window.__storage.set(key,JSON.stringify(row));}}});
    await pay(page);await page.waitForFunction(()=>window.__outcomes.length===1);assert.equal((await receipts(page))[0]?.row.requestId,'newer-request');
  });
  for(const status of [400,404,422]) await test('replay HTTP '+status+' does not erase an earlier uncertain attempt',async({page,calls,setHandler,start})=>{
    let attempts=0;setHandler(async url=>url.endsWith('/book')?(++attempts===1?{abort:true}:{status,body:{message:'Unavailable input'}}):common(url));
    await start();await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('alert').waitFor();
    await retry(page);await page.getByText('Unavailable input',{exact:true}).waitFor();
    assert.equal((await receipts(page)).length,1);assert.equal((await receipts(page))[0].row.requestId,bookCalls(calls)[0].headers['Idempotency-Key']);
    assert.ok(await page.locator('#parking-pass-promo').isDisabled());assert.equal(bookCalls(calls).length,2);
  });
  for(const status of ['confirmed','credited']) await test('recovered '+status+' is checked read-only before retiring the saved request',async({page,calls,setHandler,start})=>{
    await start();await goPay(page);await page.evaluate(()=>window.__remount());
    setHandler(async url=>url.endsWith('/book')?{body:{bookingRecovery:true,paymentIntentId:'pi_test'}}:
      url.includes('/bookings/payment-intent/')?{body:{status}}:common(url));
    await retry(page);await page.waitForFunction(()=>window.__outcomes.length===1);
    assert.deepEqual(await page.evaluate(()=>window.__outcomes),[{outcome:status}]);assert.equal((await receipts(page)).length,0);
    assert.equal(calls.filter(c=>c.url.includes('/bookings/payment-intent/')&&c.method==='GET').length,1);
    assert.equal(await page.evaluate(()=>window.__stripeCalls.length),0);
  });
};
