'use strict';
/* проверка: 403 — это блок по IP или заголовки? */
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const targets = [
  ['remotive', 'https://remotive.com/api/remote-jobs?limit=2'],
  ['arbeitnow', 'https://www.arbeitnow.com/api/job-board-api?page=1'],
  ['remoteok', 'https://remoteok.com/api'],
  ['himalayas', 'https://himalayas.app/jobs/api?limit=2'],
  ['jobicy', 'https://jobicy.com/api/v2/remote-jobs?count=2'],
  ['wwr', 'https://weworkremotely.com/remote-jobs.rss'],
];

const VARIANTS = [
  ['browser+json', { 'User-Agent': UA_BROWSER, Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9' }],
  ['node-default', {}],
  ['browser+referer', { 'User-Agent': UA_BROWSER, Accept: 'application/json', Referer: 'https://example.com/' }],
];

(async () => {
  for (const [name, url] of targets) {
    const out = [];
    for (const [vname, headers] of VARIANTS) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 12000);
        const r = await fetch(url, { headers, signal: ctl.signal });
        clearTimeout(t);
        out.push(`${vname}=${r.status}`);
      } catch (e) {
        out.push(`${vname}=ERR:${String(e.message).slice(0, 30)}`);
      }
    }
    console.log(name.padEnd(11), out.join('  '));
  }
})();
