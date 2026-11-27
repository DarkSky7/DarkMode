/* shot-darkmode-pair.mjs — pixel proof: the same page with DarkMode ON and with
 * the engine class removed, so the difference is measured, not asserted.
 *
 *   node scripts/shot-darkmode-pair.mjs --port 9222 --url https://lite.cnn.com/
 *   python <skill>/scripts/pngstat.py out-on.png out-off.png --accent 47,158,174
 *
 * Page.bringToFront FIRST: a backgrounded tab captures a blank white frame,
 * which measures as a catastrophe that is not there.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const PORT = opt('port', '9222');
const URL_ = opt('url', 'https://lite.cnn.com/');
const OUT = opt('out', 'F:/tmp/msi/darkmode');
const SETTLE = parseInt(opt('settle', '5000'), 10);
mkdirSync(OUT.replace(/\//g, '\\'), { recursive: true });

async function targetNew() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
  return r.json();
}
async function closeTarget(id) { try { await fetch(`http://127.0.0.1:${PORT}/json/close/${id}`); } catch (e) {} }

function conn(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pend = new Map();
    const contexts = [];
    ws.onopen = () => res({
      contexts,
      send(method, params = {}) {
        const mid = ++id;
        return new Promise((r2) => { pend.set(mid, r2); ws.send(JSON.stringify({ id: mid, method, params })); });
      },
      close: () => ws.close()
    });
    ws.onerror = () => rej(new Error('ws error'));
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
      if (m.method === 'Runtime.executionContextCreated') {
        const c0 = (m.params && m.params.context) || {};
        contexts.push({ id: c0.id, name: c0.name, type: (c0.auxData && c0.auxData.type) || '' });
      }
    };
  });
}

const t = await targetNew();
const c = await conn(t.webSocketDebuggerUrl);
const shots = [];
try {
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Page.navigate', { url: URL_ });
  const start = Date.now();
  while (Date.now() - start < SETTLE) await sleep(250);
  await c.send('Page.bringToFront').catch(() => {});
  await sleep(1200);

  const on = await c.send('Page.captureScreenshot', { format: 'png' });
  const onPath = OUT + '/on.png';
  writeFileSync(onPath, Buffer.from(on.result.data, 'base64'));
  shots.push(onPath);

  const iso = c.contexts.filter((x) => x.type === 'isolated');
  const pick = iso.find((x) => /dark/i.test(x.name || ''));
  if (pick) {
    await c.send('Runtime.evaluate', { contextId: pick.id, returnByValue: true,
      expression: 'window.__darkMode ? window.__darkMode.revert() : null' });
  }
  await sleep(1500);
  const off = await c.send('Page.captureScreenshot', { format: 'png' });
  const offPath = OUT + '/off.png';
  writeFileSync(offPath, Buffer.from(off.result.data, 'base64'));
  shots.push(offPath);
  console.log(JSON.stringify({ url: URL_, shots }, null, 2));
} finally {
  try { c.close(); } catch (e) {}
  await closeTarget(t.id);
}
