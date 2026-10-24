/* EM BÔNG AI · Đồng bộ Cookie Muse.ai (hỗ trợ đầy đủ httpOnly cookies) */

const $ = (id) => document.getElementById(id);
const STORE = 'embong_muse_ext_cfg';
const DEFAULT_BASE = '__DEFAULT_BASE_URL__'.startsWith('http')
  ? '__DEFAULT_BASE_URL__'
  : 'http://127.0.0.1:18638';
const DEFAULT_KEY = '__DEFAULT_API_KEY__'.startsWith('__DEFAULT')
  ? ''
  : '__DEFAULT_API_KEY__';

const ESSENTIAL = ['hatch_sess', 'hatch_gw', 'hatch_vml', 'hatch_native_auth_device'];

function log(html, cls) {
  const el = $('log');
  el.className = 'show';
  el.innerHTML = cls ? `<span class="${cls}">${html}</span>` : html;
}

function normBase(v) {
  let s = (v || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/v1$/i, '');
  return s;
}

async function loadCfg() {
  const o = await chrome.storage.local.get(STORE);
  const c = o[STORE] || {};
  $('base').value = c.base || DEFAULT_BASE;
  $('key').value = c.key || DEFAULT_KEY;
  if (c.label) $('label').value = c.label;
  if (!c.base) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const u = tab && tab.url ? new URL(tab.url) : null;
      if (u && /\/admin/.test(u.pathname)) {
        $('base').value = u.origin;
        const k = new URLSearchParams(u.search).get('key');
        if (k) $('key').value = k;
      }
    } catch (_e) { /* ignore */ }
  }
}

async function saveCfg() {
  await chrome.storage.local.set({
    [STORE]: {
      base: normBase($('base').value),
      key: $('key').value.trim(),
      label: $('label').value.trim(),
    },
  });
}

async function grabCookies() {
  const all = await chrome.cookies.getAll({ domain: 'muse.ai' });
  const out = {}, exp = {};
  for (const c of all) {
    const dom = (c.domain || '').replace(/^\./, '');
    if (!dom.endsWith('muse.ai')) continue;
    out[c.name] = c.value;
    if (c.expirationDate) exp[c.name] = Math.floor(c.expirationDate);
  }
  return { cookies: out, expires: exp };
}

async function run() {
  const base = normBase($('base').value) || DEFAULT_BASE;
  const key = $('key').value.trim();
  const label = $('label').value.trim();

  if (!base) return log('Vui lòng nhập Địa chỉ Server (VD: http://127.0.0.1:18638)', 'bad');

  $('go').disabled = true;
  log('Đang đọc Cookie từ muse.ai…');

  try {
    const { cookies, expires } = await grabCookies();
    const names = Object.keys(cookies);
    if (!names.length) {
      return log('Không tìm thấy Cookie muse.ai nào.\nHãy mở và đăng nhập https://muse.ai/ trên trình duyệt này trước.', 'bad');
    }
    const missing = ESSENTIAL.filter((n) => !(n in cookies));
    if (missing.length) {
      log(`Đã đọc ${names.length} Cookie nhưng thiếu cookie cốt lõi: ${missing.join(', ')}\n`
          + 'Vui lòng đăng nhập muse.ai hoàn tất (vào tới giao diện chat) rồi thử lại.', 'warn');
      return;
    }

    log(`Đã đọc ${names.length} Cookie, đang đồng bộ về ${base} …`);

    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['Authorization'] = 'Bearer ' + key;

    const r = await fetch(base + '/admin/accounts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ label, name: label, cookies, expires }),
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch (_e) { data = { raw: text }; }

    if (r.status === 401) {
      return log('API Key không đúng (HTTP 401). Hãy kiểm tra lại API Key trong mục Cổng API & Cài đặt.', 'bad');
    }
    if (!r.ok) {
      return log(`Đồng bộ thất bại: HTTP ${r.status}\n${text.slice(0, 300)}`, 'bad');
    }

    const a = (data.added && data.added[0]) || data.account || {};
    await saveCfg();
    const expSec = a.expires_at || a.cookie_expires || 0;
    log(`✓ Đồng bộ thành công!\nTên ních: ${a.label || a.name || label || '(Tự động)'}\n`
        + `ID ních: ${a.id || '?'}\nSố lượng Cookie: ${a.cookie_count || names.length}\n`
        + `Hạn Cookie: ${expSec ? new Date(expSec * 1000).toLocaleString() : '48h'}\n`
        + (data.warning ? `\nLưu ý: ${data.warning}` : ''), 'ok');
  } catch (e) {
    log('Lỗi kết nối: ' + (e && e.message ? e.message : String(e))
        + '\n\nHãy đảm bảo ứng dụng EM BÔNG AI Muse Studio đang mở trên máy.', 'bad');
  } finally {
    $('go').disabled = false;
  }
}

$('go').addEventListener('click', run);
loadCfg();
