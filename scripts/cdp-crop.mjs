/* cdp-crop.mjs -- capture a small rectangular crop of an open tab, so a claim
 * about ONE control's colours can be checked against pixels rather than inferred
 * from computed styles.
 *
 *   node scripts/cdp-crop.mjs --port 9223 --match "p/order" \
 *        --rect 945,375,224,32 --out F:/tmp/ae/confirm.png [--pad 6]
 *
 * WHY: computed style is what the DOM says; the screenshot is what Mike sees.
 * A control can report a sensible background-color and still render light cyan
 * because an ancestor invert(1) flips whatever we paint. Cropping the control
 * lets vision (a second instrument) confirm the polarity, not just the number.
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
const RECT = (opt('rect') || '').split(',').map(Number);
const OUT = opt('out');
const PAD = Number(opt('pad', '6'));
if (!MATCH || !OUT || RECT.length !== 4 || RECT.some((v) => !isFinite(v))) {
  console.error('need --match --rect x,y,w,h --out');
  process.exit(2);
}

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
  const i = ++id;
  pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
await sleep(250);
const dpr = (await send('Runtime.evaluate', { expression: 'window.devicePixelRatio', returnByValue: true }))
  .result?.result?.value || 1;

const [x, y, w, h] = RECT;
const clip = {
  x: Math.max(0, x - PAD),
  y: Math.max(0, y - PAD),
  width: w + PAD * 2,
  height: h + PAD * 2,
  scale: 3,
};
const shot = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
if (!shot.result || !shot.result.data) { console.error('capture failed: ' + JSON.stringify(shot.error)); process.exit(4); }
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
console.log(JSON.stringify({ out: OUT, clip, devicePixelRatio: dpr, bytes: Buffer.from(shot.result.data, 'base64').length }, null, 2));
ws.close();
