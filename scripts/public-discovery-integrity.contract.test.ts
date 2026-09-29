import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isPublicDiscoveryEligibleEntity,
  isSyntheticPublicEntityName,
} from "../shared/publicDiscoveryIntegrity";
import { isActionApiPublicBusinessEligible } from "../server/publicProfiles/actionApiPublicReadProjection";

test("confirmed synthetic production records are not discovery eligible", () => {
  for (const name of [
    "asdf",
    "asdfasdfasdf",
    "discoverability-flow-1777479688781-295625",
    "test-supplier-1771607433376-s17ept",
    "Test Truck 1771607433376",
    "test-host-1776139421969",
    "test-host-1776139608501",
    "smoke-host-site",
    "smoke-host-site-1776139421969",
  ]) {
    assert.equal(isSyntheticPublicEntityName(name), true, name);
    assert.equal(
      isPublicDiscoveryEligibleEntity({ name, isActive: true }),
      false,
      name,
    );
  }
});

test("the narrow guard preserves legitimate public business names", () => {
  for (const name of [
    "Test Kitchen",
    "The Testing Grounds",
    "ASDF Coffee Roasters",
    "Discoverability Cafe",
    "Supplier Test Labs",
    "Test Host Cafe",
    "Test Location Lounge",
    "Smoke House",
  ]) {
    assert.equal(isSyntheticPublicEntityName(name), false, name);
    assert.equal(
      isPublicDiscoveryEligibleEntity({ name, isActive: true }),
      true,
      name,
    );
  }
  assert.equal(
    isPublicDiscoveryEligibleEntity({
      name: "Legitimate Restaurant",
      isActive: false,
    }),
    false,
  );
});

test("sitemap and prerender paths consume the shared integrity policy", () => {
  const sitemap = readFileSync("server/routes/seoRoutes.ts", "utf8");
  const prerender = readFileSync(
    "server/seo/publicProfilePrerender.ts",
    "utf8",
  );
  const indexability = readFileSync(
    "server/seo/publicRestaurantIndexability.ts",
    "utf8",
  );

  assert.match(indexability, /isPublicDiscoveryEligibleEntity/);
  assert.match(indexability, /isSyntheticPublicEntityName/);
  assert.match(sitemap, /isIndexableRestaurantRow|isPublicRestaurantIndexable/);
  assert.match(sitemap, /const restaurantRows = allRestaurantRows\.filter/);
  assert.match(sitemap, /const supplierRows = allSupplierRows\.filter/);
  assert.match(prerender, /publicRestaurantRobotsDirective/);
  assert.match(prerender, /!isPublicDiscoveryEligibleEntity\(\{/);
  assert.match(prerender, /isSyntheticPublicEntityName\(name\)/);
  assert.match(
    prerender,
    /some\(\(segment\) => isSyntheticPublicEntityName\(segment\)\)/,
  );
  assert.match(
    prerender,
    /robots: isSyntheticTestEntity \? noindexRobots : indexableRobots/,
  );
});

test("Action public reads compose owner authority, integrity, visibility and quarantine", () => {
  const eligible = {
    id: "restaurant-1",
    ownerId: "fixture-owner",
    ownerDisabled: false,
    name: "Riverbend Cafe",
    address: "100 Main St",
    cuisineType: "Cafe",
    description: "Neighborhood cafe",
    city: "Pensacola",
    state: "FL",
    isActive: true,
  };
  assert.equal(isActionApiPublicBusinessEligible(eligible), true);
  assert.equal(isActionApiPublicBusinessEligible({ ...eligible, ownerId: null }), false);
  assert.equal(isActionApiPublicBusinessEligible({ ...eligible, ownerDisabled: true }), false);
  assert.equal(isActionApiPublicBusinessEligible({ ...eligible, ownerDisabled: undefined }), false);
  assert.equal(
    isActionApiPublicBusinessEligible({
      ...eligible,
      name: "Test Restaurant 1771607433376",
    }),
    false,
  );
  assert.equal(
    isActionApiPublicBusinessEligible({
      ...eligible,
      rawData: { evidenceQuarantine: { active: true } },
    }),
    false,
  );

  const actionProjection = readFileSync(
    "server/publicProfiles/actionApiPublicReadProjection.ts",
    "utf8",
  );
  const actionRoutes = readFileSync("server/routes/actionRoutes.ts", "utf8");
  assert.match(actionProjection, /isPublicDiscoveryEligibleEntity/);
  assert.match(actionProjection, /isPublicBusinessVisible/);
  assert.match(actionProjection, /deriveProfileEvidenceQuarantineVisibility/);
  assert.match(actionRoutes, /isActionApiPublicBusinessEligible/);
});
