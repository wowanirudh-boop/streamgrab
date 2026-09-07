'use strict';

// Generates polished StreamGrab icons: a rounded, gradient-blue tile with a
// white download arrow + tray line. Rendered at 4x and downsampled for smooth,
// anti-aliased edges. Writes extension/icons/{16,48,128}.png and a standalone
// 128 for the Web Store listing (dist/streamgrab-icon-128.png).

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
};
const lerp = (a, b, t) => a + (b - a) * t;

function renderRaw(S) {
  const SS = 4, N = S * SS;
  const buf = new Uint8Array(N * N * 4);
  const rad = 0.1875 * N;
  const inRR = (x, y) => {
    const x0 = 0, y0 = 0, x1 = N - 1, y1 = N - 1;
    let dx = 0, dy = 0;
    if (x < x0 + rad) dx = x0 + rad - x; else if (x > x1 - rad) dx = x - (x1 - rad);
    if (y < y0 + rad) dy = y0 + rad - y; else if (y > y1 - rad) dy = y - (y1 - rad);
    return dx * dx + dy * dy <= rad * rad;
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const o = (y * N + x) * 4;
      let R = 0, G = 0, B = 0, A = 0;
      if (inRR(x, y)) {
        const t = y / N;
        R = Math.round(lerp(0x5a, 0x2f, t)); G = Math.round(lerp(0x97, 0x6f, t)); B = Math.round(lerp(0xff, 0xe0, t)); A = 255;
        const u = x / SS, v = y / SS; // final-size space
        let white = false;
        if (u >= 0.4375 * S && u <= 0.5625 * S && v >= 0.234 * S && v <= 0.5625 * S) white = true; // stem
        if (v >= 0.484 * S && v <= 0.734 * S) { const half = 0.219 * S * (1 - (v - 0.484 * S) / (0.25 * S)); if (Math.abs(u - 0.5 * S) <= half) white = true; } // head
        if (u >= 0.266 * S && u <= 0.734 * S && v >= 0.781 * S && v <= 0.859 * S) white = true; // tray
        if (white) { R = 255; G = 255; B = 255; }
      }
      buf[o] = R; buf[o + 1] = G; buf[o + 2] = B; buf[o + 3] = A;
    }
  }
  const raw = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) {
    raw[(S * 4 + 1) * y] = 0;
    for (let x = 0; x < S; x++) {
      let R = 0, G = 0, B = 0, A = 0;
      for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) { const o = ((y * SS + dy) * N + (x * SS + dx)) * 4; R += buf[o]; G += buf[o + 1]; B += buf[o + 2]; A += buf[o + 3]; }
      const n = SS * SS, off = (S * 4 + 1) * y + 1 + x * 4;
      raw[off] = Math.round(R / n); raw[off + 1] = Math.round(G / n); raw[off + 2] = Math.round(B / n); raw[off + 3] = Math.round(A / n);
    }
  }
  return raw;
}
function png(S) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(renderRaw(S), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const iconsDir = path.join(__dirname, '..', 'extension', 'icons');
const distDir = path.join(__dirname, '..', 'dist');
fs.mkdirSync(iconsDir, { recursive: true });
fs.mkdirSync(distDir, { recursive: true });
for (const s of [16, 48, 128]) fs.writeFileSync(path.join(iconsDir, `${s}.png`), png(s));
fs.writeFileSync(path.join(distDir, 'streamgrab-icon-128.png'), png(128));

// 512px master for electron-builder — it converts build/icon.png into the
// Windows .ico used for the app exe, installer, and shortcuts.
const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, 'icon.png'), png(512));

console.log('Icons written: extension/icons/{16,48,128}.png, dist/streamgrab-icon-128.png, build/icon.png (512).');
