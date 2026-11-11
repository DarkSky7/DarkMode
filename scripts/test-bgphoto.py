#!/usr/bin/env python3
"""Prove the dashboard's white wind-dial disc and invisible light-theme text are gone.

Mike, 2026-11-11: *"With our dark mode enabled, ambientweather.net/dashboard/...
has a white circle in the center of the windspeed dial and LOTS of text is in
white."*

Cause: `startBgPhotoFix` marked ANY element with a `url(...)` background over
10,000 px² as a photo worth "restoring" — which double-inverts the element and
cancels the page filter for its whole subtree. On that page every widget's art is
an SVG (wind-circle, gauge, clock-bkg-small) or an icon+label pair, so:

  * `div.compass` (wind-circle.svg) was restored -> its WHITE disc stayed white
    on a dark dashboard;
  * `a.header` (station name + a 12px carrot SVG) was restored -> #313236 ink on
    a #000000 page, contrast 1.64:1, invisible;
  * `.recharts-responsive-container` (clock-bkg-small.svg) kept a light clock face.

The fix refuses to restore three things: vector (SVG) art, anything containing
text, and rasters that do not sample as colourful. This test asserts the page
and samples real pixels at the dial's centre.

Usage: python scripts/test-bgphoto.py [--target DIR]
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.abspath(sys.argv[sys.argv.index("--target") + 1]) if "--target" in sys.argv else ROOT
URL = "https://ambientweather.net/dashboard/1ef6c399c6ae0bbd9a9d8d56c81a006c"
WORK = os.environ.get("DM_BGPHOTO_WORK") or r"F:\tmp\dm-bgphoto"


def node():
    for c in (r"D:\Programs\nodejs\node.exe", shutil.which("node"), shutil.which("nodejs")):
        if c and os.path.exists(c):
            return c
    return None


def decode_png():
    spec = importlib.util.spec_from_file_location(
        "tin", os.path.join(ROOT, "scripts", "test-inversion.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.decode_png


def centre_white_pixels(path, x, y, w, h, box=80):
    """Mean luminance of the dial's centre window.

    A white disc measures ~0.90 here (measured on 1.0.20: 5,566 of 6,400 pixels
    above 0.85). The inverted art is near-black with light tick marks and a
    needle, so a handful of bright pixels is correct — the MEAN is the signal,
    not the brightest pixels.
    """
    decode = decode_png()
    W, H, rows, bpp = decode(open(path, "rb").read())
    cx, cy = x + w // 2, y + h // 2
    x0, y0 = max(0, cx - box // 2), max(0, cy - box // 2)
    x1, y1 = min(W, cx + box // 2), min(H, cy + box // 2)
    total = 0
    lum_sum = 0.0
    for yy in range(y0, y1):
        s = rows[yy]
        for xx in range(x0, x1):
            p = s[xx * bpp:xx * bpp + 3]
            lum_sum += (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255
            total += 1
    return (lum_sum / max(total, 1)), total


def main():
    nd = node()
    if not nd:
        print("SKIP no node on PATH (needs Node 22+ for the built-in WebSocket)")
        return 0
    os.makedirs(WORK, exist_ok=True)
    shot = os.path.join(WORK, "dial.png")
    cond = os.path.join(WORK, "stub.js")
    with open(cond, "w", encoding="utf-8") as fh:
        fh.write(
            "(function(){window.__store={darkHosts:{'ambientweather.net':true},"
            "tuneRulesByHost:{},tuneRulesGlobal:[]};"
            "function r(k,cb){var o={};if(typeof k==='string')o[k]=window.__store[k];"
            "else if(Array.isArray(k))k.forEach(function(x){if(x in window.__store)o[x]=window.__store[x];});"
            "else Object.assign(o,window.__store);if(cb)cb(o);return Promise.resolve(o);}"
            "function w(o,cb){Object.assign(window.__store,o);if(cb)cb();return Promise.resolve();}"
            "window.chrome={storage:{sync:{get:r,set:w},onChanged:{addListener:function(){}}},"
            "runtime:{onMessage:{addListener:function(){}},sendMessage:function(){return Promise.resolve();},lastError:null}};})();"
        )
    cmd = [
        nd, os.path.join(ROOT, "scripts", "cdp-eval.mjs"), "--cold", "--url", URL,
        "--style", "css=" + os.path.join(TARGET, "content.css"),
        "--page-script", "stub=" + cond,
        "--page-script", "content=" + os.path.join(TARGET, "content.js"),
        "--page-script", "tuner=" + os.path.join(TARGET, "tuner.js"),
        "--test", os.path.join(ROOT, "scripts", "test-bgphoto.js"),
        "--settle", "6500", "--shot", shot,
    ]
    run = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if run.returncode != 0:
        print("FAIL driver: " + (run.stderr.strip().splitlines() or ["?"])[-1])
        return 1
    lines = json.loads(run.stdout)
    fails = 0
    rect = None
    for line in lines:
        if line.startswith("RECT "):
            rect = [int(v) for v in line.split()[1:]]
            continue
        if line.startswith("FAIL"):
            fails += 1
        print("   " + line)
    # Pixel truth at the dial's centre: the disc must no longer be light.
    if rect and os.path.exists(shot):
        mean, total = centre_white_pixels(shot, *rect)
        good = mean < 0.25
        if not good:
            fails += 1
        print("   %s dial centre is dark :: mean luminance %.3f over %d px at %s "
              "(was 0.904 with a white disc)" %
              ("PASS" if good else "FAIL", mean, total, rect))
    else:
        fails += 1
        print("   FAIL no dial rect / screenshot")
    print("\n%s (%d failure%s)" % ("ALL PASS" if not fails else "FAILURES", fails, "" if fails == 1 else "s"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
