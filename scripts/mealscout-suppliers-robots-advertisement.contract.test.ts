import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * After the placeholder-supplier guard, sitemap-suppliers.xml correctly
 * serves zero entries — but robots.txt kept advertising it, and an
 * advertised-but-empty sitemap is a standing error report in Search
 * Console. The services feed already solved this in the same file: one
 * loader answers whether the feed has anything in it, and robots
 * advertises the feed only then (a failed count keeps the line). The
 * suppliers feed now follows the same rule: loadSuppliersSitemapEntries
 * carries the suppliers route's own query and eligibility filter,
 * unchanged, and the robots advertisement is conditional on it. The
 * route itself and the eligibility guard are untouched.
 */

const seoRoutes = readFileSync(
  new URL("../server/routes/seoRoutes.ts", import.meta.url),
  "utf8",
);

test("the suppliers loader mirrors the route's query and eligibility filter", () => {
  assert.match(seoRoutes, /const loadSuppliersSitemapEntries = async/);
  const loader = seoRoutes.slice(
    seoRoutes.indexOf("const loadSuppliersSitemapEntries"),
    seoRoutes.indexOf("export function registerSeoRoutes"),
  );
  assert.match(loader, /from\(suppliers\)/);
  assert.match(loader, /eq\(suppliers\.isActive, true\)/);
  assert.match(loader, /isPublicDiscoveryEligibleEntity/);
});

test("robots advertises the suppliers feed only while it has entries", () => {
  const robots = seoRoutes.slice(seoRoutes.indexOf('"/robots.txt"'));
  assert.match(robots, /const advertiseSuppliers =/);
  assert.match(
    robots,
    /supplierEntries === null \|\| supplierEntries\.length > 0/,
  );
  assert.match(
    robots,
    /\.\.\.\(advertiseSuppliers\s*\?\s*\[`Sitemap: \$\{baseUrl\}\/sitemap-suppliers\.xml`\]\s*:\s*\[\]\)/,
  );
  assert.doesNotMatch(
    robots,
    /^\s*`Sitemap: \$\{baseUrl\}\/sitemap-suppliers\.xml`,$/m,
  );
});

test("the services rule and the suppliers route are untouched", () => {
  assert.match(seoRoutes, /const advertiseServices =/);
  const suppliersRoute = seoRoutes.slice(
    seoRoutes.indexOf('"/sitemap-suppliers.xml"'),
    seoRoutes.indexOf('"/sitemap-suppliers.xml"') + 2000,
  );
  assert.match(suppliersRoute, /isPublicDiscoveryEligibleEntity/);
  assert.match(suppliersRoute, /sendUrlsetXml/);
});
