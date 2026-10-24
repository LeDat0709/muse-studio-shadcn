"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Store } = require("../src/store");
const { MuseEngine, minStitchedDurationSec } = require("../src/engine");

// Stands in for the Muse tab: hands out the tab's cookies, answers the in-page media-prepare script,
// then serves the base64 in slices (the fallback path).
function fakeCdp(payload, { cookies = [] } = {}) {
  const b64 = Buffer.from(payload).toString("base64");
  const cdp = {
    inPageCalls: 0,
    async send(method) {
      return method === "Network.getCookies" ? { cookies } : {};
    },
    async evaluate(js) {
      cdp.inPageCalls += 1;
      if (js.includes("__embongMediaStore = window.__embongMediaStore")) {
        return { ok: true, mime: "video/mp4", size: payload.length, b64Len: b64.length };
      }
      const slice = js.match(/\.slice\((\d+), (\d+)\)/);
      return slice ? b64.slice(Number(slice[1]), Number(slice[2])) : undefined;
    },
  };
  return cdp;
}

function newEngine(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-media-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return new MuseEngine(new Store(dataDir));
}

// Local stand-in for Muse's media host; records the Cookie header of every request.
async function mediaHost(t, routes) {
  const seenCookies = [];
  const srv = http.createServer((req, res) => {
    seenCookies.push(req.headers.cookie || "");
    const route = routes[req.url];
    if (!route) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": route.type }).end(route.body);
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => srv.close());
  return { base: `http://127.0.0.1:${srv.address().port}`, seenCookies };
}

test("videos with the same product title never overwrite each other", async (t) => {
  const engine = newEngine(t);
  const title = "Nồi Điện 1.8L";

  const first = await engine._saveMediaFromAttachment(fakeCdp("VIDEO-1"), "blob:muse/1", "video", title);
  const second = await engine._saveMediaFromAttachment(fakeCdp("VIDEO-2"), "blob:muse/2", "video", title);
  const [third, fourth] = await Promise.all([
    engine._saveMediaFromAttachment(fakeCdp("VIDEO-3"), "blob:muse/3", "video", title),
    engine._saveMediaFromAttachment(fakeCdp("VIDEO-4"), "blob:muse/4", "video", title),
  ]);

  assert.strictEqual(first.filename, `${title}.mp4`);
  assert.strictEqual(second.filename, `${title} (2).mp4`);
  const saved = [first, second, third, fourth];
  assert.strictEqual(new Set(saved.map((s) => s.filename)).size, 4, "every render gets its own file");
  saved.forEach((s, i) => assert.strictEqual(fs.readFileSync(s.fullPath, "utf8"), `VIDEO-${i + 1}`));
});

test("http(s) videos stream straight to disk with the tab's cookies, no base64 kept", async (t) => {
  const engine = newEngine(t);
  const host = await mediaHost(t, { "/clip.mp4": { type: "video/mp4", body: "STREAMED-VIDEO" } });
  const cdp = fakeCdp("UNUSED", { cookies: [{ name: "hatch_sess", value: "abc" }] });

  const saved = await engine._saveMediaFromAttachment(cdp, `${host.base}/clip.mp4`, "video", "");

  assert.strictEqual(fs.readFileSync(saved.fullPath, "utf8"), "STREAMED-VIDEO");
  assert.strictEqual(saved.size, "STREAMED-VIDEO".length);
  assert.deepStrictEqual(host.seenCookies, ["hatch_sess=abc"]);
  assert.strictEqual(cdp.inPageCalls, 0, "the in-page base64 path is not used");
  assert.ok(!("b64" in saved), "video results carry no base64 copy");
});

test("images downloaded directly still expose base64 for b64_json", async (t) => {
  const engine = newEngine(t);
  const host = await mediaHost(t, { "/img.png": { type: "image/png", body: "PNG-BYTES" } });

  const saved = await engine._saveMediaFromAttachment(fakeCdp("UNUSED"), `${host.base}/img.png`, "image", "");

  assert.ok(saved.filename.endsWith(".png"));
  assert.strictEqual(saved.b64, Buffer.from("PNG-BYTES").toString("base64"));
});

test("a non-media response falls back to the in-page download and leaves no partial file", async (t) => {
  const engine = newEngine(t);
  const host = await mediaHost(t, { "/login": { type: "text/html", body: "<html>sign in</html>" } });
  const cdp = fakeCdp("VIA-BROWSER");

  const saved = await engine._saveMediaFromAttachment(cdp, `${host.base}/login`, "video", "Clip");

  assert.strictEqual(fs.readFileSync(saved.fullPath, "utf8"), "VIA-BROWSER");
  assert.ok(cdp.inPageCalls > 0);
  assert.deepStrictEqual(fs.readdirSync(engine.store.mediaDir), ["Clip.mp4"]);
});

test("a single follow-up clip is not accepted as the stitched long video", () => {
  assert.ok(minStitchedDurationSec(15) > 10, "15s order: a 10s continuation clip is rejected");
  assert.ok(minStitchedDurationSec(60) > 11, "60s order: an 11s clip is rejected");
  assert.ok(minStitchedDurationSec(60) <= 45, "60s order: a 45s stitched video is still accepted");
  assert.ok(minStitchedDurationSec(20) <= 15, "20s order: a 15s stitched video is still accepted");
});
