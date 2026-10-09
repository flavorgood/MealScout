// Own one disposable, loopback-only PostgreSQL cluster using existing binaries.
// This helper accepts no production URL, provider credential, or external host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

assert.equal(process.env.MEALSCOUT_LEGACY_NATIVE_TEST, '1');
assert.notEqual(process.getuid?.(), 0, 'PostgreSQL fixture must run as its ordinary owner');
for (const [key, value] of Object.entries(process.env)) {
  if (/DATABASE_URL|^PG(?:HOST|PORT|USER|PASSWORD|DATABASE)|STRIPE|BREVO|SMTP|SENDGRID|RESEND|TWILIO/.test(key)) {
    assert.ok(!value, 'Forbidden ambient configuration: ' + key);
  }
}
const bin = process.env.MEALSCOUT_LEGACY_PG_BIN;
assert.ok(bin && path.isAbsolute(bin), 'Existing PostgreSQL binary directory required');
for (const name of ['initdb', 'pg_ctl', 'createdb', 'postgres']) {
  assert.ok(fs.existsSync(path.join(bin, name)), 'Existing binary required: ' + name);
}
const temporaryRoot = fs.realpathSync(os.tmpdir());
const owned = fs.mkdtempSync(path.join(temporaryRoot, 'mealscout-legacy-native-'));
const data = path.join(owned, 'data');
let started = false, finished = false;
const emit = value => console.log(JSON.stringify(value));
function cleanup() {
  if (finished) return;
  finished = true;
  const receipt = { type: 'postgres-cleanup', stopped: !started, ownedDirectoryRemoved: false };
  try {
    if (started) {
      execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe', timeout: 15000 });
      receipt.stopped = true;
    }
    const resolved = fs.realpathSync(owned);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.match(path.basename(resolved), /^mealscout-legacy-native-[A-Za-z0-9]+$/);
    fs.rmSync(resolved, { recursive: true });
    receipt.ownedDirectoryRemoved = true;
  } catch (error) {
    receipt.error = String(error.message || error);
    process.exitCode = 1;
  }
  emit(receipt);
}
process.on('SIGTERM', () => { cleanup(); process.exit(process.exitCode || 0); });
process.on('SIGINT', () => { cleanup(); process.exit(process.exitCode || 0); });
process.stdin.on('end', cleanup);
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (line === 'stop') { cleanup(); process.stdin.destroy(); }
});
try {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  execFileSync(path.join(bin, 'initdb'), ['-D', data, '-A', 'trust', '-U', 'qa_owner', '--no-locale', '-E', 'UTF8'], { stdio: 'pipe', timeout: 30000 });
  execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(owned, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${owned} -c timezone=UTC -c max_connections=40`, '-w', 'start'], { stdio: 'pipe', timeout: 30000 });
  started = true;
  execFileSync(path.join(bin, 'createdb'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'qa_owner', 'mealscout_legacy_binding_test'], { stdio: 'pipe', timeout: 15000 });
  emit({ type: 'postgres-ready', port, listen: '127.0.0.1', url: `postgresql://qa_owner@127.0.0.1:${port}/mealscout_legacy_binding_test`, version: execFileSync(path.join(bin, 'postgres'), ['--version'], { encoding: 'utf8' }).trim(), helperPid: process.pid });
} catch (error) {
  emit({ type: 'postgres-failure', error: String(error.message || error) });
  cleanup();
  process.exitCode = 1;
  process.stdin.destroy();
}
