'use strict';
/**
 * Движок: оркестрация опроса источников, фильтрация, скоринг, сохранение.
 * Новая реализация — src/core/pipeline.js; этот модуль — совместимый фасад.
 */
const store = require('./core/store');
const pipeline = require('./core/pipeline');
const sources = require('./sources');
const { evaluate } = require('./filters');
const { classifyTgPost } = require('./filters');
const alot = require('./alot');

/** alot.pro: лента новых заказов (legacy-совместимый формат) */
async function pollAlot() {
  const r = await pipeline.pollOne('alot');
  const src = r.sources[0];
  return {
    ok: src.ok,
    source: 'alot',
    fetched: src.count,
    added: r.added,
    matches: r.matches,
    error: src.error || undefined,
  };
}

/** Telegram: новые посты из каналов (legacy-совместимый формат) */
async function pollTelegram() {
  const r = await pipeline.pollOne('telegram');
  const src = r.sources[0];
  return {
    ok: src.ok,
    source: 'tg',
    fetched: src.count,
    added: r.added,
    matches: r.matches,
    errors: src.error ? [src.error] : [],
  };
}

/** Полный цикл: все источники */
async function pollOnce(opts = {}) {
  const r = await pipeline.pollAll(opts);
  return {
    ok: r.ok,
    ...r,
    alot: r.sources.find((s) => s.source === 'alot') || null,
    telegram: r.sources.find((s) => s.source === 'telegram') || null,
  };
}

async function getSessionUser() {
  const session = alot.loadSession();
  if (!session) return null;
  const data = await alot.request('checkSession', {}, session);
  return data.user || null;
}

let pollTimer = null;

function startPolling(onResult, opts = {}) {
  const minutes = store.getSettings().poll?.minutes || 5;
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const result = await pollOnce(opts);
      if (onResult) onResult(result);
    } catch (err) {
      if (onResult) onResult({ ok: false, error: String(err.message || err) });
    }
  }, minutes * 60 * 1000);
  return pollOnce(opts);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

module.exports = {
  pollOnce, pollAlot, pollTelegram, getSessionUser, startPolling, stopPolling,
  pipeline, sources, evaluate, classifyTgPost,
};
