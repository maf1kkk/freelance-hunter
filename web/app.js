/* freelance-hunter — UI */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  tab: 'feed',
  jobs: [],
  total: 0,
  sources: [],
  settings: null,
  profile: null,
  filters: {
    q: '', verdicts: ['prime', 'good', 'meh', 'bad'],
    sources: null,           // null = все источники включены
    minPrice: '', maxPrice: '', minScore: '', starred: false, onlyNew: false,
  },
  current: null,
  autoTimer: null,
};

/* ------------------------------- utils ---------------------------------- */
async function api(path, opts) {
  const r = await fetch(path, opts);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = esc(msg);
  $('#toastHost').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function money(price) {
  if (!price || price.min == null) return '—';
  if (price.max && price.max !== price.min) return `${price.min}–${price.max} ${price.currency || ''}`.trim();
  return `${price.min} ${price.currency || ''}`.trim();
}

function ago(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч`;
  if (s < 2592000) return `${Math.floor(s / 86400)} дн`;
  return new Date(ts).toLocaleDateString('ru');
}

const VERDICT_LABEL = { prime: 'prime', good: 'good', meh: 'meh', bad: 'bad', blocked: 'blocked' };

/* ------------------------------- boot ----------------------------------- */
async function init() {
  bindUI();
  renderVerdictChips();
  await Promise.all([loadSettings(), loadSources()]);
  await loadJobs();
  await refreshHeader();
  setInterval(refreshHeader, 60000);
}

async function loadSettings() {
  state.settings = await api('/api/settings');
  state.profile = await api('/api/profile');
  fillSettingsForm();
}

async function loadSources() {
  const { items } = await api('/api/sources');
  state.sources = items;
  renderSourceFilters();
  $('#h-sources').textContent = `источников: ${items.length}`;
}

/** Отрисовка чипов вердиктов по состоянию (единственный источник истины) */
function renderVerdictChips() {
  $$('#f-verdicts .chip').forEach((c) => {
    c.classList.toggle('on', state.filters.verdicts.includes(c.dataset.v));
  });
}

function renderSourceFilters() {
  const host = $('#f-sources');
  const all = state.sources.map((s) => s.id);
  const active = state.filters.sources;   // null = включены все
  const isOn = (id) => active === null || active.includes(id);

  host.innerHTML = '';
  for (const s of state.sources) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer';
    row.innerHTML = `<input type="checkbox" value="${esc(s.id)}" ${isOn(s.id) ? 'checked' : ''}> ${esc(s.label)}`;
    row.querySelector('input').addEventListener('change', (e) => {
      const id = e.target.value;
      let next;
      if (e.target.checked) {
        // вернуть источник в выборку
        next = (active === null ? all.filter((x) => x !== id) : [...new Set([...active, id])]);
        if (next.length === all.length) next = null;   // снова включены все — фильтр не нужен
      } else {
        // исключить источник
        next = (active === null ? all.filter((x) => x !== id) : active.filter((x) => x !== id));
        if (!next.length) next = [];                   // пустая выборка = ничего не показываем
      }
      state.filters.sources = next;
      renderSourceFilters();
      loadJobs();
    });
    host.appendChild(row);
  }

  // кнопки быстрого выбора
  const bar = document.createElement('div');
  bar.className = 'row';
  bar.style.marginTop = '4px';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.className = 'sm';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };
  bar.appendChild(mk('все', () => { state.filters.sources = null; renderSourceFilters(); loadJobs(); }));
  bar.appendChild(mk('снять все', () => { state.filters.sources = []; renderSourceFilters(); loadJobs(); }));
  host.appendChild(bar);

  const count = active === null ? all.length : active.length;
  const info = document.createElement('div');
  info.className = 'hint';
  info.textContent = `выбрано источников: ${count} из ${all.length}`;
  host.appendChild(info);
}

/* ------------------------------ feed ------------------------------------ */
function buildQuery() {
  const f = state.filters;
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.verdicts.length) p.set('verdict', f.verdicts.join(','));
  // null = все источники (фильтр не передаём), [] = ничего не выбрано
  if (f.sources !== null) p.set('source', f.sources.join(','));
  if (f.minPrice !== '') p.set('minPrice', f.minPrice);
  if (f.maxPrice !== '') p.set('maxPrice', f.maxPrice);
  if (f.minScore !== '') p.set('minScore', f.minScore);
  if (f.starred) p.set('starred', '1');
  if (f.onlyNew) p.set('status', 'new');
  p.set('limit', '300');
  return p.toString();
}

async function loadJobs() {
  const list = $('#list');
  list.innerHTML = '<div class="empty">Загружаю…</div>';
  try {
    const { items, total } = await api(`/api/jobs?${buildQuery()}`);
    state.jobs = items;
    state.total = total;
    renderJobs();
    $('#count').textContent = `показано ${items.length} из ${total}`;
  } catch (e) {
    list.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`;
  }
}

function renderJobs() {
  const list = $('#list');
  if (!state.jobs.length) {
    list.innerHTML = '<div class="empty">Пусто. Обнови ленту или ослабь фильтры.</div>';
    return;
  }
  list.innerHTML = state.jobs.map((j) => {
    const q = j.quality || {};
    const v = q.verdict || 'bad';
    const cl = j.client || {};
    const bits = [];
    if (cl.rating != null) bits.push(`★ ${cl.rating}`);
    if (cl.reviews != null) bits.push(`${cl.reviews} отз.`);
    if (cl.orders != null) bits.push(`${cl.orders} зак.`);
    if (cl.hiredPercent != null) bits.push(`нанимал ${cl.hiredPercent}%`);
    if (cl.ageDays != null) bits.push(`${cl.ageDays} дн.`);
    if (j.stats?.responses != null) bits.push(`откликов ${j.stats.responses}`);
    if (j.stats?.views != null) bits.push(`просм. ${j.stats.views}`);

    const flags = (q.flags || []).slice(0, 3).map((f) => `<span class="badge flag">${esc(f)}</span>`).join(' ');
    const ai = j.aiMatch;
    const aiBadge = ai ? `<span class="badge ${ai.verdict === 'take' ? 'ok' : ai.verdict === 'skip' ? 'bad' : 'warn'}" title="Оценка ИИ">ИИ ${ai.score}</span>` : '';

    return `<div class="card ${esc(j.status || '')}" data-id="${esc(j.id)}">
      <div class="score ${esc(v)}">${q.score ?? '—'}<small>${esc(VERDICT_LABEL[v] || v)}</small></div>
      <div>
        <div class="ttl">${esc(j.title || '(без названия)')}</div>
        <div class="meta">
          <span class="badge src">${esc(j.sourceLabel || j.source)}</span>
          ${j.sites?.length ? `<span class="badge">${esc(j.sites.join(', '))}</span>` : ''}
          <span>${esc(ago(j.publishedAt))}</span>
          ${bits.map((b) => `<span>${esc(b)}</span>`).join('<span>·</span>')}
        </div>
        <div class="why">${(q.reasons || []).map(esc).join(' · ') || 'без оценки'} ${flags} ${aiBadge}</div>
      </div>
      <div class="right">
        <div class="price">${esc(money(j.price))}</div>
        <div style="margin-top:6px"><span class="star ${j.starred ? 'on' : ''}" data-star="${esc(j.id)}">★</span>
        <span class="badge">${esc(j.status || 'new')}</span></div>
      </div>
    </div>`;
  }).join('');

  $$('#list .card').forEach((c) => c.addEventListener('click', (e) => {
    if (e.target.dataset.star) {
      e.stopPropagation();
      toggleStar(e.target.dataset.star, e.target);
      return;
    }
    openJob(c.dataset.id);
  }));
}

async function toggleStar(id, el) {
  const job = state.jobs.find((j) => j.id === id);
  if (!job) return;
  const next = !job.starred;
  await api(`/api/jobs/${encodeURIComponent(id)}/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: job.status || 'new', starred: next }),
  });
  job.starred = next;
  el.classList.toggle('on', next);
  toast(next ? 'Добавлено в избранное' : 'Убрано из избранного');
}

/* ------------------------------ job card ------------------------------- */
async function openJob(id) {
  const dlg = $('#dlg');
  try {
    const j = await api(`/api/jobs/${encodeURIComponent(id)}`);
    state.current = j;
    const q = j.quality || {};
    const cl = j.client || {};

    $('#d-title').textContent = j.title || '(без названия)';
    $('#d-meta').innerHTML = [
      `<span class="badge src">${esc(j.sourceLabel || j.source)}</span>`,
      `<span class="price mono" style="color:var(--green);font-weight:600">${esc(money(j.price))}</span>`,
      `<span class="badge">${esc(ago(j.publishedAt))}</span>`,
      `<span class="badge">${esc(j.status || 'new')}</span>`,
      (q.score != null ? `<span class="badge ${q.verdict === 'prime' ? 'ok' : q.verdict === 'bad' ? 'bad' : 'warn'}">score ${q.score} · ${esc(q.verdict)}</span>` : ''),
    ].join(' ');

    const kv = [];
    const add = (k, v) => { if (v !== null && v !== undefined && v !== '') kv.push(`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`); };
    add('Клиент', cl.name);
    add('Рейтинг', cl.rating);
    add('Отзывов', cl.reviews);
    add('Заказов', cl.orders);
    add('Нанимал, %', cl.hiredPercent);
    add('Аккаунт, дней', cl.ageDays);
    add('Верифицирован', cl.verified ? 'да' : null);
    add('Откликов', j.stats?.responses);
    add('Просмотров', j.stats?.views);
    add('Биржа', (j.sites || []).join(', '));
    add('Категория', (j.category || []).join(', '));
    add('Дедлайн', j.deadline ? new Date(j.deadline).toLocaleString('ru') : null);
    add('Тип', j.employmentType);
    add('Локация', j.location);
    $('#d-kv').innerHTML = kv.join('') || '<dt>—</dt><dd>нет данных</dd>';

    const parts = q.parts || {};
    const partNames = { client: 'клиент', content: 'содержание', price: 'цена', competition: 'конкуренция', fresh: 'свежесть', penalty: 'штраф' };
    $('#d-parts').innerHTML = Object.entries(partNames)
      .map(([k, v]) => `<span class="part">${esc(v)} <b>${(parts[k] ?? 0) > 0 ? '+' : ''}${Math.round(parts[k] ?? 0)}</b></span>`)
      .join('');
    $('#d-reasons').innerHTML = (q.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')
      || '<li>нет пояснений</li>';

    $('#d-body').textContent = (j.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '(нет описания)';
    $('#d-response').value = j.responseText || j.draftResponse || '';
    $('#d-link').href = j.url || '#';

    const dupes = j.duplicates || [];
    $('#d-dupes').hidden = !dupes.length;
    $('#d-dupes-list').innerHTML = dupes.map((d) => `
      <div class="meta" style="margin-bottom:4px">
        <span class="badge src">${esc(d.source)}</span>
        ${esc(d.title || d.id)}
        ${d.quality ? `<span class="badge">score ${d.quality.score}</span>` : ''}
      </div>`).join('');

    $('#d-star').textContent = j.starred ? '★ Убрать из избранного' : '★ В избранное';
    dlg.showModal();
  } catch (e) {
    toast('Не удалось открыть заказ: ' + e.message, 'err');
  }
}

async function redraft() {
  if (!state.current) return;
  const j = await api(`/api/jobs/${encodeURIComponent(state.current.id)}`);
  $('#d-response').value = j.draftResponse || '';
  toast('Черновик перегенерирован');
}

async function saveJob(status) {
  if (!state.current) return;
  const text = $('#d-response').value;
  try {
    await api(`/api/jobs/${encodeURIComponent(state.current.id)}/${status === 'applied' ? 'apply' : 'status'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responseText: text, status: status === 'applied' ? 'sent' : status }),
    });
    toast('Сохранено', 'ok');
    $('#dlg').close();
    await loadJobs();
  } catch (e) {
    toast('Ошибка: ' + e.message, 'err');
  }
}

/* ----------------------------- kanban ---------------------------------- */
const KANBAN_COLS = [
  { key: 'new', title: 'Новые' },
  { key: 'drafted', title: 'Черновик' },
  { key: 'sent', title: 'Отправлено' },
  { key: 'applied', title: 'Отклик' },
  { key: 'done', title: 'Готово' },
];

async function renderKanban() {
  const { items } = await api('/api/jobs?limit=800');
  const host = $('#kanban');
  host.innerHTML = KANBAN_COLS.map((col) => {
    const list = items.filter((j) => (j.status || 'new') === col.key).slice(0, 40);
    return `<div class="kcol">
      <h3>${esc(col.title)} <span>${list.length}</span></h3>
      ${list.map((j) => `<div class="kcard" data-id="${esc(j.id)}">
        <div>${esc((j.title || '').slice(0, 80))}</div>
        <div class="m">${esc(j.sourceLabel || j.source)} · ${esc(money(j.price))} · ${j.quality?.score ?? '—'}</div>
      </div>`).join('') || '<div class="empty" style="padding:16px 0">пусто</div>'}
    </div>`;
  }).join('');
  $$('#kanban .kcard').forEach((c) => c.addEventListener('click', () => openJob(c.dataset.id)));
}

/* ---------------------------- accounts --------------------------------- */
async function loadAccounts() {
  const [{ items: accs }, { items: chans }] = await Promise.all([
    api('/api/accounts'), api('/api/tg/channels'),
  ]);

  $('#accTable').innerHTML = `<tr><th>Сервис</th><th>Тип</th><th>Куки</th><th>Обновлён</th><th></th></tr>` + accs.map((a) => `
    <tr>
      <td>${esc(a.service)}</td>
      <td class="mono">${esc(a.type)}</td>
      <td class="mono">${a.cookieCount || '—'}</td>
      <td class="mono">${a.updatedAt ? new Date(a.updatedAt).toLocaleString('ru') : '—'}</td>
      <td><button class="sm danger" data-del-acc="${esc(a.service)}">удалить</button></td>
    </tr>`).join('');

  $$('#accTable [data-del-acc]').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/accounts/remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: b.dataset.delAcc }),
    });
    toast('Аккаунт удалён');
    loadAccounts();
  }));

  $('#tgTable').innerHTML = `<tr><th>Канал</th><th>Подпись</th><th>Ссылка</th><th></th></tr>` + chans.map((c) => `
    <tr>
      <td class="mono">${esc(c.name)}</td>
      <td>${esc(c.label)}</td>
      <td><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a></td>
      <td><button class="sm danger" data-del-tg="${esc(c.name)}">удалить</button></td>
    </tr>`).join('');

  $$('#tgTable [data-del-tg]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/tg/channels/${encodeURIComponent(b.dataset.delTg)}`, { method: 'DELETE' });
    toast('Канал удалён');
    loadAccounts();
  }));
}

async function checkAccounts() {
  const btn = $('#accCheck');
  btn.disabled = true; btn.textContent = 'Проверяю…';
  try {
    const { items } = await api('/api/accounts/check', { method: 'POST' });
    $('#accTable').innerHTML = `<tr><th>Сервис</th><th>Статус</th><th>Аккаунт</th><th>Комментарий</th></tr>` + items.map((a) => `
      <tr>
        <td>${esc(a.label)}</td>
        <td><span class="badge ${a.ok ? 'ok' : 'bad'}">${a.ok ? 'доступен' : 'нет доступа'}</span></td>
        <td class="mono">${esc(a.account || (a.hasCredentials ? 'есть' : '—'))}</td>
        <td class="mono" style="color:var(--muted)">${esc(a.note || a.error || '')}</td>
      </tr>`).join('');
    toast('Проверка завершена', 'ok');
  } catch (e) {
    toast('Ошибка: ' + e.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Проверить все';
  }
}

async function importCookies(raw) {
  const path = $('#accPath').value.trim();
  const service = $('#accService').value;
  if (!path) { toast('Укажи путь к файлу', 'err'); return; }
  try {
    const { result } = await api('/api/accounts/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, service: service || undefined }),
    });
    toast(`Импортировано в «${result.service}» (${result.count} cookie, формат ${result.format})`, 'ok');
    loadAccounts();
  } catch (e) {
    toast('Ошибка импорта: ' + e.message, 'err');
  }
}

async function importCookiesRaw() {
  const content = $('#accRaw').value.trim();
  const service = $('#accService').value;
  if (!content) { toast('Вставьте cookies', 'err'); return; }
  try {
    const { result } = await api('/api/accounts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, service: service || undefined }),
    });
    toast(`Импортировано в «${result.service}» (${result.count} cookie)`, 'ok');
    $('#accRaw').value = '';
    loadAccounts();
  } catch (e) {
    toast('Ошибка импорта: ' + e.message, 'err');
  }
}

/* ----------------------------- settings -------------------------------- */
function fillSettingsForm() {
  const s = state.settings || {};
  const sr = s.search || {};
  const q = s.quality || {};
  const a = s.apply || {};
  $('#s-plus').value = (sr.keywordsPlus || []).join(', ');
  $('#s-minus').value = (sr.keywordsMinus || []).join(', ');
  $('#s-pmin').value = sr.priceMin ?? '';
  $('#s-pmax').value = sr.priceMax ?? '';
  $('#s-sites').value = (sr.sites || []).join(', ');
  $('#s-poll').value = s.poll?.minutes ?? 5;
  $('#q-rating').value = q.minClientRating ?? 0;
  $('#q-reviews').value = q.minClientReviews ?? 0;
  $('#q-resp').value = q.maxResponses ?? 50;
  $('#q-rate').value = q.minSalaryPerHour ?? '';
  $('#q-block').value = (q.blockWords || []).join(', ');
  $('#a-enabled').checked = !!a.enabled;
  $('#a-dry').checked = a.dryRun !== false;
  $('#a-limit').value = a.dailyLimit ?? 5;
  $('#a-score').value = a.minScore ?? 80;
  $('#a-services').value = (a.services || []).join(', ');

  const n = s.notify || {};
  $('#n-enabled').checked = !!n.telegram;
  $('#n-token').value = n.botToken || '';
  $('#n-chat').value = n.chatId || '';
  $('#n-score').value = n.minScore ?? 70;
  $('#n-verdicts').value = (n.verdicts || ['prime', 'good']).join(', ');

  const p = state.profile || {};
  $('#p-name').value = p.name || '';
  $('#p-title').value = p.title || '';
  $('#p-skills').value = p.skills || '';
  $('#p-rate').value = p.hourlyRate ?? '';
  $('#p-exp').value = p.experience || '';
  $('#p-contacts').value = p.contacts || '';
}

function readSettingsForm() {
  const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
  const num = (v) => (v === '' ? null : Number(v));
  return {
    search: {
      keywordsPlus: list($('#s-plus').value),
      keywordsMinus: list($('#s-minus').value),
      priceMin: num($('#s-pmin').value),
      priceMax: num($('#s-pmax').value),
      sites: list($('#s-sites').value),
    },
    quality: {
      minClientRating: Number($('#q-rating').value) || 0,
      minClientReviews: Number($('#q-reviews').value) || 0,
      maxResponses: Number($('#q-resp').value) || 50,
      minSalaryPerHour: num($('#q-rate').value),
      blockWords: list($('#q-block').value),
    },
    poll: { minutes: Number($('#s-poll').value) || 5 },
    apply: {
      enabled: $('#a-enabled').checked,
      dryRun: $('#a-dry').checked,
      dailyLimit: Number($('#a-limit').value) || 5,
      minScore: Number($('#a-score').value) || 80,
      services: list($('#a-services').value),
    },
    notify: {
      telegram: $('#n-enabled').checked,
      botToken: $('#n-token').value.trim() || null,
      chatId: $('#n-chat').value.trim() || null,
      minScore: Number($('#n-score').value) || 70,
      verdicts: list($('#n-verdicts').value),
    },
  };
}

async function saveSettings(rescore) {
  try {
    const body = readSettingsForm();
    const r = await api('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    state.settings = r.settings;
    toast(rescore ? `Сохранено, пересчитано ${r.rescored?.changed ?? 0}` : 'Сохранено', 'ok');
    await loadJobs();
    await refreshHeader();
  } catch (e) {
    toast('Ошибка: ' + e.message, 'err');
  }
}

async function saveProfile() {
  const body = {
    name: $('#p-name').value, title: $('#p-title').value, skills: $('#p-skills').value,
    hourlyRate: $('#p-rate').value ? Number($('#p-rate').value) : null,
    experience: $('#p-exp').value, contacts: $('#p-contacts').value,
  };
  try {
    state.profile = await api('/api/profile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    toast('Профиль сохранён', 'ok');
  } catch (e) {
    toast('Ошибка: ' + e.message, 'err');
  }
}

/* ------------------------------ stats ---------------------------------- */
async function renderStats() {
  const st = await api('/api/stats');
  const cards = [
    ['Всего заказов', st.total],
    ['За 24 часа', st.last24h],
    ['За 7 дней', st.last7d],
    ['Prime', st.byVerdict.prime || 0],
    ['Good', st.byVerdict.good || 0],
    ['Средняя цена', st.avgPrice ? st.avgPrice + ' ₽' : '—'],
    ['Откликов отправлено', st.applied],
    ['Сегодня откликов', st.appliedToday],
  ];
  $('#statGrid').innerHTML = cards.map(([l, v]) => `<div class="stat"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join('');

  const max = Math.max(1, ...Object.values(st.bySource));
  $('#statSrc').innerHTML = `<tr><th>Источник</th><th>Заказов</th><th></th></tr>` + Object.entries(st.bySource)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${v}</td><td><div class="bar"><i style="width:${Math.round(v / max * 100)}%"></i></div></td></tr>`).join('');

  $('#statState').innerHTML = `<tr><th>Источник</th><th>Последний опрос</th><th>Заказов</th><th>Ошибка</th></tr>` + Object.entries(st.sourceState || {})
    .map(([k, v]) => `<tr>
      <td>${esc(k)}</td>
      <td class="mono">${v.at ? new Date(v.at).toLocaleString('ru') : '—'}</td>
      <td class="mono">${v.count ?? '—'}</td>
      <td class="mono" style="color:${v.lastOk === false ? 'var(--red)' : 'var(--muted)'}">${esc(v.error || (v.lastOk ? 'ок' : ''))}</td>
    </tr>`).join('');
}

/* ----------------------------- header ---------------------------------- */
async function refreshHeader() {
  try {
    const st = await api('/api/stats');
    $('#h-jobs').textContent = `заказов: ${st.total}`;
    $('#h-prime').textContent = `prime: ${st.byVerdict.prime || 0} · good: ${st.byVerdict.good || 0}`;
  } catch { /* тихо */ }
  try {
    const { items } = await api('/api/accounts');
    const ok = items.filter((a) => a.hasValue).length;
    const el = $('#h-account');
    el.innerHTML = `<span class="dot ${ok ? 'ok' : 'warn'}"></span>аккаунтов: ${ok}`;
  } catch { /* тихо */ }
}

/* ------------------------------- poll ----------------------------------- */
async function poll() {
  const btn = $('#pollBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spin">⟳</span> Собираю…';
  try {
    const r = await api('/api/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const bad = r.sources.filter((s) => !s.ok);
    toast(`Заказов: ${r.fetched}, новых: ${r.added}${bad.length ? `, ошибок источников: ${bad.length}` : ''}`, bad.length ? '' : 'ok');
    await loadJobs();
    await refreshHeader();
  } catch (e) {
    toast('Ошибка опроса: ' + e.message, 'err');
  } finally {
    btn.disabled = false; btn.innerHTML = '⟳ Обновить ленту';
  }
}

/* ------------------------------- AI ------------------------------------- */
let aiProviders = [];
let aiActiveId = null;

async function loadAiProviders() {
  try {
    const data = await api('/api/ai/providers');
    aiProviders = data.items || [];
    aiActiveId = data.active?.id || null;
    const sel = $('#aiProvider');
    sel.innerHTML = aiProviders.map((p) => {
      const label = p.name + (p.source === 'opencode' ? ` (из opencode: ${p.group})` : ' (свой)');
      const models = p.models?.length ? ` — ${p.models.slice(0, 4).join(', ')}` : '';
      return `<option value="${esc(p.id)}" ${p.id === aiActiveId ? 'selected' : ''}>${esc(label + models)}</option>`;
    }).join('') || '<option value="">— нет провайдеров —</option>';

    const cur = aiProviders.find((p) => p.id === aiActiveId);
    $('#aiModel').value = data.active?.model || cur?.model || '';
    $('#aiProviderInfo').textContent = cur
      ? `Активен: ${cur.name} · ${cur.baseURL} · ${cur.hasKey ? 'ключ есть' : 'БЕЗ КЛЮЧА (для локальных не нужен)'}`
      : 'Активный провайдер не выбран';

    $('#aiProvidersTable').innerHTML = `<tr><th>Название</th><th>Тип</th><th>Base URL</th><th>Модели</th><th>Ключ</th><th></th></tr>`
      + aiProviders.map((p) => `<tr>
        <td>${esc(p.name)}<div class="hint">${esc(p.id)}</div></td>
        <td class="mono">${esc(p.type)}</td>
        <td class="mono" style="font-size:11px">${esc(p.baseURL)}</td>
        <td class="mono" style="font-size:11px">${esc((p.models || []).slice(0, 6).join(', ') || '—')}</td>
        <td>${p.hasKey ? '<span class="badge ok">есть</span>' : '<span class="badge">нет</span>'}</td>
        <td class="row" style="gap:4px">
          <button class="sm" data-ai-use="${esc(p.id)}">выбрать</button>
          <button class="sm" data-ai-test="${esc(p.id)}">тест</button>
          ${p.source === 'custom' ? `<button class="sm danger" data-ai-del="${esc(p.id)}">✕</button>` : ''}
        </td></tr>`).join('');

    $$('#aiProvidersTable [data-ai-use]').forEach((b) => b.addEventListener('click', async () => {
      await api('/api/ai/provider', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: b.dataset.aiUse }),
      });
      toast('Провайдер выбран', 'ok');
      loadAiProviders();
    }));
    $$('#aiProvidersTable [data-ai-test]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = '...';
      const r = await api('/api/ai/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: b.dataset.aiTest }),
      });
      toast(r.ok ? `Работает (${r.ms}ms): ${r.reply}` : `Ошибка: ${r.error}`, r.ok ? 'ok' : 'err');
      b.disabled = false; b.textContent = 'тест';
    }));
    $$('#aiProvidersTable [data-ai-del]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/ai/provider/custom/${encodeURIComponent(b.dataset.aiDel)}`, { method: 'DELETE' });
      toast('Провайдер удалён');
      loadAiProviders();
    }));
  } catch (e) { toast('Не удалось загрузить провайдеров: ' + e.message, 'err'); }
}

async function saveAiProvider() {
  const providerId = $('#aiProvider').value;
  const model = $('#aiModel').value.trim();
  await api('/api/ai/provider', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, model, enabled: true }),
  });
  toast('Провайдер сохранён', 'ok');
  loadAiProviders();
}

async function addCustomProvider() {
  const body = {
    name: $('#aiCName').value.trim() || 'Свой провайдер',
    type: $('#aiCType').value,
    baseURL: $('#aiCBase').value.trim(),
    apiKey: $('#aiCKey').value.trim(),
    model: $('#aiCModel').value.trim(),
  };
  if (!body.baseURL) { toast('Укажи Base URL', 'err'); return; }
  try {
    await api('/api/ai/provider/custom', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    toast('Провайдер добавлен', 'ok');
    $('#aiCKey').value = '';
    loadAiProviders();
  } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
}

function fillProfileForm(p) {
  if (!p) return;
  $('#aiProfileBox').hidden = false;
  $('#ap-name').value = p.name || '';
  $('#ap-title').value = p.title || '';
  $('#ap-summary').value = p.summary || '';
  $('#ap-skills').value = (p.skills || []).join(', ');
  $('#ap-stack').value = (p.stack || []).join(', ');
  $('#ap-exp').value = (p.experience || []).join(', ');
  $('#ap-cats').value = (p.categories || []).join(', ');
  $('#ap-rate').value = p.hourlyRate ?? '';
  $('#ap-budget').value = p.minBudget ?? '';
  $('#ap-learn').value = (p.willingToLearn || []).join(', ');
  $('#ap-red').value = (p.redFlags || []).join(', ');
  $('#ap-contacts').value = p.contacts || '';
}

async function loadAiProfile() {
  try {
    const { profile } = await api('/api/ai/profile');
    if (profile) fillProfileForm(profile);
  } catch { /* нет профиля */ }
}

async function uploadResume() {
  const f = $('#aiResumeFile').files[0];
  if (!f) { toast('Выбери файл', 'err'); return; }
  const btn = $('#aiUploadResume');
  btn.disabled = true; btn.textContent = 'Разбираю…';
  try {
    const buf = await f.arrayBuffer();
    const r = await fetch(`/api/ai/resume/upload?name=${encodeURIComponent(f.name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'ошибка');
    fillProfileForm(data.profile);
    $('#aiProfileModel').textContent = data.model || '';
    toast(`Резюме разобрано (${data.source})`, 'ok');
  } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = 'Загрузить и разобрать'; }
}

async function analyzeText() {
  const text = $('#aiResumeText').value.trim();
  if (text.length < 20) { toast('Вставь текст резюме', 'err'); return; }
  const btn = $('#aiAnalyzeText');
  btn.disabled = true; btn.textContent = 'Разбираю…';
  try {
    const data = await api('/api/ai/resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    fillProfileForm(data.profile);
    $('#aiProfileModel').textContent = data.model || '';
    toast('Резюме разобрано', 'ok');
  } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = 'Разобрать текст'; }
}

async function saveAiProfile() {
  const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
  const profile = {
    name: $('#ap-name').value.trim(),
    title: $('#ap-title').value.trim(),
    summary: $('#ap-summary').value.trim(),
    skills: list($('#ap-skills').value),
    stack: list($('#ap-stack').value),
    experience: list($('#ap-exp').value),
    categories: list($('#ap-cats').value),
    hourlyRate: Number($('#ap-rate').value) || null,
    minBudget: Number($('#ap-budget').value) || null,
    willingToLearn: list($('#ap-learn').value),
    redFlags: list($('#ap-red').value),
    contacts: $('#ap-contacts').value.trim(),
  };
  await api('/api/ai/profile', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile }),
  });
  $('#aiProfileSaved').textContent = 'сохранено ' + new Date().toLocaleTimeString('ru');
  toast('Профиль сохранён', 'ok');
}

async function aiMatchFeed() {
  const btn = $('#aiMatch');
  btn.disabled = true; btn.textContent = 'Оцениваю…';
  $('#aiMatchInfo').textContent = 'ИИ смотрит заказы…';
  try {
    const data = await api('/api/ai/match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    $('#aiMatchInfo').textContent = `оценено ${data.count}`;
    $('#aiMatchTable').innerHTML = `<tr><th>score</th><th>вердикт</th><th>заказ</th><th>почему</th><th>риск</th></tr>`
      + (data.top || []).map((r) => {
        const job = state.jobs.find((j) => j.id === r.id);
        return `<tr>
          <td class="mono"><b>${r.score}</b></td>
          <td><span class="badge ${r.verdict === 'take' ? 'ok' : r.verdict === 'skip' ? 'bad' : 'warn'}">${esc(r.verdict)}</span></td>
          <td>${job ? `<a href="#" data-ai-job="${esc(r.id)}">${esc((job.title || '').slice(0, 60))}</a>` : esc(r.id)}<div class="hint">${esc(r.id)}</div></td>
          <td style="font-size:12px">${(r.reasons || []).map(esc).join('<br>')}</td>
          <td style="font-size:12px;color:var(--orange)">${esc(r.risk || '')}</td>
        </tr>`;
      }).join('');
    $$('#aiMatchTable [data-ai-job]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      openJob(a.dataset.aiJob);
    }));
    toast(`ИИ оценил ${data.count} заказов`, 'ok');
    await loadJobs();
  } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = 'Оценить ленту'; }
}

async function aiAsk(question) {
  const q = (question !== undefined ? question : $('#aiQuestion').value).trim();
  if (!q) { toast('Напиши вопрос', 'err'); return; }
  const box = $('#aiAnswer');
  box.style.display = 'block';
  box.innerHTML = 'Думаю…';
  try {
    const data = await api('/api/ai/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q }),
    });
    box.innerHTML = esc(data.text).replace(/\n/g, '<br>');
  } catch (e) { box.innerHTML = 'Ошибка: ' + esc(e.message); }
}

async function aiRecommend() {
  const btn = $('#aiRecommend');
  btn.disabled = true; btn.textContent = 'Думаю…';
  await aiAsk('Какие заказы мне стоит взять в первую очередь и почему? Что пропустить?');
  btn.disabled = false; btn.textContent = 'Что взять?';
}

async function aiImproveResponse() {
  if (!state.current) return;
  const btn = $('#d-ai-improve');
  btn.disabled = true; btn.textContent = 'Улучшаю…';
  try {
    const data = await api('/api/ai/improve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.current.id, text: $('#d-response').value }),
    });
    $('#d-response').value = data.text;
    toast('Отклик переписан', 'ok');
  } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = 'Улучшить отклик (ИИ)'; }
}

async function aiEvalJob() {
  if (!state.current) return;
  const box = $('#d-ai-box');
  box.hidden = false;
  $('#d-ai-content').innerHTML = 'Оцениваю…';
  try {
    const data = await api('/api/ai/match', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 60 }),
    });
    const r = (data.top || []).find((x) => x.id === state.current.id);
    $('#d-ai-content').innerHTML = r
      ? `<div><b>score ${r.score}</b> · ${esc(r.verdict)}</div><ul>${(r.reasons || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
        + (r.risk ? `<div style="color:var(--orange)">Риск: ${esc(r.risk)}</div>` : '')
      : 'ИИ не оценил этот заказ (возможно, он вне выборки).';
  } catch (e) { $('#d-ai-content').innerHTML = 'Ошибка: ' + esc(e.message); }
}

/* ------------------------------- tabs ----------------------------------- */
function switchTab(tab) {
  state.tab = tab;
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  ['feed', 'kanban', 'ai', 'accounts', 'settings', 'stats'].forEach((t) => { $(`#tab-${t}`).hidden = t !== tab; });
  if (tab === 'kanban') renderKanban();
  if (tab === 'ai') { loadAiProviders(); loadAiProfile(); }
  if (tab === 'accounts') loadAccounts();
  if (tab === 'stats') renderStats();
}

/* ------------------------------ binding --------------------------------- */
function bindUI() {
  $('#pollBtn').addEventListener('click', poll);
  $('#rescoreBtn').addEventListener('click', async () => {
    const r = await api('/api/settings/rescore', { method: 'POST' });
    toast(`Пересчитано ${r.total} заказов, изменено ${r.changed}`, 'ok');
    await loadJobs();
  });

  $$('#tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  let t = null;
  $('#f-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.filters.q = $('#f-q').value.trim(); loadJobs(); }, 350); });
  ['f-min', 'f-max', 'f-score'].forEach((id) => $('#' + id).addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.filters.minPrice = $('#f-min').value;
      state.filters.maxPrice = $('#f-max').value;
      state.filters.minScore = $('#f-score').value;
      loadJobs();
    }, 400);
  }));
  $('#f-starred').addEventListener('change', (e) => { state.filters.starred = e.target.checked; loadJobs(); });
  $('#f-new').addEventListener('change', (e) => { state.filters.onlyNew = e.target.checked; loadJobs(); });

  $$('#f-verdicts .chip').forEach((c) => c.addEventListener('click', () => {
    const v = c.dataset.v;
    const on = !state.filters.verdicts.includes(v);
    state.filters.verdicts = on
      ? [...new Set([...state.filters.verdicts, v])]
      : state.filters.verdicts.filter((x) => x !== v);
    renderVerdictChips();
    loadJobs();
  }));

  $('#f-reset').addEventListener('click', () => {
    state.filters = { q: '', verdicts: ['prime', 'good', 'meh', 'bad'], sources: null, minPrice: '', maxPrice: '', minScore: '', starred: false, onlyNew: false };
    $('#f-q').value = ''; $('#f-min').value = ''; $('#f-max').value = ''; $('#f-score').value = '';
    $('#f-starred').checked = false; $('#f-new').checked = false;
    renderVerdictChips();
    renderSourceFilters();
    loadJobs();
  });

  $('#d-redraft').addEventListener('click', redraft);
  $('#d-save').addEventListener('click', () => saveJob('watched'));
  $('#d-sent').addEventListener('click', () => saveJob('applied'));
  $('#d-star').addEventListener('click', async () => {
    if (!state.current) return;
    await toggleStar(state.current.id, { classList: { toggle: () => {} }, dataset: {} });
    $('#d-star').textContent = state.current.starred ? '★ Убрать из избранного' : '★ В избранное';
  });

  $('#accCheck').addEventListener('click', checkAccounts);
  $('#accImport').addEventListener('click', importCookies);
  $('#accImportRaw').addEventListener('click', importCookiesRaw);
  $('#tgAdd').addEventListener('click', async () => {
    const name = $('#tgName').value.trim();
    if (!name) return;
    const r = await api('/api/tg/channels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, label: $('#tgLabel').value.trim() }),
    });
    if (r.ok) { toast('Канал добавлен', 'ok'); $('#tgName').value = ''; $('#tgLabel').value = ''; loadAccounts(); }
    else toast(r.error || 'Ошибка', 'err');
  });

  $('#sSave').addEventListener('click', () => saveSettings(false));
  $('#sRescore').addEventListener('click', () => saveSettings(true));
  $('#pSave').addEventListener('click', saveProfile);
  $('#aiSaveProvider').addEventListener('click', saveAiProvider);
  $('#aiAddCustom').addEventListener('click', addCustomProvider);
  $('#aiUploadResume').addEventListener('click', uploadResume);
  $('#aiAnalyzeText').addEventListener('click', analyzeText);
  $('#aiSaveProfile').addEventListener('click', saveAiProfile);
  $('#aiMatch').addEventListener('click', aiMatchFeed);
  $('#aiRecommend').addEventListener('click', aiRecommend);
  $('#aiAsk').addEventListener('click', () => aiAsk());
  $('#d-ai-improve').addEventListener('click', aiImproveResponse);
  $('#d-ai-eval').addEventListener('click', aiEvalJob);
  $('#nCheck').addEventListener('click', async () => {
    try {
      const r = await api('/api/notify/check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken: $('#n-token').value.trim() }),
      });
      toast(r.ok ? `Бот подключён: ${r.note}` : `Ошибка: ${r.error}`, r.ok ? 'ok' : 'err');
    } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
  });

  $('#autoRefresh').addEventListener('click', () => {
    if (state.autoTimer) {
      clearInterval(state.autoTimer); state.autoTimer = null;
      $('#autoRefresh').textContent = 'авто: выкл';
      $('#autoRefresh').classList.remove('primary');
    } else {
      const min = state.settings?.poll?.minutes || 5;
      state.autoTimer = setInterval(poll, min * 60000);
      $('#autoRefresh').textContent = `авто: ${min} мин`;
      $('#autoRefresh').classList.add('primary');
    }
  });
}

init();
