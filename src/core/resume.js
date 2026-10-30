'use strict';
/**
 * Извлечение текста из файлов резюме без внешних зависимостей.
 * Поддерживаются: TXT / MD / HTML / DOCX / PDF (текстовый).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ------------------------------- TXT ----------------------------------- */

function fromPlain(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------ DOCX ----------------------------------- */

/** Чтение одного файла из zip-архива */
function zipRead(buf, wanted) {
  // ищем End of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: не найден EOCD');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    if (name === wanted) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return raw;
      if (method === 8) return zlib.inflateRawSync(raw);
      throw new Error(`zip: неподдерживаемый метод сжатия ${method}`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function fromDocx(buf) {
  const xmlBuf = zipRead(buf, 'word/document.xml');
  if (!xmlBuf) throw new Error('docx: нет word/document.xml');
  const xml = xmlBuf.toString('utf8');
  return fromPlain(xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, ''));
}

/* ------------------------------- PDF ------------------------------------ */

/** Распаковка потока PDF (FlateDecode) */
function inflateStream(data) {
  for (const fn of [zlib.inflateSync, zlib.inflateRawSync, zlib.gunzipSync]) {
    try { return fn(data); } catch { /* следующий вариант */ }
  }
  return null;
}

/** Декодирование строки PDF: (...) или <hex> */
function decodePdfString(raw, isHex) {
  if (isHex) {
    const hex = raw.replace(/[^0-9a-fA-F]/g, '');
    let out = '';
    for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const n = raw[++i];
    switch (n) {
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case '(': out += '('; break;
      case ')': out += ')'; break;
      case '\\': out += '\\'; break;
      case '\n': break;
      default:
        if (n >= '0' && n <= '7') {
          let oct = n;
          while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
          out += String.fromCharCode(parseInt(oct, 8));
        } else out += n;
    }
  }
  return out;
}

/** Текст из одного content-stream */
function pdfStreamToText(s, maps) {
  const text = s.toString('latin1');
  const parts = [];
  const re = /\((?:\\.|[^\\()])*\)|<[0-9a-fA-F\s]+>|\bTJ\b|\bTj\b|\bTd\b|\bTD\b|\bT\*\b|\bET\b|\bBT\b|'|"/g;
  let m;
  let line = [];
  while ((m = re.exec(text)) !== null) {
    const tok = m[0];
    if (tok.startsWith('(')) { line.push(decodePdfString(tok.slice(1, -1), false)); }
    else if (tok.startsWith('<')) {
      const hex = tok.slice(1, -1).replace(/\s+/g, '');
      const bytes = [];
      for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
      line.push(decodeCids(bytes, maps));
    } else if (tok === 'Td' || tok === 'TD' || tok === 'T*' || tok === 'ET') {
      if (line.length) { parts.push(line.join('')); line = []; }
    }
  }
  if (line.length) parts.push(line.join(''));
  return parts.join('\n');
}

/** Декодирование CID-последовательности через ToUnicode-карты */
function decodeCids(bytes, maps) {
  if (!maps || (!maps.wide.size && !maps.narrow.size)) return '';
  if (bytes.length % 2 === 0 && maps.wide.size) {
    let hit = 0;
    let out = '';
    for (let i = 0; i < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      const u = maps.wide.get(code);
      if (u !== undefined) { hit++; out += u; } else out += '�';
    }
    if (hit >= bytes.length / 2 * 0.6) return out;
  }
  let out = '';
  for (const b of bytes) {
    const u = maps.narrow.get(b);
    out += u !== undefined ? u : String.fromCharCode(b);
  }
  return out;
}

/** Разбор ToUnicode CMap: bfchar / bfrange */
function parseCMap(buf) {
  const s = buf.toString('latin1');
  const wide = new Map();
  const narrow = new Map();

  const hexToStr = (hex) => {
    const clean = hex.replace(/[^0-9a-fA-F]/g, '');
    let out = '';
    for (let i = 0; i + 3 < clean.length + 1; i += 4) {
      const code = parseInt(clean.slice(i, i + 4), 16);
      if (Number.isFinite(code)) out += String.fromCharCode(code);
    }
    return out;
  };
  const hexToNum = (hex) => parseInt(hex.replace(/[^0-9a-fA-F]/g, ''), 16);

  for (const m of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      const src = hexToNum(p[1]);
      const dst = hexToStr(p[2]);
      if (p[1].length > 2) wide.set(src, dst); else narrow.set(src, dst);
    }
  }
  for (const m of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g)) {
      const lo = hexToNum(p[1]);
      const hi = hexToNum(p[2]);
      const wideFlag = p[1].length > 2;
      if (p[3] !== undefined) {
        const base = hexToNum(p[3]);
        for (let c = lo; c <= hi && c - lo < 65535; c++) {
          const dst = String.fromCharCode(base + (c - lo));
          if (wideFlag) wide.set(c, dst); else narrow.set(c, dst);
        }
      } else if (p[4]) {
        const items = [...p[4].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => hexToStr(x[1]));
        items.forEach((dst, i) => {
          const c = lo + i;
          if (wideFlag) wide.set(c, dst); else narrow.set(c, dst);
        });
      }
    }
  }
  return { wide, narrow };
}

/** Разбор объектов PDF: номер → тело */
function pdfObjects(latin) {
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(latin)) !== null) {
    const num = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const end = latin.indexOf('endobj', bodyStart);
    objs.set(num, { start: bodyStart, end: end < 0 ? latin.length : end, body: latin.slice(bodyStart, end < 0 ? latin.length : end) });
    re.lastIndex = end < 0 ? latin.length : end;
  }
  return objs;
}

/** Достаёт распакованное содержимое stream-части объекта */
function objectStream(obj, buf) {
  const s = obj.body;
  const si = s.indexOf('stream');
  if (si < 0) return null;
  const dict = s.slice(0, si);
  let dataStart = obj.start + si + 'stream'.length;
  // buf[i] — это байт (число), а не символ
  while (dataStart < obj.end && (buf[dataStart] === 13 || buf[dataStart] === 10)) dataStart++;
  const ei = s.indexOf('endstream');
  if (ei < 0) return null;
  let end = obj.start + ei;
  while (end > dataStart && (buf[end - 1] === 10 || buf[end - 1] === 13)) end--;
  let data = buf.subarray(dataStart, end);
  if (/\/FlateDecode/.test(dict)) {
    const inflated = inflateStream(data);
    if (!inflated) return null;
    data = inflated;
  }
  return data;
}

function fromPdf(buf) {
  const latin = buf.toString('latin1');
  const objs = pdfObjects(latin);

  // собираем карты ToUnicode
  const maps = { wide: new Map(), narrow: new Map() };
  for (const [, obj] of objs) {
    const tm = obj.body.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    if (!tm) continue;
    const target = objs.get(Number(tm[1]));
    if (!target) continue;
    const data = objectStream(target, buf);
    if (!data) continue;
    const cm = parseCMap(data);
    for (const [k, v] of cm.wide) maps.wide.set(k, v);
    for (const [k, v] of cm.narrow) maps.narrow.set(k, v);
  }

  const chunks = [];
  for (const [, obj] of objs) {
    if (!/\bstream\b/.test(obj.body)) continue;
    const data = objectStream(obj, buf);
    if (!data) continue;
    const s = data.toString('latin1');
    if (!/(?:Tj|TJ)/.test(s)) continue;
    const t = pdfStreamToText(data, maps);
    if (t && t.trim()) chunks.push(t);
  }

  let text = chunks.join('\n');
  // склеиваем разорванные переносами слова («авто\nматизация» → «автоматизация»)
  text = text.replace(/(\p{L})[ \t]*\n[ \t]*(?=\p{Ll})/gu, '$1');
  text = text.replace(/\n{3,}/g, '\n\n');
  // убираем непечатаемые символы (кроме переводов строк)
  text = text.replace(/[^\S\n]/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
  return text;}

/* ---------------------------- публичный API ----------------------------- */

const KINDS = {
  '.txt': 'txt', '.md': 'txt', '.rtf': 'txt', '.log': 'txt',
  '.html': 'html', '.htm': 'html',
  '.docx': 'docx', '.doc': 'docx',
  '.pdf': 'pdf',
};

/**
 * @param {string} filePath
 * @returns {{text, kind, bytes, name}}
 */
function parseResumeFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return parseResumeBuffer(buf, path.basename(filePath));
}

/** Разбор уже загруженного файла (Buffer) */
function parseResumeBuffer(buf, name = 'resume') {
  const ext = path.extname(String(name || 'resume')).toLowerCase();
  const kind = KINDS[ext] || 'txt';
  let text = '';
  if (kind === 'pdf') text = fromPdf(buf);
  else if (kind === 'docx') text = fromDocx(buf);
  else text = fromPlain(buf.toString('utf8'));
  return { text: text.trim(), kind, bytes: buf.length, name };
}

/** Резюме из сырого текста (вставленного в UI) */
function parseResumeText(text) {
  return { text: fromPlain(String(text || '')), kind: 'txt', bytes: (text || '').length, name: 'вставленный текст' };
}

module.exports = { parseResumeFile, parseResumeBuffer, parseResumeText, fromPdf, fromDocx, fromPlain, zipRead };
