/* DarkMode popup — ask once, remember optionally, and carry the palette.
   v1.1.0 (2026-11-27): the master palette + per-site palette + the auto-dark
   switch live here. The popup only WRITES storage; content.js and tuner.js
   listen to storage.onChanged, so a colour change is live on every open tab
   without a reload. */
'use strict';

/* Read it from the manifest: the hand-typed string was left at 1.0.21 while
   the package was 1.0.22, so the popup misreported which build was running. */
const VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; } })();
document.getElementById('ver').textContent = 'v' + VERSION;

/* Must match tuner.js PALETTE_INK_DEFAULT and background defaults. */
const INK_DEFAULT = '#2f9eae';
const hexOk = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim())) ? v.trim().toLowerCase() : '';

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

   Inject every script the manifest declares, not just the first one: the tuner
   lives in a SEPARATE content-script file (tuner.js) whose message listener
   never existed on those tabs, so "Darken this page" worked while "Tune in
   place" stayed dead. tuner.js is idempotent (window.__dmTunerLoaded). */
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
const remLabel = document.getElementById('remember-label');
const hint = document.getElementById('hint');
const remNote = document.getElementById('remember-note');
const autoChk = document.getElementById('auto');
const accentChk = document.getElementById('accent');
const inkInput = document.getElementById('ink');
const inkHex = document.getElementById('inkhex');
const siteInput = document.getElementById('siteink');
const siteSave = document.getElementById('site-save');
const siteClear = document.getElementById('site-clear');
const siteNote = document.getElementById('site-note');
let tab = null, host = '';
let state = { auto: true, accent: true, ink: INK_DEFAULT, siteInk: {}, lightHosts: {}, darkHosts: {} };

function render(stateTab, remembered) {
  const dark = !!(stateTab && stateTab.dark);
  const alreadyDark = !!(stateTab && !dark && stateTab.tone === 'dark');
  btn.disabled = alreadyDark || !stateTab;
  btn.textContent = dark ? '☀️ Disable Dark Mode override'
    : alreadyDark ? '☀️ Page already dark' : '🌙 Darken this page';
  btn.classList.toggle('on', dark);
  forceBtn.hidden = !alreadyDark;
  remChk.checked = !!remembered;
  remChk.disabled = !stateTab || alreadyDark;
  remNote.hidden = !remembered;
  if (!stateTab) {
    hint.textContent = 'This page cannot be darkened (browser-internal or store page).';
  } else if (alreadyDark) {
    hint.textContent = 'This page is already dark (native or another extension) — inverting it would fake the original light look. Use "invert anyway" only if it looks light to you.';
  } else if (!dark) {
    hint.textContent = state.auto
      ? 'Auto-dark is on, but you switched this site off at some point.'
      : 'Applies now. Nothing is remembered until you check below.';
  } else {
    hint.textContent = remembered
      ? 'Remembered: this site is always dark.'
      : 'Darkened. Check below to keep it that way.';
  }
}

/* The remember checkbox means two different things depending on the mode, and
   the label has to say which: with auto-dark on, sites are dark by default so
   the useful action is to switch THIS one off; with it off, the useful action is
   to opt this one in. */
function renderRemember() {
  const b = document.getElementById('host2');
  b.textContent = host || 'this site';
  if (state.auto) {
    remLabel.textContent = '';   // no innerHTML anywhere: AMO flags it and Trusted Types sites need it gone
    remLabel.appendChild(document.createTextNode('Keep '));
    const bb = document.createElement('b');
    bb.textContent = host || 'this site';
    remLabel.appendChild(bb);
    remLabel.appendChild(document.createTextNode(' light (never auto-dark)'));
    remChk.checked = !!state.lightHosts[host];
    remNote.textContent = 'Auto-dark never touches this site again. Uncheck to let it come back.';
  } else {
    remLabel.textContent = '';   // no innerHTML anywhere: AMO flags it and Trusted Types sites need it gone
    remLabel.appendChild(document.createTextNode('Always dark on '));
    const bb = document.createElement('b');
    bb.textContent = host || 'this site';
    remLabel.appendChild(bb);
    remChk.checked = !!state.darkHosts[host];
    remNote.textContent = 'Will auto-darken on future visits. Uncheck to stop.';
  }
}

function renderPalette() {
  autoChk.checked = !!state.auto;
  accentChk.checked = !!state.accent;
  inkInput.value = state.ink;
  inkHex.textContent = state.ink;
  const site = hexOk(state.siteInk[host]) || '';
  siteInput.value = site || state.ink;
  siteClear.hidden = !site;
  siteNote.hidden = false;
  siteNote.textContent = site
    ? 'This site uses ' + site + ' instead of the master ink.'
    : 'Only saved if you press Save — the master palette is used everywhere until then.';
}

async function readSettings() {
  const got = await chrome.storage.sync.get(
    ['dmAuto', 'dmAccent', 'dmInk', 'dmSiteInk', 'dmLightHosts', 'darkHosts']);
  state.auto = got.dmAuto !== false;
  state.accent = got.dmAccent !== false;
  state.ink = hexOk(got.dmInk) || INK_DEFAULT;
  state.siteInk = (got.dmSiteInk && typeof got.dmSiteInk === 'object') ? got.dmSiteInk : {};
  state.lightHosts = got.dmLightHosts || {};
  state.darkHosts = got.darkHosts || {};
}

async function refresh() {
  tab = await currentTab();
  host = hostOf(tab);
  document.getElementById('host').textContent = host ? 'on ' + host : 'No web page';
  await readSettings();
  renderPalette();
  renderRemember();
  if (!host) { render(null, false); return; }
  const st = await askTab(tab, { type: 'dmGetState' });
  const remembered = state.auto ? !!state.lightHosts[host] : !!state.darkHosts[host];
  render(st, remembered);
}

btn.addEventListener('click', async () => {
  const st = await askTab(tab, { type: 'dmToggle' });
  render(st, remChk.checked);
  hint.textContent = st && st.dark
    ? 'Darkened for this visit.'
    : st && st.alreadyDark
      ? 'Already dark — nothing inverted.'
      : 'Dark Mode override disabled for this visit.';
});

forceBtn.addEventListener('click', async () => {
  const st = await askTab(tab, { type: 'dmSetDark', dark: true, force: true });
  render(st, remChk.checked);
  hint.textContent = st && st.dark ? 'Darkened anyway (forced).'
    : 'Still light — this page overrides the attempt.';
});

/* Remember / exclude. Auto mode writes dmLightHosts (a per-site OFF switch);
   manual mode keeps the original darkHosts meaning (a per-site ON switch). */
remChk.addEventListener('change', async () => {
  const want = remChk.checked;
  if (!host) return;
  if (state.auto) {
    const map = Object.assign({}, state.lightHosts);
    if (want) map[host] = true; else delete map[host];
    await chrome.storage.sync.set({ dmLightHosts: map });
    state.lightHosts = map;
    if (!want) await askTab(tab, { type: 'dmSetDark', dark: true });
    hint.textContent = want
      ? host + ' will stay light.'
      : host + ' is back under auto-dark.';
  } else {
    await chrome.runtime.sendMessage({ type: 'setRemembered', host, dark: want });
    if (want) await askTab(tab, { type: 'dmSetDark', dark: true });
    hint.textContent = want ? 'Remembered: ' + host + ' will auto-darken on future visits.'
      : 'Forgotten: ' + host + ' will load light unless you ask.';
  }
  remNote.hidden = !want;
  render(await askTab(tab, { type: 'dmGetState' }), want);
});

autoChk.addEventListener('change', async () => {
  state.auto = autoChk.checked;
  await chrome.storage.sync.set({ dmAuto: state.auto });
  renderRemember();
  renderPalette();
  render(await askTab(tab, { type: 'dmGetState' }), false);
  hint.textContent = state.auto
    ? 'Every site is darkened unless you switch it off.'
    : 'Nothing is darkened unless you ask or remember it.';
});

accentChk.addEventListener('change', async () => {
  state.accent = accentChk.checked;
  await chrome.storage.sync.set({ dmAccent: state.accent });
  hint.textContent = state.accent
    ? 'White and grey text is tinted with the palette ink.'
    : 'Text keeps its own colour (white stays white).';
});

let inkTimer = null;
inkInput.addEventListener('input', () => {
  state.ink = hexOk(inkInput.value) || INK_DEFAULT;
  inkHex.textContent = state.ink;
  /* Debounced: dragging a native colour picker fires `input` continuously and
     every write fans out to every open tab. */
  if (inkTimer) clearTimeout(inkTimer);
  inkTimer = setTimeout(() => { chrome.storage.sync.set({ dmInk: state.ink }); }, 180);
});

siteSave.addEventListener('click', async () => {
  if (!host) return;
  const c = hexOk(siteInput.value) || state.ink;
  const map = Object.assign({}, state.siteInk);
  map[host] = c;
  state.siteInk = map;
  await chrome.storage.sync.set({ dmSiteInk: map });
  renderPalette();
  siteNote.textContent = 'Saved: ' + host + ' now uses ' + c + '.';
});

siteClear.addEventListener('click', async () => {
  if (!host) return;
  const map = Object.assign({}, state.siteInk);
  delete map[host];
  state.siteInk = map;
  await chrome.storage.sync.set({ dmSiteInk: map });
  renderPalette();
  siteNote.textContent = 'Cleared: this site follows the master ink again.';
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
