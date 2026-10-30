'use strict';
/**
 * Единый прогон всех тестов: unit + e2e.
 * Запуск: node test/run-all.js  (или npm run test:all)
 */
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 3411;

function runNode(args, opts = {}) {
  const r = spawnSync('node', args, { cwd: ROOT, encoding: 'utf8', timeout: 900000, ...opts });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

async function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

(async () => {
  const results = [];
  const port = await freePort();

  console.log('▶ unit-тесты (node --test)');
  let unit = runNode(['--test', '--test-reporter=tap', 'test/*.test.js']);
  const uPass = (unit.out.match(/^# pass (\d+)/m) || [])[1];
  const uFail = (unit.out.match(/^# fail (\d+)/m) || [])[1];
  results.push({ name: 'unit', pass: Number(uPass || 0), fail: Number(uFail || 0), code: unit.code, out: unit.out });
  console.log(`  ${uPass} ок, ${uFail} сломанных\n`);

  console.log('▶ поднимаем сервер для e2e');
  const server = spawn('node', [path.join(ROOT, 'web', 'server.js')], {
    cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverErr = [];
  server.stderr.on('data', (d) => serverErr.push(String(d)));
  const up = await waitForServer(`http://127.0.0.1:${port}/api/health`);
  console.log(`  сервер: ${up ? 'ок' : 'НЕ ПОДНЯЛСЯ'}\n`);

  const e2e = [
    ['api', 'test/e2e/api.test.js'],
    ['ui', 'test/e2e/ui.test.js'],
    ['mcp', 'test/e2e/mcp.test.js'],
    ['cli', 'test/e2e/cli.test.js'],
    ['edge', 'test/e2e/edge.test.js'],
    ['flow', 'test/e2e/flow.test.js'],
    ['fresh', 'test/e2e/fresh.test.js'],
  ];

  for (const [name, file] of e2e) {
    console.log(`▶ e2e: ${name}`);
    const r = runNode([file], { env: { ...process.env, BASE: `http://127.0.0.1:${port}` } });
    const m = r.out.match(/(\d+) ок, (\d+) сломанных/);
    results.push({ name, pass: Number(m?.[1] || 0), fail: Number(m?.[2] || 0), code: r.code, out: r.out });
    console.log(`  ${m ? `${m[1]} ок, ${m[2]} сломанных` : `нет результата (код ${r.code})`}\n`);
    if (!m) console.log(r.out.split('\n').slice(-15).join('\n'));
  }

  server.kill();

  console.log('▶ проверка критериев (verify.js)');
  const v = runNode(['test/verify.js']);
  const vMatch = v.out.match(/(\d+) из (\d+) критериев выполнено/);
  results.push({ name: 'verify', pass: Number(vMatch?.[1] || 0), fail: Number(vMatch?.[2] || 0) - Number(vMatch?.[1] || 0), code: v.code, out: v.out });
  console.log(`  ${vMatch ? vMatch[0] : 'нет результата'}\n`);

  console.log('════════════════ ИТОГ ════════════════');
  let tp = 0; let tf = 0;
  for (const r of results) {
    tp += r.pass; tf += r.fail;
    const mark = r.fail === 0 ? '✓' : '✗';
    console.log(` ${mark} ${r.name.padEnd(8)} ${String(r.pass).padStart(4)} ок  ${String(r.fail).padStart(3)} сломанных`);
    if (r.fail) {
      for (const line of r.out.split('\n').filter((l) => l.includes('✗'))) console.log('      ' + line.trim());
    }
  }
  console.log(`\n  ИТОГО: ${tp} проверок ок, ${tf} сломанных`);
  if (serverErr.length) {
    const errs = serverErr.join('').trim();
    if (errs) { console.log('\n  stderr сервера:'); console.log('  ' + errs.slice(0, 600)); }
  }
  process.exit(tf ? 1 : 0);
})();
