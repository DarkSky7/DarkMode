/* DarkMode content script — document_start. Inert by default.
   Acts only when:
     (a) host is in the remembered allowlist (storage.sync.darkHosts) → apply
         at document_start so there is no light flash; or
     (b) the user asks via popup message → apply/revert this tab now.
   Engine = CSS filter inversion (resistant-case weapon): it inverts inline
   styles, canvases and SVG that polite per-element darkening cannot reach.
   The inversion is gated on <html class="cr-dark"> — rules live in
   content.css and do nothing until the class exists. */
(function () {
  'use strict';
  const VERSION = '1.0.9';
  const HOST = location.hostname.replace(/^www\./, '');

  if (window.top !== window) return; // frames: parent handles the page
  if (window.__darkMode) return;     // already injected (popup fallback re-execution)

  const KEY = 'cr-dark';        // filter-inversion engine
  const KEY_REPAINT = 'cr-repaint';  // measurement-repaint engine

  /* ── REPAINT LIST — sites where the invert is the WRONG TOOL but the site
     also has no dark theme of its own (2026-11-05) ──────────────────────────

     The wardrobe app is a light PHP/tables app whose body background is
     rgb(148,201,239). Inverting that yields rgb(107,54,16) — mud brown — and
     the page is a garment catalogue, so any hint of colour shift on 100+ photos
     is unacceptable. There is nothing to "remember" inverting for.

     So these hosts get the OTHER engine: no filter at all. We paint a dark
     canvas, then the surface normaliser (shared with Gmail) repaints light
     surfaces dark and lifts dark ink, skipping images/video/canvas/svg so the
     photos keep their true colours. Same measurement discipline, different
     weapon. */
  const REPAINT = {
    'carlyletheassolutions.com': { label: 'CTS Wardrobe' }
  };
  const ENGINE = Object.prototype.hasOwnProperty.call(REPAINT, HOST) ? 'repaint' : 'filter';
  const OWN_KEY = ENGINE === 'repaint' ? KEY_REPAINT : KEY;

  function apply() {
    document.documentElement.classList.add(OWN_KEY);
    if (ENGINE === 'repaint') startSurfaceRepaint();
  }
  function revert() {
    document.documentElement.classList.remove(OWN_KEY);
    // an engine change must not leave the other engine's class behind
    document.documentElement.classList.remove(ENGINE === 'repaint' ? KEY : KEY_REPAINT);
  }
  function isDark() { return document.documentElement.classList.contains(OWN_KEY); }

  /* ── DENY LIST — sites where inverting is the WRONG TOOL (2026-10-28) ──────
     An app that ships its own themes plus its own accent colours cannot be
     served by a colour-wheel invert: invert(1) maps cyan -> brown, so the
     Gmail Accent tint the user chose comes back as a different colour, while
     plain dark ink comes back white. Measured on Gmail with the light-grey
     theme: html class "aAX cr-dark", filter invert(1), accent painted
     rgb(123,200,206) by gmail-accent -> renders rgb(132,55,49), i.e. brown.
     toneNatural() cannot catch this: the page IS genuinely light, so the
     existing "don't invert an already-dark page" guard correctly says "go" —
     and produces garbage anyway.

     So the fix is to be smart enough to REFUSE the invert. Gmail has a native
     dark theme and DarkMode content.css patches the few surfaces that theme
     leaves white — gated on a class WE set from measurement (cr-gmail-dark).
     Delete an entry to allow the site again. */
  const DENY = {
    'mail.google.com': 'Gmail has a native dark theme, and inverting its accents ' +
      'turns them brown. Use Gmail\'s own dark theme — DarkMode is not needed here.'
  };
  if (Object.prototype.hasOwnProperty.call(DENY, HOST)) {
    const why = DENY[HOST];
    revert();                              // clear any stale class from storage/older version
    try {                                  // forget a previously remembered entry
      chrome.storage.sync.get('darkHosts', (got) => {
        const hosts = got.darkHosts || {};
        if (hosts[HOST]) { delete hosts[HOST]; chrome.storage.sync.set({ darkHosts: hosts }); }
      });
    } catch (e) {}
    chrome.runtime.onMessage.addListener((msg, _s, respond) => {
      respond({ dark: false, host: HOST, v: VERSION, tone: 'themed', denied: true, reason: why });
      return false;
    });
    try { chrome.runtime.sendMessage({ type: 'dmHostState', host: HOST, dark: false, denied: true }); } catch (e) {}
    window.__darkMode = {
      apply() {}, revert() {}, isDark: () => false,
      tone: () => 'themed', host: HOST, version: VERSION, denied: why
    };
    markGmailTone();
    startGmailSurfaceFix();   // hoisted: repaints the surfaces Gmail's theme leaves white
    return;
  }

  /* Gmail's OWN theme leaves a handful of containers white; content.css carries
     narrow rules for exactly those, gated on html.cr-gmail-dark. That class is
     set from MEASUREMENT, never from a Gmail class name: measured 2026-10-28,
     Gmail puts `aAX` on <html> under BOTH its dark theme (body bg
     rgb(17,17,17)) and its light-grey theme (body bg rgb(248,250,253)) — so
     `aAX` is not a dark marker and keying on it would darken a light Gmail.
     Re-decide whenever Gmail repaints its theme. */
  function markGmailTone() {
    const GM = 'cr-gmail-dark';
    const sync = () => {
      try {
        const dark = (toneNatural(true) === 'dark');
        document.documentElement.classList.toggle(GM, dark);
      } catch (e) {}
    };
    try {
      sync();
      window.addEventListener('load', sync);
      const mo = new MutationObserver(sync);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
      if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
      setTimeout(sync, 1500);   // Gmail repaints theme surfaces after load
    } catch (e) {}
  }

  /* ── SURFACE NORMALISER — one implementation, two callers (1.0.8) ─────────
     Why measurement and not selectors: 1.0.4 shipped three hard-coded Gmail
     class rules. Measured live 2026-10-28 on an OPEN CONVERSATION, Gmail
     rendered THREE white surfaces — .nH.a98.iY (thread card 807x2126),
     .nH.btDi4d.rT5Apb (Reply/Forward bar 791x68) and .nr.wR (the button row
     inside that bar 719x36). The whitelist covered two of three, and would
     break again the next time Gmail renames a class.

     So instead: SAMPLE the page's own palette (its darkest large surface and
     its lightest real ink), then repaint any near-white background to that
     sampled surface, and lift near-black ink. Order matters both ways:
     painting a surface without lightening its ink makes text vanish, and
     lightening ink on a surface we did not paint makes it vanish on white.

     Two callers, one engine:
       Gmail        — gated on the page MEASURING dark (its own theme is the
                      source of darkness; we only patch leftover white bands).
                      Ink is lifted ONLY inside surfaces we repainted.
       Repaint sites — gated on our own class, because these pages have no dark
                      theme. We supply the darkness, so ink must be lifted
                      page-wide (globalInk) or the page is dark-on-dark.
                      Media is never painted, so photos keep true colour.

     Idempotency is mandatory (a self-triggering observer is what hangs pages):
     every write is guarded by a data-cr-surf / data-cr-ink marker, so a second
     pass writes nothing, produces no mutations, and the loop settles. */
  const MEDIA_TAGS = /^(IMG|VIDEO|CANVAS|SVG|PICTURE|IFRAME|OBJECT|EMBED)$/;
  const repaintStarted = { done: false };

  function startSurfaceNormaliser(cfg) {
    const conf = Object.assign({
      rootSel: '[role=main]',
      gate: () => true,
      fallbackSurf: 'rgb(28,31,38)',
      fallbackInk: 'rgb(232,234,240)',
      globalInk: false,
      tiles: false          // clearing background images is opt-in per engine
    }, cfg || {});
    let palette = null, armed = false;

    function parseColor(s) {
      const m = String(s).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (!m) return null;
      return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    }
    function lum(c) { return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; }

    /* Does this element directly own visible text? Colour inherits, so only the
       elements that actually render glyphs need a colour written onto them.
       Form controls are included because their visible text is not a text node. */
    const TEXT_OWNER_TAGS = /^(INPUT|TEXTAREA|SELECT|OPTION|BUTTON)$/;
    function ownsText(el) {
      if (TEXT_OWNER_TAGS.test(el.tagName)) return true;
      const kids = el.childNodes;
      for (let k = 0; k < kids.length; k++) {
        const n = kids[k];
        if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
      }
      return false;
    }

    /* Lift a dark colour for legibility on a dark canvas WITHOUT destroying the
       app's meaning: near-grey ink becomes the palette ink, but a coloured
       accent (the wardrobe app paints brand/heading links a mid-dark blue
       rgb(32,101,148)) keeps its hue and gains lightness instead of turning
       grey. Flattening accents to one ink colour is what makes "dark mode"
       extensions feel like a filter rather than a theme. */
    function toHsl(c) {
      const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const l = (max + min) / 2, d = max - min;
      let h = 0, s = 0;
      if (d) {
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
      }
      return [h, s, l];
    }
    function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    function lift(c) {
      const hsl = toHsl(c);
      const h = hsl[0], s = hsl[1], l = hsl[2];
      if (s < 0.15) return palette.ink;          // near-grey -> plain ink
      const nl = Math.max(l, 0.70), ns = Math.max(s, 0.35);
      const q = nl < 0.5 ? nl * (1 + ns) : nl + ns - nl * ns;
      const p = 2 * nl - q;
      const R = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
      const G = Math.round(hue2rgb(p, q, h) * 255);
      const B = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);
      return 'rgb(' + R + ',' + G + ',' + B + ')';
    }
    const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();

    /* ── why contrast, not luminance (1.0.8) ────────────────────────────────
       The first cut skipped any ink with lum <= 0.30, where lum was the cheap
       (0.2126R+0.7152G+0.0722B)/255. That test is blind to saturated mid-tones:
       the wardrobe app paints headings rgb(32,101,148), whose cheap luminance is
       0.352 — "legible" by that rule — while its real WCAG contrast on our
       rgb(20,22,26) canvas is 2.89:1, i.e. unreadable. Measured, not guessed:
       those were the only two elements left under 3:1 after the rewrite.
       So: compute the effective backdrop by walking ancestors, compute the WCAG
       contrast ratio, and lift anything under 4.5:1. */
    function wcagLum(c) {
      const v = [c[0], c[1], c[2]].map(function (x) {
        x /= 255;
        return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    }
    function contrast(a, b) {
      const hi = Math.max(a, b), lo = Math.min(a, b);
      return (hi + 0.05) / (lo + 0.05);
    }
    /* the colour actually behind this element: nearest ancestor with a
       non-transparent background. Bounded walk — 107k elements x unbounded
       ancestor traversal is not acceptable on a page this size. */
    function effectiveBg(el) {
      let n = el, hops = 0;
      while (n && n !== document.documentElement && hops++ < 8) {
        const b = parseColor(getComputedStyle(n).backgroundColor);
        if (b && b[3] > 0.4) return b;
        n = n.parentElement;
      }
      const root = parseColor(getComputedStyle(document.body).backgroundColor);
      return root && root[3] > 0.4 ? root : [20, 22, 26, 1];
    }

    function root() { return document.querySelector(conf.rootSel) || document.body || null; }

    /* ── tiled background images (1.0.9) ────────────────────────────────────
       Themes paint a surface with BOTH a colour and a repeating image tile that
       covers it:
         background: #d7ebf9 url(ui-bg_flat_100_d7ebf9_40x100.png) 50% 50% repeat-x;
       Pass 1 can only write background-color, so on the wardrobe app it darkened
       the colour UNDER an opaque cyan plate and seven header bars stayed light.
       Measured, not guessed: computed background-color rgb(28,31,38) already
       applied, with a 40x100 #d7ebf9 repeat-x tile painting over it.
       So MEASURE the tile: fetch, decode, downsample, and treat it as a
       decorative plate only if it is near-uniform AND light. A photo or a
       patterned texture is left untouched — clearing real imagery is not dark
       mode, it is data loss. Cached per URL: one theme tile serves dozens of
       elements. */
    const tileCache = new Map();     // url -> {rgb, alpha, flat, light} | null
    const tilePending = new Set();

    function tileUrls(bgImage) {
      if (!bgImage || bgImage === 'none' || /gradient/.test(bgImage)) return [];
      const out = [], re = /url\((["']?)([^"')]+)\1\)/g;
      let m;
      while ((m = re.exec(bgImage))) out.push(m[2]);
      return out;
    }

    function resolveTile(url) {
      if (tileCache.has(url)) return Promise.resolve(tileCache.get(url));
      if (tilePending.has(url)) return Promise.resolve(null);
      tilePending.add(url);
      return fetch(url, { credentials: 'omit' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
        .then(function (b) { return createImageBitmap(b); })
        .then(function (bm) {
          const W = 16, H = 16;                 // downsample: averages the plate
          const cx = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
          cx.drawImage(bm, 0, 0, W, H);
          const d = cx.getImageData(0, 0, W, H).data;
          let r = 0, g = 0, bl = 0, a = 0, mn = 1, mx = 0;
          const n = W * H;
          for (let i = 0; i < d.length; i += 4) {
            r += d[i]; g += d[i + 1]; bl += d[i + 2]; a += d[i + 3];
            const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
            if (l < mn) mn = l;
            if (l > mx) mx = l;
          }
          const res = {
            rgb: [Math.round(r / n), Math.round(g / n), Math.round(bl / n)],
            alpha: a / n / 255,
            flat: (mx - mn) < 0.09,             // near-uniform -> plate, not a photo
            light: ((mn + mx) / 2) > 0.55
          };
          if (bm.close) bm.close();
          tileCache.set(url, res);
          return res;
        })
        /* Unreadable (cross-origin, CSP, decode failure): LEAVE IT ALONE and
           say so. A silent skip here is how the first version "shipped" and
           still showed cyan. */
        .catch(function (e) {
          tileCache.set(url, null);
          try { console.warn('[DarkMode] tile unmeasured, left as-is:', url, e && e.message); } catch (_) {}
          return null;
        })
        .then(function (v) { tilePending.delete(url); return v; });
    }

    /* One async pass per element at most; re-entry is harmless because clearing
       the image makes the element stop qualifying. */
    function fixTiles(scope) {
      const els = scope.querySelectorAll('*');
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (MEDIA_TAGS.test(el.tagName)) continue;
        const cs = getComputedStyle(el);
        const urls = tileUrls(cs.backgroundImage);
        if (!urls.length) continue;
        const box = el.getBoundingClientRect();
        if (box.width * box.height < 200) continue;      // ignore 1px spacers
        for (let u = 0; u < urls.length; u++) {
          (function (url) {
            resolveTile(url).then(function (t) {
              if (!t || !t.flat || !t.light) return;     // photo/pattern: hands off
              if (getComputedStyle(el).backgroundImage === 'none') return;
              el.style.setProperty('background-color', palette.surf, 'important');
              el.style.setProperty('background-image', 'none', 'important');
              el.dataset.crTile = '1';
            });
          })(urls[u]);
        }
      }
    }

    /* sample the page's own palette, so the patch matches whatever dark theme
       the page already has instead of imposing a hard-coded grey */
    function sample() {
      const r = root();
      if (!r) return null;
      const els = r.querySelectorAll('*');
      const n = Math.min(els.length, 7000);
      let surf = null, ink = null;
      for (let i = 0; i < n && !(surf && ink); i++) {
        const el = els[i];
        const cs = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        if (!surf) {
          const b = parseColor(cs.backgroundColor);
          if (b && b[3] > 0.9 && lum(b) < 0.22 && box.width * box.height > 20000) surf = cs.backgroundColor;
        }
        if (!ink) {
          const c = parseColor(cs.color);
          const t = el.textContent ? el.textContent.trim() : '';
          if (c && c[3] > 0.5 && lum(c) > 0.55 && t.length > 8 && box.width > 40) ink = cs.color;
        }
      }
      return { surf: surf || conf.fallbackSurf, ink: ink || conf.fallbackInk };
    }

    function fix() {
      if (!conf.gate()) return;
      const r = root();
      if (!r) return;
      palette = palette || sample();
      if (!palette) return;
      const els = r.querySelectorAll('*');

      // pass 1 — repaint near-white surfaces (never media)
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (MEDIA_TAGS.test(el.tagName)) continue;
        /* NO marker short-circuit here. The app rewrites inline styles when it
           re-renders (observed: the brand list is rebuilt after a modal is
           dismissed), which wipes our write but LEAVES data-cr-surf behind — so
           trusting the marker would skip the element forever and it would stay
           white. The luminance test below is both the selection rule and the
           idempotency guard: once our dark colour is applied the element no
           longer qualifies, so a second pass writes nothing. */
        const b = parseColor(getComputedStyle(el).backgroundColor);
        if (!b || b[3] <= 0.4 || lum(b) < 0.75) continue;
        el.style.setProperty('background-color', palette.surf, 'important');
        el.dataset.crSurf = '1';
      }

      // pass 2 — lift near-black ink
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (MEDIA_TAGS.test(el.tagName)) continue;
        /* Only restyle elements that actually OWN text. Colour is inherited, so
           writing it onto wrappers is pure cost: measured on the wardrobe app,
           the naive pass wrote 37,732 inline colours across 107,850 elements,
           most of them layout divs. Form controls are included because their
           visible text is not a text node. */
        if (!ownsText(el)) continue;
        const c = parseColor(getComputedStyle(el).color);
        if (!c || c[3] <= 0.4) continue;
        /* Legibility is a RATIO against what is actually behind the text, not an
           absolute brightness. Lifting everything below 0.30 luminance missed
           saturated mid-tones (measured: rgb(32,101,148) at 2.89:1 on our dark
           canvas was left alone). Lift below 4.5:1 (WCAG AA for body text). */
        const bgc = effectiveBg(el);
        if (contrast(wcagLum(c), wcagLum(bgc)) >= 4.5) continue;
        // Gmail: only inside a surface we repainted (leaves dark-on-dark alone).
        // Repaint sites: page-wide, because WE made the page dark and an element
        // with no background of its own now sits on our dark canvas.
        if (!conf.globalInk && !el.closest('[data-cr-surf="1"]')) continue;
        el.style.setProperty('color', conf.globalInk ? lift(c) : palette.ink, 'important');
        el.dataset.crInk = '1';
      }

      /* pass 3 — light flat plates that paint over pass 1's colour. Async
         (the tile must be decoded), idempotent (cleared = no longer matches),
         and conservative (photos and patterns are never touched). */
      if (conf.tiles) { try { fixTiles(r); } catch (e) {} }
    }

    /* trailing-edge debounce; the writes above are idempotent so this settles */
    function schedule() {
      if (armed) return;
      armed = true;
      setTimeout(function () { armed = false; try { fix(); } catch (e) {} }, 450);
    }

    try {
      if (conf.gate()) fix();
      window.addEventListener('load', schedule);
      /* Observe documentElement, NOT body. content.js runs at document_start,
         where document.body is still null — so `mo.observe(document.body, ...)`
         silently attaches to nothing and only the one-shot scan ever runs.
         That was a real defect (1.0.6): Gmail rendered its Reply/Forward button
         row LATER, the observer that should have caught it was never attached,
         so .nr.wR stayed white while the rest of the bar was dark. Failing
         quietly is how a fix looks "shipped" and still isn't working. */
      const mo = new MutationObserver(schedule);
      mo.observe(document.documentElement, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ['class', 'style']
      });
      /* pages paint chrome on their own timetable; a short ladder costs nothing
         and covers re-renders the observer can still miss. The wardrobe app
         loads 30 tables and 100+ images after the initial HTML. */
      [300, 1200, 2500, 5000, 9000, 15000, 22000, 30000].forEach(function (t) { setTimeout(schedule, t); });
    } catch (e) {}
    return fix;
  }

  /* Gmail: patch the bands its own dark theme leaves white. */
  function startGmailSurfaceFix() {
    window.__crGmailFix = startSurfaceNormaliser({
      rootSel: '[role=main]',
      gate: function () { return toneNatural(true) === 'dark'; },
      fallbackSurf: 'rgb(32,33,36)',
      fallbackInk: 'rgb(224,224,224)',
      globalInk: false
    });
  }

  /* Repaint sites: we supply the darkness, so lift ink page-wide. */
  function startSurfaceRepaint() {
    if (repaintStarted.done) return;
    repaintStarted.done = true;
    window.__crRepaintFix = startSurfaceNormaliser({
      rootSel: 'body',
      gate: function () { return isDark(); },
      fallbackSurf: 'rgb(28,31,38)',
      fallbackInk: 'rgb(232,234,240)',
      globalInk: true,
      tiles: true
    });
  }

  /* Is the page ALREADY dark (native dark theme, browser auto-dark, or another
     extension's full invert)?  Inverting a dark page would fake the original
     light look, so the popup must not offer "darken" for these. */
  function toneNatural(ignoreFilter) {
    try {
      const st = getComputedStyle(document.documentElement);
      if (!ignoreFilter) {
        const f = st.filter || '';
        if (/invert\s*\(\s*(?:1|100%)/.test(f)) return 'dark';   // another ext inverted
      }
      const cs = String(st.colorScheme || '').toLowerCase();
      if (cs === 'dark') return 'dark';
      if (cs === 'light') return 'light';
      for (let i = 0; i < 2; i++) {
        const el = i === 0 ? document.body : document.documentElement;
        if (!el) continue;
        const bg = getComputedStyle(el).backgroundColor;
        if (!bg || bg === 'transparent') continue;
        const m = bg.match(/[\d.]+/g);
        if (!m) continue;
        const r = +m[0], g = +m[1], b = +m[2], a = m.length > 3 ? +m[3] : 1;
        if (a < 0.5) continue;
        const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        if (lum <= 0.28) return 'dark';
        if (lum >= 0.55) return 'light';
        break; // opaque mid-grey — inconclusive
      }
      // NOTE: no prefers-color-scheme fallback here — on pages with no opaque
      // background (e.g. many search homes) it false-positives as dark under a
      // dark OS preference, wrongly blocking the darken button on light pages.
      return 'unknown';
    } catch (e) { return 'unknown'; }
  }

  /* tell the background which toolbar icon to show for this tab */
  function report() {
    try { chrome.runtime.sendMessage({ type: 'dmHostState', host: HOST, dark: isDark() }); } catch (e) {}
  }

  /* remembered sites: apply ASAP (documentElement exists at document_start) */
  try {
    chrome.storage.sync.get('darkHosts', (got) => {
      const hosts = got.darkHosts || {};
      if (hosts[HOST] || hosts['*']) { apply(); report(); }
    });
  } catch (e) { /* storage unavailable (chrome:// etc.) — stay inert */ }

  /* if a remembered light site turns out to be natively dark once styled
     (site shipped a dark theme, or the browser auto-darkens), our remembered
     inversion would fake light — back out after load instead.

     EXCEPT on the repaint engine (1.0.8). There WE are the source of darkness,
     so toneNatural() measures "dark" precisely because our own canvas is
     working, and backing out would undo the feature. Observed exactly that on
     the wardrobe app: class applied, 287 surfaces repainted, then this guard
     stripped cr-repaint 1200 ms after load and left a half-dark page — dark
     panels on a light-blue body with light text. A guard cannot distinguish
     "natively dark" from "darkened by us" by measuring the result, so on
     repaint hosts it must not run at all. */
  try {
    if (ENGINE !== 'repaint') {
      window.addEventListener('load', function () {
        setTimeout(function () {
          if (isDark() && toneNatural(true) === 'dark') { revert(); report(); }
        }, 1200);
      });
    }
  } catch (e) {}

  /* remember-toggled while this tab is open: apply if now remembered (never
     auto-revert a manual darken — that state is the user's call) */
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'sync' || !ch.darkHosts) return;
      const hosts = (ch.darkHosts.newValue) || {};
      if ((hosts[HOST] || hosts['*']) && !isDark()) { apply(); report(); }
    });
  } catch (e) {}

  /* popup asks */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'dmGetState') { sendResponse({ dark: isDark(), host: HOST, v: VERSION, tone: toneNatural() }); }
    else if (msg.type === 'dmSetDark') {
      if (msg.dark && !msg.force && !isDark() && toneNatural() === 'dark') {
        sendResponse({ dark: false, alreadyDark: true, tone: 'dark' });   // don't flip dark→light-ish
      } else {
        (msg.dark ? apply : revert)(); report(); sendResponse({ dark: isDark() });
      }
    }
    else if (msg.type === 'dmToggle') {
      if (!isDark() && toneNatural() === 'dark') {
        sendResponse({ dark: false, alreadyDark: true, tone: 'dark' });
      } else {
        isDark() ? revert() : apply(); report(); sendResponse({ dark: isDark() });
      }
    }
    else sendResponse({});
    return false;
  });

  /* expose for popup debugging / tests */
  window.__darkMode = { apply, revert, isDark, tone: toneNatural, host: HOST, version: VERSION };
})();
