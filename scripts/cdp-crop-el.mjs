/* cdp-crop-el.mjs -- find an element by its text, scroll it into view, re-read
 * its box, and capture that box as a PNG -- all in one CDP session.
 *
 *   node scripts/cdp-crop-el.mjs --port 9223 --match "p/order" \
 *        --text "Confirm received" --out F:/tmp/ae/confirm.png [--nth 0]
 *
 * WHY: capturing the box from a rect measured in an EARLIER tool call drifted --
 * the page re-rendered between the probe and the screenshot, so the crop showed
 * a different control's paint and the measurement described the wrong thing.
 * Measuring and capturing in one session, after scrollIntoView, keeps the box and
 * the pixels describing the same element.
 *
 * NO REGEX IN THE INJECTED CODE. A regex written inside a template string gets
 * its backslashes doubled on the way through, which produced
 * "Invalid regular expression: /rgba?\\\\(\\\\d/: Unterminated group" here and a
 * silently-never-matching probe on the cart banner. Plain string comparisons do
 * the same job and cannot be mangled.
 */
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const PORT = opt('port', '9223');
const MATCH = opt('match');
const TEXT = opt('text');
const SELECTOR = opt('selector');
const OUT = opt('out');
const NTH = Number(opt('nth', '0'));
if (!MATCH || (!TEXT && !SELECTOR) || !OUT) { console.error('need --match and --text or --selector, plus --out'); process.exit(2); }

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find((t) => t.type === 'page' && (t.url || '').includes(MATCH));
if (!target) { console.error('no page matching ' + MATCH); process.exit(3); }

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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');

/* Shared, regex-free helpers injected into the page. */
const PRELUDE = `
  const HAS_INK = (cs) => {
    const b = cs.backgroundColor || '';
    return b !== 'transparent' && b !== 'rgba(0, 0, 0, 0)';
  };
  const HAS_GRAD = (cs) => (cs.backgroundImage || 'none') !== 'none';
  const IS_INVERTED = (f) => String(f || '').indexOf('invert') >= 0;
  const HOLDERS = (want) => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const t = (el.textContent || '').trim();
      if (!t || t.length > 60) continue;
      if (t.indexOf(want) < 0) continue;
      if (el.children.length > 4) continue;
      out.push(el);
    }
    return out;
  };
  const PAINTER = (el) => {
    let n = el;
    for (let i = 0; i < 7 && n && n.nodeType === 1; i++, n = n.parentElement) {
      const cs = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      if ((HAS_INK(cs) || HAS_GRAD(cs)) && r.width > 40 && r.height > 14) return n;
    }
    return null;
  };
`;

const PICK = `const PICK = (() => {
  const sel = ${JSON.stringify(SELECTOR || '')};
  if (sel) {
    const list = document.querySelectorAll(sel);
    return { el: list[${NTH}] || null, count: list.length, by: 'selector' };
  }
  const holders = HOLDERS(${JSON.stringify(TEXT || '')});
  return { el: holders[${NTH}] || null, count: holders.length, by: 'text' };
})();`;

const infoExpr = `(() => {${PRELUDE}${PICK}
  if (!PICK.el) return { found: false, by: PICK.by, count: PICK.count };
  const n = PAINTER(PICK.el) || PICK.el;
  n.scrollIntoView({ block: 'center' });
  return { found: true, by: PICK.by, count: PICK.count, tag: n.tagName.toLowerCase() };
})()`;

const detailExpr = `(() => {${PRELUDE}${PICK}
  if (!PICK.el) return null;
  const n = PAINTER(PICK.el) || PICK.el;
  const r = n.getBoundingClientRect();
  const cs = getComputedStyle(n);
  const chain = [];
  for (let p = n; p && p.nodeType === 1; p = p.parentElement) {
    const f = getComputedStyle(p).filter || '';
    if (IS_INVERTED(f)) chain.push(p.tagName.toLowerCase() + ' ' + f.slice(0, 26));
  }
  return {
    tag: n.tagName.toLowerCase(), cls: String(n.className || '').slice(0, 44),
    matched: PICK.el === n ? 'self' : 'climbed',
    box: { x: r.x, y: r.y, w: r.width, h: r.height },
    /* Page.captureScreenshot clips in PAGE coordinates, not viewport
       coordinates. Passing the viewport rect after scrollIntoView() captured a
       region one order-item ABOVE the button -- the "Total: $1" panel -- so the
       pixel numbers described the wrong element entirely. Carry the scroll
       offset so the clip and the box refer to the same pixels. */
    page: { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height },
    scroll: { x: window.scrollX, y: window.scrollY },
    inlineStyle: (n.getAttribute('style') || '').slice(0, 240),
    bg: cs.backgroundColor, bgImage: cs.backgroundImage.slice(0, 100),
    color: cs.color, textFill: cs.webkitTextFillColor,
    invertChain: chain,
  };
})()`;

const info = await evaluate(infoExpr);
if (!info || !info.found) { console.error('not found: ' + JSON.stringify(info)); process.exit(4); }
await sleep(500);
const d = await evaluate(detailExpr);
if (!d) { console.error('element lost after scroll'); process.exit(5); }
if (d.box.w < 4 || d.box.h < 4) { console.error('degenerate box ' + JSON.stringify(d.box)); process.exit(6); }

const shot = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: d.page.x, y: d.page.y, width: d.page.w, height: d.page.h, scale: 2 },
  captureBeyondViewport: true,
});
if (!shot.result?.data) { console.error('capture failed: ' + JSON.stringify(shot.error)); process.exit(7); }
const png = Buffer.from(shot.result.data, 'base64');
writeFileSync(OUT, png);
/* Size assertion: a crop that is not the size we asked for is a crop of the
   wrong thing. This is the check that would have caught the viewport/page
   coordinate mixup immediately instead of after vision flagged it. */
const gotW = png.readUInt32BE(16);
const gotH = png.readUInt32BE(20);
const expW = Math.round(d.page.w * 2);
const expH = Math.round(d.page.h * 2);
const sizeOk = Math.abs(gotW - expW) <= 3 && Math.abs(gotH - expH) <= 3;
console.log(JSON.stringify({
  out: OUT, sizeOk, got: gotW + 'x' + gotH, expected: expW + 'x' + expH, engine: d,
}, null, 2));
if (!sizeOk) { console.error('SIZE MISMATCH -- crop is not the element box'); process.exit(8); }
ws.close();
