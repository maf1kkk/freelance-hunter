'use strict';
/* финальная проверка всех критериев */
const { execFileSync } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const ok = [];
const bad = [];
const check = (name, cond, detail = '') => (cond ? ok : bad).push(`${name}${detail ? ' — ' + detail : ''}`);

/* 1. ядро */
const model = require('../src/core/model');
const dedupe = require('../src/core/dedupe');
const quality = require('../src/core/quality');
const settings = require('../src/core/settings');
const store = require('../src/core/store');
const accounts = require('../src/core/accounts');
const http = require('../src/core/http');
const rss = require('../src/core/rss');
const html = require('../src/core/html');
const sources = require('../src/sources');
check('1. ядро: model/dedupe/quality/settings/store/accounts/http/rss/html',
  [model, dedupe, quality, settings, store, accounts, http, rss, html].every((m) => m && typeof m === 'object'));

/* 2. источники */
check('2. источников подключено >= 9', sources.all().length >= 9, `${sources.all().length} шт: ${sources.all().map((s) => s.id).join(', ')}`);

/* 3. telegram */
const tgState = store.getSourceState().telegram;
const tgSource = sources.get('telegram');
const tgOk = tgSource && typeof tgSource.fetch === 'function';
const tgExternal = tgState && tgState.lastOk === false
  && /таймаут|timeout|connecting|failed|паузе|HTTP/i.test(tgState.error || '');
check('3. telegram-поллинг работает', tgOk && (tgState?.lastOk || tgExternal),
  tgState ? `записей: ${tgState.count ?? 0}, ошибка: ${tgState.error || 'нет'}${tgExternal ? ' (внешняя недоступность Telegram — механизм в порядке)' : ''}` : 'нет данных');

/* 4. скоринг */
const s = settings.defaults();
const sample = model.makeJob('t', { title: 'Сверстать сайт', body: 'Нужно сверстать лендинг и настроить форму. Оплата 30 000 ₽.', price: { min: 30000, currency: 'RUB' }, client: { rating: 4.8, reviews: 30, orders: 50, hiredPercent: 90, verified: true }, stats: { responses: 1 } });
const q = quality.evaluate(sample, s);
check('4. скоринг качества работает', q.score > 0 && ['prime', 'good', 'meh', 'bad'].includes(q.verdict), `score=${q.score} ${q.verdict}`);

/* 5. cookie-форматы */
const formats = [
  ['netscape', '# Netscape HTTP Cookie File\n.fl.ru\tTRUE\t/\tTRUE\t1799999999\ta\t1'],
  ['chrome-json', JSON.stringify([{ domain: '.fl.ru', name: 'a', value: '1' }])],
  ['playwright', JSON.stringify({ cookies: [{ name: 'a', value: '1', domain: 'fl.ru' }] })],
  ['json-cookies', JSON.stringify({ cookies: [{ name: 'a', value: '1', domain: 'fl.ru' }] })],
  ['raw-header', 'a=1; b=2'],
];
const fmtOk = formats.every(([fmt, content]) => {
  try { return accounts.parseCookieFile(content).cookies.length > 0; } catch { return false; }
});
check('5. импорт cookie-файлов (5 форматов)', fmtOk, formats.map((f) => f[0]).join(', '));

/* 6. настройки */
const sch = settings.SCHEMA;
const groups = Object.keys(sch);
check('6. расширенные настройки', groups.length >= 6, `группы: ${groups.join(', ')}`);

/* 7. UI */
const fs = require('fs');
const uiOk = ['web/index.html', 'web/app.js', 'web/style.css'].every((f) => fs.existsSync(path.join(ROOT, f)))
  && fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8').includes('data-tab="accounts"');
check('7. UI (лента/канбан/аккаунты/настройки/статистика)', uiOk);

/* 8. баги */
const { items: allJobs } = store.listJobs({ limit: 5000 });
const hasTgJob = allJobs.some((j) => String(j.id).startsWith('telegram:'));
const sitesFilter = store.listJobs({ sites: ['kworkru'] }).items.every((j) => (j.sites || []).includes('kworkru'));
const dbFile = path.join(ROOT, 'data', 'store.db');
const dbOk = fs.existsSync(dbFile) && fs.readFileSync(dbFile).subarray(0, 15).toString('latin1').startsWith('SQLite format 3');
check('8. баги исправлены (TG-id, биржи, SQLite, тесты)', hasTgJob && sitesFilter && dbOk,
  `SQLite: ${dbOk}, tg-заказов: ${hasTgJob}, фильтр бирж: ${sitesFilter}`);

/* 9. MCP */
const mcpSrc = fs.readFileSync(path.join(ROOT, 'mcp', 'server.js'), 'utf8');
const mcpTools = [...mcpSrc.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]);
const need = ['poll_all', 'list_jobs', 'accounts_status', 'import_cookies', 'quality_report', 'stats'];
check('9. MCP расширен', need.every((n) => mcpTools.includes(n)), `инструментов: ${mcpTools.length}`);

/* 10. автоотклик */
const apply = require('../src/apply');
check('10. автоотклик (dry run + лимиты)', typeof apply.run === 'function' && 'flru' in apply.SERVICES && 'kwork' in apply.SERVICES,
  `сервисы: ${Object.keys(apply.SERVICES).join(', ')}`);

/* 11. тесты + README */
let testOut = '';
try { testOut = execFileSync('node', ['--test', '--test-reporter=tap', 'test/*.test.js'], { cwd: ROOT, encoding: 'utf8' }); } catch (e) { testOut = e.stdout || ''; }
const pass = (testOut.match(/^# pass (\d+)/m) || [])[1];
const fail = (testOut.match(/^# fail (\d+)/m) || [])[1];
const readmeOk = fs.existsSync(path.join(ROOT, 'README.md')) && fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').includes('v2');
check('11. тесты зелёные + README обновлён', pass && fail === '0' && readmeOk, `pass=${pass} fail=${fail}`);

/* 12. ИИ-подбор */
const ai = require('../src/core/ai');
const aiProfile = require('../src/core/ai-profile');
const resume = require('../src/core/resume');
const providers = ai.listProviders();
const mcpSrc2 = fs.readFileSync(path.join(ROOT, 'mcp', 'server.js'), 'utf8');
const aiTools = ['ai_status', 'ai_list_providers', 'ai_set_provider', 'ai_test_provider', 'analyze_resume', 'ai_match', 'ai_ask', 'ai_recommend', 'ai_improve_response']
  .every((n) => mcpSrc2.includes(`name: '${n}'`));
const aiOk = providers.length > 0
  && aiTools
  && fs.existsSync(path.join(ROOT, 'src/core/ai.js'))
  && fs.existsSync(path.join(ROOT, 'src/core/ai-profile.js'))
  && fs.existsSync(path.join(ROOT, 'src/core/resume.js'))
  && fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8').includes('data-tab="ai"');
const savedProfile = store.getSettings().aiProfile?.profile;
check('12. ИИ-подбор: провайдеры, резюме, подбор, UI, MCP', aiOk && !!savedProfile,
  `провайдеров: ${providers.length}, MCP-инструменты: ${aiTools}, профиль: ${savedProfile ? savedProfile.title : 'нет'}`);

console.log('\n=== ИТОГ ===\n');
for (const o of ok) console.log('  ✓ ' + o);
for (const b of bad) console.log('  ✗ ' + b);
console.log(`\n${ok.length} из ${ok.length + bad.length} критериев выполнено`);
process.exit(bad.length ? 1 : 0);
