'use strict';

// Generates the StreamGrab icons (16/48/128 px) as PNGs: a white download
// arrow on the brand blue. No image libraries — encodes PNG directly via zlib.

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function png(S) {
  const bg = [0x4c, 0x8d, 0xff, 0xff];
  const fg = [0xff, 0xff, 0xff, 0xff];
  const raw = Buffer.alloc((S * 4 + 1) * S);
  const cx = S / 2;
  const stemHalf = S * 0.09, stemTop = S * 0.22, stemBot = S * 0.54;
  const headTop = S * 0.50, headBot = S * 0.80, headHalf = S * 0.27;
  for (let y = 0; y < S; y++) {
    raw[(S * 4 + 1) * y] = 0; // filter: none
    for (let x = 0; x < S; x++) {
      let px = bg;
      const inStem = x >= cx - stemHalf && x <= cx + stemHalf && y >= stemTop && y <= stemBot;
      let inHead = false;
      if (y >= headTop && y <= headBot) {
        const half = headHalf * (1 - (y - headTop) / (headBot - headTop));
        if (Math.abs(x - cx) <= half) inHead = true;
      }
      if (inStem || inHead) px = fg;
      const off = (S * 4 + 1) * y + 1 + x * 4;
      raw[off] = px[0]; raw[off + 1] = px[1]; raw[off + 2] = px[2]; raw[off + 3] = px[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const outDir = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const s of [16, 48, 128]) fs.writeFileSync(path.join(outDir, `${s}.png`), png(s));
console.log('Icons written:', ['16', '48', '128'].map((s) => `${s}.png`).join(', '), '->', outDir);
