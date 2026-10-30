'use strict';
/**
 * Тест CLI: все команды, коды выхода, edge-кейсы.
 * Запуск: node test/e2e/cli.test.js
 */
const assert = require('node:assert');
const { execFile } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const issues = [];
let passed = 0; let failed = 0;

function run(args, timeout = 180000) {
  return new Promise((resolve) => {
    execFile('node', [path.join(ROOT, 'bin', 'hunter.js'), ...args], { cwd: ROOT, encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' }));
  });
}

async function t(name, fn) {
  try { await fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; issues.push(`${name}: ${e.message}`); process.stdout.write('X'); }
}

(async () => {
  await t('без аргументов → справка, код 0', async () => {
    const r = await run([]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('poll'), 'нет списка команд');
    assert.ok(r.stdout.includes('ai'), 'нет раздела ai');
  });

  await t('неизвестная команда → справка, код 0', async () => {
    const r = await run(['такой-команды-нет']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('poll'));
  });

  await t('settings → JSON', async () => {
    const r = await run(['settings']);
    assert.equal(r.code, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.ok(s.search && s.quality && s.ai);
  });

  await t('get → значение настройки', async () => {
    const r = await run(['get', 'search.priceMin']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.trim().length > 0);
  });

  await t('get с несуществующим ключом → «нет такого параметра»', async () => {
    const r = await run(['get', 'a.b.c']);
    assert.ok(r.stdout.includes('нет такого') || r.stdout.includes('null'));
  });

  await t('set → меняет и печатает', async () => {
    const r = await run(['set', 'search.priceMin=4321']);
    assert.equal(r.code, 0, r.stderr);
    const s = JSON.parse(r.stdout.split('\n\nПересчитано')[0]);
    assert.equal(s.search.priceMin, 4321);
  });

  await t('set со списком значений', async () => {
    const r = await run(['set', 'search.sites=a,b,c']);
    assert.equal(r.code, 0);
    const s = JSON.parse(r.stdout.split('\n\nПересчитано')[0]);
    assert.deepEqual(s.search.sites, ['a', 'b', 'c']);
  });

  await t('set с булевым значением', async () => {
    const r = await run(['set', 'apply.dryRun=false']);
    const s = JSON.parse(r.stdout.split('\n\nПересчитано')[0]);
    assert.equal(s.apply.dryRun, false);
  });

  await t('sources → список источников', async () => {
    const r = await run(['sources']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('alot') && r.stdout.includes('telegram'));
  });

  await t('stats → числа', async () => {
    const r = await run(['stats']);
    assert.equal(r.code, 0);
    assert.ok(/Всего заказов: \d+/.test(r.stdout), r.stdout.slice(0, 100));
  });

  await t('list → таблица', async () => {
    const r = await run(['list', '--limit', '5']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('Показано'));
  });

  await t('list с фильтрами', async () => {
    const r = await run(['list', '--verdict', 'prime,good', '--limit', '5']);
    assert.equal(r.code, 0);
  });

  await t('list с несуществующим фильтром → пусто, не падает', async () => {
    const r = await run(['list', '--source', 'нет-такого']);
    assert.equal(r.code, 0);
  });

  await t('show несуществующего → «Не найден»', async () => {
    const r = await run(['show', '99999999']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('Не найден'));
  });

  await t('rescore → пересчёт', async () => {
    const r = await run(['rescore']);
    assert.equal(r.code, 0);
    assert.ok(/Пересчитано \d+/.test(r.stdout));
  });

  await t('doctor → диагностика', async () => {
    const r = await run(['doctor']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('node'));
    assert.ok(r.stdout.includes('источников'));
  });

  await t('accounts → список', async () => {
    const r = await run(['accounts']);
    assert.equal(r.code, 0);
  });

  await t('accounts import без файла → ошибка, не падение', async () => {
    const r = await run(['accounts', 'import', 'D:\\нет\\файла.txt']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('Ошибка'));
  });

  await t('tg → список каналов', async () => {
    const r = await run(['tg']);
    assert.equal(r.code, 0);
  });

  await t('tg add/rm → добавляет и удаляет', async () => {
    const add = await run(['tg', 'add', 'test_channel_e2e', 'Тестовый канал']);
    assert.equal(add.code, 0);
    const list = await run(['tg']);
    assert.ok(list.stdout.includes('test_channel_e2e'), 'канал не добавился');
    const rm = await run(['tg', 'rm', 'test_channel_e2e']);
    assert.equal(rm.code, 0);
    const list2 = await run(['tg']);
    assert.ok(!list2.stdout.includes('test_channel_e2e'), 'канал не удалился');
  });

  await t('ai status → статус', async () => {
    const r = await run(['ai', 'status']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('Провайдер'));
  });

  await t('ai providers → список', async () => {
    const r = await run(['ai', 'providers']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('oc:'));
  });

  await t('ai без подкоманды → справка', async () => {
    const r = await run(['ai']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('ai resume'), r.stdout.slice(0, 120));
  });

  await t('ai profile → профиль или понятное сообщение', async () => {
    const r = await run(['ai', 'profile']);
    assert.equal(r.code, 0);
    const hasJson = r.stdout.trim().startsWith('{');
    const hasMsg = /не разобран|разбери резюме/i.test(r.stdout);
    assert.ok(hasJson || hasMsg, r.stdout.slice(0, 120));
  });

  await t('ai add/rm → свой провайдер', async () => {
    const add = await run(['ai', 'add', 'E2E', 'https://example.test/v1', 'sk-e2e', 'e2e-model']);
    assert.equal(add.code, 0, add.stderr);
    const prov = await run(['ai', 'providers']);
    assert.ok(prov.stdout.includes('E2E'), 'провайдер не появился');
    const rm = await run(['ai', 'rm', 'custom:e2e']);
    assert.equal(rm.code, 0);
  });

  await t('ai use с несуществующим → сообщение', async () => {
    const r = await run(['ai', 'use', 'нет:такого']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('не найден'));
  });

  await t('auto-apply --dry → безопасно', async () => {
    const r = await run(['auto-apply', '--dry', '--limit', '2']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('dry run'));
  });

  await t('init → настраивает профиль', async () => {
    const r = await run(['init', 'Тест Тестов', 'Тестовая должность']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('настроены'));
  });

  console.log(`\n\nCLI: ${passed} ок, ${failed} сломанных`);
  for (const i of issues) console.log('  ✗ ' + i);
  process.exit(failed ? 1 : 0);
})();
