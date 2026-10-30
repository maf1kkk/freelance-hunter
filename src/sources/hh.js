'use strict';
/**
 * hh.ru / career.habr.com — вакансии (HTML-парсинг, api.hh.ru отдаёт 403).
 * Карточки помечены data-qa="vacancy-serp__vacancy".
 */
const { request } = require('../core/http');
const { makeJob } = require('../core/model');
const { toText, pick, decodeEntities } = require('../core/html');
const accounts = require('../core/accounts');

const ID = 'hh';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DEFAULT_QUERY = 'python OR javascript OR 1с OR дизайн OR вёрстка OR таргет OR бот';

function cards(html) {
  const out = [];
  const re = /<article[^>]*data-qa="vacancy-serp__vacancy"[\s\S]*?<\/article>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[0]);
  return out;
}

function parseSalary(text) {
  const t = String(text || '');
  // «от 165 000 ₽ за месяц»
  const m = t.match(/([\d\s\u00a0]{2,})\s*(₽|руб\.?|RUR|₸|so'?m|\$|€)/i);
  if (!m) return null;
  const nums = m[1].replace(/[^\d]/g, '');
  if (!nums) return null;
  const cur = /[$€]/.test(m[2]) ? (/\$/.test(m[2]) ? 'USD' : 'EUR') : 'RUB';
  return { min: Number(nums), max: Number(nums), currency: cur, text: m[0].trim() };
}

function parseCard(card) {
  const title = toText(pick(card, /data-qa="serp-item__title-text"[^>]*>([\s\S]*?)</) || '');
  const hrefRaw = pick(card, /data-qa="serp-item__title"[^>]*href="([^"]+)"/) || '';
  const href = decodeEntities(hrefRaw);
  const employer = toText(pick(card, /data-qa="vacancy-serp__vacancy-employer-text"[^>]*>([\s\S]*?)</) || '');
  const address = toText(pick(card, /data-qa="vacancy-serp__vacancy-address"[^>]*>([\s\S]*?)</) || '');
  const rating = toText(pick(card, /data-qa="company-review-rating-value"[^>]*>([\s\S]*?)</) || '');
  const reviews = toText(pick(card, /data-qa="company-review-rating-reviews-count"[\s\S]{0,160}?(\d+)/) || '');
  const trusted = /trusted-employer-link/.test(card);
  const text = toText(card);

  const salary = parseSalary(text);
  const respMatch = text.match(/(\d+)\s*(?:челове[кк]а?)?\s*откликнулись/i);
  const experience = (text.match(/Опыт[:\s]*([^О]{2,20})/) || [])[1] || null;

  const idM = href.match(/vacancy\/(\d+)/);
  return {
    id: idM ? idM[1] : null,
    title,
    href: href ? (href.startsWith('http') ? href : 'https://hh.ru' + href) : null,
    employer,
    address,
    rating: Number(rating) || null,
    reviews: Number((reviews.match(/(\d+)/) || [])[1]) || null,
    trusted,
    salary,
    responses: respMatch ? Number(respMatch[1]) : null,
    experience: experience ? experience.trim() : null,
  };
}

async function fetchJobs(ctx = {}) {
  const query = ctx.query || DEFAULT_QUERY;
  const url = `https://hh.ru/search/vacancy?text=${encodeURIComponent(query)}&order_by=publication_time&items_on_page=${Math.min(ctx.limit || 50, 100)}&only_with_salary=false`;
  const cookie = accounts.cookieHeader('hh', 'hh.ru');
  const r = await request(url, {
    headers: { 'User-Agent': UA, 'Referer': 'https://hh.ru/', 'Accept-Language': 'ru-RU,ru;q=0.9', ...(cookie ? { Cookie: cookie } : {}) },
    timeout: ctx.timeout || 30000, retries: 1,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);

  const out = [];
  for (const card of cards(r.text)) {
    const p = parseCard(card);
    if (!p.title || !p.id) continue;
    out.push(makeJob(ID, {
      externalId: p.id,
      title: p.title,
      body: p.experience ? `Опыт: ${p.experience}\n${p.address || ''}` : (p.address || ''),
      url: p.href,
      price: p.salary,
      publishedAt: null,
      category: [],
      location: p.address || null,
      client: {
        name: p.employer || null,
        rating: p.rating,
        reviews: p.reviews,
        verified: p.trusted,
      },
      stats: { responses: p.responses },
      raw: { experience: p.experience },
    }));
    if (out.length >= (ctx.limit || 50)) break;
  }
  return out;
}

async function check() {
  const cookie = accounts.cookieHeader('hh', 'hh.ru');
  try {
    const r = await request('https://hh.ru/search/vacancy?text=python&items_on_page=5', {
      headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) }, timeout: 15000, retries: 0,
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true, account: cookie ? 'cookies' : 'guest', note: `найдено карточек: ${cards(r.text).length}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { id: ID, label: 'hh.ru', kind: 'jobs', needsAuth: false, enabled: true, fetch: fetchJobs, check, parseCard, DEFAULT_QUERY };
