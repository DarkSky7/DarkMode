/* probe-confirm-received.js -- find the order page's "Confirm received" buttons
 * and report what actually paints them.
 *
 * Mike: "Confirm received buttons with very light cyan background and white
 * foreground." A LIGHT CYAN fill is the arithmetic complement of a dark red one
 * (255-170=85, 255-20=235, 255-20=235), which is exactly what a parity mistake
 * in the invert-compensation write produces. So this reports the RAW computed
 * colours, the filter chain (how many times invert(1) is applied), the parity we
 * would derive from it, and what the engine actually wrote into the inline
 * style, side by side.
 *
 * Text is matched with indexOf, never a regex literal inside a template string
 * (a double-escaped regex silently matched nothing on the cart banner).
 */
(() => {
  const parse = (s) => {
    const m = String(s || '').match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s\/]+/).filter(Boolean).map(parseFloat);
    return p.length >= 3 ? [p[0], p[1], p[2], p.length > 3 ? p[3] : 1] : null;
  };
  const H = (c) => c ? '#' + c.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('') : null;
  const lum = (c) => {
    if (!c) return null;
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return +(0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])).toFixed(3);
  };
  const contrast = (a, b) => {
    const A = lum(a), B = lum(b);
    if (A == null || B == null) return null;
    const hi = Math.max(A, B), lo = Math.min(A, B);
    return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
  };
  /* how many invert(1) filters sit on this element's ancestor chain */
  const filterChain = (el) => {
    const chain = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      let f = '';
      try { f = getComputedStyle(n).filter || ''; } catch (e) {}
      if (/invert\(/.test(f)) chain.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : ''));
    }
    return chain;
  };

  const out = { textHits: 0, buttons: [], note: null };
  const all = [document.documentElement].concat([...document.querySelectorAll('body *')]);
  const seen = new Set();
  for (const el of all) {
    if (!el || el.nodeType !== 1) continue;
    const t = (el.textContent || '').trim();
    if (!t || t.length > 40) continue;
    if (t.indexOf('onfirm received') < 0 && t.indexOf('onfirm Receipt') < 0) continue;
    out.textHits++;
    /* climb to the smallest ancestor that actually paints a fill */
    let n = el, found = null;
    for (let i = 0; i < 7 && n && n.nodeType === 1; i++, n = n.parentElement) {
      let cs; try { cs = getComputedStyle(n); } catch (e) { break; }
      const bg = parse(cs.backgroundColor);
      const bi = cs.backgroundImage || 'none';
      const r = n.getBoundingClientRect();
      const paints = (bg && bg[3] > 0.05) || bi !== 'none';
      if (paints && r.width > 20 && r.height > 10) { found = n; break; }
    }
    if (!found) continue;
    const key = found;
    if (seen.has(key)) continue;
    seen.add(key);
    const cs = getComputedStyle(found);
    const r = found.getBoundingClientRect();
    const fc = filterChain(found);
    const par = fc.length % 2;
    const bgRaw = parse(cs.backgroundColor);
    const inkRaw = parse(cs.webkitTextFillColor || cs.color);
    /* what the viewer actually sees, given the invert chain */
    const seenBg = bgRaw && par ? [255 - bgRaw[0], 255 - bgRaw[1], 255 - bgRaw[2]] : (bgRaw ? bgRaw.slice(0, 3) : null);
    const seenInk = inkRaw && par ? [255 - inkRaw[0], 255 - inkRaw[1], 255 - inkRaw[2]] : (inkRaw ? inkRaw.slice(0, 3) : null);
    out.buttons.push({
      tag: found.tagName.toLowerCase(),
      cls: String(found.className || '').slice(0, 40),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      filters: fc,
      parity: par,
      bgRaw: H(bgRaw), bgRawL: lum(bgRaw),
      bgSeen: H(seenBg), bgSeenL: lum(seenBg),
      inkRaw: H(inkRaw), inkSeen: H(seenInk), inkSeenL: lum(seenInk),
      contrastSeen: contrast(seenBg, seenInk),
      bgImage: cs.backgroundImage === 'none' ? 'none' : cs.backgroundImage.slice(0, 60),
      inlineBg: (found.getAttribute('style') || '').slice(0, 160),
      text: t.slice(0, 30),
      attrTagged: found.hasAttribute('data-cr-surface') || found.hasAttribute('data-cr-tagged'),
    });
  }
  if (!out.textHits) out.note = 'no element carried the text in THIS frame; it may live in a shadow root or another frame';
  return out;
})()
