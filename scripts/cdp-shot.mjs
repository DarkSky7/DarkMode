/* cdp-shot.mjs -- capture a PNG of an open tab over CDP.
 *
 *   node scripts/cdp-shot.mjs --port 9223 --match "shoppingcart" --out F:/tmp/ae/cart.png [--reload]
 *
 * WHY (2026-11-16): DOM-side counts are claims, not evidence. The same session
 * that reported "267 of 267 recoloured, 0 still light" sat next to a screenshot
 * full of white text, so every claim about colour now gets a pixel check.
 * --reload is offered because a page that predates a newly saved rule keeps
 * rendering the old paint until it re-parses.
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
const OUT = opt('out');
const RELOAD = argv.includes('--reload');
if (!MATCH || !OUT) { console.error('need --match and --out'); process.exit(2); }

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find((t) => t.type === 'page' && (t.url || '').includes(MATCH));
if (!target) { console.error('no page matching ' + MATCH); process.exit(3); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let loaded = false;
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  else if (m.method === 'Page.loadEventFired') loaded = true;
});
await send('Page.enable');
if (RELOAD) {
  loaded = false;
  await send('Page.reload', { ignoreCache: false });
  const t0 = Date.now();
  while (!loaded && Date.now() - t0 < 30000) await sleep(200);
  await sleep(4000);                       // let the sweep and lazy content land
}
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
const info = await send('Runtime.evaluate', { expression: 'JSON.stringify({u:location.href,t:document.title,tagged:document.querySelectorAll("[data-dm-tone]").length})', returnByValue: true });
console.log(JSON.stringify({ out: OUT, bytes: Buffer.from(shot.data, 'base64').length, page: JSON.parse(info.result.value) }, null, 2));
ws.close();
