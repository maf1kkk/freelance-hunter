'use strict';
/**
 * Telegram-мониторинг: выгрузка постов из каналов через tg_fetch.py (Telethon).
 * Каналы описаны в src/tg/channels.json.
 */
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const TG_DIR = __dirname;
// Python-интерпретатор Telethon: переопределяется переменной TG_PYTHON
const PYTHON = process.env.TG_PYTHON
  || findPython();
const FETCH_SCRIPT = path.join(TG_DIR, 'tg_fetch.py');
const CHANNELS_FILE = path.join(TG_DIR, 'channels.json');

/** Ищем python с установленным telethon: venv телеграм-mcp или системный */
function findPython() {
  const candidates = [];
  if (process.env.TG_MCP_DIR) candidates.push(path.join(process.env.TG_MCP_DIR, '.venv', 'Scripts', 'python.exe'));
  // типовые места установки telegram-mcp
  const home = process.env.USERPROFILE || '';
  candidates.push(
    path.join(home, 'mcp-servers', 'telegram-mcp', '.venv', 'Scripts', 'python.exe'),
    path.join(home, 'opencode', 'mcp-servers', 'telegram-mcp', '.venv', 'Scripts', 'python.exe'),
    path.join(home, '.telegram-mcp', '.venv', 'Scripts', 'python.exe'),
  );
  // соседние каталоги относительно самого проекта (…/hunter → …/mcp-servers/telegram-mcp)
  const projectRoot = path.resolve(__dirname, '..', '..', '..');
  candidates.push(
    path.join(projectRoot, 'mcp-servers', 'telegram-mcp', '.venv', 'Scripts', 'python.exe'),
    path.join(projectRoot, '..', 'mcp-servers', 'telegram-mcp', '.venv', 'Scripts', 'python.exe'),
  );
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return 'python'; // системный python
}

function loadChannels() {
  try {
    const raw = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
    return Array.isArray(raw.channels) ? raw.channels : [];
  } catch {
    return [];
  }
}

function saveChannels(channels) {
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify({ channels }, null, 2));
  return channels;
}

/** Добавить канал (id может быть @username или -100...) */
function addChannel(name, label, url) {
  const channels = loadChannels();
  if (channels.some((c) => c.name === name)) return { ok: false, error: 'канал уже есть' };
  const clean = String(name).replace(/^@/, '');
  channels.push({
    name: clean,
    label: label || clean,
    url: url || `https://t.me/${clean}`,
  });
  saveChannels(channels);
  return { ok: true, channel: channels[channels.length - 1] };
}

function removeChannel(name) {
  const channels = loadChannels();
  const next = channels.filter((c) => c.name !== name && c.name !== String(name).replace(/^@/, ''));
  if (next.length === channels.length) return { ok: false, error: 'канал не найден' };
  saveChannels(next);
  return { ok: true, removed: name };
}

/**
 * Выгрузить посты одного канала. Возвращает массив {id, date, text, sender, views}
 */
function fetchChannel(channel, limit = 50, retries = 2) {
  return runFetch([channel], limit, retries).then((r) => (r[channel] || []));
}

/**
 * Выгрузить посты всех каналов ОДНИМ запуском python (одна сессия Telethon).
 * @param {string[]} channels
 * @returns {Promise<Object<string, Array>>} {канал: посты}
 */
function runFetch(channels, limit = 50, retries = 1) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      execFile(PYTHON, [FETCH_SCRIPT, ...channels, String(limit)],
        { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 120000 },
        (err, stdout, stderr) => {
          if (err) {
            let detail = String(stderr || err.message || '').trim();
            try {
              const j = JSON.parse(detail);
              detail = j.error || detail;
              if (j.hints) detail += ` (искали .env: ${j.hints.slice(0, 3).join(', ')})`;
            } catch { /* не JSON — оставляем как есть */ }
            if (left > 0) return setTimeout(() => attempt(left - 1), 15000);
            return reject(new Error(`tg_fetch: ${String(detail).slice(0, 200)}`));
          }
          try {
            const data = JSON.parse(stdout);
            resolve(data && !Array.isArray(data) ? data : { [channels[0]]: data });
          } catch {
            reject(new Error(`tg_fetch: невалидный JSON (${String(stdout).slice(0, 80)})`));
          }
        });
    };
    attempt(retries);
  });
}

/**
 * Опросить все каналы. Возвращает посты с метаданными канала.
 * onlyNew + lastSeen: { channelName: lastId } — возвращает только новые посты.
 */
async function fetchAllChannels({ limit = 30, lastSeen = {} } = {}) {
  const channels = loadChannels();
  if (!channels.length) return [];

  const names = channels.map((c) => c.name);
  let byChannel = {};
  try {
    byChannel = await runFetch(names, limit);
  } catch (e) {
    // общий сбой: не лезем повторно по каждому каналу (это лишние подключения к Telegram API)
    for (const name of names) byChannel[name] = { error: String(e.message || e).slice(0, 160) };
    return Object.entries(byChannel).map(([channel, v]) => ({ channel, error: v.error }));
  }

  const results = [];
  for (const ch of channels) {
    const raw = byChannel[ch.name];
    if (raw && raw.error) { results.push({ channel: ch.name, error: raw.error }); continue; }
    const posts = Array.isArray(raw) ? raw : [];
    const seen = lastSeen[ch.name] || 0;
    for (const p of posts) {
      if (p.id <= seen) continue; // только новые
      results.push({
        ...p,
        channel: ch.name,
        channelLabel: ch.label,
        channelUrl: ch.url,
      });
    }
  }
  return results;
}

module.exports = { loadChannels, saveChannels, addChannel, removeChannel, fetchChannel, fetchAllChannels, CHANNELS_FILE, PYTHON };
