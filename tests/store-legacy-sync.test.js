"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Store } = require("../src/store");
const { MuseServer } = require("../src/server");

const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sess = (value) => [{ name: "hatch_sess", value }];
const writeJson = (dir, file, data) => fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
const readJson = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));

// Only ever "discover" the given legacy dir, so tests never touch real user folders.
function startStore(dataDir, legacyDir, options = {}) {
  class IsolatedStore extends Store {
    discoverLegacyDataDirs() {
      return [legacyDir];
    }
  }
  return new IsolatedStore(dataDir, { autoSyncLegacy: true, ...options });
}

function seedLegacy() {
  const legacy = tmpDir("muse-legacy-");
  writeJson(legacy, "batch-rows.json", [{ id: "r1", prompt: "p", status: "done", mediaUrl: "/media/a.mp4" }]);
  writeJson(legacy, "accounts.json", [{ name: "Acc1", email: "a@x", cookies: sess("OLD") }]);
  return legacy;
}

test("first start imports rows and accounts from the old version", () => {
  const store = startStore(tmpDir("muse-new-"), seedLegacy());

  assert.strictEqual(store.batchRows.length, 1);
  assert.strictEqual(store.accounts.length, 1);
});

test("deleted rows do not come back after restart", () => {
  const dataDir = tmpDir("muse-new-");
  const legacy = seedLegacy();
  const first = startStore(dataDir, legacy);

  first.batchRows = [];
  first.saveBatchRowsToDisk();
  const restarted = startStore(dataDir, legacy);

  assert.strictEqual(restarted.batchRows.length, 0);
});

test("deleted last account does not come back after restart", () => {
  const dataDir = tmpDir("muse-new-");
  const legacy = seedLegacy();
  const first = startStore(dataDir, legacy);

  first.deleteAccount(first.accounts[0].id);
  const restarted = startStore(dataDir, legacy);

  assert.strictEqual(restarted.accounts.length, 0);
});

test("refreshed cookie is not overwritten by the stale legacy cookie on restart (encrypted store)", () => {
  const secureStore = { available: true, encrypt: (t) => Buffer.from(t), decrypt: (b) => b.toString() };
  const dataDir = tmpDir("muse-new-");
  const legacy = seedLegacy();
  const first = startStore(dataDir, legacy, { secureStore });

  first.addAccount("Acc1", sess("NEW"), "a@x");
  const restarted = startStore(dataDir, legacy, { secureStore });

  assert.strictEqual(restarted.accounts[0].cookies[0].value, "NEW");
});

test("manual sync adds new accounts but keeps the cookie of an existing one", () => {
  const store = startStore(tmpDir("muse-new-"), tmpDir("muse-empty-"));
  store.addAccount("Acc1", sess("NEW"), "a@x");
  const legacy = seedLegacy();
  writeJson(legacy, "accounts.json", [
    { name: "Acc1", email: "a@x", cookies: sess("OLD") },
    { name: "Acc2", email: "b@x", cookies: sess("B") },
  ]);

  const res = store.syncFromSource(legacy);

  assert.strictEqual(res.addedAccounts, 1);
  assert.strictEqual(store.accounts.find((a) => a.email === "a@x").cookies[0].value, "NEW");
});

test("saving never writes into the old version's folder", () => {
  const legacy = seedLegacy();
  const store = startStore(tmpDir("muse-new-"), legacy);

  store.batchRows = [...store.batchRows, { id: "r2", prompt: "q", status: "idle" }];
  store.saveBatchRowsToDisk();
  store.addAccount("Other", sess("X"), "o@x");

  assert.strictEqual(readJson(legacy, "batch-rows.json").length, 1);
  assert.strictEqual(readJson(legacy, "accounts.json").length, 1);
});

test("job export carries no account cookies and reports the package version", async (t) => {
  const dataDir = tmpDir("muse-export-");
  const srv = new MuseServer({ rootDir: path.resolve(__dirname, ".."), dataDir, port: 0 });
  await srv.start();
  t.after(async () => {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  srv.store.addAccount("Acc1", sess("SECRET"), "a@x");

  const body = await new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: srv.port, path: "/admin/jobs/export" }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(JSON.parse(data)));
      })
      .on("error", reject);
  });

  assert.strictEqual(body.accounts, undefined);
  assert.ok(!JSON.stringify(body).includes("SECRET"));
  assert.strictEqual(body.version, require("../package.json").version);
});
