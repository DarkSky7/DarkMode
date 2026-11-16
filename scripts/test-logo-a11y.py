#!/usr/bin/env python3
"""End-to-end: a logo painted as a background-image is restored iff its text is invisible.

Mike, 2026-11-16 (Brave, aliexpress.com order pages): *"our Dark Mode extension
seems to be inverting the images."* The one inverted visual the diagnostic found
was `a.pc-header--logoImg--mDbiT4k`: a wordmark painted as a background-image
with a screen-reader <span>AliExpress</span> inside it. 1.0.23 replaced the
`textContent` veto in startBgPhotoFix with `showsText()`.

`test-showstext.py` proves the predicate in isolation. This proves the ENGINE:
two anchors that differ only in whether their text is visible, driven through the
real content.css + content.js in a real Chrome, with a real raster that has to be
fetched and sampled, must land on opposite sides of the gate.

Runs entirely local: a throwaway page on 127.0.0.1 (the palette sampler and the
bg-image fetch need a real origin), a storage stub that remembers the host, and
node scripts/cdp-eval.mjs --cold so content.js sees document_start.

Usage: python scripts/test-logo-a11y.py [--target DIR]
"""
import base64
import http.server
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import threading
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.abspath(sys.argv[sys.argv.index("--target") + 1]) if "--target" in sys.argv else ROOT
WORK = os.environ.get("DM_LOGO_WORK") or r"F:\tmp\dm-logo-e2e"


def node():
    for c in (r"D:\Programs\nodejs\node.exe", shutil.which("node"), shutil.which("nodejs")):
        if c and os.path.exists(c):
            return c
    return None


def png_b64(w=24, h=24, flat=False):
    """A genuinely colourful raster, or a saturated FLAT plate.

    Both clear the 0.12 saturation floor; only the first is photographic (many
    colour buckets, wide luminance spread). That is how an 80x80 product
    thumbnail is told apart from an 80x80 icon."""
    rows = b""
    for y in range(h):
        rows += b"\x00"
        for x in range(w):
            if flat:
                rows += bytes((30, 60, 180))
            else:
                rows += bytes(((x * 10) % 256, (y * 10) % 256, 200))
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
           chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))
    return base64.b64encode(png).decode()


PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>logo</title><style>
  body {{ margin: 0; font: 16px/1.4 sans-serif; background: #fff; color: #111; }}
  .logo {{ display: block; width: 200px; height: 120px; background-color: #fff;
           background-image: url("data:image/png;base64,{img}");
           background-size: contain; background-repeat: no-repeat; }}
  .sr {{ position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
         overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }}
  #visible {{ margin-top: 20px; }}
  .smallbg {{ width: 80px; height: 80px; margin-top: 20px;
              background-image: url("data:image/png;base64,{img}");
              background-size: contain; background-repeat: no-repeat; }}
  .flat {{ background-image: url("data:image/png;base64,{img2}"); }}
  #visible span {{ font-size: 16px; color: #111; }}
</style></head><body>
<a class="logo" id="a11y" href="#"><span class="sr">AliExpress</span></a>
<a class="logo" id="visible" href="#"><span>AliExpress</span></a>
<img class="logo" id="plainimg" alt="" src="data:image/png;base64,{img}">
<div class="smallbg" id="smallbg"></div>
<div class="smallbg flat" id="flatbg"></div>
<p>Filler paragraph so the palette sampler has ordinary body text to read.</p>
</body></html>"""

STUB = """(function(){
  window.__store={darkHosts:{'127.0.0.1':true},tuneRulesByHost:{},tuneRulesGlobal:[]};
  function r(k,cb){var o={};
    if(typeof k==='string')o[k]=window.__store[k];
    else if(Array.isArray(k))k.forEach(function(x){if(x in window.__store)o[x]=window.__store[x];});
    else Object.assign(o,window.__store);
    if(cb)cb(o);return Promise.resolve(o);}
  function w(o,cb){Object.assign(window.__store,o);if(cb)cb();return Promise.resolve();}
  window.chrome={storage:{sync:{get:r,set:w},onChanged:{addListener:function(){}}},
    runtime:{onMessage:{addListener:function(){}},sendMessage:function(){return Promise.resolve();},lastError:null}};
})();"""


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def main():
    nd = node()
    if not nd:
        print("SKIP no node on PATH (needs Node 22+ for the built-in WebSocket)")
        return 0
    os.makedirs(WORK, exist_ok=True)
    with open(os.path.join(WORK, "logo.html"), "w", encoding="utf-8") as fh:
        fh.write(PAGE.format(img=png_b64(), img2=png_b64(flat=True)))
    stub = os.path.join(WORK, "stub.js")
    with open(stub, "w", encoding="utf-8") as fh:
        fh.write(STUB)

    os.chdir(WORK)
    port = free_port()
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=WORK, **k)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    try:
        cmd = [nd, os.path.join(ROOT, "scripts", "cdp-eval.mjs"), "--cold",
               "--url", "http://127.0.0.1:%d/logo.html" % port,
               "--style", "css=" + os.path.join(TARGET, "content.css"),
               "--page-script", "stub=" + stub,
               "--page-script", "content=" + os.path.join(TARGET, "content.js"),
               "--test", os.path.join(ROOT, "scripts", "test-logo-a11y.js"),
               "--settle", "6000"]
        run = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    finally:
        httpd.shutdown()

    if run.returncode != 0:
        print("FAIL driver: " + (run.stderr.strip().splitlines() or ["?"])[-1])
        return 1
    try:
        lines = json.loads(run.stdout)
    except Exception:
        print("FAIL unparseable driver output:\n" + run.stdout[:1200])
        return 1
    fails = sum(1 for l in lines if l.startswith("FAIL"))
    for line in lines:
        print("   " + line)
    print("\n%s (%d failure%s)" % ("ALL PASS" if not fails else "FAILURES", fails, "" if fails == 1 else "s"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
