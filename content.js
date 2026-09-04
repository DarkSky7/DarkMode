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
  const VERSION = '1.0.0';
  const HOST = location.hostname.replace(/^www\./, '');

  if (window.top !== window) return; // frames: parent handles the page
  if (window.__darkMode) return;     // already injected (popup fallback re-execution)

  const KEY = 'cr-dark';

  function apply() { document.documentElement.classList.add(KEY); }
  function revert() { document.documentElement.classList.remove(KEY); }
  function isDark() { return document.documentElement.classList.contains(KEY); }

  /* remembered sites: apply ASAP (documentElement exists at document_start) */
  try {
    chrome.storage.sync.get('darkHosts', (got) => {
      const hosts = got.darkHosts || {};
      if (hosts[HOST] || hosts['*']) apply();
    });
  } catch (e) { /* storage unavailable (chrome:// etc.) — stay inert */ }

  /* popup asks */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'dmGetState') { sendResponse({ dark: isDark(), host: HOST, v: VERSION }); }
    else if (msg.type === 'dmSetDark') { (msg.dark ? apply : revert)(); sendResponse({ dark: isDark() }); }
    else if (msg.type === 'dmToggle') { isDark() ? revert() : apply(); sendResponse({ dark: isDark() }); }
    else sendResponse({});
    return false;
  });

  /* expose for popup debugging / tests */
  window.__darkMode = { apply, revert, isDark, host: HOST, version: VERSION };
})();
