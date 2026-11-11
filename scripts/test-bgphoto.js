(function () {
  const out = [];
  const ok = (name, cond, detail) => out.push((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + String(detail) : ''));
  const hex = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s || ''); if (!m) return s; const p = m[1].split(',').map(Number); return '#' + p.slice(0, 3).map((x) => (x | 0).toString(16).padStart(2, '0')).join(''); };
  const inv = (h) => { const n = parseInt(h.slice(1), 16); return '#' + [255 - ((n >> 16) & 255), 255 - ((n >> 8) & 255), 255 - (n & 255)].map((x) => x.toString(16).padStart(2, '0')).join(''); };
  const depth = (el) => { let n = 0, x = el; while (x && x.nodeType === 1) { if (/invert\(\s*(?:1|100%)\s*\)/.test(getComputedStyle(x).filter || '')) n++; x = x.parentElement; } return n; };
  const lum = (h) => { const n = parseInt(h.slice(1), 16); const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const rendered = (el) => { const c = hex(getComputedStyle(el).color); return depth(el) % 2 === 1 ? inv(c) : c; };

  ok('the dashboard is darkened', /cr-dark/.test(document.documentElement.className),
     document.documentElement.className);

  // 1. vector art must never be "restored": that is what kept the wind dial's
  //    white disc white and the clock backdrop light.
  const art = [...document.querySelectorAll('.compass, .gauge, .recharts-responsive-container')];
  ok('the dial/clock widgets exist', art.length >= 3, art.length + ' found');
  const restored = art.filter((el) => el.getAttribute('data-cr-bgphoto'));
  ok('no gauge/dial/clock art is restored (would stay light)', restored.length === 0,
     restored.map((el) => el.getAttribute('class')).join(', '));

  // 2. an element that contains text must never be restored either: its text
  //    would keep the light theme's ink and vanish on the dark page.
  const textAndImage = [...document.querySelectorAll('body *')].filter((el) => {
    const cs = getComputedStyle(el);
    return cs.backgroundImage.indexOf('url(') !== -1 && (el.textContent || '').trim().length > 4 &&
           el.getBoundingClientRect().width * el.getBoundingClientRect().height > 10000;
  });
  const badTextHosts = textAndImage.filter((el) => el.getAttribute('data-cr-bgphoto'));
  ok('no element with text is restored', badTextHosts.length === 0,
     badTextHosts.map((el) => (el.getAttribute('class') || el.tagName)).join(', ') + ' of ' + textAndImage.length);

  const hdr = document.querySelector('a.header');
  if (hdr) {
    const ink = rendered(hdr);
    ok('the station name renders light on the dark page', lum(ink) > 0.5, ink);
  }

  // 3. hand the dial rect to the wrapper, which samples its centre pixels.
  const panel = document.querySelector('.compass');
  if (panel) {
    const r = panel.getBoundingClientRect();
    out.push('RECT ' + [r.x, r.y, r.width, r.height].map((v) => Math.round(v)).join(' '));
  }
  return out;
})()
