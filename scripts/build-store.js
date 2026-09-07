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

for (const f of ['background.js', 'content.js', 'content.css', 'popup.html', 'popup.js']) {
  fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
}
for (const s of ['16', '48', '128']) {
  fs.copyFileSync(path.join(SRC, 'icons', `${s}.png`), path.join(OUT, 'icons', `${s}.png`));
}

const m = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
delete m.key; // the Web Store assigns the extension ID
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(m, null, 2));

console.log('Store build ready at:', OUT);
console.log('Files:', fs.readdirSync(OUT).join(', '));
