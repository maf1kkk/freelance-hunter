'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluate, kwMatch, tokenize, stems } = require('../src/core/quality');
const { makeJob } = require('../src/core/model');

const baseSettings = {
  search: { keywordsPlus: ['сайт', 'бот', 'верстка'], keywordsMinus: [], sites: [], priceMin: null, priceMax: null },
  quality: { minClientRating: 0, minClientReviews: 0, maxResponses: 50, idealResponses: 8, minSalaryPerHour: null, blockWords: [] },
  profile: { skills: 'веб-разработка, python' },
};

function job(p = {}) {
  return makeJob('test', {
    title: 'Разработка сайта на WordPress',
    body: 'Нужно сверстать лендинг и настроить интеграцию с CRM. Оплата по договорённости после сдачи.',
    price: { min: 30000, max: 30000, currency: 'RUB', text: '30 000 ₽' },
    publishedAt: Date.now(),
    stats: { responses: 2 },
    client: { name: 'Иван', rating: 4.8, reviews: 25, orders: 40, hiredPercent: 80, verified: true },
    ...p,
  });
}

test('хороший заказ получает высокий score', () => {
  const q = evaluate(job(), baseSettings);
  assert.ok(q.score >= 70, `ожидался prime, получено ${q.score} (${q.verdict})`);
  assert.equal(q.verdict, 'prime');
});

test('минус-слово блокирует заказ', () => {
  const s = { ...baseSettings, search: { ...baseSettings.search, keywordsMinus: ['wordpress'] } };
  const q = evaluate(job(), s);
  assert.equal(q.verdict, 'blocked');
  assert.equal(q.score, 0);
});

test('стоп-лист отсекает мусор', () => {
  const q = evaluate(job({ title: 'Казино и ставки на спорт' }), baseSettings);
  assert.equal(q.verdict, 'blocked');
  assert.ok(q.flags.includes('blacklist'));
});

test('пользовательский стоп-лиск работает', () => {
  const s = { ...baseSettings, quality: { ...baseSettings.quality, blockWords: ['лендинг'] } };
  const q = evaluate(job(), s);
  assert.equal(q.verdict, 'blocked');
});

test('низкий рейтинг клиента штрафуется при жёстком пороге', () => {
  const s = { ...baseSettings, quality: { ...baseSettings.quality, minClientRating: 4 } };
  const q = evaluate(job({ client: { name: 'X', rating: 2 } }), s);
  assert.ok(q.flags.includes('low_rating'));
  assert.ok(q.score < 70);
});

test('мало отзывов штрафуется', () => {
  const s = { ...baseSettings, quality: { ...baseSettings.quality, minClientReviews: 10 } };
  const q = evaluate(job({ client: { name: 'X', rating: 5, reviews: 1 } }), s);
  assert.ok(q.flags.includes('few_reviews'));
});

test('слишком много откликов понижает конкурентность', () => {
  const q1 = evaluate(job({ stats: { responses: 1 } }), baseSettings);
  const q2 = evaluate(job({ stats: { responses: 200 } }), baseSettings);
  assert.ok(q1.score > q2.score, `${q1.score} должно быть > ${q2.score}`);
  assert.ok(q2.flags.includes('too_many_responses'));
});

test('заказчик, который никого не нанимал, штрафуется', () => {
  const q = evaluate(job({ client: { name: 'X', hiredPercent: 0, orders: 3 } }), baseSettings);
  assert.ok(q.flags.includes('never_hired'));
});

test('новый аккаунт штрафуется', () => {
  const q = evaluate(job({ client: { name: 'X', ageDays: 2 } }), baseSettings);
  assert.ok(q.flags.includes('new_account'));
});

test('смешение кириллицы и латиницы ловится', () => {
  const q = evaluate(job({ title: 'Сайт на Wоrdpress' }), baseSettings);
  assert.ok(q.flags.includes('mixed_script'));
});

test('телефон в тексте понижает', () => {
  const q = evaluate(job({ body: 'Пишите по телефону +7 999 123 45 67, нужно сверстать сайт' }), baseSettings);
  assert.ok(q.flags.includes('phone_in_text'));
});

test('спам-фразы понижают', () => {
  const good = evaluate(job(), baseSettings);
  const spam = evaluate(job({ body: 'Срочно нужно сделать сайт, дёшево, без опыта' }), baseSettings);
  assert.ok(spam.score < good.score);
  assert.ok(spam.flags.includes('spam_phrases'));
});

test('устаревший заказ теряет баллы за свежесть', () => {
  const fresh = evaluate(job({ publishedAt: Date.now() }), baseSettings);
  const old = evaluate(job({ publishedAt: Date.now() - 10 * 86400000 }), baseSettings);
  assert.ok(fresh.score > old.score);
});

test('цена ниже минимума штрафуется', () => {
  const s = { ...baseSettings, search: { ...baseSettings.search, priceMin: 100000 } };
  const q = evaluate(job(), s);
  assert.ok(q.flags.includes('price_low'));
});

test('kwMatch: «бот» не совпадает с «разработчик»', () => {
  assert.equal(kwMatch(tokenize('разработчик'), 'бот'), false);
  assert.equal(kwMatch(tokenize('бот'), 'бот'), true);
  assert.equal(kwMatch(tokenize('бота'), 'бот'), true);
  assert.equal(kwMatch(tokenize('дизайнер'), 'дизайн'), true);
  assert.equal(kwMatch(tokenize('сайты'), 'сайт'), true);
  assert.equal(kwMatch(tokenize('python3'), 'python'), true);
  assert.equal(kwMatch(tokenize('простой'), 'проститутк'), false);
});

test('stems не выкидывает основу слова полностью', () => {
  assert.ok(stems('разработчик').has('разработ'));
  assert.ok(stems('дизайнер').has('дизайн'));
});
