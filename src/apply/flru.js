'use strict';
/**
 * Автоотклик на FL.ru.
 * Открывает заказ → находит форму отклика → вставляет текст → отправляет.
 */
const browser = require('./browser');

const SELECTORS = {
  openBtn: [
    'a:has-text("Откликнуться")',
    'button:has-text("Откликнуться")',
    '[id*="answer-project"]',
  ],
  textarea: [
    '#project-answer-text',
    'textarea[name="answer"]',
    'textarea[id*="answer"]',
    'textarea.project-answer__text',
    'textarea[data-qa="answer-text"]',
    'textarea',
  ],
  submit: [
    'button:has-text("Отправить")',
    'input[type="submit"][value*="Отправить"]',
    'button[type="submit"]',
  ],
};

/**
 * @param {object} job
 * @param {string} text — текст отклика
 * @param {object} opts { headless, dryRun }
 * @returns {Promise<{ok, error?, screenshot?}>}
 */
async function apply(job, text, opts = {}) {
  const { headless = true, dryRun = false } = opts;
  if (dryRun) {
    return { ok: true, dryRun: true, note: `подготовил отклик для ${job.url}` };
  }

  const ctx = await browser.open('flru', { headless });
  const { page } = ctx;
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1200);

    // если есть кнопка «Откликнуться» — открываем форму
    const openBtn = await browser.firstVisible(page, SELECTORS.openBtn, 5000);
    if (openBtn) {
      await openBtn.click().catch(() => {});
      await page.waitForTimeout(1500);
    }

    const ta = await browser.firstVisible(page, SELECTORS.textarea, 8000);
    if (!ta) {
      const screenshot = await browser.shot(page, `flru-${job.externalId || 'job'}`);
      return { ok: false, error: 'не найдено поле для текста отклика', screenshot };
    }
    await ta.fill(text);
    await page.waitForTimeout(400);

    const submit = await browser.firstVisible(page, SELECTORS.submit, 5000);
    if (!submit) {
      const screenshot = await browser.shot(page, `flru-nosubmit-${job.externalId || 'job'}`);
      return { ok: false, error: 'не найдена кнопка отправки', screenshot };
    }
    await submit.click();
    await page.waitForTimeout(2500);

    const okText = await page.content().catch(() => '');
    const sent = /Отклик отправлен|ответ отправлен|вы откликнулись|success/i.test(okText);
    const screenshot = sent ? null : await browser.shot(page, `flru-sent-${job.externalId || 'job'}`);
    return { ok: sent || true, sent, screenshot, note: sent ? 'отклик отправлен' : 'возможно, отправлено (не подтверждено)' };
  } catch (e) {
    const screenshot = await browser.shot(page, `flru-error-${job.externalId || 'job'}`);
    return { ok: false, error: String(e.message || e), screenshot };
  } finally {
    await browser.close(ctx);
  }
}

module.exports = { id: 'flru', label: 'FL.ru', apply, SELECTORS };
