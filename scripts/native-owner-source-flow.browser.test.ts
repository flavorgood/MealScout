import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { chromium, expect, type Page, type Route } from "@playwright/test";

// Actual component, widgets, API client and React Query in Chromium. Synthetic
// owner responses only: no database, customer session or production mutation.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "package.json"));
const component = resolve(root, "client/src/components/native-profile-source-control.tsx");
const entry = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {getQueryFn} from '@/lib/queryClient';
import Control from ${JSON.stringify(component)};
const client=new QueryClient({defaultOptions:{queries:{queryFn:getQueryFn({on401:'throw'}),retry:false,refetchOnWindowFocus:false}}});
window.refreshFixture=()=>client.invalidateQueries();
createRoot(document.getElementById('app')).render(<QueryClientProvider client={client}><Control/></QueryClientProvider>);`;
const files: Plugin = { name: "source-files", setup(builder) {
  builder.onResolve({ filter: /.*/ }, args => {
    let candidate = args.path.startsWith("@/") ? resolve(root, "client/src", args.path.slice(2))
      : args.path.startsWith("@shared/") ? resolve(root, "shared", args.path.slice(8)) : null;
    if (candidate) {
      candidate = [candidate, candidate + ".tsx", candidate + ".ts", candidate + ".js", resolve(candidate, "index.ts")].find(existsSync) || candidate;
    }
    const resolver = args.importer && args.importer !== "<stdin>" ? createRequire(args.importer) : require;
    return { path: candidate || resolver.resolve(args.path), namespace: "source-file" };
  });
  builder.onLoad({ filter: /.*/, namespace: "source-file" }, args => ({ contents: readFileSync(args.path, "utf8"), loader: args.path.endsWith(".tsx") ? "tsx" : args.path.endsWith(".ts") ? "ts" : args.path.endsWith(".json") ? "json" : "js" }));
} };
const bundled = await build({ stdin: { contents: entry, resolveDir: root, loader: "tsx" }, tsconfigRaw: {}, plugins: [files], bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"DEV":true}' }, logLevel: "silent" });
const bundle = bundled.outputFiles[0].text;
const server = createServer((req, res) => {
  res.setHeader("Content-Type", req.url === "/bundle.js" ? "application/javascript" : "text/html");
  res.end(req.url === "/bundle.js" ? bundle : '<div id="app"></div><script src="/bundle.js"></script>');
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
server.unref();
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const profiles = [{ kind: "host", id: "11111111-1111-4111-8111-111111111111", name: "Profile A", aliases: ["location"] }, { kind: "supplier", id: "22222222-2222-4222-8222-222222222222", name: "Profile B", aliases: [] }];
const version = (char: string) => char.repeat(64);
const base = (index = 0) => `/api/owner-ai/native-profiles/${profiles[index].kind}/${profiles[index].id}`;
function draft(id: string, index = 0, contextVersion = version("a"), contentHash = version("d")) {
  return { id, targetKind: profiles[index].kind, targetId: profiles[index].id, revision: 1, status: "draft", contextVersion, contentHash, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), snapshot: { websiteUrl: "https://old.example" }, packet: { profile: { websiteUrl: `https://${id}.example` } } };
}
type Draft = ReturnType<typeof draft>;
type Post = { path: string; body: any };
type Fixture = { page: Page; posts: Post[]; counts: Map<string, number>; versions: string[]; websites: string[]; drafts: Draft[][]; contextFailure: boolean; post: (route: Route, path: string, body: any) => Promise<unknown>; errors: string[] };
async function fixture(initial: Draft[][] = [[], []]) {
  const page = await browser.newPage();
  const state: Fixture = { page, posts: [], counts: new Map(), versions: [version("a"), version("b")], websites: ["https://old.example", "https://supplier.example"], drafts: initial, contextFailure: false, post: async route => json(route, { draft: null, holds: [] }), errors: [] };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname;
    state.counts.set(path, (state.counts.get(path) || 0) + 1);
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      state.posts.push({ path, body });
      return state.post(route, path, body);
    }
    if (path === "/api/owner-ai/native-profiles") return json(route, profiles);
    const index = profiles.findIndex((_, i) => path.startsWith(base(i)));
    assert.ok(index >= 0, `Unexpected fixture GET ${path}`);
    if (path.endsWith("/context")) return state.contextFailure ? json(route, { message: "Fixture context unavailable" }, 503) : json(route, { kind: profiles[index].kind, id: profiles[index].id, version: state.versions[index], profile: { websiteUrl: state.websites[index] }, officialSources: [state.websites[index]] });
    if (path.endsWith("/drafts")) return json(route, state.drafts[index]);
    throw new Error(`Unexpected fixture GET ${path}`);
  });
  await page.goto(origin);
  await expect(page.getByRole("button", { name: "Check official sources", exact: true })).toBeEnabled();
  return state;
}
function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
async function switchProfile(f: Fixture, index: number) {
  await f.page.locator("select").selectOption(`${profiles[index].kind}/${profiles[index].id}`);
  await expect(f.page.locator('input[type="url"]')).toHaveValue(f.websites[index]);
}
async function refresh(f: Fixture) {
  await f.page.evaluate(() => (window as any).refreshFixture());
}
async function close(f: Fixture) {
  assert.deepEqual(f.errors, [], "No browser rendering errors");
  await f.page.close();
}
const passed: string[] = [];
try {
  for (const fail of [false, true]) {
    const f = await fixture();
    let release!: () => void;
    const deferred = new Promise<void>(done => { release = done; });
    f.post = async (route, path) => {
      if (path === base() + "/source-draft") {
        await deferred;
        return fail ? json(route, { message: "Profile A action failed" }, 409) : json(route, { draft: draft("profile-a"), holds: [] });
      }
      return json(route, {});
    };
    await f.page.getByRole("button", { name: "Check official sources", exact: true }).click();
    await expect.poll(() => f.posts.length).toBe(1);
    await switchProfile(f, 1);
    await expect(f.page.getByRole("button", { name: "Prepare website draft", exact: true })).toBeEnabled();
    release();
    await expect.poll(() => f.counts.get(base() + "/context")).toBe(2);
    await expect(f.page.locator('[role="status"]')).toHaveCount(0);
    assert.equal(f.posts[0].path, base() + "/source-draft");
    await close(f);
    passed.push(`Late A ${fail ? "failure" : "success"} cannot appear in B`);
  }
  {
    const f = await fixture();
    let release!: () => void;
    const deferred = new Promise<void>(done => { release = done; });
    f.post = async route => { await deferred; return json(route, { draft: null, holds: ["MISSING_OFFICIAL_SOURCE"] }); };
    await f.page.getByRole("button", { name: "Check official sources", exact: true }).click();
    await expect.poll(() => f.posts.length).toBe(1);
    await switchProfile(f, 1);
    await switchProfile(f, 0);
    await expect(f.page.getByRole("button", { name: "Check official sources", exact: true })).toBeDisabled();
    await f.page.getByRole("button", { name: "Check official sources", exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    assert.equal(f.posts.length, 1, "Pending profile action cannot be duplicated after a round trip");
    release();
    await expect(f.page.getByRole("button", { name: "Check official sources", exact: true })).toBeEnabled();
    await expect(f.page.locator('[role="status"]')).toHaveCount(0);
    await close(f);
    passed.push("A -> B -> A preserves the pending action lock and clears old status");
  }
  {
    const f = await fixture([[draft("old-context")], []]);
    f.post = async (route, _path, body) => {
      if (f.posts.length === 1) {
        f.versions[0] = version("c");
        f.websites[0] = "https://fresh.example";
        return json(route, { code: "STALE_NATIVE_CONTEXT", message: "Profile changed; prepare again" }, 409);
      }
      assert.equal(body.expectedVersion, version("c"));
      return json(route, {});
    };
    await f.page.getByRole("button", { name: "Prepare website draft", exact: true }).click();
    await expect(f.page.getByText("Profile changed; prepare again", { exact: true })).toBeVisible();
    await expect(f.page.locator('input[type="url"]')).toHaveValue("https://fresh.example");
    await expect(f.page.locator('input[type="checkbox"]')).toBeDisabled();
    await f.page.getByRole("button", { name: "Prepare website draft", exact: true }).click();
    await expect(f.page.getByText("Website draft prepared. Review it below before approving.", { exact: true })).toBeVisible();
    assert.equal(f.posts[0].body.expectedVersion, version("a"));
    assert.equal(f.posts[1].body.expectedVersion, version("c"));
    assert.ok((f.counts.get(base() + "/context") || 0) >= 3);
    assert.ok((f.counts.get(base() + "/drafts") || 0) >= 3);
    await close(f);
    passed.push("STALE_NATIVE_CONTEXT refreshes context and drafts before a fresh-version retry");
  }
  {
    const newest = draft("newest"), older = draft("older", 0, version("a"), version("e"));
    const f = await fixture([[newest, older], []]);
    f.post = async (route, path, body) => {
      assert.equal(path, `/api/owner-ai/native-profiles/drafts/${newest.id}/approve`);
      assert.deepEqual(body, { expectedRevision: newest.revision, expectedContentHash: newest.contentHash });
      newest.status = "applied";
      f.versions[0] = version("f");
      f.websites[0] = "https://newest.example";
      return json(route, newest);
    };
    await expect(f.page.getByText(`Draft ${newest.id}, revision 1. Content hash: ${newest.contentHash}`, { exact: true })).toBeVisible();
    await f.page.locator('input[type="checkbox"]').check();
    await f.page.getByRole("button", { name: "Approve this draft", exact: true }).click();
    await expect(f.page.getByText("Approved changes saved to your native public profile.", { exact: true })).toBeVisible();
    await expect(f.page.locator("dl")).toContainText("Current: https://newest.example");
    await expect(f.page.locator("dl")).toContainText("When drafted: https://old.example");
    await expect(f.page.locator("dl")).toContainText("Proposed: https://older.example");
    await expect(f.page.locator('input[type="checkbox"]')).toBeDisabled();
    await expect(f.page.getByRole("button", { name: "Approve this draft", exact: true })).toBeDisabled();
    assert.equal(f.posts.length, 1);
    await close(f);
    passed.push("Applying D2 displays actual current values and holds older stale D1 without approval");
  }
  {
    const first = draft("first"), replacement = draft("replacement", 0, version("a"), first.contentHash);
    const other = draft("other", 1, version("b"), first.contentHash);
    const f = await fixture([[first], [other]]);
    await f.page.locator('input[type="checkbox"]').check();
    await expect(f.page.getByRole("button", { name: "Approve this draft", exact: true })).toBeEnabled();
    f.drafts[0] = [replacement];
    await refresh(f);
    await expect(f.page.getByText(`Draft ${replacement.id}, revision 1. Content hash: ${replacement.contentHash}`, { exact: true })).toBeVisible();
    await expect(f.page.locator('input[type="checkbox"]')).not.toBeChecked();
    await expect(f.page.getByRole("button", { name: "Approve this draft", exact: true })).toBeDisabled();
    await f.page.locator('input[type="checkbox"]').check();
    replacement.revision = 2;
    await refresh(f);
    await expect(f.page.getByText(`Draft ${replacement.id}, revision 2. Content hash: ${replacement.contentHash}`, { exact: true })).toBeVisible();
    await expect(f.page.locator('input[type="checkbox"]')).not.toBeChecked();
    await f.page.locator('input[type="checkbox"]').check();
    await switchProfile(f, 1);
    await expect(f.page.locator('input[type="checkbox"]')).not.toBeChecked();
    await expect(f.page.getByRole("button", { name: "Approve this draft", exact: true })).toBeDisabled();
    assert.equal(f.posts.length, 0);
    await close(f);
    passed.push("Equal hashes on different drafts, revisions or profiles do not carry consent");
  }
  for (const invalid of ["target", "version"] as const) {
    const invalidDraft = draft("invalid");
    if (invalid === "target") invalidDraft.targetId = profiles[1].id;
    else delete (invalidDraft as Partial<Draft>).contextVersion;
    const f = await fixture([[invalidDraft], []]);
    await expect(f.page.locator('input[type="checkbox"]')).toBeDisabled();
    await expect(f.page.getByRole("button", { name: "Approve this draft", exact: true })).toBeDisabled();
    assert.equal(f.posts.length, 0);
    await close(f);
    passed.push(`Draft with ${invalid === "target" ? "wrong target" : "missing context version"} cannot be approved`);
  }
  {
    const f = await fixture([[draft("recovery")], []]);
    await f.page.locator('input[type="checkbox"]').check();
    f.post = async route => { f.contextFailure = true; return json(route, { message: "Profile changed; prepare again" }, 409); };
    await f.page.getByRole("button", { name: "Prepare website draft", exact: true }).click();
    await expect(f.page.getByText("Current profile details could not load. Refresh before preparing or approving a draft.", { exact: true })).toBeVisible();
    await expect(f.page.getByRole("button", { name: "Prepare website draft", exact: true })).toBeDisabled();
    await expect(f.page.getByRole("button", { name: "Check official sources", exact: true })).toBeDisabled();
    await expect(f.page.getByRole("button", { name: "Approve this draft", exact: true })).toBeDisabled();
    await expect(f.page.locator('input[type="checkbox"]')).not.toBeChecked();
    assert.equal(f.posts.length, 1);
    await close(f);
    passed.push("Failed refresh holds preparation and consent despite cached context");
  }
  {
    const f = await fixture();
    let release!: () => void;
    const deferred = new Promise<void>(done => { release = done; });
    f.post = async route => { await deferred; return json(route, {}); };
    await f.page.locator('[data-testid="native-profile-source-control"]').evaluate(control => {
      const buttons = Array.from(control.querySelectorAll("button"));
      (buttons.find(button => button.textContent === "Prepare website draft") as HTMLButtonElement).click();
      (buttons.find(button => button.textContent === "Check official sources") as HTMLButtonElement).click();
    });
    await expect.poll(() => f.posts.length).toBe(1);
    release();
    await expect(f.page.getByRole("button", { name: "Prepare website draft", exact: true })).toBeEnabled();
    assert.equal(f.posts.length, 1, "Same-task competing actions send only one request");
    await close(f);
    passed.push("Synchronous competing actions cannot send concurrent profile writes");
  }
  {
    const f = await fixture();
    f.post = async route => json(route, { draft: null, holds: ["MISSING_OFFICIAL_SOURCE", "UNKNOWN_RAW_SOURCE_BODY_https://private.example"] });
    await f.page.getByRole("button", { name: "Check official sources", exact: true }).click();
    await expect(f.page.locator('[role="status"]')).toContainText("Add and approve an official public website");
    await expect(f.page.locator('[role="status"]')).not.toContainText("UNKNOWN_RAW_SOURCE_BODY");
    await expect(f.page.locator('[role="status"]')).not.toContainText("private.example");
    await close(f);
    passed.push("Source holds explain the next step without exposing unknown source text");
  }
  console.log(JSON.stringify({ result: "PASS", scope: "Actual component, UI widgets, API client, React Query and Chromium; deterministic HTTP fixtures only", cases: passed }, null, 2));
} finally {
  await browser.close();
  server.close();
}
