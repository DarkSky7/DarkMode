/* DarkMode — "tune in place".
 *
 * Point at an element, see which class actually controls it (with element
 * counts), tune the text and background colour live, see the contrast ratio
 * before committing, and save the rule for this host.
 *
 * Rules are stored as [{sel, color, bg}] under `tuneRulesByHost[host]`, plus a
 * `tuneRulesGlobal` list that is applied on every host. That shape is the whole
 * point: a "global theme" is the same rule list with a wider scope, not a
 * different mechanism. Per-host rules are applied after global ones, so a site
 * can override the theme.
 *
 * Nothing is drawn until the popup asks (`{type:'dmTuner'}`) or a saved rule
 * exists. No innerHTML anywhere — YouTube and friends enforce Trusted Types.
 */
'use strict';

(function () {
  if (window.__dmTunerLoaded) return;
  window.__dmTunerLoaded = true;

  const ROOT_ID = 'dm-tuner-root';
  const TONE_ATTR = 'data-dm-tone';
  /* The id of the master-palette rule. Fixed (not uid()) so that a re-sweep
     recognises the tags it already wrote instead of re-tagging every element on
     every pass, and so `clearStaleTones` treats it as live. */
  const DEF_RULE_ID = 'dmDefInk';
  const sync = (chrome.storage && chrome.storage.sync) || null;
  const host = location.hostname.replace(/^www\./, '');

  let root = null, shadow = null, styleEl = null, panel = null;
  let picking = false, pending = null, infoEl = null, contrastEl = null, scopeSel = null, customInput = null;
  let txtInput = null, bgInput = null, bgChk = null, listEl = null, exportEl = null;
  let hi = null, perHost = [], globalRules = [], lastPick = null, mirrorEl = null, groupsEl = null, verifyEl = null;
  let coverageEl = null, coverBtn = null;
  let lastGroups = new Map(), lastMine = '', lastKey = '', seq = 0, mo = null, moTimer = null, covTimer = null;
  let ready = null;   // resolves once storage has been read; saves await it
  let pendingRoots = [];

  /* ══════════════ THE PALETTE (1.1.0, 2026-11-27) ══════════════════════════
     Mike: "convert as much white to cyan as possible … the cyan is just my
     current preference … the user should retain the ability to set that default
     override colour … a master override palette and a site-specific override of
     the override palette, only saving the latter if/when the user needs one to
     fix the default palette on that site only."

     Three storage keys, and the shape IS the request:

       dmInk       (string)  the MASTER palette's ink. One colour for every site.
       dmAccent    (bool)    is the master palette applied at all. Default true:
                             a darkened page whose white/grey ink is untouched was
                             the single most common complaint about this extension.
       dmSiteInk   (object)  { host: '#rrggbb' } — the per-site override. Only a
                             host that has an entry here is ever written to, so a
                             site override exists only when the user made one.

     Precedence, lowest to highest: master palette -> site palette -> the user's
     own saved tone/selector rules (which already win by being appended last in
     toneRules()). Nothing here touches a host that has a saved rule. */
  const PALETTE_INK_DEFAULT = '#2f9eae';
  /* The tone rules are painted by a page stylesheet, NOT by content.css, so they
     are not gated on <html class="cr-dark"> the way the engine rules are. That
     was survivable while every rule was a deliberate per-host edit; with the
     master palette DEFAULT-ON it would mean "revert to light" left the page
     light with cyan text on it. Scope every emitted rule to the same class the
     engine uses (and to the frame's class, for a frame we darkened). */
  const DARK_SCOPE = ':root:is(.cr-dark,.cr-frame-dark)';
  let accentOn = true, masterInk = PALETTE_INK_DEFAULT, siteInk = {};
  /* Baseline per element, WITH the invert parity it was measured at.
     Two bugs live here. (1) After the first sweep the element's own colour IS
     the rule's colour, so a second sweep must compare against the original.
     (2) The baseline is only true for the parity it was taken at: a page that
     gets its `filter: invert` applied late (allowlist read, or "darken this
     page" clicked after a sweep) would otherwise keep the un-inverted colour
     forever and the saved rule would never match again. */
  const toneBase = new WeakMap();

  /* ───────────────────────────── storage (callback or promise) ───────── */
  function sget(keys) {
    return new Promise((resolve) => {
      if (!sync) return resolve({});
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v || {}); } };
      try {
        const maybe = sync.get(keys, finish);
        if (maybe && typeof maybe.then === 'function') maybe.then(finish).catch(() => finish({}));
      } catch (e) { finish({}); }
    });
  }

  function sset(obj) {
    return new Promise((resolve) => {
      if (!sync) return resolve(false);
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(true); } };
      try {
        const maybe = sync.set(obj, finish);
        if (maybe && typeof maybe.then === 'function') maybe.then(finish).catch(() => finish());
      } catch (e) { finish(); }
    });
  }

  async function loadRules() {
    const data = await sget({
      tuneRulesByHost: {}, tuneRulesGlobal: [],
      dmInk: '', dmAccent: true, dmSiteInk: {}
    });
    const map = data.tuneRulesByHost || {};
    const fix = (list) => (Array.isArray(list) ? list.map((r) =>
      (r && (r.match === 'color' || r.match === 'light') && !r.id) ? Object.assign({}, r, { id: uid() }) : r) : []);
    perHost = fix(map[host]);
    globalRules = fix(data.tuneRulesGlobal);
    /* THE MASTER AND SITE PALETTES. A malformed value in storage must never
       leave the page un-tinted, so anything that is not #rrggbb falls back to
       the built-in cyan rather than to '' (which cssText would emit as an
       invalid declaration and the whole sweep would look dead). */
    masterInk = hexOr(data.dmInk, PALETTE_INK_DEFAULT);
    accentOn = data.dmAccent !== false;
    siteInk = (data.dmSiteInk && typeof data.dmSiteInk === 'object' && !Array.isArray(data.dmSiteInk))
      ? data.dmSiteInk : {};
    return { perHost, globalRules };
  }

  function hexOr(v, fallback) {
    return (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim())) ? v.trim().toLowerCase() : fallback;
  }

  /** The ink this host should use: site palette, else master palette. */
  function paletteInk() {
    return hexOr(siteInk[host], masterInk);
  }

  /* ── UNDOING OUR OWN INLINE PAINT (1.1.1) ─────────────────────────────────
     The fill cap, the photo dimmer and the label fix write inline
     `!important` values. Those survive `revert()` — the engine class only stops
     the CSS, and inline styles are not CSS we gate. That was invisible while a
     darkening was always a deliberate click; with auto-dark ON, the engine
     applies at document_start and BACKS OUT ~150 ms later on a natively dark
     page (Google's SERP, `body{background:rgb(34,36,42)}`), leaving 47 thumbnails
     carrying `filter: invert(1) brightness(0.82) !important` on a DARK page —
     i.e. every image in the top image-pack rendered as a colour negative.

     So every write records the AUTHORED inline value it replaced, and
     `__dmUnpaint()` puts them back. Record `el.style.getPropertyValue()`, never
     `getComputedStyle()`: the computed value includes our own content.css
     `invert(1)` for images, so restoring it would re-create the negative. */
  function rememberBase(el, prop, attr) {
    if (el.hasAttribute(attr)) return;
    let v = '';
    try { v = el.style.getPropertyValue(prop) || ''; } catch (e) {}
    el.setAttribute(attr, v);
  }
  function restoreBase(el, prop, attr) {
    if (!el.hasAttribute(attr)) return;
    const v = el.getAttribute(attr);
    try {
      if (v) el.style.setProperty(prop, v, 'important');
      else el.style.removeProperty(prop);
    } catch (e) {}
    el.removeAttribute(attr);
  }

  const CAP_BG_BASE = 'data-dm-capbg';
  const CAP_SH_BASE = 'data-dm-capsh';
  const LABEL_ATTR = 'data-dm-label';
  const LABEL_BASE_COLOR = 'data-dm-labc';
  const LABEL_BASE_FILL = 'data-dm-labf';
  const LABEL_BASE_SVG = 'data-dm-labs';
  const IMG_BASE = 'data-dm-imgbase';

  /** Is the engine's class on this document (top document or a darkened frame)? */
  function engineOn() {
    const de = document.documentElement;
    if (!de) return false;
    return de.classList.contains('cr-dark') || de.classList.contains('cr-frame-dark')
      || de.classList.contains('cr-repaint');
  }

  /** Remove every inline declaration and marker this file wrote. */
  function unpaint() {
    let n = 0;
    try {
      const imgs = document.querySelectorAll('[' + IMG_ATTR + ']');
      for (let i = 0; i < imgs.length; i++) {
        restoreBase(imgs[i], 'filter', IMG_BASE);
        imgs[i].removeAttribute(IMG_ATTR);
        n++;
      }
      const caps = document.querySelectorAll('[' + SURFACE_ATTR + ']');
      for (let i = 0; i < caps.length; i++) {
        restoreBase(caps[i], 'background-color', CAP_BG_BASE);
        restoreBase(caps[i], 'box-shadow', CAP_SH_BASE);
        caps[i].removeAttribute(SURFACE_ATTR);
        caps[i].removeAttribute(SURFACE_CAPT_ATTR);
        n++;
      }
      const labels = document.querySelectorAll('[' + LABEL_ATTR + ']');
      for (let i = 0; i < labels.length; i++) {
        restoreBase(labels[i], 'color', LABEL_BASE_COLOR);
        restoreBase(labels[i], '-webkit-text-fill-color', LABEL_BASE_FILL);
        restoreBase(labels[i], 'fill', LABEL_BASE_SVG);
        labels[i].removeAttribute(LABEL_ATTR);
      }
      /* The tone/frame tags paint nothing on their own (their CSS is gated), but
         a stale tag makes the next sweep's bookkeeping lie, so clear them. */
      const tones = document.querySelectorAll('[' + TONE_ATTR + ']');
      for (let i = 0; i < tones.length; i++) tones[i].removeAttribute(TONE_ATTR);
      const finks = document.querySelectorAll('[' + FINK_ATTR + ']');
      for (let i = 0; i < finks.length; i++) finks[i].removeAttribute(FINK_ATTR);
    } catch (e) { return -1; }
    return n;
  }

  async function persist() {
    const data = await sget({ tuneRulesByHost: {} });
    const map = data.tuneRulesByHost || {};
    if (perHost.length) map[host] = perHost; else delete map[host];
    await sset({ tuneRulesByHost: map, tuneRulesGlobal: globalRules });
  }

  /* ───────────────────────────────────── applying rules ──────────────── */
  /* Rules store the colour the EYE should see (intent). The page itself is
     colour-wheel inverted, so what has to be WRITTEN is the complement —
     see invertDepth() below. */
  function cssText(rules) {
    return rules
      .filter((r) => r && (r.sel || ((r.match === 'color' || r.match === 'light') && r.id)))
      .map((r) => {
        if (r.match === 'color' || r.match === 'light') {
          /* A tone rule has no selector at all: elements are tagged by
             sweepTone() with data-dm-tone="<ruleId><o|e>", the trailing letter
             being that element's OWN invert parity. One selector for both
             parities would double-invert restored-photo subtrees, and a real
             selector cannot express "every element showing colour X" anyway —
             CSS has no colour query. */
          const emit = (suffix, conv) => {
            const parts = [];
            if (r.color) {
              parts.push('color:' + conv(r.color) + ' !important');
              // `color` alone does not move ink the site painted with
              // -webkit-text-fill-color, which is a real thing on WordPress-y
              // themes (quantamagazine: 26 elements).
              parts.push('-webkit-text-fill-color:' + conv(r.color) + ' !important');
            }
            /* BOLD INSTEAD OF BRIGHT (2026-11-16). Mike: "*dim the default cyan
               closer to the colors used in this conversation*", then of the first
               dim attempt: "*the more greenish hue is still kind of bright*", then
               "*maybe just bold?*". That is the right instinct: at #3e738b the ink
               is 3.80:1 on a near-black page -- fine for a word, tiring to hunt for
               at 400 weight. Stem weight buys the legibility that brightness was
               being spent on, so the page stops glowing. Applies to the LIGHT rule
               only: an explicit colour pick is the user matching something on the
               page, and silently thickening it would change a design they chose. */
            if (r.match === 'light' && !r.def) parts.push('font-weight:' + LIGHT_WEIGHT + ' !important');
            /* Specificity by repetition. A site (or a rule saved by an older
               version of this extension) can carry a selector like
               `.post__content > div > … > p:nth-of-type(7)` at (0,5,6), which
               beats a plain attribute selector (0,1,0) even with !important —
               measured in Mike's profile, where a leftover 1.0.16 rule kept one
               paragraph of a 153-element group a different teal. Repeating the
               attribute costs nothing at match time and takes us to (0,8,0). */
            const attr = '[' + TONE_ATTR + '="' + r.id + suffix + '"]' +
              ('[' + TONE_ATTR + ']').repeat(7);
            const out = [];
            if (parts.length) out.push(DARK_SCOPE + ' ' + attr + '{' + parts.join(';') + '}');
            if (r.color) {
              /* SVG text paints with `fill` and ignores `color` outright, so a
                 gauge's own labels would tag and stay the same colour. Scoped
                 to `text` elements ONLY — a descendant `*` fill rule would
                 recolour every icon inside a tagged span. */
              out.push(DARK_SCOPE + ' text' + attr + '{fill:' + conv(r.color) + ' !important}');
              out.push(DARK_SCOPE + ' ' + attr + ' text{fill:' + conv(r.color) + ' !important}');
            }
            return out.join('\n');
          };
          return [emit('o', complementCss), emit('e', (x) => x)].filter(Boolean).join('\n');
        }
        const odd = invertDepthFor(r.sel) % 2 === 1;
        const color = r.color ? (odd ? complementCss(r.color) : r.color) : '';
        const bg = r.bg ? (odd ? complementCss(r.bg) : r.bg) : '';
        const parts = [];
        if (color) {
          parts.push('color:' + color + ' !important');
          /* The tone rules have emitted this since 1.0.17; the single-element
             rules did not, so an element whose ink the SITE painted with
             -webkit-text-fill-color kept its colour no matter what was picked —
             `color` does not move text-fill-color ink. Same fix, same reason. */
          parts.push('-webkit-text-fill-color:' + color + ' !important');
        }
        if (bg) parts.push('background-color:' + bg + ' !important');
        if (!parts.length) return '';
        /* Specificity, for "this element only" (2026-11-16).
           This branch used to emit `sel{…}` at the selector's own weight, so any
           site rule with a heavier selector beat it even with !important — and
           every big site ships one (AliExpress order rows: `.order-item .title`
           class chains, cards nested four deep). Result: the rule was written,
           the panel showed a colour, and NOTHING on screen changed. That is the
           "selecting a single element isn't helping" report.
           `x:is(x):is(x)` multiplies specificity by three while matching exactly
           the same elements (an element matches :is(x) iff it matches x), which
           is the cheapest way to outrank a site without changing the blast
           radius. EIGHT copies, not three: specificity is compared field by
           field, so `p.spec2` (0,1,1) repeated three times is (0,3,3) and still
           LOSES to a site rule like `.wrap2 .deep2 p.spec2:nth-of-type(1)` at
           (0,4,1) — class count decides. Measured 2026-11-16: the three-copy
           version left the element exactly the site's colour. Eight copies
           match the (0,8,0) the tone rules already reach by repeating their
           attribute. */
        let sel = r.sel;
        if (sel.indexOf('::') === -1) {          // :is() around a pseudo-element is invalid
          try {
            document.querySelector(sel);         // throws on a malformed selector
            sel = sel + (':is(' + sel + ')').repeat(7);
          } catch (e) { /* leave the rule exactly as written */ }
        }
        return sel + '{' + parts.join(';') + '}';
      })
      .filter(Boolean)
      .join('\n');
  }

  /* ── THE PALETTE OVER AN IMAGE PLATE (1.3.0) ──────────────────────────────

     Mike: *"in the most general way possible, can you try to make the white text
     over that footer image cyan as well?"*

     1.2.0 left image-plate ink entirely alone, and for a good reason: an image
     has no colour readable from CSS, so any write is a guess. But a plate does
     not have to STAY unmeasurable. content.js publishes its measured mean
     luminance (data-cr-bgmean), and a black inset scrim lowers that by a known
     factor — alpha blending is linear in sRGB VALUES, so the composite is
     exactly computable. That turns "unknown plate" into "plate of known
     luminance", which is all the ink engine ever needed.

     So the rule is: solve the SMALLEST scrim at which a palette-derived ink
     clears 4.5:1, and if the scrim would crush the image, BRIGHTEN THE PALETTE
     (same hue, blended toward white) rather than darken the plate further. The
     palette keeps its identity; only its lightness adapts, and only as much as
     the contrast target demands. This is the general form of "make the white text
     cyan": nothing here is specific to one site, one class name or one image.

     Writes are ordinary rememberBase/!important ones, so __dmUnpaint() undoes
     them with everything else. */
  const ISLAND_TARGET = 4.5;      // WCAG AA for body text
  const ISLAND_FLOOR = 3.0;       // accepted only if 4.5 is unreachable
  const ISLAND_SCRIM_MAX = 0.65;  // never hide more than 65% of the image
  const ISLAND_INK_ATTR = 'data-dm-isl-ink';

  /** Blend `c` toward white by t (0..1). Hue is preserved, lightness rises. */
  function lightenTo(c, t) {
    return [c[0] + (255 - c[0]) * t, c[1] + (255 - c[1]) * t, c[2] + (255 - c[2]) * t];
  }
  /** The plate as a grey at measured mean luminance `meanL` under scrim `a`. */
  function plateUnderScrim(meanL, a) {
    const v = Math.pow(Math.max(0, meanL), 1 / 2.2) * (1 - a) * 255;
    return [v, v, v];
  }
  /** Smallest scrim alpha that brings `ink` to `target` against the plate. */
  function solveScrim(meanL, ink, target) {
    if (contrastOf(ink, plateUnderScrim(meanL, 0)) >= target) return 0;
    let lo = 0, hi = 1, best = null;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (contrastOf(ink, plateUnderScrim(meanL, mid)) >= target) { best = mid; hi = mid; }
      else lo = mid;
    }
    return best;
  }

  /** Paint the palette over every dark-island image plate we have measured. */
  function islandInkPass() {
    let islands;
    try { islands = document.querySelectorAll('[data-dm-island="1"]'); } catch (e) { return 0; }
    if (!islands.length) return 0;
    const pal = parseRGB(paletteInk());
    let written = 0;
    for (let i = 0; i < islands.length && i < 40; i++) {
      const isl = islands[i];

      /* Accent off, or no usable palette: put the island back the way the site
         had it. Idempotent, so an accent toggle needs no other bookkeeping. */
      if (!accentOn || !pal) {
        if (isl.hasAttribute(ISLAND_INK_ATTR)) {
          restoreBase(isl, 'box-shadow', CAP_SH_BASE);
          const labs = isl.querySelectorAll('[' + LABEL_ATTR + ']');
          for (let k = 0; k < labs.length; k++) {
            restoreBase(labs[k], 'color', LABEL_BASE_COLOR);
            restoreBase(labs[k], '-webkit-text-fill-color', LABEL_BASE_FILL);
            restoreBase(labs[k], 'fill', LABEL_BASE_SVG);
            labs[k].removeAttribute(LABEL_ATTR);
          }
          isl.removeAttribute(ISLAND_INK_ATTR);
        }
        continue;
      }

      const meanL = Number(isl.getAttribute('data-cr-bgmean'));
      if (!isFinite(meanL) || meanL <= 0) continue;

      /* Candidates: the palette itself, then progressively brighter tints of it.
         First one that fits inside the scrim cap wins, so the palette is only
         lightened when that is what avoids crushing the image. */
      const cands = [pal, lightenTo(pal, 0.25), lightenTo(pal, 0.5), lightenTo(pal, 0.72)];
      let ink = null, a = null;
      for (let c = 0; c < cands.length; c++) {
        const s = solveScrim(meanL, cands[c], ISLAND_TARGET);
        if (s !== null && s <= ISLAND_SCRIM_MAX) { ink = cands[c]; a = s; break; }
      }
      if (!ink) {
        /* 4.5 is out of reach within the cap. Use the cap, take whichever ink is
           best there, and be honest about the number we actually achieved. */
        a = ISLAND_SCRIM_MAX;
        let best = -1;
        for (let c = 0; c < cands.length; c++) {
          const cc = contrastOf(cands[c], plateUnderScrim(meanL, a));
          if (cc > best) { best = cc; ink = cands[c]; }
        }
        if (best < ISLAND_FLOOR) {
          /* no palette tint can hold this plate up; leave the site's own ink and
             paint no scrim, which keeps the native contrast 1.2.0 established */
          continue;
        }
      }

      /* Scrim: black in NATIVE space. An island has its page filter cancelled
         (page invert + our counter-invert = even parity), so this is not the
         inverted-context polarity problem solveOverlay() deals with. */
      if (a > 0.002) {
        try {
          rememberBase(isl, 'box-shadow', CAP_SH_BASE);
          isl.style.setProperty('box-shadow',
            'inset 0 0 0 9999px rgba(0,0,0,' + a.toFixed(3) + ')', 'important');
        } catch (e) { continue; }
      } else {
        restoreBase(isl, 'box-shadow', CAP_SH_BASE);
      }
      isl.setAttribute(ISLAND_INK_ATTR, '1');

      const kids = isl.querySelectorAll('*');
      for (let k = 0; k < kids.length && k < 80; k++) {
        const t = kids[k];
        if (!ownsText(t)) continue;
        let tc;
        try { tc = parseRGB(getComputedStyle(t).webkitTextFillColor || getComputedStyle(t).color); } catch (e) { continue; }
        if (!tc || tc[3] < 0.05) continue;
        if (t.hasAttribute(LABEL_ATTR)) { written++; continue; }   // already ours
        try {
          rememberBase(t, 'color', LABEL_BASE_COLOR);
          rememberBase(t, '-webkit-text-fill-color', LABEL_BASE_FILL);
          rememberBase(t, 'fill', LABEL_BASE_SVG);
          t.style.setProperty('color', rgbCss(ink), 'important');
          t.style.setProperty('-webkit-text-fill-color', rgbCss(ink), 'important');
          t.style.setProperty('fill', rgbCss(ink), 'important');
          t.setAttribute(LABEL_ATTR, '1');
          written++;
        } catch (e) {}
      }
    }
    return written;
  }

  function applyRules() {
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'dm-tuner-rules';
      (document.head || document.documentElement).appendChild(styleEl);
    }
    /* The master palette travels with the rules (1.1.0). It is NOT a stored
       rule, so this array — not toneRules(), which drops selector rules — is
       what the stylesheet must be built from, with the palette rule FIRST so a
       saved rule always wins the cascade. */
    const def = defaultRule();
    const all = (def ? [def] : []).concat(globalRules).concat(perHost).concat(pending ? [pending] : []);
    styleEl.textContent = cssText(all);
    // Tag first? No: the stylesheet must exist before tagging, so the attribute
    // immediately has a rule to attach to. Sweep after writing, then re-sweep
    // anything the observer sees appear later.
    syncUiFilter();
    /* WHICH CODE IS ACTUALLY RUNNING (2026-11-16). Unpacked content scripts are
       read from disk once, at extension load, so an edited tuner.js keeps running
       the OLD build until the extension itself is reloaded -- not the page. That
       produced two rounds of "the fix did nothing" that were really "the fix was
       never loaded". Stamp the running manifest version into the page so the live
       code can be identified by asking, instead of inferred from behaviour. */
    try {
      const mv = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
        ? chrome.runtime.getManifest().version : 'unknown';
      document.documentElement.setAttribute('data-dm-ver', mv);
    } catch (e) {}
    sweepTone();
    /* The fill cap and the photo dimmer only make sense while WE are the ones
       painting the darkness — on a light page they dim surfaces that are already
       the right colour, and on a page we just backed out of they are writing
       inline paint that nothing will remove (1.1.1). */
    if (fillsAllowed() && engineOn()) capSurfaces();   // brightness ceiling for fills (1.0.32)
    /* AFTER the cap sweep, not before: islandInkPass owns the ink on image
       plates, and capSurfaces/applyLabelFix are the passes that must not touch
       it (they both early-return on an island). */
    try { islandInkPass(); } catch (e) {}
    ensureObserve();
  }

  /* The bright-fill ceiling and the photo dimmer write INLINE !important values
     computed from the invert parity they measured — and inside a frame that
     parity changes the instant startFrameTone() decides to darken it, which
     turns every one of those writes into its complement (measured 2026-11-21 on
     the fixture: the drawer's photo came out `brightness(0.82)` with no invert,
     i.e. a dimmed NEGATIVE, because dimPhotos had marked it before the frame had
     its class). Frames are served by content.css (media restore) and
     sweepFrameInk (accent ink) instead, both of which are parity-correct by
     construction. */
  function fillsAllowed() { return window.top === window; }

  /* ───────────────────────────────────────── colour maths ────────────── */
  function parseRGB(str) {
    if (!str) return null;
    const s = String(str).trim();
    let m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) {
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
    }
    m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) {
      const h = m[1];
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1];
    }
    m = /rgba?\(([^)]+)\)/i.exec(s);
    if (m) {
      const p = m[1].split(',').map((x) => parseFloat(x));
      return [p[0] | 0, p[1] | 0, p[2] | 0, p.length > 3 ? p[3] : 1];
    }
    return null;
  }

  function lum(rgb) {
    const f = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  }

  function ratio(a, b) {
    const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** The painted backdrop behind `el`: walk up to the first opaque background. */
  function backdropOf(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      const bg = parseRGB(getComputedStyle(node).backgroundColor);
      if (bg && bg[3] > 0.5) return bg;
      node = node.parentElement;
    }
    return [255, 255, 255, 1];
  }

  /* ────────────────────────────────────────── panel plumbing ─────────── */
  function mk(tag, props, kids) {
    const node = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'text') node.textContent = props[k];
      else if (k === 'cls') node.className = props[k];
      else if (k === 'style') node.setAttribute('style', props[k]);
      else node.setAttribute(k, props[k]);
    }
    (kids || []).forEach((c) => c && node.appendChild(c));
    return node;
  }

  function ensureRoot() {
    if (root) return;
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('style', 'all:initial; position:fixed; z-index:2147483646; right:16px; bottom:16px;');
    shadow = root.attachShadow({ mode: 'open' });
    shadow.appendChild(mk('style', {
      text: [
        ':host{all:initial}',
        '.p{font:12px/1.45 system-ui,sans-serif;color:#e8e8e8;background:#161616;border:1px solid #3a3a3a;',
        '   border-radius:8px;padding:10px;width:288px;box-shadow:0 6px 24px rgba(0,0,0,.5)}',
        '.h{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}',
        '.t{font-weight:600;letter-spacing:.02em}',
        'button{font:inherit;color:#ddd;background:#2a2a2a;border:1px solid #454545;border-radius:5px;',
        '       padding:3px 7px;cursor:pointer;margin:0 4px 4px 0}',
        'button:hover{background:#343434}',
        'button.on{background:#0d6e6e;border-color:#12a0a0;color:#fff}',
        'button.x{background:none;border:none;font-size:14px;padding:0 2px;margin:0}',
        'select,input[type=text],textarea{font:inherit;color:#e8e8e8;background:#0f0f0f;',
        '       border:1px solid #454545;border-radius:5px;padding:2px 4px;width:100%;box-sizing:border-box}',
        'input[type=color]{width:34px;height:22px;padding:0;border:1px solid #454545;background:#0f0f0f}',
        '.row{display:flex;align-items:center;gap:6px;margin:3px 0}',
        '.lab{flex:0 0 40px;color:#9aa}',
        '.dim{color:#8d8d8d}',
        '.warn{color:#ff8b6b}',
        '.ok{color:#7fd68b}',
        '.box{border-top:1px solid #2c2c2c;margin-top:6px;padding-top:6px}',
        'textarea{height:74px;resize:vertical}',
        '.rule{display:flex;justify-content:space-between;gap:6px;padding:1px 0}',
        '.sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:middle}'
      ].join('\n')
    }));

    panel = mk('div', { cls: 'p' });

    const head = mk('div', { cls: 'h' }, [
      mk('span', { cls: 't', text: 'Tune in place' }),
      closeBtn()
    ]);

    const pickBtn = mk('button', { id: 'pick', text: '🎯 Pick element' });
    pickBtn.addEventListener('click', () => togglePick(pickBtn));

    infoEl = mk('div', { cls: 'dim', text: 'No element selected.', id: 'info' });
    groupsEl = mk('div', { cls: 'dim', text: '', id: 'groups' });
    contrastEl = mk('div', { cls: 'dim', text: '', id: 'contrast' });
    mirrorEl = mk('div', { cls: 'dim', text: '', id: 'mirror' });
    verifyEl = mk('div', { cls: 'dim', text: '', id: 'verify' });

    scopeSel = mk('select', { id: 'scope' });
    scopeSel.addEventListener('change', onScopeChange);
    customInput = mk('input', { type: 'text', id: 'custom', placeholder: '.some-class' });
    customInput.addEventListener('input', () => {
      if (scopeSel.value === '__custom') setPending(customInput.value.trim());
    });

    txtInput = mk('input', { type: 'color', id: 'txt', value: '#00ffff' });
    txtInput.addEventListener('input', () => { pending && (pending.color = txtInput.value); update(); });
    const txtHex = mk('span', { cls: 'dim', id: 'txthex' });
    txtInput.addEventListener('input', () => { txtHex.textContent = txtInput.value; });

    bgInput = mk('input', { type: 'color', id: 'bg', value: '#000000' });
    bgInput.addEventListener('input', () => {
      if (pending && !bgChk.checked) pending.bg = bgInput.value;
      update();
    });
    bgChk = mk('input', { type: 'checkbox', id: 'nobg', checked: 'checked' });
    bgChk.addEventListener('change', () => {
      bgInput.disabled = bgChk.checked;
      if (pending) pending.bg = bgChk.checked ? '' : bgInput.value;
      update();
    });
    bgInput.disabled = true;

    const saveBtn = mk('button', { id: 'save', text: '💾 Save for this host' });
    saveBtn.addEventListener('click', onSave);
    const forgetBtn = mk('button', { id: 'forget', text: 'Remove' });
    forgetBtn.addEventListener('click', onForget);
    const exportBtn = mk('button', { id: 'export', text: 'Copy JSON' });
    exportBtn.addEventListener('click', onExport);

    exportEl = mk('textarea', { id: 'exported', readonly: 'readonly', hidden: 'hidden' });
    listEl = mk('div', { cls: 'box', id: 'rules' });

    /* Coverage + the one-click reach. "73 still light" is the sentence the
       panel could not say before, and the button is the answer to "we need a
       way to reach more classes": it widens the rule to a luminance threshold
       instead of asking the user to guess which class is left over. */
    coverageEl = mk('div', { cls: 'dim', id: 'coverage', text: '' });
    coverBtn = mk('button', { id: 'cover', hidden: 'hidden', text: '⚡ Also cover everything light' });
    coverBtn.addEventListener('click', () => {
      if (!pending) return;
      applyLight();
      if (scopeSel.querySelector('option[value="__light"]')) scopeSel.value = '__light';
      update();
    });

    panel.appendChild(head);
    panel.appendChild(mk('div', {}, [pickBtn]));
    panel.appendChild(infoEl);
    panel.appendChild(groupsEl);
    panel.appendChild(coverageEl);
    panel.appendChild(mk('div', {}, [coverBtn]));
    panel.appendChild(mk('div', { cls: 'row' }, [mk('span', { cls: 'lab', text: 'apply' }), scopeSel]));
    panel.appendChild(customInput);
    panel.appendChild(mk('div', { cls: 'row' }, [
      mk('span', { cls: 'lab', text: 'text' }), txtInput, txtHex,
      mk('label', { cls: 'dim' }, [bgChk, mk('span', { text: ' leave bg' })])
    ]));
    panel.appendChild(mk('div', { cls: 'row' }, [mk('span', { cls: 'lab', text: 'bg' }), bgInput]));
    panel.appendChild(contrastEl);
    panel.appendChild(mirrorEl);
    panel.appendChild(verifyEl);
    panel.appendChild(mk('div', { cls: 'box' }, [saveBtn, forgetBtn, exportBtn]));
    panel.appendChild(exportEl);
    panel.appendChild(listEl);

    shadow.appendChild(panel);
    document.documentElement.appendChild(root);
    syncUiFilter();
    renderRules();
  }

  function closeBtn() {
    const b = mk('button', { cls: 'x', text: '✕', title: 'close' });
    b.addEventListener('click', () => closePanel());
    return b;
  }

  function openPanel() {
    ensureRoot();
    root.style.display = '';
    syncUiFilter();
    renderRules();
    renderCoverage();
  }

  function closePanel() {
    stopPick();
    if (root) root.style.display = 'none';
  }

  /* ──────────────────────────────────────── the element picker ──────── */
  function togglePick(btn) {
    if (picking) { stopPick(); btn.classList.remove('on'); return; }
    picking = true;
    btn.classList.add('on');
    if (!hi) {
      hi = document.createElement('div');
      hi.id = 'dm-tuner-hi';
      hi.setAttribute('style',
        'all:initial;position:fixed;pointer-events:none;z-index:2147483647;' +
        'border:2px solid #00ffff;background:rgba(0,255,255,.07);border-radius:2px;');
      document.documentElement.appendChild(hi);
      syncUiFilter();
    }
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  function stopPick() {
    picking = false;
    const b = shadow && shadow.getElementById('pick');
    if (b) b.classList.remove('on');
    if (hi) hi.style.display = 'none';
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function insideRoot(node) {
    return root && (node === root || root.contains(node));
  }

  function onMove(e) {
    if (!picking) return;
    if (insideRoot(e.target)) { hi.style.display = 'none'; return; }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === hi) return;
    const r = el.getBoundingClientRect();
    hi.style.display = 'block';
    hi.style.left = r.left + 'px';
    hi.style.top = r.top + 'px';
    hi.style.width = r.width + 'px';
    hi.style.height = r.height + 'px';
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    stopPick();
  }

  function onClick(e) {
    if (!picking || insideRoot(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    stopPick();
    if (el) capture(el);
  }

  function capture(el) {
    lastPick = el;
    const mine = rendersOf(el) || renderedAs(rgbToHex(getComputedStyle(el).color), el);
    lastMine = mine;
    lastGroups = colourGroups();
    const groups = sortedGroups();
    const dom = groups.length ? groups[0][0] : '';
    const mineGroup = lastGroups.get(mine) || { n: 0, chars: 0, tags: {} };
    const domGroup = dom ? lastGroups.get(dom) : null;

    const classes = [...el.classList]
      .filter((c) => !/^(cr-|dm-)/.test(c))
      .map((c) => ({ c: c, n: document.querySelectorAll('.' + CSS.escape(c)).length }))
      .sort((a, b) => a.n - b.n);

    const tag = el.tagName.toLowerCase();
    infoEl.textContent = tag + (el.id ? '#' + el.id : '') + (classes.length
      ? '  ·  ' + classes.length + ' class(es)  ·  ' +
        classes.map((x) => '.' + x.c + '(' + x.n + ')').join(' ')
      : '  ·  no class');

    // the sweep the user asked for: what colour is this, and how much text shares it
    if (groupsEl) {
      const n = (h) => (lastGroups.get(h) ? lastGroups.get(h).n : 0);
      groupsEl.textContent = groups.length
        ? (dom === mine
            ? n(dom) + ' elements show ' + dom + '  ·  ' + groups.length + ' text colours'
            : 'dominant ' + dom + ' ×' + n(dom) + '  ·  this ' + mine + ' ×' + n(mine) +
              '  ·  ' + groups.length + ' colours')
        : '';
    }

    // scope options: this element, this colour, the dominant colour, classes, custom
    while (scopeSel.firstChild) scopeSel.removeChild(scopeSel.firstChild);
    scopeSel.appendChild(mk('option', { value: '__this', text: 'this element only' }));
    if (mineGroup.n >= 2) {
      scopeSel.appendChild(mk('option', {
        value: '__tone',
        text: '≈ all text ' + mine + '  → ' + mineGroup.n + ' element' + (mineGroup.n === 1 ? '' : 's') +
              (mine === dom ? ' (dominant)' : ' (this colour)')
      }));
    }
    /* The reach option. On Mike's dashboard "all text #cecdc9" covered the big
       numbers but not every label, because a handful of labels render a shade
       that rounds differently after inversion — and no list of exact colours
       can ever be complete on a page that keeps repainting values from an API.
       One threshold covers all of them, now and after the next render. */
    let lightTotal = 0, lightColours = 0;
    lastGroups.forEach((g, h) => { if (inkNeedsAccent(h)) { lightTotal += g.n; lightColours++; } });
    if (lightTotal >= 2) {
      scopeSel.appendChild(mk('option', {
        value: '__light',
        text: '≈ everything light  → ' + lightTotal + ' elements in ' + lightColours +
              ' colour' + (lightColours === 1 ? '' : 's') + ' (widest reach)'
      }));
    }
    if (dom && dom !== mine && domGroup && domGroup.n >= 2) {
      scopeSel.appendChild(mk('option', {
        value: '__tone:' + dom,
        text: '≈ all text ' + dom + '  → ' + domGroup.n + ' (dominant)'
      }));
    }
    classes.forEach((x) => {
      scopeSel.appendChild(mk('option', {
        value: '.' + x.c,
        text: '.' + x.c + '  → ' + x.n + ' element' + (x.n === 1 ? '' : 's')
      }));
    });
    scopeSel.appendChild(mk('option', { value: '__custom', text: 'custom selector…' }));

    /* Default scope. A class is preferred only when it reaches essentially the
       WHOLE colour group — it used to win at 50% of it, which is how `.fdp-val`
       (56 elements) beat "all text #cecdc9" (129) on the ambientweather
       dashboard: the numbers recoloured and 73 white labels did not, and there
       was nothing on screen saying so. Markup classes are a coincidence of how
       a site was built; the colour is what the user is pointing at. */
    const best = classes.filter((x) => x.n > 1 && x.n <= 200).pop() || classes[0];
    let defVal;
    const classCoversGroup = best && best.n >= mineGroup.n * 0.9;
    if (mineGroup.n >= 5 && !classCoversGroup) defVal = '__tone';
    else if (best) defVal = '.' + best.c;
    else if (mineGroup.n >= 8) defVal = '__tone';
    else defVal = '__this';

    pending = null;
    /* Grey seeds cyan too, not only near-white, and it uses THE SAME test the
       sweep uses -- so the knob can never "replace" an element with the colour
       it is already showing, and a mid-grey click offers cyan like a white one
       does. */
    const seed = inkNeedsAccent(mine) ? DEFAULT_INK : mine;
    txtInput.value = seed;
    shadow.getElementById('txthex').textContent =
      seed === mine ? mine : mine + '  →  ' + seed;
    if (defVal.indexOf('__tone:') === 0) applyTone(defVal.slice(7));
    else if (defVal === '__tone') applyTone(mine);
    else setPending(defVal === '__this' ? uniqueSelectorFor(el) : defVal);
    scopeSel.value = defVal;
    /* applyTone/applyLight seed pending.color from `mine`; carry the cyan seed
       through so the first render already writes it. */
    if (pending && seed !== mine) { pending.color = seed; update(); }

    customInput.hidden = true;
    customInput.value = '';
    renderRules();
    update();
  }

  function onScopeChange() {
    const v = scopeSel.value;
    customInput.hidden = v !== '__custom';
    if (v === '__tone') {
      applyTone(lastMine);
    } else if (v === '__light') {
      applyLight();
    } else if (v.indexOf('__tone:') === 0) {
      applyTone(v.slice(7));
    } else if (v === '__this') {
      const el = lastPick;
      setPending(el ? uniqueSelectorFor(el) : '');
    } else if (v === '__custom') {
      setPending(customInput.value.trim());
    } else {
      setPending(v);
    }
  }

  /** Switch `pending` to a colour-group rule: "every element showing `from`". */
  function applyTone(from) {
    const color = (pending && pending.color) || txtInput.value || '#00ffff';
    const bg = pending ? (pending.bg || '') : (bgChk.checked ? '' : bgInput.value);
    pending = {
      id: (pending && pending.match === 'color' && pending.id) || uid(),
      match: 'color',
      from: from,
      color: color,
      bg: bg || ''
    };
    lastKey = ruleKey(pending);
    update();
  }

  /** Threshold rule: "every text element that is light", whatever its colour. */
  function applyLight() {
    const color = (pending && pending.color) || txtInput.value || '#00ffff';
    const bg = pending ? (pending.bg || '') : (bgChk.checked ? '' : bgInput.value);
    pending = {
      id: (pending && pending.match === 'light' && pending.id) || uid(),
      match: 'light',
      from: '',
      color: color,
      bg: bg || '',
      min: LIGHT_MIN
    };
    lastKey = ruleKey(pending);
    update();
  }

  function setPending(sel) {
    const color = (pending && pending.color) || txtInput.value || '#00ffff';
    const bg = pending ? (pending.bg || '') : (bgChk.checked ? '' : bgInput.value);
    pending = { sel: sel, color: color, bg: bg || '' };
    lastKey = ruleKey(pending);
    update();
  }

  /** Stable identity for a rule: a tone rule is "text colour X", not a selector. */
  function ruleKey(r) {
    if (!r) return '';
    if (r.match === 'light') return 'light';
    if (r.match === 'color') return 'tone:' + r.from;
    return r.sel || '';
  }

  function rgbToHex(str) {
    const c = parseRGB(str);
    if (!c) return '#ffffff';
    const h = (n) => n.toString(16).padStart(2, '0');
    return '#' + h(c[0]) + h(c[1]) + h(c[2]);
  }

  /* "This element only" must actually mean ONE element. A classless, id-less
     element used to fall back to its tag name, so scoping a single heading
     quietly restyled every <strong> in the article (measured on quantamagazine:
     `strong` matched 3, and the same fallback runs to dozens on long pages).
     Build a path upward, testing after every step, and stop at the first one
     that matches exactly one element. Ancestors contribute their first class
     too — Quanta ships the same article twice (mobile + desktop), so a purely
     positional path stops being unique at the wrapper that differs. */
  function stepFor(node) {
    const tag = node.tagName.toLowerCase();
    let cls = '';
    if (node.classList && node.classList.length) {
      const own = [...node.classList].filter((c) => !/^(cr-|dm-)/.test(c));
      if (own.length) cls = '.' + CSS.escape(own[0]);
    }
    const parent = node.parentElement;
    if (!parent) return tag + cls;
    const same = [...parent.children].filter((c) => c.tagName === node.tagName);
    const nth = same.length > 1 ? ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : '';
    return tag + cls + nth;
  }

  function uniqueSelectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      parts.unshift(stepFor(node));
      const sel = parts.join(' > ');
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch (e) { /* keep climbing */ }
      if (parts.length >= 12) break;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  /* ─────────── colour-wheel inversion: intent vs what gets written ──────
     content.css puts `filter: invert(1)` on html.cr-dark, and re-inverts media
     (img/video/canvas/…) and restored background-photo elements so they keep
     their true colours — those subtrees therefore carry TWO inverts (net
     identity), not one.

     The colour that RENDERS is the complement of the colour written, per odd
     invert above the element. So picking cyan wrote #00ffff and the page showed
     #ff0000 — "the picker is colour-wheel mirrored". Fixed by storing intent
     and complementing on the way into the stylesheet, measured per selector so
     a restored photo subtree is left alone. */
  function invertDepth(el) {
    let n = 0;
    let node = el;
    let doc = el && el.ownerDocument;
    let guard = 0;
    while (node && node.nodeType === 1 && guard++ < 256) {
      const f = getComputedStyle(node).filter;
      if (f && f !== 'none' && /invert\(\s*(?:1|100%)\s*\)/.test(f)) n++;
      if (node.parentElement) { node = node.parentElement; continue; }
      /* A filter does not stop at a frame boundary (2026-11-21). The page's
         `html{filter:invert(1)}` paints the iframe's CONTENT, and the iframe
         element's own filter cancels it — so the parity that decides how ink
         renders inside a frame is the frame element's chain, not the frame
         document's (which starts at a parentless <html> and reported 0). Only a
         same-origin frame can read its container, and that is exactly the case
         where the ink engine is allowed to judge the frame at all. */
      let fe = null;
      try { fe = doc && doc.defaultView ? doc.defaultView.frameElement : null; } catch (e) { fe = null; }
      if (!fe) break;
      doc = fe.ownerDocument;
      node = fe;
    }
    return n;
  }

  // Selector not painted yet (typing, dynamic) -> assume the page-level count.
  function invertDepthFor(sel) {
    let el = null;
    try { el = sel ? document.querySelector(sel) : null; } catch (e) { el = null; }
    return invertDepth(el || document.documentElement);
  }

  function complementCss(str) {
    const c = parseRGB(str);
    if (!c) return str;
    const r = 255 - c[0], g = 255 - c[1], b = 255 - c[2];
    if (/^#[0-9a-f]{3}$/i.test(str) || /^#[0-9a-f]{6}$/i.test(str)) {
      const h = (n) => n.toString(16).padStart(2, '0');
      return '#' + h(r) + h(g) + h(b);
    }
    return 'rgba(' + r + ',' + g + ',' + b + ',' + c[3] + ')';
  }

  // The colour an element actually shows to the viewer.
  function renderedAs(str, el) {
    return el && invertDepth(el) % 2 === 1 ? complementCss(str) : str;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function isSvgText(el) {
    return !!el && el.namespaceURI === SVG_NS && /^text$/i.test(el.tagName);
  }

  /* ═════════ FRAMES SITTING INSIDE AN INVERTED PAGE (1.0.41, 2026-11-21) ═════

     Mike: *"after adding something to the cart, a right side view of the cart is
     presented which is not being inverted. It would also be nice if the text was
     pushed to cyan (instead of white)."*

     The flyout is not a div. It is
         <iframe id="thd-drawer-frame" src="/cart/atc?…">   499x1519, right edge
     and content.css re-inverts every iframe (`html.cr-dark iframe{filter:invert(1)}`)
     so that video and payment embeds stay in true colour. That restore cancelled
     the page filter for the drawer too. Measured in the user's own tab: the frame
     crop averaged luminance 0.950 (a white panel beside a 0.043-black page), and
     the identical crop with filter:none forced on that one frame measured 0.043.

     So each frame now judges ITSELF. This file already runs in every frame
     (manifest `all_frames: true`), and a same-origin frame can reach its
     container through window.frameElement — so no cross-document poking and no
     parent-side scan is needed:

       light frame inside an inverted page -> mark the container
           data-cr-frame="dark"  (content.css drops the restore: the page filter
                                  now darkens us), add html.cr-frame-dark (media
                                  inside the frame is re-inverted back to true
                                  colour), and tint neutral ink with the accent.
       dark frame                        -> leave it restored. A dark embedded
                                            app must not be inverted into a light
                                            one.
       cross-origin frame                -> frameElement is null, nothing runs.
                                            YouTube/payment embeds keep the old,
                                            correct true-colour behaviour.
       unmeasurable frame                -> leave the default restore.

     The ink half matters as much as the darkening: with the page filter applied,
     the drawer's #202020 ink renders white, which is exactly what Mike asked to
     be cyan. Elements are tagged data-dm-fink and one stylesheet — written in
     COMPLEMENT space, because the frame's content is still one invert away —
     paints them with the accent. Same predicate as the rest of the extension
     (inkNeedsAccent), so saturated ink keeps its meaning. */
  const FRAME_DARK_CLASS = 'cr-frame-dark';
  const FINK_ATTR = 'data-dm-fink';
  const FRAME_MEDIA = /^(IMG|VIDEO|CANVAS|IFRAME|OBJECT|EMBED|SVG|PICTURE|SCRIPT|STYLE|LINK|HEAD|META|NOSCRIPT|TEMPLATE)$/;
  const FRAME_MIN_AREA = 20000;      // 141x141: below this nobody is reading it

  /* Element -> the ink colour it showed BEFORE we tagged it, so a second sweep
     judges the site's ink and not our own paint. */
  const frameBase = new WeakMap();

  function frameContainer() {
    try { return window.frameElement || null; } catch (e) { return null; }
  }

  /* Is this frame's own document a LIGHT page? Area-weighted opaque background
     first — that is what the eye sees behind everything. Frames that paint no
     big plate (a dark app on a transparent canvas) fall back to their ink, where
     dark type means a light page. null = nothing measurable, decide nothing. */
  function frameLightness() {
    const body = document.body;
    if (!body) return null;
    const deRect = document.documentElement.getBoundingClientRect();
    const vp = Math.max(1, (deRect.width || window.innerWidth || 0) * (deRect.height || window.innerHeight || 0));
    let area = 0, sum = 0;
    const els = [document.documentElement, body]
      .concat(Array.prototype.slice.call(body.querySelectorAll('*'), 0, 5000));
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (!el || el.nodeType !== 1 || FRAME_MEDIA.test(el.tagName)) continue;
      let cs;
      try { cs = getComputedStyle(el); } catch (e) { continue; }
      const c = parseRGB(cs.backgroundColor);
      if (!c || c[3] < 0.5) continue;
      const r = el.getBoundingClientRect();
      const a = r.width * r.height;
      if (a < 2000) continue;
      area += a;
      sum += a * lum(c);
    }
    if (area >= vp * 0.15) {
      const mean = sum / area;
      return { light: mean >= 0.5, by: 'surface', mean: +mean.toFixed(3), cover: +(area / vp).toFixed(2) };
    }
    let inkSum = 0, inkN = 0;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.nodeValue || '').trim();
      if (!t || !node.parentElement) continue;
      let cs;
      try { cs = getComputedStyle(node.parentElement); } catch (e) { continue; }
      const c = parseRGB(cs.color);
      if (c && c[3] > 0.3) { inkSum += lum(c); inkN++; }
      if (inkN >= 400) break;
    }
    if (!inkN) return null;
    const meanInk = inkSum / inkN;
    return { light: meanInk <= 0.5, by: 'ink', meanInk: +meanInk.toFixed(3), n: inkN };
  }

  /* Which accent? A tuning rule the user saved for this host wins; otherwise the
     extension's own ink. Frames are not selectable in the picker, so without
     this the drawer would be the one place the tuned colour does not reach. */
  function frameAccentIntent() {
    if (!accentOn) return '';
    const rules = toneRules();
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i];
      if (r && (r.match === 'light' || r.match === 'color') && r.color) return r.color;
    }
    return paletteInk();
  }

  function frameInkCss(intent) {
    const write = complementCss(intent);
    const one = '[' + FINK_ATTR + ']';
    const many = one.repeat(8);           // (0,9,0): beats a site's own chain
    return [
      ':root ' + many + '{color:' + write + ' !important;' +
        '-webkit-text-fill-color:' + write + ' !important;' +
        'font-weight:' + LIGHT_WEIGHT + ' !important}',
      ':root text' + many + '{fill:' + write + ' !important}',
      ':root ' + one + ' text' + one.repeat(7) + '{fill:' + write + ' !important}'
    ].join(String.fromCharCode(10));
  }

  function frameRuleStyle(on, css) {
    let st = document.getElementById('dm-frame-rules');
    if (!on) { if (st && st.parentNode) st.parentNode.removeChild(st); return; }
    if (!css) return;
    if (!st) {
      st = document.createElement('style');
      st.id = 'dm-frame-rules';
      (document.head || document.documentElement).appendChild(st);
    }
    if (st.textContent !== css) st.textContent = css;
  }

  function sweepFrameInk(intent) {
    const body = document.body;
    if (!body) return 0;
    /* The master palette can be switched OFF (or a rule list emptied) while the
       frame is already dark; leaving the old stylesheet up would keep the frame
       tinted by a colour that no longer exists. */
    if (!intent) {
      frameRuleStyle(false);
      const marked = document.querySelectorAll('[' + FINK_ATTR + ']');
      for (let i = 0; i < marked.length; i++) marked[i].removeAttribute(FINK_ATTR);
      return 0;
    }
    const all = [body].concat(Array.prototype.slice.call(body.querySelectorAll('*'), 0, 8000));
    const plan = [];
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el.nodeType !== 1 || !ownsText(el)) continue;
      /* rendersOf() already answers "what colour does the eye see" and now knows
         about the frame boundary (invertDepth hops to frameElement), so a
         drawer's #202020 arrives here as #dfdfdf. */
      /* A tagged element's live colour is OUR paint, so its decision has to be
         made against the colour it had before we touched it. Same convention as
         the tone sweep's toneBase, kept local so the two can never disagree. */
      const tagged = el.hasAttribute(FINK_ATTR);
      const rendered = tagged ? (frameBase.get(el) || rendersOf(el)) : rendersOf(el);
      if (!rendered) continue;
      plan.push([el, inkNeedsAccent(rendered) ? '1' : '']);
    }
    let hits = 0;
    for (let i = 0; i < plan.length; i++) {
      const el = plan[i][0], want = plan[i][1];
      const has = el.getAttribute(FINK_ATTR);
      if (want) {
        hits++;
        if (has !== want) {
          if (!frameBase.has(el)) frameBase.set(el, rendersOf(el) || '');
          el.setAttribute(FINK_ATTR, want);
        }
      }
      else if (has) el.removeAttribute(FINK_ATTR);
    }
    frameRuleStyle(true, frameInkCss(intent));
    return hits;
  }

  function startFrameTone() {
    if (window.top === window) return;              // top document: the engine's job
    const fe = frameContainer();
    if (!fe) return;                                // cross-origin: not ours to judge
    let state = '';                                 // '', 'dark'
    let timer = null, lastEvidence = null;

    function pageInverted() {
      try {
        return invertDepth(fe.ownerDocument.documentElement) % 2 === 1;
      } catch (e) { return false; }
    }

    function clear() {
      if (state === '') return;
      state = '';
      document.documentElement.classList.remove(FRAME_DARK_CLASS);
      try { if (fe.getAttribute('data-cr-frame') === 'dark') fe.removeAttribute('data-cr-frame'); } catch (e) {}
      frameRuleStyle(false);
      const marked = document.querySelectorAll('[' + FINK_ATTR + ']');
      for (let i = 0; i < marked.length; i++) marked[i].removeAttribute(FINK_ATTR);
    }

    function step() {
      if (!document.body) return;
      if (!pageInverted()) { clear(); return; }
      /* Once the frame is dark, stop re-deciding it. The measurement is a full
         DOM walk and the observer re-runs this on every mutation, so paying for
         it forever is the one way this pass could cost a slow page frames. The
         ink sweep below is idempotent and cheap, and it is the half that has to
         keep up with content the drawer streams in. */
      if (state === 'dark') { sweepFrameInk(frameAccentIntent()); return; }
      const r = document.documentElement.getBoundingClientRect();
      const area = (r.width || window.innerWidth || 0) * (r.height || window.innerHeight || 0);
      if (area < FRAME_MIN_AREA) return;            // too small to matter
      const m = frameLightness();
      if (!m) return;                               // unmeasurable: keep the restore
      if (!m.light) { clear(); return; }            // a dark app in a frame stays true
      lastEvidence = m;
      /* Mark the container FIRST: that is what lets the page filter reach us and
         what changes our parity, and every colour decision below is made in
         complement space because of it. */
      if (state !== 'dark') {
        state = 'dark';
        try { fe.setAttribute('data-cr-frame', 'dark'); } catch (e) {}
        document.documentElement.classList.add(FRAME_DARK_CLASS);
      }
      sweepFrameInk(frameAccentIntent());
    }

    function schedule(delay) {
      if (timer) return;
      timer = setTimeout(function () { timer = null; try { step(); } catch (e) {} }, delay || 250);
    }

    /* Three watchers, because the drawer arrives late and can arrive twice:
       (1) our own DOM fills in after the frame's load event;
       (2) the HOSTING page may be darkened after us (or lifted again) — that is
           an attribute change on a document we can read;
       (3) the ladder covers the case where both are already true before this
           script ran, which no mutation will ever announce. */
    try {
      new MutationObserver(function () { schedule(300); })
        .observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    try {
      new MutationObserver(function () { schedule(300); })
        .observe(fe.ownerDocument.documentElement, { attributes: true, attributeFilter: ['class'] });
    } catch (e) {}
    [0, 300, 900, 2000, 4000, 8000, 15000].forEach(function (t) { setTimeout(function () { try { step(); } catch (e) {} }, t); });
    window.addEventListener('load', function () { schedule(400); });

    window.__dmFrame = {
      state: function () { return { marked: state, evidence: lastEvidence, parity: invertDepth(document.documentElement) % 2, tagged: document.querySelectorAll('[' + FINK_ATTR + ']').length }; },
      step: function () { step(); return window.__dmFrame.state(); }
    };
  }

  /* "Light" is the only thing left after an exact colour stops being enough.
     Mike, 2026-11-11, pointing at the ambientweather dashboard: *"after
     selecting the numeric Fahrenheit temperature, and selecting a color, a
     bunch of numeric text switched (as it should), but lots of non-numeric
     text stayed white. We need a way to reach more classes."* Every piece of
     text on that page that the eye reads as white really is one colour
     (#cecdc9 = the inverted #313236), but the CONTROL he reached for was a
     class, and a class is a coincidence of markup: `.fdp-val` covered 56 of
     the 129 light-text elements, so the values recoloured and the labels did
     not. A threshold rule covers the whole page no matter how many colours or
     classes the site uses, and it keeps covering text the site adds later.
     WCAG relative luminance. 0.45 was the old floor and it was simply wrong:
     on an INVERTED page every site-dark colour renders light, so the greys
     that actually appear on screen are the site's own light greys -- measured
     on the AliExpress cart (2026-11-16): #8a8a8a (L 0.254) x57 and #dddddd
     (L 0.723) x14 were all skipped, because a page whose ink renders mid-grey
     on near-black is exactly the page where grey needs replacing. 0.15 is
     above the near-black backdrop (#111 = 0.006) and below the greys these
     sites ship, so "grey text" now means grey text.
     NEUTRALITY IS NEW and load-bearing. Lowering the floor alone would have
     swept up every saturated colour that happens to be bright -- links,
     prices, sale badges -- and turned them cyan. "White or grey" means the
     channels agree (spread <= 14/255); anything with real chroma keeps its hue
     unless it is bright enough to read as white regardless (L >= 0.62). */
  const LIGHT_MIN = 0.15;
  /* NEUTRALITY IS A SATURATION TEST, NOT A CHANNEL-SPREAD TEST. The first
     version allowed spread <= 14/255, which silently excluded the warm greys
     these sites actually use: AliExpress renders 87 elements at #9f9b8d
     (spread 18) -- light grey with a warm cast -- and both the coverage count
     and the post-paint check called them "not neutral", so they agreed the page
     was complete while 87 grey items sat unrecoloured. HSL saturation is
     hue-independent and scale-aware: #9f9b8d is 8.6% saturated, a grey; a sale
     badge at #fe76be is 100%, untouched; bright yellow (#ffff00) is 100% and
     stays yellow instead of being mistaken for white. */
  const NEUTRAL_SAT = 0.20;
  function saturation(hex) {
    const c = parseRGB(hex);
    if (!c) return 1;
    const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d === 0) return 0;
    const l = (mx + mn) / 2;
    return d / (1 - Math.abs(2 * l - 1));
  }
  function inkIsNeutral(hex) {
    return !!parseRGB(hex) && saturation(hex) <= NEUTRAL_SAT;
  }
  /* The knob used to be seeded with whatever colour the element already shows,
     which makes "replace this white with a colour" a no-op until you notice the
     swatch. Near-white ink therefore seeds CYAN; anything else keeps its own
     colour, so nudging an accent stays a nudge. */
  /* THE DEFAULT INK IS A CYAN (1.1.0, 2026-11-27). Mike: "there are MANY sites
     in which I'd like to ensure Dark Mode AND convert as much white to cyan as
     possible"; cyan is his current preference and the master palette in the
     popup changes it in one control.

     Why #2f9eae and not #00ffff or the 1.0.x #3e738b:

       #00ffff  hue 180  L 50%  contrast 15.79 on #0a0a0a  (exhausting, rejected)
       #3e738b  hue 199  L 39%  contrast  3.80  (the old dim blue-cyan)
       #2f9eae  hue 188  L 43%  contrast  6.24  (this — unmistakably cyan, and
                                                  past AA without glowing)

     It also no longer needs the 600 weight crutch the dim ink used, so the
     master rule does NOT force font-weight (see cssText: `r.def`). */
  const DEFAULT_INK = PALETTE_INK_DEFAULT;
  /* 600, not 700: enough stem to read dim ink on black, not so much that every
     label screams. */
  const LIGHT_WEIGHT = 600;
  function inkIsLight(hex) {
    const c = parseRGB(hex);
    if (!c) return false;
    /* Light AND colourless. The old rule also accepted anything bright
       regardless of chroma, which is how a picker ends up offering to turn a
       yellow price tag cyan -- not what "white and grey" means. */
    return lum(c) >= LIGHT_MIN && inkIsNeutral(hex);
  }
  /* GLARE, NOT ONLY GREY (1.0.31, 2026-11-16). Mike: "*the item prices are still
     a little bright, color is fine*". The cart's prices render #2cfce3 -- vivid
     teal, L 0.76, weight 700 -- and the neutrality rule skips saturated ink BY
     DESIGN, so the single loudest thing on the page was the one thing the sweep
     refused to touch. Same reasoning as grey, applied to chroma: ink that
     carries real colour AND clears the dim accent by this much is glare, and
     gets the same ink. Badges at L 0.43-0.44 ("Sale -9% now", "Free shipping")
     fall in with it; genuinely dark accents (< 0.30) keep their hue. */
  const VIVID_CAP = 0.30;
  function inkIsGlare(hex) {
    const c = parseRGB(hex);
    if (!c) return false;
    return lum(c) >= VIVID_CAP && saturation(hex) > NEUTRAL_SAT;
  }
  /** Does this ink need the accent? Grey, or louder than the accent itself. */
  function inkNeedsAccent(hex) { return inkIsLight(hex) || inkIsGlare(hex); }

  /* ══════════════ THE BRIGHTNESS CEILING (1.0.32) ══════════════════════════
     Mike: "*changing the color to anything specific isn't the objective; the goal
     is taming brightness -- dark theme and tolerably bright colors*". So the
     target is a CEILING, not a palette: anything painted brighter than the
     ceiling gets dimmed IN PLACE, hue preserved, instead of being repainted with
     one chosen colour.

     Measured on the AliExpress cart before this existed: the Checkout button's
     fill renders #2cfce3 at L 0.76 -- on a page whose own background is L 0.005,
     a single 332x44 rectangle that bright is the brightest thing in view. Ink was
     already handled; surfaces were not.

     Two pieces matter:
       dimToLum()  -- binary-search a scale factor that lands the colour on the
                      ceiling, so the hue survives (dimming toward grey or toward
                      a fixed accent is what we were doing before, and it throws
                      away the site's own colour language).
       labels      -- black text on a bright fill becomes black-on-dark once the
                      fill is dimmed, i.e. invisible. Any label whose contrast
                      against the NEW fill drops under 4.5:1 is lifted to a light
                      ink, written with the right invert parity. */
  const SURFACE_CAP = 0.30;          // rendered-luminance ceiling for painted fills
  /* CHROMATIC FILLS GET A LOWER CEILING (2026-11-16). Mike, after the first
     cap: "*I'd further darken the background of the checkout button and the
     11.11 Sale*". Both are saturated fills, and saturation is what makes a fill
     read as loud at the same luminance -- a mid-teal button shouts where a grey
     of identical L is quiet. So the ceiling is tiered on chroma rather than
     lowered globally, which keeps neutral cards and page surfaces where they
     are: #1da796 (L 0.30) is the checkout at the old cap, and it goes to 0.16. */
  const SURFACE_CAP_VIVID = 0.16;
  const VIVID_SURFACE_SAT = 0.35;
  const SURFACE_MIN_AREA = 400;
  const PHOTO_OVERLAY = 0.18;        // 1.0.35: uniform trim for url() photo panels      // px^2: lowered in 1.0.34 -- sale badges are ~600px^2 and glare like anything else
  /* Wide, shallow image panels are promotional strips, not product shots: the red
     11.11 field is one AVIF. Decoration can take a heavy trim without losing
     meaning, and a promo banner is exactly the thing that glares. (2026-11-16) */
  const PHOTO_OVERLAY_PROMO = 0.55;
  const SURFACE_ATTR = 'data-dm-cap';
  const SURFACE_CAPT_ATTR = 'data-dm-capt';   // the seen fill we capped to, for re-labelling
  const CAP_LABEL_INK = [207, 216, 220];
  /* A BRIGHTER CANDIDATE IS NEEDED (2026-11-16). Dimming a fill to L 0.16 drops
     BLACK ink to ~4.2:1 and the pale grey above to ~3.4:1 -- a dead zone where
     neither offered ink clears AA, so the label pass correctly concluded it had
     nothing better and left black text on a dark teal button at 4.22:1 (measured
     on the order page's "Confirm received"). Pure white scores 4.98 on the same
     fill; this candidate keeps a little of the glare reduction while clearing
     4.5. Candidates are ordered dim-to-bright and the first that PASSES is taken,
     so a fill that can carry black ink still gets black ink. */
  const CAP_LABEL_INK_BRIGHT = [244, 247, 250];
  const LABEL_INKS_BASE = [[0, 0, 0], CAP_LABEL_INK, CAP_LABEL_INK_BRIGHT];
  /* THE PALETTE IS A LABEL INK TOO (1.1.0). These writes are inline !important,
     so they beat the accent stylesheet and a capped surface's label stayed
     PALE — measured on w3.org: 10 of 149 accented elements rendered white for
     exactly this reason. Offering the palette ink as a candidate lets the
     contrast score decide, and the score is the only thing allowed to outrank
     the palette. Black stays first: on a light fill it is still the best label. */
  function labelInks() {
    if (!accentOn) return LABEL_INKS_BASE;
    const c = parseRGB(paletteInk());
    return c ? [[0, 0, 0], [c[0], c[1], c[2]], CAP_LABEL_INK, CAP_LABEL_INK_BRIGHT] : LABEL_INKS_BASE;
  }

  function dimToLum(c, capL) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      const l = lum([c[0] * mid, c[1] * mid, c[2] * mid]);
      if (l > capL) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }
  /* SOLVING THE OVERLAY (2026-11-16). Two independent mistakes lived here, and
     together they are why a "Confirm received" button on the order page rendered
     as a light-cyan slab with pale text (measured fill #bae2f9, L 0.714) even
     though the cap was demonstrably running on it.

     1. POLARITY. The overlay was always BLACK. The page is inverted by
        html{filter:invert(1)}, so darkening the raw fill darkens it BEFORE the
        inversion, and the inversion flips it straight back to light. The button's
        orange gradient rgb(255,100,14)->rgb(255,48,0) is what you SEE as cyan;
        painting black over the orange yields... cyan again, slightly paler. Under
        an inverted ancestor the overlay must be WHITE, so that raw gets lighter
        and the inversion renders it darker.
     2. ARITHMETIC. `a = 1 - cap/Lmax` treats alpha blending as linear in
        luminance. It is linear in sRGB-encoded VALUES, and luminance is a power
        curve on top of those, so the result overshoots badly -- it was driving
        fills far below the ceiling or, with (1), above it.

     So: blend in RAW space, invert, MEASURE luminance, and binary-search the
     alpha. Same approach as dimToLum, but through the real compositing path. */
  function solveOverlay(rawStops, capL, par) {
    const OL = par ? 255 : 0;
    const seenAt = function (a) {
      let worst = 0;
      for (let i = 0; i < rawStops.length; i++) {
        const c = rawStops[i];
        const comp = [
          c[0] * (1 - a) + OL * a,
          c[1] * (1 - a) + OL * a,
          c[2] * (1 - a) + OL * a,
        ];
        const seen = par ? [255 - comp[0], 255 - comp[1], 255 - comp[2]] : comp;
        worst = Math.max(worst, lum(seen));
      }
      return worst;
    };
    if (seenAt(0) <= capL) return 0;
    let lo = 0, hi = 0.98;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      if (seenAt(mid) > capL) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  function rgbToHexCss(c) {
    const h = function (v) { return Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0'); };
    return '#' + h(c[0]) + h(c[1]) + h(c[2]);
  }
  function rgbCss(c) { return 'rgb(' + c.map(function (v) { return Math.round(Math.max(0, Math.min(255, v))); }).join(',') + ')'; }
  function contrastOf(a, b) {
    const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** Dim one element's own fill if it is brighter than the ceiling. */
  function capSurface(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.id === ROOT_ID || el === document.documentElement || el === document.body) return false;
    let cs, bg, rect, bi;
    try {
      cs = getComputedStyle(el); bg = parseRGB(cs.backgroundColor);
      bi = cs.backgroundImage || ''; rect = el.getBoundingClientRect();
    } catch (e) { return false; }
    if (rect.width * rect.height < SURFACE_MIN_AREA) return false;
    /* A DARK ISLAND NEEDS NOTHING FROM THIS PASS (1.2.0). Its filter is already
       cancelled by content.js, so the fills and ink inside it are the site's own
       and correct; capping or relabelling them here is what produced the
       low-contrast footer in the first place. */
    try { if (el.closest('[data-dm-island="1"]')) return false; } catch (e) {}
    const par = invertDepth(el) % 2;
    const asShown = function (c) { return par ? [255 - c[0], 255 - c[1], 255 - c[2]] : [c[0], c[1], c[2]]; };

    /* A FLAT FILL BEHIND AN OPAQUE IMAGE IS NOT THE PLATE (1.2.0). When a
       background-image covers the box, background-color is invisible: capping it
       dims nothing, and the label pass then scores ink against a colour no pixel
       shows. Treat the element as an image panel instead — content.js publishes
       the measured coverage so this is a read, not a guess. */
    const bgMean = el.getAttribute('data-cr-bgmean');
    const bgCov = Number(el.getAttribute('data-cr-bgcov'));
    const imagePlate = bgMean !== null && bgMean !== '' && isFinite(bgCov) && bgCov >= 0.9;
    const flat = (!imagePlate && bg && bg[3] > 0.5) ? asShown(bg) : null;
    /* GRADIENTS ARE PAINTS TOO (1.0.34). The cap only understood
       background-color, so a surface whose colour arrives as a
       linear-gradient(...) was invisible to it -- which is how a bright red sale
       strip survives a cap that is demonstrably working on the button beside it.
       Read the colour stops out of the gradient and dim the whole layer with an
       inset overlay, which keeps the gradient instead of flattening it. */
    const stops = [];
    /* rawStops keeps the UN-inverted stops: solveOverlay() has to composite in
       raw space (the overlay is painted before the ancestor inversion flips it),
       while `stops` stays in seen space for choosing the ceiling tier. */
    const rawStops = [];
    if (/gradient\(/i.test(bi)) {
      const re = /rgba?\(([^)]+)\)/g; let m;
      while ((m = re.exec(bi))) {
        const c = parseRGB('rgb(' + m[1] + ')');
        if (c && c[3] > 0.05) { rawStops.push([c[0], c[1], c[2]]); stops.push(asShown(c)); }
      }
    }
    /* PHOTO BACKDROPS AS background-image (1.0.35). AliExpress cart thumbnails
       are not <img> elements -- they are background-image url(...) panels, so the
       img filter in dimPhotos() reached exactly one of them. An image URL has no
       colour stops to read, so brightness cannot be computed: apply a fixed
       overlay instead. That is what "dim the white background in product images"
       means in practice -- the sweep behind the product is what glares, and a
       uniform trim costs nothing but a little punch. */
    const isUrlImage = /url\(/i.test(bi);
    if (!flat && !stops.length && !isUrlImage) return false;

    let Lmax = flat ? lum(flat) : 0;
    for (let i = 0; i < stops.length; i++) Lmax = Math.max(Lmax, lum(stops[i]));
    /* An image URL has no colour stops, so Lmax is 0 for a photo panel -- the
       gate below then returned false and the photo branch was unreachable
       (measured: 75 background-image panels on the cart, 0 capped). Only a
       MEASURED bright fill may be skipped for being dim enough. */
    const blind = isUrlImage && !flat && !stops.length;
    if (Lmax <= 0.02 && !blind) return false;

    /* rep must never be undefined: a blind photo panel has neither a flat colour
       nor gradient stops, and rgbToHexCss(undefined) threw INSIDE the sweep --
       which aborted the whole cap pass, taking image dimming down with it
       (measured: caps 0, images dimmed 0 after the 1.0.37 change). Carry a
       neutral stand-in; the blind branch does not use rep for anything that
       matters. */
    const rep = flat || stops[0] || [128, 128, 128];
    const cap = saturation(rgbToHexCss(rep)) > VIVID_SURFACE_SAT ? SURFACE_CAP_VIVID : SURFACE_CAP;
    if (!blind && Lmax <= cap) return false;

    let target;
    /* PRECEDENCE: gradient, then flat, then photo. A small square icon button
       carries BOTH a white background-color and a background-image url; testing
       the url first sent it down the photo path, where the only tool is an 18%
       overlay -- so #e6e6e6 came out at L 0.65 and still glared. A flat opaque
       fill can be dimmed precisely, so it gets first refusal after gradients. */
    if (stops.length) {
      const a = solveOverlay(rawStops, cap, par);
      if (a <= 0.002) return false;            // already at or under the ceiling
      const OL = par ? 255 : 0;                // white overlay inverts to a dark fill
      try {
        rememberBase(el, 'box-shadow', CAP_SH_BASE);
        el.style.setProperty('box-shadow', 'inset 0 0 0 9999px rgba(' + OL + ',' + OL + ',' + OL + ',' + a.toFixed(3) + ')', 'important');
      }
      catch (e) { return false; }
      const ref = stops.reduce(function (p, c) { return lum(c) > lum(p) ? c : p; }, stops[0]);
      /* seen = seenOrig * (1 - a) for a white overlay under an inversion, which is
         exactly how the alpha was solved, so this is the fill the label must be
         scored against. */
      target = ref.map(function (v) { return v * (1 - a); });
    } else if (flat) {
      const k = dimToLum(flat, cap);
      target = flat.map(function (v) { return v * k; });
      const write = par ? target.map(function (v) { return 255 - v; }) : target;
      try {
        rememberBase(el, 'background-color', CAP_BG_BASE);
        el.style.setProperty('background-color', rgbCss(write), 'important');
      } catch (e) { return false; }
    } else {
      /* PROMO STRIPS ARE IMAGE PANELS (2026-11-16). The red "11.11 Sale" strip is
         not a painted fill at all: it is span.group-top-notice-container with
         background-image: url(...avif) -- the red field AND the wordmark are one
         graphic. It fell into this branch, which painted BLACK at 0.18. Under the
         page's invert(1) that makes an image LIGHTER, not darker: for a red pixel
         seen = 255 - 0.82*raw, so a saturated red stays a bright cyan. Same
         polarity bug as the gradient branch, same fix -- white overlay when the
         context is inverted.

         The alpha also has to be strong enough to matter. A white overlay of alpha
         a multiplies the SEEN colour by (1-a) exactly, so 0.18 could never pull a
         loud banner down. Product thumbnails want a gentle trim (they are photos,
         and washing them out hides the product); a wide, shallow banner is
         decoration, so it gets the heavy one. Aspect ratio separates the two
         without guessing at class names. */
      const aspect = rect.height > 0 ? rect.width / rect.height : 0;
      const promo = aspect >= 4 && rect.width * rect.height >= 15000;
      const a = promo ? PHOTO_OVERLAY_PROMO : PHOTO_OVERLAY;
      const OL = par ? 255 : 0;
      try {
        rememberBase(el, 'box-shadow', CAP_SH_BASE);
        el.style.setProperty('box-shadow', 'inset 0 0 0 9999px rgba(' + OL + ',' + OL + ',' + OL + ',' + a + ')', 'important');
      }
      catch (e) { return false; }
      /* A blind image panel has no colour we can read, so the reference for label
         scoring is the BRIGHTEST the panel can be after the trim: every channel is
         multiplied by (1-a) by the overlay, whether the overlay is white under
         inversion or black without it. Using that worst case means the label is
         scored against the lightest fill it could actually sit on. */
      const ceil = Math.round(255 * (1 - a));
      target = [ceil, ceil, ceil];
    }
    el.setAttribute(SURFACE_ATTR, '1');
    /* remember the fill we landed on, so the label pass can be re-run later */
    el.setAttribute(SURFACE_CAPT_ATTR, Math.round(target[0]) + ',' + Math.round(target[1]) + ',' + Math.round(target[2]));
    applyLabelFix(el, target);
    return true;
  }

  /* ITS OWN LABELS, RE-ENTRANTLY (2026-11-16). This used to run once, inline,
     at the moment the fill was capped -- and that is exactly why the order page's
     "Confirm received" button stayed unreadable. AliExpress hydrates the button's
     text into a child <span> AFTER the button has been capped and marked, so the
     label was not there to score; the surface then carries SURFACE_ATTR and every
     later pass skips it. Measured after the fill fix: button fill capped to a dark
     blue, span still raw #ffffff (parity 1 => black on screen) at 3.2:1.

     So the label decision is a separate, idempotent function keyed off the fill we
     recorded, called at cap time AND on every later sweep. Writing the winner back
     makes the next call a no-op (contrast is then >= 4.5), so repeated sweeps cost
     two getComputedStyle reads per label and nothing else. */
  function applyLabelFix(el, seenFill) {
    if (!el || !seenFill) return 0;
    /* A DARK ISLAND IS ALREADY NATIVE (1.2.0). content.js cancels the page
       filter for a natively-dark plate, so the ink inside it is the ink the site
       chose and needs no correction — writing one would be a second guess on top
       of a pair that already works. */
    try { if (el.closest('[data-dm-island="1"]')) return 0; } catch (e) {}
    /* AN IMAGE PLATE IS NOT A COLOUR (1.2.0). `seenFill` is the background-COLOR
       we capped; when an opaque background-image covers the box that colour is
       not on screen at all. Scoring ink against it is exactly how the
       newtonpaisley footer got near-BLACK ink — which the page invert renders
       near-WHITE — on an inverted (hence LIGHT) fabric plate: measured 1.31:1,
       against the site's own 3.85:1. The invert flips ink and plate TOGETHER, so
       an authored pair keeps its contrast; where the plate cannot be measured,
       the only safe edit is none. content.js publishes the measurement. */
    const gm = el.getAttribute('data-cr-bgmean');
    const gc = Number(el.getAttribute('data-cr-bgcov'));
    if (gm !== null && gm !== '' && isFinite(gc) && gc >= 0.9) return 0;
    let written = 0;
    const kids = el.querySelectorAll('*');
    for (let i = 0; i < kids.length && i < 60; i++) {
      const t = kids[i];
      if (!ownsText(t)) continue;
      let tcs, tc;
      try { tcs = getComputedStyle(t); tc = parseRGB(tcs.webkitTextFillColor || tcs.color); } catch (e) { continue; }
      if (!tc || tc[3] < 0.05) continue;
      const tp = invertDepth(t) % 2;
      const inkShown = tp ? [255 - tc[0], 255 - tc[1], 255 - tc[2]] : [tc[0], tc[1], tc[2]];
      const cur = contrastOf(inkShown, seenFill);
      if (cur >= 4.5) continue;
      /* WHICH ink, not just "lighter". The first version always lifted the label
         to a light ink when contrast fell under 4.5 -- which is wrong as soon as
         the fill is dimmed hard: on a target of L 0.16 black scores 4.2:1 and the
         pale ink scores 3.4:1, so "fixing" it would have made the label WORSE.
         Score both candidates and take the winner; if neither beats what is
         already there, leave it alone. */
      const cDark = contrastOf([0, 0, 0], seenFill);
      const cLight = contrastOf(CAP_LABEL_INK, seenFill);
      /* first (dimmest) candidate that CLEARS 4.5 wins; otherwise the best score
         available. Scoring only black-vs-pale left a dead zone around L 0.16-0.30
         where neither passes and the label stayed unreadable. */
      let bestInk = null, bestC = -1;
      const inks = labelInks();
      for (let k = 0; k < inks.length; k++) {
        const cc = contrastOf(inks[k], seenFill);
        if (cc >= 4.5) { bestInk = inks[k]; bestC = cc; break; }
        if (cc > bestC) { bestC = cc; bestInk = inks[k]; }
      }
      if (!bestInk) continue;
      if (Math.max(cDark, cLight) <= cur + 0.01 && bestC <= cur + 0.01) continue;
      const want = tp ? [255 - bestInk[0], 255 - bestInk[1], 255 - bestInk[2]] : bestInk;
      try {
        rememberBase(t, 'color', LABEL_BASE_COLOR);
        rememberBase(t, '-webkit-text-fill-color', LABEL_BASE_FILL);
        rememberBase(t, 'fill', LABEL_BASE_SVG);
        t.style.setProperty('color', rgbCss(want), 'important');
        t.style.setProperty('-webkit-text-fill-color', rgbCss(want), 'important');
        t.style.setProperty('fill', rgbCss(want), 'important');
        t.setAttribute(LABEL_ATTR, '1');
        written++;
      } catch (e) {}
    }
    return written;
  }

  /** Re-check the labels of every surface already capped (late-hydrated text). */
  function relabelCappedSurfaces() {
    let marked;
    try { marked = document.querySelectorAll('[' + SURFACE_ATTR + ']'); } catch (e) { return 0; }
    let n = 0;
    for (let i = 0; i < marked.length && i < 500; i++) {
      const raw = marked[i].getAttribute(SURFACE_CAPT_ATTR);
      if (!raw) continue;
      const p = raw.split(',');
      if (p.length !== 3) continue;
      const fill = [Number(p[0]), Number(p[1]), Number(p[2])];
      if (fill.some(function (v) { return !isFinite(v); })) continue;
      try { n += applyLabelFix(marked[i], fill); } catch (e) {}
    }
    return n;
  }

  /* PHOTO BACKDROPS (1.0.34). Mike: "*maybe also dim the white background in
     product images*". A product shot on a white sweep is a 2,500px+ panel of
     L 1.0 on a page whose own background is L 0.005 -- the last genuinely
     glaring thing once the fills are capped. The photo must keep its colours, so
     this appends a uniform brightness trim to whatever filter the restore pass
     already applied (the counter-invert), never a hue change. */
  const IMG_DIM = 0.82;
  const IMG_MIN_AREA = 2500;
  const IMG_ATTR = 'data-dm-imgdim';
  function dimPhotos(scope) {
    const start = scope || document.body;
    if (!start || start.nodeType !== 1) return 0;
    const imgs = start.querySelectorAll('img');
    let n = 0;
    for (let i = 0; i < imgs.length && i < 400; i++) {
      const img = imgs[i];
      if (img.getAttribute(IMG_ATTR)) continue;
      const r = img.getBoundingClientRect();
      if (r.width * r.height < IMG_MIN_AREA) continue;
      let f = 'none';
      try { f = getComputedStyle(img).filter || 'none'; } catch (e) { continue; }
      const next = (f === 'none' ? '' : f + ' ') + 'brightness(' + IMG_DIM + ')';
      try {
        rememberBase(img, 'filter', IMG_BASE);
        img.style.setProperty('filter', next, 'important');
        img.setAttribute(IMG_ATTR, '1');
        n++;
      } catch (e) {}
    }
    return n;
  }

  /** Sweep fills for brightness. Bounded like the tone sweep. */
  function capSurfaces(scope) {
    const start = scope || document.body;
    if (!start || start.nodeType !== 1) return 0;
    const all = [start].concat(Array.prototype.slice.call(start.querySelectorAll('*'), 0, 6000));
    let n = 0;
    /* ONE BAD ELEMENT MUST NOT KILL THE PASS. capSurface touches live computed
       styles and inline style writes on arbitrary third-party markup; a single
       throw used to abort every remaining element silently. */
    for (let i = 0; i < all.length; i++) {
      try { if (capSurface(all[i])) n++; } catch (e) {}
    }
    n += dimPhotos(start);
    /* late-hydrated labels: button text frequently arrives AFTER its fill was
       capped, so re-score them on every sweep (idempotent, see applyLabelFix) */
    try { n += relabelCappedSurfaces(); } catch (e) {}
    return n;
  }
  function isGradientText(el) {
    const cs = getComputedStyle(el);
    const clip = cs.webkitBackgroundClip || cs.backgroundClip || '';
    const fill = parseRGB(cs.webkitTextFillColor || cs.color);
    return clip.indexOf('text') >= 0 && !!fill && fill[3] < 0.05;
  }


  /* ═══════════════════ matching by COLOUR instead of by class ═════════════

     Measured on quantamagazine (2026-11-11): the article's paragraphs are bare
     <p> elements with NO class at all, so the picker only offered "this element
     only" and a hand-typed selector — one of 186 text elements could be
     recoloured, and 185 stayed white. Nothing selector-shaped could fix that:
     the page expresses body text as ~140 elements spread over span/p/h2/a/em/
     strong/h3 with one thing in common, which is the colour they render.

     So a second rule kind exists — a TONE rule, no selector:

         {id:'r3', match:'color', from:'#e5e5e5', color:'#00ffff', bg:''}

     `from` is the colour the EYE sees (rendered space, same convention as
     `color`). sweepTone() walks the text-owning elements, compares each
     element's baseline rendered colour, and tags matches with

         data-dm-tone="r3o"   (odd invert depth -> cssText writes complement)
         data-dm-tone="r3e"   (even depth, i.e. inside a restored photo)

     Tagging, not inline styles: the attribute is undone by removing it, it
     survives a rule colour change, and it costs one stylesheet rule for every
     element that matches. */
  function uid() { return 'r' + (++seq) + Math.floor(Math.random() * 1296).toString(36); }

  function sameHex(a, b) {
    const x = parseRGB(a), y = parseRGB(b);
    if (!x || !y) return false;
    if (x[3] < 0.999 || y[3] < 0.999) return false;   // translucent: not comparable
    return x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
  }

  /** Rendered (eye) colour of an element as #rrggbb, or '' if not measurable. */
  function rendersOf(el) {
    if (!el || el.nodeType !== 1) return '';
    const tagged = el.hasAttribute(TONE_ATTR);
    const cached = toneBase.get(el);
    let cs;
    try { cs = getComputedStyle(el); } catch (e) { return tagged && cached ? cached.c : ''; }
    /* The visible ink is `-webkit-text-fill-color` when the site sets it — 26
       elements on the Quanta article paint #1a1a1a that way, and writing only
       `color` left them unchanged. A TRANSPARENT fill is a background-clip
       gradient (text over a painterly background); repainting those would
       destroy the effect, so they are not measurable and are skipped.

       SVG text is the exception: it paints with `fill`, so reading `color`
       there measures an inherited HTML value that has nothing to do with the
       pixels. Reading `fill` is what lets a gauge's dial labels into a rule. */
    /* A form control paints with `color`; its -webkit-text-fill-color is a UA
       default that can disagree with what the field actually shows. */
    let ink = FORM_TEXT_TAGS.test(el.tagName)
      ? cs.color
      : (cs.webkitTextFillColor || cs.color);
    if (isSvgText(el) && cs.fill && cs.fill !== 'none' && !/^currentcolor$/i.test(cs.fill)) ink = cs.fill;
    const rgb = parseRGB(ink);
    if (!rgb) return tagged && cached ? cached.c : '';
    /* ALPHA INK IS NOT UNMEASURABLE (1.0.27). This used to reject anything with
       alpha < 0.999, which silently excluded a whole class of real text: sites
       write rgba(0,0,0,0.9) for body copy, navigation labels and form text all
       the time. Measured on AliExpress search: 75 of 328 visible white-on-screen
       elements were rgba ink, so "everything light" reached 253 and the panel
       still reported "covers 282 of 282" — a complete-looking number over an
       incomplete job. Composite the ink over its backdrop instead, which is what
       the screen does. Below 0.05 stays unmeasurable: that is background-clip
       gradient text, where repainting destroys the effect. */
    let base = [rgb[0], rgb[1], rgb[2]];
    if (rgb[3] < 0.999) {
      if (rgb[3] < 0.05) return tagged && cached ? cached.c : '';
      const back = backdropOf(el);
      const a = rgb[3];
      base = [Math.round(rgb[0] * a + back[0] * (1 - a)),
              Math.round(rgb[1] * a + back[1] * (1 - a)),
              Math.round(rgb[2] * a + back[2] * (1 - a))];
    }
    /* CACHE RULES, and getting them wrong is what made a saved rule half-apply
       on reload. While an element carries OUR attribute its live colour is our
       paint, so the baseline is the only truth. While it does not, the live
       colour is the PAGE's — measure it, even if a baseline exists: the first
       sweeps run during parsing, before the site's own stylesheet has been
       applied, so an early baseline is often the browser default and would
       otherwise stick forever (measured: 87 of 200 elements tagged). */
    if (tagged && cached) return cached.c;
    const parity = invertDepth(el) % 2;
    const shown = parity === 1
      ? [255 - base[0], 255 - base[1], 255 - base[2]]
      : [base[0], base[1], base[2]];
    const h = (n) => n.toString(16).padStart(2, '0');
    const hex = '#' + h(shown[0]) + h(shown[1]) + h(shown[2]);
    // Only remember colours that are the PAGE's, never the ones we painted.
    if (!tagged) toneBase.set(el, { c: hex, p: parity });
    return hex;
  }

  /* Elements that own text but never PAINT it. A <script> holds its source as a
     text node, so without this filter the sweep tags every analytics blob on the
     page and the panel's "208 elements" is inflated by 12 widgets the user can
     never see. Measured on quantamagazine: 193 real + 12 script + 1 audio. The
     `i` flag matters: SVG's <title> — 28 of them on that page, one per icon —
     reports a LOWERCASE tagName, while HTML's reports uppercase. */
  const NON_TEXT_TAGS = /^(script|style|noscript|template|title|meta|link|base|head|path|defs)$/i;

  /* FORM CONTROLS OWN TEXT TOO (1.0.27). This test used to accept only an
     element with a direct child text node, so <input>, <textarea> and <select>
     were invisible to the whole tuning system: not counted in coverage, never
     tagged, never recoloured. Measured on AliExpress search: 46 of 268 visible
     white-on-screen text elements were form controls (the search box and every
     quantity field), and the panel still said "covers 253 of 253". A control's
     visible text is not a text node — it is painted by the widget. */
  const FORM_TEXT_TAGS = /^(INPUT|TEXTAREA|SELECT)$/;
  function ownsText(el) {
    if (NON_TEXT_TAGS.test(el.tagName)) return false;
    if (FORM_TEXT_TAGS.test(el.tagName)) return true;
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
    }
    return false;
  }

  /* THE MASTER PALETTE, AS A RULE (1.1.0). Emitted FIRST so that "last rule
     wins" in sweepTone gives it the LOWEST precedence — a site palette is just a
     different colour for this same rule, while a rule the user saved on purpose
     must always beat it. */
  function defaultRule() {
    if (!accentOn) return null;
    return {
      id: DEF_RULE_ID, match: 'light', from: '', color: paletteInk(),
      bg: '', min: LIGHT_MIN, def: true
    };
  }

  /* White ink on a LIGHT OR SATURATED PLATE was chosen for contrast: tinting it
     yields cyan-on-blue and destroys the control. The per-host rules never
     needed this guard (the user was looking at the element when they made one);
     a master palette applied to every site does, so `def` rules check it.
     The plate is judged the way the screen composites it — first opaque ancestor
     background, complemented for this element's invert parity — and "loud" means
     rendered luminance above 0.18. No opaque ancestor at all means the page
     canvas, which under the invert engine is BLACK, so it is not loud. */
  function plateLoud(el) {
    let node = el;
    const parity = invertDepth(el) % 2;
    while (node && node.nodeType === 1) {
      const bg = parseRGB(getComputedStyle(node).backgroundColor);
      if (bg && bg[3] > 0.5) {
        const shown = parity === 1 ? [255 - bg[0], 255 - bg[1], 255 - bg[2]] : [bg[0], bg[1], bg[2]];
        return lum(shown) > 0.18;
      }
      node = node.parentElement;
    }
    return false;
  }

  function toneRules() {
    const def = defaultRule();
    return (def ? [def] : []).concat(globalRules).concat(perHost).concat(pending ? [pending] : [])
      .filter((r) => r && r.id && (r.match === 'light' || (r.match === 'color' && r.from)));
  }

  function clearStaleTones(live) {
    const marked = document.querySelectorAll('[' + TONE_ATTR + ']');
    for (let i = 0; i < marked.length; i++) {
      const v = marked[i].getAttribute(TONE_ATTR) || '';
      if (!live.has(v.slice(0, -1))) marked[i].removeAttribute(TONE_ATTR);
    }
  }

  /** Tag every text-owning element under `scope` whose baseline colour matches. */
  function sweepTone(scope) {
    /* NOTHING TO PAINT ON A PAGE WE DID NOT DARKEN (1.1.0). The emitted rules
       are gated on the engine class, so on a light page this would only litter
       the DOM with attributes that match no rule — measured on afuncan.com
       (natively dark, auto-dark correctly backs out): 20 tagged elements, 0
       painted. */
    const de = document.documentElement;
    if (de && !de.classList.contains('cr-dark') && !de.classList.contains('cr-frame-dark')) {
      if (!scope) clearStaleTones(new Set());
      return 0;
    }
    const rules = toneRules();
    if (!rules.length) {
      if (!scope) clearStaleTones(new Set());
      return 0;
    }
    const live = new Set(rules.map((r) => r.id));
    if (!scope) clearStaleTones(live);

    const start = scope || document.body || document.documentElement;
    if (!start || start.nodeType !== 1) return 0;
    const all = [start].concat(Array.prototype.slice.call(start.querySelectorAll('*'), 0, 8000));

    /* TWO PASSES — decide, then write. Tagging a parent repaints its children
       through inheritance, so a single measure+tag loop compares the CHILDREN
       against the colour we have just painted on the PARENT and silently skips
       them. Measured on the ambientweather dashboard: two <sup> unit markers
       fell out of a 102-element group for exactly this reason (the sweep walks
       in document order, so the parent was always tagged first). */
    const plan = [];
    let tagged = 0;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el.id === ROOT_ID || !ownsText(el)) continue;
      /* A dark-island plate is native (1.2.0): its ink is the site's own choice
         for its own plate, so the accent must not touch it. */
      try { if (el.closest('[data-dm-island="1"]')) continue; } catch (e) {}
      const base = rendersOf(el);
      if (!base) continue;
      /* Last rule wins, like the CSS cascade: rules are appended in the order
         the user made them, so a later "everything light" has to beat an
         earlier "all text #cecdc9" — otherwise the wider rule looks broken on
         exactly the elements the narrow one already claimed (measured while
         building this test: the light rule painted nothing until precedence
         flipped). */
      let hit = null;
      for (let j = rules.length - 1; j >= 0; j--) {
        const r = rules[j];
        if (!(r.match === 'color' ? sameHex(r.from, base) : inkNeedsAccent(base))) continue;
        /* The master palette is applied to sites nobody inspected, so it carries
           a guard the user's own rules never needed: ink sitting on a bright or
           saturated plate keeps its colour (cyan-on-blue kills a button). */
        if (r.def && plateLoud(el)) continue;
        hit = r; break;
      }
      if (hit) tagged++;
      plan.push([el, hit ? hit.id + (invertDepth(el) % 2 === 1 ? 'o' : 'e') : '']);
    }
    for (let i = 0; i < plan.length; i++) {
      const el = plan[i][0], want = plan[i][1];
      const has = el.getAttribute(TONE_ATTR);
      if (want) { if (has !== want) el.setAttribute(TONE_ATTR, want); }
      else if (has) el.removeAttribute(TONE_ATTR);
    }
    return tagged;
  }

  /* Pages fill in AFTER document_start and single-page sites swap whole
     sections. Watch for NEW nodes only (not attributes — we write one, which
     would loop).

     THE BUG THIS REPLACED (1.0.18, reported by Mike as "saved the colour, reloaded,
     nothing came back"): the callback did `clearTimeout(moTimer)` on every batch
     and waited 250 ms for quiet before sweeping. A busy page never goes quiet —
     quantamagazine kept mutating past the 3 s mark — so the timer was reset
     forever and the first sweep never ran. Measured on a real cold load: 0
     elements tagged, and a manual sweep the same instant tagged 193. Never
     reset a timer that is doing work; coalesce without dropping. */
  function ensureObserve() {
    if (mo || !window.MutationObserver || !document.documentElement) return;
    mo = new MutationObserver((recs) => {
      if (!toneRules().length) return;
      for (let i = 0; i < recs.length; i++) {
        const added = recs[i].addedNodes;
        for (let j = 0; j < added.length; j++) {
          if (added[j].nodeType === 1 && added[j].id !== ROOT_ID) pendingRoots.push(added[j]);
        }
      }
      scheduleSweep();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    // Belt and braces: the parser's own insertions arrive as mutations, but a
    // document-lifecycle sweep cannot be starved by anything.
    ['DOMContentLoaded', 'load'].forEach((ev) => {
      document.addEventListener(ev, () => sweepTone(), true);
    });
  }

  function scheduleSweep() {
    if (moTimer) return;                 // one pending sweep, never postponed
    moTimer = setTimeout(() => {
      moTimer = null;
      const roots = pendingRoots;
      pendingRoots = [];
      for (let i = 0; i < roots.length; i++) sweepTone(roots[i]);
      if (fillsAllowed() && engineOn()) capSurfaces();   // late-rendered fills (the Checkout button renders late)
    }, 120);
  }

  /* Is this element text the user can actually SEE? The count of a colour is
     only meaningful over visible text: measured on the ambientweather
     dashboard, `#f65719` "had" 167 elements and was therefore declared
     dominant — but 155 of them were off-screen, display:none, or a 0×0
     slide-out, and a dozen orange numbers were all that showed. Correcting
     that is what makes "dominant" mean "the colour most of the page's text is
     showing you". */
  function visibleText(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return parseFloat(cs.opacity) > 0.05;
  }

  /** Rendered colour -> how many text elements show it (the "dominant" one wins). */
  function colourGroups() {
    const map = new Map();
    const body = document.body;
    if (!body) return map;
    const all = Array.prototype.slice.call(body.querySelectorAll('*'), 0, 8000);
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!ownsText(el) || !visibleText(el)) continue;
      const c = rendersOf(el);
      if (!c) continue;
      const g = map.get(c) || { n: 0, chars: 0, tags: {} };
      g.n++;
      g.chars += (el.textContent || '').trim().length;
      const t = el.tagName.toLowerCase();
      g.tags[t] = (g.tags[t] || 0) + 1;
      map.set(c, g);
    }
    return map;
  }

  function sortedGroups() {
    return [...lastGroups.entries()].sort((a, b) => (b[1].n - a[1].n));
  }

  function dominantColour() {
    const s = sortedGroups();
    return s.length ? s[0][0] : '';
  }

  /* COVERAGE — the number the panel was missing. It used to report what one
     scope reached and said nothing about what it left behind, which is exactly
     how "a bunch of numeric text switched … lots of non-numeric text stayed
     white" happened without the UI ever looking wrong. Counting is cheap
     (one pass over visible text owners) and it turns "reach more classes" into
     a fact the user can see: 56 of 129 covered, 73 still light. */
  function coverage() {
    const all = Array.prototype.slice.call(
      document.body ? document.body.querySelectorAll('*') : [], 0, 8000);
    let total = 0, done = 0, gradient = 0, svg = 0;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!ownsText(el) || !visibleText(el)) continue;
      const base = rendersOf(el);
      if (!base) {
        // Unmeasurable ink: gradient (background-clip:text) text, or a hit area
        // over an icon image. Counted so the panel can admit to leaving it.
        if (isGradientText(el)) gradient++;
        continue;
      }
      if (!inkNeedsAccent(base)) continue;
      /* Elements the MASTER palette deliberately declines — ink on a bright or
         saturated plate — must not be counted as "still light", or the panel
         nags about work it decided not to do (measured on python.org: 18 such
         labels, all on the yellow Donate button and the light-blue nav). A user
         rule that DID tag such an element still counts, because that was asked
         for explicitly. */
      if (accentOn && !el.hasAttribute(TONE_ATTR) && plateLoud(el)) continue;
      total++;
      if (el.hasAttribute(TONE_ATTR)) { done++; if (isSvgText(el)) svg++; }
    }
    return { total: total, done: done, left: total - done, gradient: gradient, svg: svg };
  }

  function renderCoverage() {
    if (!coverageEl) return;
    /* Debounced: the colour knob fires `input` continuously and both this and
       sweepTone() walk every text element, so recomputing per pointer move
       would make the panel feel sticky on a heavy dashboard. */
    if (covTimer) clearTimeout(covTimer);
    covTimer = setTimeout(paintCoverage, 120);
  }

  function paintCoverage() {
    covTimer = null;
    if (!coverageEl) return;
    const c = coverage();
    if (!c.total && !c.gradient) { coverageEl.textContent = ''; coverageEl.className = 'dim'; if (coverBtn) coverBtn.hidden = true; return; }
    let t = 'covers ' + c.done + ' of ' + c.total + ' light-text elements';
    if (c.left) t += '  ·  ' + c.left + ' still light';
    if (c.svg) t += '  ·  ' + c.svg + ' in SVG (via fill)';
    if (c.gradient) t += '  ·  ' + c.gradient + ' gradient text left alone';
    coverageEl.textContent = t;
    coverageEl.className = c.left ? 'warn' : 'dim';
    if (coverBtn) coverBtn.hidden = !c.left;
  }

  /* Our own UI is a child of <html>, so the page filter paints IT too — the
     panel came up as a light-grey box with salmon buttons and a mirrored
     swatch. One invert on the panel and on the hover outline cancels it, which
     is also what makes the swatch show the colour that will be produced. */
  function syncUiFilter() {
    const odd = invertDepth(document.documentElement) % 2 === 1;
    const f = odd ? 'invert(1)' : 'none';
    if (root) root.style.filter = f;
    if (hi) hi.style.filter = f;
    return odd;
  }

  /* ────────────────────────── DID THE RULE ACTUALLY LAND? ────────────── */
  /* Twice now the rule was written, the panel showed a colour, and the pixels
     never moved: once because the rule was emitted at the site's own
     specificity, once because the site painted ink with
     -webkit-text-fill-color. Both were invisible from the panel, and what Mike
     saw was "selecting a single element isn't helping". Writing a rule is not
     the same as winning, so measure what the element COMPUTES after the
     stylesheet is in and say which one happened. */
  function sameRGB(a, b) {
    return !!a && !!b && Math.abs(a[0] - b[0]) < 3 && Math.abs(a[1] - b[1]) < 3 &&
           Math.abs(a[2] - b[2]) < 3;
  }

  /* The panel speaks hex everywhere else; getComputedStyle answers in rgb(). */
  function hexOf(rgb) {
    if (!rgb) return '?';
    return '#' + [rgb[0], rgb[1], rgb[2]].map((v) => (v | 0).toString(16).padStart(2, '0')).join('');
  }

  function verifyApplied(target, odd) {
    if (!verifyEl) return;
    if (!pending || !pending.color) { verifyEl.textContent = ''; verifyEl.className = 'dim'; return; }
    const want = parseRGB(odd ? complementCss(pending.color) : pending.color);
    let cs, ink = '', fill = '';
    try {
      cs = getComputedStyle(target);
      ink = cs.color || '';
      fill = cs.webkitTextFillColor || '';
    } catch (e) { verifyEl.textContent = ''; verifyEl.className = 'dim'; return; }
    const hit = sameRGB(parseRGB(ink), want) || sameRGB(parseRGB(fill), want);
    const shown = hexOf(parseRGB(ink));
    if (hit) {
      verifyEl.textContent = '✔ rule applied — element computes ' + shown;
      verifyEl.className = 'ok';
    } else {
      verifyEl.textContent = '✖ rule written but OVERRIDDEN — element still computes ' + shown +
        ' (a site rule outranks it, or the ink is painted another way)';
      verifyEl.className = 'warn';
    }
  }

  /* ─────────────────────────────── live preview + contrast ───────────── */
  function update() {
    if (!pending) return;
    scopeSel.title = pending.sel ||
      (pending.match === 'light' ? 'every light text element' : ('text colour ' + pending.from));
    applyRules();
    if (!lastPick) { contrastEl.textContent = ''; renderCoverage(); return; }

    let target = lastPick;
    if (pending.sel) {
      try {
        const found = document.querySelector(pending.sel);
        if (found) target = found;
      } catch (e) { /* invalid selector while typing */ }
    }

    // Measure in RENDERED space: pending.color is intent, and on an inverted
    // page the backdrop the eye sees is the complement of the one
    // getComputedStyle reports. A uniform invert preserves the ratio itself, so
    // this changes only the printed numbers — but they now match the screen.
    const odd = invertDepth(target) % 2 === 1;
    const raw = backdropOf(target);
    const backdrop = odd ? [255 - raw[0], 255 - raw[1], 255 - raw[2], raw[3]] : raw;
    const fg = parseRGB(pending.color) || parseRGB(getComputedStyle(target).color) || [255, 255, 255, 1];
    const r = ratio(fg, backdrop);
    const txt = 'contrast ' + r.toFixed(1) + ':1 vs backdrop rgb(' + backdrop[0] + ',' + backdrop[1] + ',' + backdrop[2] + ')';
    contrastEl.textContent = r < 3 ? txt + ' — too low' : r < 4.5 ? txt + ' — OK for large text' : txt + ' — good';
    contrastEl.className = r < 3 ? 'warn' : r < 4.5 ? 'dim' : 'ok';
    if (mirrorEl) {
      mirrorEl.textContent = (odd && pending.color)
        ? 'page inverted · writes ' + complementCss(pending.color).toLowerCase() +
          ' to render ' + String(pending.color).toLowerCase()
        : '';
    }
    verifyApplied(target, odd);
    renderCoverage();
  }

  /* ────────────────────────────────── save / forget / export ─────────── */
  /* "Save for this host" has to mean the page comes back the way you left it.
     A tuning rule on a site that is not in `darkHosts` is a trap: on reload the
     page is not inverted, so the rule's colour (recorded as the colour the eye
     saw on a DARKENED page) matches nothing — which is exactly what Mike hit,
     "or darken". So saving a rule also remembers the site, using the same key
     content.js reads, and switches the engine on now if it is off. */
  async function rememberHost() {
    const isDark = () => document.documentElement.classList.contains('cr-dark') ||
                         document.documentElement.classList.contains('cr-repaint');
    try {
      chrome.storage.sync.get('darkHosts', (got) => {
        const hosts = (got && got.darkHosts) || {};
        if (hosts[host]) return;
        hosts[host] = true;
        chrome.storage.sync.set({ darkHosts: hosts });
      });
    } catch (e) { /* no storage in a bare harness */ }
    if (!isDark()) {
      if (window.__darkMode && typeof window.__darkMode.apply === 'function') {
        window.__darkMode.apply();               // the engine's own apply()
      } else {
        document.documentElement.classList.add('cr-dark');
      }
      syncUiFilter();
      return true;
    }
    return false;
  }

  async function onSave() {
    if (ready) await ready;          // storage read must precede the push, or
    if (!pending || !ruleKey(pending)) return;   // loadRules clobbers perHost
    const rule = pending.match === 'light'
      ? { id: pending.id, match: 'light', from: '', color: pending.color, bg: pending.bg || '', min: LIGHT_MIN }
      : pending.match === 'color'
      ? { id: pending.id, match: 'color', from: pending.from, color: pending.color, bg: pending.bg || '' }
      : { sel: pending.sel, color: pending.color, bg: pending.bg || '' };
    const k = ruleKey(rule);
    const i = perHost.findIndex((r) => ruleKey(r) === k);
    if (i >= 0) perHost[i] = rule; else perHost.push(rule);
    await persist();
    const darkened = await rememberHost();     // the page must come back dark too
    pending = null;
    applyRules();                              // parity may have just changed
    renderRules();
    infoEl.textContent = 'Saved for ' + host + ':  ' +
      (rule.match === 'light' ? 'all light text' : rule.match === 'color' ? 'all text ' + rule.from : rule.sel) +
      (darkened ? '  ·  site now darkened + remembered' : '  ·  site already remembered');
    renderCoverage();
  }

  async function onForget() {
    if (ready) await ready;
    const sel = ruleKey(pending) || lastKey;
    const before = perHost.length;
    perHost = perHost.filter((r) => ruleKey(r) !== sel);
    if (perHost.length !== before) { await persist(); }
    pending = null;
    applyRules();
    renderRules();
    infoEl.textContent = perHost.length === before
      ? 'No saved rule for ' + sel
      : 'Removed ' + sel.replace(/^tone:/, 'all text ');
    renderCoverage();
  }

  function onExport() {
    const payload = { host: host, rules: globalRules.concat(perHost) };
    exportEl.hidden = false;
    exportEl.value = JSON.stringify(payload, null, 2);
    exportEl.select();
    try { navigator.clipboard.writeText(exportEl.value); infoEl.textContent = 'JSON copied.'; }
    catch (e) { infoEl.textContent = 'Select-all and copy the JSON below.'; }
  }

  function renderRules() {
    if (!listEl) return;
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    const total = globalRules.length + perHost.length;
    listEl.appendChild(mk('div', {
      cls: 'dim',
      text: total ? total + ' rule(s) active here' : 'no rules saved yet'
    }));
    globalRules.concat(perHost).slice(0, 12).forEach((r) => {
      const sw = mk('span', { cls: 'sw', style: 'background:' + (r.color || '#888') });
      const label = r.match === 'light'
        ? '≈ all light text (' + document.querySelectorAll('[' + TONE_ATTR + ']').length + ' tagged)'
        : r.match === 'color'
        ? '≈ all text ' + r.from + ' (' + document.querySelectorAll('[' + TONE_ATTR + ']').length + ' tagged)'
        : r.sel;
      listEl.appendChild(mk('div', { cls: 'rule' }, [
        mk('span', { cls: 'dim' }, [sw, mk('span', { text: label })]),
        mk('span', { cls: 'dim', text: (r.bg ? r.bg + ' bg' : 'text only') })
      ]));
    });
  }

  /* ─────────────────────────────────────────────── wiring ───────────── */
  try {
    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'dmTuner') { openPanel(); respond && respond({ ok: true }); }
      if (msg.type === 'dmTunerState') {
        respond && respond({ host: host, perHost: perHost.length, global: globalRules.length, open: !!(root && root.style.display !== 'none') });
      }
    });
  } catch (e) { /* no runtime in a bare page harness */ }

  // Apply anything already saved for this host, without drawing anything.
  // `ready` is what onSave/onForget await: pushing a rule before this resolves
  // gets the array replaced underneath them by loadRules().
  //
  // A host that HAS tuning rules is by definition meant to be dark: remembering
  // it here repairs the state 1.0.17 could produce (rule saved, host never added
  // to darkHosts), where the reloaded page came back light and the colour rule —
  // recorded in the colours of a darkened page — matched nothing. Measured in
  // Mike's live profile on 2026-11-11: two rules for quantamagazine.org, no
  // darkHosts entry, hence "it didn't reassert … or darken".
  ready = loadRules().then(async () => {
    if (perHost.length) await rememberHost();
    applyRules();
  }).catch(() => {});

  /* Frames are judged on their own evidence, not on storage: the drawer's ink is
     the accent whether or not this host has a saved rule. Cheap no-op in the top
     document and in every cross-origin frame. */
  try { startFrameTone(); } catch (e) {}

  /* PALETTE CHANGES REACH THE OPEN PAGE (1.1.0). The popup writes storage; every
     tab listens, so "pick a colour" is a live loop rather than save-and-reload.
     Only the three palette keys are handled here — darkHosts belongs to
     content.js, which owns the engine class. */
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'sync' || (!ch.dmInk && !ch.dmAccent && !ch.dmSiteInk)) return;
      if (ch.dmInk) masterInk = hexOr(ch.dmInk.newValue, PALETTE_INK_DEFAULT);
      if (ch.dmAccent) accentOn = ch.dmAccent.newValue !== false;
      if (ch.dmSiteInk) {
        siteInk = (ch.dmSiteInk.newValue && typeof ch.dmSiteInk.newValue === 'object'
          && !Array.isArray(ch.dmSiteInk.newValue)) ? ch.dmSiteInk.newValue : {};
      }
      applyRules();
      if (window.top !== window && document.documentElement.classList.contains(FRAME_DARK_CLASS)) {
        sweepFrameInk(frameAccentIntent());
      }
    });
  } catch (e) {}

  /* content.js calls this when the engine class changes (1.1.0): the emitted
     rules and their tags are both produced here, so "darken this page" has to
     re-run the sweep or the ink stays white until the next load. */
  window.__dmResweep = function () { try { applyRules(); } catch (e) {} };

  /* …and this when the engine class comes OFF (1.1.1): inline paint written by
     the cap/photo/label passes is not gated by the class, so leaving it behind
     is what made Google's image thumbnails render as negatives on a dark page. */
  window.__dmUnpaint = function () { return unpaint(); };

  // Harness hook: lets a test drive the picker without a real click.
  window.__dmTuner = {
    open: openPanel,
    close: closePanel,
    capture: (el) => { ensureRoot(); capture(el); },
    state: () => ({
      host: host, perHost: perHost, global: globalRules, pending: pending,
      css: styleEl ? styleEl.textContent : '',
      tagged: document.querySelectorAll('[' + TONE_ATTR + ']').length,
      coverage: coverage(),
      /* what the palette currently resolves to, and whether the master rule is
         live at all — the two facts a "why is my text still white" report needs
         (1.1.0) */
      ink: paletteInk(), masterInk: masterInk, accent: accentOn,
      siteOverride: siteInk[host] || '', defRule: defaultRule()
    }),
    /* colour-sweep surface: the same code paths the panel buttons hit */
    scope: (v) => { scopeSel.value = v; onScopeChange(); },
    tone: (from, colour) => {
      applyTone(from);
      if (colour) { txtInput.value = colour; pending.color = colour; update(); }
    },
    light: (colour) => {
      applyLight();
      if (colour) { txtInput.value = colour; pending.color = colour; update(); }
    },
    coverage: () => coverage(),
    /* every scope the panel is offering right now, as the user sees it */
    options: () => (scopeSel ? [...scopeSel.options].map((o) => ({
      v: o.value, t: o.textContent.trim(), chosen: o.selected
    })) : []),
    groups: () => [...lastGroups.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([c, v]) => ({ colour: c, n: v.n, chars: v.chars, tags: v.tags })),
    sweep: () => sweepTone(),
    save: onSave,
    forget: onForget
  };
})();
