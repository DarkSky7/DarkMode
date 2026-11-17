/* probe-find-sale-banner.js -- locate the sale strip in whatever frame it lives
 * in, and report what actually paints it (flat colour? gradient?) plus the state
 * of image thumbnails in that frame.
 *
 * Mike can see a bright RED "11.11 Sale" band that the top-frame probe cannot
 * find. A background-color cap can do nothing about a background-IMAGE gradient,
 * so this reports the raw computed backgroundImage string too -- that is the
 * difference between "our cap missed it" and "our cap cannot see it at all".
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
  const depth = (el) => {
    let d = 0;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      let f = ''; try { f = getComputedStyle(n).filter || ''; } catch (e) {}
      if (/invert\(/.test(f)) d++;
    }
    return d % 2;
  };
  const H = (c) => '#' + c.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  // brightest colour mentioned inside a gradient string
  const gradColours = (s) => {
    const out = [];
    const re = /rgba?\(([^)]+)\)/g; let m;
    while ((m = re.exec(s))) { const c = parse('rgb(' + m[1] + ')'); if (c) out.push(c); }
    return out;
  };

  const hits = [];
  const all = [document.documentElement].concat([...document.querySelectorAll('body *')]);
  for (const el of all) {
    if (!el || el.nodeType !== 1) continue;
    const t = (el.textContent || '').trim();
    if (t.length > 90 || !/11\.11|Sale Ends/i.test(t)) continue;
    if (el.children.length > 4) continue;
    let n = el;
    for (let i = 0; i < 6 && n && n.nodeType === 1; i++, n = n.parentElement) {
      const cs = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      if (r.width * r.height < 1500) continue;
      const p = depth(n);
      const bg = parse(cs.backgroundColor);
      const bgShown = bg && bg[3] > 0.5 ? (p ? [255 - bg[0], 255 - bg[1], 255 - bg[2]] : [bg[0], bg[1], bg[2]]) : null;
      const gradStr = cs.backgroundImage || 'none';
      const gcs = gradColours(gradStr).map((c) => (p ? [255 - c[0], 255 - c[1], 255 - c[2]] : [c[0], c[1], c[2]]));
      const gradMax = gcs.length ? Math.max.apply(null, gcs.map(lum)) : null;
      hits.push({
        tag: n.tagName.toLowerCase(), cls: String(n.className || '').slice(0, 30),
        box: Math.round(r.width) + 'x' + Math.round(r.height),
        bg: bgShown ? H(bgShown) : 'transparent',
        bgL: bgShown ? +lum(bgShown).toFixed(2) : null,
        grad: gradStr === 'none' ? 'none' : gradStr.slice(0, 120),
        gradL: gradMax === null ? null : +gradMax.toFixed(2),
        gradColours: gcs.slice(0, 4).map(H),
        capped: n.getAttribute('data-dm-cap') || '-',
        shadow: (cs.boxShadow || 'none').slice(0, 40),
      });
      break;
    }
    if (hits.length >= 4) break;
  }

  const imgs = [...document.querySelectorAll('img')].filter((i) => {
    const r = i.getBoundingClientRect();
    return r.width * r.height >= 1500;
  });
  return {
    hit: hits.length > 0,
    hits,
    frameUrl: location.href.slice(0, 60),
    imgCount: imgs.length,
    imgFilters: [...new Set(imgs.slice(0, 8).map((i) => getComputedStyle(i).filter))].slice(0, 6),
  };
})()
