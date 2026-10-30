'use strict';
const test = require('node:test');
const assert = require('node:assert');
const settings = require('../src/core/settings');

test('дефолты содержат все группы', () => {
  const d = settings.defaults();
  for (const g of Object.keys(settings.SCHEMA)) assert.ok(d[g], 'нет группы ' + g);
});

test('валидация приводит типы', () => {
  const s = settings.validate({ search: { keywordsPlus: 'бот, сайт ,', priceMin: '5000' } });
  assert.deepEqual(s.search.keywordsPlus, ['бот', 'сайт']);
  assert.equal(s.search.priceMin, 5000);
});

test('валидация режет значения вне диапазона', () => {
  const s = settings.validate({ quality: { minClientRating: 500, maxResponses: 0 } });
  assert.equal(s.quality.minClientRating, 100);
  assert.equal(s.quality.maxResponses, 1);
});

test('числовые строки становятся числами', () => {
  const s = settings.validate({ poll: { minutes: '15' } });
  assert.equal(s.poll.minutes, 15);
});

test('булевы значения распознаются', () => {
  const s = settings.validate({ apply: { enabled: 'true', dryRun: 'false' } });
  assert.equal(s.apply.enabled, true);
  assert.equal(s.apply.dryRun, false);
});

test('миграция со старой версии переносит поля', () => {
  const m = settings.migrate({
    keywordsPlus: ['бот'],
    keywordsMinus: ['крипта'],
    priceMin: 5000,
    pollMinutes: 10,
    autoApply: true,
  });
  assert.deepEqual(m.search.keywordsPlus, ['бот']);
  assert.deepEqual(m.search.keywordsMinus, ['крипта']);
  assert.equal(m.search.priceMin, 5000);
  assert.equal(m.poll.minutes, 10);
  assert.equal(m.apply.enabled, true);
  assert.equal(m.schemaVersion, 2);
});

test('get/set работают по пути', () => {
  const s = settings.defaults();
  settings.set(s, 'search.priceMin', '7000');
  assert.equal(settings.get(s, 'search.priceMin'), 7000);
});

test('неизвестные ключи группы не теряются', () => {
  const s = settings.validate({ sources: { flru: { enabled: false } } });
  assert.deepEqual(s.sources, { flru: { enabled: false } });
});
