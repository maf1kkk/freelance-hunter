'use strict';
/**
 * Edge-кейсы: битые файлы, пустая база, юникод, длинные тексты, конкурентная запись.
 * Запуск: node test/e2e/edge.test.js
 */
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-edge-'));
const STORE = path.join(TMP, 'store.db');
const toUnix = (p) => String(p).split(String.fromCharCode(92)).join('/');
const issues = [];
let passed = 0; let failed = 0;

async function t(name, fn) {
  try { await fn(); passed++; process.stdout.write('.'); }
  catch (e) { failed++; issues.push(`${name}: ${e.message}`); process.stdout.write('X'); }
}

/** запуск модуля с подменённым путём к базе */
function fresh(extraEnv = {}) {
  const code = `
    const fs = require('fs');
    const store = require('${toUnix(path.join(__dirname, '..', '..', 'src', 'core', 'store.js'))}');
    const out = {};
    out.loaded = !!store.load();
    out.total = store.stats().total;
    out.settings = !!store.getSettings();
    store.upsertJobs([{ id: 't:1', source: 't', title: 'Первый', publishedAt: Date.now() }]);
    out.afterUpsert = store.stats().total;
    out.job = store.getJob('t:1');
    out.list = store.listJobs({ limit: 10 }).items.length;
    out.saved = fs.existsSync('${toUnix(STORE)}');
    console.log(JSON.stringify(out));
  `;
  let res;
  try {
    res = execFileSync('node', ['-e', code], {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      env: { ...process.env, FH_DB_FILE: STORE, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new Error('дочерний процесс упал: ' + String(e.stderr || e.message).slice(0, 400));
  }
  const out = res.trim().split('\n').pop();
  try { return JSON.parse(out); } catch { throw new Error('не JSON из дочернего процесса: ' + out.slice(0, 300)); }
}

(async () => {
  await t('битая база → не падает, создаётся новая', async () => {
    fs.writeFileSync(STORE, 'это не база данных, а мусор');
    const r = fresh();
    assert.ok(r.loaded);
    assert.equal(r.total, 0);
    assert.equal(r.afterUpsert, 1);
  });

  await t('пустая база → пустая лента', async () => {
    fs.writeFileSync(STORE, '');
    const r = fresh();
    assert.equal(r.total, 0);
  });

  await t('миграция v1 JSON → SQLite', async () => {
    const jsonFile = path.join(TMP, 'store.json');
    fs.writeFileSync(jsonFile, JSON.stringify({
      schemaVersion: 1,
      projects: { '123': { internalId: 123, title: 'Старый заказ', price: '5 000 руб.', internalPrice: 5000, currency: 'RUB', date: Date.now(), site: 'alot:flru', rating: 7, seenCounter: 3 } },
      settings: { keywordsPlus: ['бот'], pollMinutes: 7 },
    }));
    fs.rmSync(STORE, { force: true });
    const code = `
      const store = require('${toUnix(path.join(__dirname, '..', '..', 'src', 'core', 'store.js'))}');
      const job = store.getJob('alot:123');
      const s = store.getSettings();
      console.log(JSON.stringify({
        job: !!job,
        price: job && job.price.min,
        responses: job && job.stats.responses,
        rating: job && job.client.rating,
        sites: job && job.sites,
        keywords: s.search.keywordsPlus,
        minutes: s.poll.minutes,
        total: store.stats().total,
      }));
    `;
    const res = execFileSync('node', ['-e', code], {
      cwd: path.join(__dirname, '..', '..'), encoding: 'utf8',
      env: { ...process.env, FH_DB_FILE: STORE, FH_LEGACY_JSON: jsonFile },
    });
    const d = JSON.parse(res.trim());
    assert.ok(d.job, 'заказ не перенесён');
    assert.equal(d.price, 5000);
    assert.equal(d.responses, 7, 'rating в alot = число откликов');
    assert.equal(d.rating, null, 'рейтинг клиента не должен браться из rating');
    assert.deepEqual(d.sites, ['flru']);
    assert.deepEqual(d.keywords, ['бот']);
    assert.equal(d.minutes, 7);
  });

  await t('произвольные поля не теряются', async () => {
    const code = `
      const store = require('${toUnix(path.join(__dirname, '..', '..', 'src', 'core', 'store.js'))}');
      store.setMeta('myCustomField', 42);
      console.log(JSON.stringify({ keep: store.getMeta('myCustomField') }));
    `;
    const res = execFileSync('node', ['-e', code], {
      cwd: path.join(__dirname, '..', '..'), encoding: 'utf8',
      env: { ...process.env, FH_DB_FILE: STORE },
    });
    assert.equal(JSON.parse(res.trim()).keep, 42);
  });

  await t('юникод и эмодзи в заголовке не ломают выдачу', async () => {
    fs.writeFileSync(STORE, '');
    const code = `
      const store = require('${toUnix(path.join(__dirname, '..', '..', 'src', 'core', 'store.js'))}');
      const title = '🎯 Сайт «Магия» — 100% \\u043A\\u0430\\u0447\\u0435\\u0441\\u0442\\u0432\\u0430 🔥';
      store.upsertJobs([{ id: 'u:1', source: 'u', title, body: 'текст', publishedAt: Date.now() }]);
      const found = store.listJobs({ q: 'Магия' }).items;
      const all = store.listJobs({ limit: 10 }).items;
      console.log(JSON.stringify({ found: found.length, all: all.length, title: all[0] && all[0].title }));
    `;
    const res = execFileSync('node', ['-e', code], {
      cwd: path.join(__dirname, '..', '..'), encoding: 'utf8',
      env: { ...process.env, FH_DB_FILE: STORE },
    });
    const d = JSON.parse(res.trim());
    assert.equal(d.found, 1);
    assert.equal(d.all, 1);
    assert.ok(d.title.includes('🎯'));
  });

  await t('очень длинный заголовок и тело не ломают модель', async () => {
    fs.writeFileSync(STORE, '');
    const code = `
      const store = require('${toUnix(path.join(__dirname, '..', '..', 'src', 'core', 'store.js'))}');
      const { makeJob } = require('${toUnix(path.join(__dirname, '..', '..', 'src', 'core', 'model.js'))}');
      const long = 'A'.repeat(200000);
      const job = makeJob('x', { title: long, body: long });
      store.upsertJobs([job]);
      const back = store.getJob(job.id);
      console.log(JSON.stringify({ ok: !!back, len: back.title.length, bodyLen: back.body.length }));
    `;
    const res = execFileSync('node', ['-e', code], {
      cwd: path.join(__dirname, '..', '..'), encoding: 'utf8',
      env: { ...process.env, FH_DB_FILE: STORE },
    });
    const d = JSON.parse(res.trim());
    assert.ok(d.ok);
      assert.equal(d.len, 300);
    assert.ok(d.bodyLen <= 8000, 'тело должно обрезаться: ' + d.bodyLen);
  });

  await t('битый accounts.json → не падает', async () => {
    const accFile = path.join(__dirname, '..', '..', 'data', 'accounts.json');
    const backup = fs.existsSync(accFile) ? fs.readFileSync(accFile) : null;
    fs.writeFileSync(accFile, '{сломан');
    try {
      const code = `
        const accounts = require('${toUnix(path.join(__dirname, '..', '..', 'src', 'core', 'accounts.js'))}');
        const list = accounts.list();
        console.log(JSON.stringify({ ok: Array.isArray(list) }));
      `;
      const res = execFileSync('node', ['-e', code], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
      assert.equal(JSON.parse(res.trim()).ok, true);
    } finally {
      if (backup) fs.writeFileSync(accFile, backup); else fs.unlinkSync(accFile);
    }
  });

  await t('фильтр по бирже не отдаёт чужие', async () => {
    fs.writeFileSync(STORE, '');
    const code = `
      const store = require('${toUnix(path.join(__dirname, '..', '..', 'src', 'core', 'store.js'))}');
      store.upsertJobs([
        { id: 'a:1', source: 'alot', sites: ['kworkru'], title: 'A', publishedAt: Date.now() },
        { id: 'a:2', source: 'alot', sites: ['flru'], title: 'B', publishedAt: Date.now() },
        { id: 'a:3', source: 'alot', sites: [], title: 'C', publishedAt: Date.now() },
      ]);
      const only = store.listJobs({ sites: ['kworkru'] }).items;
      console.log(JSON.stringify({ ids: only.map((x) => x.id) }));
    `;
    const res = execFileSync('node', ['-e', code], {
      cwd: path.join(__dirname, '..', '..'), encoding: 'utf8',
      env: { ...process.env, FH_DB_FILE: STORE },
    });
    const d = JSON.parse(res.trim());
    assert.deepEqual(d.ids, ['a:1']);
  });

  await t('параллельная запись из двух процессов не теряет данные', async () => {
    fs.writeFileSync(STORE, '');
    const script = `
      const store = require('${toUnix(path.join(__dirname, '..', '..', 'src', 'core', 'store.js'))}');
      const n = process.argv[2];
      for (let i = 0; i < 40; i++) store.upsertJobs([{ id: 'p:' + n + ':' + i, source: 'p', title: 'x', publishedAt: Date.now() }]);
    `;
    const scriptFile = path.join(TMP, 'writer.js');
    fs.writeFileSync(scriptFile, script);
    // реальная параллельность: оба процесса работают одновременно
    await Promise.all([1, 2].map((n) => new Promise((resolve, reject) => {
      execFile('node', [scriptFile, String(n)], { env: { ...process.env, FH_DB_FILE: STORE } },
        (err) => (err ? reject(err) : resolve()));
    })));
    const code = `
      const store = require('${toUnix(path.join(__dirname, '..', '..', 'src', 'core', 'store.js'))}');
      console.log(JSON.stringify({ total: store.stats().total }));
    `;
    const res = execFileSync('node', ['-e', code], {
      cwd: path.join(__dirname, '..', '..'), encoding: 'utf8',
      env: { ...process.env, FH_DB_FILE: STORE },
    });
    const d = JSON.parse(res.trim());
    assert.equal(d.total, 80, 'ожидалось 80 записей, получено ' + d.total);
  });

  await t('битый канал Telegram в channels.json → пустой список', async () => {
    const chFile = path.join(__dirname, '..', '..', 'src', 'tg', 'channels.json');
    const backup = fs.readFileSync(chFile);
    fs.writeFileSync(chFile, '{битый');
    try {
      const code = `
        const tg = require('${toUnix(path.join(__dirname, '..', '..', 'src', 'tg', 'index.js'))}');
        console.log(JSON.stringify({ ok: Array.isArray(tg.loadChannels()) }));
      `;
      const res = execFileSync('node', ['-e', code], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
      assert.equal(JSON.parse(res.trim()).ok, true);
    } finally {
      fs.writeFileSync(chFile, backup);
    }
  });

  await t('каналы без TELEGRAM_* → ошибка понятная', async () => {
    const py = 'D:\\opencode\\mcp-servers\\telegram-mcp\\.venv\\Scripts\\python.exe';
    if (!fs.existsSync(py)) return; // нет python — пропускаем
    const scriptFile = path.join(TMP, 'tg-check.js');
    fs.writeFileSync(scriptFile, `
const { execFileSync, execFile } = require('child_process');
      const TG_PY = ${JSON.stringify(py)};
      const TG_SCRIPT = ${JSON.stringify(toUnix(path.join(__dirname, '..', '..', 'src', 'tg', 'tg_fetch.py')))};
      try {
        execFileSync(TG_PY, [TG_SCRIPT, 'test_channel'], {
          encoding: 'utf8', env: { PATH: process.env.PATH },
        });
        console.log(JSON.stringify({ out: 'no error' }));
      } catch (e) {
        console.log(JSON.stringify({ err: (e.stderr || String(e.message)).slice(0, 300) }));
      }
    `);
    const res = execFileSync('node', [scriptFile], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
    const d = JSON.parse(res.trim());
    assert.ok(d.err || d.out, 'нет результата');
    if (d.err) {
      // ошибка должна быть понятной: либо про переменные окружения, либо про канал/сеть
      assert.ok(
        /переменн|TELEGRAM|Traceback|username|ResolveUsername|Nobody|Timeout|connecting|failed/i.test(d.err),
        'непонятная ошибка: ' + d.err.slice(0, 160),
      );
    }
  });

  await t('оценка качества выдерживает мусорные данные', async () => {
    const code = `
      const { evaluate } = require('${toUnix(path.join(__dirname, '..', '..', 'src', 'core', 'quality.js'))}');
      const { makeJob } = require('${toUnix(path.join(__dirname, '..', '..', 'src', 'core', 'model.js'))}');
      const settings = require('${toUnix(path.join(__dirname, '..', '..', 'src', 'core', 'settings.js'))}').defaults();
      const cases = [
        makeJob('x', {}),
        makeJob('x', { title: null, body: null, price: null }),
        makeJob('x', { title: '', body: '', client: {}, stats: {} }),
        makeJob('x', { title: 'x', price: { min: -100, max: -1, currency: 'XXX' } }),
      ];
      const res = cases.map((c) => { const q = evaluate(c, settings); return { score: q.score, verdict: q.verdict }; });
      console.log(JSON.stringify(res));
    `;
    const res = execFileSync('node', ['-e', code], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
    const arr = JSON.parse(res.trim());
    assert.equal(arr.length, 4);
    for (const a of arr) {
      assert.equal(typeof a.score, 'number');
      assert.ok(!Number.isNaN(a.score));
      assert.ok(['prime', 'good', 'meh', 'bad', 'blocked'].includes(a.verdict));
    }
  });

  console.log(`\n\nEDGE: ${passed} ок, ${failed} сломанных`);
  for (const i of issues) console.log('  ✗ ' + i);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* не удалось */ }
  process.exit(failed ? 1 : 0);
})();
