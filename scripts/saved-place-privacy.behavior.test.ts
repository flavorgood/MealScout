import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';
import express from 'express';

// Execute the exact native GET handler with the actual canonical projector.
// Only storage transport/owner-row reads and auth identity are synthetic.
// No production database, credential, favorite/claim write or provider executes.
const root = path.resolve(import.meta.dirname, '..');
const source = await readFile(path.join(root, 'server/routes/restaurantCoreRoutes.ts'), 'utf8');
const ast = ts.createSourceFile('restaurantCoreRoutes.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const handlers = new Map<string, ts.Node>();
const collections = ["favorites", "following", "recommendations"];
function visit(node: ts.Node) {
 if(ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text==='get' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
  const collection=collections.find(value=>node.arguments[0].getText(ast)===JSON.stringify(`/api/${value}/restaurants`));
  if(collection)handlers.set(collection,node.arguments.at(-1)!);
 }
 ts.forEachChild(node, visit);
}
visit(ast);assert.equal(handlers.size,3);
const state: any = { rows:[], owners:[], fail:false, ownerReads:0 };
(globalThis as any).__savedPrivacyFixture=state;
const result = await build({ absWorkingDir:root, bundle:true, platform:'node', format:'esm', packages:'external', write:false, stdin:{resolveDir:root,loader:'ts',contents:`
 import {toPublicRestaurantRelationshipArrayWithVisibility} from './server/publicProfiles/toPublicRestaurantListingWithVisibility';
 import {isPublicBusinessVisible} from './server/utils/publicBusinessVisibility';
 import {deriveProfileEvidenceQuarantineVisibility} from './server/services/profileEvidenceQuarantine';
 const read=async(userId)=>{if(userId!=='synthetic-viewer')throw Error('Wrong fixture actor');return globalThis.__savedPrivacyFixture.rows;};
 const storage={getUserRestaurantFavorites:read,getUserRestaurantFollows:read,getUserRestaurantRecommendations:read};
 export const handlers={${[...handlers].map(([key,node])=>JSON.stringify(key)+':'+node.getText(ast)).join(',')}};
 `},plugins:[{name:'synthetic-owner-read',setup(builder){
 builder.onResolve({filter:/.*/},args=>path.resolve(args.resolveDir,args.path)===path.join(root,'server/db')?{path:'db',namespace:'saved-privacy'}:undefined);
 builder.onLoad({filter:/.*/,namespace:'saved-privacy'},()=>({loader:'js',contents:`export const db={select:()=>({from:()=>({where:async()=>{const state=globalThis.__savedPrivacyFixture;state.ownerReads++;if(state.fail)throw Error('Synthetic visibility outage');return state.owners;}})})};`}));
 }}]});
const filename=path.join(root,'scripts',`.saved-privacy-${process.pid}.mjs`);
await writeFile(filename,result.outputFiles[0].text);
let native: any;try{native=await import(pathToFileURL(filename).href);}finally{await unlink(filename);}
const app=express();for(const collection of collections)app.get(`/api/${collection}/restaurants`,(req:any,_res,next)=>{req.user={id:'synthetic-viewer'};next();},native.handlers[collection]);
const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${(server.address() as any).port}`;
const business={id:'synthetic-private-address',ownerId:'synthetic-owner',name:'Synthetic Neighborhood Kitchen',isActive:true,businessType:'restaurant',cuisineType:'Soup',address:'Synthetic private street 999',phone:'555-private',latitude:40,longitude:-80,rawData:{secretInternalFixture:'not-public'},stripeConnectAccountId:'acct_private_fixture'};
const favorite=(restaurant:any,id=restaurant.id)=>({id:`favorite-${id}`,restaurantId:restaurant.id,userId:'synthetic-viewer',favoritedAt:'2026-10-22T12:00:00Z',restaurant});
try {
 for(const collection of collections){
 const endpoint=base+`/api/${collection}/restaurants`;
 await test(`${collection} GET hides private street/contact/admin fields and excludes hidden or disabled businesses`,async()=>{
  state.fail=false;state.rows=[favorite(business),favorite({...business,id:'hidden',isActive:false}),favorite({...business,id:'disabled',ownerId:'disabled-owner'})];
  state.owners=[{id:'synthetic-owner',isDisabled:false,publicProfileSettings:{showAddress:false,showContact:false}},{id:'disabled-owner',isDisabled:true,publicProfileSettings:{showAddress:true,showContact:true}}];
  const response=await fetch(endpoint);const rows=await response.json();
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(rows.length,1);assert.equal(rows[0].id,'favorite-synthetic-private-address');
  assert.equal(rows[0].restaurant.address,null);assert.equal(rows[0].restaurant.phone,null);assert.equal(rows[0].restaurant.latitude,null);
  assert.ok(!('rawData' in rows[0].restaurant));assert.ok(!('stripeConnectAccountId' in rows[0].restaurant));assert.ok(!('ownerId' in rows[0].restaurant));assert.ok(state.ownerReads>0);
 });
 await test(`${collection} GET preserves supplied public address with owner consent`,async()=>{
  state.rows=[favorite(business)];state.owners=[{id:'synthetic-owner',isDisabled:false,publicProfileSettings:{showAddress:true,showContact:true}}];
  const rows=await(await fetch(endpoint)).json();assert.equal(rows[0].restaurant.address,business.address);assert.equal(rows[0].restaurant.latitude,40);
 });
 await test(`${collection} visibility-read failure returns recoverable API failure rather than raw or empty success`,async()=>{
  state.fail=true;const response=await fetch(endpoint);assert.equal(response.status,500);assert.match((await response.json()).message,/^Failed to fetch (favorites|follows|recommendations)$/);
 });
}
} finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));delete(globalThis as any).__savedPrivacyFixture;}
