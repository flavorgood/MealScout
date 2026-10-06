// Source-only SDK/API URL regressions. No App mount, real SSO, server or network.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {test,after}=require('node:test');
const root=process.env.MEALSCOUT_TEST_SOURCE_ROOT||path.resolve(__dirname,'..');
const dependencies=process.env.MEALSCOUT_TEST_DEPENDENCY_ROOT||root;
const ts=createRequire(path.join(dependencies,'package.json'))('typescript');
function compile(relative){
 const source=fs.readFileSync(path.join(root,relative),'utf8');
 const output=ts.transpileModule(source.replaceAll('import.meta.env','__mealEnv'),{
  fileName:relative,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.React,esModuleInterop:true},reportDiagnostics:true,
 });
 assert.deepEqual((output.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error),[]);
 return output.outputText;
}
const apiCode=compile('client/src/lib/api.ts');
const sdkCode=compile('client/src/MealScoutApp.tsx');
let calls=0;
function fixture(hostname,baseUrl=''){
 const requests=[];
 const globals={URL,AbortController,setTimeout,clearTimeout,__mealEnv:{DEV:false,VITE_API_BASE_URL:baseUrl},window:{location:{hostname,origin:'https://'+hostname}},fetch:async(url,options)=>{calls++;requests.push({url,options});return{ok:true,json:async()=>({user:{id:'synthetic-meal-user',userType:'customer'}})};}};
 function evaluate(code,imports){
  const exports={};
  const context=vm.createContext({...globals,exports,require:name=>{assert.ok(Object.hasOwn(imports,name),'Unexpected module import '+name);return imports[name];}});
  vm.runInContext(code,context,{timeout:1000});
  return exports;
 }
 const api=evaluate(apiCode,{});
 const sdk=evaluate(sdkCode,{'react':{createContext:()=>({}),useContext:()=>null},'./App':{default:()=>null},'@/lib/api':api});
 return{api,sdk,requests};
}
test('TradeScout embedded app and default SDK SSO use the same existing Meal API',async()=>{
 const {api,sdk,requests}=fixture('www.thetradescout.com');
 assert.equal(api.apiUrl('/api/orders'),'https://www.mealscout.us/api/orders');
 assert.equal((await sdk.performMealScoutSSO('synthetic-token')).id,'synthetic-meal-user');
 assert.equal(requests[0].url,api.apiUrl('/api/auth/tradescout/sso'));
 assert.equal(requests[0].options.method,'POST');
 assert.equal(requests[0].options.credentials,'include');
 assert.deepEqual(JSON.parse(requests[0].options.body),{token:'synthetic-token'});
});
test('an explicit existing API base is also used by default SDK SSO',async()=>{
 const {api,sdk,requests}=fixture('www.thetradescout.com','https://mealscout.onrender.com');
 await sdk.performMealScoutSSO('synthetic-token');
 assert.equal(requests[0].url,api.apiUrl('/api/auth/tradescout/sso'));
 assert.equal(requests[0].url,'https://mealscout.onrender.com/api/auth/tradescout/sso');
});
test('MealScout first-party API and SSO stay same-origin',async()=>{
 for(const hostname of ['mealscout.us','www.mealscout.us','app.mealscout.us']){
  const {api,sdk,requests}=fixture(hostname,'https://mealscout.onrender.com');
  assert.equal(api.apiUrl('/api/orders'),'/api/orders');
  await sdk.performMealScoutSSO('synthetic-token');
  assert.equal(requests[0].url,'/api/auth/tradescout/sso');
  assert.equal(api.authUrl('/api/auth/google'),'https://'+hostname+'/api/auth/google');
 }
});
test('isolated deployment API and default SDK SSO stay on that origin',async()=>{
 for(const hostname of ['mealscout-preview.onrender.com','mealscout-preview.vercel.app']){
  const {api,sdk,requests}=fixture(hostname);
  assert.equal(api.apiUrl('/api/orders'),'/api/orders');
  await sdk.performMealScoutSSO('synthetic-token');
  assert.equal(requests[0].url,'/api/auth/tradescout/sso');
 }
});
test('lookalike names receive no TradeScout API fallback or OAuth app context',()=>{
 for(const hostname of ['evil-tradescout.example','www.thetradescout.com.attacker.example','thetradescout.com-attacker.example','nottradescout.io']){
  const {api}=fixture(hostname);
  assert.equal(api.apiUrl('/api/orders'),'/api/orders',hostname);
  assert.equal(api.authUrl('/api/auth/google'),'/api/auth/google',hostname);
 }
});
test('the actual TradeScout domain and its subdomains keep their existing API/auth context',()=>{
 for(const hostname of ['thetradescout.com','www.thetradescout.com','profiles.thetradescout.com']){
  const {api}=fixture(hostname);
  assert.equal(api.apiUrl('/api/orders'),'https://www.mealscout.us/api/orders');
  const auth=new URL(api.authUrl('/api/auth/google'));
  assert.equal(auth.origin,'https://www.mealscout.us');
  assert.equal(auth.searchParams.get('app'),'tradescout');
 }
});
test('explicit SDK origin and explicit same-origin overrides preserve the existing contract',async()=>{
 const {sdk,requests}=fixture('www.thetradescout.com');
 await sdk.performMealScoutSSO('synthetic-token',{baseUrl:'https://mealscout.onrender.com/'});
 await sdk.performMealScoutSSO('synthetic-token',{baseUrl:''});
 assert.equal(requests[0].url,'https://mealscout.onrender.com/api/auth/tradescout/sso');
 assert.equal(requests[1].url,'/api/auth/tradescout/sso');
});
after(()=>console.log(JSON.stringify({scope:'Actual API module and SDK helper runtime with synthetic window/env/React/App/fetch ports; two isolated syntax transpiles only',syntheticFetchCalls:calls,realNetworkCalls:0,fullAppMounted:false,semanticProgramCreated:false,serverOrProviderCodeExecuted:false,memory:process.memoryUsage()})));
