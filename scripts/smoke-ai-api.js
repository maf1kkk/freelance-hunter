'use strict';
/* API smoke-тест AI-раздела */
const B = process.env.BASE || 'http://127.0.0.1:3410';

async function j(p, o) {
  const r = await fetch(B + p, o);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t.slice(0, 300) }; }
}
const post = (p, body) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

(async () => {
  const prov = await j('/api/ai/providers');
  console.log('провайдеров:', prov.items?.length, '| активен:', JSON.stringify(prov.active));

  const prof0 = await j('/api/ai/profile');
  if (!prof0.profile) {
    const fs = require('fs');
    const path = require('path');
    const text = fs.readFileSync(path.join(__dirname, '..', 'output/resume-test/resume.txt'), 'utf8');
    const r = await post('/api/ai/resume', { text });
    console.log('разбор резюме:', r.profile?.title, '| навыков:', r.profile?.skills?.length, r.error || '');
  }

  const prof = await j('/api/ai/profile');
  console.log('профиль:', prof.profile?.title, '| навыков:', prof.profile?.skills?.length);

  const m = await post('/api/ai/match', { limit: 20 });
  console.log('оценено:', m.count, '| топ:', (m.top || []).slice(0, 3).map((x) => `${x.id}=${x.score}/${x.verdict}`).join(', '));

  const a = await post('/api/ai/ask', { question: 'Один заказ, который стоит взять прямо сейчас?' });
  console.log('ответ ИИ:', (a.text || a.error || '').slice(0, 220).replace(/\n/g, ' | '));

  const imp = await post('/api/ai/improve', { id: (m.top || [])[0]?.id, text: 'Здравствуйте, готов взяться' });
  console.log('улучшенный отклик:', (imp.text || imp.error || '').slice(0, 260).replace(/\n/g, ' | '));
})();
