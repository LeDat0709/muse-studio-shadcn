"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  MuseGateway,
  encodeNoiseTransportFrame,
  encodeServiceRequestFrame,
  decodeServiceResponseFrame,
  inspectHistoryEvent,
} = require("../src/gateway");
const { Store } = require("../src/store");
const { MuseEngine } = require("../src/engine");

function encodeServiceResponseFrame({ stream_id, status = 200, body = "" }) {
  // ApplicationResponse: field 1 status (varint), field 3 body (bytes), field 4 end_body (varint 1)
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const appResp = Buffer.concat([
    Buffer.from([0x08, status & 0x7f]),
    Buffer.from([0x1a, bodyBuf.length]),
    bodyBuf,
    Buffer.from([0x20, 0x01]),
  ]);
  const sf = Buffer.concat([
    Buffer.from([0x08, stream_id & 0x7f]),
    Buffer.from([0x1a, appResp.length]),
    appResp,
  ]);
  return Buffer.concat([Buffer.from([0x0a, sf.length]), sf]);
}

test("MuseGateway buffers out-of-order stream frames instead of dropping concurrent responses", async () => {
  const gw = new MuseGateway({ id: "acc1", cookies: [] });
  const incomingFrames = [];

  gw.noise = {
    encrypt: (b) => b,
    decrypt: (b) => b,
  };
  gw.ws = {
    sendBytes: () => {},
    recvBytes: async () => {
      if (!incomingFrames.length) throw new Error("queue empty");
      return incomingFrames.shift();
    },
  };

  // Push response for stream 2 BEFORE stream 1
  const resp2 = encodeServiceResponseFrame({ stream_id: 2, status: 200, body: '{"stream":2}' });
  const resp1 = encodeServiceResponseFrame({ stream_id: 1, status: 200, body: '{"stream":1}' });
  incomingFrames.push(
    encodeNoiseTransportFrame({ chunk_id: 10, chunk_index: 0, total_chunks: 1, payload: resp2 }),
    encodeNoiseTransportFrame({ chunk_id: 11, chunk_index: 0, total_chunks: 1, payload: resp1 })
  );

  const [r1, r2] = await Promise.all([
    gw.requestRaw("GET", "/one"),
    gw.requestRaw("GET", "/two"),
  ]);

  assert.deepStrictEqual(JSON.parse(r1.body.toString("utf8")), { stream: 1 });
  assert.deepStrictEqual(JSON.parse(r2.body.toString("utf8")), { stream: 2 });
});

test("MuseGateway reassembles interleaved multi-chunk transport frames by chunk_id", async () => {
  const gw = new MuseGateway({ id: "acc1", cookies: [] });
  const incomingFrames = [];

  gw.noise = {
    encrypt: (b) => b,
    decrypt: (b) => b,
  };
  gw.ws = {
    sendBytes: () => {},
    recvBytes: async () => {
      if (!incomingFrames.length) throw new Error("queue empty");
      return incomingFrames.shift();
    },
  };

  const fullA = Buffer.from("AAAA-BBBB");
  const fullB = Buffer.from("1111-2222");

  // Interleave chunk 0 of cid=1, chunk 0 of cid=2, chunk 1 of cid=1, chunk 1 of cid=2
  incomingFrames.push(
    encodeNoiseTransportFrame({ chunk_id: 1, chunk_index: 0, total_chunks: 2, payload: fullA.subarray(0, 4) }),
    encodeNoiseTransportFrame({ chunk_id: 2, chunk_index: 0, total_chunks: 2, payload: fullB.subarray(0, 4) }),
    encodeNoiseTransportFrame({ chunk_id: 1, chunk_index: 1, total_chunks: 2, payload: fullA.subarray(4) }),
    encodeNoiseTransportFrame({ chunk_id: 2, chunk_index: 1, total_chunks: 2, payload: fullB.subarray(4) })
  );

  const out1 = await gw._readTransportFrame(5000);
  const out2 = await gw._readTransportFrame(5000);

  assert.strictEqual(out1.toString("utf8"), "AAAA-BBBB");
  assert.strictEqual(out2.toString("utf8"), "1111-2222");
});

test("inspectHistoryEvent extracts sessionId and clientMessageId and engine filters foreign final_<tag> videos", () => {
  const ev = {
    message_id: "msg_99",
    session_id: "sess_abc",
    event_name: "message.assistant",
    occurred_at_ms: 1700000005000,
    payload: {
      reply_to_message_id: "user_1",
      client_message_id: "cli_1",
      text: "Done video!",
      data: {
        videos: [
          {
            path: "/workspace/imagine_media/final_aaaaaa_20s.mp4",
            mime: "video/mp4",
          },
        ],
      },
    },
  };
  const info = inspectHistoryEvent(ev);
  assert.strictEqual(info.sessionId, "sess_abc");
  assert.strictEqual(info.clientMessageId, "cli_1");
  assert.strictEqual(info.replyTo, "user_1");
  assert.strictEqual(info.mediaRefs.length, 1);
  assert.strictEqual(info.mediaRefs[0].path, "workspace/imagine_media/final_aaaaaa_20s.mp4");
});

test("MuseEngine.cancelTasks cancels matching running tasks by rowId without marking account failed", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-cancel-test-"));
  try {
    const store = new Store(tmpDir);
    const engine = new MuseEngine(store);
    const t1 = store.createTask("video", "prompt 1", "muse-video", "acc_1", "row_A");
    const t2 = store.createTask("video", "prompt 2", "muse-video", "acc_1", "row_B");

    let cancelChatCalled = 0;
    const makeFakeRunner = (task, rowId) => ({
      taskId: task.id,
      rowId,
      accountId: "acc_1",
      accountName: "TestAcc",
      sessionId: `sess_${rowId}`,
      cancelled: false,
      cancelReason: "",
      gw: {
        cancelChat: async () => {
          cancelChatCalled += 1;
          return true;
        },
        close: () => {},
      },
    });

    engine.activeRunners.set(t1.id, makeFakeRunner(t1, "row_A"));
    engine.activeRunners.set(t2.id, makeFakeRunner(t2, "row_B"));

    const res = await engine.cancelTasks({ rowIds: ["row_A"] });
    assert.strictEqual(res.cancelledCount, 1);
    assert.deepStrictEqual(res.cancelledRowIds, ["row_A"]);
    assert.strictEqual(cancelChatCalled, 1);
    assert.strictEqual(engine.activeRunners.get(t1.id).cancelled, true);
    assert.strictEqual(engine.activeRunners.get(t2.id).cancelled, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
