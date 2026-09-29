import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Evidence-only branch. Never merge this proof configuration into main.
const sourceSha = "416bcca39199c88839ed03663b078e32fc6fb459";
const root = process.cwd();
const output = path.join(root, ".discovery-proof");
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(path.join(tmpdir(), "mealscout-discovery-proof-"));
const work = path.join(temp, "source");
mkdirSync(work);
const cleanEnv = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "SYSTEMROOT"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(cleanEnv, { NODE_ENV: "test", CI: "true", DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:9/mealscout_discovery_test?sslmode=disable", EMAIL_NOTIFICATIONS_MODE: "off", VAC_AUTO_VERIFY_ENABLED: "false", MERLIN_OR_ENABLED: "false" });
const receipt = { sourceSha, proofCommit: process.env.VERCEL_GIT_COMMIT_SHA || null, startedAt: new Date().toISOString(), finishedAt: null, passed: false, scope: "isolated_source_tests_and_builds_only", productionChanged: false, providerCallsAllowed: false, stages: [] };
function run(name, command, args, cwd = work, env = cleanEnv, required = true) {
  console.log("DISCOVERY_PROOF_STAGE " + name);
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
  const text = String(result.stdout || "") + String(result.stderr || "");
  const stage = { name, exitCode: result.status, signal: result.signal || null, passed: result.status === 0, required, output: text.slice(-18000), error: result.error?.message || null };
  receipt.stages.push(stage);
  console.log(text.slice(-18000));
  return stage.passed;
}
try {
  if (!run("source_init", "git", ["init"])) throw new Error("Isolated source initialization failed");
  if (!run("source_fetch", "git", ["fetch", "--depth=1", "--no-tags", "https://github.com/infotradescout/MealScout.git", sourceSha])) throw new Error("Exact source fetch failed");
  if (!run("source_checkout", "git", ["checkout", "--detach", sourceSha])) throw new Error("Exact source checkout failed");
  symlinkSync(path.join(root, "node_modules"), path.join(work, "node_modules"), "dir");
  const toolRoot = path.join(temp, "sql-tooling");
  mkdirSync(toolRoot);
  if (!run("disposable_pglite_install", "npm", ["install", "--prefix", toolRoot, "--no-save", "--package-lock=false", "--ignore-scripts", "--no-audit", "--no-fund", "@electric-sql/pglite@0.3.14"], root)) throw new Error("Disposable SQL tooling unavailable");
  cleanEnv.MEAL_QUALITY_PGLITE_MODULE = pathToFileURL(path.join(toolRoot, "node_modules/@electric-sql/pglite/dist/index.js")).href;
  run("historical_contract_source", "git", ["fetch", "--depth=1", "--no-tags", "https://github.com/infotradescout/MealScout.git", "d64ef420f537b78e00fc93c8d8aa1baba84a976f"]);
  const guard = path.join(temp, "network-guard.mjs");
  writeFileSync(guard, `import net from 'node:net';\nimport tls from 'node:tls';\nimport {syncBuiltinESMExports} from 'node:module';\nconst local = host => ['127.0.0.1','localhost','::1','[::1]'].includes(String(host || 'localhost').toLowerCase());\nconst check = value => { const u = new URL(typeof value === 'string' || value instanceof URL ? value : value.url); if (!local(u.hostname) || !['http:','https:'].includes(u.protocol)) throw new Error('External network is blocked in MealScout discovery proof'); };\nconst originalFetch=globalThis.fetch; globalThis.fetch=(input,...rest)=>{check(input);return originalFetch(input,...rest);};\nconst connect=net.Socket.prototype.connect; net.Socket.prototype.connect=function(...args){const first=args[0];const host=first&&typeof first==='object'?first.host:typeof args[1]==='string'?args[1]:'localhost';if(!local(host))throw new Error('External socket is blocked in MealScout discovery proof');return connect.apply(this,args);};\nconst tlsConnect=tls.connect;tls.connect=function(...args){const first=args[0];const options=first&&typeof first==='object'?first:args.find(arg=>arg&&typeof arg==='object')||{};const host=options.host||(typeof args[1]==='string'?args[1]:'localhost');if(!local(host))throw new Error('External TLS is blocked in MealScout discovery proof');return tlsConnect.apply(this,args);};\nsyncBuiltinESMExports();\n`);
  cleanEnv.NODE_OPTIONS = "--import=" + pathToFileURL(guard).href;
  const suites = [
    "scripts/discovery-request-signals.test.ts",
    "scripts/public-discovery-integrity.contract.test.ts",
    "scripts/traffic-quality-dashboard.test.mjs",
    "scripts/discovery-v2-origin-traffic.test.ts",
    "scripts/public-restaurant-indexability.contract.test.ts",
    "scripts/public-seo-landing-model.behavior.test.ts",
    "scripts/public-seo-landing-pages.contract.test.ts",
  ];
  for (const suite of suites) run(suite, process.execPath, ["--import", "tsx", "--test", suite]);
  run("typescript", process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit"]);
  run("server_build", process.execPath, ["scripts/buildServer.mjs"]);
  run("client_build", process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build", "--config", "client/vite.config.ts"]);
} catch (error) {
  receipt.stages.push({ name: "proof_setup", passed: false, required: true, error: String(error.message || error) });
} finally {
  receipt.finishedAt = new Date().toISOString();
  receipt.passed = receipt.stages.length > 0 && receipt.stages.filter(stage => stage.required).every(stage => stage.passed);
  writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  writeFileSync(path.join(output, "index.html"), '<!doctype html><meta name="robots" content="noindex,nofollow,noarchive"><title>MealScout isolated evidence</title><h1>MealScout isolated source verification</h1><p>This hosting deployment is an evidence report, not a passing application gate. Read the receipt passed field and every stage.</p><a href="receipt.json">Verification receipt</a>');
  writeFileSync(path.join(output, "robots.txt"), "User-agent: *\nDisallow: /\n");
  console.log("DISCOVERY_ISOLATED_RECEIPT " + JSON.stringify({ sourceSha, passed: receipt.passed, stages: receipt.stages.map(({name,passed,exitCode}) => ({name,passed,exitCode})) }));
}
