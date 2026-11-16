/* test-logo-a11y.js -- run in a real Chrome against the AliExpress logo shape.
 *
 * 1.0.23 turned the bg-photo restore veto from `textContent` to `showsText()`.
 * This is the end-to-end half: two anchors that differ ONLY in whether their
 * text is visible must land on opposite sides of that gate, with the real
 * content.css filter on and the real content.js measuring a real raster.
 *
 *   #a11y    background-image logo + sr-only <span>AliExpress</span>  -> restored
 *   #visible background-image logo + visible caption text            -> NOT restored
 *
 * "restored" is proved twice: the marker attribute AND the net invert() depth
 * from the element to <html> being even (page filter + our second invert). */
(function () {
  const out = [];
  const ok = (name, cond, detail) =>
    out.push((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + String(detail) : ''));
  const depth = (el) => {
    let n = 0, x = el;
    while (x && x.nodeType === 1) {
      if (/invert\(\s*(?:1|100%)\s*\)/.test(getComputedStyle(x).filter || '')) n++;
      x = x.parentElement;
    }
    return n;
  };

  ok('the page is darkened', /cr-dark/.test(document.documentElement.className),
     document.documentElement.className);

  const a11y = document.getElementById('a11y');
  const vis = document.getElementById('visible');
  ok('fixtures present', !!a11y && !!vis, 'a11y=' + !!a11y + ' visible=' + !!vis);

  // the predicate itself, as the engine sees it
  ok('showsText() says the screen-reader span is not text',
     window.__crShowsText ? window.__crShowsText(a11y) === false : 'n/a',
     window.__crShowsText ? window.__crShowsText(a11y) : 'not exposed');
  ok('showsText() says the caption IS text',
     window.__crShowsText ? window.__crShowsText(vis) === true : 'n/a',
     window.__crShowsText ? window.__crShowsText(vis) : 'not exposed');

  // ...and what the engine actually did with it
  ok('the a11y-text logo is RESTORED (true colours)', a11y.getAttribute('data-cr-bgphoto') === '1',
     'data-cr-bgphoto=' + a11y.getAttribute('data-cr-bgphoto'));
  ok('the a11y-text logo renders at even invert depth', depth(a11y) % 2 === 0,
     'depth=' + depth(a11y));
  ok('the visible-text logo is NOT restored', !vis.getAttribute('data-cr-bgphoto'),
     'data-cr-bgphoto=' + vis.getAttribute('data-cr-bgphoto'));
  ok('the visible-text logo stays inside the page filter', depth(vis) % 2 === 1,
     'depth=' + depth(vis));

  /* ── the two other ways a product thumbnail can be painted ─────────────
     A plain <img> is covered by the stylesheet's media rule, so if a photo is
     blue on a real page, the element is NOT a plain <img>. Prove that here, and
     measure the OTHER candidate: a small photographic background-image, which
     the bg-photo pass refuses below 10,000 px² (≈100x100) as "sprite/icon". */
  const plain = document.getElementById('plainimg');
  ok('a plain <img> photo is re-inverted (net even)', depth(plain) % 2 === 0, 'depth=' + depth(plain));

  const small = document.getElementById('smallbg');
  ok('an 80x80 PHOTOGRAPHIC background is restored (order-list thumbnail)',
     depth(small) % 2 === 0,
     'area 6400, depth=' + depth(small) + ', data-cr-bgphoto=' + small.getAttribute('data-cr-bgphoto'));

  const flat = document.getElementById('flatbg');
  ok('an 80x80 FLAT plate is still left inverted (icon, not photo)', depth(flat) % 2 === 1,
     'depth=' + depth(flat) + ', data-cr-bgphoto=' + flat.getAttribute('data-cr-bgphoto'));

  return out;
})();
