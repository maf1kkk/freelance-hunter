'use strict';
/**
 * We Work Remotely — RSS (https://weworkremotely.com/remote-jobs.rss).
 * Заголовок в формате "Компания: Должность".
 */
const rss = require('../core/rss');
const { getText } = require('../core/http');
const { makeJob } = require('../core/model');

const ID = 'weworkremotely';

const FEEDS = [
  { url: 'https://weworkremotely.com/remote-jobs.rss', tag: 'all' },
  { url: 'https://weworkremotely.com/categories/remote-programming-jobs.rss', tag: 'programming' },
  { url: 'https://weworkremotely.com/categories/remote-design-jobs.rss', tag: 'design' },
  { url: 'https://weworkremotely.com/categories/remote-marketing-jobs.rss', tag: 'marketing' },
];

async function fetchJobs(ctx = {}) {
  const limit = Math.min(ctx.limit || 80, 200);
  const seen = new Set();
  const out = [];
  for (const feed of FEEDS) {
    let xml;
    try {
      xml = await getText(feed.url, { timeout: 20000, retries: 1, referer: 'https://weworkremotely.com/' });
    } catch { continue; }
    for (const item of rss.parse(xml)) {
      if (!item.title || !item.link) continue;
      const key = item.guid || item.link;
      if (seen.has(key)) continue;
      seen.add(key);

      const rawTitle = item.title;
      let company = null;
      let position = rawTitle;
      const idx = rawTitle.indexOf(': ');
      if (idx > 0) { company = rawTitle.slice(0, idx).trim(); position = rawTitle.slice(idx + 2).trim(); }

      const location = item.extra.region || item.extra.country || null;
      const skills = item.extra.skills ? item.extra.skills.split(',').map((s) => s.trim()).filter(Boolean) : [];

      out.push(makeJob(ID, {
        externalId: key,
        title: position,
        body: item.description || item.content || '',
        url: item.link,
        publishedAt: rss.parseDate(item.pubDate),
        category: item.categories?.length ? item.categories : (item.extra.category ? [item.extra.category] : []),
        tags: [...skills, ...(item.categories || [])],
        location,
        employmentType: item.extra.type || null,
        remote: true,
        client: { name: company },
        raw: { ...item, feed: feed.tag },
      }));
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return out;
}

async function check() {
  return { ok: true, note: 'открытый RSS' };
}

module.exports = { id: ID, label: 'We Work Remotely', kind: 'jobs', needsAuth: false, enabled: true, fetch: fetchJobs, check };
