"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Store } = require("../src/store");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "muse-row-images-"));
const IMG = { name: "sp.jpg", mime: "image/jpeg", b64: "QUJD".repeat(1000) };
const row = (id, extra = {}) => ({ id, prompt: "p", status: "idle", ...extra });
const rowsFile = (dir) => path.join(dir, "batch-rows.json");
const imagesFile = (dir) => path.join(dir, "batch-images.json");

test("ảnh nằm ngoài batch-rows.json nhưng vẫn có đủ sau khi mở lại", () => {
  const dir = tmp();
  new Store(dir).saveBatchRows([row("a", { productImage: IMG }), row("b")]);

  assert.ok(!fs.readFileSync(rowsFile(dir), "utf-8").includes(IMG.b64), "file luồng không chứa ảnh");
  assert.ok(fs.statSync(rowsFile(dir)).size < 1000);

  const reopened = new Store(dir);
  assert.deepStrictEqual(reopened.getBatchRows()[0].productImage, IMG);
  assert.strictEqual(reopened.getBatchRows()[1].productImage, undefined);
});

test("keepImages: lưu nhẹ giữ nguyên ảnh đã có và không ghi lại file ảnh", () => {
  const dir = tmp();
  const store = new Store(dir);
  store.saveBatchRows([row("a", { productImage: IMG, characterImage: IMG })]);
  const before = fs.statSync(imagesFile(dir)).mtimeMs;
  fs.utimesSync(imagesFile(dir), new Date(0), new Date(0));

  store.saveBatchRows([row("a", { status: "done", mediaUrl: "/v1/media/x.mp4" })], { keepImages: true });

  assert.ok(before > 0);
  assert.strictEqual(fs.statSync(imagesFile(dir)).mtimeMs, 0, "file ảnh không bị ghi lại");
  const saved = store.getBatchRows()[0];
  assert.strictEqual(saved.status, "done");
  assert.deepStrictEqual(saved.productImage, IMG);
  assert.deepStrictEqual(new Store(dir).getBatchRows()[0].characterImage, IMG);
});

test("lưu đầy đủ khi bỏ ảnh khỏi luồng thì ảnh không quay lại sau khi mở lại", () => {
  const dir = tmp();
  const store = new Store(dir);
  store.saveBatchRows([row("a", { productImage: IMG })]);

  store.saveBatchRows([row("a")]);

  assert.strictEqual(new Store(dir).getBatchRows()[0].productImage, undefined);
});

test("luồng đã xóa không để lại ảnh trong file ảnh", () => {
  const dir = tmp();
  const store = new Store(dir);
  store.saveBatchRows([row("a", { productImage: IMG }), row("b", { productImage: IMG })]);

  store.saveBatchRows([row("b", { productImage: IMG })]);

  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(imagesFile(dir), "utf-8"))), ["b"]);
});

test("dữ liệu bản cũ (ảnh nằm trong batch-rows.json) vẫn đọc được và được tách ở lần lưu sau", () => {
  const dir = tmp();
  fs.writeFileSync(rowsFile(dir), JSON.stringify([row("a", { productImage: IMG })]));

  const store = new Store(dir);
  assert.deepStrictEqual(store.getBatchRows()[0].productImage, IMG);

  store.saveBatchRows(store.getBatchRows());
  assert.ok(!fs.readFileSync(rowsFile(dir), "utf-8").includes(IMG.b64));
  assert.deepStrictEqual(new Store(dir).getBatchRows()[0].productImage, IMG);
});

test("file ảnh hỏng thì vẫn mở được luồng, không làm mất danh sách", () => {
  const dir = tmp();
  new Store(dir).saveBatchRows([row("a", { productImage: IMG })]);
  fs.writeFileSync(imagesFile(dir), "{hỏng");

  const rows = new Store(dir).getBatchRows();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, "a");
});

test("đồng bộ từ thư mục bản mới mang theo cả ảnh đã tách", () => {
  const source = tmp();
  new Store(source).saveBatchRows([row("a", { productImage: IMG })]);

  const target = new Store(tmp());
  target.syncFromSource(source);

  assert.deepStrictEqual(target.getBatchRows()[0].productImage, IMG);
});

test("stats không còn quét thư mục media", () => {
  const store = new Store(tmp());
  fs.writeFileSync(path.join(store.mediaDir, "a.mp4"), "x");

  assert.strictEqual(store.stats().media_count, undefined);
});
