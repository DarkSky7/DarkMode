/* DarkMode — "tune in place".
 *
 * Point at an element, see which class actually controls it (with element
 * counts), tune the text and background colour live, see the contrast ratio
 * before committing, and save the rule for this host.
 *
 * Rules are stored as [{sel, color, bg}] under `tuneRulesByHost[host]`, plus a
 * `tuneRulesGlobal` list that is applied on every host. That shape is the whole
 * point: a "global theme" is the same rule list with a wider scope, not a
 * different mechanism. Per-host rules are applied after global ones, so a site
 * can override the theme.
 *
 * Nothing is drawn until the popup asks (`{type:'dmTuner'}`) or a saved rule
 * exists. No innerHTML anywhere — YouTube and friends enforce Trusted Types.
 */
'use strict';

(function () {
  if (window.__dmTunerLoaded) return;
  window.__dmTunerLoaded = true;

  const ROOT_ID = 'dm-tuner-root';
  const sync = (chrome.storage && chrome.storage.sync) || null;
  const host = location.hostname.replace(/^www\./, '');

  let root = null, shadow = null, styleEl = null, panel = null;
  let picking = false, pending = null, infoEl = null, contrastEl = null, scopeSel = null, customInput = null;
  let txtInput = null, bgInput = null, bgChk = null, listEl = null, exportEl = null;
  let hi = null, perHost = [], globalRules = [], lastPick = null;

  /* ───────────────────────────── storage (callback or promise) ───────── */
  function sget(keys) {
    return new Promise((resolve) => {
      if (!sync) return resolve({});
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v || {}); } };
      try {
        const maybe = sync.get(keys, finish);
        if (maybe && typeof maybe.then === 'function') maybe.then(finish).catch(() => finish({}));
      } catch (e) { finish({}); }
    });
  }

  function sset(obj) {
    return new Promise((resolve) => {
      if (!sync) return resolve(false);
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(true); } };
      try {
        const maybe = sync.set(obj, finish);
        if (maybe && typeof maybe.then === 'function') maybe.then(finish).catch(() => finish());
      } catch (e) { finish(); }
    });
  }

  async function loadRules() {
    const data = await sget({ tuneRulesByHost: {}, tuneRulesGlobal: [] });
    const map = data.tuneRulesByHost || {};
    perHost = Array.isArray(map[host]) ? map[host].slice() : [];
    globalRules = Array.isArray(data.tuneRulesGlobal) ? data.tuneRulesGlobal.slice() : [];
    return { perHost, globalRules };
  }

  async function persist() {
    const data = await sget({ tuneRulesByHost: {} });
    const map = data.tuneRulesByHost || {};
    if (perHost.length) map[host] = perHost; else delete map[host];
    await sset({ tuneRulesByHost: map, tuneRulesGlobal: globalRules });
  }

  /* ───────────────────────────────────── applying rules ──────────────── */
  function cssText(rules) {
    return rules
      .filter((r) => r && r.sel)
      .map((r) => {
        const parts = [];
        if (r.color) parts.push('color:' + r.color + ' !important');
        if (r.bg) parts.push('background-color:' + r.bg + ' !important');
        return parts.length ? r.sel + '{' + parts.join(';') + '}' : '';
      })
      .filter(Boolean)
      .join('\n');
  }

  function applyRules() {
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'dm-tuner-rules';
      (document.head || document.documentElement).appendChild(styleEl);
    }
    const all = globalRules.concat(perHost).concat(pending ? [pending] : []);
    styleEl.textContent = cssText(all);
  }

  /* ───────────────────────────────────────── colour maths ────────────── */
  function parseRGB(str) {
    if (!str) return null;
    const s = String(str).trim();
    let m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) {
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
    }
    m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) {
      const h = m[1];
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1];
    }
    m = /rgba?\(([^)]+)\)/i.exec(s);
    if (m) {
      const p = m[1].split(',').map((x) => parseFloat(x));
      return [p[0] | 0, p[1] | 0, p[2] | 0, p.length > 3 ? p[3] : 1];
    }
    return null;
  }

  function lum(rgb) {
    const f = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  }

  function ratio(a, b) {
    const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** The painted backdrop behind `el`: walk up to the first opaque background. */
  function backdropOf(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      const bg = parseRGB(getComputedStyle(node).backgroundColor);
      if (bg && bg[3] > 0.5) return bg;
      node = node.parentElement;
    }
    return [255, 255, 255, 1];
  }

  /* ────────────────────────────────────────── panel plumbing ─────────── */
  function mk(tag, props, kids) {
    const node = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'text') node.textContent = props[k];
      else if (k === 'cls') node.className = props[k];
      else if (k === 'style') node.setAttribute('style', props[k]);
      else node.setAttribute(k, props[k]);
    }
    (kids || []).forEach((c) => c && node.appendChild(c));
    return node;
  }

  function ensureRoot() {
    if (root) return;
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('style', 'all:initial; position:fixed; z-index:2147483646; right:16px; bottom:16px;');
    shadow = root.attachShadow({ mode: 'open' });
    shadow.appendChild(mk('style', {
      text: [
        ':host{all:initial}',
        '.p{font:12px/1.45 system-ui,sans-serif;color:#e8e8e8;background:#161616;border:1px solid #3a3a3a;',
        '   border-radius:8px;padding:10px;width:288px;box-shadow:0 6px 24px rgba(0,0,0,.5)}',
        '.h{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}',
        '.t{font-weight:600;letter-spacing:.02em}',
        'button{font:inherit;color:#ddd;background:#2a2a2a;border:1px solid #454545;border-radius:5px;',
        '       padding:3px 7px;cursor:pointer;margin:0 4px 4px 0}',
        'button:hover{background:#343434}',
        'button.on{background:#0d6e6e;border-color:#12a0a0;color:#fff}',
        'button.x{background:none;border:none;font-size:14px;padding:0 2px;margin:0}',
        'select,input[type=text],textarea{font:inherit;color:#e8e8e8;background:#0f0f0f;',
        '       border:1px solid #454545;border-radius:5px;padding:2px 4px;width:100%;box-sizing:border-box}',
        'input[type=color]{width:34px;height:22px;padding:0;border:1px solid #454545;background:#0f0f0f}',
        '.row{display:flex;align-items:center;gap:6px;margin:3px 0}',
        '.lab{flex:0 0 40px;color:#9aa}',
        '.dim{color:#8d8d8d}',
        '.warn{color:#ff8b6b}',
        '.ok{color:#7fd68b}',
        '.box{border-top:1px solid #2c2c2c;margin-top:6px;padding-top:6px}',
        'textarea{height:74px;resize:vertical}',
        '.rule{display:flex;justify-content:space-between;gap:6px;padding:1px 0}',
        '.sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:middle}'
      ].join('\n')
    }));

    panel = mk('div', { cls: 'p' });

    const head = mk('div', { cls: 'h' }, [
      mk('span', { cls: 't', text: 'Tune in place' }),
      closeBtn()
    ]);

    const pickBtn = mk('button', { id: 'pick', text: '🎯 Pick element' });
    pickBtn.addEventListener('click', () => togglePick(pickBtn));

    infoEl = mk('div', { cls: 'dim', text: 'No element selected.', id: 'info' });
    contrastEl = mk('div', { cls: 'dim', text: '', id: 'contrast' });

    scopeSel = mk('select', { id: 'scope' });
    scopeSel.addEventListener('change', onScopeChange);
    customInput = mk('input', { type: 'text', id: 'custom', placeholder: '.some-class' });
    customInput.addEventListener('input', () => {
      if (scopeSel.value === '__custom') setPending(customInput.value.trim());
    });

    txtInput = mk('input', { type: 'color', id: 'txt', value: '#00ffff' });
    txtInput.addEventListener('input', () => { pending && (pending.color = txtInput.value); update(); });
    const txtHex = mk('span', { cls: 'dim', id: 'txthex' });
    txtInput.addEventListener('input', () => { txtHex.textContent = txtInput.value; });

    bgInput = mk('input', { type: 'color', id: 'bg', value: '#000000' });
    bgInput.addEventListener('input', () => {
      if (pending && !bgChk.checked) pending.bg = bgInput.value;
      update();
    });
    bgChk = mk('input', { type: 'checkbox', id: 'nobg', checked: 'checked' });
    bgChk.addEventListener('change', () => {
      bgInput.disabled = bgChk.checked;
      if (pending) pending.bg = bgChk.checked ? '' : bgInput.value;
      update();
    });
    bgInput.disabled = true;

    const saveBtn = mk('button', { id: 'save', text: '💾 Save for this host' });
    saveBtn.addEventListener('click', onSave);
    const forgetBtn = mk('button', { id: 'forget', text: 'Remove' });
    forgetBtn.addEventListener('click', onForget);
    const exportBtn = mk('button', { id: 'export', text: 'Copy JSON' });
    exportBtn.addEventListener('click', onExport);

    exportEl = mk('textarea', { id: 'exported', readonly: 'readonly', hidden: 'hidden' });
    listEl = mk('div', { cls: 'box', id: 'rules' });

    panel.appendChild(head);
    panel.appendChild(mk('div', {}, [pickBtn]));
    panel.appendChild(infoEl);
    panel.appendChild(mk('div', { cls: 'row' }, [mk('span', { cls: 'lab', text: 'apply' }), scopeSel]));
    panel.appendChild(customInput);
    panel.appendChild(mk('div', { cls: 'row' }, [
      mk('span', { cls: 'lab', text: 'text' }), txtInput, txtHex,
      mk('label', { cls: 'dim' }, [bgChk, mk('span', { text: ' leave bg' })])
    ]));
    panel.appendChild(mk('div', { cls: 'row' }, [mk('span', { cls: 'lab', text: 'bg' }), bgInput]));
    panel.appendChild(contrastEl);
    panel.appendChild(mk('div', { cls: 'box' }, [saveBtn, forgetBtn, exportBtn]));
    panel.appendChild(exportEl);
    panel.appendChild(listEl);

    shadow.appendChild(panel);
    document.documentElement.appendChild(root);
    renderRules();
  }

  function closeBtn() {
    const b = mk('button', { cls: 'x', text: '✕', title: 'close' });
    b.addEventListener('click', () => closePanel());
    return b;
  }

  function openPanel() {
    ensureRoot();
    root.style.display = '';
    renderRules();
  }

  function closePanel() {
    stopPick();
    if (root) root.style.display = 'none';
  }

  /* ──────────────────────────────────────── the element picker ──────── */
  function togglePick(btn) {
    if (picking) { stopPick(); btn.classList.remove('on'); return; }
    picking = true;
    btn.classList.add('on');
    if (!hi) {
      hi = document.createElement('div');
      hi.id = 'dm-tuner-hi';
      hi.setAttribute('style',
        'all:initial;position:fixed;pointer-events:none;z-index:2147483647;' +
        'border:2px solid #00ffff;background:rgba(0,255,255,.07);border-radius:2px;');
      document.documentElement.appendChild(hi);
    }
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  function stopPick() {
    picking = false;
    const b = shadow && shadow.getElementById('pick');
    if (b) b.classList.remove('on');
    if (hi) hi.style.display = 'none';
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function insideRoot(node) {
    return root && (node === root || root.contains(node));
  }

  function onMove(e) {
    if (!picking) return;
    if (insideRoot(e.target)) { hi.style.display = 'none'; return; }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === hi) return;
    const r = el.getBoundingClientRect();
    hi.style.display = 'block';
    hi.style.left = r.left + 'px';
    hi.style.top = r.top + 'px';
    hi.style.width = r.width + 'px';
    hi.style.height = r.height + 'px';
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    stopPick();
  }

  function onClick(e) {
    if (!picking || insideRoot(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    stopPick();
    if (el) capture(el);
  }

  function capture(el) {
    lastPick = el;
    const cs = getComputedStyle(el);
    const classes = [...el.classList]
      .filter((c) => !/^(cr-|dm-)/.test(c))
      .map((c) => ({ c: c, n: document.querySelectorAll('.' + CSS.escape(c)).length }))
      .sort((a, b) => a.n - b.n);

    const tag = el.tagName.toLowerCase();
    infoEl.textContent = tag + (el.id ? '#' + el.id : '') +
      (classes.length ? '  ·  ' + classes.length + ' class(es)' : '') + '  ·  ' + classes.map((x) => '.' + x.c + '(' + x.n + ')').join(' ');

    // scope options: this element, then each class by ascending element count
    while (scopeSel.firstChild) scopeSel.removeChild(scopeSel.firstChild);
    scopeSel.appendChild(mk('option', { value: '__this', text: 'this element only' }));
    classes.forEach((x) => {
      scopeSel.appendChild(mk('option', {
        value: '.' + x.c,
        text: '.' + x.c + '  → ' + x.n + ' element' + (x.n === 1 ? '' : 's')
      }));
    });
    scopeSel.appendChild(mk('option', { value: '__custom', text: 'custom selector…' }));

    // default scope: the class with the largest count that is still specific
    const best = classes.filter((x) => x.n > 1 && x.n <= 200).pop() || classes[0];
    pending = {
      sel: best ? '.' + best.c : (el.id ? '#' + el.id : tag),
      color: rgbToHex(cs.color),
      bg: ''
    };
    scopeSel.value = best ? '.' + best.c : '__this';
    customInput.hidden = true;
    customInput.value = '';
    txtInput.value = pending.color;
    shadow.getElementById('txthex').textContent = pending.color;
    renderRules();
    update();
  }

  function onScopeChange() {
    const v = scopeSel.value;
    customInput.hidden = v !== '__custom';
    if (v === '__this') {
      const el = lastPick;
      setPending(el ? (el.id ? '#' + el.id : el.tagName.toLowerCase()) : '');
    } else if (v === '__custom') {
      setPending(customInput.value.trim());
    } else {
      setPending(v);
    }
  }

  function setPending(sel) {
    if (!pending) pending = { sel: sel, color: txtInput.value, bg: bgChk.checked ? '' : bgInput.value };
    else pending.sel = sel;
    update();
  }

  function rgbToHex(str) {
    const c = parseRGB(str);
    if (!c) return '#ffffff';
    const h = (n) => n.toString(16).padStart(2, '0');
    return '#' + h(c[0]) + h(c[1]) + h(c[2]);
  }

  /* ─────────────────────────────── live preview + contrast ───────────── */
  function update() {
    if (!pending) return;
    scopeSel.title = pending.sel || '';
    applyRules();
    if (!lastPick || !pending.sel) { contrastEl.textContent = ''; return; }

    let target = lastPick;
    try {
      const found = document.querySelector(pending.sel);
      if (found) target = found;
    } catch (e) { /* invalid selector while typing */ }

    const backdrop = backdropOf(target);
    const fg = parseRGB(pending.color) || parseRGB(getComputedStyle(target).color) || [255, 255, 255, 1];
    const r = ratio(fg, backdrop);
    const txt = 'contrast ' + r.toFixed(1) + ':1 vs backdrop rgb(' + backdrop[0] + ',' + backdrop[1] + ',' + backdrop[2] + ')';
    contrastEl.textContent = r < 3 ? txt + ' — too low' : r < 4.5 ? txt + ' — OK for large text' : txt + ' — good';
    contrastEl.className = r < 3 ? 'warn' : r < 4.5 ? 'dim' : 'ok';
  }

  /* ────────────────────────────────── save / forget / export ─────────── */
  async function onSave() {
    if (!pending || !pending.sel) return;
    const rule = { sel: pending.sel, color: pending.color, bg: pending.bg || '' };
    const i = perHost.findIndex((r) => r.sel === rule.sel);
    if (i >= 0) perHost[i] = rule; else perHost.push(rule);
    await persist();
    pending = null;
    applyRules();
    renderRules();
    infoEl.textContent = 'Saved for ' + host + ': ' + rule.sel;
  }

  async function onForget() {
    const sel = (pending && pending.sel) || (scopeSel && scopeSel.value);
    const before = perHost.length;
    perHost = perHost.filter((r) => r.sel !== sel);
    if (perHost.length !== before) { await persist(); }
    pending = null;
    applyRules();
    renderRules();
    infoEl.textContent = perHost.length === before ? 'No saved rule for ' + sel : 'Removed ' + sel;
  }

  function onExport() {
    const payload = { host: host, rules: globalRules.concat(perHost) };
    exportEl.hidden = false;
    exportEl.value = JSON.stringify(payload, null, 2);
    exportEl.select();
    try { navigator.clipboard.writeText(exportEl.value); infoEl.textContent = 'JSON copied.'; }
    catch (e) { infoEl.textContent = 'Select-all and copy the JSON below.'; }
  }

  function renderRules() {
    if (!listEl) return;
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    const total = globalRules.length + perHost.length;
    listEl.appendChild(mk('div', {
      cls: 'dim',
      text: total ? total + ' rule(s) active here' : 'no rules saved yet'
    }));
    globalRules.concat(perHost).slice(0, 12).forEach((r) => {
      const sw = mk('span', { cls: 'sw', style: 'background:' + (r.color || '#888') });
      listEl.appendChild(mk('div', { cls: 'rule' }, [
        mk('span', { cls: 'dim' }, [sw, mk('span', { text: r.sel })]),
        mk('span', { cls: 'dim', text: (r.bg ? r.bg + ' bg' : 'text only') })
      ]));
    });
  }

  /* ─────────────────────────────────────────────── wiring ───────────── */
  try {
    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'dmTuner') { openPanel(); respond && respond({ ok: true }); }
      if (msg.type === 'dmTunerState') {
        respond && respond({ host: host, perHost: perHost.length, global: globalRules.length, open: !!(root && root.style.display !== 'none') });
      }
    });
  } catch (e) { /* no runtime in a bare page harness */ }

  // Apply anything already saved for this host, without drawing anything.
  loadRules().then(applyRules).catch(() => {});

  // Harness hook: lets a test drive the picker without a real click.
  window.__dmTuner = {
    open: openPanel,
    close: closePanel,
    capture: (el) => { ensureRoot(); capture(el); },
    state: () => ({ host: host, perHost: perHost, global: globalRules, pending: pending, css: styleEl ? styleEl.textContent : '' }),
    save: onSave
  };
})();
