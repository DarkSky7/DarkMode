/* cdp-nav.mjs -- navigate an ALREADY-OPEN tab to a URL over CDP.
 *
 *   node scripts/cdp-nav.mjs --port 9223 --match "cart" --url https://example.com
 *   node scripts/cdp-nav.mjs --port 9223 --id D35E72D9... --url https://example.com
 *
 * Why this exists (2026-11-16): PUT /json/new?url=... opens the tab at
 * about:blank on current Chrome -- the query parameter is ignored -- so a probe
 * run against a "new" tab silently measures a blank document and reports zero
 * text elements. That reads exactly like "the page has no misses" if you are
 * not suspicious of a clean result. Navigate explicitly, then wait for the load
 * event (or the timeout), and only then probe.
 *
 * Prints {id, title, url} of the tab after navigation.
 */
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const PORT = opt('port', '9223');
const MATCH = opt('match');
const ID = opt('id');
const URL_ = opt('url');
const WAIT = parseInt(opt('wait', '25000'), 10);
if (!URL_ || (!MATCH && !ID)) {
  console.error('need --url and one of --match <url substring> | --id <targetId>');
  process.exit(2);
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find((t) => t.type === 'page' && (ID ? t.id === ID : (t.url || '').includes(MATCH)));
if (!target) {
  console.error('no page target matching ' + (ID || MATCH));
  process.exit(3);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
let loaded = false;
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  } else if (m.method === 'Page.loadEventFired') {
    loaded = true;
  }
});
await send('Page.enable');
await send('Page.navigate', { url: URL_ });
const started = Date.now();
while (!loaded && Date.now() - started < WAIT) await sleep(250);

// report where we actually ended up
const { result } = await send('Runtime.evaluate', {
  expression: 'JSON.stringify({t: document.title, u: location.href, n: document.querySelectorAll("*").length})',
  returnByValue: true,
});
console.log(JSON.stringify({ targetId: target.id, loaded, settleMs: Date.now() - started, after: JSON.parse(result.value) }, null, 2));
ws.close();
