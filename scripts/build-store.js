'use strict';

// Builds a Chrome Web Store-ready copy of the extension in dist/store:
//  - copies code + icons
//  - writes a manifest WITHOUT the developer "key" (the store assigns its own ID)
// After this, zip dist/store and upload that zip to the Web Store dashboard.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'extension');
const OUT = path.join(__dirname, '..', 'dist', 'store');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'icons'), { recursive: true });

// Copy every shipped file, not a hand-kept list: a file the manifest or a page
// references but the list forgot (quality.js, once) makes the store build dead
// on arrival while the unpacked dev copy keeps working.
for (const f of fs.readdirSync(SRC)) {
  if (f === 'manifest.json' || !/\.(js|css|html)$/.test(f)) continue;
  fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
}
for (const s of ['16', '48', '128']) {
  fs.copyFileSync(path.join(SRC, 'icons', `${s}.png`), path.join(OUT, 'icons', `${s}.png`));
}

const m = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
delete m.key; // the Web Store assigns the extension ID
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(m, null, 2));

// Fail loudly if anything the manifest or a page references is missing.
const shipped = new Set(fs.readdirSync(OUT));
const referenced = new Set();
for (const cs of m.content_scripts || []) for (const f of [...(cs.js || []), ...(cs.css || [])]) referenced.add(f);
if (m.background && m.background.service_worker) referenced.add(m.background.service_worker);
for (const f of fs.readdirSync(OUT).filter((x) => x.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(OUT, f), 'utf8');
  for (const [, src] of html.matchAll(/<script[^>]+src="([^"]+)"/g)) referenced.add(src);
}
const missing = [...referenced].filter((f) => !shipped.has(f));
if (missing.length) {
  console.error('Store build is missing referenced files:', missing.join(', '));
  process.exit(1);
}

console.log('Store build ready at:', OUT);
console.log('Files:', fs.readdirSync(OUT).join(', '));
