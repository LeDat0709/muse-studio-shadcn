"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const {
  CDPClient,
  getTargets,
  getBrowserWsUrl,
  closeTarget,
} = require("./cdp");
const {
  MuseGateway,
  inspectHistoryEvent,
  getOrCreateLocalProxyBridge,
  parseProxyConfig,
} = require("./gateway");

const MUSE_URL = "https://muse.ai";
const MUSE_NEW_THREAD = "https://muse.ai/thread/new";

const MODEL_ALIASES = {
  "muse-spark": { type: "chat", mode: "chat" },
  "muse-chat": { type: "chat", mode: "chat" },
  "muse-code": { type: "chat", mode: "code" },
  "gpt-4o": { type: "chat", mode: "chat" },
  "gpt-4o-mini": { type: "chat", mode: "chat" },
  "gpt-4.1": { type: "chat", mode: "chat" },
  "claude-3-5-sonnet-20241022": { type: "chat", mode: "chat" },
  "claude-sonnet-4-20250514": { type: "chat", mode: "chat" },
  "claude-sonnet-4": { type: "chat", mode: "chat" },
  "muse-image": { type: "image", mode: "create" },
  "gpt-image-1": { type: "image", mode: "create" },
  "dall-e-3": { type: "image", mode: "create" },
  "flux-pro": { type: "image", mode: "create" },
  "muse-video": { type: "video", mode: "create" },
  "sora": { type: "video", mode: "create" },
  "veo-3": { type: "video", mode: "create" },
};

function resolveModel(model) {
  const m = String(model || "muse-spark").toLowerCase().trim();
  if (MODEL_ALIASES[m]) return MODEL_ALIASES[m];
  if (m.includes("image") || m.includes("dall") || m.includes("flux") || m.includes("draw")) {
    return { type: "image", mode: "create" };
  }
  if (m.includes("video") || m.includes("sora") || m.includes("veo")) {
    return { type: "video", mode: "create" };
  }
  return { type: "chat", mode: "chat" };
}

function findChromeBinary(customPath = "") {
  if (customPath && fs.existsSync(customPath)) return customPath;
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = [
    process.env.CHROME_BIN,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    homeDir
      ? path.join(homeDir, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
      : "",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_err) {
      // ignore
    }
  }
  return "";
}

// ==================== EXACT MUSE.AI DOM SCRIPTS (PORTED FROM ENGINE.PY) ====================

const JS_HYDRATION_STATE = `
(() => {
  if (document.readyState !== 'complete') return 'loading';
  const bodyTxt = document.body ? (document.body.innerText || '') : '';
  if (
    !document.querySelector('textarea') &&
    (document.querySelector('[data-testid="native-auth-access-pane"]') ||
      bodyTxt.includes('Authentication required') ||
      /log in to muse|sign in to muse|create an account|continue with google|use another account/i.test(bodyTxt))
  ) {
    return 'logged-out';
  }
  const ta = document.querySelector('textarea');
  if (!ta) return 'no-ta';
  const h = document.querySelector('[data-hatch-shell-hydration-state]');
  if (h && h.getAttribute('data-hatch-shell-hydration-state') !== 'hydrated') return 'hydrating';
  if (bodyTxt.indexOf('Connecting...') !== -1) return 'connecting';
  if (ta.disabled) return 'input-disabled';
  return 'ready';
})()
`;

const JS_SCROLL_BOTTOM = `
(() => {
  const els = Array.from(document.querySelectorAll('*')).filter(e => {
    const s = getComputedStyle(e);
    return (s.overflowY === 'auto' || s.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 100;
  });
  els.sort((a, b) => b.scrollHeight - a.scrollHeight);
  if (els[0]) els[0].scrollTop = els[0].scrollHeight;
  const s = document.scrollingElement || document.body;
  if (s) s.scrollTop = s.scrollHeight;
  const ta = document.querySelector('textarea');
  if (ta) ta.scrollIntoView({ block: 'end' });
  return 1;
})()
`;

const JS_GET_ATTACHMENTS = `
(() => {
  const list = [];
  const seen = new Set();
  function addEl(el, tid) {
    if (!el || seen.has(el)) return;
    seen.add(el);
    if (el.closest('form, [class*="chat-user-bubble"], [class*="group/msg"]')) return;
    const v = el.querySelector('video') || (el.tagName === 'VIDEO' ? el : null);
    if (v && v.preload === 'none') {
      try { v.preload = 'metadata'; } catch (_) {}
    }
    const img = el.querySelector('img') || (el.tagName === 'IMG' ? el : null);
    const isVid = (tid || '').includes('video') || Boolean(v);
    const primary = isVid ? (v || img) : (img || v);
    const src = primary ? (primary.currentSrc || primary.src || '') : '';
    const vDur = (v && Number.isFinite(v.duration) && v.duration > 0) ? Math.round(v.duration * 10) / 10 : 0;
    if (src && !seen.has(src)) {
      seen.add(src);
      list.push({
        tid: tid || el.getAttribute('data-testid') || (isVid ? 'video' : 'image'),
        hasVideo: Boolean(v),
        hasImg: Boolean(img),
        src,
        vSrc: v ? (v.currentSrc || v.src || '') : '',
        iSrc: img ? (img.currentSrc || img.src || '') : '',
        w: primary ? (primary.videoWidth || primary.naturalWidth || 0) : 0,
        h: primary ? (primary.videoHeight || primary.naturalHeight || 0) : 0,
        dur: vDur,
      });
    }
  }
  document.querySelectorAll('[data-testid^="hatch-chat-attachment-presentation-"]').forEach(a => {
    addEl(a, a.getAttribute('data-testid'));
  });
  document.querySelectorAll('div[class*="hatch-agent-bubble-bg"] img, div[class*="hatch-agent-bubble-bg"] video').forEach(m => {
    const s = m.currentSrc || m.src || '';
    if (s && !s.includes('avatar') && !s.includes('emoji')) {
      addEl(m.parentElement || m, 'agent-media');
    }
  });
  return list;
})()
`;

// Never clobber an earlier render: claims "Title.mp4", then "Title (2).mp4", ... The "wx" flag makes the
// existence check and the create one atomic step, so parallel streams for the same product can't race.
function reserveUniqueFile(dir, base, ext) {
  for (let n = 1; ; n += 1) {
    const filename = n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`;
    try {
      fs.closeSync(fs.openSync(path.join(dir, filename), "wx"));
      return filename;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
}

const MAX_OUTPUT_NAME = 120;
const OUTPUT_MEDIA_EXT = /\.(mp4|mov|webm|mkv|png|jpe?g|webp|gif)$/i;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// The user's own name for an output file, made safe on macOS and Windows: no folders, no reserved device
// names, no extension (the real one comes from the media). "" means "let the engine pick a name".
function outputFileBase(name) {
  const base = String(name || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(OUTPUT_MEDIA_EXT, "")
    .replace(/^[.\s]+/, "")
    .slice(0, MAX_OUTPUT_NAME)
    .replace(/[.\s]+$/, "");
  return WINDOWS_RESERVED_NAME.test(base) ? `${base}_` : base;
}

// Fills a user-defined prompt template: {prompt} {duration} {ratio} {quality}
// {output} {clips} {specs}. Unknown placeholders are left untouched.
function applyPromptTemplate(tpl, vars) {
  return String(tpl || "").replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m
  );
}

// Builds a saved-media base filename from a user template in Settings. Adds the
// date/time/rand placeholders, then the caller sanitises it with outputFileBase().
// Placeholders: {title} {prompt} {duration} {ratio} {quality} {mode} {tag}
// {date} {time} {datetime} {rand}.
function buildTemplatedName(template, vars) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const hms = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return applyPromptTemplate(template, {
    date: ymd,
    time: hms,
    datetime: `${ymd.replace(/-/g, "")}_${hms}`,
    rand: crypto.randomBytes(3).toString("hex"),
    ...vars,
  });
}

function mediaExtFor(mime, expect) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("mp4")) return ".mp4";
  if (m.includes("webm")) return ".webm";
  if (m.includes("png")) return ".png";
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("webp")) return ".webp";
  return expect === "video" ? ".mp4" : ".png";
}

const MEDIA_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const PROMPT_INPUT_WAIT_MS = 20000;
// Abort a job after this many back-to-back history-poll failures instead of
// polling a dead socket blindly until the (up to 900s+) deadline (H9).
const MAX_CONSECUTIVE_POLL_FAILURES = 5;
// History polling cadence. Each running job polls on its own loop, so with many
// concurrent jobs the base rate is multiplied; widen the interval as concurrency
// rises so N streams don't all hammer getHistory + event parsing every 2.2s.
const BASE_POLL_MS = 2200;
const POLL_MS_PER_EXTRA_JOB = 500;
const MAX_POLL_MS = 6000;

// Classify a generation failure so auto-retry knows how to react.
function classifyGenError(message) {
  const m = String(message || "").toLowerCase();
  if (/refus|not available for this account|country or region|quốc gia|region-?block|content policy|cannot (?:create|generate)|unable to generate|not allowed|inappropriate|safety|vi phạm|chặn 403|403 forbidden/.test(m))
    return "violation";
  if (/401|unauthorized|sign in|log in|đăng xuất|hết hạn|thiếu cookie|nich die|ních die|unassigned|create an account/.test(m))
    return "auth";
  if (/50[234]|service unavailable|timeout|quá thời gian|mất kết nối|không tải được|gateway|network|econn|socket|reset|still sending/.test(m))
    return "transient";
  return "unknown";
}

// Make a rejected prompt safer/compliant for the next attempt (idempotent).
const SAFE_PROMPT_PREFIX =
  "(Phiên bản AN TOÀN, phù hợp quảng cáo thương mại, nhân vật người trưởng thành, bối cảnh điện ảnh nhẹ nhàng, KHÔNG chi tiết nhạy cảm/bạo lực/trẻ em) ";
function softenPromptForRetry(prompt) {
  const p = String(prompt || "");
  return p.startsWith(SAFE_PROMPT_PREFIX) ? p : SAFE_PROMPT_PREFIX + p;
}

// Where the tab is and what it shows, for errors that would otherwise say only "no textarea".
const JS_PAGE_SNAPSHOT = `
(() => ({
  url: location.href,
  tail: (document.body ? document.body.innerText || '' : '').replace(/\\s+/g, ' ').trim().slice(-160),
}))()
`;

const MAX_SINGLE_CLIP_SEC = 10;

// A stitched result must be longer than any single clip Muse can render and cover most of the target;
// otherwise a lone follow-up clip (e.g. 11s for a 60s order) would be accepted as the final video.
function minStitchedDurationSec(targetSec) {
  return Math.max(MAX_SINGLE_CLIP_SEC + 0.5, targetSec * 0.6);
}

const MEDIA_FINALIZE_POLL_MS = 5000;
const MEDIA_FINALIZE_GRACE_MS = 3 * 60 * 1000;

// ffmpeg creates its output file as soon as a render/stitch starts and only writes `moov` (and the real
// mdat size) when it finishes, so a file grabbed mid-render is an unplayable stub. Walks the top-level
// boxes; anything that is not an MP4 (no `ftyp`) is left to the caller.
function isUnfinishedMp4(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.toString("latin1", 4, 8) !== "ftyp") return false;
  let offset = 0;
  let hasMoov = false;
  while (offset + 8 <= buf.length) {
    let size = buf.readUInt32BE(offset);
    if (size === 1) {
      if (offset + 16 > buf.length) return true;
      size = Number(buf.readBigUInt64BE(offset + 8));
    }
    // size 0 ("runs to end of file") is ffmpeg's placeholder until it finalises the file.
    if (size < 8 || offset + size > buf.length) return true;
    if (buf.toString("latin1", offset + 4, offset + 8) === "moov") hasMoov = true;
    offset += size;
  }
  return !hasMoov || offset !== buf.length;
}

// Muse saves each job's output as `final_<taskTag>_<n>s.mp4`. A file carrying a
// DIFFERENT job's tag belongs to another job, so it must never be adopted here.
// Centralises the check that was duplicated across the poll loop (M5).
function isForeignFinalVideo(pathOrUrl, taskTag) {
  const m = String(pathOrUrl || "")
    .toLowerCase()
    .match(/final_([a-z0-9]{4,12})_\d+s\.mp4/i);
  return Boolean(m && m[1].toLowerCase() !== String(taskTag || "").toLowerCase());
}

// Re-downloads the same VM file until ffmpeg has finished writing it, so "Hoàn tất" never points at a stub.
// ponytail: re-fetches the whole file each poll; poll fs.stat size first if large renders make this slow.
async function downloadFinishedMedia(download, { deadlineMs, pollMs = MEDIA_FINALIZE_POLL_MS, onWait }) {
  for (;;) {
    const media = await download();
    if (!isUnfinishedMp4(media.buffer)) return media;
    if (Date.now() >= deadlineMs) {
      throw new Error(
        `File video trên Muse VM vẫn chưa ghi xong (thiếu moov, mới ${media.buffer.length} byte) nên không lưu file hỏng.`
      );
    }
    if (onWait) onWait(media.buffer.length);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function buildPrepareMediaChunksJs(src, storeKey) {
  return `
(async () => {
  try {
    const u = ${JSON.stringify(src)};
    const key = ${JSON.stringify(storeKey)};
    if (!u) return { ok: false, err: 'no-media-src' };
    window.__embongMediaStore = window.__embongMediaStore || {};
    if (u.startsWith('data:')) {
      const idx = u.indexOf(',');
      const meta = u.slice(0, idx);
      const b64 = u.slice(idx + 1);
      const mime = (meta.split(';')[0] || 'data:image/png').replace('data:', '');
      window.__embongMediaStore[key] = b64;
      return { ok: true, mime, size: Math.floor(b64.length * 0.75), b64Len: b64.length, url: u };
    }
    const r = await fetch(u);
    if (!r.ok) return { ok: false, err: 'media-http-' + r.status };
    const b = await r.blob();
    const ab = await b.arrayBuffer();
    const bytes = new Uint8Array(ab);
    let s = '';
    for (let i = 0; i < bytes.length; i += 65536) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 65536));
    }
    const b64 = btoa(s);
    window.__embongMediaStore[key] = b64;
    return { ok: true, mime: b.type || '', size: b.size, b64Len: b64.length, url: u };
  } catch (e) {
    return { ok: false, err: String(e) };
  }
})()
`;
}

class MuseEngine {
  constructor(store, options = {}) {
    this.store = store;
    this.cdpHost = options.cdpHost || process.env.CDP_HOST || "127.0.0.1";
    // Use port 9225 by default for primary profile; additional accounts use 9226, 9227, ...
    this.cdpPort = Number(options.cdpPort || process.env.CDP_PORT || 9225);
    this.chromeBin = options.chromeBin || process.env.CHROME_BIN || "";
    this.chromeUserData = path.join(this.store.dataDir, "chrome-visible-profile");
    this.chromeProfilesRoot = path.join(this.store.dataDir, "chrome-profiles");
    this.downloadDir = path.join(this.store.dataDir, "downloads");
    fs.mkdirSync(this.downloadDir, { recursive: true });
    fs.mkdirSync(this.chromeProfilesRoot, { recursive: true });
    this.chromeProc = null;
    this._chromeLaunchPromise = null;
    this._chromeLaunchPromises = new Map();
    this.portModes = new Map();
    this.portProxies = new Map();
    this.knownCdpPorts = new Set([this.cdpPort]);
    this.pendingLoginPorts = new Set();
    this._openTabChain = Promise.resolve();
    this.activeCount = 0;
    this.activeRunners = new Map();
    this.busyTabIds = new Set();
    this.usedGridSlots = new Map();
    this._autoCloseChromeTimer = null;
    this.lastBrowserSyncAt = 0;
    this.keepaliveRunning = false;
    this.keepaliveTimer = null;
    this.logs = [];
  }

  _getProfileDirForPort(port = null) {
    const p = Number(port || this.cdpPort);
    if (p === this.cdpPort) {
      return this.chromeUserData;
    }
    return path.join(this.chromeProfilesRoot, `profile_${p}`);
  }

  _getPortForAccount(account = null) {
    if (account && Number(account.cdp_port) > 0) {
      return Number(account.cdp_port);
    }
    return this.cdpPort;
  }

  _getAllKnownPorts() {
    const ports = new Set([this.cdpPort]);
    for (const acc of this.store.accounts || []) {
      if (acc && Number(acc.cdp_port) > 0) {
        ports.add(Number(acc.cdp_port));
      }
    }
    for (const p of this.knownCdpPorts) {
      if (Number(p) > 0) ports.add(Number(p));
    }
    for (const p of this.pendingLoginPorts) {
      if (Number(p) > 0) ports.add(Number(p));
    }
    return Array.from(ports).sort((a, b) => a - b);
  }

  _withOpenTabLock(fn) {
    const next = this._openTabChain.then(() => fn());
    this._openTabChain = next.catch(() => {});
    return next;
  }

  log(message, level = "info") {
    const entry = {
      time: new Date().toISOString(),
      level,
      message: String(message),
    };
    this.logs.push(entry);
    if (this.logs.length > 300) {
      this.logs.shift();
    }
    console.log(`[MuseEngine][${level.toUpperCase()}] ${message}`);
  }

  getLogs(limit = 100) {
    return this.logs.slice(-limit).reverse();
  }

  async isChromeAlive(customPort = null) {
    if (customPort !== null && customPort !== undefined) {
      try {
        await getTargets(this.cdpHost, Number(customPort));
        return true;
      } catch (_err) {
        return false;
      }
    }
    try {
      await getTargets(this.cdpHost, this.cdpPort);
      return true;
    } catch (_err) {
      for (const p of this._getAllKnownPorts()) {
        if (p === this.cdpPort) continue;
        try {
          await getTargets(this.cdpHost, p);
          return true;
        } catch (_e2) {
          // ignore
        }
      }
      return false;
    }
  }

  async _closeBrowserOnPort(port) {
    try {
      const browserWs = await getBrowserWsUrl(this.cdpHost, port);
      if (browserWs) {
        const browserCdp = new CDPClient(browserWs);
        await browserCdp.connect(2500);
        await browserCdp.send("Browser.close").catch(() => {});
        await browserCdp.close().catch(() => {});
      }
    } catch (_e) {
      // ignore
    }
    for (let i = 0; i < 12; i += 1) {
      if (!(await this.isChromeAlive(port))) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    this.portModes.delete(port);
  }

  /**
   * Launches Chrome in Headless (--headless=new) mode by default, or visibly when requested!
   * Serialized per port so concurrent streams/logins never spawn duplicate processes on the same port.
   */
  async ensureChrome(forceVisible = false, customPort = null, slotHint = null, proxyOverride = null) {
    if (this._autoCloseChromeTimer) {
      clearTimeout(this._autoCloseChromeTimer);
      this._autoCloseChromeTimer = null;
    }
    const targetPort = Number(customPort || this.cdpPort);
    this.knownCdpPorts.add(targetPort);
    const existingPromise = this._chromeLaunchPromises.get(targetPort);
    if (existingPromise) {
      return existingPromise;
    }
    const p = this._ensureChromeInternal(forceVisible, targetPort, slotHint, proxyOverride).finally(() => {
      this._chromeLaunchPromises.delete(targetPort);
      if (targetPort === this.cdpPort) {
        this._chromeLaunchPromise = null;
      }
    });
    this._chromeLaunchPromises.set(targetPort, p);
    if (targetPort === this.cdpPort) {
      this._chromeLaunchPromise = p;
    }
    return p;
  }

  async _ensureChromeInternal(
    forceVisible = false,
    targetPort = this.cdpPort,
    slotHint = null,
    proxyOverride = null
  ) {
    const port = Number(targetPort || this.cdpPort);
    const profileDir = this._getProfileDirForPort(port);
    const isVisibleMode =
      Boolean(forceVisible) ||
      Boolean(this.store.settings && this.store.settings.showChromeWindow === true);

    const accForPort = (this.store.accounts || []).find(
      (a) => Number(a.cdp_port || this.cdpPort) === port
    );
    const rawProxy = String(
      proxyOverride !== null && proxyOverride !== undefined
        ? proxyOverride
        : accForPort?.proxy || ""
    ).trim();

    if (await this.isChromeAlive(port)) {
      const currentMode = this.portModes.get(port);
      const currentProxy = this.portProxies.get(port) || "";
      if ((isVisibleMode && currentMode === "headless") || currentProxy !== rawProxy) {
        this.log(
          `Khởi động lại cổng CDP :${port} để áp dụng ${
            currentProxy !== rawProxy ? "cấu hình Proxy mới" : "Chế độ Hiển thị"
          }...`
        );
        await this._closeBrowserOnPort(port);
      } else {
        return true;
      }
    }

    const bin = findChromeBinary(this.chromeBin);
    if (!bin) {
      throw new Error(
        "Không tìm thấy Google Chrome hoặc Microsoft Edge trên máy. Vui lòng cài đặt Chrome."
      );
    }

    fs.mkdirSync(profileDir, { recursive: true });
    for (const lockName of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      const lp = path.join(profileDir, lockName);
      try {
        if (fs.existsSync(lp)) fs.unlinkSync(lp);
      } catch (_err) {
        // ignore
      }
    }

    const gridSlot = slotHint !== null ? Number(slotHint) : Math.max(0, port - this.cdpPort);
    const initBounds = this._getCompactGridBounds(gridSlot, isVisibleMode);

    const args = [
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--simulate-outdated-no-au=Tue, 31 Dec 2099 23:59:59 GMT",
      "--disable-component-update",
      "--disable-background-networking",
      "--disable-default-apps",
      "--no-service-autorun",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,OutdatedBuildDetector,ChromeWhatsNewUI,Translate",
      "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      `--window-size=${initBounds.width},${initBounds.height}`,
      `--window-position=${initBounds.left},${initBounds.top}`,
    ];

    if (rawProxy) {
      const bridgeUrl = await getOrCreateLocalProxyBridge(rawProxy).catch(() => null);
      if (bridgeUrl) {
        args.push(`--proxy-server=${bridgeUrl}`);
        const parsedP = parseProxyConfig(rawProxy);
        this.log(
          `[Proxy Cổng :${port}] Đã gắn Proxy riêng (${parsedP ? parsedP.label : rawProxy}) qua cầu nối cục bộ ${bridgeUrl}`
        );
      }
    }

    if (!isVisibleMode) {
      args.push("--headless=new", "--hide-scrollbars", "--mute-audio");
    }

    args.push(MUSE_URL);

    this.log(
      `Đang khởi chạy Engine CDP (${isVisibleMode ? "Chế độ Hiển thị Gọn" : "Chế độ Headless 100% Không Hiện Cửa Sổ"}) tại cổng :${port}...`
    );
    const proc = spawn(bin, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: !isVisibleMode,
    });
    proc.unref();
    if (port === this.cdpPort) {
      this.chromeProc = proc;
    }

    for (let i = 0; i < 35; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      if (await this.isChromeAlive(port)) {
        this.portModes.set(port, isVisibleMode ? "visible" : "headless");
        this.portProxies.set(port, rawProxy);
        this.log(
          `Đã kết nối Engine CDP cổng :${port} (${isVisibleMode ? "Visible" : "Headless 100%"}) thành công!`
        );
        return true;
      }
    }
    throw new Error(`Không thể kết nối Chrome CDP trên cổng ${port}`);
  }

  _getCompactGridBounds(slot = 0, visible = true) {
    if (!visible) {
      return {
        left: -3200,
        top: 0,
        width: 440,
        height: 350,
        windowState: "normal",
      };
    }
    const col = slot % 4;
    const row = Math.floor(slot / 4) % 3;
    return {
      left: 16 + col * 446,
      top: 20 + row * 356,
      width: 440,
      height: 350,
      windowState: "normal",
    };
  }

  async _setChromeWin32Visibility(visible = true, targetPort = null) {
    const portFilter = targetPort
      ? `--remote-debugging-port=${Number(targetPort)}`
      : "--remote-debugging-port=92";

    if (process.platform === "darwin") {
      const actionMethod = visible ? "unhide" : "hide";
      const jxaScript = `
        ObjC.import('AppKit');
        ObjC.import('Foundation');
        const task = $.NSTask.alloc.init;
        task.launchPath = '/usr/bin/pgrep';
        task.arguments = $(['-f', ${JSON.stringify(portFilter)}]);
        const pipe = $.NSPipe.pipe;
        task.standardOutput = pipe;
        try {
          task.launch;
          task.waitUntilExit;
          const data = pipe.fileHandleForReading.readDataToEndOfFile;
          const out = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
          out.split(/\\s+/).forEach(s => {
            const pid = parseInt(s, 10);
            if (pid > 0) {
              const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
              if (app && !app.isNil()) app.${actionMethod};
            }
          });
        } catch (e) {}
      `;
      return new Promise((resolve) => {
        const child = spawn("osascript", ["-l", "JavaScript", "-e", jxaScript], {
          stdio: "ignore",
        });
        child.on("close", () => resolve());
        child.on("error", () => resolve());
        setTimeout(() => resolve(), 2000);
      });
    }

    if (process.platform !== "win32") return;
    const cmdShow = visible ? 9 : 0; // 9 = SW_RESTORE, 0 = SW_HIDE
    const psScript = `
$code = @'
using System;
using System.Runtime.InteropServices;
public class Win32Show {
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
'@
Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
$portStr = "${portFilter}"
$procs = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*$portStr*" }
foreach ($p in $procs) {
  $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if ($gp -and $gp.MainWindowHandle -ne 0) {
    [Win32Show]::ShowWindowAsync($gp.MainWindowHandle, ${cmdShow}) | Out-Null
  }
}
`;
    return new Promise((resolve) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psScript],
        { stdio: "ignore", windowsHide: true }
      );
      child.on("close", () => resolve());
      child.on("error", () => resolve());
      setTimeout(() => resolve(), 2500);
    });
  }

  async bringChromeToFront({ saveSetting = true, targetPort = null } = {}) {
    if (saveSetting) {
      this.store.saveSettings({ showChromeWindow: true });
    }
    try {
      await this._setChromeWin32Visibility(true, targetPort);
      const ports = targetPort ? [Number(targetPort)] : this._getAllKnownPorts();
      let slotIdx = targetPort ? Math.max(0, Number(targetPort) - this.cdpPort) : 0;

      for (const port of ports) {
        let targets = [];
        try {
          targets = await getTargets(this.cdpHost, port);
        } catch (_e) {
          continue;
        }
        const pageTargets = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
        const museTargets = pageTargets.filter((t) => (t.url || "").includes("muse.ai"));
        const toRestore = museTargets.length > 0 ? museTargets : pageTargets;
        const seenWinIds = new Set();

        for (let i = 0; i < toRestore.length; i += 1) {
          const pt = toRestore[i];
          const cdp = new CDPClient(pt.webSocketDebuggerUrl);
          await cdp.connect(4000).catch(() => {});
          try {
            const win = await cdp
              .send("Browser.getWindowForTarget", { targetId: pt.id })
              .catch(() => null);
            if (win && win.windowId && !seenWinIds.has(win.windowId)) {
              seenWinIds.add(win.windowId);
              const gridBounds = this._getCompactGridBounds(slotIdx, true);
              slotIdx += 1;
              await cdp
                .send("Browser.setWindowBounds", {
                  windowId: win.windowId,
                  bounds: { windowState: "normal" },
                })
                .catch(() => {});
              await cdp
                .send("Browser.setWindowBounds", {
                  windowId: win.windowId,
                  bounds: gridBounds,
                })
                .catch(() => {});
            }
            await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
            await cdp.send("Page.bringToFront").catch(() => {});
          } finally {
            await cdp.close();
          }
        }
      }
    } catch (_err) {
      // ignore
    }
  }

  async hideChromeWindows({ saveSetting = true } = {}) {
    if (saveSetting) {
      this.store.saveSettings({ showChromeWindow: false, headlessMode: true });
    }
    try {
      const ports = this._getAllKnownPorts();
      if (this.activeCount === 0 && this.pendingLoginPorts.size === 0) {
        for (const port of ports) {
          if (this.portModes.get(port) === "visible") {
            await this._closeBrowserOnPort(port);
          }
        }
        await this._setChromeWin32Visibility(false);
        this.log("Đã chuyển sang Chế độ Headless 100% (--headless=new): Tuyệt đối không hiện cửa sổ Chrome.");
        return;
      }
      let globalIdx = 0;
      for (const port of ports) {
        let targets = [];
        try {
          targets = await getTargets(this.cdpHost, port);
        } catch (_e) {
          continue;
        }
        const pageTargets = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
        const seenWinIds = new Set();

        for (let i = 0; i < pageTargets.length; i += 1) {
          const pt = pageTargets[i];
          const cdp = new CDPClient(pt.webSocketDebuggerUrl);
          await cdp.connect(3500).catch(() => {});
          try {
            await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
            await cdp.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
            const win = await cdp
              .send("Browser.getWindowForTarget", { targetId: pt.id })
              .catch(() => null);
            if (win && win.windowId && !seenWinIds.has(win.windowId)) {
              seenWinIds.add(win.windowId);
              await cdp
                .send("Browser.setWindowBounds", {
                  windowId: win.windowId,
                  bounds: { windowState: "normal" },
                })
                .catch(() => {});
              await cdp
                .send("Browser.setWindowBounds", {
                  windowId: win.windowId,
                  bounds: this._getCompactGridBounds(globalIdx, false),
                })
                .catch(() => {});
              globalIdx += 1;
            }
          } finally {
            await cdp.close();
          }
        }
      }
      await this._setChromeWin32Visibility(false);
      this.log("Đã ẩn toàn bộ cửa sổ Chrome khỏi màn hình (vẫn chạy ngầm 100% tốc độ).");
    } catch (_err) {
      // ignore
    }
  }

  _scheduleAutoCloseChrome(delayMs = 1200) {
    if (this._autoCloseChromeTimer) {
      clearTimeout(this._autoCloseChromeTimer);
    }
    this._autoCloseChromeTimer = setTimeout(() => {
      this._autoCloseChromeTimer = null;
      if (this.activeCount === 0 && this.busyTabIds.size === 0) {
        this.closeAllChromeBrowsers().catch(() => {});
      }
    }, delayMs);
  }

  async closeAllChromeBrowsers({ targetPort = null } = {}) {
    if (!targetPort && (this.activeCount > 0 || this.busyTabIds.size > 0)) {
      return { ok: true, closed: false, busy: true };
    }
    const ports = targetPort ? [Number(targetPort)] : this._getAllKnownPorts();
    let closedAny = false;

    for (const port of ports) {
      if (this.pendingLoginPorts.has(port)) continue;
      const busyOnPort = Array.from(this.busyTabIds).filter((id) =>
        String(id).startsWith(`${port}:`)
      ).length;
      if (busyOnPort > 0) continue;

      const alive = await this.isChromeAlive(port);
      if (!alive) continue;

      closedAny = true;
      try {
        const browserWs = await getBrowserWsUrl(this.cdpHost, port).catch(() => null);
        if (browserWs) {
          const browserCdp = new CDPClient(browserWs);
          await browserCdp.connect(2500).catch(() => {});
          try {
            await browserCdp.send("Browser.close").catch(() => {});
          } finally {
            await browserCdp.close();
          }
        }
      } catch (_e) {
        // ignore
      }

      try {
        const targets = await getTargets(this.cdpHost, port).catch(() => []);
        const pageTargets = targets.filter((t) => t.type === "page");
        for (const pt of pageTargets) {
          await closeTarget(this.cdpHost, port, pt.id).catch(() => {});
        }
      } catch (_e) {
        // ignore
      }

      await new Promise((r) => setTimeout(r, 450));
      if (await this.isChromeAlive(port)) {
        if (process.platform === "win32") {
          await new Promise((resolve) => {
            const psCmd = `Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*--remote-debugging-port=${port}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
            const child = spawn(
              "powershell.exe",
              ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psCmd],
              { stdio: "ignore", windowsHide: true }
            );
            child.on("close", () => resolve());
            child.on("error", () => resolve());
            setTimeout(() => resolve(), 2000);
          });
        } else {
          await new Promise((resolve) => {
            const child = spawn("pkill", ["-f", `--remote-debugging-port=${port}`], {
              stdio: "ignore",
            });
            child.on("close", () => resolve());
            child.on("error", () => resolve());
            setTimeout(() => resolve(), 1500);
          });
        }
      }
    }

    if (closedAny) {
      this.usedGridSlots.clear();
      this.log("Đã tự động đóng Chrome sau khi hoàn tất tiến trình tạo Video.");
    }
    return { ok: true, closed: closedAny };
  }

  async _syncSinglePortSession(port, { force = false } = {}) {
    try {
      const targets = await getTargets(this.cdpHost, port);
      const museTarget = targets.find((t) => {
        const u = String(t.url || "");
        return (
          t.type === "page" &&
          t.webSocketDebuggerUrl &&
          u.startsWith("https://muse.ai") &&
          !u.includes("/oidc/") &&
          !u.includes("/access") &&
          !u.includes("aymh") &&
          !this.busyTabIds.has(t.id) &&
          !this.busyTabIds.has(`${port}:${t.id}`)
        );
      });
      if (!museTarget) return null;

      const cdp = new CDPClient(museTarget.webSocketDebuggerUrl);
      await cdp.connect();
      try {
        await cdp.send("Network.enable");
        const cookieRes = await cdp.send("Network.getCookies", {
          urls: ["https://muse.ai", "https://www.muse.ai"],
        });
        const museCookies = (cookieRes.cookies || []).filter((c) =>
          String(c.domain || "").includes("muse.ai")
        );
        const sessCookie = museCookies.find((c) => c.name === "hatch_sess" && c.value);
        if (!sessCookie) return null;

        const matchingAcc = this.store.accounts.find((a) =>
          (a.cookies || []).some((c) => c.name === "hatch_sess" && c.value === sessCookie.value)
        );
        if (matchingAcc && matchingAcc.status === "live" && !force) {
          this.store.updateAccountCookies(matchingAcc.id, museCookies);
          return { ok: true, account: matchingAcc };
        }

        await cdp.send("Runtime.enable");
        const checkRes = await cdp.evaluate(
          `
          (async () => {
            try {
              const href = String(location.href || '');
              if (
                href.includes('auth.muse.ai') ||
                href.includes('aymh') ||
                href.includes('/oidc/') ||
                href.includes('/access') ||
                document.querySelector('[data-testid="native-auth-access-pane"]')
              ) {
                return { ok: false, loginPage: true };
              }
              const r1 = await fetch('https://muse.ai/api/session', { credentials: 'include' });
              if (!r1.ok) return { ok: false, status: r1.status };
              const d1 = await r1.json();
              const email = d1?.email || d1?.user?.email || d1?.user?.username || '';
              return {
                ok: Boolean(d1 && d1.status === 'assigned'),
                vm_state: d1?.vm_state || 'RUNNING',
                email
              };
            } catch (e) {
              return { ok: false, error: String(e) };
            }
          })()
          `,
          true,
          8000
        );

        if (!checkRes || !checkRes.ok) return null;

        const finalCookieRes = await cdp.send("Network.getCookies", {
          urls: ["https://muse.ai", "https://www.muse.ai"],
        });
        const finalMuseCookies = (finalCookieRes.cookies || []).filter((c) =>
          String(c.domain || "").includes("muse.ai")
        );
        const normalized = (finalMuseCookies.length ? finalMuseCookies : museCookies).map((c) => ({
          name: c.name,
          value: c.value,
          domain:
            c.domain ||
            (String(c.name).startsWith("hatch_native_auth_") || c.name === "theme"
              ? "muse.ai"
              : ".muse.ai"),
          path: c.path || "/",
          secure: c.secure !== undefined ? Boolean(c.secure) : true,
          httpOnly: Boolean(c.httpOnly),
          sameSite: c.sameSite || "Lax",
          expires: Number(c.expires || 0),
        }));

        if (matchingAcc) {
          this.store.updateAccountCookies(
            matchingAcc.id,
            normalized,
            checkRes.email || "",
            checkRes.vm_state || "RUNNING"
          );
          this.store.markLive(matchingAcc.id, { vm_state: checkRes.vm_state || "RUNNING" });
          return { ok: true, account: matchingAcc };
        }

        const { account, isNew } = this.store.addAccount(
          "",
          normalized,
          checkRes.email || "",
          { cdpPort: port, forceNew: true }
        );
        this.store.markLive(account.id, { vm_state: checkRes.vm_state || "RUNNING" });
        this.log(
          `[🟢 LIVE] Đã tự động đồng bộ phiên đăng nhập trên Chrome (cổng ${port}) vào [${account.name}] (${normalized.length} cookies)`
        );
        return { ok: true, isNew, account };
      } finally {
        await cdp.close();
      }
    } catch (_err) {
      return null;
    }
  }

  /**
   * Non-intrusively checks if any open Chrome window across all account ports has an active Muse.ai session
   * and syncs it into this.store.accounts so manual browser logins never get overwritten or logged out.
   */
  async syncActiveBrowserSession({ force = false } = {}) {
    if (!force && Date.now() - this.lastBrowserSyncAt < 8000) return null;
    if (this.activeCount > 0 || this.keepaliveRunning) return null;
    this.lastBrowserSyncAt = Date.now();

    let lastSynced = null;
    for (const port of this._getAllKnownPorts()) {
      if (!force && this.pendingLoginPorts.has(port)) continue;
      const r = await this._syncSinglePortSession(port, { force });
      if (r && r.ok) {
        lastSynced = r;
      }
    }
    return lastSynced;
  }

  /**
   * Multi-Account Visible Chrome Login:
   * - If accountId is specified, opens that specific account's dedicated Chrome profile & port.
   * - If adding a new account (!accountId), automatically allocates a fresh isolated Chrome profile & port
   *   (9225 for #1, 9226 for #2, 9227 for #3, ...) so the user can log into unlimited accounts without
   *   ever logging out or colliding with existing accounts!
   */
  async loginWithBrowser({
    accountName = "",
    accountId = "",
    proxy = "",
    forceNewProfile = false,
    slotOffset = 0,
    timeoutSec = 240,
  } = {}) {
    const existingAcc = accountId ? this.store.getAccount(accountId) : null;
    const effectiveProxy = String(proxy || existingAcc?.proxy || "").trim();
    if (existingAcc && proxy !== undefined && String(proxy).trim()) {
      this.store.updateAccountProxy(existingAcc.id, String(proxy).trim());
    }

    // First, sync port 9225 if it already has an active session so Account #1 is never lost
    if (!existingAcc && !this.pendingLoginPorts.has(this.cdpPort)) {
      await this._syncSinglePortSession(this.cdpPort, { force: true }).catch(() => null);
    }

    let targetPort = this.cdpPort;
    const isAddingNewAccount = !existingAcc;

    if (existingAcc) {
      targetPort = this._getPortForAccount(existingAcc);
    } else {
      // Check if primary port 9225 is completely free (no accounts yet and not in pending login)
      const port9225UsedByAccount = this.store.accounts.some(
        (a) => Number(a.cdp_port || this.cdpPort) === this.cdpPort
      );
      if (
        !forceNewProfile &&
        this.store.accounts.length === 0 &&
        !port9225UsedByAccount &&
        !this.pendingLoginPorts.has(this.cdpPort)
      ) {
        targetPort = this.cdpPort;
      } else {
        targetPort = this.store.allocateNextCdpPort(this.cdpPort, this.pendingLoginPorts);
      }
    }

    this.pendingLoginPorts.add(targetPort);
    this.knownCdpPorts.add(targetPort);
    const gridSlot = Math.max(0, targetPort - this.cdpPort + Number(slotOffset || 0));

    let cdp = null;
    try {
      await this.ensureChrome(true, targetPort, gridSlot, effectiveProxy);
      await this.bringChromeToFront({ saveSetting: true, targetPort });

      const targets = await getTargets(this.cdpHost, targetPort);
      let pageTarget =
        targets.find(
          (t) =>
            t.type === "page" &&
            t.webSocketDebuggerUrl &&
            ((t.url || "").includes("muse.ai") ||
              (t.url || "").includes("meta.com") ||
              (t.url || "").includes("facebook.com") ||
              (t.url || "").includes("instagram.com") ||
              (t.url || "").includes("accounts.google.com"))
        ) || targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);

      if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
        throw new Error(`Không tìm thấy tab Muse.ai trong cửa sổ Chrome (cổng ${targetPort}).`);
      }

      cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
      await cdp.connect();
      await cdp.send("Page.enable");
      await cdp.send("Network.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Page.bringToFront");

      // Position this login window neatly in the compact grid so multiple login windows never stack on top of each other
      try {
        const win = await cdp.send("Browser.getWindowForTarget", { targetId: pageTarget.id });
        if (win && win.windowId) {
          await cdp
            .send("Browser.setWindowBounds", {
              windowId: win.windowId,
              bounds: { windowState: "normal" },
            })
            .catch(() => {});
          await cdp
            .send("Browser.setWindowBounds", {
              windowId: win.windowId,
              bounds: this._getCompactGridBounds(gridSlot, true),
            })
            .catch(() => {});
        }
      } catch (_e) {
        // ignore
      }

      // Check existing cookies in this profile before starting login poll
      const initCookieRes = await cdp
        .send("Network.getCookies", { urls: ["https://muse.ai", "https://www.muse.ai"] })
        .catch(() => ({ cookies: [] }));
      const initMuseCookies = (initCookieRes.cookies || []).filter((c) =>
        String(c.domain || "").includes("muse.ai")
      );
      const initSess =
        (initMuseCookies.find((c) => c.name === "hatch_sess" && c.value) || {}).value || "";

      if (existingAcc) {
        // Opening a specific existing account's Chrome profile: if profile has no session yet, inject its stored cookies
        if (!initSess && Array.isArray(existingAcc.cookies) && existingAcc.cookies.length > 0) {
          await this._applyAccountCookiesToCdp(cdp, existingAcc.cookies);
          await cdp.navigate(MUSE_URL, 2500);
        }
      } else if (isAddingNewAccount && initSess) {
        // If adding a brand-new account and this profile has a hatch_sess that ALREADY belongs to an existing account
        // (or leftover from a deleted account when forceNewProfile is requested), clear .muse.ai cookies on this profile
        // so the user gets a clean login screen for the new account!
        const alreadySavedAcc = this.store.accounts.find((a) =>
          (a.cookies || []).some((c) => c.name === "hatch_sess" && c.value === initSess)
        );
        if (alreadySavedAcc || forceNewProfile) {
          for (const ec of initMuseCookies) {
            await cdp
              .send("Network.deleteCookies", {
                name: ec.name,
                domain: ec.domain,
                path: ec.path || "/",
              })
              .catch(() => {});
          }
          await cdp.navigate(MUSE_URL, 2500);
        }
      }

      let curUrl = String((await cdp.evaluate("location.href")) || "");
      const bodyTxt = String(
        (await cdp.evaluate("document.body ? document.body.innerText : ''")) || ""
      );
      const isAuthDomain =
        curUrl.includes("muse.ai") ||
        curUrl.includes("meta.com") ||
        curUrl.includes("facebook.com") ||
        curUrl.includes("instagram.com") ||
        curUrl.includes("google.com");

      if (!isAuthDomain || bodyTxt.includes("Authentication required")) {
        await cdp.navigate(MUSE_URL, 2500);
        curUrl = String((await cdp.evaluate("location.href")) || "");
      }

      const deadline = Date.now() + timeoutSec * 1000;
      let museCookies = [];
      let vmState = "RUNNING";
      let detectedEmail = "";

      while (Date.now() < deadline) {
        // Also check if the user completed login in a newly opened tab on the same Chrome port
        let activeCdp = cdp;
        try {
          const curTargets = await getTargets(this.cdpHost, targetPort);
          const mainMuseTab = curTargets.find((t) => {
            const u = String(t.url || "");
            return (
              t.type === "page" &&
              t.webSocketDebuggerUrl &&
              u.startsWith("https://muse.ai") &&
              !u.includes("/oidc/") &&
              !u.includes("/access") &&
              !u.includes("aymh")
            );
          });
          if (mainMuseTab && mainMuseTab.id !== pageTarget.id) {
            await cdp.close().catch(() => {});
            pageTarget = mainMuseTab;
            cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
            await cdp.connect();
            await cdp.send("Page.enable");
            await cdp.send("Network.enable");
            await cdp.send("Runtime.enable");
            activeCdp = cdp;
          }
        } catch (_eTab) {
          // ignore
        }

        const res = await activeCdp.send("Network.getCookies", {
          urls: ["https://muse.ai", "https://www.muse.ai"],
        });
        museCookies = (res.cookies || []).filter((c) =>
          String(c.domain || "").includes("muse.ai")
        );
        const sessObj = museCookies.find((c) => c.name === "hatch_sess" && c.value);
        const hasSess = Boolean(sessObj && sessObj.value);

        if (hasSess) {
          const currentHref = String((await activeCdp.evaluate("location.href")) || "");
          if (
            currentHref.startsWith("https://muse.ai") &&
            !currentHref.includes("/oidc/") &&
            !currentHref.includes("/access") &&
            !currentHref.includes("aymh")
          ) {
            const checkRes = await activeCdp.evaluate(
              `
              (async () => {
                try {
                  if (
                    location.href.includes('aymh') ||
                    location.href.includes('/oidc/') ||
                    location.href.includes('/access') ||
                    document.querySelector('[data-testid="native-auth-access-pane"]')
                  ) {
                    return { ok: false, loginPage: true };
                  }
                  const r1 = await fetch('https://muse.ai/api/session', { credentials: 'include' });
                  if (!r1.ok) return { ok: false, status: r1.status };
                  const d1 = await r1.json();
                  const email = d1?.email || d1?.user?.email || d1?.user?.username || '';
                  return { ok: d1?.status === 'assigned', data: d1, email };
                } catch (e) { return { ok: false, error: String(e) }; }
              })()
              `,
              true,
              8000
            );

            if (checkRes && checkRes.ok) {
              vmState = checkRes.data?.vm_state || "RUNNING";
              detectedEmail = checkRes.email || "";
              this.log(
                `Đã xác nhận phiên đăng nhập Muse.ai LIVE trên cổng ${targetPort}! Đang lưu Cookie...`
              );
              await new Promise((r) => setTimeout(r, 800));
              const finalCookieRes = await activeCdp.send("Network.getCookies", {
                urls: ["https://muse.ai", "https://www.muse.ai"],
              });
              const updatedCookies = (finalCookieRes.cookies || []).filter((c) =>
                String(c.domain || "").includes("muse.ai")
              );
              if (updatedCookies.length > 0) {
                museCookies = updatedCookies;
              }
              break;
            }
          }
        }

        await new Promise((r) => setTimeout(r, 2000));
      }

      if (!museCookies.some((c) => c.name === "hatch_sess" && c.value)) {
        throw new Error(
          `Hết thời gian chờ đăng nhập Muse.ai trên cổng ${targetPort} (chưa phát hiện cookie hatch_sess).`
        );
      }

      const normalized = museCookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain:
          c.domain ||
          (String(c.name).startsWith("hatch_native_auth_") || c.name === "theme"
            ? "muse.ai"
            : ".muse.ai"),
        path: c.path || "/",
        secure: c.secure !== undefined ? Boolean(c.secure) : true,
        httpOnly: Boolean(c.httpOnly),
        sameSite: c.sameSite || "Lax",
        expires: Number(c.expires || 0),
      }));

      const finalName = accountName || (existingAcc ? existingAcc.name : "");
      const { account, isNew } = this.store.addAccount(finalName, normalized, detectedEmail, {
        accountId: existingAcc ? existingAcc.id : "",
        cdpPort: targetPort,
        proxy: effectiveProxy,
        forceNew: isAddingNewAccount,
      });
      this.store.markLive(account.id, { vm_state: vmState });

      this.log(
        `${isNew ? "Đã thêm ních mới" : "Đã cập nhật ních"} [🟢 LIVE]: ${account.name} (Cổng :${account.cdp_port || targetPort}, ${normalized.length} cookies)`
      );
      return {
        ok: true,
        isNew,
        cdp_port: account.cdp_port || targetPort,
        account: this.store.listAccounts().find((a) => a.id === account.id) || account,
        cookie_count: normalized.length,
      };
    } finally {
      this.pendingLoginPorts.delete(targetPort);
      if (cdp) {
        await cdp.close().catch(() => {});
      }
    }
  }

  /**
   * Injects account cookies into Chrome WITHOUT calling Network.clearBrowserCookies()
   * and preserving .muse.ai domain for hatch_sess / hatch_vml / hatch_gw.
   */
  async _applyAccountCookiesToCdp(cdp, cookies = []) {
    try {
      const existing = await cdp.send("Network.getCookies", {
        urls: ["https://muse.ai", "https://www.muse.ai"],
      });
      for (const ec of existing.cookies || []) {
        const cname = String(ec.name || "");
        if (
          cname.startsWith("hatch_native_auth_") ||
          cname.startsWith("__Host-hatch_")
        ) {
          continue;
        }
        if (String(ec.domain || "").includes("muse.ai")) {
          await cdp
            .send("Network.deleteCookies", {
              name: ec.name,
              domain: ec.domain,
              path: ec.path || "/",
            })
            .catch(() => {});
        }
      }
    } catch (_err) {
      // ignore
    }

    const nowSec = Date.now() / 1000;
    for (const c of cookies || []) {
      if (!c || !c.name || c.value === undefined || c.value === "") continue;
      const cname = String(c.name);
      const isHostOnly =
        cname.startsWith("hatch_native_auth_") ||
        cname.startsWith("__Host-") ||
        cname === "theme" ||
        c.domain === "muse.ai";
      const rawExp = Number(c.expires || c.expirationDate || 0);
      const expVal = rawExp > nowSec + 600 ? rawExp : nowSec + 7 * 86400;
      const cookieParam = {
        name: cname,
        value: String(c.value),
        url: "https://muse.ai/",
        path: c.path || "/",
        secure: c.secure !== undefined ? Boolean(c.secure) : true,
        httpOnly:
          c.httpOnly !== undefined
            ? Boolean(c.httpOnly)
            : ["hatch_sess", "hatch_vml", "hatch_native_auth_device"].includes(cname),
        expires: expVal,
      };
      if (!isHostOnly) {
        cookieParam.domain = ".muse.ai";
      }
      if (c.sameSite && ["Strict", "Lax", "None"].includes(String(c.sameSite))) {
        cookieParam.sameSite = String(c.sameSite);
      }
      await cdp.send("Network.setCookie", cookieParam).catch(() => {});
    }
  }

  /**
   * Opens a visible window/tab in the account's dedicated Chrome instance (cdp_port)
   * and preserves or injects the account's cookies cleanly.
   * When multiple streams run in parallel, each stream opens in its own separate Chrome window
   * with focus & visibility emulation enabled so Chrome never throttles any stream!
   */
  async _openSessionPage(account, targetUrl = MUSE_NEW_THREAD, { reuseMainTab = true } = {}) {
    const accPort = this._getPortForAccount(account);
    const isVisibleMode = Boolean(this.store.settings && this.store.settings.showChromeWindow === true);
    await this.ensureChrome(isVisibleMode, accPort);

    const { pageTarget, createdNewTab, streamSlot } = await this._withOpenTabLock(async () => {
      const usedSlots = new Set(this.usedGridSlots.values());
      let globalSlot = 0;
      while (usedSlots.has(globalSlot)) {
        globalSlot += 1;
      }
      if (this.busyTabIds.size > 0) {
        // Stagger parallel stream window launches so simultaneous uploads/sends don't collide
        await new Promise((r) => setTimeout(r, 1400));
      }

      const targets = await getTargets(this.cdpHost, accPort);
      const pageTargets = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
      const idleTargets = pageTargets.filter(
        (t) => !this.busyTabIds.has(t.id) && !this.busyTabIds.has(`${accPort}:${t.id}`)
      );

      let chosenTarget = null;
      let isNew = false;

      if (reuseMainTab && idleTargets.length > 0) {
        chosenTarget =
          idleTargets.find((t) => (t.url || "").includes("muse.ai")) || idleTargets[0];
      } else {
        const initBounds = this._getCompactGridBounds(globalSlot, isVisibleMode);
        const browserWs = await getBrowserWsUrl(this.cdpHost, accPort);
        const browserCdp = new CDPClient(browserWs);
        await browserCdp.connect();
        try {
          const createParams = { url: "about:blank" };
          if (isVisibleMode) {
            createParams.newWindow = true;
            createParams.left = initBounds.left;
            createParams.top = initBounds.top;
            createParams.width = initBounds.width;
            createParams.height = initBounds.height;
          }
          const res = await browserCdp.send("Target.createTarget", createParams);
          const targetId = res.targetId;
          isNew = true;
          await new Promise((r) => setTimeout(r, 350));
          const updatedTargets = await getTargets(this.cdpHost, accPort);
          chosenTarget = updatedTargets.find((t) => t.id === targetId) || {
            id: targetId,
            webSocketDebuggerUrl: `ws://${this.cdpHost}:${accPort}/devtools/page/${targetId}`,
          };
        } finally {
          await browserCdp.close();
        }
      }

      const targetKey = `${accPort}:${chosenTarget.id}`;
      this.busyTabIds.add(targetKey);
      this.usedGridSlots.set(targetKey, globalSlot);
      return { pageTarget: chosenTarget, createdNewTab: isNew, streamSlot: globalSlot };
    });

    const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
    // The tab/slot are already reserved above. If anything below throws, the caller
    // never gets a session to close, so release everything here and rethrow (H7).
    try {
    await cdp.connect();
    await cdp.send("Network.enable");
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    // Prevent Chrome & Muse.ai React from ever throttling or pausing background/headless tabs
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    await cdp.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
    const antiThrottleScript = `
      (() => {
        try {
          Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
          Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
          Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
          window.chrome = window.chrome || { runtime: {} };
          document.hasFocus = () => true;
        } catch (_) {}
      })()
    `;
    await cdp
      .send("Page.addScriptToEvaluateOnNewDocument", { source: antiThrottleScript })
      .catch(() => {});
    await cdp.evaluate(antiThrottleScript).catch(() => {});

    try {
      await cdp.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: this.downloadDir,
      });
    } catch (_err) {
      // ignore
    }

    if (isVisibleMode) {
      try {
        const win = await cdp.send("Browser.getWindowForTarget", { targetId: pageTarget.id });
        if (win && win.windowId) {
          await cdp
            .send("Browser.setWindowBounds", {
              windowId: win.windowId,
              bounds: { windowState: "normal" },
            })
            .catch(() => {});
          await cdp
            .send("Browser.setWindowBounds", {
              windowId: win.windowId,
              bounds: this._getCompactGridBounds(streamSlot, true),
            })
            .catch(() => {});
        }
      } catch (_err) {
        // ignore
      }
      await cdp.send("Page.bringToFront").catch(() => {});
    }

    // Check current browser cookies BEFORE touching them so we NEVER log out an active session!
    const browserCookieRes = await cdp
      .send("Network.getCookies", { urls: ["https://muse.ai", "https://www.muse.ai"] })
      .catch(() => ({ cookies: [] }));
    const browserMuseCookies = (browserCookieRes.cookies || []).filter((c) =>
      String(c.domain || "").includes("muse.ai")
    );
    const browserSess =
      (browserMuseCookies.find((c) => c.name === "hatch_sess" && c.value) || {}).value || "";
    const accountSess =
      ((account.cookies || []).find((c) => c.name === "hatch_sess" && c.value) || {}).value || "";

    let shouldInjectAccountCookies = false;

    if (!browserSess) {
      // Chrome has no hatch_sess cookie at all -> inject account cookies
      shouldInjectAccountCookies = true;
    } else if (browserSess === accountSess) {
      // Chrome is ALREADY logged into this exact account -> do NOT delete or overwrite cookies!
      this.store.updateAccountCookies(account.id, browserMuseCookies);
    } else {
      // Chrome has a different hatch_sess than account.cookies.
      const otherLiveAcc = this.store.accounts.find(
        (a) =>
          a.id !== account.id &&
          a.status === "live" &&
          ((a.cookies || []).find((c) => c.name === "hatch_sess")?.value || "") === browserSess
      );

      if (otherLiveAcc && account.status !== "die") {
        shouldInjectAccountCookies = true;
      } else {
        const curHref = String((await cdp.evaluate("location.href")) || "");
        if (!curHref.includes("muse.ai") || curHref.includes("auth.muse.ai")) {
          await cdp.send("Page.navigate", { url: MUSE_URL });
          await new Promise((r) => setTimeout(r, 1800));
        }
        const liveProbe = await cdp.evaluate(
          `
          (async () => {
            try {
              if (
                location.href.includes('auth.muse.ai') ||
                location.href.includes('aymh') ||
                location.href.includes('/oidc/') ||
                location.href.includes('/access') ||
                document.querySelector('[data-testid="native-auth-access-pane"]')
              ) {
                return { live: false, status: 401 };
              }
              const r = await fetch('https://muse.ai/api/session', { credentials: 'include' });
              if (!r.ok) return { live: false, status: r.status };
              const d = await r.json();
              return { live: Boolean(d && d.status === 'assigned'), vm_state: d?.vm_state || 'RUNNING' };
            } catch (e) {
              return { live: false, status: 0 };
            }
          })()
          `,
          true,
          6000
        );
        if (liveProbe && liveProbe.live) {
          this.store.updateAccountCookies(
            account.id,
            browserMuseCookies,
            "",
            liveProbe.vm_state || "RUNNING"
          );
          this.log(
            `[${account.name}] Đã giữ nguyên & đồng bộ phiên đăng nhập đang LIVE trực tiếp trên Chrome (:${accPort}).`
          );
        } else {
          shouldInjectAccountCookies = true;
        }
      }
    }

    if (shouldInjectAccountCookies) {
      await this._applyAccountCookiesToCdp(cdp, account.cookies || []);
      await cdp.send("Page.navigate", { url: targetUrl });
      await new Promise((r) => setTimeout(r, 900));
    } else {
      const curHref = String((await cdp.evaluate("location.href")) || "");
      if (
        createdNewTab ||
        (!curHref.includes("muse.ai/thread") && !curHref.startsWith("https://muse.ai/"))
      ) {
        await cdp.send("Page.navigate", { url: targetUrl });
        await new Promise((r) => setTimeout(r, 900));
      }
    }

    return { cdp, targetId: pageTarget.id, cdpPort: accPort, createdNewTab, streamSlot };
    } catch (err) {
      await this._closeSessionPage({ cdp, targetId: pageTarget.id, cdpPort: accPort }).catch(
        () => {}
      );
      throw err;
    }
  }

  async _closeSessionPage(session) {
    if (!session) return;
    const port = Number(session.cdpPort || this.cdpPort);
    const targetKey = `${port}:${session.targetId}`;
    if (session.targetId) {
      this.busyTabIds.delete(session.targetId);
      this.busyTabIds.delete(targetKey);
      this.usedGridSlots.delete(targetKey);
    }
    try {
      if (session.cdp) await session.cdp.close();
    } catch (_err) {
      // ignore
    }
    if (session.targetId) {
      try {
        const targets = await getTargets(this.cdpHost, port);
        const pageTargets = targets.filter((t) => t.type === "page");
        if (pageTargets.length > 1) {
          await closeTarget(this.cdpHost, port, session.targetId);
        }
      } catch (_err) {
        // ignore
      }
    }

    const busyOnPort = Array.from(this.busyTabIds).filter((id) =>
      String(id).startsWith(`${port}:`)
    ).length;
    if (busyOnPort === 0 && !this.pendingLoginPorts.has(port)) {
      setTimeout(() => {
        const stillBusyOnPort = Array.from(this.busyTabIds).filter((id) =>
          String(id).startsWith(`${port}:`)
        ).length;
        if (stillBusyOnPort === 0 && !this.pendingLoginPorts.has(port)) {
          this.closeAllChromeBrowsers({ targetPort: port }).catch(() => {});
        }
      }, 1200);
    }
    if (this.activeCount === 0 && this.busyTabIds.size === 0) {
      this._scheduleAutoCloseChrome(1200);
    }
  }

  async _waitWsReady(cdp, timeoutMs = 35000) {
    const deadline = Date.now() + timeoutMs;
    let lastState = "loading";
    let wakeTriggered = false;
    let vmVerified = false;
    let readyTicks = 0;
    const startMs = Date.now();

    while (Date.now() < deadline) {
      try {
        lastState = await cdp.evaluate(JS_HYDRATION_STATE);
        if (lastState === "ready") {
          if (!vmVerified) {
            vmVerified = true;
            wakeTriggered = true;
            await cdp
              .evaluate(
                `
                (async () => {
                  try {
                    const r1 = await fetch('https://muse.ai/api/session', { credentials: 'include' });
                    if (!r1.ok) return;
                    const d1 = await r1.json();
                    if (d1 && d1.status === 'assigned' && d1.vm_id && d1.vm_state !== 'RUNNING') {
                      await fetch('https://muse.ai/api/hatch/vm/wake', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ vm_id: d1.vm_id, retry_count: 0, connect_attempt_id: crypto.randomUUID() })
                      });
                    }
                  } catch (e) {}
                })()
                `,
                true,
                5000
              )
              .catch(() => {});
          }
          readyTicks += 1;
          if (readyTicks >= 3) {
            return { ok: true, state: "ready" };
          }
        } else {
          readyTicks = 0;
        }
        if (lastState === "logged-out") {
          // Double check via /api/session before declaring logged-out
          const sessCheck = await cdp.evaluate(
            `
            (async () => {
              try {
                const r = await fetch('https://muse.ai/api/session', { credentials: 'include' });
                if (r.status === 401 || r.status === 403) return { assigned: false, status: r.status };
                if (r.ok) {
                  const d = await r.json();
                  return { assigned: Boolean(d && d.status === 'assigned'), status: r.status };
                }
                return { assigned: false, status: r.status };
              } catch (e) {
                return { assigned: false, status: 0 };
              }
            })()
            `,
            true,
            5000
          );
          if (!sessCheck || !sessCheck.assigned) {
            return {
              ok: false,
              state: "logged-out",
              reason: "Ních DIE: Cookie đã hết hạn hoặc bị đăng xuất khỏi Muse.ai (Sign in page)",
            };
          }
        }
        // Trigger VM wake if hydrating/connecting takes > 2s
        if (!wakeTriggered && Date.now() - startMs > 2000) {
          wakeTriggered = true;
          cdp
            .evaluate(
              `
              (async () => {
                try {
                  const r1 = await fetch('https://muse.ai/api/session', { credentials: 'include' });
                  if (!r1.ok) return;
                  const d1 = await r1.json();
                  if (d1 && d1.status === 'assigned' && d1.vm_id) {
                    await fetch('https://muse.ai/api/hatch/vm/wake', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      credentials: 'include',
                      body: JSON.stringify({ vm_id: d1.vm_id, retry_count: 0, connect_attempt_id: crypto.randomUUID() })
                    });
                  }
                } catch (e) {}
              })()
              `,
              false
            )
            .catch(() => {});
        }
      } catch (_err) {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 320));
    }
    return {
      ok: false,
      state: lastState,
      reason:
        lastState === "connecting"
          ? "Máy chủ Muse.ai đang kẹt trạng thái Connecting..."
          : `Trang Muse.ai không hiện ô nhập lệnh (${lastState})`,
    };
  }

  /**
   * Pure Node.js HTTP Fast-Path for Account Session Check & 48h VM Wake (No Chrome Needed!)
   */
  async _renewAccountViaHttp(account) {
    try {
      const cookieMap = new Map();
      for (const c of account.cookies || []) {
        if (c && c.name && c.value !== undefined) {
          cookieMap.set(c.name, { ...c });
        }
      }
      const buildCookieHeader = () =>
        Array.from(cookieMap.values())
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");

      const applySetCookieHeaders = (res) => {
        const rawSetCookies =
          typeof res.headers?.getSetCookie === "function" ? res.headers.getSetCookie() : [];
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
      };

      const commonHeaders = {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        Origin: "https://muse.ai",
        Referer: "https://muse.ai/",
      };

      const r1 = await fetch("https://muse.ai/api/session", {
        method: "GET",
        headers: {
          ...commonHeaders,
          Cookie: buildCookieHeader(),
        },
      });
      applySetCookieHeaders(r1);

      if (r1.status === 401) {
        return { ok: false, fatalDie: true, reason: "Ních DIE: Phiên đăng nhập hết hạn (/api/session HTTP 401)" };
      }
      if (!r1.ok) {
        return { ok: false, fatalDie: false };
      }

      const d1 = await r1.json().catch(() => null);
      if (!d1 || d1.status !== "assigned") {
        return { ok: false, fatalDie: false };
      }

      let vmState = d1.vm_state || "RUNNING";
      const email = d1.email || d1.user?.email || d1.user?.username || "";

      if (d1.vm_id && vmState !== "DISABLED") {
        const r2 = await fetch("https://muse.ai/api/hatch/vm/wake", {
          method: "POST",
          headers: {
            ...commonHeaders,
            "Content-Type": "application/json",
            Cookie: buildCookieHeader(),
          },
          body: JSON.stringify({
            vm_id: d1.vm_id,
            retry_count: 0,
            connect_attempt_id: crypto.randomUUID(),
          }),
        }).catch(() => null);
        if (r2) {
          applySetCookieHeaders(r2);
          if (r2.ok) {
            vmState = "RUNNING";
          }
        }
      }

      const mergedCookies = Array.from(cookieMap.values());
      this.store.updateAccountCookies(account.id, mergedCookies, email, vmState);
      this.store.markLive(account.id, { vm_state: vmState });

      const updated = this.store.getAccount(account.id);
      const now = Date.now() / 1000;
      const exp = Number(updated?.cookie_expires || 0);
      const expiresInHours = exp > 0 ? Math.round(((exp - now) / 3600) * 10) / 10 : 48;

      this.log(
        `[🟢 LIVE · HTTP Request] Ních [${account.name}] hoạt động tốt (Không cần mở Chrome)! VM: ${vmState}, hạn Cookie: ${expiresInHours}h`
      );
      return {
        ok: true,
        live: true,
        status: "live",
        mode: "http",
        vm_state: vmState,
        expires_in_hours: expiresInHours,
        cookie_count: updated?.cookies?.length || mergedCookies.length,
      };
    } catch (_err) {
      return { ok: false, fatalDie: false };
    }
  }

  /**
   * 100% Pure HTTP + Noise-XX Gateway LIVE / DIE verification + 48h Cookie renewal + VM Wake (NO Chrome CDP!)
   */
  async renewAccount(account) {
    const hasSess = (account.cookies || []).some((c) => c.name === "hatch_sess" && c.value);
    if (!hasSess) {
      const reason = "Ních DIE: Thiếu cookie cốt lõi hatch_sess";
      this.store.markDie(account.id, reason);
      this.log(`[🔴 DIE] Ních [${account.name}]: ${reason}`, "warn");
      return { ok: false, live: false, status: "die", error: reason };
    }

    // 1. Try 100% Pure HTTP Request fast-path first
    const httpCheck = await this._renewAccountViaHttp(account);
    if (httpCheck.ok) {
      return httpCheck;
    }
    if (httpCheck.fatalDie) {
      this.store.markDie(account.id, httpCheck.reason);
      this.log(`[🔴 DIE] Ních [${account.name}]: ${httpCheck.reason}`, "warn");
      return { ok: false, live: false, status: "die", error: httpCheck.reason };
    }

    // 2. Fallback to Direct MuseGateway Auth & VM Wake (still 100% HTTP/WebSocket, zero Chrome CDP!)
    const gw = new MuseGateway(account, { store: this.store });
    try {
      const authInfo = await gw.authenticateAndWakeVm();
      const vmState = authInfo.vmState || "RUNNING";
      this.store.markLive(account.id, { vm_state: vmState });

      const updated = this.store.getAccount(account.id);
      const now = Date.now() / 1000;
      const exp = Number(updated?.cookie_expires || 0);
      const expiresInHours = exp > 0 ? Math.round(((exp - now) / 3600) * 10) / 10 : 48;

      this.log(
        `[🟢 LIVE · Gateway] Ních [${account.name}] hoạt động tốt (VM: ${authInfo.vmId}, ${vmState}, hạn Cookie: ${expiresInHours}h)`
      );
      return {
        ok: true,
        live: true,
        status: "live",
        mode: "gateway",
        vm_id: authInfo.vmId,
        vm_state: vmState,
        expires_in_hours: expiresInHours,
        cookie_count: updated?.cookies?.length || 0,
      };
    } catch (err) {
      const reason = `Ních DIE / Lỗi kết nối Gateway: ${err.message}`;
      if (err.fatalDie) {
        this.store.markDie(account.id, reason);
      } else {
        this.store.markFail(account.id, reason);
      }
      this.log(`[🔴 DIE] Ních [${account.name}]: ${reason}`, "error");
      return { ok: false, live: false, status: "die", error: reason };
    } finally {
      gw.close();
    }
  }

  async renewAllAccounts() {
    if (this.keepaliveRunning) {
      return { ok: false, message: "Đang chạy tiến trình kiểm tra & bảo hoạt" };
    }
    this.keepaliveRunning = true;
    const results = [];
    try {
      const ordered = [...this.store.accounts].filter((a) => a.status !== "disabled");
      for (const acc of ordered) {
        const r = await this.renewAccount(acc);
        results.push({ id: acc.id, name: acc.name, ...r });
      }
      const liveCount = results.filter((r) => r.ok).length;
      const dieCount = results.length - liveCount;
      return { ok: true, liveCount, dieCount, results };
    } finally {
      this.keepaliveRunning = false;
    }
  }

  /**
   * Checks account status & VM health directly via Noise-XX Gateway (NO Chrome CDP!)
   */
  async checkAccountQuota(account) {
    const gw = new MuseGateway(account, { store: this.store });
    try {
      await gw.connect(20000);
      const [identity, health] = await Promise.all([
        gw.call("identity").catch(() => null),
        gw.call("vm.health").catch(() => null),
      ]);
      const quota = {
        used_percent: "0%",
        plan: identity?.plan || health?.plan || "Muse VM Active",
        vm_id: gw.vmId,
        checked_at: Math.floor(Date.now() / 1000),
      };
      this.store.updateAccountQuota(account.id, quota);
      this.store.markLive(account.id, { vm_state: "RUNNING" });
      return { ok: true, quota };
    } catch (err) {
      if (err.fatalDie) {
        this.store.markDie(account.id, err.message);
      }
      return { ok: false, error: err.message };
    } finally {
      gw.close();
    }
  }

  startKeepaliveLoop() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    const intervalMin = Number(this.store.settings.keepaliveIntervalMinutes || 360);
    const ms = Math.max(15, intervalMin) * 60 * 1000;
    this.keepaliveTimer = setInterval(() => {
      if (this.store.settings.autoKeepalive !== false && this.store.accounts.length > 0) {
        this.renewAllAccounts().catch((err) => {
          this.log(`Lỗi auto-keepalive: ${err.message}`, "warn");
        });
      }
    }, ms);
  }

  /**
   * Exact port of engine.py _send():
   * Scrolls textarea into view, clicks center via CDP mouse event, sets value via React 18 prototype setter,
   * and clicks Send button (or presses Enter).
   */
  async _sendPromptToMuse(cdp, prompt) {
    // Muse drops the composer for a few seconds while it reloads, reconnects or shows a notice;
    // wait for it instead of failing the whole render on the first look.
    const hasInputJs = "Boolean(document.querySelector('textarea'))";
    if (!(await cdp.evaluate(hasInputJs))) {
      const ready = await this._waitWsReady(cdp, PROMPT_INPUT_WAIT_MS);
      if (!(await cdp.evaluate(hasInputJs))) {
        const page = (await cdp.evaluate(JS_PAGE_SNAPSHOT).catch(() => null)) || {};
        throw new Error(
          `Không tìm thấy ô nhập lệnh (textarea) trên trang Muse.ai sau ${PROMPT_INPUT_WAIT_MS / 1000}s ` +
            `(trạng thái: ${ready.state}, url: ${page.url || "?"}, cuối trang: "${page.tail || ""}")`
        );
      }
    }

    await cdp.evaluate(`
      (() => {
        const ta = document.querySelector('textarea');
        if (ta) {
          ta.scrollIntoView({ block: 'center', inline: 'nearest' });
          ta.focus();
        }
      })()
    `);
    await new Promise((r) => setTimeout(r, 120));

    const rect = await cdp.evaluate(`
      (() => {
        const t = document.querySelector('textarea');
        if (!t) return null;
        const r = t.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()
    `);

    if (!rect) {
      throw new Error("Không tìm thấy ô nhập lệnh (textarea) trên trang Muse.ai");
    }

    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", {
        type,
        x: rect.x,
        y: rect.y,
        button: "left",
        clickCount: 1,
      });
    }
    await new Promise((r) => setTimeout(r, 120));

    const setterScript = `
      (() => {
        const text = ${JSON.stringify(prompt)};
        const ta = document.querySelector('textarea');
        if (!ta) return 0;
        ta.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(ta, text);
        else ta.value = text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        return (ta.value || '').length;
      })()
    `;

    let valLen = await cdp.evaluate(setterScript);
    if (!valLen) {
      await cdp.send("Input.insertText", { text: prompt });
      valLen = await cdp.evaluate(setterScript);
    }

    const clickSendBtnJs = `
      (() => {
        const b = Array.from(document.querySelectorAll('button, [role=button]'))
          .filter(x => x.offsetParent !== null)
          .find(x =>
            /发送|send/i.test(x.getAttribute('aria-label') || '') ||
            /发送|send/i.test(x.getAttribute('data-testid') || '') ||
            /send/i.test(x.innerText || '')
          );
        if (!b) return 'no-button';
        if (b.disabled) return 'disabled';
        b.click();
        return 'clicked';
      })()
    `;

    let clicked = "no-button";
    const deadline = Date.now() + 4500;
    while (Date.now() < deadline) {
      const res = await cdp.evaluate(clickSendBtnJs);
      if (res === "clicked") {
        clicked = "clicked";
        break;
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    if (clicked !== "clicked") {
      for (const type of ["keyDown", "char", "keyUp"]) {
        const params = {
          type,
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        };
        if (type === "char") {
          params.text = "\r";
          params.unmodifiedText = "\r";
        }
        await cdp.send("Input.dispatchKeyEvent", params);
      }
      await new Promise((r) => setTimeout(r, 600));
      clicked = "enter-sent";
    }

    // Confirm that the textarea actually cleared (if not, click Send again once upload finishes)
    const confirmDeadline = Date.now() + 3500;
    while (Date.now() < confirmDeadline) {
      await new Promise((r) => setTimeout(r, 350));
      const remainingLen = await cdp.evaluate(`
        (() => {
          const ta = document.querySelector('textarea');
          return ta ? (ta.value || '').trim().length : 0;
        })()
      `);
      if (!remainingLen) break;
      await cdp.evaluate(clickSendBtnJs).catch(() => {});
    }

    await new Promise((r) => setTimeout(r, 350));
    return clicked;
  }

  _normalizeProductVideoTitle(rawExtracted = "", fallbackFileBase = "") {
    let extracted = String(rawExtracted || "")
      .replace(/^[\s"'«»“”‘’\[\]]+|[\s"'«»“”‘’\[\]]+$/g, "")
      .replace(
        /^(?:Star\s*Shop|Yêu\s*thích\+?|\bMall\b|Shopee\s*Mall|TikTok\s*Shop|LazMall|Official\s*Store)\s*[-:·|]?\s*/i,
        ""
      )
      .trim();

    if (/^(?:none|null|n\/a|không|không\s*có|no\s*title|unknown|-+)$/i.test(extracted)) {
      extracted = "";
    }

    const fallback = String(fallbackFileBase || "").trim();
    const chosen = extracted || fallback;
    if (!chosen) return "";

    return chosen
      .replace(/[\r\n\t]+/g, " ")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/^[.\s]+|[.\s]+$/g, "")
      .slice(0, 180)
      .trim();
  }

  // Streams an http(s) media URL straight to disk with the tab's own cookies, so a 4K video is never held in
  // memory as base64. Returns null (the caller then uses the in-page path) for blob:/data: sources or any
  // response that isn't media, e.g. a login page.
  async _downloadMediaDirect(cdp, src, expect, base) {
    if (!/^https?:\/\//i.test(src)) return null;
    let fullPath = "";
    try {
      const { cookies = [] } = (await cdp.send("Network.getCookies", { urls: [src] })) || {};
      const res = await fetch(src, {
        headers: cookies.length ? { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") } : {},
        signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS),
      });
      const mime = String(res.headers.get("content-type") || "").toLowerCase();
      if (!res.ok || !res.body || !/^(video|image)\/|octet-stream/.test(mime)) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status} ${mime || "không có content-type"}`);
      }
      const filename = reserveUniqueFile(this.store.mediaDir, base, mediaExtFor(mime, expect));
      fullPath = path.join(this.store.mediaDir, filename);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(fullPath));
      const size = fs.statSync(fullPath).size;
      if (!size) throw new Error("file rỗng");
      // Catch a cut-off download: if the server told us the length, it must match.
      const expectedLen = Number(res.headers.get("content-length") || 0);
      if (expectedLen > 0 && size < expectedLen) {
        throw new Error(`file cụt: ${size}/${expectedLen} bytes`);
      }
      return { filename, mime, size };
    } catch (err) {
      if (fullPath) fs.rmSync(fullPath, { force: true });
      this.log(`Tải ${expect} trực tiếp thất bại (${err.message}), chuyển sang tải qua trình duyệt...`, "warn");
      return null;
    }
  }

  async _saveMediaFromAttachment(cdp, selectedSrc, expect = "video", preferredTitle = "") {
    const prefix = expect === "video" ? "vid" : "img";
    const cleanCustom = String(preferredTitle || "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/^[.\s]+|[.\s]+$/g, "")
      .slice(0, 180)
      .trim();
    const base = cleanCustom || `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    // Videos are only ever served by URL; images keep base64 for the /v1 b64_json response format.
    const result = (filename, mime, size, b64 = "") => {
      const fullPath = path.join(this.store.mediaDir, filename);
      return {
        filename,
        fullPath,
        url: `/v1/media/${encodeURIComponent(filename)}`,
        mime,
        size,
        ...(expect === "image" && { b64: b64 || fs.readFileSync(fullPath).toString("base64") }),
      };
    };

    const direct = await this._downloadMediaDirect(cdp, selectedSrc, expect, base);
    if (direct) return result(direct.filename, direct.mime, direct.size);

    let lastErr = "unknown";
    const chunkSize = 2 * 1024 * 1024; // 2MB per CDP chunk to avoid WebSocket frame limits

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const storeKey = `media_${Date.now()}_${attempt}`;
      try {
        const meta = await cdp.evaluate(
          buildPrepareMediaChunksJs(selectedSrc, storeKey),
          true,
          120000
        );
        if (meta && meta.ok && meta.b64Len > 0) {
          const chunks = [];
          for (let offset = 0; offset < meta.b64Len; offset += chunkSize) {
            const part = await cdp.evaluate(
              `window.__embongMediaStore && window.__embongMediaStore[${JSON.stringify(
                storeKey
              )}] ? window.__embongMediaStore[${JSON.stringify(storeKey)}].slice(${offset}, ${
                offset + chunkSize
              }) : ""`,
              false,
              30000
            );
            chunks.push(part || "");
          }
          await cdp
            .evaluate(
              `if (window.__embongMediaStore) delete window.__embongMediaStore[${JSON.stringify(
                storeKey
              )}];`
            )
            .catch(() => {});

          const fullB64 = chunks.join("");
          // A chunk comes back "" when the page navigated and the store key vanished mid-read.
          // Verify we got every expected base64 char, then that the bytes form a complete file,
          // so a truncated read retries this attempt instead of being saved as success (H8).
          if (fullB64.length !== meta.b64Len) {
            throw new Error(`dữ liệu cụt: ${fullB64.length}/${meta.b64Len} ký tự base64`);
          }
          const buf = Buffer.from(fullB64, "base64");
          if (!buf.length) throw new Error("file rỗng");
          if (expect === "video" && isUnfinishedMp4(buf)) {
            throw new Error("video MP4 chưa hoàn tất (thiếu moov hoặc bị cụt)");
          }
          const filename = reserveUniqueFile(this.store.mediaDir, base, mediaExtFor(meta.mime, expect));
          fs.writeFileSync(path.join(this.store.mediaDir, filename), buf);
          return result(filename, meta.mime, buf.length, fullB64);
        }
        lastErr = meta?.err || "extract-failed";
      } catch (err) {
        lastErr = err.message || "extract-exception";
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`Không tải được file ${expect} từ Muse.ai: ${lastErr}`);
  }

  /**
   * Core Media Generation (Video or Image) — 100% Direct HTTP + Noise-XX Gateway (NO Chrome CDP!)
   * Supports >10s Video Multi-Clip Generation & Automatic FFmpeg Stitching Command on Muse VM
   */
  async _generateMedia({
    expect = "video",
    prompt,
    model,
    aspectRatio = "9:16",
    duration = "20s",
    quality = "4K",
    referenceImages = [],
    accountId = "",
    rowId = "",
    outputName = "",
    onProgress = null,
  }) {
    const account = accountId
      ? this.store.getAccount(accountId) || this.store.pickAccount()
      : this.store.pickAccount();
    if (!account) {
      throw new Error(
        "Chưa có ních Muse.ai nào đang LIVE. Vui lòng thêm hoặc kiểm tra ních ở mục [Ních Muse.ai]."
      );
    }

    const targetDurationSec =
      expect === "video"
        ? Math.max(5, parseInt(String(duration || "20s").replace(/[^\d]/g, ""), 10) || 20)
        : 0;
    const isLongVideo = expect === "video" && targetDurationSec > 10;
    const clipCount10s = isLongVideo ? Math.max(2, Math.ceil(targetDurationSec / 10)) : 1;
    const clipCount5s = isLongVideo ? Math.max(2, Math.ceil(targetDurationSec / 5)) : 1;

    const validRefImgs = (Array.isArray(referenceImages) ? referenceImages : []).filter(
      (img) => img && img.b64
    );
    const hasCharacterRef = validRefImgs.some((img) => img.role === "character");
    const hasProductRef = validRefImgs.some((img) => img.role === "product");
    const productRefImg =
      validRefImgs.find((img) => img.role === "product") || validRefImgs[0] || null;
    const rawProductImgName = String(productRefImg?.name || "").trim();
    const fallbackProductFileBase = rawProductImgName
      ? path.parse(rawProductImgName).name.trim()
      : "";

    let cleanPrompt = String(prompt || "").trim();
    if (!hasProductRef && validRefImgs.length === 0) {
      cleanPrompt = cleanPrompt
        .replace(/,?\s*giữ nguyên[^,.]*đính kèm/gi, ", với các kiện hàng và hộp sản phẩm thực tế")
        .replace(/sản phẩm mẫu đính kèm/gi, "sản phẩm thực tế")
        .replace(/ảnh đính kèm/gi, "bối cảnh thực tế");
    }
    // Automatically adapt child-in-distress / medical-distress terms that trigger Meta's safety refusal
    cleanPrompt = cleanPrompt
      .replace(/10岁男孩/g, "22岁年轻男子")
      .replace(/6岁([^，,。]*?)女孩/g, "22岁$1年轻女子")
      .replace(/4岁男孩/g, "年轻男子")
      .replace(/1岁[，,\s]*极度瘦弱/g, "成年角色，神情疲惫")
      .replace(/患儿/g, "年轻角色")
      .replace(/婴儿/g, "成年亲属")
      .replace(/鼻孔[^，,。]*?流血/g, "神情专注疲惫")
      .replace(/极度苍白[，,]\s*眼窝深陷[，,]\s*双颊因塞满未吞咽的食物而严重鼓起/g, "神情严肃紧张")
      .replace(/身上贴着监护仪电极片/g, "站在明亮的房间里");

    const specs = [];
    if (aspectRatio) specs.push(`aspect ratio ${aspectRatio}`);
    if (expect === "video" && duration) specs.push(`total duration ${targetDurationSec}s`);
    const qUpper = String(quality || "4K").toUpperCase();
    if (qUpper === "4K") specs.push("resolution 4K Ultra HD 2160p, photorealistic, high detail");
    else if (qUpper === "2K") specs.push("resolution 2K QHD 1440p, sharp detail");
    else if (qUpper === "1K") specs.push("resolution 1K Full HD 1080p");

    if (hasCharacterRef) {
      specs.push(
        "strictly preserve the exact face, facial features, hairstyle, outfit, and identity of the attached character reference image"
      );
    }
    if (hasProductRef) {
      specs.push(
        "strictly preserve the exact appearance, logo, packaging, and details of the attached product reference image"
      );
    }

    const task = this.store.createTask(expect, cleanPrompt, model, account.id, {
      row_id: rowId || "",
      aspect_ratio: aspectRatio,
      duration: expect === "video" ? `${targetDurationSec}s` : "",
      quality: qUpper,
    });
    const taskTag = String(task.id || "")
      .replace(/[^a-z0-9]/gi, "")
      .slice(-6)
      .toLowerCase() || crypto.randomBytes(3).toString("hex");
    const targetVmVideoName = `final_${taskTag}_${targetDurationSec}s.mp4`;

    const noRefNotice =
      validRefImgs.length === 0
        ? `\n- Không cần chờ ảnh đính kèm: Hãy tự thiết kế sản phẩm/nhân vật phù hợp với mô tả và thực thi tạo file ngay lập tức, TUYỆT ĐỐI KHÔNG dừng lại hỏi xin ảnh từ người dùng.`
        : "";

    const safetyAutoAdaptNotice =
      `\n- TỰ ĐỘNG ĐIỀU CHỈNH AN TOÀN (AUTO SAFETY ADAPTATION): Nếu trong kịch bản có bất kỳ chi tiết nào nhạy cảm (như trẻ em, cấp cứu bệnh viện, thương tích, nguy hiểm), bạn ĐƯỢC ỦY QUYỀN 100% tự động đổi sang nhân vật người trưởng thành và bối cảnh điện ảnh an toàn, bình tĩnh để tạo ảnh và xuất file MP4 ngay lập tức, TUYỆT ĐỐI KHÔNG dừng lại từ chối hay hỏi xin phép người dùng!`;

    const videoExecutionPolicy =
      expect === "video"
        ? `\n\n[CHÍNH SÁCH THỰC THI TẠO VIDEO AI THẬT BẮT BUỘC / MANDATORY NATIVE AI VIDEO POLICY]:${noRefNotice}${safetyAutoAdaptNotice}\n` +
          `- BẮT BUỘC gọi trực tiếp công cụ tạo video AI thật (media.generate_video) cho yêu cầu này. TUYỆT ĐỐI KHÔNG dùng generate_image + ffmpeg zoompan tạo video từ ảnh tĩnh!\n` +
          `- Nếu tổng thời lượng yêu cầu > 10s (${targetDurationSec}s), hãy gọi media.generate_video tạo đủ ${clipCount10s} đoạn video AI thật nối tiếp nhau, sau đó ghép các đoạn video AI thật đó bằng ffmpeg thành 1 file MP4 duy nhất dài ${targetDurationSec}s tại /workspace/imagine_media/${targetVmVideoName} và hiển thị (present) ra khung chat.`
        : `${noRefNotice}${safetyAutoAdaptNotice}`;

    const productTitleInstruction = productRefImg
      ? `\n\n[YÊU CẦU BẮT BUỘC TRÍCH XUẤT TÊN SẢN PHẨM TRONG ẢNH ĐỂ ĐẶT TÊN FILE VIDEO / MANDATORY PRODUCT TITLE EXTRACTION]:\n` +
        `- Hãy đọc kỹ bức ảnh sản phẩm đính kèm. Nếu trong ảnh có dòng chữ Tên/Tiêu đề sản phẩm (ví dụ ảnh chụp màn hình TikTok Shop / Shopee có dòng chữ tiêu đề như "DKHOUSE Nồi Điện 1.8L Đa Năng, Nồi Cơm, Nồi Áp Suất Nấu Các Món, Tặng Vỉ Hấp" — lưu ý bỏ qua các nhãn phụ đứng đầu như "Star Shop", "Mall", "Yêu thích", giá tiền hay nút mua hàng), bạn BẮT BUỘC phải in nguyên văn 100% tên sản phẩm đó ở dòng đầu tiên của câu trả lời theo đúng cú pháp:\n` +
        `[[PRODUCT_TITLE: tên sản phẩm chính xác 100% như trong ảnh]]\n` +
        `(Nếu ảnh chỉ chụp sản phẩm mà hoàn toàn không có chữ tiêu đề sản phẩm nào thì in [[PRODUCT_TITLE: NONE]]).`
      : "";

    // Optional user-defined prompt format from Settings. When set it replaces the built-in
    // wrapper; the mandatory execution policy + product-title rules are still appended so
    // generation keeps working regardless of how the user worded the template.
    const customPromptTpl =
      expect === "video"
        ? String((this.store.settings && this.store.settings.promptTemplateVideo) || "").trim()
        : String((this.store.settings && this.store.settings.promptTemplateImage) || "").trim();
    const promptTplVars = {
      prompt: cleanPrompt,
      duration: targetDurationSec,
      ratio: aspectRatio,
      quality: qUpper,
      output: targetVmVideoName,
      clips: clipCount10s,
      specs: specs.join(", "),
    };

    let finalPrompt = cleanPrompt;
    if (customPromptTpl) {
      finalPrompt =
        applyPromptTemplate(customPromptTpl, promptTplVars) +
        videoExecutionPolicy +
        productTitleInstruction;
    } else if (expect === "video") {
      if (isLongVideo) {
        finalPrompt =
          `Please create and present a complete ${targetDurationSec}-second MP4 video (${specs.join(", ")}) for this scene: ${cleanPrompt}\n\n` +
          `[YÊU CẦU BẮT BUỘC VỀ ĐỘ DÀI ${targetDurationSec} GIÂY & LỆNH GHÉP VIDEO HOÀN CHỈNH / MANDATORY MULTI-CLIP & FFMPEG STITCHING]:\n` +
          `1. Chia kịch bản thành ${clipCount10s} phân cảnh nối tiếp nhau mượt mà (tổng cộng ${targetDurationSec} giây), giữ đồng nhất ${hasCharacterRef ? "khuôn mặt & trang phục nhân vật mẫu đính kèm, " : ""}bối cảnh${hasProductRef ? " và giữ nguyên chính xác sản phẩm mẫu đính kèm" : ""}.\n` +
          `2. Xuất ra 1 file video MP4 hoàn chỉnh duy nhất dài ${targetDurationSec} giây tại /workspace/imagine_media/${targetVmVideoName} và hiển thị (present) file video MP4 hoàn chỉnh đó ra khung chat!${videoExecutionPolicy}${productTitleInstruction}`;
      } else {
        finalPrompt = `Please generate and present a ${targetDurationSec}-second MP4 video (${specs.join(", ") || "aspect ratio 9:16"}) saved to /workspace/imagine_media/${targetVmVideoName}: ${cleanPrompt}${videoExecutionPolicy}${productTitleInstruction}`;
      }
    } else {
      finalPrompt = `Please generate and present an image (${specs.join(", ") || "high quality"}): ${cleanPrompt}${videoExecutionPolicy}${productTitleInstruction}`;
    }

    const reportProgress = (pct, text) => {
      this.store.updateTaskProgress(task.id, pct, text);
      if (typeof onProgress === "function") {
        try {
          onProgress(pct, text);
        } catch (_err) {
          // ignore
        }
      }
    };

    // Construct the gateway BEFORE bumping activeCount: if the constructor throws,
    // we're still outside the try/finally, so a premature increment would leak forever.
    const gw = new MuseGateway(account, { store: this.store });
    this.activeCount += 1;
    const runner = {
      taskId: task.id,
      rowId: rowId || "",
      accountId: account.id,
      accountName: account.name,
      gw,
      sessionId: "",
      cancelled: false,
      cancelReason: "",
    };
    this.activeRunners.set(task.id, runner);

    const checkCancelled = () => {
      if (runner.cancelled) {
        const cancelErr = new Error(runner.cancelReason || "Đã dừng bởi người dùng");
        cancelErr.cancelled = true;
        throw cancelErr;
      }
    };

    const isMatchingMediaKey = (str) => {
      const s = String(str || "").toLowerCase();
      if (expect === "video") {
        return /\.(mp4|webm|mov)(\?|$)/i.test(s);
      }
      return /\.(png|jpe?g|webp)(\?|$)/i.test(s);
    };

    try {
      checkCancelled();
      const proxyNote = gw.proxy ? ` · Proxy ${gw.proxy.label}` : "";
      reportProgress(
        10,
        `Đang xác thực HTTP & kết nối cổng Noise-XX Gateway${proxyNote} (Không dùng CDP)...`
      );
      this.log(
        `[${account.name}] [HTTP + Noise-XX Gateway${proxyNote}] Bắt đầu tạo ${expect.toUpperCase()} (${aspectRatio}, ${
          expect === "video" ? `${targetDurationSec}s${isLongVideo ? " [Ghép đa cảnh]" : ""}, ` : ""
        }${qUpper}): "${cleanPrompt.slice(0, 60)}..."`
      );

      await gw.connect(25000);
      checkCancelled();
      reportProgress(20, `Đã kết nối máy chủ Muse VM (${gw.vmId}) qua giao thức Noise-XX!`);

      if (expect === "video") {
        await gw.cleanStaleVideoRefusalFromMemory().catch(() => false);
      }

      const sessionId = await gw.startSession(cleanPrompt.slice(0, 48));
      runner.sessionId = sessionId || "";
      checkCancelled();

      // Upload reference images directly to the VM workspace via fs.write
      const uploadedPaths = [];
      if (validRefImgs.length > 0) {
        reportProgress(
          28,
          `Đang tải ${validRefImgs.length} ảnh tham chiếu trực tiếp lên Muse VM (fs.write)...`
        );
        for (let i = 0; i < validRefImgs.length; i += 1) {
          const img = validRefImgs[i];
          const roleTag = img.role === "character" ? "character" : img.role === "product" ? "product" : "ref";
          const fileName = img.name || `reference_${roleTag}_${i + 1}.png`;
          const up = await gw.uploadReferenceFile(fileName, img.b64, img.mime || "image/png");
          if (up && up.path) {
            uploadedPaths.push({ role: roleTag, path: up.path, name: fileName });
          }
        }
        if (uploadedPaths.length > 0) {
          const refLines = uploadedPaths
            .map((u) => `- ${u.role.toUpperCase()} reference image in workspace: ${u.path}`)
            .join("\n");
          finalPrompt += `\n\n[ATTACHED REFERENCE IMAGES IN WORKSPACE]:\n${refLines}\nPlease inspect and use the reference image file(s) above directly from your workspace.`;
        }
      }

      // Snapshot baseline history & files on the VM so only newly created media is picked up
      const baselineMsgIds = new Set();
      const baselineMediaKeys = new Set();
      const ownedTurnIds = new Set();
      const taskSendStartMs = Date.now();
      let minTaskOccurredAtMs = taskSendStartMs - 1000;

      // Baseline must succeed: if it silently returned [], every pre-existing VM file
      // would look "new" and the job could pick up stale media. Let a failure abort (H9).
      const initHist = await gw.getHistory({ sessionId, limit: 30 });
      for (const ev of initHist) {
        if (ev?.message_id) baselineMsgIds.add(ev.message_id);
        const info = inspectHistoryEvent(ev);
        if (info.occurredAtMs > minTaskOccurredAtMs) {
          minTaskOccurredAtMs = info.occurredAtMs;
        }
        for (const r of info.mediaRefs) {
          baselineMediaKeys.add(`${r.url || ""}|${r.path || ""}|${r.id || ""}`);
        }
      }
      const initFiles = await gw.listGeneratedFiles();
      for (const f of initFiles) {
        baselineMediaKeys.add(`${f.url || ""}|${f.path || ""}|${f.id || ""}|${f.mtimeMs || 0}`);
        baselineMediaKeys.add(`${f.url || ""}|${f.path || ""}|${f.id || ""}`);
      }

      const sendTrackedMessage = async (msgText) => {
        const res = await gw.sendChatMessage(msgText, { sessionId });
        if (res?.clientMessageId) ownedTurnIds.add(String(res.clientMessageId));
        if (res?.submissionId) ownedTurnIds.add(String(res.submissionId));
        for (const ev of res?.events || []) {
          const mid = ev?.message_id || ev?.payload?.message_id || ev?.id || "";
          const rto = ev?.reply_to_message_id || ev?.payload?.reply_to_message_id || "";
          if (mid) ownedTurnIds.add(String(mid));
          if (rto) ownedTurnIds.add(String(rto));
        }
        return res;
      };

      checkCancelled();
      reportProgress(
        35,
        isLongVideo
          ? `Đang gửi lệnh tạo & ghép Video ${targetDurationSec}s qua cổng Gateway...`
          : `Đang gửi lệnh tạo ${expect === "video" ? "Video" : "Ảnh"} trực tiếp qua cổng Gateway...`
      );
      await sendTrackedMessage(finalPrompt);
      checkCancelled();

      this.log(
        `[${account.name}] [Gateway VM ${gw.vmId} · Session ${(sessionId || "default").slice(0, 8)} · Tag ${taskTag}] Đã gửi lệnh trực tiếp qua WebSocket Noise-XX${
          isLongVideo ? ` (Yêu cầu tạo & xuất video ${targetDurationSec}s)` : ""
        }, đang chờ render...`
      );

      const baseTimeoutSec =
        expect === "video"
          ? Number(this.store.settings.videoTimeout || 600)
          : Number(this.store.settings.genTimeout || 240);
      const multiStreamExtraSec = Math.max(0, this.activeCount - 1) * 300;
      const timeoutSec =
        (isLongVideo ? Math.max(baseTimeoutSec, targetDurationSec * 35, 900) : baseTimeoutSec) +
        multiStreamExtraSec;
      const deadline = Date.now() + timeoutSec * 1000;
      const tStart = Date.now();

      let matchedMedia = null;
      let extractedProductTitle = "";
      let storyboardCmdCount = 0;
      let stitchCmdCount = 0;
      const handledAssistantTurnIds = new Set();
      const preStitchMediaKeys = new Set();
      let lastSeenAssistantText = "";
      let consecutivePollFailures = 0;

      while (Date.now() < deadline) {
        checkCancelled();
        const pollSleepMs = Math.min(
          MAX_POLL_MS,
          BASE_POLL_MS + Math.max(0, this.activeCount - 1) * POLL_MS_PER_EXTRA_JOB
        );
        await new Promise((r) => setTimeout(r, pollSleepMs));
        checkCancelled();
        const elapsedSec = Math.round((Date.now() - tStart) / 1000);
        const progPct = Math.min(92, Math.round(36 + elapsedSec * 0.45));

        let events;
        try {
          events = await gw.getHistory({ sessionId, limit: 40 });
          consecutivePollFailures = 0;
        } catch (pollErr) {
          consecutivePollFailures += 1;
          if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            throw new Error(`Mất kết nối Gateway khi theo dõi tiến trình: ${pollErr.message}`);
          }
          continue;
        }
        checkCancelled();
        const newMediaCandidates = [];
        const assistantReplies = [];

        for (const ev of events) {
          if (ev?.message_id && baselineMsgIds.has(ev.message_id)) continue;
          const info = inspectHistoryEvent(ev);
          if (info.occurredAtMs > 0 && info.occurredAtMs < minTaskOccurredAtMs) continue;
          if (sessionId && info.sessionId && info.sessionId !== sessionId) continue;

          if (info.eventName === "message.user" || ev?.role === "user") {
            if (info.clientMessageId && ownedTurnIds.has(info.clientMessageId) && info.messageId) {
              ownedTurnIds.add(String(info.messageId));
            }
            continue;
          }

          // When multiple jobs run concurrently on the same VM without distinct sessionIds,
          // ignore events explicitly replying to a different job's turn.
          if (
            this.activeCount > 1 &&
            !sessionId &&
            info.replyTo &&
            ownedTurnIds.size > 0 &&
            !ownedTurnIds.has(info.replyTo)
          ) {
            continue;
          }

          if (info.text) {
            lastSeenAssistantText = info.text;
            const m = info.text.match(/\[\[?\s*PRODUCT_TITLE\s*:\s*([^\]\n]+?)\s*\]?\]/i);
            if (m && m[1] && !extractedProductTitle) {
              extractedProductTitle = m[1].trim();
            }
            if (/额度不足|积分不足|out of credits|达到上限|token limit/i.test(info.text)) {
              throw new Error("Ních Muse.ai đã hết hạn mức (Out of credits / Token limit)");
            }
            if (
              expect === "video" &&
              /(?:failed with a 403|403 Forbidden|not available for this account in its country or region|region-blocked|chặn 403|không khả dụng cho tài khoản này ở quốc gia)/i.test(
                info.text
              )
            ) {
              throw new Error(
                `Ních Muse.ai [${account.name}] đang bị Meta chặn tạo Video AI theo vùng/quốc gia (HTTP 403 Region Restricted: "Video generation is not available for this account in its country or region"). Vui lòng thêm ních Muse.ai vùng Mỹ (US) có mở khóa tạo Video!`
              );
            }
          }

          if (info.eventName === "message.assistant" && info.messageKind !== "commentary") {
            assistantReplies.push(info);
          }

          for (const ref of info.mediaRefs) {
            const key = `${ref.url || ""}|${ref.path || ""}|${ref.id || ""}`;
            if (baselineMediaKeys.has(key)) continue;
            if (isForeignFinalVideo(ref.path || ref.url, taskTag)) continue;
            if (isMatchingMediaKey(ref.url || ref.path)) {
              if (!newMediaCandidates.some((c) => c.key === key)) {
                newMediaCandidates.push({ ...ref, key, fromPresentation: true });
              }
            }
          }
        }

        // Only scan session-presented media OR completed workspace files after assistant turn finishes
        if (newMediaCandidates.length === 0 && (assistantReplies.length > 0 || expect !== "video")) {
          const vmFiles = await gw.listGeneratedFiles().catch(() => []);
          for (const f of vmFiles) {
            const key = `${f.url || ""}|${f.path || ""}|${f.id || ""}`;
            const mtimeKey = `${f.url || ""}|${f.path || ""}|${f.id || ""}|${f.mtimeMs || 0}`;
            const fname = String(f.name || f.path || "").toLowerCase();
            // A recently-modified file only re-enters past the baseline if it's OUR file
            // (carries this job's tag). Otherwise a sibling/previous job's freshly-touched
            // file would be mistaken for this job's output (root cause of "lấy nhầm video").
            const isFreshlyModified =
              f.mtimeMs && f.mtimeMs >= taskSendStartMs - 2000 && fname.includes(taskTag);
            if (baselineMediaKeys.has(mtimeKey) && !isFreshlyModified) continue;
            if (baselineMediaKeys.has(key) && !isFreshlyModified) continue;
            if (expect === "video") {
              if (isForeignFinalVideo(fname, taskTag)) continue;
              if (/(?:^|\/)(?:clip|seg|part|temp|tmp)\d*[_-]/i.test(fname) && stitchCmdCount < 3) {
                continue;
              }
              // vmFiles is only a fallback when the session presented nothing. Require this
              // job's tag so we never adopt a sibling job's untagged workspace file (M5);
              // the session-presented path above still matches a legit untagged video.
              if (!fname.includes(taskTag)) {
                continue;
              }
            }
            if (isMatchingMediaKey(f.url || f.path)) {
              if (!newMediaCandidates.some((c) => c.key === key)) {
                newMediaCandidates.push({ ...f, key });
              }
            }
          }
        }

        const latestReply = assistantReplies.length
          ? assistantReplies[assistantReplies.length - 1]
          : null;
        if (latestReply?.text) {
          lastSeenAssistantText = latestReply.text;
        }

        // ==================== FAST PATH: IMAGE OR SHORT VIDEO (<= 10s) ====================
        if (!isLongVideo) {
          if (newMediaCandidates.length > 0) {
            const exactShort = newMediaCandidates.find((c) =>
              String(c.path || c.url || "").toLowerCase().includes(taskTag.toLowerCase())
            );
            matchedMedia = exactShort || newMediaCandidates[newMediaCandidates.length - 1];
            break;
          }

          const hasUnhandledShortTurn =
            latestReply && latestReply.messageId && !handledAssistantTurnIds.has(latestReply.messageId);

          if (hasUnhandledShortTurn && storyboardCmdCount < 3) {
            handledAssistantTurnIds.add(latestReply.messageId);
            storyboardCmdCount += 1;
            const fallbackNudge =
              expect === "video"
                ? `Đồng ý với phiên bản an toàn của bạn! Hãy gọi ngay công cụ tạo video AI thật (media.generate_video, tuyệt đối KHÔNG dùng generate_image ảnh tĩnh) để tạo và xuất file video MP4 (${targetDurationSec}s, tỉ lệ ${
                    aspectRatio || "9:16"
                  }) tại /workspace/imagine_media/${targetVmVideoName} và hiển thị ra khung chat ngay lập tức, không hỏi lại!`
                : `Đồng ý với phiên bản an toàn của bạn! Hãy gọi công cụ generate_image tạo và hiển thị ngay bức ảnh theo yêu cầu ra khung chat, không hỏi lại!`;
            this.log(
              `[${account.name}] [Gateway] ⚡ Đang gửi lệnh thúc đẩy xuất file ${expect.toUpperCase()} (Lần ${storyboardCmdCount})...`
            );
            await sendTrackedMessage(fallbackNudge);
            continue;
          }

          const snippet = lastSeenAssistantText
            ? ` · "${lastSeenAssistantText.replace(/\s+/g, " ").slice(0, 45)}..."`
            : "";
          reportProgress(
            progPct,
            `Muse VM đang tạo ${expect === "video" ? "Video" : "Ảnh"} qua Gateway (${elapsedSec}s)${snippet}`
          );
          continue;
        }

        // ==================== LONG VIDEO (> 10s): MULTI-CLIP & AUTO STITCH ====================
        const stitchedCandidate = newMediaCandidates.find((c) => {
          const p = String(c.path || c.url || "").toLowerCase();
          if (/(?:^|\/)(?:clip|seg|part|temp|tmp)\d*[_-]/i.test(p)) return false;
          if (isForeignFinalVideo(p, taskTag)) return false;
          if (p.includes(targetVmVideoName.toLowerCase()) || p.includes(`final_${taskTag.toLowerCase()}`)) {
            return true;
          }
          if (this.activeCount > 1 && !p.includes(taskTag.toLowerCase())) {
            return false;
          }
          return (
            /final_stitched|final_video|stitched|merged|combined|complete/i.test(p) ||
            new RegExp(`_${targetDurationSec}s\\.mp4$`, "i").test(p)
          );
        });
        if (stitchedCandidate) {
          this.log(
            `[${account.name}] [Gateway] ✅ Đã nhận được file Video hoàn chỉnh: ${
              stitchedCandidate.path || stitchedCandidate.url
            }`
          );
          matchedMedia = stitchedCandidate;
          break;
        }

        const postStitchCandidates = newMediaCandidates.filter(
          (c) => stitchCmdCount > 0 && !preStitchMediaKeys.has(c.key)
        );
        if (postStitchCandidates.length > 0) {
          matchedMedia = postStitchCandidates[postStitchCandidates.length - 1];
          this.log(
            `[${account.name}] [Gateway] ✅ Muse VM đã xuất file Video mới sau lệnh ghép: ${
              matchedMedia.path || matchedMedia.url
            }`
          );
          break;
        }

        const clipCnt = newMediaCandidates.length;
        const hasUnhandledTurn =
          latestReply && latestReply.messageId && !handledAssistantTurnIds.has(latestReply.messageId);

        if (
          clipCnt === 1 &&
          hasUnhandledTurn &&
          newMediaCandidates[0].fromPresentation &&
          (this.activeCount <= 1 ||
            String(newMediaCandidates[0].path || newMediaCandidates[0].url || "")
              .toLowerCase()
              .includes(taskTag.toLowerCase()))
        ) {
          matchedMedia = newMediaCandidates[0];
          this.log(
            `[${account.name}] [Gateway] ✅ Muse VM đã trình bày file Video hoàn chỉnh trên khung chat: ${
              matchedMedia.path || matchedMedia.url
            }`
          );
          break;
        }

        if (!hasUnhandledTurn) {
          const snippet = lastSeenAssistantText
            ? ` · "${lastSeenAssistantText.replace(/\s+/g, " ").slice(0, 40)}..."`
            : "";
          reportProgress(
            progPct,
            clipCnt > 0
              ? `Muse VM đang tạo & ghép video ${targetDurationSec}s (Đã có ${clipCnt} clip · ${elapsedSec}s)`
              : `Muse VM đang tạo phân cảnh cho video ${targetDurationSec}s (${elapsedSec}s)${snippet}`
          );
          continue;
        }

        handledAssistantTurnIds.add(latestReply.messageId);
        const titleReminder =
          productRefImg && !extractedProductTitle
            ? ` Đồng thời BẮT BUỘC in kèm dòng [[PRODUCT_TITLE: tên sản phẩm chính xác 100% hiển thị trong ảnh đính kèm]] (hoặc [[PRODUCT_TITLE: NONE]] nếu ảnh không có chữ tiêu đề) trong câu trả lời!`
            : "";

        if (clipCnt === 0 && storyboardCmdCount < 3) {
          storyboardCmdCount += 1;
          const followUpCmd =
            `Đồng ý với phiên bản an toàn của bạn! Hãy gọi ngay công cụ tạo video AI thật (media.generate_video, tuyệt đối KHÔNG dùng generate_image ảnh tĩnh) để tạo các phân cảnh video AI thật tỉ lệ ${
              aspectRatio || "9:16"
            } cho đủ ${targetDurationSec}s, sau đó dùng lệnh ffmpeg ghép các đoạn video AI thật đó thành 1 file MP4 dài ${targetDurationSec}s tại /workspace/imagine_media/${targetVmVideoName} và gửi/present file video MP4 lên khung chat ngay lập tức!${titleReminder}`;
          reportProgress(
            Math.min(86, progPct),
            `🎬 Đang gửi lệnh qua Gateway yêu cầu Muse render & xuất video ${targetDurationSec}s...`
          );
          this.log(
            `[${account.name}] [Gateway] 🎬 Đang gửi lệnh bắt buộc render & ghép video ${targetDurationSec}s (Lần ${storyboardCmdCount})...`
          );
          await sendTrackedMessage(followUpCmd);
          continue;
        }

        if (clipCnt > 0 && stitchCmdCount < 3) {
          for (const c of newMediaCandidates) {
            preStitchMediaKeys.add(c.key);
          }
          stitchCmdCount += 1;
          const followUpCmd =
            clipCnt < clipCount10s && stitchCmdCount === 1
              ? `Hiện tại mới có ${clipCnt} đoạn video ngắn, chưa đủ độ dài ${targetDurationSec} giây đã chọn. Hãy tạo tiếp các phân cảnh nối tiếp cho đủ ${targetDurationSec} giây, sau đó BẮT BUỘC dùng lệnh ffmpeg ghép nối tất cả các đoạn video theo đúng thứ tự thành 1 file video MP4 hoàn chỉnh duy nhất (/workspace/imagine_media/${targetVmVideoName}) và xuất file đó ra khung chat!${titleReminder}`
              : `Bây giờ hãy ghép nối tất cả ${clipCnt} đoạn video vừa tạo ở trên theo đúng thứ tự thành 1 video MP4 hoàn chỉnh duy nhất dài ${targetDurationSec} giây tại /workspace/imagine_media/${targetVmVideoName} và hiển thị ra khung chat!${titleReminder}`;
          reportProgress(
            Math.min(90, progPct),
            `🎬 Đang gửi lệnh qua Gateway ghép nối ${clipCnt} đoạn clip thành 1 video ${targetDurationSec}s...`
          );
          this.log(
            `[${account.name}] [Gateway] 🎬 Đang gửi lệnh ghép nối ${clipCnt} clip thành 1 video ${targetDurationSec}s hoàn chỉnh (Lần ${stitchCmdCount})...`
          );
          await sendTrackedMessage(followUpCmd);
          continue;
        }

        if (clipCnt > 0 && stitchCmdCount >= 3) {
          matchedMedia = newMediaCandidates[newMediaCandidates.length - 1];
          break;
        }
      }

      if (!matchedMedia) {
        checkCancelled();
        throw new Error(
          `Quá thời gian chờ (${timeoutSec}s) nhưng Muse VM chưa trả về file ${expect} mới.`
        );
      }

      checkCancelled();
      const preferredMediaTitle = productRefImg
        ? this._normalizeProductVideoTitle(extractedProductTitle, fallbackProductFileBase)
        : "";
      if (preferredMediaTitle) {
        this.log(
          `[${account.name}] 🏷️ Đặt tên file ${expect.toUpperCase()} theo ảnh sản phẩm: "${preferredMediaTitle}"`
        );
      }

      reportProgress(
        95,
        `Đang tải trực tiếp file ${expect === "video" ? "Video" : "Ảnh"} từ Muse VM qua Gateway...`
      );
      const { buffer, mime } = await downloadFinishedMedia(() => gw.downloadMediaBuffer(matchedMedia), {
        deadlineMs: Math.max(deadline, Date.now() + MEDIA_FINALIZE_GRACE_MS),
        onWait: (bytes) =>
          reportProgress(
            96,
            `Muse VM vẫn đang ghi file video (${Math.round(bytes / 1024)} KB), chờ ghi xong rồi tải lại...`
          ),
      });
      checkCancelled();
      const prefix = expect === "video" ? "vid" : "img";
      const chosenBase = outputFileBase(outputName);
      if (chosenBase) {
        this.log(`[${account.name}] 🏷️ Đặt tên file ${expect.toUpperCase()} theo tên bạn đặt: "${chosenBase}"`);
      }
      // Optional output-name template from Settings (applied only when the row has no
      // explicit name). {title} {prompt} {duration} {ratio} {quality} {mode} {tag}
      // {date} {time} {datetime} {rand}; reserveUniqueFile still de-dupes with "(2)".
      let templatedBase = "";
      const nameTpl = String((this.store.settings && this.store.settings.outputNameTemplate) || "").trim();
      if (!chosenBase && nameTpl) {
        templatedBase = outputFileBase(
          buildTemplatedName(nameTpl, {
            title: preferredMediaTitle || extractedProductTitle || "",
            prompt: cleanPrompt,
            duration: `${targetDurationSec}s`,
            ratio: aspectRatio,
            quality: qUpper,
            mode: expect,
            tag: taskTag,
          })
        );
        if (templatedBase) {
          this.log(`[${account.name}] 🏷️ Đặt tên file ${expect.toUpperCase()} theo mẫu: "${templatedBase}"`);
        }
      }
      const base =
        chosenBase ||
        templatedBase ||
        preferredMediaTitle ||
        `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
      const ext = mediaExtFor(mime || matchedMedia.path || matchedMedia.url, expect);
      const filename = reserveUniqueFile(this.store.mediaDir, base, ext);
      const fullPath = path.join(this.store.mediaDir, filename);
      fs.writeFileSync(fullPath, buffer);

      const saved = {
        filename,
        fullPath,
        url: `/v1/media/${encodeURIComponent(filename)}`,
        mime: mime || (expect === "video" ? "video/mp4" : "image/png"),
        size: buffer.length,
        ...(expect === "image" && { b64: buffer.toString("base64") }),
      };

      this.store.markLive(account.id, { vm_state: "RUNNING" });

      if (expect === "video") {
        const resultPayload = {
          video: { url: saved.url, filename: saved.filename, size: saved.size },
          productTitle: preferredMediaTitle,
        };
        this.store.finishTask(task.id, resultPayload);
        this.log(`[${account.name}] 🎉 [Gateway No-CDP] Tạo VIDEO thành công: ${saved.filename}`);
        return {
          taskId: task.id,
          accountId: account.id,
          accountName: account.name,
          productTitle: preferredMediaTitle,
          video: saved,
        };
      } else {
        const resultPayload = {
          images: [{ url: saved.url, filename: saved.filename, size: saved.size }],
          productTitle: preferredMediaTitle,
        };
        this.store.finishTask(task.id, resultPayload);
        this.log(`[${account.name}] 🎉 [Gateway No-CDP] Tạo ẢNH thành công: ${saved.filename}`);
        return {
          taskId: task.id,
          accountId: account.id,
          accountName: account.name,
          productTitle: preferredMediaTitle,
          images: [saved],
        };
      }
    } catch (err) {
      if (err.cancelled || runner.cancelled) {
        const reason = runner.cancelReason || err.message || "Đã dừng bởi người dùng";
        this.log(`[${account.name}] ⏹️ Đã dừng tạo ${expect}: ${reason}`);
        this.store.finishTask(task.id, null, reason);
        const cancelErr = new Error(reason);
        cancelErr.cancelled = true;
        throw cancelErr;
      }
      this.log(`[${account.name}] ❌ Lỗi tạo ${expect} (Gateway): ${err.message}`, "error");
      if (err.fatalDie) {
        this.store.markDie(account.id, err.message);
      } else {
        this.store.markFail(account.id, err.message);
      }
      this.store.finishTask(task.id, null, err.message);
      throw err;
    } finally {
      this.activeRunners.delete(task.id);
      this.activeCount = Math.max(0, this.activeCount - 1);
      gw.close();
    }
  }

  /**
   * Cancel active media generation tasks by rowIds, taskIds, or all.
   */
  async cancelTasks({ rowIds = [], taskIds = [], all = false, reason = "Đã dừng bởi người dùng" } = {}) {
    const rowSet = new Set((rowIds || []).map((x) => String(x || "").trim()).filter(Boolean));
    const taskSet = new Set((taskIds || []).map((x) => String(x || "").trim()).filter(Boolean));
    const cancelledTaskIds = [];
    const cancelledRowIds = [];

    for (const [tId, runner] of this.activeRunners.entries()) {
      const match =
        all ||
        taskSet.has(tId) ||
        (runner.rowId && rowSet.has(runner.rowId));
      if (!match) continue;
      runner.cancelled = true;
      runner.cancelReason = reason;
      cancelledTaskIds.push(tId);
      if (runner.rowId) cancelledRowIds.push(runner.rowId);
      try {
        if (runner.gw) {
          runner.gw.cancelChat({ sessionId: runner.sessionId }).catch(() => {});
          setTimeout(() => {
            try {
              runner.gw.close();
            } catch (_e) {}
          }, 150);
        }
      } catch (_e) {
        // ignore
      }
      this.store.finishTask(tId, null, reason);
    }

    // Also clean up any store running tasks that didn't have a live runner entry
    for (const t of this.store.listActiveTasks() || []) {
      const match =
        all ||
        taskSet.has(t.id) ||
        (t.row_id && rowSet.has(t.row_id));
      if (match && !cancelledTaskIds.includes(t.id)) {
        cancelledTaskIds.push(t.id);
        if (t.row_id) cancelledRowIds.push(t.row_id);
        this.store.finishTask(t.id, null, reason);
      }
    }

    return {
      cancelledCount: cancelledTaskIds.length,
      cancelledTaskIds,
      cancelledRowIds,
    };
  }

  // Uses Muse's own chat model (muse-spark) to rewrite a rejected prompt into a safe,
  // policy-compliant version that keeps the core product/scene idea. Returns null on failure.
  async _rewritePromptWithMuse(originalPrompt) {
    const instruction =
      "Bạn là trợ lý viết lại prompt tạo video. Hãy viết lại prompt dưới đây thành MỘT phiên bản AN TOÀN, " +
      "tuân thủ chính sách nội dung (không trẻ em/vị thành niên, không bạo lực/máu me, không nguy hiểm, không nhạy cảm), " +
      "giữ nguyên ý tưởng sản phẩm và bối cảnh chính, phù hợp quảng cáo thương mại. " +
      "CHỈ trả về đúng prompt mới, KHÔNG giải thích, KHÔNG thêm dấu ngoặc kép.\n\nPrompt gốc:\n" +
      String(originalPrompt || "");
    const res = await this.chatCompletion({ prompt: instruction, model: "muse-spark" });
    const text = String((res && res.text) || "")
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "")
      .trim();
    return text || null;
  }

  // Runs a generation and auto-retries on failure. Transient/auth errors retry with a
  // fresh LIVE account and the same prompt; a content refusal has Muse rewrite the prompt
  // first. Controlled by settings.autoRetryCount and settings.autoFixPromptOnViolation.
  async _generateWithRetry(opts) {
    const settings = this.store.settings || {};
    const maxRetries = Math.max(0, Math.min(5, Number(settings.autoRetryCount) || 0));
    const autoFix = settings.autoFixPromptOnViolation !== false;
    let prompt = opts.prompt;
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await this._generateMedia({
          ...opts,
          prompt,
          // After the first attempt, let the pool pick a fresh LIVE account.
          accountId: attempt === 0 ? opts.accountId : "",
        });
      } catch (err) {
        lastErr = err;
        if (err.cancelled) throw err; // user stopped -> never retry
        if (attempt >= maxRetries) break;
        const cls = classifyGenError(err.message);
        if (cls === "unknown") break; // can't reason about it -> surface the error
        let fixNote = "";
        if (cls === "violation" && autoFix) {
          // Ask Muse itself to rewrite the rejected prompt into a safe version;
          // fall back to the static safe framing if the rewrite fails.
          let rewritten = null;
          try {
            rewritten = await this._rewritePromptWithMuse(prompt);
          } catch (_e) {
            rewritten = null;
          }
          prompt = rewritten || softenPromptForRetry(prompt);
          fixNote = rewritten ? " · Muse đã viết lại prompt" : " · chèn khung an toàn";
        }
        this.log(
          `🔁 Tự động thử lại (${attempt + 1}/${maxRetries}) · ${cls}${fixNote}: ${String(err.message).slice(0, 90)}`,
          "warn"
        );
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    throw lastErr;
  }

  async generateImage(opts) {
    return this._generateWithRetry({ ...opts, expect: "image" });
  }

  async generateVideo(opts) {
    const refImgs = opts.referenceImage
      ? [opts.referenceImage]
      : Array.isArray(opts.referenceImages)
      ? opts.referenceImages
      : [];
    return this._generateWithRetry({ ...opts, referenceImages: refImgs, expect: "video" });
  }

  /**
   * 100% Direct HTTP + Noise-XX Gateway Chat Completion (NO Chrome CDP!)
   */
  async chatCompletion({ prompt, model = "muse-spark", onDelta = null }) {
    const account = this.store.pickAccount();
    if (!account) {
      throw new Error(
        "Chưa có ních Muse.ai nào đang LIVE. Vui lòng thêm hoặc kiểm tra ních ở mục [Ních Muse.ai]."
      );
    }

    const task = this.store.createTask("chat", prompt, model, account.id);
    this.activeCount += 1;
    const gw = new MuseGateway(account, { store: this.store });

    try {
      await gw.connect(22000);
      const sessionId = await gw.startSession(String(prompt || "").slice(0, 48));

      const beforeEvents = await gw.getHistory({ sessionId, limit: 20 }).catch(() => []);
      const seenIds = new Set(beforeEvents.map((e) => e?.message_id).filter(Boolean));

      await gw.sendChatMessage(prompt, { sessionId });

      const timeoutMs = Number(this.store.settings.genTimeout || 240) * 1000;
      const start = Date.now();
      let sent = "";

      while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 1500));
        const events = await gw.getHistory({ sessionId, limit: 20 }).catch(() => []);
        for (const ev of events) {
          if (ev?.message_id && seenIds.has(ev.message_id)) continue;
          const info = inspectHistoryEvent(ev);
          if (info.eventName === "message.assistant" && info.messageKind !== "commentary" && info.text) {
            const cur = info.text;
            const delta = cur.startsWith(sent) ? cur.slice(sent.length) : cur;
            if (delta) {
              sent = cur;
              if (typeof onDelta === "function") onDelta(delta);
            }
          }
        }
        if (sent) break;
      }

      if (!sent) {
        throw new Error("Không nhận được phản hồi văn bản từ Muse VM Gateway");
      }

      this.store.markLive(account.id, { vm_state: "RUNNING" });
      this.store.finishTask(task.id, { text: sent });
      return { text: sent, taskId: task.id, accountId: account.id };
    } catch (err) {
      if (err.fatalDie) {
        this.store.markDie(account.id, err.message);
      } else {
        this.store.markFail(account.id, err.message);
      }
      this.store.finishTask(task.id, null, err.message);
      throw err;
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
      gw.close();
    }
  }
}

module.exports = {
  MuseEngine,
  resolveModel,
  findChromeBinary,
  MODEL_ALIASES,
  minStitchedDurationSec,
  isUnfinishedMp4,
  isForeignFinalVideo,
  applyPromptTemplate,
  buildTemplatedName,
  classifyGenError,
  softenPromptForRetry,
  downloadFinishedMedia,
  outputFileBase,
};
