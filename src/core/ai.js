'use strict';
/**
 * Универсальный ИИ-провайдер: работает с любым OpenAI-совместимым (и не только) эндпоинтом.
 *
 * Источники провайдеров:
 *   1) свои — data/ai-providers.json (любой baseURL/ключ/модель, формат openai | anthropic | ollama)
 *   2) из конфига opencode — читаются read-only: baseURL + apiKey + список моделей
 *
 * Поддерживаемые протоколы:
 *   openai     — POST {baseURL}/chat/completions      (OpenAI, DeepSeek, GLM/Z.AI, Groq, OpenRouter,
 *                                                   Moonshot, Together, Ollama, LM Studio, vLLM, ...)
 *   anthropic  — POST {baseURL}/messages              (Claude)
 */
const fs = require('fs');
const path = require('path');
const http = require('./http');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CUSTOM_FILE = path.join(DATA_DIR, 'ai-providers.json');

const OPENCODE_CONFIGS = [
  path.join(process.env.USERPROFILE || '', '.config', 'opencode', 'opencode.json'),
  'D:/opencode/config/opencode.json',
  'D:/opencode/opencode.json',
];

/* --------------------------- хранилище ---------------------------------- */

function loadCustom() {
  try {
    const raw = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.providers || []);
  } catch { return []; }
}

function saveCustom(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CUSTOM_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ providers: list }, null, 2));
  fs.renameSync(tmp, CUSTOM_FILE);
  return list;
}

/* --------------------------- discovery ---------------------------------- */

/** Провайдеры из конфигов opencode (ключи не копируются — читаются на лету) */
function discoverFromOpencode() {
  const out = [];
  const seen = new Set();
  for (const cfg of OPENCODE_CONFIGS) {
    let j;
    try { j = JSON.parse(fs.readFileSync(cfg, 'utf8')); } catch { continue; }
    for (const [name, p] of Object.entries(j.provider || {})) {
      const opts = p.options || {};
      if (!opts.baseURL || !opts.apiKey) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      const models = Object.keys(p.models || {});
      out.push({
        id: `oc:${name}`,
        name: p.name || name,
        group: name,
        type: 'openai',
        baseURL: opts.baseURL,
        apiKey: opts.apiKey,
        models,
        model: models[0] || null,
        source: 'opencode',
        configFile: cfg,
      });
    }
  }
  return out;
}

/** Все провайдеры: свои + из opencode */
function listProviders() {
  const custom = loadCustom().map((p) => ({ ...p, source: p.source || 'custom' }));
  return [...custom, ...discoverFromOpencode()];
}

function getProvider(id) {
  return listProviders().find((p) => p.id === id) || null;
}

function addCustom(p) {
  const list = loadCustom();
  const id = p.id || `custom:${String(p.name || 'provider').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const item = {
    id,
    name: p.name || id,
    type: p.type || 'openai',
    baseURL: p.baseURL,
    apiKey: p.apiKey || '',
    models: p.models || (p.model ? [p.model] : []),
    model: p.model || (p.models || [])[0] || null,
    headers: p.headers || {},
    source: 'custom',
  };
  const idx = list.findIndex((x) => x.id === id);
  if (idx >= 0) list[idx] = item; else list.push(item);
  saveCustom(list);
  return item;
}

function removeCustom(id) {
  const list = loadCustom().filter((p) => p.id !== id);
  saveCustom(list);
  return list;
}

/** Разрешает {env:VAR} в значении */
function resolveSecret(v) {
  if (typeof v !== 'string') return v;
  const m = v.match(/^\{env:(.+)\}$/);
  if (m) return process.env[m[1]] || '';
  return v;
}

/* ----------------------------- запросы ---------------------------------- */

/**
 * Единый вызов LLM.
 * @param {object} provider
 * @param {Array} messages — [{role, content}]
 * @param {object} opts { model, temperature, maxTokens, json, timeout, system }
 * @returns {Promise<{text, raw, usage, model, provider}>}
 */
async function chat(provider, messages, opts = {}) {
  if (!provider) throw new Error('не выбран ИИ-провайдер');
  const type = provider.type || 'openai';
  const model = opts.model || provider.model;
  if (!model) throw new Error('не указана модель');
  const apiKey = resolveSecret(provider.apiKey);
  const baseURL = String(provider.baseURL || '').replace(/\/+$/, '');
  const temperature = opts.temperature ?? 0.3;
  const maxTokens = opts.maxTokens ?? 2000;
  const timeout = opts.timeout ?? 120000;

  let url; let body; let headers = { 'Content-Type': 'application/json', ...(provider.headers || {}) };

  if (type === 'anthropic') {
    url = `${baseURL}/messages`;
    const sys = opts.system || messages.find((m) => m.role === 'system')?.content;
    const msgs = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
    body = { model, max_tokens: maxTokens, temperature, messages: msgs };
    if (sys) body.system = sys;
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';
  } else {
    url = `${baseURL}/chat/completions`;
    const msgs = [];
    if (opts.system) msgs.push({ role: 'system', content: opts.system });
    msgs.push(...messages);
    body = { model, temperature, max_tokens: maxTokens, messages: msgs };
    if (opts.json) body.response_format = { type: 'json_object' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await http.request(url, {
    method: 'POST', headers, body: JSON.stringify(body), timeout, retries: 1,
  });
  if (!res.ok) {
    let detail = res.text.slice(0, 300);
    try {
      const j = JSON.parse(res.text);
      detail = j.error?.message || j.error?.code || j.message || detail;
    } catch { /* не JSON */ }
    throw new Error(`${provider.name || provider.id}: HTTP ${res.status} — ${detail}`);
  }

  const data = JSON.parse(res.text);
  let text = '';
  if (type === 'anthropic') {
    text = (data.content || []).map((c) => c.text || '').join('');
  } else {
    const msg = data.choices?.[0]?.message;
    text = msg?.content ?? '';
    if (Array.isArray(msg?.content)) text = msg.content.map((c) => c.text || '').join('');
    if (!text) text = msg?.reasoning_content || msg?.reasoning || '';
  }
  return {
    text: String(text || '').trim(),
    raw: data,
    usage: data.usage || null,
    model: data.model || model,
    provider: provider.id,
  };
}

/** Проверка связи с провайдером */
async function testProvider(id) {
  const p = getProvider(id);
  if (!p) return { ok: false, error: `провайдер ${id} не найден` };
  const t0 = Date.now();
  try {
    const r = await chat(p, [{ role: 'user', content: 'Ответь одним словом: тест' }], { maxTokens: 300, timeout: 45000 });
    return { ok: true, ms: Date.now() - t0, model: r.model, reply: r.text.slice(0, 120) };
  } catch (e) {
    return { ok: false, error: String(e.message || e), ms: Date.now() - t0 };
  }
}

/* --------------------------- список моделей ----------------------------- */

/** Модели провайдера: из конфига или запросом /models */
async function listModels(id) {
  const p = getProvider(id);
  if (!p) return [];
  if (p.models && p.models.length) return p.models;
  try {
    const apiKey = resolveSecret(p.apiKey);
    const res = await http.request(`${String(p.baseURL).replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, ...(p.headers || {}) }, timeout: 20000, retries: 0,
    });
    if (!res.ok) return [];
    const d = JSON.parse(res.text);
    return (d.data || d.models || []).map((m) => m.id || m.name).filter(Boolean);
  } catch { return []; }
}

/** Публичное описание провайдера (без ключей) */
function publicInfo(p) {
  return {
    id: p.id,
    name: p.name,
    group: p.group || null,
    type: p.type || 'openai',
    baseURL: p.baseURL,
    models: (p.models || []).slice(0, 40),
    model: p.model || null,
    source: p.source,
    hasKey: Boolean(p.apiKey),
    keyHint: p.apiKey ? String(resolveSecret(p.apiKey)).slice(-6) : null,
  };
}

module.exports = {
  listProviders, getProvider, addCustom, removeCustom, loadCustom, saveCustom,
  discoverFromOpencode, chat, testProvider, listModels, publicInfo, resolveSecret,
  CUSTOM_FILE,
};
