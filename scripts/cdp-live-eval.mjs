/* cdp-live-eval.mjs -- run a probe file against a LIVE tab in an already-running
 * Chromium-family browser. Node 21+ (native WebSocket), no dependencies.
 *
 *   node scripts/cdp-live-eval.mjs --port 9223 --match "aliexpress.com/p/order" \
 *        --probe scripts/probe-order-page.js [--isolated]
 *
 * This is the counterpart to cdp-eval.mjs: that one launches a throwaway browser
 * and injects the engine; this one attaches to the user's own signed-in session,
 * which is the only way to inspect pages behind a login.
 *
 * --isolated runs the probe in a fresh isolated world (same DOM, no page
 * JavaScript): use it when a page's own scripts (Ghostery/uBO scriptlets are the
 * measured case) make page-world Runtime.evaluate throw for unrelated reasons.
 *
 * Prints the probe's return value as JSON. Read-only: it never clicks, types or
 * navigates, and it does not close the target.
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const PORT = opt('port', '9223');
const MATCH = opt('match');
const PROBE = opt('probe');
const ISOLATED = argv.includes('--isolated');
const EXTENSION = argv.includes('--extension');
if ((!MATCH && !opt('id')) || !PROBE) {
  console.error('need --probe <file> and either --match <url substring> or --id <targetId>');
  process.exit(2);
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
/* --id picks ONE tab exactly. Several tabs can share a URL substring (three cart
   tabs were open at once during this work), and probing "whichever matched
   first" means measuring a different document than the one the user is looking
   at while claiming it is theirs. */
const ONLY = opt('id');
const target = ONLY
  ? list.find((t) => t.id === ONLY)
  : list.find((t) => t.type === 'page' && (t.url || '').includes(MATCH));
if (!target) {
  console.error('no page target matching ' + MATCH);
  console.error('pages: ' + list.filter((t) => t.type === 'page').length);
  process.exit(3);
}
console.error('attached: ' + target.title + ' :: ' + target.url.slice(0, 90));

const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  }
});

const expression = readFileSync(PROBE, 'utf8');
let contextId;
if (EXTENSION) {
  /* Run inside the EXTENSION's own isolated world, where the content script
     lives: that is the only place its exposed handles (__crImgStats,
     __crShowsText) and its fetch behave as they do in production.
     A content script's context is NOT origin chrome-extension:// -- it reports
     the PAGE origin with auxData.type 'isolated' and the extension's name -- so
     the context is identified by probing for the handle, never by guessing from
     its name. */
  const contexts = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context);
  });
  await send('Runtime.enable');                 // listener FIRST, then enable
  await new Promise((r) => setTimeout(r, 1500));
  /* Find the extension world by its HANDLE first, then by NAME. The handle test
     alone fails on pages where the engine has not exposed __crImgStats yet (or
     never will, e.g. a site where dark mode was never enabled): the world is
     listed but every candidate is skipped and the tool exits 4. Measured on
     aliexpress.us in Chromium -- five isolated contexts present, DarkMode among
     them, no __crImgStats anywhere. --world <substring> matches the context name
     instead (e.g. --world DarkMode). */
  const candidates = contexts.filter((c) => c.auxData && c.auxData.type === 'isolated');
  const wanted = (argv[argv.indexOf('--world') + 1] || '').trim();
  if (argv.includes('--world')) {
    const byName = candidates.find((c) => (c.name || '').includes(wanted));
    if (byName) {
      console.error('extension world by name: ' + (byName.name || '(unnamed)') + ' origin=' + byName.origin);
      contextId = byName.id;
    }
  }
  for (const c of candidates) {
    if (contextId) break;
    const t = await send('Runtime.evaluate', {
      expression: 'typeof window.__crImgStats',
      contextId: c.id, returnByValue: true
    });
    if (t.result && t.result.value === 'function') {
      console.error('extension world: ' + (c.name || '(unnamed)') + ' origin=' + c.origin);
      contextId = c.id;
      break;
    }
  }
  if (!contextId) {
    console.error('no isolated world exposes __crImgStats; contexts: ' +
      contexts.map((c) => c.origin + '/' + (c.name || '') + '/' +
        JSON.stringify(c.auxData && c.auxData.type)).join(' | ').slice(0, 600));
    process.exit(4);
  }
} else if (ISOLATED) {
  await send('Page.enable').catch(() => {});
  await send('Runtime.enable').catch(() => {});
  const world = await send('Page.createIsolatedWorld', {
    frameId: (await send('Page.getFrameTree')).frameTree.frame.id,
    worldName: 'dm-probe',
    grantUniveralAccess: false,
  });
  contextId = world.executionContextId;
}

const res = await send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
  userGesture: false,
  ...(contextId ? { contextId } : {}),
});
ws.close();

if (res.exceptionDetails) {
  const d = res.exceptionDetails;
  console.error('PROBE THREW: ' + ((d.exception && d.exception.description) || d.text));
  process.exit(1);
}
console.log(JSON.stringify(res.result.value, null, 2));
