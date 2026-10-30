'use strict';
/**
 * Клиент alot.pro API (POST https://alot.pro/api/v2/, action-based).
 * Куки UID + S берутся из data/session.json или переменных окружения
 * ALOT_UID / ALOT_S. Без сессии доступны getProjects и getSitesInfo.
 */
const fs = require('fs');
const path = require('path');

const API_URL = 'https://alot.pro/api/v2/';
const DATA_DIR = path.join(__dirname, '..', 'data');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');

function loadSession() {
  if (process.env.ALOT_UID && process.env.ALOT_S) {
    return { uid: process.env.ALOT_UID, s: process.env.ALOT_S };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (raw.uid && raw.s) return { uid: String(raw.uid), s: String(raw.s) };
  } catch {}
  return null;
}

function saveSession(uid, s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ uid, s, updatedAt: Date.now() }, null, 2));
}

async function request(action, params = {}, session = loadSession()) {
  const body = JSON.stringify({ action, ...params });
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://alot.pro/projects/',
    'Origin': 'https://alot.pro',
  };
  if (session) headers['Cookie'] = `UID=${session.uid}; S=${session.s}`;

  const res = await fetch(API_URL, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`Alot API HTTP ${res.status}`);
  const data = await res.json();

  // responseCode: 0 — ок, 6/7 — сессия истекла, -1 — сеть
  if (data.responseCode !== undefined && data.responseCode !== 0 && data.responseCode !== 8) {
    const err = new Error(`Alot API responseCode=${data.responseCode} (${action})`);
    err.code = data.responseCode;
    err.action = action;
    throw err;
  }
  return data;
}

module.exports = { request, loadSession, saveSession, SESSION_FILE };
