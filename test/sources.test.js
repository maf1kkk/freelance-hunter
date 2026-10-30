'use strict';
const test = require('node:test');
const assert = require('node:assert');
const flru = require('../src/sources/flru');
const kwork = require('../src/sources/kwork');
const hh = require('../src/sources/hh');
const sources = require('../src/sources');

/* ------------------------- FL.ru карточка ------------------------------ */
const FLRU_CARD = `
<div class="b-page__lenta_item b-post" id="project-item5525976">
  <h2 class="text-h5 b-post__title"><a id="prj_name_5525976" href="/projects/5525976/sverstat-buklet.html">Сверстать буклет объёмом от 20 до 36 полос</a></h2>
  <div class="b-post__price"><span class="text-4">7&nbsp;000&nbsp;<span class="fl-rub">&#8381;</span></span></div>
  <div class="b-post__body"><div class="b-post__txt">Нужно сверстать буклет объёмом от 20 до 36 полос.</div></div>
  <span class="text-gray-opacity-4">8 минут назад</span>
  <span title="Количество просмотров"><span class="text-7">146</span></span>
  <span data-id="fl-view-count-href">2 ответа</span>
</div>`;

test('FL.ru: парсинг карточки', () => {
  const p = flru.parseCard({ id: '5525976', html: FLRU_CARD });
  assert.equal(p.title, 'Сверстать буклет объёмом от 20 до 36 полос');
  assert.equal(p.href, 'https://www.fl.ru/projects/5525976/sverstat-buklet.html');
  assert.equal(p.money.min, 7000);
  assert.equal(p.money.currency, 'RUB');
  assert.equal(p.responses, 2);
  assert.equal(p.views, 146);
  assert.ok(p.publishedAt > 0);
});

/* ------------------------- Kwork данные -------------------------------- */
const KWORK_HTML = `<script>window.stateData = {"wantsListData":{"pagination":{"current_page":1,"data":[
{"id":3268136,"name":"Ищу маркетолога-копирайтера","description":"Нужно продвижение","priceLimit":"3000.00",
 "date_create":"2026-10-20 09:19:41","date_expire":"2026-10-21 09:19:41","category_id":"273",
 "views_dirty":"19","getWantsActiveCount":"2","wantGetSumOrderCount":0,"max_days":"10",
 "user":{"USERID":16739933,"username":"blesterin","badges":[],"data":{"wants_count":"2","wants_hired_percent":"0"}}}
]}};</script>`;

test('Kwork: парсинг встроенного JSON', () => {
  const { list } = kwork.parseWantsList(KWORK_HTML);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 3268136);
  assert.equal(list[0].name, 'Ищу маркетолога-копирайтера');
});

test('Kwork: чтение поля wantsListData по ключу', () => {
  const { list } = kwork.parseWantsList('<script>var x={"wantsListData":{"pagination":{"data":[{"id":1,"name":"A"}]}}};</script>');
  assert.equal(list.length, 1);
});

/* --------------------------- hh.ru карточка ----------------------------- */
const HH_CARD = `<article data-qa="vacancy-serp__vacancy">
  <a data-qa="serp-item__title" href="https://hh.ru/vacancy/137298080?from=x">
    <span data-qa="serp-item__title-text">Специалист по ценообразованию</span></a>
  <span class="salary">от 165 000 ₽ за месяц</span>
  <div data-qa="vacancy-serp__vacancy-employer-text">ООО ЮТИМ</div>
  <span data-qa="company-review-rating-value">4.2</span>
  <span data-qa="company-review-rating-reviews-count"><span>77 отзывов</span></span>
  <span data-qa="vacancy-serp__vacancy-address">Москва, Тверская</span>
  <span>3 человека откликнулись</span>
</article>`;

test('hh.ru: парсинг карточки', () => {
  const p = hh.parseCard(HH_CARD);
  assert.equal(p.id, '137298080');
  assert.equal(p.title, 'Специалист по ценообразованию');
  assert.equal(p.employer, 'ООО ЮТИМ');
  assert.equal(p.rating, 4.2);
  assert.equal(p.reviews, 77);
  assert.equal(p.responses, 3);
  assert.equal(p.salary.min, 165000);
  assert.equal(p.salary.currency, 'RUB');
});

/* --------------------------- реестр источников -------------------------- */
test('реестр содержит 11 источников', () => {
  assert.equal(sources.all().length, 11);
  for (const id of ['alot', 'flru', 'kwork', 'hh', 'telegram', 'remoteok', 'remotive', 'arbeitnow', 'jobicy', 'himalayas', 'weworkremotely']) {
    assert.ok(sources.get(id), 'нет источника ' + id);
  }
});

test('каждый источник объявляет контракт', () => {
  for (const s of sources.all()) {
    assert.equal(typeof s.id, 'string');
    assert.equal(typeof s.label, 'string');
    assert.equal(typeof s.fetch, 'function');
    assert.equal(typeof s.check, 'function');
    assert.ok(['exchange', 'jobs', 'chat'].includes(s.kind));
  }
});

test('enabled() уважает настройки', () => {
  const all = sources.enabled({ sources: {} });
  assert.equal(all.length, 11);
  const less = sources.enabled({ sources: { flru: { enabled: false } } });
  assert.equal(less.length, 10);
  assert.ok(!less.find((s) => s.id === 'flru'));
});
