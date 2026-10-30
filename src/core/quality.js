'use strict';
/**
 * Скоринг качества заказа. Это ядро ценности агрегатора:
 * отсекает мусор, рекламу, «плохих» клиентов и заведомо невыгодные заказы.
 *
 * Модель: взвешенная сумма независимых критериев (0..100) минус штрафы.
 *   клиент    — до 30   (рейтинг, отзывы, опыт, верификация, возраст аккаунта)
 *   содержание— до 30   (ключевые слова, навыки профиля, объём ТЗ)
 *   цена      — до 20   (в диапазоне, адекватная ставка в час)
 *   конкуренция— до 10  (число откликов)
 *   свежесть  — до 10   (возраст публикации)
 *
 * Вердикты: prime (>=70) / good (>=55) / meh (>=38) / bad (<38) / blocked
 */
const { normalize } = require('../filters');
const { salaryPerHour, tokenize, stems, SUFFIXES } = require('./model');

/** Встроенный стоп-лист: мошенничество, gambling, adult, крипто-пампинг */
const BUILTIN_BLOCK = [
  'казино', 'букмекер', 'ставки на спорт', 'беттинг', 'хкб', 'тотализатор',
  'крипто-сигналы', 'бинарные опционы', 'форекс сигналы', 'пампинг', 'инфоцыган',
  'памятник', 'свидание', 'интим', 'вебкам', 'onlyfans', 'вебкамера',
  'обмен валют', 'карта иностранного банка', 'обнал', 'дропшипт карт', 'свифт',
  'секс', 'порно', 'эротика', 'массаж', 'проститутк', 'только для взрослых',
  'накрутка', 'накрутить отзывы', 'списать отзывы', 'отзывы за деньги',
  'обход блокировки', 'взлом аккаунта', 'взлом вк', 'сим карт', 'оформление кредита',
];

/** Мусорные/спам-фразы — понижают, но не блокируют */
const SPAM_PHRASES = [
  'срочно', 'очень срочно', 'нужно прям сейчас', 'по срочно',
  'дёшево', 'дешево', 'сильно дешевле', 'за копейки', 'за отзыв',
  'без опыта', 'без портфолио', 'без отзывов', 'без истории', 'первый заказ',
  'тестовое задание', 'тестовая задача', 'напишите в личку', 'пиши в личку', 'пишите в лс',
  'возьмите заказ', 'нужен свой человек', 'на удалёнку', 'на удаленку',
  'нужны люди', 'нужен человек', 'нужно много людей', 'набор в команду',
  'обучаем', 'стажировка', 'стажировка без опыта', 'работа от 18',
];

/** Слова-приманки: часто спам, но в вакансиях встречаются — только минус */
const WEAK_SIGNALS = [
  'массово', 'много людей', 'рассылка', 'обзвон', 'холодные звонки',
  'наполнение сайта', 'наполнение контента', 'проставление ссылок',
  'накрутка лайков', 'накрутка подписчиков', 'бот для накрутки',
];

const CURRENCY_MULT = { RUB: 1, USD: 90, EUR: 100, KZT: 2.2, UAH: 2.4, BYN: 28 };

const WEIGHTS = { client: 30, content: 30, price: 20, competition: 10, fresh: 10 };

function toRUB(amount, currency) {
  if (amount == null) return null;
  const mult = CURRENCY_MULT[currency] || 1;
  return Math.round(amount * mult);
}

function words(s) {
  return normalize(s).split(/[^a-zа-я0-9+]+/).filter(Boolean);
}

function emojiCount(s) {
  return (String(s || '').match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu) || []).length;
}

function capsRatio(s) {
  const letters = String(s || '').replace(/[^A-Za-zА-Яа-яЁё]/g, '');
  if (letters.length < 8) return 0;
  const upper = letters.replace(/[^A-ZА-ЯЁ]/g, '').length;
  return upper / letters.length;
}

function mixedScript(s) {
  const wordsArr = String(s || '').split(/\s+/);
  for (const w of wordsArr) {
    if (w.length < 4) continue;
    if (/[a-z]/.test(w) && /[а-яё]/.test(w)) return true;
  }
  return false;
}

function repeatSpam(s) {
  return /([!?.\-_*#=])\1{3,}/.test(String(s || '')) || /((\w)\2{4,})/.test(String(s || ''));
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

/** Объединение основ всех слов текста — быстрая проверка совпадения */
function stemSignature(tokens) {
  const sig = new Set();
  for (const t of tokens) for (const s of stems(t)) sig.add(s);
  return sig;
}

/**
 * Сопоставление ключевого слова с токеном.
 * «бот» ≠ «разработчик», но «бот» = «бота», «дизайн» = «дизайнер».
 * Строгое сравнение основ — без «размытых» префиксов.
 */
function kwMatch(tokens, keyword) {
  return kwMatchSig(stemSignature(tokens), tokens, keyword);
}

/** Быстрая версия: заранее посчитанный отпечаток основ */
function kwMatchSig(sig, tokens, keyword) {
  const k = normalize(keyword).trim().replace(/[.,]/g, '');
  if (!k) return false;
  if (/\s/.test(k)) return tokens.join(' ').includes(k); // многословная фраза
  const ks = stems(k);
  for (const a of ks) if (sig.has(a)) return true;
  if (k.length >= 6 && tokens.some((t) => t.includes(k))) return true;
  return false;
}

/** Проверка наличия фразы/слова в тексте (text уже нормализован) */
function hasPhraseSig(sig, tokens, fullText, phrase) {
  const p = normalize(phrase).trim();
  if (!p) return false;
  if (/\s/.test(p)) return fullText.includes(p);
  return kwMatchSig(sig, tokens, p);
}

function hasPhrase(tokens, fullText, phrase) {
  const p = normalize(phrase).trim();
  if (!p) return false;
  if (/\s/.test(p)) return fullText.includes(p);
  return kwMatch(tokens, p);
}

/** Кэш нормализованных стоп-слов (список меняется редко) */
let blockCache = null;
let blockCacheKey = '';

function blockWordsOf(q) {
  const key = (q.blockWords || []).join('\n');
  if (blockCache && blockCacheKey === key) return blockCache;
  blockCache = [...(q.blockWords || []), ...BUILTIN_BLOCK].map((w) => normalize(w).trim()).filter(Boolean);
  blockCacheKey = key;
  return blockCache;
}

/**
 * @param {object} job — нормализованный Job
 * @param {object} settings — полные настройки
 * @param {object} ctx — { profile }
 * @returns {{score:number, verdict:string, reasons:string[], flags:string[], parts:object}}
 */
function evaluate(job, settings = {}, ctx = {}) {
  const q = settings.quality || {};
  const search = settings.search || {};
  const reasons = [];
  const flags = [];
  const parts = { client: 0, content: 0, price: 0, competition: 0, fresh: 0, penalty: 0 };

  const text = normalize(`${job.title || ''} ${job.body || ''}`);
  const title = normalize(job.title || '');
  const tokens = tokenize(text);
  const titleTokens = tokenize(job.title || '');
  const sig = stemSignature(tokens);
  const titleSig = stemSignature(titleTokens);

  /* ---------- 0. Жёсткий блок ---------- */
  const blockWords = blockWordsOf(q);
  const blockHits = blockWords.filter((w) => hasPhraseSig(sig, tokens, text, w));
  if (blockHits.length) {
    return {
      score: 0, verdict: 'blocked', parts,
      reasons: [`стоп-слово: ${blockHits.slice(0, 3).join(', ')}`],
      flags: ['blacklist'],
    };
  }

  // минус-слова пользователя — тоже жёсткий отсев
  const minusHits = (search.keywordsMinus || []).filter((w) => w && hasPhraseSig(sig, tokens, text, w));
  if (minusHits.length) {
    return {
      score: 0, verdict: 'blocked', parts,
      reasons: [`минус-слово: ${minusHits.slice(0, 3).join(', ')}`],
      flags: ['minus_word'],
    };
  }

  /* ---------- 1. Клиент (до 30) ---------- */
  const cl = job.client || {};
  // рейтинги приводятся к шкале 0–5 (hh даёт 0–5, остальные — 0–100)
  const to5 = (r) => (r == null ? null : (r <= 5 ? r : r / 20));
  const maxRating = q.maxClientRating ?? 100;
  const minRating = q.minClientRating ?? 0;
  const maxR5 = to5(maxRating) || 5;
  const minR5 = to5(minRating) || 0;

  if (cl.rating != null) {
    const r5 = to5(cl.rating);
    const norm = clamp01(r5 / maxR5);
    parts.client += 12 * norm;
    if (norm >= 0.9) reasons.push(`рейтинг клиента ${cl.rating}`);
    if (minR5 > 0 && r5 < minR5) {
      flags.push('low_rating');
      reasons.push(`рейтинг ${cl.rating} < ${minRating}`);
      parts.client -= 14;
    } else if (norm < 0.4) {
      flags.push('mid_rating');
    }
  } else if (minR5 > 0) {
    flags.push('no_rating');
    reasons.push('нет данных о рейтинге клиента');
    parts.client -= 8;
  }

  const minReviews = q.minClientReviews ?? 0;
  if (cl.reviews != null) {
    parts.client += 8 * clamp01(cl.reviews / 10);
    if (cl.reviews >= 5) reasons.push(`отзывов: ${cl.reviews}`);
    if (minReviews > 0 && cl.reviews < minReviews) {
      flags.push('few_reviews');
      reasons.push(`отзывов ${cl.reviews} < ${minReviews}`);
      parts.client -= 12;
    }
  } else if (minReviews > 0) {
    flags.push('no_reviews');
    parts.client -= 6;
  }

  if (cl.orders != null) {
    parts.client += 4 * clamp01(cl.orders / 10);
    if (cl.orders === 0) { parts.client -= 6; flags.push('no_orders'); reasons.push('заказчик ещё никого не нанимал'); }
  }
  if (cl.hiredPercent != null) {
    parts.client += 3 * clamp01(cl.hiredPercent / 100);
    if (cl.hiredPercent >= 50) reasons.push(`нанимал в ${cl.hiredPercent}% случаев`);
    else if (cl.hiredPercent === 0) { parts.client -= 8; flags.push('never_hired'); reasons.push('заказчик никого не нанял'); }
  }
  if (cl.verified) { parts.client += 3; flags.push('verified'); }
  if (cl.ageDays != null) {
    if (cl.ageDays < 7) { parts.client -= 10; flags.push('new_account'); reasons.push(`аккаунт создан ${cl.ageDays} дн. назад`); }
    else if (cl.ageDays < 30) parts.client -= 4;
    else if (cl.ageDays > 365) parts.client += 2;
  }
  // если данных о клиенте нет вообще — не наказываем, но и не награждаем
  const hasClientData = cl.rating != null || cl.reviews != null || cl.orders != null
    || cl.hiredPercent != null || cl.ageDays != null || cl.verified;
  if (!hasClientData) {
    parts.client += 8;
    flags.push('no_client_data');
  }

  /* ---------- 2. Содержание (до 30) ---------- */
  const plus = (search.keywordsPlus || []).map(normalize).filter(Boolean);
  const plusGroups = search.keywordGroups || [];
  if (plus.length) {
    const titleHits = plus.filter((k) => kwMatchSig(titleSig, titleTokens, k));
    const bodyHits = plus.filter((k) => kwMatchSig(sig, tokens, k));
    if (!titleHits.length && !bodyHits.length) {
      flags.push('no_keyword');
    } else {
      parts.content += 12 * clamp01(titleHits.length / 2);
      parts.content += 6 * clamp01(bodyHits.length / 3);
      if (titleHits.length) reasons.push(`совпадения в заголовке: ${titleHits.slice(0, 4).join(', ')}`);
    }
  }
  // совпадение с навыками из профиля исполнителя
  const skills = String((ctx.profile && ctx.profile.skills) || '')
    .split(/[,;/|]/).map((s) => normalize(s).trim()).filter((s) => s.length > 2);
  if (skills.length) {
    const skillHits = skills.filter((sk) => kwMatchSig(sig, tokens, sk));
    if (skillHits.length) {
      parts.content += 8 * clamp01(skillHits.length / 3);
      reasons.push(`подходит по навыкам: ${skillHits.slice(0, 3).join(', ')}`);
      flags.push('skill_match');
    }
  }
  for (const g of plusGroups) {
    const kw = (g.words || []).map(normalize);
    if (!kw.length) continue;
    const hit = kw.some((k) => kwMatchSig(sig, tokens, k));
    if (hit) { parts.content += Math.min(g.weight ?? 5, 12); reasons.push(`группа «${g.name || ''}»`); }
    else if (g.required) { parts.content -= 10; flags.push('group_miss'); reasons.push(`нет обязательной группы «${g.name || ''}»`); }
  }

  const bodyLen = (job.body || '').length;
  parts.content += 4 * clamp01(bodyLen / 400);
  if (bodyLen < 25) { parts.content -= 3; flags.push('empty_body'); }

  /* ---------- 3. Цена (до 20) ---------- */
  const p = job.price || {};
  const rub = toRUB(p.min, p.currency);
  const rubMax = toRUB(p.max, p.currency);
  const pMin = q.priceMin ?? search.priceMin ?? null;
  const pMax = q.priceMax ?? search.priceMax ?? null;
  if (rub != null) {
    if (pMin != null && rub < pMin) {
      flags.push('price_low');
      reasons.push(`цена ${p.text || rub} ниже минимума ${pMin}`);
    } else if (pMax != null && rubMax != null && rubMax > pMax) {
      parts.price += 5;
      reasons.push(`цена выше максимума ${pMax} (не блокирует)`);
    } else {
      parts.price += 10;
      reasons.push(`цена: ${p.text || rub}`);
    }
    const rate = salaryPerHour(job);
    if (rate != null) {
      const minRate = q.minSalaryPerHour ?? null;
      if (minRate != null && rate < minRate) {
        flags.push('low_rate');
        reasons.push(`~${rate} ₽/ч ниже порога ${minRate}`);
      } else {
        parts.price += 10 * clamp01(rate / 3000);
        if (rate >= 3000) reasons.push(`~${rate} ₽/ч`);
      }
    }
  } else {
    flags.push('no_price');
  }

  /* ---------- 4. Конкуренция (до 10) ---------- */
  const resp = job.stats && job.stats.responses;
  const maxResp = q.maxResponses ?? 50;
  const idealResp = q.idealResponses ?? 8;
  if (resp != null) {
    if (resp >= maxResp) {
      parts.competition -= 8;
      flags.push('too_many_responses');
      reasons.push(`уже ${resp} откликов — конкуренция высокая`);
    } else {
      parts.competition += 10 * clamp01(1 - (resp - idealResp) / Math.max(1, maxResp - idealResp));
      if (resp <= idealResp) reasons.push(`откликов мало: ${resp}`);
    }
  } else {
    parts.competition += 5;
  }

  /* ---------- 5. Свежесть (до 10) ---------- */
  const ageH = (Date.now() - (job.publishedAt || Date.now())) / 3600000;
  parts.fresh += 10 * clamp01(1 - ageH / 72);

  /* ---------- 6. Штрафы за мусор ---------- */
  const spamHits = SPAM_PHRASES.filter((w) => hasPhraseSig(sig, tokens, text, w));
  if (spamHits.length) {
    parts.penalty -= Math.min(spamHits.length * 5, 15);
    flags.push('spam_phrases');
    reasons.push(`подозрительные формулировки: ${spamHits.slice(0, 3).join(', ')}`);
  }
  const weakHits = WEAK_SIGNALS.filter((w) => hasPhraseSig(sig, tokens, text, w));
  if (weakHits.length) {
    parts.penalty -= Math.min(weakHits.length * 4, 8);
    flags.push('weak_signals');
  }
  if (capsRatio(job.title || '') > 0.7 && (job.title || '').length > 10) { parts.penalty -= 5; flags.push('caps'); }
  if (emojiCount(job.title || '') >= 4) { parts.penalty -= 4; flags.push('emoji'); }
  if (mixedScript(job.title || '')) { parts.penalty -= 14; flags.push('mixed_script'); reasons.push('смешение кириллицы и латиницы'); }
  if (repeatSpam(job.title || '')) { parts.penalty -= 5; flags.push('char_spam'); }
  if (/\D(\+7|8)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-()]*\d{2}[\s\-()]*\d{2}/.test(text)) {
    parts.penalty -= 9; flags.push('phone_in_text'); reasons.push('телефон в тексте — вероятно не заказ');
  }
  if (/t\.me\/|\+\d{7,}/.test(title) && (job.body || '').length < 120) { parts.penalty -= 7; flags.push('promo_link'); }
  if (job.source === 'telegram' && job.postKind === 'resume') { parts.penalty -= 30; flags.push('resume_post'); reasons.push('пост-резюме, а не заказ'); }
  if (job.source === 'telegram' && job.postKind === 'vacancy') { parts.penalty -= 20; flags.push('vacancy_post'); reasons.push('пост-вакансия'); }

  /* ---------- Итог ---------- */
  let score = parts.client + parts.content + parts.price + parts.competition + parts.fresh + parts.penalty;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const verdict = score >= 70 ? 'prime' : score >= 55 ? 'good' : score >= 38 ? 'meh' : 'bad';
  return { score, verdict, reasons, flags, parts };
}

/** Массовая оценка */
function evaluateAll(jobs, settings, ctx) {
  return jobs.map((j) => {
    const q = evaluate(j, settings, ctx);
    j.quality = { score: q.score, verdict: q.verdict, reasons: q.reasons, flags: q.flags, parts: q.parts };
    return j;
  });
}

module.exports = {
  evaluate, evaluateAll, WEIGHTS,
  BUILTIN_BLOCK, SPAM_PHRASES, WEAK_SIGNALS,
  toRUB, words, emojiCount, capsRatio, tokenize, kwMatch, kwMatchSig, hasPhrase, hasPhraseSig, stems, stemSignature,
};
