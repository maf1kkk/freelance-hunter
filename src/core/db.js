'use strict';
/**
 * Хранилище на SQLite (встроенный node:sqlite, без зависимостей).
 *
 * Схема:
 *   jobs        — лента заказов (все поля Job в колонках + JSON для вложенных)
 *   settings    — настройки (один JSON-документ)
 *   meta        — служебное: lastSeen телеграма, notifyState, произвольные ключи
 *   applied_log — журнал откликов
 *   source_state— состояние последнего опроса каждого источника
 *
 * При первом запуске данные из data/store.json переносятся в data/store.db
 * (JSON остаётся как бэкап рядом).
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const settingsLib = require('./settings');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_FILE = process.env.FH_DB_FILE || path.join(DATA_DIR, 'store.db');
const LEGACY_JSON = process.env.FH_LEGACY_JSON || path.join(DATA_DIR, 'store.json');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  source_label  TEXT,
  title_search  TEXT,
  external_id   TEXT,
  title         TEXT,
  body          TEXT,
  url           TEXT,
  price_min     REAL,
  price_max     REAL,
  price_currency TEXT,
  price_text    TEXT,
  published_at  INTEGER,
  deadline      INTEGER,
  category      TEXT,
  tags          TEXT,
  sites         TEXT,
  client        TEXT,
  stats         TEXT,
  quality       TEXT,
  ai_match      TEXT,
  dedupe        TEXT,
  raw           TEXT,
  status        TEXT NOT NULL DEFAULT 'new',
  response_text TEXT,
  applied_at    INTEGER,
  notes         TEXT,
  starred       INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER,
  last_seen_at  INTEGER,
  stored_at     INTEGER,
  search_text   TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_source    ON jobs(source);
CREATE INDEX IF NOT EXISTS idx_jobs_status    ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_published ON jobs(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_sourceid ON jobs(source, external_id);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS applied_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT, source TEXT, title TEXT, url TEXT,
  at INTEGER, price REAL, response_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_log_at ON applied_log(at DESC);
CREATE TABLE IF NOT EXISTS source_state (source TEXT PRIMARY KEY, state TEXT, at INTEGER);
`;

let db = null;
let openError = null;

/**
 * Текст для поиска: всё в нижний регистр.
 * SQLite LOWER() работает только с ASCII, поэтому регистр снижаем в JS
 * (там toLowerCase понимает кириллицу).
 */
function searchText(job) {
  const parts = [job.title, job.body, job.client?.name, job.client?.company];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

/** Ошибка «база повреждена» (не блокировка) */
function isCorruptError(e) {
  const msg = String(e?.message || e || '').toLowerCase();
  return /not a database|malformed|file is encrypted|disk image is malformed|notadb/i.test(msg)
    || e?.errcode === 11;
}

/** Добавляет недостающие колонки (ALTER TABLE) — эволюция схемы */
function migrateSchema() {
  const cols = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  const wanted = [
    ['source_label', 'TEXT'],
    ['title_search', 'TEXT'],
    ['search_text', 'TEXT'],
    ['ai_match', 'TEXT'],
    ['dedupe', 'TEXT'],
    ['sites', 'TEXT'],
    ['notes', 'TEXT'],
    ['starred', 'INTEGER NOT NULL DEFAULT 0'],
    ['first_seen_at', 'INTEGER'],
    ['last_seen_at', 'INTEGER'],
  ];
  for (const [name, type] of wanted) {
    if (!cols.includes(name)) {
      try { db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`); } catch { /* уже есть */ }
    }
  }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_search ON jobs(search_text)'); } catch { /* ignore */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(json_extract(quality, \'$.score\') DESC)'); } catch { /* ignore */ }
}

/** Заполняет поисковый текст для записей, где его нет */
function fillSearchText() {
  const missing = db.prepare('SELECT id, title, body, client FROM jobs WHERE search_text IS NULL LIMIT 5000').all();
  if (!missing.length) return 0;
  const upd = db.prepare('UPDATE jobs SET search_text = ?, title_search = ? WHERE id = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of missing) {
      let client = {};
      try { client = JSON.parse(r.client || '{}'); } catch { /* пусто */ }
      upd.run(searchText({ title: r.title, body: r.body, client }), String(r.title || '').toLowerCase(), r.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
  return missing.length;
}

function open() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    db = new DatabaseSync(DB_FILE);
    // таймаут ожидания блокировки — ДО переключения журнала (оно требует эксклюзивного лока)
    db.exec('PRAGMA busy_timeout = 10000;');
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec(SCHEMA);
  } catch (e) {
    try { if (db) { db.close(); db = null; } } catch { /* уже закрыта */ }

    if (!isCorruptError(e)) {
      // это не повреждение (например, временная блокировка) — пробрасываем как есть
      throw e;
    }

    // база действительно повреждена — отводим её в сторону и создаём новую
    const broken = `${DB_FILE}.broken-${Date.now()}`;
    try {
      fs.renameSync(DB_FILE, broken);
    } catch {
      try { fs.rmSync(DB_FILE, { force: true }); } catch { /* ignore */ }
    }
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { fs.unlinkSync(DB_FILE + suffix); } catch { /* нет файла */ }
    }
    openError = `база повреждена (${e.message}), создана новая`;
    db = new DatabaseSync(DB_FILE);
    db.exec('PRAGMA busy_timeout = 10000;');
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(SCHEMA);
  }
  migrateSchema();
  migrateLegacy();
  try { fillSearchText(); } catch { /* не критично */ }
  return db;
}

/** Последняя ошибка открытия (если база была повреждена) */
function getOpenError() { return openError; }

/* ------------------------- перенос из JSON ------------------------------ */

function migrateLegacy() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM jobs').get().c;
  if (count > 0) return { migrated: 0 };
  if (!fs.existsSync(LEGACY_JSON)) return { migrated: 0 };

  let raw;
  try { raw = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8')); } catch { return { migrated: 0 }; }
  if (!raw || typeof raw !== 'object') return { migrated: 0 };

  const jobs = raw.jobs && typeof raw.jobs === 'object' ? raw.jobs : {};
  // в v1 заказы лежали в projects
  if (!Object.keys(jobs).length && raw.projects && typeof raw.projects === 'object') {
    for (const [id, p] of Object.entries(raw.projects)) {
      const money = parseMoney(p.price || '');
      // старые telegram-заказы лежали в общей куче с id вида tg_<канал>_<id>
      const isTg = String(id).startsWith('tg_');
      const jobId = isTg ? `telegram:${String(id).slice(3)}` : `alot:${id}`;
      jobs[jobId] = {
        id: jobId, source: isTg ? 'telegram' : 'alot', sourceLabel: isTg ? 'Telegram' : 'alot.pro',
        externalId: String(id),
        title: p.title || '', body: p.body || '', url: p.url || null,
        price: { min: money ? money.min : (p.internalPrice ?? null), max: money ? money.max : (p.internalPrice ?? null), currency: money?.currency || p.currency || 'RUB', text: p.price || '' },
        publishedAt: p.date || p.storedAt || Date.now(), deadline: null,
        category: p.category ? [p.category] : [], tags: [], sites: isTg ? [] : (p.site ? [String(p.site).replace(/^alot:/, '')] : []),
        client: { name: null, id: p.projectOwnerId || null, rating: null, reviews: null, orders: null, ageDays: null, verified: null },
        stats: { responses: p.rating != null ? Math.max(0, Number(p.rating) || 0) : null, views: p.seenCounter ?? null },
        status: p.status || 'new', quality: null, dedupe: null,
        storedAt: p.storedAt || Date.now(),
      };
    }
  }

  const stmt = db.prepare(`INSERT OR REPLACE INTO jobs
    (id, source, source_label, external_id, title, body, url, price_min, price_max, price_currency, price_text,
     published_at, deadline, category, tags, sites, client, stats, quality, ai_match, dedupe, raw,
     status, response_text, applied_at, notes, starred, first_seen_at, last_seen_at, stored_at, search_text, title_search)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const j of Object.values(jobs)) {
      if (!j || !j.id) continue;
      stmt.run(
        j.id, j.source || 'unknown', j.sourceLabel || null, j.externalId != null ? String(j.externalId) : null,
        j.title || '', j.body || '', j.url || null,
        j.price?.min ?? null, j.price?.max ?? null, j.price?.currency || null, j.price?.text || '',
        j.publishedAt || null, j.deadline || null,
        JSON.stringify(j.category || []), JSON.stringify(j.tags || []), JSON.stringify(j.sites || []),
        JSON.stringify(j.client || {}), JSON.stringify(j.stats || {}),
        j.quality ? JSON.stringify(j.quality) : null,
        j.aiMatch ? JSON.stringify(j.aiMatch) : null,
        j.dedupe ? JSON.stringify(j.dedupe) : null,
        j.raw ? JSON.stringify(j.raw) : null,
        j.status || 'new', j.responseText || null, j.appliedAt || null, j.notes || null,
        j.starred ? 1 : 0, j.firstSeenAt || Date.now(), j.lastSeenAt || Date.now(), j.storedAt || Date.now(),
        searchText(j), String(j.title || '').toLowerCase(),
      );
    }
    for (const [k, v] of Object.entries(raw.appliedLog || [])) {
      db.prepare('INSERT INTO applied_log (job_id, source, title, url, at, price, response_text) VALUES (?,?,?,?,?,?,?)')
        .run(v.id || v.internalId || null, v.source || v.site || null, v.title || null, v.url || null,
          v.at || Date.now(), v.price ?? null, v.responseText || '');
    }
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)')
      .run('main', JSON.stringify(settingsLib.migrate(raw.settings || {})));
    for (const [k, v] of Object.entries(raw.telegramLastSeen || {})) {
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run(`tg:${k}`, String(v));
    }
    for (const [k, v] of Object.entries(raw.sourceState || {})) {
      db.prepare('INSERT OR REPLACE INTO source_state (source, state, at) VALUES (?,?,?)').run(k, JSON.stringify(v), v.at || Date.now());
    }
    for (const [k, v] of Object.entries(raw)) {
      if (['jobs', 'projects', 'settings', 'appliedLog', 'telegramLastSeen', 'sourceState', 'groups', 'schemaVersion'].includes(k)) continue;
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run(k, JSON.stringify(v));
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* уже откатили */ }
    throw e;
  }

  // JSON оставляем как бэкап
  try {
    fs.renameSync(LEGACY_JSON, LEGACY_JSON + '.migrated');
  } catch { /* может быть занят */ }
  return { migrated: Object.keys(jobs).length };
}

function parseMoney(text) {
  const t = String(text || '');
  const nums = [...t.matchAll(/\d[\d\s]*/g)]
    .map((m) => Number(m[0].replace(/\s+/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return null;
  return { min: Math.min(...nums), max: Math.max(...nums), currency: 'RUB' };
}

/* --------------------------- хелперы ------------------------------------ */

const j = (v) => (v == null ? null : JSON.stringify(v));
const pj = (v, dflt) => {
  if (v == null) return dflt;
  try { return JSON.parse(v); } catch { return dflt; }
};

function rowToJob(r) {
  if (!r) return null;
  return {
    id: r.id,
    source: r.source,
    sourceLabel: r.source_label || r.source,
    externalId: r.external_id,
    title: r.title || '',
    body: r.body || '',
    url: r.url,
    price: {
      min: r.price_min,
      max: r.price_max,
      currency: r.price_currency,
      text: r.price_text || '',
    },
    publishedAt: r.published_at,
    deadline: r.deadline,
    category: pj(r.category, []),
    tags: pj(r.tags, []),
    sites: pj(r.sites, []),
    client: pj(r.client, {}),
    stats: pj(r.stats, {}),
    quality: pj(r.quality, null),
    aiMatch: pj(r.ai_match, null),
    dedupe: pj(r.dedupe, null),
    raw: pj(r.raw, null),
    status: r.status || 'new',
    responseText: r.response_text || undefined,
    appliedAt: r.applied_at || undefined,
    notes: r.notes || undefined,
    starred: !!r.starred,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    storedAt: r.stored_at,
  };
}

module.exports = {
  open, close: () => { if (db) { db.close(); db = null; } },
  getOpenError, searchText,
  DB_FILE, LEGACY_JSON, SCHEMA, rowToJob, j, pj,
  get conn() { return open(); },
};
