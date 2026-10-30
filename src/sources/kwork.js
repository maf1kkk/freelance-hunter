'use strict';
/**
 * Kwork — биржа кворков. Список заказов: https://kwork.ru/projects
 * Данные встроены в страницу как JSON (window.stateData / wantsListData) — парсим без HTML-селекторов.
 */
const { request } = require('../core/http');
const { makeJob } = require('../core/model');
const { extractVarJson, extractKeyJson } = require('../core/html');
const accounts = require('../core/accounts');

const ID = 'kwork';
const BASE = 'https://kwork.ru';
const LIST_URL = `${BASE}/projects`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function parseWantsList(html) {
  // 1) отдельный var wantsListData (страница списка)
  let data = extractVarJson(html, 'wantsListData') || extractKeyJson(html, 'wantsListData');
  if (data && data.pagination && Array.isArray(data.pagination.data)) {
    return { list: data.pagination.data, pagination: data.pagination };
  }
  // 2) stateData.wants_XXX_data (страница проекта)
  const state = extractVarJson(html, 'stateData');
  if (state) {
    for (const [k, v] of Object.entries(state)) {
      if (/^wants_\d+_data$/.test(k) && v && typeof v === 'object') {
        const arr = Array.isArray(v) ? v : (v.data || v.wants || []);
        if (Array.isArray(arr) && arr.length) return { list: arr, pagination: null };
      }
    }
    if (state.wantData) return { list: [state.wantData], pagination: null };
  }
  return { list: [], pagination: null };
}

function toJob(w) {
  const price = Number(w.priceLimit);
  const user = w.user || {};
  const data = user.data || {};
  const hired = Number(data.wants_hired_percent);
  return makeJob(ID, {
    externalId: w.id,
    title: w.name || '',
    body: String(w.description || '').replace(/\r\n/g, '\n'),
    url: `${BASE}/projects/${w.id}`,
    price: Number.isFinite(price) && price > 0
      ? { min: price, max: price, currency: 'RUB', text: `${price} ₽` }
      : null,
    publishedAt: w.date_create ? Date.parse(w.date_create.replace(' ', 'T')) : null,
    deadline: w.date_expire ? Date.parse(w.date_expire.replace(' ', 'T')) : null,
    category: w.category_id ? [String(w.category_id)] : [],
    tags: [],
    location: null,
    employmentType: null,
    client: {
      name: user.username || null,
      id: user.USERID || null,
      url: w.wantUserGetProfileUrl || null,
      orders: Number(data.wants_count) || null,
      hiredPercent: Number.isFinite(hired) ? hired : null,
      verified: Array.isArray(user.badges) && user.badges.length > 0,
    },
    stats: {
      responses: Number(w.wantGetSumOrderCount) || null,
      views: Number(w.views_dirty) || null,
      activeOrders: Number(w.getWantsActiveCount) || null,
      duplicateActive: Boolean(w.isOtherActiveWantsExceptByWantId),
    },
    raw: {
      maxDays: w.max_days,
      kworkCount: w.kwork_count,
      priceThreshold: w.getPriceThreshold,
      timeLeft: w.timeLeft,
      status: w.status,
    },
  });
}

async function fetchJobs(ctx = {}) {
  const cookie = accounts.cookieHeader('kwork', 'kwork.ru');
  const limit = Math.min(ctx.limit || 40, 200);
  const maxPages = ctx.pages || 3;
  const out = [];
  const seen = new Set();

  for (let page = 1; page <= maxPages && out.length < limit; page++) {
    const url = page === 1 ? LIST_URL : `${LIST_URL}?page=${page}`;
    let html;
    try {
      const r = await request(url, {
        headers: { 'User-Agent': UA, 'Referer': LIST_URL, 'Accept-Language': 'ru-RU,ru;q=0.9', ...(cookie ? { Cookie: cookie } : {}) },
        timeout: ctx.timeout || 25000, retries: 1,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      html = r.text;
    } catch (e) {
      if (page === 1) throw e;
      break;
    }
    const { list } = parseWantsList(html);
    if (!list.length) break;
    for (const w of list) {
      if (!w || !w.id || seen.has(w.id)) continue;
      seen.add(w.id);
      out.push(toJob(w));
      if (out.length >= limit) break;
    }
  }
  return out;
}

async function check() {
  const cookie = accounts.cookieHeader('kwork', 'kwork.ru');
  try {
    const r = await request(LIST_URL, {
      headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) },
      timeout: 15000, retries: 0,
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const { list } = parseWantsList(r.text);
    return {
      ok: true,
      account: cookie ? 'cookies' : 'guest',
      note: list.length ? `найдено заказов: ${list.length}` : 'список пуст',
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { id: ID, label: 'Kwork', kind: 'exchange', needsAuth: false, enabled: true, fetch: fetchJobs, check, parseWantsList };
