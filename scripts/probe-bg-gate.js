/* probe-bg-gate.js -- run INSIDE the extension's isolated world (cdp-live-eval
 * --extension). Replays startBgPhotoFix's gates against the real order-page
 * thumbnail and prints the engine's own sampled numbers, so the failing gate is
 * named by the engine rather than inferred.
 */
(async function () {
  const out = { handles: {}, gates: [], stats: null, css: null };

  out.handles = {
    showsText: typeof window.__crShowsText,
    imgStats: typeof window.__crImgStats,
    isVectorArt: typeof window.__crIsVectorArt
  };

  const el = document.querySelector('div.order-item-content-img') ||
             [].slice.call(document.querySelectorAll('*')).find(function (n) {
               const b = n.getBoundingClientRect();
               return b.width >= 100 && b.height >= 100 &&
                      (getComputedStyle(n).backgroundImage || '').indexOf('url(') !== -1;
             });
  if (!el) return { error: 'no thumbnail element found' };

  const cs = getComputedStyle(el);
  const box = el.getBoundingClientRect();
  const m = /url\(["']?([^"')]+)["']?\)/.exec(cs.backgroundImage || '');
  const url = m ? m[1] : null;

  out.css = {
    size: Math.round(box.width) + 'x' + Math.round(box.height),
    area: Math.round(box.width * box.height),
    backgroundRepeat: cs.backgroundRepeat,
    backgroundSize: cs.backgroundSize,
    hasGradient: /gradient/.test(cs.backgroundImage || ''),
    text: (el.textContent || '').trim().length,
    className: el.getAttribute('class') || ''
  };

  out.gates.push(['AREA < 2500', box.width * box.height < 2500]);
  out.gates.push(['GRADIENT', /gradient/.test(cs.backgroundImage || '')]);
  out.gates.push(['VECTOR (svg)',
    window.__crIsVectorArt ? window.__crIsVectorArt(cs.backgroundImage || '') : 'no handle']);
  out.gates.push(['VISIBLE TEXT',
    window.__crShowsText ? window.__crShowsText(el) : 'no handle']);
  out.gates.push(['TILE (repeats && size auto)',
    cs.backgroundRepeat !== 'no-repeat' && cs.backgroundSize === 'auto']);
  out.gates.push(['NESTED under data-cr-bgphoto',
    !!(el.parentElement && el.parentElement.closest('[data-cr-bgphoto="1"]'))]);

  if (url && window.__crImgStats) {
    try { out.stats = await window.__crImgStats(url); }
    catch (e) { out.stats = { error: e.message }; }
  }
  out.url = url ? url.slice(-60) : null;
  out.marked = el.getAttribute('data-cr-bgphoto');
  out.cacheHasUrl = !!(window.__crImgStats);
  return out;
})();
