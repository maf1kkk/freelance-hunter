'use strict';
/**
 * Генератор черновика отклика.
 * Использует профиль исполнителя (settings.profile) вместо хардкода.
 * ИИ (через MCP) может переопределить текст и вернуть его через mark_applied.
 */
const profileLib = require('./core/profile');
const { summarizeTask, clarifyQuestion } = require('./core/text');

/**
 * @param {object} job — нормализованный Job (или legacy project)
 * @param {object} settings — полные настройки (для профиля)
 */
function draftResponse(job, settings = {}) {
  const profile = profileLib.load(settings);
  const price = profileLib.suggestPrice(job, profile);
  const deadline = profileLib.suggestDeadline(job, profile);

  const lines = [
    'Здравствуйте!',
    '',
    `По вашему заказу «${job.title}»:`, 
    `1. Как сделаю: ${summarizeTask(job)}`,
    `2. Срок: ${deadline}.`,
    `3. Цена: ${price.text}.`,
    '',
  ];

  const sig = profileLib.signature(profile);
  lines.push(sig ? `О себе: ${sig}` : 'Опыт: веб-разработка (JS/TS, Python), автоматизация, вайбкодинг. Есть примеры работ — покажу по запросу.');
  lines.push('');
  lines.push(`Один уточняющий вопрос: ${clarifyQuestion(job)}`);

  return lines.filter((l) => l !== null).join('\n');
}

module.exports = { draftResponse };
