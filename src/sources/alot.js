'use strict';
/**
 * alot.pro — агрегатор фриланс-бирж (FL.ru, Kwork, hh.ru, Freelancer.ru, ...).
 * API: POST https://alot.pro/api/v2/, action-based. Куки UID + S.
 */
const alot = require('../alot');
const { makeJob } = require('../core/model');
const { parseMoney } = require('../core/html');
const accounts = require('../core/accounts');

const ID = 'alot';

let sitesCache = null;

/** id биржи → название (кэш) */
async function sitesInfo() {
  if (sitesCache) return sitesCache;
  try {
    const data = await alot.request('getSitesInfo', {}, alot.loadSession());
    const map = {};
    for (const s of (data.items || [])) {
      if (s && s.id) map[s.id] = s.title || s.id;
    }
    sitesCache = map;
    return map;
  } catch {
    return {};
  }
}

async function fetchJobs(ctx = {}) {
  const session = alot.loadSession();
  if (!session) throw new Error('нет сессии alot.pro (npm run login)');

  const data = await alot.request('getNew', { lastProjectId: 0 }, session);
  const items = data.items || [];
  const limit = ctx.limit || 100;
  const sites = await sitesInfo();

  return items.slice(0, limit).map((p) => {
    // rating в alot = количество откликов (иногда отрицательное — спец-значение)
    const resp = p.rating != null ? Math.max(0, Number(p.rating) || 0) : null;
    // цену берём из текста («от 5 000 до 10 000 ₽»), internalPrice может быть максимумом
    const money = parseMoney(p.price || '');
    const priceMin = money ? money.min : (p.internalPrice || null);
    const priceMax = money ? money.max : (p.internalPrice || null);
    return makeJob(ID, {
      externalId: p.internalId,
      title: p.title || '',
      body: String(p.body || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '),
      url: p.url || null,
      price: priceMin
        ? { min: priceMin, max: priceMax, currency: money?.currency || p.currency || 'RUB', text: p.price || String(priceMin) }
        : null,
      publishedAt: p.date || null,
      category: p.category ? [p.category] : [],
      tags: Array.isArray(p.alotCategories) ? p.alotCategories : [],
      sites: p.site ? [p.site] : [],
      client: { name: null, id: p.projectOwnerId || null },
      stats: { responses: resp, views: p.seenCounter ?? null },
      raw: { site: p.site, siteTitle: sites[p.site] || p.site, projectClass: p.projectClass, reports: p.reports },
    });
  });
}

async function check() {
  const session = alot.loadSession();
  if (!session) return { ok: false, error: 'нет сессии (npm run login)' };
  try {
    const data = await alot.request('checkSession', {}, session);
    const u = data.user || {};
    return {
      ok: true,
      account: `${u.firstName || ''} ${u.lastName || ''}`.trim() || `id=${u.id}`,
      note: `вход выполнен, всего заказов: ${u.lastId || '?'}`,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { id: ID, label: 'alot.pro', kind: 'exchange', needsAuth: true, enabled: true, fetch: fetchJobs, check, sitesInfo };
