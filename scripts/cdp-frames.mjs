/* cdp-frames.mjs -- run a probe in EVERY frame of a page (main frame + all
 * child frames / iframes), not just the top document.
 *
 *   node scripts/cdp-frames.mjs --port 9223 --match "shoppingcart" \
 *        --probe scripts/probe-find-sale-banner.js
 *
 * WHY (2026-11-16): Mike could see a bright red "11.11 Sale" strip that the
 * top-frame probe could not find ("bodyTextHas1111": false), and the extension's
 * content_scripts had no all_frames flag -- so whole sections of AliExpress
 * (recom-acs, store-proxy) were never darkened or capped at all. Auditing only
 * the top frame is how a glaring element stays "0 misses" forever. This walks
 * every out-of-process frame target belonging to the page and reports per-frame.
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const PORT = opt('port', '9223');
const MATCH = opt('match');
const PROBE = opt('probe');
if (!MATCH || !PROBE) { console.error('need --match and --probe'); process.exit(2); }

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && (t.url || '').includes(MATCH));
if (!page) { console.error('no page matching ' + MATCH); process.exit(3); }
const frames = list.filter((t) => t.type === 'iframe' && t.parentId === page.id);
const targets = [{ id: page.id, url: page.url, ws: page.webSocketDebuggerUrl, kind: 'main' }]
  .concat(frames.map((f) => ({ id: f.id, url: f.url, ws: f.webSocketDebuggerUrl, kind: 'iframe' })));

const expression = readFileSync(PROBE, 'utf8');
const results = [];
for (const t of targets) {
  try {
    const ws = new WebSocket(t.ws);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const out = await new Promise((resolve, reject) => {
      const id = 1;
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === id) m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      });
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
      setTimeout(() => reject(new Error('timeout')), 15000);
    });
    ws.close();
    results.push({ kind: t.kind, url: (t.url || '').slice(0, 70), value: out.result && out.result.value, threw: out.exceptionDetails ? 1 : 0 });
  } catch (e) {
    results.push({ kind: t.kind, url: (t.url || '').slice(0, 70), error: e.message.slice(0, 120) });
  }
}
const hits = results.filter((r) => r.value && (r.value.hit || (r.value.hits && r.value.hits.length)));
console.log(JSON.stringify({ frames: results.length, hits, all: results.map((r) => ({ kind: r.kind, url: r.url, err: r.error || null })) }, null, 2));
