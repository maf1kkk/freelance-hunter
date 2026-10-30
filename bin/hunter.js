#!/usr/bin/env node
'use strict';
/**
 * CLI freelance-hunter v2.
 *
 *   node bin/hunter.js poll [--source s] [--limit n]   — опросить источники
 *   node bin/hunter.js list [флаги]                    — лента заказов
 *   node bin/hunter.js show <id>                       — карточка + черновик
 *   node bin/hunter.js apply <id> [текст]              — сохранить отклик
 *   node bin/hunter.js status <id> <статус>             — сменить статус
 *   node bin/hunter.js settings                        — настройки
 *   node bin/hunter.js set group.key=значение           — изменить настройку
 *   node bin/hunter.js get group.key                    — значение настройки
 *   node bin/hunter.js whoami                          — обзор аккаунтов
 *   node bin/hunter.js sources                         — список источников
 *   node bin/hunter.js accounts                        — список аккаунтов
 *   node bin/hunter.js accounts import <file> [svc]    — импорт cookie-файла
 *   node bin/hunter.js accounts check                  — проверить доступ
 *   node bin/hunter.js stats                           — статистика
 *   node bin/hunter.js rescore                         — пересчитать качество
 *   node bin/hunter.js doctor                          — диагностика окружения
 *   node bin/hunter.js init                            — быстрая настройка профиля
 *   node bin/hunter.js auto-apply [--dry]             — подготовка откликов
 *   node bin/hunter.js tg add <channel> [label]        — добавить канал
 *   node bin/hunter.js tg rm <channel>                 — удалить канал
 */
const path = require('path');
const store = require('../src/core/store');
const pipeline = require('../src/core/pipeline');
const sources = require('../src/sources');
const accounts = require('../src/core/accounts');
const settingsLib = require('../src/core/settings');
const profileLib = require('../src/core/profile');
const { draftResponse } = require('../src/respond');
const tg = require('../src/tg');
const applyRunner = require('../src/apply');
const { agoText } = require('../src/core/time');

const [, , cmd, ...args] = process.argv;

function flag(name, dflt) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return args.includes(`--${name}`) ? true : dflt;
}

function has(name) { return args.includes(`--${name}`); }

function findJob(id) {
  const key = String(id || '');
  return store.getJob(key)
    || store.getJob(`alot:${key}`)
    || store.getJob(key.startsWith('alot:') ? key.slice(5) : key);
}

async function main() {
  switch (cmd) {
    /* ------------------------------- poll ------------------------------ */
    case 'poll': {
      const only = flag('source');
      const r = await pipeline.pollAll({
        only: only ? String(only).split(',') : null,
        limit: flag('limit') ? Number(flag('limit')) : undefined,
      });
      console.log(`Заказов получено: ${r.fetched} | новых: ${r.added} | обновлено: ${r.updated}`);
      console.log(`Качество: prime ${r.matches} · good ${r.good} | пересчитано ${r.rescored?.changed ?? 0}\n`);
      for (const s of r.sources) {
        const mark = s.ok ? '✓' : '✗';
        console.log(` ${mark} ${s.source.padEnd(16)} ${String(s.count).padStart(4)}  ${s.ms}ms  ${s.error || ''}`);
      }
      break;
    }

    /* ------------------------------- list ------------------------------ */
    case 'list': {
      const filter = {
        status: flag('status'),
        source: flag('source') ? String(flag('source')).split(',') : undefined,
        verdict: flag('verdict') ? String(flag('verdict')).split(',') : undefined,
        minPrice: flag('min') ? Number(flag('min')) : undefined,
        maxPrice: flag('max') ? Number(flag('max')) : undefined,
        minScore: flag('score') ? Number(flag('score')) : undefined,
        q: flag('q'),
        limit: Number(flag('limit')) || 30,
      };
      const { items, total } = store.listJobs(filter);
      if (!items.length) { console.log('Ничего не найдено.'); break; }
      for (const p of items) {
        const v = p.quality?.verdict || '?';
        const sc = p.quality?.score ?? 0;
        console.log(`[${String(sc).padStart(3)}|${v.padEnd(7)}] ${p.source.padEnd(14)} ${(p.price?.text || '—').padEnd(18)} ${agoText(p.publishedAt).padEnd(14)} ${p.title}`);
      }
      console.log(`\nПоказано ${items.length} из ${total}`);
      break;
    }

    /* ------------------------------- show ------------------------------ */
    case 'show': {
      const p = findJob(args[0]);
      if (!p) { console.log('Не найден: ' + args[0]); break; }
      console.log(`# ${p.title}`);
      console.log(`Источник: ${p.sourceLabel || p.source} ${p.url || ''}`);
      console.log(`Цена: ${p.price?.text || '—'} | score ${p.quality?.score} (${p.quality?.verdict}) | статус ${p.status}`);
      console.log(`Клиент: ${p.client?.name || '—'} | рейтинг ${p.client?.rating ?? '—'} | отзывов ${p.client?.reviews ?? '—'} | откликов ${p.stats?.responses ?? '—'}`);
      console.log(`Причины: ${(p.quality?.reasons || []).join('; ')}`);
      console.log('\n===== Описание =====\n');
      console.log((p.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500));
      console.log('\n===== Черновик отклика =====\n');
      console.log(draftResponse(p, store.getSettings()));
      break;
    }

    /* ------------------------------ apply ------------------------------ */
    case 'apply': {
      const p = findJob(args[0]);
      if (!p) { console.log('Не найден: ' + args[0]); break; }
      const text = args.slice(1).join(' ') || p.responseText || draftResponse(p, store.getSettings());
      const updated = store.setJobStatus(p.id, 'applied', { responseText: text, appliedAt: Date.now() });
      console.log('Отмечен как applied: ' + updated.id);
      break;
    }

    case 'status': {
      const p = findJob(args[0]);
      if (!p) { console.log('Не найден: ' + args[0]); break; }
      const updated = store.setJobStatus(p.id, args[1] || 'watched', { responseText: args.slice(2).join(' ') });
      console.log(`Статус: ${updated.status}`);
      break;
    }

    /* ---------------------------- settings ----------------------------- */
    case 'settings': {
      console.log(JSON.stringify(store.getSettings(), null, 2));
      break;
    }

    case 'set': {
      const patch = {};
      for (const a of args) {
        const idx = a.indexOf('=');
        if (idx < 1) continue;
        const path = a.slice(0, idx);
        let value = a.slice(idx + 1);
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (value !== '' && !isNaN(Number(value)) && !/^\d+,\d+/.test(value)) value = Number(value);
        else if (value.includes(',')) value = value.split(',').map((s) => s.trim()).filter(Boolean);
        settingsLib.set(patch, path, value);
      }
      const updated = store.updateSettings(patch);
      const rescored = pipeline.rescore({ settings: updated });
      console.log(JSON.stringify(updated, null, 2));
      console.log(`\nПересчитано заказов: ${rescored.total}, изменено вердиктов: ${rescored.changed}`);
      break;
    }

    case 'get': {
      const v = settingsLib.get(store.getSettings(), args[0]);
      console.log(v === undefined ? '(нет такого параметра)' : JSON.stringify(v));
      break;
    }

    /* ------------------------------ whoami ----------------------------- */
    case 'whoami': {
      const list = await pipeline.checkAll();
      for (const s of list) {
        const mark = s.ok ? '✓' : '✗';
        console.log(`${mark} ${s.source.padEnd(16)} ${s.account || '—'} ${s.error || s.note || ''}`);
      }
      break;
    }

    /* ----------------------------- sources ----------------------------- */
    case 'sources': {
      const state = store.getSourceState();
      for (const s of sources.all()) {
        const st = state[s.id] || {};
        console.log(`${s.id.padEnd(16)} ${String(s.label).padEnd(20)} ${s.kind.padEnd(9)} auth:${s.needsAuth ? 'да ' : 'нет'} `
          + `заказов:${String(st.count ?? '—').padStart(4)} ${st.error ? 'ОШИБКА: ' + st.error : ''}`);
      }
      break;
    }

    /* ---------------------------- accounts ----------------------------- */
    case 'accounts': {
      const sub = args[0];
      if (sub === 'import') {
        const file = args[1];
        if (!file) { console.log('Укажи путь: hunter accounts import <file> [service]'); break; }
        try {
          const r = accounts.importCookieFile(file, { service: args[2] });
          console.log(`Импортировано в «${r.service}»: ${r.count} cookie, формат ${r.format}, домены: ${r.domains.join(', ') || '—'}`);
        } catch (e) {
          console.log('Ошибка: ' + e.message);
        }
        break;
      }
      if (sub === 'check') {
        const list = await pipeline.checkAll();
        for (const s of list) console.log(`${s.ok ? '✓' : '✗'} ${s.source.padEnd(16)} ${s.account || '—'} ${s.error || s.note || ''}`);
        break;
      }
      const list = accounts.list();
      if (!list.length) { console.log('Аккаунтов нет. Импортируй куки: hunter accounts import <file>'); break; }
      for (const a of list) {
        console.log(`${a.service.padEnd(16)} ${a.type.padEnd(10)} cookies:${String(a.cookieCount).padStart(3)} домены:${(a.domains || []).join(',') || a.domain || '—'} ${a.updatedAt ? new Date(a.updatedAt).toLocaleString('ru') : ''}`);
      }
      break;
    }

    /* ------------------------------ stats ------------------------------ */
    case 'stats': {
      const s = store.stats();
      console.log(`Всего заказов: ${s.total} | за 24ч: ${s.last24h} | за 7д: ${s.last7d}`);
      console.log(`Средняя цена: ${s.avgPrice ?? '—'} | откликов: ${s.applied} (сегодня ${s.appliedToday})`);
      console.log('\nПо вердиктам:', JSON.stringify(s.byVerdict));
      console.log('По источникам:');
      for (const [k, v] of Object.entries(s.bySource).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k.padEnd(16)} ${v}`);
      }
      break;
    }

    /* ----------------------------- rescore ----------------------------- */
    case 'rescore': {
      const r = pipeline.rescore();
      console.log(`Пересчитано ${r.total}, изменено вердиктов: ${r.changed}`);
      break;
    }

    /* ----------------------------- doctor ------------------------------ */
    case 'doctor': {
      console.log('Диагностика окружения:\n');
      console.log(` node            ${process.version}`);
      let playwright = 'нет';
      try { require('playwright'); playwright = 'установлен'; } catch { playwright = 'НЕ УСТАНОВЛЕН'; }
      console.log(` playwright       ${playwright}`);
      console.log(` python (tg)     ${require('fs').existsSync(require('../src/tg').PYTHON) ? require('../src/tg').PYTHON : 'НЕ НАЙДЕН (' + require('../src/tg').PYTHON + ')'}`);
      console.log(` каналов tg      ${tg.loadChannels().length}`);
      const accs = accounts.list();
      console.log(` аккаунтов       ${accs.length}${accs.length ? ' (' + accs.map((a) => a.service).join(', ') + ')' : ''}`);
      const st = store.getSourceState();
      const bad = Object.entries(st).filter(([, v]) => v.lastOk === false);
      console.log(` источников      ${sources.all().length}, с ошибками: ${bad.length}`);
      for (const [k, v] of bad) console.log(`   ! ${k}: ${v.error}`);
      const http = require('../src/core/http');
      const paused = http.pausedHosts();
      if (paused.length) {
        console.log(' хосты на паузе (защита от блокировки):');
        for (const p of paused) console.log(`   ⏸ ${p.host} — ещё ${Math.round((p.until - Date.now()) / 1000)} с (ошибок подряд: ${p.fails})`);
      }
      console.log(` заказов в базе  ${store.stats().total}`);
      break;
    }

    /* ------------------------------- init ------------------------------ */
    case 'init': {
      const name = args[0] || process.env.FH_PROFILE_NAME || '';
      const title = args[1] || process.env.FH_PROFILE_TITLE || 'Фрилансер';
      const skills = args[2] || process.env.FH_PROFILE_SKILLS || 'веб-разработка, javascript, python, автоматизация';
      store.updateSettings({
        profile: { name, title, skills, hourlyRate: 1500, experience: '', defaultDeadline: '2–3 дня' },
        search: {
          keywordsPlus: ['сайт', 'бот', 'парсинг', 'автоматизация', 'верстка', 'верстальщик',
            'telegram', 'api', 'интеграция', 'лендинг', 'wordpress', 'tilda', 'python', 'javascript',
            'разработка', 'дизайн', 'фронтенд', 'frontend', 'backend', 'crm'],
        },
      });
      console.log('Профиль и ключевые слова настроены.');
      console.log('Проверить: hunter settings  |  править: hunter init "Имя" "Должность" "навыки через запятую"');
      break;
    }

    /* ---------------------------- auto-apply --------------------------- */
    case 'auto-apply': {
      const r = await applyRunner.run({
        dryRun: has('dry') ? true : undefined,
        limit: flag('limit') ? Number(flag('limit')) : undefined,
        minScore: flag('score') ? Number(flag('score')) : undefined,
        services: flag('services') ? String(flag('services')).split(',') : undefined,
      });
      console.log(`Режим: ${r.dryRun ? 'dry run (без отправки)' : 'реальная отправка'} | лимит ${r.budget} | обработано ${r.processed}`);
      for (const x of r.results) {
        console.log(` ${x.ok ? '✓' : '✗'} ${x.source.padEnd(8)} ${(x.title || '').slice(0, 50).padEnd(52)} ${x.error || x.note || ''}`);
      }
      break;
    }

    /* -------------------------------- tg ------------------------------- */
    case 'tg': {
      const sub = args[0];
      if (sub === 'add') {
        const r = tg.addChannel(args[1], args[2]);
        console.log(r.ok ? `Канал добавлен: ${r.channel.name}` : 'Ошибка: ' + r.error);
      } else if (sub === 'rm') {
        const r = tg.removeChannel(args[1]);
        console.log(r.ok ? `Канал удалён: ${args[1]}` : 'Ошибка: ' + r.error);
      } else {
        for (const c of tg.loadChannels()) console.log(`${c.name.padEnd(24)} ${c.label} ${c.url}`);
      }
      break;
    }

    /* -------------------------------- AI -------------------------------- */
    case 'ai': {
      const sub = args[0];
      const aiLib = require('../src/core/ai');
      const aiProfile = require('../src/core/ai-profile');

      if (!sub || sub === 'help' || sub === '--help') {
        console.log('Команды AI:\n'
          + '  ai status                    статус ИИ и профиля\n'
          + '  ai providers                 список провайдеров\n'
          + '  ai use <id> [model]          выбрать провайдера\n'
          + '  ai add <name> <url> <key> [model]  добавить своего\n'
          + '  ai rm <id>                   удалить своего\n'
          + '  ai test [id]                 проверить связь\n'
          + '  ai resume <file>             разобрать резюме\n'
          + '  ai profile                   показать профиль\n'
          + '  ai match [--limit N]         оценить ленту по профилю\n'
          + '  ai ask "вопрос"              спросить ИИ\n'
          + '  ai improve <id> [текст]      переписать отклик');
        break;
      }

      if (sub === 'status') {
        const settings = store.getSettings();
        const p = aiProfile.activeProvider(settings);
        const prof = aiProfile.getProfile(settings);
        console.log(`ИИ: ${settings.ai?.enabled ? 'включён' : 'выключен'}`);
        console.log(`Провайдер: ${p ? `${p.name} (${p.id}) → ${p.baseURL}` : 'НЕ ВЫБРАН'}`);
        console.log(`Модель: ${settings.ai?.model || p?.model || '—'}`);
        console.log(`Профиль: ${prof ? `${prof.title} (навыков: ${prof.skills?.length || 0})` : 'НЕ РАЗОБРАН'}`);
        console.log(`Провайдеров доступно: ${aiLib.listProviders().length}`);
        break;
      }

      if (sub === 'providers') {
        const list = aiLib.listProviders();
        const active = aiProfile.activeProvider(store.getSettings());
        for (const p of list) {
          const mark = p.id === active?.id ? '→' : ' ';
          console.log(`${mark} ${p.id.padEnd(24)} ${String(p.name).slice(0, 26).padEnd(27)} ${p.type.padEnd(10)} ${p.apiKey ? 'ключ' : 'без ключа'} ${(p.models || []).slice(0, 3).join(',')}`);
        }
        console.log('\nСвой провайдер: hunter ai add <name> <baseURL> <apiKey> <model>');
        break;
      }

      if (sub === 'use') {
        const id = args[1];
        if (!id) { console.log('Укажи id провайдера: hunter ai use <id>'); break; }
        const p = aiLib.getProvider(id);
        if (!p) { console.log('Провайдер не найден: ' + id); break; }
        const model = args[2] || p.model;
        store.updateSettings({ ai: { providerId: id, model, enabled: true } });
        console.log(`Провайдер: ${p.name} (${id}), модель: ${model}`);
        break;
      }

      if (sub === 'add') {
        const [, name, baseURL, apiKey, model] = args;
        if (!baseURL) { console.log('Укажи: hunter ai add <name> <baseURL> <apiKey> [model]'); break; }
        const created = aiLib.addCustom({ name: name || 'Свой провайдер', baseURL, apiKey: apiKey || '', model: model || '' });
        console.log('Добавлен: ' + created.id);
        break;
      }

      if (sub === 'rm') {
        aiLib.removeCustom(args[1]);
        console.log('Удалён: ' + args[1]);
        break;
      }

      if (sub === 'test') {
        const id = args[1] || aiProfile.activeProvider(store.getSettings())?.id;
        const r = await aiLib.testProvider(id);
        console.log(r.ok ? `✓ ${id} — ${r.ms}ms — ${r.reply}` : `✗ ${id} — ${r.error}`);
        break;
      }

      if (sub === 'resume') {
        const file = args[1];
        if (!file) { console.log('Укажи файл: hunter ai resume <path>'); break; }
        const resumeLib = require('../src/core/resume');
        const parsed = resumeLib.parseResumeFile(file);
        console.log(`Файл: ${parsed.name} (${parsed.kind}, ${parsed.text.length} симв.)`);
        const settings = store.getSettings();
        const r = await aiProfile.analyzeResume(parsed.text, settings);
        aiProfile.saveProfile(r.profile, settings);
        console.log(`Модель: ${r.model}\n`);
        console.log(JSON.stringify(r.profile, null, 2));
        break;
      }

      if (sub === 'profile') {
        const prof = aiProfile.getProfile(store.getSettings());
        if (!prof) { console.log('Профиль не разобран. Сначала: hunter ai resume <файл>'); break; }
        console.log(JSON.stringify(prof, null, 2));
        break;
      }

      if (sub === 'match') {
        const settings = store.getSettings();
        const prof = aiProfile.getProfile(settings);
        if (!prof) { console.log('Сначала разбери резюме: hunter ai resume <файл>'); break; }
        const { items } = store.listJobs({ limit: Number(flag('limit')) || 30 });
        const { results } = await aiProfile.matchJobs(prof, items, settings);
        results.sort((a, b) => b.score - a.score);
        for (const r of results.slice(0, 25)) {
          const job = store.getJob(r.id);
          console.log(`[${String(r.score).padStart(3)}|${r.verdict.padEnd(8)}] ${(job?.title || r.id).slice(0, 52).padEnd(53)} ${(r.reasons || [])[0] || ''}`);
        }
        break;
      }

      if (sub === 'ask') {
        const settings = store.getSettings();
        const prof = aiProfile.getProfile(settings);
        if (!prof) { console.log('Сначала разбери резюме: hunter ai resume <файл>'); break; }
        const question = args.slice(1).join(' ') || 'Какие заказы мне взять?';
        const { items } = store.listJobs({ limit: settings.ai?.matchLimit || 40 });
        const r = await aiProfile.ask(prof, items, question, settings);
        console.log(r.text);
        break;
      }

      if (sub === 'improve') {
        const settings = store.getSettings();
        const prof = aiProfile.getProfile(settings);
        const job = findJob(args[1]);
        if (!job) { console.log('Заказ не найден: ' + args[1]); break; }
        const draft = args.slice(2).join(' ') || job.responseText || require('../src/respond').draftResponse(job, settings);
        const r = await aiProfile.improveResponse(job, prof, draft, settings);
        console.log(r.text);
        break;
      }

      console.log('Неизвестная подкоманда: ' + sub + '\n');
      console.log('Команды AI:\n'
        + '  ai status                    статус ИИ и профиля\n'
        + '  ai providers                 список провайдеров\n'
        + '  ai use <id> [model]          выбрать провайдера\n'
        + '  ai add <name> <url> <key> [model]  добавить своего\n'
        + '  ai rm <id>                   удалить своего\n'
        + '  ai test [id]                 проверить связь\n'
        + '  ai resume <file>             разобрать резюме\n'
        + '  ai profile                   показать профиль\n'
        + '  ai match [--limit N]         оценить ленту по профилю\n'
        + '  ai ask "вопрос"              спросить ИИ\n'
        + '  ai improve <id> [текст]      переписать отклик');
      break;
    }

    default:
      console.log(`freelance-hunter v2 — команды:

  poll [--source s] [--limit n]   опросить источники
  list [--source s] [--verdict v] [--status st] [--q текст] [--score N] [--min N] [--max N]
  show <id>                        карточка + черновик
  apply <id> [текст]              сохранить отклик
  status <id> <статус>             drafted|sent|applied|done|skipped
  settings                         текущие настройки
  set group.key=значение           изменить настройку (search.priceMin=5000)
  get group.key                    значение настройки
  whoami                           обзор аккаунтов на всех площадках
  sources                          список источников
  accounts                         список аккаунтов
  accounts import <file> [svc]     импорт cookie-файла
  accounts check                   проверить доступ ко всем сервисам
  stats                            статистика
  rescore                          пересчитать качество
  doctor                           диагностика окружения
  init [имя] [должность] [навыки]  быстрая настройка профиля
  auto-apply [--dry] [--limit N] [--score N] [--services flru,kwork]
  tg [add|rm]                      telegram-каналы
  ai status|providers|use|add|rm|test|resume|profile|match|ask|improve`);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
