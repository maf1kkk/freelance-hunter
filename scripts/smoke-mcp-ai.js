'use strict';
/* smoke-тест MCP: список инструментов + ai_status + ai_ask */
const { spawn } = require('child_process');
const p = spawn('node', ['mcp/server.js'], { cwd: 'D:/opencode/hunter' });
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');

p.stdout.on('data', (d) => {
  for (const l of d.toString().split('\n')) {
    if (!l.trim()) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.id === 1) {
      console.log('initialize:', m.result.serverInfo.name, m.result.serverInfo.version);
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    } else if (m.id === 2) {
      console.log('инструментов:', m.result.tools.length);
      console.log(m.result.tools.map((t) => t.name).join(', '));
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ai_status', arguments: {} } });
    } else if (m.id === 3) {
      console.log('\nai_status:', m.result.content[0].text.slice(0, 400));
      send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ai_list_providers', arguments: {} } });
    } else if (m.id === 4) {
      const j = JSON.parse(m.result.content[0].text);
      console.log('\nпровайдеров:', j.items.length, '| активен:', j.active);
      send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ai_ask', arguments: { question: 'Какой один заказ взять прямо сейчас?' } } });
    } else if (m.id === 5) {
      const j = JSON.parse(m.result.content[0].text);
      console.log('\nai_ask:', (j.text || j.error || '').slice(0, 350).replace(/\n/g, ' | '));
      p.kill(); process.exit(0);
    }
  }
});
p.stderr.on('data', (d) => process.stderr.write('ERR ' + d));
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
setTimeout(() => { console.log('timeout'); p.kill(); process.exit(1); }, 120000);
