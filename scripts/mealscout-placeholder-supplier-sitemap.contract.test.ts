import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isPublicDiscoveryEligibleEntity,
  isSyntheticPublicEntityName,
} from "../shared/publicDiscoveryIntegrity";

/**
 * The suppliers sitemap listed exactly one supplier: the placeholder
 * record the platform itself creates. ensureSupplier
 * (server/routes/supplierMarketplaceRoutes.ts) inserts every new
 * supplier row with businessName "New Supplier" and isActive: true, and
 * the synthetic-name guard did not recognize that creation-default name,
 * so an unfinished shell with no city and no products was advertised to
 * crawlers as a public business. The guard now treats the platform's
 * "New <entity type>" creation defaults as synthetic as a class, which
 * removes such records from every consumer of the shared eligibility
 * rule (root sitemap, sitemap-suppliers.xml, discovery, prerender).
 */

test("the platform's creation-default supplier name is synthetic", () => {
  assert.equal(isSyntheticPublicEntityName("New Supplier"), true);
  assert.equal(
    isPublicDiscoveryEligibleEntity({ name: "New Supplier", isActive: true }),
    false,
  );
});

test("creation-default names are covered as a class, not one record", () => {
  for (const name of [
    "New Restaurant",
    "New Truck",
    "New Food Truck",
    "new supplier",
    "  New   Supplier  ",
  ]) {
    assert.equal(isSyntheticPublicEntityName(name), true, name);
  }
});

test("legitimate names that merely resemble a default stay eligible", () => {
  for (const name of [
    "New York Pizza",
    "New Supplier Outlet",
    "The New Supplier Co",
    "Test Kitchen",
    "The Testing Grounds",
    "ASDF Coffee Roasters",
    "Discoverability Cafe",
    "Supplier Test Labs",
    "Test Host Cafe",
    "Test Location Lounge",
    "Smoke House",
    "Acme Supply Co",
  ]) {
    assert.equal(isSyntheticPublicEntityName(name), false, name);
    assert.equal(
      isPublicDiscoveryEligibleEntity({ name, isActive: true }),
      true,
      name,
    );
  }
});

test("the pre-existing synthetic patterns still fire", () => {
  for (const name of [
    "asdf",
    "discoverability-flow-1777479688781-295625",
    "test-supplier-1771607433376-s17ept",
    "Test Truck 1771607433376",
    "smoke-host-site",
  ]) {
    assert.equal(isSyntheticPublicEntityName(name), true, name);
  }
});

test("both supplier sitemap paths consume the shared eligibility rule", () => {
  const seoRoutes = readFileSync(
    new URL("../server/routes/seoRoutes.ts", import.meta.url),
    "utf8",
  );
  assert.match(seoRoutes, /const supplierRows = allSupplierRows\.filter/);
  const suppliersRoute = seoRoutes.slice(
    seoRoutes.indexOf('"/sitemap-suppliers.xml"'),
    seoRoutes.indexOf('"/sitemap-suppliers.xml"') + 2000,
  );
  assert.match(suppliersRoute, /isPublicDiscoveryEligibleEntity/);
});
