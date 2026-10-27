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

  const api = { splitPromptLines };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MusePromptLines = api;
})(typeof window !== "undefined" ? window : globalThis);
