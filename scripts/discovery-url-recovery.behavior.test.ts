import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { readFileSync } from "node:fs";
import express from "express";
import { registerPublicProfilePrerenderRoutes } from "../server/seo/publicProfilePrerender";

const ID = "a0000000-0000-4000-8000-000000000001";
const DISABLED = "a0000000-0000-4000-8000-000000000002";
const UNKNOWN = "a0000000-0000-4000-8000-000000000003";
const QUARANTINED = "a0000000-0000-4000-8000-000000000004";
const canonical = `/truck/current-name--${ID}`;
const fixturePage = (canonicalPath: string, robots = "index,follow") => ({title:"Fixture", description:"Fixture",canonicalPath,robots,schema:{},links:[],body:[]});

test("real Express recovery preserves attribution, prevents loops, and keeps failures honest", async () => {
  let visible = true;
  const app = express();
  registerPublicProfilePrerenderRoutes(app,"https://www.mealscout.us",async input => {
    if (input.cuisineSlug === "dependency-failure") throw new Error("isolated dependency failure");
    return {kind:"not_found",reason:input.citySlug?"city":"cuisine"};
  },{
    restaurantPage: async (_base,id,type) => {
      if (id === "error") throw new Error("isolated profile failure");
      if (id === ID) return visible && (!type || type === "truck") ? fixturePage(canonical) : null;
      if (id === DISABLED) return null;
      if (id === UNKNOWN) return type ? null : fixturePage(`/restaurant/${UNKNOWN}/unsupported-type`);
      if (id === QUARANTINED) return type ? null : fixturePage(`/truck/quarantined--${QUARANTINED}`,"noindex,follow");
      return null;
    },
  });
  app.use((_req,res)=>res.status(418).send("protected application continuation"));
  const server=app.listen(0,"127.0.0.1"); await once(server,"listening");
  const addr=server.address(); assert(addr&&typeof addr!=="string");
  const base=`http://127.0.0.1:${addr.port}`;
  const get=(path:string)=>fetch(base+path,{redirect:"manual",signal:AbortSignal.timeout(5000)});
  try {
    for (const url of [`/restaurant/${ID}`,`/restaurant/old-name--${ID}`,`/p/restaurant/${ID}/old-name`,`/p/truck/${ID}`]) {
      const res=await get(url+"?ref=affiliate-proof&utm_source=google&token=private-secret&redirect=https://invalid.example");
      assert.equal(res.status,308,url);
      const dest=new URL(res.headers.get("location")!,base);
      assert.equal(dest.pathname,canonical,url); assert.equal(dest.origin,base,url);
      assert.equal(dest.searchParams.get("ref"),"affiliate-proof",url);
      assert.equal(dest.searchParams.get("utm_source"),"google",url);
      assert.equal(dest.searchParams.has("token"),false,url);
      assert.equal(dest.searchParams.has("redirect"),false,url);
      assert.match(res.headers.get("cache-control")||"",/no-store/,url);
      assert.equal((await get(dest.pathname+dest.search)).status,200,url);
    }
    assert.equal((await get(canonical)).status,200);
    for (const id of [DISABLED, UNKNOWN, QUARANTINED]) {
      const res=await get(`/restaurant/old--${id}`);
      assert.equal(res.status,404,id); assert.equal(res.headers.get("location"),null,id);
    }
    visible=false;
    assert.equal((await get(`/p/truck/${ID}`)).status,404,"revoked public visibility cannot remain a cached redirect");
    assert.equal((await get(`/restaurant/${UNKNOWN}/unsupported-type`)).status,404,"same-path recovery must terminate");
    for (const path of ["/cuisine/not-currently-published","/cuisine/tacos/unknown-city"]) {
      const res=await get(path); assert.equal(res.status,404,path); assert.match(res.headers.get("cache-control")||"",/no-store/);
    }
    for (const path of ["/cuisine/dependency-failure","/truck/error"]) {
      const res=await get(path); assert.equal(res.status,503,path); assert.equal(res.headers.get("retry-after"),"60");
    }
    for (const path of ["/restaurant/dashboard",`/restaurant/${ID}/reviews`,"/supplier/dashboard"]) assert.equal((await get(path)).status,418,path);
  } finally {server.closeAllConnections(); await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));}
});

test("unsupported stored classifications are rejected before untyped fallback projection",()=>{
  const source=readFileSync("server/seo/publicProfilePrerender.ts","utf8");
  const start=source.indexOf("async function restaurantPage(");
  const end=source.indexOf("async function hostPage(",start);
  const handler=source.slice(start,end);
  assert.match(handler,/if\s*\(\s*!strictRouteProfileType\s*\)\s*(?:\{\s*)?return null/);
});
