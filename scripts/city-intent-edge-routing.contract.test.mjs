/** Focused routing tests; not a deployment, booking or indexing acceptance claim. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const config = JSON.parse(readFileSync(process.env.CITY_INTENT_ROUTING_CONFIG || 'vercel.json', 'utf8'));
const origin = 'https://mealscout.onrender.com';
const families = ['food-truck-catering', 'book-food-truck'];
const cities = ['pensacola', 'milton', 'fort-walton-beach', 'lakeworth-beach', 'kingston'];

for (const family of families) {
  test(`${family}: both authored routing forms reach the same existing server route`, () => {
    const rewrite = config.rewrites.filter(rule => rule.source === `/${family}/:city`);
    const route = config.routes.filter(rule => rule.src === `/${family}/([^/]+)`);
    assert.equal(rewrite.length, 1);
    assert.equal(route.length, 1, 'Legacy edge route must not fall through to the empty SPA');
    assert.equal(rewrite[0].destination, `${origin}/${family}/:city`);
    assert.equal(route[0].dest, `${origin}/${family}/$1`);
    for (const rule of [rewrite[0], route[0]]) {
      assert.equal(rule.has, undefined, 'Public city pages must not be crawler-only');
      assert.equal(rule.missing, undefined);
      assert.equal(rule.methods, undefined);
    }
    assert.ok(config.routes.indexOf(route[0]) < config.routes.findIndex(rule => rule.handle === 'filesystem'));
    assert.ok(config.routes.indexOf(route[0]) < config.routes.findIndex(rule => rule.src === '/(.*)'));
    assert.ok(config.rewrites.indexOf(rewrite[0]) < config.rewrites.findIndex(rule => rule.destination === '/index.html'));
  });

  for (const city of cities) {
    test(`${family}/${city}: first matching terminal legacy route reaches the exact origin path`, () => {
      const pathname = `/${family}/${city}`;
      const rule = config.routes.find(entry => entry.src && !entry.continue && !entry.has && new RegExp(`^(?:${entry.src})$`).test(pathname));
      assert.ok(rule);
      assert.equal(pathname.replace(new RegExp(`^(?:${rule.src})$`), rule.dest), `${origin}${pathname}`);
    });
  }

  test(`${family}: route does not capture the root or nested private-looking paths`, () => {
    const rule = config.routes.find(entry => entry.src === `/${family}/([^/]+)`);
    assert.ok(rule);
    const pattern = new RegExp(`^(?:${rule.src})$`);
    for (const pathname of [`/${family}`, `/${family}/`, `/${family}/pensacola/private`, '/api/admin', '/dashboard']) {
      assert.equal(pattern.test(pathname), false, pathname);
    }
  });
}

test('existing asset, API, private dashboard and fallback safeguards remain', () => {
  const api = config.routes.find(rule => rule.src === '/api/(.*)');
  assert.equal(api?.dest, `${origin}/api/$1`);
  for (const name of ['admin', 'dashboard', 'vendor-dashboard', 'supplier-portal']) {
    const rule = config.routes.find(entry => entry.src === `/${name}(/.*)?`);
    assert.equal(rule?.dest, `${origin}/${name}$1`);
    assert.equal(rule.has, undefined);
  }
  for (const asset of ['assets', 'static']) {
    assert.ok(config.routes.some(rule => rule.src?.startsWith(`/${asset}/`) && rule.status === 404));
  }
  assert.deepEqual(config.routes.at(-1), { src: '/(.*)', dest: '/index.html' });
  assert.equal(config.redirects[0].destination, 'https://www.mealscout.us/$1');
});
