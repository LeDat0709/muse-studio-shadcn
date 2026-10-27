"use strict";

const crypto = require("crypto");
const tls = require("tls");
const fs = require("fs");
const path = require("path");

const MUSE_WEB = "https://muse.ai";
const GATEWAY_HOST = "hatch.metaaivm.com";
const GATEWAY_PATH = "/v1/noise";

const SERVICES = {
  daemon: 0,
  sentinel: 1,
  vault: 2,
  authd: 3,
};

// X25519 ASN.1 DER prefixes for Node.js crypto KeyObject import/export
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

let _routesMap = null;
function getRoutesMap() {
  if (_routesMap) return _routesMap;
  _routesMap = new Map();
  try {
    const routesPath = path.join(__dirname, "routes.json");
    const list = JSON.parse(fs.readFileSync(routesPath, "utf8"));
    for (const r of list) {
      if (r && r.method) {
        _routesMap.set(r.method, r);
      }
    }
  } catch (_err) {
    // Fallback core routes if routes.json cannot be loaded
    const fallback = [
      { method: "chat.history", http: "GET", path: "/chat/history" },
      { method: "chat.stream", http: "POST", path: "/chat/stream", streamMode: "subscription" },
      { method: "chat.subscribe", http: "POST", path: "/chat/subscribe", streamMode: "subscription" },
      { method: "chat.unread_count", http: "GET", path: "/chat/unread-count" },
      { method: "session.start", http: "POST", path: "/session/start" },
      { method: "sessions.list", http: "GET", path: "/api/session/list" },
      { method: "identity", http: "GET", path: "/identity" },
      { method: "vm.health", http: "GET", path: "/health" },
      { method: "artifacts.list", http: "GET", path: "/api/artifacts" },
      { method: "artifacts.fetch_url", http: "GET", path: "/artifacts/fetch_url" },
      { method: "fs.list", http: "POST", path: "/fs/list" },
      { method: "fs.stat", http: "POST", path: "/fs/stat" },
      { method: "fs.read", http: "POST", path: "/fs/read" },
      { method: "fs.write", http: "POST", path: "/fs/write" },
      { method: "fs.export", http: "POST", path: "/fs/export" },
      { method: "fs.search", http: "POST", path: "/fs/search" },
    ];
    for (const r of fallback) _routesMap.set(r.method, r);
  }
  return _routesMap;
}

// ==================== LIGHTWEIGHT PROTOBUF WIRE CODEC ====================
// Matches desc0.bin (NoiseTransportFrame) & desc1.bin (ServiceRequest/Response/Frame)

function encodeVarint(value) {
  let v = BigInt(value);
  if (v < 0n) {
    v = BigInt.asUintN(64, v);
  }
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function decodeVarint(buf, offset = 0) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos];
    pos += 1;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return { value: result, nextOffset: pos };
    }
    shift += 7n;
    if (shift > 70n) {
      throw new Error("Protobuf varint overflow");
    }
  }
  throw new Error("Unexpected EOF decoding Protobuf varint");
}

function encodeTag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeBytesField(fieldNumber, buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || "");
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(data.length), data]);
}

function encodeStringField(fieldNumber, str) {
  const s = String(str || "");
  if (!s) return Buffer.alloc(0);
  return encodeBytesField(fieldNumber, Buffer.from(s, "utf8"));
}

function encodeVarintField(fieldNumber, val, alwaysWrite = false) {
  const n = BigInt(val || 0);
  if (!alwaysWrite && n === 0n) return Buffer.alloc(0);
  return Buffer.concat([encodeTag(fieldNumber, 0), encodeVarint(n)]);
}

function parseProtoFields(buf) {
  const fields = [];
  let offset = 0;
  while (offset < buf.length) {
    const tagRes = decodeVarint(buf, offset);
    offset = tagRes.nextOffset;
    const tag = Number(tagRes.value);
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;

    if (wireType === 0) {
      const valRes = decodeVarint(buf, offset);
      offset = valRes.nextOffset;
      fields.push({ fieldNumber, wireType, value: valRes.value });
    } else if (wireType === 2) {
      const lenRes = decodeVarint(buf, offset);
      offset = lenRes.nextOffset;
      const len = Number(lenRes.value);
      const data = buf.subarray(offset, offset + len);
      offset += len;
      fields.push({ fieldNumber, wireType, value: data });
    } else if (wireType === 1) {
      const data = buf.subarray(offset, offset + 8);
      offset += 8;
      fields.push({ fieldNumber, wireType, value: data });
    } else if (wireType === 5) {
      const data = buf.subarray(offset, offset + 4);
      offset += 4;
      fields.push({ fieldNumber, wireType, value: data });
    } else {
      throw new Error(`Unsupported Protobuf wireType=${wireType} at field=${fieldNumber}`);
    }
  }
  return fields;
}

/**
 * NoiseTransportFrame (desc0.bin):
 *   optional int64 chunk_id = 1;
 *   optional uint32 chunk_index = 2;
 *   optional uint32 total_chunks = 3;
 *   optional bytes payload = 4;
 */
function encodeNoiseTransportFrame({ chunk_id = 0, chunk_index = 0, total_chunks = 1, payload = Buffer.alloc(0) }) {
  return Buffer.concat([
    encodeVarintField(1, chunk_id, true),
    encodeVarintField(2, chunk_index, true),
    encodeVarintField(3, total_chunks, true),
    encodeBytesField(4, payload),
  ]);
}

function decodeNoiseTransportFrame(buf) {
  const out = {
    chunk_id: 0,
    chunk_index: 0,
    total_chunks: 1,
    payload: Buffer.alloc(0),
  };
  for (const f of parseProtoFields(buf)) {
    if (f.fieldNumber === 1) out.chunk_id = Number(f.value);
    else if (f.fieldNumber === 2) out.chunk_index = Number(f.value);
    else if (f.fieldNumber === 3) out.total_chunks = Number(f.value);
    else if (f.fieldNumber === 4) out.payload = f.value;
  }
  return out;
}

/**
 * Header (desc1.bin):
 *   string key = 1;
 *   string value = 2;
 */
function encodeHeader(key, value) {
  return Buffer.concat([
    encodeStringField(1, key),
    encodeStringField(2, value),
  ]);
}

function decodeHeader(buf) {
  let key = "";
  let value = "";
  for (const f of parseProtoFields(buf)) {
    if (f.fieldNumber === 1) key = f.value.toString("utf8");
    else if (f.fieldNumber === 2) value = f.value.toString("utf8");
  }
  return { key, value };
}

/**
 * ApplicationRequest (desc1.bin):
 *   string verb = 1;
 *   string path = 2;
 *   repeated Header headers = 3;
 *   bytes body = 4;
 *   bool end_body = 5;
 */
function encodeApplicationRequest({ verb = "GET", path: reqPath = "/", headers = [], body = Buffer.alloc(0), end_body = true }) {
  const parts = [
    encodeStringField(1, verb),
    encodeStringField(2, reqPath),
  ];
  for (const h of headers) {
    const k = Array.isArray(h) ? h[0] : h.key;
    const v = Array.isArray(h) ? h[1] : h.value;
    parts.push(encodeBytesField(3, encodeHeader(k, v)));
  }
  if (body && body.length > 0) {
    parts.push(encodeBytesField(4, body));
  }
  if (end_body) {
    parts.push(encodeVarintField(5, 1));
  }
  return Buffer.concat(parts);
}

/**
 * ServiceFrame (desc1.bin):
 *   int64 stream_id = 1;
 *   ApplicationRequest request = 2;
 *   ApplicationResponse response = 3;
 *   BodyChunk body_chunk = 4;
 *   Reset reset = 5;
 */
function encodeServiceRequestFrame({ service = 0, stream_id = 1, request }) {
  const appReqBuf = encodeApplicationRequest(request);
  const serviceFrameBuf = Buffer.concat([
    encodeVarintField(1, stream_id),
    encodeBytesField(2, appReqBuf),
  ]);
  const parts = [];
  if (service !== 0) {
    parts.push(encodeVarintField(1, service));
  }
  parts.push(encodeBytesField(2, serviceFrameBuf));
  return Buffer.concat(parts);
}

function decodeApplicationResponse(buf) {
  const out = {
    status: 0,
    headers: [],
    body: Buffer.alloc(0),
    end_body: false,
  };
  for (const f of parseProtoFields(buf)) {
    if (f.fieldNumber === 1) out.status = Number(f.value);
    else if (f.fieldNumber === 2) out.headers.push(decodeHeader(f.value));
    else if (f.fieldNumber === 3) out.body = f.value;
    else if (f.fieldNumber === 4) out.end_body = Boolean(f.value);
  }
  return out;
}

function decodeBodyChunk(buf) {
  const out = {
    data: Buffer.alloc(0),
    end_body: false,
  };
  for (const f of parseProtoFields(buf)) {
    if (f.fieldNumber === 1) out.data = f.value;
    else if (f.fieldNumber === 2) out.end_body = Boolean(f.value);
  }
  return out;
}

function decodeReset(buf) {
  const out = {
    code: 0,
    reason: "",
  };
  for (const f of parseProtoFields(buf)) {
    if (f.fieldNumber === 1) out.code = Number(f.value);
    else if (f.fieldNumber === 2) out.reason = f.value.toString("utf8");
  }
  return out;
}

function decodeServiceResponseFrame(rawServiceRespBuf) {
  let serviceFrameBytes = Buffer.alloc(0);
  for (const f of parseProtoFields(rawServiceRespBuf)) {
    if (f.fieldNumber === 1 && f.wireType === 2) {
      serviceFrameBytes = f.value;
    }
  }
  const frame = {
    stream_id: 0,
    kind: null,
    response: null,
    body_chunk: null,
    reset: null,
  };
  for (const f of parseProtoFields(serviceFrameBytes)) {
    if (f.fieldNumber === 1) {
      frame.stream_id = Number(f.value);
    } else if (f.fieldNumber === 3 && f.wireType === 2) {
      frame.kind = "response";
      frame.response = decodeApplicationResponse(f.value);
    } else if (f.fieldNumber === 4 && f.wireType === 2) {
      frame.kind = "body_chunk";
      frame.body_chunk = decodeBodyChunk(f.value);
    } else if (f.fieldNumber === 5 && f.wireType === 2) {
      frame.kind = "reset";
      frame.reset = decodeReset(f.value);
    }
  }
  return frame;
}

// ==================== PURE NODE.JS NOISE_XX_25519_AESGCM_SHA256 ====================

function generateX25519KeyPair(rawPrivateBytes = null) {
  if (rawPrivateBytes) {
    const privKeyObj = crypto.createPrivateKey({
      key: Buffer.concat([X25519_PKCS8_PREFIX, rawPrivateBytes]),
      format: "der",
      type: "pkcs8",
    });
    const pubKeyObj = crypto.createPublicKey(privKeyObj);
    const spki = pubKeyObj.export({ format: "der", type: "spki" });
    return {
      privateKey: privKeyObj,
      publicKey: pubKeyObj,
      rawPublic: Buffer.from(spki.subarray(spki.length - 32)),
    };
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey,
    publicKey,
    rawPublic: Buffer.from(spki.subarray(spki.length - 32)),
  };
}

function x25519DH(privateKeyObj, remoteRawPublicBytes) {
  if (!remoteRawPublicBytes || remoteRawPublicBytes.length !== 32) {
    throw new Error(`Invalid X25519 public key length: ${remoteRawPublicBytes?.length}`);
  }
  const remotePubKeyObj = crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, remoteRawPublicBytes]),
    format: "der",
    type: "spki",
  });
  return crypto.diffieHellman({
    privateKey: privateKeyObj,
    publicKey: remotePubKeyObj,
  });
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest();
}

function hmacSha256(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function hkdf2(chainingKey, inputKeyMaterial) {
  const tempKey = hmacSha256(chainingKey, inputKeyMaterial);
  const out1 = hmacSha256(tempKey, Buffer.from([0x01]));
  const out2 = hmacSha256(tempKey, Buffer.concat([out1, Buffer.from([0x02])]));
  return [out1, out2];
}

function aeadEncryptAesGcm(key, nonceUint64, ad, plaintext) {
  const nonce = Buffer.alloc(12, 0);
  nonce.writeBigUInt64BE(BigInt(nonceUint64), 4);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  if (ad && ad.length > 0) {
    cipher.setAAD(ad);
  }
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([enc, tag]);
}

function aeadDecryptAesGcm(key, nonceUint64, ad, ciphertextWithTag) {
  if (!ciphertextWithTag || ciphertextWithTag.length < 16) {
    throw new Error("Noise AESGCM ciphertext too short (< 16 bytes)");
  }
  const nonce = Buffer.alloc(12, 0);
  nonce.writeBigUInt64BE(BigInt(nonceUint64), 4);
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);
  const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  if (ad && ad.length > 0) {
    decipher.setAAD(ad);
  }
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

class NoiseXXSession {
  constructor(staticPrivateBytes = null) {
    const protocolName = Buffer.from("Noise_XX_25519_AESGCM_SHA256", "ascii");
    this.h = Buffer.alloc(32, 0);
    protocolName.copy(this.h, 0);
    this.ck = Buffer.from(this.h);
    this.k = null;
    this.n = 0n;

    // MixHash(prologue = "")
    this.mixHash(Buffer.alloc(0));

    this.s = generateX25519KeyPair(staticPrivateBytes);
    this.e = null;
    this.re = null;
    this.rs = null;

    this.sendKey = null;
    this.sendNonce = 0n;
    this.recvKey = null;
    this.recvNonce = 0n;
    this.handshakeComplete = false;
  }

  mixHash(data) {
    this.h = sha256(Buffer.concat([this.h, data]));
  }

  mixKey(ikm) {
    const [ck, k] = hkdf2(this.ck, ikm);
    this.ck = ck;
    this.k = k;
    this.n = 0n;
  }

  encryptAndHash(plaintext) {
    let ciphertext;
    if (!this.k) {
      ciphertext = Buffer.from(plaintext);
    } else {
      ciphertext = aeadEncryptAesGcm(this.k, this.n, this.h, plaintext);
      this.n += 1n;
    }
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext) {
    let plaintext;
    if (!this.k) {
      plaintext = Buffer.from(ciphertext);
    } else {
      plaintext = aeadDecryptAesGcm(this.k, this.n, this.h, ciphertext);
      this.n += 1n;
    }
    this.mixHash(ciphertext);
    return plaintext;
  }

  // Message 1: -> e
  writeHandshakeMessage1(payload = Buffer.alloc(0)) {
    this.e = generateX25519KeyPair();
    this.mixHash(this.e.rawPublic);
    const encPayload = this.encryptAndHash(payload);
    return Buffer.concat([this.e.rawPublic, encPayload]);
  }

  // Message 2: <- e, ee, s, es
  readHandshakeMessage2(msg2) {
    if (!msg2 || msg2.length < 96) {
      throw new Error(`Noise handshake msg2 too short (${msg2?.length || 0} bytes)`);
    }
    this.re = Buffer.from(msg2.subarray(0, 32));
    this.mixHash(this.re);

    // ee
    this.mixKey(x25519DH(this.e.privateKey, this.re));

    // s (32B pubkey + 16B tag = 48 bytes)
    const encRs = msg2.subarray(32, 80);
    this.rs = this.decryptAndHash(encRs);

    // es
    this.mixKey(x25519DH(this.e.privateKey, this.rs));

    // payload
    const encPayload = msg2.subarray(80);
    return this.decryptAndHash(encPayload);
  }

  // Message 3: -> s, se
  writeHandshakeMessage3(payload = Buffer.alloc(0)) {
    const encS = this.encryptAndHash(this.s.rawPublic);
    // se
    this.mixKey(x25519DH(this.s.privateKey, this.re));
    const encPayload = this.encryptAndHash(payload);

    // Split()
    const [k1, k2] = hkdf2(this.ck, Buffer.alloc(0));
    this.sendKey = k1;
    this.sendNonce = 0n;
    this.recvKey = k2;
    this.recvNonce = 0n;
    this.handshakeComplete = true;

    return Buffer.concat([encS, encPayload]);
  }

  encrypt(plaintext) {
    if (!this.handshakeComplete) {
      throw new Error("Noise handshake not complete");
    }
    const ct = aeadEncryptAesGcm(this.sendKey, this.sendNonce, Buffer.alloc(0), plaintext);
    this.sendNonce += 1n;
    return ct;
  }

  decrypt(ciphertext) {
    if (!this.handshakeComplete) {
      throw new Error("Noise handshake not complete");
    }
    const pt = aeadDecryptAesGcm(this.recvKey, this.recvNonce, Buffer.alloc(0), ciphertext);
    this.recvNonce += 1n;
    return pt;
  }
}

// ==================== BINARY WEBSOCKET OVER TLS CLIENT ====================

class BinaryWebSocketClient {
  constructor(urlStr, options = {}) {
    this.url = new URL(urlStr);
    this.headers = options.headers || {};
    this.socket = null;
    this.connected = false;
    this.closed = false;
    this._recvBuffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = 0;
    this._messageQueue = [];
    this._waiters = [];
    this._closeError = null;
  }

  async connect(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const host = this.url.hostname;
      const port = Number(this.url.port || (this.url.protocol === "wss:" ? 443 : 80));
      const pathWithQuery = `${this.url.pathname || "/"}${this.url.search || ""}`;
      const wsKey = crypto.randomBytes(16).toString("base64");

      const timer = setTimeout(() => {
        this.close();
        reject(new Error(`WebSocket connection timeout (${timeoutMs}ms) to ${host}`));
      }, timeoutMs);

      const sock = tls.connect({
        host,
        port,
        servername: host,
        ALPNProtocols: ["http/1.1"],
      });
      this.socket = sock;

      let handshakeDone = false;
      let headerBuf = Buffer.alloc(0);

      sock.on("secureConnect", () => {
        const reqLines = [
          `GET ${pathWithQuery} HTTP/1.1`,
          `Host: ${host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${wsKey}`,
          "Sec-WebSocket-Version: 13",
          `Origin: ${this.headers.Origin || MUSE_WEB}`,
          `User-Agent: ${
            this.headers["User-Agent"] ||
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
          }`,
        ];
        for (const [k, v] of Object.entries(this.headers)) {
          if (!["origin", "user-agent", "host", "upgrade", "connection"].includes(k.toLowerCase())) {
            reqLines.push(`${k}: ${v}`);
          }
        }
        reqLines.push("", "");
        sock.write(reqLines.join("\r\n"));
      });

      sock.on("data", (chunk) => {
        if (!handshakeDone) {
          headerBuf = Buffer.concat([headerBuf, chunk]);
          const idx = headerBuf.indexOf("\r\n\r\n");
          if (idx === -1) return;

          const headerStr = headerBuf.subarray(0, idx).toString("utf8");
          const firstLine = headerStr.split("\r\n")[0] || "";
          if (!firstLine.includes("101")) {
            clearTimeout(timer);
            this.close();
            reject(new Error(`WebSocket upgrade failed: ${firstLine}`));
            return;
          }

          handshakeDone = true;
          this.connected = true;
          clearTimeout(timer);

          const remaining = headerBuf.subarray(idx + 4);
          headerBuf = null;
          if (remaining.length > 0) {
            this._onSocketData(remaining);
          }
          resolve();
        } else {
          this._onSocketData(chunk);
        }
      });

      sock.on("error", (err) => {
        clearTimeout(timer);
        this._closeError = err;
        this.closed = true;
        this._flushWaitersWithError(err);
        if (!handshakeDone) reject(err);
      });

      sock.on("close", () => {
        clearTimeout(timer);
        this.closed = true;
        this._flushWaitersWithError(this._closeError || new Error("WebSocket closed by remote host"));
      });
    });
  }

  _flushWaitersWithError(err) {
    while (this._waiters.length > 0) {
      const w = this._waiters.shift();
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  _pushMessage(msgBuf) {
    if (this._waiters.length > 0) {
      const w = this._waiters.shift();
      clearTimeout(w.timer);
      w.resolve(msgBuf);
    } else {
      this._messageQueue.push(msgBuf);
    }
  }

  _onSocketData(chunk) {
    this._recvBuffer = Buffer.concat([this._recvBuffer, chunk]);

    while (this._recvBuffer.length >= 2) {
      const b0 = this._recvBuffer[0];
      const b1 = this._recvBuffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._recvBuffer.length < 4) return;
        payloadLen = this._recvBuffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._recvBuffer.length < 10) return;
        payloadLen = Number(this._recvBuffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (this._recvBuffer.length < offset + maskLen + payloadLen) {
        return;
      }

      let maskKey = null;
      if (masked) {
        maskKey = this._recvBuffer.subarray(offset, offset + 4);
        offset += 4;
      }

      const payload = Buffer.from(this._recvBuffer.subarray(offset, offset + payloadLen));
      this._recvBuffer = this._recvBuffer.subarray(offset + payloadLen);

      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      if (opcode === 0x08) {
        // Close frame
        this.closed = true;
        this._flushWaitersWithError(new Error("WebSocket closed by server"));
        try {
          this.socket?.end();
        } catch (_e) {}
        return;
      } else if (opcode === 0x09) {
        // Ping -> send Pong
        this._sendRawFrame(0x0a, payload);
      } else if (opcode === 0x0a) {
        // Pong -> ignore
      } else if (opcode === 0x00) {
        // Continuation frame
        this._fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this._fragments);
          this._fragments = [];
          this._fragmentOpcode = 0;
          this._pushMessage(full);
        }
      } else if (opcode === 0x01 || opcode === 0x02) {
        if (fin) {
          this._pushMessage(payload);
        } else {
          this._fragments = [payload];
          this._fragmentOpcode = opcode;
        }
      }
    }
  }

  _sendRawFrame(opcode, payloadBuf) {
    if (this.closed || !this.socket) {
      throw new Error("WebSocket is not open");
    }
    const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(payloadBuf || "");
    const len = payload.length;
    let headerLen = 2;
    if (len >= 65536) headerLen = 10;
    else if (len >= 126) headerLen = 4;

    const frame = Buffer.allocUnsafe(headerLen + 4 + len);
    frame[0] = 0x80 | (opcode & 0x0f);

    if (len < 126) {
      frame[1] = 0x80 | len;
    } else if (len < 65536) {
      frame[1] = 0x80 | 126;
      frame.writeUInt16BE(len, 2);
    } else {
      frame[1] = 0x80 | 127;
      frame.writeBigUInt64BE(BigInt(len), 2);
    }

    const maskKey = crypto.randomBytes(4);
    maskKey.copy(frame, headerLen);
    for (let i = 0; i < len; i += 1) {
      frame[headerLen + 4 + i] = payload[i] ^ maskKey[i & 3];
    }
    this.socket.write(frame);
  }

  sendBytes(buf) {
    this._sendRawFrame(0x02, buf);
  }

  async recvBytes(timeoutMs = 30000) {
    if (this._messageQueue.length > 0) {
      return this._messageQueue.shift();
    }
    if (this.closed) {
      throw this._closeError || new Error("WebSocket is closed");
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this._waiters.indexOf(waiter);
          if (idx !== -1) this._waiters.splice(idx, 1);
          reject(new Error(`WebSocket recv timeout after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs),
      };
      this._waiters.push(waiter);
    });
  }

  close() {
    this.closed = true;
    try {
      if (this.socket && !this.socket.destroyed) {
        this.socket.destroy();
      }
    } catch (_e) {}
    this._flushWaitersWithError(new Error("WebSocket closed"));
  }
}

// ==================== MUSE.AI HTTPS AUTH & NOISE-XX GATEWAY ====================

function buildCookieMapFromAccount(account) {
  const map = new Map();
  for (const c of account?.cookies || []) {
    if (c && c.name && c.value !== undefined) {
      map.set(c.name, { ...c });
    }
  }
  return map;
}

function cookieHeaderFromMap(cookieMap) {
  return Array.from(cookieMap.values())
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

function absorbSetCookieHeaders(res, cookieMap) {
  const rawSetCookies =
    typeof res?.headers?.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const sc of rawSetCookies) {
    const parts = String(sc || "")
      .split(";")
      .map((s) => s.trim());
    const [nv, ...attrs] = parts;
    if (!nv || !nv.includes("=")) continue;
    const eq = nv.indexOf("=");
    const name = nv.slice(0, eq).trim();
    const value = nv.slice(eq + 1).trim();
    if (!name || !value) continue;

    let expires = 0;
    for (const attr of attrs) {
      const low = attr.toLowerCase();
      if (low.startsWith("max-age=")) {
        const sec = Number(attr.slice(8).trim());
        if (Number.isFinite(sec) && sec > 0) {
          expires = Math.floor(Date.now() / 1000) + sec;
        }
      } else if (low.startsWith("expires=") && !expires) {
        const ts = Date.parse(attr.slice(8).trim());
        if (Number.isFinite(ts) && ts > 0) {
          expires = Math.floor(ts / 1000);
        }
      }
    }
    const prev = cookieMap.get(name) || {
      name,
      domain: ".muse.ai",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    };
    cookieMap.set(name, {
      ...prev,
      name,
      value,
      expires: expires || prev.expires || Math.floor(Date.now() / 1000) + 48 * 3600,
    });
  }
}

function buildBrowserHeaders(cookieMap, extra = {}) {
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
    Origin: MUSE_WEB,
    Referer: `${MUSE_WEB}/`,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    Cookie: cookieHeaderFromMap(cookieMap),
    ...extra,
  };
}

class MuseGateway {
  constructor(account, options = {}) {
    this.account = account;
    this.store = options.store || null;
    this.cookieMap = buildCookieMapFromAccount(account);
    this.deviceId = account?.device_id || crypto.randomUUID();
    this.vmId = account?.vm_id || "";
    this.vmState = account?.vm_state || "RUNNING";
    this.email = account?.email || "";
    this.accessToken = "";
    this.hatchToken = "";
    this.ws = null;
    this.noise = null;
    this._chunkId = 0;
    this._streamId = 0;
    this._readLock = Promise.resolve();
    this._transportChunks = new Map();
    this._streamFrames = new Map();
  }

  _persistCookiesIfNeeded() {
    if (!this.store || !this.account?.id) return;
    const merged = Array.from(this.cookieMap.values());
    if (merged.some((c) => c.name === "hatch_sess" && c.value)) {
      this.store.updateAccountCookies(
        this.account.id,
        merged,
        this.email || "",
        this.vmState || "RUNNING"
      );
    }
  }

  async authenticateAndWakeVm() {
    const hasSess = Array.from(this.cookieMap.values()).some(
      (c) => c.name === "hatch_sess" && c.value
    );
    if (!hasSess) {
      const err = new Error("Ních DIE: Thiếu cookie cốt lõi hatch_sess");
      err.fatalDie = true;
      throw err;
    }

    // 1. GET /api/session
    let sessionData = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const r1 = await fetch(`${MUSE_WEB}/api/session`, {
        method: "GET",
        headers: buildBrowserHeaders(this.cookieMap),
        signal: AbortSignal.timeout(15000),
      });
      absorbSetCookieHeaders(r1, this.cookieMap);

      if (r1.status === 401 || r1.status === 403) {
        const err = new Error(`Ních DIE: Phiên đăng nhập hết hạn (/api/session HTTP ${r1.status})`);
        err.fatalDie = true;
        throw err;
      }
      if (!r1.ok) {
        throw new Error(`Lỗi kết nối /api/session (HTTP ${r1.status})`);
      }

      sessionData = await r1.json().catch(() => null);
      if (sessionData?.email || sessionData?.user?.email) {
        this.email = sessionData.email || sessionData.user?.email || this.email;
      }

      if (sessionData && sessionData.status === "assigned" && sessionData.vm_id) {
        this.vmId = sessionData.vm_id;
        this.vmState = sessionData.vm_state || "RUNNING";
        break;
      }

      // If VM is restarting or sleeping, wake it and retry
      const candidateVmId = sessionData?.vm_id || this.vmId;
      if (candidateVmId) {
        await fetch(`${MUSE_WEB}/api/hatch/vm/wake`, {
          method: "POST",
          headers: buildBrowserHeaders(this.cookieMap, {
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({
            vm_id: candidateVmId,
            retry_count: attempt,
            connect_attempt_id: crypto.randomUUID(),
          }),
          signal: AbortSignal.timeout(15000),
        }).catch(() => null);
      }
      await new Promise((r) => setTimeout(r, 1800));
    }

    if (!this.vmId) {
      const st = sessionData?.status || "unassigned";
      const err = new Error(`Không lấy được VM từ /api/session (status=${st})`);
      if (st === "unauthenticated" || st === "logged_out") {
        err.fatalDie = true;
      }
      throw err;
    }

    // Always wake VM if not RUNNING
    if (this.vmState !== "RUNNING") {
      const rw = await fetch(`${MUSE_WEB}/api/hatch/vm/wake`, {
        method: "POST",
        headers: buildBrowserHeaders(this.cookieMap, {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          vm_id: this.vmId,
          retry_count: 0,
          connect_attempt_id: crypto.randomUUID(),
        }),
        signal: AbortSignal.timeout(15000),
      }).catch(() => null);
      if (rw) {
        absorbSetCookieHeaders(rw, this.cookieMap);
        if (rw.ok) this.vmState = "RUNNING";
      }
    }

    // 2. POST /api/auth/check -> access_token
    const rAuth = await fetch(`${MUSE_WEB}/api/auth/check`, {
      method: "POST",
      headers: buildBrowserHeaders(this.cookieMap, {
        "Content-Length": "0",
      }),
      body: "",
      signal: AbortSignal.timeout(15000),
    });
    absorbSetCookieHeaders(rAuth, this.cookieMap);

    if (rAuth.status === 401 || rAuth.status === 403) {
      const err = new Error(`Ních DIE: /api/auth/check từ chối truy cập (HTTP ${rAuth.status})`);
      err.fatalDie = true;
      throw err;
    }
    const authJson = await rAuth.json().catch(() => null);
    if (!rAuth.ok || !authJson?.access_token) {
      throw new Error(`Không lấy được access_token từ /api/auth/check (HTTP ${rAuth.status})`);
    }
    this.accessToken = authJson.access_token;

    // 3. POST /api/hatch/token -> hatch gateway token
    const rHatch = await fetch(`${MUSE_WEB}/api/hatch/token`, {
      method: "POST",
      headers: buildBrowserHeaders(this.cookieMap, {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        vmAddress: `wss://${this.vmId}.metaaivm.com/`,
        vmName: this.vmId,
      }),
      signal: AbortSignal.timeout(15000),
    });
    absorbSetCookieHeaders(rHatch, this.cookieMap);

    const hatchJson = await rHatch.json().catch(() => null);
    if (!rHatch.ok || !hatchJson?.token) {
      throw new Error(`Không lấy được hatch token từ /api/hatch/token (HTTP ${rHatch.status})`);
    }
    this.hatchToken = hatchJson.token;
    this._persistCookiesIfNeeded();

    return {
      vmId: this.vmId,
      vmState: this.vmState,
      email: this.email,
      accessToken: this.accessToken,
      hatchToken: this.hatchToken,
    };
  }

  async connect(timeoutMs = 25000) {
    await this.authenticateAndWakeVm();

    const wsUrl = `wss://${GATEWAY_HOST}${GATEWAY_PATH}?vm_id=${encodeURIComponent(
      this.vmId
    )}&auth_token=${encodeURIComponent(this.hatchToken)}`;

    // Connect WebSocket & perform 3-message Noise_XX_25519_AESGCM_SHA256 handshake
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ws = new BinaryWebSocketClient(wsUrl, {
        headers: {
          Origin: MUSE_WEB,
        },
      });
      try {
        await ws.connect(timeoutMs);
        const noise = new NoiseXXSession();

        // msg1: -> e (32 bytes)
        const msg1 = noise.writeHandshakeMessage1(Buffer.alloc(0));
        ws.sendBytes(msg1);

        // msg2: <- e, ee, s, es (96 bytes)
        const msg2 = await ws.recvBytes(timeoutMs);
        noise.readHandshakeMessage2(msg2);

        // msg3: -> s, se (64 bytes)
        const msg3 = noise.writeHandshakeMessage3(Buffer.alloc(0));
        ws.sendBytes(msg3);

        this.ws = ws;
        this.noise = noise;
        return this;
      } catch (err) {
        ws.close();
        if (attempt === 2) throw err;
        // Wake VM and refresh token if connection reset
        await fetch(`${MUSE_WEB}/api/hatch/vm/wake`, {
          method: "POST",
          headers: buildBrowserHeaders(this.cookieMap, {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({
            vm_id: this.vmId,
            retry_count: attempt,
            connect_attempt_id: crypto.randomUUID(),
          }),
        }).catch(() => null);
        await new Promise((r) => setTimeout(r, 1500));
        await this.authenticateAndWakeVm();
      }
    }
    return this;
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  _sendTransportFrame(payloadBuf, chunkSize = 60000) {
    const data = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(payloadBuf || "");
    this._chunkId += 1;
    const cid = this._chunkId;
    const parts = [];
    if (data.length === 0) {
      parts.push(Buffer.alloc(0));
    } else {
      for (let i = 0; i < data.length; i += chunkSize) {
        parts.push(data.subarray(i, i + chunkSize));
      }
    }
    for (let i = 0; i < parts.length; i += 1) {
      const tf = encodeNoiseTransportFrame({
        chunk_id: cid,
        chunk_index: i,
        total_chunks: parts.length,
        payload: parts[i],
      });
      const encrypted = this.noise.encrypt(tf);
      this.ws.sendBytes(encrypted);
    }
  }

  async _readTransportFrameUnlocked(timeoutMs = 30000) {
    while (true) {
      const enc = await this.ws.recvBytes(timeoutMs);
      const raw = this.noise.decrypt(enc);
      const tf = decodeNoiseTransportFrame(raw);
      const total = tf.total_chunks || 1;
      if (total <= 1) {
        return tf.payload;
      }
      const cid = tf.chunk_id || 0;
      let bucket = this._transportChunks.get(cid);
      if (!bucket) {
        bucket = new Map();
        this._transportChunks.set(cid, bucket);
      }
      bucket.set(tf.chunk_index, tf.payload);
      if (bucket.size >= total) {
        this._transportChunks.delete(cid);
        const ordered = [];
        for (let i = 0; i < total; i += 1) {
          ordered.push(bucket.get(i) || Buffer.alloc(0));
        }
        return Buffer.concat(ordered);
      }
    }
  }

  _readTransportFrame(timeoutMs = 30000) {
    const run = () => this._readTransportFrameUnlocked(timeoutMs);
    const next = this._readLock.then(run, run);
    this._readLock = next.catch(() => {});
    return next;
  }

  async _readStreamFrame(sid, deadlineMs) {
    while (true) {
      const queued = this._streamFrames.get(sid);
      if (queued && queued.length > 0) {
        return queued.shift();
      }
      const rem = Math.max(500, deadlineMs - Date.now());
      if (Date.now() >= deadlineMs) {
        throw new Error(`Gateway stream ${sid} timeout`);
      }
      const next = this._readLock.then(
        async () => {
          const qNow = this._streamFrames.get(sid);
          if (qNow && qNow.length > 0) {
            return qNow.shift();
          }
          const raw = await this._readTransportFrameUnlocked(rem);
          const sf = decodeServiceResponseFrame(raw);
          if (sf.stream_id === sid) {
            return sf;
          }
          if (sf.stream_id > 0) {
            let q = this._streamFrames.get(sf.stream_id);
            if (!q) {
              q = [];
              this._streamFrames.set(sf.stream_id, q);
            }
            q.push(sf);
          }
          return null;
        },
        () => null
      );
      this._readLock = next.catch(() => {});
      const matched = await next;
      if (matched) return matched;
    }
  }

  _openStream(verb, reqPath, { service = 0, body = null, headers = {} } = {}) {
    this._streamId += 1;
    const sid = this._streamId;
    const hdrs = {
      accept: "application/json",
      "x-hatch-device-id": this.deviceId,
      ...headers,
    };
    let rawBody = Buffer.alloc(0);
    if (body !== null && body !== undefined) {
      if (Buffer.isBuffer(body)) {
        rawBody = body;
      } else if (typeof body === "string") {
        rawBody = Buffer.from(body, "utf8");
      } else {
        rawBody = Buffer.from(JSON.stringify(body), "utf8");
        if (!hdrs["content-type"]) {
          hdrs["content-type"] = "application/json";
        }
      }
    }

    const reqFrame = encodeServiceRequestFrame({
      service,
      stream_id: sid,
      request: {
        verb,
        path: reqPath,
        headers: Object.entries(hdrs),
        body: rawBody,
        end_body: true,
      },
    });
    this._sendTransportFrame(reqFrame);
    return sid;
  }

  _resolveRoute(methodName, { params = null, pathParams = null } = {}) {
    const routes = getRoutesMap();
    const spec = routes.get(methodName);
    if (!spec) {
      throw new Error(`Unknown gateway method: ${methodName}`);
    }
    let reqPath = spec.path;
    for (const [k, v] of Object.entries(pathParams || {})) {
      reqPath = reqPath.replace(`{${k}}`, encodeURIComponent(String(v)));
      reqPath = reqPath.replace(`{*${k}}`, String(v));
    }
    if (params && Object.keys(params).length > 0) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) {
          qs.append(k, String(v));
        }
      }
      const qsStr = qs.toString();
      if (qsStr) {
        reqPath += (reqPath.includes("?") ? "&" : "?") + qsStr;
      }
    }
    const svc = SERVICES[spec.service || "daemon"] ?? 0;
    return { spec, reqPath, svc };
  }

  async requestRaw(verb, reqPath, { service = 0, body = null, headers = {}, timeoutMs = 30000 } = {}) {
    const sid = this._openStream(verb, reqPath, { service, body, headers });
    let status = 0;
    let respHeaders = [];
    const chunks = [];
    const deadline = Date.now() + timeoutMs;

    try {
      while (true) {
        const sf = await this._readStreamFrame(sid, deadline);

        if (sf.kind === "response" && sf.response) {
          status = sf.response.status;
          respHeaders = sf.response.headers || [];
          if (sf.response.body && sf.response.body.length > 0) {
            chunks.push(sf.response.body);
          }
          if (sf.response.end_body) break;
        } else if (sf.kind === "body_chunk" && sf.body_chunk) {
          if (sf.body_chunk.data && sf.body_chunk.data.length > 0) {
            chunks.push(sf.body_chunk.data);
          }
          if (sf.body_chunk.end_body) break;
        } else if (sf.kind === "reset" && sf.reset) {
          throw new Error(`Stream reset (${sf.reset.code}): ${sf.reset.reason}`);
        }
      }
    } finally {
      this._streamFrames.delete(sid);
    }

    return {
      status,
      headers: respHeaders,
      body: Buffer.concat(chunks),
    };
  }

  async call(methodName, { body = null, params = null, pathParams = null, timeoutMs = 30000 } = {}) {
    const { spec, reqPath, svc } = this._resolveRoute(methodName, { params, pathParams });
    const res = await this.requestRaw(spec.http, reqPath, {
      service: svc,
      body,
      timeoutMs,
    });
    const text = res.body.toString("utf8");
    if (res.status >= 400) {
      throw new Error(`${methodName} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_e) {
      return text;
    }
  }

  async callStream(methodName, { body = null, params = null, pathParams = null, timeoutMs = 25000, onEvent = null } = {}) {
    const { spec, reqPath, svc } = this._resolveRoute(methodName, { params, pathParams });
    const sid = this._openStream(spec.http, reqPath, {
      service: svc,
      body: body ?? {},
      headers: { accept: "application/x-ndjson, application/json" },
    });

    const events = [];
    let buf = "";
    const deadline = Date.now() + timeoutMs;

    try {
      while (Date.now() < deadline) {
        let sf;
        try {
          sf = await this._readStreamFrame(sid, deadline);
        } catch (_err) {
          break;
        }

        let chunk = Buffer.alloc(0);
        let done = false;
        if (sf.kind === "response" && sf.response) {
          if (sf.response.status >= 400) {
            throw new Error(
              `${methodName} -> HTTP ${sf.response.status}: ${sf.response.body.toString("utf8")}`
            );
          }
          chunk = sf.response.body || Buffer.alloc(0);
          done = Boolean(sf.response.end_body);
        } else if (sf.kind === "body_chunk" && sf.body_chunk) {
          chunk = sf.body_chunk.data || Buffer.alloc(0);
          done = Boolean(sf.body_chunk.end_body);
        } else if (sf.kind === "reset") {
          break;
        }

        buf += chunk.toString("utf8");
        while (buf.includes("\n")) {
          const nl = buf.indexOf("\n");
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            try {
              const parsed = JSON.parse(line);
              events.push(parsed);
              if (typeof onEvent === "function") onEvent(parsed);
            } catch (_e) {
              events.push({ raw: line });
            }
          }
        }
        if (done) break;
      }
    } finally {
      this._streamFrames.delete(sid);
    }
    return events;
  }

  /**
   * Starts a fresh chat thread/session on the VM and returns its session_id
   */
  async startSession(title = "") {
    const cleanTitle = String(title || "New Session").slice(0, 80);
    const params = {
      origin: "fresh",
      lifecycle: "persistent",
      title: cleanTitle,
    };
    const extractId = (res) =>
      res?.result?.session_id ||
      res?.session_id ||
      res?.result?.id ||
      res?.id ||
      res?.result?.session?.session_id ||
      res?.session?.session_id ||
      res?.result?.session?.id ||
      res?.session?.id ||
      "";

    for (const bodyCandidate of [
      { method: "/api/session/start", params },
      params,
    ]) {
      try {
        const res = await this.call("session.start", {
          body: bodyCandidate,
          timeoutMs: 20000,
        });
        const sid = extractId(res);
        if (sid) return String(sid);
      } catch (_err) {
        // try next body shape
      }
    }
    return "";
  }

  /**
   * Cleans stale refusal notes from MEMORY.md and enforces real AI video generation (no still-image zoompan)
   */
  async cleanStaleVideoRefusalFromMemory() {
    try {
      const readRes = await this.call("fs.read", {
        body: { path: "MEMORY.md", offset: 0, len: 65536 },
        timeoutMs: 12000,
      });
      const b64 = readRes?.result?.data_base64 || readRes?.data_base64 || "";
      const original = b64 ? Buffer.from(b64, "base64").toString("utf8") : "";
      const policyLine =
        "- **Native AI Video Generation Rule (Mandatory):** Whenever asked to create a video, ALWAYS call `media.generate_video` to generate real AI video clips. NEVER substitute still images (`generate_image` + `ffmpeg zoompan`) for a video request. For videos > 10s, call `media.generate_video` for each 10s scene and concatenate those real AI video clips with `ffmpeg`.";

      const filteredLines = original
        .split("\n")
        .filter(
          (line) =>
            !/asked for a complete 20s product promo video|Awaiting her product photo|no product photo was attached|media\.generate_video bắt đầu trả lỗi 403|permanently region-blocked|The AI video tool was not retried|Video Generation Rule \(Mandatory\)/i.test(
              line
            )
        );
      if (!filteredLines.some((l) => l.includes("Native AI Video Generation Rule (Mandatory)"))) {
        filteredLines.push("", policyLine);
      }
      const updated = filteredLines.join("\n").trim() + "\n";
      if (updated !== original) {
        await this.call("fs.write", {
          body: {
            path: "MEMORY.md",
            data_base64: Buffer.from(updated, "utf8").toString("base64"),
            overwrite: true,
            append: false,
            create_parent: true,
          },
          timeoutMs: 12000,
        });
        return true;
      }
      return false;
    } catch (_err) {
      return false;
    }
  }

  /**
   * Uploads a reference image directly into the Muse VM workspace via fs.write
   */
  async uploadReferenceFile(fileName, base64Data, mimeType = "image/png") {
    const safeName =
      String(fileName || `ref_${Date.now()}.png`).replace(/[^a-zA-Z0-9._-]/g, "_") ||
      `ref_${Date.now()}.png`;
    const relPath = `workspace/imagine_media/ref_${Date.now()}_${safeName}`;

    try {
      await this.call("fs.mkdir", {
        body: { path: "workspace/imagine_media" },
        timeoutMs: 10000,
      }).catch(() => null);

      await this.call("fs.write", {
        body: {
          path: relPath,
          data_base64: base64Data,
          overwrite: true,
          append: false,
          create_parent: true,
        },
        timeoutMs: 25000,
      });
      return {
        ok: true,
        path: `/${relPath}`,
        vmPath: relPath,
        name: safeName,
        mime: mimeType,
      };
    } catch (_err) {
      try {
        const rootRel = `workspace/ref_${Date.now()}_${safeName}`;
        await this.call("fs.write", {
          body: {
            path: rootRel,
            data_base64: base64Data,
            overwrite: true,
            append: false,
            create_parent: true,
          },
          timeoutMs: 25000,
        });
        return {
          ok: true,
          path: `/${rootRel}`,
          vmPath: rootRel,
          name: safeName,
          mime: mimeType,
        };
      } catch (e2) {
        return {
          ok: false,
          path: safeName,
          name: safeName,
          mime: mimeType,
          error: e2.message,
        };
      }
    }
  }

  /**
   * Cancels an active chat stream/turn on the Muse VM
   */
  async cancelChat({ sessionId = "" } = {}) {
    try {
      const body = {};
      if (sessionId) body.session_id = sessionId;
      await this.call("chat.cancel", { body, timeoutMs: 5000 }).catch(() => null);
      return true;
    } catch (_err) {
      return false;
    }
  }

  /**
   * Sends a message to the Muse VM via chat.stream
   */
  async sendChatMessage(text, { sessionId = "", attachments = [] } = {}) {
    const clientMessageId = crypto.randomUUID();
    const submissionId = crypto.randomUUID();
    const body = {
      message: String(text || ""),
      client_message_id: clientMessageId,
      submission_id: submissionId,
      attachments: Array.isArray(attachments) ? attachments : [],
      mentions: [],
    };
    if (sessionId) {
      body.session_id = sessionId;
    }
    const events = await this.callStream("chat.stream", {
      body,
      timeoutMs: 25000,
    });
    return {
      clientMessageId,
      submissionId,
      events,
    };
  }

  /**
   * Fetches chat history events from the Muse VM
   */
  async getHistory({ sessionId = "", limit = 30 } = {}) {
    const params = { limit };
    if (sessionId) params.session_id = sessionId;
    const res = await this.call("chat.history", {
      params,
      timeoutMs: 20000,
    });
    const list =
      res?.result?.chat_events ||
      res?.chat_events ||
      res?.result?.events ||
      res?.events ||
      [];
    if (!Array.isArray(list)) return [];
    if (!sessionId) return list;
    return list.filter((ev) => {
      const evSid =
        ev?.session_id ||
        ev?.thread_id ||
        ev?.payload?.session_id ||
        ev?.payload?.thread_id ||
        "";
      return !evSid || String(evSid) === String(sessionId);
    });
  }

  /**
   * Lists workspace files or searches for generated media files on the VM
   */
  async listGeneratedFiles(extraDirs = []) {
    const results = [];
    const seenPaths = new Set();
    const dirs = [
      ...extraDirs.filter(Boolean),
      "workspace/imagine_media",
      "workspace",
      "workspace/industrial_video_20s",
      "workspace/industrial_product_video_20s",
    ];
    for (const dirPath of dirs) {
      try {
        const listRes = await this.call("fs.list", {
          body: { path: dirPath },
          timeoutMs: 10000,
        }).catch(() => null);
        const entries = Array.isArray(listRes?.result?.entries)
          ? listRes.result.entries
          : Array.isArray(listRes?.entries)
          ? listRes.entries
          : Array.isArray(listRes?.files)
          ? listRes.files
          : Array.isArray(listRes)
          ? listRes
          : [];
        for (const entry of entries) {
          if (entry?.type === "directory") continue;
          const name = typeof entry === "string" ? entry : entry?.name || entry?.path || "";
          if (!name || /^(?:ref_|reference_)/i.test(path.posix.basename(name))) continue;
          const full = name.startsWith(dirPath + "/") ? name : `${dirPath}/${name}`;
          if (seenPaths.has(full)) continue;
          if (/\.(mp4|webm|mov|png|jpe?g|webp)$/i.test(full)) {
            seenPaths.add(full);
            const rawMtime =
              entry?.modifiedAt ??
              entry?.mtime ??
              entry?.mtime_ms ??
              entry?.modified_at ??
              0;
            const mtimeMs =
              typeof rawMtime === "number"
                ? rawMtime > 1e12
                  ? rawMtime
                  : rawMtime * 1000
                : rawMtime
                ? Date.parse(String(rawMtime)) || 0
                : 0;
            results.push({
              source: "fs",
              name: path.posix.basename(full),
              path: full,
              size: Number(entry?.size || 0),
              mtimeMs,
            });
          }
        }
      } catch (_e) {}
    }

    return results;
  }

  /**
   * Downloads a media file from the VM (via /media/raw/..., fs.read, or HTTPS URL).
   * For MP4 files, verifies that ffmpeg has finished writing the moov/mvhd atoms before returning.
   */
  async downloadMediaBuffer(mediaCandidate) {
    const rawUrl = typeof mediaCandidate === "string" ? mediaCandidate : mediaCandidate?.url || "";
    let rawPath =
      typeof mediaCandidate === "string" ? mediaCandidate : mediaCandidate?.path || "";
    rawPath = String(rawPath || "")
      .replace(/^sandbox:\/\//i, "")
      .replace(/^file:/i, "")
      .replace(/^\/+/, "");

    // If rawUrl is a per-VM metaaivm.com/media/raw/... URL, extract the /media/raw/... path for direct Noise Gateway download
    if (!rawPath && /^https?:\/\/[^/]+\.metaaivm\.com\/media\/raw\/(.+)$/i.test(rawUrl)) {
      const m = rawUrl.match(/^https?:\/\/[^/]+\.metaaivm\.com\/media\/raw\/(.+)$/i);
      if (m && m[1]) rawPath = decodeURIComponent(m[1]);
    }

    const isMp4Target = /\.mp4(\?|$)/i.test(rawPath || rawUrl);
    const isCompleteMp4 = (buf) =>
      Buffer.isBuffer(buf) &&
      buf.length > 1024 &&
      buf.includes(Buffer.from("moov")) &&
      buf.includes(Buffer.from("mvhd"));

    // 1. Direct binary download over Noise Gateway via GET /media/raw/<path>
    if (rawPath && !/^https?:\/\//i.test(rawPath)) {
      const maxWaitPasses = isMp4Target ? 24 : 1;
      let lastPartial = null;

      for (let pass = 0; pass < maxWaitPasses; pass += 1) {
        try {
          const mediaRoutePath = `/media/raw/${rawPath.replace(/^\/+/, "")}`;
          const rawMedia = await this.requestRaw("GET", mediaRoutePath, {
            headers: { accept: "*/*" },
            timeoutMs: 120000,
          });
          if (rawMedia.status >= 200 && rawMedia.status < 300 && rawMedia.body?.length > 0) {
            const ct =
              rawMedia.headers.find((h) => h.key.toLowerCase() === "content-type")?.value || "";
            if (!isMp4Target || isCompleteMp4(rawMedia.body)) {
              return {
                buffer: rawMedia.body,
                mime: ct,
              };
            }
            lastPartial = { buffer: rawMedia.body, mime: ct };
          }
        } catch (_e) {}

        // 2. Fallback via fs.read ({ path, offset: 0, len })
        try {
          const readRes = await this.call("fs.read", {
            body: {
              path: rawPath,
              offset: 0,
              len: 50 * 1024 * 1024,
            },
            timeoutMs: 120000,
          });
          const b64 = readRes?.result?.data_base64 || readRes?.data_base64 || "";
          if (b64) {
            const buf = Buffer.from(b64, "base64");
            if (!isMp4Target || isCompleteMp4(buf)) {
              return {
                buffer: buf,
                mime: mediaCandidate?.mime || "",
              };
            }
            lastPartial = { buffer: buf, mime: mediaCandidate?.mime || "" };
          }
        } catch (_e) {}

        if (pass < maxWaitPasses - 1) {
          await new Promise((r) => setTimeout(r, 2500));
        }
      }

      if (lastPartial) return lastPartial;
    }

    // 3. Direct HTTPS URL fallback
    if (/^https?:\/\//i.test(rawUrl)) {
      const res = await fetch(rawUrl, {
        headers: buildBrowserHeaders(this.cookieMap, {
          ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
        }),
        signal: AbortSignal.timeout(180000),
      });
      if (res.ok) {
        const ab = await res.arrayBuffer();
        const buf = Buffer.from(ab);
        if (buf.length > 0) {
          return {
            buffer: buf,
            mime: res.headers.get("content-type") || "",
          };
        }
      }
    }

    throw new Error(`Không tải được dữ liệu media từ VM (${rawPath || rawUrl || "unknown"})`);
  }
}

/**
 * Extracts assistant text and media references (delta.presentation videos/images, paths, URLs)
 * from a chat.history event object.
 */
function inspectHistoryEvent(ev) {
  const payload = ev?.payload && typeof ev.payload === "object" ? ev.payload : {};
  const text = String(
    ev?.display_text ||
      ev?.text ||
      payload.display_text ||
      payload.content ||
      payload.text ||
      ""
  ).trim();
  const replyTo = String(ev?.reply_to_message_id ?? payload.reply_to_message_id ?? "");
  const clientMessageId = String(
    ev?.client_message_id ??
      payload.client_message_id ??
      ev?.submission_id ??
      payload.submission_id ??
      ""
  );
  const sessionId = String(
    ev?.session_id ??
      ev?.thread_id ??
      payload.session_id ??
      payload.thread_id ??
      ""
  );
  const messageKind = String(payload?.metadata?.message_kind || "");
  const status = String(payload?.status || ev?.status || "");
  const mediaRefs = [];
  const seen = new Set();

  const addRef = (refObj) => {
    const cleanPath = String(refObj.path || "")
      .replace(/^sandbox:\/\//i, "")
      .replace(/^file:/i, "")
      .replace(/^\/+/, "");
    const url = String(refObj.url || "");
    const key = `${cleanPath}|${url}`;
    if (key === "|" || seen.has(key)) return;
    seen.add(key);
    mediaRefs.push({
      ...refObj,
      path: cleanPath,
      url,
    });
  };

  // 1. Check delta.presentation payload.data.videos & payload.data.images
  const presData = payload?.data && typeof payload.data === "object" ? payload.data : {};
  for (const vid of Array.isArray(presData.videos) ? presData.videos : []) {
    if (vid && (vid.path || vid.variants?.original)) {
      addRef({
        path: vid.path || "",
        url: vid.variants?.original || "",
        mime: vid.mime || "video/mp4",
        size: Number(vid.byte_len || 0),
        label: vid.label || "",
      });
    }
  }
  for (const img of Array.isArray(presData.images) ? presData.images : []) {
    if (img && (img.path || img.variants?.original)) {
      addRef({
        path: img.path || "",
        url: img.variants?.original || "",
        mime: img.mime || "image/webp",
        size: Number(img.byte_len || 0),
        label: img.label || "",
      });
    }
  }

  // 2. Scan structured arrays inside event & payload
  const candidateArrays = [
    ev?.attachments,
    ev?.media,
    ev?.artifacts,
    ev?.files,
    payload.attachments,
    payload.media,
    payload.artifacts,
    payload.files,
    payload.deliverables,
  ];
  for (const arr of candidateArrays) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!item) continue;
      if (typeof item === "string") {
        if (/^https?:\/\//i.test(item)) addRef({ url: item });
        else addRef({ path: item });
      } else if (typeof item === "object") {
        const url =
          item.url ||
          item.download_url ||
          item.src ||
          item.media_url ||
          item.variants?.original ||
          "";
        const p = item.path || item.file_path || item.filename || item.name || "";
        const mime = item.mime_type || item.content_type || item.mime || "";
        if (url || p) {
          addRef({ url, path: p, mime });
        }
      }
    }
  }

  // 3. Scan sandbox://workspace/... or /workspace/... paths in fallback_text / text
  const rawStr = JSON.stringify(ev || {});
  const sandboxRegex =
    /sandbox:\/\/(workspace\/[^\s"'<>\\)]+\.(?:mp4|webm|mov|png|jpe?g|webp))/gi;
  let m;
  while ((m = sandboxRegex.exec(rawStr)) !== null) {
    addRef({ path: m[1] });
  }

  return {
    messageId: ev?.message_id || "",
    clientMessageId,
    sessionId,
    eventName: ev?.event_name || "",
    occurredAtMs: Number(ev?.occurred_at_ms || 0),
    messageKind,
    status,
    text,
    replyTo,
    mediaRefs,
  };
}

module.exports = {
  MuseGateway,
  NoiseXXSession,
  BinaryWebSocketClient,
  encodeNoiseTransportFrame,
  decodeNoiseTransportFrame,
  encodeServiceRequestFrame,
  decodeServiceResponseFrame,
  inspectHistoryEvent,
  getRoutesMap,
};
