/* test-plate-guard.mjs — does the MASTER palette refuse to tint ink that sits on
 * a bright or saturated plate?
 *
 *   node scripts/test-plate-guard.mjs --port 9222 --url https://lite.cnn.com/
 *
 * The live page may not contain the case at all (that is exactly how the
 * guard's compensating branch shipped untested in 1.0.x), so this builds it:
 *
 *   A  white ink, no plate            -> MUST be tagged (accent applies)
 *   B  white ink on a saturated blue  -> MUST NOT be tagged (contrast survives)
 *   C  white ink on a WHITE plate     -> MUST be tagged (the plate renders dark
 *                                        under the invert, so cyan is safe)
 *
 * Sweeps through the real __dmTuner.sweep() in the extension's own world, so the
 * code under test is the installed one, not a copy.
 */
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const PORT = opt('port', '9222');
const URL_ = opt('url', 'https://lite.cnn.com/');
const SETTLE = parseInt(opt('settle', '5000'), 10);

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
let failed = 0;
try {
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Page.navigate', { url: URL_ });
  const start = Date.now();
  while (Date.now() - start < SETTLE) await sleep(250);

  const iso = c.contexts.filter((x) => x.type === 'isolated');
  const pick = iso.find((x) => /dark/i.test(x.name || ''));
  if (!pick) { console.error('no DarkMode isolated world found'); process.exit(3); }

  await c.send('Runtime.evaluate', {
    expression: `(() => {
      const mk = (id, bg, colour) => {
        const d = document.createElement('div');
        d.id = id;
        d.setAttribute('style', 'background:' + bg + ';color:' + colour +
          ';padding:6px;font:16px sans-serif;display:block;width:220px;margin:4px');
        d.textContent = 'guard probe ' + id;
        document.body.appendChild(d);
        return d;
      };
      /* BLACK ink is what the engine turns INTO white: the page is inverted, so
         a site that paints #fff ink renders black and is not what the palette is
         for. Planting #fff here made every case "correctly skipped" and the test
         passed nothing but itself (measured 2026-11-27). */
      mk('dmprobeA', 'transparent', '#000000');
      mk('dmprobeB', 'rgb(26,115,232)', '#000000');
      mk('dmprobeC', 'rgb(255,255,255)', '#000000');
      return 'planted';
    })()`, returnByValue: true
  });

  const swept = await c.send('Runtime.evaluate', {
    contextId: pick.id, returnByValue: true,
    expression: '(() => { try { return window.__dmTuner.sweep(); } catch (e) { return "ERR " + e.message; } })()'
  });

  const read = await c.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const g = (id) => {
        const el = document.getElementById(id);
        return el ? el.getAttribute('data-dm-tone') : 'MISSING';
      };
      return { A_noPlate: g('dmprobeA'), B_bluePlate: g('dmprobeB'), C_whitePlate: g('dmprobeC') };
    })()`
  });

  const v = read.result.result.value;
  console.log(JSON.stringify({ url: URL_, swept: swept.result.result.value, tones: v }, null, 2));

  const check = (name, cond) => { if (!cond) { failed++; console.log('FAIL ' + name); } else console.log('pass ' + name); };
  check('A white ink on the page canvas is accented', !!v.A_noPlate);
  check('B white ink on a saturated blue plate is NOT accented', !v.B_bluePlate);
  check('C white ink on a white plate IS accented', !!v.C_whitePlate);
} finally {
  try { await c.send('Runtime.evaluate', {
    expression: `['dmprobeA','dmprobeB','dmprobeC'].forEach(function (i) { var e = document.getElementById(i); if (e) e.remove(); });`
  }); } catch (e) {}
  try { c.close(); } catch (e) {}
  await closeTarget(t.id);
}
process.exit(failed ? 1 : 0);
