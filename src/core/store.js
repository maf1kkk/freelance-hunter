'use strict';
/**
 * Хранилище v3 — SQLite (node:sqlite, без внешних зависимостей).
 *
 * Публичный интерфейс тот же, что был на JSON-базе, поэтому весь код
 * (pipeline, web, mcp, cli) работает без изменений.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const settingsLib = require('./settings');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STORE_FILE = db.DB_FILE;
const LEGACY_JSON = db.LEGACY_JSON;

const STATUSES = ['new', 'watched', 'drafted', 'sent', 'applied', 'skipped', 'done', 'rejected'];

/** Старая шкала вердиктов (v1) → новая (v2) */
const LEGACY_VERDICTS = { match: 'prime', maybe: 'good', weak: 'meh', skip: 'bad' };

function normVerdict(v) {
  if (!v) return null;
  return LEGACY_VERDICTS[v] || v;
}

const conn = () => db.open();

/* ------------------------------ settings -------------------------------- */

function getSettings() {
  const row = conn().prepare('SELECT value FROM settings WHERE key = ?').get('main');
  if (!row) return settingsLib.defaults();
  try { return settingsLib.validate(JSON.parse(row.value)); } catch { return settingsLib.defaults(); }
}

function updateSettings(patch) {
  const cur = getSettings();
  const next = settingsLib.validate(patch, cur);
  conn().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').run('main', JSON.stringify(next));
  return next;
}

/* -------------------------------- meta ---------------------------------- */

function getMeta(key, dflt = null) {
  const row = conn().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  if (!row) return dflt;
  try { return JSON.parse(row.value); } catch { return dflt; }
}

function setMeta(key, value) {
  conn().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run(key, JSON.stringify(value));
  return value;
}

/* -------------------------------- jobs ---------------------------------- */

const UPSERT = `INSERT INTO jobs
  (id, source, source_label, external_id, title, body, url, price_min, price_max, price_currency, price_text,
   published_at, deadline, category, tags, sites, client, stats, quality, ai_match, dedupe, raw,
   status, response_text, applied_at, notes, starred, first_seen_at, last_seen_at, stored_at, search_text, title_search)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    source=excluded.source, source_label=excluded.source_label,
    external_id=excluded.external_id, title=excluded.title, body=excluded.body,
    url=excluded.url, price_min=excluded.price_min, price_max=excluded.price_max,
    price_currency=excluded.price_currency, price_text=excluded.price_text,
    published_at=excluded.published_at, deadline=excluded.deadline, category=excluded.category,
    tags=excluded.tags, sites=excluded.sites, client=excluded.client, stats=excluded.stats,
    quality=excluded.quality, ai_match=excluded.ai_match, dedupe=excluded.dedupe, raw=excluded.raw,
    last_seen_at=excluded.last_seen_at, stored_at=excluded.stored_at,
    search_text=excluded.search_text, title_search=excluded.title_search`;

function upsertJobs(jobs) {
  const c = conn();
  const stmt = c.prepare(UPSERT);
  const keep = c.prepare(`SELECT status, response_text, applied_at, notes, starred, first_seen_at FROM jobs WHERE id = ?`);
  let added = 0;
  let updated = 0;
  const now = Date.now();

  c.exec('BEGIN IMMEDIATE');
  try {
    for (const job of jobs) {
      if (!job || !job.id) continue;
      const prev = keep.get(job.id);
      const status = prev ? prev.status : (job.status || 'new');
      const responseText = prev ? prev.response_text : (job.responseText || null);
      const appliedAt = prev ? prev.applied_at : (job.appliedAt || null);
      const notes = prev ? prev.notes : (job.notes || null);
      const starred = prev ? prev.starred : (job.starred ? 1 : 0);
      const firstSeen = prev ? prev.first_seen_at : (job.firstSeenAt || now);

      stmt.run(
        job.id, job.source || 'unknown', job.sourceLabel || null,
        job.externalId != null ? String(job.externalId) : null,
        job.title || '', job.body || '', job.url || null,
        job.price?.min ?? null, job.price?.max ?? null, job.price?.currency || null, job.price?.text || '',
        job.publishedAt || null, job.deadline || null,
        JSON.stringify(job.category || []), JSON.stringify(job.tags || []), JSON.stringify(job.sites || []),
        JSON.stringify(job.client || {}), JSON.stringify(job.stats || {}),
        job.quality ? JSON.stringify(job.quality) : null,
        job.aiMatch ? JSON.stringify(job.aiMatch) : null,
        job.dedupe ? JSON.stringify(job.dedupe) : null,
        job.raw ? JSON.stringify(job.raw) : null,
        status, responseText, appliedAt, notes, starred, firstSeen, now, job.storedAt || now,
        db.searchText(job), String(job.title || '').toLowerCase(),
      );
      if (prev) updated++; else added++;
    }
    c.exec('COMMIT');
  } catch (e) {
    try { c.exec('ROLLBACK'); } catch { /* уже откатили */ }
    throw e;
  }
  return { added, updated };
}

function getJob(id) {
  const r = conn().prepare('SELECT * FROM jobs WHERE id = ?').get(String(id));
  return db.rowToJob(r);
}

function setJobStatus(id, status, extra = {}) {
  const c = conn();
  const key = String(id);
  const job = c.prepare('SELECT * FROM jobs WHERE id = ?').get(key);
  if (!job) return null;
  const nextStatus = STATUSES.includes(status) ? status : job.status;

  const fields = [];
  const values = [];
  const set = (col, val) => { fields.push(`${col} = ?`); values.push(val); };
  set('status', nextStatus);
  if (extra.responseText !== undefined) set('response_text', extra.responseText);
  if (extra.notes !== undefined) set('notes', extra.notes);
  if (extra.starred !== undefined) set('starred', extra.starred ? 1 : 0);
  if (extra.appliedAt !== undefined) set('applied_at', extra.appliedAt);
  if (extra.quality !== undefined) set('quality', extra.quality ? JSON.stringify(extra.quality) : null);
  if (extra.aiMatch !== undefined) set('ai_match', extra.aiMatch ? JSON.stringify(extra.aiMatch) : null);
  if (extra.dedupe !== undefined) set('dedupe', extra.dedupe ? JSON.stringify(extra.dedupe) : null);
  values.push(key);
  c.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  if (nextStatus === 'applied' || nextStatus === 'sent') {
    addAppliedLog({
      id: key, source: job.source, title: job.title, url: job.url,
      at: Date.now(), price: job.price_min, responseText: extra.responseText || job.response_text || '',
    });
  }
  return getJob(key);
}

function updateJob(id, patch) {
  const c = conn();
  const key = String(id);
  const job = c.prepare('SELECT id FROM jobs WHERE id = ?').get(key);
  if (!job) return null;
  const fields = [];
  const values = [];
  const set = (col, val) => { fields.push(`${col} = ?`); values.push(val); };
  if (patch.title !== undefined) set('title', patch.title);
  if (patch.body !== undefined) set('body', patch.body);
  if (patch.url !== undefined) set('url', patch.url);
  if (patch.price !== undefined) {
    set('price_min', patch.price?.min ?? null);
    set('price_max', patch.price?.max ?? null);
    set('price_currency', patch.price?.currency || null);
    set('price_text', patch.price?.text || '');
  }
  if (patch.publishedAt !== undefined) set('published_at', patch.publishedAt);
  if (patch.category !== undefined) set('category', JSON.stringify(patch.category));
  if (patch.tags !== undefined) set('tags', JSON.stringify(patch.tags));
  if (patch.sites !== undefined) set('sites', JSON.stringify(patch.sites));
  if (patch.client !== undefined) set('client', JSON.stringify(patch.client));
  if (patch.stats !== undefined) set('stats', JSON.stringify(patch.stats));
  if (patch.quality !== undefined) set('quality', patch.quality ? JSON.stringify(patch.quality) : null);
  if (patch.aiMatch !== undefined) set('ai_match', patch.aiMatch ? JSON.stringify(patch.aiMatch) : null);
  if (patch.dedupe !== undefined) set('dedupe', patch.dedupe ? JSON.stringify(patch.dedupe) : null);
  if (patch.status !== undefined) set('status', patch.status);
  if (patch.responseText !== undefined) set('response_text', patch.responseText);
  if (patch.notes !== undefined) set('notes', patch.notes);
  if (patch.starred !== undefined) set('starred', patch.starred ? 1 : 0);
  set('last_seen_at', Date.now());
  if (!fields.length) return getJob(key);
  values.push(key);
  c.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getJob(key);
}

function removeJob(id) {
  conn().prepare('DELETE FROM jobs WHERE id = ?').run(String(id));
}

/**
 * Список заказов с фильтрами.
 * filter: { source, verdict, status, minPrice, maxPrice, minScore, sites, q, starred, since, limit, offset, sort }
 */
function listJobs(filter = {}) {
  const c = conn();
  const where = [];
  const params = [];

  if (filter.status) {
    const list = Array.isArray(filter.status) ? filter.status : [filter.status];
    where.push(`status IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (filter.source) {
    const list = Array.isArray(filter.source) ? filter.source : [filter.source];
    where.push(`source IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (filter.verdict) {
    const list = (Array.isArray(filter.verdict) ? filter.verdict : [filter.verdict]).map(normVerdict);
    where.push(`json_extract(quality, '$.verdict') IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (filter.minPrice != null) { where.push('COALESCE(price_min, 0) >= ?'); params.push(filter.minPrice); }
  if (filter.maxPrice != null) { where.push('COALESCE(price_min, 9223372036854775807) <= ?'); params.push(filter.maxPrice); }
  if (filter.minScore != null) { where.push('COALESCE(json_extract(quality, \'$.score\'), 0) >= ?'); params.push(filter.minScore); }
  if (filter.starred) where.push('starred = 1');
  if (filter.since) { where.push('COALESCE(published_at, 0) >= ?'); params.push(filter.since); }
  if (filter.sites && filter.sites.length) {
    const clauses = filter.sites.map(() => `EXISTS (SELECT 1 FROM json_each(jobs.sites) WHERE value = ?)`);
    where.push(`(${clauses.join(' OR ')})`);
    params.push(...filter.sites);
  }
  if (filter.q) {
    // поиск без учёта регистра (в т.ч. кириллицы) — по заранее lowercase-полю
    const like = `%${String(filter.q).toLowerCase()}%`;
    where.push('search_text LIKE ?');
    params.push(like);
  }

  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = c.prepare(`SELECT COUNT(*) AS n FROM jobs ${sql}`).get(...params).n;

  // при поиске сортируем по релевантности, потом по качеству
  const scoreOrder = 'COALESCE(json_extract(quality, \'$.score\'), 0) DESC';
  let order;
  if (filter.q) {
    const q = String(filter.q).toLowerCase();
    order = `CASE
      WHEN title_search LIKE ? THEN 0
      WHEN title_search LIKE ? THEN 1
      WHEN title_search LIKE ? THEN 2
      ELSE 3 END, ${scoreOrder}, published_at DESC`;
  } else {
    order = filter.sort === 'date'
      ? 'published_at DESC, id DESC'
      : `${scoreOrder}, published_at DESC, id DESC`;
  }

  let rows;
  const orderParams = filter.q
    ? [`${filter.q.toLowerCase()}%`, `% ${filter.q.toLowerCase()}%`, `%${filter.q.toLowerCase()}%`]
    : [];
  if (filter.limit) {
    rows = c.prepare(`SELECT * FROM jobs ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, ...orderParams, filter.limit, filter.offset || 0);
  } else {
    rows = c.prepare(`SELECT * FROM jobs ${sql} ORDER BY ${order}`).all(...params, ...orderParams);
  }
  return { items: rows.map(db.rowToJob), total };
}

/* ----------------------------- applied log ------------------------------ */

function addAppliedLog(entry) {
  conn().prepare('INSERT INTO applied_log (job_id, source, title, url, at, price, response_text) VALUES (?,?,?,?,?,?,?)')
    .run(entry.id || null, entry.source || null, entry.title || null, entry.url || null,
      entry.at || Date.now(), entry.price ?? null, entry.responseText || '');
}

function getAppliedLog(limit = 2000) {
  return conn().prepare('SELECT * FROM applied_log ORDER BY at DESC LIMIT ?').all(limit)
    .map((r) => ({
      id: r.job_id, source: r.source, title: r.title, url: r.url, at: r.at, price: r.price, responseText: r.response_text,
    }));
}

function todayCount() {
  const dayAgo = Date.now() - 86400000;
  return conn().prepare('SELECT COUNT(*) AS n FROM applied_log WHERE at >= ?').get(dayAgo).n;
}

/* --------------------------- source state ------------------------------ */

function getSourceState() {
  const out = {};
  for (const r of conn().prepare('SELECT source, state FROM source_state').all()) {
    try { out[r.source] = JSON.parse(r.state); } catch { out[r.source] = {}; }
  }
  return out;
}

function setSourceState(source, state) {
  const value = { ...(getSourceState()[source] || {}), ...state, at: Date.now() };
  conn().prepare('INSERT OR REPLACE INTO source_state (source, state, at) VALUES (?,?,?)')
    .run(source, JSON.stringify(value), value.at);
  return value;
}

/* --------------------------- telegram lastSeen -------------------------- */

function getTelegramLastSeen() {
  const out = {};
  for (const r of conn().prepare("SELECT key, value FROM meta WHERE key LIKE 'tg:%'").all()) {
    out[r.key.slice(3)] = Number(r.value) || 0;
  }
  return out;
}

function setTelegramLastSeen(map) {
  const c = conn();
  c.exec('BEGIN IMMEDIATE');
  try {
    c.prepare("DELETE FROM meta WHERE key LIKE 'tg:%'").run();
    for (const [k, v] of Object.entries(map || {})) {
      c.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run(`tg:${k}`, String(v));
    }
    c.exec('COMMIT');
  } catch (e) { try { c.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
  return map || {};
}

/* ---------------------------- notify state ------------------------------ */

function getNotifyState() {
  return getMeta('notifyState', { lastSentAt: 0, lastIds: [] });
}

function setNotifyState(state) {
  return setMeta('notifyState', state);
}

/* -------------------------------- stats --------------------------------- */

function stats() {
  const c = conn();
  const bySource = {};
  for (const r of c.prepare('SELECT source, COUNT(*) AS n FROM jobs GROUP BY source').all()) bySource[r.source] = r.n;

  const byVerdict = {};
  for (const r of c.prepare("SELECT COALESCE(json_extract(quality,'$.verdict'),'none') AS v, COUNT(*) AS n FROM jobs GROUP BY v").all()) {
    byVerdict[normVerdict(r.v) || 'none'] = r.n;
  }

  const byStatus = {};
  for (const r of c.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all()) byStatus[r.status] = r.n;

  const avg = c.prepare('SELECT AVG(price_min) AS a FROM jobs WHERE price_min > 0').get().a;
  const dayAgo = Date.now() - 86400000;
  const weekAgo = Date.now() - 7 * 86400000;
  const last24h = c.prepare('SELECT COUNT(*) AS n FROM jobs WHERE COALESCE(published_at,0) >= ?').get(dayAgo).n;
  const last7d = c.prepare('SELECT COUNT(*) AS n FROM jobs WHERE COALESCE(published_at,0) >= ?').get(weekAgo).n;
  const total = c.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;

  return {
    total, bySource, byVerdict, byStatus,
    avgPrice: avg ? Math.round(avg) : null,
    last24h, last7d,
    applied: c.prepare('SELECT COUNT(*) AS n FROM applied_log').get().n,
    appliedToday: c.prepare('SELECT COUNT(*) AS n FROM applied_log WHERE at >= ?').get(dayAgo).n,
  };
}

/* -------------------------------- prune --------------------------------- */

function prune({ keepDays = 30, maxJobs = 8000 } = {}) {
  const c = conn();
  const cutoff = Date.now() - keepDays * 86400000;
  let removed = c.prepare(
    "DELETE FROM jobs WHERE status IN ('applied','done','rejected','skipped') AND COALESCE(published_at,0) < ?",
  ).run(cutoff).changes;

  const total = c.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
  if (total > maxJobs) {
    removed += c.prepare(
      `DELETE FROM jobs WHERE id IN (
         SELECT id FROM jobs ORDER BY COALESCE(published_at,0) ASC LIMIT ?
       )`,
    ).run(total - maxJobs).changes;
  }
  return removed;
}

/* ------------------------- совместимость (v2) --------------------------- */

/** Снимок состояния — для кода, которому нужен весь документ */
function load() {
  const c = conn();
  const { items } = listJobs({ limit: 100000 });
  const out = {
    schemaVersion: 3,
    jobs: {},
    settings: getSettings(),
    appliedLog: getAppliedLog(),
    sourceState: getSourceState(),
    telegramLastSeen: getTelegramLastSeen(),
    notifyState: getNotifyState(),
  };
  for (const j of items) out.jobs[j.id] = j;
  for (const r of c.prepare('SELECT key, value FROM meta WHERE key NOT LIKE ?').all('tg:%')) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}

/** Совместимость: сохранение теперь происходит автоматически */
function save() { /* no-op: SQLite пишет сразу */ }

/**
 * Совместимость для кода, который меняет «документ» (настройки/meta).
 * Изменения в settings/meta сохраняются автоматически.
 */
function mutate(fn) {
  const doc = {
    settings: getSettings(),
    notifyState: getNotifyState(),
    telegramLastSeen: getTelegramLastSeen(),
    sourceState: getSourceState(),
  };
  const res = fn(doc);
  if (doc.settings) {
    conn().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').run('main', JSON.stringify(doc.settings));
  }
  if (doc.notifyState) setNotifyState(doc.notifyState);
  if (doc.telegramLastSeen) setTelegramLastSeen(doc.telegramLastSeen);
  if (doc.sourceState) {
    for (const [k, v] of Object.entries(doc.sourceState)) setSourceState(k, v);
  }
  return res;
}

module.exports = {
  // новое API
  conn, getMeta, setMeta, addAppliedLog, getAppliedLog, todayCount,
  getNotifyState, setNotifyState,
  // прежнее API
  load, save, mutate, STORE_FILE, LEGACY_JSON, DATA_DIR, STATUSES, normVerdict,
  upsertJobs, getJob, setJobStatus, removeJob, updateJob, listJobs,
  getSettings, updateSettings,
  getSourceState, setSourceState,
  getTelegramLastSeen, setTelegramLastSeen,
  stats, prune,
};
