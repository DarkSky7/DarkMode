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
  let hi = null, perHost = [], globalRules = [], lastPick = null, mirrorEl = null, groupsEl = null, verifyEl = null;
  let coverageEl = null, coverBtn = null;
  let lastGroups = new Map(), lastMine = '', lastKey = '', seq = 0, mo = null, moTimer = null, covTimer = null;
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
      (r && (r.match === 'color' || r.match === 'light') && !r.id) ? Object.assign({}, r, { id: uid() }) : r) : []);
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
      .filter((r) => r && (r.sel || ((r.match === 'color' || r.match === 'light') && r.id)))
      .map((r) => {
        if (r.match === 'color' || r.match === 'light') {
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
            /* BOLD INSTEAD OF BRIGHT (2026-11-16). Mike: "*dim the default cyan
               closer to the colors used in this conversation*", then of the first
               dim attempt: "*the more greenish hue is still kind of bright*", then
               "*maybe just bold?*". That is the right instinct: at #3e738b the ink
               is 3.80:1 on a near-black page -- fine for a word, tiring to hunt for
               at 400 weight. Stem weight buys the legibility that brightness was
               being spent on, so the page stops glowing. Applies to the LIGHT rule
               only: an explicit colour pick is the user matching something on the
               page, and silently thickening it would change a design they chose. */
            if (r.match === 'light') parts.push('font-weight:' + LIGHT_WEIGHT + ' !important');
            /* Specificity by repetition. A site (or a rule saved by an older
               version of this extension) can carry a selector like
               `.post__content > div > … > p:nth-of-type(7)` at (0,5,6), which
               beats a plain attribute selector (0,1,0) even with !important —
               measured in Mike's profile, where a leftover 1.0.16 rule kept one
               paragraph of a 153-element group a different teal. Repeating the
               attribute costs nothing at match time and takes us to (0,8,0). */
            const attr = '[' + TONE_ATTR + '="' + r.id + suffix + '"]' +
              ('[' + TONE_ATTR + ']').repeat(7);
            const out = [];
            if (parts.length) out.push(':root ' + attr + '{' + parts.join(';') + '}');
            if (r.color) {
              /* SVG text paints with `fill` and ignores `color` outright, so a
                 gauge's own labels would tag and stay the same colour. Scoped
                 to `text` elements ONLY — a descendant `*` fill rule would
                 recolour every icon inside a tagged span. */
              out.push(':root text' + attr + '{fill:' + conv(r.color) + ' !important}');
              out.push(':root ' + attr + ' text{fill:' + conv(r.color) + ' !important}');
            }
            return out.join('\n');
          };
          return [emit('o', complementCss), emit('e', (x) => x)].filter(Boolean).join('\n');
        }
        const odd = invertDepthFor(r.sel) % 2 === 1;
        const color = r.color ? (odd ? complementCss(r.color) : r.color) : '';
        const bg = r.bg ? (odd ? complementCss(r.bg) : r.bg) : '';
        const parts = [];
        if (color) {
          parts.push('color:' + color + ' !important');
          /* The tone rules have emitted this since 1.0.17; the single-element
             rules did not, so an element whose ink the SITE painted with
             -webkit-text-fill-color kept its colour no matter what was picked —
             `color` does not move text-fill-color ink. Same fix, same reason. */
          parts.push('-webkit-text-fill-color:' + color + ' !important');
        }
        if (bg) parts.push('background-color:' + bg + ' !important');
        if (!parts.length) return '';
        /* Specificity, for "this element only" (2026-11-16).
           This branch used to emit `sel{…}` at the selector's own weight, so any
           site rule with a heavier selector beat it even with !important — and
           every big site ships one (AliExpress order rows: `.order-item .title`
           class chains, cards nested four deep). Result: the rule was written,
           the panel showed a colour, and NOTHING on screen changed. That is the
           "selecting a single element isn't helping" report.
           `x:is(x):is(x)` multiplies specificity by three while matching exactly
           the same elements (an element matches :is(x) iff it matches x), which
           is the cheapest way to outrank a site without changing the blast
           radius. EIGHT copies, not three: specificity is compared field by
           field, so `p.spec2` (0,1,1) repeated three times is (0,3,3) and still
           LOSES to a site rule like `.wrap2 .deep2 p.spec2:nth-of-type(1)` at
           (0,4,1) — class count decides. Measured 2026-11-16: the three-copy
           version left the element exactly the site's colour. Eight copies
           match the (0,8,0) the tone rules already reach by repeating their
           attribute. */
        let sel = r.sel;
        if (sel.indexOf('::') === -1) {          // :is() around a pseudo-element is invalid
          try {
            document.querySelector(sel);         // throws on a malformed selector
            sel = sel + (':is(' + sel + ')').repeat(7);
          } catch (e) { /* leave the rule exactly as written */ }
        }
        return sel + '{' + parts.join(';') + '}';
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
    verifyEl = mk('div', { cls: 'dim', text: '', id: 'verify' });

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

    /* Coverage + the one-click reach. "73 still light" is the sentence the
       panel could not say before, and the button is the answer to "we need a
       way to reach more classes": it widens the rule to a luminance threshold
       instead of asking the user to guess which class is left over. */
    coverageEl = mk('div', { cls: 'dim', id: 'coverage', text: '' });
    coverBtn = mk('button', { id: 'cover', hidden: 'hidden', text: '⚡ Also cover everything light' });
    coverBtn.addEventListener('click', () => {
      if (!pending) return;
      applyLight();
      if (scopeSel.querySelector('option[value="__light"]')) scopeSel.value = '__light';
      update();
    });

    panel.appendChild(head);
    panel.appendChild(mk('div', {}, [pickBtn]));
    panel.appendChild(infoEl);
    panel.appendChild(groupsEl);
    panel.appendChild(coverageEl);
    panel.appendChild(mk('div', {}, [coverBtn]));
    panel.appendChild(mk('div', { cls: 'row' }, [mk('span', { cls: 'lab', text: 'apply' }), scopeSel]));
    panel.appendChild(customInput);
    panel.appendChild(mk('div', { cls: 'row' }, [
      mk('span', { cls: 'lab', text: 'text' }), txtInput, txtHex,
      mk('label', { cls: 'dim' }, [bgChk, mk('span', { text: ' leave bg' })])
    ]));
    panel.appendChild(mk('div', { cls: 'row' }, [mk('span', { cls: 'lab', text: 'bg' }), bgInput]));
    panel.appendChild(contrastEl);
    panel.appendChild(mirrorEl);
    panel.appendChild(verifyEl);
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
    renderCoverage();
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
    /* The reach option. On Mike's dashboard "all text #cecdc9" covered the big
       numbers but not every label, because a handful of labels render a shade
       that rounds differently after inversion — and no list of exact colours
       can ever be complete on a page that keeps repainting values from an API.
       One threshold covers all of them, now and after the next render. */
    let lightTotal = 0, lightColours = 0;
    lastGroups.forEach((g, h) => { if (inkNeedsAccent(h)) { lightTotal += g.n; lightColours++; } });
    if (lightTotal >= 2) {
      scopeSel.appendChild(mk('option', {
        value: '__light',
        text: '≈ everything light  → ' + lightTotal + ' elements in ' + lightColours +
              ' colour' + (lightColours === 1 ? '' : 's') + ' (widest reach)'
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

    /* Default scope. A class is preferred only when it reaches essentially the
       WHOLE colour group — it used to win at 50% of it, which is how `.fdp-val`
       (56 elements) beat "all text #cecdc9" (129) on the ambientweather
       dashboard: the numbers recoloured and 73 white labels did not, and there
       was nothing on screen saying so. Markup classes are a coincidence of how
       a site was built; the colour is what the user is pointing at. */
    const best = classes.filter((x) => x.n > 1 && x.n <= 200).pop() || classes[0];
    let defVal;
    const classCoversGroup = best && best.n >= mineGroup.n * 0.9;
    if (mineGroup.n >= 5 && !classCoversGroup) defVal = '__tone';
    else if (best) defVal = '.' + best.c;
    else if (mineGroup.n >= 8) defVal = '__tone';
    else defVal = '__this';

    pending = null;
    /* Grey seeds cyan too, not only near-white, and it uses THE SAME test the
       sweep uses -- so the knob can never "replace" an element with the colour
       it is already showing, and a mid-grey click offers cyan like a white one
       does. */
    const seed = inkNeedsAccent(mine) ? DEFAULT_INK : mine;
    txtInput.value = seed;
    shadow.getElementById('txthex').textContent =
      seed === mine ? mine : mine + '  →  ' + seed;
    if (defVal.indexOf('__tone:') === 0) applyTone(defVal.slice(7));
    else if (defVal === '__tone') applyTone(mine);
    else setPending(defVal === '__this' ? uniqueSelectorFor(el) : defVal);
    scopeSel.value = defVal;
    /* applyTone/applyLight seed pending.color from `mine`; carry the cyan seed
       through so the first render already writes it. */
    if (pending && seed !== mine) { pending.color = seed; update(); }

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
    } else if (v === '__light') {
      applyLight();
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

  /** Threshold rule: "every text element that is light", whatever its colour. */
  function applyLight() {
    const color = (pending && pending.color) || txtInput.value || '#00ffff';
    const bg = pending ? (pending.bg || '') : (bgChk.checked ? '' : bgInput.value);
    pending = {
      id: (pending && pending.match === 'light' && pending.id) || uid(),
      match: 'light',
      from: '',
      color: color,
      bg: bg || '',
      min: LIGHT_MIN
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
    if (r.match === 'light') return 'light';
    if (r.match === 'color') return 'tone:' + r.from;
    return r.sel || '';
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

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function isSvgText(el) {
    return !!el && el.namespaceURI === SVG_NS && /^text$/i.test(el.tagName);
  }

  /* "Light" is the only thing left after an exact colour stops being enough.
     Mike, 2026-11-11, pointing at the ambientweather dashboard: *"after
     selecting the numeric Fahrenheit temperature, and selecting a color, a
     bunch of numeric text switched (as it should), but lots of non-numeric
     text stayed white. We need a way to reach more classes."* Every piece of
     text on that page that the eye reads as white really is one colour
     (#cecdc9 = the inverted #313236), but the CONTROL he reached for was a
     class, and a class is a coincidence of markup: `.fdp-val` covered 56 of
     the 129 light-text elements, so the values recoloured and the labels did
     not. A threshold rule covers the whole page no matter how many colours or
     classes the site uses, and it keeps covering text the site adds later.
     WCAG relative luminance. 0.45 was the old floor and it was simply wrong:
     on an INVERTED page every site-dark colour renders light, so the greys
     that actually appear on screen are the site's own light greys -- measured
     on the AliExpress cart (2026-11-16): #8a8a8a (L 0.254) x57 and #dddddd
     (L 0.723) x14 were all skipped, because a page whose ink renders mid-grey
     on near-black is exactly the page where grey needs replacing. 0.15 is
     above the near-black backdrop (#111 = 0.006) and below the greys these
     sites ship, so "grey text" now means grey text.
     NEUTRALITY IS NEW and load-bearing. Lowering the floor alone would have
     swept up every saturated colour that happens to be bright -- links,
     prices, sale badges -- and turned them cyan. "White or grey" means the
     channels agree (spread <= 14/255); anything with real chroma keeps its hue
     unless it is bright enough to read as white regardless (L >= 0.62). */
  const LIGHT_MIN = 0.15;
  /* NEUTRALITY IS A SATURATION TEST, NOT A CHANNEL-SPREAD TEST. The first
     version allowed spread <= 14/255, which silently excluded the warm greys
     these sites actually use: AliExpress renders 87 elements at #9f9b8d
     (spread 18) -- light grey with a warm cast -- and both the coverage count
     and the post-paint check called them "not neutral", so they agreed the page
     was complete while 87 grey items sat unrecoloured. HSL saturation is
     hue-independent and scale-aware: #9f9b8d is 8.6% saturated, a grey; a sale
     badge at #fe76be is 100%, untouched; bright yellow (#ffff00) is 100% and
     stays yellow instead of being mistaken for white. */
  const NEUTRAL_SAT = 0.20;
  function saturation(hex) {
    const c = parseRGB(hex);
    if (!c) return 1;
    const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d === 0) return 0;
    const l = (mx + mn) / 2;
    return d / (1 - Math.abs(2 * l - 1));
  }
  function inkIsNeutral(hex) {
    return !!parseRGB(hex) && saturation(hex) <= NEUTRAL_SAT;
  }
  /* The knob used to be seeded with whatever colour the element already shows,
     which makes "replace this white with a colour" a no-op until you notice the
     swatch. Near-white ink therefore seeds CYAN; anything else keeps its own
     colour, so nudging an accent stays a nudge. */
  /* #4a7f9e, not #00ffff and not the first attempt (2026-11-16). Bright cyan at
     15.79:1 on a near-black page is exhausting for a whole page of text; Mike
     asked for the blue-cyan his own UI uses for code and links, then said the
     first replacement still read "greenish and kind of bright". The accent in
     his screenshot measures hue ~198 deg, mean #3e738b (3.80:1 against #0a0a0a),
     so: keep the hue family, ROTATE IT BLUER to drop the green cast, and land on
     the AA floor rather than above it --
       #00ffff  hue 180  light 0.50  contrast 15.79   (original)
       #4d9cb2  hue 193  light 0.50  contrast  6.33   (too green, too bright)
       #4a7f9e  hue 202  light 0.45  contrast  4.54   (this)
     One constant to move in either direction. */
  const DEFAULT_INK = '#3e738b';
  /* 600, not 700: enough stem to read dim ink on black, not so much that every
     label screams. */
  const LIGHT_WEIGHT = 600;
  function inkIsLight(hex) {
    const c = parseRGB(hex);
    if (!c) return false;
    /* Light AND colourless. The old rule also accepted anything bright
       regardless of chroma, which is how a picker ends up offering to turn a
       yellow price tag cyan -- not what "white and grey" means. */
    return lum(c) >= LIGHT_MIN && inkIsNeutral(hex);
  }
  /* GLARE, NOT ONLY GREY (1.0.31, 2026-11-16). Mike: "*the item prices are still
     a little bright, color is fine*". The cart's prices render #2cfce3 -- vivid
     teal, L 0.76, weight 700 -- and the neutrality rule skips saturated ink BY
     DESIGN, so the single loudest thing on the page was the one thing the sweep
     refused to touch. Same reasoning as grey, applied to chroma: ink that
     carries real colour AND clears the dim accent by this much is glare, and
     gets the same ink. Badges at L 0.43-0.44 ("Sale -9% now", "Free shipping")
     fall in with it; genuinely dark accents (< 0.30) keep their hue. */
  const VIVID_CAP = 0.30;
  function inkIsGlare(hex) {
    const c = parseRGB(hex);
    if (!c) return false;
    return lum(c) >= VIVID_CAP && saturation(hex) > NEUTRAL_SAT;
  }
  /** Does this ink need the accent? Grey, or louder than the accent itself. */
  function inkNeedsAccent(hex) { return inkIsLight(hex) || inkIsGlare(hex); }
  function isGradientText(el) {
    const cs = getComputedStyle(el);
    const clip = cs.webkitBackgroundClip || cs.backgroundClip || '';
    const fill = parseRGB(cs.webkitTextFillColor || cs.color);
    return clip.indexOf('text') >= 0 && !!fill && fill[3] < 0.05;
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
       destroy the effect, so they are not measurable and are skipped.

       SVG text is the exception: it paints with `fill`, so reading `color`
       there measures an inherited HTML value that has nothing to do with the
       pixels. Reading `fill` is what lets a gauge's dial labels into a rule. */
    /* A form control paints with `color`; its -webkit-text-fill-color is a UA
       default that can disagree with what the field actually shows. */
    let ink = FORM_TEXT_TAGS.test(el.tagName)
      ? cs.color
      : (cs.webkitTextFillColor || cs.color);
    if (isSvgText(el) && cs.fill && cs.fill !== 'none' && !/^currentcolor$/i.test(cs.fill)) ink = cs.fill;
    const rgb = parseRGB(ink);
    if (!rgb) return tagged && cached ? cached.c : '';
    /* ALPHA INK IS NOT UNMEASURABLE (1.0.27). This used to reject anything with
       alpha < 0.999, which silently excluded a whole class of real text: sites
       write rgba(0,0,0,0.9) for body copy, navigation labels and form text all
       the time. Measured on AliExpress search: 75 of 328 visible white-on-screen
       elements were rgba ink, so "everything light" reached 253 and the panel
       still reported "covers 282 of 282" — a complete-looking number over an
       incomplete job. Composite the ink over its backdrop instead, which is what
       the screen does. Below 0.05 stays unmeasurable: that is background-clip
       gradient text, where repainting destroys the effect. */
    let base = [rgb[0], rgb[1], rgb[2]];
    if (rgb[3] < 0.999) {
      if (rgb[3] < 0.05) return tagged && cached ? cached.c : '';
      const back = backdropOf(el);
      const a = rgb[3];
      base = [Math.round(rgb[0] * a + back[0] * (1 - a)),
              Math.round(rgb[1] * a + back[1] * (1 - a)),
              Math.round(rgb[2] * a + back[2] * (1 - a))];
    }
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
      ? [255 - base[0], 255 - base[1], 255 - base[2]]
      : [base[0], base[1], base[2]];
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

  /* FORM CONTROLS OWN TEXT TOO (1.0.27). This test used to accept only an
     element with a direct child text node, so <input>, <textarea> and <select>
     were invisible to the whole tuning system: not counted in coverage, never
     tagged, never recoloured. Measured on AliExpress search: 46 of 268 visible
     white-on-screen text elements were form controls (the search box and every
     quantity field), and the panel still said "covers 253 of 253". A control's
     visible text is not a text node — it is painted by the widget. */
  const FORM_TEXT_TAGS = /^(INPUT|TEXTAREA|SELECT)$/;
  function ownsText(el) {
    if (NON_TEXT_TAGS.test(el.tagName)) return false;
    if (FORM_TEXT_TAGS.test(el.tagName)) return true;
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
    }
    return false;
  }

  function toneRules() {
    return globalRules.concat(perHost).concat(pending ? [pending] : [])
      .filter((r) => r && r.id && (r.match === 'light' || (r.match === 'color' && r.from)));
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

    /* TWO PASSES — decide, then write. Tagging a parent repaints its children
       through inheritance, so a single measure+tag loop compares the CHILDREN
       against the colour we have just painted on the PARENT and silently skips
       them. Measured on the ambientweather dashboard: two <sup> unit markers
       fell out of a 102-element group for exactly this reason (the sweep walks
       in document order, so the parent was always tagged first). */
    const plan = [];
    let tagged = 0;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el.id === ROOT_ID || !ownsText(el)) continue;
      const base = rendersOf(el);
      if (!base) continue;
      /* Last rule wins, like the CSS cascade: rules are appended in the order
         the user made them, so a later "everything light" has to beat an
         earlier "all text #cecdc9" — otherwise the wider rule looks broken on
         exactly the elements the narrow one already claimed (measured while
         building this test: the light rule painted nothing until precedence
         flipped). */
      let hit = null;
      for (let j = rules.length - 1; j >= 0; j--) {
        const r = rules[j];
        if (r.match === 'color' ? sameHex(r.from, base) : inkNeedsAccent(base)) { hit = r; break; }
      }
      if (hit) tagged++;
      plan.push([el, hit ? hit.id + (invertDepth(el) % 2 === 1 ? 'o' : 'e') : '']);
    }
    for (let i = 0; i < plan.length; i++) {
      const el = plan[i][0], want = plan[i][1];
      const has = el.getAttribute(TONE_ATTR);
      if (want) { if (has !== want) el.setAttribute(TONE_ATTR, want); }
      else if (has) el.removeAttribute(TONE_ATTR);
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

  /* Is this element text the user can actually SEE? The count of a colour is
     only meaningful over visible text: measured on the ambientweather
     dashboard, `#f65719` "had" 167 elements and was therefore declared
     dominant — but 155 of them were off-screen, display:none, or a 0×0
     slide-out, and a dozen orange numbers were all that showed. Correcting
     that is what makes "dominant" mean "the colour most of the page's text is
     showing you". */
  function visibleText(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return parseFloat(cs.opacity) > 0.05;
  }

  /** Rendered colour -> how many text elements show it (the "dominant" one wins). */
  function colourGroups() {
    const map = new Map();
    const body = document.body;
    if (!body) return map;
    const all = Array.prototype.slice.call(body.querySelectorAll('*'), 0, 8000);
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!ownsText(el) || !visibleText(el)) continue;
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

  /* COVERAGE — the number the panel was missing. It used to report what one
     scope reached and said nothing about what it left behind, which is exactly
     how "a bunch of numeric text switched … lots of non-numeric text stayed
     white" happened without the UI ever looking wrong. Counting is cheap
     (one pass over visible text owners) and it turns "reach more classes" into
     a fact the user can see: 56 of 129 covered, 73 still light. */
  function coverage() {
    const all = Array.prototype.slice.call(
      document.body ? document.body.querySelectorAll('*') : [], 0, 8000);
    let total = 0, done = 0, gradient = 0, svg = 0;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!ownsText(el) || !visibleText(el)) continue;
      const base = rendersOf(el);
      if (!base) {
        // Unmeasurable ink: gradient (background-clip:text) text, or a hit area
        // over an icon image. Counted so the panel can admit to leaving it.
        if (isGradientText(el)) gradient++;
        continue;
      }
      if (!inkNeedsAccent(base)) continue;
      total++;
      if (el.hasAttribute(TONE_ATTR)) { done++; if (isSvgText(el)) svg++; }
    }
    return { total: total, done: done, left: total - done, gradient: gradient, svg: svg };
  }

  function renderCoverage() {
    if (!coverageEl) return;
    /* Debounced: the colour knob fires `input` continuously and both this and
       sweepTone() walk every text element, so recomputing per pointer move
       would make the panel feel sticky on a heavy dashboard. */
    if (covTimer) clearTimeout(covTimer);
    covTimer = setTimeout(paintCoverage, 120);
  }

  function paintCoverage() {
    covTimer = null;
    if (!coverageEl) return;
    const c = coverage();
    if (!c.total && !c.gradient) { coverageEl.textContent = ''; coverageEl.className = 'dim'; if (coverBtn) coverBtn.hidden = true; return; }
    let t = 'covers ' + c.done + ' of ' + c.total + ' light-text elements';
    if (c.left) t += '  ·  ' + c.left + ' still light';
    if (c.svg) t += '  ·  ' + c.svg + ' in SVG (via fill)';
    if (c.gradient) t += '  ·  ' + c.gradient + ' gradient text left alone';
    coverageEl.textContent = t;
    coverageEl.className = c.left ? 'warn' : 'dim';
    if (coverBtn) coverBtn.hidden = !c.left;
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

  /* ────────────────────────── DID THE RULE ACTUALLY LAND? ────────────── */
  /* Twice now the rule was written, the panel showed a colour, and the pixels
     never moved: once because the rule was emitted at the site's own
     specificity, once because the site painted ink with
     -webkit-text-fill-color. Both were invisible from the panel, and what Mike
     saw was "selecting a single element isn't helping". Writing a rule is not
     the same as winning, so measure what the element COMPUTES after the
     stylesheet is in and say which one happened. */
  function sameRGB(a, b) {
    return !!a && !!b && Math.abs(a[0] - b[0]) < 3 && Math.abs(a[1] - b[1]) < 3 &&
           Math.abs(a[2] - b[2]) < 3;
  }

  /* The panel speaks hex everywhere else; getComputedStyle answers in rgb(). */
  function hexOf(rgb) {
    if (!rgb) return '?';
    return '#' + [rgb[0], rgb[1], rgb[2]].map((v) => (v | 0).toString(16).padStart(2, '0')).join('');
  }

  function verifyApplied(target, odd) {
    if (!verifyEl) return;
    if (!pending || !pending.color) { verifyEl.textContent = ''; verifyEl.className = 'dim'; return; }
    const want = parseRGB(odd ? complementCss(pending.color) : pending.color);
    let cs, ink = '', fill = '';
    try {
      cs = getComputedStyle(target);
      ink = cs.color || '';
      fill = cs.webkitTextFillColor || '';
    } catch (e) { verifyEl.textContent = ''; verifyEl.className = 'dim'; return; }
    const hit = sameRGB(parseRGB(ink), want) || sameRGB(parseRGB(fill), want);
    const shown = hexOf(parseRGB(ink));
    if (hit) {
      verifyEl.textContent = '✔ rule applied — element computes ' + shown;
      verifyEl.className = 'ok';
    } else {
      verifyEl.textContent = '✖ rule written but OVERRIDDEN — element still computes ' + shown +
        ' (a site rule outranks it, or the ink is painted another way)';
      verifyEl.className = 'warn';
    }
  }

  /* ─────────────────────────────── live preview + contrast ───────────── */
  function update() {
    if (!pending) return;
    scopeSel.title = pending.sel ||
      (pending.match === 'light' ? 'every light text element' : ('text colour ' + pending.from));
    applyRules();
    if (!lastPick) { contrastEl.textContent = ''; renderCoverage(); return; }

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
    verifyApplied(target, odd);
    renderCoverage();
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
    const rule = pending.match === 'light'
      ? { id: pending.id, match: 'light', from: '', color: pending.color, bg: pending.bg || '', min: LIGHT_MIN }
      : pending.match === 'color'
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
    infoEl.textContent = 'Saved for ' + host + ':  ' +
      (rule.match === 'light' ? 'all light text' : rule.match === 'color' ? 'all text ' + rule.from : rule.sel) +
      (darkened ? '  ·  site now darkened + remembered' : '  ·  site already remembered');
    renderCoverage();
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
    renderCoverage();
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
      const label = r.match === 'light'
        ? '≈ all light text (' + document.querySelectorAll('[' + TONE_ATTR + ']').length + ' tagged)'
        : r.match === 'color'
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
      tagged: document.querySelectorAll('[' + TONE_ATTR + ']').length,
      coverage: coverage()
    }),
    /* colour-sweep surface: the same code paths the panel buttons hit */
    scope: (v) => { scopeSel.value = v; onScopeChange(); },
    tone: (from, colour) => {
      applyTone(from);
      if (colour) { txtInput.value = colour; pending.color = colour; update(); }
    },
    light: (colour) => {
      applyLight();
      if (colour) { txtInput.value = colour; pending.color = colour; update(); }
    },
    coverage: () => coverage(),
    /* every scope the panel is offering right now, as the user sees it */
    options: () => (scopeSel ? [...scopeSel.options].map((o) => ({
      v: o.value, t: o.textContent.trim(), chosen: o.selected
    })) : []),
    groups: () => [...lastGroups.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([c, v]) => ({ colour: c, n: v.n, chars: v.chars, tags: v.tags })),
    sweep: () => sweepTone(),
    save: onSave,
    forget: onForget
  };
})();
