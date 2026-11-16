/* diag-images.js v2 -- paste into the DevTools console on a dark-moded page.
 *
 * v1 answered "why is this visual inverted?" and printed a console.table you had
 * to screenshot. v2 answers the harder question it kept missing: WHICH visuals
 * the scan never saw. On the AliExpress order page v1 reported
 * `visuals: 1` -- one element, the header logo -- which is impossible for a page
 * full of product thumbnails. A single number cannot tell "the page is empty"
 * from "the scan is blind", so v2 prints a CENSUS first, then the rows.
 *
 * WHAT IT GIVES YOU
 *   census  elements / <img> present vs above the area floor / background-image
 *           elements / pseudo-element backgrounds / shadow roots / iframes /
 *           scrollHeight vs viewport  -> tells you whether the page is thin or
 *           the diagnostic is.
 *   rows    every inverted visual (and every *candidate* that was NOT inverted,
 *           because "why is this not restored" is the other half of the bug).
 *   why     ok | SHADOW-DOM | BG-IN-TEXT-EL (text really visible) |
 *           BG-IN-A11Y-TEXT (only screen-reader text -- restoring is safe) |
 *           BG-VECTOR | BG-FLAT | IMG-UNDER-RESTORED | MEDIA-RULE-MISSING
 *   JSON    `copy()` puts the whole thing on the clipboard as text. Paste that
 *           instead of a screenshot: no columns get cut off.
 *
 * VIRTUALISED LISTS: the order page renders rows as you scroll, so one snapshot
 * under-reports. After the first scan this keeps listening to scroll for 60 s and
 * merges results; call __dmDiag.report() whenever you want the union, or
 * __dmDiag.stop() to disconnect.
 *
 * Nothing here mutates the page. */
(function () {
  const H = '__dmDiag';
  if (window[H] && window[H].stop) window[H].stop();

  const inv = (s) => { const m = /invert\(([\d.]+)/.exec(s || ''); return m ? parseFloat(m[1]) : 0; };
  const depth = (el) => {
    let net = 0, n = el, d = 0;
    while (n && d++ < 80) {
      net += inv(getComputedStyle(n).filter);
      const r = n.getRootNode && n.getRootNode();
      if (r && r.host) { n = r.host; continue; }          // hop out of shadow roots
      n = n.parentElement;
    }
    return net;
  };
  const path = (el) => {
    const parts = [];
    let n = el, d = 0;
    while (n && n.nodeType === 1 && d++ < 6) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + '#' + n.id); break; }
      if (n.classList && n.classList.length) s += '.' + [...n.classList].slice(0, 2).join('.');
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join('>');
  };
  /* Every element, including OPEN shadow roots -- page CSS cannot reach those at
     all, so they are the one class of miss the engine can never fix from CSS. */
  const allElements = (root, acc, depthN) => {
    if (!root || depthN > 12) return acc;
    const els = root.querySelectorAll('*');
    for (let i = 0; i < els.length; i++) {
      acc.push(els[i]);
      if (els[i].shadowRoot) allElements(els[i].shadowRoot, acc, depthN + 1);
    }
    return acc;
  };
  /* The engine's own "does this element show text?" when it is loaded, else the
     crude textContent test v1 used (and which AliExpress's sr-only logo span
     defeats). Reported separately so you can see the difference. */
  const showsText = (el) => {
    if (typeof window.__crShowsText === 'function') {
      try { return window.__crShowsText(el); } catch (e) {}
    }
    return !!(el.textContent || '').trim();
  };

  const CENSUS = {};
  const ROWS = new Map();          // key -> row, persisted across scrolls

  function scan() {
    const els = allElements(document, [], 0);
    const c = {
      readyState: document.readyState,
      elements: els.length,
      imgTags: 0, imgBig: 0, bgUrl: 0, bgBig: 0,
      pseudoBg: 0, shadowRoots: 0, iframes: document.querySelectorAll('iframe').length,
      scrollHeight: document.documentElement.scrollHeight,
      viewport: window.innerHeight,
      crDark: document.documentElement.classList.contains('cr-dark')
    };
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el.shadowRoot) c.shadowRoots++;
      const tag = el.tagName;
      const isImg = /^(IMG|VIDEO|CANVAS|PICTURE|OBJECT|EMBED|IFRAME)$/.test(tag) || tag === 'svg';
      if (tag === 'IMG') c.imgTags++;
      let cs, bg = '', pseudo = '';
      try { cs = getComputedStyle(el); } catch (e) { continue; }
      bg = cs.backgroundImage || '';
      let hasBg = bg.indexOf('url(') !== -1;
      if (hasBg) c.bgUrl++;
      if (!hasBg) {                                  // painted by a pseudo-element?
        for (const pe of ['::before', '::after']) {
          let pb = '';
          try { pb = getComputedStyle(el, pe).backgroundImage || ''; } catch (e) {}
          if (pb.indexOf('url(') !== -1) { pseudo = pe + ' ' + pb; c.pseudoBg++; break; }
        }
      }
      if (!isImg && !hasBg && !pseudo) continue;
      let box;
      try { box = el.getBoundingClientRect(); } catch (e) { continue; }
      const area = box.width * box.height;
      if (isImg && area >= 2500) c.imgBig++;
      if (hasBg && area >= 2500) c.bgBig++;
      const net = depth(el);
      const shadow = !!(el.getRootNode && el.getRootNode().host);
      const restoredAnc = el.parentElement && el.parentElement.closest('[data-cr-bgphoto="1"]');
      let inner = '';
      if (pseudo) {
        const m = /url\("?([^")]{0,60})/.exec(pseudo);
        inner = 'pseudo' + (m ? ':' + m[1] : '');
      } else if (isImg) inner = tag.toLowerCase();
      else inner = 'bg:' + (bg.match(/url\("?([^")]{0,60})/) || [])[1];

      let why = 'ok';
      if (net % 2 === 1) {
        if (shadow) why = 'SHADOW-DOM';
        else if (isImg && restoredAnc) why = 'IMG-UNDER-RESTORED';
        else if ((hasBg || pseudo) && showsText(el)) why = 'BG-IN-TEXT-EL';
        else if ((hasBg || pseudo) && /\S/.test((el.textContent || '').trim())) why = 'BG-IN-A11Y-TEXT';
        else if ((hasBg || pseudo) && /\.svg|svg\+xml/i.test(pseudo || bg)) why = 'BG-VECTOR';
        else if (hasBg || pseudo) why = 'BG-FLAT';
        else why = 'MEDIA-RULE-MISSING';
      }
      const key = path(el) + '|' + inner + '|' + Math.round(box.width) + 'x' + Math.round(box.height);
      ROWS.set(key, {
        why,
        net,
        paint: inner,
        text: (el.textContent || '').trim().length,
        textVisible: showsText(el),
        size: Math.round(box.width) + 'x' + Math.round(box.height),
        shadow,
        el: path(el),
        scrollY: Math.round(window.scrollY)
      });
    }
    Object.assign(CENSUS, c);
    return c;
  }

  function report() {
    scan();
    const rows = [...ROWS.values()];
    const bad = rows.filter((r) => r.why !== 'ok');
    const byWhy = {};
    for (const r of rows) byWhy[r.why] = (byWhy[r.why] || 0) + 1;
    console.log('%c[dm-diag] census', 'font-weight:bold', CENSUS);
    console.log('[dm-diag] rows by why:', byWhy);
    if (bad.length) console.table(bad.slice(0, 40));
    else console.log('[dm-diag] nothing inverted — either the page is clean or the scan is blind; check the census');
    const blob = { t: new Date().toISOString(), url: location.href, census: CENSUS, byWhy, bad, all: rows };
    const txt = JSON.stringify(blob);
    try { copy(txt); console.log('%c[dm-diag] JSON copied to clipboard — paste it, no screenshot needed', 'color:#0a0'); }
    catch (e) { console.log('[dm-diag] clipboard blocked; copy this line:', txt); }
    return blob;
  }

  let t = null;
  const onScroll = () => { clearTimeout(t); t = setTimeout(() => { try { scan(); } catch (e) {} }, 700); };
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  const stop = () => {
    window.removeEventListener('scroll', onScroll, true);
    clearTimeout(t);
  };
  const timer = setTimeout(() => { stop(); console.log('[dm-diag] scroll watcher stopped (60 s)'); }, 60000);

  window[H] = { report, stop: () => { clearTimeout(timer); stop(); }, rows: ROWS, census: CENSUS };
  return report();
})();
