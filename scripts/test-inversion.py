#!/usr/bin/env python3
"""Prove the tuner compensates for the page's colour-wheel inversion — by pixel.

Two mock pages are built from the real content.css and tuner.js:

  inverted.html  <html class="cr-dark">  -> html{filter:invert(1)}  (depth 1)
  plain.html     no class                -> no invert             (depth 0)

On the inverted page a rule whose INTENT is cyan must WRITE red, and the pixels
must come back cyan. On the plain page intent must be written unchanged. The
even-depth case ([data-cr-bgphoto] carries a second invert) must not compensate.

Chrome is driven headless: --dump-dom collects the in-page assertions,
--screenshot + a minimal PNG decode samples the rendered pixels.
"""
import os
import re
import struct
import subprocess
import sys
import tempfile
import zlib

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# --target <dir> runs this against a STAGED build (dist/DarkMode-<ver>) instead
# of the working tree, so the artifact that ships is what gets exercised.
REPO = sys.argv[sys.argv.index("--target") + 1] if "--target" in sys.argv else ROOT
REPO = os.path.abspath(REPO)
WORK = os.environ.get("DM_TEST_WORK") or r"F:\tmp\dm-inversion-harness"

TEST_JS = r"""
(function () {
  const out = [];
  const ok = (name, cond, detail) => out.push((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
  const T = window.__dmTuner;
  T.open();
  const sr = document.getElementById('dm-tuner-root').shadowRoot;

  // ── case 1: a plain element on the (possibly inverted) page ─────────────
  const probe = document.getElementById('probe');
  T.capture(probe);
  sr.getElementById('nobg').checked = false;
  sr.getElementById('nobg').dispatchEvent(new Event('change'));
  const bgIn = sr.getElementById('bg');
  bgIn.value = '#00ffff';
  bgIn.dispatchEvent(new Event('input'));
  const txtIn = sr.getElementById('txt');
  txtIn.value = '#00ffff';
  txtIn.dispatchEvent(new Event('input'));

  const st = T.state();
  const css = st.css;
  const inverted = document.documentElement.classList.contains('cr-dark');
  const probeRule = (css.match(/#probe\{[^}]*\}/) || [''])[0];
  ok('probe rule emitted', !!probeRule, probeRule);
  if (inverted) {
    ok('inverted: cyan intent writes #ff0000', probeRule.indexOf('#ff0000') !== -1, probeRule);
    ok('inverted: no raw cyan in written css', probeRule.indexOf('#00ffff') === -1, probeRule);
  } else {
    ok('plain: cyan written unchanged', probeRule.indexOf('#00ffff') !== -1, probeRule);
  }
  ok('intent preserved in state', st.pending && st.pending.color === '#00ffff',
     st.pending && st.pending.color);

  // ── case 5 (checked here: state must still be the probe) ────────────────
  const mirror = sr.getElementById('mirror');
  if (inverted) {
    ok('mirror note explains the write', /writes #ff0000 to render #00ffff/.test(mirror.textContent),
       mirror.textContent);
  } else {
    ok('no mirror note on a plain page', (mirror.textContent || '') === '', mirror.textContent);
  }

  // ── case 2: even depth — a restored background-photo subtree ────────────
  const restored = document.querySelector('[data-cr-bgphoto="1"]');
  const inner = restored ? restored.querySelector('.inside') : null;
  if (inner) {
    T.capture(inner);
    sr.getElementById('nobg').checked = false;
    sr.getElementById('nobg').dispatchEvent(new Event('change'));
    const b2 = sr.getElementById('bg');
    b2.value = '#00ffff';
    b2.dispatchEvent(new Event('input'));
    const css2 = T.state().css;
    const rule2 = (css2.match(/(?:#inside|\.inside)\{[^}]*\}/) || [''])[0];
    if (inverted) {
      ok('even depth: NOT complemented', rule2.indexOf('#00ffff') !== -1, rule2);
    } else {
      ok('even depth (plain page): raw', rule2.indexOf('#00ffff') !== -1, rule2);
    }
  } else {
    ok('even-depth fixture present', false, 'missing [data-cr-bgphoto]/.inside');
  }

  // ── case 3: capture seeds the RENDERED colour ───────────────────────────
  const sample = document.querySelector('p.aX');
  T.capture(sample);
  const seeded = T.state().pending.color;
  // .aX is #003366 in the source; on an inverted page it looks like #ffcc99.
  ok('capture seeds rendered colour',
     seeded === (inverted ? '#ffcc99' : '#003366'), seeded);

  // ── case 3b: ink the site paints with -webkit-text-fill-color ───────────
  // .aF is #663300 by fill and #003366 by color: grouping on `color` would put
  // it in the wrong group and writing only `color` would not move its ink.
  const fillEl = document.querySelector('p.aF');
  T.capture(fillEl);
  const inkList = T.groups().map((g) => g.colour);
  const fFrom = inverted ? '#99ccff' : '#663300';           // #663300 is the fill
  ok('ink measured from text-fill-color, not color',
     inkList.indexOf(fFrom) !== -1, inkList.join(' '));
  T.tone(fFrom, '#00ffff');
  const cssF = T.state().css;
  ok('tone rule writes -webkit-text-fill-color',
     /-webkit-text-fill-color:(#ff0000|#00ffff) !important/.test(cssF),
     (cssF.split('\n')[0] || '').slice(0, 120));
  ok('fill-painted element is tagged', fillEl.getAttribute('data-dm-tone') !== null,
     String(fillEl.getAttribute('data-dm-tone')));

  // ── case 3c: the user's colour must beat a site rule that outranks a plain
  // attribute selector. `.wrap .deep p.spec1:nth-of-type(1)` is (0,4,1); a bare
  // [data-dm-tone] is (0,1,0) and LOSES even with !important. Repetition of the
  // attribute takes the emitted rule to (0,8,0).
  const specEl = document.querySelector('p.spec1');
  T.capture(specEl);
  // .spec1 is #003366 in the source; on an inverted page it renders #ffcc99.
  T.tone(inverted ? '#ffcc99' : '#003366', '#00ffff');
  const specTagged = specEl.getAttribute('data-dm-tone');
  const specComputed = getComputedStyle(specEl).color;
  const specWant = inverted ? 'rgb(255, 0, 0)' : 'rgb(0, 255, 255)';
  ok('our colour outranks a (0,4,1) site rule',
     specTagged !== null && specComputed === specWant,
     'attr=' + specTagged + ' computed=' + specComputed + ' want=' + specWant);

  // ── case 3d: a child that INHERITS its ink from a tagged parent ─────────
  // The sweep used to measure and tag in one pass, in document order, so the
  // parent was repainted before the child was measured and the child no longer
  // matched the colour the rule was for. Measured on the ambientweather
  // dashboard: two <sup> unit markers fell out of a 102-element group.
  const outer = document.querySelector('p.withsup');
  const child = document.getElementById('child');
  const groupColour = inverted ? '#ffcc99' : '#003366';
  T.tone(groupColour, '#00ffff');
  ok('an inheriting child is tagged with its parent',
     !!outer && outer.getAttribute('data-dm-tone') !== null &&
     !!child && child.getAttribute('data-dm-tone') !== null,
     'parent=' + (outer && outer.getAttribute('data-dm-tone')) +
     ' child=' + (child && child.getAttribute('data-dm-tone')));

  // ── case 3e: a LATER threshold rule outranks an EARLIER exact one ───────
  // "everything light" is the widest reach, so it has to win where it overlaps;
  // otherwise the user presses the button and nothing visibly changes.
  const toneId = T.state().pending.id;
  T.light('#00ffff');
  const lightId = T.state().pending.id;
  ok('light rule replaces the pending exact rule', T.state().pending.match === 'light',
     T.state().pending.match);
  const inheritTag = outer && outer.getAttribute('data-dm-tone');
  if (inverted) {
    ok('a later light rule outranks an earlier exact rule',
       !!inheritTag && inheritTag.slice(0, -1) === lightId,
       'tag=' + inheritTag + ' light=' + lightId + ' tone=' + toneId);
  } else {
    // #003366 is LIGHT ink only after inversion; on a plain page it is dark, and
    // the threshold rule must leave it to the exact rule.
    ok('on a light page the threshold rule leaves dark ink to the exact rule',
       inheritTag === null || inheritTag.slice(0, -1) === toneId,
       'tag=' + inheritTag + ' light=' + lightId + ' tone=' + toneId);
  }

  // ── case 4: our own panel is counter-inverted ───────────────────────────
  const rootEl = document.getElementById('dm-tuner-root');
  const rf = getComputedStyle(rootEl).filter;
  ok(inverted ? 'panel counter-inverted' : 'panel unfiltered',
     inverted ? rf === 'invert(1)' : (rf === 'none' || rf === ''), 'root filter=' + rf);
  const htmlF = getComputedStyle(document.documentElement).filter;
  ok('html filter reported to tuner',
     inverted ? htmlF === 'invert(1)' : (htmlF === 'none' || htmlF === ''),
     'html filter=' + htmlF);

  // ── leave the probe painted so the screenshot can sample real pixels ─────
  // (each capture() replaces `pending`, so the last one wins the stylesheet)
  T.capture(probe);
  sr.getElementById('nobg').checked = false;
  sr.getElementById('nobg').dispatchEvent(new Event('change'));
  const bFinal = sr.getElementById('bg');
  bFinal.value = '#00ffff';
  bFinal.dispatchEvent(new Event('input'));

  const pre = document.createElement('pre');
  pre.id = 'out';
  pre.textContent = out.join('\n');
  document.body.appendChild(pre);
})();
"""

PAGE = """<!doctype html>
<html{CLS}>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="file:///{css}">
<style>
  html, body {{ margin: 0; padding: 0; }}
  body {{ background: #ffffff; color: #333333; font: 16px/1.4 system-ui; }}
  #probe {{ position: absolute; left: 40px; top: 40px; width: 160px; height: 160px;
            background: #ffffff; }}
  .aX {{ color: #003366; }}
  /* The inheriting-child case: the <sup> takes the parent's ink, which is what
     made a one-pass sweep lose it. */
  .withsup {{ color: #003366; }}
  /* ink the site paints with -webkit-text-fill-color instead of color */
  .aF {{ color: #003366; -webkit-text-fill-color: #663300; }}
  /* a site rule with a specificity that beats a plain attribute selector:
     (0,4,1) vs (0,1,0). The user's colour must still win. */
  .wrap .deep p.spec1:nth-of-type(1) {{ color: #003366 !important; }}
  [data-cr-bgphoto="1"] {{ background-image: url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="); }}
</style>
</head>
<body>
<div id="probe"></div>
<p class="aX">sample text one</p>
<p class="aX">sample text two</p>
<p class="withsup">with unit <sup id="child">2</sup></p>
<p class="aF">fill painted text</p>
<div class="wrap"><div class="deep"><p class="spec1">specificity hostage</p></div></div>
<div data-cr-bgphoto="1"><span id="inside" class="inside">restored subtree</span></div>
<script>
  window.chrome = {{ storage: {{ sync: {{ get: function (k, cb) {{ cb && cb({{}}); }},
                                      set: function (o, cb) {{ cb && cb(); }} }} }},
                    runtime: {{ onMessage: {{ addListener: function () {{}} }} }} }};
</script>
<script src="file:///{tuner}"></script>
<script>{test}</script>
</body>
</html>
"""


def build(name, cls):
    path = os.path.join(WORK, name)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(PAGE.format(
            CLS=cls,
            css=(REPO + r"\content.css").replace("\\", "/"),
            tuner=(REPO + r"\tuner.js").replace("\\", "/"),
            test=TEST_JS,
        ))
    return path


def run(args, timeout=90):
    return subprocess.run([CHROME] + args, capture_output=True, timeout=timeout)


def decode_png(data):
    """Minimal PNG reader: returns (width, height, rows of RGBA tuples)."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, w, h = 8, b"", 0, 0
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        if ctype == b"IHDR":
            w, h, depth, color, _, _, inter = struct.unpack(">IIBBBBB", chunk)
            assert depth == 8 and inter == 0, (depth, inter)
            assert color in (2, 6), color
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"IEND":
            break
        pos += 12 + length
    raw = zlib.decompress(idat)
    bpp = 4 if color == 6 else 3
    stride = w * bpp
    rows, prev = [], bytearray(stride)
    p = 0
    for _ in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif f == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 0xFF
        rows.append(line)
        prev = line
    return w, h, rows, bpp


def pixel(rows, bpp, x, y):
    s = rows[y]
    return tuple(s[x * bpp:x * bpp + 3])


def main():
    os.makedirs(WORK, exist_ok=True)
    results = []
    for name, cls in (("inverted.html", ' class="cr-dark"'), ("plain.html", "")):
        page = build(name, cls)
        dom = run(["--headless=new", "--disable-gpu", "--no-sandbox",
                   "--allow-file-access-from-files", "--dump-dom",
                   "--virtual-time-budget=3000", "file:///" + page.replace("\\", "/")])
        html = dom.stdout.decode("utf-8", "replace")
        pre = re.search(r'<pre id="out">(.*?)</pre>', html, re.S)
        body = pre.group(1) if pre else ""
        got = re.findall(r"(PASS|FAIL) ([^\n]+)", body)
        results.append((name, got))

    # pixel truth on the inverted page
    page = os.path.join(WORK, "inverted.html")
    shot = os.path.join(WORK, "inverted.png")
    if os.path.exists(shot):
        os.remove(shot)
    run(["--headless=new", "--disable-gpu", "--no-sandbox",
         "--allow-file-access-from-files", "--window-size=800,600",
         "--virtual-time-budget=3000", "--screenshot=" + shot,
         "file:///" + page.replace("\\", "/")])
    px_line = "no screenshot"
    if os.path.exists(shot):
        with open(shot, "rb") as fh:
            w, h, rows, bpp = decode_png(fh.read())
        px = pixel(rows, bpp, 120, 120)
        want = (0, 255, 255)
        close = all(abs(a - b) <= 4 for a, b in zip(px, want))
        px_line = ("%s probe pixel rgb%s %s cyan" %
                   ("PASS" if close else "FAIL", px, "~=" if close else "!="))
        results.append(("inverted.html pixel", [("PASS" if close else "FAIL",
                                                 "probe renders rgb%s (intent #00ffff)" % (px,))]))

    fails = 0
    for name, got in results:
        print("== " + name)
        if not got:
            print("   FAIL no assertions captured")
            fails += 1
        for status, detail in got:
            if status == "FAIL":
                fails += 1
            print("   %s %s" % (status, detail))
    print(px_line)
    print("\n%s (%d failure%s)" % ("ALL PASS" if not fails else "FAILURES", fails, "" if fails == 1 else "s"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
