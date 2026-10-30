'use strict';
/**
 * Схема настроек пользователя + валидация/приведение типов + миграция со старой версии.
 *
 * Все настройки хранятся в data/store.json → settings.
 * Группы: search, quality, poll, notify, apply, profile, ui.
 */

const SCHEMA = {
  search: {
    keywordsPlus: { type: 'string[]', default: [], title: 'Плюс-слова' },
    keywordsMinus: { type: 'string[]', default: [], title: 'Минус-слова' },
    keywordGroups: {
      type: 'object[]', default: [], title: 'Группы ключевых слов',
      fields: {
        name: { type: 'string', default: '' },
        words: { type: 'string[]', default: [] },
        weight: { type: 'number', default: 5 },
        required: { type: 'bool', default: false },
      },
    },
    sites: { type: 'string[]', default: [], title: 'Биржи (пусто = все)' },
    priceMin: { type: 'number|null', default: null },
    priceMax: { type: 'number|null', default: null },
    minVerdict: { type: 'enum', values: ['prime', 'good', 'meh', 'bad'], default: 'meh' },
    onlyNew: { type: 'bool', default: false },
  },
  quality: {
    minClientRating: { type: 'number', default: 0, min: 0, max: 100 },
    maxClientRating: { type: 'number', default: 100, min: 1, max: 100 },
    minClientReviews: { type: 'number', default: 0, min: 0 },
    minClientOrders: { type: 'number', default: 0, min: 0 },
    maxResponses: { type: 'number', default: 50, min: 1 },
    idealResponses: { type: 'number', default: 8, min: 0 },
    minSalaryPerHour: { type: 'number|null', default: null, min: 0 },
    blockWords: { type: 'string[]', default: [] },
    minBodyLength: { type: 'number', default: 0, min: 0 },
  },
  poll: {
    minutes: { type: 'number', default: 5, min: 1, max: 1440 },
    perSourceTimeout: { type: 'number', default: 45000, min: 3000 },
    maxPerSource: { type: 'number', default: 80, min: 1, max: 500 },
    auto: { type: 'bool', default: false },
  },
  notify: {
    telegram: { type: 'bool', default: false },
    chatId: { type: 'string|null', default: null },
    botToken: { type: 'string|null', default: null },
    verdicts: { type: 'string[]', default: ['prime', 'good'] },
    minScore: { type: 'number', default: 70, min: 0, max: 100 },
    cooldownMin: { type: 'number', default: 60, min: 0 },
  },
  apply: {
    enabled: { type: 'bool', default: false },
    dryRun: { type: 'bool', default: true },
    dailyLimit: { type: 'number', default: 5, min: 1, max: 200 },
    minScore: { type: 'number', default: 80, min: 0, max: 100 },
    services: { type: 'string[]', default: [] },
    onlySources: { type: 'string[]', default: [] },
  },
  profile: {
    name: { type: 'string', default: '' },
    title: { type: 'string', default: '' },
    skills: { type: 'string', default: '' },
    hourlyRate: { type: 'number|null', default: null, min: 0 },
    experience: { type: 'string', default: '' },
    portfolio: { type: 'string[]', default: [] },
    contacts: { type: 'string', default: '' },
    defaultDeadline: { type: 'string', default: '2–3 дня' },
  },
  ui: {
    perPage: { type: 'number', default: 50, min: 10, max: 500 },
    compact: { type: 'bool', default: false },
    showBad: { type: 'bool', default: false },
  },
  ai: {
    enabled: { type: 'bool', default: false },
    providerId: { type: 'string|null', default: null, title: 'Активный провайдер' },
    model: { type: 'string|null', default: null, title: 'Модель' },
    temperature: { type: 'number', default: 0.2, min: 0, max: 2 },
    maxTokens: { type: 'number', default: 2500, min: 100, max: 32000 },
    timeout: { type: 'number', default: 120000, min: 10000, max: 600000 },
    matchLimit: { type: 'number', default: 40, min: 5, max: 200 },
    matchBatchSize: { type: 'number', default: 12, min: 1, max: 30 },
    autoMatch: { type: 'bool', default: false, title: 'Оценивать заказы ИИ при опросе' },
    customName: { type: 'string', default: '' },
    customType: { type: 'enum', values: ['openai', 'anthropic', 'ollama'], default: 'openai' },
    customBaseUrl: { type: 'string', default: '' },
    customApiKey: { type: 'string', default: '' },
    customModel: { type: 'string', default: '' },
  },
};

const LEGACY_KEYS = {
  keywordsPlus: 'search.keywordsPlus',
  keywordsMinus: 'search.keywordsMinus',
  sites: 'search.sites',
  priceMin: 'search.priceMin',
  priceMax: 'search.priceMax',
  pollMinutes: 'poll.minutes',
  autoApply: 'apply.enabled',
};

function defaults() {
  const out = { schemaVersion: 2 };
  for (const [group, fields] of Object.entries(SCHEMA)) {
    out[group] = {};
    for (const [key, spec] of Object.entries(fields)) {
      out[group][key] = Array.isArray(spec.default) ? [...spec.default] : (spec.default ?? null);
    }
  }
  return out;
}

function coerce(spec, value) {
  if (value === undefined || value === null || value === '') {
    if (spec.type === 'number|null' || spec.type === 'string|null') return null;
    if (spec.type === 'string[]') return [];
    if (spec.type === 'number[]') return [];
    if (spec.type === 'object[]') return [];
    if (spec.type === 'bool') return false;
    if (spec.type === 'number') return spec.default ?? 0;
    if (spec.type === 'string') return spec.default ?? '';
    return null;
  }
  switch (spec.type) {
    case 'string':
      return String(value).slice(0, 500);
    case 'string|null':
      return value == null ? null : String(value).slice(0, 500);
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return spec.default ?? 0;
      return clamp(n, spec.min, spec.max);
    }
    case 'number|null': {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return clamp(n, spec.min, spec.max);
    }
    case 'bool':
      if (typeof value === 'boolean') return value;
      return ['1', 'true', 'yes', 'on', 'да'].includes(String(value).toLowerCase());
    case 'string[]':
      return (Array.isArray(value) ? value : String(value).split(','))
        .map((v) => String(v).trim()).filter(Boolean).slice(0, 200);
    case 'number[]':
      return (Array.isArray(value) ? value : String(value).split(','))
        .map((v) => Number(v)).filter(Number.isFinite).slice(0, 200);
    case 'object[]':
      if (!Array.isArray(value)) return [];
      return value.slice(0, 100).map((item) => {
        const out = {};
        for (const [f, fspec] of Object.entries(spec.fields || {})) out[f] = coerce(fspec, item ? item[f] : undefined);
        return out;
      });
    case 'object':
      return (value && typeof value === 'object') ? value : {};
    case 'enum':
      return spec.values.includes(value) ? value : spec.default;
    default:
      return value;
  }
}

function clamp(n, min, max) {
  if (min != null && n < min) return min;
  if (max != null && n > max) return max;
  return n;
}

/** Приводит произвольный патч к валидным настройкам (по группам) */
function validate(patch = {}, base = null) {
  const out = { ...(base || defaults()) };
  for (const [group, fields] of Object.entries(SCHEMA)) {
    const src = patch[group] && typeof patch[group] === 'object' ? patch[group] : {};
    out[group] = out[group] || {};
    for (const [key, spec] of Object.entries(fields)) {
      if (src[key] !== undefined) out[group][key] = coerce(spec, src[key]);
      else if (out[group][key] === undefined) out[group][key] = coerce(spec, undefined);
    }
    // неизвестные ключи группы сохраняем (например, per-source параметры)
    for (const [key, val] of Object.entries(src)) {
      if (!(key in fields)) out[group][key] = val;
    }
  }
  // настройки вне схемы (например, per-source)
  for (const [key, val] of Object.entries(patch)) {
    if (!(key in SCHEMA)) out[key] = val;
  }
  out.schemaVersion = 2;
  return out;
}

/** Миграция старых (v1) настроек → новая схема */
function migrate(old = {}) {
  const patch = {};
  for (const [legacyKey, path] of Object.entries(LEGACY_KEYS)) {
    if (old[legacyKey] === undefined) continue;
    const [group, key] = path.split('.');
    patch[group] = patch[group] || {};
    patch[group][key] = old[legacyKey];
  }
  if (old.quality && typeof old.quality === 'object') patch.quality = { ...patch.quality, ...old.quality };
  if (old.sources && typeof old.sources === 'object') patch.sources = old.sources;
  // сохраняем неизвестные ключи (например, aiProfile с профилем исполнителя)
  for (const [key, val] of Object.entries(old)) {
    if (key in SCHEMA || key in LEGACY_KEYS || key === 'schemaVersion') continue;
    patch[key] = val;
  }
  return validate(patch, defaults());
}

/** Плоский список «group.key -> значение» для UI/CLI */
function flatten(settings) {
  const out = {};
  for (const [group, fields] of Object.entries(SCHEMA)) {
    for (const key of Object.keys(fields)) {
      out[`${group}.${key}`] = settings?.[group]?.[key];
    }
  }
  return out;
}

/** Значение по пути "group.key" */
function get(settings, path, dflt = undefined) {
  const [g, k] = path.split('.');
  const v = settings?.[g]?.[k];
  return v === undefined ? dflt : v;
}

/** Запись по пути "group.key" */
function set(settings, path, value) {
  const [g, k] = path.split('.');
  const group = SCHEMA[g];
  if (group && group[k]) {
    settings[g] = settings[g] || {};
    settings[g][k] = coerce(group[k], value);
  } else {
    settings[g] = settings[g] || {};
    settings[g][k] = value;
  }
  return settings;
}

module.exports = { SCHEMA, defaults, validate, migrate, flatten, get, set, coerce, LEGACY_KEYS };
