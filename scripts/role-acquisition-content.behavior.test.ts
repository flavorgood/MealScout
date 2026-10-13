import assert from "node:assert/strict";
import test, { after } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import RoleLandingPage from "../client/src/components/role-landing";
import { roleLandingContent } from "../client/src/content/role-landing";
import { roleAcquisitionGuides } from "../shared/roleAcquisitionContent";
import { registerAcquisitionPrerenderRoutes } from "../server/seo/acquisitionPrerender";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("No network is allowed in acquisition rendering proof"); };
after(() => { globalThis.fetch = originalFetch; });

const routes = new Map<string, Function>();
registerAcquisitionPrerenderRoutes({ get(path: string, handler: Function) { routes.set(path, handler); } } as any, "https://www.mealscout.us");
const serve = (path: string, ua = "Googlebot/2.1", query: object = {}) => {
  let html = "", nextCalls = 0;
  const headers = new Map<string, string>();
  routes.get(path)!({ query, get: () => ua }, {
    setHeader(name: string, value: string) { headers.set(name, value); },
    send(value: string) { html = value; },
  }, () => { nextCalls++; });
  return { html, headers, nextCalls };
};
const textFrom = (html: string) => html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
  .replace(/<[^>]*>/g, " ")
  .replace(/&#(?:39|x27);/gi, "'")
  .replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">")
  .replaceAll("&amp;", "&").replace(/\s+/g, " ");
const renderApp = (key: "truck" | "hosts") => renderToStaticMarkup(createElement(
  Router,
  { hook: () => [roleAcquisitionGuides[key].path, () => undefined] as [string, () => void] },
  createElement(RoleLandingPage, { content: roleLandingContent[key] }),
));

for (const key of ["truck", "hosts"] as const) {
  test(`${key}: actual app and crawler HTML expose the same complete planning answers`, () => {
    const guide = roleAcquisitionGuides[key];
    const content = roleLandingContent[key];
    assert.equal(content.guide, guide);
    assert.equal(content.seo.title, guide.title);
    assert.equal(content.seo.description, guide.description);
    assert.equal(content.seo.canonicalPath, guide.path);
    const app = renderApp(key);
    const bot = serve(guide.path);
    assert.equal(bot.nextCalls, 0);
    assert.equal(bot.headers.get("Content-Type"), "text/html; charset=utf-8");
    for (const html of [app, bot.html]) {
      const text = textFrom(html);
      assert.ok(text.includes(guide.headline));
      for (const section of guide.sections) {
        assert.ok(text.includes(section.title));
        for (const paragraph of section.paragraphs) assert.ok(text.includes(paragraph));
      }
      for (const example of guide.examples) {
        assert.ok(text.includes(example.title));
        assert.ok(text.includes(example.copy));
      }
      for (const faq of guide.questions) {
        assert.ok(text.includes(faq.question));
        assert.ok(text.includes(faq.answer));
      }
      assert.match(html, /href="\/parking-pass"/);
      for (const link of guide.relatedLinks) assert.ok(html.includes(link.href.replaceAll("&", "&amp;")));
      assert.ok(text.split(/\s+/).length > 600, "must expose substantive visible answers, not a three-paragraph teaser");
    }
    assert.ok(bot.html.includes('rel="canonical" href="https://www.mealscout.us' + guide.path + '"'));
    assert.ok(bot.html.includes("<title>" + guide.title.replaceAll("&", "&amp;") + "</title>"));
    for (const script of bot.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) JSON.parse(script[1]);
  });
}

test("existing browser and explicit prerender policy remains intact", () => {
  for (const guide of Object.values(roleAcquisitionGuides)) {
    assert.equal(serve(guide.path, "Mozilla/5.0 Chrome/152").nextCalls, 1);
    assert.equal(serve(guide.path, "Mozilla/5.0 Chrome/152").html, "");
    assert.ok(serve(guide.path, "Mozilla/5.0 Chrome/152", { prerender: "1" }).html.includes(guide.headline));
    assert.ok(serve(guide.path, "OAI-SearchBot/1.3").html.includes(guide.headline));
  }
});

test("unrelated acquisition routes retain their content and do not receive another role's guide", () => {
  for (const [path, headline] of [
    ["/for-restaurants", "Help local diners find your restaurant"],
    ["/host-location-partner", "Apply to become a MealScout host location partner"],
  ]) {
    const html = serve(path).html;
    assert.ok(html.includes(headline));
    assert.ok(!html.includes("Questions before you get started"));
    assert.ok(!html.includes(roleAcquisitionGuides.truck.headline));
    assert.ok(!html.includes(roleAcquisitionGuides.hosts.headline));
  }
});

test("both renderers escape guide text rather than turning it into executable HTML", () => {
  const paragraphs = roleAcquisitionGuides.truck.sections[0].paragraphs;
  const original = paragraphs[0];
  const probe = '<script>window.acquisitionProbe=1</script><img src=x onerror="probe()">';
  try {
    paragraphs[0] = probe;
    for (const html of [serve("/for-food-trucks").html, renderApp("truck")]) {
      assert.ok(!html.includes(probe));
      assert.ok(html.includes("&lt;script&gt;"));
      assert.ok(!html.includes('<img src=x onerror="probe()">'));
    }
  } finally { paragraphs[0] = original; }
});
