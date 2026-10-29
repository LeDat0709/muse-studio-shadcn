"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { classifyGenError, softenPromptForRetry } = require("../src/engine");

test("classifies transient gateway/media errors", () => {
  assert.equal(classifyGenError("chat.history -> HTTP 502: service unavailable"), "transient");
  assert.equal(classifyGenError("Mất kết nối Gateway khi theo dõi tiến trình"), "transient");
  assert.equal(classifyGenError("Không tải được dữ liệu media từ VM"), "transient");
  assert.equal(classifyGenError("Quá thời gian chờ"), "transient");
});

test("classifies content violations", () => {
  assert.equal(
    classifyGenError("Video generation is not available for this account in its country or region"),
    "violation"
  );
  assert.equal(classifyGenError("The model refused to generate this content"), "violation");
  assert.equal(classifyGenError("content policy violation"), "violation");
});

test("classifies auth/die errors", () => {
  assert.equal(classifyGenError("401 Unauthorized"), "auth");
  assert.equal(classifyGenError("Ních DIE: Thiếu cookie cốt lõi hatch_sess"), "auth");
});

test("softenPromptForRetry prepends once, idempotently", () => {
  const once = softenPromptForRetry("Cảnh đua xe tốc độ cao");
  assert.ok(once.startsWith("(Phiên bản AN TOÀN"));
  assert.ok(once.endsWith("Cảnh đua xe tốc độ cao"));
  // applying again must not stack the prefix
  assert.equal(softenPromptForRetry(once), once);
});
