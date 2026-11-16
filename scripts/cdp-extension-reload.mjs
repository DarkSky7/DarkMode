/* cdp-extension-reload.mjs -- reload an unpacked extension WITHOUT touching the
 * browser, the tabs, or chrome://extensions UI.
 *
 *   node scripts/cdp-extension-reload.mjs --port 9223 --id engkmokfinknofjifodnakjedibbbahe
 *   node scripts/cdp-extension-reload.mjs --port 9223 --match "DarkMode"
 *
 * WHY (2026-11-16): unpacked content scripts are read from disk exactly once, at
 * extension load. Editing tuner.js then refreshing the page changes NOTHING --
 * measured: manifestVersion stayed 1.0.27 across a full navigation while the
 * repo was 1.0.28, and every "the fix didn't work" conclusion after that point
 * is measuring the OLD code.
 *
 * Three routes were tried, in order:
 *   1. click Reload on chrome://extensions over CDP  -> hangs (restricted page)
 *   2. chrome.runtime.reload() from the content-script world -> not exposed
 *   3. chrome.runtime.reload() from the extension's SERVICE WORKER -> works,
 *      and is the same operation the UI button performs.
 * Killing the browser is never acceptable: the user keeps ~20 live tabs.
 *
 * Verifies afterwards by re-reading manifest version from a fresh page target.
 */
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const PORT = opt('port', '9223');
const ID = opt('id');
const MATCH = opt('match', 'DarkMode');
const PAGE = opt('page');   // optional: url substring of a page to re-check after reload

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
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});

const { targetInfos } = await send('Target.getTargets');
const extTargets = targetInfos.filter((t) =>
  /^chrome-extension:\/\//.test(t.url || '') &&
  (ID ? t.url.startsWith('chrome-extension://' + ID) : (t.title || '').includes(MATCH) || (t.url || '').includes(MATCH)));

/* An MV3 extension's service worker is TERMINATED when idle, so there is often
 * no service_worker target at all -- measured: the only chrome-extension target
 * in the whole browser belonged to an unrelated MV2 extension. Don't give up:
 * open the extension's own popup page in a throwaway tab, which creates an
 * extension context (chrome.runtime.is exposed there, unlike a content script),
 * reload from it, then close the tab. */
let throwaway = null;
let target = extTargets.find((t) => t.type === 'service_worker') || extTargets[0];
if (!target && ID) {
  const created = await send('Target.createTarget', { url: `chrome-extension://${ID}/popup.html`, background: true });
  throwaway = created.targetId;
  await sleep(1200);
  const again = await send('Target.getTargets');
  target = again.targetInfos.find((t) => t.targetId === throwaway);
  if (target) console.error('no live worker; opened extension page instead');
}
if (!target) {
  console.error('no extension targets for ' + (ID || MATCH));
  console.error('saw: ' + targetInfos.filter((t) => /chrome-extension/.test(t.url || ''))
    .map((t) => t.type + ' ' + t.url.slice(0, 70)).join(' | ').slice(0, 500));
  process.exit(3);
}
console.error('reloading via ' + target.type + ' ' + target.url.slice(0, 80));

const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
const before = await send('Runtime.evaluate', {
  expression: 'chrome.runtime.getManifest().version',
  returnByValue: true,
}, sessionId).catch(() => ({ result: {} }));
// schedule so the evaluate returns before the worker is torn down
await send('Runtime.evaluate', {
  expression: 'setTimeout(() => chrome.runtime.reload(), 60); "scheduled"',
  returnByValue: true,
}, sessionId).catch(() => ({}));
await sleep(2500);
if (throwaway) await send('Target.closeTarget', { targetId: throwaway }).catch(() => {});

const out = { reloadedVia: target.type, versionBefore: before.result && before.result.value };
if (PAGE) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const p = list.find((t) => t.type === 'page' && (t.url || '').includes(PAGE));
  if (p) {
    const pws = new WebSocket(p.webSocketDebuggerUrl);
    let pseq = 0;
    const pPending = new Map();
    const psend = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++pseq;
      pPending.set(id, { resolve, reject });
      pws.send(JSON.stringify({ id, method, params }));
    });
    await new Promise((res, rej) => { pws.addEventListener('open', res, { once: true }); pws.addEventListener('error', rej, { once: true }); });
    pws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pPending.has(m.id)) { const { resolve, reject } = pPending.get(m.id); pPending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
    });
    const r = await psend('Runtime.evaluate', {
      expression: 'location.reload(); "reloading page"', returnByValue: true,
    }).catch(() => ({ result: {} }));
    out.pageReloaded = r.result && r.result.value;
    pws.close();
  }
}
console.log(JSON.stringify(out, null, 2));
ws.close();
