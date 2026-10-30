'use strict';
/**
 * Arbeitnow — public JSON API (https://www.arbeitnow.com/api/job-board-api).
 * Отдаёт в основном Германию/Европу, но есть remote-вакансии по всему миру.
 */
const { getJson } = require('../core/http');
const { makeJob } = require('../core/model');

const ID = 'arbeitnow';

async function fetchJobs(ctx = {}) {
  const limit = Math.min(ctx.limit || 60, 120);
  const data = await getJson(`https://www.arbeitnow.com/api/job-board-api?page=1`, { timeout: 30000, retries: 1, referer: 'https://www.arbeitnow.com/' });
  const jobs = Array.isArray(data.data) ? data.data : [];
  return jobs.slice(0, limit).map((r) => makeJob(ID, {
    externalId: r.slug,
    title: r.title,
    body: r.description || '',
    url: r.url,
    publishedAt: r.created_at,
    category: r.tags || [],
    location: r.location || null,
    employmentType: Array.isArray(r.job_types) ? r.job_types.join(', ') : (r.job_types || null),
    remote: r.remote !== undefined ? r.remote : null,
    client: { name: r.company_name || null, logo: r.logo || null },
    raw: r,
  }));
}

async function check() {
  return { ok: true, note: 'открытый API' };
}

module.exports = { id: ID, label: 'Arbeitnow', kind: 'jobs', needsAuth: false, enabled: true, fetch: fetchJobs, check };
