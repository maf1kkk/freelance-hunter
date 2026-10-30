'use strict';
/**
 * Генератор карточек товаров для WB/Озон/Авито.
 * ИИ передаёт данные товара → рендерим HTML-шаблон → Playwright → PNG.
 *
 * Использование через MCP: generate_product_cards
 * CLI: node src/cards.js '{"title":"...","bullets":[...]}'
 */
const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const OUTPUT_DIR = path.join(__dirname, '..', 'output', 'cards');

const SIZES = {
  wb: { width: 900, height: 1200 },
  ozon: { width: 1080, height: 1350 },
  avito: { width: 1000, height: 1000 },
};

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Строит HTML карточки. style: minimal | bold | gradient */
function buildHtml(data, size, style = 'gradient') {
  const { width, height } = SIZES[size] || SIZES.wb;
  const bullets = (data.bullets || []).slice(0, 5)
    .map((b) => `<li>${esc(b)}</li>`).join('');
  const badge = data.badge ? `<div class="badge">${esc(data.badge)}</div>` : '';
  const price = data.price ? `<div class="price">${esc(data.price)}</div>` : '';
  const photo = data.photoPath
    ? `<img class="photo" src="file:///${String(data.photoPath).replace(/\\/g, '/')}" alt="">`
    : `<div class="photo placeholder">${esc(data.title || '').slice(0, 1)}</div>`;

  const styles = {
    minimal: `
      .card { background:#fff; color:#111; font-family:'Segoe UI',Arial,sans-serif; }
      .title { font-size:44px; font-weight:700; }
      ul { border-left:4px solid #111; }
      .price { color:#111; background:#f2f2f2; padding:8px 20px; border-radius:8px; }
      .badge { background:#111; color:#fff; }`,
    bold: `
      .card { background:#111; color:#fff; font-family:'Segoe UI',Arial,sans-serif; }
      .title { font-size:48px; font-weight:900; color:#ffd524; }
      ul { border-left:4px solid #ffd524; }
      .price { color:#111; background:#ffd524; padding:8px 20px; border-radius:8px; font-weight:800; }
      .badge { background:#ffd524; color:#111; font-weight:800; }`,
    gradient: `
      .card { background:linear-gradient(135deg,#667eea 0%,#764ba2 100%); color:#fff; font-family:'Segoe UI',Arial,sans-serif; }
      .title { font-size:46px; font-weight:800; text-shadow:0 2px 8px rgba(0,0,0,.3); }
      ul { border-left:4px solid rgba(255,255,255,.7); }
      .price { color:#333; background:#ffd524; padding:8px 20px; border-radius:8px; font-weight:800; }
      .badge { background:#ff5252; color:#fff; font-weight:700; }`,
  };

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${width}px; height:${height}px; }
  ${styles[style] || styles.gradient}
  .card {
    width:${width}px; height:${height}px;
    padding:48px; display:flex; flex-direction:column;
  }
  .top { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:24px; }
  .badge { padding:8px 18px; border-radius:999px; font-size:24px; }
  .photo {
    width:100%; height:46%; object-fit:cover; border-radius:20px;
    display:flex; align-items:center; justify-content:center;
    font-size:180px; font-weight:900; opacity:.5;
  }
  .photo.placeholder { background:rgba(255,255,255,.25); }
  .title { margin:28px 0 18px; line-height:1.15; }
  ul { list-style:none; font-size:28px; line-height:1.5; }
  ul li { padding-left:34px; position:relative; margin-bottom:10px; }
  ul li::before { content:'✔'; position:absolute; left:0; }
  .bottom { margin-top:auto; display:flex; align-items:center; justify-content:space-between; }
  .price { font-size:36px; }
</style></head>
<body><div class="card">
  <div class="top">${badge}<span></span></div>
  ${photo}
  <h1 class="title">${esc(data.title || '')}</h1>
  <ul>${bullets}</ul>
  <div class="bottom"><span></span>${price}</div>
</div></body></html>`;
}

/**
 * Рендер карточки в PNG.
 * @param {object} data { title, bullets[], badge?, price?, photoPath?, style? }
 * @param {string} size 'wb'|'ozon'|'avito'
 * @param {string} outName имя файла без расширения
 * @returns {string} путь к PNG
 */
async function renderCard(data, size = 'wb', outName) {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { throw new Error('playwright не установлен: npm install в D:\\opencode\\hunter'); }

  const html = buildHtml(data, size, data.style);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, `${outName || 'card'}-${size}-${Date.now()}.png`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: SIZES[size] });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.screenshot({ path: outPath, clip: { x: 0, y: 0, ...SIZES[size] } });
  await browser.close();
  return outPath;
}

/** Батч: массив товаров → массив путей PNG */
async function renderBatch(items, size = 'wb', baseName = 'card') {
  const results = [];
  for (let i = 0; i < items.length; i++) {
    results.push(await renderCard(items[i], size, `${baseName}-${i + 1}`));
  }
  return results;
}

module.exports = { buildHtml, renderCard, renderBatch, SIZES, OUTPUT_DIR };

// CLI: node src/cards.js test_card.json wb
if (require.main === module) {
  const arg = process.argv[2];
  let raw = arg || '{"title":"Тестовая карточка","bullets":["Пункт 1","Пункт 2"]}';
  if (arg && fs.existsSync(arg)) raw = fs.readFileSync(arg, 'utf8').replace(/^\uFEFF/, '');
  const data = JSON.parse(raw);
  renderCard(data, process.argv[3] || 'wb', 'test')
    .then((p) => console.log('OK:', p))
    .catch((e) => { console.error('ERR:', e.message); process.exit(1); });
}
