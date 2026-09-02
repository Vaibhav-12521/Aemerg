/* Draws the Aemerg icon set: a warm heart on the candlelit ground.
   Writes PNGs with a small hand-rolled encoder so the project stays
   dependency-free. Run: node tools/make-icons.js */

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');

const GROUND = [0x17, 0x10, 0x0c];
const EMBER  = [0xe4, 0xa9, 0x50];
const ROSE   = [0xc9, 0x7b, 0x6e];
const IVORY  = [0xf7, 0xf0, 0xe4];

const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t)
];

/* the classic heart implicit curve, negative inside */
function heart(x, y) {
  const a = x * x + y * y - 1;
  return a * a * a - x * x * y * y * y;
}

function draw(size, opts) {
  const pad   = opts.pad;                    /* fraction of the canvas kept clear */
  const round = opts.round;                  /* corner radius, 0.5 = circle */
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const ss = 3;                              /* supersample factor */

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const fx = x + (sx + 0.5) / ss;
          const fy = y + (sy + 0.5) / ss;

          /* rounded-rect mask: distance to the inset rect, clipped at the radius */
          const rad = round * size;
          const dx = Math.max(Math.abs(fx - size / 2) - (size / 2 - rad), 0);
          const dy = Math.max(Math.abs(fy - size / 2) - (size / 2 - rad), 0);
          if (rad > 0 && Math.hypot(dx, dy) > rad) continue;

          /* ground with a candle glow toward the upper middle */
          const gx = (fx - size * 0.5) / size;
          const gy = (fy - size * 0.42) / size;
          const d = Math.sqrt(gx * gx + gy * gy);
          const glow = Math.max(0, 1 - d / 0.62);
          let col = mix(GROUND, [0x3a, 0x28, 0x1c], glow * glow * 0.85);

          /* the heart */
          const span = 1 - pad * 2;
          const hx = (fx / size - 0.5) / (span * 0.315);
          const hy = -((fy / size - 0.455) / (span * 0.30));
          const v = heart(hx, hy);
          if (v <= 0) {
            const t = Math.min(1, Math.max(0, (fy / size - 0.2) / 0.6));
            col = mix(EMBER, ROSE, t);
            const sheen = Math.max(0, 1 - Math.hypot(hx + 0.30, hy - 0.40) / 0.62);
            col = mix(col, IVORY, sheen * sheen * 0.5);
          }

          r += col[0]; g += col[1]; b += col[2]; a += 255;
        }
      }

      const n = ss * ss;
      const i = (y * size + x) * 4;
      if (a === 0) { px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0; continue; }
      px[i]     = Math.round(r / n);
      px[i + 1] = Math.round(g / n);
      px[i + 2] = Math.round(b / n);
      px[i + 3] = Math.round(a / n);
    }
  }
  return px;
}

/* ---- minimal PNG writer ---- */

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---- write them ---- */

fs.mkdirSync(OUT, { recursive: true });

const files = [
  { name: 'icon-192.png',           size: 192, pad: 0.10, round: 0.22 },
  { name: 'icon-512.png',           size: 512, pad: 0.10, round: 0.22 },
  { name: 'icon-maskable-512.png',  size: 512, pad: 0.30, round: 0    },
  { name: 'apple-touch-icon.png',   size: 180, pad: 0.12, round: 0    },
  { name: 'favicon-64.png',         size: 64,  pad: 0.06, round: 0.22 }
];

for (const f of files) {
  const buf = png(f.size, draw(f.size, f));
  fs.writeFileSync(path.join(OUT, f.name), buf);
  console.log(f.name.padEnd(26) + f.size + 'x' + f.size + '  ' + buf.length + ' bytes');
}
