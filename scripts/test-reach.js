/* Regression: "a bunch of numeric text switched, lots of non-numeric text
 * stayed white. We need a way to reach more classes."
 *
 * The failure was the DEFAULT scope: picking the big numeric temperature chose
 * `.fdp-val` (56 elements) instead of the colour group (129), so the values
 * recoloured and the labels did not — and the panel never said what it had
 * left behind. This asserts the default now covers every visible light text
 * element, that "everything light" is offered as a scope, and that the tagged
 * set equals what the pixels show.
 */
(async () => {
  const TONE = 'data-dm-tone';
  const MODE = window.__REACH_MODE || 'after';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { checks: [], mode: MODE };
  const chk = (name, ok, detail) => out.checks.push((ok ? 'PASS ' : 'FAIL ') + name + ' :: ' + detail);

  const comp = (n) => 255 - n;
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (r, g, b) => 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  const rgb = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(',').map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const hex = (c) => '#' + [c.r, c.g, c.b].map((n) => (n | 0).toString(16).padStart(2, '0')).join('');
  const ownText = (el) => {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return n.nodeValue.trim();
    }
    return '';
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return parseFloat(cs.opacity) > 0.05;
  };
  /* Rendered colour, computed independently of the extension so the assertion
     is not the code marking its own homework. */
  const renderOf = (el) => {
    const cs = getComputedStyle(el);
    let ink = cs.webkitTextFillColor || cs.color;
    if (el.namespaceURI === 'http://www.w3.org/2000/svg' && /^text$/i.test(el.tagName) &&
        cs.fill && cs.fill !== 'none' && !/^currentcolor$/i.test(cs.fill)) ink = cs.fill;
    const c = rgb(ink);
    if (!c || c.a < 0.999) return null;
    const depth = 1 + (el.closest('[data-cr-bgphoto="1"]') ? 1 : 0);
    const o = depth % 2 ? { r: comp(c.r), g: comp(c.g), b: comp(c.b) } : c;
    return { hex: hex(o), L: lum(o.r, o.g, o.b) };
  };
  const lightRects = () => {
    const res = [];
    for (const el of Array.from(document.querySelectorAll('body *')).slice(0, 9000)) {
      if (el.closest('#dm-tuner-root') || !ownText(el) || !visible(el)) continue;
      const r = renderOf(el);
      if (!r || r.L <= 0.45) continue;
      const b = el.getBoundingClientRect();
      res.push({
        txt: ownText(el).slice(0, 18), colour: r.hex, tagged: el.hasAttribute(TONE),
        x: Math.round(b.left), y: Math.round(b.top),
        w: Math.round(b.width), h: Math.round(b.height)
      });
    }
    return res;
  };

  const before = lightRects();
  chk('page is inverted', document.documentElement.classList.contains('cr-dark'),
      document.documentElement.className);

  /* Baseline run: no rules at all, plus a rect list of every text element. The
     pixel half of this test needs its OWN "before" screenshot — the page
     reflows while the panel is driven (the map expands), so a rect measured
     before the interactions does not sit on the same pixels afterwards. */
  const allTextRects = () => {
    /* Only text that the pixel check can judge honestly: skip the map (which
       keeps its true colours on purpose — its canvas is re-inverted) and the
       icon buttons whose "text" is transparent over an image. Everything else
       that owns ink on this dashboard sits on a card that the inversion already
       darkened, so white ink there is white text. */
    const res = [];
    for (const el of Array.from(document.querySelectorAll('body *')).slice(0, 9000)) {
      if (el.closest('#dm-tuner-root') || el.closest('.component-map') || !ownText(el) || !visible(el)) continue;
      const ink = rgb(getComputedStyle(el).webkitTextFillColor || getComputedStyle(el).color);
      if (!ink || ink.a < 0.5) continue;
      const b = el.getBoundingClientRect();
      if (b.left < 0 || b.top < 0 || b.left + b.width > innerWidth || b.top + b.height > innerHeight) continue;
      res.push({
        txt: ownText(el).slice(0, 18), colour: (renderOf(el) || {}).hex || '',
        x: Math.round(b.left), y: Math.round(b.top),
        w: Math.round(b.width), h: Math.round(b.height)
      });
    }
    return res;
  };
  if (MODE === 'baseline') {
    out.lightText = before.length;
    out.rects = allTextRects().slice(0, 500);
    chk('baseline: the dashboard has plenty of light text to reach', before.length >= 60,
        before.length + ' elements, ' + out.rects.length + ' text rects recorded');
    return out;
  }

  chk('the dashboard has plenty of light text to reach', before.length >= 60, before.length + ' elements');

  __dmTuner.open();
  await sleep(200);
  const pickEl = (() => {
    let best = null, bestFs = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('#dm-tuner-root') || !ownText(el) || !visible(el)) continue;
      if (!/^-?\d+(\.\d+)?$/.test(ownText(el).trim())) continue;
      const r = renderOf(el);
      if (!r || r.L <= 0.45) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
      if (fs > bestFs) { bestFs = fs; best = el; }
    }
    return best;
  })();
  const mineColour = pickEl ? renderOf(pickEl).hex : '#cecdc9';
  chk('found a numeric reading to pick', !!pickEl, pickEl ? ownText(pickEl) + ' @' + getComputedStyle(pickEl).fontSize : 'none');
  __dmTuner.capture(pickEl);
  await sleep(400);

  const opts = __dmTuner.options();
  const chosen = opts.find((o) => o.chosen) || {};
  out.options = opts.map((o) => (o.chosen ? '** ' : '   ') + o.t);
  chk('default scope reaches a colour group, not one class',
      chosen.v === '__tone' || chosen.v === '__light', chosen.v + ' :: ' + chosen.t);
  chk('an "everything light" scope is offered',
      !!opts.find((o) => o.v === '__light'),
      (opts.find((o) => o.v === '__light') || {}).t || 'missing');

  const covOpen = __dmTuner.coverage();
  chk('the live preview already covers the picked group', covOpen.total > 0 && covOpen.done >= covOpen.total * 0.9,
      JSON.stringify(covOpen));

  /* A real save picks a colour. Orange is deliberately NOT neutral (r≈g≈b), so
     the pixel check can tell "still white" from "recoloured". */
  if (chosen.v === '__light') __dmTuner.light('#ff8800');
  else __dmTuner.tone(mineColour, '#ff8800');
  await sleep(400);
  await __dmTuner.save();
  await sleep(900);
  const covSaved = __dmTuner.coverage();
  out.coverageDefault = covSaved;
  chk('the DEFAULT save leaves no visible light text', covSaved.total >= 60 && covSaved.left === 0,
      JSON.stringify(covSaved));

  /* The wider reach, exactly as the button applies it. */
  __dmTuner.light('#00ffff');
  await sleep(500);
  const covLight = __dmTuner.coverage();
  out.coverageLight = covLight;
  chk('"everything light" covers at least as much',
      covLight.left === 0 && covLight.done >= covSaved.done, JSON.stringify(covLight));
  await __dmTuner.save();
  await sleep(900);

  const stillLight = lightRects().filter((x) => !x.tagged);
  out.stillLight = stillLight.slice(0, 12);
  chk('no light text element is left untagged', stillLight.length === 0,
      stillLight.length + ' left' + (stillLight.length ? ' e.g. ' + stillLight.map((x) => x.txt).slice(0, 5).join(' | ') : ''));

  const st = __dmTuner.state();
  out.tagged = st.tagged;
  out.rules = st.perHost;
  out.css = st.css.slice(0, 500);
  chk('rules persisted for the host', st.perHost.length >= 1, JSON.stringify(st.perHost.map((r) => r.match || r.sel)));
  chk('the emitted rule paints SVG text with fill',
      /fill:/.test(st.css), st.css.indexOf('fill:') >= 0 ? 'present' : 'absent');
  chk('tagged set is not inflated by our own panel',
      st.tagged >= covLight.done && st.tagged < covLight.done + 40, st.tagged + ' tagged / ' + covLight.done + ' expected');

  /* Rects for the pixel check, taken in the SAME state as the screenshot, with
     the panel closed so its own ink is not mistaken for page text. */
  __dmTuner.close();
  await sleep(400);
  out.rects = allTextRects().slice(0, 500);
  return out;
})()
