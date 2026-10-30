'use strict';
/**
 * Telegram-каналы с заказами (источник-чат).
 * Посты классифицируются: заказ / резюме / вакансия / спам.
 */
const tg = require('../tg');
const { makeJob } = require('../core/model');
const { classifyTgPost } = require('../filters');

const ID = 'telegram';

function toJob(p) {
  const lines = String(p.text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const title = (lines.find((l) => l.length > 12) || lines[0] || '').slice(0, 140);
  const link = p.channelUrl ? `${p.channelUrl}/${p.id}` : `https://t.me/${p.channel}/${p.id}`;
  const kind = classifyTgPost(p.text);

  // цена из текста: «10 000 ₽», «от 5 до 10 тыс», «5000р»
  const money = /\b(\d[\d\s\u00a0]{2,})\s*(?:₽|руб\.?|р\.?)\b/i.exec(p.text)
    || /\b(\d[\d\s\u00a0]{2,})\s*(?:тыс\.?|k)\b/i.exec(p.text);
  let price = null;
  if (money) {
    const n = Number(money[1].replace(/[^\d]/g, ''));
    const isK = /тыс|k/i.test(money[2]);
    const val = isK ? n * 1000 : n;
    if (Number.isFinite(val) && val > 0) price = { min: val, max: val, currency: 'RUB', text: money[0].trim() };
  }

  return makeJob(ID, {
    externalId: `${p.channel}_${p.id}`,
    title,
    body: p.text || '',
    url: link,
    price,
    publishedAt: p.date ? new Date(p.date).getTime() : null,
    category: p.channelLabel ? [p.channelLabel] : [],
    tags: [],
    client: { name: p.sender || null },
    stats: { views: p.views ?? null },
    postKind: kind,
    raw: { channel: p.channel, channelLabel: p.channelLabel, views: p.views },
  });
}

async function fetchJobs(ctx = {}) {
  const store = require('../core/store');
  const lastSeen = store.getTelegramLastSeen();
  const posts = await tg.fetchAllChannels({ limit: ctx.limit || 40, lastSeen });

  const valid = posts.filter((p) => !p.error && p.text);
  const jobs = valid.map(toJob);

  // обновляем lastSeen
  const newLastSeen = { ...lastSeen };
  for (const ch of tg.loadChannels()) {
    const chPosts = valid.filter((p) => p.channel === ch.name);
    if (chPosts.length) newLastSeen[ch.name] = Math.max(...chPosts.map((p) => p.id));
  }
  store.setTelegramLastSeen(newLastSeen);

  const errors = posts.filter((p) => p.error).map((p) => `${p.channel}: ${p.error}`);
  if (errors.length) ctx.log?.(`telegram: ${errors.length} каналов с ошибкой`);
  return jobs;
}

async function check() {
  const channels = tg.loadChannels();
  if (!channels.length) return { ok: false, error: 'нет настроенных каналов' };
  try {
    const posts = await tg.fetchChannel(channels[0].name, 1);
    return { ok: true, note: `каналов: ${channels.length}, тестовый канал отвечает (${posts.length} постов)` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { id: ID, label: 'Telegram', kind: 'chat', needsAuth: true, enabled: true, fetch: fetchJobs, check, timeout: 75000 };
