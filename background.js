/* DarkMode background — owns the remembered-sites allowlist (sync storage).
   The extension does NOTHING by itself: content.js only acts when (a) the host
   is in the allowlist, or (b) the user asks via popup → tab message.
   Toolbar icon mirrors the ACTIVE TAB's state: crescent moon = darkened,
   sun = not darkened. Content scripts report state; icons persist per tab. */
const DEFAULT_HOSTS = {}; // { "foxglove.dev": true } once remembered

const ICON_DARK = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
const ICON_OFF = { 16: 'icons/sun16.png', 32: 'icons/sun32.png', 48: 'icons/sun48.png', 128: 'icons/sun128.png' };

function setTabIcon(tabId, dark) {
  try { chrome.action.setIcon({ tabId, path: dark ? ICON_DARK : ICON_OFF }); } catch (e) { /* no tab yet */ }
}

async function getHosts() {
  const got = await chrome.storage.sync.get('darkHosts');
  return got.darkHosts || {};
}

async function setHost(host, dark) {
  const hosts = await getHosts();
  if (dark) hosts[host] = true;
  else delete hosts[host];
  await chrome.storage.sync.set({ darkHosts: hosts });
  return hosts;
}

/* popup asks */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'getHostState') {
      const hosts = await getHosts();
      sendResponse({ remembered: !!hosts[msg.host] });
    } else if (msg.type === 'setRemembered') {
      await setHost(msg.host, msg.dark);
      sendResponse({ ok: true });
    } else if (msg.type === 'dmHostState') {
      /* content script reports its tab's dark state → mirror on the icon */
      if (sender.tab && sender.tab.id) setTabIcon(sender.tab.id, !!msg.dark);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'unknown type' });
    }
  })();
  return true; // async response
});
