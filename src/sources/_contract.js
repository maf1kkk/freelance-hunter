'use strict';
/**
 * Контракт источника заказов.
 *
 * Источник — модуль с полями:
 *   id          — уникальный id ('flru', 'remoteok', ...)
 *   label       — человекочитаемое название
 *   kind        — 'exchange' | 'jobs' | 'chat'
 *   needsAuth   — требует ли cookies/сессии
 *   enabled     — включён по умолчанию
 *   fetch(ctx)  → Promise<Job[]>  (ctx: { settings, accounts, limit, log })
 *   check(ctx)  → Promise<{ok, account?, error?}>  (проверка доступа)
 */
const { makeJob } = require('../core/model');

/** Обёртка: сырой объект → Job */
function job(source, p) {
  return makeJob(source, p);
}

module.exports = { job };
