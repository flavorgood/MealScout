import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

// Execute the current ordered regex route table over loopback HTTP and a real
// disposable filesystem. This is configuration behavior proof, not a Vercel
// deployment or an emulator of every platform feature. No external proxy runs.
test("current profile edge routes preserve native destinations and static failures", async () => {
  const config = JSON.parse(await readFile("vercel.json", "utf8"));
  const root = await mkdtemp(path.join(tmpdir(), "mealscout-profile-edge-"));
  await mkdir(path.join(root, "assets"));
  await mkdir(path.join(root, "static"));
  await writeFile(path.join(root, "assets", "profile.js"), "export const profile = true;");
  await writeFile(path.join(root, "static", "profile.css"), "body { color: orange; }");
  await writeFile(path.join(root, "index.html"), "<html>SPA_FIXTURE</html>");
  const backend = express();
  backend.use((req, res) => res.json({ nativePath: req.originalUrl }));
  const origin = backend.listen(0, "127.0.0.1"); await once(origin, "listening");
  const address = origin.address(); assert.ok(address && typeof address !== "string");
  const nativeOrigin = `http://127.0.0.1:${address.port}`;
  const app = express();
  const filesystem = express.static(root);
  app.use((req, res, next) => {
    let index = 0;
    const dispatch = (): void => {
      const rule = config.routes[index++];
      if (!rule) { res.status(404).end(); return; }
      if (rule.handle === "filesystem") { filesystem(req, res, dispatch); return; }
      const match = new RegExp(`^(?:${rule.src})$`).exec(req.path);
      if (!match) { dispatch(); return; }
      if (rule.has?.some((condition: any) => condition.type !== "header" ||
        !new RegExp(condition.value).test(String(req.get(condition.key) || "")))) {
        dispatch(); return;
      }
      for (const [name, value] of Object.entries(rule.headers || {})) res.set(name, String(value));
      if (rule.continue) { dispatch(); return; }
      if (rule.status) { res.status(rule.status).type("text/plain").send("Missing static asset"); return; }
      const destination = String(rule.dest).replace(/\$(\d+)/g, (_: string, n: string) => match[Number(n)] || "");
      if (destination === "/index.html") { res.sendFile(path.join(root, "index.html")); return; }
      const target = new URL(destination);
      assert.equal(target.origin, "https://mealscout.onrender.com");
      const query = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
      void fetch(nativeOrigin + target.pathname + query).then(async response => {
        res.status(response.status).json(await response.json());
      }).catch(next);
    };
    dispatch();
  });
  const edge = app.listen(0, "127.0.0.1"); await once(edge, "listening");
  const edgeAddress = edge.address(); assert.ok(edgeAddress && typeof edgeAddress !== "string");
  const base = `http://127.0.0.1:${edgeAddress.port}`;
  try {
    for (const file of ["/assets/profile.js", "/static/profile.css"]) {
      const response = await fetch(base + file);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type")!, file.endsWith("js") ? /javascript/ : /text\/css/);
      assert.match(response.headers.get("cache-control")!, /immutable/);
      assert.doesNotMatch(await response.text(), /SPA_FIXTURE/);
    }
    for (const file of ["/assets/missing.js", "/assets/missing.css", "/static/missing.js", "/static/missing.css"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(base + file, { method });
        assert.equal(response.status, 404, `${method} ${file}`);
        assert.doesNotMatch(await response.text(), /SPA_FIXTURE/);
      }
    }
    for (const kind of ["restaurant", "truck", "bar", "caterer", "private-chef", "location", "supplier"]) {
      for (const agent of ["MealScoutSyntheticBrowser", "MealScoutSyntheticBot"]) {
        const route = `/${kind}/synthetic--a0000000-0000-4000-8000-000000000001?view=app`;
        const response = await fetch(base + route, { headers: { "user-agent": agent } });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).nativePath, route);
      }
    }
    for (const route of ["/p/truck/synthetic", "/suppliers/a0000000-0000-4000-8000-000000000001?view=app", "/api/public/profiles/truck/synthetic"]) {
      assert.equal((await (await fetch(base + route)).json()).nativePath, route);
    }
    for (const route of ["/scout", "/deals/featured", "/events/public"]) {
      assert.match(await (await fetch(base + route)).text(), /SPA_FIXTURE/);
    }
  } finally {
    for (const server of [edge, origin]) {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await rm(root, { recursive: true });
  }
});
