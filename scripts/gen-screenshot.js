'use strict';

// Renders a 1280x800 promo screenshot as a 24-bit PNG (color type 2, NO alpha),
// per Chrome Web Store requirements. Pure Node (zlib only); 2x supersampled for
// smooth edges. Draws a StreamGrab app-window mockup with download rows + the
// in-page floating Download pill on a dark gradient.

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length, 0); const t = Buffer.from(type, 'ascii'); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([t, data])), 0); return Buffer.concat([l, t, data, cr]); };
const lerp = (a, b, t) => a + (b - a) * t;

const W = 1280, H = 800, SS = 2, NW = W * SS, NH = H * SS;
const buf = Buffer.alloc(NW * NH * 3);

const px = (x, y, c) => { x |= 0; y |= 0; if (x < 0 || x >= NW || y < 0 || y >= NH) return; const o = (y * NW + x) * 3; buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; };
function inRR(x, y, x0, y0, x1, y1, rad) { if (x < x0 || x > x1 || y < y0 || y > y1) return false; let dx = 0, dy = 0; if (x < x0 + rad) dx = x0 + rad - x; else if (x > x1 - rad) dx = x - (x1 - rad); if (y < y0 + rad) dy = y0 + rad - y; else if (y > y1 - rad) dy = y - (y1 - rad); return dx * dx + dy * dy <= rad * rad; }
function roundRect(fx, fy, fw, fh, frad, c) { const x0 = fx * SS, y0 = fy * SS, x1 = (fx + fw) * SS, y1 = (fy + fh) * SS, rad = frad * SS; for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) if (inRR(x, y, x0, y0, x1, y1, rad)) px(x, y, c); }
function circle(fcx, fcy, fr, c) { const cx = fcx * SS, cy = fcy * SS, r = fr * SS; for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) { const dx = x - cx, dy = y - cy; if (dx * dx + dy * dy <= r * r) px(x, y, c); } }
function triDown(fcx, ftop, fhalf, fh, c) { const cx = fcx * SS, top = ftop * SS, half = fhalf * SS, h = fh * SS; for (let y = Math.floor(top); y <= Math.ceil(top + h); y++) { const t = (y - top) / h; const hw = half * (1 - t); for (let x = Math.floor(cx - hw); x <= Math.ceil(cx + hw); x++) px(x, y, c); } }
function triRight(fx, fcy, fw, fhalf, c) { const x0 = fx * SS, cy = fcy * SS, w = fw * SS, half = fhalf * SS; for (let x = Math.floor(x0); x <= Math.ceil(x0 + w); x++) { const t = (x - x0) / w; const hh = half * (1 - t); for (let y = Math.floor(cy - hh); y <= Math.ceil(cy + hh); y++) px(x, y, c); } }

// palette
const ACCENT = [0x4c, 0x8d, 0xff], GREEN = [0x34, 0xc7, 0x7b], PURPLE = [0xc3, 0x9b, 0xff];
const WIN = [0x1b, 0x20, 0x2b], BAR = [0x23, 0x2a, 0x38], LINE = [0x2c, 0x34, 0x44];
const NAME = [0x3a, 0x43, 0x54], SUB = [0x2b, 0x32, 0x42], WHITE = [255, 255, 255];

// background gradient
for (let y = 0; y < NH; y++) { const t = y / NH; const c = [Math.round(lerp(0x18, 0x0b, t)), Math.round(lerp(0x20, 0x0e, t)), Math.round(lerp(0x30, 0x16, t))]; for (let x = 0; x < NW; x++) { const o = (y * NW + x) * 3; buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; } }

// window
roundRect(148, 118, 984, 524, 20, LINE);   // border
roundRect(150, 120, 980, 520, 18, WIN);    // body
roundRect(150, 120, 980, 54, 18, BAR);     // title bar
circle(185, 147, 6, [0xff, 0x5f, 0x57]); circle(210, 147, 6, [0xfe, 0xbc, 0x2e]); circle(235, 147, 6, [0x28, 0xc8, 0x40]);
triRight(285, 147, 20, 12, ACCENT);        // brand play mark
roundRect(315, 141, 120, 12, 6, LINE);     // wordmark placeholder

// download rows
const rows = [
  { badge: ACCENT, pct: 1.00, fill: GREEN },
  { badge: GREEN, pct: 0.66, fill: ACCENT },
  { badge: PURPLE, pct: 0.40, fill: ACCENT },
  { badge: ACCENT, pct: 0.88, fill: ACCENT },
  { badge: GREEN, pct: 0.15, fill: ACCENT }
];
let ry = 196;
for (const r of rows) {
  roundRect(170, ry, 940, 78, 10, [0x1f, 0x25, 0x31]);      // row card
  roundRect(190, ry + 26, 62, 26, 6, r.badge);              // type badge
  roundRect(272, ry + 22, 360, 16, 8, NAME);               // title bar
  roundRect(272, ry + 46, 250, 10, 5, SUB);                // url bar
  roundRect(680, ry + 33, 250, 12, 6, BAR);                // progress track
  roundRect(680, ry + 33, Math.max(12, 250 * r.pct), 12, 6, r.fill); // progress fill
  roundRect(960, ry + 32, 70, 14, 7, SUB);                 // speed
  roundRect(1050, ry + 28, 44, 22, 6, [0x2b, 0x32, 0x42]); // action
  ry += 90;
}

// floating in-page Download pill (overlapping bottom-right)
roundRect(948, 596, 214, 66, 33, ACCENT);
// white down arrow inside the pill (left)
roundRect(984, 614, 10, 20, 3, WHITE);
triDown(989, 630, 16, 18, WHITE);
// count chip
roundRect(1104, 616, 40, 30, 15, [0xff, 0xff, 0xff]);
roundRect(1112, 623, 24, 16, 8, ACCENT);

// downsample NW/NH -> W/H, emit color-type-2 (RGB) scanlines
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[(W * 3 + 1) * y] = 0;
  for (let x = 0; x < W; x++) {
    let R = 0, G = 0, B = 0;
    for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) { const o = ((y * SS + dy) * NW + (x * SS + dx)) * 3; R += buf[o]; G += buf[o + 1]; B += buf[o + 2]; }
    const n = SS * SS, off = (W * 3 + 1) * y + 1 + x * 3;
    raw[off] = Math.round(R / n); raw[off + 1] = Math.round(G / n); raw[off + 2] = Math.round(B / n);
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit, color type 2 (RGB, no alpha)
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const out = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);

const dist = path.join(__dirname, '..', 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'streamgrab-screenshot-1280x800.png'), out);
console.log('Wrote dist/streamgrab-screenshot-1280x800.png (' + out.length + ' bytes)');
