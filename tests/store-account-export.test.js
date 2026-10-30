"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Store } = require("../src/store");

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-store-"));
  return new Store(dir);
}

const COOKIES = [
  { name: "hatch_sess", value: "sess-abc" },
  { name: "hatch_vml", value: "vml-xyz" },
  { name: "hatch_gw", value: "gw-123" },
];

test("export then import round-trips cookies + proxy", () => {
  // Arrange
  const a = tmpStore();
  a.addAccount("Ních A", COOKIES, "a@x.com", { proxy: "1.2.3.4:8080:u:p" });

  // Act
  const dump = a.exportAllAccounts();
  const b = tmpStore();
  const res = b.importAccounts(dump);

  // Assert
  assert.equal(dump.length, 1);
  assert.equal(dump[0].cookies.length, 3);
  assert.equal(dump[0].proxy, "1.2.3.4:8080:u:p");
  assert.equal(res.imported, 1);
  const acc = b.listAccounts()[0];
  assert.equal(acc.cookie_count, 3);
  assert.equal(acc.has_session, true);
  assert.equal(acc.proxy, "1.2.3.4:8080:u:p");
});

test("re-importing the same account dedupes instead of duplicating", () => {
  const b = tmpStore();
  b.importAccounts([{ name: "Ních A", email: "a@x.com", cookies: COOKIES }]);
  b.importAccounts([{ name: "Ních A", email: "a@x.com", cookies: COOKIES }]);
  assert.equal(b.listAccounts().length, 1);
});

test("exportAccount returns null for an unknown id", () => {
  assert.equal(tmpStore().exportAccount("nope"), null);
});
