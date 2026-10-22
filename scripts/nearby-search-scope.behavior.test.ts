import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchSearchJson, searchArray, unifiedSearchResult, validSearchLocation, withinSearchRadius } from "../client/src/lib/search-scope";

const origin = { lat: 30, lng: -90 };

test("public nearby membership excludes outside, missing, blank and invalid coordinates", () => {
  assert.equal(withinSearchRadius({ latitude: 30.01, longitude: -90 }, origin, 12), true);
  assert.equal(withinSearchRadius({ latitude: 30.5, longitude: -90 }, origin, 12), false);
  for (const row of [{}, { latitude: null, longitude: null }, { latitude: "", longitude: "" }, { latitude: 91, longitude: -90 }]) {
    assert.equal(withinSearchRadius(row, origin, 12), false);
  }
  // Published live coordinates supersede a public static location.
  assert.equal(withinSearchRadius({ latitude: 30, longitude: -90, currentLatitude: 31, currentLongitude: -90 }, origin, 12), false);
  assert.equal(withinSearchRadius({ latitude: "30.01", longitude: "-90" }, origin, 12), true);
});

test("radius changes only membership and supports zero coordinates and the date line", () => {
  const row = { latitude: 30.1, longitude: -90 };
  assert.equal(withinSearchRadius(row, origin, 12), true);
  assert.equal(withinSearchRadius(row, origin, 3), false);
  assert.equal(withinSearchRadius({ latitude: 0, longitude: 0 }, { lat: 0, lng: 0 }, 3), true);
  assert.equal(withinSearchRadius({ latitude: 0, longitude: -179.99 }, { lat: 0, lng: 179.99 }, 3), true);
  assert.equal(validSearchLocation({ lat: "30", lng: -90 }), false);
  assert.equal(validSearchLocation({ lat: 30, lng: -90, label: {} }), false);
});

test("empty collections remain valid while malformed source responses become errors", () => {
  assert.deepEqual(searchArray([]), []);
  for (const value of [null, {}, [null], ["restaurant"], [[]]]) assert.throws(() => searchArray(value));
  const empty = { restaurants: [], deals: [], parkingPassHosts: [], videos: [], events: [] };
  assert.deepEqual(unifiedSearchResult(empty), empty);
  assert.throws(() => unifiedSearchResult({ restaurants: [] }));
  assert.throws(() => unifiedSearchResult({ ...empty, deals: {} }));
  assert.throws(() => searchArray([{ id: "", name: "broken" }], ["id", "name"]));
  assert.throws(() => unifiedSearchResult({ ...empty, restaurants: [{ id: "r", name: 42 }] }));
  for (const deal of [
    { id: "d", title: 42 },
    { id: "d", title: "Tacos", description: {} },
    { id: "d", title: "Tacos", restaurant: { name: [] } },
    { id: "d", title: "Tacos", restaurant: { cuisineType: 42 } },
  ]) assert.throws(() => unifiedSearchResult({ ...empty, deals: [deal] }));
  assert.throws(() => searchArray([{ id: "r", name: "Tacos", cuisineType: {} }], ["id", "name"]));
  assert.throws(() => searchArray([{ id: "m", name: "Tacos", restaurantId: "r", restaurantName: {} }], ["id", "name", "restaurantId"]));
  assert.deepEqual(unifiedSearchResult({ ...empty, deals: [{ id: "d", title: "Tacos", description: null, restaurant: { name: "Fixture", cuisineType: null } }] }).deals.length, 1);
});

test("a failed or malformed GET is retryable and does not become an empty result", async () => {
  const original = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    return attempts === 1 ? new Response("unavailable", { status: 503 }) : Response.json([]);
  }) as typeof fetch;
  try {
    await assert.rejects(fetchSearchJson("https://synthetic.invalid/api/search"), /unavailable/);
    assert.deepEqual(await fetchSearchJson("https://synthetic.invalid/api/search"), []);
    assert.equal(attempts, 2);
    globalThis.fetch = (async () => new Response("not JSON")) as typeof fetch;
    await assert.rejects(fetchSearchJson("https://synthetic.invalid/api/search"));
  } finally { globalThis.fetch = original; }
});

test("a delayed read times out and a superseded read honors cancellation", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url, options) => new Promise((_resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) reject(new DOMException("Aborted", "AbortError"));
    else signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  })) as typeof fetch;
  try {
    await assert.rejects(fetchSearchJson("https://synthetic.invalid/api/search", undefined, 10), /timed out/);
    const controller = new AbortController();
    const pending = fetchSearchJson("https://synthetic.invalid/api/search", controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
  } finally { globalThis.fetch = original; }
});
