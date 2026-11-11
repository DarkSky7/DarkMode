/* Cold-reload payload: the state of the page AFTER a reload, with a tuning rule
 * already in storage. Run under scripts/test-reload.py, which loads
 * content.css + content.js + tuner.js at document_start via CDP and then reads
 * the result — so everything here is the extension's own doing, not a test
 * harness applying rules by hand.
 *
 * Why this test exists: 1.0.17 shipped a tuner whose saved colour rule died on
 * reload. The mutation observer debounce waited for 250 ms of DOM quiet before
 * the first sweep, and a news page never goes quiet, so nothing was ever
 * tagged. It passed every earlier test because those injected the scripts into
 * an ALREADY-LOADED page, where a single immediate sweep finds everything.
 */
(async function () {
  const out = [];
  const ok = (name, cond, detail) => out.push((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + String(detail) : ''));

  const inv = (h) => { const n = parseInt(h.slice(1), 16); return '#' + [255 - ((n >> 16) & 255), 255 - ((n >> 8) & 255), 255 - (n & 255)].map((x) => x.toString(16).padStart(2, '0')).join(''); };
  const hex = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s || ''); return m ? '#' + m[1].split(',').slice(0, 3).map((x) => (Number(x) | 0).toString(16).padStart(2, '0')).join('') : s; };
  const depth = (el) => { let n = 0, x = el; while (x && x.nodeType === 1) { if (/invert\(\s*(?:1|100%)\s*\)/.test(getComputedStyle(x).filter || '')) n++; x = x.parentElement; } return n; };
  const shown = (el) => { const cs = getComputedStyle(el); const c = hex(cs.webkitTextFillColor || cs.color); return depth(el) % 2 === 1 ? inv(c) : c; };

  const stub = window.__DM_STUB || {};
  const remembered = stub.remembered !== false;
  const dark = /cr-dark/.test(document.documentElement.className);
  const tagged = document.querySelectorAll('[data-dm-tone]').length;
  const para = [...document.querySelectorAll('p')].find((el) => /Turbulence is hard to miss/.test(el.textContent));
  const h2 = [...document.querySelectorAll('h2')].find((el) => /Cascade of Chaos/.test(el.textContent));
  const rule = (window.__dmTuner && window.__dmTuner.state().perHost || [])[0] || null;

  ok('the saved rule was read back from storage',
     !!rule && rule.match === 'color' && rule.from === '#e5e5e5', JSON.stringify(rule));

  const ownsText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
  const taggedEls = [...document.querySelectorAll('body *')].filter((el) => el.hasAttribute && el.hasAttribute('data-dm-tone'));
  const notCyan = taggedEls.filter((el) => shown(el) !== '#00ffff');
  const kinds = {};
  taggedEls.forEach((el) => { const t = el.tagName.toLowerCase(); kinds[t] = (kinds[t] || 0) + 1; });

  if (remembered) {
    ok('the site is still darkened after a reload', dark, 'html class="' + document.documentElement.className + '"');
    ok('the colour rule reasserts itself without any click', tagged >= 100, tagged + ' elements tagged');
    ok('the picked paragraph is cyan again', !!para && shown(para) === '#00ffff', para ? shown(para) : 'no paragraph');
    ok('every tagged element actually renders cyan', notCyan.length === 0,
       notCyan.length + ' wrong: ' + notCyan.slice(0, 3).map((el) => el.tagName.toLowerCase() + '=' + shown(el)).join(' '));
    ok('the group really spans element kinds, not one class',
       Object.keys(kinds).length >= 4, JSON.stringify(kinds));
  } else {
    // Mike's exact state on 2026-11-11: a tuning rule was saved by 1.0.17, which
    // did NOT add the host to darkHosts. The reload therefore came back light and
    // the colour rule had nothing to match. A host with rules is meant to be
    // dark, so the tuner now repairs that itself.
    ok('a host with saved rules is remembered automatically', dark,
       'html class="' + document.documentElement.className + '"');
    ok('the rule applies without the user re-saving', tagged >= 100, tagged + ' elements tagged');
    ok('the picked paragraph is cyan again', !!para && shown(para) === '#00ffff', para ? shown(para) : 'no paragraph');
    ok('the repair was persisted, not just applied',
       (window.__writeLog || []).indexOf('darkHosts') !== -1, JSON.stringify(window.__writeLog || []));
  }

  // the observer must still catch content added long after load (SPA / infinite scroll)
  if (remembered && window.__dmTuner) {
    const probe = document.createElement('p');
    probe.textContent = 'late probe';
    probe.style.color = 'rgb(26, 26, 26)';
    document.body.appendChild(probe);
    await new Promise((r) => setTimeout(r, 600));
    ok('late-added content is tagged by the observer', !!probe.getAttribute('data-dm-tone'),
       String(probe.getAttribute('data-dm-tone')));
    probe.remove();
  }

  return out;
})()
