/* probe-white-census.js -- enumerate EVERY visible text/glyph element on the page,
 * bucket it by RENDERED colour, and say whether the tuner has tagged it.
 *
 * Why this exists (2026-11-16): a screenshot plus a vision model reported the
 * AliExpress cart as "everything looks fine" while dozens of white and grey text
 * items were plainly unrecoloured. A vision pass cannot enumerate. This probe
 * answers the only question that matters -- how many, which ones, and why not --
 * from the DOM, using the same rendered-colour math as rendersOf() in tuner.js:
 * computed ink -> composite alpha over backdrop -> complement when the element
 * sits inside an odd number of invert() filters.
 *
 * Read-only. Returns JSON.
 */
(() => {
  const TONE = 'data-dm-tone';
  const H = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  const hexOf = (c) => '#' + H(c[0]) + H(c[1]) + H(c[2]);

  const parse = (s) => {
    if (!s) return null;
    if (s === 'transparent') return [0, 0, 0, 0];
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s\/]+/).filter(Boolean).map(parseFloat);
    if (p.length < 3 || p.some((v) => isNaN(v))) return null;
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  /* Saturation, not channel spread: a spread test called the warm greys these
     sites use (#9f9b8d, spread 18) "not neutral", so the census and the engine
     agreed a page was complete while 87 grey items were unrecoloured. Keep this
     identical to NEUTRAL_SAT in tuner.js or the measurement starts flattering
     the rule it is supposed to check. */
  const NEUTRAL_SAT = 0.20;
  const isNeutral = (c) => {
    const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d === 0) return true;
    const l = (mx + mn) / 2;
    return d / (1 - Math.abs(2 * l - 1)) <= NEUTRAL_SAT;
  };

  // invert parity, cached per node -- walking getComputedStyle up the tree per
  // element is the only reliable way to know whether the eye sees c or 255-c.
  const depthCache = new Map();
  const filterDepth = (el) => {
    const chain = [];
    let n = el, result = null;
    for (; n && n.nodeType === 1; n = n.parentElement) {
      if (depthCache.has(n)) { result = depthCache.get(n); break; }
      chain.push(n);
    }
    if (result === null) result = 0;
    for (let i = chain.length - 1; i >= 0; i--) {
      let f = '';
      try { f = getComputedStyle(chain[i]).filter || ''; } catch (e) { f = ''; }
      if (/invert\(/.test(f)) result += 1;
      depthCache.set(chain[i], result);
    }
    return result;
  };

  const backdropOf = (el) => {
    let n = el;
    while (n && n.nodeType === 1) {
      const bg = parse(getComputedStyle(n).backgroundColor);
      if (bg && bg[3] > 0.5) return bg;
      n = n.parentElement;
    }
    return [255, 255, 255, 1];
  };

  const NON_TEXT = /^(script|style|noscript|template|title|meta|link|base|head|path|defs)$/i;
  const FORM = /^(INPUT|TEXTAREA|SELECT)$/;
  const ownsText = (el) => {
    if (NON_TEXT.test(el.tagName)) return false;
    if (FORM.test(el.tagName)) return true;
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
    }
    return false;
  };
  const visible = (el, r) => {
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity) <= 0.05) return false;
    return true;
  };

  const body = document.body;
  if (!body) return { error: 'no body' };
  const all = [body].concat(Array.prototype.slice.call(body.querySelectorAll('*'), 0, 9000));

  const buckets = {};
  const misses = [];
  let considered = 0, tagged = 0, taggedStill = 0, formControls = 0, alphaInk = 0, svgText = 0;

  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (!ownsText(el)) continue;
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    considered++;
    const isForm = FORM.test(el.tagName);
    if (isForm) formControls++;
    const cs = getComputedStyle(el);
    let ink = isForm ? cs.color : (cs.webkitTextFillColor || cs.color);
    const isSvg = el.namespaceURI === 'http://www.w3.org/2000/svg';
    if (isSvg) { svgText++; if (cs.fill && cs.fill !== 'none' && !/^currentcolor$/i.test(cs.fill)) ink = cs.fill; }
    const rgb = parse(ink);
    if (!rgb) continue;
    let base = [rgb[0], rgb[1], rgb[2]];
    if (rgb[3] < 0.999) {
      alphaInk++;
      if (rgb[3] < 0.05) continue;                     // background-clip gradient text
      const back = backdropOf(el);
      base = [rgb[0] * rgb[3] + back[0] * (1 - rgb[3]),
              rgb[1] * rgb[3] + back[1] * (1 - rgb[3]),
              rgb[2] * rgb[3] + back[2] * (1 - rgb[3])];
    }
    const par = filterDepth(el) % 2;
    const shown = par === 1 ? [255 - base[0], 255 - base[1], 255 - base[2]] : base;
    const shownHex = hexOf(shown);
    const L = lum(shown);
    const has = el.getAttribute(TONE);
    buckets[shownHex] = buckets[shownHex] || { n: 0, L: +L.toFixed(3), neutral: isNeutral(shown) };
    buckets[shownHex].n++;
    if (has) {
      tagged++;
      // a tagged element that STILL renders light means the paint did not land
      if (isNeutral(shown) && L >= 0.25) taggedStill++;
    } else if (isNeutral(shown) && L >= 0.15 && misses.length < 400) {
      misses.push({
        t: el.tagName.toLowerCase(),
        cls: (el.className && String(el.className).slice(0, 44)) || '',
        L: +L.toFixed(3),
        hex: shownHex,
        form: isForm,
        svg: isSvg,
        txt: (el.textContent || el.value || '').trim().slice(0, 46),
        w: Math.round(r.width), h: Math.round(r.height),
      });
    }
  }

  const byL = Object.entries(buckets).sort((a, b) => b[1].n - a[1].n);
  return {
    url: location.href.slice(0, 90),
    considered,
    tagged,
    taggedStill,
    untaggedNeutral: misses.length,
    formControls,
    alphaInk,
    svgText,
    topColours: byL.slice(0, 18).map(([h, v]) => ({ hex: h, n: v.n, L: v.L, neutral: v.neutral })),
    misses: misses.slice(0, 90),
  };
})()
