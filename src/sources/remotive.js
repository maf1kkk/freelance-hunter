'use strict';
/**
 * Remotive — public JSON API (https://remotive.com/api/remote-jobs).
 */
const { getJson } = require('../core/http');
const { makeJob } = require('../core/model');

const ID = 'remotive';

async function fetchJobs(ctx = {}) {
  const url = `https://remotive.com/api/remote-jobs?limit=${Math.min(ctx.limit || 60, 200)}`;
  const data = await getJson(url, { timeout: 25000, retries: 1, referer: 'https://remotive.com/' });
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  return jobs.map((r) => makeJob(ID, {
    externalId: r.id,
    title: r.title,
    body: r.description || '',
    url: r.url,
    price: r.salary ? { min: 0, max: 0, currency: 'USD', text: String(r.salary) } : null,
    publishedAt: r.publication_date,
    category: r.category ? [r.category] : [],
    tags: Array.isArray(r.tags) ? r.tags : [],
    location: r.candidate_required_location || null,
    employmentType: r.job_type || null,
    remote: true,
    client: { name: r.company_name || null, verified: Boolean(r.company_logo) },
    raw: r,
  }));
}

async function check() {
  return { ok: true, note: 'открытый API' };
}

module.exports = { id: ID, label: 'Remotive', kind: 'jobs', needsAuth: false, enabled: true, fetch: fetchJobs, check };
