import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const dependencies = createRequire(path.join(root, 'package.json'));
const ts = dependencies('typescript');
const { Pool } = dependencies('pg');
const sha = value => createHash('sha256').update(value).digest('hex');
const pins = {
  'server/unifiedAuth.ts': 'b5a5f9483f004a0ca4b74f77c36998b06aba1ba7544cb9574a79985bf0737902',
  'migrations/0000_famous_deathbird.sql': '64a5cda2a0059d72059f794d6e53165b06e2bfb69b3d4b730c3772d518d6d182',
  'scripts/native-hosted-realtime.test.mjs': '583949008c5d68505b90a56b86bc5f4ba0183c1153cd6b0d5973a7ed4eacfa4e',
  'server/websocket.ts': '70658e3b734feb5e8c65385f79c59508f5848f6a8c9824c63eda2537a69c6fd0',
};
const sources = {};
for (const [filename, expected] of Object.entries(pins)) {
  sources[filename] = fs.readFileSync(filename, 'utf8');
  assert.equal(sha(sources[filename]), expected, filename);
}
assert.equal(spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), 'c102255fe8ed1d44b7807ad1891417ebe656ba23');
assert.equal(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim(), '');
const connection = new URL(process.env.DATABASE_URL);
assert.equal(connection.protocol, 'postgresql:');
assert.equal(connection.hostname, '127.0.0.1');
assert.equal(connection.pathname, '/hosting_session_fixture');
assert.equal(connection.username, 'hosting_fixture');
assert.equal(connection.password, '');
assert.equal(process.env.NODE_ENV, 'production');
assert.equal(process.env.SESSION_COOKIE_DOMAIN || '', '');
assert.equal(process.env.MEALSCOUT_HOST_GATEWAY_RUNTIME_SOURCE || '', '');
assert.equal(process.env.MEALSCOUT_HOST_GATEWAY_UPGRADE_SOURCE || '', '');

const out = '.qa-evidence/hosting-native-pg';
fs.mkdirSync(out, { recursive: true });
const parsed = ts.createSourceFile('unifiedAuth.ts', sources['server/unifiedAuth.ts'], ts.ScriptTarget.Latest, true);
const selected = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'getSession');
assert.equal(selected.length, 1);
const functionSource = selected[0].getText(parsed);
const compiled = ts.transpileModule(functionSource, { fileName: 'get-session.ts', reportDiagnostics: true,
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
fs.writeFileSync(out + '/get-session.mjs', "import session from 'express-session';\nimport connectPg from 'connect-pg-simple';\n" + compiled.outputText);

const ddlStatements = sources['migrations/0000_famous_deathbird.sql'].split('--> statement-breakpoint')
  .filter(sql => /^\s*CREATE TABLE "sessions"\s*\(/.test(sql));
assert.equal(ddlStatements.length, 1);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(ddlStatements[0]);

const memorySetup = "    const nativeSession = session({ name: 'tradescout.sid', secret: 'owned-loopback-fixture-not-provider-credential',\n" +
  "      resave: false, saveUninitialized: false, store: new session.MemoryStore(), proxy: true,\n" +
  "      cookie: { secure: true, httpOnly: true, sameSite: 'none' },\n    });";
const original = sources['scripts/native-hosted-realtime.test.mjs'];
assert.equal(original.split(memorySetup).length - 1, 1);
const adapted = "import { getSession } from '../.qa-evidence/hosting-native-pg/get-session.mjs';\n" +
  original.replace(memorySetup, '    const nativeSession = getSession();');
const target = 'scripts/native-hosted-realtime-pg.test.mjs';
fs.writeFileSync(target, adapted);
const result = spawnSync(process.execPath, ['--max-old-space-size=192', '--test', '--test-reporter=tap', target], { encoding: 'utf8', timeout: 90_000 });
fs.writeFileSync(out + '/native-pg.log', result.stdout + result.stderr);
process.stdout.write(result.stdout + result.stderr);
assert.equal(result.status, 0, 'Original native assertions with actual canonical PgSession');
assert.match(result.stdout, /# tests 13\b/);
assert.match(result.stdout, /# pass 13\b/);
assert.match(result.stdout, /# fail 0\b/);
const rows = await pool.query("SELECT sess #>> '{passport,user}' AS actor FROM sessions ORDER BY actor");
assert.deepEqual(rows.rows.map(row => row.actor), ['fixture-disabled', 'fixture-other', 'fixture-owner']);
const version = await pool.query('SHOW server_version');
assert.equal(version.rows[0].server_version.startsWith('16.14'), true);
await pool.end();
assert.equal(spawnSync('git', ['diff', '--exit-code', 'HEAD'], { encoding: 'utf8' }).status, 0);
for (const [filename, expected] of Object.entries(pins)) assert.equal(sha(fs.readFileSync(filename)), expected, 'Final unchanged source: ' + filename);
const receipt = { source: 'c102255fe8ed1d44b7807ad1891417ebe656ba23', node: process.version,
  PostgreSQL: version.rows[0].server_version, sourceHashes: pins, canonicalFunctionSha256: sha(functionSource),
  canonicalDdlSha256: sha(ddlStatements[0]), originalSuiteSha256: sha(original), adaptedSuiteSha256: sha(adapted),
  adaptation: 'Only replace the MemoryStore setup with AST-extracted exact canonical getSession; all original assertions remain unchanged',
  testsPassed: 13, testsFailed: 0, persistedOwnedFixtureActors: rows.rowCount,
  actualConnectPgSimple: true, actualNativePostgres: true, actualNativeSocketIo: true,
  trackedProductSourceChanged: false, gatewayExecuted: false,
  fixtureOwnerResolution: true, productionOwnerRecords: false, providerCalls: 0, customerCalls: 0 };
fs.writeFileSync(out + '/receipt.json', JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
