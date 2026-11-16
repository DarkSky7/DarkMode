/* probe-bg-skipped.js -- for every background-image element still rendering as a
 * negative, replay the bg-photo pass's gates in order and name the one that
 * stopped it.
 *
 * Gates, in the engine's own order (content.js -> startBgPhotoFix -> pass):
 *   AREA      box < 2500 px²
 *   GRADIENT  background-image contains a gradient -- not individually restorable
 *   VECTOR    .svg / data:image/svg+xml -- UI art, must invert
 *   TEXT      visible text in the element -- restoring would double-invert its ink
 *   TILE      repeating AND background-size:auto -- a plate, supposed to invert
 *   NESTED    an ancestor already carries data-cr-bgphoto
 *   FLAT      sampled as not photographic (sat/distinct/spread all reported)
 *   NONE      nothing stopped it (restored, or sampling had not resolved yet)
 *
 * Ask it on a page where images look wrong: the gate that fires most often is the
 * answer. Read-only; uses the engine's own exposed predicates.
 */
(async function () {
  const out = [];
  const depth = (el) => {
    let n = 0, x = el;
    while (x && x.nodeType === 1) {
      if (/invert\(\s*(?:1|100%)\s*\)/.test(getComputedStyle(x).filter || '')) n++;
      x = x.parentElement;
    }
    return n;
  };
  const path = (el) => {
    const parts = [];
    let n = el, d = 0;
    while (n && n.nodeType === 1 && d++ < 4) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + '#' + n.id); break; }
      if (n.classList && n.classList.length) s += '.' + [].slice.call(n.classList, 0, 2).join('.');
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join('>');
  };

  out.push('env :: brave=' + (!!navigator.brave) + ' host=' + location.hostname +
           ' cr-dark=' + document.documentElement.classList.contains('cr-dark'));
  out.push('handles :: showsText=' + (typeof window.__crShowsText) +
           ' imgStats=' + (typeof window.__crImgStats) +
           ' isVectorArt=' + (typeof window.__crIsVectorArt));

  const all = [].slice.call(document.querySelectorAll('*'));
  let considered = 0, inverted = 0;
  const reasons = {};
  const lines = [];

  for (const el of all) {
    if (/^(IMG|VIDEO|CANVAS|OBJECT|EMBED|IFRAME|svg)$/i.test(el.tagName)) continue;
    let cs;
    try { cs = getComputedStyle(el); } catch (e) { continue; }
    const bi = cs.backgroundImage || '';
    if (bi.indexOf('url(') === -1) continue;
    const box = el.getBoundingClientRect();
    const area = box.width * box.height;
    if (area < 2500) { reasons.AREA = (reasons.AREA || 0) + 1; continue; }
    considered++;
    if (depth(el) % 2 === 0) continue;                    // already true colour
    inverted++;

    let gate = 'NONE';
    let stats = null;
    const m = /url\(["']?([^"')]+)["']?\)/.exec(bi);
    if (/gradient/.test(bi)) gate = 'GRADIENT';
    else if (window.__crIsVectorArt && window.__crIsVectorArt(bi)) gate = 'VECTOR';
    else if (window.__crShowsText && window.__crShowsText(el)) gate = 'TEXT';
    else if (el.parentElement && el.parentElement.closest('[data-cr-bgphoto="1"]')) gate = 'NESTED';
    if (gate === 'NONE') {
      const repeats = cs.backgroundRepeat !== 'no-repeat';
      const autoSize = cs.backgroundSize === 'auto';
      if (repeats && autoSize) gate = 'TILE';
      else if (m && window.__crImgStats) {
        try { stats = await window.__crImgStats(m[1]); } catch (e) { stats = { error: e.message }; }
        if (!stats || stats.error) gate = 'UNMEASURABLE';
        else if (!stats.photo && area < 10000) gate = 'FLAT (small)';
        else if (!stats.photo && stats.sat < 0.12) gate = 'FLAT (desaturated)';
      }
    }
    reasons[gate] = (reasons[gate] || 0) + 1;
    if (lines.length < 16) {
      lines.push(gate + '  ' + Math.round(box.width) + 'x' + Math.round(box.height) +
                 ' text=' + (el.textContent || '').trim().length +
                 ' stats=' + (stats ? JSON.stringify(stats) : '-') +
                 '  ' + path(el) + '  <- ' + (m ? m[1].slice(-40) : ''));
    }
  }

  out.push('bg-image elements >=2500px2 considered=' + considered + ' still inverted=' + inverted);
  out.push('gate histogram :: ' + JSON.stringify(reasons));
  for (const l of lines) out.push(l);
  return out;
})();
