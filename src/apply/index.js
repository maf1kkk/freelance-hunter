'use strict';
/**
 * Раннер автоотклика: отбор кандидатов → генерация текста → отправка.
 *
 * По умолчанию dryRun=true: тексты генерируются и сохраняются, но НЕ отправляются.
 */
const store = require('../core/store');
const profileLib = require('../core/profile');
const { draftResponse } = require('../respond');
const flru = require('./flru');
const kwork = require('./kwork');

const SERVICES = { flru, kwork };

function applierFor(source) {
  return SERVICES[source] || null;
}

/** Сколько откликов сегодня уже отправлено */
function todayCount() {
  return store.todayCount();
}

/**
 * @param {object} opts { limit, minScore, services, dryRun, headless, only }
 * @returns {Promise<object>}
 */
async function run(opts = {}) {
  const settings = opts.settings || store.getSettings();
  const cfg = settings.apply || {};
  const dryRun = opts.dryRun !== undefined ? opts.dryRun : (cfg.dryRun !== false);
  const minScore = opts.minScore ?? cfg.minScore ?? 80;
  const limit = opts.limit ?? cfg.dailyLimit ?? 5;
  const services = opts.services || cfg.services || [];
  const only = opts.only || null;

  const used = todayCount();
  const budget = Math.max(0, limit - used);

  const filter = {
    status: ['new', 'watched', 'drafted'],
    minScore,
    limit: 500,
  };
  if (only) filter.source = only;
  const { items } = store.listJobs(filter);

  const candidates = items
    .filter((j) => j.source in SERVICES)
    .filter((j) => !services.length || services.includes(j.source))
    .slice(0, budget);

  const profile = profileLib.load(settings);
  const results = [];

  for (const job of candidates) {
    const text = job.responseText || draftResponse(job, settings);
    const applier = applierFor(job.source);
    if (!applier) continue;

    if (dryRun) {
      store.setJobStatus(job.id, 'drafted', { responseText: text });
      results.push({ id: job.id, source: job.source, title: job.title, ok: true, dryRun: true, text });
      continue;
    }

    const res = await applier.apply(job, text, {
      headless: opts.headless !== false,
      dryRun: false,
      price: opts.price,
    });
    if (res.ok) {
      store.setJobStatus(job.id, 'sent', { responseText: text, appliedAt: Date.now() });
    }
    results.push({ id: job.id, source: job.source, title: job.title, ...res });
  }

  return {
    ok: true,
    dryRun,
    minScore,
    budget,
    usedToday: used,
    processed: results.length,
    results,
  };
}

module.exports = { run, todayCount, SERVICES };
