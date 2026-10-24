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

// 1 poll in the post-send acknowledgement check + 6 idle ticks before the follow-up; one more poll ends the run.
const POLLS_BEFORE_STOP = 7;

// A long-video Muse tab where the agent has replied with a storyboard and gone quiet (no Stop button).
// After POLLS_BEFORE_STOP polls past the first prompt the tab throws to end _generateMedia's loop.
function storyboardTab(hasInput) {
  const tab = { prompts: 0, polls: 0 };
  tab.cdp = {
    async send() {
      return {};
    },
    async evaluate(js) {
      if (js.includes("statusStep")) {
        if (tab.prompts > 0 && ++tab.polls > POLLS_BEFORE_STOP) throw new Error("end-of-test");
        return { cnt: tab.prompts > 0 ? 1 : 0, txt: "Kịch bản: cảnh 1...", stop: false, tail: "", hasInput };
      }
      if (js.includes("agent-media")) return [];
      if (js === "location.href") return "https://muse.ai/thread/abc";
      return false;
    },
  };
  return tab;
}

async function runLongVideo(t, tab) {
  const engine = newEngine(t);
  engine.store.pickAccount = () => ({ id: "acc-test", name: "test", cookies: [] });
  engine._openSessionPage = async () => ({ cdp: tab.cdp, streamSlot: 0 });
  engine._waitWsReady = async () => ({ ok: true, state: "ready" });
  engine._sendPromptToMuse = async () => {
    tab.prompts += 1;
  };
  engine._closeSessionPage = async () => {};
  await assert.rejects(engine.generateVideo({ prompt: "test", duration: "20s" }), /end-of-test/);
}

describe("long-video follow-ups only fire when the agent is really idle", { concurrency: true }, () => {
  it("does not send a follow-up while the page has no composer", async (t) => {
    const tab = storyboardTab(false);
    await runLongVideo(t, tab);
    assert.strictEqual(tab.prompts, 1, "only the initial prompt was sent");
  });

  it("still sends the follow-up when the composer is present (control)", async (t) => {
    const tab = storyboardTab(true);
    await runLongVideo(t, tab);
    assert.strictEqual(tab.prompts, 2, "initial prompt + one storyboard follow-up");
  });
});
