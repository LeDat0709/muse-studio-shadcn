"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Store } = require("../src/store");

// Stand-in for Electron safeStorage: reversible, so a round-trip is verifiable.
const fakeSecure = {
  available: true,
  encrypt: (text) => Buffer.from("ENC:" + text, "utf8"),
  decrypt: (buf) => buf.toString("utf8").replace(/^ENC:/, ""),
};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "muse-store-"));
}

test("with a secure store, accounts persist encrypted (no plaintext accounts.json)", () => {
  const dir = tmpDir();
  const s1 = new Store(dir, { secureStore: fakeSecure });
  s1.accounts.push({ id: "a1", name: "n", cookies: [{ name: "hatch_sess", value: "secret" }] });
  s1.saveAccounts();

  assert.ok(fs.existsSync(path.join(dir, "accounts.enc")), "accounts.enc written");
  assert.ok(!fs.existsSync(path.join(dir, "accounts.json")), "no plaintext accounts.json");
  // The on-disk bytes must be the ciphertext, not the clear session value.
  const onDisk = fs.readFileSync(path.join(dir, "accounts.enc"), "utf8");
  assert.ok(onDisk.startsWith("ENC:"), "stored as ciphertext");

  const s2 = new Store(dir, { secureStore: fakeSecure });
  assert.equal(s2.accounts.length, 1);
  assert.equal(s2.accounts[0].cookies[0].value, "secret");
});

test("a legacy plaintext accounts.json migrates to encrypted on load", () => {
  const dir = tmpDir();
  const legacy = [{ id: "old", name: "legacy", cookies: [{ name: "hatch_sess", value: "v" }] }];
  fs.writeFileSync(path.join(dir, "accounts.json"), JSON.stringify(legacy), "utf8");

  const s = new Store(dir, { secureStore: fakeSecure });
  assert.equal(s.accounts[0].id, "old");
  assert.ok(fs.existsSync(path.join(dir, "accounts.enc")), "migrated to accounts.enc");
  assert.ok(!fs.existsSync(path.join(dir, "accounts.json")), "plaintext removed after migration");
});

test("without a secure store, legacy plaintext behaviour is unchanged", () => {
  const dir = tmpDir();
  const s1 = new Store(dir);
  s1.accounts.push({ id: "p", name: "plain", cookies: [] });
  s1.saveAccounts();

  assert.ok(fs.existsSync(path.join(dir, "accounts.json")), "plaintext accounts.json written");
  assert.ok(!fs.existsSync(path.join(dir, "accounts.enc")), "no accounts.enc without secure store");

  const s2 = new Store(dir);
  assert.equal(s2.accounts[0].id, "p");
});
