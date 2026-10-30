'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ai = require('../src/core/ai');
const aiProfile = require('../src/core/ai-profile');
const resume = require('../src/core/resume');

/* --------------------------- extractJson -------------------------------- */
test('extractJson достаёт чистый JSON', () => {
  assert.deepEqual(aiProfile.extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(aiProfile.extractJson('Вот ответ:\n```json\n{"a":2}\n```\nГотово'), { a: 2 });
  assert.deepEqual(aiProfile.extractJson('текст {"b":[1,2]} ещё'), { b: [1, 2] });
});

test('extractJson не ломается на строках с фигурными скобками', () => {
  assert.deepEqual(aiProfile.extractJson('{"t":"вот { скобка"}'), { t: 'вот { скобка' });
});

test('extractJson возвращает null на мусоре', () => {
  assert.equal(aiProfile.extractJson('вообще не json'), null);
  assert.equal(aiProfile.extractJson(''), null);
});

/* --------------------------- профиль ------------------------------------ */
test('normalizeProfile приводит к предсказуемой форме', () => {
  const p = aiProfile.normalizeProfile({ name: 'X', skills: 'a, b', hourlyRate: '1500' });
  assert.deepEqual(p.skills, ['a', 'b']);
  assert.equal(p.hourlyRate, 1500);
  assert.equal(p.remoteOk, true);
  assert.deepEqual(p.redFlags, []);
});

test('profileToPrompt собирает текст для промпта', () => {
  const txt = aiProfile.profileToPrompt({ title: 'Разработчик', skills: ['JS'], minBudget: 20000 });
  assert.ok(txt.includes('Разработчик'));
  assert.ok(txt.includes('JS'));
  assert.ok(txt.includes('20000'));
});

/* --------------------------- провайдеры --------------------------------- */
test('discoverFromOpencode находит провайдеров с ключами', () => {
  const list = ai.discoverFromOpencode();
  assert.ok(Array.isArray(list));
  for (const p of list) {
    assert.ok(p.id.startsWith('oc:'));
    assert.ok(p.baseURL);
    assert.ok(p.apiKey);
  }
});

test('publicInfo не светит ключ целиком', () => {
  const p = ai.getProvider('oc:openrouter') || ai.listProviders()[0];
  if (!p) return;
  const info = ai.publicInfo(p);
  assert.equal(info.hasKey, true);
  assert.ok(!('apiKey' in info));
  assert.ok(info.keyHint.length <= 6);
});

test('resolveSecret понимает {env:VAR}', () => {
  process.env.__FH_TEST_KEY = 'sekret';
  assert.equal(ai.resolveSecret('{env:__FH_TEST_KEY}'), 'sekret');
  assert.equal(ai.resolveSecret('plain'), 'plain');
});

test('свой провайдер сохраняется и удаляется', () => {
  const created = ai.addCustom({
    name: 'Тестовый провайдер',
    baseURL: 'https://example.test/v1',
    apiKey: 'sk-test',
    model: 'test-model',
  });
  assert.ok(created.id);
  assert.ok(ai.getProvider(created.id));
  const info = ai.publicInfo(ai.getProvider(created.id));
  assert.equal(info.type, 'openai');
  assert.equal(info.model, 'test-model');
  ai.removeCustom(created.id);
  assert.equal(ai.getProvider(created.id), null);
});

test('callTool-совместимость: activeProvider не падает без настроек', () => {
  const p = aiProfile.activeProvider({});
  assert.ok(p === null || typeof p.id === 'string');
});

/* --------------------------- резюме ------------------------------------- */
test('parseResumeText чистит html', () => {
  const r = resume.parseResumeText('<p>Привет</p><p>Мир</p>');
  assert.ok(r.text.includes('Привет'));
  assert.ok(r.text.includes('Мир'));
  assert.ok(!r.text.includes('<'));
});

test('парсинг DOCX', () => {
  // собираем минимальный docx
  const zlib = require('zlib');
  const docXml = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Веб-разработчик</w:t></w:r></w:p></w:body></w:document>';
  const data = Buffer.from(docXml, 'utf8');
  const comp = zlib.deflateRawSync(data);
  const name = Buffer.from('word/document.xml', 'utf8');
  const crc = 0; // crc игнорируется парсером
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(local.length + name.length + comp.length, 16);
  eocd.writeUInt16LE(central.length + name.length, 20);
  const buf = Buffer.concat([local, name, comp, central, name, eocd]);
  const r = resume.parseResumeBuffer(buf, 'cv.docx');
  assert.ok(r.text.includes('Веб-разработчик'), r.text);
  assert.equal(r.kind, 'docx');
});

test('парсинг PDF с текстом (сгенерированный)', () => {
  const fixture = path.join(__dirname, 'fixtures', 'resume.pdf');
  if (!fs.existsSync(fixture)) return; // фикстура генерируется скриптом
  const r = resume.parseResumeFile(fixture);
  assert.ok(r.text.length > 50, 'текст слишком короткий');
});
