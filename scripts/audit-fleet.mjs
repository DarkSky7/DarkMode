/* audit-fleet.mjs -- walk a set of AliExpress pages in their OWN throwaway tab,
 * run the white/grey census on each, and report per-page numbers plus samples.
 *
 * WHY (2026-11-16): Mike's requirement is "every page" -- cart, orders, and the
 * product pages reachable from those plus the two home pages. Auditing that by
 * hand is one CDP session per page and a vision pass per screenshot, which is
 * both expensive and unreliable (a vision pass already declared the cart "fine"
 * while 290 elements were unrecoloured). One process, one tab, N navigations.
 *
 *   node scripts/audit-fleet.mjs --port 9223 [--sources u1,u2] [--urls u1,u2]
 *        [--max 6] [--settle 4000] [--out F:/tmp/ae-audit.json]
 *
 * It never touches the user's tabs: it creates its own tab and closes it.
 * Source pages are used only to COLLECT product links; --urls pages are audited
 * themselves (plus any product links they publish).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const PORT = opt('port', '9223');
const MAX = parseInt(opt('max', '6'), 10);
const SETTLE = parseInt(opt('settle', '4000'), 10);
const OUT = opt('out', 'F:/tmp/ae-audit.json');
const SOURCES = (opt('sources', '') || '').split(',').filter(Boolean);
const URLS = (opt('urls', '') || '').split(',').filter(Boolean);
if (!SOURCES.length && !URLS.length) {
  console.error('need --sources and/or --urls');
  process.exit(2);
}

const CENSUS = readFileSync(new URL('./probe-white-census.js', import.meta.url), 'utf8');
const POST = readFileSync(new URL('./probe-post-paint.js', import.meta.url), 'utf8');
/* No regex here on purpose: the first version was written inside a template
 * literal and the escaping (\\\\/) produced "Invalid or unexpected token", so the
 * collector silently returned [] on every page. Plain substring tests cannot be
 * mis-escaped. */
const LINKJS = `(() => {
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const h = a.href || '';
    if (!h.includes('aliexpress.')) continue;
    if (h.includes('/item/') || h.includes('/i/')) out.push(h.split('?')[0].split('#')[0]);
  }
  return [...new Set(out)];
})()`;

const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let loadFlag = false, loadSession = null;
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  } else if (m.method === 'Page.loadEventFired') {
    loadFlag = true; loadSession = m.sessionId;
  }
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank', background: true });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);

const ev = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
};

const goto = async (url) => {
  loadFlag = false;
  await send('Page.navigate', { url }, sessionId);
  const t0 = Date.now();
  while (!loadFlag && Date.now() - t0 < 30000) await sleep(200);
  await sleep(SETTLE);                      // SPA hydration: the sweep and the render both land late
  return ev('JSON.stringify({u: location.href, t: document.title, n: document.querySelectorAll("*").length})');
};

const found = new Set();
const report = [];

const collect = async (url) => {
  try {
    await goto(url);
    const links = await ev(LINKJS);
    (links || []).forEach((l) => found.add(l));
    console.error(`collected ${links ? links.length : 0} product links from ${url.slice(0, 60)}`);
  } catch (e) {
    console.error('collect failed ' + url.slice(0, 60) + ': ' + e.message.slice(0, 120));
  }
};

const audit = async (url, kind) => {
  try {
    const where = await goto(url);
    const c = await ev(CENSUS, true);
    const p = await ev(POST, true);          // what is STILL white/grey to the eye
    report.push({
      kind, url, finalUrl: JSON.parse(where).u, title: JSON.parse(where).t,
      elements: JSON.parse(where).n,
      considered: c.considered, tagged: c.tagged, untaggedNeutral: c.untaggedNeutral,
      formControls: c.formControls, alphaInk: c.alphaInk,
      stillLightChecked: p.checked, stillLight: p.residual,
      stillLightSamples: (p.samples || []).slice(0, 8),
      topColours: (c.topColours || []).slice(0, 6),
      misses: (c.misses || []).slice(0, 8),
    });
    console.error(`${kind}: ${url.slice(0, 50)} -> considered=${c.considered} tagged=${c.tagged} misses=${c.untaggedNeutral} STILL_LIGHT=${p.residual}`);
  } catch (e) {
    report.push({ kind, url, error: e.message.slice(0, 200) });
    console.error(`${kind}: ${url.slice(0, 58)} FAILED ${e.message.slice(0, 100)}`);
  }
};

for (const u of SOURCES) await collect(u);
for (const u of URLS) await audit(u, 'page');
const products = [...found].slice(0, MAX);
for (const u of products) await audit(u, 'product');

await send('Target.closeTarget', { targetId }).catch(() => {});
ws.close();
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  out: OUT, audited: report.length, discoveredProducts: found.size,
  summary: report.map((r) => ({ kind: r.kind, url: (r.finalUrl || r.url || '').slice(0, 70), considered: r.considered, tagged: r.tagged, misses: r.untaggedNeutral, err: r.error ? 1 : 0 })),
}, null, 2));
