'use strict';
/**
 * Мини-парсер HTML без внешних зависимостей.
 * Достаточно для разбора карточек бирж, но не является полноценным DOM.
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  times: '×', deg: '°', rub: '₽', dollar: '$', euro: '€', bull: '•', middot: '·',
  laquo_ru: '«', copy: '©', reg: '®', trade: '™', shy: '', ensp: ' ', emsp: ' ', thinsp: ' ',
};

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => (ENTITIES[name] !== undefined ? ENTITIES[name] : m));
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

function toText(html) {
  return collapse(decodeEntities(stripTags(html)));
}

function collapse(s) {
  return String(s || '').replace(/[ \t\r\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Все совпадения регулярки, только первая группа */
function pickAll(html, re) {
  const out = [];
  const rx = re instanceof RegExp ? new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g') : re;
  let m;
  while ((m = rx.exec(html)) !== null) {
    out.push(m.length > 1 ? m[1] : m[0]);
    if (m.index === rx.lastIndex) rx.lastIndex++;
  }
  return out;
}

function pick(html, re) {
  const m = String(html || '').match(re);
  return m ? (m.length > 1 ? m[1] : m[0]) : null;
}

function between(html, startRe, endRe) {
  const s = String(html || '').match(startRe);
  if (!s) return null;
  const from = s.index + s[0].length;
  const rest = html.slice(from);
  const e = rest.match(endRe);
  return e ? rest.slice(0, e.index) : rest.slice(0, 5000);
}

function attr(html, name) {
  const m = String(html || '').match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? decodeEntities(m[1]) : null;
}

/**
 * Разбивает HTML на «карточки» по повторяющемуся признаку.
 * Ищет все вхождения маркера и режет HTML на куски от одного маркера до следующего.
 * @param {string} html
 * @param {RegExp} marker — регексп с группой-идентификатором карточки
 */
function sliceByMarker(html, marker) {
  const src = String(html || '');
  const hits = [];
  const rx = new RegExp(marker.source, marker.flags.includes('g') ? marker.flags : marker.flags + 'g');
  let m;
  while ((m = rx.exec(src)) !== null) {
    hits.push({ index: m.index, key: m[1] || m[0] });
    if (m.index === rx.lastIndex) rx.lastIndex++;
  }
  const out = [];
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].index;
    const end = i + 1 < hits.length ? hits[i + 1].index : src.length;
    out.push({ key: hits[i].key, html: src.slice(start, end) });
  }
  return out;
}

/** Извлекает JSON из встроенного <script type="application/json"> или window.__X__ */
function extractJson(html, varName) {
  if (varName) {
    const m = String(html || '').match(new RegExp(`${varName}\\s*=\\s*(\\{[\\s\\S]*?\\});`, 'm'));
    if (m) { try { return JSON.parse(m[1]); } catch {} }
  }
  const m2 = String(html || '').match(/<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (m2) { try { return JSON.parse(decodeEntities(m2[1])); } catch {} }
  return null;
}

/** Достаёт JSON из присваивания вида window.VAR = {...} / var VAR = {...} */
function extractVarJson(html, varName) {
  const src = String(html || '');
  const re = new RegExp(`(?:window\\.)?\\b${varName}\\s*=\\s*`, 'm');
  const m = src.match(re);
  if (!m) return null;
  const from = m.index + m[0].length;
  const first = src[from];
  if (first !== '{' && first !== '[') return null;
  let depth = 0, inStr = false, esc = false;
  for (let p = from; p < src.length; p++) {
    const c = src[p];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(src.slice(from, p + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** Достаёт JSON по ключу вида "key": {...} (внутри большого объекта) */
function extractKeyJson(html, key) {
  const src = String(html || '');
  const m = src.match(new RegExp(`"${key}"\\s*:\\s*`));
  if (!m) return null;
  const from = m.index + m[0].length;
  const first = src[from];
  if (first !== '{' && first !== '[') return null;
  let depth = 0, inStr = false, esc = false;
  for (let p = from; p < src.length; p++) {
    const c = src[p];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(src.slice(from, p + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** Число из строки вида "7 000 ₽" / "от 5 000 до 10 000" */
function parseMoney(text) {
  if (!text) return null;
  const t = String(text).replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const ranges = [...t.matchAll(/(\d[\d\s\u00a0]*)\s*(?:|-|–|—|до|to)?\s*(\d[\d\s\u00a0]*)/g)];
  const nums = ranges.map((m) => Number(m[1].replace(/[^\d]/g, ''))).filter((n) => Number.isFinite(n) && n > 0);
  const all = [...t.matchAll(/\d[\d\s\u00a0]*/g)]
    .map((m) => Number(m[0].replace(/[^\d]/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);
  const list = all.length ? all : nums;
  if (!list.length) return null;
  const cur = /[$€]|usd|\$/i.test(t) ? 'USD' : /€|eur/i.test(t) ? 'EUR' : 'RUB';
  return { min: Math.min(...list), max: Math.max(...list), currency: cur, text: t };
}

module.exports = {
  decodeEntities, stripTags, toText, collapse,
  pickAll, pick, between, attr, sliceByMarker, extractJson, extractVarJson, extractKeyJson, parseMoney,
};
