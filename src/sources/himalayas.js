'use strict';
/**
 * Himalayas — public JSON API (https://himalayas.app/jobs/api).
 */
const { getJson } = require('../core/http');
const { makeJob } = require('../core/model');

const ID = 'himalayas';

async function fetchJobs(ctx = {}) {
  const limit = Math.min(ctx.limit || 50, 100);
  const data = await getJson(`https://himalayas.app/jobs/api?limit=${limit}`, { timeout: 25000, retries: 1, referer: 'https://himalayas.app/' });
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  return jobs.map((r) => {
    const salary = (r.minSalary || r.maxSalary)
      ? {
        min: Number(r.minSalary) || null,
        max: Number(r.maxSalary) || null,
        currency: r.currency || 'USD',
        text: `${r.minSalary || '?'}–${r.maxSalary || '?'} ${r.currency || ''}`.trim(),
      }
      : null;
    return makeJob(ID, {
      externalId: r.guid || r.id,
      title: r.title,
      body: [r.excerpt, r.description].filter(Boolean).join('\n\n'),
      url: r.applicationLink || r.jobUrl,
      price: salary,
      publishedAt: r.pubDate,
      deadline: r.expiryDate || null,
      category: r.categories || [],
      location: Array.isArray(r.locationRestrictions) ? r.locationRestrictions.join(', ') : (r.locationRestrictions || null),
      employmentType: r.employmentType || null,
      remote: true,
      client: { name: r.companyName || null, logo: r.companyLogo || null, id: r.companySlug || null },
      raw: r,
    });
  });
}

async function check() {
  return { ok: true, note: 'открытый API' };
}

module.exports = { id: ID, label: 'Himalayas', kind: 'jobs', needsAuth: false, enabled: true, fetch: fetchJobs, check };
