'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeJob, salaryPerHour, fingerprint, titleTokens } = require('../src/core/model');
const html = require('../src/core/html');
const rss = require('../src/core/rss');

test('makeJob строит единую модель', () => {
  const j = makeJob('flru', {
    externalId: '5525976',
    title: '  Сверстать лендинг  ',
    body: 'Описание',
    url: 'https://www.fl.ru/projects/5525976/',
    price: { min: 15000, max: 20000, currency: 'RUB', text: '15 000–20 000 ₽' },
    publishedAt: 1700000000000,
    stats: { responses: 3 },
    client: { name: 'Иван', rating: 4.5, reviews: 10 },
  });
  assert.equal(j.id, 'flru:5525976');
  assert.equal(j.title, 'Сверстать лендинг');
  assert.equal(j.price.min, 15000);
  assert.equal(j.stats.responses, 3);
  assert.equal(j.client.rating, 4.5);
});

test('makeJob принимает и примитивную цену', () => {
  const j = makeJob('x', { title: 't', price: 1000, currency: 'RUB' });
  assert.equal(j.price.min, 1000);
  assert.equal(j.price.max, 1000);
});

test('fingerprint стабилен', () => {
  const a = fingerprint('Сверстать лендинг', { min: 100 });
  const b = fingerprint('сверстать  лендинг!', { min: 100 });
  assert.equal(a, b);
});

test('titleTokens убирает служебные слова', () => {
  const t = titleTokens('Нужен веб-дизайнер для сайта');
  assert.ok(!t.includes('нужен'));
  assert.ok(t.includes('дизайнер'));
});

test('salaryPerHour считает ставку', () => {
  const j = makeJob('x', { title: 'Задача', body: 'a'.repeat(500), price: { min: 30000, currency: 'RUB' } });
  const rate = salaryPerHour(j);
  assert.ok(rate > 0 && rate < 100000, 'ставка ' + rate);
});

test('decodeEntities раскрывает html-сущности', () => {
  assert.equal(html.decodeEntities('7&nbsp;000&nbsp;&#8381;'), '7 000 ₽');
  assert.equal(html.decodeEntities('&laquo;тест&raquo;'), '«тест»');
});

test('toText чистит теги', () => {
  assert.equal(html.toText('<p>Привет</p><br>Мир'), 'Привет\n\nМир');
});

test('parseMoney разбирает суммы', () => {
  const m = html.parseMoney('от 5 000 до 10 000 ₽');
  assert.equal(m.min, 5000);
  assert.equal(m.max, 10000);
  assert.equal(m.currency, 'RUB');
});

test('pickAll находит все совпадения', () => {
  const out = html.pickAll('<a href="/a">1</a><a href="/b">2</a>', /href="([^"]+)"/g);
  assert.deepEqual(out, ['/a', '/b']);
});

test('sliceByMarker режет на карточки', () => {
  const blocks = html.sliceByMarker('<div id="i1">a</div><div id="i2">b</div>', /id="(i\d)"/g);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].key, 'i1');
});

test('extractVarJson достаёт window.X = {...}', () => {
  const data = html.extractVarJson('<script>window.STATE={"a":1,"b":[2,3]};</script>', 'STATE');
  assert.equal(data.a, 1);
  assert.deepEqual(data.b, [2, 3]);
});

test('extractKeyJson достаёт вложенный ключ', () => {
  const data = html.extractKeyJson('prefix{"outer":{"x":5}}suffix', 'outer');
  assert.equal(data.x, 5);
});

test('rss парсит RSS 2.0', () => {
  const xml = `<rss><channel>
    <item><title>Job A</title><link>https://e.com/a</link><description><![CDATA[<p>Text</p>]]></description>
    <pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate><category>dev</category><region>Anywhere</region></item>
  </channel></rss>`;
  const items = rss.parse(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Job A');
  assert.equal(items[0].link, 'https://e.com/a');
  assert.equal(items[0].description, 'Text');
  assert.deepEqual(items[0].categories, ['dev']);
  assert.equal(items[0].extra.region, 'Anywhere');
});

test('rss парсит Atom', () => {
  const xml = `<feed><entry><title>Job B</title><link href="https://e.com/b"/><updated>2024-01-02T10:00:00Z</updated>
    <content>Body</content></entry></feed>`;
  const items = rss.parse(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].link, 'https://e.com/b');
});
