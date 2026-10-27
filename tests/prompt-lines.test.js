"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { splitPromptLines } = require("../desktop/prompt-lines");

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
