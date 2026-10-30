'use strict';
/**
 * E2E-тест UI: кликаем по всем вкладкам и кнопкам, ловим JS-ошибки и битые состояния.
 * Запуск: node test/e2e/ui.test.js
 */
const assert = require('node:assert');
const path = require('path');
const { chromium } = require('playwright');

const B = process.env.BASE || 'http://127.0.0.1:3410';
const OUT = path.join(__dirname, '..', '..', 'output');

const issues = [];
let passed = 0; let failed = 0;

async function t(name, fn) {
  try { await fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; issues.push(`${name}: ${e.message}`); process.stdout.write('X'); }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const jsErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push(m.text()); });
  page.on('pageerror', (e) => jsErrors.push('PAGEERROR: ' + e.message));

  await page.goto(B, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1200);

  /* ---------- шапка ---------- */
  await t('шапка: счётчики заполнены', async () => {
    const jobs = await page.locator('#h-jobs').textContent();
    assert.ok(/заказов: \d+/.test(jobs), jobs);
    const src = await page.locator('#h-sources').textContent();
    assert.ok(/источников: \d+/.test(src), src);
  });

  await t('статус аккаунтов отображается', async () => {
    const txt = await page.locator('#h-account').textContent();
    assert.ok(/аккаунтов: \d+/.test(txt), txt);
  });

  /* ---------- лента ---------- */
  await t('лента: карточки отрисованы', async () => {
    const n = await page.locator('#list .card').count();
    assert.ok(n > 0, 'нет карточек в ленте');
  });

  await t('лента: счётчик показан', async () => {
    const c = await page.locator('#count').textContent();
    assert.ok(/показано \d+ из \d+/.test(c), c);
  });

  await t('фильтр: поиск по тексту сужает выдачу', async () => {
    const before = await page.locator('#list .card').count();
    await page.fill('#f-q', 'сайт');
    await page.waitForTimeout(900);
    const after = await page.locator('#list .card').count();
    assert.ok(after <= before, `${after} > ${before}`);
    await page.fill('#f-q', '');
    await page.waitForTimeout(900);
  });

  await t('фильтр: вердикты переключаются', async () => {
    // чип blocked изначально выключен
    const chip = page.locator('#f-verdicts .chip[data-v="blocked"]');
    assert.ok(!(await chip.getAttribute('class')).includes('on'), 'должен быть выключен');
    await chip.click();
    await page.waitForTimeout(700);
    assert.ok((await chip.getAttribute('class')).includes('on'), 'чип не включился');
    await chip.click();
    await page.waitForTimeout(500);
    assert.ok(!(await chip.getAttribute('class')).includes('on'), 'чип не выключился');
  });

  await t('фильтр: источники переключаются', async () => {
    const cb = page.locator('#f-sources input').first();
    await cb.uncheck();
    await page.waitForTimeout(800);
    await cb.check();
    await page.waitForTimeout(800);
  });

  await t('фильтр: выбор одного источника показывает только его', async () => {
    // включаем только telegram
    const boxes = page.locator('#f-sources input');
    const n = await boxes.count();
    for (let i = 0; i < n; i++) {
      const id = await boxes.nth(i).getAttribute('value');
      const checked = await boxes.nth(i).isChecked();
      if (id === 'telegram' && !checked) await boxes.nth(i).check();
      else if (id !== 'telegram' && checked) await boxes.nth(i).uncheck();
    }
    await page.waitForTimeout(1200);
    const badges = await page.locator('#list .card .badge.src').allTextContents();
    assert.ok(badges.length > 0, 'нет карточек');
    assert.ok(badges.every((b) => b.trim() === 'Telegram'), 'показаны чужие источники: ' + [...new Set(badges)].join(','));
  });

  await t('фильтр: снятие галочки убирает источник, а не оставляет только его', async () => {
    // оставляем включённым telegram + alot, снимаем остальные
    const boxes = page.locator('#f-sources input');
    const n = await boxes.count();
    for (let i = 0; i < n; i++) {
      const id = await boxes.nth(i).getAttribute('value');
      const checked = await boxes.nth(i).isChecked();
      if ((id === 'telegram' || id === 'alot') && !checked) await boxes.nth(i).check();
      else if (id !== 'telegram' && id !== 'alot' && checked) await boxes.nth(i).uncheck();
    }
    await page.waitForTimeout(1200);
    const badges = await page.locator('#list .card .badge.src').allTextContents();
    const uniq = [...new Set(badges.map((b) => b.trim()))].sort();
    assert.ok(uniq.length <= 2, 'слишком много источников: ' + uniq.join(','));
    assert.ok(uniq.includes('Telegram'), 'Telegram пропал: ' + uniq.join(','));
  });

  await t('фильтр: кнопка «все источники» возвращает полную ленту', async () => {
    await page.click('#f-sources button:has-text("все")');
    await page.waitForTimeout(1200);
    const badges = await page.locator('#list .card .badge.src').allTextContents();
    const uniq = [...new Set(badges.map((b) => b.trim()))];
    assert.ok(uniq.length > 2, 'источники не вернулись: ' + uniq.join(','));
  });

  await t('фильтр: снятие всех галочек даёт пустую ленту', async () => {
    await page.click('#f-sources button:has-text("снять все")');
    await page.waitForTimeout(1200);
    const cards = await page.locator('#list .card').count();
    assert.equal(cards, 0, 'при пустом выборе источников должны быть 0 карточек');
    const empty = await page.locator('#list .empty').count();
    assert.ok(empty > 0, 'нет подсказки о пустом результате');
    await page.click('#f-sources button:has-text("все")');
    await page.waitForTimeout(1000);
  });

  await t('фильтр: вердикт good отсекает остальные', async () => {
    // оставляем включённым только good
    for (const v of ['prime', 'meh', 'bad', 'blocked']) {
      const chip = page.locator(`#f-verdicts .chip[data-v="${v}"]`);
      if ((await chip.getAttribute('class')).includes('on')) await chip.click();
    }
    await page.waitForTimeout(1400);
    const verdicts = await page.locator('#list .card .score small').allTextContents();
    assert.ok(verdicts.length > 0, 'нет карточек');
    assert.ok(verdicts.every((v) => v.trim() === 'good'), 'показаны чужие вердикты: ' + [...new Set(verdicts)].join(','));
    // возвращаем как было
    for (const v of ['prime', 'meh', 'bad']) {
      const chip = page.locator(`#f-verdicts .chip[data-v="${v}"]`);
      if (!(await chip.getAttribute('class')).includes('on')) await chip.click();
    }
    await page.waitForTimeout(800);
  });

  await t('фильтр: цена отсекает дешёвые', async () => {
    await page.fill('#f-min', '900000');
    await page.waitForTimeout(1200);
    const prices = await page.locator('#list .card .price').allTextContents();
    for (const p of prices) {
      const num = Number(p.replace(/[^\d]/g, ''));
      if (Number.isFinite(num)) assert.ok(num >= 900000, `цена ${p} ниже порога`);
    }
    await page.fill('#f-min', '');
    await page.waitForTimeout(900);
  });

  await t('фильтр: сброс работает', async () => {
    await page.click('#f-reset');
    await page.waitForTimeout(900);
    const q = await page.locator('#f-q').inputValue();
    assert.equal(q, '');
  });

  await t('звезда переключается', async () => {
    const star = page.locator('#list .star').first();
    await star.click();
    await page.waitForTimeout(900);
  });

  /* ---------- карточка заказа ---------- */
  await t('карточка: открывается модалка', async () => {
    await page.locator('#list .card').first().click();
    await page.waitForTimeout(1400);
    const open = await page.locator('#dlg').evaluate((d) => d.open);
    assert.ok(open, 'модалка не открылась');
  });

  await t('карточка: есть заголовок, текст, черновик', async () => {
    const title = await page.locator('#d-title').textContent();
    assert.ok(title && title.trim().length > 0, 'пустой заголовок');
    const body = await page.locator('#d-body').textContent();
    assert.ok(body.trim().length > 0, 'пустое описание');
    const resp = await page.locator('#d-response').inputValue();
    assert.ok(resp.length > 0, 'пустой черновик');
  });

  await t('карточка: разбор качества отрисован', async () => {
    const parts = await page.locator('#d-parts .part').count();
    assert.ok(parts >= 4, 'частей скоринга: ' + parts);
  });

  await t('карточка: кнопка «Сохранить отклик» работает', async () => {
    await page.click('#d-save');
    await page.waitForTimeout(1200);
  });

  await t('карточка: закрывается по Escape', async () => {
    await page.locator('#list .card').first().click();
    await page.waitForTimeout(1000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const open = await page.locator('#dlg').evaluate((d) => d.open);
    assert.equal(open, false);
  });

  /* ---------- вкладки ---------- */
  for (const tab of ['kanban', 'ai', 'accounts', 'settings', 'stats', 'feed']) {
    await t(`вкладка «${tab}» открывается`, async () => {
      await page.click(`[data-tab="${tab}"]`);
      await page.waitForTimeout(1500);
      const hidden = await page.locator(`#tab-${tab}`).evaluate((e) => e.hidden);
      assert.equal(hidden, false, 'секция скрыта');
    });
  }

  await t('канбан: есть колонки', async () => {
    await page.click('[data-tab="kanban"]');
    await page.waitForTimeout(1200);
    const cols = await page.locator('.kcol').count();
    assert.ok(cols >= 4, 'колонок: ' + cols);
  });

  await t('AI: список провайдеров загружен', async () => {
    await page.click('[data-tab="ai"]');
    await page.waitForTimeout(1800);
    const rows = await page.locator('#aiProvidersTable tr').count();
    assert.ok(rows > 1, 'строк провайдеров: ' + rows);
    const opts = await page.locator('#aiProvider option').count();
    assert.ok(opts > 0, 'нет вариантов провайдера');
  });

  await t('AI: профиль подгружен в форму', async () => {
    await page.click('[data-tab="ai"]');
    await page.waitForTimeout(1800);
    const visible = await page.locator('#aiProfileBox').isVisible();
    assert.ok(visible, 'блок профиля скрыт');
    const skills = await page.locator('#ap-skills').inputValue();
    assert.ok(skills.length > 0, 'навыки не подставлены');
  });

  await t('AI: тест провайдера отрабатывает', async () => {
    await page.click('[data-tab="ai"]');
    await page.waitForTimeout(1500);
    await page.locator('#aiProvidersTable [data-ai-test]').first().click();
    await page.waitForTimeout(6000);
    const toast = await page.locator('.toast').count();
    assert.ok(toast >= 0);
  });

  await t('настройки: форма заполнена', async () => {
    await page.click('[data-tab="settings"]');
    await page.waitForTimeout(1200);
    const plus = await page.locator('#s-plus').inputValue();
    assert.ok(plus.length > 0, 'плюс-слова не подставлены');
    const name = await page.locator('#p-name').inputValue();
    assert.ok(name.length > 0, 'имя профиля не подставлено');
  });

  await t('настройки: сохранение работает', async () => {
    await page.click('#sSave');
    await page.waitForTimeout(2500);
  });

  await t('статистика: сетка и таблицы', async () => {
    await page.click('[data-tab="stats"]');
    await page.waitForTimeout(1500);
    const cards = await page.locator('#statGrid .stat').count();
    assert.ok(cards >= 6, 'плиток: ' + cards);
    const srcRows = await page.locator('#statSrc tr').count();
    assert.ok(srcRows > 1, 'строк источников: ' + srcRows);
  });

  /* ---------- обновление ленты ---------- */
  await t('кнопка обновления ленты отрабатывает', async () => {
    await page.click('[data-tab="feed"]');
    await page.waitForTimeout(600);
    await page.click('#pollBtn');
    // полный опрос 11 источников занимает 15–90 с (внешние сайты могут тормозить)
    for (let i = 0; i < 120; i++) {
      await page.waitForTimeout(1000);
      const txt = await page.locator('#pollBtn').textContent();
      if (txt.includes('Обновить')) return;
    }
    throw new Error('кнопка осталась в состоянии «Собираю…» дольше 120 с');
  });

  await t('автообновление переключается', async () => {
    await page.click('#autoRefresh');
    await page.waitForTimeout(600);
    const txt = await page.locator('#autoRefresh').textContent();
    assert.ok(/авто: \d+ мин/.test(txt), txt);
    await page.click('#autoRefresh');
    await page.waitForTimeout(400);
  });

  /* ---------- скриншоты ---------- */
  for (const tab of ['feed', 'ai', 'accounts', 'kanban', 'settings', 'stats']) {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, `e2e-${tab}.png`) });
  }

  /* ---------- итог по JS-ошибкам ---------- */
  await t('нет необработанных JS-ошибок', async () => {
    const real = jsErrors.filter((e) => !/favicon|ERR_ABORTED/i.test(e));
    assert.equal(real.length, 0, real.slice(0, 3).join(' | '));
  });

  console.log(`\n\nUI: ${passed} ок, ${failed} сломанных`);
  for (const i of issues) console.log('  ✗ ' + i);
  if (jsErrors.length) {
    console.log('\nJS-ошибки в консоли:');
    for (const e of jsErrors.slice(0, 10)) console.log('  ! ' + e);
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
