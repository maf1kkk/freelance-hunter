'use strict';
/**
 * Парсер RSS 2.0 и Atom без XML-библиотеки.
 * Достаточно для job-фидов (WWR, RSS-агрегаторы) и Telegram-каналов через RSS-мосты.
 */
const { decodeEntities, stripTags, collapse } = require('./html');

function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i');
  const m = block.match(re);
  if (!m) return '';
  let v = m[1];
  // CDATA
  const cd = v.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cd) v = cd[1];
  return decodeEntities(v).trim();
}

function attrOf(block, tagName, attrName) {
  const re = new RegExp(`<${tagName}[^>]*\\b${attrName}\\s*=\\s*["']([^"']*)["']`, 'i');
  const m = block.match(re);
  return m ? decodeEntities(m[1]) : '';
}

/**
 * @param {string} xml
 * @returns {Array<{title,link,description,content,pubDate,guid,categories:[],author,extra:{}}>}
 */
function parse(xml) {
  const src = String(xml || '');
  const blocks = [
    ...src.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...src.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ];
  const out = [];
  for (const m of blocks) {
    const b = m[1];
    let link = tag(b, 'link');
    if (!link) link = attrOf(b, 'link', 'href');
    if (!link) {
      const alt = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
      if (alt) link = decodeEntities(alt[1]);
    }
    const cats = [...b.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)]
      .map((x) => decodeEntities(x[1]).replace(/<!\[CDATA\[|\]\]>/g, '').trim())
      .filter(Boolean);

    // дополнительные теги (регион, навыки, тип) — нестандартные поля
    const extra = {};
    for (const em of b.matchAll(/<([a-zA-Z][\w:-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
      const name = em[1].toLowerCase();
      if (['title', 'link', 'description', 'guid', 'pubdate', 'category', 'content', 'author', 'dc:creator', 'encoded', 'enclosure'].includes(name)) continue;
      const v = decodeEntities(em[2].replace(/<!\[CDATA\[|\]\]>/g, '')).trim();
      if (v && v.length < 500) extra[name] = v;
    }

    out.push({
      title: collapse(stripTags(tag(b, 'title'))),
      link: link.trim(),
      description: collapse(stripTags(tag(b, 'description'))),
      content: collapse(stripTags(tag(b, 'content:encoded') || tag(b, 'content'))),
      pubDate: tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated'),
      guid: tag(b, 'guid') || tag(b, 'id'),
      categories: cats,
      author: tag(b, 'author') || tag(b, 'dc:creator'),
      extra,
    });
  }
  return out;
}

function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isFinite(t)) return t;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

module.exports = { parse, parseDate, tag };
