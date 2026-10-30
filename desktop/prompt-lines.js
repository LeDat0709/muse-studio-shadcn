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

  function clampConcurrency(val) {
    return Math.max(1, Math.min(50, Math.round(Number(val) || 2)));
  }

  // Merges waiting/selected rows into the active batch queue without duplicating running or queued items.
  function mergePendingIntoQueue(activeQueue, targets, runningIds, { prioritize = false } = {}) {
    const busy = runningIds instanceof Set ? runningIds : new Set(runningIds || []);
    const runnable = (Array.isArray(targets) ? targets : []).filter(
      (r) => r && !busy.has(r.id) && r.status !== "running" && r.prompt && String(r.prompt).trim()
    );
    const targetIds = new Set(runnable.map((r) => r.id));
    const existingIds = new Set((activeQueue || []).map((r) => r.id));
    const newlyQueuedCount = runnable.filter((r) => !existingIds.has(r.id)).length;
    const restQueue = (activeQueue || []).filter((r) => !targetIds.has(r.id) && !busy.has(r.id));
    const queue = prioritize ? [...runnable, ...restQueue] : [...restQueue, ...runnable];
    return { queue, runnable, newlyQueuedCount };
  }

  const api = {
    splitPromptLines,
    parsePromptLine,
    splitNamedPromptLines,
    clampConcurrency,
    mergePendingIntoQueue,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MusePromptLines = api;
})(typeof window !== "undefined" ? window : globalThis);
