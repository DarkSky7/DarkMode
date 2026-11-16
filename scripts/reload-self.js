/* reload-self.js -- reload the extension from inside its own content-script
 * world: the same effect as the Reload button on chrome://extensions, without
 * touching the browser and without losing the user's tabs.
 *
 * WHY (2026-11-16): unpacked content scripts are read from disk ONCE, at
 * extension load. Editing tuner.js and refreshing the page changes nothing --
 * measured: manifestVersion stayed 1.0.27 after a full navigation. The UI path
 * (clicking Reload through chrome://extensions over CDP) hung, and killing the
 * browser is not acceptable. chrome.runtime.reload() is the same operation the
 * button performs, and it is reachable from the content-script world.
 *
 * Scheduled on a timer so the evaluate returns BEFORE the context is destroyed.
 */
(() => {
  if (!globalThis.chrome || !chrome.runtime || typeof chrome.runtime.reload !== 'function') {
    return { ok: false, why: 'chrome.runtime.reload unavailable in this world' };
  }
  const v = (() => { try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; } })();
  setTimeout(() => { try { chrome.runtime.reload(); } catch (e) {} }, 60);
  return { ok: true, versionBefore: v, note: 'reload scheduled' };
})()
