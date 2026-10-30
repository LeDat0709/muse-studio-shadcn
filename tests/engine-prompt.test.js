"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Store } = require("../src/store");
const { MuseEngine } = require("../src/engine");

function newEngine(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-prompt-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return new MuseEngine(new Store(dataDir));
}

// A Muse composer page as _sendPromptToMuse sees it; `state.hasInput` toggles the textarea.
function composerTab(state) {
  return {
    async send() {
      return {};
    },
    async evaluate(js) {
      if (js === "Boolean(document.querySelector('textarea'))") return state.hasInput;
      if (js.includes("getBoundingClientRect")) return state.hasInput ? { x: 10, y: 10 } : null;
      if (js.includes("HTMLTextAreaElement.prototype")) return 4;
      if (js.includes("'no-button'")) return "clicked";
      if (js.includes("trim().length")) return 0;
      if (js.includes("location.href")) return { url: "https://muse.ai/thread/abc", tail: "Connecting..." };
      return undefined;
    },
  };
}

describe("_sendPromptToMuse when the composer is missing", () => {
  it("waits for the composer to come back instead of failing the render", async (t) => {
    const engine = newEngine(t);
    const state = { hasInput: false };
    let waits = 0;
    engine._waitWsReady = async () => {
      waits += 1;
      state.hasInput = true;
      return { ok: true, state: "ready" };
    };

    assert.strictEqual(await engine._sendPromptToMuse(composerTab(state), "test"), "clicked");
    assert.strictEqual(waits, 1);
  });

  it("reports where the page was and what it showed when the composer never returns", async (t) => {
    const engine = newEngine(t);
    engine._waitWsReady = async () => ({ ok: false, state: "connecting" });

    await assert.rejects(engine._sendPromptToMuse(composerTab({ hasInput: false }), "test"), (err) => {
      assert.match(err.message, /sau 20s/);
      assert.match(err.message, /trạng thái: connecting/);
      assert.match(err.message, /url: https:\/\/muse\.ai\/thread\/abc/);
      assert.match(err.message, /Connecting\.\.\./);
      return true;
    });
  });

  it("does not wait at all when the composer is already there", async (t) => {
    const engine = newEngine(t);
    engine._waitWsReady = async () => assert.fail("must not wait when the textarea exists");

    assert.strictEqual(await engine._sendPromptToMuse(composerTab({ hasInput: true }), "test"), "clicked");
  });
});
