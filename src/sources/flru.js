'use strict';
/**
 * FL.ru — биржа фриланс-заказов.
 * Парсит HTML-ленту https://www.fl.ru/projects/ (работает и без авторизации).
 * С куками fl.ru дополнительно доступна статистика заказчика.
 */
const { request } = require('../core/http');
const { makeJob } = require('../core/model');
const { parseAgo, parseDurationDays } = require('../core/time');
const accounts = require('../core/accounts');
const { toText, parseMoney, pick } = require('../core/html');

const ID = 'flru';
const BASE = 'https://www.fl.ru';
const LIST_URL = `${BASE}/projects/`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function cardBlocks(html) {
  const out = [];
  const re = /id="project-item(\d+)"/g;
  const hits = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    hits.push({ index: m.index, id: m[1] });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].index;
    const end = i + 1 < hits.length ? hits[i + 1].index : html.length;
    out.push({ id: hits[i].id, html: html.slice(start, end) });
  }
  return out;
}

function parseCard(card) {
  const html = card.html;

  const title = toText(pick(html, /id="prj_name_\d+"[^>]*>([\s\S]*?)<\/a>/) || '');
  const href = pick(html, /id="prj_name_\d+"[^>]*href="([^"]+)"/) || pick(html, /<a[^>]+href="(\/projects\/[^"]+)"/);
  const priceText = toText(pick(html, /b-post__price[^>]*>([\s\S]*?)<\/div>/) || '');
  const desc = toText(pick(html, /b-post__body[^>]*>[\s\S]*?b-post__txt[^>]*>([\s\S]*?)<\/div>/) || '');

  const views = toText(pick(html, /Количество просмотров[\s\S]*?<span class="text-7">([\s\S]*?)<\/span>/) || '');
  const responsesText = toText(
    pick(html, /Количество ответов[\s\S]*?<\/svg>\s*([\s\S]*?)<\/span>/)
    || pick(html, /data-id="fl-view-count-href"[^>]*>([\s\S]*?)<\/span>/)
    || '',
  );
  const agoText = toText(pick(html, /text-gray-opacity-4[^>]*>([\s\S]*?)<\/span>/) || '');

  const money = parseMoney(priceText);
  return {
    id: card.id,
    title,
    href: href ? (href.startsWith('http') ? href : BASE + href) : `${BASE}/projects/${card.id}/`,
    priceText,
    money,
    desc,
    views: Number((views.match(/(\d[\d\s]*)/)?.[1] || '').replace(/[^\d]/g, '')) || null,
    responses: Number(responsesText.match(/(\d+)/)?.[1]) || 0,
    publishedAt: parseAgo(agoText),
  };
}

/** Дополнительное обогащение страницы заказа (клиент, возраст аккаунта, верификация) */
async function enrich(job, cookie) {
  try {
    const r = await request(job.url, {
      headers: { 'User-Agent': UA, 'Referer': LIST_URL, ...(cookie ? { Cookie: cookie } : {}) },
      timeout: 15000, retries: 0,
    });
    if (!r.ok) return job;
    const html = r.text;

    const ageText = pick(html, /Зарегистрирован:<\/span>\s*<span[^>]*>([^<]+)</);
    const ageDays = ageText ? parseDurationDays(ageText) : null;

    const body = toText(pick(html, /id="projectp\d+"[^>]*>([\s\S]*?)<\/div>/) || '');
    const cat = toText(pick(html, /itemprop="name">([^<]+)<\/span>/) || '');

    const safeDeal = /Безопасн\w+ Сделк/i.test(html);
    const verified = /Верифицированный пользователь/i.test(html);

    // ответы на странице заказа
    const resp = toText(pick(html, /Количество ответов[\s\S]*?<\/svg>\s*([\s\S]*?)<\/span>/) || '');

    job.client = {
      ...job.client,
      ageDays: ageDays ?? job.client.ageDays,
      verified: verified || job.client.verified,
      safeDeal,
    };
    if (body && body.length > job.body.length) job.body = body;
    if (cat) job.category = [cat];
    const respNum = Number(resp.match(/(\d+)/)?.[1]);
    if (Number.isFinite(respNum)) job.stats.responses = respNum;
    job.raw = { ...(job.raw || {}), enriched: true };
  } catch { /* enrichment не критичен */ }
  return job;
}

async function fetchJobs(ctx = {}) {
  const cookie = accounts.cookieHeader('flru', 'fl.ru');
  const r = await request(LIST_URL, {
    headers: { 'User-Agent': UA, 'Referer': BASE, 'Accept-Language': 'ru-RU,ru;q=0.9', ...(cookie ? { Cookie: cookie } : {}) },
    timeout: ctx.timeout || 25000, retries: 1,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);

  const cards = cardBlocks(r.text);
  const limit = ctx.limit || 60;
  const jobs = [];
  for (const card of cards) {
    const p = parseCard(card);
    if (!p.title) continue;
    jobs.push(makeJob(ID, {
      externalId: p.id,
      title: p.title,
      body: p.desc,
      url: p.href,
      price: p.money ? { min: p.money.min, max: p.money.max, currency: 'RUB', text: p.priceText } : null,
      publishedAt: p.publishedAt,
      stats: { responses: p.responses, views: p.views },
      client: { name: null },
      raw: { href: p.href },
    }));
    if (jobs.length >= limit) break;
  }

  // обогащение топ-кандидатов (по цене) — не больше 10 страниц
  if (ctx.enrich !== false) {
    const top = [...jobs].sort((a, b) => (b.price?.min || 0) - (a.price?.min || 0)).slice(0, 10);
    for (const j of top) await enrich(j, cookie);
  }
  return jobs;
}

async function check(ctx = {}) {
  const cookie = accounts.cookieHeader('flru', 'fl.ru');
  try {
    const r = await request(LIST_URL, { headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) }, timeout: 15000, retries: 0 });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const hasLogin = /Выйти|Вход|Войти/i.test(r.text);
    return { ok: true, account: cookie ? 'cookies' : 'guest', note: cookie ? 'куки подгружены' : 'работает как гость' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { id: ID, label: 'FL.ru', kind: 'exchange', needsAuth: false, enabled: true, fetch: fetchJobs, check, parseCard };
