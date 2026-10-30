'use strict';
/**
 * Фильтры и классификация постов (совместимый слой).
 * Основной скоринг качества — в src/core/quality.js.
 */

function normalize(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е');
}

/** Приводит идентификатор биржи к каноническому виду: 'alot:kworkru' → 'kworkru' */
function siteId(site) {
  return String(site || '').replace(/^alot:/, '').trim();
}

/**
 * Классификация ТГ-поста: что это вообще такое.
 * order   — реальный заказ («нужно сделать», «ищу исполнителя»)
 * resume  — резюме («ищу работу», «моё портфолио»)
 * vacancy — вакансия в компанию («#вакансия», «оклад»)
 * promo   — самореклама исполнителя («мои услуги», «делаю под ключ»)
 */
function classifyTgPost(text) {
  const t = normalize(text);
  if (!t) return 'empty';

  const strongResume = ['меня зовут', 'мои услуги', 'предлагаю услуги', 'открыт к заказам', 'открыта к новым', 'я веб-дизайнер', 'я дизайнер и', '#резюме', 'ищу работу', 'ищу заказ', 'ищу проект', 'выполняю', 'готов взять'];
  const weakResume = ['моё портфолио', 'мои работы:', 'портфолио:', 'обо мне', 'стаж ', 'опыт — ', 'скину примеры', 'могу помочь с'];
  const resumeHits = [...strongResume, ...weakResume].filter((w) => t.includes(w));

  if (resumeHits.length && !t.includes('ищу исполнителя') && !t.includes('нужен специалист')) {
    if (strongResume.some((w) => t.includes(w))) return 'resume';
    if (weakResume.some((w) => t.includes(w))) return 'resume';
  }

  const vacancyHits = ['#вакансия', 'вакансия', 'требуется сотрудник', 'в команду', 'в компанию', 'зарплата', 'оклад', 'оформление по тк', 'график 5/2', 'полная занятость', 'собеседование'].filter((w) => t.includes(w));
  if (vacancyHits.length) return 'vacancy';

  const orderHits = ['нужно сделать', 'нужен специалист', 'нужен дизайнер', 'нужен разработчик', 'ищу исполнителя', 'ищу мастера', 'сколько стоит', 'бюджет ', 'оплата ', 'сделать под ключ', 'нужно разработать', 'нужна помощь', 'нужен человек', 'требуется сделать', 'нужно собрать', 'ищу того кто', 'требуется специалист', 'нужен frontend', 'нужен backend', 'нужен разраб'].filter((w) => t.includes(w));
  if (orderHits.length) return 'order';

  if (/^#?\s*(ищу|нужен|нужна|нужно)\b/im.test(t)) return 'order';
  return 'unknown';
}

/**
 * Legacy-скоринг (v1). Оставлен для совместимости со старыми сохранёнными данными.
 * @param {object} project
 * @param {object} settings
 */
function evaluate(project, settings = {}) {
  const reasons = [];
  const search = settings.search || settings;
  const text = normalize(`${project.title} ${project.body}`);
  const title = normalize(project.title);

  const minusHits = (search.keywordsMinus || []).filter((k) => text.includes(normalize(k)));
  if (minusHits.length) {
    return { verdict: 'skip', score: 0, reasons: [`минус-слова: ${minusHits.join(', ')}`] };
  }

  const plus = search.keywordsPlus || [];
  const titleHits = plus.filter((k) => title.includes(normalize(k)));
  const bodyHits = plus.filter((k) => text.includes(normalize(k)));
  if (plus.length && titleHits.length === 0 && bodyHits.length === 0) {
    return { verdict: 'skip', score: 0, reasons: ['нет ни одного плюс-слова'] };
  }

  const sites = search.sites || [];
  if (sites.length) {
    const canonical = siteId(project.site);
    const jobSites = Array.isArray(project.sites) ? project.sites.map(siteId) : [canonical];
    if (!jobSites.some((s) => sites.map(siteId).includes(s))) {
      return { verdict: 'skip', score: 0, reasons: [`биржа ${canonical} исключена`] };
    }
  }

  const price = project.internalPrice || project.price?.min || 0;
  const priceMin = search.priceMin ?? null;
  const priceMax = search.priceMax ?? null;
  if (priceMin != null && price && price < priceMin) {
    return { verdict: 'skip', score: 0, reasons: [`цена ${price} < минимума ${priceMin}`] };
  }
  if (priceMax != null && price && price > priceMax) {
    reasons.push(`цена ${price} выше максимума (не блокирует)`);
  }

  let score = 40;
  score += Math.min(titleHits.length * 20, 40);
  score += Math.min(bodyHits.length * 5, 15);
  if (price >= 10000) score += 10;
  if (price >= 50000) score += 10;

  if (titleHits.length) reasons.push(`плюс-слова в заголовке: ${titleHits.join(', ')}`);
  if (bodyHits.length) reasons.push(`плюс-слова в тексте: ${bodyHits.slice(0, 5).join(', ')}`);

  const verdict = score >= 70 ? 'match' : score >= 45 ? 'maybe' : 'weak';
  return { verdict, score: Math.min(score, 100), reasons };
}

module.exports = { evaluate, normalize, classifyTgPost, siteId };
