"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Store } = require("./store");
const { MuseEngine, resolveModel, findChromeBinary } = require("./engine");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const SUPPORTED_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"];

// OpenAI clients send `size` as pixels ("1024x1792"); Muse needs a ratio, so snap to the nearest supported one.
function sizeToAspectRatio(value, fallback) {
  const v = String(value || "").trim();
  if (/^\d+:\d+$/.test(v)) return v;
  const m = v.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (!m || !Number(m[1]) || !Number(m[2])) return fallback;
  const target = Math.log(Number(m[1]) / Number(m[2]));
  const distance = (ratio) => {
    const [w, h] = ratio.split(":").map(Number);
    return Math.abs(Math.log(w / h) - target);
  };
  return SUPPORTED_ASPECT_RATIOS.reduce((best, r) => (distance(r) < distance(best) ? r : best));
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/**
 * Pure Node.js ZIP builder (Store method) for packaging Chrome Extension on the fly
 */
function buildZipBuffer(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j += 1) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf-8");
    const dataBuf = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf-8");
    const crc = crc32(dataBuf);

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuf.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);

    localParts.push(localHeader, dataBuf);
    centralParts.push(centralHeader);
    offset += localHeader.length + dataBuf.length;
  }

  const centralSize = centralParts.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function parseMultipart(buffer, boundary) {
  const fields = {};
  const files = [];
  const sep = `--${boundary}`;
  const raw = buffer.toString("latin1");
  const parts = raw.split(sep).slice(1, -1);

  for (const part of parts) {
    const trimmed = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const headerEnd = trimmed.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headerText = trimmed.slice(0, headerEnd);
    const bodyLatin1 = trimmed.slice(headerEnd + 4);
    const bodyBuf = Buffer.from(bodyLatin1, "latin1");

    const nameMatch = headerText.match(/name="([^"]+)"/i);
    const filenameMatch = headerText.match(/filename="([^"]+)"/i);
    const ctMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);
    const fieldName = nameMatch ? nameMatch[1] : "file";

    if (filenameMatch) {
      files.push({
        fieldName,
        filename: Buffer.from(filenameMatch[1], "latin1").toString("utf-8"),
        mime: ctMatch ? ctMatch[1].trim() : "application/octet-stream",
        buffer: bodyBuf,
        b64: bodyBuf.toString("base64"),
      });
    } else {
      fields[fieldName] = bodyBuf.toString("utf-8");
    }
  }
  return { fields, files };
}

class MuseServer {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.resolve(__dirname, "..");
    this.dataDir = options.dataDir || path.join(this.rootDir, "data");
    this.desktopDir = path.join(this.rootDir, "desktop");
    this.store = options.store || new Store(this.dataDir);
    this.engine = options.engine || new MuseEngine(this.store, options);
    this.host = options.host || "127.0.0.1";
    this.port =
      options.port !== undefined
        ? Number(options.port)
        : Number(this.store.settings.port || 18638);
    this.server = null;
    this.asyncJobs = new Map();
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  async start() {
    if (this.server) return this.baseUrl;
    this.engine.startKeepaliveLoop();

    let retries = 0;
    await new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this._handleRequest(req, res).catch((err) => {
          const status = err.statusCode || 500;
          if (status >= 500) console.error("[MuseServer] Request error:", err);
          if (!res.headersSent) {
            this._sendJson(res, status, {
              error: {
                message: err.message || "Internal server error",
                type: status >= 500 ? "server_error" : "invalid_request_error",
              },
            });
          }
        });
      });

      srv.on("error", (err) => {
        if ((err.code === "EADDRINUSE" || err.code === "EACCES") && retries < 20) {
          retries += 1;
          this.port = retries > 10 ? 0 : this.port + 17;
          srv.listen(this.port, this.host);
        } else {
          reject(err);
        }
      });

      srv.listen(this.port, this.host, () => {
        const addr = srv.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        this.server = srv;
        resolve();
      });
    });

    return this.baseUrl;
  }

  async stop() {
    if (this.engine.keepaliveTimer) {
      clearInterval(this.engine.keepaliveTimer);
      this.engine.keepaliveTimer = null;
    }
    if (!this.server) return;
    await new Promise((resolve) => {
      this.server.close(() => resolve());
    });
    this.server = null;
  }

  _sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    });
    res.end(body);
  }

  async _readBodyBuffer(req, maxBytes = 250 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          reject(Object.assign(new Error("Payload too large"), { statusCode: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  async _readJson(req) {
    const buf = await this._readBodyBuffer(req);
    if (!buf.length) return {};
    try {
      return JSON.parse(buf.toString("utf-8"));
    } catch (_err) {
      throw Object.assign(new Error("Body không phải JSON hợp lệ"), { statusCode: 400 });
    }
  }

  // A valid Bearer key always passes. Without one, only loopback requests with no foreign Origin pass:
  // the bundled UI is same-origin and curl/python send no Origin, but any website the user visits does,
  // and the Host check stops DNS-rebinding pages that pretend to be same-origin.
  _isTrustedRequest(req) {
    const configured = this.store.settings.apiKey;
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (token) return !configured || token === configured;
    if (!LOOPBACK_HOSTS.has(String(req.headers.host || "").replace(/:\d+$/, ""))) return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const o = new URL(origin);
      return LOOPBACK_HOSTS.has(o.hostname) && Number(o.port) === this.port;
    } catch (_err) {
      return false;
    }
  }

  // An empty prompt would still burn a Muse turn, so /v1 rejects it up front like /admin/generate does.
  _rejectEmptyPrompt(res, prompt) {
    if (String(prompt || "").trim()) return false;
    this._sendJson(res, 400, { error: { message: "prompt is required", type: "invalid_request_error" } });
    return true;
  }

  async _handleRequest(req, res) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      });
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = parsedUrl.pathname;

    // Static UI routes
    if (req.method === "GET" && (pathname === "/" || pathname === "/admin" || pathname === "/index.html")) {
      const htmlPath = path.join(this.desktopDir, "index.html");
      if (fs.existsSync(htmlPath)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(htmlPath));
        return;
      }
    }

    if (req.method === "GET" && (pathname === "/styles.css" || pathname === "/renderer.js")) {
      const filePath = path.join(this.desktopDir, pathname.slice(1));
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "text/plain" });
        res.end(fs.readFileSync(filePath));
        return;
      }
    }

    if (req.method === "GET" && pathname.startsWith("/assets/")) {
      const safeName = path.basename(pathname);
      const assetPath = path.join(this.desktopDir, "assets", safeName);
      if (fs.existsSync(assetPath)) {
        const ext = path.extname(assetPath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
        res.end(fs.readFileSync(assetPath));
        return;
      }
    }

    // Media file serving (with full HTTP 206 Range support for MP4 moov seeking & streaming)
    if ((req.method === "GET" || req.method === "HEAD") && pathname.startsWith("/v1/media/")) {
      const filename = path.basename(decodeURIComponent(pathname.slice("/v1/media/".length)));
      const fullPath = path.join(this.store.mediaDir, filename);
      if (!fs.existsSync(fullPath)) {
        return this._sendJson(res, 404, { error: "Media file not found" });
      }
      const ext = path.extname(fullPath).toLowerCase();
      const stat = fs.statSync(fullPath);
      const total = stat.size;
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      const rangeHeader = req.headers.range;

      if (rangeHeader && total > 0) {
        const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader).trim());
        if (match) {
          let start = match[1] ? parseInt(match[1], 10) : 0;
          let end = match[2] ? parseInt(match[2], 10) : total - 1;
          if (!match[1] && match[2]) {
            start = Math.max(0, total - parseInt(match[2], 10));
            end = total - 1;
          }
          if (start >= total || end >= total || start > end) {
            res.writeHead(416, {
              "Content-Range": `bytes */${total}`,
              "Access-Control-Allow-Origin": "*",
            });
            res.end();
            return;
          }
          const chunkSize = end - start + 1;
          res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Accept-Ranges": "bytes",
            "Content-Length": chunkSize,
            "Content-Type": contentType,
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache",
          });
          if (req.method === "HEAD") {
            res.end();
          } else {
            fs.createReadStream(fullPath, { start, end }).pipe(res);
          }
          return;
        }
      }

      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": total,
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      });
      if (req.method === "HEAD") {
        res.end();
      } else {
        fs.createReadStream(fullPath).pipe(res);
      }
      return;
    }

    if ((pathname.startsWith("/admin/") || pathname.startsWith("/v1/")) && !this._isTrustedRequest(req)) {
      return this._sendJson(res, 401, {
        error: { message: "Invalid API Key", type: "authentication_error" },
      });
    }

    // ==================== ADMIN API ====================
    if (pathname === "/admin/status" && req.method === "GET") {
      const runningTasks = this.store
        .listTasks(30)
        .filter((t) => t.status === "running")
        .map((t) => ({
          id: t.id,
          row_id: t.row_id || "",
          type: t.type,
          prompt: t.prompt,
          account_id: t.account_id,
          progress: t.progress || 10,
          progress_text: t.progress_text || "Đang xử lý qua cổng HTTP + Noise-XX Gateway...",
        }));
      return this._sendJson(res, 200, {
        ok: true,
        base_url: this.baseUrl,
        api_key: this.store.settings.apiKey,
        engine_mode: "http_noise_gateway",
        chrome_alive: true,
        chrome_installed: true,
        cdp_port: 0,
        active_tasks: this.engine.activeCount,
        running_tasks: runningTasks,
        max_concurrency: this.store.settings.maxConcurrency || 3,
        keepalive_running: this.engine.keepaliveRunning,
        keepalive_interval_minutes: this.store.settings.keepaliveIntervalMinutes || 360,
        settings: this.store.settings,
        stats: this.store.stats(),
      });
    }

    if (pathname === "/admin/chrome/show" && req.method === "POST") {
      try {
        this.store.saveSettings({ showChromeWindow: true });
        await this.engine.ensureChrome(true);
        await this.engine.bringChromeToFront({ saveSetting: true });
        if (typeof this.engine.syncActiveBrowserSession === "function") {
          this.engine.syncActiveBrowserSession({ force: true }).catch(() => {});
        }
        return this._sendJson(res, 200, {
          ok: true,
          visible: true,
          cdp_port: this.engine.cdpPort,
        });
      } catch (err) {
        return this._sendJson(res, 500, { ok: false, error: err.message });
      }
    }

    if (pathname === "/admin/chrome/hide" && req.method === "POST") {
      try {
        this.store.saveSettings({ showChromeWindow: false });
        if (typeof this.engine.hideChromeWindows === "function") {
          await this.engine.hideChromeWindows({ saveSetting: true });
        }
        return this._sendJson(res, 200, {
          ok: true,
          visible: false,
          cdp_port: this.engine.cdpPort,
        });
      } catch (err) {
        return this._sendJson(res, 500, { ok: false, error: err.message });
      }
    }

    if (pathname === "/admin/chrome/close" && req.method === "POST") {
      try {
        let out = { ok: true, closed: false };
        if (typeof this.engine.closeAllChromeBrowsers === "function") {
          out = await this.engine.closeAllChromeBrowsers();
        }
        return this._sendJson(res, 200, out);
      } catch (err) {
        return this._sendJson(res, 500, { ok: false, error: err.message });
      }
    }


    if (pathname === "/admin/accounts" && req.method === "GET") {
      return this._sendJson(res, 200, {
        accounts: this.store.listAccounts(),
      });
    }

    if (pathname === "/admin/accounts" && req.method === "POST") {
      const body = await this._readJson(req);
      try {
        const { account, isNew } = this.store.addAccount(
          body.name || body.label || "",
          body.cookies || body.cookie || "",
          body.email || "",
          { expires: body.expires || null }
        );
        let checkResult = null;
        if (body.autoCheck && typeof this.engine.renewAccount === "function") {
          checkResult = await this.engine.renewAccount(account);
        }
        const latest =
          this.store.listAccounts().find((a) => a.id === account.id) || {
            id: account.id,
            name: account.name,
            cookie_count: account.cookies.length,
            cookie_expires: account.cookie_expires || 0,
            status: account.status,
          };
        return this._sendJson(res, 200, {
          ok: true,
          is_new: isNew,
          check: checkResult,
          account: latest,
          added: [
            {
              id: latest.id,
              label: latest.name,
              cookie_count: latest.cookie_count,
              expires_at: latest.cookie_expires || 0,
            },
          ],
        });
      } catch (err) {
        return this._sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    if (pathname === "/admin/accounts/browser-login" && req.method === "POST") {
      const body = await this._readJson(req);
      try {
        const result = await this.engine.loginWithBrowser({
          accountName: body.name || "",
          accountId: body.accountId || "",
          forceNewProfile: Boolean(body.forceNewProfile),
          slotOffset: Number(body.slotOffset || 0),
          timeoutSec: Number(body.timeoutSec || 240),
        });
        return this._sendJson(res, 200, result);
      } catch (err) {
        return this._sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    if (
      (pathname === "/admin/accounts/renew-all" || pathname === "/admin/accounts/keepalive") &&
      req.method === "POST"
    ) {
      const result = await this.engine.renewAllAccounts();
      return this._sendJson(res, 200, result);
    }

    const accActionMatch = pathname.match(
      /^\/admin\/accounts\/([^/]+)\/(toggle|test|renew|quota|open-chrome)$/
    );
    if (accActionMatch) {
      const accId = accActionMatch[1];
      const action = accActionMatch[2];
      const acc = this.store.getAccount(accId);
      if (!acc) {
        return this._sendJson(res, 404, { ok: false, error: "Không tìm thấy ních" });
      }

      if (action === "toggle" && req.method === "POST") {
        const updated = this.store.toggleAccount(accId);
        return this._sendJson(res, 200, { ok: true, status: updated.status });
      }
      if ((action === "test" || action === "renew") && req.method === "POST") {
        const r = await this.engine.renewAccount(acc);
        return this._sendJson(res, 200, r);
      }
      if (action === "quota" && (req.method === "GET" || req.method === "POST")) {
        const r = await this.engine.checkAccountQuota(acc);
        return this._sendJson(res, 200, r);
      }
      if (action === "open-chrome" && req.method === "POST") {
        try {
          const r = await this.engine.loginWithBrowser({
            accountId: acc.id,
            accountName: acc.name || "",
            timeoutSec: 240,
          });
          return this._sendJson(res, 200, r);
        } catch (err) {
          return this._sendJson(res, 400, { ok: false, error: err.message });
        }
      }
    }

    const accDeleteMatch = pathname.match(/^\/admin\/accounts\/([^/]+)$/);
    if (accDeleteMatch && req.method === "DELETE") {
      const ok = this.store.deleteAccount(accDeleteMatch[1]);
      return this._sendJson(res, 200, { ok });
    }

    if (pathname === "/admin/tasks" && req.method === "GET") {
      const limit = Number(parsedUrl.searchParams.get("limit") || 100);
      return this._sendJson(res, 200, { tasks: this.store.listTasks(limit) });
    }

    if (pathname === "/admin/tasks" && req.method === "DELETE") {
      this.store.clearTasks();
      return this._sendJson(res, 200, { ok: true });
    }

    if (pathname === "/admin/media" && req.method === "GET") {
      const files = [];
      try {
        const names = fs.readdirSync(this.store.mediaDir);
        for (const name of names) {
          const ext = path.extname(name).toLowerCase();
          if (![".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm"].includes(ext)) continue;
          const st = fs.statSync(path.join(this.store.mediaDir, name));
          files.push({
            name,
            url: `/v1/media/${encodeURIComponent(name)}`,
            type: [".mp4", ".webm"].includes(ext) ? "video" : "image",
            size: st.size,
            created_at: Math.floor(st.mtimeMs / 1000),
          });
        }
        files.sort((a, b) => b.created_at - a.created_at);
      } catch (_err) {
        // ignore
      }
      return this._sendJson(res, 200, { media: files });
    }

    const mediaDeleteMatch = pathname.match(/^\/admin\/media\/([^/]+)$/);
    if (mediaDeleteMatch && req.method === "DELETE") {
      const name = path.basename(decodeURIComponent(mediaDeleteMatch[1]));
      const p = path.join(this.store.mediaDir, name);
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        return this._sendJson(res, 200, { ok: true });
      }
      return this._sendJson(res, 404, { ok: false, error: "File not found" });
    }

    if (pathname === "/admin/batch-rows" && req.method === "GET") {
      return this._sendJson(res, 200, { rows: this.store.getBatchRows() });
    }

    if (pathname === "/admin/batch-rows" && req.method === "POST") {
      const body = await this._readJson(req);
      const saved = this.store.saveBatchRows(body.rows || []);
      return this._sendJson(res, 200, { ok: true, count: saved.length });
    }

    if (pathname === "/admin/settings" && req.method === "GET") {
      return this._sendJson(res, 200, { settings: this.store.settings });
    }

    if (pathname === "/admin/settings" && req.method === "POST") {
      const body = await this._readJson(req);
      const updated = this.store.saveSettings(body);
      this.engine.startKeepaliveLoop();
      return this._sendJson(res, 200, { ok: true, settings: updated });
    }

    if (pathname === "/admin/apikey/rotate" && req.method === "POST") {
      const newKey = this.store.rotateApiKey();
      return this._sendJson(res, 200, { ok: true, api_key: newKey });
    }

    if (pathname === "/admin/logs" && req.method === "GET") {
      return this._sendJson(res, 200, { logs: this.engine.getLogs(120) });
    }

    if (pathname === "/admin/ai/test-gemini" && req.method === "POST") {
      const body = await this._readJson(req);
      const apiKey = String(body.apiKey || this.store.settings.geminiApiKey || "").trim();
      const model = String(body.model || this.store.settings.geminiModel || "gemini-2.5-flash").trim();
      if (!apiKey) {
        return this._sendJson(res, 400, { ok: false, error: "Vui lòng nhập Gemini API Key" });
      }
      try {
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: "Trả lời ngắn gọn: OK" }] }],
            }),
            signal: AbortSignal.timeout(15000),
          }
        );
        const data = await geminiRes.json().catch(() => ({}));
        if (!geminiRes.ok) {
          throw new Error(data.error?.message || `Gemini HTTP ${geminiRes.status}`);
        }
        this.store.saveSettings({ geminiApiKey: apiKey, geminiModel: model });
        return this._sendJson(res, 200, {
          ok: true,
          model,
          reply: data.candidates?.[0]?.content?.parts?.[0]?.text || "OK",
        });
      } catch (err) {
        return this._sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    if (pathname === "/admin/ai/generate-script" && req.method === "POST") {
      const body = await this._readJson(req);
      const provider = String(body.provider || "gemini").toLowerCase();
      const topic = String(body.topic || "").trim();
      const count = Math.max(1, Math.min(30, Number(body.count || 5)));
      const duration = String(body.duration || "20s");
      const durSec = Math.max(5, parseInt(duration.replace(/[^\d]/g, ""), 10) || 20);
      const quality = String(body.quality || "4K");
      const aspectRatio = String(body.aspectRatio || "9:16");
      const targetMode = String(body.mode || body.targetMode || "both");
      const characterImage = body.characterImage || null;
      const productImages = Array.isArray(body.productImages)
        ? body.productImages.filter((p) => p && p.b64)
        : body.productImage && body.productImage.b64
        ? [body.productImage]
        : [];

      if (!topic) {
        return this._sendJson(res, 400, { ok: false, error: "Vui lòng nhập chủ đề kịch bản" });
      }

      const longVideoNote =
        (targetMode === "video" || targetMode === "both") && durSec > 10
          ? `\n- Vì mỗi video có độ dài ${durSec} giây (>10s), trong mỗi dòng Prompt Video hãy mô tả chuỗi chuyển động nối tiếp qua ${Math.ceil(durSec / 10)} phân cảnh nhỏ liên mạch và kèm yêu cầu ghép nối các đoạn thành 1 video hoàn chỉnh dài ${durSec} giây.`
          : "";

      const charNote =
        characterImage && characterImage.b64
          ? "\nLưu ý về Nhân vật mẫu: Người dùng có đính kèm Ảnh tham chiếu Nhân vật. Hãy quan sát kỹ khuôn mặt, kiểu tóc, trang phục, vóc dáng và thần thái của nhân vật trong ảnh để mô tả đồng nhất xuyên suốt tất cả các phân cảnh."
          : "";
      const prodNote =
        productImages.length > 0
          ? `\nLưu ý về Sản phẩm mẫu (${productImages.length} sản phẩm): Người dùng có đính kèm ${productImages.length} Ảnh tham chiếu Sản phẩm. Hãy quan sát kỹ đặc điểm sản phẩm trong ảnh (màu sắc, kiểu dáng, bao bì, chất liệu) và mô tả đồng nhất sản phẩm trong từng phân cảnh.`
          : "";

      const modeInstruction =
        targetMode === "both"
          ? `Hãy viết bộ kịch bản gồm 2 phần theo đúng thứ tự Luồng (Tạo Ảnh trước ➔ Tạo Video sau):
- Phần 1: Viết chính xác ${count} dòng bắt đầu bằng tiền tố "[IMAGE] " để tạo Ảnh AI sắc nét (${quality}) làm khung hình chuẩn.
- Phần 2: Viết chính xác ${count} dòng bắt đầu bằng tiền tố "[VIDEO] " để tạo Video AI chuyển động mượt mà (tỉ lệ ${aspectRatio}, thời lượng ${duration}, chất lượng ${quality}) tương ứng với ${count} ảnh ở Phần 1.`
          : `Hãy viết chính xác ${count} câu lệnh Prompt chi tiết để tạo ${
              targetMode === "video"
                ? `Video AI (tỉ lệ ${aspectRatio}, thời lượng ${duration}, chất lượng ${quality})`
                : `Ảnh AI (tỉ lệ ${aspectRatio}, chất lượng ${quality})`
            } về chủ đề: "${topic}".`;

      const systemPrompt = `Bạn là đạo diễn hình ảnh & biên kịch AI chuyên nghiệp của EM BÔNG AI Studio.
Chủ đề kịch bản: "${topic}".${charNote}${prodNote}
${modeInstruction}
Yêu cầu bắt buộc:
- Mỗi dòng là 1 Prompt hoàn chỉnh (mô tả bối cảnh, nhân vật/sản phẩm, góc máy, ánh sáng điện ảnh ${quality}).${longVideoNote}
- KHÔNG đánh số thứ tự đầu dòng, KHÔNG dùng dấu gạch đầu dòng, KHÔNG viết lời mở đầu hay kết thúc.`;

      const parseGeneratedLines = (rawText) => {
        const cleaned = String(rawText || "")
          .split("\n")
          .map((l) => l.replace(/^(\d+[\.\)\-]|[-*•])\s*/, "").trim())
          .filter((l) => l.length > 8);

        if (targetMode === "both") {
          const imagePrompts = [];
          const videoPrompts = [];
          const otherLines = [];
          for (const line of cleaned) {
            if (/^\[(IMAGE|ANH|ẢNH)\]/i.test(line)) {
              imagePrompts.push(line.replace(/^\[(IMAGE|ANH|ẢNH)\]\s*:?\s*/i, "").trim());
            } else if (/^\[(VIDEO|VID)\]/i.test(line)) {
              videoPrompts.push(line.replace(/^\[(VIDEO|VID)\]\s*:?\s*/i, "").trim());
            } else {
              otherLines.push(line);
            }
          }
          if (!imagePrompts.length && !videoPrompts.length && otherLines.length) {
            const half = Math.ceil(otherLines.length / 2);
            imagePrompts.push(...otherLines.slice(0, half));
            videoPrompts.push(...otherLines.slice(half));
          }
          const combined = [
            ...imagePrompts.slice(0, count).map((p) => `[IMAGE] ${p}`),
            ...videoPrompts.slice(0, count).map((p) => `[VIDEO] ${p}`),
          ];
          return {
            imagePrompts: imagePrompts.slice(0, count),
            videoPrompts: videoPrompts.slice(0, count),
            prompts: combined,
            text: combined.join("\n"),
          };
        }

        const lines = cleaned
          .map((l) => l.replace(/^\[(IMAGE|ANH|ẢNH|VIDEO|VID)\]\s*:?\s*/i, "").trim())
          .slice(0, count);
        return {
          imagePrompts: targetMode === "image" ? lines : [],
          videoPrompts: targetMode === "video" ? lines : [],
          prompts: lines,
          text: lines.join("\n"),
        };
      };

      if (provider === "gemini") {
        const rawKey = body.apiKey || body.geminiApiKey || this.store.settings.geminiApiKey || "";
        const apiKey = String(rawKey).trim();
        const rawModel =
          body.model || body.geminiModel || this.store.settings.geminiModel || "gemini-2.5-flash";
        const model = String(rawModel).trim();
        if (!apiKey) {
          return this._sendJson(res, 400, {
            ok: false,
            error: "Chưa nhập Gemini API Key! Vui lòng dán Gemini API Key ở ô cấu hình bên trên.",
          });
        }
        if (body.apiKey || body.geminiApiKey) {
          this.store.saveSettings({ geminiApiKey: apiKey, geminiModel: model });
        }

        try {
          const parts = [{ text: systemPrompt }];
          if (characterImage && characterImage.b64) {
            parts.push({
              inlineData: {
                mimeType: characterImage.mime || "image/png",
                data: characterImage.b64,
              },
            });
          }
          for (const pImg of productImages.slice(0, 6)) {
            parts.push({
              inlineData: {
                mimeType: pImg.mime || "image/png",
                data: pImg.b64,
              },
            });
          }

          const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: { temperature: 0.7 },
              }),
              signal: AbortSignal.timeout(45000),
            }
          );
          const data = await geminiRes.json().catch(() => ({}));
          if (!geminiRes.ok) {
            throw new Error(data.error?.message || `Gemini API lỗi HTTP ${geminiRes.status}`);
          }
          const rawText =
            (data.candidates?.[0]?.content?.parts || [])
              .map((p) => p.text || "")
              .join("\n")
              .trim() || "";
          const parsed = parseGeneratedLines(rawText);
          return this._sendJson(res, 200, {
            ok: true,
            provider: "gemini",
            model,
            ...parsed,
          });
        } catch (err) {
          return this._sendJson(res, 500, { ok: false, error: `Lỗi Gemini API: ${err.message}` });
        }
      }

      // Fallback / Muse-Spark provider
      try {
        const out = await this.engine.chatCompletion({
          prompt: systemPrompt,
          model: "muse-spark",
        });
        const parsed = parseGeneratedLines(out.text || "");
        return this._sendJson(res, 200, {
          ok: true,
          provider: "muse-spark",
          ...parsed,
        });
      } catch (err) {
        return this._sendJson(res, 500, { ok: false, error: err.message });
      }
    }

    if (pathname === "/admin/generate" && req.method === "POST") {
      const body = await this._readJson(req);
      const mode = String(body.mode || "video").toLowerCase();
      const prompt = String(body.prompt || "").trim();
      if (!prompt) {
        return this._sendJson(res, 400, { ok: false, error: "Prompt không được để trống" });
      }

      const refList = [];
      if (body.characterImage && body.characterImage.b64) {
        refList.push({ ...body.characterImage, role: "character" });
      }
      if (body.productImage && body.productImage.b64) {
        refList.push({ ...body.productImage, role: "product" });
      }
      if (Array.isArray(body.referenceImages)) {
        for (const r of body.referenceImages) {
          if (r && r.b64) refList.push(r);
        }
      } else if (body.referenceImage && body.referenceImage.b64) {
        refList.push(body.referenceImage);
      } else if (body.linkedImageFilename) {
        try {
          const safeName = path.basename(String(body.linkedImageFilename));
          const fullPath = path.join(this.store.mediaDir, safeName);
          if (fs.existsSync(fullPath)) {
            const buf = fs.readFileSync(fullPath);
            const ext = path.extname(safeName).toLowerCase();
            const mime =
              ext === ".jpg" || ext === ".jpeg"
                ? "image/jpeg"
                : ext === ".webp"
                ? "image/webp"
                : "image/png";
            refList.push({
              b64: buf.toString("base64"),
              mime,
              name: safeName,
              role: "reference",
            });
          }
        } catch (_err) {
          // ignore if file read fails
        }
      }

      const runGenerationPayload = async () => {
        if (mode === "image") {
          const out = await this.engine.generateImage({
            prompt,
            model: body.model || "muse-image",
            aspectRatio: body.aspectRatio || "1:1",
            quality: body.quality || "4K",
            referenceImages: refList,
            accountId: body.accountId || "",
            rowId: body.rowId || "",
          });
          return {
            ok: true,
            mode: "image",
            taskId: out.taskId,
            accountName: out.accountName,
            productTitle: out.productTitle || "",
            mediaUrl: out.images[0]?.url || "",
            filename: out.images[0]?.filename || "",
            images: out.images.map((i) => ({ url: i.url, filename: i.filename })),
          };
        }

        if (mode === "chat") {
          const out = await this.engine.chatCompletion({
            prompt,
            model: body.model || "muse-spark",
          });
          return {
            ok: true,
            mode: "chat",
            taskId: out.taskId,
            text: out.text,
          };
        }

        const out = await this.engine.generateVideo({
          prompt,
          model: body.model || "muse-video",
          aspectRatio: body.aspectRatio || "9:16",
          duration: body.duration || "20s",
          quality: body.quality || "4K",
          referenceImages: refList,
          accountId: body.accountId || "",
          rowId: body.rowId || "",
        });
        return {
          ok: true,
          mode: "video",
          taskId: out.taskId,
          accountName: out.accountName,
          productTitle: out.productTitle || "",
          mediaUrl: out.video?.url || "",
          filename: out.video?.filename || "",
          video: { url: out.video?.url, filename: out.video?.filename },
        };
      };

      if (body.async) {
        const jobId = `job_${crypto.randomBytes(6).toString("hex")}`;
        const jobRecord = {
          jobId,
          rowId: body.rowId || "",
          status: "running",
          createdAt: Date.now(),
          result: null,
          error: null,
        };
        this.asyncJobs.set(jobId, jobRecord);

        runGenerationPayload()
          .then((resultData) => {
            jobRecord.status = "done";
            jobRecord.result = resultData;
          })
          .catch((err) => {
            jobRecord.status = "error";
            jobRecord.error = err.message || "Lỗi tạo video";
          })
          .finally(() => {
            setTimeout(() => {
              this.asyncJobs.delete(jobId);
            }, 2 * 60 * 60 * 1000);
          });

        return this._sendJson(res, 200, {
          ok: true,
          async: true,
          jobId,
        });
      }

      try {
        const payload = await runGenerationPayload();
        return this._sendJson(res, 200, payload);
      } catch (err) {
        return this._sendJson(res, 500, { ok: false, error: err.message });
      }
    }

    const genJobMatch = pathname.match(/^\/admin\/generate\/job\/([^/]+)$/);
    if (genJobMatch && req.method === "GET") {
      const job = this.asyncJobs.get(genJobMatch[1]);
      if (!job) {
        return this._sendJson(res, 404, { ok: false, error: "Job not found" });
      }
      let progress = job.status === "done" ? 100 : 0;
      let progressText = "";
      if (job.status === "running" && job.rowId) {
        const activeTask = (this.store.listActiveTasks() || []).find(
          (t) => t.row_id === job.rowId
        );
        if (activeTask) {
          progress = Number(activeTask.progress || 0);
          progressText = String(activeTask.progress_text || "");
        }
      }
      return this._sendJson(res, 200, {
        ok: true,
        jobId: job.jobId,
        status: job.status,
        progress,
        progress_text: progressText,
        result: job.result,
        error: job.error,
      });
    }

    if (pathname === "/admin/extension.zip" && req.method === "GET") {
      const extDir = path.join(this.rootDir, "extension");
      const files = [];
      if (fs.existsSync(extDir)) {
        for (const f of fs.readdirSync(extDir)) {
          const fp = path.join(extDir, f);
          if (!fs.statSync(fp).isFile()) continue;
          let content = fs.readFileSync(fp);
          if (f === "popup.js") {
            let txt = content.toString("utf-8");
            txt = txt.replace(/http:\/\/localhost:8638/g, this.baseUrl);
            txt = txt.replace(/__DEFAULT_BASE_URL__/g, this.baseUrl);
            txt = txt.replace(/__DEFAULT_API_KEY__/g, this.store.settings.apiKey || "");
            content = Buffer.from(txt, "utf-8");
          }
          files.push({ name: `muse-cookie-grabber/${f}`, data: content });
        }
      }
      const zipBuf = buildZipBuffer(files);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="embongai-muse-cookie-extension.zip"',
        "Content-Length": zipBuf.length,
      });
      res.end(zipBuf);
      return;
    }

    if (pathname === "/admin/tampermonkey.user.js" && req.method === "GET") {
      const script = `// ==UserScript==
// @name         EM BÔNG AI · Muse.ai Cookie Sync
// @namespace    https://embongai.local/
// @version      1.0.0
// @description  Đồng bộ Cookie Muse.ai 1-Click về EM BÔNG AI Muse Studio
// @match        https://muse.ai/*
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function() {
  'use strict';
  const SERVER = ${JSON.stringify(this.baseUrl)};
  const btn = document.createElement('button');
  btn.textContent = '🌱 Đồng bộ về EM BÔNG AI';
  btn.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:999999;background:#12bd86;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-weight:700;cursor:pointer;box-shadow:0 8px 24px rgba(4,154,108,0.35);font-family:sans-serif;';
  btn.onclick = () => {
    GM_xmlhttpRequest({
      method: 'POST',
      url: SERVER + '/admin/accounts',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ name: document.title || 'Muse Web', cookies: document.cookie }),
      onload: (r) => alert('Đã gửi Cookie về EM BÔNG AI Studio! (' + r.status + ')'),
      onerror: () => alert('Không kết nối được EM BÔNG AI Studio tại ' + SERVER)
    });
  };
  document.body.appendChild(btn);
})();
`;
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Content-Disposition": 'attachment; filename="embongai-muse.user.js"',
      });
      res.end(script);
      return;
    }

    // ==================== OPENAI V1 API ====================
    if (pathname === "/v1/models" && req.method === "GET") {
      const now = Math.floor(Date.now() / 1000);
      const modelIds = [
        "muse-spark",
        "muse-image",
        "muse-video",
        "muse-code",
        "gpt-4o",
        "gpt-4o-mini",
        "claude-sonnet-4-20250514",
        "dall-e-3",
        "gpt-image-1",
        "sora",
        "veo-3",
      ];
      return this._sendJson(res, 200, {
        object: "list",
        data: modelIds.map((id) => ({
          id,
          object: "model",
          created: now,
          owned_by: "em-bong-ai-muse",
        })),
      });
    }

    if (pathname === "/v1/chat/completions" && req.method === "POST") {
      const body = await this._readJson(req);
      const model = body.model || "muse-spark";
      const stream = Boolean(body.stream);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const prompt = messages
        .map((m) => {
          if (typeof m.content === "string") return m.content;
          if (Array.isArray(m.content)) {
            return m.content
              .map((part) => (typeof part === "string" ? part : part.text || ""))
              .join("\n");
          }
          return "";
        })
        .filter(Boolean)
        .join("\n\n");

      const resolved = resolveModel(model);
      const chatId = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const created = Math.floor(Date.now() / 1000);

      try {
        if (resolved.type === "image") {
          const imgOut = await this.engine.generateImage({ prompt, model });
          const md = imgOut.images
            .map((img) => `![Generated Image](${this.baseUrl}${img.url})`)
            .join("\n\n");
          return this._sendChatResponse(res, { chatId, created, model, text: md, stream });
        }

        if (resolved.type === "video") {
          const vidOut = await this.engine.generateVideo({ prompt, model });
          const fullUrl = `${this.baseUrl}${vidOut.video.url}`;
          const md = `[🎬 Tải Video (${vidOut.video.filename})](${fullUrl})\n\n<video controls src="${fullUrl}" width="480"></video>`;
          return this._sendChatResponse(res, { chatId, created, model, text: md, stream });
        }

        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          });

          const roleChunk = {
            id: chatId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

          await this.engine.chatCompletion({
            prompt,
            model,
            onDelta: (delta) => {
              const chunk = {
                id: chatId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            },
          });

          const stopChunk = {
            id: chatId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          };
          res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        const out = await this.engine.chatCompletion({ prompt, model });
        return this._sendChatResponse(res, {
          chatId,
          created,
          model,
          text: out.text,
          stream: false,
        });
      } catch (err) {
        return this._sendJson(res, 500, {
          error: { message: err.message, type: "api_error" },
        });
      }
    }

    if (pathname === "/v1/responses" && req.method === "POST") {
      const body = await this._readJson(req);
      const model = body.model || "muse-spark";
      let prompt = "";
      if (typeof body.input === "string") {
        prompt = body.input;
      } else if (Array.isArray(body.input)) {
        prompt = body.input
          .map((item) => {
            if (typeof item === "string") return item;
            if (typeof item.content === "string") return item.content;
            if (Array.isArray(item.content)) {
              return item.content.map((c) => c.text || "").join("\n");
            }
            return "";
          })
          .filter(Boolean)
          .join("\n\n");
      }

      try {
        const out = await this.engine.chatCompletion({ prompt, model });
        const respId = "resp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
        return this._sendJson(res, 200, {
          id: respId,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "completed",
          model,
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: out.text }],
            },
          ],
          output_text: out.text,
        });
      } catch (err) {
        return this._sendJson(res, 500, {
          error: { message: err.message, type: "api_error" },
        });
      }
    }

    if (pathname === "/v1/images/generations" && req.method === "POST") {
      const body = await this._readJson(req);
      const prompt = body.prompt || "";
      if (this._rejectEmptyPrompt(res, prompt)) return;
      const responseFormat = body.response_format || "url";
      try {
        const out = await this.engine.generateImage({
          prompt,
          model: body.model || "muse-image",
          aspectRatio: sizeToAspectRatio(body.aspect_ratio || body.size, "1:1"),
          quality: body.quality || "4K",
        });
        return this._sendJson(res, 200, {
          created: Math.floor(Date.now() / 1000),
          data: out.images.map((img) =>
            responseFormat === "b64_json"
              ? { b64_json: img.b64, revised_prompt: prompt }
              : { url: `${this.baseUrl}${img.url}`, revised_prompt: prompt }
          ),
        });
      } catch (err) {
        return this._sendJson(res, 500, {
          error: { message: err.message, type: "api_error" },
        });
      }
    }

    if (pathname === "/v1/images/edits" && req.method === "POST") {
      const ct = String(req.headers["content-type"] || "");
      let prompt = "";
      let model = "muse-image";
      let responseFormat = "url";
      let aspectRatio = "";
      let quality = "4K";
      const referenceImages = [];

      if (ct.includes("multipart/form-data")) {
        const boundaryMatch = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
        const boundary = boundaryMatch ? boundaryMatch[1] || boundaryMatch[2] : "";
        const buf = await this._readBodyBuffer(req);
        const { fields, files } = parseMultipart(buf, boundary);
        prompt = fields.prompt || "";
        model = fields.model || "muse-image";
        responseFormat = fields.response_format || "url";
        aspectRatio = sizeToAspectRatio(fields.aspect_ratio || fields.size, "");
        quality = fields.quality || "4K";
        for (const f of files) {
          referenceImages.push({ b64: f.b64, mime: f.mime, name: f.filename });
        }
      } else {
        const body = await this._readJson(req);
        prompt = body.prompt || "";
        model = body.model || "muse-image";
        responseFormat = body.response_format || "url";
        aspectRatio = sizeToAspectRatio(body.aspect_ratio || body.size, "");
        quality = body.quality || "4K";
        if (Array.isArray(body.images)) {
          for (const item of body.images) {
            if (typeof item === "string") {
              const b64 = item.includes(",") ? item.split(",")[1] : item;
              referenceImages.push({ b64, mime: "image/png", name: "ref.png" });
            } else if (item && item.b64) {
              referenceImages.push(item);
            }
          }
        }
      }
      if (this._rejectEmptyPrompt(res, prompt)) return;

      try {
        const out = await this.engine.generateImage({
          prompt,
          model,
          aspectRatio,
          quality,
          referenceImages,
        });
        return this._sendJson(res, 200, {
          created: Math.floor(Date.now() / 1000),
          data: out.images.map((img) =>
            responseFormat === "b64_json"
              ? { b64_json: img.b64, revised_prompt: prompt }
              : { url: `${this.baseUrl}${img.url}`, revised_prompt: prompt }
          ),
        });
      } catch (err) {
        return this._sendJson(res, 500, {
          error: { message: err.message, type: "api_error" },
        });
      }
    }

    if (pathname === "/v1/images/tasks" && req.method === "POST") {
      const body = await this._readJson(req);
      const prompt = body.prompt || "";
      if (this._rejectEmptyPrompt(res, prompt)) return;
      const model = body.model || "muse-image";
      const placeholder = this.store.createTask("image_async", prompt, model);

      this.engine
        .generateImage({
          prompt,
          model,
          aspectRatio: sizeToAspectRatio(body.aspect_ratio || body.size, ""),
          quality: body.quality || "4K",
        })
        .then((out) => {
          this.store.finishTask(placeholder.id, {
            data: out.images.map((i) => ({ url: `${this.baseUrl}${i.url}` })),
          });
        })
        .catch((err) => {
          this.store.finishTask(placeholder.id, null, err.message);
        });

      return this._sendJson(res, 200, {
        id: placeholder.id,
        status: "running",
        created_at: placeholder.created_at,
      });
    }

    const imgTaskMatch = pathname.match(/^\/v1\/images\/tasks\/([^/]+)$/);
    if (imgTaskMatch && req.method === "GET") {
      const t = this.store.getTask(imgTaskMatch[1]);
      if (!t) return this._sendJson(res, 404, { error: "Task not found" });
      return this._sendJson(res, 200, t);
    }

    if (pathname === "/v1/videos" && req.method === "POST") {
      const ct = String(req.headers["content-type"] || "");
      let prompt = "";
      let model = "muse-video";
      let aspectRatio = "9:16";
      let duration = "20s";
      let quality = "4K";
      let referenceImage = null;
      let asyncMode = false;

      if (ct.includes("multipart/form-data")) {
        const boundaryMatch = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
        const boundary = boundaryMatch ? boundaryMatch[1] || boundaryMatch[2] : "";
        const buf = await this._readBodyBuffer(req);
        const { fields, files } = parseMultipart(buf, boundary);
        prompt = fields.prompt || "";
        model = fields.model || "muse-video";
        aspectRatio = sizeToAspectRatio(fields.aspect_ratio || fields.size, "9:16");
        duration = fields.duration || "20s";
        quality = fields.quality || "4K";
        asyncMode = fields.async === "true";
        if (files.length > 0) {
          referenceImage = {
            b64: files[0].b64,
            mime: files[0].mime,
            name: files[0].filename,
          };
        }
      } else {
        const body = await this._readJson(req);
        prompt = body.prompt || "";
        model = body.model || "muse-video";
        aspectRatio = sizeToAspectRatio(body.aspect_ratio || body.size, "9:16");
        duration = body.duration || "20s";
        quality = body.quality || "4K";
        asyncMode = Boolean(body.async);
        if (body.input_reference) {
          const b64 = String(body.input_reference).includes(",")
            ? String(body.input_reference).split(",")[1]
            : String(body.input_reference);
          referenceImage = { b64, mime: "image/png", name: "first_frame.png" };
        }
      }
      if (this._rejectEmptyPrompt(res, prompt)) return;

      if (asyncMode) {
        const placeholder = this.store.createTask("video_async", prompt, model);
        this.engine
          .generateVideo({ prompt, model, aspectRatio, duration, quality, referenceImage })
          .then((out) => {
            this.store.finishTask(placeholder.id, {
              url: `${this.baseUrl}${out.video.url}`,
              filename: out.video.filename,
            });
          })
          .catch((err) => {
            this.store.finishTask(placeholder.id, null, err.message);
          });

        return this._sendJson(res, 200, {
          id: placeholder.id,
          object: "video",
          status: "in_progress",
          created_at: placeholder.created_at,
        });
      }

      try {
        const out = await this.engine.generateVideo({
          prompt,
          model,
          aspectRatio,
          duration,
          quality,
          referenceImage,
        });
        return this._sendJson(res, 200, {
          id: out.taskId,
          object: "video",
          status: "completed",
          created_at: Math.floor(Date.now() / 1000),
          url: `${this.baseUrl}${out.video.url}`,
          data: [{ url: `${this.baseUrl}${out.video.url}` }],
        });
      } catch (err) {
        return this._sendJson(res, 500, {
          error: { message: err.message, type: "api_error" },
        });
      }
    }

    const vidTaskMatch = pathname.match(/^\/v1\/videos\/([^/]+)$/);
    if (vidTaskMatch && req.method === "GET") {
      const t = this.store.getTask(vidTaskMatch[1]);
      if (!t) return this._sendJson(res, 404, { error: "Video task not found" });
      return this._sendJson(res, 200, {
        id: t.id,
        object: "video",
        status:
          t.status === "succeeded"
            ? "completed"
            : t.status === "failed"
            ? "failed"
            : "in_progress",
        url: t.result?.url || (t.result?.video?.url ? `${this.baseUrl}${t.result.video.url}` : null),
        error: t.error || null,
      });
    }

    return this._sendJson(res, 404, { error: `Not found: ${pathname}` });
  }

  _sendChatResponse(res, { chatId, created, model, text, stream }) {
    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      const chunk1 = {
        id: chatId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
      };
      const chunk2 = {
        id: chatId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
      res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    this._sendJson(res, 200, {
      id: chatId,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 80, total_tokens: 100 },
    });
  }
}

module.exports = {
  MuseServer,
  buildZipBuffer,
  sizeToAspectRatio,
};
