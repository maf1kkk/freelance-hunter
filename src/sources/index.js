'use strict';
/**
 * Реестр источников.
 * Каждый источник — модуль с контрактом:
 *   { id, label, kind, needsAuth, enabled, fetch(ctx), check(ctx) }
 */
const alot = require('./alot');
const flru = require('./flru');
const kwork = require('./kwork');
const hh = require('./hh');
const telegram = require('./telegram');
const remoteok = require('./remoteok');
const remotive = require('./remotive');
const arbeitnow = require('./arbeitnow');
const jobicy = require('./jobicy');
const himalayas = require('./himalayas');
const weworkremotely = require('./weworkremotely');

const ALL = [alot, flru, kwork, hh, telegram, remoteok, remotive, arbeitnow, jobicy, himalayas, weworkremotely];

const BY_ID = new Map(ALL.map((s) => [s.id, s]));

function all() {
  return ALL.slice();
}

function get(id) {
  return BY_ID.get(id) || null;
}

/** Источники, включённые в настройках (по умолчанию — все с enabled=true) */
function enabled(settings = {}) {
  const conf = settings.sources || {};
  return ALL.filter((s) => {
    const c = conf[s.id];
    if (c && typeof c === 'object' && 'enabled' in c) return Boolean(c.enabled);
    if (c === false) return false;
    return s.enabled !== false;
  });
}

function label(id) {
  return BY_ID.get(id)?.label || id;
}

module.exports = { all, get, enabled, label, BY_ID, ALL };
