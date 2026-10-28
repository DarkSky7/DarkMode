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
  const VERSION = '1.0.5';
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
