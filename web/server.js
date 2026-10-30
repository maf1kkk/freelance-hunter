#!/usr/bin/env node
'use strict';
/**
 * freelance-hunter Web — HTTP API + раздача UI.
 * Запуск: node web/server.js  → http://localhost:3410
 *
 * API:
 *   GET  /api/health
 *   GET  /api/stats
 *   GET  /api/sources
 *   POST /api/poll
 *   GET  /api/jobs?…             — лента с фильтрами
 *   GET  /api/jobs/:id           — карточка + черновик отклика
 *   POST /api/jobs/:id/status    — статус / заметки / звезда
 *   POST /api/jobs/:id/apply     — сохранить отклик
 *   GET  /api/settings  POST /api/settings  POST /api/settings/rescore
 *   GET  /api/profile   POST /api/profile
 *   GET  /api/accounts  POST /api/accounts/import  POST /api/accounts/check
 *   GET  /api/tg/channels  POST /api/tg/channels  DELETE /api/tg/channels/:name
 *   POST /api/apply/auto
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const engine = require('../src/engine');
const store = require('../src/core/store');
const pipeline = require('../src/core/pipeline');
const accounts = require('../src/core/accounts');
const sources = require('../src/sources');
const settingsLib = require('../src/core/settings');
const profileLib = require('../src/core/profile');
const aiProfile = require('../src/core/ai-profile');
const { draftResponse } = require('../src/respond');
const tg = require('../src/tg');

const PORT = process.env.PORT || 3410;
const ROOT = __dirname;
const applyRunner = require('../src/apply');

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function json(res, status, obj) { send(res, status, JSON.stringify(obj)); }

function parseJobId(raw) {
  if (!raw) return null;
  return decodeURIComponent(raw);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  const q = u.searchParams;

  try {
    /* ---------------- health / stats ---------------- */
    if (p === '/api/health') {
      return json(res, 200, { ok: true, tool: 'freelance-hunter', version: '2.0.0', sources: sources.all().length });
    }

    if (p === '/api/stats') {
      const http = require('../src/core/http');
      return json(res, 200, { ...store.stats(), sourceState: store.getSourceState(), pausedHosts: http.pausedHosts() });
    }

    if (p === '/api/sources') {
      const state = store.getSourceState();
      const list = sources.all().map((s) => ({
        id: s.id, label: s.label, kind: s.kind, needsAuth: s.needsAuth,
        enabled: s.enabled !== false,
        last: state[s.id] || null,
        account: accounts.get(s.id) ? { type: accounts.get(s.id).type } : null,
      }));
      return json(res, 200, { items: list });
    }

    /* ---------------- poll ---------------- */
    if (p === '/api/poll' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const only = Array.isArray(body.only) && body.only.length ? body.only : null;
      const r = await pipeline.pollAll({ only, limit: body.limit, settings: store.getSettings() });
      return json(res, 200, r);
    }

    /* ---------------- jobs ---------------- */
    if (p === '/api/jobs') {
      const filter = {
        status: q.get('status') || undefined,
        // важно: пустое значение («ничего не выбрано») ≠ отсутствие параметра
        source: q.has('source') ? q.get('source').split(',').filter(Boolean) : undefined,
        verdict: q.has('verdict') ? q.get('verdict').split(',').filter(Boolean) : undefined,
        minPrice: q.get('minPrice') ? Number(q.get('minPrice')) : undefined,
        maxPrice: q.get('maxPrice') ? Number(q.get('maxPrice')) : undefined,
        minScore: q.get('minScore') ? Number(q.get('minScore')) : undefined,
        sites: q.has('sites') ? q.get('sites').split(',').filter(Boolean) : undefined,
        q: q.get('q') || undefined,
        starred: q.get('starred') === '1',
        limit: Number(q.get('limit')) || 100,
        offset: Number(q.get('offset')) || 0,
        sort: q.get('sort') || undefined,
      };
      // пустой список источников/вердиктов = ничего не показываем
      if (Array.isArray(filter.source) && filter.source.length === 0) {
        return json(res, 200, { items: [], total: 0 });
      }
      if (Array.isArray(filter.verdict) && filter.verdict.length === 0) {
        return json(res, 200, { items: [], total: 0 });
      }
      const { items, total } = store.listJobs(filter);
      return json(res, 200, { items, total });
    }

    const jobMatch = p.match(/^\/api\/jobs\/([^/]+)(\/status|\/apply)?$/);
    if (jobMatch) {
      const id = parseJobId(jobMatch[1]);
      const item = store.getJob(id) || store.getJob(`alot:${id}`) || store.getJob(String(jobMatch[1]));
      if (!item) return json(res, 404, { error: 'заказ не найден' });

      if (req.method === 'GET') {
        const settings = store.getSettings();
        return json(res, 200, {
          ...item,
          draftResponse: draftResponse(item, settings),
          duplicates: (item.dedupe?.duplicates || []).map((d) => {
            const j = store.getJob(d.id);
            return { ...d, title: j?.title, quality: j?.quality };
          }),
        });
      }
      if (req.method === 'POST' && jobMatch[2] === '/status') {
        const body = JSON.parse(await readBody(req) || '{}');
        const updated = store.setJobStatus(item.id, body.status || 'watched', {
          responseText: body.responseText,
          notes: body.notes,
          starred: body.starred,
        });
        return json(res, 200, { ok: true, job: updated });
      }
      if (req.method === 'POST' && jobMatch[2] === '/apply') {
        const body = JSON.parse(await readBody(req) || '{}');
        const updated = store.setJobStatus(item.id, body.status || 'sent', {
          responseText: body.responseText || '', appliedAt: Date.now(),
        });
        return json(res, 200, { ok: true, job: updated });
      }
    }

    /* ---------------- settings ---------------- */
    if (p === '/api/settings') {
      if (req.method === 'GET') return json(res, 200, store.getSettings());
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const updated = store.updateSettings(body);
        const rescored = pipeline.rescore({ settings: updated });
        return json(res, 200, { settings: updated, rescored });
      }
    }
    if (p === '/api/settings/rescore' && req.method === 'POST') {
      return json(res, 200, pipeline.rescore());
    }
    if (p === '/api/settings/schema' && req.method === 'GET') {
      return json(res, 200, settingsLib.SCHEMA);
    }

    /* ---------------- profile ---------------- */
    if (p === '/api/profile') {
      if (req.method === 'GET') return json(res, 200, profileLib.load(store.getSettings()));
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        store.updateSettings({ profile: body });
        return json(res, 200, profileLib.load(store.getSettings()));
      }
    }

    /* ---------------- accounts ---------------- */
    if (p === '/api/accounts') {
      if (req.method === 'GET') return json(res, 200, { items: accounts.list() });
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        if (body.service && body.uid && body.s) {
          return json(res, 200, { ok: true, account: accounts.setAlotSession(body.uid, body.s) });
        }
        if (body.content) {
          return json(res, 200, { ok: true, result: accounts.importCookieString(body.content, body) });
        }
        return json(res, 400, { error: 'нужен content (содержимое cookie-файла) или uid+s' });
      }
    }
    if (p === '/api/accounts/import' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.path) return json(res, 400, { error: 'нужен путь к файлу' });
      try {
        const result = accounts.importCookieFile(body.path, { service: body.service, domain: body.domain });
        return json(res, 200, { ok: true, result });
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }
    if (p === '/api/accounts/check' && req.method === 'POST') {
      const only = body_safe(await readBody(req));
      const list = only.only ? await pipeline.checkAll() : await pipeline.checkAll();
      return json(res, 200, { items: list });
    }
    if (p === '/api/accounts/remove' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      accounts.remove(body.service);
      return json(res, 200, { ok: true });
    }

    /* ---------------- telegram channels ---------------- */
    if (p === '/api/tg/channels') {
      if (req.method === 'GET') return json(res, 200, { items: tg.loadChannels() });
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        return json(res, 200, tg.addChannel(body.name, body.label, body.url));
      }
    }
    const chMatch = p.match(/^\/api\/tg\/channels\/([^/]+)$/);
    if (chMatch && req.method === 'DELETE') {
      return json(res, 200, tg.removeChannel(decodeURIComponent(chMatch[1])));
    }

    /* ---------------- AI ---------------- */
    if (p === '/api/ai/providers' && req.method === 'GET') {
      const ai = require('../src/core/ai');
      const settings = store.getSettings();
      const active = aiProfile.activeProvider(settings);
      return json(res, 200, {
        items: ai.listProviders().map((x) => ai.publicInfo(x)),
        active: active ? { id: active.id, model: settings.ai?.model || active.model } : null,
        config: settings.ai || {},
      });
    }

    if (p === '/api/ai/provider' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const patch = { ai: {} };
      if (body.providerId !== undefined) patch.ai.providerId = body.providerId || null;
      if (body.model !== undefined) patch.ai.model = body.model || null;
      if (body.enabled !== undefined) patch.ai.enabled = Boolean(body.enabled);
      const updated = store.updateSettings(patch);
      return json(res, 200, { settings: updated.ai });
    }

    if (p === '/api/ai/provider/custom' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const ai = require('../src/core/ai');
      if (!body.baseURL) return json(res, 400, { error: 'нужен baseURL' });
      const created = ai.addCustom({
        name: body.name || 'Свой провайдер',
        type: body.type || 'openai',
        baseURL: body.baseURL,
        apiKey: body.apiKey || '',
        model: body.model || '',
      });
      return json(res, 200, { ok: true, provider: ai.publicInfo(created) });
    }

    const aiDel = p.match(/^\/api\/ai\/provider\/custom\/(.+)$/);
    if (aiDel && req.method === 'DELETE') {
      const ai = require('../src/core/ai');
      ai.removeCustom(decodeURIComponent(aiDel[1]));
      return json(res, 200, { ok: true });
    }

    if (p === '/api/ai/test' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const ai = require('../src/core/ai');
      const result = await ai.testProvider(body.providerId || aiProfile.activeProvider(store.getSettings())?.id);
      return json(res, 200, result);
    }

    if (p === '/api/ai/resume' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const resumeLib = require('../src/core/resume');
      let text = body.text || '';
      let name = 'вставленный текст';
      if (body.path) {
        const parsed = resumeLib.parseResumeFile(body.path);
        text = parsed.text; name = parsed.name;
      }
      if (!text || text.length < 20) return json(res, 400, { error: 'резюме пустое или слишком короткое' });
      const result = await aiProfile.analyzeResume(text, store.getSettings());
      aiProfile.saveProfile(result.profile, store.getSettings());
      return json(res, 200, { ok: true, profile: result.profile, source: name, model: result.model, raw: result.raw });
    }

    if (p === '/api/ai/resume/upload' && req.method === 'POST') {
      const resumeLib = require('../src/core/resume');
      const name = decodeURIComponent(q.get('name') || 'resume');
      const buf = await readBodyBuf(req);
      const parsed = resumeLib.parseResumeBuffer(buf, name);
      if (!parsed.text || parsed.text.length < 20) return json(res, 400, { error: 'не удалось извлечь текст из файла' });
      const result = await aiProfile.analyzeResume(parsed.text, store.getSettings());
      aiProfile.saveProfile(result.profile, store.getSettings());
      return json(res, 200, { ok: true, profile: result.profile, source: parsed.name, model: result.model });
    }

    if (p === '/api/ai/profile') {
      if (req.method === 'GET') {
        const settings = store.getSettings();
        return json(res, 200, { profile: aiProfile.getProfile(settings), updatedAt: settings.aiProfile?.updatedAt || null });
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const saved = aiProfile.saveProfile(body.profile || body, store.getSettings());
        return json(res, 200, { ok: true, profile: saved.aiProfile.profile });
      }
    }

    if (p === '/api/ai/match' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const settings = store.getSettings();
      const profile = aiProfile.getProfile(settings);
      if (!profile) return json(res, 400, { error: 'сначала разбери резюме' });
      const filter = {
        verdict: body.verdict ? String(body.verdict).split(',') : undefined,
        source: body.source ? String(body.source).split(',') : undefined,
        limit: body.limit || settings.ai?.matchLimit || 40,
      };
      const { items } = store.listJobs(filter);
      const { results } = await aiProfile.matchJobs(profile, items, settings);
      for (const r of results) {
        const job = store.getJob(r.id);
        if (job) store.updateJob(r.id, { aiMatch: { ...r, at: Date.now() } });
      }
      const ranked = results.slice().sort((a, b) => b.score - a.score);
      return json(res, 200, { ok: true, count: results.length, top: ranked.slice(0, 20) });
    }

    if (p === '/api/ai/ask' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const settings = store.getSettings();
      const profile = aiProfile.getProfile(settings);
      if (!profile) return json(res, 400, { error: 'сначала разбери резюме' });
      const { items } = store.listJobs({ limit: settings.ai?.matchLimit || 40 });
      const r = await aiProfile.ask(profile, items, body.question || 'Какие заказы мне взять?', settings);
      return json(res, 200, { ok: true, text: r.text, model: r.model });
    }

    if (p === '/api/ai/recommend' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const settings = store.getSettings();
      const profile = aiProfile.getProfile(settings);
      if (!profile) return json(res, 400, { error: 'сначала разбери резюме' });
      const { items } = store.listJobs({ limit: settings.ai?.matchLimit || 40 });
      const r = await aiProfile.recommend(profile, items, settings, { question: body.question });
      return json(res, 200, { ok: true, text: r.text, model: r.model });
    }

    if (p === '/api/ai/improve' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const settings = store.getSettings();
      const profile = aiProfile.getProfile(settings);
      const job = store.getJob(body.id) || store.getJob(`alot:${body.id}`);
      if (!job) return json(res, 404, { error: 'заказ не найден' });
      const draft = body.text || job.responseText || draftResponse(job, settings);
      const r = await aiProfile.improveResponse(job, profile, draft, settings);
      return json(res, 200, { ok: true, text: r.text, model: r.model });
    }

    /* ---------------- notify ---------------- */
    if (p === '/api/notify/check' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const notifyLib = require('../src/core/notify');
      const token = body.botToken || store.getSettings().notify?.botToken;
      return json(res, 200, await notifyLib.check({ botToken: token }));
    }

    /* ---------------- auto apply ---------------- */
    if (p === '/api/apply/auto' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const result = await applyRunner.run({ ...body, settings: store.getSettings() });
      return json(res, 200, result);
    }

    /* ---------------- static ---------------- */
    if (p === '/' || p === '/index.html') {
      try {
        return send(res, 200, fs.readFileSync(path.join(ROOT, 'index.html')), 'text/html; charset=utf-8');
      } catch {
        return json(res, 500, { error: 'index.html не найден' });
      }
    }
    if (p === '/app.js') {
      try {
        return send(res, 200, fs.readFileSync(path.join(ROOT, 'app.js')), 'application/javascript; charset=utf-8');
      } catch { /* нет файла — инлайн-скрипт */ }
    }
    if (p === '/style.css') {
      try {
        return send(res, 200, fs.readFileSync(path.join(ROOT, 'style.css')), 'text/css; charset=utf-8');
      } catch { /* нет файла — инлайн-стили */ }
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[api]', err);
    return json(res, 500, { error: String((err && err.message) || err) });
  }
});

function body_safe(str) {
  try { return JSON.parse(str || '{}'); } catch { return {}; }
}

/** Чтение бинарного тела (загрузка файла) */
function readBodyBuf(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => { chunks.push(c); if (chunks.reduce((a, b) => a + b.length, 0) > 20e6) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

server.listen(PORT, () => {
  console.log(`freelance-hunter web → http://localhost:${PORT}`);
  console.log(`источников подключено: ${sources.all().length}`);
});
