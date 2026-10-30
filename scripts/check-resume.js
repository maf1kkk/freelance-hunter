'use strict';
/* проверка парсера резюме на всех форматах */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const r = require(path.join(ROOT, 'src/core/resume.js'));

const FIX = path.join(ROOT, 'output/resume-test');
const files = ['resume.pdf', 'resume.docx', 'resume.txt'];
let bad = 0;
for (const f of files) {
  const p = path.join(FIX, f);
  if (!fs.existsSync(p)) { console.log('нет файла', f); continue; }
  try {
    const res = r.parseResumeFile(p);
    const hasName = /Максим/.test(res.text);
    const hasSkills = /JavaScript/.test(res.text);
    const joined = /автоматизация/.test(res.text);
    console.log(`${f.padEnd(14)} ${res.kind.padEnd(5)} ${String(res.text.length).padStart(4)} симв. | имя:${hasName ? 'да' : 'НЕТ'} навыки:${hasSkills ? 'да' : 'НЕТ'} склейка:${joined ? 'да' : 'нет'}`);
    if (!hasName || !hasSkills) bad++;
    console.log('   →', res.text.slice(0, 150).replace(/\n+/g, ' | '));
  } catch (e) {
    console.log(f, 'ERR', e.message);
    bad++;
  }
}
process.exit(bad ? 1 : 0);
