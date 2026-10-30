'use strict';
/**
 * Jobicy — public JSON API (https://jobicy.com/api/v2/remote-jobs).
 */
const { getJson } = require('../core/http');
const { makeJob } = require('../core/model');

const ID = 'jobicy';

async function fetchJobs(ctx = {}) {
  const count = Math.min(ctx.limit || 50, 100);
  const data = await getJson(`https://jobicy.com/api/v2/remote-jobs?count=${count}`, { timeout: 25000, retries: 1, referer: 'https://jobicy.com/' });
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  return jobs.map((r) => {
    const salary = (r.salaryMin || r.salaryMax)
      ? {
        min: Number(r.salaryMin) || null,
        max: Number(r.salaryMax) || null,
        currency: r.salaryCurrency || 'USD',
        text: `${r.salaryMin || '?'}–${r.salaryMax || '?'} ${r.salaryCurrency || ''}`.trim(),
      }
      : null;
    return makeJob(ID, {
      externalId: r.id || r.jobSlug,
      title: r.jobTitle,
      body: [r.jobExcerpt, r.jobDescription].filter(Boolean).join('\n\n'),
      url: r.url,
      price: salary,
      publishedAt: r.pubDate,
      category: r.jobIndustry || [],
      location: r.jobGeo || null,
      employmentType: Array.isArray(r.jobType) ? r.jobType.join(', ') : (r.jobType || null),
      remote: true,
      client: { name: r.companyName || null, logo: r.companyLogo || null },
      raw: r,
    });
  });
}

async function check() {
  return { ok: true, note: 'открытый API' };
}

module.exports = { id: ID, label: 'Jobicy', kind: 'jobs', needsAuth: false, enabled: true, fetch: fetchJobs, check };
