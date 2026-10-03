import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import express from 'express';
import { chromium } from '@playwright/test';
import { resolvePublicSeoLanding, toPublicSeoSlug } from '../server/services/publicSeoLandingModel';

// Fixture-only isolation: production rendering/owner gates/adapters are bundled unchanged.
// No production database module is evaluated; only hosts/users/cities reads are allowed.
const root = process.cwd();
const temporary = path.join(root, '.tmp-tests/seo-location-isolated');
const evidence = path.resolve(root, '../evidence/location-isolation');
const fixtureKey = '__mealScoutLocationIsolationFixture';
const privateSentinels = ['PRIVATE_STREET_947', '+18505550947', 'PRIVATE_EMAIL_947', 'private-contact-947.example', 'PRIVATE_DESCRIPTION_947'];
const city = { id: 'city-fixture', name: 'Pensacola', state: 'FL', slug: 'pensacola-fl' };
const normalName = 'Harbor Gathering Hall';
const host = {
  id: 'host-fixture', userId: 'owner-fixture', businessName: normalName,
  city: city.name, state: city.state, address: privateSentinels[0],
  contactPhone: privateSentinels[1], contactEmail: privateSentinels[2],
  websiteUrl: `https://${privateSentinels[3]}`, instagramUrl: `https://${privateSentinels[3]}/instagram`,
  facebookPageUrl: `https://${privateSentinels[3]}/facebook`, xUrl: `https://${privateSentinels[3]}/x`,
  description: privateSentinels[4], latitude: '30.421947', longitude: '-87.216947',
  locationType: 'business', updatedAt: new Date('2026-01-02T00:00:00Z'),
};
const fixture: any = { host: { ...host }, owner: { email: privateSentinels[2], isDisabled: false, publicProfileSettings: { showAddress: false, showContact: false } }, city, fail: false, reads: [] };
const assertPrivate = (html: string) => {
  for (const sentinel of privateSentinels) assert.ok(!html.includes(sentinel), `private sentinel exposed: ${sentinel}`);
  assert.ok(!/href=["'](?:tel:|mailto:)/i.test(html));
  assert.ok(!html.includes('30.421947') && !html.includes('-87.216947'));
};
const parseJsonLd = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));

after(() => { delete (globalThis as any)[fixtureKey]; });
test('real location SSR owner/privacy/JSON-LD and loopback Chromium journey', { timeout: 120_000 }, async () => {
  await mkdir(temporary, { recursive: true });
  await mkdir(evidence, { recursive: true });
  (globalThis as any)[fixtureKey] = fixture;
  const bundle = path.join(temporary, 'prerender.cjs');
  await build({
    absWorkingDir: root, entryPoints: ['./server/seo/publicProfilePrerender.ts'], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', tsconfig: path.join(root, 'tsconfig.json'),
    plugins: [{ name: 'explicit-fixture-db-only', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        const candidate = path.resolve(args.resolveDir || root, args.path).replace(/\\/g, '/');
        if (candidate === path.join(root, 'server/db').replace(/\\/g, '/')) return { path: 'fixture-db', namespace: 'fixture-db' };
        // Custom source namespace avoids restricted Windows ancestor traversal.
        if (!args.path.startsWith('.') && !args.path.startsWith('@shared/')) return { path: args.path, external: true };
        const source = args.path.startsWith('@shared/') ? path.join(root, 'shared', args.path.slice(8)) : candidate;
        const resolved = [source, source+'.ts', source+'.tsx', source+'.js', path.join(source, 'index.ts')].find(value => existsSync(value) && statSync(value).isFile());
        if (!resolved) throw new Error('Unresolved isolated source '+args.path);
        return { path: resolved, namespace: 'isolated-source' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'isolated-source' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'ts', resolveDir: path.dirname(args.path) }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture-db' }, () => ({ loader: 'js', contents: `
        import { getTableName } from 'drizzle-orm';
        export const db = { select() { let table; const q = {
          from(value) { table = getTableName(value); return q; },
          where() { return q; }, orderBy() { return q; }, limit() { return q; },
          then(resolve, reject) { const f = globalThis.${fixtureKey}; f.reads.push(table);
            if(f.fail) return Promise.reject(new Error('injected fixture DB unavailable')).then(resolve,reject);
            if(!['hosts','users','cities'].includes(table)) return Promise.reject(new Error('unexpected fixture table '+table)).then(resolve,reject);
            const value = table === 'hosts' ? f.host : table === 'users' ? f.owner : f.city;
            return Promise.resolve(value ? [value] : []).then(resolve,reject);
          }
        }; return q; } };
      ` }));
    } }],
  });
  const { registerPublicProfilePrerenderRoutes } = await import(pathToFileURL(bundle).href);
  const app = express();
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const locationPath = `/location/${toPublicSeoSlug(normalName)}--${host.id}`;
  const item = { id: host.id, profileType: 'location' as const, displayName: normalName, slug: toPublicSeoSlug(normalName), profilePath: locationPath, city: city.name, state: city.state, imageUrl: null, cuisineTags: [], statusLabel: null, summary: 'Food truck gathering location', primaryCtaPath: locationPath };
  const repository: any = {
    resolveCityBySlug: async (slug: string) => slug === city.slug ? city : null,
    loadCityFood: async () => [item],
    loadFoodTrucks: async () => [], loadFoodTrucksToday: async () => [], loadDealsToday: async () => [], loadEventsToday: async () => [], loadCuisine: async () => [], loadLocationsWithTrucks: async () => [item],
  };
  registerPublicProfilePrerenderRoutes(app, base, (request: any) => resolvePublicSeoLanding(request, repository));
  app.use((_req, res) => res.status(404).send('Fixture resource not found'));
  const receipts: any[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const request = async (label: string, expected: number) => {
      const response = await fetch(`${base}${locationPath}`);
      const html = await response.text();
      assert.equal(response.status, expected, label);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assertPrivate(html);
      receipts.push({ label, status: response.status, headers: Object.fromEntries(response.headers), bytes: html.length });
      return { response, html };
    };
    const enabled = await request('enabled owner with private address/contact', 200);
    const entities = parseJsonLd(enabled.html);
    const page = entities.find(entity => entity['@type'] === 'WebPage');
    const business = entities.find(entity => entity['@type'] === 'LocalBusiness');
    const canonical = `${base}${locationPath}`;
    assert.equal(page['@id'], `${canonical}#webpage`);
    assert.equal(business['@id'], `${canonical}#location`);
    assert.notEqual(page['@id'], business['@id']);
    assert.equal(page.mainEntity['@id'], business['@id']);
    assert.equal(business.mainEntityOfPage['@id'], page['@id']);
    assert.equal(business.address.streetAddress, undefined);
    assert.equal(business.telephone, undefined);
    assert.deepEqual(business.sameAs, []);
    await writeFile(path.join(evidence, 'location-render.html'), enabled.html);
    await writeFile(path.join(evidence, 'location-jsonld.json'), JSON.stringify(entities, null, 2));
    fixture.owner.isDisabled = true;
    await request('disabled owner', 404);
    fixture.owner = null;
    await request('missing owner', 404);
    fixture.owner = { email: privateSentinels[2], isDisabled: false, publicProfileSettings: { showAddress: false, showContact: false } };
    fixture.host = null;
    await request('missing host', 404);
    fixture.host = { ...host, userId: null };
    await request('host with missing owner ID', 404);
    fixture.host = { ...host };
    fixture.fail = true;
    const unavailable = await request('injected DB failure', 503);
    assert.equal(unavailable.response.headers.get('retry-after'), '60');
    assert.equal(unavailable.response.headers.get('x-robots-tag'), 'noindex,follow');
    fixture.fail = false;
    fixture.host.businessName = 'Harbor </script><script>globalThis.PWNED=1</script> & "Hall"';
    const adversarial = await request('adversarial name escaping', 200);
    const adversarialEntities = parseJsonLd(adversarial.html);
    assert.equal(adversarialEntities.find(entity => entity['@type'] === 'LocalBusiness').name, fixture.host.businessName);
    assert.ok(!adversarial.html.includes('<script>globalThis.PWNED'));
    assert.ok(adversarial.html.includes('&lt;/script&gt;'));
    fixture.host = { ...host };

    // Browser required: never silently skip acceptance coverage.
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const observed: any[] = [];
    let blockedNetwork = 0;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { blockedNetwork++; observed.push({ url: url.href, blocked: true }); await route.abort(); }
      else { await route.continue(); }
    });
    const browserPage = await context.newPage();
    browserPage.setDefaultTimeout(15_000);
    browserPage.on('response', response => observed.push({ url: response.url(), status: response.status() }));
    fixture.host.businessName = 'Harbor </script><script>globalThis.PWNED=1</script> & "Hall"';
    await browserPage.goto(`${base}${locationPath}`, { waitUntil: 'networkidle' });
    assert.equal(await browserPage.evaluate(() => (globalThis as any).PWNED), undefined);
    assertPrivate(await browserPage.content());
    fixture.host = { ...host };
    await browserPage.goto(`${base}${locationPath}`, { waitUntil: 'networkidle' });
    assert.ok(await browserPage.getByRole('heading', { name: /Harbor Gathering Hall/ }).isVisible());
    assertPrivate(await browserPage.content());
    await browserPage.screenshot({ path: path.join(evidence, '01-location.png'), fullPage: true });
    await browserPage.getByRole('link', { name: 'Food in Pensacola', exact: true }).click();
    await browserPage.waitForURL(`${base}/city/${city.slug}/food`);
    assert.ok(await browserPage.getByRole('heading', { name: /Pensacola/ }).isVisible());
    const returnLink = browserPage.locator(`.listing-results a[href="${locationPath}"]`).first();
    assert.ok(await returnLink.isVisible());
    assert.ok((await returnLink.innerText()).includes(normalName));
    assertPrivate(await browserPage.content());
    await browserPage.screenshot({ path: path.join(evidence, '02-city-food.png'), fullPage: true });
    await returnLink.click();
    await browserPage.waitForURL(`${base}${locationPath}`);
    assert.ok(await browserPage.getByRole('heading', { name: /Harbor Gathering Hall/ }).isVisible());
    assertPrivate(await browserPage.content());
    assert.equal(await browserPage.evaluate(() => (globalThis as any).PWNED), undefined);
    await browserPage.screenshot({ path: path.join(evidence, '03-location-return.png'), fullPage: true });
    await writeFile(path.join(evidence, 'receipt.json'), JSON.stringify({ scope: 'Synthetic fixture DB; real registered SSR hostPage, owner/privacy adapter, sendPage, landing model, and one headless loopback Chromium journey. No real DB/customer acceptance.', receipts, parsedJsonLd: entities, fixtureTablesRead: fixture.reads, browser: { observed, blockedNetwork, finalUrl: browserPage.url() } }, null, 2));
    console.log(`Location isolation PASS: ${receipts.length} runtime cases; Chromium location -> city food -> location; evidence ${evidence}`);
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    delete (globalThis as any)[fixtureKey];
  }
});
