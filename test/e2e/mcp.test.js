'use strict';
/**
 * Контрактный тест MCP: вызов всех инструментов + невалидные аргументы.
 * Запуск: node test/e2e/mcp.test.js
 */
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
let id = 0;
const pending = new Map();
const issues = [];
let passed = 0; let failed = 0;

const child = spawn('node', [path.join(ROOT, 'mcp', 'server.js')], { cwd: ROOT });

child.stdout.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const res = pending.get(m.id);
    if (res) { pending.delete(m.id); res(m); }
  }
});
child.stderr.on('data', (d) => process.stderr.write('SERVER ERR ' + d));

function call(name, args = {}, timeout = 120000) {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(myId); reject(new Error('таймаут ' + name)); }, timeout);
    pending.set(myId, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}

async function t(name, fn) {
  try { await fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; issues.push(`${name}: ${e.message}`); process.stdout.write('X'); }
}

function parse(res) {
  const text = res.result?.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return { __text: text }; }
}

(async () => {
  // инициализация
  await new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, () => resolve());
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: myId, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }) + '\n');
  });

  /* ---------- список инструментов ---------- */
  const toolsRes = await new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method: 'tools/list' }) + '\n');
  });
  const toolNames = toolsRes.result.tools.map((x) => x.name);

  await t('tools/list отдаёт ≥20 инструментов с описаниями', async () => {
    assert.ok(toolNames.length >= 20, 'инструментов: ' + toolNames.length);
    for (const tl of toolsRes.result.tools) {
      assert.ok(tl.name, 'инструмент без имени');
      assert.ok(tl.description && tl.description.length > 10, tl.name + ' без описания');
      assert.ok(tl.inputSchema, tl.name + ' без схемы');
    }
  });

  await t('дубликатов имён нет', async () => {
    assert.equal(new Set(toolNames).size, toolNames.length);
  });

  /* ---------- чтение ---------- */
  await t('sources', async () => {
    const d = parse(await call('sources'));
    assert.ok(Array.isArray(d.items) && d.items.length >= 9);
  });

  await t('stats', async () => {
    const d = parse(await call('stats'));
    assert.equal(typeof d.total, 'number');
    assert.ok(d.bySource);
  });

  await t('list_jobs с фильтром', async () => {
    const d = parse(await call('list_jobs', { verdict: 'good', limit: 5 }));
    assert.ok(Array.isArray(d.items));
    assert.ok(d.items.every((i) => i.verdict === 'good'));
  });

  await t('list_jobs без аргументов', async () => {
    const d = parse(await call('list_jobs'));
    assert.ok(Array.isArray(d.items));
  });

  let jobId = null;
  await t('list_jobs → берём id для проверки get_job', async () => {
    const d = parse(await call('list_jobs', { limit: 5 }));
    if (d.items[0]) jobId = d.items[0].id;
    assert.ok(jobId, 'нет заказов');
  });

  await t('get_job', async () => {
    const d = parse(await call('get_job', { id: jobId }));
    assert.equal(d.id, jobId);
    assert.ok(typeof d.draftResponse === 'string');
  });

  await t('get_job для несуществующего → isError', async () => {
    const res = await call('get_job', { id: 'нет:такого' });
    assert.ok(res.result.isError || parse(res).error, 'ожидалась ошибка');
  });

  await t('draft_response', async () => {
    const d = parse(await call('draft_response', { id: jobId }));
    assert.ok(d.text.length > 10);
  });

  await t('draft_response со своим текстом', async () => {
    const d = parse(await call('draft_response', { id: jobId, customText: 'мой текст' }));
    assert.equal(d.text, 'мой текст');
  });

  await t('quality_report', async () => {
    const d = parse(await call('quality_report', { id: jobId }));
    assert.equal(typeof d.score, 'number');
    assert.ok(Array.isArray(d.parts));
    assert.ok(d.parts.length >= 5);
  });

  await t('get_settings / set_settings', async () => {
    const before = parse(await call('get_settings'));
    assert.ok(before.search);
    const after = parse(await call('set_settings', { search: { priceMin: 7777 } }));
    assert.equal(after.settings.search.priceMin, 7777);
    await call('set_settings', { search: { priceMin: before.search.priceMin } });
  });

  await t('accounts_status', async () => {
    const d = parse(await call('accounts_status'));
    assert.ok(Array.isArray(d.accounts));
    assert.ok(Array.isArray(d.sources));
  });

  await t('whoami', async () => {
    const d = parse(await call('whoami'));
    assert.ok(Array.isArray(d.accounts));
  });

  await t('import_cookies без пути → ошибка', async () => {
    const res = await call('import_cookies', {});
    assert.ok(res.result.isError || parse(res).error);
  });

  /* ---------- ИИ ---------- */
  await t('ai_status', async () => {
    const d = parse(await call('ai_status'));
    assert.ok('provider' in d);
    assert.equal(typeof d.jobsTotal, 'number');
  });

  await t('ai_list_providers', async () => {
    const d = parse(await call('ai_list_providers'));
    assert.ok(Array.isArray(d.items) && d.items.length > 0);
    assert.ok(!('apiKey' in d.items[0]), 'ключ не должен светиться');
  });

  await t('ai_set_provider + ai_test_provider', async () => {
    const d = parse(await call('ai_set_provider', { providerId: 'oc:zai2', model: 'glm-4.5-flash' }));
    assert.equal(d.providerId, 'oc:zai2');
    const t2 = parse(await call('ai_test_provider', { providerId: 'oc:zai2' }));
    assert.ok('ok' in t2);
  });

  await t('ai_set_provider с несуществующим → ошибка', async () => {
    const res = await call('ai_set_provider', { providerId: 'нет:такого' });
    assert.ok(res.result.isError || parse(res).error);
  });

  await t('get_ai_profile', async () => {
    const d = parse(await call('get_ai_profile'));
    assert.ok('profile' in d);
  });

  await t('ai_ask без профиля/с вопросом → не падает', async () => {
    const res = await call('ai_ask', { question: 'какой заказ взять?' }, 180000);
    const d = parse(res);
    assert.ok(d.text || d.error || res.result.isError);
  });

  /* ---------- прочее ---------- */
  await t('mark_applied', async () => {
    const d = parse(await call('mark_applied', { id: jobId, responseText: 'тест', status: 'drafted' }));
    assert.equal(d.ok, true);
    assert.equal(d.status, 'drafted');
  });

  await t('mark_applied на несуществующем → ошибка', async () => {
    const res = await call('mark_applied', { id: 'нет:такого' });
    assert.ok(res.result.isError || parse(res).error);
  });

  await t('auto_apply в dry-run', async () => {
    const d = parse(await call('auto_apply', { dryRun: true, limit: 2 }));
    assert.equal(d.ok, true);
    assert.equal(d.dryRun, true);
    assert.ok(typeof d.processed === 'number');
  });

  await t('generate_product_cards без title → ошибка', async () => {
    const res = await call('generate_product_cards', { products: [{ bullets: ['x'] }] });
    assert.ok(res.result.isError || parse(res).error);
  });

  await t('generate_product_cards отдаёт файл', async () => {
    const d = parse(await call('generate_product_cards', {
      products: [{ title: 'Тест', bullets: ['раз', 'два'] }], size: 'wb',
    }, 120000));
    assert.equal(d.ok, true);
    assert.ok(Array.isArray(d.files) && d.files.length === 1);
    assert.ok(require('fs').existsSync(d.files[0]), 'файл не создан');
  });

  await t('неизвестный инструмент → ошибка', async () => {
    const res = await call('нет_такого_инструмента', {});
    assert.ok(res.result.isError || parse(res).error);
  });

  console.log(`\n\nMCP: ${passed} ок, ${failed} сломанных (инструментов: ${toolNames.length})`);
  for (const i of issues) console.log('  ✗ ' + i);
  child.kill();
  process.exit(failed ? 1 : 0);
})();
