'use strict';
/**
 * RemoteOK — public JSON API (https://remoteok.com/api).
 * Требует обратной ссылки на remoteok.com (условие API).
 */
const { getJson } = require('../core/http');
const { makeJob } = require('../core/model');

const ID = 'remoteok';

async function fetchJobs(ctx = {}) {
  const data = await getJson('https://remoteok.com/api', { timeout: 25000, retries: 1, referer: 'https://remoteok.com/' });
  const raw = Array.isArray(data) ? data : [];
  const limit = ctx.limit || 80;
  const out = [];
  for (const r of raw) {
    if (!r || !r.position || r.legal) continue; // первый элемент — юридическая шапка
    out.push(makeJob(ID, {
      externalId: r.id || r.slug,
      title: r.position,
      body: r.description || '',
      url: r.apply_url || r.url,
      urlDirect: r.apply_url || r.url,
      price: r.salary_min ? { min: r.salary_min, max: r.salary_max || r.salary_min, currency: 'USD', text: `${r.salary_min}${r.salary_max ? `-${r.salary_max}` : ''} USD` } : null,
      currency: 'USD',
      publishedAt: r.epoch ? r.epoch * 1000 : r.date,
      tags: Array.isArray(r.tags) ? r.tags : [],
      location: r.location || null,
      employmentType: null,
      client: { name: r.company || null },
      raw: r,
    }));
    if (out.length >= limit) break;
  }
  return out;
}

async function check() {
  return { ok: true, note: 'открытый API, авторизация не нужна' };
}

module.exports = { id: ID, label: 'RemoteOK', kind: 'jobs', needsAuth: false, enabled: true, fetch: fetchJobs, check };
