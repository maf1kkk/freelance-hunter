'use strict';
/**
 * Уведомления в Telegram (bot API) о новых подходящих заказах.
 * Настройки: settings.notify { telegram, botToken, chatId, verdicts, minScore, cooldownMin }
 */
const http = require('./http');
const store = require('./store');

const API = 'https://api.telegram.org/bot';

/**
 * Отправляет сообщение.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function sendMessage(token, chatId, text, opts = {}) {
  if (!token || !chatId) return { ok: false, error: 'не указан botToken/chatId' };
  const url = `${API}${token}/sendMessage`;
  try {
    const res = await http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
        ...opts,
      }),
      timeout: 15000,
      retries: 1,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = JSON.parse(res.text);
    return data.ok ? { ok: true } : { ok: false, error: data.description || 'telegram error' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** Форматирует карточку заказа для Telegram */
function formatJob(job) {
  const q = job.quality || {};
  const price = job.price?.text || (job.price?.min != null ? `${job.price.min} ${job.price.currency || ''}` : 'цена не указана');
  const lines = [
    `🔥 [${q.score ?? '—'} · ${q.verdict || '?'}] ${job.title}`,
    `💰 ${price}`,
    `📍 ${job.sourceLabel || job.source}${job.sites?.length ? ' (' + job.sites.join(', ') + ')' : ''}`,
  ];
  const cl = job.client || {};
  if (cl.name) lines.push(`👤 ${cl.name}`);
  const clBits = [];
  if (cl.rating != null) clBits.push(`рейтинг ${cl.rating}`);
  if (cl.reviews != null) clBits.push(`${cl.reviews} отз.`);
  if (job.stats?.responses != null) clBits.push(`откликов ${job.stats.responses}`);
  if (clBits.length) lines.push(`📊 ${clBits.join(' · ')}`);
  if (q.reasons?.length) lines.push(`💡 ${q.reasons.slice(0, 3).join('; ')}`);
  lines.push(job.url || '');
  return lines.join('\n');
}

/**
 * Рассылает уведомления о новых подходящих заказах.
 * @param {Array} jobs — новые заказы (обычно только что добавленные)
 * @returns {Promise<{sent:number, skipped:number, error?:string}>}
 */
async function notifyNew(jobs, settings) {
  const cfg = (settings || store.getSettings()).notify || {};
  if (!cfg.telegram) return { sent: 0, skipped: jobs.length, reason: 'уведомления выключены' };
  if (!cfg.botToken || !cfg.chatId) return { sent: 0, skipped: jobs.length, reason: 'нет botToken/chatId' };

  const verdicts = new Set(cfg.verdicts || ['prime', 'good']);
  const minScore = cfg.minScore ?? 70;
  const cooldown = (cfg.cooldownMin ?? 60) * 60000;

  const notifyState = store.getNotifyState();
  if (Date.now() - (notifyState.lastSentAt || 0) < cooldown) {
    return { sent: 0, skipped: jobs.length, reason: 'кулдаун' };
  }
  const already = new Set(notifyState.lastIds || []);

  const targets = jobs
    .filter((j) => j.quality && verdicts.has(j.quality.verdict) && (j.quality.score ?? 0) >= minScore)
    .filter((j) => !already.has(j.id))
    .slice(0, 10);

  let sent = 0;
  for (const j of targets) {
    const r = await sendMessage(cfg.botToken, cfg.chatId, formatJob(j));
    if (r.ok) { sent++; already.add(j.id); }
    else return { sent, skipped: jobs.length - sent, error: r.error };
  }

  store.setNotifyState({
    lastSentAt: Date.now(),
    lastIds: [...already].slice(-200),
  });
  return { sent, skipped: jobs.length - sent };
}

/** Проверка подключения бота */
async function check(cfg) {
  if (!cfg.botToken) return { ok: false, error: 'нет botToken' };
  try {
    const res = await http.request(`${API}${cfg.botToken}/getMe`, { timeout: 10000, retries: 0 });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = JSON.parse(res.text);
    return data.ok ? { ok: true, note: `бот @${data.result.username}` } : { ok: false, error: data.description };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

module.exports = { sendMessage, notifyNew, formatJob, check };
