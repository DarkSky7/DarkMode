#!/usr/bin/env python3
"""Prove the "reach more text" fix on a live dashboard.

Mike, 2026-11-11: *"after selecting the numeric Fahrenheit temperature, and
selecting a color, a bunch of numeric text switched (as it should), but lots of
non-numeric text stayed white. We need a way to reach more classes."*

Root cause was not reach, it was the DEFAULT: `colourGroups()` counted text the
user cannot see, so the "dominant" colour was an accent that 167 elements had and
a dozen showed. The picked colour was then not dominant, so the default fell
through to a single class — `.fdp-val`, 56 of the page's 129 light-text elements
— and every label outside that class stayed white with nothing in the UI saying
so.

Asserted here (DOM) and in pixels (screenshot):
  * default scope = a colour group, and a colour-group save leaves 0 light text;
  * "≈ everything light" exists as a scope, and a light rule covers everything;
  * the two-pass sweep no longer loses children to their tagged parent;
  * after the light rule, no text rect on screen still has neutral-white ink.

Usage: python scripts/test-reach.py [--target DIR] [--keep]
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
WORK = os.environ.get("DM_REACH_WORK") or r"F:\tmp\dm-reach"


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


def ink_counts(rows, W, H, rects, detail=False):
    """Ink inside each rect: pixels that differ from the rect's own modal
    background (so a white map tile is not mistaken for white glyphs), split
    into neutral-white and cyan-family."""
    neutral = cyan = 0
    per = []
    for r in rects:
        x0, y0 = max(0, r["x"]), max(0, r["y"])
        x1, y1 = min(W, r["x"] + r["w"]), min(H, r["y"] + r["h"])
        if x1 - x0 < 2 or y1 - y0 < 2:
            continue
        hist = {}
        px = []
        for yy in range(y0, y1):
            s = rows[yy]
            for xx in range(x0, x1):
                p = (s[xx * 3], s[xx * 3 + 1], s[xx * 3 + 2])
                px.append(p)
                k = (p[0] // 24, p[1] // 24, p[2] // 24)
                hist[k] = hist.get(k, 0) + 1
        if not hist:
            continue
        bq = max(hist, key=hist.get)
        bg = (bq[0] * 24 + 12, bq[1] * 24 + 12, bq[2] * 24 + 12)
        n0 = c0 = 0
        for R, G, B in px:
            if abs(R - bg[0]) + abs(G - bg[1]) + abs(B - bg[2]) <= 36:
                continue                      # background, not ink
            if min(R, G, B) > 170 and abs(R - G) < 20 and abs(G - B) < 20:
                neutral += 1
                n0 += 1
            elif B > 140 and G > 140 and R < 140:
                cyan += 1
                c0 += 1
        if detail and (n0 or c0):
            per.append((n0, c0, r.get("txt", "?"), r.get("colour", "?"), x0, y0, x1 - x0, y1 - y0))
    if detail:
        per.sort(reverse=True)
        for n0, c0, txt, col, x, y, w, h in per[:8]:
            print("      white %4d / cyan %4d px in %r (%s) at %d,%d %dx%d" % (n0, c0, txt, col, x, y, w, h))
    return neutral, cyan


def run_pass(nd, mode):
    """One cold load. mode 'baseline' records rects with no rules; 'after' drives
    the panel and applies the light rule."""
    tag = "base" if mode == "baseline" else "after"
    shot = os.path.join(WORK, tag + ".png")
    stub = os.path.join(WORK, "stub-%s.js" % tag)
    with open(stub, "w", encoding="utf-8") as fh:
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
    modefile = os.path.join(WORK, "mode-%s.js" % tag)
    with open(modefile, "w", encoding="utf-8") as fh:
        fh.write("window.__REACH_MODE=" + json.dumps(mode) + ";")
    cmd = [nd, os.path.join(ROOT, "scripts", "cdp-eval.mjs"), "--cold", "--url", URL,
           "--style", "css=" + os.path.join(TARGET, "content.css"),
           "--page-script", "stub=" + stub,
           "--page-script", "mode=" + modefile,
           "--page-script", "content=" + os.path.join(TARGET, "content.js"),
           "--page-script", "tuner=" + os.path.join(TARGET, "tuner.js"),
           "--test", os.path.join(ROOT, "scripts", "test-reach.js"),
           "--settle", "9000", "--width", "1920", "--height", "1200", "--shot", shot]
    run = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if run.returncode != 0:
        raise SystemExit("FAIL driver (%s): %s" % (tag, (run.stderr.strip().splitlines() or ["?"])[-1]))
    return json.loads(run.stdout), shot


def white_ink(shot, rects, detail=False):
    W, H, rows, bpp = decode_png()(open(shot, "rb").read())
    if bpp == 4:
        rows = [bytes(b for i, b in enumerate(s) if i % 4 != 3) for s in rows]
    return ink_counts(rows, W, H, rects, detail)


def main():
    nd = node()
    if not nd:
        print("SKIP no node on PATH (needs Node 22+ for the built-in WebSocket)")
        return 0
    os.makedirs(WORK, exist_ok=True)
    fails = 0

    base, base_shot = run_pass(nd, "baseline")
    for line in base["checks"]:
        if line.startswith("FAIL"):
            fails += 1
        print("   " + line)
    n_base, c_base = white_ink(base_shot, base["rects"])
    ok = n_base > 1200
    if not ok:
        fails += 1
    print("   %s baseline screen: %d neutral-white ink px across %d text rects "
          "(the white text Mike saw), %d cyan" %
          ("PASS" if ok else "FAIL", n_base, len(base["rects"]), c_base))

    rep, shot = run_pass(nd, "after")
    for line in rep["checks"]:
        if line.startswith("FAIL"):
            fails += 1
        print("   " + line)

    # PIXEL TRUTH: after "everything light -> cyan", the same page must have no
    # neutral-white glyph ink, and cyan ink where the white used to be.
    n_after, c_after = white_ink(shot, rep["rects"], detail=True)
    ok = n_after < 300 and c_after > 500 and n_after < n_base * 0.15
    if not ok:
        fails += 1
    print("   %s after screen: %d neutral-white ink px (was %d), %d cyan px" %
          ("PASS" if ok else "FAIL", n_after, n_base, c_after))

    print("\n   coverage after the default save : " + json.dumps(rep.get("coverageDefault")))
    print("   coverage after 'everything light': " + json.dumps(rep.get("coverageLight")))
    print("   rules: " + json.dumps(rep.get("rules")))
    if fails:
        print("\n   scope menu that was offered:")
        for o in rep.get("options", []):
            print("     " + o)
    print("\n%s (%d failure%s)" % ("ALL PASS" if not fails else "FAILURES", fails, "" if fails == 1 else "s"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
