/* frame-verify.mjs -- prove the frame behaviour of content.css + tuner.js with
 * the REAL extension in a THROWAWAY Brave.
 *
 *   node scripts/frame-verify.mjs [--dir <repo>] [--port 9333] [--out F:/tmp]
 *
 * WHY THIS HARNESS EXISTS (2026-11-21). The frame pass only exists as a content
 * script running INSIDE an iframe, at document_start; CDP injection into the top
 * frame cannot reach it. So the extension is loaded the only way Chromium loads
 * an unpacked extension -- `--load-extension` on a throwaway profile -- against a
 * local fixture served over http (file:// breaks the palette sampler and gives
 * every frame the opaque origin).
 *
 * THREE CASES, and the third is the one that protects the other two:
 *
 *   light frame + inverted page  -> container data-cr-frame="dark", frame html
 *                                   cr-frame-dark, ink tagged data-dm-fink,
 *                                   media re-inverted, crop near-black
 *   DARK frame + inverted page   -> untouched (a dark app must not be flipped)
 *   light frame + page NOT dark  -> untouched (nothing to darken)
 *
 * Exit code is the verdict: 0 only when every assertion passes.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DIR = opt('dir', new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PORT_CDP = Number(opt('port', '9333'));
const OUT = opt('out', 'F:/tmp/msi/images');
const BRAVE = opt('brave', 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe');
const ACCENT = [0x3e, 0x73, 0x8b];

/* ── the fixture ─────────────────────────────────────────────────────────── */
const PAGE_CSS = `
  body { margin:0; font:14px/1.5 system-ui, sans-serif; background:#fff; color:#111; }
  header { padding:14px 18px; border-bottom:1px solid #ddd; background:#fff; }
  h1 { font-size:17px; margin:0 0 6px; color:#111; }
  .grid { padding:16px; display:grid; grid-template-columns:repeat(3,1fr); gap:14px; }
  .card { border:1px solid #ddd; background:#fff; padding:10px; }
  .price { color:#c0392b; font-weight:700; }
  /* a saturated fill the bright-fill ceiling is expected to act on in the TOP
     document only: proves that pass still runs where it is allowed to */
  .cta { margin:14px 18px; padding:12px 16px; background:#00ffcc; color:#003b30; font-weight:700; }
`;
function topPage(frameSrc, inverted) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>top</title>
<link rel="stylesheet" href="/content.css"><style>${PAGE_CSS}</style></head><body>
<header><h1>Frame fixture — the page around the iframe</h1>
<p>Same shape as Home Depot's cart flyout: a same-origin, light, app-like panel.</p></header>
<div class="cta">Bright fill — cap me in the top document</div>
<div class="grid">
  <div class="card"><h3>Apollo 3/4 in. PVC Union</h3><p class="price">$8.24</p></div>
  <div class="card"><h3>Charlotte Pipe Adapter</h3><p class="price">$0.79</p></div>
  <div class="card"><h3>Charlotte Pipe 90&deg; Elbow</h3><p class="price">$0.87</p></div>
</div>
<iframe id="probe-frame" src="${frameSrc}" title="drawer stand-in"
  style="position:fixed;right:0;top:0;width:480px;height:560px;border:0;border-left:1px solid #ccc"></iframe>
<script>${inverted ? "document.documentElement.classList.add('cr-dark');" : ""}</script>
</body></html>`;
}
const LIGHT_FRAME = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>light drawer</title><style>
  html,body{margin:0;height:100%;background:#fff;color:#202020;font:14px/1.45 system-ui,sans-serif}
  .wrap{padding:16px 18px;background:#fff}
  h2{font-size:19px;margin:0 0 4px;color:#202020}
  .sub{color:#6f6f6f;margin:0 0 12px}
  .row{display:flex;gap:12px;align-items:center;border-top:1px solid #e2e2e2;padding:10px 0;background:#fff}
  .thumb{width:64px;height:64px;flex:0 0 64px;background:#f5f5f5}
  .name{font-weight:600;color:#202020}.qty{color:#4a4a4a}.price{color:#2e7d32;font-weight:700}
  button{background:#0a5bd3;color:#fff;border:0;border-radius:6px;padding:9px 14px;font:inherit;font-weight:600;margin-top:12px}
</style></head><body><div class="wrap">
  <h2>Added to Cart</h2><p class="sub">Apollo 3/4 in. x 3/4 in. PVC Slip Joint Union</p>
  <div class="row"><img class="thumb" id="thumb" src="/red.png" alt="">
    <div><div class="name">Apollo PVC Union</div><div class="qty">Qty: 1</div><div class="price">$8.24</div></div></div>
  <button>View Cart</button>
</div></body></html>`;
const DARK_FRAME = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>dark embed</title><style>
  html,body{margin:0;height:100%;background:#101014;color:#eaeaea;font:14px/1.45 system-ui,sans-serif}
  .wrap{padding:16px 18px} h2{color:#eaeaea;margin:0 0 8px} p{color:#b9b9b9}
</style></head><body><div class="wrap"><h2>Dark embed</h2>
<p>This frame ships its own dark theme; inverting it would fake a light page.</p>
<p>Second paragraph so the frame paints enough ink to measure.</p></div></body></html>`;

/* solid-red 64x64 PNG: restored media stays RED, a negative turns CYAN. */
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUElEQVR42u3PQREAAAQAMKTRP48wUni42xospzs+q3hOQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBA4N4CzZgBrHWnw5QAAAAASUVORK5CYII=',
  'base64');

const server = createServer((req, res) => {
  const u = (req.url || '/').split('?')[0];
  const send = (type, body) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
  if (u === '/content.css') {
    try { send('text/css', readFileSync(join(DIR, 'content.css'))); } catch (e) { res.writeHead(404); res.end(); }
    return;
  }
  if (u === '/red.png') return send('image/png', RED_PNG);
  if (u === '/child.html') return send('text/html', LIGHT_FRAME);
  if (u === '/child-dark.html') return send('text/html', DARK_FRAME);
  if (u === '/top.html') return send('text/html', topPage('/child.html', true));
  if (u === '/top-dark.html') return send('text/html', topPage('/child-dark.html', true));
  if (u === '/top-plain.html') return send('text/html', topPage('/child.html', false));
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/* ── throwaway Brave with the extension loaded ───────────────────────────── */
const profile = mkdtempSync(join(tmpdir(), 'dm-frame-'));
const brave = spawn(BRAVE, [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT_CDP}`,
  `--load-extension=${DIR}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1200,900', 'about:blank'
], { stdio: 'ignore' });

async function browserWs() {
  for (let i = 0; i < 80; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT_CDP}/json/version`)).json();
      if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(500);
  }
  throw new Error('throwaway browser never opened its debug port');
}
await browserWs();
const list = await (await fetch(`http://127.0.0.1:${PORT_CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  waiting.set(id, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const evalIn = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || 'eval threw');
  return r.result.value;
};
await send('Page.enable');
mkdirSync(OUT, { recursive: true });

async function cropStats(name, rect) {
  /* Page.captureScreenshot wants width/height, not w/h — and `clip` is PAGE space,
     so a scrolled page needs the scroll offset added (the fixture does not scroll,
     but the habit is what keeps the measurement honest). */
  const clip = { x: rect.x + 0, y: rect.y + 0, width: rect.w, height: rect.h, scale: 1 };
  const r = await send('Page.captureScreenshot', { format: 'png', clip });
  const zlib = await import('node:zlib');
  const buf = Buffer.from(r.data, 'base64');
  writeFileSync(join(OUT, name + '.png'), buf);
  /* decode the PNG ourselves: no PIL, no deps. 4x4 subsample is plenty for a
     mean-luminance and colour-fraction verdict. */
  let i = 8, w = 0, h = 0, colourType = 6; const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i), type = buf.toString('ascii', i + 4, i + 8);
    if (type === 'IHDR') {
      w = buf.readUInt32BE(i + 8);
      h = buf.readUInt32BE(i + 12);
      /* byte 9 = bit depth, byte 10 = colour type. Chromium hands back RGB (2),
         not RGBA (6), and a decoder that assumes 4 bytes per pixel reads every
         row at the wrong stride and returns a black image — measured here as
         lum 0.004 on a page PIL reads as 0.985. Take it from the header. */
      colourType = buf.readUInt8(i + 17);
    }
    if (type === 'IDAT') idat.push(buf.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = colourType === 2 ? 3 : colourType === 0 ? 1 : 4;
  const stride = w * bpp + 1, out = Buffer.alloc(w * h * bpp);
  let prev = Buffer.alloc(w * bpp);
  for (let y = 0; y < h; y++) {
    const f = raw[y * stride], line = raw.subarray(y * stride + 1, y * stride + 1 + w * bpp), cur = Buffer.alloc(w * bpp);
    for (let x = 0; x < w * bpp; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
    cur.copy(out, y * w * bpp); prev = cur;
  }
  let n = 0, white = 0, accent = 0, red = 0, lumSum = 0;
  for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) {
    const o = (y * w + x) * bpp, r = out[o], g = out[o + 1], b = out[o + 2];
    n++; lumSum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
    if (mn >= 190 && mx - mn <= 14) white++;
    if (Math.abs(r - ACCENT[0]) < 28 && Math.abs(g - ACCENT[1]) < 28 && Math.abs(b - ACCENT[2]) < 28) accent++;
    if (r > 150 && g < 90 && b < 90) red++;
  }
  return { path: join(OUT, name + '.png'), lum: +(lumSum / n).toFixed(3), white: +(white / n).toFixed(4), accent: +(accent / n).toFixed(4), red: +(red / n).toFixed(4) };
}

async function runCase(path, label) {
  await send('Page.navigate', { url: BASE + path });
  /* A window that is not the foreground one captures BLACK (measured here, three
     cases in a row at lum 0.004 while the DOM was correct) — the DOM verdict and
     the pixel verdict disagree, and the pixels are the lie. Activate first. */
  await send('Page.bringToFront');
  await sleep(6500);
  await send('Page.bringToFront');
  const t = await evalIn(`(() => {
    const f = document.getElementById('probe-frame');
    const r = f.getBoundingClientRect();
    let d = null; try { d = f.contentDocument; } catch (e) {}
    const w = d && d.defaultView;
    return {
      topCap: document.querySelectorAll('[data-dm-cap]').length,
      frameFilter: getComputedStyle(f).filter,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, scrollY: window.scrollY },
      frame: d ? {
        marker: f.getAttribute('data-cr-frame'),
        frameClass: d.documentElement.className,
        fink: d.querySelectorAll('[data-dm-fink]').length,
        cap: d.querySelectorAll('[data-dm-cap]').length,
        styleEl: !!d.getElementById('dm-frame-rules'),
        imgFilter: d.getElementById('thumb') ? w.getComputedStyle(d.getElementById('thumb')).filter : null,
        ink: d.querySelector('h2') ? w.getComputedStyle(d.querySelector('h2')).color : null
      } : null
    };
  })()`);
  const stats = await cropStats(label + '-frame', t.rect);
  return { t, stats };
}

const out = {};
out.light = await runCase('/top.html', 'fixture-light');
out.dark = await runCase('/top-dark.html', 'fixture-darkframe');
out.plain = await runCase('/top-plain.html', 'fixture-page-not-dark');

/* ── verdict ─────────────────────────────────────────────────────────────── */
const fails = [];
const ok = (name, cond, detail) => { if (!cond) fails.push(`${name}${detail ? ' — ' + detail : ''}`); };
const L = out.light, D = out.dark, P = out.plain;
ok('light frame is darkened by the page filter', L.t.frameFilter === 'none', 'frame filter ' + L.t.frameFilter);
ok('light frame marked on its container', L.t.frame && L.t.frame.marker === 'dark');
ok('light frame carries cr-frame-dark', L.t.frame && /cr-frame-dark/.test(L.t.frame.frameClass));
ok('light frame ink tagged', L.t.frame && L.t.frame.fink >= 3, 'tagged ' + (L.t.frame && L.t.frame.fink));
ok('light frame media restored', L.t.frame && /invert\(1\)/.test(L.t.frame.imgFilter || ''));
ok('light frame crop is dark', L.stats.lum < 0.15, 'lum ' + L.stats.lum);
ok('light frame crop carries the accent', L.stats.accent > 0.0005, 'accent ' + L.stats.accent);
ok('light frame photo is not a negative', L.stats.red > 0.002, 'red ' + L.stats.red);
ok('top document still caps bright fills', L.t.topCap > 0, 'caps ' + L.t.topCap);
ok('no fill capping inside the frame', L.t.frame && L.t.frame.cap === 0, 'caps ' + (L.t.frame && L.t.frame.cap));
ok('DARK frame left alone', D.t.frameFilter === 'invert(1)' && D.t.frame && !D.t.frame.marker && D.t.frame.fink === 0);
ok('DARK frame keeps its own theme', D.t.frame && !/cr-frame-dark/.test(D.t.frame.frameClass));
ok('page-not-dark: frame untouched', P.t.frame && !P.t.frame.marker && P.t.frame.fink === 0);
ok('page-not-dark: frame stays light', P.stats.lum > 0.8, 'lum ' + P.stats.lum);

console.log(JSON.stringify(out, null, 2));
ws.close();
try { brave.kill(); } catch (e) {}
server.close();
await sleep(800);
try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
if (fails.length) {
  console.error('\nFAILED (' + fails.length + '):');
  fails.forEach((f) => console.error('  ✖ ' + f));
  process.exit(1);
}
console.log('\nPASS — all frame assertions held (' + OUT + ')');
