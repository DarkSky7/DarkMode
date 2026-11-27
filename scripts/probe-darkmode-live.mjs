/* probe-darkmode-live.mjs — measure what the INSTALLED DarkMode does to a real
 * page, in a NEW tab, without touching the user's tabs.
 *
 *   node scripts/probe-darkmode-live.mjs --port 9222 --url https://example.com
 *   node scripts/probe-darkmode-live.mjs --port 9222 --url URL --settle 3000
 *
 * Why a new tab and an explicit Page.navigate (2026-11-27): PUT /json/new?<url>
 * ignores the query string on current Chrome, so a "new" target silently
 * measures about:blank, which reports zero text elements and reads exactly like
 * "nothing needed recolouring". And navigating the user's tab to look at
 * something is not ours to do.
 *
 * Two colour spaces, kept apart on purpose. `written` is what our stylesheet
 * declares; `rendered` is what the eye sees (255-written when the element's
 * invert parity is odd). Quoting `written` as if it were the accent is how a
 * correct page gets reported as broken.
 *
 * NO REGEX ESCAPES ANYWHERE. This file is a JS template literal wrapped around
 * page code; a single `\d` in the wrong place silently became `/d+/` and made a
 * residual audit return an empty list while seventeen elements were plain
 * white. Everything here parses with indexOf or `[0-9.]`-style classes instead.
 */
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 ? argv[i + 1] : d;
};
const PORT = opt('port', '9222');
const URL_ = opt('url');
const SETTLE = parseInt(opt('settle', '2500'), 10);
/* --set '{"dmInk":"#d98c00"}' writes storage from the extension's own world
   (only there is chrome.storage defined), then re-measures. That is how the
   palette, the site override and the two switches get tested on a live page
   instead of being asserted from the source. */
const SET = opt('set', null);
if (!URL_) { console.error('need --url'); process.exit(2); }

const PROBE = `(() => {
  const html = document.documentElement;
  const nums = (s) => (String(s || '').match(/[0-9.]+/g) || []).map(Number);
  const depth = (el) => {
    let n = 0, node = el;
    while (node && node.nodeType === 1) {
      const f = getComputedStyle(node).filter || '';
      const i = f.indexOf('invert(');
      if (i >= 0) {
        const v = parseFloat(f.slice(i + 7));
        if (!isNaN(v)) n += Math.round(v);
      }
      node = node.parentElement;
    }
    return n;
  };
  const renderedOf = (el) => {
    const m = nums(getComputedStyle(el).color);
    if (m.length < 3) return null;
    const d = depth(el) % 2;
    return d ? [255 - m[0], 255 - m[1], 255 - m[2]] : [m[0], m[1], m[2]];
  };
  const isNeutralWhite = (v) => v && Math.min(v[0], v[1], v[2]) >= 220
    && (Math.max(v[0], v[1], v[2]) - Math.min(v[0], v[1], v[2])) <= 26;
  const hex = (v) => '#' + v.map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('');
  const plateOf = (el) => {
    let node = el;
    while (node && node.nodeType === 1) {
      const bg = getComputedStyle(node).backgroundColor;
      const m = nums(bg);
      const a = m.length > 3 ? m[3] : 1;
      if (m.length >= 3 && a > 0.5) return bg;
      node = node.parentElement;
    }
    return 'none (page canvas)';
  };
  const tags = [...document.querySelectorAll('[data-dm-tone]')];
  const white = tags.filter((el) => isNeutralWhite(renderedOf(el)));
  return {
    url: location.href,
    ready: document.readyState,
    darkClass: html.classList.contains('cr-dark'),
    repaintClass: html.classList.contains('cr-repaint'),
    dataVer: html.getAttribute('data-dm-ver'),
    htmlFilter: getComputedStyle(html).filter,
    colorScheme: getComputedStyle(html).colorScheme,
    prefersDark: !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches),
    htmlBg: getComputedStyle(html).backgroundColor,
    bodyBg: document.body ? getComputedStyle(document.body).backgroundColor : null,
    toneTags: tags.length,
    defTags: tags.filter((el) => (el.getAttribute('data-dm-tone') || '').indexOf('dmDefInk') === 0).length,
    styleFound: !!document.getElementById('dm-tuner-rules'),
    styleLen: (document.getElementById('dm-tuner-rules') || {}).textContent
      ? document.getElementById('dm-tuner-rules').textContent.length : 0,
    stillWhite: white.length,
    residual: white.slice(0, 10).map((el) => ({
      text: (el.textContent || '').trim().slice(0, 30),
      tag: el.tagName.toLowerCase(),
      tone: el.getAttribute('data-dm-tone'),
      written: getComputedStyle(el).color,
      fill: getComputedStyle(el).webkitTextFillColor,
      parity: depth(el) % 2,
      plate: plateOf(el)
    })),
    sample: tags.slice(0, 6).map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 30),
      tone: el.getAttribute('data-dm-tone'),
      written: getComputedStyle(el).color,
      rendered: hex(renderedOf(el) || [0, 0, 0])
    }))
  };
})()`;

async function targetNew() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
  return r.json();
}
async function closeTarget(id) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/close/${id}`); } catch (e) {}
}

function conn(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pend = new Map();
    const events = [];
    const contexts = [];
    ws.onopen = () => res({
      events, contexts,
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
      /* Uncaught errors in ANY world (page, or the extension's isolated world)
         land here. Without this, a throw inside applyRules() is invisible: the
         stylesheet element and data-dm-ver are written BEFORE the sweep, so the
         page looks "loaded but un-tinted" with no error to read. */
      if (m.method === 'Runtime.exceptionThrown') {
        const d = (m.params && m.params.exceptionDetails) || {};
        events.push((d.exception && d.exception.description) || d.text || 'exception');
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        const a = ((m.params && m.params.args) || []).map((x) => x.value || x.description || '').join(' ');
        events.push('console.' + m.params.type + ': ' + a);
      }
      if (m.method === 'Runtime.executionContextCreated') {
        const c0 = (m.params && m.params.context) || {};
        contexts.push({
          id: c0.id, name: c0.name, origin: c0.origin,
          type: (c0.auxData && c0.auxData.type) || ''
        });
      }
    };
  });
}

const t = await targetNew();
const c = await conn(t.webSocketDebuggerUrl);
try {
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Page.navigate', { url: URL_ });
  const start = Date.now();
  while (Date.now() - start < SETTLE) await sleep(250);
  const out = await c.send('Runtime.evaluate', { expression: PROBE, returnByValue: true, awaitPromise: false });
  const report = (out.result && out.result.result && out.result.result.value) || out;

  /* The content script lives in an ISOLATED world: window.__dmTuner is not
     visible from the page realm, so "the hook is null" proves nothing. Ask the
     isolated context directly and drive one manual sweep there — the difference
     between "the sweep never ran" and "the sweep ran and matched nothing" is the
     whole diagnosis. */
  const iso = c.contexts.filter((x) => x.type === 'isolated');
  const pick = iso.find((x) => /dark/i.test(x.name || '')) || iso[iso.length - 1];
  if (pick) {
    const expr = `(() => {
      const t = window.__dmTuner;
      if (!t) return { tuner: false };
      const before = t.state();
      let swept = null;
      try { swept = t.sweep(); } catch (e) { swept = 'ERR ' + e.message; }
      const after = t.state();
      return {
        tuner: true, ctxName: ${JSON.stringify(pick.name)},
        taggedBefore: before.tagged, taggedAfter: after.tagged,
        sweptReturned: swept, ink: after.ink || null,
        accent: after.accent, siteOverride: after.siteOverride || '',
        toneNatural: (window.__darkMode ? window.__darkMode.tone(true) : null),
        coverage: after.coverage, defId: after.defRule ? after.defRule.id : null
      };
    })()`;
    const q = await c.send('Runtime.evaluate', { contextId: pick.id, returnByValue: true, expression: expr });
    report.isolated = (q.result && q.result.result && q.result.result.value) || q;
    report.isolatedContexts = iso.map((x) => x.name);
  }
  if (SET && pick) {
    const w = await c.send('Runtime.evaluate', {
      contextId: pick.id, awaitPromise: true, returnByValue: true,
      expression: `chrome.storage.sync.set(${SET}).then(() => 'ok').catch((e) => 'ERR ' + e.message)`
    });
    report.setResult = (w.result && w.result.result && w.result.result.value) || w;
    await sleep(1400);   // the onChanged listeners re-apply on every tab
    const after = await c.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    report.afterSet = (after.result && after.result.result && after.result.result.value) || after;
  }
  if (c.events.length) report.errors = c.events.slice(0, 12);
  console.log(JSON.stringify(report, null, 2));
} finally {
  try { c.close(); } catch (e) {}
  await closeTarget(t.id);
}
