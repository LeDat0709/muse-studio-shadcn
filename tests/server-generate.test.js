"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { MuseServer, recordJobStep } = require("../src/server");

function request(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null }));
      }
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-generate-test-"));
  const srv = new MuseServer({ rootDir: path.resolve(__dirname, ".."), dataDir, port: 0 });
  await srv.start();
  t.after(async () => {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return srv;
}

test("/admin/generate hands the row's output name to the engine, and only a string", async (t) => {
  const srv = await startServer(t);
  const calls = [];
  srv.engine.generateVideo = async (opts) => {
    calls.push({ mode: "video", ...opts });
    return { taskId: "t1", accountName: "acc", video: { url: "/v1/media/Quang%20cao%2001.mp4", filename: "Quang cao 01.mp4" } };
  };
  srv.engine.generateImage = async (opts) => {
    calls.push({ mode: "image", ...opts });
    return { taskId: "t2", accountName: "acc", images: [{ url: "/v1/media/a.png", filename: "a.png" }] };
  };

  const video = await request(srv.port, "/admin/generate", { prompt: "p", outputName: "Quang cao 01" });
  await request(srv.port, "/admin/generate", { prompt: "p", mode: "image", outputName: "Anh bia" });
  await request(srv.port, "/admin/generate", { prompt: "p", outputName: { evil: true } });

  assert.strictEqual(video.json.filename, "Quang cao 01.mp4");
  assert.deepStrictEqual(
    calls.map((c) => [c.mode, c.outputName]),
    [["video", "Quang cao 01"], ["image", "Anh bia"], ["video", ""]]
  );
});

test("a repeated step with a new counter updates in place; a capped timeline keeps its first step", () => {
  let steps = [];
  steps = recordJobStep(steps, { at: 0, pct: 5, text: "Khởi tạo" });
  steps = recordJobStep(steps, { at: 1000, pct: 20, text: "Tạo phân cảnh (5s)" });
  steps = recordJobStep(steps, { at: 6000, pct: 25, text: "Tạo phân cảnh (10s)" });
  assert.deepStrictEqual(steps, [
    { at: 0, pct: 5, text: "Khởi tạo" },
    { at: 1000, pct: 25, text: "Tạo phân cảnh (10s)" },
  ]);

  for (let i = 1; i <= 60; i += 1) steps = recordJobStep(steps, { at: 6000 + i, pct: 30, text: `Bước ${"x".repeat(i)}` });

  assert.strictEqual(steps.length, 40);
  assert.strictEqual(steps[0].text, "Khởi tạo");
  assert.strictEqual(steps.at(-1).text, `Bước ${"x".repeat(60)}`);
  assert.strictEqual(recordJobStep(steps, { at: 1, pct: 1, text: "  " }), steps, "blank text is ignored");
});

test("an async job reports its step timeline and ends it at the failure", async (t) => {
  const srv = await startServer(t);
  srv.engine.generateVideo = async ({ onProgress }) => {
    onProgress(10, "Kết nối VM");
    onProgress(20, "Tạo phân cảnh (5s)");
    onProgress(30, "Tạo phân cảnh (10s)");
    onProgress(40, "Ghép video");
    throw new Error("VM hỏng");
  };

  const start = await request(srv.port, "/admin/generate", { prompt: "p", async: true, rowId: "row_a" });
  let job = null;
  for (let i = 0; i < 50; i += 1) {
    job = (await request(srv.port, `/admin/generate/job/${start.json.jobId}`)).json;
    if (job.status !== "running") break;
    await new Promise((r) => setTimeout(r, 20));
  }

  assert.strictEqual(job.status, "error");
  assert.deepStrictEqual(
    job.steps.map((s) => s.text),
    ["Đang khởi tạo trên cổng Gateway...", "Kết nối VM", "Tạo phân cảnh (10s)", "Ghép video", "Lỗi: VM hỏng"]
  );
  assert.ok(job.steps.every((s, i, all) => i === 0 || s.at >= all[i - 1].at), "steps are in time order");
  assert.ok(job.elapsed_ms >= job.steps.at(-1).at, "elapsed covers the whole run");
});
