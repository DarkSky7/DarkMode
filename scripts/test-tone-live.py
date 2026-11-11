#!/usr/bin/env python3
"""Prove the colour-sweep ("shift every element showing colour X") on a LIVE page.

The bug this covers is not theoretical. On quantamagazine.org the article body is
made of bare <p> elements with NO class, so the picker offered only "this element
only" and a hand-typed selector: pointing at a paragraph and choosing cyan
recoloured 1 of 186 text elements and left the rest white. The page expresses
"body text" as ~200 elements spread over p/span/h2/a/em/strong/h3 whose only
common property is the colour they render — something CSS cannot query.

So the tuner tags matches with data-dm-tone="<ruleId><parity>" and emits one rule
per parity. scripts/test-tone-live.js asserts, against the real page:

  * the dominant text colour is discovered and offered as the default scope
  * one rule recolours the whole group (not one element)
  * headings / inline spans / fill-painted ink follow, differently-coloured
    links do not
  * the CSS written is the complement (the page is colour-wheel inverted)
  * re-sweeping is idempotent (baselines, not our own cyan)
  * the rule persists as {match:'color', from:...} and removing it reverts

Requires Node 22+ (global WebSocket) and Chrome. No npm packages.

Usage: python scripts/test-tone-live.py [--target DIR]
"""
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.abspath(sys.argv[sys.argv.index("--target") + 1]) if "--target" in sys.argv else ROOT
URL = ("https://www.quantamagazine.org/"
       "sea-monkeys-show-scientists-how-to-rewrite-a-rule-of-turbulence-20261002/")


def node():
    for c in (r"D:\Programs\nodejs\node.exe", shutil.which("node"), shutil.which("nodejs")):
        if c and os.path.exists(c):
            return c
    return None


def main():
    nd = node()
    if not nd:
        print("SKIP no node on PATH (needs Node 22+ for the built-in WebSocket)")
        return 0
    driver = os.path.join(ROOT, "scripts", "cdp-eval.mjs")
    payload = os.path.join(ROOT, "scripts", "test-tone-live.js")
    cmd = [
        nd, driver,
        "--url", URL,
        "--inject", "css=" + os.path.join(TARGET, "content.css"),
        "--inject", "tuner=" + os.path.join(TARGET, "tuner.js"),
        "--test", payload,
        "--settle", "2500",
    ]
    run = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if run.returncode != 0:
        print(run.stderr.strip() or "driver failed")
        return 1
    try:
        lines = json.loads(run.stdout)
    except Exception:
        print(run.stdout[-2000:])
        print("could not parse driver output")
        return 1

    fails = 0
    for line in lines:
        if line.startswith("FAIL"):
            fails += 1
        print("   " + line)
    print("\n%s (%d failure%s)" % ("ALL PASS" if not fails else "FAILURES",
                                   fails, "" if fails == 1 else "s"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
