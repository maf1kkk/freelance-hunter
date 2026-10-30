#!/usr/bin/env node
'use strict';
/**
 * MCP-сервер freelance-hunter (stdio, JSON-RPC 2.0).
 *
 * Инструменты:
 *   poll_all            — опросить все источники
 *   poll_source         — опросить один источник
 *   sources             — список источников и их статус
 *   list_jobs           — лента с фильтрами
 *   get_job             — карточка заказа + черновик отклика
 *   draft_response      — черновик отклика (ИИ дорабатывает)
 *   mark_applied        — сохранить отклик / сменить статус
 *   set_settings        — настройки поиска и качества
 *   get_settings        — текущие настройки
 *   quality_report      — разбор скоринга конкретного заказа
 *   stats               — статистика по базе
 *   accounts_status     — обзор аккаунтов на всех площадках
 *   import_cookies      — импорт cookie-файла
 *   whoami              — кто я на всех площадках
 *   auto_apply          — подготовка/отправка откликов
 *   generate_product_cards — PNG-карточки товаров
 *
 * Подключение:
 * {
 *   "mcp": {
 *     "hunter": {
 *       "type": "local",
 *       "command": ["node", "D:\\opencode\\hunter\\mcp\\server.js"]
 *     }
 *   }
 * }
 */
const engine = require('../src/engine');
const store = require('../src/core/store');
const pipeline = require('../src/core/pipeline');
const accounts = require('../src/core/accounts');
const sources = require('../src/sources');
const settingsLib = require('../src/core/settings');
const profileLib = require('../src/core/profile');
const aiProfile = require('../src/core/ai-profile');
const { draftResponse } = require('../src/respond');
const cards = require('../src/cards');
const applyRunner = require('../src/apply');

const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'poll_all',
    description: 'Опросить ВСЕ подключённые источники (alot.pro, fl.ru, kwork, hh.ru, Telegram, remoteok, remotive, arbeitnow, jobicy, himalayas, WWR), отфильтровать, оценить качество и сохранить. Возвращает статистику по каждому источнику.',
    inputSchema: {
      type: 'object',
      properties: {
        only: { type: 'array', items: { type: 'string' }, description: 'Опросить только эти источники' },
        limit: { type: 'number', description: 'Максимум заказов с источника (по умолчанию 80)' },
      },
    },
  },
  {
    name: 'poll_source',
    description: 'Опросить один источник по id (alot, flru, kwork, hh, telegram, remoteok, remotive, arbeitnow, jobicy, himalayas, weworkremotely).',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string', description: 'id источника' } },
      required: ['source'],
    },
  },
  {
    name: 'sources',
    description: 'Список источников: id, название, тип, требует ли авторизации, состояние последнего опроса.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_jobs',
    description: 'Список заказов из ленты. Фильтры: source, verdict (prime/good/meh/bad/blocked), status, minPrice, maxPrice, minScore, q (поиск по тексту), limit, offset. По умолчанию сортировка по качеству.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'id источника или список через запятую' },
        verdict: { type: 'string', description: 'prime | good | meh | bad | blocked (через запятую)' },
        status: { type: 'string', description: 'new | watched | drafted | sent | applied | skipped | done | rejected' },
        minPrice: { type: 'number' },
        maxPrice: { type: 'number' },
        minScore: { type: 'number', description: 'Минимальный score качества (0-100)' },
        q: { type: 'string', description: 'Поиск по тексту' },
        limit: { type: 'number', description: 'По умолчанию 20' },
        offset: { type: 'number' },
      },
    },
  },
  {
    name: 'get_job',
    description: 'Полная карточка заказа: текст, цена, площадка, метрики заказчика (рейтинг/отзывы), разбор качества, дубликаты + черновик отклика. Используй ПЕРЕД генерацией отклика.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'id заказа (например alot:17352142 или flru:5525976)' } },
      required: ['id'],
    },
  },
  {
    name: 'draft_response',
    description: 'Черновик отклика на заказ. Приходит каркас (приветствие, план, срок, цена, вопрос) — можешь переписать его своими словами и вернуть через mark_applied.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        customText: { type: 'string', description: 'Свой текст отклика (если не указан — шаблонный)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'mark_applied',
    description: 'Сохранить финальный текст отклика и пометить заказ (status: drafted/sent/applied/done/skipped). Отправку на биржу выполняет пользователь в UI либо auto_apply.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        responseText: { type: 'string', description: 'Финальный текст отклика' },
        status: { type: 'string', description: 'drafted | sent | applied | done | skipped (по умолчанию applied)' },
        notes: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'set_settings',
    description: 'Настроить фильтры. Принимает плоские параметры (priceMin, keywordsPlus, minClientRating…) и вложенные группы (search:{priceMin:5000}, quality:{…}, apply:{…}, notify:{…}, profile:{…}).',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'object', description: '{keywordsPlus[], keywordsMinus[], priceMin, priceMax, sites[]}' },
        quality: { type: 'object', description: '{minClientRating, minClientReviews, maxResponses, minSalaryPerHour, blockWords[]}' },
        apply: { type: 'object', description: '{enabled, dryRun, dailyLimit, minScore, services[]}' },
        notify: { type: 'object', description: '{telegram, botToken, chatId, minScore, verdicts[]}' },
        profile: { type: 'object', description: '{name,title,skills,hourlyRate,experience,contacts}' },
        keywordsPlus: { type: 'array', items: { type: 'string' } },
        keywordsMinus: { type: 'array', items: { type: 'string' } },
        sites: { type: 'array', items: { type: 'string' }, description: 'Биржи: flru, kworkru, hhru и т.д.' },
        priceMin: { type: 'number' },
        priceMax: { type: 'number' },
        minClientRating: { type: 'number' },
        minClientReviews: { type: 'number' },
        maxResponses: { type: 'number' },
        minSalaryPerHour: { type: 'number' },
        blockWords: { type: 'array', items: { type: 'string' } },
        pollMinutes: { type: 'number' },
        autoApplyEnabled: { type: 'bool' },
        autoApplyDryRun: { type: 'bool' },
        autoApplyDailyLimit: { type: 'number' },
        notifyTelegram: { type: 'bool' },
        botToken: { type: 'string', description: 'Токен Telegram-бота' },
        chatId: { type: 'string' },
        notifyMinScore: { type: 'number' },
        notifyVerdicts: { type: 'array', items: { type: 'string' } },
        profile: { type: 'object', description: '{name,title,skills,hourlyRate,experience,contacts}' },
      },
    },
  },
  {
    name: 'get_settings',
    description: 'Все текущие настройки: поиск, качество, опрос, автоотклик, профиль исполнителя.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'quality_report',
    description: 'Разбор скоринга качества заказа: баллы по критериям (клиент/содержание/цена/конкуренция/свежесть), штрафы, флаги и объяснения.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'stats',
    description: 'Статистика: сколько заказов, по источникам, по вердиктам, средняя цена, сколько откликов отправлено.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'accounts_status',
    description: 'Обзор аккаунтов на всех площадках: есть ли credentials, работает ли доступ, кто пользователь. Возвращает и список источников без аккаунта.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'import_cookies',
    description: 'Импортировать cookie-файл (Netscape cookies.txt / Chrome JSON / Playwright storageState / raw header). Сервис определяется по домену автоматически.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к файлу с cookies' },
        service: { type: 'string', description: 'Сервис (flru/kwork/hh) — если не указан, определится сам' },
        domain: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    name: 'whoami',
    description: 'Кто я на всех площадках (alot, fl.ru, kwork, hh) + статус Telegram-сессии.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'auto_apply',
    description: 'Подготовить (и по умолчанию НЕ отправить) отклики на подходящие заказы fl.ru/kwork. По умолчанию dryRun=true.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: { type: 'bool', description: 'true — только подготовить тексты (по умолчанию)' },
        limit: { type: 'number' },
        minScore: { type: 'number' },
        services: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'ai_status',
    description: 'Статус ИИ-подбора: активный провайдер и модель, есть ли разобранный профиль, сколько заказов уже оценено ИИ.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ai_list_providers',
    description: 'Список ИИ-провайдеров: из конфига opencode (подтягиваются автоматически) и свои. Можно выбрать любой OpenAI-совместимый, Anthropic или Ollama.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ai_set_provider',
    description: 'Выбрать активного ИИ-провайдера и модель (id из ai_list_providers).',
    inputSchema: {
      type: 'object',
      properties: {
        providerId: { type: 'string', description: 'например oc:zai2 или custom:my-openai' },
        model: { type: 'string' },
      },
      required: ['providerId'],
    },
  },
  {
    name: 'ai_test_provider',
    description: 'Проверить связь с ИИ-провайдером (тестовый запрос).',
    inputSchema: {
      type: 'object',
      properties: { providerId: { type: 'string' } },
    },
  },
  {
    name: 'analyze_resume',
    description: 'Разобрать резюме в профиль исполнителя (навыки, стек, ставка, пожелания, анти-хотелки). Принимает путь к файлу (PDF/DOCX/TXT) или текст. Профиль сохраняется и используется для подбора.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'путь к файлу резюме' },
        text: { type: 'string', description: 'текст резюме, если файла нет' },
      },
    },
  },
  {
    name: 'get_ai_profile',
    description: 'Текущий профиль исполнителя, разобранный из резюме.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ai_match',
    description: 'Оценить заказы из ленты по профилю (score 0-100, вердикт take/consider/skip, причины и риски). Результат сохраняется в заказы.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'сколько заказов оценить (по умолчанию 40)' },
        source: { type: 'string' },
        verdict: { type: 'string', description: 'фильтр по качеству: prime,good' },
      },
    },
  },
  {
    name: 'ai_ask',
    description: 'Спросить ИИ по ленте: «какой заказ взять?», «почему этот плохой?». Отвечает на основе профиля и списка заказов.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
    },
  },
  {
    name: 'ai_recommend',
    description: 'Рекомендация ИИ: топ заказов, что взять, что пропустить и риски.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string' } },
    },
  },
  {
    name: 'ai_improve_response',
    description: 'Переписать черновик отклика с учётом профиля: как решишь задачу, срок, цена, уточняющий вопрос.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id заказа' },
        text: { type: 'string', description: 'текущий черновик (если не указан — берётся из базы)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'generate_product_cards',
    description: 'Сгенерировать карточки товаров для WB/Озон/Авито в PNG. ИИ сам придумывает заголовок и УТП-буллеты, инструмент рендерит. Один товар или массив (батч).',
    inputSchema: {
      type: 'object',
      properties: {
        products: {
          type: 'array',
          description: 'Один объект или массив объектов: { title, bullets[] (2-5 УТП), badge? (плашка), price?, photoPath? (абсолютный путь к фото), style? (minimal|bold|gradient) }',
          items: { type: 'object' },
        },
        size: { type: 'string', description: 'wb (900x1200) | ozon (1080x1350) | avito (1000x1000). По умолчанию wb.' },
      },
      required: ['products'],
    },
  },
];

function jsonRpcResult(id, result) { return JSON.stringify({ jsonrpc: '2.0', id, result }); }
function jsonRpcError(id, code, message) { return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }); }

function findJob(id) {
  const key = String(id || '');
  return store.getJob(key)
    || store.getJob(`alot:${key}`)
    || store.getJob(key.startsWith('alot:') ? key.slice(5) : key);
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'poll_all': {
      const r = await pipeline.pollAll({
        only: Array.isArray(args.only) && args.only.length ? args.only : null,
        limit: args.limit,
      });
      return {
        ok: r.ok,
        fetched: r.fetched,
        added: r.added,
        updated: r.updated,
        prime: r.matches,
        good: r.good,
        sources: r.sources,
      };
    }

    case 'poll_source': {
      const r = await pipeline.pollOne(args.source, { limit: args.limit });
      return { ok: r.ok, fetched: r.fetched, added: r.added, sources: r.sources };
    }

    case 'sources': {
      const state = store.getSourceState();
      return {
        items: sources.all().map((s) => ({
          id: s.id, label: s.label, kind: s.kind, needsAuth: s.needsAuth,
          lastPoll: state[s.id] || null,
        })),
      };
    }

    case 'list_jobs': {
      // пустая строка в фильтре = «ничего не выбрано» (не «фильтр не задан»)
      const src = args.source === undefined ? undefined : String(args.source).split(',').filter(Boolean);
      const vrd = args.verdict === undefined ? undefined : String(args.verdict).split(',').filter(Boolean);
      if (Array.isArray(src) && !src.length) return { total: 0, count: 0, items: [] };
      if (Array.isArray(vrd) && !vrd.length) return { total: 0, count: 0, items: [] };
      const filter = {
        source: src,
        verdict: vrd,
        status: args.status || undefined,
        minPrice: args.minPrice, maxPrice: args.maxPrice, minScore: args.minScore,
        q: args.q || undefined,
        limit: args.limit || 20, offset: args.offset || 0,
      };
      const { items, total } = store.listJobs(filter);
      return {
        total,
        count: items.length,
        items: items.map((p) => ({
          id: p.id, title: p.title, price: p.price?.text || p.price?.min || null,
          source: p.source, sourceLabel: p.sourceLabel || p.source,
          verdict: p.quality?.verdict, score: p.quality?.score,
          status: p.status, url: p.url,
          publishedAt: p.publishedAt ? new Date(p.publishedAt).toISOString() : null,
          responses: p.stats?.responses ?? null,
          client: p.client?.name || null,
          reasons: (p.quality?.reasons || []).slice(0, 3),
        })),
      };
    }

    case 'get_job': {
      const p = findJob(args.id);
      if (!p) throw new Error(`Заказ ${args.id} не найден. Сначала poll_all.`);
      return {
        ...p,
        draftResponse: draftResponse(p, store.getSettings()),
        duplicates: (p.dedupe?.duplicates || []).map((d) => {
          const j = store.getJob(d.id);
          return { ...d, title: j?.title };
        }),
      };
    }

    case 'draft_response': {
      const p = findJob(args.id);
      if (!p) throw new Error(`Заказ ${args.id} не найден.`);
      return { id: p.id, title: p.title, text: args.customText || draftResponse(p, store.getSettings()) };
    }

    case 'mark_applied': {
      const p = findJob(args.id);
      if (!p) throw new Error(`Заказ ${args.id} не найден.`);
      const updated = store.setJobStatus(p.id, args.status || 'applied', {
        responseText: args.responseText || p.responseText || '',
        notes: args.notes,
        appliedAt: Date.now(),
      });
      return { ok: true, id: updated.id, status: updated.status };
    }

    case 'set_settings': {
      const patch = {};

      // принимаем и вложенный формат (как в HTTP API: {search:{priceMin:5000}}),
      // и плоский ({priceMin:5000}) — для удобства обоих
      for (const group of ['search', 'quality', 'apply', 'poll', 'notify', 'profile', 'ui', 'sources']) {
        if (args[group] && typeof args[group] === 'object' && !Array.isArray(args[group])) {
          patch[group] = { ...(patch[group] || {}), ...args[group] };
        }
      }

      const search = { ...(patch.search || {}) };
      if (Array.isArray(args.keywordsPlus)) search.keywordsPlus = args.keywordsPlus.map(String);
      if (Array.isArray(args.keywordsMinus)) search.keywordsMinus = args.keywordsMinus.map(String);
      if (Array.isArray(args.sites)) search.sites = args.sites.map(String);
      if (typeof args.priceMin === 'number') search.priceMin = args.priceMin;
      if (typeof args.priceMax === 'number') search.priceMax = args.priceMax;
      if (Object.keys(search).length) patch.search = search;

      const quality = { ...(patch.quality || {}) };
      if (typeof args.minClientRating === 'number') quality.minClientRating = args.minClientRating;
      if (typeof args.minClientReviews === 'number') quality.minClientReviews = args.minClientReviews;
      if (typeof args.maxResponses === 'number') quality.maxResponses = args.maxResponses;
      if (typeof args.minSalaryPerHour === 'number') quality.minSalaryPerHour = args.minSalaryPerHour;
      if (Array.isArray(args.blockWords)) quality.blockWords = args.blockWords.map(String);
      if (Object.keys(quality).length) patch.quality = quality;

      const apply = { ...(patch.apply || {}) };
      if (typeof args.autoApplyEnabled === 'boolean') apply.enabled = args.autoApplyEnabled;
      if (typeof args.autoApplyDryRun === 'boolean') apply.dryRun = args.autoApplyDryRun;
      if (typeof args.autoApplyDailyLimit === 'number') apply.dailyLimit = args.autoApplyDailyLimit;
      if (Object.keys(apply).length) patch.apply = apply;

      const notify = { ...(patch.notify || {}) };
      if (typeof args.notifyTelegram === 'boolean') notify.telegram = args.notifyTelegram;
      if (typeof args.botToken === 'string') notify.botToken = args.botToken;
      if (typeof args.chatId === 'string') notify.chatId = args.chatId;
      if (typeof args.notifyMinScore === 'number') notify.minScore = args.notifyMinScore;
      if (Array.isArray(args.notifyVerdicts)) notify.verdicts = args.notifyVerdicts.map(String);
      if (Object.keys(notify).length) patch.notify = notify;

      if (typeof args.pollMinutes === 'number') patch.poll = { ...(patch.poll || {}), minutes: args.pollMinutes };
      if (args.profile && typeof args.profile === 'object') patch.profile = args.profile;

      const updated = store.updateSettings(patch);
      const rescored = pipeline.rescore({ settings: updated });
      return { settings: updated, rescored };
    }

    case 'get_settings':
      return store.getSettings();

    case 'quality_report': {
      const p = findJob(args.id);
      if (!p) throw new Error(`Заказ ${args.id} не найден.`);
      const q = p.quality || {};
      const names = { client: 'клиент (рейтинг/отзывы/опыт)', content: 'содержание (слова/навыки)', price: 'цена', competition: 'конкуренция', fresh: 'свежесть', penalty: 'штрафы' };
      return {
        id: p.id, title: p.title,
        score: q.score, verdict: q.verdict,
        parts: Object.entries(names).map(([k, label]) => ({ criterion: label, points: Math.round(q.parts?.[k] ?? 0) })),
        reasons: q.reasons || [],
        flags: q.flags || [],
        client: p.client,
        stats: p.stats,
        price: p.price,
      };
    }

    case 'stats': {
      const st = store.stats();
      return {
        total: st.total, bySource: st.bySource, byVerdict: st.byVerdict, byStatus: st.byStatus,
        avgPrice: st.avgPrice, last24h: st.last24h, last7d: st.last7d,
        applied: st.applied, appliedToday: st.appliedToday,
      };
    }

    case 'accounts_status': {
      const list = await pipeline.checkAll();
      return {
        accounts: accounts.list(),
        sources: list.map((s) => ({
          source: s.source, label: s.label, kind: s.kind, ok: s.ok,
          account: s.account || null, error: s.error || null, note: s.note || null,
        })),
      };
    }

    case 'import_cookies': {
      if (!args.path) throw new Error('нужен path к файлу с cookies');
      const result = accounts.importCookieFile(args.path, { service: args.service, domain: args.domain });
      return { ok: true, service: result.service, count: result.count, format: result.format, domains: result.domains };
    }

    case 'whoami': {
      const list = await pipeline.checkAll();
      return {
        accounts: list.map((s) => ({
          source: s.source, label: s.label, ok: s.ok,
          who: s.account || null, error: s.error || null,
        })),
      };
    }

    case 'auto_apply': {
      const r = await applyRunner.run({
        dryRun: args.dryRun,
        limit: args.limit,
        minScore: args.minScore,
        services: args.services,
      });
      return r;
    }

    case 'ai_status': {
      const ai = require('../src/core/ai');
      const aiProfile = require('../src/core/ai-profile');
      const settings = store.getSettings();
      const p = aiProfile.activeProvider(settings);
      const { items } = store.listJobs({ limit: 1000 });
      const scored = items.filter((j) => j.aiMatch).length;
      return {
        enabled: Boolean(settings.ai?.enabled),
        provider: p ? { id: p.id, name: p.name, baseURL: p.baseURL, model: settings.ai?.model || p.model } : null,
        profile: aiProfile.getProfile(settings) ? { title: aiProfile.getProfile(settings).title, skills: aiProfile.getProfile(settings).skills?.length } : null,
        jobsScored: scored,
        jobsTotal: items.length,
        providersAvailable: ai.listProviders().length,
      };
    }

    case 'ai_list_providers': {
      const ai = require('../src/core/ai');
      const settings = store.getSettings();
      const active = aiProfile.activeProvider(settings);
      return {
        active: active?.id || null,
        items: ai.listProviders().map((x) => ai.publicInfo(x)),
      };
    }

    case 'ai_set_provider': {
      const ai = require('../src/core/ai');
      if (!ai.getProvider(args.providerId)) throw new Error(`провайдер ${args.providerId} не найден`);
      const patch = { ai: { providerId: args.providerId, enabled: true } };
      if (args.model) patch.ai.model = args.model;
      const updated = store.updateSettings(patch);
      return { ok: true, providerId: updated.ai.providerId, model: updated.ai.model };
    }

    case 'ai_test_provider': {
      const ai = require('../src/core/ai');
      return await ai.testProvider(args.providerId || aiProfile.activeProvider(store.getSettings())?.id);
    }

    case 'analyze_resume': {
      const resumeLib = require('../src/core/resume');
      let text = args.text || '';
      let source = 'текст';
      if (args.path) {
        const parsed = resumeLib.parseResumeFile(args.path);
        text = parsed.text; source = parsed.name;
      }
      if (!text || text.length < 20) throw new Error('нужен path к файлу или text резюме');
      const settings = store.getSettings();
      const result = await aiProfile.analyzeResume(text, settings);
      aiProfile.saveProfile(result.profile, settings);
      return { ok: true, source, model: result.model, provider: result.provider, profile: result.profile };
    }

    case 'get_ai_profile': {
      const settings = store.getSettings();
      return { profile: aiProfile.getProfile(settings), updatedAt: settings.aiProfile?.updatedAt || null };
    }

    case 'ai_match': {
      const settings = store.getSettings();
      const profile = aiProfile.getProfile(settings);
      if (!profile) throw new Error('сначала разбери резюме: analyze_resume');
      const filter = {
        limit: args.limit || settings.ai?.matchLimit || 40,
        source: args.source ? String(args.source).split(',') : undefined,
        verdict: args.verdict ? String(args.verdict).split(',') : undefined,
      };
      const { items } = store.listJobs(filter);
      const { results } = await aiProfile.matchJobs(profile, items, settings);
      for (const r of results) {
        const job = store.getJob(r.id);
        if (job) store.updateJob(r.id, { aiMatch: { ...r, at: Date.now() } });
      }
      return {
        ok: true, count: results.length,
        results: results.sort((a, b) => b.score - a.score).map((r) => ({
          id: r.id, score: r.score, verdict: r.verdict, reasons: r.reasons, risk: r.risk,
        })),
      };
    }

    case 'ai_ask': {
      const settings = store.getSettings();
      const profile = aiProfile.getProfile(settings);
      if (!profile) throw new Error('сначала разбери резюме: analyze_resume');
      const { items } = store.listJobs({ limit: settings.ai?.matchLimit || 40 });
      const r = await aiProfile.ask(profile, items, args.question, settings);
      return { ok: true, text: r.text, model: r.model, provider: r.provider };
    }

    case 'ai_recommend': {
      const settings = store.getSettings();
      const profile = aiProfile.getProfile(settings);
      if (!profile) throw new Error('сначала разбери резюме: analyze_resume');
      const { items } = store.listJobs({ limit: settings.ai?.matchLimit || 40 });
      const r = await aiProfile.recommend(profile, items, settings, { question: args.question });
      return { ok: true, text: r.text, model: r.model, provider: r.provider };
    }

    case 'ai_improve_response': {
      const settings = store.getSettings();
      const profile = aiProfile.getProfile(settings);
      const job = findJob(args.id);
      if (!job) throw new Error(`Заказ ${args.id} не найден.`);
      const draft = args.text || job.responseText || draftResponse(job, settings);
      const r = await aiProfile.improveResponse(job, profile, draft, settings);
      return { ok: true, id: job.id, text: r.text, model: r.model, provider: r.provider };
    }

    case 'generate_product_cards': {
      const size = ['wb', 'ozon', 'avito'].includes(args.size) ? args.size : 'wb';
      const list = Array.isArray(args.products) ? args.products : [args.products];
      if (!list.length || !list[0] || !list[0].title) {
        throw new Error('products: нужен массив объектов с полем title');
      }
      const paths = await cards.renderBatch(list, size, 'card');
      return { ok: true, size, count: paths.length, files: paths };
    }

    default:
      throw new Error(`Неизвестный инструмент: ${name}`);
  }
}

async function handleRequest(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return null; }
  const { id, method, params } = msg;

  try {
    switch (method) {
      case 'initialize':
        return jsonRpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'freelance-hunter', version: '2.0.0' },
        });
      case 'notifications/initialized':
        return null;
      case 'tools/list':
        return jsonRpcResult(id, { tools: TOOLS });
      case 'tools/call': {
        try {
          const result = await callTool(params.name, params.arguments || {});
          return jsonRpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
        } catch (err) {
          return jsonRpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify({ error: String(err.message || err) }) }],
            isError: true,
          });
        }
      }
      case 'ping':
        return jsonRpcResult(id, {});
      default:
        return id !== undefined ? jsonRpcError(id, -32601, `Метод не найден: ${method}`) : null;
    }
  } catch (err) {
    return id !== undefined
      ? jsonRpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ error: String(err.message || err) }) }], isError: true })
      : null;
  }
}

(async () => {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  let inFlight = 0;
  let stdinClosed = false;

  const maybeExit = () => { if (stdinClosed && inFlight === 0) process.exit(0); };

  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      inFlight++;
      handleRequest(line)
        .then((out) => { if (out) process.stdout.write(out + '\n'); })
        .catch((err) => process.stderr.write(String(err) + '\n'))
        .finally(() => { inFlight--; maybeExit(); });
    }
  });
  process.stdin.on('end', () => { stdinClosed = true; maybeExit(); });
})();
