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
  const TONE_ATTR = 'data-dm-tone';
  const sync = (chrome.storage && chrome.storage.sync) || null;
  const host = location.hostname.replace(/^www\./, '');

  let root = null, shadow = null, styleEl = null, panel = null;
  let picking = false, pending = null, infoEl = null, contrastEl = null, scopeSel = null, customInput = null;
  let txtInput = null, bgInput = null, bgChk = null, listEl = null, exportEl = null;
  let hi = null, perHost = [], globalRules = [], lastPick = null, mirrorEl = null, groupsEl = null;
  let lastGroups = new Map(), lastMine = '', lastKey = '', seq = 0, mo = null, moTimer = null;
  let ready = null;   // resolves once storage has been read; saves await it
  let pendingRoots = [];
  /* Baseline per element, WITH the invert parity it was measured at.
     Two bugs live here. (1) After the first sweep the element's own colour IS
     the rule's colour, so a second sweep must compare against the original.
     (2) The baseline is only true for the parity it was taken at: a page that
     gets its `filter: invert` applied late (allowlist read, or "darken this
     page" clicked after a sweep) would otherwise keep the un-inverted colour
     forever and the saved rule would never match again. */
  const toneBase = new WeakMap();

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
    const fix = (list) => (Array.isArray(list) ? list.map((r) =>
      (r && r.match === 'color' && !r.id) ? Object.assign({}, r, { id: uid() }) : r) : []);
    perHost = fix(map[host]);
    globalRules = fix(data.tuneRulesGlobal);
    return { perHost, globalRules };
  }

  async function persist() {
    const data = await sget({ tuneRulesByHost: {} });
    const map = data.tuneRulesByHost || {};
    if (perHost.length) map[host] = perHost; else delete map[host];
    await sset({ tuneRulesByHost: map, tuneRulesGlobal: globalRules });
  }

  /* ───────────────────────────────────── applying rules ──────────────── */
  /* Rules store the colour the EYE should see (intent). The page itself is
     colour-wheel inverted, so what has to be WRITTEN is the complement —
     see invertDepth() below. */
  function cssText(rules) {
    return rules
      .filter((r) => r && (r.sel || (r.match === 'color' && r.from && r.id)))
      .map((r) => {
        if (r.match === 'color') {
          /* A tone rule has no selector at all: elements are tagged by
             sweepTone() with data-dm-tone="<ruleId><o|e>", the trailing letter
             being that element's OWN invert parity. One selector for both
             parities would double-invert restored-photo subtrees, and a real
             selector cannot express "every element showing colour X" anyway —
             CSS has no colour query. */
          const emit = (suffix, conv) => {
            const parts = [];
            if (r.color) {
              parts.push('color:' + conv(r.color) + ' !important');
              // `color` alone does not move ink the site painted with
              // -webkit-text-fill-color, which is a real thing on WordPress-y
              // themes (quantamagazine: 26 elements).
              parts.push('-webkit-text-fill-color:' + conv(r.color) + ' !important');
            }
            if (r.bg) parts.push('background-color:' + conv(r.bg) + ' !important');
            /* Specificity by repetition. A site (or a rule saved by an older
               version of this extension) can carry a selector like
               `.post__content > div > … > p:nth-of-type(7)` at (0,5,6), which
               beats a plain attribute selector (0,1,0) even with !important —
               measured in Mike's profile, where a leftover 1.0.16 rule kept one
               paragraph of a 153-element group a different teal. Repeating the
               attribute costs nothing at match time and takes us to (0,8,0). */
            const sel = ':root ' + ('[' + TONE_ATTR + '="' + r.id + suffix + '"]') +
              ('[' + TONE_ATTR + ']').repeat(7);
            return parts.length ? sel + '{' + parts.join(';') + '}' : '';
          };
          return [emit('o', complementCss), emit('e', (x) => x)].filter(Boolean).join('\n');
        }
        const odd = invertDepthFor(r.sel) % 2 === 1;
        const color = r.color ? (odd ? complementCss(r.color) : r.color) : '';
        const bg = r.bg ? (odd ? complementCss(r.bg) : r.bg) : '';
        const parts = [];
        if (color) parts.push('color:' + color + ' !important');
        if (bg) parts.push('background-color:' + bg + ' !important');
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
    // Tag first? No: the stylesheet must exist before tagging, so the attribute
    // immediately has a rule to attach to. Sweep after writing, then re-sweep
    // anything the observer sees appear later.
    syncUiFilter();
    sweepTone();
    ensureObserve();
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
    groupsEl = mk('div', { cls: 'dim', text: '', id: 'groups' });
    contrastEl = mk('div', { cls: 'dim', text: '', id: 'contrast' });
    mirrorEl = mk('div', { cls: 'dim', text: '', id: 'mirror' });

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
    panel.appendChild(groupsEl);
    panel.appendChild(mk('div', { cls: 'row' }, [mk('span', { cls: 'lab', text: 'apply' }), scopeSel]));
    panel.appendChild(customInput);
    panel.appendChild(mk('div', { cls: 'row' }, [
      mk('span', { cls: 'lab', text: 'text' }), txtInput, txtHex,
      mk('label', { cls: 'dim' }, [bgChk, mk('span', { text: ' leave bg' })])
    ]));
    panel.appendChild(mk('div', { cls: 'row' }, [mk('span', { cls: 'lab', text: 'bg' }), bgInput]));
    panel.appendChild(contrastEl);
    panel.appendChild(mirrorEl);
    panel.appendChild(mk('div', { cls: 'box' }, [saveBtn, forgetBtn, exportBtn]));
    panel.appendChild(exportEl);
    panel.appendChild(listEl);

    shadow.appendChild(panel);
    document.documentElement.appendChild(root);
    syncUiFilter();
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
    syncUiFilter();
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
      syncUiFilter();
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
    const mine = rendersOf(el) || renderedAs(rgbToHex(getComputedStyle(el).color), el);
    lastMine = mine;
    lastGroups = colourGroups();
    const groups = sortedGroups();
    const dom = groups.length ? groups[0][0] : '';
    const mineGroup = lastGroups.get(mine) || { n: 0, chars: 0, tags: {} };
    const domGroup = dom ? lastGroups.get(dom) : null;

    const classes = [...el.classList]
      .filter((c) => !/^(cr-|dm-)/.test(c))
      .map((c) => ({ c: c, n: document.querySelectorAll('.' + CSS.escape(c)).length }))
      .sort((a, b) => a.n - b.n);

    const tag = el.tagName.toLowerCase();
    infoEl.textContent = tag + (el.id ? '#' + el.id : '') + (classes.length
      ? '  ·  ' + classes.length + ' class(es)  ·  ' +
        classes.map((x) => '.' + x.c + '(' + x.n + ')').join(' ')
      : '  ·  no class');

    // the sweep the user asked for: what colour is this, and how much text shares it
    if (groupsEl) {
      const n = (h) => (lastGroups.get(h) ? lastGroups.get(h).n : 0);
      groupsEl.textContent = groups.length
        ? (dom === mine
            ? n(dom) + ' elements show ' + dom + '  ·  ' + groups.length + ' text colours'
            : 'dominant ' + dom + ' ×' + n(dom) + '  ·  this ' + mine + ' ×' + n(mine) +
              '  ·  ' + groups.length + ' colours')
        : '';
    }

    // scope options: this element, this colour, the dominant colour, classes, custom
    while (scopeSel.firstChild) scopeSel.removeChild(scopeSel.firstChild);
    scopeSel.appendChild(mk('option', { value: '__this', text: 'this element only' }));
    if (mineGroup.n >= 2) {
      scopeSel.appendChild(mk('option', {
        value: '__tone',
        text: '≈ all text ' + mine + '  → ' + mineGroup.n + ' element' + (mineGroup.n === 1 ? '' : 's') +
              (mine === dom ? ' (dominant)' : ' (this colour)')
      }));
    }
    if (dom && dom !== mine && domGroup && domGroup.n >= 2) {
      scopeSel.appendChild(mk('option', {
        value: '__tone:' + dom,
        text: '≈ all text ' + dom + '  → ' + domGroup.n + ' (dominant)'
      }));
    }
    classes.forEach((x) => {
      scopeSel.appendChild(mk('option', {
        value: '.' + x.c,
        text: '.' + x.c + '  → ' + x.n + ' element' + (x.n === 1 ? '' : 's')
      }));
    });
    scopeSel.appendChild(mk('option', { value: '__custom', text: 'custom selector…' }));

    /* Default scope. A class is preferred only when it actually reaches
       further than a single element — a page where every paragraph carries its
       own class makes the class list useless, and the colour group is the only
       thing that describes "the body text". */
    const best = classes.filter((x) => x.n > 1 && x.n <= 200).pop() || classes[0];
    let defVal;
    if (mineGroup.n >= 8 && mine === dom && (!best || best.n < mineGroup.n * 0.5)) defVal = '__tone';
    else if (best) defVal = '.' + best.c;
    else if (mineGroup.n >= 8) defVal = '__tone';
    else defVal = '__this';

    pending = null;
    txtInput.value = mine;               // seed the knob with what this element shows
    shadow.getElementById('txthex').textContent = mine;
    if (defVal.indexOf('__tone:') === 0) applyTone(defVal.slice(7));
    else if (defVal === '__tone') applyTone(mine);
    else setPending(defVal === '__this' ? uniqueSelectorFor(el) : defVal);
    scopeSel.value = defVal;

    customInput.hidden = true;
    customInput.value = '';
    renderRules();
    update();
  }

  function onScopeChange() {
    const v = scopeSel.value;
    customInput.hidden = v !== '__custom';
    if (v === '__tone') {
      applyTone(lastMine);
    } else if (v.indexOf('__tone:') === 0) {
      applyTone(v.slice(7));
    } else if (v === '__this') {
      const el = lastPick;
      setPending(el ? uniqueSelectorFor(el) : '');
    } else if (v === '__custom') {
      setPending(customInput.value.trim());
    } else {
      setPending(v);
    }
  }

  /** Switch `pending` to a colour-group rule: "every element showing `from`". */
  function applyTone(from) {
    const color = (pending && pending.color) || txtInput.value || '#00ffff';
    const bg = pending ? (pending.bg || '') : (bgChk.checked ? '' : bgInput.value);
    pending = {
      id: (pending && pending.match === 'color' && pending.id) || uid(),
      match: 'color',
      from: from,
      color: color,
      bg: bg || ''
    };
    lastKey = ruleKey(pending);
    update();
  }

  function setPending(sel) {
    const color = (pending && pending.color) || txtInput.value || '#00ffff';
    const bg = pending ? (pending.bg || '') : (bgChk.checked ? '' : bgInput.value);
    pending = { sel: sel, color: color, bg: bg || '' };
    lastKey = ruleKey(pending);
    update();
  }

  /** Stable identity for a rule: a tone rule is "text colour X", not a selector. */
  function ruleKey(r) {
    if (!r) return '';
    return r.match === 'color' ? 'tone:' + r.from : (r.sel || '');
  }

  function rgbToHex(str) {
    const c = parseRGB(str);
    if (!c) return '#ffffff';
    const h = (n) => n.toString(16).padStart(2, '0');
    return '#' + h(c[0]) + h(c[1]) + h(c[2]);
  }

  /* "This element only" must actually mean ONE element. A classless, id-less
     element used to fall back to its tag name, so scoping a single heading
     quietly restyled every <strong> in the article (measured on quantamagazine:
     `strong` matched 3, and the same fallback runs to dozens on long pages).
     Build a path upward, testing after every step, and stop at the first one
     that matches exactly one element. Ancestors contribute their first class
     too — Quanta ships the same article twice (mobile + desktop), so a purely
     positional path stops being unique at the wrapper that differs. */
  function stepFor(node) {
    const tag = node.tagName.toLowerCase();
    let cls = '';
    if (node.classList && node.classList.length) {
      const own = [...node.classList].filter((c) => !/^(cr-|dm-)/.test(c));
      if (own.length) cls = '.' + CSS.escape(own[0]);
    }
    const parent = node.parentElement;
    if (!parent) return tag + cls;
    const same = [...parent.children].filter((c) => c.tagName === node.tagName);
    const nth = same.length > 1 ? ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : '';
    return tag + cls + nth;
  }

  function uniqueSelectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      parts.unshift(stepFor(node));
      const sel = parts.join(' > ');
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch (e) { /* keep climbing */ }
      if (parts.length >= 12) break;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  /* ─────────── colour-wheel inversion: intent vs what gets written ──────
     content.css puts `filter: invert(1)` on html.cr-dark, and re-inverts media
     (img/video/canvas/…) and restored background-photo elements so they keep
     their true colours — those subtrees therefore carry TWO inverts (net
     identity), not one.

     The colour that RENDERS is the complement of the colour written, per odd
     invert above the element. So picking cyan wrote #00ffff and the page showed
     #ff0000 — "the picker is colour-wheel mirrored". Fixed by storing intent
     and complementing on the way into the stylesheet, measured per selector so
     a restored photo subtree is left alone. */
  function invertDepth(el) {
    let n = 0;
    let node = el;
    while (node && node.nodeType === 1) {
      const f = getComputedStyle(node).filter;
      if (f && f !== 'none' && /invert\(\s*(?:1|100%)\s*\)/.test(f)) n++;
      node = node.parentElement;
    }
    return n;
  }

  // Selector not painted yet (typing, dynamic) -> assume the page-level count.
  function invertDepthFor(sel) {
    let el = null;
    try { el = sel ? document.querySelector(sel) : null; } catch (e) { el = null; }
    return invertDepth(el || document.documentElement);
  }

  function complementCss(str) {
    const c = parseRGB(str);
    if (!c) return str;
    const r = 255 - c[0], g = 255 - c[1], b = 255 - c[2];
    if (/^#[0-9a-f]{3}$/i.test(str) || /^#[0-9a-f]{6}$/i.test(str)) {
      const h = (n) => n.toString(16).padStart(2, '0');
      return '#' + h(r) + h(g) + h(b);
    }
    return 'rgba(' + r + ',' + g + ',' + b + ',' + c[3] + ')';
  }

  // The colour an element actually shows to the viewer.
  function renderedAs(str, el) {
    return el && invertDepth(el) % 2 === 1 ? complementCss(str) : str;
  }

  /* ═══════════════════ matching by COLOUR instead of by class ═════════════

     Measured on quantamagazine (2026-11-11): the article's paragraphs are bare
     <p> elements with NO class at all, so the picker only offered "this element
     only" and a hand-typed selector — one of 186 text elements could be
     recoloured, and 185 stayed white. Nothing selector-shaped could fix that:
     the page expresses body text as ~140 elements spread over span/p/h2/a/em/
     strong/h3 with one thing in common, which is the colour they render.

     So a second rule kind exists — a TONE rule, no selector:

         {id:'r3', match:'color', from:'#e5e5e5', color:'#00ffff', bg:''}

     `from` is the colour the EYE sees (rendered space, same convention as
     `color`). sweepTone() walks the text-owning elements, compares each
     element's baseline rendered colour, and tags matches with

         data-dm-tone="r3o"   (odd invert depth -> cssText writes complement)
         data-dm-tone="r3e"   (even depth, i.e. inside a restored photo)

     Tagging, not inline styles: the attribute is undone by removing it, it
     survives a rule colour change, and it costs one stylesheet rule for every
     element that matches. */
  function uid() { return 'r' + (++seq) + Math.floor(Math.random() * 1296).toString(36); }

  function sameHex(a, b) {
    const x = parseRGB(a), y = parseRGB(b);
    if (!x || !y) return false;
    if (x[3] < 0.999 || y[3] < 0.999) return false;   // translucent: not comparable
    return x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
  }

  /** Rendered (eye) colour of an element as #rrggbb, or '' if not measurable. */
  function rendersOf(el) {
    if (!el || el.nodeType !== 1) return '';
    const tagged = el.hasAttribute(TONE_ATTR);
    const cached = toneBase.get(el);
    let cs;
    try { cs = getComputedStyle(el); } catch (e) { return tagged && cached ? cached.c : ''; }
    /* The visible ink is `-webkit-text-fill-color` when the site sets it — 26
       elements on the Quanta article paint #1a1a1a that way, and writing only
       `color` left them unchanged. A TRANSPARENT fill is a background-clip
       gradient (text over a painterly background); repainting those would
       destroy the effect, so they are not measurable and are skipped. */
    const ink = cs.webkitTextFillColor || cs.color;
    const rgb = parseRGB(ink);
    if (!rgb || rgb[3] < 0.999) return tagged && cached ? cached.c : '';
    /* CACHE RULES, and getting them wrong is what made a saved rule half-apply
       on reload. While an element carries OUR attribute its live colour is our
       paint, so the baseline is the only truth. While it does not, the live
       colour is the PAGE's — measure it, even if a baseline exists: the first
       sweeps run during parsing, before the site's own stylesheet has been
       applied, so an early baseline is often the browser default and would
       otherwise stick forever (measured: 87 of 200 elements tagged). */
    if (tagged && cached) return cached.c;
    const parity = invertDepth(el) % 2;
    const shown = parity === 1
      ? [255 - rgb[0], 255 - rgb[1], 255 - rgb[2]]
      : [rgb[0], rgb[1], rgb[2]];
    const h = (n) => n.toString(16).padStart(2, '0');
    const hex = '#' + h(shown[0]) + h(shown[1]) + h(shown[2]);
    // Only remember colours that are the PAGE's, never the ones we painted.
    if (!tagged) toneBase.set(el, { c: hex, p: parity });
    return hex;
  }

  /* Elements that own text but never PAINT it. A <script> holds its source as a
     text node, so without this filter the sweep tags every analytics blob on the
     page and the panel's "208 elements" is inflated by 12 widgets the user can
     never see. Measured on quantamagazine: 193 real + 12 script + 1 audio. The
     `i` flag matters: SVG's <title> — 28 of them on that page, one per icon —
     reports a LOWERCASE tagName, while HTML's reports uppercase. */
  const NON_TEXT_TAGS = /^(script|style|noscript|template|title|meta|link|base|head|path|defs)$/i;

  function ownsText(el) {
    if (NON_TEXT_TAGS.test(el.tagName)) return false;
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
    }
    return false;
  }

  function toneRules() {
    return globalRules.concat(perHost).concat(pending ? [pending] : [])
      .filter((r) => r && r.match === 'color' && r.from && r.id);
  }

  function clearStaleTones(live) {
    const marked = document.querySelectorAll('[' + TONE_ATTR + ']');
    for (let i = 0; i < marked.length; i++) {
      const v = marked[i].getAttribute(TONE_ATTR) || '';
      if (!live.has(v.slice(0, -1))) marked[i].removeAttribute(TONE_ATTR);
    }
  }

  /** Tag every text-owning element under `scope` whose baseline colour matches. */
  function sweepTone(scope) {
    const rules = toneRules();
    if (!rules.length) {
      if (!scope) clearStaleTones(new Set());
      return 0;
    }
    const live = new Set(rules.map((r) => r.id));
    if (!scope) clearStaleTones(live);

    const start = scope || document.body || document.documentElement;
    if (!start || start.nodeType !== 1) return 0;
    const all = [start].concat(Array.prototype.slice.call(start.querySelectorAll('*'), 0, 8000));
    let tagged = 0;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el.id === ROOT_ID || !ownsText(el)) continue;
      const base = rendersOf(el);
      if (!base) continue;
      const hit = rules.filter((r) => sameHex(r.from, base))[0];
      const want = hit ? hit.id + (invertDepth(el) % 2 === 1 ? 'o' : 'e') : '';
      const has = el.getAttribute(TONE_ATTR);
      if (want) {
        if (has !== want) el.setAttribute(TONE_ATTR, want);
        tagged++;
      } else if (has) {
        el.removeAttribute(TONE_ATTR);
      }
    }
    return tagged;
  }

  /* Pages fill in AFTER document_start and single-page sites swap whole
     sections. Watch for NEW nodes only (not attributes — we write one, which
     would loop).

     THE BUG THIS REPLACED (1.0.18, reported by Mike as "saved the colour, reloaded,
     nothing came back"): the callback did `clearTimeout(moTimer)` on every batch
     and waited 250 ms for quiet before sweeping. A busy page never goes quiet —
     quantamagazine kept mutating past the 3 s mark — so the timer was reset
     forever and the first sweep never ran. Measured on a real cold load: 0
     elements tagged, and a manual sweep the same instant tagged 193. Never
     reset a timer that is doing work; coalesce without dropping. */
  function ensureObserve() {
    if (mo || !window.MutationObserver || !document.documentElement) return;
    mo = new MutationObserver((recs) => {
      if (!toneRules().length) return;
      for (let i = 0; i < recs.length; i++) {
        const added = recs[i].addedNodes;
        for (let j = 0; j < added.length; j++) {
          if (added[j].nodeType === 1 && added[j].id !== ROOT_ID) pendingRoots.push(added[j]);
        }
      }
      scheduleSweep();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    // Belt and braces: the parser's own insertions arrive as mutations, but a
    // document-lifecycle sweep cannot be starved by anything.
    ['DOMContentLoaded', 'load'].forEach((ev) => {
      document.addEventListener(ev, () => sweepTone(), true);
    });
  }

  function scheduleSweep() {
    if (moTimer) return;                 // one pending sweep, never postponed
    moTimer = setTimeout(() => {
      moTimer = null;
      const roots = pendingRoots;
      pendingRoots = [];
      for (let i = 0; i < roots.length; i++) sweepTone(roots[i]);
    }, 120);
  }

  /** Rendered colour -> how many text elements show it (the "dominant" one wins). */
  function colourGroups() {
    const map = new Map();
    const body = document.body;
    if (!body) return map;
    const all = Array.prototype.slice.call(body.querySelectorAll('*'), 0, 8000);
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!ownsText(el)) continue;
      const c = rendersOf(el);
      if (!c) continue;
      const g = map.get(c) || { n: 0, chars: 0, tags: {} };
      g.n++;
      g.chars += (el.textContent || '').trim().length;
      const t = el.tagName.toLowerCase();
      g.tags[t] = (g.tags[t] || 0) + 1;
      map.set(c, g);
    }
    return map;
  }

  function sortedGroups() {
    return [...lastGroups.entries()].sort((a, b) => (b[1].n - a[1].n));
  }

  function dominantColour() {
    const s = sortedGroups();
    return s.length ? s[0][0] : '';
  }

  /* Our own UI is a child of <html>, so the page filter paints IT too — the
     panel came up as a light-grey box with salmon buttons and a mirrored
     swatch. One invert on the panel and on the hover outline cancels it, which
     is also what makes the swatch show the colour that will be produced. */
  function syncUiFilter() {
    const odd = invertDepth(document.documentElement) % 2 === 1;
    const f = odd ? 'invert(1)' : 'none';
    if (root) root.style.filter = f;
    if (hi) hi.style.filter = f;
    return odd;
  }

  /* ─────────────────────────────── live preview + contrast ───────────── */
  function update() {
    if (!pending) return;
    scopeSel.title = pending.sel || ('text colour ' + pending.from);
    applyRules();
    if (!lastPick) { contrastEl.textContent = ''; return; }

    let target = lastPick;
    if (pending.sel) {
      try {
        const found = document.querySelector(pending.sel);
        if (found) target = found;
      } catch (e) { /* invalid selector while typing */ }
    }

    // Measure in RENDERED space: pending.color is intent, and on an inverted
    // page the backdrop the eye sees is the complement of the one
    // getComputedStyle reports. A uniform invert preserves the ratio itself, so
    // this changes only the printed numbers — but they now match the screen.
    const odd = invertDepth(target) % 2 === 1;
    const raw = backdropOf(target);
    const backdrop = odd ? [255 - raw[0], 255 - raw[1], 255 - raw[2], raw[3]] : raw;
    const fg = parseRGB(pending.color) || parseRGB(getComputedStyle(target).color) || [255, 255, 255, 1];
    const r = ratio(fg, backdrop);
    const txt = 'contrast ' + r.toFixed(1) + ':1 vs backdrop rgb(' + backdrop[0] + ',' + backdrop[1] + ',' + backdrop[2] + ')';
    contrastEl.textContent = r < 3 ? txt + ' — too low' : r < 4.5 ? txt + ' — OK for large text' : txt + ' — good';
    contrastEl.className = r < 3 ? 'warn' : r < 4.5 ? 'dim' : 'ok';
    if (mirrorEl) {
      mirrorEl.textContent = (odd && pending.color)
        ? 'page inverted · writes ' + complementCss(pending.color).toLowerCase() +
          ' to render ' + String(pending.color).toLowerCase()
        : '';
    }
  }

  /* ────────────────────────────────── save / forget / export ─────────── */
  /* "Save for this host" has to mean the page comes back the way you left it.
     A tuning rule on a site that is not in `darkHosts` is a trap: on reload the
     page is not inverted, so the rule's colour (recorded as the colour the eye
     saw on a DARKENED page) matches nothing — which is exactly what Mike hit,
     "or darken". So saving a rule also remembers the site, using the same key
     content.js reads, and switches the engine on now if it is off. */
  async function rememberHost() {
    const isDark = () => document.documentElement.classList.contains('cr-dark') ||
                         document.documentElement.classList.contains('cr-repaint');
    try {
      chrome.storage.sync.get('darkHosts', (got) => {
        const hosts = (got && got.darkHosts) || {};
        if (hosts[host]) return;
        hosts[host] = true;
        chrome.storage.sync.set({ darkHosts: hosts });
      });
    } catch (e) { /* no storage in a bare harness */ }
    if (!isDark()) {
      if (window.__darkMode && typeof window.__darkMode.apply === 'function') {
        window.__darkMode.apply();               // the engine's own apply()
      } else {
        document.documentElement.classList.add('cr-dark');
      }
      syncUiFilter();
      return true;
    }
    return false;
  }

  async function onSave() {
    if (ready) await ready;          // storage read must precede the push, or
    if (!pending || !ruleKey(pending)) return;   // loadRules clobbers perHost
    const rule = pending.match === 'color'
      ? { id: pending.id, match: 'color', from: pending.from, color: pending.color, bg: pending.bg || '' }
      : { sel: pending.sel, color: pending.color, bg: pending.bg || '' };
    const k = ruleKey(rule);
    const i = perHost.findIndex((r) => ruleKey(r) === k);
    if (i >= 0) perHost[i] = rule; else perHost.push(rule);
    await persist();
    const darkened = await rememberHost();     // the page must come back dark too
    pending = null;
    applyRules();                              // parity may have just changed
    renderRules();
    infoEl.textContent = 'Saved for ' + host + ': ' +
      (rule.match === 'color' ? 'all text ' + rule.from : rule.sel) +
      (darkened ? '  ·  site now darkened + remembered' : '  ·  site already remembered');
  }

  async function onForget() {
    if (ready) await ready;
    const sel = ruleKey(pending) || lastKey;
    const before = perHost.length;
    perHost = perHost.filter((r) => ruleKey(r) !== sel);
    if (perHost.length !== before) { await persist(); }
    pending = null;
    applyRules();
    renderRules();
    infoEl.textContent = perHost.length === before
      ? 'No saved rule for ' + sel
      : 'Removed ' + sel.replace(/^tone:/, 'all text ');
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
      const label = r.match === 'color'
        ? '≈ all text ' + r.from + ' (' + document.querySelectorAll('[' + TONE_ATTR + ']').length + ' tagged)'
        : r.sel;
      listEl.appendChild(mk('div', { cls: 'rule' }, [
        mk('span', { cls: 'dim' }, [sw, mk('span', { text: label })]),
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
  // `ready` is what onSave/onForget await: pushing a rule before this resolves
  // gets the array replaced underneath them by loadRules().
  //
  // A host that HAS tuning rules is by definition meant to be dark: remembering
  // it here repairs the state 1.0.17 could produce (rule saved, host never added
  // to darkHosts), where the reloaded page came back light and the colour rule —
  // recorded in the colours of a darkened page — matched nothing. Measured in
  // Mike's live profile on 2026-11-11: two rules for quantamagazine.org, no
  // darkHosts entry, hence "it didn't reassert … or darken".
  ready = loadRules().then(async () => {
    if (perHost.length) await rememberHost();
    applyRules();
  }).catch(() => {});

  // Harness hook: lets a test drive the picker without a real click.
  window.__dmTuner = {
    open: openPanel,
    close: closePanel,
    capture: (el) => { ensureRoot(); capture(el); },
    state: () => ({
      host: host, perHost: perHost, global: globalRules, pending: pending,
      css: styleEl ? styleEl.textContent : '',
      tagged: document.querySelectorAll('[' + TONE_ATTR + ']').length
    }),
    /* colour-sweep surface: the same code paths the panel buttons hit */
    scope: (v) => { scopeSel.value = v; onScopeChange(); },
    tone: (from, colour) => {
      applyTone(from);
      if (colour) { txtInput.value = colour; pending.color = colour; update(); }
    },
    groups: () => [...lastGroups.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([c, v]) => ({ colour: c, n: v.n, chars: v.chars, tags: v.tags })),
    sweep: () => sweepTone(),
    save: onSave,
    forget: onForget
  };
})();
