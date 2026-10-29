"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { applyPromptTemplate } = require("../src/engine");

test("fills known placeholders and leaves unknown ones untouched", () => {
  const out = applyPromptTemplate(
    "Make a {duration}s {ratio} video ({specs}) at {output}: {prompt} [{unknown}]",
    {
      prompt: "a cat",
      duration: 20,
      ratio: "9:16",
      quality: "4K",
      output: "final_abc_20s.mp4",
      clips: 2,
      specs: "resolution 4K",
    }
  );
  assert.equal(
    out,
    "Make a 20s 9:16 video (resolution 4K) at final_abc_20s.mp4: a cat [{unknown}]"
  );
});

test("empty template yields empty string", () => {
  assert.equal(applyPromptTemplate("", { prompt: "x" }), "");
  assert.equal(applyPromptTemplate(null, { prompt: "x" }), "");
});
