import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("client/src/App.tsx", "utf8");
const background = readFileSync(
  "client/src/components/TimeOfDayBackground.tsx",
  "utf8",
);
const navigation = readFileSync(
  "client/src/components/navigation.tsx",
  "utf8",
);
const scout = readFileSync(
  "client/src/pages/explore-preview-v2.tsx",
  "utf8",
);
const menu = readFileSync("client/src/pages/online-menu.tsx", "utf8");
const search = readFileSync("client/src/pages/search.tsx", "utf8");

assert.match(background, /appearance = "day"/);
assert.match(background, /root\.classList\.add\([\s\S]*"theme-night" : "theme-day"/);
assert.match(
  app,
  /if \(usesSelfContainedConsumerShell\)[\s\S]*<TimeOfDayBackground appearance="day"/,
);
assert.match(app, /function GuestProtectedRoutes\(\)/);
assert.match(
  app,
  /\{SharedPublicRoutes\(\)\}/,
  "Shared route groups must be expanded into direct Switch children",
);
assert.match(
  app,
  /\{GuestProtectedRoutes\(\)\}/,
  "Guest guards must be expanded into direct Switch children",
);
assert.doesNotMatch(
  app,
  /desktop-full-width/,
  "The application shell must respect page-level content widths",
);
assert.match(app, /path="\/favorites" component=\{RedirectToLogin\}/);
assert.match(
  app,
  /path="\/restaurant-owner-dashboard"[\s\S]*component=\{RedirectToLogin\}/,
);

assert.match(
  navigation,
  /guest: \[[\s\S]*label: "Scout"[\s\S]*label: "Create menu"[\s\S]*label: "Account"/,
);
assert.match(
  navigation,
  /data-scout-mobile-nav-shell=\{[\s\S]*"search-and-navigation"/,
);
assert.match(navigation, /useScoutNavSearch|\{scoutNavSearch\}/);
assert.match(navigation, /isScoutRoute[\s\S]*\? "customer"[\s\S]*: "guest"/);

assert.doesNotMatch(scout, /data-scout-search-surface="top"/);
assert.doesNotMatch(scout, /<ScoutSearchDock[\s\S]*placement="inline"/);
assert.match(
  app,
  /const usesCinematicBackground =[\s\S]*currentPath === "\/scout"[\s\S]*currentPath\.startsWith\("\/directory\/"\)/,
  "Scout and its aliases must retain the warm night application theme.",
);

assert.match(menu, /const publicProfileHref =/);
assert.match(menu, /restaurantName \|\| "Menu"/);
assert.match(menu, />\s*Back to profile\s*</);
assert.match(menu, />\s*View profile\s*/);
assert.doesNotMatch(menu, /Waiting on:/);

assert.doesNotMatch(search, /<BackHeader/);
assert.match(search, /const hasSearchIntent =/);
assert.match(search, /Start with what sounds good/);

console.log("mealscout-ui-shell-foundation.contract: PASS");
