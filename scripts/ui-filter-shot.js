'use strict';
/* визуальная проверка фильтра источников */
const path = require('path');
const { chromium } = require('playwright');
const OUT = path.join(__dirname, '..', 'output');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:3410', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // оставляем только Telegram
  const boxes = page.locator('#f-sources input');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) {
    const id = await boxes.nth(i).getAttribute('value');
    const checked = await boxes.nth(i).isChecked();
    if (id === 'telegram' && !checked) await boxes.nth(i).check();
    else if (id !== 'telegram' && checked) await boxes.nth(i).uncheck();
  }
  await page.waitForTimeout(1500);
  const badges = await page.locator('#list .card .badge.src').allTextContents();
  console.log('источники в ленте:', [...new Set(badges)].join(', '), '| карточек:', badges.length);
  await page.screenshot({ path: path.join(OUT, 'filter-telegram.png') });

  // пустой выбор
  await page.click('#f-sources button:has-text("снять все")');
  await page.waitForTimeout(1200);
  console.log('карточек при пустом выборе:', await page.locator('#list .card').count());
  await page.screenshot({ path: path.join(OUT, 'filter-empty.png') });

  console.log('ошибок JS:', errors.length ? errors.join(' | ') : 'нет');
  await browser.close();
})();
