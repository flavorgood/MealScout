// Executes the actual dashboard mutation/handler/effect bodies extracted with
// TypeScript's AST. Hooks, geolocation, and HTTP are deterministic local fakes.
// This proves their state transitions, not full React rendering or database IO.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const sourcePath = 'client/src/pages/restaurant-owner-dashboard.tsx';
const current = fs.readFileSync(path.join(root, sourcePath), 'utf8');
const baseline = execFileSync('git', ['show', `5158063956003d2446463b36428e41976d06c0c2:${sourcePath}`], { cwd: root, encoding: 'utf8' });
const passed = [];
function parsed(source) {
  const tree = ts.createSourceFile('dashboard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal(tree.parseDiagnostics.length, 0);
  return { tree, body: tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'RestaurantOwnerDashboard').body };
}
function statement(source, name) {
  const { tree, body } = parsed(source);
  const item = body.statements.find(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(tree) === name));
  assert.ok(item, `Source statement ${name} exists`);
  return item.getText(tree);
}
function watchStatement(source) {
  const { tree, body } = parsed(source);
  const item = body.statements.find(n => ts.isExpressionStatement(n) && n.getText(tree).includes('navigator.geolocation.watchPosition('));
  assert.ok(item, 'Source GPS watch effect exists');
  return item.getText(tree);
}
function run(context, text) {
  return vm.runInContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context);
}
function fixture(source = current) {
  const calls = [], watches = [], clears = [], toasts = [], pending = [];
  const context = vm.createContext({ console: { error() {}, warn() {} }, Response, Date, Math, Number, Error, encodeURIComponent,
    selectedRestaurant: 'synthetic-truck-a', selectedRestaurantRef: { current: 'synthetic-truck-a' }, sessionId: null,
    isBroadcasting: false, connectionStatus: 'disconnected', currentLocation: null, lastBroadcast: null,
    gpsWatchId: null, gpsWatchIdRef: { current: null }, hasProfileLocationTools: true, gpsRetryAttempt: 0,
    locationWritePromiseRef: { current: null }, stopIntentRef: { current: false }, stopRequestRef: { current: null }, startLocationInFlightRef: { current: false }, activeSessionRef: { current: null }, locationWriteInFlightRef: { current: false }, lastSentLocationRef: { current: null }, lastSentAtRef: { current: 0 },
    currentIsTruckBusiness: true, currentRestaurant: { latitude: '11', longitude: '12' }, hasWarnedFallbackAccuracyRef: { current: false },
    manualLocationAddress: '', manualLocationPin: null, isFindingManualPin: false,
    queryClient: { invalidateQueries() {} }, connectWS() {}, disconnectWS() {}, subscribeToRestaurant() {},
    toast(value) { toasts.push(value); }, setTimeout(fn) { fn(); return 1; },
    navigator: { userAgent: 'synthetic-local-test', geolocation: {
      watchPosition(ok, error, options) { watches.push({ ok, error, options }); return watches.length - 1; },
      clearWatch(id) { clears.push(id); }, getCurrentPosition(ok, error, options) { context.oneShot = { ok, error, options }; },
    } },
    async apiRequest(method, url, body) {
      calls.push({ method, url, body });
      if (context.failRequest) throw new Error('Synthetic network failure');
      if (context.request) return context.request(method, url, body);
      const receipt = method === 'PATCH' ? { success: true, restaurant: { id: 'synthetic-truck-a', latitude: String(body.latitude), longitude: String(body.longitude) } }
        : url.endsWith('/location') ? { success: true, location: { restaurantId: 'synthetic-truck-a', sessionId: body.sessionId, latitude: String(body.latitude), longitude: String(body.longitude), accuracy: String(body.accuracy), source: 'gps' }, restaurant: { id: 'synthetic-truck-a', currentLatitude: String(body.latitude), currentLongitude: String(body.longitude) } }
        : url.endsWith('/truck-session/end') ? { success: true }
        : { success: true, session: { id: 'owned-session-a', restaurantId: 'synthetic-truck-a' } };
      return new Response(JSON.stringify(context.receipt ?? receipt), { status: 200 });
    },
    useMutation(options) {
      const subject = { ...options, isPending: false, mutateAsync(variables) {
        const promise = options.mutationFn(variables).then(data => { options.onSuccess?.(data, variables); return data; }, error => { options.onError?.(error, variables); throw error; }).finally(() => options.onSettled?.());
        pending.push(promise.catch(() => undefined));
        return promise;
      }, mutate(variables) { void subject.mutateAsync(variables).catch(() => undefined); } };
      return subject;
    },
    useEffect(effect, dependencies) { context.effectDependencies = dependencies; context.cleanup = effect(); },
  });
  for (const state of ['sessionId', 'isBroadcasting', 'connectionStatus', 'lastBroadcast', 'locationError', 'currentLocation', 'gpsAccuracy', 'gpsWatchId', 'showManualLocation', 'isUpdatingLocation', 'locationUpdateError', 'isFindingManualPin', 'manualLocationPin']) {
    context['set' + state[0].toUpperCase() + state.slice(1)] = value => { context[state] = value; };
  }
  const load = name => { run(context, statement(source, name) + `\nglobalThis.${name}=${name};`); return context[name]; };
  load('getDistance');
  for (const name of ['readFreshGpsPosition', 'offerManualLocation']) if (source.includes(`const ${name} =`)) load(name);
  for (const name of ['updateLocationMutation', 'startFoodTruckSessionMutation', 'stopFoodTruckSessionMutation', 'updateRestaurantLocationMutation']) load(name);
  context.updateLocationRef = { current: context.updateLocationMutation.mutateAsync };
  return { context, calls, watches, clears, toasts, load, watch: () => run(context, watchStatement(source)), flush: () => Promise.all(pending.splice(0)) };
}
async function invoke(f, name, variables) {
  const subject = f.context[name];
  try { const receipt = await subject.mutationFn(variables); subject.onSuccess?.(receipt, variables); return receipt; }
  catch (error) { subject.onError?.(error, variables); throw error; }
  finally { subject.onSettled?.(); }
}
function position(lat = 35, lng = -90, accuracy = 8, timestamp = Date.now()) {
  return { coords: { latitude: lat, longitude: lng, accuracy, heading: 0, speed: 0 }, timestamp };
}
function liveReceipt(body) {
  return { success: true, location: { restaurantId: 'synthetic-truck-a', sessionId: body.sessionId, latitude: String(body.latitude), longitude: String(body.longitude), accuracy: String(body.accuracy), source: 'gps' }, restaurant: { id: 'synthetic-truck-a', currentLatitude: String(body.latitude), currentLongitude: String(body.longitude) } };
}
(async () => {
  {
    const f = fixture(baseline);
    const receipt = await invoke(f, 'startFoodTruckSessionMutation', { restaurantId: 'synthetic-truck-a', lat: 35, lng: -90, accuracy: 8 });
    assert.ok(receipt instanceof Response);
    assert.equal(f.context.isBroadcasting, true);
    assert.equal(f.context.sessionId, null);
    f.watch();
    assert.equal(f.watches.length, 0);
    passed.push('FAILURE BEFORE: successful unread Response announces live but stores null session and never starts watch');
  }
  {
    const f = fixture();
    await invoke(f, 'startFoodTruckSessionMutation', { restaurantId: 'synthetic-truck-a', lat: 35, lng: -90, accuracy: 8 });
    assert.equal(f.context.sessionId, 'owned-session-a');
    assert.equal(f.calls[0].body.source, 'gps');
    assert.equal(f.calls[0].body.accuracy, 8);
    f.watch();
    assert.equal(f.watches.length, 1);
    assert.equal(f.context.gpsWatchIdRef.current, 0);
    f.watches[0].ok(position()); await f.flush();
    f.watches[0].ok(position(35.002, -90)); await f.flush();
    assert.equal(f.calls.length, 3);
    for (const call of f.calls.slice(1)) {
      assert.equal(call.url, '/api/restaurants/synthetic-truck-a/location');
      assert.equal(call.body.sessionId, 'owned-session-a');
      assert.equal(call.body.source, 'gps'); assert.equal(call.body.accuracy, 8);
      assert.equal(call.body.heading, 0); assert.equal(call.body.speed, 0);
    }
    f.watches[0].ok(position(35.002001, -90)); await f.flush();
    assert.equal(f.calls.length, 3, 'Small movement within throttle sends no duplicate');
    assert.equal(f.watches.length, 1, 'Receipt and reading changes do not own effect dependencies');
    assert.deepEqual(Array.from(f.context.effectDependencies), [true, 'owned-session-a', 'synthetic-truck-a', true, 0]);
    f.context.cleanup(); f.watches[0].ok(position(35.004, -90)); await f.flush();
    assert.equal(f.calls.length, 3); assert.deepEqual(f.clears, [0]);
    passed.push('FIX AFTER: owned session starts one stable watch; movement sends owned ID/source/accuracy; throttle and cleanup ignore old callbacks');
  }
  for (const receipt of [{ success: true, session: {} }, { success: true, session: { id: 'foreign', restaurantId: 'other-truck' } }, { success: false, session: { id: 'bad', restaurantId: 'synthetic-truck-a' } }]) {
    const f = fixture(); f.context.receipt = receipt;
    await assert.rejects(() => invoke(f, 'startFoodTruckSessionMutation', { restaurantId: 'synthetic-truck-a', lat: 35, lng: -90, accuracy: 8 }), /did not confirm/);
    f.watch(); assert.equal(f.watches.length, 0); assert.equal(f.context.isBroadcasting, false);
  }
  passed.push('Missing, unsuccessful and foreign session receipts cannot announce live or start watch');
  {
    const f = fixture(); f.context.failRequest = true;
    await assert.rejects(() => invoke(f, 'startFoodTruckSessionMutation', { restaurantId: 'synthetic-truck-a', lat: 35, lng: -90, accuracy: 8 }), /network/);
    assert.equal(f.context.connectionStatus, 'disconnected'); assert.equal(f.context.isBroadcasting, false);
    f.context.failRequest = false; await invoke(f, 'startFoodTruckSessionMutation', { restaurantId: 'synthetic-truck-a', lat: 35, lng: -90, accuracy: 8 });
    f.watch(); f.context.failRequest = true;
    await assert.rejects(() => invoke(f, 'stopFoodTruckSessionMutation'), /network/);
    assert.equal(f.context.isBroadcasting, true); assert.deepEqual(f.clears, []);
    f.context.failRequest = false; await invoke(f, 'stopFoodTruckSessionMutation');
    assert.equal(f.context.isBroadcasting, false); assert.equal(f.context.sessionId, null); assert.deepEqual(f.clears, [0]);
    passed.push('Failed start/stop preserve truthful state; retry succeeds and clears watch ID zero');
  }
  for (const code of [1, 2, 3]) {
    const f = fixture(); await invoke(f, 'startFoodTruckSessionMutation', { restaurantId: 'synthetic-truck-a', lat: 35, lng: -90, accuracy: 8 }); f.watch();
    f.watches[0].error({ code, message: 'Synthetic denied/unavailable/timeout' }); await f.flush();
    assert.equal(f.calls.length, 1); assert.equal(f.context.showManualLocation, true); assert.equal(f.context.connectionStatus, 'disconnected');
  }
  passed.push('Denied, unavailable and timeout watch errors offer manual confirmation without IP/base/location writes');
  for (const reading of [{ ...position(), coords: { ...position().coords, accuracy: undefined } }, position(35, -90, NaN), position(35, -90, 8, Date.now() - 6000), position(100, -90, 8)]) {
    const f = fixture(); await invoke(f, 'startFoodTruckSessionMutation', { restaurantId: 'synthetic-truck-a', lat: 35, lng: -90, accuracy: 8 }); f.watch();
    f.watches[0].ok(reading); await f.flush();
    assert.equal(f.calls.length, 1); assert.equal(f.context.showManualLocation, true);
  }
  passed.push('Unknown accuracy, stale GPS and invalid bounds cannot be promoted to fresh live movement');
  {
    const f = fixture(); f.context.hasProfileLocationTools = false;
    f.load('handleStartBroadcasting')(); assert.equal(f.context.oneShot, undefined); assert.equal(f.calls.length, 0);
    f.context.hasProfileLocationTools = true; f.context.handleStartBroadcasting();
    assert.equal(f.context.oneShot.options.maximumAge, 0);
    f.context.oneShot.error({ message: 'Synthetic permission denied' });
    assert.equal(f.context.showManualLocation, true); assert.equal(f.calls.length, 0);
    passed.push('Permission gate blocks GPS action; denied one-shot offers manual entry without writes');
  }
  {
    const f = fixture(); f.load('handleStartBroadcasting')();
    const oneShot = f.context.oneShot;
    f.context.handleStartBroadcasting();
    assert.equal(f.context.oneShot, oneShot, 'Duplicate click cannot start another GPS request');
    f.context.selectedRestaurant = 'synthetic-truck-b'; f.context.selectedRestaurantRef.current = 'synthetic-truck-b';
    oneShot.ok(position()); await f.flush(); assert.equal(f.calls.length, 0);
    f.context.sessionId = 'session-a'; f.context.isBroadcasting = true;
    f.context.activeSessionRef.current = { restaurantId: 'synthetic-truck-a', id: 'session-a' };
    f.watch(); assert.equal(f.watches.length, 0, 'A session cannot start B watch before selection-reset effect');
    passed.push('Duplicate start and late GPS callback across business switch cannot send A position to B or start a foreign watch');
  }
  {
    const f = fixture(); f.context.manualLocationAddress = 'Synthetic preserved address';
    f.context.failRequest = true; f.load('handleFindManualLocation');
    await f.context.handleFindManualLocation(); assert.equal(f.context.manualLocationAddress, 'Synthetic preserved address');
    assert.equal(f.context.manualLocationPin, null); assert.equal(f.context.isFindingManualPin, false);
    f.context.failRequest = false; f.context.receipt = [{ lat: '35', lon: '-90' }];
    await f.context.handleFindManualLocation(); assert.equal(f.context.manualLocationPin.lat, 35);
    assert.equal(f.context.manualLocationPin.lng, -90);
    assert.ok(f.calls.every(call => call.method === 'GET' && call.url.startsWith('/api/location/search?q=')));
    assert.equal(f.context.isBroadcasting, false);
    passed.push('Existing address geocoder can fail and retry without losing input or saving before confirmation');
  }
  {
    const f = fixture(); f.context.manualLocationAddress = 'Synthetic test address'; f.context.manualLocationPin = { lat: 35, lng: -90 };
    f.context.failRequest = true; f.load('handleConfirmManualLocation')(); await f.flush();
    assert.equal(f.context.manualLocationAddress, 'Synthetic test address'); assert.equal(f.context.manualLocationPin.lat, 35);
    assert.match(f.context.locationUpdateError, /network/); assert.equal(f.context.isBroadcasting, false);
    f.context.failRequest = false; f.context.handleConfirmManualLocation(); await f.flush();
    assert.equal(f.calls[1].method, 'PATCH'); assert.equal(f.calls[1].body.source, 'manual');
    assert.equal(f.calls[1].body.address, 'Synthetic test address'); assert.equal(f.calls[1].body.mobileOnline, undefined);
    assert.equal(f.context.isBroadcasting, false); assert.equal(f.context.showManualLocation, false);
    passed.push('Explicit manual confirmation uses saved PATCH only; failed save retains address/pin and retry truthfully succeeds without going live');
  }
  {
    const f = fixture(baseline); f.context.receipt = {};
    await invoke(f, 'updateRestaurantLocationMutation', { restaurantId: 'synthetic-truck-a', latitude: 35, longitude: -90, source: 'manual' });
    assert.equal(f.toasts.at(-1).title, 'Saved location updated');
    f.context.isBroadcasting = true; f.context.sessionId = 'owned-session-a'; f.context.receipt = { success: false };
    await invoke(f, 'stopFoodTruckSessionMutation');
    assert.equal(f.context.isBroadcasting, false);
    passed.push('DLOC-01 FAILURE BEFORE: baseline PATCH accepts empty200 and end accepts successfalse200 while claiming saved/offline');
  }
  for (const receipt of [{}, { success: false }, { success: true, restaurant: { id: 'other-truck', latitude: '35', longitude: '-90' } }, { success: true, restaurant: { id: 'synthetic-truck-a', latitude: '36', longitude: '-90' } }, { success: true, restaurant: { id: 'synthetic-truck-a', latitude: null, longitude: '-90' } }]) {
    const f = fixture(); f.context.receipt = receipt; f.context.showManualLocation = true;
    f.context.manualLocationAddress = 'Synthetic retained address'; f.context.manualLocationPin = { lat: 35, lng: -90 };
    f.load('handleConfirmManualLocation')(); await f.flush();
    assert.equal(f.context.showManualLocation, true); assert.equal(f.context.manualLocationAddress, 'Synthetic retained address');
    assert.equal(f.context.manualLocationPin.lat, 35); assert.match(f.context.locationUpdateError, /did not confirm/);
    assert.ok(!f.toasts.some(toast => toast.title === 'Saved location updated'));
  }
  passed.push('DLOC-01 FIX AFTER: malformed, unsuccessful, foreign or mismatched saved-pin200 retains draft and gives no success toast');
  for (const receipt of [{}, { success: false }]) {
    const f = fixture(); await invoke(f, 'startFoodTruckSessionMutation', { restaurantId: 'synthetic-truck-a', lat: 35, lng: -90, accuracy: 8 }); f.watch();
    f.context.receipt = receipt;
    await assert.rejects(() => invoke(f, 'stopFoodTruckSessionMutation'), /did not confirm/);
    assert.equal(f.context.isBroadcasting, true); assert.equal(f.context.sessionId, 'owned-session-a');
    assert.equal(f.context.stopIntentRef.current, false); assert.deepEqual(f.clears, []);
  }
  passed.push('DLOC-01 FIX AFTER: empty or unsuccessful end200 keeps live session/watch and releases stop intent for retry');
  {
    const f = fixture(baseline); f.context.receipt = {};
    await invoke(f, 'updateLocationMutation', { restaurantId: 'synthetic-truck-a', sessionId: 'owned-session-a', lat: 35, lng: -90, accuracy: 8 });
    assert.ok(f.context.lastBroadcast instanceof Date);
    passed.push('DLOC-01 movement FAILURE BEFORE: empty200 advances last successful broadcast without a persisted position receipt');
  }
  for (const change of [() => ({}), r => ({ ...r, success: false }), r => ({ ...r, location: { ...r.location, restaurantId: 'other-truck' } }), r => ({ ...r, location: { ...r.location, sessionId: 'foreign-session' } }), r => ({ ...r, location: { ...r.location, source: 'manual' } }), r => ({ ...r, location: { ...r.location, accuracy: null } }), r => ({ ...r, location: { ...r.location, latitude: '36' } }), r => ({ ...r, restaurant: { ...r.restaurant, currentLatitude: '36' } })]) {
    const f = fixture(); await invoke(f, 'startFoodTruckSessionMutation', { restaurantId: 'synthetic-truck-a', lat: 35, lng: -90, accuracy: 8 }); f.watch();
    f.watches[0].ok(position()); await f.flush();
    const last = f.context.lastBroadcast;
    f.context.receipt = change(liveReceipt({ sessionId: 'owned-session-a', latitude: 35.002, longitude: -90, accuracy: 8 }));
    f.watches[0].ok(position(35.002, -90)); await f.flush();
    assert.equal(f.context.lastBroadcast, last); assert.equal(f.context.lastSentLocationRef.current.lat, 35);
    assert.equal(f.context.connectionStatus, 'disconnected'); assert.match(f.context.locationError, /did not confirm/);
  }
  passed.push('DLOC-01 movement FIX AFTER: malformed/foreign/session/source/accuracy/coordinate receipts preserve last successful broadcast and show disconnected error');
  {
    const f = fixture();
    await invoke(f, 'updateRestaurantLocationMutation', { restaurantId: 'synthetic-truck-a', latitude: 35.123456789, longitude: -90.123456789, source: 'manual' });
    f.context.receipt = { success: true, restaurant: { id: 'synthetic-truck-a', latitude: '35.12345679', longitude: '-90.12345679' } };
    await invoke(f, 'updateRestaurantLocationMutation', { restaurantId: 'synthetic-truck-a', latitude: 35.123456789, longitude: -90.123456789, source: 'manual' });
    assert.equal(f.toasts.at(-1).title, 'Saved location updated');
    passed.push('DLOC-01 valid owned saved-pin receipt accepts only persisted coordinates within existing decimal-scale rounding');
  }
  {
    const f = fixture(baseline); const events = []; let releaseEnd;
    f.context.isBroadcasting = true; f.context.sessionId = 'owned-session-a'; f.watch();
    f.context.request = async (_method, url) => {
      if (url.endsWith('/truck-session/end')) { events.push('end sent'); return new Promise(done => { releaseEnd = () => done(new Response('{"success":true}')); }); }
      events.push('movement sent during pending end'); return new Response('{"success":true}');
    };
    const stop = invoke(f, 'stopFoodTruckSessionMutation');
    f.watches[0].ok(position()); await f.flush();
    assert.deepEqual(events, ['end sent', 'movement sent during pending end']);
    releaseEnd(); await stop;
    passed.push('DLOC-02 FAILURE BEFORE: baseline GPS sends movement while the end request is already pending');
  }
  {
    const f = fixture(); const events = []; let releaseMove, releaseEnd;
    await invoke(f, 'startFoodTruckSessionMutation', { restaurantId: 'synthetic-truck-a', lat: 35, lng: -90, accuracy: 8 }); f.watch();
    f.context.request = async (_method, url, body) => {
      if (url.endsWith('/location')) { events.push('movement sent'); return new Promise(done => { releaseMove = () => { events.push('movement settled'); done(new Response(JSON.stringify(liveReceipt(body)))); }; }); }
      assert.ok(url.endsWith('/truck-session/end')); events.push('end sent');
      return new Promise(done => { releaseEnd = () => done(new Response('{"success":false}')); });
    };
    f.watches[0].ok(position());
    assert.equal(f.calls.length, 2);
    const stop = invoke(f, 'stopFoodTruckSessionMutation');
    assert.equal(f.context.stopIntentRef.current, true);
    f.watches[0].ok(position(35.004, -90)); assert.equal(f.calls.length, 2, 'Stop intent blocks a new movement immediately');
    assert.deepEqual(events, ['movement sent'], 'End waits for prior movement');
    releaseMove(); await f.flush(); await new Promise(setImmediate);
    assert.deepEqual(events, ['movement sent', 'movement settled', 'end sent']);
    f.watches[0].ok(position(35.006, -90)); assert.equal(f.calls.length, 3, 'Pending end still blocks GPS writes');
    releaseEnd(); await assert.rejects(() => stop, /did not confirm/);
    assert.equal(f.context.isBroadcasting, true); assert.equal(f.context.stopIntentRef.current, false); assert.deepEqual(f.clears, []);
    f.context.request = undefined;
    f.watches[0].ok(position(35.008, -90)); await f.flush(); assert.equal(f.calls.length, 4, 'Failed end resumes owned movement');
    await invoke(f, 'stopFoodTruckSessionMutation');
    assert.equal(f.context.isBroadcasting, false); assert.deepEqual(f.clears, [0]);
    f.watches[0].ok(position(35.010, -90)); await f.flush(); assert.equal(f.calls.length, 5, 'Queued callback cannot write after valid end');
    passed.push('DLOC-02 FIX AFTER: stop intent blocks new GPS, drains held movement before end, blocks pending end, resumes failed end, and suppresses callbacks after successful retry');
  }
  assert.ok(current.includes('const hasProfileLocationTools = canManageProfile;'));
  assert.ok(!current.includes('ipapi.co')); assert.ok(!current.includes('tryFallbackLocation'));
  console.log(JSON.stringify({ source: sourcePath, baseline: '5158063956003d2446463b36428e41976d06c0c2', environment: 'local source-extracted native handlers/effect; synthetic hooks/geolocation/HTTP, no browser or DB', passed: passed.length, cases: passed }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
