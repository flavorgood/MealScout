/** Actual React + Chromium component tests. Native dialog/UI and API/Stripe
 * fixtures isolate checkout state; this does NOT test Radix, real Stripe,
 * production storage, backend booking capacity/insurance or full E2E.
 * The local offline runtime override is reported; normal CI uses installed React.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { chromium } = require(process.env.UI_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(process.env.PARKING_SOURCE_OVERRIDE || path.join(root, 'client/src/components/booking-payment-modal.tsx'), 'utf8');
assert.equal(ts.createSourceFile('modal.tsx', source, ts.ScriptTarget.Latest, true).parseDiagnostics.length, 0);
const code = ts.transpileModule(source.replace('import.meta.env.VITE_STRIPE_PUBLIC_KEY', '"pk_test_fixture"'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React},
}).outputText;
const runtime = process.env.UI_REACT_RUNTIME ? fs.readFileSync(process.env.UI_REACT_RUNTIME,'utf8') :
  require('esbuild').buildSync({stdin:{contents:'import * as React from "react"; import * as ReactDOM from "react-dom/client"; window.ReactTestRuntime={React,ReactDOM};',resolveDir:root},bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'}).outputFiles[0].text;
const requestCode = ts.transpileModule(fs.readFileSync(path.join(root, "client/src/lib/parking-booking-request.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const fixture = `
const React=ReactTestRuntime.React;const {createRoot}=ReactTestRuntime.ReactDOM;
const storage=new Map();Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},configurable:true});
window.__storage=storage;window.__userId="qa-user-a";window.__toasts=[];window.__outcomes=[];window.__closes=[];window.__stripeCalls=[];
window.__confirm=async()=>({paymentIntent:{status:'succeeded'}});
window.fetch=async(url,options={})=>{const r=await window.__api(String(url),options);if(r.abort)throw new TypeError('Connection interrupted');return new Response(JSON.stringify(r.body),{status:r.status||200,headers:{'Content-Type':'application/json'}});};
// Accelerate only the modal's polling clock, never the test runner or React.
let clock=0;const DateFixture={now:()=>{clock+=13000;return clock;}};
const toast=value=>window.__toasts.push(value);
const dialogContext=React.createContext(null);
function Dialog({children,open,onOpenChange}){return open?React.createElement(dialogContext.Provider,{value:onOpenChange},children):null;}
function DialogContent({children}){const close=React.useContext(dialogContext);return React.createElement('section',{role:'dialog'},React.createElement('button',{type:'button','aria-label':'Close dialog',onClick:()=>close(false)},'Close'),children);}
function Description({children,asChild}){return asChild?children:React.createElement('p',{},children);}
function primitive(tag){return ({children,variant,...props})=>React.createElement(tag,props,children);}
const modules={react:React,'@stripe/react-stripe-js':{Elements:({children})=>React.createElement('div',{},children),PaymentElement:()=>React.createElement('div',{'data-testid':'card-field'},'Card fixture'),useStripe:()=>({confirmPayment:options=>{window.__stripeCalls.push(options);return window.__confirm(options);}}),useElements:()=>({fixture:true})},
'@/components/ui/button':{Button:primitive('button')},'@/components/ui/dialog':{Dialog,DialogContent,DialogDescription:Description,DialogHeader:primitive('header'),DialogTitle:primitive('h2')},'lucide-react':{Loader2:()=>null},'@/hooks/use-toast':{useToast:()=>({toast})},'@/components/payment-browser-gate':{__esModule:true,default:()=>null},'@/lib/inAppBrowser':{isPaymentHostileBrowser:()=>false},'@/lib/api':{apiUrl:p=>p},'@/lib/stripeClient':{getStripePromise:()=>({fixture:true})}};
modules["@/hooks/useAuth"]={useAuth:()=>({user:window.__userId?{id:window.__userId}:null})};
modules["@/lib/parking-booking-request"]={};new Function("exports",${JSON.stringify(requestCode)})(modules["@/lib/parking-booking-request"]);
const mod={exports:{}};new Function('require','exports','module','React','Date','setTimeout',${JSON.stringify(code)})(id=>{if(!(id in modules))throw new Error('Unstubbed '+id);return modules[id];},mod.exports,mod,React,DateFixture,(fn,delay)=>window.setTimeout(fn,delay===1500?0:delay));
const Modal=mod.exports.BookingPaymentModal;
function App(){const [open,setOpen]=React.useState(true);window.__setOpen=setOpen;const close=React.useCallback(value=>{window.__closes.push(value);setOpen(value);},[]);const success=React.useCallback(value=>window.__outcomes.push(value),[]);return React.createElement(Modal,{open,onOpenChange:close,onSuccess:success,passId:window.__passId||'pass-a',truckId:window.__truckId||'truck-a',slotTypes:['lunch'],selectedDates:['2026-10-01'],eventDetails:{name:'Test pass',hostName:'Test host',date:'2026-10-01',startTime:'11:00',endTime:'14:00',slotSummary:'Lunch'}});}
let testRoot;window.__start=()=>{sessionStorage.setItem('mealscout_route_booking_context',JSON.stringify({routeId:'test-route'}));testRoot=createRoot(document.getElementById('root'));testRoot.render(React.createElement(App));};window.__remount=()=>{testRoot.unmount();testRoot=createRoot(document.getElementById('root'));testRoot.render(React.createElement(App));};window.__rerender=()=>testRoot.render(React.createElement(App));window.__ready=true;
`;
const paymentSetup={paymentIntentId:'pi_test',clientSecret:'secret_test',totalCents:2100,breakdown:{hostPrice:1800,platformFee:300},hostPaymentsReady:false};
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.UI_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox']});
 const results=[];let reactVersion;
 async function test(name,run){const context=await browser.newContext({viewport:{width:390,height:844}});const page=await context.newPage();page.setDefaultTimeout(2500);const calls=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 let handler=async(url)=>({body:url==='/api/payout/balance'?{balance:5}:url.includes('/bookings/payment-intent/')?{status:'confirmed'}:url.endsWith('/book')?paymentSetup:{}});
 try{await page.route('**/*',r=>r.abort());await page.exposeFunction('__api',async(url,options)=>{const c={url,method:options.method||'GET',headers:options.headers||{},body:options.body?JSON.parse(options.body):null};calls.push(c);return handler(url,c);});await page.setContent('<div id="root"></div>');await page.addScriptTag({type:'module',content:runtime});await page.waitForFunction(()=>!!window.ReactTestRuntime);await page.addScriptTag({type:'module',content:fixture});await page.waitForFunction(()=>window.__ready);reactVersion=await page.evaluate(()=>ReactTestRuntime.React.version);
 await run({page,calls,setHandler:h=>handler=h,start:()=>page.evaluate(()=>window.__start())});assert.deepEqual(errors,[]);results.push({name,status:'pass'});
 }catch(e){results.push({name,status:'fail',error:e.message});}finally{console.error(JSON.stringify(results.at(-1)));await context.close();}}
 const pay=async(page)=>{await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByTestId('card-field').waitFor();};
 try{
 await test('pending is never labeled or tracked as confirmed',async({page,calls,setHandler,start})=>{
  setHandler(async url=>({body:url==='/api/payout/balance'?{balance:5}:url.endsWith('/book')?paymentSetup:{status:'pending'}}));await start();await pay(page);await page.getByRole('button',{name:'Pay $21.00',exact:true}).click();await page.waitForFunction(()=>window.__outcomes.length===1);
  assert.deepEqual(await page.evaluate(()=>window.__outcomes),[{outcome:'pending'}]);assert.ok(!(await page.evaluate(()=>window.__toasts)).some(t=>/confirmed/i.test(t.title)));assert.equal(calls.filter(c=>c.url==='/api/parking-pass/routes/events').length,0);
 });
 await test('confirmed emits one server-confirmed outcome and event',async({page,calls,start})=>{await start();await pay(page);await page.getByRole('button',{name:'Pay $21.00',exact:true}).click();await page.waitForFunction(()=>window.__outcomes.length===1);assert.deepEqual(await page.evaluate(()=>window.__outcomes),[{outcome:'confirmed'}]);assert.equal(calls.filter(c=>c.url==='/api/parking-pass/routes/events').length,1);});
 await test('credited remains distinct from reserved',async({page,calls,setHandler,start})=>{setHandler(async url=>({body:url==='/api/payout/balance'?{balance:5}:url.endsWith('/book')?paymentSetup:{status:'credited'}}));await start();await pay(page);await page.getByRole('button',{name:'Pay $21.00',exact:true}).click();await page.waitForFunction(()=>window.__outcomes.length===1);assert.deepEqual(await page.evaluate(()=>window.__outcomes),[{outcome:'credited'}]);assert.equal(calls.filter(c=>c.url==='/api/parking-pass/routes/events').length,0);});
 await test('same-tick payment submits invoke Stripe once',async({page,start})=>{await start();await pay(page);await page.evaluate(()=>{window.__confirm=()=>new Promise(()=>{});const f=document.querySelector('form');f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});assert.equal(await page.evaluate(()=>window.__stripeCalls.length),1);});
 await test('dismissal during payment cannot cancel its intent',async({page,calls,start})=>{await start();await pay(page);await page.evaluate(()=>window.__confirm=()=>new Promise(()=>{}));await page.getByRole('button',{name:'Pay $21.00',exact:true}).click();await page.getByRole('button',{name:'Close dialog'}).click();assert.equal(await page.getByRole('dialog').count(),1);assert.equal(calls.filter(c=>c.url.includes('/cancel')).length,0);});
 await test('ordinary cancellation still releases the unpaid hold',async({page,calls,start})=>{await start();await pay(page);await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.waitForFunction(()=>window.__closes.length>0);assert.equal(calls.filter(c=>c.url.includes('/cancel')&&c.method==='POST').length,1);});
 await test('uncertain payment rechecks existing booking without charging again',async({page,calls,start})=>{await start();await pay(page);await page.evaluate(()=>window.__confirm=async()=>{throw new Error('Lost connection');});await page.getByRole('button',{name:'Pay $21.00',exact:true}).click();await page.getByRole('button',{name:'Check booking status'}).waitFor();assert.ok(await page.getByRole('button',{name:'Pay $21.00',exact:true}).isDisabled());await page.getByRole('button',{name:'Check booking status'}).click();await page.waitForFunction(()=>window.__outcomes.length===1);assert.equal(await page.evaluate(()=>window.__stripeCalls.length),1);assert.equal(calls.filter(c=>c.url.endsWith('/book')).length,1);});
 await test('closing uncertain payment does not cancel a potentially paid intent',async({page,calls,start})=>{await start();await pay(page);await page.evaluate(()=>window.__confirm=async()=>({error:{type:'api_connection_error',message:'Network interrupted'}}));await page.getByRole('button',{name:'Pay $21.00',exact:true}).click();await page.getByRole('button',{name:'Check booking status'}).waitFor();await page.getByRole('button',{name:'Close checkout',exact:true}).click();assert.equal(calls.filter(c=>c.url.includes('/cancel')).length,0);assert.deepEqual(await page.evaluate(()=>window.__outcomes),[]);});
 await test('credits loading is not fabricated as a zero balance',async({page,setHandler,start})=>{setHandler(async()=>new Promise(()=>{}));await start();await page.getByText('Checking credits…',{exact:true}).waitFor();assert.ok(await page.getByRole('button',{name:'Use max'}).isDisabled());});
 await test('credit failure has a read-only retry and retains entered promo',async({page,calls,setHandler,start})=>{let fail=true;setHandler(async()=>fail?{status:503,body:{}}:{body:{balance:7}});await start();await page.getByRole('button',{name:'Retry credits'}).waitFor();await page.locator('#parking-pass-promo').fill('KEEP');fail=false;await page.getByRole('button',{name:'Retry credits'}).click();await page.getByText('$7.00',{exact:true}).waitFor();assert.equal(await page.locator('#parking-pass-promo').inputValue(),'KEEP');assert.ok(calls.every(c=>c.method==='GET'));});
 await test('payout setup does not promise a reservation before confirmation',async({page,start})=>{await start();await pay(page);assert.ok(!(await page.getByRole('dialog').innerText()).includes('Your booking is guaranteed'));assert.ok((await page.getByRole('dialog').innerText()).includes('not reserved until'));});
 await test('terms and server prices remain visible before paying',async({page,start})=>{await start();await pay(page);await page.getByText('$18.00',{exact:true}).waitFor();await page.getByText('$3.00',{exact:true}).waitFor();await page.getByText('By confirming payment, you acknowledge bookings are non-refundable once confirmed.').waitFor();});
 await require('./qa/parking-request-browser-cases.cjs')({test,paymentSetup});
 await require('./qa/parking-payment-receipt-cases.cjs')({test,paymentSetup});
 }finally{await browser.close();}
 console.log(JSON.stringify({scope:'React/Chromium checkout component with native UI and mocked storage/API/Stripe',reactVersion,runtimeOverride:!!process.env.UI_REACT_RUNTIME,results},null,2));if(results.some(r=>r.status!=='pass'))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
