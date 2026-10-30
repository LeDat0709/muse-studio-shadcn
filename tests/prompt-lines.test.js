"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  splitPromptLines,
  parsePromptLine,
  splitNamedPromptLines,
  clampConcurrency,
  mergePendingIntoQueue,
} = require("../desktop/prompt-lines");

test("'tên-file | prompt' names the output; the first | splits, later ones stay in the prompt", () => {
  assert.deepStrictEqual(parsePromptLine("noi-chien-01 | Cận cảnh nồi chiên"), {
    name: "noi-chien-01",
    prompt: "Cận cảnh nồi chiên",
  });
  assert.deepStrictEqual(parsePromptLine("logo | Chữ A | chữ B"), { name: "logo", prompt: "Chữ A | chữ B" });
  assert.deepStrictEqual(parsePromptLine("Cảnh bình minh"), { name: "", prompt: "Cảnh bình minh" });
});

test("a line that cannot be a name keeps its text as the prompt", () => {
  assert.deepStrictEqual(parsePromptLine("| chỉ có prompt"), { name: "", prompt: "chỉ có prompt" });
  assert.deepStrictEqual(parsePromptLine("chỉ có tên |"), { name: "", prompt: "chỉ có tên" });
  const longLeft = `${"x".repeat(121)} | 4K`;
  assert.deepStrictEqual(parsePromptLine(longLeft), { name: "", prompt: longLeft }, "too long for a file name");
});

test("named lines go through the same list cleanup and skip empty lines", () => {
  assert.deepStrictEqual(splitNamedPromptLines("1. sp-01 | Nồi chiên\n\n- Bánh mì\n|\n[VIDEO]: sp-02 | Ấm trà"), [
    { name: "sp-01", prompt: "Nồi chiên" },
    { name: "", prompt: "Bánh mì" },
    { name: "sp-02", prompt: "Ấm trà" },
  ]);
});

test("each non-empty line becomes one prompt", () => {
  assert.deepStrictEqual(splitPromptLines("Cảnh 1: bình minh\n\n  Cảnh 2: hoàng hôn  \r\nCảnh 3: đêm\n"), [
    "Cảnh 1: bình minh",
    "Cảnh 2: hoàng hôn",
    "Cảnh 3: đêm",
  ]);
});

test("pasted list markers and script tags are stripped", () => {
  assert.deepStrictEqual(
    splitPromptLines("1. Một tách cà phê\n2) Một ấm trà\n- Bánh mì\n• Phở\n[VIDEO]: Chợ nổi\n3. [VIDEO] Cầu Rồng"),
    ["Một tách cà phê", "Một ấm trà", "Bánh mì", "Phở", "Chợ nổi", "Cầu Rồng"]
  );
});

test("text that only looks like a marker is kept", () => {
  assert.deepStrictEqual(splitPromptLines("4K cận cảnh\n3.5 giây slow motion\n16:9 toàn cảnh"), [
    "4K cận cảnh",
    "3.5 giây slow motion",
    "16:9 toàn cảnh",
  ]);
});

test("empty input gives no prompts", () => {
  assert.deepStrictEqual(splitPromptLines("  \n\n"), []);
  assert.deepStrictEqual(splitPromptLines(undefined), []);
});

test("clampConcurrency allows custom concurrency between 1 and 50", () => {
  assert.strictEqual(clampConcurrency(7), 7);
  assert.strictEqual(clampConcurrency("12"), 12);
  assert.strictEqual(clampConcurrency(0), 2);
  assert.strictEqual(clampConcurrency(-5), 1);
  assert.strictEqual(clampConcurrency(99), 50);
});

test("mergePendingIntoQueue enqueues waiting streams while a batch is running and can prioritize selected waiting rows", () => {
  const r1 = { id: "r1", status: "running", prompt: "Đang chạy 1" };
  const r2 = { id: "r2", status: "idle", prompt: "Chờ chạy 2" };
  const r3 = { id: "r3", status: "idle", prompt: "Chờ chạy 3" };
  const r4 = { id: "r4", status: "idle", prompt: "Chờ chạy 4" };

  // r1 is running, r2 and r3 are already in the queue; user selects r3 and newly added r4 to run now
  const out = mergePendingIntoQueue([r2, r3], [r1, r3, r4], new Set(["r1"]), { prioritize: true });
  assert.deepStrictEqual(
    out.queue.map((r) => r.id),
    ["r3", "r4", "r2"]
  );
  assert.deepStrictEqual(
    out.runnable.map((r) => r.id),
    ["r3", "r4"]
  );
  assert.strictEqual(out.newlyQueuedCount, 1);
});

test("Store.syncFromSource merges legacy batch-rows, completed job statuses, tasks, and media between old and new versions", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { Store } = require("../src/store");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "muse-sync-test-"));
  const oldToolDir = path.join(tmpRoot, "old-tool", "embong-muse-data");
  const newToolDir = path.join(tmpRoot, "new-tool", "data");
  fs.mkdirSync(path.join(oldToolDir, "media"), { recursive: true });
  fs.mkdirSync(newToolDir, { recursive: true });

  try {
    // Old tool has 2 jobs (one idle, one completed with video) and 1 media file
    fs.writeFileSync(
      path.join(oldToolDir, "batch-rows.json"),
      JSON.stringify([
        {
          id: "row_old_1",
          mode: "video",
          prompt: "Quay sản phẩm 1",
          status: "done",
          mediaUrl: "/v1/media/video1.mp4",
          filename: "video1.mp4",
        },
        {
          id: "row_old_2",
          mode: "video",
          prompt: "Quay sản phẩm 2",
          status: "running",
        },
      ])
    );
    fs.writeFileSync(
      path.join(oldToolDir, "tasks.json"),
      JSON.stringify([
        {
          id: "task_old_1",
          type: "video",
          prompt: "Quay sản phẩm 1",
          status: "succeeded",
          created_at: 1700000000,
        },
      ])
    );
    fs.writeFileSync(path.join(oldToolDir, "media", "video1.mp4"), "fake-mp4-bytes");

    const store = new Store(newToolDir);
    // Suppose new tool had row_old_1 still marked as idle
    store.saveBatchRows([
      {
        id: "row_old_1",
        mode: "video",
        prompt: "Quay sản phẩm 1",
        status: "idle",
        mediaUrl: "",
      },
    ]);

    const res = store.syncFromSource(path.join(tmpRoot, "old-tool"));
    assert.strictEqual(res.addedRows, 1);
    assert.strictEqual(res.updatedRows, 1);
    assert.strictEqual(res.totalRows, 2);
    assert.strictEqual(res.addedTasks, 1);
    assert.strictEqual(res.copiedMedia, 1);

    const rows = store.getBatchRows();
    const r1 = rows.find((r) => r.id === "row_old_1");
    const r2 = rows.find((r) => r.id === "row_old_2");
    assert.strictEqual(r1.status, "done");
    assert.strictEqual(r1.mediaUrl, "/v1/media/video1.mp4");
    assert.strictEqual(r2.status, "idle"); // running in old crash -> ready to run (idle)
    assert.ok(fs.existsSync(path.join(newToolDir, "media", "video1.mp4")));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
