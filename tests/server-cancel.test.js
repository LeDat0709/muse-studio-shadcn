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
    req.end(body);
  });
}

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-cancel-test-"));
  const srv = new MuseServer({ rootDir: path.resolve(__dirname, ".."), dataDir, port: 0 });
  await srv.start();
  t.after(async () => {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return srv;
}

test("cancel route only stops everything on a literal all: true", async (t) => {
  const srv = await startServer(t);
  const engineCalls = [];
  srv.engine.cancelTasks = async (args) => {
    engineCalls.push(args);
    return { cancelledCount: 0, cancelledTaskIds: [], cancelledRowIds: [] };
  };
  srv.asyncJobs.set("job_a", { jobId: "job_a", rowId: "row_a", status: "running" });
  srv.asyncJobs.set("job_b", { jobId: "job_b", rowId: "row_b", status: "running" });

  const nullBody = await postJson(srv.port, "/admin/generate/cancel", "null");
  assert.strictEqual(nullBody.status, 200, "a null body is an empty request, not a crash");
  assert.strictEqual(srv.asyncJobs.get("job_a").status, "running");
  assert.strictEqual(engineCalls.at(-1).all, false);

  const stringFalse = await postJson(srv.port, "/admin/generate/cancel", JSON.stringify({ all: "false" }));
  assert.strictEqual(stringFalse.status, 200);
  assert.strictEqual(stringFalse.json.cancelledJobs, 0, '"false" must not cancel every job');
  assert.strictEqual(engineCalls.at(-1).all, false);

  const byJob = await postJson(srv.port, "/admin/generate/cancel", JSON.stringify({ jobIds: ["job_a"] }));
  assert.deepStrictEqual(byJob.json.cancelledJobIds, ["job_a"]);
  assert.strictEqual(srv.asyncJobs.get("job_a").status, "cancelled");
  assert.strictEqual(srv.asyncJobs.get("job_b").status, "running", "other jobs keep running");
  assert.deepStrictEqual(engineCalls.at(-1).rowIds, ["row_a"], "the job's row is passed on to the engine");

  const everything = await postJson(srv.port, "/admin/generate/cancel", JSON.stringify({ all: true }));
  assert.deepStrictEqual(everything.json.cancelledJobIds, ["job_b"]);
  assert.strictEqual(engineCalls.at(-1).all, true);
});

test("engine cancel-all leaves the in-flight counter to the runs themselves", async (t) => {
  const srv = await startServer(t);
  srv.engine.activeCount = 2; // two runs started but not yet registered as runners

  await srv.engine.cancelTasks({ all: true });

  assert.strictEqual(srv.engine.activeCount, 2, "each run decrements in its own finally");
});
