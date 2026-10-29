"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ESSENTIAL_COOKIES = [
  "hatch_sess",
  "hatch_gw",
  "hatch_vml",
  "hatch_native_auth_device",
];

function defaultCookieDomain(name, rawDomain) {
  const dom = String(rawDomain || "").trim();
  const cname = String(name || "").trim();
  if (
    cname.startsWith("hatch_native_auth_") ||
    cname.startsWith("__Host-") ||
    cname === "theme"
  ) {
    return "muse.ai";
  }
  if (dom) {
    return dom === "muse.ai" ? ".muse.ai" : dom;
  }
  return ".muse.ai";
}

function parseCookieInput(raw, expiresMap = null) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (raw.name && raw.value !== undefined) {
      return [
        {
          name: String(raw.name),
          value: String(raw.value),
          domain: defaultCookieDomain(raw.name, raw.domain),
          path: raw.path || "/",
          secure: true,
          httpOnly:
            raw.httpOnly !== undefined
              ? Boolean(raw.httpOnly)
              : ["hatch_sess", "hatch_vml", "hatch_native_auth_device"].includes(String(raw.name)),
          expires: Number(raw.expires || raw.expirationDate || (expiresMap && expiresMap[raw.name]) || 0),
        },
      ];
    }
    return Object.entries(raw)
      .filter(([k, v]) => k && v !== undefined && v !== null)
      .map(([k, v]) => ({
        name: String(k),
        value: String(v),
        domain: defaultCookieDomain(k, ""),
        path: "/",
        secure: true,
        httpOnly: ["hatch_sess", "hatch_vml", "hatch_native_auth_device"].includes(String(k)),
        expires: Number((expiresMap && expiresMap[k]) || 0),
      }));
  }

  raw = String(raw || "").trim();
  if (!raw) return [];

  if (raw.startsWith("[")) {
    try {
      const items = JSON.parse(raw);
      return items
        .filter((c) => c && typeof c === "object" && c.name && c.value !== undefined)
        .map((c) => {
          const d = {
            name: String(c.name),
            value: String(c.value),
            domain: defaultCookieDomain(c.name, c.domain),
            path: c.path || "/",
            secure: c.secure !== undefined ? Boolean(c.secure) : true,
            httpOnly:
              c.httpOnly !== undefined
                ? Boolean(c.httpOnly)
                : ["hatch_sess", "hatch_vml", "hatch_native_auth_device"].includes(String(c.name)),
          };
          for (const k of ["sameSite", "expires", "expirationDate"]) {
            if (c[k] !== undefined) d[k] = c[k];
          }
          if (!d.expires && d.expirationDate) {
            d.expires = Number(d.expirationDate);
          }
          if (!d.expires && expiresMap && expiresMap[c.name]) {
            d.expires = Number(expiresMap[c.name]);
          }
          return d;
        });
    } catch (_err) {
      // fallthrough
    }
  }

  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw);
      return parseCookieInput(obj, expiresMap);
    } catch (_err) {
      // fallthrough
    }
  }

  const cookies = [];
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (trimmed.includes("=")) {
      const idx = trimmed.indexOf("=");
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim();
      if (k) {
        cookies.push({
          name: k,
          value: v,
          domain: defaultCookieDomain(k, ""),
          path: "/",
          secure: true,
          httpOnly: ["hatch_sess", "hatch_vml", "hatch_native_auth_device"].includes(k),
          expires: Number((expiresMap && expiresMap[k]) || 0),
        });
      }
    }
  }
  return cookies;
}

function getCookieFingerprint(cookies) {
  const sessCookie = (cookies || []).find((c) => c && c.name === "hatch_sess" && c.value);
  if (sessCookie) {
    return crypto
      .createHash("sha256")
      .update(`hatch_sess=${sessCookie.value}`)
      .digest("hex")
      .slice(0, 16);
  }
  const names = new Set(ESSENTIAL_COOKIES);
  const parts = [];
  const sorted = [...(cookies || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  for (const c of sorted) {
    if (names.has(c.name)) {
      parts.push(`${c.name}=${c.value || ""}`);
    }
  }
  if (parts.length === 0) {
    for (const c of sorted) {
      parts.push(`${c.name || ""}=${c.value || ""}`);
    }
  }
  const raw = parts.join(";");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function getCookieExpires(cookies) {
  for (const c of cookies || []) {
    const exp = Number(c.expires || c.expirationDate || 0);
    if (c.name === "hatch_vml" && exp > 0) {
      return exp;
    }
  }
  let minExp = 0;
  for (const c of cookies || []) {
    const exp = Number(c.expires || c.expirationDate || 0);
    if (exp > 0 && (minExp === 0 || exp < minExp)) {
      minExp = exp;
    }
  }
  return minExp;
}

function getMissingEssentialCookies(cookies) {
  const present = new Set(
    (cookies || []).filter((c) => c && c.name && c.value).map((c) => c.name)
  );
  return ESSENTIAL_COOKIES.filter((name) => !present.has(name));
}

class Store {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    // When the host provides an OS-keychain-backed secure store (Electron safeStorage),
    // account cookies (full session access) are encrypted at rest in accounts.enc.
    // Without it (raw CLI/tests) we keep the legacy plaintext accounts.json behaviour.
    const ss = options.secureStore;
    this.secureStore = ss && ss.available ? ss : null;
    this.mediaDir = path.join(dataDir, "media");
    this.accountsFile = path.join(dataDir, "accounts.json");
    this.accountsEncFile = path.join(dataDir, "accounts.enc");
    this.tasksFile = path.join(dataDir, "tasks.json");
    this.settingsFile = path.join(dataDir, "settings.json");
    this.batchRowsFile = path.join(dataDir, "batch-rows.json");

    fs.mkdirSync(this.mediaDir, { recursive: true });

    this.accounts = this._loadAccounts();
    this.tasks = this._loadJson(this.tasksFile, []);
    this.settings = this._loadJson(this.settingsFile, {
      apiKey: "",
      port: 18638,
      maxConcurrency: 2,
      genTimeout: 240,
      videoTimeout: 600,
      keepaliveIntervalMinutes: 360,
      defaultAspectRatio: "9:16",
      defaultDuration: "20s",
      defaultQuality: "4K",
      defaultMode: "video",
      exportDir: "",
      autoKeepalive: true,
      showChromeWindow: false,
      headlessMode: true,
      geminiApiKey: "",
      geminiModel: "gemini-2.5-flash",
    });
    if (this.settings.showChromeWindow === undefined) {
      this.settings.showChromeWindow = false;
    }
    if (this.settings.headlessMode === undefined) {
      this.settings.headlessMode = true;
    }
    if (!this.settings.defaultQuality) {
      this.settings.defaultQuality = "4K";
    }
    if (!this.settings.geminiModel) {
      this.settings.geminiModel = "gemini-2.5-flash";
    }
    this.batchRows = this._loadJson(this.batchRowsFile, []);

    if (!this.settings.apiKey) {
      this.settings.apiKey = "sk-muse-" + crypto.randomBytes(12).toString("hex");
      this._saveJson(this.settingsFile, this.settings);
    }

    let accountsChanged = false;
    const usedPorts = new Set();
    for (let idx = 0; idx < this.accounts.length; idx += 1) {
      const acc = this.accounts[idx];
      if (Array.isArray(acc.cookies)) {
        for (const c of acc.cookies) {
          if (c && c.name) {
            const expectedDom = defaultCookieDomain(c.name, c.domain);
            if (c.domain !== expectedDom) {
              c.domain = expectedDom;
              accountsChanged = true;
            }
          }
        }
      }
      if (!acc.fingerprint) {
        acc.fingerprint = getCookieFingerprint(acc.cookies || []);
        accountsChanged = true;
      }
      if (acc.cookie_expires === undefined) {
        acc.cookie_expires = getCookieExpires(acc.cookies || []);
        accountsChanged = true;
      }
      if (!acc.quota) {
        acc.quota = {};
      }
      // Normalize legacy status & recover accounts falsely marked DIE by non-auth errors (e.g. Still sending / timeout)
      if (acc.status === "invalid") {
        acc.status = "die";
        accountsChanged = true;
      }
      if (acc.status === "die") {
        const missing = getMissingEssentialCookies(acc.cookies || []);
        const nowSec = Date.now() / 1000;
        const expSec = Number(acc.cookie_expires || 0);
        const notExpired = !expSec || expSec > nowSec;
        const errLower = String(acc.last_error || "").toLowerCase();
        const isAuthFailure =
          errLower.includes("401") ||
          errLower.includes("403") ||
          errLower.includes("sign in") ||
          errLower.includes("log in") ||
          errLower.includes("create an account") ||
          errLower.includes("unauthorized") ||
          errLower.includes("đăng xuất") ||
          errLower.includes("hết hạn") ||
          errLower.includes("unassigned") ||
          errLower.includes("thiếu cookie");
        if (missing.length === 0 && notExpired && !isAuthFailure) {
          acc.status = "live";
          acc.verified_live = true;
          acc.fail_count = 0;
          acc.last_error = "";
          accountsChanged = true;
        }
      }
      let port = Number(acc.cdp_port || 0);
      if (!port || usedPorts.has(port)) {
        port = 9225 + idx;
        while (usedPorts.has(port)) port += 1;
        acc.cdp_port = port;
        accountsChanged = true;
      }
      usedPorts.add(port);
    }
    if (accountsChanged) {
      this.saveAccounts();
    }

    let tasksChanged = false;
    for (const t of this.tasks) {
      if (t && t.status === "running") {
        t.status = "failed";
        t.error = "Đã hủy do khởi động lại ứng dụng";
        tasksChanged = true;
      }
    }
    if (tasksChanged) {
      this.saveTasks();
    }
  }

  allocateNextCdpPort(basePort = 9225, reservedPorts = null) {
    const used = new Set(
      this.accounts.map((a) => Number(a.cdp_port || 0)).filter((p) => p > 0)
    );
    if (reservedPorts) {
      for (const p of reservedPorts) {
        if (Number(p) > 0) used.add(Number(p));
      }
    }
    let port = Number(basePort || 9225);
    while (used.has(port)) {
      port += 1;
    }
    return port;
  }

  _nextAutoAccountName() {
    let idx = this.accounts.length + 1;
    const names = new Set(this.accounts.map((a) => String(a.name || "").trim()));
    while (names.has(`Ních Muse #${idx}`)) {
      idx += 1;
    }
    return `Ních Muse #${idx}`;
  }

  _loadJson(filePath, fallback) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
      }
    } catch (_err) {
      // return fallback
    }
    return fallback;
  }

  _saveJson(filePath, data) {
    try {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmp, filePath);
    } catch (_err) {
      try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
      } catch (_err2) {
        // ignore
      }
    }
  }

  _backupCorruptFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      }
    } catch (_err) {
      // ignore
    }
  }

  _writeAccountsEncrypted(accounts) {
    const enc = this.secureStore.encrypt(JSON.stringify(accounts, null, 2));
    const tmp = `${this.accountsEncFile}.tmp`;
    fs.writeFileSync(tmp, enc);
    fs.renameSync(tmp, this.accountsEncFile);
  }

  _loadAccounts() {
    if (!this.secureStore) {
      return this._loadJson(this.accountsFile, []);
    }
    if (fs.existsSync(this.accountsEncFile)) {
      try {
        return JSON.parse(this.secureStore.decrypt(fs.readFileSync(this.accountsEncFile)));
      } catch (_err) {
        // Keep the unreadable file for recovery instead of silently wiping accounts.
        this._backupCorruptFile(this.accountsEncFile);
        return [];
      }
    }
    // One-time migration of a legacy plaintext accounts.json to encrypted-at-rest.
    const legacy = this._loadJson(this.accountsFile, null);
    if (Array.isArray(legacy)) {
      try {
        this._writeAccountsEncrypted(legacy);
        fs.rmSync(this.accountsFile, { force: true });
      } catch (_err) {
        // ignore; the plaintext file stays as the source of truth until encryption succeeds
      }
      return legacy;
    }
    return [];
  }

  saveAccounts() {
    if (this.secureStore) {
      try {
        this._writeAccountsEncrypted(this.accounts);
        return;
      } catch (_err) {
        // ponytail: never lose accounts on an encrypt failure; fall back to plaintext.
        // Upgrade path: surface this to the UI so the user knows cookies aren't encrypted.
      }
    }
    this._saveJson(this.accountsFile, this.accounts);
  }

  saveTasks() {
    this._saveJson(this.tasksFile, this.tasks.slice(-500));
  }

  saveSettings(partial = {}) {
    this.settings = { ...this.settings, ...partial };
    this._saveJson(this.settingsFile, this.settings);
    return this.settings;
  }

  saveBatchRows(rows) {
    if (Array.isArray(rows)) {
      this.batchRows = rows;
      this.saveBatchRowsToDisk();
    }
    return this.batchRows;
  }

  saveBatchRowsToDisk() {
    this._saveJson(this.batchRowsFile, this.batchRows);
  }

  getBatchRows() {
    return this.batchRows;
  }

  rotateApiKey() {
    const newKey = "sk-muse-" + crypto.randomBytes(12).toString("hex");
    this.saveSettings({ apiKey: newKey });
    return newKey;
  }

  listAccounts() {
    const now = Date.now() / 1000;
    return this.accounts.map((a, idx) => {
      const exp = Number(a.cookie_expires || 0);
      let expiresInHours = null;
      if (exp > 0) {
        expiresInHours = Math.round(((exp - now) / 3600) * 10) / 10;
      }
      const missingEssential = getMissingEssentialCookies(a.cookies || []);
      const isExpired = expiresInHours !== null && expiresInHours <= 0;
      let effectiveStatus = a.status || "active";
      if (isExpired && effectiveStatus !== "disabled") {
        effectiveStatus = "die";
      }

      return {
        id: a.id,
        name: a.name,
        email: a.email || "",
        cdp_port: Number(a.cdp_port || 9225 + idx),
        proxy: a.proxy || "",
        proxy_ip: a.proxy_ip || "",
        status: effectiveStatus,
        verified_live: Boolean(a.verified_live && effectiveStatus === "live"),
        vm_state: a.vm_state || "",
        cookie_count: (a.cookies || []).length,
        has_session: (a.cookies || []).some((c) => c.name === "hatch_sess" && c.value),
        missing_essential: missingEssential,
        created_at: a.created_at,
        last_used: a.last_used,
        last_keepalive: a.last_keepalive || 0,
        use_count: a.use_count || 0,
        fail_count: a.fail_count || 0,
        last_error: a.last_error || (isExpired ? "Cookie hatch_vml đã hết hạn 48h" : ""),
        cookie_expires: exp,
        expires_in_hours: expiresInHours,
        quota: a.quota || {},
      };
    });
  }

  getAccount(accId) {
    return this.accounts.find((a) => a.id === accId) || null;
  }

  addAccount(name, cookieRaw, email = "", options = {}) {
    const expiresMap = options && options.expires ? options.expires : null;
    const cookies = Array.isArray(cookieRaw)
      ? parseCookieInput(JSON.stringify(cookieRaw), expiresMap)
      : parseCookieInput(cookieRaw, expiresMap);
    if (!cookies.length) {
      throw new Error("Không nhận diện được dữ liệu Cookie hợp lệ");
    }
    const fp = getCookieFingerprint(cookies);
    const exp = getCookieExpires(cookies);
    const hasSess = cookies.some((c) => c.name === "hatch_sess" && c.value);
    const initialStatus = hasSess ? "active" : "die";
    const initialError = hasSess ? "" : "Thiếu cookie cốt lõi hatch_sess (Ních DIE)";

    const isAutoName =
      !name ||
      name.startsWith("Ních #") ||
      name.startsWith("Ních Muse #") ||
      name.startsWith("账号#");

    const requestedAccId = options && options.accountId ? String(options.accountId) : "";
    const requestedPort = options && options.cdpPort ? Number(options.cdpPort) : 0;

    const targetExisting = requestedAccId
      ? this.accounts.find((acc) => acc.id === requestedAccId)
      : this.accounts.find(
          (acc) =>
            acc.fingerprint === fp ||
            (email && acc.email && acc.email === email) ||
            (!isAutoName && acc.name === name)
        );

    if (targetExisting) {
      targetExisting.cookies = cookies;
      targetExisting.fingerprint = fp;
      targetExisting.cookie_expires = exp;
      targetExisting.status = initialStatus;
      targetExisting.verified_live = false;
      targetExisting.fail_count = 0;
      targetExisting.last_error = initialError;
      targetExisting.last_keepalive = Math.floor(Date.now() / 1000);
      if (name && !isAutoName) {
        targetExisting.name = name;
      }
      if (email) targetExisting.email = email;
      if (options && options.proxy !== undefined && String(options.proxy).trim()) {
        targetExisting.proxy = String(options.proxy).trim();
      }
      if (
        requestedPort > 0 &&
        !this.accounts.some((a) => a.id !== targetExisting.id && Number(a.cdp_port) === requestedPort)
      ) {
        targetExisting.cdp_port = requestedPort;
      } else if (!targetExisting.cdp_port) {
        targetExisting.cdp_port = this.allocateNextCdpPort(9225);
      }
      this.saveAccounts();
      return { account: targetExisting, isNew: false };
    }

    const assignedPort =
      requestedPort > 0 && !this.accounts.some((a) => Number(a.cdp_port) === requestedPort)
        ? requestedPort
        : this.allocateNextCdpPort(9225);

    const acc = {
      id: crypto.randomUUID().slice(0, 8),
      name: (!isAutoName && name) || email || this._nextAutoAccountName(),
      email: email || "",
      cdp_port: assignedPort,
      proxy: options && options.proxy ? String(options.proxy).trim() : "",
      proxy_ip: "",
      cookies,
      fingerprint: fp,
      cookie_expires: exp,
      status: initialStatus,
      verified_live: false,
      vm_state: "",
      created_at: Math.floor(Date.now() / 1000),
      last_used: 0,
      last_keepalive: Math.floor(Date.now() / 1000),
      use_count: 0,
      fail_count: 0,
      last_error: initialError,
      quota: {},
    };
    this.accounts.push(acc);
    this.saveAccounts();
    return { account: acc, isNew: true };
  }

  updateAccountProxy(accId, proxyStr = "", proxyIp = null) {
    const acc = this.getAccount(accId);
    if (!acc) return null;
    const cleaned = String(proxyStr || "").trim();
    if (acc.proxy !== cleaned) {
      acc.proxy_ip = "";
    }
    acc.proxy = cleaned;
    if (proxyIp !== null && proxyIp !== undefined) {
      acc.proxy_ip = String(proxyIp || "");
    }
    this.saveAccounts();
    return acc;
  }

  bulkAssignProxies(proxyLines = []) {
    const lines = (Array.isArray(proxyLines) ? proxyLines : [])
      .map((l) => String(l || "").trim())
      .filter(Boolean);
    if (!lines.length || !this.accounts.length) return 0;
    let updated = 0;
    for (let i = 0; i < this.accounts.length; i += 1) {
      if (i >= lines.length) break;
      const p = lines[i];
      if (this.accounts[i].proxy !== p) {
        this.accounts[i].proxy_ip = "";
      }
      this.accounts[i].proxy = p;
      updated += 1;
    }
    this.saveAccounts();
    return updated;
  }

  updateAccountCookies(accId, newCookies, email = "", vmState = "") {
    const acc = this.getAccount(accId);
    if (!acc) return false;
    const cookieMap = new Map();
    for (const c of acc.cookies || []) {
      cookieMap.set(c.name, c);
    }
    for (const c of newCookies || []) {
      if (c && c.name && c.value !== undefined && c.value !== "") {
        cookieMap.set(c.name, {
          name: c.name,
          value: c.value,
          domain: defaultCookieDomain(c.name, c.domain),
          path: c.path || "/",
          secure: c.secure !== undefined ? Boolean(c.secure) : true,
          httpOnly:
            c.httpOnly !== undefined
              ? Boolean(c.httpOnly)
              : ["hatch_sess", "hatch_vml", "hatch_native_auth_device"].includes(String(c.name)),
          sameSite: c.sameSite || "Lax",
          expires: Number(c.expires || c.expirationDate || 0),
        });
      }
    }
    acc.cookies = Array.from(cookieMap.values());
    acc.fingerprint = getCookieFingerprint(acc.cookies);
    const exp = getCookieExpires(acc.cookies);
    if (exp > 0) acc.cookie_expires = exp;
    acc.last_keepalive = Math.floor(Date.now() / 1000);
    acc.status = "live";
    acc.verified_live = true;
    if (vmState) acc.vm_state = vmState;
    acc.fail_count = 0;
    acc.last_error = "";
    if (email) {
      acc.email = email;
      if (acc.name.startsWith("Ních #") || acc.name.startsWith("Ních Muse #")) {
        acc.name = email;
      }
    }
    this.saveAccounts();
    return true;
  }

  updateAccountQuota(accId, quota) {
    const acc = this.getAccount(accId);
    if (acc) {
      acc.quota = quota || {};
      this.saveAccounts();
    }
  }

  deleteAccount(accId) {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((a) => a.id !== accId);
    if (this.accounts.length < before) {
      this.saveAccounts();
      return true;
    }
    return false;
  }

  toggleAccount(accId) {
    const acc = this.getAccount(accId);
    if (!acc) return null;
    if (acc.status === "disabled") {
      acc.status = acc.verified_live ? "live" : "active";
      acc.fail_count = 0;
      acc.last_error = "";
    } else {
      acc.status = "disabled";
    }
    this.saveAccounts();
    return acc;
  }

  pickAccount() {
    const now = Date.now() / 1000;
    const candidates = this.accounts.filter((a) => {
      if (a.status === "disabled" || a.status === "die" || a.status === "invalid") return false;
      const exp = Number(a.cookie_expires || 0);
      if (exp > 0 && exp <= now) {
        a.status = "die";
        a.verified_live = false;
        a.last_error = "Cookie hatch_vml đã hết hạn";
        return false;
      }
      return true;
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => (a.last_used || 0) - (b.last_used || 0));
    const chosen = candidates[0];
    chosen.last_used = Math.floor(Date.now() / 1000);
    chosen.use_count = (chosen.use_count || 0) + 1;
    this.saveAccounts();
    return chosen;
  }

  markLive(accId, detail = {}) {
    const acc = this.getAccount(accId);
    if (acc) {
      acc.status = "live";
      acc.verified_live = true;
      acc.fail_count = 0;
      acc.last_error = "";
      acc.last_keepalive = Math.floor(Date.now() / 1000);
      if (detail.vm_state) acc.vm_state = detail.vm_state;
      if (detail.email) acc.email = detail.email;
      this.saveAccounts();
    }
  }

  markDie(accId, reason = "Cookie hết hạn hoặc bị đăng xuất (DIE)") {
    const acc = this.getAccount(accId);
    if (acc) {
      acc.status = "die";
      acc.verified_live = false;
      acc.fail_count = (acc.fail_count || 0) + 1;
      acc.last_error = String(reason || "Ních DIE").slice(0, 250);
      acc.last_keepalive = Math.floor(Date.now() / 1000);
      this.saveAccounts();
    }
  }

  markFail(accId, error) {
    const acc = this.getAccount(accId);
    if (acc) {
      acc.fail_count = (acc.fail_count || 0) + 1;
      acc.last_error = String(error || "").slice(0, 250);
      const errLower = String(error || "").toLowerCase();
      const isAuthFailure =
        errLower.includes("401") ||
        errLower.includes("403") ||
        errLower.includes("sign in") ||
        errLower.includes("log in") ||
        errLower.includes("create an account") ||
        errLower.includes("unauthorized") ||
        errLower.includes("đăng xuất") ||
        errLower.includes("hết hạn") ||
        errLower.includes("nich die") ||
        errLower.includes("ních die") ||
        errLower.includes("unassigned") ||
        errLower.includes("thiếu cookie");
      if (isAuthFailure) {
        acc.status = "die";
        acc.verified_live = false;
      }
      this.saveAccounts();
    }
  }

  createTask(taskType, prompt, model, accountId = "", extra = {}) {
    const t = {
      id: "task_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
      type: taskType,
      model,
      prompt: String(prompt || "").slice(0, 500),
      account_id: accountId,
      status: "running",
      progress: 5,
      progress_text: "Đang khởi tạo Chrome...",
      created_at: Math.floor(Date.now() / 1000),
      finished_at: 0,
      duration_ms: 0,
      result: null,
      error: "",
      ...extra,
    };
    this.tasks.push(t);
    this.saveTasks();
    return t;
  }

  updateTaskProgress(taskId, progressPct, progressText) {
    for (let i = this.tasks.length - 1; i >= 0; i -= 1) {
      const t = this.tasks[i];
      if (t.id === taskId) {
        if (typeof progressPct === "number") t.progress = progressPct;
        if (progressText) t.progress_text = progressText;
        return t;
      }
    }
    return null;
  }

  finishTask(taskId, result = null, error = "") {
    for (let i = this.tasks.length - 1; i >= 0; i -= 1) {
      const t = this.tasks[i];
      if (t.id === taskId) {
        const now = Math.floor(Date.now() / 1000);
        t.finished_at = now;
        t.duration_ms = Math.max(0, (now - t.created_at) * 1000);
        if (error) {
          t.status = "failed";
          t.progress_text = `Lỗi: ${String(error).slice(0, 120)}`;
          t.error = String(error).slice(0, 500);
        } else {
          t.status = "succeeded";
          t.progress = 100;
          t.progress_text = "Hoàn tất 100%";
          t.result = result;
        }
        this.saveTasks();
        return t;
      }
    }
    return null;
  }

  getTask(taskId) {
    for (let i = this.tasks.length - 1; i >= 0; i -= 1) {
      if (this.tasks[i].id === taskId) return this.tasks[i];
    }
    return null;
  }

  listTasks(limit = 50) {
    return [...this.tasks].reverse().slice(0, limit);
  }

  listActiveTasks() {
    return this.tasks.filter((t) => t && t.status === "running");
  }

  clearTasks() {
    this.tasks = [];
    this.saveTasks();
  }

  stats() {
    const listed = this.listAccounts();
    const totalAcc = listed.length;
    const liveAcc = listed.filter((a) => a.status === "live" || a.status === "active").length;
    const dieAcc = listed.filter((a) => a.status === "die").length;
    const disabledAcc = listed.filter((a) => a.status === "disabled").length;
    const totalTasks = this.tasks.length;
    const okTasks = this.tasks.filter((t) => t.status === "succeeded").length;
    const failTasks = this.tasks.filter((t) => t.status === "failed").length;
    const runningTasks = this.tasks.filter((t) => t.status === "running").length;

    let mediaFiles = 0;
    try {
      mediaFiles = fs.readdirSync(this.mediaDir).filter((f) => {
        const ext = path.extname(f).toLowerCase();
        return [".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm"].includes(ext);
      }).length;
    } catch (_err) {
      // ignore
    }

    return {
      accounts: {
        total: totalAcc,
        active: liveAcc,
        live: liveAcc,
        invalid: dieAcc,
        die: dieAcc,
        disabled: disabledAcc,
      },
      tasks: {
        total: totalTasks,
        succeeded: okTasks,
        failed: failTasks,
        running: runningTasks,
      },
      media_count: mediaFiles,
    };
  }
}

module.exports = {
  Store,
  parseCookieInput,
  getCookieFingerprint,
  getCookieExpires,
  getMissingEssentialCookies,
  ESSENTIAL_COOKIES,
};
