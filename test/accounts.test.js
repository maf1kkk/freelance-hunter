'use strict';
const test = require('node:test');
const assert = require('node:assert');
const accounts = require('../src/core/accounts');

const NETSCAPE = `# Netscape HTTP Cookie File
.fl.ru\tTRUE\t/\tTRUE\t1799999999\tPHPSESSID\tabc123
#HttpOnly_.kwork.ru\tTRUE\t/\tTRUE\t1799999999\tuid_kwork\t999
`;

const CHROME_JSON = JSON.stringify([
  { domain: '.fl.ru', name: 'fl_sid', value: 'xyz', path: '/', secure: true, httpOnly: false, expirationDate: 1799999999 },
  { domain: '.fl.ru', name: 'fl_uid', value: '42', path: '/' },
]);

const PW_STATE = JSON.stringify({
  cookies: [{ name: 'uid', value: '1', domain: 'hh.ru', path: '/', expires: -1, httpOnly: true, secure: true }],
  origins: [{ origin: 'https://hh.ru', localStorage: [] }],
});

test('парсинг Netscape cookies.txt', () => {
  const r = accounts.parseCookieFile(NETSCAPE);
  assert.equal(r.format, 'netscape');
  assert.equal(r.cookies.length, 2);
  assert.equal(r.cookies[0].name, 'PHPSESSID');
  assert.equal(r.cookies[1].httpOnly, true);
  assert.deepEqual(r.domains.sort(), ['.kwork.ru', '.fl.ru'].sort());
});

test('парсинг Chrome JSON', () => {
  const r = accounts.parseCookieFile(CHROME_JSON);
  assert.equal(r.format, 'chrome-json');
  assert.equal(r.cookies.length, 2);
  assert.equal(r.cookies[0].value, 'xyz');
});

test('парсинг Playwright storageState', () => {
  const r = accounts.parseCookieFile(PW_STATE);
  assert.equal(r.format, 'playwright-storage-state');
  assert.equal(r.cookies[0].domain, 'hh.ru');
});

test('парсинг сырой строки header', () => {
  const r = accounts.parseCookieFile('a=1; b=2');
  assert.equal(r.format, 'raw-header');
  assert.equal(r.cookies.length, 2);
  assert.equal(r.cookies[1].name, 'b');
});

test('парсинг JSON {cookies:[...]}', () => {
  const r = accounts.parseCookieFile(JSON.stringify({ cookies: [{ name: 'x', value: 'y', domain: 'fl.ru' }] }));
  assert.equal(r.cookies.length, 1);
  assert.equal(r.cookies[0].name, 'x');
});

test('определение сервиса по домену', () => {
  assert.equal(accounts.detectService(['fl.ru']), 'flru');
  assert.equal(accounts.detectService(['.kwork.ru']), 'kwork');
  assert.equal(accounts.detectService(['hh.ru']), 'hh');
  assert.equal(accounts.detectService(['example.com']), 'custom');
});

test('склейка cookie по ключу domain|path|name', () => {
  const merged = accounts.mergeCookies(
    [{ domain: 'fl.ru', path: '/', name: 'a', value: '1' }],
    [{ domain: 'fl.ru', path: '/', name: 'a', value: '2' }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].value, '2');
});

test('cookieHeader собирает строку Cookie', () => {
  const acc = accounts.set('flru', {
    type: 'cookies', service: 'flru', domain: 'fl.ru',
    domains: ['fl.ru'],
    cookies: [{ domain: 'fl.ru', path: '/', name: 'a', value: '1', expires: -1 }],
  });
  assert.ok(acc);
  const h = accounts.cookieHeader('flru', 'fl.ru');
  assert.equal(h, 'a=1');
  accounts.remove('flru');
});
