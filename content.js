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
  const VERSION = '1.0.7';
  const HOST = location.hostname.replace(/^www\./, '');

  if (window.top !== window) return; // frames: parent handles the page
  if (window.__darkMode) return;     // already injected (popup fallback re-execution)

  const KEY = 'cr-dark';

  function apply() { document.documentElement.classList.add(KEY); }
  function revert() { document.documentElement.classList.remove(KEY); }
  function isDark() { return document.documentElement.classList.contains(KEY); }

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

  /* ── GMAIL SURFACE NORMALISER (1.0.6) ────────────────────────────────────
     Why measurement and not selectors: 1.0.4 shipped three hard-coded Gmail
     class rules. Measured live 2026-10-28 on an OPEN CONVERSATION, Gmail
     rendered THREE white surfaces — .nH.a98.iY (thread card 807x2126),
     .nH.btDi4d.rT5Apb (Reply/Forward bar 791x68) and .nr.wR (the button row
     inside that bar 719x36). The whitelist covered two of three, and would
     break again the next time Gmail renames a class.

     So instead: SAMPLE the page's own dark palette (its darkest large surface
     and its lightest real ink), then repaint any near-white background inside
     [role=main] to that sampled surface, and lighten near-black ink ONLY
     inside the surfaces we repainted. Order matters both ways: painting a
     surface without lightening its ink makes text vanish, and lightening ink
     on a surface we did not paint makes it vanish on white.

     Idempotency is mandatory (a self-triggering observer is what hangs pages):
     every write is guarded by a data-cr-surf / data-cr-ink marker, so a second
     pass writes nothing, produces no mutations, and the loop settles. */
  function startGmailSurfaceFix() {
    let palette = null, armed = false;

    function parseColor(s) {
      const m = String(s).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (!m) return null;
      return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    }
    function lum(c) { return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; }

    /* sample the page's own palette, so the patch matches whatever dark theme
       the user picked instead of imposing a hard-coded grey */
    function sample() {
      const root = document.querySelector('[role=main]') || document.body;
      if (!root) return null;
      const els = root.querySelectorAll('*');
      const n = Math.min(els.length, 7000);
      let surf = null, ink = null;
      for (let i = 0; i < n && !(surf && ink); i++) {
        const el = els[i];
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (!surf) {
          const b = parseColor(cs.backgroundColor);
          if (b && b[3] > 0.9 && lum(b) < 0.22 && r.width * r.height > 20000) surf = cs.backgroundColor;
        }
        if (!ink) {
          const c = parseColor(cs.color);
          const t = el.textContent ? el.textContent.trim() : '';
          if (c && c[3] > 0.5 && lum(c) > 0.55 && t.length > 8 && r.width > 40) ink = cs.color;
        }
      }
      return { surf: surf || 'rgb(32,33,36)', ink: ink || 'rgb(224,224,224)' };
    }

    function fix() {
      if (toneNatural(true) !== 'dark') return;   // never fight a light Gmail
      const root = document.querySelector('[role=main]') || document.body;
      if (!root) return;
      palette = palette || sample();
      if (!palette) return;
      const els = root.querySelectorAll('*');

      // pass 1 — repaint near-white surfaces
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (el.dataset.crSurf === '1') continue;
        const b = parseColor(getComputedStyle(el).backgroundColor);
        if (!b || b[3] <= 0.4 || lum(b) < 0.75) continue;
        el.style.setProperty('background-color', palette.surf, 'important');
        el.dataset.crSurf = '1';
      }

      // pass 2 — lighten near-black ink, but ONLY inside surfaces we repainted
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (el.dataset.crInk === '1') continue;
        const c = parseColor(getComputedStyle(el).color);
        if (!c || c[3] <= 0.4 || lum(c) > 0.30) continue;
        if (!el.closest('[data-cr-surf="1"]')) continue;   // leaves dark-on-dark alone
        el.style.setProperty('color', palette.ink, 'important');
        el.dataset.crInk = '1';
      }
    }

    /* trailing-edge debounce; the writes above are idempotent so this settles */
    function schedule() {
      if (armed) return;
      armed = true;
      setTimeout(() => { armed = false; try { fix(); } catch (e) {} }, 450);
    }

    try {
      if (toneNatural(true) === 'dark') fix();
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
      /* Gmail paints thread chrome on its own timetable; a short ladder costs
         nothing and covers re-renders the observer can still miss. */
      [300, 1200, 2500, 5000, 9000].forEach(t => setTimeout(schedule, t));
    } catch (e) {}
    window.__crGmailFix = fix;
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
     inversion would fake light — back out after load instead. */
  try {
    window.addEventListener('load', function () {
      setTimeout(function () {
        if (isDark() && toneNatural(true) === 'dark') { revert(); report(); }
      }, 1200);
    });
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
