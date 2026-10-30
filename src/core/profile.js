'use strict';
/**
 * Профиль исполнителя: навыки, ставка, портфолио, шаблоны.
 * Хранится в settings.profile, используется генератором откликов.
 */
const { salaryPerHour } = require('./model');

function load(settings) {
  const p = (settings && settings.profile) || {};
  return {
    name: p.name || '',
    title: p.title || '',
    skills: p.skills || '',
    hourlyRate: p.hourlyRate ?? null,
    experience: p.experience || '',
    portfolio: Array.isArray(p.portfolio) ? p.portfolio : [],
    contacts: p.contacts || '',
    defaultDeadline: p.defaultDeadline || '2–3 дня',
  };
}

/** Текстовый блок «О себе» для отклика */
function signature(profile) {
  const lines = [];
  if (profile.title) lines.push(profile.title);
  if (profile.skills) lines.push(profile.skills);
  if (profile.experience) lines.push(profile.experience);
  if (profile.portfolio?.length) lines.push(`Портфолио: ${profile.portfolio.slice(0, 3).join(', ')}`);
  if (profile.contacts) lines.push(profile.contacts);
  return lines.join('.\n');
}

/**
 * Рекомендованная цена по заказу.
 * Если указан часовой ставкой — считаем от оценки часов; иначе — от рыночной цены заказа.
 */
function suggestPrice(job, profile) {
  if (profile.hourlyRate) {
    const rate = salaryPerHour(job);
    const hours = rate ? Math.round(job.price?.min / rate) || 8 : 8;
    const val = Math.round((profile.hourlyRate * hours) / 100) * 100;
    return { min: val, max: Math.round((val * 1.25) / 100) * 100, currency: 'RUB', text: `${val}–${Math.round((val * 1.25) / 100) * 100} ₽` };
  }
  if (job.price?.min) {
    const base = job.price.min;
    return {
      min: base,
      max: job.price.max ?? base,
      currency: job.price.currency || 'RUB',
      text: job.price.text || String(base),
    };
  }
  return { min: null, max: null, currency: 'RUB', text: 'по договорённости' };
}

/** Оценка срока */
function suggestDeadline(job, profile) {
  const len = (job.body || '').length;
  if (len > 3000) return '1–2 недели';
  if (len > 1200) return '5–7 дней';
  if (len > 400) return '3–5 дней';
  if (len > 100) return '2–3 дня';
  return profile.defaultDeadline || '1–2 дня';
}

module.exports = { load, signature, suggestPrice, suggestDeadline };
