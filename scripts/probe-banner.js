/* probe-banner.js -- what IS the "11.11 Sale" strip, and is its ink legible on
 * its own backdrop? Read-only.
 *
 * The screenshot showed a full-width band of solid #00ffff with near-white
 * glyphs inside. Two candidate stories: the site's own branding (fine), or our
 * paint landing on a background (not fine). This resolves it from computed
 * styles plus the rendered-pixel trick -- the band's own backgroundColor and
 * backgroundImage, the ink of the text inside it, and the contrast between
 * them.
 */
(() => {
  const parse = (s) => {
    const m = String(s || '').match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s\/]+/).filter(Boolean).map(parseFloat);
    return p.length >= 3 ? [p[0], p[1], p[2], p.length > 3 ? p[3] : 1] : null;
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const contrast = (a, b) => {
    const la = lum(a), lb = lum(b);
    return +(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05))).toFixed(2);
  };
  const H = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  // find the text node containing the sale copy, then climb to the painted strip
  const hits = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = (n.nodeValue || '').trim();
    if (/11\.11|Sale Ends/i.test(t)) hits.push({ node: n, text: t.slice(0, 60) });
    if (hits.length > 4) break;
  }
  const out = { found: hits.length, items: [] };
  for (const h of hits.slice(0, 3)) {
    const el = h.node.parentElement;
    const chain = [];
    let p = el;
    for (let i = 0; i < 5 && p && p.nodeType === 1; i++, p = p.parentElement) {
      const cs = getComputedStyle(p);
      const bg = parse(cs.backgroundColor);
      const r = p.getBoundingClientRect();
      chain.push({
        tag: p.tagName.toLowerCase(),
        cls: String(p.className || '').slice(0, 50),
        bg: bg ? H(bg) + (bg[3] < 0.999 ? '/a' + bg[3].toFixed(2) : '') : cs.backgroundColor.slice(0, 22),
        bgImg: (cs.backgroundImage || 'none').slice(0, 46),
        ink: H(parse(cs.color) || [0, 0, 0]),
        fill: cs.webkitTextFillColor,
        filter: (cs.filter || 'none').slice(0, 30),
        tone: p.getAttribute('data-dm-tone') || '',
        box: Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.x) + ',' + Math.round(r.y),
      });
    }
    const ink = parse(getComputedStyle(el).color) || [0, 0, 0];
    // nearest opaque backdrop behind the text
    let back = null, q = el;
    while (q && q.nodeType === 1) {
      const b = parse(getComputedStyle(q).backgroundColor);
      if (b && b[3] > 0.5) { back = b; break; }
      q = q.parentElement;
    }
    out.items.push({
      text: h.text,
      inkHex: H(ink),
      backdrop: back ? H(back) : 'none',
      contrastVsBackdrop: back ? contrast(ink, back) : null,
      chain,
    });
  }
  return out;
})()
