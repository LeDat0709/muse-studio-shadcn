"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { buildTemplatedName, outputFileBase } = require("../src/engine");

const VARS = {
  title: "Nồi điện 1.8L",
  prompt: "a product video",
  duration: "20s",
  ratio: "9:16",
  quality: "4K",
  mode: "video",
  tag: "abc123",
};

test("fills name placeholders; outputFileBase makes it filesystem-safe", () => {
  const raw = buildTemplatedName("{title}_{duration}_{ratio}", VARS);
  assert.equal(raw, "Nồi điện 1.8L_20s_9:16");
  // ':' is illegal in a filename -> sanitised to '-'
  assert.equal(outputFileBase(raw), "Nồi điện 1.8L_20s_9-16");
});

test("date/time/datetime/rand placeholders are generated", () => {
  const out = buildTemplatedName("{mode}_{datetime}_{tag}", VARS);
  assert.match(out, /^video_\d{8}_\d{6}_abc123$/);
  assert.match(buildTemplatedName("{date}", VARS), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(buildTemplatedName("{rand}", VARS), /^[0-9a-f]{6}$/);
});

test("unknown placeholders are left untouched", () => {
  assert.equal(buildTemplatedName("{title}-{nope}", VARS), "Nồi điện 1.8L-{nope}");
});
