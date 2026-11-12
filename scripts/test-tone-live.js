(async function () {
  const out = [];
  const ok = (name, cond, detail) => out.push((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + String(detail) : ''));
  const SRC = window.__SRC || {};
  const writes = [];
  window.chrome = { storage: { sync: {
    get: function (k, cb) { cb && cb({}); return Promise.resolve({}); },
    set: function (o, cb) { writes.push(JSON.parse(JSON.stringify(o))); cb && cb(); return Promise.resolve(); }
  } }, runtime: { onMessage: { addListener: function () {} } } };

  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: SRC.css || '' }));
  document.documentElement.classList.add('cr-dark');
  document.head.appendChild(Object.assign(document.createElement('script'), { textContent: SRC.tuner || '' }));

  const inv = (h) => { const n = parseInt(h.slice(1), 16); return '#' + [255 - ((n >> 16) & 255), 255 - ((n >> 8) & 255), 255 - (n & 255)].map((x) => x.toString(16).padStart(2, '0')).join(''); };
  const hex = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s || ''); return m ? '#' + m[1].split(',').slice(0, 3).map((x) => (Number(x) | 0).toString(16).padStart(2, '0')).join('') : s; };
  const depth = (el) => { let n = 0, x = el; while (x && x.nodeType === 1) { if (/invert\(\s*(?:1|100%)\s*\)/.test(getComputedStyle(x).filter || '')) n++; x = x.parentElement; } return n; };
  // what the eye sees: -webkit-text-fill-color wins over color when the site sets it
  const shown = (el) => { const cs = getComputedStyle(el); const c = hex(cs.webkitTextFillColor || cs.color); return depth(el) % 2 === 1 ? inv(c) : c; };
  const ownsText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
  const textEls = () => [...document.querySelectorAll('body *')].filter(ownsText);

  const para = textEls().find((el) => /Turbulence is hard to miss/.test(el.textContent) && el.tagName === 'P');
  // Measured BEFORE the tuner touches anything: elements whose visible ink is
  // not `color` because the site sets -webkit-text-fill-color.
  const fillOnly = textEls().filter((el) => {
    const cs = getComputedStyle(el);
    return cs.webkitTextFillColor !== cs.color && shown(el) === '#e5e5e5';
  });
  const T = window.__dmTuner;
  T.open();
  const sr = document.getElementById('dm-tuner-root').shadowRoot;
  T.capture(para);

  // ── 1. the picker discovers the colour group
  const g = T.groups();
  const st0 = T.state();
  ok('dominant text colour discovered', g[0].colour === '#e5e5e5' && g[0].n >= 100,
     'top group ' + g[0].colour + ' x' + g[0].n);
  ok('paragraph has no class (the original blocker)', para.classList.length === 0,
     'classList=' + JSON.stringify([...para.classList]));
  const labels = [...sr.getElementById('scope').options].map((o) => o.text);
  ok('a colour scope is offered', labels.some((t) => /all text #e5e5e5/.test(t)), labels.join(' | '));
  ok('colour scope is the DEFAULT', st0.pending && st0.pending.match === 'color' && st0.pending.from === '#e5e5e5',
     JSON.stringify(st0.pending));
  ok('panel reports the sweep', /#e5e5e5/.test(sr.getElementById('groups').textContent),
     sr.getElementById('groups').textContent);

  // ── 2. recolour: one rule for the whole group
  const txt = sr.getElementById('txt');
  txt.value = '#00ffff';
  txt.dispatchEvent(new Event('input'));

  const after = textEls().map((el) => ({ el: el, c: shown(el) }));
  const st1 = T.state();
  const taggedNotCyan = [...document.querySelectorAll('[data-dm-tone]')].filter((el) => shown(el) !== '#00ffff');
  ok('one rule covers the whole colour group', st1.tagged >= 130,
     'tagged=' + st1.tagged + ' rendering cyan=' + after.filter((x) => x.c === '#00ffff').length + ' of ' + after.length + ' text elements');
  ok('every tagged element actually shows cyan', taggedNotCyan.length === 0,
     taggedNotCyan.length + ' exception(s): ' +
     taggedNotCyan.slice(0, 4).map((el) => el.tagName.toLowerCase() + '>' + (el.textContent || '').trim().slice(0, 16)).join(', '));
  ok('the picked paragraph is cyan', shown(para) === '#00ffff', shown(para));
  ok('the intro paragraph is cyan too', (function () {
    const p = textEls().filter((el) => el.tagName === 'P' && /Turbulence is hard to miss/.test(el.textContent))[0];
    return p && shown(p) === '#00ffff';
  })(), 'second copy of the same sentence');

  const h2 = textEls().filter((el) => el.tagName === 'H2')[0];
  ok('headings of the same colour follow', h2 && shown(h2) === '#00ffff',
     h2 ? h2.textContent.trim().slice(0, 26) + ' -> ' + shown(h2) : 'no h2');
  const strong = textEls().filter((el) => el.tagName === 'STRONG')[0];
  ok('inline strong/em follow', strong && shown(strong) === '#00ffff', strong ? shown(strong) : 'no strong');
  ok('site -webkit-text-fill-color ink is moved too',
     fillOnly.every((el) => shown(el) === '#00ffff'),
     fillOnly.length + ' element(s) on this page paint with fill instead of color');

  const link = textEls().filter((el) => el.tagName === 'A' && shown(el) === '#0079ff')[0];
  ok('differently-coloured links are left alone', !!link,
     link ? (link.textContent.trim().slice(0, 20) || '(icon)') + ' still #0079ff' : 'n/a');

  // ── 3. the write is the complement, one rule per parity
  ok('css writes the complement for inverted elements', /#ff0000/.test(st1.css), st1.css.slice(0, 200));
  /* One rule per parity for `color`, plus one per parity for SVG `fill` (so a
     gauge's own labels, which ignore `color`, can be reached) — six in total,
     invariant in the number of matched elements. The property being defended is
     "the stylesheet does not grow with the page". */
  ok('no selector list of hundreds of paths', (st1.css.match(/\{/g) || []).length <= 6,
     (st1.css.match(/\{/g) || []).length + ' css rule(s) for ' + st1.tagged + ' elements');

  // ── 4. re-sweep is idempotent (baseline, not our own cyan)
  const before = st1.tagged;
  T.sweep(); T.sweep();
  ok('re-sweep does not lose or duplicate tags', T.state().tagged === before, before + ' -> ' + T.state().tagged);

  // ── 5. persistence: the rule AND the host's "remembered" flag
  await T.save();
  const saved = writes.filter((w) => w && w.tuneRulesByHost).pop() || {};
  const hostWrite = writes.filter((w) => w && w.darkHosts).pop() || {};
  const rules = (saved.tuneRulesByHost || {})['quantamagazine.org'] || [];
  ok('rule persisted as a colour match',
     rules.length === 1 && rules[0].match === 'color' && rules[0].from === '#e5e5e5' && !!rules[0].id,
     JSON.stringify(rules));
  ok('saving also remembers the site, so a reload comes back dark',
     !!(hostWrite.darkHosts || {})['quantamagazine.org'],
     JSON.stringify(hostWrite.darkHosts || null));
  ok('still applied after saving', T.state().tagged === before, 'tagged=' + T.state().tagged);

  // ── 6. removing the rule reverts every element
  await T.forget();
  const back = textEls().map((el) => shown(el));
  ok('removing the rule reverts the page',
     document.querySelectorAll('[data-dm-tone]').length === 0 && back.filter((c) => c === '#00ffff').length === 0,
     'tagged=' + document.querySelectorAll('[data-dm-tone]').length);
  ok('paragraph back to its own colour', shown(para) === '#e5e5e5', shown(para));

  return out;
})()
