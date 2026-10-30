'use strict';
/* финальная проверка «как пользователь»: поднимаем приложение и смотрим на результат */
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'output');
const PORT = 3421;
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  const server = spawn('node', [path.join(ROOT, 'web', 'server.js')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const errs = [];
  server.stderr.on('data', (d) => errs.push(String(d)));
  await new Promise((r) => setTimeout(r, 2000));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const jsErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push(m.text()); });
  page.on('pageerror', (e) => jsErrors.push('PAGEERROR: ' + e.message));

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT, 'final-feed.png') });

  // топ-5 по качеству
  const top = await page.evaluate(async () => {
    const r = await fetch('/api/jobs?limit=200');
    const d = await r.json();
    return d.items.slice(0, 5).map((j) => ({ score: j.quality?.score, v: j.quality?.verdict, t: j.title, s: j.source, p: j.price?.text }));
  });
  console.log('ТОП заказов по качеству:');
  for (const j of top) console.log(`  ${String(j.score).padStart(3)} ${String(j.v).padEnd(6)} ${String(j.s).padEnd(12)} ${(j.t || '').slice(0, 48).padEnd(49)} ${j.p || ''}`);

  // карточка
  await page.locator('#list .card').first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, 'final-job.png') });
  const dlgTitle = await page.locator('#d-title').textContent();
  console.log('\nкарточка открыта:', dlgTitle?.slice(0, 50));
  await page.keyboard.press('Escape');

  // ИИ-вкладка
  await page.click('[data-tab="ai"]');
  await page.waitForTimeout(2200);
  await page.screenshot({ path: path.join(OUT, 'final-ai.png') });

  // статистика
  await page.click('[data-tab="stats"]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, 'final-stats.png') });

  console.log('\nJS-ошибок:', jsErrors.length ? jsErrors.join(' | ') : 'нет');
  console.log('stderr сервера:', errs.join('').trim() || 'нет');
  await browser.close();
  server.kill();
})();
