import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
process.env.NODE_ENV='development';
const {registerPublicProfilePrerenderRoutes}=await import('../server/seo/publicProfilePrerender');
const ID='a0000000-0000-4000-8000-000000000006';
const OTHER='a0000000-0000-4000-8000-000000000007';
for(const type of ['location','supplier'] as const){
  test(`${type}: native app continuation requires current same-entity public admission`,async()=>{
    const canonical=`/${type}/harbor-kitchen--${ID}`;
    const state={visible:true,fail:false,id:ID,kind:type as string,path:canonical,continuations:0};
    const page=async()=>{
      if(state.fail)throw Error('synthetic unavailable');if(!state.visible)return null;
      return {title:'Harbor Kitchen | MealScout',description:'Public coastal food profile',canonicalPath:state.path,robots:'index,follow',schema:{'@type':'LocalBusiness',name:'Harbor Kitchen'},body:['Coastal food'],links:[{label:'Open profile',href:canonical+'?view=app'}],appProfile:{id:state.id,profileType:state.kind}};
    };
    const app=express();
    registerPublicProfilePrerenderRoutes(app,'https://www.mealscout.us',async()=>({kind:'not_found',reason:'city'}) as any,{restaurantPage:async()=>null,hostPage:page as any,supplierPage:page as any});
    app.use((_req,res)=>{state.continuations++;res.type('html').send('NATIVE_APP');});
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
    const base=`http://127.0.0.1:${(server.address() as any).port}`;
    const get=(p:string)=>fetch(base+p,{redirect:'manual'});
    try{
      let response=await get(canonical);assert.equal(response.status,200);assert.match(await response.text(),/href="[^" ]+\?view=app"/);assert.equal(state.continuations,0);
      response=await get(canonical+'?view=app');assert.equal(await response.text(),'NATIVE_APP');assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('link'),`<https://www.mealscout.us${canonical}>; rel="canonical"`);assert.equal(state.continuations,1);
      for(const mutation of [()=>{state.id=OTHER;},()=>{state.kind=type==='supplier'?'location':'supplier';},()=>{state.path='//evil.invalid/profile';},()=>{state.path=`/${type}/other--${OTHER}`;}]){
        state.id=ID;state.kind=type;state.path=canonical;mutation();response=await get(canonical+'?view=app');assert.notEqual(await response.text(),'NATIVE_APP');assert.equal(state.continuations,1);
      }
      state.id=ID;state.kind=type;state.path=canonical;
      for(const query of ['?view=APP','?view=app&view=app','?view[mode]=app']){response=await get(canonical+query);assert.notEqual(await response.text(),'NATIVE_APP');assert.equal(state.continuations,1);}
      response=await get(canonical+'?view=app&token=secret&redirect=https://evil.invalid');assert.equal(response.status,308);assert.equal(response.headers.get('location'),canonical+'?view=app');
      if(type==='supplier'){
        response=await get(`/suppliers/${ID}?view=app`);assert.equal(await response.text(),'NATIVE_APP');assert.equal(state.continuations,2);
        response=await get(`/suppliers/${OTHER}?view=app`);assert.notEqual(await response.text(),'NATIVE_APP');assert.equal(state.continuations,2);
      }
      state.visible=false;response=await get(canonical+'?view=app');assert.equal(response.status,404);assert.equal(response.headers.get('cache-control'),'no-store');assert.doesNotMatch(await response.text(),/Harbor Kitchen|NATIVE_APP/);
      if(type==='supplier')assert.equal((await get(`/suppliers/${ID}?view=app`)).status,404);
      state.visible=true;state.fail=true;response=await get(canonical+'?view=app');assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'60');assert.doesNotMatch(await response.text(),/Harbor Kitchen|NATIVE_APP/);
    }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  });
}
