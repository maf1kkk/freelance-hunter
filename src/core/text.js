'use strict';
/**
 * Текстовые утилиты для черновиков откликов.
 */

function cleanText(body) {
  return String(body || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function summarizeTask(job) {
  const body = cleanText(job.body);
  if (body.length > 220) return body.slice(0, 217) + '…';
  return body || 'выполню задачу по описанию';
}

function clarifyQuestion(job) {
  const text = `${job.title || ''} ${cleanText(job.body)}`.toLowerCase();
  // порядок важен: более специфичные темы проверяем первыми
  if (/бот|chat-?bot|телеграм|telegram|автоответ|рассылк/.test(text)) return 'какой функционал нужен в боте и как он будет принимать заявки?';
  if (/парсинг|парсер|scrap|выгрузк|сбор данных/.test(text)) return 'какой источник данных и в каком объёме нужно собирать?';
  if (/crm|битрикс|amo|битрикс24|1с|интеграц|api|вебхук/.test(text)) return 'с какой системой нужна интеграция и в обе стороны?';
  if (/карточк|дизайн|баннер|логотип|макет|фирменн|figma|иллюстрац/.test(text)) return 'есть ли готовый брендбук / примеры стиля, или собираем с нуля?';
  if (/лендинг|лендинг|landing|промо-?страниц/.test(text)) return 'есть ли референсы и примеры страниц, которые нравятся?';
  if (/сайт|вёрстк|верстк|лендинг|фронтенд|frontend|wordpress|tilda|сайт/.test(text)) return 'сколько страниц нужно и есть ли готовый дизайн?';
  if (/текст|статья|копирайт|ролик|видео|сценари|контент|презентац/.test(text)) return 'какой объём и есть ли ТЗ/бриф?';
  if (/реклам|таргет|продвиж|seo|smm|перфоманс/.test(text)) return 'какие KPI и бюджет на продвижение?';
  if (/опыт|стаж|junior|молодой|студент/.test(text)) return 'готов взять на себя часть задач и быстро погрузиться — ок?';
  return 'какой формат результата вы ожидаете и в каком сроке нужен?';
}

module.exports = { cleanText, summarizeTask, clarifyQuestion };
