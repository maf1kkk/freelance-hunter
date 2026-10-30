'use strict';
/**
 * Менеджер аккаунтов и cookie-файлов — data/accounts.json
 *
 * Поддерживаемые типы аккаунтов:
 *   alot      — uid + s (сессия alot.pro)
 *   telegram  — session string + api id/hash
 *   cookies   — набор cookies для сайта (fl.ru / kwork.ru / hh.ru / ...)
 *
 * Импорт cookie-файлов поддерживает 5 форматов (определяются автоматически):
 *   1. Netscape cookies.txt
 *   2. Chrome / EditThisCookie / Cookie-Editor JSON (массив)
 *   3. Playwright storageState.json
 *   4. JSON {cookies:[...]} или {name,value,domain}
 *   5. сырая строка "name=value; name2=value2"
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const LEGACY_SESSION = path.join(DATA_DIR, 'session.json');

/** сервис -> домены, по которым определяется сервис-владелец */
const SERVICE_DOMAINS = {
  flru: ['fl.ru'],
  kwork: ['kwork.ru', 'kwork.com'],
  hh: ['hh.ru', 'career.habr.com', 'hh.cd'],
  alot: ['alot.pro'],
  telegram: [],
  avito: ['avito.ru'],
  freelance: ['freelancer.ru', 'weblancer.net'],
};

/* ----------------------------- парсинг --------------------------------- */

function parseNetscape(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    let httpOnly = false;
    if (/^#HttpOnly_/i.test(line)) { httpOnly = true; line = line.replace(/^#HttpOnly_/i, ''); }
    if (line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [domain, , p, secure, expires, name, ...rest] = parts;
    out.push({
      domain: domain.trim(),
      path: p || '/',
      secure: secure === 'TRUE',
      expires: Number(expires) || -1,
      name: name.trim(),
      value: rest.join('\t'),
      httpOnly,
    });
  }
  return out;
}

function normalizeCookie(c) {
  return {
    domain: String(c.domain || c.Domain || c.host || '').replace(/^\./, ''),
    path: c.path || c.Path || '/',
    secure: Boolean(c.secure ?? c.Secure),
    httpOnly: Boolean(c.httpOnly ?? c.HttpOnly),
    expires: Number(c.expires ?? c.expirationDate ?? c.expiresIn) || -1,
    name: String(c.name || c.Name || ''),
    value: String(c.value ?? c.Value ?? ''),
    sameSite: c.sameSite || c.SameSite || undefined,
  };
}

function parseJsonCookies(data) {
  let arr = null;
  if (Array.isArray(data)) arr = data;
  else if (data && Array.isArray(data.cookies)) arr = data.cookies;
  else if (data && data.name && data.value) arr = [data];
  if (!arr) return null;
  return arr.map(normalizeCookie).filter((c) => c.name);
}

function parseRawHeader(text) {
  const out = [];
  for (const part of String(text).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out.push({ domain: '', path: '/', name, value, secure: false, httpOnly: false, expires: -1 });
  }
  return out;
}

/**
 * Определяет формат и парсит cookie-файл.
 * @returns {{cookies:Array, format:string, domains:string[]}}
 */
function parseCookieFile(content) {
  const text = String(content || '').trim();
  if (!text) throw new Error('пустой файл');

  // JSON
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const data = JSON.parse(text);
      const cookies = parseJsonCookies(data);
      if (cookies) {
        const format = Array.isArray(data) ? 'chrome-json' : (data.origins ? 'playwright-storage-state' : 'json');
        return { cookies, format, domains: [...new Set(cookies.map((c) => c.domain).filter(Boolean))] };
      }
    } catch {
      throw new Error('невалидный JSON');
    }
  }

  // Netscape: ищем строку, начинающуюся с домена + табуляция
  const lines = text.split(/\r?\n/);
  const netscapeLine = lines.find((l) => /^(#HttpOnly_)?[\w.-]+\t/.test(l.trim()));
  if (netscapeLine) {
    const cookies = parseNetscape(text);
    if (cookies.length) {
      return { cookies, format: 'netscape', domains: [...new Set(cookies.map((c) => c.domain).filter(Boolean))] };
    }
  }

  // raw header
  if (text.includes('=') && !text.includes('\n')) {
    const cookies = parseRawHeader(text);
    if (cookies.length) return { cookies, format: 'raw-header', domains: [] };
  }

  // похоже на JSON, но сломан
  throw new Error('не удалось определить формат файла');
}

/* --------------------------- определение сервиса ----------------------- */

function detectService(domains = [], explicit = null) {
  if (explicit && SERVICE_DOMAINS[explicit]) return explicit;
  const joined = domains.join(' ').toLowerCase();
  for (const [svc, doms] of Object.entries(SERVICE_DOMAINS)) {
    if (!doms.length) continue;
    if (doms.some((d) => joined.includes(d))) return svc;
  }
  return explicit || 'custom';
}

/* ------------------------------ хранилище ------------------------------ */

function loadAll() {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch { data = {}; }
  // миграция legacy session.json → alot
  if (!data.alot) {
    try {
      const s = JSON.parse(fs.readFileSync(LEGACY_SESSION, 'utf8'));
      if (s.uid && s.s) {
        data.alot = { type: 'alot', uid: String(s.uid), s: String(s.s), updatedAt: s.updatedAt || Date.now(), migratedFrom: 'data/session.json' };
      }
    } catch {}
  }
  return data;
}

function saveAll(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = ACCOUNTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, ACCOUNTS_FILE);
}

function get(service) {
  return loadAll()[service] || null;
}

function set(service, data) {
  const all = loadAll();
  all[service] = { ...data, updatedAt: Date.now() };
  saveAll(all);
  return all[service];
}

function remove(service) {
  const all = loadAll();
  delete all[service];
  saveAll(all);
}

/**
 * Импорт cookie-файла.
 * @param {string} filePath — путь к файлу
 * @param {object} opts { service, domain, name }
 */
function importCookieFile(filePath, opts = {}) {
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = parseCookieFile(content);
  const service = detectService(parsed.domains, opts.service);
  const domain = opts.domain || parsed.domains[0] || '';
  const cookies = parsed.cookies.map((c) => ({ ...c, domain: c.domain || domain }));
  if (!cookies.length) throw new Error('в файле не найдено ни одной cookie');
  const existing = get(service);
  const merged = mergeCookies(existing?.cookies || [], cookies);
  const acc = set(service, {
    type: 'cookies',
    service,
    domain,
    domains: [...new Set([...(existing?.domains || []), ...parsed.domains, domain].filter(Boolean))],
    cookies: merged,
    format: parsed.format,
    importedFrom: filePath,
  });
  return { service, format: parsed.format, domains: parsed.domains, count: merged.length, account: acc };
}

/** Импорт из строки (raw header или JSON) */
function importCookieString(text, opts = {}) {
  const parsed = parseCookieFile(text);
  const service = detectService(parsed.domains, opts.service);
  const domain = opts.domain || parsed.domains[0] || '';
  const cookies = parsed.cookies.map((c) => ({ ...c, domain: c.domain || domain }));
  const existing = get(service);
  const merged = mergeCookies(existing?.cookies || [], cookies);
  set(service, {
    type: 'cookies', service, domain,
    domains: [...new Set([...(existing?.domains || []), ...parsed.domains, domain].filter(Boolean))],
    cookies: merged, format: parsed.format,
  });
  return { service, format: parsed.format, count: merged.length };
}

function mergeCookies(a = [], b = []) {
  const map = new Map();
  for (const c of [...a, ...b]) map.set(`${c.domain}|${c.path}|${c.name}`, c);
  return [...map.values()];
}

/** Строка Cookie: "a=b; c=d" для домена */
function cookieHeader(service, domain) {
  const acc = get(service);
  if (!acc) return null;
  if (acc.type === 'alot') return `UID=${acc.uid}; S=${acc.s}`;
  if (acc.type !== 'cookies' || !acc.cookies?.length) return null;
  const now = Date.now() / 1000;
  const relevant = acc.cookies.filter((c) => {
    if (c.expires && c.expires > 0 && c.expires < now) return false;
    if (!domain) return true;
    const d = String(c.domain || '').toLowerCase();
    const target = String(domain).toLowerCase().replace(/^\./, '');
    return d === target || target.endsWith(`.${d}`) || d.endsWith(`.${target}`) || d === '' || d.includes(target);
  });
  if (!relevant.length) return null;
  return relevant.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** Куки в виде объекта (для Playwright addCookies) */
function cookiesFor(service) {
  const acc = get(service);
  if (!acc || acc.type !== 'cookies') return [];
  return acc.cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain ? (c.domain.startsWith('.') ? c.domain : `.${c.domain}`) : undefined,
    path: c.path || '/',
    secure: Boolean(c.secure),
    httpOnly: Boolean(c.httpOnly),
    expires: c.expires && c.expires > 0 ? c.expires : undefined,
  }));
}

/** Список аккаунтов (без печати значений cookie) */
function list() {
  const all = loadAll();
  return Object.entries(all).map(([service, acc]) => ({
    service,
    type: acc.type,
    domain: acc.domain || acc.domains?.[0] || null,
    domains: acc.domains || [],
    cookieCount: acc.cookies?.length || 0,
    updatedAt: acc.updatedAt,
    format: acc.format || null,
    hasValue: acc.type === 'cookies' ? Boolean(acc.cookies?.length) : Boolean(acc.uid || acc.sessionString),
  }));
}

/** Установить сессию alot (uid + s) */
function setAlotSession(uid, s) {
  return set('alot', { type: 'alot', uid: String(uid), s: String(s) });
}

module.exports = {
  ACCOUNTS_FILE, SERVICE_DOMAINS, STATUS: ACCOUNTS_FILE,
  parseCookieFile, parseNetscape, parseJsonCookies, parseRawHeader, detectService,
  importCookieFile, importCookieString, mergeCookies,
  get, set, remove, list, loadAll, saveAll,
  cookieHeader, cookiesFor, setAlotSession,
};
