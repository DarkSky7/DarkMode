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
  const VERSION = '1.0.3';
  const HOST = location.hostname.replace(/^www\./, '');

  if (window.top !== window) return; // frames: parent handles the page
  if (window.__darkMode) return;     // already injected (popup fallback re-execution)

  const KEY = 'cr-dark';

  function apply() { document.documentElement.classList.add(KEY); }
  function revert() { document.documentElement.classList.remove(KEY); }
  function isDark() { return document.documentElement.classList.contains(KEY); }

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
