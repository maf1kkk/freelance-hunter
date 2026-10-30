'use strict';
/**
 * Оркестратор: опрос всех включённых источников → нормализация → дедуп → скоринг → store.
 */
const store = require('./store');
const settingsLib = require('./settings');
const quality = require('./quality');
const dedupe = require('./dedupe');
const db = require('./db');
const sources = require('../sources');
const accounts = require('./accounts');
const profileLib = require('./profile');

/** Один источник с таймаутом и изоляцией ошибок */
async function pollSource(src, ctx) {
  const started = Date.now();
  // у медленных источников (Telegram через Telethon) свой лимит
  const timeout = src.timeout || ctx.perSourceTimeout || 45000;
  let timer = null;
  try {
    const p = ctx.limit != null
      ? src.fetch({ ...ctx, limit: ctx.limit })
      : src.fetch(ctx);
    const jobs = await Promise.race([
      p,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`таймаут ${timeout} мс`)), timeout); }),
    ]);
    store.setSourceState(src.id, { lastOk: true, lastPollAt: Date.now(), count: jobs.length, error: null, ms: Date.now() - started });
    return { source: src.id, ok: true, jobs, ms: Date.now() - started };
  } catch (err) {
    store.setSourceState(src.id, { lastOk: false, lastPollAt: Date.now(), error: String(err.message || err), ms: Date.now() - started });
    return { source: src.id, ok: false, error: String(err.message || err), jobs: [], ms: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Полный опрос.
 * @param {object} opts { only: [sourceIds], limit, perSourceTimeout, settings }
 */
async function pollAll(opts = {}) {
  const settings = opts.settings || store.getSettings();
  const list = sources.enabled(settings).filter((s) => !opts.only || opts.only.includes(s.id));
  const ctx = {
    settings,
    limit: opts.limit || settings.poll?.maxPerSource || 80,
    perSourceTimeout: opts.perSourceTimeout || settings.poll?.perSourceTimeout || 45000,
    log: opts.log,
  };

  const results = await Promise.all(list.map((s) => pollSource(s, ctx)));
  const allJobs = results.flatMap((r) => r.jobs || []);

  // дедупликация между источниками
  const groups = dedupe.group(allJobs);
  const primaries = groups.map((g) => g.best);
  for (const j of primaries) j.sourceLabel = sources.label(j.source);

  // скоринг качества
  quality.evaluateAll(primaries, settings, { profile: profileLib.load(settings) });

  const { added, updated } = store.upsertJobs(primaries);
  backfillSourceLabels();

  // чистим старые записи, чтобы база не росла бесконечно
  const pruned = store.prune({ keepDays: 30, maxJobs: 8000 });

  // переоценка всей базы — только если менялись настройки качества
  const hash = qualitySettingsHash(settings);
  let rescored = { total: 0, changed: 0, skipped: true };
  if (store.getMeta('qualityHash') !== hash) {
    rescored = rescore({ settings });
    store.setMeta('qualityHash', hash);
  }
  // уведомления о новых подходящих заказах
  let notify = null;
  try {
    const notifyLib = require('./notify');
    const fresh = primaries.filter((j) => (j.quality?.score ?? 0) >= (settings.notify?.minScore ?? 70));
    notify = await notifyLib.notifyNew(fresh, settings);
  } catch (e) {
    notify = { sent: 0, error: String(e.message || e) };
  }

  return {
    ok: results.every((r) => r.ok) || results.some((r) => r.ok),
    sources: results.map((r) => ({
      source: r.source,
      label: sources.label(r.source),
      ok: r.ok,
      count: (r.jobs || []).length,
      error: r.error || null,
      ms: r.ms,
    })),
    fetched: allJobs.length,
    groups: groups.length,
    added,
    updated,
    pruned,
    rescored,
    notify,
    matches: primaries.filter((j) => j.quality?.verdict === 'prime').length,
    good: primaries.filter((j) => j.quality?.verdict === 'good').length,
  };
}

/** Опрос одного источника */
async function pollOne(sourceId, opts = {}) {
  const src = sources.get(sourceId);
  if (!src) throw new Error(`неизвестный источник: ${sourceId}`);
  return pollAll({ ...opts, only: [sourceId] });
}

/** Переоценка всех сохранённых заказов с текущими настройками (без повторного опроса) */
/** Проставляет человекочитаемые названия источников для старых записей */
function backfillSourceLabels() {
  const c = store.conn();
  const upd = c.prepare('UPDATE jobs SET source_label = ? WHERE source = ? AND (source_label IS NULL OR source_label = ?)');
  for (const s of sources.all()) {
    try { upd.run(s.label, s.id, s.id); } catch { /* ignore */ }
  }
}

function rescore(opts = {}) {
  const settings = opts.settings || store.getSettings();
  const { evaluate } = quality;
  const ctx = { profile: profileLib.load(settings) };
  const c = store.conn();
  const rows = c.prepare('SELECT id, title, body, url, price_min, price_max, price_currency, price_text, published_at, category, tags, sites, client, stats, quality FROM jobs').all();
  const upd = c.prepare('UPDATE jobs SET quality = ? WHERE id = ?');
  let changed = 0;
  c.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows) {
      const job = {
        id: r.id, title: r.title, body: r.body, url: r.url,
        price: { min: r.price_min, max: r.price_max, currency: r.price_currency, text: r.price_text },
        publishedAt: r.published_at,
        category: db.pj(r.category, []), tags: db.pj(r.tags, []), sites: db.pj(r.sites, []),
        client: db.pj(r.client, {}), stats: db.pj(r.stats, {}),
        quality: db.pj(r.quality, null),
      };
      const q = evaluate(job, settings, ctx);
      const before = job.quality?.verdict;
      const beforeScore = job.quality?.score;
      // пишем только если что-то изменилось — экономим время и диск
      if (before !== q.verdict || beforeScore !== q.score) {
        upd.run(JSON.stringify({ score: q.score, verdict: q.verdict, reasons: q.reasons, flags: q.flags, parts: q.parts }), r.id);
        if (before !== q.verdict) changed++;
      }
    }
    c.exec('COMMIT');
  } catch (e) {
    try { c.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
  return { total: rows.length, changed };
}

/** Отпечаток настроек, влияющих на качество: если он не менялся — пересчёт не нужен */
function qualitySettingsHash(settings) {
  const s = settings || store.getSettings();
  const relevant = { search: s.search, quality: s.quality, profile: s.profile };
  return require('crypto').createHash('sha1').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}

/** Проверка доступа ко всем подключённым сервисам */
async function checkAll() {
  const out = [];
  for (const src of sources.all()) {
    const acc = accounts.get(src.id);
    const res = await Promise.race([
      (src.check ? src.check({}) : Promise.resolve({ ok: true })),
      new Promise((res2) => setTimeout(() => res2({ ok: false, error: 'таймаут' }), 20000)),
    ]);
    out.push({
      source: src.id,
      label: src.label,
      kind: src.kind,
      needsAuth: src.needsAuth,
      hasCredentials: Boolean(acc),
      ...res,
    });
  }
  return out;
}

module.exports = { pollAll, pollOne, pollSource, rescore, checkAll };
