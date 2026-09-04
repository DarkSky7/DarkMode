/* DarkMode popup — ask once, remember optionally. */
'use strict';

const VERSION = '0.1.0';
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
  catch (e) { return null; } // no content script (chrome://, store, ...)
}

const btn = document.getElementById('btn-toggle');
const remChk = document.getElementById('remember');
const hint = document.getElementById('hint');
const remNote = document.getElementById('remember-note');
let tab = null, host = '';

function render(state, remembered) {
  const dark = !!(state && state.dark);
  btn.textContent = dark ? '☀️ Lighten this page' : '🌙 Darken this page';
  btn.classList.toggle('on', dark);
  remChk.checked = !!remembered;
  remNote.hidden = !remembered;
  if (!state) {
    btn.disabled = true;
    btn.textContent = '🌙 Not available here';
    hint.textContent = 'This page cannot be darkened (browser-internal or store page).';
  }
}

async function refresh() {
  tab = await currentTab();
  host = hostOf(tab);
  document.getElementById('host').textContent = host ? 'on ' + host : 'no web page';
  document.getElementById('host2').textContent = host || 'this site';
  if (!host) { render(null, false); return; }
  const state = await sendTab(tab, { type: 'dmGetState' });
  const bg = await chrome.runtime.sendMessage({ type: 'getHostState', host });
  render(state, bg && bg.remembered);
}

btn.addEventListener('click', async () => {
  const state = await sendTab(tab, { type: 'dmToggle' });
  render(state, remChk.checked);
  hint.textContent = state && state.dark
    ? 'Darkened for this visit. Check below to remember ' + host + '.'
    : 'Reverted for this visit.';
});

remChk.addEventListener('change', async () => {
  const want = remChk.checked;
  await chrome.runtime.sendMessage({ type: 'setRemembered', host, dark: want });
  remNote.hidden = !want;
  if (want) {
    // remembering implies dark now
    const state = await sendTab(tab, { type: 'dmSetDark', dark: true });
    render(state, true);
  }
  hint.textContent = want
    ? 'Remembered: ' + host + ' will auto-darken on future visits.'
    : 'Forgotten: ' + host + ' will load light unless you ask.';
});

refresh();
