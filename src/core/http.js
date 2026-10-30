'use strict';
/**
 * Сетевой слой: fetch с таймаутом, ретраями, rate-limit по хостам и куками.
 * Никаких зависимостей — только встроенный fetch (Node 18+).
 */
const fs = require('fs');
const path = require('path');

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

/** host -> timestamp последнего запроса */
const lastHit = new Map();
/** минимальный интервал между запросами к одному хосту (мс) */
const hostDelay = new Map();
/** host -> { fails, until } — защита от блокировок при слишком частом опросе */
const circuit = new Map();
const DEFAULT_DELAY = 1200;
const MAX_FAILS = 3;
const BACKOFF_MS = [60_000, 300_000, 900_000]; // 1 мин → 5 мин → 15 мин

// состояние «пауз» хранится на диске: переживает перезапуск процесса,
// иначе CLI-вызовы забивают хост с нуля каждый раз
const BLOCK_FILE = path.join(__dirname, '..', '..', 'data', 'host-block.json');

function loadCircuit() {
  try {
    const raw = JSON.parse(fs.readFileSync(BLOCK_FILE, 'utf8'));
    for (const [host, st] of Object.entries(raw || {})) {
      if (st && st.until > Date.now()) circuit.set(host, st);
    }
  } catch { /* файла нет — начинаем с чистого листа */ }
}

let saveTimer = null;
function saveCircuit() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const out = {};
      for (const [host, st] of circuit) {
        if (st.until > Date.now() || st.fails) out[host] = st;
      }
      fs.mkdirSync(path.dirname(BLOCK_FILE), { recursive: true });
      fs.writeFileSync(BLOCK_FILE, JSON.stringify(out, null, 2));
    } catch { /* не критично */ }
  }, 2000);
  if (saveTimer.unref) saveTimer.unref();
}

loadCircuit();

/** Список хостов, которые сейчас на паузе (показать в UI/доке) */
function pausedHosts() {
  const out = [];
  for (const [host, st] of circuit) {
    if (st.until > Date.now()) out.push({ host, until: st.until, fails: st.fails });
  }
  return out;
}

function noteFailure(host) {
  const st = circuit.get(host) || { fails: 0, until: 0 };
  st.fails++;
  if (st.fails >= MAX_FAILS) {
    const level = Math.min(st.fails - MAX_FAILS, BACKOFF_MS.length - 1);
    st.until = Date.now() + BACKOFF_MS[level];
  }
  circuit.set(host, st);
  saveCircuit();
}

function noteSuccess(host) {
  const st = circuit.get(host);
  if (st) { st.fails = 0; st.until = 0; circuit.set(host, st); saveCircuit(); }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return 'unknown'; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function pickUA(seed) {
  if (!seed) return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
  let h = 0;
  for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return UA_POOL[h % UA_POOL.length];
}

/** Ждёт, если host недавно был опрошен (rate limit). */
async function respectRateLimit(url) {
  const host = hostOf(url);
  const st = circuit.get(host);
  if (st && st.until > Date.now()) {
    const wait = st.until - Date.now();
    const e = new Error(`хост ${host} на паузе ${Math.round(wait / 1000)} с (защита от блокировки)`);
    e.code = 'HOST_PAUSED';
    throw e;
  }
  const delay = hostDelay.get(host) ?? DEFAULT_DELAY;
  const prev = lastHit.get(host) || 0;
  const wait = prev + delay - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

function buildHeaders(opts = {}) {
  const h = {
    'User-Agent': opts.userAgent || pickUA(opts.seed),
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    'Accept': opts.accept || '*/*',
  };
  if (opts.referer) h['Referer'] = opts.referer;
  if (opts.origin) h['Origin'] = opts.origin;
  if (opts.cookie) h['Cookie'] = opts.cookie;
  if (opts.headers) Object.assign(h, opts.headers);
  return h;
}

/**
 * Основной запрос.
 * @returns {Promise<{status:number, ok:boolean, text:string, headers:Headers, url:string}>}
 */
async function request(url, opts = {}) {
  const retries = opts.retries ?? 2;
  const timeout = opts.timeout ?? 20000;
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(800 * 2 ** (attempt - 1), 6000));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      if (opts.rateLimit !== false) await respectRateLimit(url);
      const res = await fetch(url, {
        method: opts.method || 'GET',
        headers: buildHeaders(opts),
        body: opts.body,
        redirect: opts.redirect || 'follow',
        signal: ctrl.signal,
      });
      const text = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const ra = Number(res.headers.get('retry-after')) || 0;
        if (ra) await sleep(Math.min(ra * 1000, 10000));
        lastErr = new Error(`HTTP ${res.status}`);
        noteFailure(hostOf(url));
        continue;
      }
      if (res.status === 403 || res.status === 429) noteFailure(hostOf(url));
      else if (res.ok) noteSuccess(hostOf(url));
      return { status: res.status, ok: res.ok, text, headers: res.headers, url: res.url };
    } catch (err) {
      lastErr = err;
      if (err && err.code === 'HOST_PAUSED') throw err;
      noteFailure(hostOf(url));
      const msg = String(err.message || err);
      if (attempt >= retries || /abort/i.test(msg)) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`request failed: ${url} — ${lastErr ? lastErr.message : 'unknown'}`);
}

async function getText(url, opts = {}) {
  const r = await request(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text;
}

async function getJson(url, opts = {}) {
  const txt = await getText(url, { ...opts, accept: opts.accept || 'application/json' });
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error(`invalid JSON from ${url}: ${txt.slice(0, 80)}`);
  }
}

async function postJson(url, payload, opts = {}) {
  const r = await request(url, {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  try {
    return JSON.parse(r.text);
  } catch {
    return r.text;
  }
}

/** Значение env или дефолт */
function envNum(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

module.exports = {
  request, getText, getJson, postJson, sleep, pickUA, hostOf, envNum, readIfExists, UA_POOL,
  pausedHosts, noteFailure, noteSuccess, circuit,
};
