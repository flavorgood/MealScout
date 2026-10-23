import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath: string) =>
  readFileSync(path.join(root, relativePath), "utf8");

const auth = read("server/unifiedAuth.ts");
const storage = read("server/storage/usersRepository.ts");
const storageContract = read("server/storage.ts");
const schema = read("shared/schema/legacy.ts");
const login = read("client/src/pages/login.tsx");
const restaurantSignup = read("client/src/pages/restaurant-signup.tsx");
const historicalImplementation = read("docs/FACEBOOK_OAUTH_IMPLEMENTATION.md");
const historicalArchitecture = read("docs/SHARED_FACEBOOK_AUTH_ARCHITECTURE.md");

assert.match(auth, /findExistingOAuthProviderUser/);
assert.doesNotMatch(auth, /findExistingOAuthUser/);
assert.match(auth, /OAuthIdentityBoundaryError/);
assert.match(auth, /oauthIdentityRedirectCode\(info\)/);

assert.match(storage, /decideOAuthIdentity/);
assert.match(storage, /assertOAuthIdentityCanProceed/);
assert.match(storage, /providerConfirmsResolvedEmail/);
assert.match(storage, /AUTH_ACCOUNT_DISABLED/);
assert.doesNotMatch(storage, /googleAccessToken:/);
assert.doesNotMatch(storage, /facebookAccessToken:/);
assert.doesNotMatch(auth, /googleAccessToken:/);
assert.doesNotMatch(auth, /facebookAccessToken:/);

assert.match(auth, /CROSS_PRODUCT_AUTH_RETIRED/);
assert.doesNotMatch(auth, /googleAppContext/);
assert.doesNotMatch(auth, /fbAppContext/);
assert.doesNotMatch(auth, /TRADESCOUT_PUBLIC_BASE_URL/);
assert.doesNotMatch(auth, /thetradescout\.com\/?\?auth=success/);
assert.match(storageContract, /appContext\?: "mealscout"/);
assert.doesNotMatch(storageContract, /appContext\?: "mealscout" \| "tradescout"/);

assert.match(schema, /Legacy OAuth fields/);
assert.match(schema, /active authentication must not write new token values/);
assert.match(schema, /Legacy multi-platform marker/);

for (const client of [login, restaurantSignup]) {
  assert.match(client, /getOAuthIdentityFailureMessage/);
  assert.match(client, /Account sign-in needs attention/);
}

assert.match(historicalImplementation, /Historical truth only/);
assert.match(historicalImplementation, /Status:\*\* Retired historical design/);
assert.match(historicalArchitecture, /not governing architecture/i);
assert.match(historicalArchitecture, /Status:\*\* Retired/);

// The selected-QA runner has no outer timeout. Bound this pure helper child
// explicitly so a hung helper test cannot leave that command waiting forever.
const helperTests = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "client/src/lib/oauthIdentityFailure.test.ts"],
  { cwd: root, encoding: "utf8", timeout: 10_000 },
);
if (helperTests.stdout) process.stdout.write(helperTests.stdout);
if (helperTests.stderr) process.stderr.write(helperTests.stderr);
assert.ifError(helperTests.error);
assert.equal(helperTests.signal, null, "OAuth helper tests must not be interrupted");
assert.equal(helperTests.status, 0, "OAuth helper tests must pass");

console.log("MealScout OAuth identity boundary contract passed");
