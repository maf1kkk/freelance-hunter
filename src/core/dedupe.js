'use strict';
/**
 * Дедупликация: один и тот же заказ часто висит на нескольких площадках
 * (или в Telegram-канале и на бирже). Схлопываем в группы.
 *
 * Правило слияния (консервативное!):
 *   — заголовки совпадают почти полностью (≥80% контентных слов совпали, минимум 2 слова)
 *   — И цены пересекаются (±15%)
 * Одинаковые заголовки + одинаковая цена = дубликат.
 */
const { fingerprint, titleTokens, hash, stems } = require('./model');

/** служебные слова, которые не несут смысла */
const STOP = new Set([
  'для', 'или', 'под', 'над', 'при', 'без', 'про', 'этот', 'эта', 'эти', 'все', 'всё',
  'так', 'же', 'быть', 'есть', 'надо', 'нужно', 'требуется', 'ищу', 'нужен', 'нужна',
]);

/** основы слов заголовка — чтобы «лендинг» и «лендинга» считались одним словом */
function stemSet(title) {
  const out = new Set();
  for (const w of titleTokens(title)) {
    for (const s of stems(w)) out.add(s);
  }
  return out;
}

/** значимые слова заголовка */
function contentTokens(title) {
  return titleTokens(title).filter((w) => w.length >= 3 && !STOP.has(w));
}

/** совпадает ли слово с одним из основ другого заголовка */
function wordMatches(word, otherStems) {
  const own = stems(word);
  for (const s of own) {
    if (otherStems.has(s)) return true;
    for (const t of otherStems) {
      if (s.length >= 4 && t.length >= 4 && Math.abs(s.length - t.length) <= 3 && (s.includes(t) || t.includes(s))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Покрытие заголовков: сколько значимых слов ОДНОГО найдено в другом.
 * Считаем от БОЛЬШЕГО набора — иначе короткий заголовок («Project Manager»)
 * всегда «покрывается» длинным и они склеиваются ошибочно.
 * @returns {{ratio:number, matched:number, total:number, big:number}}
 */
function titleCoverage(a, b) {
  const A = contentTokens(a);
  const B = contentTokens(b);
  if (!A.length || !B.length) return { ratio: 0, matched: 0, total: 0, big: 0 };
  const [small, big] = A.length <= B.length ? [A, B] : [B, A];
  const bigStems = new Set();
  for (const w of big) for (const s of stems(w)) bigStems.add(s);
  let matched = 0;
  for (const w of small) if (wordMatches(w, bigStems)) matched++;
  return { ratio: matched / big.length, matched, total: small.length, big: big.length };
}

/** Нормализованный вид заголовка для «простых» дублей */
function normTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !STOP_WORDS_FOR_TITLE.has(w))
    .join(' ')
    .trim();
}

const STOP_WORDS_FOR_TITLE = new Set([
  'нужен', 'нужна', 'нужно', 'ищу', 'ищем', 'требуется', 'заказ', 'заказа', 'работа',
  'вакансия', 'специалист', 'мастер', 'человек', 'для', 'под', 'над',
]);

/** Jaccard по множествам */
function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Нормализация без удаления стоп-слов — для точного сравнения заголовков */
function rawTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Заголовок из хештегов («#ищу #дизайнер #сайт») — обобщённый, склеивать нельзя */
function isTagTitle(t) {
  const words = String(t || '').split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const tags = words.filter((w) => w.startsWith('#')).length;
  return tags >= Math.max(2, words.length * 0.5);
}

/**
 * Пересекаются ли ценовые диапазоны (с допуском ~15%).
 * Точечная цена (min == max) — это вырожденный отрезок, он пересекается сам с собой.
 */
function priceOverlap(a, b, tol = 0.15) {
  if (!a || !b || a.min == null || b.min == null) return true; // цену не знаем — не мешаем
  const aMin = a.min;
  const aMax = a.max ?? a.min;
  const bMin = b.min;
  const bMax = b.max ?? b.min;
  const lo = Math.max(aMin, bMin);
  const hi = Math.min(aMax, bMax);
  if (lo <= hi) return true; // есть пересечение
  const gap = Math.min(Math.abs(aMin - bMax), Math.abs(bMin - aMax));
  const scale = Math.max(aMin, bMin, 1);
  return gap <= scale * tol;
}

function sameJob(x, y, opts = {}) {
  const minRatio = opts.minRatio ?? 0.8;
  const minMatched = opts.minMatched ?? 2;
  if (!x || !y) return false;

  // совпадение ссылки — самый надёжный признак
  if (x.url && y.url && x.url === y.url) return true;

  // теги-обобщения не склеиваем: «#ищу #дизайнер» подходит ко всему подряд
  if (isTagTitle(x.title) || isTagTitle(y.title)) return false;

  const pricesOk = priceOverlap(x.price, y.price);

  // полностью одинаковый заголовок
  if (rawTitle(x.title) && rawTitle(x.title) === rawTitle(y.title)) return pricesOk;

  const cov = titleCoverage(x.title, y.title);
  if (cov.matched < minMatched) return false;
  // если цену одного из заказов не знаем — требуем почти полного совпадения заголовков
  const priceKnown = x.price?.min != null && y.price?.min != null;
  const need = priceKnown ? minRatio : Math.max(minRatio, 0.9);
  return cov.ratio >= need && pricesOk;
}

/**
 * Группирует заказы.
 * @param {Array} jobs
 * @returns {Array<{groupId, jobs:Array, best:object}>}
 */
function group(jobs, opts = {}) {
  const groups = [];
  const buckets = new Map(); // fingerprint -> group index

  for (const job of jobs) {
    const fp = job.dedupe?.key || fingerprint(job.title, job.price);
    let gi = buckets.get(fp);
    if (gi == null) {
      groups.push({ groupId: hash(fp), jobs: [], best: null });
      gi = groups.length - 1;
      buckets.set(fp, gi);
    }
    groups[gi].jobs.push(job);
  }

  // второй проход: склейка разных fingerprint по похожему заголовку
  const merged = [];
  for (const g of groups) {
    let target = null;
    for (const ex of merged) {
      if (ex.jobs.some((j) => sameJob(j, g.jobs[0], opts))) { target = ex; break; }
    }
    if (target) target.jobs.push(...g.jobs);
    else merged.push(g);
  }

  for (const g of merged) {
    g.best = pickBest(g.jobs);
    g.groupId = hash(g.best.dedupe?.key || g.best.id);
    for (const j of g.jobs) {
      j.dedupe = j.dedupe || {};
      j.dedupe.groupId = g.groupId;
      j.dedupe.duplicates = g.jobs.filter((x) => x.id !== j.id).map((x) => ({ id: x.id, source: x.source, url: x.url }));
      j.dedupe.isPrimary = j.id === g.best.id;
    }
  }
  return merged;
}

/** Лучший представитель группы: больше данных, адекватная цена, наличие метрик клиента */
function pickBest(jobs) {
  const score = (j) => {
    let s = 0;
    if (j.body && j.body.length > 300) s += 3;
    if (j.price && j.price.min != null) s += 3;
    if (j.client && j.client.rating != null) s += 2;
    if (j.stats && j.stats.responses != null) s += 1;
    if (j.category && j.category.length) s += 1;
    s -= (j.publishedAt || 0) / 1e13; // более свежие лучше
    return s;
  };
  return [...jobs].sort((a, b) => score(b) - score(a))[0];
}

module.exports = {
  group, sameJob, normTitle, priceOverlap, pickBest, jaccard,
  stemSet, titleCoverage, contentTokens,
};
