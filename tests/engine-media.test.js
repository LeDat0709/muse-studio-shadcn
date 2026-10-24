"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Store } = require("../src/store");
const { MuseEngine, minStitchedDurationSec } = require("../src/engine");

// Stands in for the Muse tab: answers the media-prepare script, then serves the base64 in slices.
function fakeCdp(payload) {
  const b64 = Buffer.from(payload).toString("base64");
  return {
    async evaluate(js) {
      if (js.includes("__embongMediaStore = window.__embongMediaStore")) {
        return { ok: true, mime: "video/mp4", size: payload.length, b64Len: b64.length };
      }
      const slice = js.match(/\.slice\((\d+), (\d+)\)/);
      return slice ? b64.slice(Number(slice[1]), Number(slice[2])) : undefined;
    },
  };
}

test("videos with the same product title never overwrite each other", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-media-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const engine = new MuseEngine(new Store(dataDir));
  const title = "Nồi Điện 1.8L";

  const first = await engine._saveMediaFromAttachment(fakeCdp("VIDEO-1"), "https://x/1.mp4", "video", title);
  const second = await engine._saveMediaFromAttachment(fakeCdp("VIDEO-2"), "https://x/2.mp4", "video", title);
  const [third, fourth] = await Promise.all([
    engine._saveMediaFromAttachment(fakeCdp("VIDEO-3"), "https://x/3.mp4", "video", title),
    engine._saveMediaFromAttachment(fakeCdp("VIDEO-4"), "https://x/4.mp4", "video", title),
  ]);

  assert.strictEqual(first.filename, `${title}.mp4`);
  assert.strictEqual(second.filename, `${title} (2).mp4`);
  const saved = [first, second, third, fourth];
  assert.strictEqual(new Set(saved.map((s) => s.filename)).size, 4, "every render gets its own file");
  saved.forEach((s, i) => assert.strictEqual(fs.readFileSync(s.fullPath, "utf8"), `VIDEO-${i + 1}`));
});

test("a single follow-up clip is not accepted as the stitched long video", () => {
  assert.ok(minStitchedDurationSec(15) > 10, "15s order: a 10s continuation clip is rejected");
  assert.ok(minStitchedDurationSec(60) > 11, "60s order: an 11s clip is rejected");
  assert.ok(minStitchedDurationSec(60) <= 45, "60s order: a 45s stitched video is still accepted");
  assert.ok(minStitchedDurationSec(20) <= 15, "20s order: a 15s stitched video is still accepted");
});
