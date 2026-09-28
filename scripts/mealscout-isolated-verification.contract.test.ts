import assert from "node:assert/strict";
import { test } from "node:test";
import { assertIsolatedVerificationDatabaseUrl, isIsolatedVerificationMode, useLocalPostgresRuntime } from "../server/bootstrap/isolatedVerification";
import { resolveMigrationDatabaseUrl, useLocalPostgresTransport } from "./runDeployMigrations";

test("isolated verification requires an explicit true value", () => {
  assert.equal(isIsolatedVerificationMode({}), false);
  assert.equal(isIsolatedVerificationMode({ MEALSCOUT_ISOLATED_VERIFICATION: "false" }), false);
  assert.equal(isIsolatedVerificationMode({ MEALSCOUT_ISOLATED_VERIFICATION: " TRUE " }), true);
});

test("the live MealScout Render service cannot disable its startup jobs", () => {
  assert.throws(
    () => isIsolatedVerificationMode({
      MEALSCOUT_ISOLATED_VERIFICATION: "true",
      RENDER_SERVICE_ID: "srv-d5escdh5pdvs73foo41g",
    }),
    /cannot disable jobs on the live MealScout service/,
  );
  assert.equal(isIsolatedVerificationMode({
    MEALSCOUT_ISOLATED_VERIFICATION: "true",
    RENDER_SERVICE_ID: "srv-disposable-verification",
    RENDER_SERVICE_NAME: "mealscout-isolated-verification",
  }), true);
  assert.throws(() => isIsolatedVerificationMode({
    MEALSCOUT_ISOLATED_VERIFICATION: "true",
    RENDER_SERVICE_ID: "srv-other",
    RENDER_SERVICE_NAME: "mealscout",
  }), /dedicated Render service name/);
});

test("local runtime cannot escape a disposable numeric-loopback database", () => {
  const env = {
    MEALSCOUT_ISOLATED_VERIFICATION: "true",
    MEALSCOUT_LOCAL_POSTGRES_RUNTIME: "true",
  };
  assert.equal(useLocalPostgresRuntime("postgresql://fixture@127.0.0.1:55494/mealscout_isolated_fixture", env), true);
  assert.equal(useLocalPostgresRuntime("postgres://fixture@[::1]:55494/mealscout_isolated_fixture", env), true);
  for (const url of [
    "postgresql://fixture@localhost:55494/mealscout_isolated_fixture",
    "postgresql://fixture@example.com:55494/mealscout_isolated_fixture",
    "postgresql://fixture@127.0.0.1:55494/mealscout_isolated_fixture?host=example.com",
    "postgresql://fixture@127.0.0.1:55494/mealscout_isolated_fixture#override",
    "postgresql://fixture@127.0.0.1:55494/mealscout",
    "postgresql://fixture@127.0.0.1:55494/mealscout_isolated_fixture/extra",
    "https://fixture@127.0.0.1:55494/mealscout_isolated_fixture",
  ]) {
    assert.throws(() => useLocalPostgresRuntime(url, env));
  }
  assert.throws(() => useLocalPostgresRuntime(
    "postgresql://fixture@127.0.0.1:55494/mealscout_isolated_fixture",
    { ...env, RENDER_SERVICE_ID: "srv-disposable-verification" },
  ));
  assert.throws(() => useLocalPostgresRuntime(
    "postgresql://fixture@127.0.0.1:55494/mealscout_isolated_fixture",
    { MEALSCOUT_LOCAL_POSTGRES_RUNTIME: "true" },
  ));
});

test("isolated server and migrator reject ordinary or mismatched database targets", () => {
  const environment = {
    MEALSCOUT_ISOLATED_VERIFICATION: "true",
    RENDER_SERVICE_ID: "srv-disposable-verification",
    RENDER_SERVICE_NAME: "mealscout-isolated-verification",
  };
  const runtimeUrl = "postgresql://fixture@ep-fixture-pooler.us-east-2.aws.neon.tech/mealscout_isolated_fixture?sslmode=require&channel_binding=require";
  const migrationUrl = "postgresql://fixture@ep-fixture.us-east-2.aws.neon.tech/mealscout_isolated_fixture?sslmode=require";
  assert.doesNotThrow(() => assertIsolatedVerificationDatabaseUrl(runtimeUrl, environment));
  assert.equal(resolveMigrationDatabaseUrl({
    ...environment,
    DATABASE_URL: runtimeUrl,
    MIGRATION_DATABASE_URL: migrationUrl,
  }), migrationUrl);

  for (const unsafeUrl of [
    "postgresql://fixture@ep-fixture.us-east-2.aws.neon.tech/mealscout",
    "postgresql://fixture@example.com/mealscout_isolated_fixture",
    "postgresql://fixture@127.0.0.1/mealscout_isolated_fixture",
    "postgresql://fixture@ep-fixture.us-east-2.aws.neon.tech/mealscout_isolated_fixture?host=example.com",
    "postgresql://fixture@ep-fixture.us-east-2.aws.neon.tech/mealscout_isolated_fixture#override",
  ]) {
    assert.throws(() => assertIsolatedVerificationDatabaseUrl(unsafeUrl, environment));
    assert.throws(() => resolveMigrationDatabaseUrl({ ...environment, DATABASE_URL: unsafeUrl }));
  }
  assert.throws(() => resolveMigrationDatabaseUrl({
    ...environment,
    DATABASE_URL: runtimeUrl,
    MIGRATION_DATABASE_URL: migrationUrl.replace("mealscout_isolated_fixture", "mealscout_isolated_other"),
  }), /targets differ/);
});

test("Render detection refuses local PostgreSQL even before a service ID is assigned", () => {
  const environment = {
    MEALSCOUT_ISOLATED_VERIFICATION: "true",
    MEALSCOUT_LOCAL_POSTGRES_RUNTIME: "true",
    MEALSCOUT_LOCAL_POSTGRES_MIGRATION: "true",
    RENDER: "true",
    RENDER_SERVICE_NAME: "mealscout-isolated-verification",
  };
  const localUrl = "postgresql://fixture@127.0.0.1/mealscout_isolated_fixture";
  assert.throws(() => assertIsolatedVerificationDatabaseUrl(localUrl, environment), /non-Render URL/);
  assert.throws(() => useLocalPostgresRuntime(localUrl, environment), /non-Render service/);
  assert.throws(() => useLocalPostgresTransport(localUrl, environment), /unavailable in a Render service/);
});
