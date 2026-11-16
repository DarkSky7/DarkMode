#!/usr/bin/env python3
"""Prove the engine tells "has text" apart from "SHOWS text".

Mike, 2026-11-16, Brave, AliExpress order pages: *"our Dark Mode extension seems
to be inverting the images"*. The diagnostic found exactly one inverted visual on
the whole page:

    why=BG-IN-TEXT-EL  paint=bg:ae-pic-a1.aliexpress-media.com/k  text=10
    size=98x31         el=a.pc-header--logoImg--mDbiT4k

`startBgPhotoFix` refused to restore it because the test was
`(el.textContent || '').trim()` — and that anchor carries a screen-reader
<span>AliExpress</span> for accessibility. Text nobody can see vetoed a restore,
so the logo painted as a photo-negative on every order page.

1.0.23 replaces the textContent test with `showsText()`, which asks the renderer:
does any text node have a rect of at least 4x4 CSS px that intersects the
element's own border box? That is the only test that honours clipping,
`overflow:hidden`, `clip:rect(0 0 0 0)`, `clip-path` and negative `text-indent`
at once.

This harness extracts the REAL `parseColor` and `showsText` out of content.js
(no copy to drift), runs them in headless Chrome against every sr-only recipe and
both kinds of visible text, and also asserts the call site kept its meaning: the
Ambient Weather lesson (visible text must never be restored, or it renders
#313236 on #000000) is exactly what showsText must still report.

Usage: python scripts/test-showstext.py [--target DIR]
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import shutil

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.abspath(sys.argv[sys.argv.index("--target") + 1]) if "--target" in sys.argv else ROOT
SRC = os.path.join(SRC, "content.js")
WORK = os.environ.get("DM_SHOWSTEXT_WORK") or r"F:\tmp\dm-showstext"


def extract(name, src):
    """Pull `function <name>(...) { ... }` out of content.js by brace matching."""
    start = src.index("function %s(" % name)
    i = src.index("{", start)
    depth = 0
    for j in range(i, len(src)):
        ch = src[j]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return src[start:j + 1]
    raise AssertionError("unbalanced braces extracting " + name)


def strip_comments(text):
    """Comments must not satisfy (or break) a source-level assertion."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"//[^\n]*", "", text)


CASES = [
    # (element id, expected showsText, what it is)
    ("clip", False, "sr-only via clip:rect(0 0 0 0) + 1px box (AliExpress logo recipe)"),
    ("indent", False, "text-indent:-9999px"),
    ("fs0", False, "font-size:0"),
    ("transparent", False, "color:transparent"),
    ("vis", False, "visibility:hidden"),
    ("none", False, "display:none"),
    ("op0", False, "opacity:0"),
    ("clip_path", False, "clip-path:inset(50%)"),
    ("offbox", False, "positioned off the left edge"),
    ("notext", False, "no text at all"),
    ("icon", False, "svg only, no text"),
    ("visible", True, "16px visible text -- must still veto a restore"),
    ("nested", True, "visible text three levels down"),
]


def build_html(parse_color, shows_text, cases_json):
    html = """<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; font: 16px/1.2 sans-serif; }
  .tile { width: 200px; height: 100px; background-image: url("data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="); }
  .sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
        overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .clippath { position: absolute; width: 1px; height: 1px; overflow: hidden;
              clip-path: inset(50%); white-space: nowrap; }
  .off { position: absolute; left: -500px; }
</style></head><body>
<div class="tile" id="clip"><span class="sr">AliExpress</span></div>
<div class="tile" id="indent" style="text-indent:-9999px;white-space:nowrap">AliExpress</div>
<div class="tile" id="fs0"><span style="font-size:0">AliExpress</span></div>
<div class="tile" id="transparent"><span style="color:transparent">AliExpress</span></div>
<div class="tile" id="vis"><span style="visibility:hidden">AliExpress</span></div>
<div class="tile" id="none"><span style="display:none">AliExpress</span></div>
<div class="tile" id="op0"><span style="opacity:0">AliExpress</span></div>
<div class="tile" id="clip_path"><span class="clippath">AliExpress</span></div>
<div class="tile" id="offbox"><span class="off">AliExpress</span></div>
<div class="tile" id="notext"></div>
<div class="tile" id="icon"><svg width="10" height="10"><circle cx="5" cy="5" r="4"/></svg></div>
<div class="tile" id="visible"><span style="font-size:16px">Real caption text</span></div>
<div class="tile" id="nested"><p><b><span style="font-size:16px">Real caption text</span></b></p></div>
<pre id="out">pending</pre>
<script>
  __PARSE_COLOR__
  __SHOWS_TEXT__
  var out = [];
  function ok(name, cond, detail) { out.push((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); }
  var cases = __CASES__;
  for (var i = 0; i < cases.length; i++) {
    var id = cases[i][0], want = cases[i][1], label = cases[i][2];
    var el = document.getElementById(id);
    var got = null, err = '';
    try { got = showsText(el); } catch (e) { err = String(e && e.message || e); }
    ok('showsText(' + id + ') === ' + want + '  [' + label + ']', got === want, 'got ' + got + (err ? ' err ' + err : ''));
  }
  document.getElementById('out').textContent = out.join('\\n');
</script></body></html>"""
    return (html.replace("__PARSE_COLOR__", parse_color)
                .replace("__SHOWS_TEXT__", shows_text)
                .replace("__CASES__", cases_json))


def main():
    if not os.path.exists(CHROME):
        print("SKIP: no headless Chrome at " + CHROME)
        return 2
    src = open(SRC, encoding="utf-8").read()
    parse_color = extract("parseColor", src)
    shows_text = extract("showsText", src)

    results = []

    # call-site assertions: the point of the fix is that pass() ASKS showsText
    results.append(("pass() gates the restore on showsText", "if (showsText(el)) continue;" in src, ""))
    results.append(("the textContent veto is gone",
                    "(el.textContent || '').trim()) continue;" not in src, ""))
    results.append(("showsText is reachable for diagnostics",
                    "window.__crShowsText = showsText" in src, ""))
    # Self-containment: a reference to a helper that lives in a SIBLING closure
    # throws ReferenceError at runtime, and the conservative catch turns that into
    # "has text" -- which silently disables the fix. This harness cannot see
    # closures (it evaluates both functions in one page scope), so assert the
    # source-level property instead. (Caught for real by test-logo-a11y.py.)
    results.append(("showsText does not reach outside its closure",
                    "parseColor(" not in strip_comments(shows_text), ""))

    os.makedirs(WORK, exist_ok=True)
    html = (build_html(parse_color, shows_text, json.dumps(CASES))
            .replace("__PARSE_COLOR__", parse_color)
            .replace("__SHOWS_TEXT__", shows_text))
    page = os.path.join(WORK, "showstext.html")
    with open(page, "w", encoding="utf-8") as fh:
        fh.write(html)

    profile = tempfile.mkdtemp(prefix="dm-showstext-", dir=WORK)
    try:
        proc = subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--no-first-run",
             "--user-data-dir=" + profile, "--allow-file-access-from-files",
             "--dump-dom", "file:///" + page.replace("\\", "/")],
            capture_output=True, text=True, timeout=90)
        dom = proc.stdout
    finally:
        shutil.rmtree(profile, ignore_errors=True)

    m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not m:
        print("FAIL: harness page produced no results")
        print(dom[:1500])
        return 1
    for line in m.group(1).strip().splitlines():
        parts = line.split(" :: ")
        results.append((parts[0], parts[0].startswith("PASS"), parts[1] if len(parts) > 1 else ""))

    fails = 0
    for name, cond, detail in results:
        label = name if name.startswith(("PASS", "FAIL")) else (("PASS " if cond else "FAIL ") + name)
        if not cond:
            fails += 1
        print(label + ((" :: " + detail) if detail and not cond else ""))
    print("\n%s (%d failures)" % ("ALL PASS" if not fails else "FAILURES", fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
