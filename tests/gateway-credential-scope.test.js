"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { isMuseHost, stripCredentialHeaders } = require("../src/gateway");

test("isMuseHost allows muse.ai and its subdomains only", () => {
  assert.equal(isMuseHost("muse.ai"), true);
  assert.equal(isMuseHost("cdn.muse.ai"), true);
  assert.equal(isMuseHost("MUSE.AI"), true);
  assert.equal(isMuseHost("evil.com"), false);
  assert.equal(isMuseHost("muse.ai.evil.com"), false); // suffix attack
  assert.equal(isMuseHost("notmuse.ai"), false);
  assert.equal(isMuseHost(""), false);
});

test("stripCredentialHeaders removes cookie/authorization/proxy-authorization case-insensitively", () => {
  const out = stripCredentialHeaders({
    Cookie: "hatch_sess=secret",
    Authorization: "Bearer tok",
    "Proxy-Authorization": "Basic x",
    "User-Agent": "UA",
    Accept: "*/*",
  });
  assert.deepEqual(out, { "User-Agent": "UA", Accept: "*/*" });
});
