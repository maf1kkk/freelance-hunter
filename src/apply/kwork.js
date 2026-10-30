'use strict';
/**
 * Автоотклик на Kwork.
 * Открывает проект → «Предложить свои услуги» → заполняет описание и цену → отправляет.
 */
const browser = require('./browser');

const SELECTORS = {
  openBtn: [
    'button:has-text("Предложить свои услуги")',
    'a:has-text("Предложить свои услуги")',
    'button:has-text("Откликнуться")',
    'a:has-text("Откликнуться")',
  ],
  description: [
    'textarea[name="description"]',
    'textarea#description',
    'textarea[data-qa="offer-description"]',
    'textarea',
  ],
  price: [
    'input[name="price"]',
    'input#price',
    'input[data-qa="offer-price"]',
  ],
  submit: [
    'button:has-text("Отправить предложение")',
    'button:has-text("Отправить")',
    'button[type="submit"]',
  ],
};

/**
 * @param {object} job
 * @param {string} text
 * @param {object} opts { headless, dryRun, price }
 */
async function apply(job, text, opts = {}) {
  const { headless = true, dryRun = false, price } = opts;
  if (dryRun) {
    return { ok: true, dryRun: true, note: `подготовил отклик для ${job.url}` };
  }

  const ctx = await browser.open('kwork', { headless });
  const { page } = ctx;
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    const openBtn = await browser.firstVisible(page, SELECTORS.openBtn, 6000);
    if (openBtn) {
      await openBtn.click().catch(() => {});
      await page.waitForTimeout(2000);
    }

    const desc = await browser.firstVisible(page, SELECTORS.description, 8000);
    if (!desc) {
      const screenshot = await browser.shot(page, `kwork-${job.externalId || 'job'}`);
      return { ok: false, error: 'не найдено поле описания', screenshot };
    }
    await desc.fill(text);
    await page.waitForTimeout(300);

    const priceInput = await browser.firstVisible(page, SELECTORS.price, 3000);
    const amount = price || job.price?.min;
    if (priceInput && amount) {
      await priceInput.fill(String(amount)).catch(() => {});
    }

    const submit = await browser.firstVisible(page, SELECTORS.submit, 5000);
    if (!submit) {
      const screenshot = await browser.shot(page, `kwork-nosubmit-${job.externalId || 'job'}`);
      return { ok: false, error: 'не найдена кнопка отправки', screenshot };
    }
    await submit.click();
    await page.waitForTimeout(2500);

    const body = await page.content().catch(() => '');
    const sent = /предложение отправлено|вы отправили предложение|success/i.test(body);
    const screenshot = sent ? null : await browser.shot(page, `kwork-sent-${job.externalId || 'job'}`);
    return { ok: true, sent, screenshot, note: sent ? 'предложение отправлено' : 'возможно, отправлено (не подтверждено)' };
  } catch (e) {
    const screenshot = await browser.shot(page, `kwork-error-${job.externalId || 'job'}`);
    return { ok: false, error: String(e.message || e), screenshot };
  } finally {
    await browser.close(ctx);
  }
}

module.exports = { id: 'kwork', label: 'Kwork', apply, SELECTORS };
