"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MuseServer, sizeToAspectRatio } = require("../src/server");

test("OpenAI pixel sizes snap to the nearest ratio Muse understands", () => {
  assert.strictEqual(sizeToAspectRatio("1024x1024", "9:16"), "1:1");
  assert.strictEqual(sizeToAspectRatio("1792x1024", "9:16"), "16:9");
  assert.strictEqual(sizeToAspectRatio("1024x1792", "1:1"), "9:16");
  assert.strictEqual(sizeToAspectRatio("720x1280", "1:1"), "9:16");
  assert.strictEqual(sizeToAspectRatio("1536x1024", "1:1"), "4:3");
  assert.strictEqual(sizeToAspectRatio("3:4", "1:1"), "3:4", "ratios pass through");
  assert.strictEqual(sizeToAspectRatio("auto", "1:1"), "1:1");
  assert.strictEqual(sizeToAspectRatio("0x1024", "9:16"), "9:16");
  assert.strictEqual(sizeToAspectRatio(undefined, ""), "");
});

test("/v1 media endpoints reject an empty prompt before touching Muse", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-v1-test-"));
  const srv = new MuseServer({ rootDir: path.resolve(__dirname, ".."), dataDir, port: 0 });
  srv.engine._generateMedia = async () => {
    throw new Error("Muse must not be called for an empty prompt");
  };
  await srv.start();
  t.after(async () => {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  for (const route of ["/v1/videos", "/v1/images/generations", "/v1/images/edits", "/v1/images/tasks"]) {
    const res = await fetch(`http://127.0.0.1:${srv.port}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "   ", size: "1024x1024" }),
    });
    assert.strictEqual(res.status, 400, route);
    assert.strictEqual((await res.json()).error.type, "invalid_request_error", route);
  }
  assert.strictEqual(srv.store.tasks.length, 0, "no task is created for a rejected request");
});
