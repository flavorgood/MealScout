import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { registerPublicProfileAppAssets } from "../server/seo/publicProfileAppAssets";
import { PUBLIC_PROFILE_APP_ASSET_PATH } from "../shared/publicProfileAppAssetPaths";

test("Render asset alias serves public compiled bytes and terminates missing or private paths before API/SPA", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mealscout-public-assets-"));
  const assets = path.join(directory, "assets");
  await mkdir(assets);
  await writeFile(path.join(assets, "profile-hash.js"), "export const publicProfile = true;");
  await writeFile(path.join(assets, "profile-hash.css"), "body { color: orange; }");
  await writeFile(path.join(assets, ".private"), "PRIVATE_CANARY");
  await writeFile(path.join(directory, "server-secret.js"), "PRIVATE_CANARY");
  const app = express();
  registerPublicProfileAppAssets(app, assets);
  app.use((_req, res) => res.type("html").send("SPA_CANARY"));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const [file, type] of [["profile-hash.js", /javascript/], ["profile-hash.css", /text\/css/]] as const) {
      const response = await fetch(`${base}${PUBLIC_PROFILE_APP_ASSET_PATH}/${file}`);
      assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, type);
      assert.match(response.headers.get("cache-control")!, /immutable/);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.doesNotMatch(await response.text(), /PRIVATE_CANARY|SPA_CANARY/);
    }
    for (const suffix of ["/missing.js", "/missing.css", "/.private", "/", "/%2e%2e%2fserver-secret.js", "/%2eprivate"]) {
      const response = await fetch(`${base}${PUBLIC_PROFILE_APP_ASSET_PATH}${suffix}`);
      assert.equal(response.status, 404, suffix); assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(response.headers.get("content-type")!, /text\/plain/);
      assert.doesNotMatch(await response.text(), /PRIVATE_CANARY|SPA_CANARY/);
    }
    const head = await fetch(`${base}${PUBLIC_PROFILE_APP_ASSET_PATH}/profile-hash.js`, { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(await head.text(), "");
    const write = await fetch(`${base}${PUBLIC_PROFILE_APP_ASSET_PATH}/profile-hash.js`, { method: "POST" });
    assert.equal(write.status, 404); assert.equal(write.headers.get("cache-control"), "no-store");
    assert.equal(await (await fetch(base + "/unrelated")).text(), "SPA_CANARY");
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  }
});
