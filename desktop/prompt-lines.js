"use strict";

// Turns a pasted block into prompts: one per non-empty line, with list markers ("1.", "2)", "-", "•", "*")
// and script tags ("[VIDEO]:") stripped. The page reads it as window.MusePromptLines; the tests require it.
(function (root) {
  const LIST_MARKER = /^\s*(?:\d{1,3}[.)]|[-•*])\s+/;
  const SCRIPT_TAG = /^\[(?:IMAGE|ANH|ẢNH|VIDEO|VID)\]\s*:?\s*/i;

  function splitPromptLines(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((line) => line.replace(LIST_MARKER, "").replace(SCRIPT_TAG, "").trim())
      .filter(Boolean);
  }

  // Same cap as the engine's output names: a longer left side is a prompt that happens to contain "|".
  const MAX_NAME = 120;

  // "tên-file | prompt" names the output file; the first "|" splits, so later ones stay in the prompt.
  function parsePromptLine(line) {
    const text = String(line || "").trim();
    const at = text.indexOf("|");
    if (at < 0) return { name: "", prompt: text };
    const name = text.slice(0, at).trim();
    const prompt = text.slice(at + 1).trim();
    if (name.length > MAX_NAME) return { name: "", prompt: text };
    return name && prompt ? { name, prompt } : { name: "", prompt: prompt || name };
  }

  function splitNamedPromptLines(text) {
    return splitPromptLines(text)
      .map(parsePromptLine)
      .filter((p) => p.prompt);
  }

  const api = { splitPromptLines, parsePromptLine, splitNamedPromptLines };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MusePromptLines = api;
})(typeof window !== "undefined" ? window : globalThis);
