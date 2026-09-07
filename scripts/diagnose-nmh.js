'use strict';
// Validate the native-messaging registration exactly the way Chrome does.
const { execFileSync } = require('child_process');
const fs = require('fs');

const HOST = 'com.streamgrab.host';

function regGet(hive) {
  try {
    const out = execFileSync('reg', ['query', `HKCU\\Software\\${hive}\\NativeMessagingHosts\\${HOST}`, '/ve'], { encoding: 'utf8' });
    const m = out.match(/REG_SZ\s+(.+?)\s*$/m);
    return m ? m[1].trim() : '(key exists, no default value)';
  } catch { return null; }
}

for (const hive of ['Google\\Chrome', 'Microsoft\\Edge']) {
  const p = regGet(hive);
  console.log(`\n[${hive}] registry ->`, p);
  if (!p || p.startsWith('(')) continue;
  console.log('  manifest file exists:', fs.existsSync(p));
  try {
    const raw = fs.readFileSync(p, 'utf8');
    console.log('  bytes:', Buffer.byteLength(raw), '| has BOM:', raw.charCodeAt(0) === 0xFEFF);
    const j = JSON.parse(raw);
    console.log('  name:', JSON.stringify(j.name), '| matches host:', j.name === HOST);
    console.log('  type:', JSON.stringify(j.type));
    console.log('  allowed_origins:', JSON.stringify(j.allowed_origins));
    console.log('  path:', j.path);
    console.log('  path file exists:', fs.existsSync(j.path));
  } catch (e) {
    console.log('  MANIFEST READ/PARSE ERROR:', e.message);
  }
}
