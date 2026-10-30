#!/usr/bin/env node
'use strict';
/**
 * Автокуки: открывает видимое окно браузера, ты логинишься на alot.pro
 * вручную ОДИН раз, скрипт сохраняет UID+S в data/session.json
 * и полный профиль браузера в browser/state/ (для будущих автооткликов
 * на биржах: kwork, fl.ru и т.д.).
 *
 * Запуск: npm run login
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const alot = require('../src/alot');

const STATE_DIR = path.join(__dirname, 'state');

(async () => {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(STATE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  console.log('Открываю alot.pro... Логинься через ВК/Яндекс/Google в открывшемся окне.');
  console.log('После входа скрипт сам поймает куки. Не закрывай окно вручную — закрою я после сохранения.');
  await page.goto('https://alot.pro/profile/', { waitUntil: 'domcontentloaded' });

  // Ждём, пока в localStorage появятся user.id и user.session (признак входа)
  let session = null;
  for (let i = 0; i < 600; i++) { // до 10 минут
    await page.waitForTimeout(1000);
    try {
      const uid = await page.evaluate(() => localStorage.getItem('user.id'));
      const s = await page.evaluate(() => localStorage.getItem('user.session'));
      if (uid && s) { session = { uid, s }; break; }
    } catch {}
  }

  if (session) {
    alot.saveSession(session.uid, session.s);
    console.log(`\nСессия сохранена: UID=${session.uid}`);
    console.log(`Файл: ${alot.SESSION_FILE}`);
    console.log('Профиль браузера сохранён в browser/state/ — логиниться больше не нужно.');
  } else {
    console.log('\nНе дождался входа за 10 минут. Попробуй ещё раз: npm run login');
  }

  await context.close();
  process.exit(session ? 0 : 1);
})();
