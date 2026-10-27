"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { splitPromptLines, parsePromptLine, splitNamedPromptLines } = require("../desktop/prompt-lines");

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
