'use strict';
/** Разбор и форматирование времени. */

const UNITS = {
  минуту: 60, минуты: 60, минут: 60, минута: 60,
  час: 3600, часа: 3600, часов: 3600,
  день: 86400, дня: 86400, дней: 86400,
  неделю: 604800, недели: 604800, недель: 604800,
  месяц: 2592000, месяца: 2592000, месяцев: 2592000,
  год: 31536000, года: 31536000, лет: 31536000,
};

/**
 * «8 минут назад» / «2 часа назад» / «3 дня назад» → timestamp
 */
function parseAgo(text, now = Date.now()) {
  const t = String(text || '').toLowerCase().replace(/&nbsp;/g, ' ').trim();
  if (!t) return null;
  if (t.includes('сегодня')) return now - 3600000;
  if (t.includes('вчера')) return now - 86400000;
  const m = t.match(/(\d+)\s*([а-яё]+)/);
  if (m) {
    const n = Number(m[1]);
    const unit = UNITS[m[2].replace(/ё/g, 'е')];
    if (unit) return now - n * unit * 1000;
  }
  return null;
}

/** «10 месяцев» → дней */
function parseDurationDays(text) {
  const t = String(text || '').toLowerCase();
  const m = t.match(/(\d+)\s*([а-яё]+)/);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2].replace(/ё/g, 'е');
  if (u.startsWith('месяц')) return Math.round(n * 30.44);
  if (u.startsWith('год')) return Math.round(n * 365);
  if (u.startsWith('недел')) return Math.round(n * 7);
  if (u.startsWith('день') || u.startsWith('дн')) return n;
  if (u.startsWith('час')) return Math.round(n / 24);
  if (u.startsWith('минут')) return Math.round(n / 1440);
  return null;
}

function agoText(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  if (s < 2592000) return `${Math.floor(s / 86400)} дн назад`;
  return new Date(ts).toLocaleDateString('ru');
}

function startOfDay(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

module.exports = { parseAgo, parseDurationDays, agoText, startOfDay, UNITS };
