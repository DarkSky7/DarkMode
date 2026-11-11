/* DarkMode popup — ask once, remember optionally. */
'use strict';

const VERSION = '1.0.21';
document.getElementById('ver').textContent = 'v' + VERSION;

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function hostOf(tab) {
  try { return new URL(tab.url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

async function sendTab(tab, msg) {
  try { return await chrome.tabs.sendMessage(tab.id, msg); }
  catch (e) { return null; } // no content script yet (pre-extension tab, SPA hop)
}

/* MV3 does not inject content scripts into tabs that were open BEFORE the
   extension loaded — and reloading the extension in the browser's extensions
   page strips them from every open tab, which is what "reload the tab and try
   again" was telling the user to do.

   The fallback used to inject content.js only, so on those tabs "Darken this
   page" worked while "Tune in place" stayed dead forever: the tuner lives in a
   SEPARATE content-script file (tuner.js) whose message listener never existed.
   Inject every script the manifest declares, not just the first one. tuner.js
   is idempotent (window.__dmTunerLoaded), so injecting it twice is harmless. */
async function ensureContent(tab) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['tuner.js'] });
    return true;
  } catch (e) { return false; }
}

async function askTab(tab, msg) {
  // The popup can be clicked before refresh() has resolved, in which case `tab`
  // is still null and the old code threw here with no visible error at all.
  if (!tab) tab = await currentTab();
  if (!tab || !tab.id) return null;
  let res = await sendTab(tab, msg);
  if (res === null && /^https?:/.test(tab.url || '')) {
    if (await ensureContent(tab)) res = await sendTab(tab, msg); // retry once
  }
  return res;
}

const btn = document.getElementById('btn-toggle');
const forceBtn = document.getElementById('btn-force');
const remChk = document.getElementById('remember');
const hint = document.getElementById('hint');
const remNote = document.getElementById('remember-note');
let tab = null, host = '';

function render(state, remembered) {
  const dark = !!(state && state.dark);
  const alreadyDark = !!(state && !dark && state.tone === 'dark');
  btn.disabled = alreadyDark || !state;
  btn.textContent = dark ? '☀️ Disable Dark Mode override'
    : alreadyDark ? '☀️ Page already dark' : '🌙 Darken this page';
  btn.classList.toggle('on', dark);
  forceBtn.hidden = !alreadyDark;
  remChk.checked = !!remembered;
  remChk.disabled = !state || alreadyDark;
  remNote.hidden = !remembered;
  if (!state) {
    hint.textContent = 'This page cannot be darkened (browser-internal or store page).';
  } else if (alreadyDark) {
    hint.textContent = 'This page is already dark (native or another extension) — inverting it would fake the original light look. Use "invert anyway" only if it looks light to you.';
  } else if (!dark) {
    hint.textContent = 'Applies now. Nothing is remembered until you check below.';
  } else {
    hint.textContent = 'Darkened for this visit. Check below to remember ' + host + '.';
  }
}

async function refresh() {
  tab = await currentTab();
  host = hostOf(tab);
  document.getElementById('host').textContent = host ? 'on ' + host : 'no web page';
  document.getElementById('host2').textContent = host || 'this site';
  if (!host) { render(null, false); return; }
  const state = await askTab(tab, { type: 'dmGetState' });
  const bg = await chrome.runtime.sendMessage({ type: 'getHostState', host });
  render(state, bg && bg.remembered);
}

btn.addEventListener('click', async () => {
  const state = await askTab(tab, { type: 'dmToggle' });
  render(state, remChk.checked);
  hint.textContent = state && state.dark
    ? 'Darkened for this visit. Check below to remember ' + host + '.'
    : state && state.alreadyDark
      ? 'Already dark — nothing inverted.'
      : 'Dark Mode override disabled for this visit.';
});

forceBtn.addEventListener('click', async () => {
  const state = await askTab(tab, { type: 'dmSetDark', dark: true, force: true });
  render(state, remChk.checked);
  hint.textContent = state && state.dark
    ? 'Darkened anyway (forced).'
    : 'Still light — this page overrides the attempt.';
});

remChk.addEventListener('change', async () => {
  const want = remChk.checked;
  await chrome.runtime.sendMessage({ type: 'setRemembered', host, dark: want });
  remNote.hidden = !want;
  if (want) {
    // remembering implies dark now
    const state = await askTab(tab, { type: 'dmSetDark', dark: true });
    render(state, true);
  }
  hint.textContent = want
    ? 'Remembered: ' + host + ' will auto-darken on future visits.'
    : 'Forgotten: ' + host + ' will load light unless you ask.';
});

refresh();

/* ── Tune in place ────────────────────────────────────────────────────────
   The panel lives on the page (tuner.js, shadow DOM), not in the popup, so it
   can be pointed at while the page stays visible. Clicking this closes the
   popup and leaves the panel up. */
const tuneBtn = document.getElementById('btn-tune');
const tuneNote = document.getElementById('tune-note');
if (tuneBtn) {
  tuneBtn.addEventListener('click', async () => {
    const res = await askTab(tab, { type: 'dmTuner' });
    if (res && res.ok) { window.close(); return; }
    tuneNote.hidden = false;
    tuneNote.textContent = host
      ? 'The tuner could not load on this page — reload the tab and try again.'
      : 'No web page to tune here.';
  });
}
