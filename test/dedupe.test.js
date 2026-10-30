'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { group, sameJob, jaccard, normTitle, priceOverlap, stemSet, titleCoverage } = require('../src/core/dedupe');
const { makeJob } = require('../src/core/model');

function job(source, id, title, price = 10000) {
  return makeJob(source, {
    externalId: id,
    title,
    body: 'Нужно сверстать сайт и настроить форму обратной связи на клиенте.',
    price: { min: price, max: price, currency: 'RUB', text: String(price) },
    publishedAt: Date.now(),
  });
}

test('одинаковые заказы с разных площадок попадают в одну группу', () => {
  const jobs = [
    job('flru', '1', 'Сверстать лендинг для компании', 15000),
    job('kwork', '2', 'Сверстать лендинг для компании', 15000),
  ];
  const groups = group(jobs);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].jobs.length, 2);
  assert.equal(jobs[0].dedupe.groupId, jobs[1].dedupe.groupId);
});

test('разные заказы остаются разными', () => {
  const groups = group([
    job('flru', '1', 'Сверстать лендинг для компании', 15000),
    job('flru', '2', 'Разработать мобильное приложение', 900000),
  ]);
  assert.equal(groups.length, 2);
});

test('одинаковый заголовок, но разная цена — разные заказы', () => {
  const groups = group([
    job('flru', '1', 'Сверстать лендинг', 5000),
    job('kwork', '2', 'Сверстать лендинг', 90000),
  ]);
  assert.equal(groups.length, 2);
});

test('группа помечает дубликаты и выбирает лучшего представителя', () => {
  const jobs = [job('flru', '1', 'Сверстать лендинг', 15000), job('kwork', '2', 'Сверстать лендинг', 15000)];
  group(jobs);
  const withDup = jobs.find((j) => j.dedupe.duplicates.length > 0);
  assert.ok(withDup, 'ожидались дубликаты');
  assert.equal(withDup.dedupe.duplicates.length, 1);
});

test('jaccard считает пересечение множеств', () => {
  assert.equal(jaccard(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccard(['a'], ['b']), 0);
  assert.equal(jaccard(['a', 'b'], ['a', 'c']), 1 / 3);
});

test('normTitle убирает служебные слова', () => {
  assert.ok(!normTitle('Нужен веб-дизайнер').includes('нужен'));
});

test('priceOverlap: одинаковые точечные цены пересекаются', () => {
  assert.equal(priceOverlap({ min: 20000, max: 20000 }, { min: 20000, max: 20000 }), true);
  assert.equal(priceOverlap({ min: 20000 }, { min: 20000 }), true);
});

test('priceOverlap: диапазоны с пересечением', () => {
  assert.equal(priceOverlap({ min: 10000, max: 30000 }, { min: 20000, max: 40000 }), true);
});

test('priceOverlap: сильно разные цены не пересекаются', () => {
  assert.equal(priceOverlap({ min: 5000, max: 5000 }, { min: 90000, max: 90000 }), false);
});

test('priceOverlap: неизвестная цена не мешает', () => {
  assert.equal(priceOverlap(null, { min: 100 }), true);
  assert.equal(priceOverlap({ min: null }, { min: 100 }), true);
});

test('stemOverlap склеивает словоформы', () => {
  const a = stemSet('Сверстать лендинг для компании');
  const b = stemSet('Вёрстка лендинга для компании');
  const cov = titleCoverage('Сверстать лендинг для компании', 'Вёрстка лендинга для компании');
  assert.ok(cov.ratio >= 0.8, 'покрытие: ' + cov.ratio);
  assert.ok(cov.matched >= 2, 'совпадений: ' + cov.matched);
});

test('разные заказы не склеиваются', () => {
  const cov = titleCoverage('Создать бот для заявок', 'Написать телеграм бота');
  assert.ok(cov.ratio < 0.8, 'покрытие слишком высокое: ' + cov.ratio);
});

test('одинаковые по смыслу, но разные по словам заказы не склеиваются', () => {
  const cov = titleCoverage('Senior Product Designer (UI/UX)', 'Principal Product Designer');
  assert.ok(cov.ratio < 0.8, 'покрытие слишком высокое: ' + cov.ratio);
});
