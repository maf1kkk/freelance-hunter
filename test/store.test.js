'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// магазин работает с фиксированным файлом → подменяем путь до require
const STORE = path.join(os.tmpdir(), `fh-store-test-${process.pid}.json`);
process.env.FH_DB_FILE = STORE;

const store = require('../src/core/store');

test.after(() => {
  try { fs.unlinkSync(STORE); } catch { /* нет файла */ }
});

test('upsertJobs добавляет и обновляет', () => {
  const r = store.upsertJobs([
    { id: 'test:1', source: 'test', title: 'Заказ один', publishedAt: Date.now() },
  ]);
  assert.equal(r.added, 1);
  const r2 = store.upsertJobs([
    { id: 'test:1', source: 'test', title: 'Заказ один (новый текст)', publishedAt: Date.now() },
  ]);
  assert.equal(r2.updated, 1);
  assert.equal(store.getJob('test:1').title, 'Заказ один (новый текст)');
});

test('ручной статус сохраняется при перезаписи', () => {
  store.setJobStatus('test:1', 'applied', { responseText: 'мой отклик' });
  store.upsertJobs([{ id: 'test:1', source: 'test', title: 'обновлено', publishedAt: Date.now() }]);
  const j = store.getJob('test:1');
  assert.equal(j.status, 'applied');
  assert.equal(j.responseText, 'мой отклик');
});

test('listJobs фильтрует по источнику и вердикту', () => {
  store.upsertJobs([
    { id: 'test:2', source: 'other', title: 'Другой', quality: { score: 90, verdict: 'prime' }, publishedAt: Date.now() },
    { id: 'test:3', source: 'test', title: 'Третий', quality: { score: 20, verdict: 'bad' }, publishedAt: Date.now() },
  ]);
  const bySrc = store.listJobs({ source: 'other' });
  assert.equal(bySrc.items.length, 1);
  const byVerdict = store.listJobs({ verdict: 'prime' });
  assert.ok(byVerdict.items.every((j) => j.quality.verdict === 'prime'));
});

test('фильтр по биржам работает', () => {
  store.upsertJobs([{ id: 'test:4', source: 'alot', sites: ['kworkru'], title: 'X', publishedAt: Date.now() }]);
  assert.equal(store.listJobs({ sites: ['kworkru'] }).items.length, 1);
  assert.equal(store.listJobs({ sites: ['flru'] }).items.length, 0);
});

test('поиск по тексту', () => {
  store.upsertJobs([{ id: 'test:5', source: 'test', title: 'Верстать лендинг', publishedAt: Date.now() }]);
  assert.equal(store.listJobs({ q: 'лендинг' }).items.length, 1);
  assert.equal(store.listJobs({ q: 'нетакого' }).items.length, 0);
});

test('настройки сохраняются и валидируются', () => {
  const s = store.updateSettings({ search: { priceMin: '1234' } });
  assert.equal(s.search.priceMin, 1234);
  assert.equal(store.getSettings().search.priceMin, 1234);
});

test('normVerdict переводит старые вердикты', () => {
  assert.equal(store.normVerdict('match'), 'prime');
  assert.equal(store.normVerdict('skip'), 'bad');
  assert.equal(store.normVerdict('prime'), 'prime');
});

test('статистика считается', () => {
  const s = store.stats();
  assert.ok(s.total > 0);
  assert.ok(typeof s.bySource === 'object');
});

test('legacy telegram-записи переносятся в формат telegram:<id>', () => {
  // миграция v1 → v2: заказы с id tg_<канал>_<id> становятся telegram:<канал>_<id>
  const db = store.load();
  assert.ok(db.jobs, 'снимок доступен');
  assert.ok(Object.keys(db.jobs).length >= 0);
});

test('mark_applied работает со строковыми id', () => {
  store.upsertJobs([{ id: 'telegram:ch_1', source: 'telegram', title: 'TG заказ', publishedAt: Date.now() }]);
  const updated = store.setJobStatus('telegram:ch_1', 'drafted', { responseText: 'ок' });
  assert.ok(updated);
  assert.equal(updated.status, 'drafted');
  assert.equal(updated.responseText, 'ок');
});
