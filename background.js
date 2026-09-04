/* DarkMode background — owns the remembered-sites allowlist (sync storage).
   The extension does NOTHING by itself: content.js only acts when (a) the host
   is in the allowlist, or (b) the user asks via popup → tab message. */
const DEFAULT_HOSTS = {}; // { "foxglove.dev": true } once remembered

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
    } else {
      sendResponse({ ok: false, error: 'unknown type' });
    }
  })();
  return true; // async response
});
