"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { MuseServer } = require("../src/server");

function request(port, urlPath, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("admin & v1 API only trust same-origin, local tools, or a valid key", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-auth-test-"));
  const srv = new MuseServer({ rootDir: path.resolve(__dirname, ".."), dataDir, port: 0 });
  await srv.start();
  t.after(async () => {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const { port } = srv;
  const key = srv.store.settings.apiKey;
  const evil = "https://evil.example";

  assert.strictEqual(await request(port, "/admin/settings"), 200, "local tool / same-origin GET");
  assert.strictEqual(await request(port, "/admin/settings", { headers: { Origin: `http://127.0.0.1:${port}` } }), 200);
  assert.strictEqual(await request(port, "/admin/settings", { headers: { Origin: evil } }), 401, "foreign site");
  assert.strictEqual(await request(port, "/admin/settings", { headers: { Origin: "null" } }), 401, "sandboxed/file origin");
  assert.strictEqual(await request(port, "/admin/settings", { headers: { Host: "rebind.evil.example" } }), 401, "DNS rebinding");
  assert.strictEqual(
    await request(port, "/admin/settings", { headers: { Origin: evil, Authorization: `Bearer ${key}` } }),
    200,
    "extension / userscript with key"
  );
  assert.strictEqual(await request(port, "/admin/settings", { headers: { Authorization: "Bearer wrong" } }), 401);
  assert.strictEqual(await request(port, "/v1/models", { headers: { Origin: evil } }), 401);
  assert.strictEqual(await request(port, "/v1/models", { headers: { Authorization: `Bearer ${key}` } }), 200);
  assert.strictEqual(await request(port, "/", { headers: { Origin: evil } }), 200, "UI page stays public");

  const badJson = await request(port, "/admin/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.strictEqual(badJson, 400, "malformed JSON is rejected instead of saving {}");
});
