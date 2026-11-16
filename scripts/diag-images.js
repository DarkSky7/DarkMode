/* diag-images.js -- paste into DevTools console on a dark-moded page.
 *
 * Answers ONE question: for every visual that looks inverted, WHY is it inverted?
 * Works by computing the net invert() depth from the element to <html> (odd means
 * it renders as a negative), then reporting how the thing is painted and which
 * engine rule failed to cover it.
 *
 *   net = sum of invert(...) exponents from the element up to <html>
 *         html.cr-dark contributes 1; our media re-invert contributes 1;
 *         a [data-cr-bgphoto="1"] ancestor contributes 1.  even = true colour.
 *
 * Copy the whole block, paste it in the console, read the table. `why` names the
 * most likely engine gap:
 *   ok                 covered
 *   SHADOW-DOM         inside a shadow root -- page-level CSS cannot reach it
 *   BG-IN-TEXT-EL      painted as a background-image on an element that also has
 *                      text, which content.js deliberately skips
 *   BG-VECTOR          .svg background -- skipped as UI art
 *   BG-FLAT            raster too flat/unsampled to be a photo -- skipped
 *   IMG-UNDER-RESTORED img inside a restored parent should be filter:none;
 *                      if it is inverted, the specificity rule lost
 */
(function () {
  const inv = (s) => { const m = /invert\(([\d.]+)/.exec(s || ''); return m ? parseFloat(m[1]) : 0; };
  const depth = (el) => {
    let net = 0, n = el, d = 0;
    while (n && d++ < 80) {
      net += inv(getComputedStyle(n).filter);
      const r = n.getRootNode && n.getRootNode();
      if (r && r.host) { n = r.host; continue; }   // hop out of shadow roots
      n = n.parentElement;
    }
    return net;
  };
  const path = (el) => {
    const parts = [];
    let n = el, d = 0;
    while (n && n.nodeType === 1 && d++ < 5) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + '#' + n.id); break; }
      if (n.classList && n.classList.length) s += '.' + [...n.classList].slice(0, 2).join('.');
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join('>');
  };
  const rows = [];
  const all = document.querySelectorAll('*');
  for (const el of all) {
    const tag = el.tagName;
    const cs = getComputedStyle(el);
    const isImg = /^(IMG|VIDEO|CANVAS|PICTURE)$/.test(tag) || tag === 'svg' || tag === 'OBJECT' || tag === 'EMBED' || tag === 'IFRAME';
    const bg = cs.backgroundImage || '';
    const hasBg = bg.indexOf('url(') !== -1;
    if (!isImg && !hasBg) continue;
    const box = el.getBoundingClientRect();
    if (box.width * box.height < 2500) continue;             // ignore sprites/spacers
    const net = depth(el);
    const shadow = !!(el.getRootNode && el.getRootNode().host);
    const restoredAnc = el.parentElement && el.parentElement.closest('[data-cr-bgphoto="1"]');
    let why = 'ok';
    if (net % 2 === 1) {
      if (shadow) why = 'SHADOW-DOM';
      else if (isImg && restoredAnc) why = 'IMG-UNDER-RESTORED';
      else if (hasBg && (el.textContent || '').trim()) why = 'BG-IN-TEXT-EL';
      else if (hasBg && /\.svg|svg\+xml/i.test(bg)) why = 'BG-VECTOR';
      else if (hasBg) why = 'BG-FLAT';
      else why = 'MEDIA-RULE-MISSING';
    }
    rows.push({
      why,
      net,
      paint: isImg ? tag.toLowerCase() : 'bg:' + (bg.match(/url\("?([^")]{0,40})/) || [])[1],
      text: (el.textContent || '').trim().length,
      size: Math.round(box.width) + 'x' + Math.round(box.height),
      el: path(el)
    });
  }
  const bad = rows.filter((r) => r.why !== 'ok');
  console.log('cr-dark present:', document.documentElement.classList.contains('cr-dark'),
              '| visuals:', rows.length, '| inverted:', bad.length);
  console.table(bad.length ? bad : rows.slice(0, 10));
  return bad;
})();
