/* probe-order-page.js -- "the order page's product images are still blue".
 *
 * Runs against the LIVE signed-in page. Answers, in order:
 *   1. is the page darkened by our engine at all, and by which mode
 *   2. are the product images plain <img>, background-image, or inside a shadow
 *      root (the three cases that need three different fixes)
 *   3. what does the engine's own marker say (data-cr-bgphoto)
 *   4. did the shadow-root stylesheet actually get adopted
 *   5. the raw shape of one offending element, so the fix can be written against
 *      the real DOM instead of a guess
 */
(async function () {
  const out = {};
  const root = document.documentElement;

  const depth = (el) => {
    let n = 0, x = el, g = 0;
    while (x && x.nodeType === 1 && g++ < 80) {
      const f = (getComputedStyle(x).filter || '');
      if (/invert\(\s*(?:1|100%)\s*\)/.test(f)) n++;
      const r = x.getRootNode && x.getRootNode();
      if (r && r.host) { x = r.host; continue; }
      x = x.parentElement;
    }
    return n;
  };
  const inShadow = (el) => {
    const r = el.getRootNode && el.getRootNode();
    return !!(r && r.host);
  };
  const path = (el) => {
    const parts = [];
    let n = el, d = 0;
    while (n && n.nodeType === 1 && d++ < 6) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + '#' + n.id); break; }
      if (n.classList && n.classList.length) s += '.' + [].slice.call(n.classList, 0, 3).join('.');
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join('>');
  };

  out.url = location.href;
  out.ready = document.readyState;
  out.htmlClass = root.className;
  out.htmlFilter = getComputedStyle(root).filter;
  out.engineMode = /cr-dark/.test(root.className) ? 'invert' :
                   /cr-repaint/.test(root.className) ? 'repaint' : 'none';

  /* ── 1. every element that could be a product image ─────────────────────── */
  const all = [].slice.call(document.querySelectorAll('*'));
  const roots = [];
  for (const el of all) if (el.shadowRoot) roots.push(el);

  const imgs = all.filter((el) => el.tagName === 'IMG');
  const imgHist = {};
  let imgInShadow = 0;
  for (const im of imgs) {
    const d = depth(im);
    imgHist[d] = (imgHist[d] || 0) + 1;
    if (inShadow(im)) imgInShadow++;
  }
  out.imgs = { total: imgs.length, inShadowRoot: imgInShadow, depthHistogram: imgHist };

  const thumbs = imgs.filter((im) => {
    const b = im.getBoundingClientRect();
    return b.width >= 40 && b.height >= 40;
  });
  out.thumbnails = {
    count: thumbs.length,
    sample: thumbs.slice(0, 6).map((im) => {
      const b = im.getBoundingClientRect();
      return {
        size: Math.round(b.width) + 'x' + Math.round(b.height),
        src: (im.currentSrc || im.src || '').slice(-46),
        filter: getComputedStyle(im).filter,
        depth: depth(im),
        shadow: inShadow(im),
        cls: (im.getAttribute('class') || '').slice(0, 40)
      };
    })
  };

  /* ── 2. background-image candidates of thumbnail size ───────────────────── */
  const bgs = [];
  for (const el of all) {
    if (/^(IMG|VIDEO|CANVAS|svg|OBJECT|EMBED|IFRAME)$/i.test(el.tagName)) continue;
    let cs, bi;
    try { cs = getComputedStyle(el); bi = cs.backgroundImage || ''; } catch (e) { continue; }
    if (bi.indexOf('url(') === -1) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 40 || b.height < 40) continue;
    if (depth(el) % 2 === 0) continue;
    bgs.push({
      size: Math.round(b.width) + 'x' + Math.round(b.height),
      depth: depth(el),
      marked: el.getAttribute('data-cr-bgphoto'),
      text: (el.textContent || '').trim().length,
      shadow: inShadow(el),
      el: path(el),
      url: (bi.match(/url\("?([^")]{0,60})/) || [])[1]
    });
    if (bgs.length >= 8) break;
  }
  out.invertedBackgrounds = bgs;
  out.bgphotoMarkedTotal = document.querySelectorAll('[data-cr-bgphoto="1"]').length;

  /* ── 3. shadow roots: did the adopted stylesheet land? ──────────────────── */
  out.shadowRoots = {
    count: roots.length,
    adopted: roots.filter((h) => h.shadowRoot.adoptedStyleSheets &&
                                 h.shadowRoot.adoptedStyleSheets.length > 0).length,
    sample: roots.slice(0, 8).map((h) => ({
      host: path(h),
      css: (h.shadowRoot.adoptedStyleSheets || []).length,
      imgs: h.shadowRoot.querySelectorAll('img').length
    }))
  };

  /* ── 4. the raw shape of one offending thumbnail ────────────────────────── */
  const offender = thumbs.find((im) => depth(im) % 2 === 1) ||
                   (bgs.length ? document.elementFromPoint(1, 1) : null);
  if (offender && offender.outerHTML) {
    out.offenderHtml = offender.outerHTML.slice(0, 700);
    let p = offender.parentElement, hops = [];
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
      hops.push(path(p) + ' filter=' + getComputedStyle(p).filter +
                ' marked=' + p.getAttribute('data-cr-bgphoto'));
    }
    out.offenderAncestors = hops;
  }

  /* ── 5. is the extension's content script alive in this tab? ───────────── */
  out.extensionMarkers = {
    dataCrSurf: document.querySelectorAll('[data-cr-surf]').length,
    dataCrTile: document.querySelectorAll('[data-cr-tile]').length,
    dmTunerRoot: !!document.getElementById('dm-tuner-root'),
    inlineStyleTag: !!document.getElementById('dm-tuner-rules')
  };

  return out;
})();
