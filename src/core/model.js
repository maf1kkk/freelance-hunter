'use strict';
/**
 * Единая модель заказа/вакансии.
 * Любой источник приводит свои данные к Job через makeJob().
 */
const crypto = require('crypto');
const { normalize } = require('../filters');

const VERDICTS = ['prime', 'good', 'meh', 'bad', 'blocked'];

/** Синонимы для нормализации заголовка при дедупликации */
const TITLE_STOP = new Set([
  'нужен', 'нужна', 'нужно', 'ищу', 'ищем', 'требуется', 'заказ', 'заказа', 'работа', 'вакансия',
  'на', 'и', 'в', 'для', 'от', 'до', 'с', 'со', 'без', 'под', 'над', 'про', 'за', 'по', 'а', 'к',
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on',
]);

function hash(str) {
  return crypto.createHash('sha1').update(String(str)).digest('hex').slice(0, 12);
}

function cleanTitle(t) {
  return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Создаёт нормализованный объект Job.
 * @param {string} source — id источника
 * @param {object} p — сырые поля
 */
function makeJob(source, p = {}) {
  const id = p.id || `${source}:${p.externalId || hash(p.title + (p.url || ''))}`;
  const publishedAt = toTs(p.publishedAt) || Date.now();
  const price = normalizePrice(p.price, p.currency, p.priceText);

  return {
    id,
    source,
    sourceLabel: p.sourceLabel || source,
    externalId: p.externalId != null ? String(p.externalId) : null,
    title: cleanTitle(p.title),
    body: String(p.body || '').trim().slice(0, 8000),
    url: p.url || null,
    urlDirect: p.urlDirect || p.url || null,
    price,
    publishedAt,
    deadline: p.deadline || null,
    category: toArray(p.category).slice(0, 10),
    tags: toArray(p.tags).slice(0, 25),
    sites: toArray(p.sites).slice(0, 10),
    client: normalizeClient(p.client),
    stats: {
      responses: numOrNull(p.stats && p.stats.responses),
      views: numOrNull(p.stats && p.stats.views),
      ...(p.stats || {}),
    },
    location: p.location || null,
    employmentType: p.employmentType || null,
    remote: p.remote != null ? Boolean(p.remote) : null,
    quality: null,
    dedupe: { key: fingerprint(p.title, price), groupId: null, duplicates: [] },
    raw: p.raw || null,
    storedAt: Date.now(),
  };
}

function toArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v).split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toTs(v) {
  if (!v) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function normalizePrice(price, currency, priceText) {
  if (price == null && !priceText) return { min: null, max: null, currency: currency || null, text: '' };
  if (typeof price === 'object' && price !== null) {
    return {
      min: numOrNull(price.min),
      max: numOrNull(price.max),
      currency: price.currency || currency || 'RUB',
      text: price.text || priceText || '',
    };
  }
  const n = numOrNull(price);
  return { min: n, max: n, currency: currency || 'RUB', text: priceText || (n != null ? String(n) : '') };
}

function normalizeClient(c) {
  if (!c) return { name: null, id: null, rating: null, reviews: null, orders: null, ageDays: null, verified: null, hiredPercent: null };
  return {
    name: c.name || null,
    id: c.id != null ? String(c.id) : null,
    rating: numOrNull(c.rating),
    reviews: numOrNull(c.reviews),
    orders: numOrNull(c.orders),
    ageDays: numOrNull(c.ageDays),
    verified: c.verified != null ? Boolean(c.verified) : null,
    hiredPercent: numOrNull(c.hiredPercent),
    url: c.url || null,
  };
}

/** Ключ для точного дедупа: заголовок + цена */
function fingerprint(title, price) {
  const t = normalize(title).replace(/[^a-zа-я0-9]+/gi, ' ').trim();
  const p = price && price.min != null ? Math.round(price.min) : 0;
  return hash(`${t}|${p}`);
}

/** Токены заголовка без стоп-слов */
function titleTokens(title) {
  return normalize(title)
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !TITLE_STOP.has(w));
}

/**
 * Оценка оплаты в час. Грубая: объём текста → оценка часов.
 * @returns {number|null} руб/час
 */
function salaryPerHour(job) {
  const p = job.price;
  if (!p || p.min == null) return null;
  const len = (job.body || '').length;
  const titleLen = (job.title || '').length;
  let hours = 1;
  if (len > 4000) hours = 40;
  else if (len > 2000) hours = 24;
  else if (len > 900) hours = 14;
  else if (len > 350) hours = 7;
  else if (len > 120) hours = 4;
  else hours = 2;
  if (titleLen > 120) hours *= 1.3;
  const amount = p.max != null && p.max > p.min ? (p.min + p.max) / 2 : p.min;
  if (!amount || !hours) return null;
  const cur = p.currency === 'USD' ? 90 : p.currency === 'EUR' ? 100 : 1;
  return Math.round((amount / hours) * cur);
}

/** Токены текста (для точного сопоставления слов) */
function tokenize(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9+#.]+/)
    .filter(Boolean);
}

/** Возможные основы слова (слово + варианты со снятым окончанием) */
const SUFFIXES = [
  'иями', 'ями', 'ами', 'ами', 'ев', 'ов', 'ей', 'ой', 'ый', 'ий', 'ая', 'яя', 'ое', 'ее',
  'ые', 'ие', 'ам', 'ям', 'ах', 'ях', 'ом', 'ем', 'чик', 'щик', 'ик', 'ер', 'ль', 'ца', 'ть',
  'ка', 'ке', 'ки', 'а', 'я', 'ы', 'и', 'о', 'е', 'у', 'ю', 'ь', 'й',
];

/** Кэш основ — одни и те же слова встречаются в тысячах заказов */
const stemCache = new Map();

function computeStems(w) {
  const s = String(w || '').toLowerCase();
  const out = new Set([s]);
  for (const suf of SUFFIXES) {
    if (s.length - suf.length >= 3 && s.endsWith(suf)) out.add(s.slice(0, -suf.length));
  }
  const noDigits = s.replace(/\d+$/, '');
  if (noDigits && noDigits !== s) out.add(noDigits);
  return out;
}

function stems(w) {
  const key = String(w || '').toLowerCase();
  const hit = stemCache.get(key);
  if (hit) return hit;
  const out = computeStems(key);
  if (stemCache.size > 50000) stemCache.clear();
  stemCache.set(key, out);
  return out;
}

module.exports = {
  makeJob, fingerprint, titleTokens, salaryPerHour, normalizePrice, toTs, hash, VERDICTS,
  tokenize, stems, SUFFIXES,
};
