'use strict';
/**
 * ИИ-профиль: разбор резюме в структурированные данные и подбор заказов.
 *
 * Возможности:
 *   analyzeResume  — резюме → профиль (навыки, стек, ставка, пожелания, анти-хотелки)
 *   matchJobs      — оценка соответствия заказов профилю (match 0..100 + причины)
 *   recommend      — «какие заказы взять» + краткое обоснование
 *   ask            — свободный вопрос по ленте («что лучше взять?», «почему этот?»)
 *   improveResponse— переписать черновик отклика под профиль
 */
const ai = require('./ai');
const store = require('./store');

const VERDICTS = ['take', 'consider', 'skip'];

/* --------------------------- работа с провайдером ----------------------- */

/** Активный провайдер: из настроек, иначе — первый доступный из конфига opencode */
function activeProvider(settings) {
  const cfg = (settings && settings.ai) || {};
  if (cfg.providerId) {
    const p = ai.getProvider(cfg.providerId);
    if (p) return p;
  }
  const list = ai.listProviders();
  const fromOc = list.find((p) => p.source === 'opencode');
  return fromOc || list[0] || null;
}

function aiOptions(settings, extra = {}) {
  const cfg = (settings && settings.ai) || {};
  return {
    model: cfg.model || undefined,
    temperature: cfg.temperature ?? 0.2,
    maxTokens: cfg.maxTokens ?? 2500,
    timeout: cfg.timeout ?? 120000,
    ...extra,
  };
}

/**
 * Вызов LLM с автофоллбэком: если активный провайдер недоступен (лимит, баланс, 5xx),
 * пробуем следующие по списку. Это спасает, когда бесплатные модели упираются в rate-limit.
 */
const failedProviders = new Map(); // id -> timestamp последней неудачи

async function callLLM(settings, messages, opts = {}) {
  const primary = activeProvider(settings);
  const errors = [];
  const tried = new Set();
  const all = ai.listProviders().filter((p) => p.apiKey);
  // приоритет: бесплатные модели и openrouter (обычно не требуют баланса)
  const score = (p) => {
    const m = String(p.model || '').toLowerCase();
    const g = String(p.group || p.id).toLowerCase();
    if (m.includes('free') || g.includes('openrouter')) return 0;
    if (g.includes('zai2')) return 1;
    return 2;
  };
  const rest = all.filter((p) => p.id !== primary?.id).sort((a, b) => score(a) - score(b));
  const candidates = [primary, ...rest].filter(Boolean);

  let attempts = 0;
  for (const p of candidates) {
    if (attempts >= (opts.maxProviders || 4)) break;
    if (tried.has(p.id)) continue;
    // не пробуем тот же провайдер дважды подряд в течение 2 минут
    const lastFail = failedProviders.get(p.id) || 0;
    if (lastFail && Date.now() - lastFail < 120000) continue;
    tried.add(p.id);
    attempts++;
    const isPrimary = p.id === primary?.id;
    const model = isPrimary ? (opts.model || settings?.ai?.model || p.model) : p.model;
    if (!model) continue;
    try {
      const primaryTimeout = settings?.ai?.timeout || 120000;
      // у резервных провайдеров короткий таймаут — иначе пользователь ждёт минуты
      const timeout = isPrimary ? primaryTimeout : Math.min(primaryTimeout, 20000);
      const r = await ai.chat(p, messages, { ...aiOptions(settings, opts), model, timeout });
      if (!r.text) throw new Error('пустой ответ модели');
      failedProviders.delete(p.id);
      return { ...r, provider: p.id };
    } catch (e) {
      failedProviders.set(p.id, Date.now());
      errors.push(`${p.name || p.id}: ${String(e.message || e).slice(0, 90)}`);
    }
  }
  throw new Error(`ИИ недоступен. Попытки: ${errors.join(' | ') || 'нет провайдеров'}`);
}

/* -------------------------------- JSON ---------------------------------- */

/** Достаёт JSON-объект/массив из ответа модели (модели любят добавлять текст вокруг) */
function extractJson(text) {
  if (!text) return null;
  const t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : t;
  const firstObj = body.indexOf('{');
  const firstArr = body.indexOf('[');
  const start = firstObj < 0 ? firstArr : (firstArr < 0 ? firstObj : Math.min(firstObj, firstArr));
  if (start < 0) return null;
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) { try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/* ------------------------------ профиль --------------------------------- */

const PROFILE_SCHEMA = `{
  "name": "строка",
  "title": "кем работает (1-2 слова)",
  "summary": "краткое описание опыта, 1-2 предложения",
  "skills": ["навыки, которые он УМЕЕТ"],
  "stack": ["технологии/инструменты"],
  "experience": ["краткий опыт: что делал, какой результат"],
  "categories": ["категории заказов, которые ему подходят: сайты, боты, автоматизация..."],
  "hourlyRate": 1500,
  "minBudget": 20000,
  "remoteOk": true,
  "willingToLearn": ["что готов освоить"],
  "redFlags": ["что точно НЕ хочет: вакансии без ТЗ, тестовые..."],
  "contacts": "телефон/telegram/почта если указаны",
  "links": ["ссылки на портфолио если указаны"],
  "languages": ["ru", "en"],
  "notes": "важные нюансы, которые видны из резюме"
}`;

/**
 * Разбор резюме.
 * @param {string} resumeText
 * @param {object} settings
 * @returns {Promise<{profile:object, raw:string, model:string}>}
 */
async function analyzeResume(resumeText, settings = {}) {
  const provider = activeProvider(settings);
  if (!provider) throw new Error('не настроен ИИ-провайдер (добавь ключ в разделе «AI» или включи провайдер из конфига opencode)');
  const text = String(resumeText || '').slice(0, 20000);
  if (text.length < 20) throw new Error('резюме слишком короткое');

  const system = `Ты — эксперт по подбору фриланс-заказов. Анализируй резюме исполнителя и строго верни JSON по схеме. Ничего не выдумывай: если данных нет — ставь пустой массив или null. Отвечай ТОЛЬКО JSON.`;
  const user = `Схема ответа:\n${PROFILE_SCHEMA}\n\nРезюме:\n"""\n${text}\n"""\n\nВерни JSON с разбором этого резюме.`;

  const r = await callLLM(settings, [{ role: 'user', content: user }], aiOptions(settings, { system, json: true }));
  const data = extractJson(r.text);
  if (!data) throw new Error('не удалось разобрать ответ модели как JSON: ' + r.text.slice(0, 200));
  const profile = normalizeProfile(data);
  return { profile, raw: r.text, model: r.model, provider: provider.id };
}

/** Приводит профиль к предсказуемой форме */
function normalizeProfile(d = {}) {
  const arr = (v) => {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    if (typeof v === 'string') return v.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
    return [];
  };
  return {
    name: d.name || null,
    title: d.title || null,
    summary: d.summary || null,
    skills: arr(d.skills),
    stack: arr(d.stack),
    experience: arr(d.experience),
    categories: arr(d.categories),
    hourlyRate: Number(d.hourlyRate) || null,
    minBudget: Number(d.minBudget) || null,
    remoteOk: d.remoteOk !== false,
    willingToLearn: arr(d.willingToLearn),
    redFlags: arr(d.redFlags),
    contacts: d.contacts || null,
    links: arr(d.links),
    languages: arr(d.languages),
    notes: d.notes || null,
  };
}

/** Профиль для промпта (компактно) */
function profileToPrompt(profile) {
  if (!profile) return '(профиль не задан)';
  const p = normalizeProfile(profile);
  const lines = [
    p.title ? `Кто: ${p.title}` : null,
    p.summary ? `О себе: ${p.summary}` : null,
    p.skills.length ? `Навыки: ${p.skills.join(', ')}` : null,
    p.stack.length ? `Стек: ${p.stack.join(', ')}` : null,
    p.experience.length ? `Опыт: ${p.experience.join('; ')}` : null,
    p.categories.length ? `Подходящие категории: ${p.categories.join(', ')}` : null,
    p.hourlyRate ? `Ставка: ${p.hourlyRate} ₽/час` : null,
    p.minBudget ? `Минимальный бюджет: ${p.minBudget} ₽` : null,
    p.remoteOk ? 'Готов работать удалённо' : null,
    p.willingToLearn.length ? `Готов освоить: ${p.willingToLearn.join(', ')}` : null,
    p.redFlags.length ? `НЕ хочет: ${p.redFlags.join(', ')}` : null,
    p.languages.length ? `Языки: ${p.languages.join(', ')}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

/* ------------------------------ подбор ---------------------------------- */

/** Компактное представление заказа для промпта */
function jobToPrompt(job) {
  const price = job.price?.text || (job.price?.min != null ? `${job.price.min} ${job.price.currency || ''}` : 'не указана');
  const cl = job.client || {};
  const clientBits = [];
  if (cl.rating != null) clientBits.push(`рейтинг ${cl.rating}`);
  if (cl.reviews != null) clientBits.push(`${cl.reviews} отзывов`);
  if (job.stats?.responses != null) clientBits.push(`${job.stats.responses} откликов`);
  const body = String(job.body || '').replace(/\s+/g, ' ').slice(0, 700);
  return [
    `id: ${job.id}`,
    `заголовок: ${job.title}`,
    `цена: ${price}`,
    `площадка: ${job.sourceLabel || job.source}`,
    clientBits.length ? `заказчик: ${clientBits.join(', ')}` : null,
    `описание: ${body}`,
  ].filter(Boolean).join('\n');
}

/**
 * Оценка соответствия заказов профилю.
 * @param {object} profile
 * @param {Array} jobs
 * @returns {Promise<{results:Array, model:string}>}
 */
async function matchJobs(profile, jobs, settings = {}) {
  if (!jobs.length) return { results: [], model: null };
  const provider = activeProvider(settings);
  if (!provider) throw new Error('не настроен ИИ-провайдер');

  const cfg = (settings.ai) || {};
  const batchSize = cfg.matchBatchSize || 12;
  const maxJobs = cfg.matchLimit || 40;
  const list = jobs.slice(0, maxJobs);

  const system = `Ты — помощник фрилансера. Оцени соответствие заказов профилю исполнителя.
Для каждого заказа верни: id (строго как входной), score (0-100 — насколько заказ подходит), verdict ("take" | "consider" | "skip"), reasons (массив из 1-3 коротких объяснений на русском), risk (строка: главный риск или "").
Критерии: совпадение навыков, адекватность цены, качество заказчика, конкуренция (число откликов), понятность ТЗ, соответствие пожеланиям и анти-пожеланиям профиля.
Отвечай ТОЛЬКО JSON: {"results":[{"id":"...","score":80,"verdict":"take","reasons":["..."],"risk":""}]}`;

  const all = [];
  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);
    const user = `ПРОФИЛЬ:\n${profileToPrompt(profile)}\n\nЗАКАЗЫ:\n${batch.map(jobToPrompt).join('\n---\n')}`;
    const r = await callLLM(settings, [{ role: 'user', content: user }], aiOptions(settings, { system, json: true }));
    const data = extractJson(r.text);
    const rows = data?.results || (Array.isArray(data) ? data : []);
    for (const row of rows) {
      if (!row || !row.id) continue;
      all.push({
        id: String(row.id),
        score: Math.max(0, Math.min(100, Number(row.score) || 0)),
        verdict: VERDICTS.includes(row.verdict) ? row.verdict : 'consider',
        reasons: Array.isArray(row.reasons) ? row.reasons.map(String).slice(0, 4) : [],
        risk: row.risk ? String(row.risk) : '',
      });
    }
  }
  return { results: all, model: null };
}

/** Рекомендация: какие заказы взять */
async function recommend(profile, jobs, settings = {}, opts = {}) {
  const provider = activeProvider(settings);
  if (!provider) throw new Error('не настроен ИИ-провайдер');
  const list = jobs.slice(0, (settings.ai?.matchLimit) || 40);
  const system = `Ты — помощник фрилансера, который помогает выбрать заказы.
Отвечай по-русски, конкретно и по делу. Если данных мало — скажи это прямо.`;
  const user = `ПРОФИЛЬ:\n${profileToPrompt(profile)}\n\nЗАКАЗЫ:\n${list.map(jobToPrompt).join('\n---\n')}\n\n`
    + `Задача: ${opts.question || 'выбери заказы, которые стоит взять, и объясни почему именно их, а не остальные.'}\n`
    + `Ответь в формате:\n1) ТОП: список из 3-5 заказов (id, название, почему)\n2) Что пропустить и почему\n3) На что обратить внимание (риски, спорные моменты)`;
  const r = await callLLM(settings, [{ role: 'user', content: user }], aiOptions(settings, { system, maxTokens: 3000 }));
  return { text: r.text, model: r.model, provider: provider.id };
}

/** Свободный вопрос по ленте */
async function ask(profile, jobs, question, settings = {}) {
  const provider = activeProvider(settings);
  if (!provider) throw new Error('не настроен ИИ-провайдер');
  const list = jobs.slice(0, (settings.ai?.matchLimit) || 40);
  const system = `Ты — помощник фрилансера. Отвечай по-русски, конкретно, опираясь на профиль и список заказов. Не выдумывай заказы — используй только id из списка.`;
  const user = `ПРОФИЛЬ:\n${profileToPrompt(profile)}\n\nЗАКАЗЫ:\n${list.map(jobToPrompt).join('\n---\n')}\n\nВОПРОС: ${question}`;
  const r = await callLLM(settings, [{ role: 'user', content: user }], aiOptions(settings, { system, maxTokens: 3000 }));
  return { text: r.text, model: r.model, provider: provider.id };
}

/** Улучшение черновика отклика */
async function improveResponse(job, profile, draft, settings = {}) {
  const provider = activeProvider(settings);
  if (!provider) throw new Error('не настроен ИИ-провайдер');
  const system = `Ты — профессиональный фрилансер. Пишешь отклики на русском: коротко (до 900 знаков), по делу, без воды и без «извините за поздний ответ».`;
  const user = `ПРОФИЛЬ:\n${profileToPrompt(profile)}\n\nЗАКАЗ:\n${jobToPrompt(job)}\n\nЧЕРНОВИК ОТКЛИКА:\n"""\n${draft}\n"""\n\n`
    + `Перепиши отклик: используй реальные навыки профиля, покажи как решишь задачу, назови срок и цену, задай один уточняющий вопрос.`
    + `Если в черновике есть конкретика — сохрани её. Верни только текст отклика, без комментариев.`;
  const r = await callLLM(settings, [{ role: 'user', content: user }], aiOptions(settings, { system, maxTokens: 1500 }));
  return { text: r.text.trim(), model: r.model, provider: provider.id };
}

/* --------------------------- хранение профиля --------------------------- */

function getProfile(settings) {
  const s = settings || store.getSettings();
  return (s.aiProfile && s.aiProfile.profile) || null;
}

function saveProfile(profile, settings) {
  const s = settings || store.getSettings();
  return store.updateSettings({ aiProfile: { profile: normalizeProfile(profile), updatedAt: Date.now() } });
}

/** Итоговая оценка: скоринг ИИ + детерминированный скоринг качества */
function combinedScore(job) {
  const aiScore = job.aiMatch?.score ?? null;
  const qScore = job.quality?.score ?? null;
  if (aiScore == null) return qScore;
  if (qScore == null) return aiScore;
  return Math.round(aiScore * 0.65 + qScore * 0.35);
}

module.exports = {
  activeProvider, aiOptions, extractJson, normalizeProfile, profileToPrompt, jobToPrompt,
  analyzeResume, matchJobs, recommend, ask, improveResponse,
  getProfile, saveProfile, combinedScore, VERDICTS,
};
