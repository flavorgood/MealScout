import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serveStatic } from "../server/vite";
import { publicMenuDocumentId, renderMenuHtml } from "../server/seo/menuHtml";
import { publicMenuFixture, SYNTHETIC_MENU_ID as id } from "./qa/public-menu-fixture";
import { publicMenuPageMetadata } from "../shared/publicMenuPage";

const fixture = publicMenuFixture();
const template = fs.readFileSync(new URL("../client/index.html", import.meta.url), "utf8");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mealscout-menu-document-"));
fs.writeFileSync(path.join(directory, "index.html"), template);
let failing = false;
const reads: string[] = [];
const app = express();
app.use((req, res, next) => {
  if (req.get("Host") === "preview.example.test") res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  // Existing generic tracking middleware's output, independently reproduced
  // from native index.ts: the menu document must reconcile this Link header.
  if (req.query.ref) res.setHeader("Link", `<https://www.mealscout.us/menu/${id}?menuId=dinner>; rel="canonical"`);
  next();
});
serveStatic(app, { distPath: directory, loadPublicMenu: async key => {
  reads.push(key);
  if (failing) throw new Error("Synthetic data failure: private diagnostic must not appear");
  return key === "public-unclaimed" ? { ...fixture, parentIndexable: false } : key === id ? fixture : null;
} });
const server = app.listen(0, "127.0.0.1");
let base: string;
before(async () => { if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); });
const get = (url = `/menu/${id}`, ua = "Mozilla/5.0", headers: Record<string, string> = {}) =>
  new Promise<{ status: number; headers: Headers; html: string }>((resolve, reject) => {
    const request = http.request(base + url, { headers: { Accept: "text/html", "User-Agent": ua, ...headers } }, response => {
      let html = ""; response.setEncoding("utf8"); response.on("data", chunk => { html += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, headers: new Headers(response.headers as Record<string, string>), html }));
    });
    request.once("error", reject); request.end();
  });
const menuSchema = (html: string) => [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1])).find(schema => schema["@type"] === "Menu");

test("actual static/menu document pipeline serves identical native public facts for human and crawler before JS", async () => {
  const human = await get();
  assert.equal(human.status, 200);
  assert.equal(human.headers.get("cache-control"), "private, no-store");
  assert.match(human.html, /<h1[^>]*>Synthetic Native Kitchen<\/h1>/);
  for (const text of ["Synthetic lunch plate", "$8.25", "Price unavailable", "Uncategorized synthetic side", "Browse the menu"]) assert.ok(human.html.includes(text));
  assert.ok(human.html.includes('data-public-menu-shell="warm-food-led"'));
  assert.ok(human.html.includes('href="/menu/synthetic-menu-vendor?menuId=dinner"'));
  assert.ok(human.html.includes('<script type="module" src="/src/main.tsx"></script>'));
  assert.ok(human.html.includes('rel="canonical" href="https://www.mealscout.us/menu/' + id + '"'));
  assert.equal(menuSchema(human.html).hasMenuSection[0].hasMenuItem[0].offers.price, "8.25");
  assert.equal(menuSchema(human.html).hasMenuSection[0].hasMenuItem[1].offers, undefined);
  for (const ua of ["Googlebot/2.1", "OAI-SearchBot/1.0"]) assert.equal((await get(undefined, ua)).html, human.html);
  for (const ua of ["Mozilla/5.0", "Googlebot/2.1"]) {
    for (const accept of ["*/*", "", "application/xhtml+xml"]) assert.equal((await get(undefined, ua, { Accept: accept })).html, human.html);
  }
});
test("functional menu selection changes raw facts, preserves attribution links and keeps a clean canonical", async () => {
  const result = await get(`/menu/${id}?menuId=dinner&ref=synthetic&returnTo=%2Fbar%2Ftest--${id}`);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("link"), `<https://www.mealscout.us/menu/${id}>; rel="canonical"`);
  assert.ok(result.html.includes("Synthetic dinner plate"));
  assert.ok(!result.html.includes("Synthetic lunch plate"));
  assert.ok(result.html.includes("$0.00"));
  assert.ok(result.html.includes(`href="/bar/test--${id}"`));
  assert.ok(result.html.includes("menuId=lunch&amp;ref=synthetic"));
  assert.ok(result.html.includes('content="noindex, nofollow"'));
  assert.ok(result.html.includes(`rel="canonical" href="https://www.mealscout.us/menu/${id}"`));
});
test("a reader-rejected projection produces404 without entity facts or homepage success", async () => {
  for (const key of ["rejected-projection", "missing"]) {
    const result = await get("/menu/" + key);
    assert.equal(result.status, 404);
    assert.match(result.headers.get("x-robots-tag") || "", /noindex/);
    assert.ok(result.html.includes("Menu not found"));
    assert.ok(!result.html.includes(fixture.restaurantName));
    assert.equal(menuSchema(result.html), undefined);
    assert.ok(!result.html.includes('data-testid="welcome-landing"'));
  }
});
test("a visible but nonindexable parent keeps its real menu visible without index or Menu schema", async () => {
  const result = await get("/menu/public-unclaimed");
  assert.equal(result.status, 200);
  assert.ok(result.html.includes("Synthetic lunch plate"));
  assert.ok(result.html.includes('content="noindex, nofollow"'));
  assert.equal(menuSchema(result.html), undefined);
});
test("lookup failure is an explicit unavailable response and the next read recovers without stale facts", async () => {
  failing = true;
  try {
    const result = await get();
    assert.equal(result.status, 503);
    assert.ok(result.html.includes("Menu could not be loaded"));
    assert.ok(!result.html.includes(fixture.restaurantName));
    assert.ok(!result.html.includes("private diagnostic"));
    assert.ok(result.html.includes("Retry menu"));
    assert.equal(menuSchema(result.html), undefined);
  } finally { failing = false; }
  assert.equal((await get()).status, 200);
});
test("preview and hostile host/query values cannot change canonical authority or indexability", async () => {
  const result = await get(`/menu/${id}?canonical=https://attacker.invalid`, undefined, { Host: "preview.example.test" });
  assert.equal(result.status, 200);
  assert.ok(result.html.includes('content="noindex, nofollow"'));
  assert.ok(result.html.includes(`rel="canonical" href="https://www.mealscout.us/menu/${id}"`));
});
test("empty active-menu data stays truthful and does not invent schema or public menu items", () => {
  const html = renderMenuHtml(template, "https://www.mealscout.us", `/menu/${id}`, id, { ...fixture, menus: [] });
  assert.ok(html.includes("Menu coming soon"));
  assert.ok(html.includes('content="noindex, nofollow"'));
  assert.equal(menuSchema(html), undefined);
});
test("dynamic menu facts and structured data are escaped rather than interpreted as markup or replacement syntax", () => {
  const hostile = { ...fixture, restaurantName: 'Kitchen $& </script><script>alert(1)</script> "quoted"' };
  const html = renderMenuHtml(template, "https://www.mealscout.us", `/menu/${id}`, id, hostile);
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("$&amp;"));
  assert.ok(menuSchema(html).name.includes(hostile.restaurantName));
});
test("mounted route classification is bounded to menu GET documents; health/API/private/asset paths do not query menus", async () => {
  const mounted = express();
  mounted.use("*", (req, res) => res.json({ id: publicMenuDocumentId(req) }));
  const listener = mounted.listen(0, "127.0.0.1");
  if (!listener.listening) await new Promise<void>(resolve => listener.once("listening", resolve));
  try {
    const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    for (const [route, expected] of [[`/menu/${id}`, id], ["/scout", null], ["/menu/a/child", null], ["/menu/a%2Fb", null], ["/admin", null], ["/api/menus/a", null]]) {
      const result = await fetch(origin + route, { headers: { Accept: "text/html" } }).then(r => r.json());
      assert.equal(result.id, expected);
    }
    const before = reads.length;
    await fetch(base + `/menu/${id}`, { method: "HEAD" });
    await get(undefined, undefined, { Accept: "application/json" });
    assert.equal(reads.length, before);
  } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
});
test("menu metadata preserves null prices and uses only actual active-menu facts", () => {
  const meta = publicMenuPageMetadata(id, fixture);
  assert.equal(meta.noIndex, false);
  assert.equal(meta.schema?.name, "Synthetic Native Kitchen — Lunch menu");
  assert.equal(meta.schema?.hasMenuSection[0].hasMenuItem[1].offers, undefined);
});
