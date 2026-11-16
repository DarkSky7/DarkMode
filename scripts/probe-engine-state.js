/* probe-engine-state.js -- is the tuner actually running on THIS page, and what
 * rules does the profile hold? Run in the EXTENSION world (--extension) so
 * chrome.storage is reachable.
 *
 * The failure this exists for (2026-11-16): the AliExpress cart had 290
 * visible white/grey text elements and data-dm-tone="0". Two very different
 * causes look identical from the DOM -- no rule stored for this host, or a rule
 * stored but never swept (blocked observer, engine not injected, filter chain
 * changed). This tells them apart instead of guessing.
 */
(async () => {
  const out = { world: 'extension?' };
  try {
    out.hasStorage = typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local;
  } catch (e) { out.hasStorage = false; }

  // page-side facts, readable from either world
  const styleEl = document.getElementById('dm-tuner-rules');
  out.rulesheetChars = styleEl ? (styleEl.textContent || '').length : 0;
  out.rulesheetHead = styleEl ? (styleEl.textContent || '').slice(0, 220) : '';
  out.htmlClass = (document.documentElement.className || '').slice(0, 90);
  out.taggedCount = document.querySelectorAll('[data-dm-tone]').length;
  out.tunerRoot = !!document.getElementById('dm-tuner-root') || !!document.querySelector('[id^="dm-tuner"]');

  if (out.hasStorage) {
    /* Rules live in storage.SYNC (tuner's sget/sset use `sync`), not local.
     * Reading local alone reported "no rules" while a rule was plainly being
     * applied -- a probe that lies in the reassuring direction. Read both. */
    const area = (a) => new Promise((res) => a.get(null, (v) => res(v || {})));
    const local = await area(chrome.storage.local);
    let sync = {};
    try { sync = await area(chrome.storage.sync); } catch (e) { sync = { __error: String(e && e.message) }; }
    const data = Object.assign({}, local, sync);
    out.storageAreas = { localKeys: Object.keys(local).length, syncKeys: Object.keys(sync).length };
    const byHost = data.tuneRulesByHost || {};
    out.hostsWithRules = Object.keys(byHost);
    const mine = byHost[location.host] || [];
    const shape = (r) => ({
      id: r.id, match: r.match, from: r.from, color: r.color,
      bg: r.bg || '', min: r.min, sel: r.sel ? String(r.sel).slice(0, 60) : undefined,
    });
    out.hostRules = mine.map(shape);
    out.globalRules = (data.tuneRulesGlobal || []).map(shape);
    out.otherKeys = Object.keys(data).filter((k) => !/^tuneRules/.test(k)).slice(0, 12);
  }
  out.manifestVersion = (() => {
    try { return chrome.runtime.getManifest().version; } catch (e) { return 'n/a'; }
  })();
  return out;
})()
