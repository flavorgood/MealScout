import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The locations, events, and videos sitemaps each serve zero entries
 * today, but robots.txt kept advertising all three — and an
 * advertised-but-empty sitemap is a standing error report in Search
 * Console. The services and suppliers feeds already solved this in the
 * same file: one loader answers whether the feed has anything in it,
 * and robots advertises the feed only then (a failed count keeps the
 * line). These three feeds now follow the same rule: each loader
 * carries its route's own query and eligibility filter, unchanged,
 * and the robots advertisement is conditional on it. The routes
 * themselves serve exactly what they served before.
 */

const seoRoutes = readFileSync(
  new URL("../server/routes/seoRoutes.ts", import.meta.url),
  "utf8",
);

const feeds = [
  {
    loader: "loadLocationsSitemapEntries",
    entries: "locationEntries",
    flag: "advertiseLocations",
    file: "sitemap-locations.xml",
    marker: /from\(eventBookings\)/,
  },
  {
    loader: "loadEventsSitemapEntries",
    entries: "eventEntries",
    flag: "advertiseEvents",
    file: "sitemap-events.xml",
    marker: /selectDistinct/,
  },
  {
    loader: "loadVideosSitemapEntries",
    entries: "videoEntries",
    flag: "advertiseVideos",
    file: "sitemap-videos.xml",
    marker: /from\(videoStories\)/,
  },
] as const;

for (const feed of feeds) {
  test(`the ${feed.file} loader mirrors the route's query and eligibility filter`, () => {
    assert.match(seoRoutes, new RegExp(`const ${feed.loader} = async`));
    const loader = seoRoutes.slice(
      seoRoutes.indexOf(`const ${feed.loader}`),
      seoRoutes.indexOf("export function registerSeoRoutes"),
    );
    assert.match(loader, feed.marker);
    assert.match(loader, /isPublicDiscoveryEligibleEntity|isPublicStoryAssociationEligible/);
  });

  test(`robots advertises ${feed.file} only while it has entries`, () => {
    const robots = seoRoutes.slice(seoRoutes.indexOf('"/robots.txt"'));
    assert.match(robots, new RegExp(`const ${feed.flag} =`));
    assert.match(
      robots,
      new RegExp(`${feed.entries} === null \\|\\| ${feed.entries}\\.length > 0`),
    );
    assert.match(
      robots,
      new RegExp(
        `\\.\\.\\.\\(${feed.flag}\\s*\\?\\s*\\[\`Sitemap: \\$\\{baseUrl\\}\\/${feed.file.replace(".", "\\.")}\`\\]\\s*:\\s*\\[\\]\\)`,
      ),
    );
    assert.doesNotMatch(
      robots,
      new RegExp(`^\\s*\`Sitemap: \\$\\{baseUrl\\}\\/${feed.file.replace(".", "\\.")}\`,$`, "m"),
    );
  });

  test(`the ${feed.file} route serves the loader's entries`, () => {
    const route = seoRoutes.slice(
      seoRoutes.indexOf(`"/${feed.file}"`),
      seoRoutes.indexOf(`"/${feed.file}"`) + 600,
    );
    assert.match(route, new RegExp(`await ${feed.loader}\\(baseUrl\\)`));
    assert.match(route, /sendUrlsetXml\(res, \{ entries \}\)/);
  });
}

test("the services and suppliers rules are untouched", () => {
  assert.match(seoRoutes, /const advertiseServices =/);
  assert.match(seoRoutes, /const advertiseSuppliers =/);
  assert.match(seoRoutes, /const loadServicesSitemapEntries = async/);
  assert.match(seoRoutes, /const loadSuppliersSitemapEntries = async/);
});
