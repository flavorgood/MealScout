import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  expandScoutSearchTerms,
  foldScoutSearchText,
  scoutSearchRelevanceScore,
  tokenizeScoutSearchIntent,
} from "../shared/scoutSearchIntent";
import {
  filterProjectedRestaurantSearchRows,
  rankPublicRestaurantSearchRows,
} from "../server/services/publicRestaurantSearchProjection";

/**
 * Accent handling must be symmetric on every search surface: an accented
 * spelling and its unaccented twin return the same results, whether the
 * accent lives in the query or in the stored text. Before this fix the
 * unified search destroyed accented queries in the tokenizer ("açaí"
 * expanded to zero terms, which then filtered out every row), the
 * restaurant search matched raw lowercased text in both directions, and
 * the menu feed stripped accents from the query while matching against
 * unstripped stored text.
 */

test("foldScoutSearchText folds accents and case, generally", () => {
  assert.equal(foldScoutSearchText("Açaí"), "acai");
  assert.equal(foldScoutSearchText("Crème Brûlée"), "creme brulee");
  assert.equal(foldScoutSearchText("Jalapeño"), "jalapeno");
  assert.equal(foldScoutSearchText("PIÑA COLADA"), "pina colada");
  assert.equal(foldScoutSearchText("tacos"), "tacos");
  assert.equal(foldScoutSearchText(null), "");
});

test("tokenize/expand treat accented and unaccented spellings identically", () => {
  assert.deepEqual(tokenizeScoutSearchIntent("açaí"), ["acai"]);
  assert.deepEqual(
    expandScoutSearchTerms("açaí"),
    expandScoutSearchTerms("acai"),
  );
  // Pre-existing ASCII behavior is unchanged.
  assert.deepEqual(tokenizeScoutSearchIntent("find tacos near me"), ["tacos"]);
  assert.ok(expandScoutSearchTerms("find tacos near me").includes("mexican"));
});

test("relevance scoring folds the query and the candidate", () => {
  const candidate = {
    name: "Blessed Berry Bowls",
    cuisineType: "Açaí Bowls",
  };
  assert.ok(scoutSearchRelevanceScore(candidate, "acai") > 0);
  assert.equal(
    scoutSearchRelevanceScore(candidate, "açaí"),
    scoutSearchRelevanceScore(candidate, "acai"),
  );
});

const blessedBerry = {
  id: "r1",
  ownerId: "owner-1",
  name: "Blessed Berry Bowls",
  cuisineType: "Açaí Bowls",
  address: "12 Garden St",
  city: "Pensacola",
  state: "FL",
  description: "Fresh açaí bowls and smoothies",
  isActive: true,
  isVerified: false,
};
const creativBowls = {
  id: "r2",
  ownerId: "owner-2",
  name: "CREATIVBOWLS",
  cuisineType: "Acai Bowls",
  address: "9 Palafox St",
  city: "Pensacola",
  state: "FL",
  description: "Acai bowls and juices",
  isActive: true,
  isVerified: false,
};
const rows = [blessedBerry, creativBowls];
const visibility = new Map([
  ["owner-1", { showAddress: true, showContact: true }],
  ["owner-2", { showAddress: true, showContact: true }],
]);

test("/api/restaurants/search filter folds both sides", () => {
  const plain = filterProjectedRestaurantSearchRows(rows, {
    query: "acai",
  }).map((row: any) => row.id);
  const accented = filterProjectedRestaurantSearchRows(rows, {
    query: "açaí",
  }).map((row: any) => row.id);
  assert.ok(plain.includes("r1"), "unaccented query finds accented stored text");
  assert.ok(accented.includes("r2"), "accented query finds unaccented stored text");
  assert.deepEqual([...plain].sort(), [...accented].sort());
});

test("/api/search restaurant ranking folds both sides", () => {
  const plain = rankPublicRestaurantSearchRows(rows, "acai", visibility).map(
    (row: any) => row.id,
  );
  const accented = rankPublicRestaurantSearchRows(rows, "açaí", visibility).map(
    (row: any) => row.id,
  );
  assert.equal(accented.length, 2, "accented query must not return zero rows");
  assert.deepEqual([...plain].sort(), [...accented].sort());
});

test("/api/search SQL fold map is the same rule, projected onto Latin letters", () => {
  const routes = readFileSync(
    new URL("../server/routes/publicSearchRoutes.ts", import.meta.url),
    "utf8",
  );
  const from = routes.match(/SEARCH_SQL_FOLD_FROM =\s*\n?\s*"([^"]+)"/)?.[1];
  const to = routes.match(/SEARCH_SQL_FOLD_TO =\s*\n?\s*"([^"]+)"/)?.[1];
  assert.ok(from && to, "fold constants are exported");
  const fromChars = [...from];
  const toChars = [...to];
  assert.equal(fromChars.length, toChars.length);
  fromChars.forEach((char, index) => {
    assert.equal(
      foldScoutSearchText(char),
      toChars[index],
      `SQL fold maps ${char} to ${toChars[index]}`,
    );
  });
  // Simulate Postgres translate(lower(x), FROM, TO) and compare with the
  // JS fold over a corpus of realistic accented food words.
  const translateSim = (value: string) =>
    [...value.toLowerCase()]
      .map((char) => {
        const index = fromChars.indexOf(char);
        return index >= 0 ? toChars[index] : char;
      })
      .join("");
  for (const sample of [
    "açaí bowls",
    "crème brûlée",
    "jalapeño",
    "piña colada",
    "café",
    "pâté",
    "façade",
    "naïve",
    "señor",
    "zürich",
    "gâteau",
    "smörgåsbord",
  ]) {
    assert.equal(translateSim(sample), foldScoutSearchText(sample), sample);
  }
  assert.match(routes, /translate\(lower\(coalesce/);
  assert.match(routes, /foldScoutSearchText\(query\.trim\(\)\)/);
  assert.match(routes, /foldScoutSearchText\(value\)/);
});

test("/api/menus/local-items folds the query and the stored text", () => {
  const menuRoutes = readFileSync(
    new URL("../server/routes/menuRoutes.ts", import.meta.url),
    "utf8",
  );
  const handlerStart = menuRoutes.indexOf('"/api/menus/local-items",');
  assert.ok(handlerStart >= 0, "local-items handler exists");
  const handler = menuRoutes.slice(handlerStart, handlerStart + 40000);
  const foldUses = handler.match(/foldScoutSearchText/g) || [];
  assert.ok(
    foldUses.length >= 5,
    `local-items handler folds query prep, haystacks, and scoring fields (found ${foldUses.length})`,
  );
  assert.match(handler, /const q = foldScoutSearchText\(/);
});
