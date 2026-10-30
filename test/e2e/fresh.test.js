'use strict';
/**
 * «Свежая установка»: пустая база, нет сессии, первый запуск.
 * Проверяем, что UI не падает и показывает корректные пустые состояния.
 * Запуск: node test/e2e/fresh.test.js
 */
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-fresh-'));
const STORE = path.join(TMP, 'store.json');
const ACCOUNTS = path.join(TMP, 'accounts.json');
const PORT = 3499;
const BASE = `http://127.0.0.1:${PORT}`;

const issues = [];
let passed = 0; let failed = 0;

async function t(name, fn) {
  try { await fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; issues.push(`${name}: ${e.message}`); process.stdout.write('X'); }
}

(async () => {
  // окружение: пустая база, отдельные аккаунты, порт
  const env = { ...process.env, FH_DB_FILE: STORE, PORT: String(PORT) };
  fs.writeFileSync(ACCOUNTS, '{}');
  const server = spawn('node', [path.join(ROOT, 'web', 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const serverErr = [];
  server.stderr.on('data', (d) => serverErr.push(String(d)));
  await new Promise((r) => setTimeout(r, 1800));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const jsErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push(m.text()); });
  page.on('pageerror', (e) => jsErrors.push('PAGEERROR: ' + e.message));

  try {
    await t('сервер поднялся с пустой базой', async () => {
      const r = await fetch(BASE + '/api/health');
      assert.equal(r.status, 200);
    });

    await t('UI открывается без ошибок', async () => {
      await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1500);
      const real = jsErrors.filter((e) => !/favicon/i.test(e));
      assert.equal(real.length, 0, real.join(' | '));
    });

    await t('пустая лента показывает подсказку, а не ошибку', async () => {
      const txt = await page.locator('#list').textContent();
      assert.ok(/Пусто|Обнови/i.test(txt), txt.slice(0, 120));
    });

    await t('счётчики показывают нули, а не NaN', async () => {
      const jobs = await page.locator('#h-jobs').textContent();
      assert.ok(/заказов: 0/.test(jobs), jobs);
      const prime = await page.locator('#h-prime').textContent();
      assert.ok(!/NaN|undefined/.test(prime), prime);
    });

    await t('все вкладки открываются на пустой базе', async () => {
      for (const tab of ['kanban', 'ai', 'accounts', 'settings', 'stats', 'feed']) {
        await page.click(`[data-tab="${tab}"]`);
        await page.waitForTimeout(900);
        const hidden = await page.locator(`#tab-${tab}`).evaluate((e) => e.hidden);
        assert.equal(hidden, false, tab);
      }
    });

    await t('канбан на пустой базе не падает', async () => {
      await page.click('[data-tab="kanban"]');
      await page.waitForTimeout(1000);
      const cols = await page.locator('.kcol').count();
      assert.ok(cols >= 4, 'колонок: ' + cols);
    });

    await t('статистика на пустой базе показывает нули', async () => {
      await page.click('[data-tab="stats"]');
      await page.waitForTimeout(1200);
      const cards = await page.locator('#statGrid .stat').count();
      assert.ok(cards >= 6);
      const txt = await page.locator('#statGrid').textContent();
      assert.ok(!/NaN|undefined/.test(txt), 'есть NaN/undefined');
    });

    await t('AI-вкладка на пустой базе: профиля нет, но панель работает', async () => {
      await page.click('[data-tab="ai"]');
      await page.waitForTimeout(1800);
      const rows = await page.locator('#aiProvidersTable tr').count();
      assert.ok(rows > 1, 'провайдеры не загрузились');
      const visible = await page.locator('#aiProfileBox').isVisible();
      assert.equal(visible, false, 'профиля быть не должно');
    });

    await t('карточка заказа при отсутствии заказов → понятная ошибка', async () => {
      const r = await fetch(BASE + '/api/jobs/несуществующий');
      assert.equal(r.status, 404);
      const d = await r.json();
      assert.ok(d.error);
    });

    await t('API списка заказов на пустой базе → пустой массив', async () => {
      const d = await (await fetch(BASE + '/api/jobs')).json();
      assert.deepEqual(d.items, []);
      assert.equal(d.total, 0);
    });

    await t('настройки на пустой базе имеют дефолты', async () => {
      const d = await (await fetch(BASE + '/api/settings')).json();
      assert.ok(d.search && d.quality && d.ai);
      assert.ok(Array.isArray(d.search.keywordsPlus));
    });

    await t('сохранение настроек на пустой базе работает', async () => {
      const r = await fetch(BASE + '/api/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ search: { keywordsPlus: ['тест'] } }),
      });
      assert.equal(r.status, 200);
      const d = await (await fetch(BASE + '/api/settings')).json();
      assert.deepEqual(d.search.keywordsPlus, ['тест']);
    });

    await t('AI подбор без профиля → понятная ошибка', async () => {
      const r = await fetch(BASE + '/api/ai/match', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.ok(r.status >= 400);
      const d = await r.json();
      assert.ok(/резюме|профил/i.test(d.error), d.error);
    });

    await t('на диске создана валидная база SQLite', async () => {
      assert.ok(fs.existsSync(STORE), 'нет файла базы');
      const head = fs.readFileSync(STORE).subarray(0, 16).toString('latin1');
      assert.ok(head.startsWith('SQLite format 3'), 'не SQLite-файл');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(STORE, { readOnly: true });
      const n = db.prepare('SELECT COUNT(*) AS c FROM jobs').get().c;
      const s = db.prepare('SELECT value FROM settings WHERE key = ?').get('main');
      db.close();
      assert.equal(typeof n, 'number');
      assert.ok(s, 'нет настроек');
      assert.ok(JSON.parse(s.value).search, 'настройки без группы search');
    });

    await t('сервер не писал в stderr', async () => {
      const errs = serverErr.join('').trim();
      assert.ok(!/Error|at Object/.test(errs), errs.slice(0, 300));
    });
  } finally {
    await browser.close();
    server.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n\nFRESH: ${passed} ок, ${failed} сломанных`);
  for (const i of issues) console.log('  ✗ ' + i);
  process.exit(failed ? 1 : 0);
})();
