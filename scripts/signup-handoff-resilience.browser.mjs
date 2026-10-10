import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root=process.cwd();
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'meal-signup-handoff-'));
const suite=process.env.MEAL_HANDOFF_SUITE||'all';
assert(['all','storage','auth'].includes(suite));
const report={passed:false,suite,cases:[],productionWrites:0,scope:'Real signup pages, useAuth, query client and form validation on loopback with intercepted registration/session responses. Not a production account, email verification or host publication.'};
let browser,server;
const fixtureUser={id:'fixture-user',email:'fixture@example.invalid',firstName:'Fixture',lastName:'User',phone:'2025550146',userType:'host',emailVerified:true};
try {
  await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClientProvider} from '@tanstack/react-query';import {useLocation} from 'wouter';import {queryClient} from './client/src/lib/queryClient';import Customer from './client/src/pages/customer-signup';import Host from './client/src/pages/host-signup';window.__handoffClient=queryClient;function App(){const [location]=useLocation();return location==='/host-signup'?<Host/>:location==='/customer-signup'?<Customer/>:<main data-testid="destination">{location}</main>;}createRoot(document.getElementById('root')).render(<QueryClientProvider client={queryClient}><App/></QueryClientProvider>);`,resolveDir:root,loader:'tsx'},bundle:true,format:'esm',platform:'browser',jsx:'automatic',alias:{'@':path.join(root,'client/src'),'@shared':path.join(root,'shared')},define:{'process.env.NODE_ENV':'"production"','import.meta.env':JSON.stringify({DEV:false,PROD:true,MODE:'production',BASE_URL:'/'})},outfile:path.join(temporary,'app.js'),logLevel:'silent'});
  const publicDir=path.join(root,'dist/public');
  const css=fs.readdirSync(publicDir,{recursive:true}).filter(f=>String(f).endsWith('.css'));
  assert(css.length,'Production CSS is required');
  fs.writeFileSync(path.join(temporary,'app.css'),css.map(f=>fs.readFileSync(path.join(publicDir,String(f)),'utf8')).join('\n'));
  const app=express();app.use(express.static(temporary));
  app.get('*',(_req,res)=>res.type('html').send('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>'));
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  for(const width of [390,1440]) {
    if(suite!=='auth') for(const role of ['host','diner','event_coordinator','supplier']) for(const storage of ['normal','remove-fails','storage-unavailable']) {
      const context=await browser.newContext({viewport:{width,height:950},serviceWorkers:'block'});
      const errors=[];let registrations=0,blockedWrites=0,intendedNextPath;
      await context.addInitScript(mode=>{
        if(mode==='remove-fails') {
          const remove=Storage.prototype.removeItem;
          Storage.prototype.removeItem=function(key){if(key==='mealscout:customer-signup-draft')throw new DOMException('Fixture storage denied','SecurityError');return remove.call(this,key);};
        } else if(mode==='storage-unavailable') {
          for(const name of ['localStorage','sessionStorage'])Object.defineProperty(window,name,{get(){throw new DOMException('Fixture storage denied','SecurityError');},configurable:true});
        }
      },storage);
      await context.route('**/*',async route=>{
        const req=route.request(),url=new URL(req.url());
        if(url.origin!==base)return route.abort();
        if(url.pathname==='/api/auth/user')return route.fulfill({status:401,contentType:'application/json',body:'{"message":"Guest fixture"}'});
        if(['/api/auth/customer/register','/api/auth/supplier/register'].includes(url.pathname)&&req.method()==='POST') {
          registrations++;intendedNextPath=req.postDataJSON().intendedNextPath;
          return route.fulfill({status:201,contentType:'application/json',body:'{"message":"Fixture registration accepted; verification is still required."}'});
        }
        if(req.method()!=='GET'){blockedWrites++;return route.abort();}
        if(url.pathname.startsWith('/api/'))return route.fulfill({status:404,contentType:'application/json',body:'{}'});
        return route.continue();
      });
      const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
      await page.goto(`${base}/customer-signup?role=${role}`);
      await page.getByTestId('input-email').fill('fixture@example.invalid');
      await page.getByTestId('input-first-name').fill('Fixture');await page.getByTestId('input-last-name').fill('User');
      await page.getByTestId('input-phone').fill('2025550146');
      await page.getByTestId('input-password').fill('TestOnly!Route2026');await page.getByTestId('input-confirm-password').fill('TestOnly!Route2026');
      if(role==='host')await page.getByTestId('input-host-location-name').fill('Fixture host');
      if(role==='event_coordinator')await page.getByTestId('input-event-name').fill('Fixture event');
      if(role==='supplier')await page.getByTestId('input-supplier-business-name').fill('Fixture supplier');
      await page.getByTestId('checkbox-phone-contact-consent').uncheck();
      await page.getByTestId('button-create-account').click();
      await page.waitForURL(url=>url.pathname==='/post-verification',{timeout:4000}).catch(()=>{});
      const url=new URL(page.url());
      assert.equal(url.pathname,'/post-verification','successful signup must reach verification despite blocked storage');
      const target=role==='host'?'/host-signup':role==='supplier'?'/supplier/dashboard':role==='event_coordinator'?'/event-coordinator/dashboard?setup=onboarding':'/scout';
      assert.equal(url.searchParams.get('redirect'),target);assert.equal(url.searchParams.get('status'),'check-email');
      assert.equal(intendedNextPath,target);assert.equal(registrations,1,'No second registration caused by cleanup failure');
      assert.deepEqual(errors,[]);
      report.cases.push({width,kind:'registration-handoff',role,storage,passed:true,registrations,blockedWrites,verificationRequired:true});
      await context.close();
    }
    if(suite!=='storage') for(const scenario of ['delayed-auth','confirmed-guest','auth-error-retry','draft-refresh']) {
      const context=await browser.newContext({viewport:{width,height:950},serviceWorkers:'block'});
      let release,mode=scenario==='auth-error-retry'?'error':'hold',authReads=0,writes=0;
      const errors=[];
      await context.addInitScript(()=>localStorage.setItem('mealscout:host-signup-draft',JSON.stringify({businessName:'Stored fixture',city:'Fixture city'})));
      await context.route('**/*',async route=>{
        const req=route.request(),url=new URL(req.url());
        if(url.origin!==base)return route.abort();
        if(req.method()!=='GET'){writes++;return route.abort();}
        if(url.pathname==='/api/auth/user') {
          authReads++;if(mode==='hold')await new Promise(resolve=>release=resolve);
          if(mode==='error')return route.fulfill({status:500,contentType:'application/json',body:'{"message":"Authentication unavailable"}'});
          return route.fulfill({status:mode==='guest'?401:200,contentType:'application/json',body:JSON.stringify(mode==='guest'?{message:'Guest fixture'}:fixtureUser)});
        }
        if(url.pathname.startsWith('/api/'))return route.fulfill({status:404,contentType:'application/json',body:'{}'});
        return route.continue();
      });
      const page=await context.newPage();page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
      await page.goto(base+'/host-signup');
      if(scenario==='auth-error-retry') {
        await page.getByRole('button',{name:'Retry session check'}).waitFor();
        assert.equal(new URL(page.url()).pathname,'/host-signup','Auth errors are not guest sessions');
        assert.equal(await page.locator('form').count(),0);
        mode='authenticated';await page.getByRole('button',{name:'Retry session check'}).click();
        await page.locator('#businessName').waitFor();assert.equal(await page.locator('#businessName').inputValue(),'Stored fixture');
      } else {
        await page.getByText('Loading host signup',{exact:true}).waitFor().catch(()=>{});
        await page.waitForTimeout(80);
        assert.equal(new URL(page.url()).pathname,'/host-signup','pending auth must not redirect the host to signup');
        assert.equal(await page.locator('form').count(),0,'No host writes before auth is known');
        assert.equal(typeof release,'function');mode=scenario==='confirmed-guest'?'guest':'authenticated';release();
        if(scenario==='confirmed-guest') {
          await page.waitForURL(url=>url.pathname==='/customer-signup');assert.equal(new URL(page.url()).searchParams.get('role'),'host');
        } else {
          await page.locator('#businessName').waitFor();assert.equal(await page.locator('#businessName').inputValue(),'Stored fixture');
          if(scenario==='draft-refresh') {
            await page.locator('#businessName').fill('Unsaved edit stays');
            await page.evaluate(()=>localStorage.setItem('mealscout:host-signup-draft','{"businessName":"Older stored fixture"}'));
            mode='hold';release=undefined;
            await page.evaluate(()=>{void window.__handoffClient.resetQueries({queryKey:['/api/auth/user']});});
            await page.getByText('Loading host signup',{exact:true}).waitFor();
            assert.equal(new URL(page.url()).pathname,'/host-signup');
            for(let i=0;i<30&&typeof release!=='function';i++)await page.waitForTimeout(20);
            assert.equal(typeof release,'function');mode='authenticated';release();
            await page.locator('#businessName').waitFor();assert.equal(await page.locator('#businessName').inputValue(),'Unsaved edit stays','Auth refresh must not reload stale saved details');
          }
        }
      }
      assert.deepEqual(errors,[]);
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
      // Guest continuation uses the unchanged account signup layout; only host UI changed here.
      if(scenario!=='confirmed-guest')assert.equal(overflow,false);
      report.cases.push({width,kind:'host-session',scenario,passed:true,authReads,blockedWrites:writes,overflow});
      await context.close();
    }
  }
  report.passed=true;
} catch(error) {report.error=String(error.stack||error);process.exitCode=1;}
finally {
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});
  console.log('SIGNUP_HANDOFF_BROWSER '+JSON.stringify(report));
}
