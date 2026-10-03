import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root=process.cwd(),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'host-intake-browser-'));
const evidence={passed:false,cases:[],productionWrites:0,scope:'Actual host-partner page, real submission module and production CSS with isolated network responses. No live account, email, customer request or analytics event.'};
let browser,server;
const baseline=process.env.HOST_INTAKE_BROWSER_BASELINE==='1';
try {
  await build({stdin:{contents:"import React from 'react';import {createRoot} from 'react-dom/client';import Page from './client/src/pages/host-location-partner';const root=createRoot(document.getElementById('root'));root.render(<Page/>);window.__unmountHost=()=>root.unmount();",resolveDir:root,loader:'tsx'},bundle:true,format:'esm',platform:'browser',jsx:'automatic',alias:{'@':path.join(root,'client/src'),'@shared':path.join(root,'shared')},define:{'process.env.NODE_ENV':'\"production\"'},outfile:path.join(temporary,'app.js'),logLevel:'silent'});
  const output=path.join(root,'dist/public');
  const css=fs.readdirSync(output,{recursive:true}).filter(file=>String(file).endsWith('.css'));
  assert(css.length,'Built production CSS required');
  fs.writeFileSync(path.join(temporary,'app.css'),css.map(file=>fs.readFileSync(path.join(output,String(file)),'utf8')).join('\n'));
  const app=express();app.use(express.static(temporary));app.get('*',(_req,res)=>res.type('html').send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>'));
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const scenarios=baseline?['html']:['html','malformed','empty','missing-id','wrong-email-type','declared-failure','400','429','503','network','timeout','email-confirmed','email-unconfirmed','duplicate','unmount'];
  for(const width of baseline?[390]:[390,1440]) for(const scenario of scenarios) {
    const context=await browser.newContext({viewport:{width,height:950},serviceWorkers:'block'});
    if(scenario==='timeout')await context.addInitScript(()=>{
      const original=window.setTimeout.bind(window);
      window.setTimeout=(fn,delay,...args)=>original(fn,delay===20000?100:delay,...args);
    });
    const page=await context.newPage();page.setDefaultTimeout(6000);
    let calls=0,release,unexpectedWrites=0;const errors=[],payloads=[];
    page.on('pageerror',error=>errors.push(error.message));
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!==base)return route.abort();
      if(url.pathname==='/api/public/host-partner-leads'&&request.method()==='POST') {
        calls++;payloads.push(request.postDataJSON());
        if(['timeout','duplicate','unmount'].includes(scenario))await new Promise(resolve=>release=resolve);
        if(scenario==='network')return route.abort('failed');
        const statuses={'400':400,'429':429,'503':503};
        if(statuses[scenario])return route.fulfill({status:statuses[scenario],contentType:'application/json',body:'{"ok":false,"message":"PRIVATE_INTERNAL_DETAIL"}'});
        let contentType='application/json',body=JSON.stringify({ok:true,leadId:'fixture-request-123',emailed:scenario!=='email-unconfirmed'});
        if(scenario==='html'){contentType='text/html';body='<html>generic fallback</html>';}
        if(scenario==='malformed')body='{';
        if(scenario==='empty')body='{}';
        if(scenario==='missing-id')body='{"ok":true,"emailed":true}';
        if(scenario==='wrong-email-type')body='{"ok":true,"leadId":"fixture-request-123","emailed":"false"}';
        if(scenario==='declared-failure')body='{"ok":false,"leadId":"fixture-request-123","emailed":true}';
        return route.fulfill({status:200,contentType,body}).catch(()=>{});
      }
      if(request.method()!=='GET'){unexpectedWrites++;return route.abort();}
      if(url.pathname.startsWith('/api/'))return route.abort();
      return route.continue();
    });
    try {
      await page.goto(base+'/host-location-partner');
      await page.locator('#email').fill('fixture@example.invalid');
      await page.locator('#businessName').fill('  Fixture host  ');
      await page.locator('#notes').fill('Fixture notes retained locally only');
      if(scenario==='duplicate') {
        await page.locator('form').evaluate(form=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
      } else await page.getByRole('button',{name:'Request Host Partnership',exact:true}).click();
      if(['duplicate','unmount'].includes(scenario)) {
        await page.waitForFunction(()=>document.querySelector('form')?.getAttribute('aria-busy')==='true');
        for(let n=0;n<60&&!release;n++)await new Promise(r=>setTimeout(r,10));
        assert.equal(calls,1,'Overlapping submits must not create another request');
        assert.equal(await page.getByRole('button',{name:'Submitting...',exact:true}).isDisabled(),true);
        if(scenario==='unmount')await page.evaluate(()=>window.__unmountHost());
        release?.();
      }
      if(scenario==='unmount') {
        await page.waitForTimeout(100);assert.equal(await page.locator('#root').innerText(),'');
      } else if(['email-confirmed','email-unconfirmed','duplicate'].includes(scenario)) {
        await page.getByRole('heading',{name:'Request received',exact:true}).waitFor();
        const text=await page.getByTestId('host-partner-receipt').innerText();
        assert(text.includes('fixture-request-123'));assert(!text.includes('We sent next steps'));
        assert(text.includes(scenario==='email-unconfirmed'?'email delivery was not confirmed':'submitted for email delivery'));
        const link=page.locator('a[href="/customer-signup?role=host"]');assert.equal(await link.count(),1);assert.equal(await link.isVisible(),true);
        assert.equal(await page.locator('form').count(),0);
      } else {
        // This detects the unchanged page's false-positive success without relying on new test IDs.
        await page.waitForFunction(()=>Boolean(document.querySelector('[role="alert"]'))||document.body.textContent.includes('Request received'));
        assert.equal(await page.getByRole('heading',{name:'Request received',exact:true}).count(),0,'Malformed or failed response must not produce a receipt');
        const message=await page.getByRole('alert').innerText();assert(message.length>10);assert(!message.includes('PRIVATE_INTERNAL_DETAIL'));
        assert.equal(await page.locator('#email').inputValue(),'fixture@example.invalid');assert.equal(await page.locator('#businessName').inputValue(),'  Fixture host  ');
        assert.equal(await page.locator('#notes').inputValue(),'Fixture notes retained locally only');
        assert.equal(await page.getByRole('button',{name:'Request Host Partnership',exact:true}).isEnabled(),true);
        release?.();
      }
      assert.equal(calls,1,'No automatic replay');assert.equal(unexpectedWrites,0);
      assert.equal(payloads[0].businessName,'Fixture host');assert.equal(payloads[0].source,'host_location_partner_page');
      assert(!page.url().includes('fixture'));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(errors,[]);
      evidence.cases.push({width,scenario,passed:true,calls,unexpectedWrites,fieldsOrReceiptPreserved:true});
      if(process.env.HOST_INTAKE_BROWSER_OUTPUT&&['html','email-unconfirmed'].includes(scenario)) {
        fs.mkdirSync(process.env.HOST_INTAKE_BROWSER_OUTPUT,{recursive:true});await page.screenshot({path:path.join(process.env.HOST_INTAKE_BROWSER_OUTPUT,`host-intake-${width}-${scenario}.png`),fullPage:true});
      }
    } finally {release?.();await context.close();}
  }
  evidence.passed=true;
} finally {
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});
  console.log('HOST_INTAKE_BROWSER '+JSON.stringify(evidence));
}
