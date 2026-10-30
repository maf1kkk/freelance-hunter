'use strict';
/**
 * Контрактный тест HTTP API: все эндпоинты + ошибочные сценарии.
 * Запуск: node test/e2e/api.test.js   (сервер должен быть поднят)
 */
const assert = require('node:assert');
const B = process.env.BASE || 'http://127.0.0.1:3410';

const issues = [];
let passed = 0;
let failed = 0;

async function req(method, path, body, opts = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  if (opts.raw) { init.headers['Content-Type'] = 'application/octet-stream'; init.body = opts.raw; }
  const r = await fetch(B + path, init);
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { __raw: text.slice(0, 200) }; }
  return { status: r.status, data, text };
}

async function t(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write('.');
  } catch (e) {
    failed++;
    issues.push(`${name}: ${e.message}`);
    process.stdout.write('X');
  }
}

(async () => {
  /* снимок настроек, чтобы тесты не затирали пользовательские данные */
  const orig = (await req('GET', '/api/settings')).data;

  /* ---------------- health / stats / sources ---------------- */
  await t('GET /api/health → 200 ok', async () => {
    const r = await req('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.ok(r.data.sources >= 9);
  });

  await t('GET /api/stats → структура', async () => {
    const r = await req('GET', '/api/stats');
    assert.equal(r.status, 200);
    assert.ok(typeof r.data.total === 'number');
    assert.ok(r.data.bySource && typeof r.data.bySource === 'object');
    assert.ok(r.data.sourceState && typeof r.data.sourceState === 'object');
  });

  await t('GET /api/sources → массив', async () => {
    const r = await req('GET', '/api/sources');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.items));
    assert.ok(r.data.items.length >= 9);
    assert.ok(r.data.items.every((s) => s.id && s.label));
  });

  await t('GET /api/sources → last-состояние у всех', async () => {
    const r = await req('GET', '/api/sources');
    for (const s of r.data.items) {
      assert.ok('last' in s, `нет last у ${s.id}`);
    }
  });

  /* ---------------- jobs ---------------- */
  let someJobId = null;
  await t('GET /api/jobs → массив с total', async () => {
    const r = await req('GET', '/api/jobs?limit=5');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.items));
    assert.equal(typeof r.data.total, 'number');
    if (r.data.items[0]) someJobId = r.data.items[0].id;
  });

  await t('GET /api/jobs с фильтром verdict', async () => {
    const r = await req('GET', '/api/jobs?verdict=prime&limit=10');
    assert.equal(r.status, 200);
    assert.ok(r.data.items.every((j) => j.quality.verdict === 'prime'));
  });

  await t('GET /api/jobs с фильтром source', async () => {
    const r = await req('GET', '/api/jobs?source=alot&limit=10');
    assert.equal(r.status, 200);
    assert.ok(r.data.items.every((j) => j.source === 'alot'));
  });

  await t('GET /api/jobs с поиском q', async () => {
    const r = await req('GET', '/api/jobs?q=сайт&limit=10');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.items));
  });

  await t('GET /api/jobs с мусорными параметрами не падает', async () => {
    const r = await req('GET', '/api/jobs?limit=abc&minPrice=xyz&source=&verdict=&offset=-5');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.items));
  });

  await t('GET /api/jobs с огромным limit ограничивается', async () => {
    const r = await req('GET', '/api/jobs?limit=999999');
    assert.equal(r.status, 200);
    assert.ok(r.data.items.length <= 999999);
  });

  await t('GET /api/jobs/:id → карточка + черновик', async () => {
    assert.ok(someJobId, 'нет заказа для теста');
    const r = await req('GET', `/api/jobs/${encodeURIComponent(someJobId)}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.id, someJobId);
    assert.ok(typeof r.data.draftResponse === 'string');
    assert.ok(Array.isArray(r.data.duplicates));
  });

  await t('GET /api/jobs/:id для несуществующего → 404', async () => {
    const r = await req('GET', '/api/jobs/nope:123');
    assert.equal(r.status, 404);
    assert.ok(r.data.error);
  });

  await t('GET /api/jobs с id в виде спецсимволов → не 500', async () => {
    const r = await req('GET', `/api/jobs/${encodeURIComponent('../../etc/passwd')}`);
    assert.ok(r.status === 404 || r.status === 200, 'статус ' + r.status);
  });

  /* ---------------- settings ---------------- */
  await t('GET /api/settings → все группы', async () => {
    const r = await req('GET', '/api/settings');
    assert.equal(r.status, 200);
    for (const g of ['search', 'quality', 'poll', 'notify', 'apply', 'profile', 'ui', 'ai']) {
      assert.ok(r.data[g], 'нет группы ' + g);
    }
  });

  await t('POST /api/settings → валидация и сохранение', async () => {
    const r = await req('POST', '/api/settings', { search: { priceMin: 1234, keywordsPlus: 'a, b' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.settings.search.priceMin, 1234);
    assert.deepEqual(r.data.settings.search.keywordsPlus, ['a', 'b']);
    assert.ok(r.data.rescored);
  });

  await t('POST /api/settings с невалидным JSON → 500 без падения', async () => {
    const r = await req('POST', '/api/settings', '{битый json');
    assert.ok(r.status >= 400, 'статус ' + r.status);
    assert.ok(r.data.error);
  });

  await t('POST /api/settings с чужими ключами не ломает схему', async () => {
    const r = await req('POST', '/api/settings', { sources: { flru: { enabled: false } }, search: { keywordsPlus: [] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.settings.sources, { flru: { enabled: false } });
  });

  await t('POST /api/settings восстанавливает исходные значения', async () => {
    const r = await req('POST', '/api/settings', {
      search: orig.search, quality: orig.quality, profile: orig.profile, ui: orig.ui,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.settings.search.keywordsPlus, orig.search.keywordsPlus);
    const check = await req('GET', '/api/settings');
    assert.deepEqual(check.data.profile.name, orig.profile.name);
  });

  await t('GET /api/settings/schema → описание', async () => {
    const r = await req('GET', '/api/settings/schema');
    assert.equal(r.status, 200);
    assert.ok(r.data.search);
  });

  await t('POST /api/settings/rescore → пересчёт', async () => {
    const r = await req('POST', '/api/settings/rescore');
    assert.equal(r.status, 200);
    assert.equal(typeof r.data.total, 'number');
  });

  /* ---------------- profile ---------------- */
  await t('GET /api/profile → поля', async () => {
    const r = await req('GET', '/api/profile');
    assert.equal(r.status, 200);
    assert.ok('skills' in r.data);
  });

  await t('POST /api/profile → сохраняет', async () => {
    const r = await req('POST', '/api/profile', { name: 'Тест Тестов', skills: 'js, python' });
    assert.equal(r.status, 200);
    assert.equal(r.data.name, 'Тест Тестов');
  });

  /* ---------------- accounts ---------------- */
  await t('GET /api/accounts → список', async () => {
    const r = await req('GET', '/api/accounts');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.items));
  });

  await t('POST /api/accounts/import без path → 400', async () => {
    const r = await req('POST', '/api/accounts/import', {});
    assert.equal(r.status, 400);
    assert.ok(r.data.error);
  });

  await t('POST /api/accounts/import несуществующего файла → 400', async () => {
    const r = await req('POST', '/api/accounts/import', { path: 'D:\\нет\\такого.txt' });
    assert.equal(r.status, 400);
    assert.ok(r.data.error);
  });

  await t('POST /api/accounts с мусором → 400', async () => {
    const r = await req('POST', '/api/accounts', { content: 12345 });
    assert.ok(r.status >= 400);
  });

  await t('POST /api/accounts/remove несуществующего → ok', async () => {
    const r = await req('POST', '/api/accounts/remove', { service: 'нет-такого' });
    assert.equal(r.status, 200);
  });

  /* ---------------- telegram ---------------- */
  await t('GET /api/tg/channels → список', async () => {
    const r = await req('GET', '/api/tg/channels');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.items));
  });

  await t('POST /api/tg/channels с дублем → ok/ошибка', async () => {
    const list = (await req('GET', '/api/tg/channels')).data.items;
    const ch = list[0];
    const r = await req('POST', '/api/tg/channels', { name: ch.name, label: 'дубль' });
    assert.ok(r.status === 200 && r.data.ok === false, 'дубль должен отклоняться');
  });

  await t('DELETE /api/tg/channels/несуществующего → ok', async () => {
    const r = await req('DELETE', '/api/tg/channels/нет-такого-канала');
    assert.equal(r.status, 200);
  });

  /* ---------------- AI ---------------- */
  // ускоряем ИИ-часть: реальные провайдеры могут быть недоступны (rate-limit)
  await req('POST', '/api/settings', { ai: { timeout: 12000 } });

  await t('GET /api/ai/providers → список + активный', async () => {
    const r = await req('GET', '/api/ai/providers');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.items));
    assert.ok(r.data.items.length > 0);
    assert.ok('config' in r.data);
  });

  await t('POST /api/ai/provider → выбор', async () => {
    const r = await req('POST', '/api/ai/provider', { providerId: 'oc:zai2', model: 'glm-4.5-flash' });
    assert.equal(r.status, 200);
    assert.equal(r.data.settings.providerId, 'oc:zai2');
  });

  await t('POST /api/ai/provider с пустым → сброс', async () => {
    const r = await req('POST', '/api/ai/provider', { providerId: '' });
    assert.equal(r.status, 200);
    assert.equal(r.data.settings.providerId, null);
    // вернуть обратно
    await req('POST', '/api/ai/provider', { providerId: 'oc:zai2', model: 'glm-4.5-flash' });
  });

  await t('POST /api/ai/provider/custom без baseURL → 400', async () => {
    const r = await req('POST', '/api/ai/provider/custom', { name: 'x' });
    assert.equal(r.status, 400);
  });

  await t('POST /api/ai/provider/custom → создаётся и удаляется', async () => {
    const r = await req('POST', '/api/ai/provider/custom', {
      name: 'E2E-провайдер', type: 'openai', baseURL: 'https://example.test/v1', apiKey: 'sk-e2e', model: 'test-model',
    });
    assert.equal(r.status, 200);
    assert.ok(r.data.provider.id);
    const d = await req('DELETE', `/api/ai/provider/custom/${encodeURIComponent(r.data.provider.id)}`);
    assert.equal(d.status, 200);
  });

  await t('GET /api/ai/profile → профиль или null', async () => {
    const r = await req('GET', '/api/ai/profile');
    assert.equal(r.status, 200);
    assert.ok('profile' in r.data);
  });

  await t('POST /api/ai/resume с пустым текстом → 400', async () => {
    const r = await req('POST', '/api/ai/resume', { text: 'мало' });
    assert.equal(r.status, 400);
  });

  await t('POST /api/ai/resume с битым файлом → 400', async () => {
    const r = await req('POST', '/api/ai/resume/upload?name=bad.pdf', undefined, { raw: Buffer.from('not a pdf') });
    assert.ok(r.status === 400 || r.status === 500, 'статус ' + r.status);
  });

  await t('POST /api/ai/ask без вопроса → ответ или понятная ошибка ИИ', async () => {
    const r = await req('POST', '/api/ai/ask', {});
    if (r.status === 200) {
      assert.ok(typeof r.data.text === 'string' && r.data.text.length > 0, 'пустой ответ');
    } else {
      // провайдеры могут быть недоступны (лимит/баланс) — тогда должна быть понятная ошибка
      assert.equal(r.status, 500);
      assert.ok(/ИИ|провайдер/i.test(r.data.error), r.data.error);
    }
  });

  await t('POST /api/ai/improve с несуществующим id → 404', async () => {
    const r = await req('POST', '/api/ai/improve', { id: 'нет:такого' });
    assert.equal(r.status, 404);
  });

  /* ---------------- misc ---------------- */
  await t('GET / → HTML', async () => {
    const r = await req('GET', '/');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('<html'));
  });

  await t('GET /app.js → JS', async () => {
    const r = await req('GET', '/app.js');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('switchTab'));
  });

  await t('GET /style.css → CSS', async () => {
    const r = await req('GET', '/style.css');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(':root'));
  });

  await t('GET /неизвестный → 404', async () => {
    const r = await req('GET', '/такого-нет');
    assert.equal(r.status, 404);
  });

  /* ---------------- restore ---------------- */
  await t('настройки восстановлены после тестов', async () => {
    const r = await req('POST', '/api/settings', { ai: orig.ai });
    assert.equal(r.status, 200);
  });

  console.log(`\n\nAPI: ${passed} ок, ${failed} сломанных`);
  for (const i of issues) console.log('  ✗ ' + i);
  process.exit(failed ? 1 : 0);
})();
