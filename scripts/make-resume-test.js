'use strict';
/* создание тестовых файлов резюме: PDF (через playwright) и DOCX (zip) */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'output', 'resume-test');
fs.mkdirSync(OUT, { recursive: true });

const RESUME = `
<h1>Максим Устименко</h1>
<p>Веб-разработчик / автоматизация. Опыт 6 лет.</p>
<h2>Навыки</h2>
<p>JavaScript, TypeScript, Python, Node.js, React, вёрстка, Telegram-боты, парсинг, интеграции API, WordPress, Tilda, автоматизация, PostgreSQL, Docker.</p>
<h2>Опыт</h2>
<p>2021–2026 — фриланс и разработка: сайты под ключ, лендинги, Telegram-боты для бизнеса, интеграции CRM (Bitrix24, amoCRM), парсеры для маркетплейсов.</p>
<p>Ставка 1500 ₽/час. Готов брать заказы от 20 000 ₽. Не интересуют вакансии без чёткого ТЗ.</p>
<h2>Контакты</h2>
<p>max@example.com, telegram @maxexample</p>
`;

// ---- PDF через playwright
(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(`<html><body style="font-family:Arial;padding:40px">${RESUME}</body></html>`);
  await page.pdf({ path: path.join(OUT, 'resume.pdf'), format: 'A4' });
  await browser.close();

  // ---- DOCX (минимальный zip с word/document.xml)
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Максим Устименко</w:t></w:r></w:p>
<w:p><w:r><w:t>Веб-разработчик / автоматизация. Опыт 6 лет.</w:t></w:r></w:p>
<w:p><w:r><w:t>Навыки: JavaScript, TypeScript, Python, Node.js, React, Telegram-боты, парсинг, WordPress, Docker.</w:t></w:r></w:p>
<w:p><w:r><w:t>Опыт: сайты под ключ, лендинги, интеграции CRM, парсеры для маркетплейсов. Ставка 1500 ₽/час.</w:t></w:r></w:p>
</w:body></w:document>`;

  function crc32(buf) {
    let c, crc = 0xFFFFFFFF;
    for (let n = 0; n < buf.length; n++) {
      c = (crc ^ buf[n]) & 0xFF;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crc = c ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function zipEntry(name, content) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x2100, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x2100, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38);
    central.writeUInt32LE(0, 42);
    return { local: Buffer.concat([local, nameBuf, comp]), central: Buffer.concat([central, nameBuf]), comp: comp.length, size: data.length };
  }
  const e = zipEntry('word/document.xml', docXml);
  const cdOffset = e.local.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(e.comp, 12); eocd.writeUInt32LE(e.size, 16);
  eocd.writeUInt16LE(e.central.length, 20);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  fs.writeFileSync(path.join(OUT, 'resume.docx'), Buffer.concat([e.local, e.central, eocd]));
  fs.writeFileSync(path.join(OUT, 'resume.txt'), RESUME.replace(/<[^>]+>/g, '\n').replace(/\n{2,}/g, '\n'));

  console.log('создано в', OUT);
})();
