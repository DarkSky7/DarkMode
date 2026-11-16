/* probe-post-paint.js -- count text elements that STILL render white/grey AFTER
 * the tuner's rules have been applied. Read-only.
 *
 * WHY (2026-11-16): probe-white-census measures each element's BASELINE (the
 * page's own colour, cached on first sight), which is what decides tagging. It
 * therefore cannot tell you whether the paint landed -- and "covers 267 of 267"
 * was believed once already while the screen was full of white text. This reads
 * the live computed colour (rules included), undoes the invert parity, and
 * reports what the eye actually gets.
 *
 * Returned residual is the number that has to be zero (logo/branding excepted).
 */
(() => {
  const parse = (s) => {
    if (!s) return null;
    if (s === 'transparent') return [0, 0, 0, 0];
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s\/]+/).filter(Boolean).map(parseFloat);
    return p.length >= 3 ? [p[0], p[1], p[2], p.length > 3 ? p[3] : 1] : null;
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const H = (c) => '#' + c.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const depthCache = new Map();
  const parity = (el) => {
    const chain = []; let n = el, r = null;
    for (; n && n.nodeType === 1; n = n.parentElement) { if (depthCache.has(n)) { r = depthCache.get(n); break; } chain.push(n); }
    if (r === null) r = 0;
    for (let i = chain.length - 1; i >= 0; i--) {
      let f = ''; try { f = getComputedStyle(chain[i]).filter || ''; } catch (e) {}
      if (/invert\(/.test(f)) r += 1;
      depthCache.set(chain[i], r);
    }
    return r % 2;
  };
  const backdrop = (el) => {
    let n = el;
    while (n && n.nodeType === 1) { const b = parse(getComputedStyle(n).backgroundColor); if (b && b[3] > 0.5) return b; n = n.parentElement; }
    return [255, 255, 255, 1];
  };
  const NON_TEXT = /^(script|style|noscript|template|title|meta|link|base|head|path|defs)$/i;
  const FORM = /^(INPUT|TEXTAREA|SELECT)$/;
  const ownsText = (el) => {
    if (NON_TEXT.test(el.tagName)) return false;
    if (FORM.test(el.tagName)) return true;
    for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
    return false;
  };

  const body = document.body;
  if (!body) return { error: 'no body' };
  const all = [body].concat(Array.prototype.slice.call(body.querySelectorAll('*'), 0, 9000));
  let checked = 0, painted = 0, residual = 0;
  const samples = [];
  for (const el of all) {
    if (!ownsText(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) <= 0.05) continue;
    checked++;
    const isForm = FORM.test(el.tagName);
    let ink = isForm ? cs.color : (cs.webkitTextFillColor || cs.color);
    if (el.namespaceURI === 'http://www.w3.org/2000/svg' && cs.fill && cs.fill !== 'none' && !/^currentcolor$/i.test(cs.fill)) ink = cs.fill;
    const c = parse(ink);
    if (!c) continue;
    let base = [c[0], c[1], c[2]];
    if (c[3] < 0.999) {
      if (c[3] < 0.05) continue;
      const b = backdrop(el);
      base = [c[0] * c[3] + b[0] * (1 - c[3]), c[1] * c[3] + b[1] * (1 - c[3]), c[2] * c[3] + b[2] * (1 - c[3])];
    }
    const shown = parity(el) === 1 ? [255 - base[0], 255 - base[1], 255 - base[2]] : base;
    const chroma = Math.max(shown[0], shown[1], shown[2]) - Math.min(shown[0], shown[1], shown[2]);
    const sat = (() => {
      const r = shown[0] / 255, g = shown[1] / 255, b = shown[2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (d === 0) return 0;
      const l = (mx + mn) / 2;
      return d / (1 - Math.abs(2 * l - 1));
    })();
    const L = lum(shown);
    /* THE TARGET COLOUR IS NOT A RESIDUAL. The first version of this probe also
       skipped nothing for chroma at high luminance (that is the TAGGING rule,
       where a pale tint counts as white-ish), so every element we had just
       painted cyan came back as "still light" -- 373 of 373 on a page that was
       visibly all cyan. Judging "still white or grey" is a different question
       from deciding what to tag: it is neutrality plus luminance, full stop. */
    if (Math.abs(shown[0] - 0) < 16 && Math.abs(shown[1] - 255) < 16 && Math.abs(shown[2] - 255) < 16) { painted++; continue; }
    /* "Still white or grey" == light AND unsaturated. The first version used a
       channel-spread test and thus blessed the 87 warm greys (#9f9b8d) that are
       exactly the defect being hunted. */
    if (L >= 0.15 && sat <= 0.20) {
      residual++;
      if (samples.length < 25) samples.push({ t: el.tagName.toLowerCase(), hex: H(shown), L: +L.toFixed(3), sat: +sat.toFixed(3), txt: (el.textContent || el.value || '').trim().slice(0, 40) });
    }
  }
  return { url: location.href.slice(0, 80), checked, painted, residual, samples };
})()
