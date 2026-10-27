"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Store } = require("../src/store");
const {
  MuseEngine,
  minStitchedDurationSec,
  isUnfinishedMp4,
  downloadFinishedMedia,
  outputFileBase,
} = require("../src/engine");

test("a user-chosen output name becomes a safe file base on macOS and Windows", () => {
  assert.strictEqual(outputFileBase("  Nồi chiên 01  "), "Nồi chiên 01");
  assert.strictEqual(outputFileBase("quang-cao.mp4"), "quang-cao", "the real extension comes from the media");
  assert.strictEqual(outputFileBase("../../etc/passwd"), "-..-etc-passwd", "no folder escape");
  assert.strictEqual(outputFileBase('a:b*c?"d<e>f|g\\h'), "a-b-c--d-e-f-g-h");
  assert.strictEqual(outputFileBase("CON"), "CON_", "Windows reserved device name");
  assert.strictEqual(outputFileBase("ten."), "ten", "Windows drops a trailing dot");
  assert.strictEqual(outputFileBase("x".repeat(300)).length, 120);
  assert.strictEqual(outputFileBase("   "), "");
  assert.strictEqual(outputFileBase(undefined), "");
});

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

function box(type, payload = Buffer.alloc(0), declaredSize) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(declaredSize ?? 8 + payload.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, payload]);
}

const FTYP = box("ftyp", Buffer.from("isom\0\0\x02\0isomiso2avc1mp41", "latin1"));
const FRAMES = Buffer.alloc(4096, 7);
const FINISHED_MP4 = Buffer.concat([FTYP, box("free"), box("mdat", FRAMES), box("moov", Buffer.alloc(64))]);
// What ffmpeg has on disk mid-render: mdat size still the 0 placeholder, no moov yet.
const RENDERING_MP4 = Buffer.concat([FTYP, box("free"), box("mdat", FRAMES, 0)]);

test("only a finalised MP4 counts as finished", () => {
  assert.strictEqual(isUnfinishedMp4(FINISHED_MP4), false);
  assert.strictEqual(isUnfinishedMp4(RENDERING_MP4), true, "ffmpeg still writing");
  assert.strictEqual(isUnfinishedMp4(FINISHED_MP4.subarray(0, 2000)), true, "cut off mid-mdat");
  assert.strictEqual(isUnfinishedMp4(Buffer.concat([FTYP, box("mdat", FRAMES)])), true, "no moov");

  const largeMdat = Buffer.alloc(16);
  largeMdat.writeUInt32BE(1, 0);
  largeMdat.write("mdat", 4, "latin1");
  largeMdat.writeBigUInt64BE(BigInt(16 + FRAMES.length), 8);
  const finished64 = Buffer.concat([FTYP, largeMdat, FRAMES, box("moov", Buffer.alloc(8))]);
  assert.strictEqual(isUnfinishedMp4(finished64), false, "64-bit mdat size");

  assert.strictEqual(isUnfinishedMp4(Buffer.from("\x89PNG\r\n\x1a\n-not-mp4", "latin1")), false);
});

test("a video still being rendered on the VM is re-downloaded until it is finished", async () => {
  const served = [RENDERING_MP4, RENDERING_MP4, FINISHED_MP4];
  let calls = 0;
  const waits = [];

  const media = await downloadFinishedMedia(
    async () => ({ buffer: served[calls++], mime: "video/mp4" }),
    { deadlineMs: Date.now() + 60000, pollMs: 1, onWait: (bytes) => waits.push(bytes) }
  );

  assert.strictEqual(media.buffer, FINISHED_MP4);
  assert.strictEqual(calls, 3);
  assert.deepStrictEqual(waits, [RENDERING_MP4.length, RENDERING_MP4.length]);
});

test("a render that never finishes fails instead of saving a broken video", async () => {
  await assert.rejects(
    downloadFinishedMedia(async () => ({ buffer: RENDERING_MP4, mime: "video/mp4" }), {
      deadlineMs: Date.now() + 20,
      pollMs: 5,
    }),
    /chưa ghi xong/
  );
});
