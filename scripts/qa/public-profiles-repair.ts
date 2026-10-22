import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import * as schema from '../../shared/schema';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

// Native Express registrars, native projections, isolated relational data, actual App router.
// Only authentication and storage/provider boundaries are fixture substitutes. Never uses a real DB.
const root=process.cwd();
const output=path.resolve(process.env.PROFILE_EVIDENCE_DIR || '../mealscout-profile-evidence/before');
const strict=process.env.PROFILE_CANDIDATE==='1';
await mkdir(output,{recursive:true}); await mkdir('.tmp-tests',{recursive:true});
for(const key of Object.keys(process.env)) if(/DATABASE_URL|STRIPE|BREVO|ANTHROPIC|OPENAI|GOOGLE.*KEY|FACEBOOK.*SECRET/.test(key)) delete process.env[key];
process.env.NODE_ENV='development'; process.env.EMAIL_NOTIFICATIONS_MODE='off';
const pg=new PGlite();
const seen=new Set<string>();
for(const table of Object.values(schema)) {
  let config; try{config=getTableConfig(table as any);}catch{continue;}
  if(!config?.name || seen.has(config.name))continue;seen.add(config.name);
  await pg.exec(`create table "${config.name}" (${config.columns.map(c=>`"${c.name}" ${(c as any).enumValues?.length?'text':c.getSQLType()}${c.primary?' primary key':''}`).join(',')})`);
}
const db=drizzle(pg,{schema});
const ownerId='profile-owner';
await db.insert(schema.users).values({id:ownerId,email:'profile-owner@example.invalid',isDisabled:false,emailVerified:true,userType:'food_truck',publicProfileSettings:{showAddress:true,showContact:true}});
await db.insert(schema.cities).values({id:'profile-city',name:'Pensacola',state:'FL',slug:'pensacola-fl',isActive:true});
const kinds=['restaurant','truck','bar','caterer','private_chef','location','supplier'] as const;
const rows=new Map<string,any>();
for(const [i,kind] of kinds.entries()) {
  const id=`a0000000-0000-4000-8000-00000000000${i+1}`;
  const row={id,ownerId,userId:ownerId,name:`Harbor ${kind.replace('_',' ')} Kitchen`,businessName:`Harbor ${kind} Kitchen`,businessType:kind==='truck'?'food_truck':kind,isFoodTruck:kind==='truck',isActive:true,isVerified:false,city:'Pensacola',state:'FL',address:'101 Public Market Street',latitude:null,longitude:null,cuisineType:'Coastal food',description:'Fresh coastal food and friendly service.',phone:'+18505550199',contactPhone:'+18505550199',websiteUrl:'https://harbor.example.invalid',logoUrl:'/fixture/photo.svg',coverImageUrl:'/fixture/photo.svg',updatedAt:new Date('2026-10-22T12:00:00Z'),rawData:{},socialAutopostSettings:{publicGalleryImages:[{id:'photo-a',url:'/fixture/photo.svg',publicApproved:true,category:'food'}]}};
  rows.set(kind,row);
  await db.insert(schema.publicBusinessSlugOwnerships).values({id:'slug-'+kind,slug:'harbor-'+kind.replace('_','-')+'-kitchen',entityType:kind,entityId:id,assignmentStatus:'assigned'});
  if(kind==='location')await db.insert(schema.hosts).values(row);
  else if(kind==='supplier') await db.insert(schema.suppliers).values(row);
  else {
    await db.insert(schema.restaurants).values(row);
    const menuId=`b0000000-0000-4000-8000-00000000000${i+1}`;
    await db.insert(schema.menus).values({id:menuId,restaurantId:id,name:'Lunch',isActive:true});
    await db.insert(schema.menuItems).values({id:`c0000000-0000-4000-8000-00000000000${i+1}`,menuId,name:'Coastal rice bowl',description:'Rice, vegetables and coastal flavors.',restaurantId:id,priceCents:1200,price:'1200',isAvailable:true,category:'Bowls',imageUrl:'/fixture/photo.svg'});
  }
}
const today=new Date();today.setUTCHours(0,0,0,0);
for(const [i,name] of ['Public Market','Harbor Square'].entries()){
  const date=new Date(today.getTime()+i*86400000);
  await db.insert(schema.truckManualSchedules).values({id:'manual-'+i,truckId:rows.get('truck').id,date,startTime:'00:00',endTime:'23:59',timezone:'UTC',locationName:name,address:'202 Public Venue Street',city:'Pensacola',state:'FL',isPublic:true,status:'open',sourceType:'owner',sourceConfidence:'high',ownerSubmittedEquivalent:true,mapEligible:true,liveFeedEligible:true,lastConfirmedAt:new Date(),updatedAt:new Date(),expiresAt:new Date(today.getTime()+3*86400000)});
}
const owner=async()=> (await db.select().from(schema.users).where(eq(schema.users.id,ownerId)))[0];
let failRead=false,failSave=false;
const storage={getUser:owner,getRestaurant:async(id:string)=>{if(failRead)throw Error('isolated failure');return(await db.select().from(schema.restaurants).where(eq(schema.restaurants.id,id)))[0]},getHost:async(id:string)=>(await db.select().from(schema.hosts).where(eq(schema.hosts.id,id)))[0],getDealsByRestaurant:async(id:string)=>db.select().from(schema.deals).where(eq(schema.deals.restaurantId,id)),verifyRestaurantOwnership:async(id:string,userId:string)=>rows.get('truck').id===id&&userId===ownerId};
(globalThis as any).__profileFixture={db,storage};
const bundle=path.resolve('.tmp-tests/profile-native.cjs');
await build({absWorkingDir:root,stdin:{contents:`export {registerPublicProfilePrerenderRoutes} from './server/seo/publicProfilePrerender'; export {registerPublicDiscoveryRoutes} from './server/routes/publicDiscoveryRoutes'; export {registerRestaurantOperationsRoutes} from './server/routes/restaurantOperationsRoutes'; export {registerSupplierMarketplaceRoutes} from './server/routes/supplierMarketplaceRoutes'; export {registerMenuRoutes} from './server/routes/menuRoutes'; export {registerBookingRoutes} from './server/routes/bookingRoutes'; export {DatabaseStorage} from './server/storage.ts';`,resolveDir:root,loader:'ts'},outfile:bundle,bundle:true,platform:'node',format:'cjs',packages:'external',tsconfig:root+'/tsconfig.json',plugins:[{name:'isolated-boundaries',setup(b){
  b.onResolve({filter:/.*/},a=>{const p=path.resolve(a.resolveDir,a.path);if(p===root+'/server/db')return{path:'db',namespace:'fixture'};if(p===root+'/server/unifiedAuth')return{path:'auth',namespace:'fixture'};if(p===root+'/server/storage')return{path:'storage',namespace:'fixture'};});
  b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'js',contents:a.path==='db'?`export const db=globalThis.__profileFixture.db; export const pool=undefined;`:a.path==='storage'?`export const storage=globalThis.__profileFixture.storage;`:`export const isAuthenticated=(req,res,next)=>req.user?next():res.status(401).json({message:'Sign in required'}); export const isAdmin=isAuthenticated; export const isStaffOrAdmin=isAuthenticated; export const isRestaurantOwner=isAuthenticated; export const isAdminOrSuperAdmin=isAuthenticated; export const requireSuperAdmin=isAuthenticated;`}));
}}]});
const native=createRequire(import.meta.url)(bundle);
await pg.exec('alter table truck_manual_schedules alter column id set default gen_random_uuid(); alter table telemetry_events alter column id set default gen_random_uuid()');
(storage as any).getTruckManualSchedules=native.DatabaseStorage.prototype.getTruckManualSchedules;
(storage as any).getTruckParkingReports=native.DatabaseStorage.prototype.getTruckParkingReports;
(storage as any).createTruckManualSchedule=native.DatabaseStorage.prototype.createTruckManualSchedule;
const app=express();app.use(express.json());
let signedIn=false;
app.use(async(req:any,res,next)=>{req.isAuthenticated=()=>signedIn; if(signedIn)req.user=await owner();if(req.method!=='GET'&&req.method!=='HEAD'&&!req.path.endsWith('/profile-basics')&&!req.path.endsWith('/manual-schedule'))return res.status(405).json({message:'Fixture blocks unrelated writes'}); if(failSave&&req.method==='PATCH')return res.status(503).json({message:'Temporary save failure'});next();});
app.get('/api/auth/user',async(_req,res)=>signedIn?res.json(await owner()):res.status(401).json({message:'Logged out'}));
app.get('/api/restaurants/my-restaurants',async(_req,res)=>res.json(await db.select().from(schema.restaurants).where(eq(schema.restaurants.ownerId,ownerId))));
app.get('/api/business-access/me',(_req,res)=>res.json({hasAnyAccess:true,permissions:{manageProfile:true,manageParkingPass:true,manageDeals:true},restaurants:[...rows.values()].filter(r=>!['location','supplier'].includes(r.businessType)).map(r=>({id:r.id,isOwner:true,permissions:{manageProfile:true,manageParkingPass:true,manageDeals:true}}))}));
native.registerPublicDiscoveryRoutes(app);
native.registerSupplierMarketplaceRoutes(app);native.registerMenuRoutes(app);native.registerBookingRoutes(app,{hasCompleteProfileAccess:async()=>true});
native.registerRestaurantOperationsRoutes(app,{validateProfileAnalyticsAccess:async()=>({hasAccess:true}),hasCompleteProfileAccess:async()=>true});
app.use('/api',(_req,res)=>res.json({}));
native.registerPublicProfilePrerenderRoutes(app,'https://www.mealscout.us');
app.get('/fixture/photo.svg',(_req,res)=>res.type('svg').send('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="#ffb777"/><circle cx="400" cy="200" r="120" fill="#fff8ef"/><text x="290" y="210" font-size="24" fill="#7b321f">Synthetic food photo</text></svg>'));
const vite=await createServer({configFile:path.resolve('vite.config.ts'),server:{middlewareMode:true,hmr:false},appType:'spa'});
app.use(vite.middlewares);
const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
const base=`http://127.0.0.1:${(server.address() as any).port}`;
const report:any={base,mode:strict?'candidate':'baseline',tables:seen.size,checks:[],defects:[],screens:[],scope:'Loopback synthetic PGlite, real profile API/SSR registrars and actual routed React. Synthetic owner auth/storage boundaries. No provider, production data or publication.'};
function check(label:string,ok:boolean,detail?:unknown){report.checks.push({label,ok,detail});if(!ok){report.defects.push(label);if(strict)throw Error(label+': '+JSON.stringify(detail));}}
let browser:any;
try{
  for(const kind of kinds){const row=rows.get(kind);const response=await fetch(`${base}/api/public/profiles/${kind}/${row.id}`);const dto:any=await response.json();check(kind+' logged-out API',response.status===200,{status:response.status,dto});if(response.status===200)row.dto=dto;
    if(response.status===200){const htmlRes=await fetch(base+dto.profilePath);const html=await htmlRes.text();check(kind+' server HTML/canonical',htmlRes.status===200&&html.includes('rel="canonical"')&&html.includes(dto.displayName),htmlRes.status);await writeFile(path.join(output,kind+'-ssr.html'),html);if(kind==='location'||kind==='supplier')check(kind+' opens interactive profile',html.includes('?view=app'));}}
  browser=await chromium.launch({headless:true,executablePath:process.env.PROFILE_CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  for(const viewport of [{width:1365,height:900},{width:390,height:844}]){
    const context=await browser.newContext({viewport,serviceWorkers:'block'});let blocked=0;
    await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==base){blocked++;return route.abort();}if(!['GET','HEAD','OPTIONS'].includes(route.request().method())&&!u.pathname.endsWith('/profile-basics')&&!u.pathname.endsWith('/manual-schedule'))return route.fulfill({status:204});return route.continue();});
    const page=await context.newPage();page.setDefaultTimeout(30000);
    for(const kind of kinds){const row=rows.get(kind);if(!row.dto)continue;
      await page.goto(base+row.dto.profilePath+'?view=app',{waitUntil:'networkidle'});
      // The baseline host/supplier response loops at SSR; also inspect their actual existing App route via Vite directly.
      if((kind==='location'||kind==='supplier')&&!strict){await page.route(base+row.dto.profilePath+'?view=app',async route=>route.fulfill({contentType:'text/html',body:await vite.transformIndexHtml(row.dto.profilePath,await readFile('client/index.html','utf8'))}));await page.reload({waitUntil:'networkidle'});}
      check(kind+' routed heading '+viewport.width,await page.getByRole('heading',{name:row.dto.displayName,exact:true}).isVisible());
      const shell=page.locator('.mealscout-public-profile');check(kind+' native brand '+viewport.width,await shell.count()===1);
      check(kind+' no horizontal overflow '+viewport.width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      const filename=`${kind}-${viewport.width}.png`;await page.screenshot({path:path.join(output,filename),fullPage:true});report.screens.push(filename);
      if(kind==='supplier'&&viewport.width>700)check('supplier desktop actions',await page.locator('main a[href="https://harbor.example.invalid"]').first().isVisible());
      if(kind==='location')check('unknown host activity is not zero',!(await page.locator('#menu').innerText()).includes('No trucks listed right now'));
      if(kind==='truck'){check('truck schedule anchor',await page.locator('#truck-schedule').count()===1);check('scheduled stop is not a live broadcast',!(await page.locator('[data-public-profile-decision-bar]').innerText()).toLowerCase().includes('live now'));}
      const canonical=await page.locator('link[rel="canonical"]').getAttribute('href');check(kind+' canonical origin '+viewport.width,canonical===row.dto.seo.canonicalUrl,canonical);
    }
    report.checks.push({label:'browser external requests blocked '+viewport.width,ok:true,detail:blocked});await context.close();
  }
  const truck=rows.get('truck');
  const catalogContext=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  await catalogContext.route('**/*',route=>{const u=new URL(route.request().url());return u.origin===base&&['GET','HEAD','OPTIONS'].includes(route.request().method())?route.continue():route.abort();});
  const catalog=await catalogContext.newPage();catalog.setDefaultTimeout(30000);
  const supplier=rows.get('supplier');await catalog.goto(base+supplier.dto.profilePath+'?view=app',{waitUntil:'networkidle'});
  const catalogLink=catalog.locator('[data-mobile-action-dock] a').filter({hasText:'Browse'}).first();
  check('supplier mobile catalog action visible',await catalogLink.isVisible());
  await catalogLink.click();await catalog.getByText('You can browse products without an account.',{exact:false}).waitFor();
  check('supplier catalog opens without login',new URL(catalog.url()).pathname===`/suppliers/${supplier.id}`);
  await catalog.screenshot({path:path.join(output,'supplier-catalog-390.png'),fullPage:true});await catalogContext.close();
  const metadataBefore=truck.dto.seo;
  await db.insert(schema.restaurantSubscriptions).values({id:'synthetic-paid',restaurantId:truck.id,tier:'yearly',status:'active',priceCents:0});
  check('free and paid public metadata parity',JSON.stringify((await (await fetch(`${base}/api/public/profiles/truck/${truck.id}`)).json()).seo)===JSON.stringify(metadataBefore));
  await db.delete(schema.restaurantSubscriptions).where(eq(schema.restaurantSubscriptions.id,'synthetic-paid'));
  const retryContext=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  await retryContext.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==base)return route.abort();if(!['GET','HEAD','OPTIONS'].includes(route.request().method()))return route.fulfill({status:204});return route.continue();});
  const retryPage=await retryContext.newPage();retryPage.setDefaultTimeout(30000);
  await retryPage.goto(base+truck.dto.profilePath+'?view=app',{waitUntil:'networkidle'});
  await retryPage.getByRole('link',{name:'Full schedule',exact:true}).click();
  check('full schedule link reaches its target',new URL(retryPage.url()).hash==='#truck-schedule');
  check('posted manual address supports directions',await retryPage.locator('#truck-schedule a[href*="maps.google.com"]').count()>=2);
  check('menu item and photo render',await retryPage.locator('[data-public-menu-item]').count()>=1&&await retryPage.getByText('Coastal rice bowl',{exact:true}).first().isVisible());
  failRead=true;await retryPage.reload({waitUntil:'domcontentloaded'});
  await retryPage.getByRole('button',{name:'Retry profile',exact:true}).waitFor();
  check('failed read clears public structured data',await retryPage.locator('script[data-page-schema]').count()===0);
  check('failed read metadata is unavailable',await retryPage.title()==='Profile unavailable | MealScout');
  failRead=false;await retryPage.getByRole('button',{name:'Retry profile',exact:true}).click();
  await retryPage.getByRole('heading',{name:truck.dto.displayName,exact:true}).waitFor();
  check('read retry restores public schema',await retryPage.locator('script[data-page-schema]').count()===1);
  await retryPage.screenshot({path:path.join(output,'retry-recovered-390.png'),fullPage:true});
  await retryContext.close();
  await db.update(schema.users).set({publicProfileSettings:{showAddress:false,showContact:false}}).where(eq(schema.users.id,ownerId));
  for(const kind of kinds){const row=rows.get(kind);const api=await fetch(`${base}/api/public/profiles/${kind}/${row.id}`);const text=await api.text();check(kind+' private fields redacted',api.status===200&&!text.includes('101 Public Market Street')&&!text.includes('+18505550199'));const html=await(await fetch(base+row.dto.profilePath)).text();check(kind+' private SSR fields redacted',!html.includes('101 Public Market Street')&&!html.includes('+18505550199'));}
  await db.update(schema.users).set({publicProfileSettings:{showAddress:true,showContact:true}}).where(eq(schema.users.id,ownerId));
  const patch=async(body:any)=>fetch(`${base}/api/restaurants/${truck.id}/profile-basics`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  check('logged-out editing rejected',(await patch({description:'Unauthorized'})).status===401);
  signedIn=true;
  const foreign=await fetch(`${base}/api/restaurants/${rows.get('restaurant').id}/profile-basics`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({description:'Cross-business edit'})});
  check('foreign owner edit rejected',foreign.status===403);
  failSave=true;check('save failure is retryable',(await patch({description:'Must not persist'})).status===503);failSave=false;
  const save=await patch({isActive:true,description:'Owner saved coastal description'});check('already-public unverified owner can save',save.status===200,{status:save.status,body:await save.json()});
  check('owner text persists in public API',(await (await fetch(`${base}/api/public/profiles/truck/${truck.id}`)).json()).description==='Owner saved coastal description');
  const ownerContext=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  await ownerContext.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==base)return route.abort();if(!['GET','HEAD','OPTIONS'].includes(route.request().method())&&!u.pathname.endsWith('/profile-basics')&&!u.pathname.endsWith('/manual-schedule'))return route.fulfill({status:204});return route.continue();});
  const editor=await ownerContext.newPage();editor.setDefaultTimeout(30000);
  await editor.addInitScript(()=>{navigator.geolocation.getCurrentPosition=()=>{throw Error('Owner device coordinates must not be used');};});
  await editor.goto(base+`/restaurant-owner-dashboard?setup=profile&restaurantId=${truck.id}`,{waitUntil:'networkidle'});
  const dismiss=editor.getByRole('button',{name:/got it/i});if(await dismiss.isVisible())await dismiss.click();
  await editor.getByRole('heading',{name:'What customers see',exact:true}).waitFor();
  const about=editor.getByLabel(/^About your business/);
  await about.fill('Owner edited from mobile profile');
  failSave=true;await editor.getByTestId('button-save-profile').click();
  await editor.getByText('Unable to save profile',{exact:true}).waitFor();
  check('owner failed save retains draft',await about.inputValue()==='Owner edited from mobile profile');
  failSave=false;await editor.getByTestId('button-save-profile').click();
  await editor.getByText('Business Profile Updated',{exact:true}).waitFor();
  const manual=editor.getByRole('link',{name:'Add a dated stop manually',exact:true});
  check('manual fallback preserves selected business',(await manual.getAttribute('href'))===`/parking-pass?setup=schedule&truckId=${truck.id}`);
  await editor.screenshot({path:path.join(output,'owner-editor-390.png'),fullPage:true});
  await editor.reload({waitUntil:'networkidle'});await editor.getByRole('heading',{name:'What customers see',exact:true}).waitFor();
  check('owner save survives reload',await about.inputValue()==='Owner edited from mobile profile');
  check('owner AI remains optional',await editor.getByTestId('owner-profile-workspace').isVisible());
  await editor.getByRole('link',{name:'Add a dated stop manually',exact:true}).click();
  await editor.locator('#schedule-location').waitFor();
  check('manual fallback opens native dated-stop editor',new URL(editor.url()).pathname==='/parking-pass'&&await editor.locator('#schedule-location').isEnabled());
  const manualDate=new Date(today.getTime()+2*86400000).toISOString().slice(0,10);
  await editor.locator('#schedule-date').fill(manualDate);await editor.locator('#schedule-start').fill('12:00');await editor.locator('#schedule-end').fill('14:00');
  await editor.locator('#schedule-location').fill('Mobile manual venue');await editor.locator('#schedule-address').fill('303 Public Plaza');await editor.locator('#schedule-city').fill('Pensacola');await editor.locator('#schedule-state').fill('FL');
  const [manualSaved]=await Promise.all([editor.waitForResponse(r=>r.url().endsWith('/manual-schedule')&&r.request().method()==='POST'),editor.getByRole('button',{name:'Add stop',exact:true}).click()]);
  check('manual fallback saves through native API',manualSaved.status()===200,await manualSaved.text());
  const publicAfterManual:any=await(await fetch(`${base}/api/public/profiles/truck/${truck.id}`)).json();
  check('manual public stop appears without owner GPS',JSON.stringify(publicAfterManual.truckSchedule).includes('Mobile manual venue'));
  await editor.screenshot({path:path.join(output,'manual-fallback-390.png'),fullPage:true});
  await ownerContext.close();
  const desktopOwner=await browser.newContext({viewport:{width:1365,height:900},serviceWorkers:'block'});
  await desktopOwner.route('**/*',route=>{const u=new URL(route.request().url());return u.origin===base&&['GET','HEAD','OPTIONS'].includes(route.request().method())?route.continue():route.fulfill({status:204});});
  const desktopEditor=await desktopOwner.newPage();desktopEditor.setDefaultTimeout(30000);await desktopEditor.goto(base+`/restaurant-owner-dashboard?setup=profile&restaurantId=${truck.id}`,{waitUntil:'networkidle'});await desktopEditor.getByRole('heading',{name:'What customers see',exact:true}).waitFor();
  check('desktop owner sees saved mobile edits',await desktopEditor.getByLabel(/^About your business/).inputValue()==='Owner edited from mobile profile');
  await desktopEditor.screenshot({path:path.join(output,'owner-editor-1365.png'),fullPage:true});await desktopOwner.close();
  await db.update(schema.restaurants).set({isActive:false}).where(eq(schema.restaurants.id,truck.id));
  check('unpublished API stays private',(await fetch(`${base}/api/public/profiles/truck/${truck.id}`)).status===404);
  check('unpublished HTML stays private',(await fetch(base+truck.dto.profilePath+'?view=app')).status===404);
  check('unverified cannot publish',(await patch({isActive:true})).status!==200);
}finally{await browser?.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await vite.close();await pg.close();await writeFile(path.join(output,'receipt.json'),JSON.stringify(report,null,2));delete(globalThis as any).__profileFixture;}
console.log(JSON.stringify({mode:report.mode,checks:report.checks.length,defects:report.defects,output}));

process.exit(0);
