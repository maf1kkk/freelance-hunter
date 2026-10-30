'use strict';
/* функциональный тест ИИ-модулей */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const ai = require(path.join(ROOT, 'src/core/ai.js'));
const aiProfile = require(path.join(ROOT, 'src/core/ai-profile.js'));
const store = require(path.join(ROOT, 'src/core/store.js'));
const resume = require(path.join(ROOT, 'src/core/resume.js'));

(async () => {
  const settings = store.getSettings();
  const providers = ai.listProviders();
  console.log('провайдеров найдено:', providers.length);

  // выбрать рабочий: пробуем openrouter/free, zai2/glm-4.5-flash, toptools
  const candidates = [
    ['oc:openrouter', 'openrouter/free'],
    ['oc:zai2', 'glm-4.5-flash'],
    ['oc:toptools5', 'Top-Tools-Ai'],
  ];
  let working = null;
  for (const [pid, model] of candidates) {
    const p = ai.getProvider(pid);
    if (!p) continue;
    const r = await ai.testProvider(pid);
    console.log(`  ${pid}/${model}: ${r.ok ? 'OK ' + r.ms + 'ms' : r.error}`);
    if (r.ok && !working) working = { id: pid, model };
  }
  if (!working) { console.log('нет рабочего провайдера'); process.exit(1); }

  store.updateSettings({ ai: { enabled: true, providerId: working.id, model: working.model } });
  const s2 = store.getSettings();

  // 1. разбор резюме
  const res = resume.parseResumeFile(path.join(ROOT, 'output/resume-test/resume.pdf'));
  console.log('\n=== разбор резюме ===');
  const a = await aiProfile.analyzeResume(res.text, s2);
  console.log('профиль:', JSON.stringify(a.profile, null, 1).slice(0, 900));

  // 2. подбор заказов
  console.log('\n=== подбор заказов ===');
  const { items } = store.listJobs({ limit: 30 });
  const m = await aiProfile.matchJobs(a.profile, items, s2);
  console.log('оценено:', m.results.length);
  m.results.slice(0, 5).forEach((r) => console.log(' ', r.score, r.verdict.padEnd(8), r.id, '|', (r.reasons || []).join('; ').slice(0, 90)));

  // 3. рекомендация
  console.log('\n=== рекомендация ===');
  const rec = await aiProfile.recommend(a.profile, items, s2, { question: 'Какие 3 заказа взять в первую очередь?' });
  console.log(rec.text.slice(0, 700));

  // 4. улучшение отклика
  console.log('\n=== улучшение отклика ===');
  const job = items[0];
  const draft = 'Здравствуйте! Готов взяться за ваш заказ. Срок 3 дня.';
  const imp = await aiProfile.improveResponse(job, a.profile, draft, s2);
  console.log(imp.text.slice(0, 500));
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
