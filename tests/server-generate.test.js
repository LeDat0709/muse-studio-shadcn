"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { MuseServer } = require("../src/server");

function postJson(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null }));
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

test("/admin/generate hands the row's output name to the engine, and only a string", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-generate-test-"));
  const srv = new MuseServer({ rootDir: path.resolve(__dirname, ".."), dataDir, port: 0 });
  await srv.start();
  t.after(async () => {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const calls = [];
  srv.engine.generateVideo = async (opts) => {
    calls.push({ mode: "video", ...opts });
    return { taskId: "t1", accountName: "acc", video: { url: "/v1/media/Quang%20cao%2001.mp4", filename: "Quang cao 01.mp4" } };
  };
  srv.engine.generateImage = async (opts) => {
    calls.push({ mode: "image", ...opts });
    return { taskId: "t2", accountName: "acc", images: [{ url: "/v1/media/a.png", filename: "a.png" }] };
  };

  const video = await postJson(srv.port, "/admin/generate", { prompt: "p", outputName: "Quang cao 01" });
  await postJson(srv.port, "/admin/generate", { prompt: "p", mode: "image", outputName: "Anh bia" });
  await postJson(srv.port, "/admin/generate", { prompt: "p", outputName: { evil: true } });

  assert.strictEqual(video.json.filename, "Quang cao 01.mp4");
  assert.deepStrictEqual(
    calls.map((c) => [c.mode, c.outputName]),
    [["video", "Quang cao 01"], ["image", "Anh bia"], ["video", ""]]
  );
});
