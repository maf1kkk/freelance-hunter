'use strict';
/**
 * Сквозной тест модулей: то, что не покрыто юнит-тестами и e2e.
 * Запуск: node test/e2e/flow.test.js
 */
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const toUnix = (p) => String(p).split(String.fromCharCode(92)).join('/');
const issues = [];
let passed = 0; let failed = 0;

async function t(name, fn) {
  try { await fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; issues.push(`${name}: ${e.message}`); process.stdout.write('X'); }
}

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-flow-'));
  const STORE = path.join(TMP, 'store.db');
  process.env.FH_DB_FILE = STORE;   // изолированная база — рабочую не трогаем

  const store = require(toUnix(path.join(ROOT, 'src', 'core', 'store.js')));
  const { makeJob } = require(toUnix(path.join(ROOT, 'src', 'core', 'model.js')));
  const { draftResponse } = require(toUnix(path.join(ROOT, 'src', 'respond.js')));
  const filters = require(toUnix(path.join(ROOT, 'src', 'filters.js')));
  const notify = require(toUnix(path.join(ROOT, 'src', 'core', 'notify.js')));
  const cards = require(toUnix(path.join(ROOT, 'src', 'cards.js')));
  const dedupe = require(toUnix(path.join(ROOT, 'src', 'core', 'dedupe.js')));
  const time = require(toUnix(path.join(ROOT, 'src', 'core', 'time.js')));
  const text = require(toUnix(path.join(ROOT, 'src', 'core', 'text.js')));
  const accounts = require(toUnix(path.join(ROOT, 'src', 'core', 'accounts.js')));
  const quality = require(toUnix(path.join(ROOT, 'src', 'core', 'quality.js')));

  /* ---------------- respond ---------------- */
  await t('черновик отклика собирается из минимального заказа', async () => {
    const job = makeJob('x', { title: 'Сверстать сайт' });
    const d = draftResponse(job, store.getSettings());
    assert.ok(d.includes('Сверстать сайт'));
    assert.ok(d.includes('Здравствуйте'));
    assert.ok(d.includes('Срок'));
    assert.ok(d.includes('вопрос'));
  });

  await t('черновик не падает на пустом теле и без цены', async () => {
    const job = makeJob('x', { title: '', body: '' });
    const d = draftResponse(job, store.getSettings());
    assert.ok(typeof d === 'string' && d.length > 20);
  });

  await t('черновик убирает html из тела', async () => {
    const job = makeJob('x', { title: 'Заказ', body: '<p>Нужно <b>сверстать</b> сайт</p>' });
    const d = draftResponse(job, store.getSettings());
    assert.ok(!d.includes('<b>'), 'html попал в черновик');
  });

  /* ---------------- filters (legacy) ---------------- */
  await t('legacy evaluate: минус-слово → skip', async () => {
    const r = filters.evaluate({ title: 'Крипта', body: 'ставки' }, { search: { keywordsMinus: ['крипта'] } });
    assert.equal(r.verdict, 'skip');
  });

  await t('legacy evaluate: фильтр бирж понимает префикс alot:', async () => {
    const s = { search: { sites: ['flru'], keywordsPlus: [] } };
    const allowed = filters.evaluate({ title: 'Заказ', body: '', site: 'alot:flru' }, s);
    const excluded = filters.evaluate({ title: 'Заказ', body: '', site: 'alot:kworkru' }, s);
    assert.notEqual(allowed.verdict, 'skip', 'разрешённая биржа не должна отсекаться');
    assert.equal(excluded.verdict, 'skip', 'исключённая биржа должна отсекаться');
  });

  await t('classifyTgPost различает заказ/резюме/вакансию', async () => {
    assert.equal(filters.classifyTgPost('Нужно сверстать лендинг, ищу исполнителя'), 'order');
    assert.equal(filters.classifyTgPost('#резюме fullstack react, ищу работу'), 'resume');
    assert.equal(filters.classifyTgPost('#вакансия требуется сотрудник в компанию'), 'vacancy');
  });

  /* ---------------- notify ---------------- */
  await t('форматирование уведомления ИИ не падает', async () => {
    const job = makeJob('x', {
      title: 'Заказ', body: 'текст', price: { min: 1000, currency: 'RUB', text: '1 000 ₽' },
      quality: { score: 80, verdict: 'prime', reasons: ['ок'] }, url: 'https://e.com/1',
      client: { name: 'Иван', rating: 5, reviews: 10 }, stats: { responses: 2 },
    });
    const msg = notify.formatJob(job);
    assert.ok(msg.includes('Заказ'));
    assert.ok(msg.includes('1 000'));
    assert.ok(msg.includes('https://e.com/1'));
  });

  await t('уведомления выключены → sent 0', async () => {
    const r = await notify.notifyNew([{ id: 'a', quality: { score: 90, verdict: 'prime' } }], { notify: { telegram: false } });
    assert.equal(r.sent, 0);
  });

  await t('уведомления без токена → не падает', async () => {
    const r = await notify.notifyNew([{ id: 'a', quality: { score: 90, verdict: 'prime' } }], { notify: { telegram: true } });
    assert.equal(r.sent, 0);
    assert.ok(r.reason || r.error);
  });

  /* ---------------- cards ---------------- */
  await t('buildHtml экранирует данные', async () => {
    const html = cards.buildHtml({ title: '<script>alert(1)</script>', bullets: ['<b>жирный</b>'] }, 'wb', 'minimal');
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('&lt;b&gt;'));
  });

  await t('buildHtml поддерживает все размеры', async () => {
    for (const size of ['wb', 'ozon', 'avito']) {
      const html = cards.buildHtml({ title: 'T', bullets: ['a'] }, size);
      assert.ok(html.includes(`${cards.SIZES[size].width}px`), size);
    }
  });

  /* ---------------- dedupe ---------------- */
  await t('дедуп склеивает реальные дубли с разных площадок', async () => {
    const a = makeJob('flru', { externalId: '1', title: 'Сверстать лендинг для компании', body: 'Нужно сверстать лендинг под ключ', price: { min: 20000, currency: 'RUB' } });
    const b = makeJob('kwork', { externalId: '2', title: 'Вёрстка лендинга для компании', body: 'Требуется вёрстка лендинга под ключ', price: { min: 20000, currency: 'RUB' } });
    const c = makeJob('hh', { externalId: '3', title: 'Разработка мобильного приложения', body: 'Совсем другое', price: { min: 900000, currency: 'RUB' } });
    const groups = dedupe.group([a, b, c]);
    assert.equal(groups.length, 2, 'групп: ' + groups.length);
  });

  /* ---------------- time ---------------- */
  await t('парсинг относительного времени', async () => {
    const now = Date.now();
    assert.ok(Math.abs(time.parseAgo('8 минут назад', now) - (now - 480000)) < 2000);
    assert.ok(Math.abs(time.parseAgo('2 часа назад', now) - (now - 7200000)) < 2000);
    assert.ok(Math.abs(time.parseAgo('3 дня назад', now) - (now - 3 * 86400000)) < 5000);
    assert.equal(time.parseAgo('вчера', now) > 0, true);
  });

  await t('парсинг длительности аккаунта', async () => {
    assert.equal(time.parseDurationDays('10 месяцев'), 304);
    assert.equal(time.parseDurationDays('2 года'), 730);
  });

  /* ---------------- text ---------------- */
  await t('очистка текста заказа', async () => {
    const t1 = text.cleanText('<div>Привет<br>Мир</div>');
    assert.ok(t1.includes('Привет') && t1.includes('Мир'));
    assert.ok(!t1.includes('<'));
  });

  await t('уточняющий вопрос подбирается по теме', async () => {
    const site = text.clarifyQuestion({ title: 'Сверстать лендинг', body: 'нужен лендинг' });
    const bot = text.clarifyQuestion({ title: 'Сделать telegram бота', body: 'бот для заявок' });
    assert.notEqual(site, bot);
  });

  /* ---------------- accounts ---------------- */
  await t('импорт cookie-файла → доступен в cookieHeader', async () => {
    const file = path.join(TMP, 'c.txt');
    fs.writeFileSync(file, '.fl.ru\tTRUE\t/\tTRUE\t1799999999\tsid\tVALUE1');
    const r = accounts.importCookieFile(file);
    assert.equal(r.service, 'flru');
    assert.equal(r.count, 1);
    const h = accounts.cookieHeader('flru', 'fl.ru');
    assert.ok(h.includes('sid=VALUE1'), h);
    accounts.remove('flru');
  });

  /* ---------------- store: prune ---------------- */
  await t('prune удаляет старые закрытые заказы', async () => {
    const old = Date.now() - 60 * 86400000;
    store.upsertJobs([
      { id: 'old:1', source: 'o', title: 'старый', status: 'applied', publishedAt: old },
      { id: 'new:1', source: 'o', title: 'новый', status: 'applied', publishedAt: Date.now() },
    ]);
    const removed = store.prune({ keepDays: 30 });
    assert.ok(removed >= 1, 'удалено: ' + removed);
    assert.ok(store.getJob('new:1'), 'новый заказ не должен удаляться');
  });

  /* ---------------- quality: детерминированность ---------------- */
  await t('скоринг детерминирован (одинаковый вход → одинаковый результат)', async () => {
    const settings = store.getSettings();
    const job = makeJob('x', {
      title: 'Сверстать сайт на WordPress', body: 'Нужно сверстать лендинг и настроить форму.',
      price: { min: 30000, currency: 'RUB' }, stats: { responses: 2 },
      client: { rating: 4.8, reviews: 20, orders: 30 },
    });
    const a = quality.evaluate(job, settings);
    const b = quality.evaluate(job, settings);
    assert.equal(a.score, b.score);
    assert.equal(a.verdict, b.verdict);
  });

  /* ---------------- pipeline: изоляция сломанного источника ---------------- */
  await t('сломанный источник не роняет опрос', async () => {
    const pipeline = require(toUnix(path.join(ROOT, 'src', 'core', 'pipeline.js')));
    const sources = require(toUnix(path.join(ROOT, 'src', 'sources', 'index.js')));
    const orig = sources.all();
    const broken = {
      id: 'broken', label: 'Broken', kind: 'jobs', needsAuth: false, enabled: true,
      fetch: async () => { throw new Error('источник упал'); },
      check: async () => ({ ok: false, error: 'упал' }),
    };
    const fake = {
      id: 'fake-ok2', label: 'Fake OK 2', kind: 'jobs', needsAuth: false, enabled: true,
      fetch: async () => [{ id: 'fake2:1', source: 'fake-ok2', title: 'Тест', publishedAt: Date.now() }],
      check: async () => ({ ok: true }),
    };
    sources.ALL.push(broken, fake);
    sources.BY_ID.set('broken', broken);
    sources.BY_ID.set('fake-ok2', fake);
    try {
      const r = await pipeline.pollAll({ only: ['broken', 'fake-ok2'], limit: 3 });
      assert.equal(r.sources.find((s) => s.source === 'broken').ok, false);
      assert.ok(r.sources.find((s) => s.source === 'fake-ok2').ok, 'другие источники должны работать');
    } finally {
      sources.ALL.length = orig.length;
      sources.BY_ID.delete('broken');
      sources.BY_ID.delete('fake-ok2');
    }
  });

  await t('источник без auth не ломает общий опрос', async () => {
    const pipeline = require(toUnix(path.join(ROOT, 'src', 'core', 'pipeline.js')));
    const sources = require(toUnix(path.join(ROOT, 'src', 'sources', 'index.js')));
    const orig = sources.all();
    const fake = {
      id: 'fake-ok', label: 'Fake OK', kind: 'jobs', needsAuth: false, enabled: true,
      fetch: async () => [{ id: 'fake:1', source: 'fake-ok', title: 'Тестовый заказ', publishedAt: Date.now() }],
      check: async () => ({ ok: true }),
    };
    sources.ALL.push(fake);
    sources.BY_ID.set('fake-ok', fake);
    try {
      const r = await pipeline.pollAll({ only: ['fake-ok'], limit: 3 });
      assert.equal(r.sources[0].ok, true);
      assert.ok(r.added >= 0);
    } finally {
      sources.ALL.length = orig.length;
      sources.BY_ID.delete('fake-ok');
    }
  });

  console.log(`\n\nFLOW: ${passed} ок, ${failed} сломанных`);
  for (const i of issues) console.log('  ✗ ' + i);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
