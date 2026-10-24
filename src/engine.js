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

const MAX_SINGLE_CLIP_SEC = 10;

// A stitched result must be longer than any single clip Muse can render and cover most of the target;
// otherwise a lone follow-up clip (e.g. 11s for a 60s order) would be accepted as the final video.
function minStitchedDurationSec(targetSec) {
  return Math.max(MAX_SINGLE_CLIP_SEC + 0.5, targetSec * 0.6);
}

function buildProbeVideoDurationJs(targetSrc) {
  return `
(async () => {
  const src = ${JSON.stringify(targetSrc)};
  if (!src) return 0;
  const domVids = Array.from(document.querySelectorAll('video'));
  const existing = domVids.find(v => (v.currentSrc || v.src || '') === src);
  if (existing && Number.isFinite(existing.duration) && existing.duration > 0) {
    return Math.round(existing.duration * 10) / 10;
  }
  return await new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { v.removeAttribute('src'); v.load(); } catch (_) {}
      resolve(val);
    };
    const timer = setTimeout(() => finish(0), 4000);
    v.onloadedmetadata = () => {
      clearTimeout(timer);
      const d = Number.isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration * 10) / 10 : 0;
      finish(d);
    };
    v.onerror = () => {
      clearTimeout(timer);
      finish(0);
    };
    v.src = src;
  });
})()
`;
}

const JS_POLL_AGENT_STATUS = `
(() => {
  const scope = document.querySelector('main, [class*="chat-scroll"], [class*="hatch-chat-scroll"]') || document.body;
  if (!scope) {
    return { cnt: 0, total: 0, txt: '', stop: false, tail: '', statusStep: '', productTitle: '' };
  }
  const bs = Array.from(scope.querySelectorAll('div[class*="hatch-chat-groupable-bubble"]'))
    .filter(b => /hatch-agent-bubble-bg/.test(b.className || ''));
  const nonEmpty = bs.filter(b => (b.innerText || '').trim().length > 0);
  const lastTxt = nonEmpty.length ? (nonEmpty[nonEmpty.length - 1].innerText || '').trim() : '';
  let productTitle = '';
  for (const b of nonEmpty) {
    const t = b.innerText || '';
    const m = t.match(/\\[\\[?\\s*PRODUCT_TITLE\\s*:\\s*([^\\]\\n]+?)\\s*\\]?\\]/i);
    if (m && m[1]) {
      productTitle = m[1].trim();
    }
  }
  const statusEl = document.querySelector('[data-testid="hatch-status-panel-sliding-surface"]');
  const statusHasSpinner = Boolean(
    statusEl &&
      statusEl.querySelector(
        '.animate-spin, svg.animate-spin, [role="progressbar"], [data-testid*="loading" i], [data-testid*="spinner" i]'
      )
  );
  const hasStop = Boolean(
    document.querySelector('[data-testid="hatch-composer-stop-button"]') ||
    document.querySelector('button[aria-label*="Stop" i]') ||
    document.querySelector('button[aria-label*="停止"]') ||
    statusHasSpinner
  );
  const statusLines = statusEl
    ? (statusEl.innerText || '')
        .split('\\n')
        .map(s => s.trim())
        .filter(Boolean)
    : [];
  let statusStep = '';
  if (statusLines.length > 1) {
    const filtered = statusLines.filter(l => l !== 'Muse' && l !== '🎬' && l !== 'Today');
    statusStep = filtered.slice(0, 2).join(' · ');
  }
  const tail = document.body ? (document.body.innerText || '').slice(-700) : '';
  return {
    cnt: nonEmpty.length,
    total: bs.length,
    txt: lastTxt,
    stop: hasStop,
    statusStep,
    tail,
    productTitle,
  };
})()
`;

const JS_CLEAR_ATTACHMENTS = `
(() => {
  const btns = Array.from(document.querySelectorAll('button[aria-label]')).filter(b => {
    const al = b.getAttribute('aria-label') || '';
    return /remove\\s*attachment|移除附件|删除附件|移除|删除/i.test(al);
  });
  btns.forEach(b => b.click());
  Array.from(document.querySelectorAll('input[type="file"]')).forEach(inp => { inp.value = ''; });
  return btns.length;
})()
`;

function buildInjectAttachmentsJs(items) {
  return `
(() => {
  try {
    const rawItems = ${JSON.stringify(items)};
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    if (!inputs.length) return { ok: false, err: 'no-file-input' };
    const ov = document.querySelector('[data-testid="hatch-composer-placeholder-overlay"]');
    const composer = ov ? ov.closest('form') : null;
    let input = null;
    if (composer) {
      input = inputs.find(x => composer.contains(x)) || null;
    }
    if (!input) {
      input = inputs.find(x => !x.closest('[class*="chat-user-bubble"], [class*="group/msg"]')) || inputs[0];
    }
    if (!input.getAttribute('accept')) input.setAttribute('accept', 'image/*');
    input.multiple = true;

    const dt = new DataTransfer();
    rawItems.forEach((item, idx) => {
      const byteChars = atob(item.b64);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      const mime = item.mime || 'image/png';
      const blob = new Blob([bytes], { type: mime });
      let ext = (mime.split('/')[1] || 'png').toLowerCase();
      if (ext === 'jpeg') ext = 'jpg';
      const fileName = item.name || ('reference_' + (idx + 1) + '.' + ext);
      const file = new File([blob], fileName, { type: mime });
      dt.items.add(file);
    });

    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, count: rawItems.length };
  } catch (e) {
    return { ok: false, err: String(e) };
  }
})()
`;
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
    this.knownCdpPorts = new Set([this.cdpPort]);
    this.pendingLoginPorts = new Set();
    this._openTabChain = Promise.resolve();
    this._accountSendChains = new Map();
    this.activeCount = 0;
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

  _withAccountSendLock(accountId, fn) {
    const key = String(accountId || "default");
    const prev = this._accountSendChains.get(key) || Promise.resolve();
    const next = prev.then(() => fn());
    this._accountSendChains.set(key, next.catch(() => {}));
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
  async ensureChrome(forceVisible = false, customPort = null, slotHint = null) {
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
    const p = this._ensureChromeInternal(forceVisible, targetPort, slotHint).finally(() => {
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

  async _ensureChromeInternal(forceVisible = false, targetPort = this.cdpPort, slotHint = null) {
    const port = Number(targetPort || this.cdpPort);
    const profileDir = this._getProfileDirForPort(port);
    const isVisibleMode =
      Boolean(forceVisible) ||
      Boolean(this.store.settings && this.store.settings.showChromeWindow === true);

    if (await this.isChromeAlive(port)) {
      const currentMode = this.portModes.get(port);
      if (isVisibleMode && currentMode === "headless") {
        this.log(`Chuyển cổng CDP :${port} từ Chế độ Ngầm (Headless) sang Chế độ Hiển thị...`);
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
    forceNewProfile = false,
    slotOffset = 0,
    timeoutSec = 240,
  } = {}) {
    const existingAcc = accountId ? this.store.getAccount(accountId) : null;

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
      await this.ensureChrome(true, targetPort, gridSlot);
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

  async _syncRefreshedCookies(cdp, account, vmState = "RUNNING") {
    try {
      const res = await cdp.send("Network.getCookies", {
        urls: ["https://muse.ai", "https://www.muse.ai"],
      });
      const museCookies = (res.cookies || []).filter((c) =>
        String(c.domain || "").includes("muse.ai")
      );
      if (museCookies.length > 0 && museCookies.some((c) => c.name === "hatch_sess" && c.value)) {
        this.store.updateAccountCookies(account.id, museCookies, "", vmState);
      }
    } catch (_err) {
      // ignore
    }
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
   * Strict LIVE / DIE verification + 48h Cookie renewal + VM Wake
   * Tries pure HTTP request first, falls back to Headless Chrome (--headless=new) if needed.
   */
  async renewAccount(account) {
    const hasSess = (account.cookies || []).some((c) => c.name === "hatch_sess" && c.value);
    if (!hasSess) {
      const reason = "Ních DIE: Thiếu cookie cốt lõi hatch_sess";
      this.store.markDie(account.id, reason);
      this.log(`[🔴 DIE] Ních [${account.name}]: ${reason}`, "warn");
      return { ok: false, live: false, status: "die", error: reason };
    }

    // 1. Try 100% Pure HTTP Request fast-path first (zero Chrome overhead!)
    const httpCheck = await this._renewAccountViaHttp(account);
    if (httpCheck.ok) {
      return httpCheck;
    }
    if (httpCheck.fatalDie) {
      this.store.markDie(account.id, httpCheck.reason);
      this.log(`[🔴 DIE] Ních [${account.name}]: ${httpCheck.reason}`, "warn");
      return { ok: false, live: false, status: "die", error: httpCheck.reason };
    }

    let session = null;
    try {
      session = await this._openSessionPage(account, MUSE_NEW_THREAD, { reuseMainTab: true });
      const { cdp } = session;

      // Wait a moment for navigation to muse.ai so same-origin fetch works
      await new Promise((r) => setTimeout(r, 2000));

      const apiRes = await cdp.evaluate(
        `
        (async () => {
          const out = {
            session_status: 0,
            session_ok: false,
            assigned: false,
            vm_id: '',
            vm_state: '',
            wake_ok: false,
            raw_session: null
          };
          try {
            const r1 = await fetch('https://muse.ai/api/session', { credentials: 'include' });
            out.session_status = r1.status;
            if (r1.status === 401 || r1.status === 403) {
              return out;
            }
            if (r1.ok) {
              const d1 = await r1.json();
              out.raw_session = d1;
              out.assigned = Boolean(d1 && d1.status === 'assigned');
              out.vm_id = d1?.vm_id || '';
              out.vm_state = d1?.vm_state || '';
              out.session_ok = out.assigned;
            }
          } catch (e) {
            out.session_error = String(e);
          }

          if (out.assigned && out.vm_id && out.vm_state !== 'DISABLED') {
            try {
              const r2 = await fetch('https://muse.ai/api/hatch/vm/wake', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                  vm_id: out.vm_id,
                  retry_count: 0,
                  connect_attempt_id: crypto.randomUUID()
                })
              });
              out.wake_status = r2.status;
              if (r2.ok) {
                const verify = await fetch('https://muse.ai/api/session', { credentials: 'include' });
                if (verify.ok) {
                  const vd = await verify.json();
                  out.vm_state = vd?.vm_state || out.vm_state || 'RUNNING';
                  out.wake_ok = out.vm_state === 'RUNNING';
                }
              }
            } catch (e) {
              out.wake_error = String(e);
            }
          }
          return out;
        })()
        `,
        true
      );

      if (apiRes?.session_status === 401) {
        const reason = "Ních DIE: Phiên đăng nhập hết hạn (/api/session HTTP 401)";
        this.store.markDie(account.id, reason);
        this.log(`[🔴 DIE] Ních [${account.name}]: ${reason}`, "warn");
        return { ok: false, live: false, status: "die", error: reason, detail: apiRes };
      }

      const wsReady = await this._waitWsReady(cdp, 15000);

      if (!apiRes?.assigned || !wsReady.ok) {
        const reason =
          wsReady.state === "logged-out"
            ? wsReady.reason
            : !apiRes?.assigned
            ? `Ních DIE: Phiên không hợp lệ (status=${apiRes?.raw_session?.status || apiRes?.session_status || "unassigned"})`
            : `Ních DIE / Lỗi kết nối: ${wsReady.reason}`;
        this.store.markDie(account.id, reason);
        this.log(`[🔴 DIE] Ních [${account.name}]: ${reason}`, "warn");
        return { ok: false, live: false, status: "die", error: reason, detail: apiRes };
      }

      const vmState = apiRes.vm_state || "RUNNING";
      await this._syncRefreshedCookies(cdp, account, vmState);
      this.store.markLive(account.id, { vm_state: vmState });

      const updated = this.store.getAccount(account.id);
      const now = Date.now() / 1000;
      const exp = Number(updated?.cookie_expires || 0);
      const expiresInHours = exp > 0 ? Math.round(((exp - now) / 3600) * 10) / 10 : 48;

      this.log(
        `[🟢 LIVE] Ních [${account.name}] hoạt động tốt! VM: ${vmState}, hạn Cookie: ${expiresInHours}h`
      );
      return {
        ok: true,
        live: true,
        status: "live",
        vm_state: vmState,
        expires_in_hours: expiresInHours,
        cookie_count: updated?.cookies?.length || 0,
      };
    } catch (err) {
      const reason = `Ních DIE / Lỗi kiểm tra: ${err.message}`;
      this.store.markDie(account.id, reason);
      this.log(`[🔴 DIE] Ních [${account.name}]: ${reason}`, "error");
      return { ok: false, live: false, status: "die", error: reason };
    } finally {
      await this._closeSessionPage(session);
    }
  }

  async renewAllAccounts() {
    if (this.keepaliveRunning) {
      return { ok: false, message: "Đang chạy tiến trình kiểm tra & bảo hoạt" };
    }
    await this.syncActiveBrowserSession({ force: true }).catch(() => null);
    this.keepaliveRunning = true;
    const results = [];
    try {
      // Check die/failing accounts first and live/active accounts last so Chrome stays logged into a LIVE account
      const ordered = [...this.store.accounts]
        .filter((a) => a.status !== "disabled")
        .sort((a, b) => {
          const score = (acc) => (acc.status === "live" ? 2 : acc.status === "active" ? 1 : 0);
          return score(a) - score(b);
        });
      for (const acc of ordered) {
        const r = await this.renewAccount(acc);
        results.push({ id: acc.id, name: acc.name, ...r });
      }
      const liveAcc = this.store.accounts.find((a) => a.status === "live");
      const lastChecked = ordered[ordered.length - 1];
      if (liveAcc && lastChecked && lastChecked.id !== liveAcc.id) {
        await this.renewAccount(liveAcc).catch(() => {});
      }
      const liveCount = results.filter((r) => r.ok).length;
      const dieCount = results.length - liveCount;
      return { ok: true, liveCount, dieCount, results };
    } finally {
      this.keepaliveRunning = false;
    }
  }

  /**
   * Ported from engine.py quota(): clicks Settings button -> Settings menu item -> reads Usage modal
   */
  async checkAccountQuota(account) {
    let session = null;
    try {
      session = await this._openSessionPage(account, MUSE_NEW_THREAD, { reuseMainTab: true });
      const { cdp } = session;
      const ready = await this._waitWsReady(cdp, 18000);
      if (!ready.ok) {
        this.store.markDie(account.id, ready.reason);
        return { ok: false, error: ready.reason };
      }

      // Click Settings button in bottom-left
      const pt1 = await cdp.evaluate(`
        (() => {
          const b = Array.from(document.querySelectorAll('button[aria-label="Settings"]')).find(x => x.offsetParent !== null);
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })()
      `);

      if (pt1) {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await cdp.send("Input.dispatchMouseEvent", {
            type,
            x: pt1.x,
            y: pt1.y,
            button: "left",
            clickCount: 1,
          });
        }
        await new Promise((r) => setTimeout(r, 1200));

        const pt2 = await cdp.evaluate(`
          (() => {
            const els = Array.from(document.querySelectorAll('div,span,li,[role=menuitem],button')).filter(e =>
              e.offsetParent !== null &&
              (e.textContent || '').trim() === 'Settings' &&
              e.getAttribute('aria-label') !== 'Settings' &&
              e.children.length <= 3
            );
            if (!els.length) return null;
            const el = els[els.length - 1];
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          })()
        `);

        if (pt2) {
          for (const type of ["mousePressed", "mouseReleased"]) {
            await cdp.send("Input.dispatchMouseEvent", {
              type,
              x: pt2.x,
              y: pt2.y,
              button: "left",
              clickCount: 1,
            });
          }
          await new Promise((r) => setTimeout(r, 2200));
        }
      }

      const dialogTxt =
        (await cdp.evaluate(`
          (() => {
            const d = document.querySelector('[role=dialog],[aria-modal=true]');
            return d ? (d.innerText || '') : (document.body ? document.body.innerText : '');
          })()
        `)) || "";

      // Close modal with Escape
      for (const type of ["keyDown", "keyUp"]) {
        await cdp
          .send("Input.dispatchKeyEvent", {
            type,
            key: "Escape",
            code: "Escape",
            windowsVirtualKeyCode: 27,
            nativeVirtualKeyCode: 27,
          })
          .catch(() => {});
      }

      const pctMatch = dialogTxt.match(/(\d+)\s*%\s*used/i);
      const planMatch = dialogTxt.match(/^(.+?\s*plan)$/im);
      const quota = {
        used_percent: pctMatch ? `${pctMatch[1]}%` : "0%",
        plan: planMatch ? planMatch[1].trim() : "Free plan",
        checked_at: Math.floor(Date.now() / 1000),
      };
      this.store.updateAccountQuota(account.id, quota);
      this.store.markLive(account.id);
      return { ok: true, quota };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      await this._closeSessionPage(session);
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

  async _tryClickRetrySendButton(cdp) {
    try {
      return await cdp.evaluate(`
        (() => {
          const btns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => b.offsetParent !== null);
          const retryBtn = btns.find(b => {
            const txt = ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).trim();
            return /retry|resend|try\\s*again|重试|重新发送/i.test(txt);
          });
          if (retryBtn) {
            retryBtn.click();
            return true;
          }
          return false;
        })()
      `);
    } catch (_err) {
      return false;
    }
  }

  async _attachReferenceImages(cdp, refImages = []) {
    const valid = (refImages || []).filter((img) => img && img.b64);
    if (!valid.length) return;
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    await cdp.evaluate(JS_CLEAR_ATTACHMENTS);
    await new Promise((r) => setTimeout(r, 300));

    const payload = valid.map((img, i) => ({
      b64: img.b64,
      mime: img.mime || "image/png",
      name: img.name || `reference_${i + 1}.png`,
    }));

    let injectRes = await cdp.evaluate(buildInjectAttachmentsJs(payload));
    if (!injectRes || !injectRes.ok) {
      throw new Error(`Không đính kèm được ảnh tham chiếu vào Muse.ai (${injectRes?.err || "unknown"})`);
    }

    // Allow React to mount attachment thumbnails and any upload progress indicators
    await new Promise((r) => setTimeout(r, 750));

    const deadline = Date.now() + 22000;
    let confirmed = false;
    let retriedInject = false;
    const startWait = Date.now();

    while (Date.now() < deadline) {
      const attachState = await cdp.evaluate(`
        (() => {
          const btns = Array.from(document.querySelectorAll('button[aria-label]'));
          const hasRemove = btns.some(b => /remove\\s*attachment|移除附件|删除附件/i.test(b.getAttribute('aria-label') || ''));
          const ov = document.querySelector('[data-testid="hatch-composer-placeholder-overlay"]');
          const composer = ov ? (ov.closest('form') || ov.parentElement?.parentElement?.parentElement) : document.querySelector('form');
          const hasThumb = Boolean(composer && composer.querySelectorAll('img, video').length > 0);
          const hasSpinner = Boolean(
            composer &&
            composer.querySelector('[role="progressbar"], .animate-spin, svg.animate-spin')
          );
          if ((hasRemove || hasThumb) && !hasSpinner) return 'ready';
          if (hasRemove || hasThumb) return 'uploading';
          return '';
        })()
      `);
      if (attachState === "ready") {
        confirmed = true;
        break;
      }
      if (!attachState && !retriedInject && Date.now() - startWait > 5000) {
        retriedInject = true;
        await cdp.evaluate(buildInjectAttachmentsJs(payload)).catch(() => {});
      }
      if (attachState === "uploading" && Date.now() - startWait > 7500) {
        confirmed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 350));
    }
    if (!confirmed) {
      throw new Error("Tải ảnh tham chiếu lên Muse.ai chưa được xác nhận (timeout)");
    }
    // Wait for Muse.ai blob upload to finalize before clicking Send
    await new Promise((r) => setTimeout(r, 2000));
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

  async _extractProductTitleFallback(cdp, productRefImg = null) {
    try {
      const stNow = (await cdp.evaluate(JS_POLL_AGENT_STATUS)) || {};
      if (stNow.productTitle) {
        return String(stNow.productTitle).trim();
      }
    } catch (_e) {
      // ignore
    }

    // Optional fast path via Gemini Vision if API key is configured
    const geminiKey = String(this.store.settings.geminiApiKey || "").trim();
    const geminiModel = String(this.store.settings.geminiModel || "gemini-2.5-flash").trim();
    if (geminiKey && productRefImg && productRefImg.b64) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
            geminiModel
          )}:generateContent?key=${encodeURIComponent(geminiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    {
                      text: 'Đọc bức ảnh sản phẩm này và trả về DUY NHẤT dòng chữ Tên/Tiêu đề sản phẩm hiển thị trong ảnh (ví dụ: "DKHOUSE Nồi Điện 1.8L Đa Năng, Nồi Cơm, Nồi Áp Suất Nấu Các Món, Tặng Vỉ Hấp"). Bỏ qua nhãn phụ đầu dòng như "Star Shop", "Mall", "Yêu thích", giá tiền hay nút bấm. Nếu ảnh chỉ chụp vật thể không có chữ tên sản phẩm thì trả về đúng chữ NONE.',
                    },
                    {
                      inlineData: {
                        mimeType: productRefImg.mime || "image/jpeg",
                        data: productRefImg.b64,
                      },
                    },
                  ],
                },
              ],
              generationConfig: { temperature: 0.1 },
            }),
            signal: AbortSignal.timeout(10000),
          }
        );
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const txt = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
          const m = txt.match(/\[\[?\s*PRODUCT_TITLE\s*:\s*([^\]\n]+?)\s*\]?\]/i);
          const candidate = (m ? m[1] : txt.split("\n")[0] || "").trim();
          if (candidate) return candidate;
        }
      } catch (_e) {
        // ignore and use Muse.ai fallback
      }
    }

    // Fast fallback on the already-open Muse.ai thread
    try {
      const askTitlePrompt =
        `Hãy nhìn vào bức ảnh sản phẩm đính kèm ở đầu cuộc trò chuyện và chỉ trả lời duy nhất 1 dòng theo đúng cú pháp: ` +
        `[[PRODUCT_TITLE: nguyên văn 100% tên tiêu đề sản phẩm trong ảnh]] ` +
        `(bỏ qua nhãn phụ đầu dòng như Star Shop/Mall; nếu trong ảnh không có chữ tên sản phẩm thì in [[PRODUCT_TITLE: NONE]]). ` +
        `Tuyệt đối không gọi bất kỳ tool tạo ảnh hay video nào.`;
      await this._sendPromptToMuse(cdp, askTitlePrompt);
      const deadline = Date.now() + 14000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 650));
        const st = (await cdp.evaluate(JS_POLL_AGENT_STATUS)) || {};
        if (st.productTitle) {
          return String(st.productTitle).trim();
        }
      }
    } catch (_e) {
      // ignore
    }
    return "";
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
          const buf = Buffer.from(fullB64, "base64");
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

  async _probeVideoDuration(cdp, videoSrc) {
    if (!videoSrc) return 0;
    try {
      const dur = await cdp.evaluate(buildProbeVideoDurationJs(videoSrc), true, 6000);
      return Number.isFinite(dur) && dur > 0 ? Number(dur) : 0;
    } catch (_err) {
      return 0;
    }
  }

  /**
   * Core Media Generation (Video or Image) — Exact port of engine.py generate()
   * Supports >10s Video Multi-Clip Generation & Automatic FFmpeg Stitching Command on Muse.ai
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
    onProgress = null,
  }) {
    let account = accountId
      ? this.store.getAccount(accountId) || this.store.pickAccount()
      : this.store.pickAccount();
    if (!account) {
      const synced = await this.syncActiveBrowserSession({ force: true }).catch(() => null);
      if (synced && synced.account) {
        account = synced.account;
      }
    }
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

    // Build clear instruction for Muse.ai agent including aspect ratio, duration (5s-60s), quality (1K/2K/4K), and product reference
    const cleanPrompt = String(prompt || "").trim();
    const specs = [];
    if (aspectRatio) specs.push(`aspect ratio ${aspectRatio}`);
    if (expect === "video" && duration) specs.push(`total duration ${targetDurationSec}s`);
    const qUpper = String(quality || "4K").toUpperCase();
    if (qUpper === "4K") specs.push("resolution 4K Ultra HD 2160p, photorealistic, high detail");
    else if (qUpper === "2K") specs.push("resolution 2K QHD 1440p, sharp detail");
    else if (qUpper === "1K") specs.push("resolution 1K Full HD 1080p");

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

    const productTitleInstruction = productRefImg
      ? `\n\n[YÊU CẦU BẮT BUỘC TRÍCH XUẤT TÊN SẢN PHẨM TRONG ẢNH ĐỂ ĐẶT TÊN FILE VIDEO / MANDATORY PRODUCT TITLE EXTRACTION]:\n` +
        `- Hãy đọc kỹ bức ảnh sản phẩm đính kèm. Nếu trong ảnh có dòng chữ Tên/Tiêu đề sản phẩm (ví dụ ảnh chụp màn hình TikTok Shop / Shopee có dòng chữ tiêu đề như "DKHOUSE Nồi Điện 1.8L Đa Năng, Nồi Cơm, Nồi Áp Suất Nấu Các Món, Tặng Vỉ Hấp" — lưu ý bỏ qua các nhãn phụ đứng đầu như "Star Shop", "Mall", "Yêu thích", giá tiền hay nút mua hàng), bạn BẮT BUỘC phải in nguyên văn 100% tên sản phẩm đó ở dòng đầu tiên của câu trả lời theo đúng cú pháp:\n` +
        `[[PRODUCT_TITLE: tên sản phẩm chính xác 100% như trong ảnh]]\n` +
        `(Nếu ảnh chỉ chụp sản phẩm mà hoàn toàn không có chữ tiêu đề sản phẩm nào thì in [[PRODUCT_TITLE: NONE]]).`
      : "";

    let finalPrompt = cleanPrompt;
    if (expect === "video") {
      if (isLongVideo) {
        finalPrompt =
          `Please create a complete ${targetDurationSec}-second video (${specs.join(", ")}) for this scene: ${cleanPrompt}\n\n` +
          `[YÊU CẦU BẮT BUỘC VỀ ĐỘ DÀI ${targetDurationSec} GIÂY & LỆNH GHÉP VIDEO HOÀN CHỈNH / MANDATORY MULTI-CLIP & FFMPEG STITCHING]:\n` +
          `Vì mỗi đoạn video đơn lẻ chỉ dài tối đa 5s–10s, bạn BẮT BUỘC thực hiện đầy đủ 2 bước sau trong lượt này:\n` +
          `1. Chia kịch bản thành ${clipCount10s} phân cảnh nối tiếp nhau mượt mà (ví dụ ${clipCount10s} đoạn video 10s hoặc ${clipCount5s} đoạn 5s = tổng cộng ${targetDurationSec} giây), giữ đồng nhất ${hasCharacterRef ? "khuôn mặt & trang phục nhân vật mẫu đính kèm, " : ""}bối cảnh${hasProductRef ? " và giữ nguyên chính xác sản phẩm mẫu đính kèm" : ""}, rồi tạo ngay tất cả các đoạn video thành phần đó.\n` +
          `2. GHÉP VIDEO HOÀN CHỈNH (STITCH VIDEO): Ngay sau khi tạo xong các đoạn video thành phần, BẮT BUỘC dùng công cụ ffmpeg trong workspace để ghép nối (concatenate/stitch) tất cả các đoạn video theo đúng thứ tự thành 1 file video MP4 hoàn chỉnh duy nhất dài ${targetDurationSec} giây (final_stitched_${targetDurationSec}s.mp4) và đính kèm/xuất file video MP4 hoàn chỉnh đó ra khung chat!${productTitleInstruction}`;
      } else {
        finalPrompt = `Please generate a video (${specs.join(", ") || "aspect ratio 9:16"}): ${cleanPrompt}${productTitleInstruction}`;
      }
    } else {
      finalPrompt = `Please generate an image (${specs.join(", ") || "high quality"}): ${cleanPrompt}${productTitleInstruction}`;
    }

    const task = this.store.createTask(expect, cleanPrompt, model, account.id, {
      row_id: rowId || "",
      aspect_ratio: aspectRatio,
      duration: expect === "video" ? `${targetDurationSec}s` : "",
      quality: qUpper,
    });

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

    this.activeCount += 1;
    let session = null;

    try {
      reportProgress(10, "Đang mở cửa sổ Chrome riêng & nạp Cookie ních...");
      this.log(
        `[${account.name}] Mở Chrome bắt đầu tạo ${expect.toUpperCase()} (${aspectRatio}, ${
          expect === "video" ? `${targetDurationSec}s${isLongVideo ? " [Ghép đa cảnh]" : ""}, ` : ""
        }${qUpper}): "${cleanPrompt.slice(0, 60)}..."`
      );

      session = await this._openSessionPage(account, MUSE_NEW_THREAD, { reuseMainTab: true });
      const { cdp, streamSlot } = session;

      reportProgress(20, `Đang kết nối máy chủ Muse VM (Cửa sổ #${(streamSlot || 0) + 1})...`);
      const ready = await this._waitWsReady(cdp, 25000);
      if (!ready.ok) {
        if (ready.state === "logged-out") {
          this.store.markDie(account.id, ready.reason);
        } else {
          this.store.markFail(account.id, ready.reason);
        }
        throw new Error(ready.reason);
      }

      const baselineSources = new Set();
      let baseAgentCnt = 0;

      // Serialize initial thread creation + image upload + prompt submission per account
      // so parallel windows on the same Muse account never collide on /thread/new WebSocket handshakes
      await this._withAccountSendLock(account.id, async () => {
        const hasExistingBubbles = await cdp.evaluate(`
          (() => {
            return document.querySelectorAll('div[class*="hatch-chat-groupable-bubble"]').length > 0 ||
                   document.querySelectorAll('[data-testid^="hatch-chat-attachment-presentation-"]').length > 0;
          })()
        `);
        if (hasExistingBubbles) {
          await cdp.send("Page.navigate", { url: MUSE_NEW_THREAD });
          await new Promise((r) => setTimeout(r, 1500));
          await this._waitWsReady(cdp, 22000);
        }

        await cdp.evaluate(JS_SCROLL_BOTTOM);

        if (validRefImgs.length > 0) {
          reportProgress(
            28,
            `Đang tải ${validRefImgs.length} ảnh tham chiếu (Nhân vật / Sản phẩm) lên Muse.ai...`
          );
          await this._attachReferenceImages(cdp, validRefImgs);
        } else {
          await cdp.evaluate(JS_CLEAR_ATTACHMENTS);
        }

        const attsBefore = (await cdp.evaluate(JS_GET_ATTACHMENTS)) || [];
        baselineSources.clear();
        for (const a of attsBefore) {
          if (a.src) baselineSources.add(a.src);
          if (a.vSrc) baselineSources.add(a.vSrc);
          if (a.iSrc) baselineSources.add(a.iSrc);
        }
        const agentBefore = (await cdp.evaluate(JS_POLL_AGENT_STATUS)) || { cnt: 0 };
        baseAgentCnt = Number(agentBefore.cnt || 0);

        reportProgress(
          35,
          isLongVideo
            ? `Đang gửi lệnh tạo & ghép Video ${targetDurationSec}s trên Muse.ai...`
            : "Đang nhập Prompt và bấm nút Gửi trên Muse.ai..."
        );
        await this._sendPromptToMuse(cdp, finalPrompt);

        // Wait up to 4.5s for Muse.ai to acknowledge thread creation before letting the next stream on the same account send
        const ackDeadline = Date.now() + 4500;
        while (Date.now() < ackDeadline) {
          await new Promise((r) => setTimeout(r, 500));
          const hrefNow = String((await cdp.evaluate("location.href")) || "");
          const stNow = (await cdp.evaluate(JS_POLL_AGENT_STATUS)) || {};
          if (
            (!hrefNow.endsWith("/thread/new") && hrefNow.includes("/thread/")) ||
            stNow.stop ||
            Number(stNow.cnt || 0) > baseAgentCnt
          ) {
            break;
          }
        }
      });

      this.log(
        `[${account.name}] [Luồng #${(streamSlot || 0) + 1}] Đã gửi lệnh vào ô chat Muse.ai${
          isLongVideo ? ` (Yêu cầu tạo ${clipCount10s} phân cảnh & ghép video ${targetDurationSec}s)` : ""
        }, đang chờ render...`
      );

      const baseTimeoutSec =
        expect === "video"
          ? Number(this.store.settings.videoTimeout || 600)
          : Number(this.store.settings.genTimeout || 240);
      // Scale timeout when multiple parallel streams share the same Muse VM so queued streams never time out early
      const multiStreamExtraSec = Math.max(0, this.activeCount - 1) * 420;
      const timeoutSec =
        (isLongVideo ? Math.max(baseTimeoutSec, targetDurationSec * 35, 900) : baseTimeoutSec) +
        multiStreamExtraSec;
      const deadline = Date.now() + timeoutSec * 1000;
      const tStart = Date.now();
      let lastSendTime = Date.now();
      let resendAttempts = 0;
      let lastFollowUpCmd = "";

      let matchedAtt = null;
      let stableSrc = "";
      let stableN = 0;
      let lastTxt = "";
      let txtStable = 0;
      let extractedProductTitle = "";

      // State for >10s multi-clip & stitching workflow
      const knownClipDurations = new Map();
      const preStitchSources = new Set();
      let storyboardCmdCount = 0;
      let stitchCmdCount = 0;
      let agentIdleTicks = 0;
      let postMediaIdleTicks = 0;
      let unhydratedIdleTicks = 0;
      let lastDomSig = "";
      let staleDomTicks = 0;
      let pollTick = 0;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 900));
        pollTick += 1;
        if (pollTick % 10 === 0) {
          await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
          await cdp.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
        }
        await cdp.evaluate(JS_SCROLL_BOTTOM);

        const elapsedSec = Math.round((Date.now() - tStart) / 1000);
        const sinceSendSec = Math.round((Date.now() - lastSendTime) / 1000);
        const progPct = Math.min(92, Math.round(36 + elapsedSec * 0.45));

        const st = (await cdp.evaluate(JS_POLL_AGENT_STATUS)) || {};
        if (st.productTitle && !extractedProductTitle) {
          extractedProductTitle = String(st.productTitle).trim();
        }
        const tail = String(st.tail || "");
        const curCnt = Number(st.cnt || 0);
        const curTxt = String(st.txt || "").trim();
        const statusStep = String(st.statusStep || "").trim();
        const hasStop = Boolean(st.stop);

        if (/额度不足|积分不足|out of credits|达到上限|token limit/i.test(tail)) {
          throw new Error("Ních Muse.ai đã hết hạn mức (Out of credits / Token limit)");
        }

        const isStillSending =
          !hasStop && /Still sending|Delivery not confirmed|正在发送|未确认送达/i.test(tail);

        // Auto-recover & re-send if initial prompt or follow-up command gets stuck in "Still sending"
        if (isStillSending && sinceSendSec >= 18) {
          const clickedRetry = await this._tryClickRetrySendButton(cdp);
          if (clickedRetry) {
            this.log(
              `[${account.name}] [Luồng #${(streamSlot || 0) + 1}] 🔄 Tự động bấm nút Gửi lại (Retry) trên Muse.ai...`
            );
            lastSendTime = Date.now();
            await new Promise((r) => setTimeout(r, 3200));
            continue;
          }

          if (curCnt <= baseAgentCnt && resendAttempts < 4) {
            resendAttempts += 1;
            this.log(
              `[${account.name}] [Luồng #${(streamSlot || 0) + 1}] 🔄 Phát hiện lệnh chờ gửi ("Still sending"), đang tự động làm mới kết nối & gửi lại câu lệnh (Lần ${resendAttempts}/4)...`
            );
            reportProgress(
              Math.min(45, progPct),
              `Đang tự động làm mới kết nối & gửi lại lệnh (Lần ${resendAttempts}/4)...`
            );
            await this._withAccountSendLock(account.id, async () => {
              await cdp.send("Page.navigate", { url: MUSE_NEW_THREAD });
              await new Promise((r) => setTimeout(r, 1800));
              await this._waitWsReady(cdp, 25000);
              if (validRefImgs.length > 0) {
                await this._attachReferenceImages(cdp, validRefImgs);
              }
              const attsNow = (await cdp.evaluate(JS_GET_ATTACHMENTS)) || [];
              baselineSources.clear();
              for (const a of attsNow) {
                if (a.src) baselineSources.add(a.src);
                if (a.vSrc) baselineSources.add(a.vSrc);
                if (a.iSrc) baselineSources.add(a.iSrc);
              }
              const agentNow = (await cdp.evaluate(JS_POLL_AGENT_STATUS)) || { cnt: 0 };
              baseAgentCnt = Number(agentNow.cnt || 0);
              await this._sendPromptToMuse(cdp, finalPrompt);
              await new Promise((r) => setTimeout(r, 2500));
            });
            lastSendTime = Date.now();
            unhydratedIdleTicks = 0;
            staleDomTicks = 0;
            continue;
          } else if (curCnt > baseAgentCnt && lastFollowUpCmd && resendAttempts < 4) {
            resendAttempts += 1;
            this.log(
              `[${account.name}] [Luồng #${(streamSlot || 0) + 1}] 🔄 Tự động gửi lại lệnh ghép video (Lần ${resendAttempts}/4)...`
            );
            await this._withAccountSendLock(account.id, async () => {
              await cdp.send("Page.reload").catch(() => {});
              await new Promise((r) => setTimeout(r, 2600));
              await this._waitWsReady(cdp, 20000).catch(() => {});
              await this._sendPromptToMuse(cdp, lastFollowUpCmd);
            });
            lastSendTime = Date.now();
            continue;
          }
        }

        const atts = (await cdp.evaluate(JS_GET_ATTACHMENTS)) || [];
        const newMatchingAtts = [];

        for (const a of atts) {
          const tid = String(a.tid || "").toLowerCase();
          const hasVideo = Boolean(a.hasVideo);
          const src = a.src || "";
          const vSrc = a.vSrc || "";
          let isMatch = false;
          if (expect === "video") {
            isMatch =
              hasVideo ||
              Boolean(vSrc) ||
              src.endsWith(".mp4") ||
              src.endsWith(".webm") ||
              src.endsWith(".mov");
          } else {
            isMatch =
              tid.includes("image") ||
              (!hasVideo &&
                !src.endsWith(".mp4") &&
                !src.endsWith(".webm") &&
                !src.endsWith(".mov"));
          }
          if (!isMatch) continue;

          const checkSrc =
            expect === "video"
              ? vSrc ||
                (src.endsWith(".mp4") || src.endsWith(".webm") || src.endsWith(".mov") ? src : "")
              : src;
          if (checkSrc && !baselineSources.has(checkSrc)) {
            newMatchingAtts.push({ ...a, checkSrc });
          }
        }

        const curDomSig = `${curCnt}:${curTxt.length}:${statusStep}:${newMatchingAtts.length}:${hasStop ? 1 : 0}`;
        if (curDomSig === lastDomSig) {
          staleDomTicks += 1;
        } else {
          lastDomSig = curDomSig;
          staleDomTicks = 0;
        }

        // If the agent finished on the VM (!hasStop) after 35s+ without hydrating attachments,
        // OR if the DOM hasn't received a WebSocket delta for ~65s (staleDomTicks >= 68) during multi-window parallel run,
        // reload the thread page so server-persisted attachments & messages immediately hydrate into the DOM!
        const shouldReloadUnhydrated =
          !hasStop && newMatchingAtts.length === 0 && curCnt <= baseAgentCnt && sinceSendSec > 35;
        if (shouldReloadUnhydrated) {
          unhydratedIdleTicks += 1;
        } else {
          unhydratedIdleTicks = 0;
        }

        if (unhydratedIdleTicks >= 5 || (staleDomTicks >= 68 && sinceSendSec > 60)) {
          unhydratedIdleTicks = 0;
          staleDomTicks = 0;
          const curHref = String((await cdp.evaluate("location.href")) || "");
          if (curHref.endsWith("/thread/new") && curCnt <= baseAgentCnt && resendAttempts < 4) {
            resendAttempts += 1;
            this.log(
              `[${account.name}] [Luồng #${(streamSlot || 0) + 1}] 🔄 Luồng /thread/new chưa khởi tạo trên máy chủ, tự động gửi lại câu lệnh (Lần ${resendAttempts}/4)...`
            );
            await this._withAccountSendLock(account.id, async () => {
              await cdp.send("Page.navigate", { url: MUSE_NEW_THREAD });
              await new Promise((r) => setTimeout(r, 1800));
              await this._waitWsReady(cdp, 25000);
              if (validRefImgs.length > 0) {
                await this._attachReferenceImages(cdp, validRefImgs);
              }
              await this._sendPromptToMuse(cdp, finalPrompt);
              await new Promise((r) => setTimeout(r, 2500));
            });
            lastSendTime = Date.now();
            continue;
          }

          this.log(
            `[${account.name}] [Luồng #${(streamSlot || 0) + 1}] Làm mới đồng bộ luồng Muse.ai để nhận trạng thái/video mới nhất từ máy chủ...`
          );
          if (this.store.settings.showChromeWindow !== false) {
            await cdp.send("Page.bringToFront").catch(() => {});
          }
          await cdp.send("Page.reload").catch(() => {});
          await new Promise((r) => setTimeout(r, 3200));
          await this._waitWsReady(cdp, 18000).catch(() => {});
          continue;
        }

        // ==================== FAST PATH: IMAGE OR SHORT VIDEO (<= 10s) ====================
        if (!isLongVideo) {
          const att = newMatchingAtts.length ? newMatchingAtts[newMatchingAtts.length - 1] : null;
          if (att) {
            const w = Number(att.w || 0);
            const h = Number(att.h || 0);
            if (att.checkSrc === stableSrc) {
              stableN += 1;
            } else {
              stableSrc = att.checkSrc;
              stableN = 0;
            }
            if (!hasStop) {
              postMediaIdleTicks += 1;
            } else {
              postMediaIdleTicks = 0;
            }
            // Wait until Chrome's agent has finished its turn (!hasStop for >= 3 ticks) and media is ready
            if (!hasStop && postMediaIdleTicks >= 3 && ((w > 0 && h > 0) || stableN >= 3)) {
              matchedAtt = att;
              break;
            }
          } else {
            postMediaIdleTicks = 0;
          }

          const stepInfo = curTxt
            ? ` · "${curTxt.slice(0, 40)}..."`
            : statusStep
            ? ` · ${statusStep.slice(0, 45)}`
            : "";
          reportProgress(
            progPct,
            `Muse.ai đang tạo ${expect === "video" ? "Video" : "Ảnh"} (${elapsedSec}s)${stepInfo}`
          );

          if (curCnt > baseAgentCnt && curTxt && !hasStop && newMatchingAtts.length === 0) {
            const isMediaReport = /\.(?:webp|png|jpe?g|mp4|webm)|imagine_media|deliverable|generated\s+.*image|verified\s+generated|artifact|video/i.test(
              curTxt
            );
            if (!isMediaReport) {
              if (curTxt === lastTxt) {
                txtStable += 1;
              } else {
                lastTxt = curTxt;
                txtStable = 0;
              }
              if (txtStable >= 12 && elapsedSec > 10) {
                throw new Error(
                  `Muse.ai chỉ trả lời văn bản, không tạo ${expect}: "${curTxt.slice(0, 120)}"`
                );
              }
            } else {
              txtStable = 0;
            }
          } else {
            txtStable = 0;
          }
          continue;
        }

        // ==================== LONG VIDEO (> 10s): MULTI-CLIP & AUTO STITCH COMMAND ====================
        for (const item of newMatchingAtts) {
          const cSrc = item.checkSrc;
          let d = Number(item.dur || 0);
          if (!d && (!knownClipDurations.has(cSrc) || knownClipDurations.get(cSrc) === 0)) {
            d = await this._probeVideoDuration(cdp, cSrc);
          }
          if (d > 0 || !knownClipDurations.has(cSrc)) {
            knownClipDurations.set(cSrc, d);
          }
        }

        const latestAtt = newMatchingAtts.length
          ? newMatchingAtts[newMatchingAtts.length - 1]
          : null;
        if (latestAtt) {
          const latestSrc = latestAtt.checkSrc;
          const latestDur = knownClipDurations.get(latestSrc) || Number(latestAtt.dur || 0);

          if (latestSrc === stableSrc) {
            stableN += 1;
          } else {
            stableSrc = latestSrc;
            stableN = 0;
          }

          if (!hasStop) {
            postMediaIdleTicks += 1;
          } else {
            postMediaIdleTicks = 0;
          }

          // 1. Did we receive a stitched video whose duration meets the >10s target (>= 72% of targetDurationSec)
          //    AND Chrome has completely finished its turn (!hasStop for >= 4 consecutive ticks)?
          if (!hasStop && postMediaIdleTicks >= 4 && latestDur >= targetDurationSec * 0.72) {
            this.log(
              `[${account.name}] [Luồng #${(streamSlot || 0) + 1}] ✅ Đã nhận được Video ghép hoàn chỉnh dài ${latestDur}s (Mục tiêu: ${targetDurationSec}s)!`
            );
            matchedAtt = latestAtt;
            break;
          }

          // 2. Did Muse output a brand-new stitched video AFTER our explicit stitch command (sent when clips already existed)
          //    AND finish its turn completely (!hasStop for >= 5 ticks)?
          const minStitchedDur = minStitchedDurationSec(targetDurationSec);
          if (
            stitchCmdCount > 0 &&
            !preStitchSources.has(latestSrc) &&
            !hasStop &&
            postMediaIdleTicks >= 5 &&
            (latestDur >= minStitchedDur ||
              (stitchCmdCount >= 2 && latestDur === 0 && stableN >= 5))
          ) {
            this.log(
              `[${account.name}] [Luồng #${(streamSlot || 0) + 1}] ✅ Muse.ai đã hoàn tất lệnh ghép video và xuất file mới (${
                latestDur ? latestDur + "s" : "MP4 hoàn chỉnh"
              })!`
            );
            matchedAtt = latestAtt;
            break;
          }
        } else {
          postMediaIdleTicks = 0;
        }

        const clipCnt = newMatchingAtts.length;
        const sumDur = newMatchingAtts.reduce((acc, item) => {
          const d = knownClipDurations.get(item.checkSrc) || Number(item.dur || 0);
          return acc + (d > 0 ? d : 6);
        }, 0);

        if (hasStop) {
          agentIdleTicks = 0;
          const snippet = curTxt
            ? ` · "${curTxt.slice(0, 35)}..."`
            : statusStep
            ? ` · ${statusStep.slice(0, 42)}`
            : "";
          reportProgress(
            progPct,
            clipCnt > 0
              ? `Muse đang tạo & ghép video ${targetDurationSec}s (Đã có ${clipCnt} clip ~${Math.round(
                  sumDur
                )}s · ${elapsedSec}s)`
              : `Muse đang tạo phân cảnh cho video ${targetDurationSec}s (${elapsedSec}s)${snippet}`
          );
          continue;
        }

        // Muse agent is currently idle (!hasStop) — wait 6 consecutive idle ticks (~5.5s) before sending a follow-up command
        // so we never interrupt Muse while it transitions between generating clips and running FFmpeg.
        if (curCnt > baseAgentCnt || clipCnt > 0) {
          agentIdleTicks += 1;
        }

        if (agentIdleTicks >= 6) {
          agentIdleTicks = 0;

          const titleReminder =
            productRefImg && !extractedProductTitle
              ? ` Đồng thời BẮT BUỘC in kèm dòng [[PRODUCT_TITLE: tên sản phẩm chính xác 100% hiển thị trong ảnh đính kèm]] (hoặc [[PRODUCT_TITLE: NONE]] nếu ảnh không có chữ tiêu đề) trong câu trả lời!`
              : "";

          if (clipCnt === 0 && storyboardCmdCount < 2) {
            storyboardCmdCount += 1;
            const followUpCmd =
              `Hãy tiến hành tạo ngay tất cả các đoạn video cho các phân cảnh trên (tổng thời lượng ${targetDurationSec} giây, tỉ lệ ${aspectRatio}), ` +
              `sau đó BẮT BUỘC dùng công cụ ffmpeg ghép nối (concatenate/stitch) toàn bộ các đoạn video lại thành 1 file video MP4 hoàn chỉnh duy nhất dài ${targetDurationSec} giây (final_stitched_${targetDurationSec}s.mp4) và gửi file video MP4 hoàn chỉnh lên khung chat!${titleReminder}`;
            reportProgress(
              Math.min(86, progPct),
              `🎬 Đang ra lệnh cho Muse bắt đầu render các cảnh & ghép video ${targetDurationSec}s...`
            );
            this.log(
              `[${account.name}] [Luồng #${(streamSlot || 0) + 1}] 🎬 Muse vừa viết kịch bản chữ. Đang gửi lệnh bắt buộc render & ghép video ${targetDurationSec}s (Lần ${storyboardCmdCount})...`
            );
            lastFollowUpCmd = followUpCmd;
            await this._withAccountSendLock(account.id, async () => {
              await this._sendPromptToMuse(cdp, followUpCmd);
            });
            lastSendTime = Date.now();
            postMediaIdleTicks = 0;
            await new Promise((r) => setTimeout(r, 2500));
            continue;
          }

          if (clipCnt > 0 && stitchCmdCount < 3) {
            for (const item of newMatchingAtts) {
              preStitchSources.add(item.checkSrc);
            }
            stitchCmdCount += 1;

            let followUpCmd = "";
            if (
              sumDur < targetDurationSec * 0.72 &&
              clipCnt < clipCount10s &&
              stitchCmdCount === 1
            ) {
              // Muse only generated 1 or too few clips (~5s-10s) and stopped
              followUpCmd =
                `Hiện tại mới có ${clipCnt} đoạn video ngắn (~${Math.round(
                  sumDur
                )} giây), chưa đủ độ dài ${targetDurationSec} giây đã chọn. ` +
                `Hãy tạo tiếp các phân cảnh nối tiếp theo đúng kịch bản cho đủ tổng thời lượng ${targetDurationSec} giây, ` +
                `sau đó BẮT BUỘC dùng lệnh ffmpeg ghép nối (concatenate/stitch) tất cả các đoạn video vừa tạo theo đúng thứ tự thành 1 file video MP4 hoàn chỉnh duy nhất dài ${targetDurationSec} giây (final_stitched_${targetDurationSec}s.mp4) và đính kèm file video hoàn chỉnh đó lên khung chat!${titleReminder}`;
              reportProgress(
                Math.min(88, progPct),
                `🎬 Đang ra lệnh cho Muse tạo thêm cảnh & ghép thành video ${targetDurationSec}s hoàn chỉnh...`
              );
              this.log(
                `[${account.name}] [Luồng #${(streamSlot || 0) + 1}] 🎬 Mới có ${clipCnt} clip (~${Math.round(
                  sumDur
                )}s). Đang ra lệnh tạo tiếp & dùng FFmpeg ghép video ${targetDurationSec}s hoàn chỉnh (Lần ${stitchCmdCount})...`
              );
            } else {
              // Muse generated the clips and stopped before stitching them — send explicit Stitch Command!
              followUpCmd =
                `Bây giờ hãy ghép nối tất cả ${clipCnt} đoạn video vừa tạo ở trên theo đúng thứ tự thành 1 video MP4 hoàn chỉnh duy nhất dài ${targetDurationSec} giây! ` +
                `(Please run ffmpeg right now in your workspace to concatenate/stitch all ${clipCnt} generated video clips above in sequential order into ONE single seamless final MP4 video file named final_stitched_${targetDurationSec}s.mp4, and attach/present that final stitched MP4 video in the chat!)${titleReminder}`;
              reportProgress(
                Math.min(90, progPct),
                `🎬 Đang ra lệnh cho Muse ghép nối ${clipCnt} đoạn clip thành 1 video ${targetDurationSec}s hoàn chỉnh...`
              );
              this.log(
                `[${account.name}] [Luồng #${(streamSlot || 0) + 1}] 🎬 Đã có ${clipCnt} clip (~${Math.round(
                  sumDur
                )}s). Đang ra lệnh cho Muse ghép nối thành 1 video ${targetDurationSec}s hoàn chỉnh (Lần ${stitchCmdCount})...`
              );
            }

            lastFollowUpCmd = followUpCmd;
            await this._withAccountSendLock(account.id, async () => {
              await this._sendPromptToMuse(cdp, followUpCmd);
            });
            lastSendTime = Date.now();
            postMediaIdleTicks = 0;
            await new Promise((r) => setTimeout(r, 2500));
            continue;
          } else if (latestAtt && stitchCmdCount >= 3 && postMediaIdleTicks >= 8) {
            // Fallback only after 3 stitch commands have completely finished on Chrome and been idle for >= 8 ticks
            this.log(
              `[${account.name}] [Luồng #${(streamSlot || 0) + 1}] ⚠️ Đã hoàn tất ${stitchCmdCount} lệnh ghép video trên Chrome, lấy file video mới nhất từ Muse.ai.`
            );
            matchedAtt = latestAtt;
            break;
          }
        }
      }

      if (!matchedAtt) {
        throw new Error(
          `Quá thời gian chờ (${timeoutSec}s) nhưng Muse.ai chưa trả về file ${expect} mới.`
        );
      }

      if (productRefImg && !extractedProductTitle) {
        reportProgress(94, "Đang đọc tên sản phẩm từ ảnh để đặt tên file Video...");
        extractedProductTitle = await this._extractProductTitleFallback(cdp, productRefImg);
      }
      const preferredMediaTitle = productRefImg
        ? this._normalizeProductVideoTitle(extractedProductTitle, fallbackProductFileBase)
        : "";
      if (preferredMediaTitle) {
        this.log(
          `[${account.name}] 🏷️ Đặt tên file ${expect.toUpperCase()} theo ảnh sản phẩm: "${preferredMediaTitle}"`
        );
      }

      reportProgress(95, `Đang tải file ${expect === "video" ? "Video" : "Ảnh"} về máy...`);
      const selectedSrc =
        (expect === "video" ? matchedAtt.vSrc : null) || matchedAtt.src || "";
      const saved = await this._saveMediaFromAttachment(
        cdp,
        selectedSrc,
        expect,
        preferredMediaTitle
      );

      await this._syncRefreshedCookies(cdp, account, "RUNNING");
      this.store.markLive(account.id, { vm_state: "RUNNING" });

      if (expect === "video") {
        const resultPayload = {
          video: { url: saved.url, filename: saved.filename, size: saved.size },
          productTitle: preferredMediaTitle,
        };
        this.store.finishTask(task.id, resultPayload);
        this.log(`[${account.name}] 🎉 Tạo VIDEO thành công: ${saved.filename}`);
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
        this.log(`[${account.name}] 🎉 Tạo ẢNH thành công: ${saved.filename}`);
        return {
          taskId: task.id,
          accountId: account.id,
          accountName: account.name,
          productTitle: preferredMediaTitle,
          images: [saved],
        };
      }
    } catch (err) {
      this.log(`[${account.name}] ❌ Lỗi tạo ${expect}: ${err.message}`, "error");
      this.store.markFail(account.id, err.message);
      this.store.finishTask(task.id, null, err.message);
      throw err;
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
      await this._closeSessionPage(session);
    }
  }

  async generateImage(opts) {
    return this._generateMedia({ ...opts, expect: "image" });
  }

  async generateVideo(opts) {
    const refImgs = opts.referenceImage
      ? [opts.referenceImage]
      : Array.isArray(opts.referenceImages)
      ? opts.referenceImages
      : [];
    return this._generateMedia({ ...opts, referenceImages: refImgs, expect: "video" });
  }

  async chatCompletion({ prompt, model = "muse-spark", onDelta = null }) {
    let account = this.store.pickAccount();
    if (!account) {
      const synced = await this.syncActiveBrowserSession({ force: true }).catch(() => null);
      if (synced && synced.account) {
        account = synced.account;
      }
    }
    if (!account) {
      throw new Error(
        "Chưa có ních Muse.ai nào đang LIVE. Vui lòng thêm hoặc kiểm tra ních ở mục [Ních Muse.ai]."
      );
    }

    const task = this.store.createTask("chat", prompt, model, account.id);
    this.activeCount += 1;
    let session = null;

    try {
      session = await this._openSessionPage(account, MUSE_NEW_THREAD, { reuseMainTab: true });
      const { cdp } = session;

      const ready = await this._waitWsReady(cdp, 22000);
      if (!ready.ok) {
        if (ready.state === "logged-out") {
          this.store.markDie(account.id, ready.reason);
        } else {
          this.store.markFail(account.id, ready.reason);
        }
        throw new Error(ready.reason);
      }

      const beforeSt = (await cdp.evaluate(JS_POLL_AGENT_STATUS)) || { cnt: 0, txt: "" };
      const baseAgent = Number(beforeSt.cnt || 0);
      const baseText = String(beforeSt.txt || "").trim();

      await this._sendPromptToMuse(cdp, prompt);

      const timeoutMs = Number(this.store.settings.genTimeout || 240) * 1000;
      const start = Date.now();
      let sent = "";
      let last = "";
      let stable = 0;

      while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 250));
        await cdp.evaluate(JS_SCROLL_BOTTOM);
        const st = (await cdp.evaluate(JS_POLL_AGENT_STATUS)) || {};
        const cnt = Number(st.cnt || 0);
        const cur = String(st.txt || "").trim();
        const hasStop = Boolean(st.stop);

        if (!cur || (cnt <= baseAgent && cur === baseText)) {
          continue;
        }

        if (cur !== last) {
          const delta = cur.startsWith(sent) ? cur.slice(sent.length) : cur;
          if (delta) {
            sent = cur;
            if (typeof onDelta === "function") onDelta(delta);
          }
          last = cur;
          stable = 0;
        } else {
          stable += 1;
          if (!hasStop && stable >= 4 && sent.length > 0) {
            break;
          }
        }
      }

      if (!sent) {
        throw new Error("Không nhận được phản hồi văn bản từ Muse.ai");
      }

      await this._syncRefreshedCookies(cdp, account, "RUNNING");
      this.store.markLive(account.id, { vm_state: "RUNNING" });
      this.store.finishTask(task.id, { text: sent });
      return { text: sent, taskId: task.id, accountId: account.id };
    } catch (err) {
      this.store.markFail(account.id, err.message);
      this.store.finishTask(task.id, null, err.message);
      throw err;
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
      await this._closeSessionPage(session);
    }
  }
}

module.exports = {
  MuseEngine,
  resolveModel,
  findChromeBinary,
  MODEL_ALIASES,
  minStitchedDurationSec,
};
