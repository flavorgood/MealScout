const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const filename = path.join(root, 'server/services/ownerAiActions.ts');
const source = fs.readFileSync(filename, 'utf8');
const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
const selected = ['OwnerAiActionError', 'getOwnerAiContextForCurrentOwner'].map(name => {
  const node = ast.statements.find(item => item.name?.text === name);
  assert.ok(node, 'Actual production declaration missing: ' + name);
  return node.getText(ast);
}).join('\n');
const compiled = ts.transpileModule(selected, { compilerOptions: { target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS }, reportDiagnostics:true });
assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
// Only the exact selected production declarations are executed. The DB driver
// and context assembler are isolated ports; this is not a real SQL/live proof.
function fixture() {
  const state = {
    restaurant:{ id:'restaurant-a', ownerId:'owner-a', privateText:'owner-a-private' },
    owner:{ id:'owner-a', isDisabled:false },
    contextReads:0, transactions:0, duringFirstRead:()=>{}, options:undefined,
  };
  const restaurants = { id:'restaurants.id', ownerId:'restaurants.ownerId' };
  const users = { id:'users.id', isDisabled:'users.isDisabled' };
  const db = { async transaction(run, options) {
    state.transactions++;
    assert.equal(options.isolationLevel,'repeatable read'); assert.equal(options.accessMode,'read only');
    assert.deepEqual(Object.keys(options).sort(),['accessMode','isolationLevel']);
    const snapshot = structuredClone({ restaurant:state.restaurant, owner:state.owner });
    const tx = { snapshot, select() { return { from(table) { return { where(predicate) { return { async limit(count) {
      assert.equal(count,1);
      const row = table === restaurants ? snapshot.restaurant : table === users ? snapshot.owner : assert.fail('Unexpected table');
      if (table === restaurants) state.duringFirstRead();
      return row && row[predicate.field] === predicate.value ? [row] : [];
    } }; } }; } }; } };
    return run(tx);
  }, update(){ assert.fail('Readback must not write'); }, insert(){ assert.fail('Readback must not write'); } };
  const module = { exports:{} };
  const sandbox = { exports:module.exports, module, db, restaurants, users,
    eq:(column,value)=>({ field:column.split('.').at(-1), value }),
    getOwnerAiContextSnapshot:async(id,tx,options)=>{
      state.contextReads++;
      assert.equal(id,tx.snapshot.restaurant.id);
      state.options=options;
      return { restaurant:{ ...tx.snapshot.restaurant }, expectedVersions:{ restaurant:'snapshot-version' } };
    },
  };
  vm.runInNewContext(compiled.outputText,sandbox,{ filename, timeout:1000 });
  return { state, read:module.exports.getOwnerAiContextForCurrentOwner };
}
const rejects = (work, code, status=403) => assert.rejects(work,error=>error.code===code&&error.status===status);
test('enabled exact owner reads context and offsets inside one read-only snapshot',async()=>{
  const f=fixture(), offsets={ menuOffset:5 };
  const result=await f.read('owner-a','restaurant-a',offsets);
  assert.equal(result.restaurant.ownerId,'owner-a');
  assert.equal(result.restaurant.privateText,'owner-a-private');
  assert.equal(f.state.contextReads,1); assert.equal(f.state.transactions,1); assert.equal(f.state.options,offsets);
});
test('missing restaurant retains404 without assembling context',async()=>{
  const f=fixture(); f.state.restaurant=undefined;
  await rejects(()=>f.read('owner-a','restaurant-a'),'RESTAURANT_NOT_FOUND',404);
  assert.equal(f.state.contextReads,0);
});
test('foreign owner, missing account and empty caller cannot read private context',async()=>{
  for(const [caller,change] of [['owner-a',state=>state.restaurant.ownerId='owner-b'],['owner-a',state=>state.owner=undefined],['',state=>{}]]){
    const f=fixture(); change(f.state);
    await rejects(()=>f.read(caller,'restaurant-a'),'ACTUAL_OWNER_REQUIRED');
    assert.equal(f.state.contextReads,0);
  }
});
test('disabled, null and missing enabled flags fail closed without reading private context',async()=>{
  for(const disabled of [true,null,undefined,0]){
    const f=fixture(); f.state.owner.isDisabled=disabled;
    await rejects(()=>f.read('owner-a','restaurant-a'),'ACTUAL_OWNER_REQUIRED');
    assert.equal(f.state.contextReads,0);
  }
});
test('ownership transferred after a stale external session check is denied by the actual snapshot',async()=>{
  const f=fixture(); const staleSession={ id:'owner-a' };
  f.state.restaurant.ownerId='owner-b'; f.state.restaurant.privateText='owner-b-private';
  await rejects(()=>f.read(staleSession.id,'restaurant-a'),'ACTUAL_OWNER_REQUIRED');
  assert.equal(f.state.contextReads,0);
});
test('ownership changes during reading cannot mix a new-owner payload into an authorized old-owner snapshot',async()=>{
  const f=fixture();
  f.state.duringFirstRead=()=>{ f.state.restaurant.ownerId='owner-b'; f.state.restaurant.privateText='owner-b-private'; };
  const result=await f.read('owner-a','restaurant-a');
  assert.equal(result.restaurant.ownerId,'owner-a'); assert.equal(result.restaurant.privateText,'owner-a-private');
  assert.equal(f.state.restaurant.ownerId,'owner-b');
});
test('the authenticated owner identity reaches the existing profile capability context port',async()=>{
  const file=path.join(root,'server/services/ownerAiProfileCapabilities.ts'), content=fs.readFileSync(file,'utf8');
  const parsed=ts.createSourceFile(file,content,ts.ScriptTarget.Latest,true);
  const names=['createOwnerAiProfileCapabilities','nowPlusMinute'];
  const code=names.map(name=>{ const node=parsed.statements.find(item=>item.name?.text===name); assert.ok(node); return node.getText(parsed); }).join('\n');
  const output=ts.transpileModule(code,{ compilerOptions:{ target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS } }).outputText;
  const module={ exports:{} };
  const sandbox={ module,exports:module.exports,OwnerAiCapabilityError:class extends Error { constructor(code){super(code);this.code=code;} },resolveOwnerAiNativeAdapter:()=>({profileType:'truck',adapter:'food'}),readOwnerAiCapabilities:value=>value };
  vm.runInNewContext(output,sandbox,{filename:file,timeout:1000});
  const principal={ apiKeyId:'key-a',userId:'owner-a',restaurantId:'restaurant-a' };
  const credential={id:'key-a',userId:'owner-a',restaurantId:'restaurant-a',purpose:'owner_ai_connector',scope:'owner_ai:context',isActive:true,revokedAt:null,expiresAt:null};
  const restaurant={id:'restaurant-a',ownerId:'owner-a',businessType:'food_truck',blockedProfileFields:[],completeProfileAccess:true,publicSurface:true};
  let calls=0;
  const service=sandbox.module.exports.createOwnerAiProfileCapabilities({ now:()=>new Date('2026-10-06T12:00:00Z'),readBinding:async()=>({credential,restaurant}),readContext:async(id,ownerId)=>{assert.equal(id,principal.restaurantId);assert.equal(ownerId,principal.userId);calls++;return{restaurant,expectedVersions:{restaurant:'v1'}};} });
  const result=await service.read(principal);
  assert.equal(calls,1); assert.equal(result.authority.currentOwnerId,principal.userId);
});
test('changed owning modules parse without loading a database, provider or credential module',()=>{
  const files=['server/services/ownerAiActions.ts','server/routes/ownerAiActionRoutes.ts','server/services/ownerAiMcp.ts','server/services/ownerAiProfileCapabilities.ts'];
  for(const relative of files){
    const body=fs.readFileSync(path.join(root,relative),'utf8');
    const output=ts.transpileModule(body,{ compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true });
    assert.equal(output.diagnostics?.filter(d=>d.category===ts.DiagnosticCategory.Error).length,0,relative);
  }
});
console.log(JSON.stringify({scope:'Actual extracted production declarations with isolated transaction/context ports; syntax, not semantic typechecking or SQL/live acceptance',sourceSha256:sha(source),selectedDeclarationsSha256:sha(selected),typescriptVersion:ts.version,prior13SqlGroupsRepeated:false,nativeProviderOrProductionExecuted:false}));
