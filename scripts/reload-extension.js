(async function () {
  const out = { devModeFound: false, devModeOn: null, reloaded: [], note: '' };
  const walk = (node, fn) => {
    if (!node || !node.querySelectorAll) return;
    for (const el of node.querySelectorAll('*')) { fn(el); if (el.shadowRoot) walk(el.shadowRoot, fn); }
  };
  const all = [];
  walk(document, (el) => all.push(el));

  // 1. developer mode must be ON for the per-item Reload button to exist
  const toggle = all.find((el) => el.id === 'devMode' && el.tagName === 'CR-TOGGLE');
  if (toggle) {
    out.devModeFound = true;
    out.devModeOn = !!toggle.checked;
    if (!toggle.checked) {
      toggle.click();
      out.devModeOn = true;
      out.note += ' dev mode enabled;';
      /* The list re-renders asynchronously: the Reload button does not exist in
         the same task that turns developer mode on. Measured. */
      await new Promise((r) => setTimeout(r, 1500));
    }
  } else {
    out.note += ' dev mode toggle not found;';
  }

  // 2. click Reload on every DarkMode item (the DOM re-renders after the toggle,
  //    so re-walk rather than reusing detached nodes)
  const fresh = [];
  walk(document, (el) => fresh.push(el));
  const items = fresh.filter((el) => el.tagName === 'EXTENSIONS-ITEM');
  for (const item of items) {
    const nameEl = item.shadowRoot && item.shadowRoot.getElementById('name');
    const name = nameEl ? nameEl.textContent.trim() : '';
    if (name.indexOf('DarkMode') === -1) continue;
    const btn = item.shadowRoot.querySelector('#dev-reload');
    const d = item.data || {};
    if (btn) { btn.click(); out.reloaded.push((d.path || name) + ' -> reload clicked'); }
    else out.note += ' no reload button for ' + (d.path || name) + ';';
  }
  if (!out.reloaded.length && !out.note) out.note = 'no DarkMode item found';
  return out;
})();
