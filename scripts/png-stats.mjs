/* png-stats.mjs -- decode a PNG and report exact pixel colour statistics.
 *
 *   node scripts/png-stats.mjs --in F:/tmp/ae/confirm.png [--json]
 *
 * WHY: vision is a useful second instrument but it contradicted itself here --
 * it described the same crop as "black background, teal text" and then as
 * "light blue background, white text". Contrast is arithmetic on measured
 * pixels, so this decodes the actual PNG (zlib + un-filter, no dependencies)
 * and reports the dominant fill colour, the dominant ink colour, and the WCAG
 * contrast ratio between them.
 *
 * Supports 8-bit non-interlaced PNG, colour types 0/2/4/6 -- what CDP emits.
 */
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const IN = opt('in');
if (!IN) { console.error('need --in <png>'); process.exit(2); }

const buf = readFileSync(IN);
if (buf.readUInt32BE(0) !== 0x89504e47) { console.error('not a PNG'); process.exit(3); }

let off = 8, W = 0, H = 0, bitDepth = 0, colorType = 0, interlace = 0;
const idat = [];
while (off < buf.length) {
  const len = buf.readUInt32BE(off);
  const type = buf.toString('ascii', off + 4, off + 8);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 'IHDR') {
    W = data.readUInt32BE(0); H = data.readUInt32BE(4);
    bitDepth = data[8]; colorType = data[9]; interlace = data[12];
  } else if (type === 'IDAT') idat.push(data);
  else if (type === 'IEND') break;
  off += 12 + len;
}
if (bitDepth !== 8 || interlace !== 0) { console.error(`unsupported png bitDepth=${bitDepth} interlace=${interlace}`); process.exit(4); }
const CH = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
if (!CH) { console.error('unsupported colorType ' + colorType); process.exit(5); }

const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = W * CH;
const px = Buffer.alloc(H * stride);
const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
};
let rp = 0;
for (let y = 0; y < H; y++) {
  const f = raw[rp++];
  const row = raw.subarray(rp, rp + stride); rp += stride;
  const cur = px.subarray(y * stride, (y + 1) * stride);
  const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
  for (let x = 0; x < stride; x++) {
    const a = x >= CH ? cur[x - CH] : 0;
    const b = prev ? prev[x] : 0;
    const c = (prev && x >= CH) ? prev[x - CH] : 0;
    let v = row[x];
    if (f === 1) v += a;
    else if (f === 2) v += b;
    else if (f === 3) v += (a + b) >> 1;
    else if (f === 4) v += paeth(a, b, c);
    cur[x] = v & 0xff;
  }
}

const lum = (c) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const H6 = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/* quantise to 6 bits per channel so anti-aliasing noise does not shatter a
   cluster into thousands of singletons */
const counts = new Map();
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * stride + x * CH;
    const r = px[i], g = CH >= 3 ? px[i + 1] : px[i], b = CH >= 3 ? px[i + 2] : px[i];
    const k = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let e = counts.get(k);
    if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; counts.set(k, e); }
    e.n++; e.r += r; e.g += g; e.b += b;
  }
}
const clusters = [...counts.values()]
  .map((e) => ({ n: e.n, c: [e.r / e.n, e.g / e.n, e.b / e.n] }))
  .sort((a, b) => b.n - a.n);
const total = W * H;

/* fill = biggest cluster; ink = biggest cluster far enough away in luminance
   to be a different colour rather than anti-aliasing fuzz */
const fill = clusters[0];
const fillL = lum(fill.c);
let ink = null;
for (const c of clusters.slice(1)) {
  const d = Math.abs(lum(c.c) - fillL);
  if (d > 0.12 && c.n >= Math.max(12, total * 0.002)) { ink = c; break; }
}
let contrast = null;
if (ink) {
  const a = lum(ink.c), b = fillL;
  contrast = +(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
}
const out = {
  file: IN, size: W + 'x' + H, pixels: total,
  fill: H6(fill.c), fillPct: +(100 * fill.n / total).toFixed(1), fillL: +fillL.toFixed(3),
  ink: ink ? H6(ink.c) : null,
  inkPct: ink ? +(100 * ink.n / total).toFixed(1) : null,
  inkL: ink ? +lum(ink.c).toFixed(3) : null,
  contrast: contrast,
  verdict: contrast == null ? 'single-colour region (no ink found)'
    : contrast >= 4.5 ? 'AA pass' : contrast >= 3 ? 'AA-large only' : 'FAIL',
  top: clusters.slice(0, 5).map((c) => H6(c.c) + ' ' + (100 * c.n / total).toFixed(1) + '%'),
};
console.log(JSON.stringify(out, null, 2));
