/* element-pixels.mjs -- measure one element's ACTUAL rendered colours.
 *
 *   node scripts/element-pixels.mjs --port 9223 --match "p/order" \
 *        --selector "button.comet-btn-primary" --nth 1 \
 *        --out F:/tmp/ae/btn.png [--whole] [--text "Confirm received"]
 *
 * WHY THIS EXISTS (2026-11-16): every earlier attempt to measure a single control
 * got the wrong pixels --
 *   * Page.captureScreenshot with a clip: the clip's scale is not applied the way
 *     the docs imply. A 224x32 CSS box at scale:2 produced a 531x76 PNG, i.e. a
 *     region 18% larger than the element, so the "measurement" covered a
 *     neighbouring panel. Vision caught it ("Total: $1") after the numbers had
 *     already been reported as if they described the button.
 *   * Decoding a crop gives no way to know it is the right crop.
 *
 * So: capture the WHOLE viewport (no clip, nothing to mis-scale), decode it,
 * derive the CSS->pixel scale from the image width against the layout viewport,
 * and cut the element's box out arithmetically. The derived scale is printed and
 * cross-checked against devicePixelRatio, and the crop is re-encoded to a PNG so
 * a second instrument (vision) can confirm the same pixels.
 *
 * Also reports WCAG contrast between the dominant fill and the dominant ink.
 */
import { writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const PORT = opt('port', '9223');
const MATCH = opt('match');
const ID = opt('id');
const SELECTOR = opt('selector');
const TEXT = opt('text');
const NTH = Number(opt('nth', '0'));
const OUT = opt('out');
const WHOLE = argv.includes('--whole');
if ((!SELECTOR && !TEXT) || (!MATCH && !ID)) { console.error('need --selector or --text, and --match or --id'); process.exit(2); }

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = ID ? list.find((t) => t.id === ID)
  : list.find((t) => t.type === 'page' && (t.url || '').includes(MATCH));
if (!target) { console.error('no page target'); process.exit(3); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');

const PRELUDE = `
  const HAS_INK = (cs) => { const b = cs.backgroundColor || ''; return b !== 'transparent' && b !== 'rgba(0, 0, 0, 0)'; };
  const HAS_GRAD = (cs) => (cs.backgroundImage || 'none') !== 'none';
`;

const detailExpr = `(() => {${PRELUDE}
  const sel = ${JSON.stringify(SELECTOR || '')};
  const want = ${JSON.stringify(TEXT || '')};
  let el = null;
  if (sel) el = document.querySelectorAll(sel)[${NTH}] || null;
  else {
    const hs = [];
    for (const e of document.querySelectorAll('body *')) {
      const t = (e.textContent || '').trim();
      if (!t || t.length > 60) continue;
      if (t.indexOf(want) < 0) continue;
      if (e.children.length > 4) continue;
      hs.push(e);
    }
    el = hs[${NTH}] || null;
  }
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const chain = [];
  for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
    const f = getComputedStyle(p).filter || '';
    if (f.indexOf('invert') >= 0) chain.push(p.tagName.toLowerCase() + ' ' + f.slice(0, 26));
  }
  return {
    tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 44),
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    /* innerWidth, NOT clientWidth: clientWidth excludes the scrollbar, so the
       derived CSS->pixel scale came out 1.1% high (1.324 vs a true DPR of 1.309)
       and every crop was shifted ~13 device px to the right, dragging a strip of
       page background into the measured region. */
    viewport: { w: window.innerWidth, h: window.innerHeight },
    dpr: window.devicePixelRatio,
    inlineStyle: (el.getAttribute('style') || '').slice(0, 240),
    bg: cs.backgroundColor, bgImage: cs.backgroundImage.slice(0, 110),
    color: cs.color, textFill: cs.webkitTextFillColor,
    invertChain: chain,
  };
})()`;

const d = await evaluate(detailExpr);
if (!d) { console.error('element not found'); process.exit(4); }
await sleep(450);

/* capture the whole viewport -- no clip means no clip-scale ambiguity */
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (!shot.result?.data) { console.error('capture failed: ' + JSON.stringify(shot.error)); process.exit(5); }
const png = Buffer.from(shot.result.data, 'base64');

/* ---- minimal PNG decode (8-bit, non-interlaced) ---- */
let off = 8, W = 0, H = 0, bd = 0, ct = 0, il = 0;
const idat = [];
while (off < png.length) {
  const len = png.readUInt32BE(off);
  const type = png.toString('ascii', off + 4, off + 8);
  const data = png.subarray(off + 8, off + 8 + len);
  if (type === 'IHDR') { W = data.readUInt32BE(0); H = data.readUInt32BE(4); bd = data[8]; ct = data[9]; il = data[12]; }
  else if (type === 'IDAT') idat.push(data);
  else if (type === 'IEND') break;
  off += 12 + len;
}
if (bd !== 8 || il !== 0) { console.error(`unsupported png bd=${bd} il=${il}`); process.exit(6); }
const CH = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
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
    if (f === 1) v += a; else if (f === 2) v += b;
    else if (f === 3) v += (a + b) >> 1; else if (f === 4) v += paeth(a, b, c);
    cur[x] = v & 0xff;
  }
}

/* derive the CSS->pixel scale from the image, not from an assumption */
const scale = W / d.viewport.w;
const region = WHOLE
  ? { x: 0, y: 0, w: W, h: H }
  : {
      x: Math.max(0, Math.round(d.rect.x * scale)),
      y: Math.max(0, Math.round(d.rect.y * scale)),
      w: Math.round(d.rect.w * scale),
      h: Math.round(d.rect.h * scale),
    };
if (region.x + region.w > W) region.w = W - region.x;
if (region.y + region.h > H) region.h = H - region.y;

const lum = (c) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const HX = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

const counts = new Map();
const pixelOf = (x, y) => {
  const i = y * stride + x * CH;
  return [px[i], CH >= 3 ? px[i + 1] : px[i], CH >= 3 ? px[i + 2] : px[i]];
};
for (let y = region.y; y < region.y + region.h; y++) {
  for (let x = region.x; x < region.x + region.w; x++) {
    const c = pixelOf(x, y);
    const k = ((c[0] >> 2) << 12) | ((c[1] >> 2) << 6) | (c[2] >> 2);
    let e = counts.get(k);
    if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; counts.set(k, e); }
    e.n++; e.r += c[0]; e.g += c[1]; e.b += c[2];
  }
}
const clusters = [...counts.values()]
  .map((e) => ({ n: e.n, c: [e.r / e.n, e.g / e.n, e.b / e.n] }))
  .sort((a, b) => b.n - a.n);
const total = region.w * region.h;
const fill = clusters[0];
const fillL = lum(fill.c);
let ink = null;
for (const c of clusters.slice(1)) {
  if (Math.abs(lum(c.c) - fillL) > 0.10 && c.n >= Math.max(10, total * 0.005)) { ink = c; break; }
}
let contrast = null;
if (ink) {
  const a = lum(ink.c), b = fillL;
  contrast = +(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
}
/* bracket the region by luminance regardless of cluster size (see note below) */
const pop = clusters.filter((c) => c.n >= Math.max(6, total * 0.0025));
const brightest = pop.reduce((p, c) => (lum(c.c) > lum(p.c) ? c : p), pop[0] || fill);
const darkest = pop.reduce((p, c) => (lum(c.c) < lum(p.c) ? c : p), pop[0] || fill);

/* re-encode the region as a PNG so vision can check the same pixels */
function encodePNG(w, h, getPix) {
  const rowBytes = w * 4 + 1;
  const rawOut = Buffer.alloc(h * rowBytes);
  for (let y = 0; y < h; y++) {
    rawOut[y * rowBytes] = 0;
    for (let x = 0; x < w; x++) {
      const c = getPix(x, y);
      const o = y * rowBytes + 1 + x * 4;
      rawOut[o] = c[0]; rawOut[o + 1] = c[1]; rawOut[o + 2] = c[2]; rawOut[o + 3] = 255;
    }
  }
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, cr]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rawOut)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
if (OUT) {
  const enc = encodePNG(region.w, region.h, (x, y) => pixelOf(region.x + x, region.y + y));
  writeFileSync(OUT, enc);
}

console.log(JSON.stringify({
  target: { title: target.title, url: target.url.slice(0, 80) },
  out: OUT || null,
  image: W + 'x' + H,
  cssViewport: d.viewport.w + 'x' + d.viewport.h,
  derivedScale: +scale.toFixed(4),
  devicePixelRatio: +d.dpr.toFixed(4),
  scaleAgreesWithDpr: Math.abs(scale - d.dpr) < 0.01,
  region,
  element: {
    tag: d.tag, cls: d.cls, rect: { x: Math.round(d.rect.x), y: Math.round(d.rect.y), w: Math.round(d.rect.w), h: Math.round(d.rect.h) },
    inlineStyle: d.inlineStyle, bg: d.bg, bgImage: d.bgImage,
    color: d.color, textFill: d.textFill, invertChain: d.invertChain,
  },
  pixels: {
    fill: HX(fill.c), fillPct: +(100 * fill.n / total).toFixed(1), fillL: +fillL.toFixed(3),
    ink: ink ? HX(ink.c) : null, inkPct: ink ? +(100 * ink.n / total).toFixed(1) : null,
    inkL: ink ? +lum(ink.c).toFixed(3) : null,
    contrast,
    verdict: contrast == null ? 'single-colour region'
      : contrast >= 4.5 ? 'AA pass' : contrast >= 3 ? 'AA-large only' : 'FAIL',
    /* THIN TEXT NEEDS EXTREMES, NOT CLUSTERS. A 12px label over a gradient fill
       never accumulates a large enough cluster to out-rank the gradient's own
       shades, so "biggest cluster far from the fill" picked a NEIGHBOURING SHADE
       and reported 3.94:1 for a label that actually renders at 4.62:1. The
       lightest and darkest reasonably-populated clusters bracket the glyph and
       the fill regardless of how few pixels the glyph covers. */
    brightest: HX(brightest.c), brightestPct: +(100 * brightest.n / total).toFixed(2), brightestL: +lum(brightest.c).toFixed(3),
    darkest: HX(darkest.c), darkestPct: +(100 * darkest.n / total).toFixed(2), darkestL: +lum(darkest.c).toFixed(3),
    extremesContrast: +(((Math.max(lum(brightest.c), lum(darkest.c)) + 0.05) / (Math.min(lum(brightest.c), lum(darkest.c)) + 0.05)).toFixed(2)),
    /* THE NUMBER THAT MATTERS for a text control: the brightest populated cluster
       (the glyph, on a dark theme) against the dominant fill. `contrast` above can
       be nonsense on a bordered button -- it compared the glyph against a 1px dark
       BORDER and reported 3.94:1 for a label that actually sits at 4.96:1. */
    labelContrast: +(((Math.max(lum(brightest.c), fillL) + 0.05) / (Math.min(lum(brightest.c), fillL) + 0.05)).toFixed(2)),
    labelVerdict: (function () {
      const c = (Math.max(lum(brightest.c), fillL) + 0.05) / (Math.min(lum(brightest.c), fillL) + 0.05);
      return c >= 4.5 ? 'AA pass' : c >= 3 ? 'AA-large only' : 'FAIL';
    })(),
    top: clusters.slice(0, 6).map((c) => HX(c.c) + ' ' + (100 * c.n / total).toFixed(1) + '%'),
  },
}, null, 2));
ws.close();
