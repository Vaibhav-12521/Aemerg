/* Draws the Aemerg mark: a didone A whose crossbar is lit like an ember
   filament, on the candlelit ground. The letterform echoes Bodoni Moda,
   the app's display face; the glowing bar is the ember in "Aemerg".

   PNGs are written through a small encoder so the project keeps its two
   dependencies. Run: node tools/make-icons.js */

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');

const GROUND = [0x17, 0x10, 0x0c];
const LIFT   = [0x3d, 0x2a, 0x1d];
const EMBER  = [0xe4, 0xa9, 0x50];
const ROSE   = [0xc9, 0x7b, 0x6e];
const IVORY  = [0xf7, 0xf0, 0xe4];
const HOT    = [0xff, 0xf1, 0xd2];

const mix = (a, b, t) => {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k
  ];
};

/* distance from p to segment ab, plus how far along the segment it landed */
function seg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len = vx * vx + vy * vy;
  let t = len === 0 ? 0 : (wx * vx + wy * vy) / len;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { d: Math.hypot(px - (ax + vx * t), py - (ay + vy * t)), t: t };
}

/* the glyph, in a 0..1 box. Returns how far inside the letter a point is
   (negative outside), and how close it is to the lit crossbar. */
function glyph(x, y) {
  const APEX_X = 0.5,  APEX_Y = 0.045;
  const LF_X   = 0.075, RF_X  = 0.925, FOOT_Y = 0.955;
  const BAR_Y  = 0.715;

  /* left stroke: the hairline */
  const L = seg(x, y, APEX_X, APEX_Y, LF_X, FOOT_Y);
  const lw = 0.020 + 0.026 * L.t;

  /* right stroke: the fat one, the didone contrast */
  const R = seg(x, y, APEX_X, APEX_Y, RF_X, FOOT_Y);
  const rw = 0.022 + 0.175 * Math.pow(R.t, 1.25);

  let inside = Math.max(lw - L.d, rw - R.d);

  /* flat serifs sitting on the baseline, one under each stroke */
  const serif = (cx, half) => {
    const dx = Math.abs(x - cx), dy = Math.abs(y - (FOOT_Y - 0.020));
    return Math.min(half - dx, 0.021 - dy);
  };
  inside = Math.max(inside, serif(LF_X + 0.010, 0.082), serif(RF_X - 0.030, 0.115));

  /* nothing hangs below the baseline: the round stroke caps are cut flat */
  if (y > FOOT_Y) inside = Math.min(inside, FOOT_Y - y);

  /* the crossbar, drawn between the two strokes at the bar height */
  const spanAt = (yy) => {
    const k = (yy - APEX_Y) / (FOOT_Y - APEX_Y);
    return [APEX_X + (LF_X - APEX_X) * k, APEX_X + (RF_X - APEX_X) * k];
  };
  const [bl, br] = spanAt(BAR_Y);
  const barDx = Math.min(x - (bl - 0.012), (br + 0.012) - x);
  const barDy = 0.030 - Math.abs(y - BAR_Y);
  const bar = Math.min(barDx, barDy);

  inside = Math.max(inside, bar);

  return { inside: inside, bar: bar };
}

function draw(size, opts) {
  const pad   = opts.pad;
  const round = opts.round;
  const px = Buffer.alloc(size * size * 4);
  const ss = 3;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const fx = x + (sx + 0.5) / ss;
          const fy = y + (sy + 0.5) / ss;

          /* rounded-rect tile */
          const rad = round * size;
          if (rad > 0) {
            const dx = Math.max(Math.abs(fx - size / 2) - (size / 2 - rad), 0);
            const dy = Math.max(Math.abs(fy - size / 2) - (size / 2 - rad), 0);
            if (Math.hypot(dx, dy) > rad) continue;
          }

          /* ground, warmed toward the middle where the bar sits */
          const gx = (fx - size * 0.5) / size;
          const gy = (fy - size * 0.62) / size;
          const glow = Math.max(0, 1 - Math.hypot(gx, gy) / 0.58);
          let col = mix(GROUND, LIFT, glow * glow * 0.9);

          /* glyph coordinates inside the padded box */
          const span = 1 - pad * 2;
          const ux = (fx / size - pad) / span;
          const uy = (fy / size - pad) / span;

          if (ux > -0.15 && ux < 1.15 && uy > -0.15 && uy < 1.15) {
            const q = glyph(ux, uy);

            /* the bar throws light onto the ground around it */
            if (q.bar > -0.16) {
              const halo = Math.max(0, 1 + q.bar / 0.16);
              col = mix(col, EMBER, halo * halo * 0.30);
            }

            if (q.inside > 0) {
              /* letter body: ember at the top falling to rose at the feet */
              col = mix(EMBER, ROSE, Math.pow(uy, 1.1));
              /* the crossbar is the lit filament */
              if (q.bar > 0) {
                const heat = Math.min(1, q.bar / 0.026);
                col = mix(col, HOT, 0.45 + 0.55 * heat);
              }
              /* a soft sheen down the fat stroke */
              const R2 = seg(ux, uy, 0.5, 0.045, 0.925, 0.955);
              const sheen = Math.max(0, 1 - Math.abs(R2.d - 0.03) / 0.05) * Math.max(0, R2.t - 0.25);
              col = mix(col, IVORY, sheen * 0.28);
            }
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
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
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
  { name: 'icon-192.png',          size: 192, pad: 0.18, round: 0.22 },
  { name: 'icon-512.png',          size: 512, pad: 0.18, round: 0.22 },
  { name: 'icon-maskable-512.png', size: 512, pad: 0.30, round: 0    },
  { name: 'apple-touch-icon.png',  size: 180, pad: 0.18, round: 0    },
  { name: 'favicon-64.png',        size: 64,  pad: 0.15, round: 0.22 }
];

for (const f of files) {
  const buf = png(f.size, draw(f.size, f));
  fs.writeFileSync(path.join(OUT, f.name), buf);
  console.log(f.name.padEnd(26) + f.size + 'x' + f.size + '  ' + buf.length + ' bytes');
}
