'use strict';
/**
 * Общие помощники автоотклика на Playwright.
 * Используется постоянный профиль в data/profiles/<service>/ и куки из data/accounts.json.
 */
const fs = require('fs');
const path = require('path');
const accounts = require('../core/accounts');

const PROFILES_DIR = path.join(__dirname, '..', '..', 'data', 'profiles');
const SHOTS_DIR = path.join(__dirname, '..', '..', 'output', 'apply-logs');

function profileDir(service) {
  return path.join(PROFILES_DIR, service);
}

function ensureDirs(service) {
  fs.mkdirSync(profileDir(service), { recursive: true });
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
}

/**
 * Открывает браузер с профилем сервиса и применяет куки из accounts.json.
 * @returns {Promise<{browser, context, page}>}
 */
async function open(service, { headless = true } = {}) {
  const { chromium } = require('playwright');
  ensureDirs(service);
  const context = await chromium.launchPersistentContext(profileDir(service), {
    headless,
    viewport: { width: 1440, height: 900 },
    locale: 'ru-RU',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  // подставляем куки, если они импортированы
  const cookies = accounts.cookiesFor(service);
  if (cookies.length) {
    try { await context.addCookies(cookies.filter((c) => c.domain)); } catch { /* часть кук может быть невалидна */ }
  }
  const page = context.pages()[0] || await context.newPage();
  return { browser: null, context, page };
}

async function close(ctx) {
  try { await ctx.context.close(); } catch { /* уже закрыт */ }
}

/** Скриншот ошибки — чтобы понять, что пошло не так */
async function shot(page, name) {
  try {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const file = path.join(SHOTS_DIR, `${name}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch {
    return null;
  }
}

/** Ищет первый видимый элемент по списку селекторов */
async function firstVisible(page, selectors, timeout = 8000) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1000 })) return loc;
    } catch { /* следующий */ }
  }
  return null;
}

module.exports = { open, close, shot, firstVisible, profileDir, PROFILES_DIR, SHOTS_DIR };
