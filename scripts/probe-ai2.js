'use strict';
/* проверка конкретных провайдеров с реальным промптом */
const fs = require('fs');
const path = require('path');

const CFGS = [
  path.join(process.env.USERPROFILE, '.config', 'opencode', 'opencode.json'),
  'D:/opencode/config/opencode.json',
];
const all = {};
for (const c of CFGS) {
  try {
    const j = JSON.parse(fs.readFileSync(c, 'utf8'));
    for (const [name, p] of Object.entries(j.provider || {})) {
      if (p?.options?.apiKey && p?.options?.baseURL && !all[name]) {
        all[name] = { baseURL: p.options.baseURL, apiKey: p.options.apiKey, models: Object.keys(p.models || {}) };
      }
    }
  } catch { /* нет файла */ }
}

async function chat(name, model, prompt) {
  const p = all[name];
  if (!p) return `нет провайдера ${name}`;
  const url = `${p.baseURL.replace(/\/$/, '')}/chat/completions`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 120 }),
      signal: AbortSignal.timeout(45000),
    });
    const txt = await r.text();
    if (!r.ok) return `HTTP ${r.status}: ${txt.slice(0, 140).replace(/\s+/g, ' ')}`;
    const d = JSON.parse(txt);
    return `${Date.now() - t0}ms | ${String(d.choices?.[0]?.message?.content || '(пусто)').slice(0, 200).replace(/\s+/g, ' ')}`;
  } catch (e) { return 'ERR ' + String(e.message || e).slice(0, 100); }
}

(async () => {
  const prompt = 'Ответь строго одним предложением: что такое фриланс?';
  const tries = [
    ['openrouter', 'openrouter/free'],
    ['zai2', 'glm-4.5-flash'],
    ['zai', 'glm-4.7'],
    ['toptools5', 'Top-Tools-Ai'],
    ['toptools20', 'Top-Tools-Ai'],
    ['toptools30', 'Top-Tools-Ai'],
  ];
  for (const [n, m] of tries) {
    console.log(`${n}/${m}: ${await chat(n, m, prompt)}`);
  }
})();
