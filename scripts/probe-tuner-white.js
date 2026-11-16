/* probe-tuner-white.js -- what does the tuner actually offer for WHITE text today?
 *
 * Runs in the extension's isolated world on a darkened page. Opens the real
 * panel, captures the biggest light-text element, and reports:
 *   - the scope list the user is shown, and which one is selected by default
 *   - the colour the knob is seeded with
 *   - what "≈ everything light -> cyan" then reaches, measured on the elements
 *     themselves rather than by trusting the panel's own count
 * The panel is left open; nothing is saved (pending rules are in-memory only).
 *
 * READ THIS BEFORE TRUSTING A RESULT: on an inverted page the rule writes the
 * COMPLEMENT of the intent (the page filter renders it back to cyan on screen).
 * A check for rgb(0,255,255) therefore reported 2 of 30 on a page that was in
 * fact correct. Expect what is WRITTEN, not what is seen.
 */
(async function () {
  const T = window.__dmTuner;
  const TONE_ATTR = 'data-dm-tone';
  const out = {};
  if (!T) return { error: 'no __dmTuner handle' };

  const flat = (s) => String(s || '').split(' ').join('');

  const invDepth = (el) => {
    let n = 0, x = el, g = 0;
    while (x && x.nodeType === 1 && g++ < 80) {
      if (getComputedStyle(x).filter.indexOf('invert(') !== -1) n++;
      const r = x.getRootNode && x.getRootNode();
      if (r && r.host) { x = r.host; continue; }
      x = x.parentElement;
    }
    return n;
  };
  const inverted = invDepth(document.body) % 2 === 1;

  /* what the stylesheet writes for the intent #00ffff */
  const WRITTEN_RGB = inverted ? '255,0,0' : '0,255,255';
  const wroteIntent = (ink) => {
    const s = flat(ink);
    return s.indexOf('rgb(' + WRITTEN_RGB) === 0 || s.indexOf('rgba(' + WRITTEN_RGB) === 0;
  };

  const lumOf = (ink) => {
    const m = /rgba?\(([^)]+)\)/.exec(ink || '');
    if (!m) return null;
    const p = m[1].split(',').map(Number);
    if (p.length > 3 && p[3] === 0) return null;
    const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]);
  };
  const inkOf = (el) => {
    const cs = getComputedStyle(el);
    return cs.webkitTextFillColor || cs.color;
  };
  /* WHAT THE EYE SEES, not what the element computes. On an inverted page a
     white-on-screen label computes near-black, so measuring computed ink finds
     exactly the wrong population (first version of this probe did, and reported
     "0 of 30 reached" about a page that was fine). */
  const renderedInk = (ink) => {
    if (!inverted) return ink;
    const m = /rgba?\(([^)]+)\)/.exec(ink || '');
    if (!m) return ink;
    const p = m[1].split(',').map(Number);
    const c = (v) => Math.max(0, Math.min(255, 255 - v));
    return (p.length > 3 ? 'rgba(' : 'rgb(') + c(p[0]) + ',' + c(p[1]) + ',' + c(p[2]) +
           (p.length > 3 ? ',' + p[3] : '') + ')';
  };
  const isLightOnScreen = (el) => {
    const L = lumOf(renderedInk(inkOf(el)));
    return L !== null && L >= 0.45;
  };
  const ownsText = (el) => {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName);
  };

  out.dark = document.documentElement.classList.contains('cr-dark');
  out.inverted = inverted;

  /* baseline: every element showing light ink */
  const lightEls = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!ownsText(el)) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 4 || b.height < 4) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    /* checkVisibility() is the only test that catches a hidden ANCESTOR (a
       collapsed dropdown keeps its items in the DOM with clean own styles, and
       counting those inflates "still light" with text nobody can see). */
    let shown = true;
    try {
      shown = el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true });
    } catch (e) {
      shown = !!(el.getClientRects().length);
    }
    if (!shown) continue;
    if (isLightOnScreen(el)) lightEls.push(el);
  }
  out.baseline = {
    lightTextElements: lightEls.length,
    sample: lightEls.slice(0, 5).map((el) => 'computed ' + flat(inkOf(el)) +
      ' renders ' + flat(renderedInk(inkOf(el))) + ' "' +
      (el.textContent || '').trim().slice(0, 16) + '"')
  };
  if (!lightEls.length) return out;

  /* capture the biggest one -- what a user would click */
  lightEls.sort((a, b) => {
    const A = a.getBoundingClientRect(), B = b.getBoundingClientRect();
    return B.width * B.height - A.width * A.height;
  });
  const target = lightEls[0];
  T.capture(target);

  const root = document.getElementById('dm-tuner-root');
  const sr = root && root.shadowRoot;
  if (!sr) return Object.assign(out, { error: 'panel did not open' });
  const scope = sr.getElementById('scope');
  out.panel = {
    capturedElement: (target.textContent || '').trim().slice(0, 30),
    capturedInkComputed: flat(inkOf(target)),
    scopes: [].slice.call(scope.options).map((o) => o.text.trim()),
    defaultScope: scope.value,
    knobColour: (sr.getElementById('txt') || {}).value,
    verifyLine: (sr.getElementById('verify') || {}).textContent
  };

  /* one click: everything light -> cyan */
  T.light('#00ffff');
  await new Promise((r) => setTimeout(r, 2000));

  let cyan = 0, tagged = 0, neither = 0, stillLight = 0;
  const misses = [];
  for (const el of lightEls) {
    const ink = inkOf(el);
    const hasAttr = el.hasAttribute(TONE_ATTR);
    if (hasAttr) tagged++;
    if (wroteIntent(ink)) { cyan++; continue; }
    if (!hasAttr) neither++;
    if (isLightOnScreen(el)) stillLight++;
    if (misses.length < 6) {
      misses.push({
        ink: flat(ink), renders: flat(renderedInk(ink)), tagged: hasAttr, tag: el.tagName,
        cls: (el.getAttribute('class') || '').slice(0, 34),
        text: (el.textContent || '').trim().slice(0, 16)
      });
    }
  }

  out.afterLightRule = {
    wroteThis: WRITTEN_RGB,
    elementsNowCyan: cyan,
    ofLightTextElements: lightEls.length,
    taggedWithToneAttr: tagged,
    neitherTaggedNorCyan: neither,
    stillLight: stillLight,
    misses: misses,
    taggedInState: T.state().tagged,
    ruleCss: (T.state().css || '').slice(0, 240),
    coverage: T.state().coverage,
    coverageLine: (sr.getElementById('coverage') || {}).textContent,
    verifyLine: (sr.getElementById('verify') || {}).textContent
  };
  return out;
})();
