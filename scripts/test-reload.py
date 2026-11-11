#!/usr/bin/env python3
"""Prove a saved tuning rule survives a RELOAD — the way the browser actually loads it.

Mike, 2026-11-11: "I selected save for this host and reloaded the page but it
didn't reassert the foreground color change after the refresh ... or darken."

Both halves were real:

  1. THE SWEEP NEVER RAN. The mutation observer waited for 250 ms of DOM quiet
     before its first sweep and reset that timer on every batch. A news page
     never goes quiet; on a cold load the page mutated past the 3 s mark, so 0
     elements were tagged while a manual sweep the same instant tagged 193.
  2. THE SITE WAS NEVER REMEMBERED. "Save for this host" stored the tuning rule
     but not the host in darkHosts, so the reloaded page was not inverted and a
     rule recorded in the colours of a DARKENED page had nothing to match.

Every earlier test missed this because it injected the scripts into an
already-loaded page, where one immediate sweep sees the whole document. This one
uses CDP's addScriptToEvaluateOnNewDocument to run content.css + content.js +
tuner.js at document_start, then navigates — i.e. a genuine reload.

Variants: remembered (normal), ?dmstub=slow (storage lands 150 ms late),
?dmstub=noremember (host not in darkHosts — documented consequence).

Usage: python scripts/test-reload.py [--target DIR]
"""
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.abspath(sys.argv[sys.argv.index("--target") + 1]) if "--target" in sys.argv else ROOT
BASE = ("https://www.quantamagazine.org/"
        "sea-monkeys-show-scientists-how-to-rewrite-a-rule-of-turbulence-20261002/")
VARIANTS = [("remembered", ""), ("slow storage", "?dmstub=slow"), ("un-remembered", "?dmstub=noremember")]


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
    fails = 0
    for label, qs in VARIANTS:
        cmd = [
            nd, driver, "--cold", "--url", BASE + qs,
            "--style", "css=" + os.path.join(TARGET, "content.css"),
            "--page-script", "stub=" + os.path.join(ROOT, "scripts", "stub-storage.js"),
            "--page-script", "content=" + os.path.join(TARGET, "content.js"),
            "--page-script", "tuner=" + os.path.join(TARGET, "tuner.js"),
            "--test", os.path.join(ROOT, "scripts", "test-reload.js"),
            "--settle", "3000",
        ]
        run = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
        print("== " + label)
        if run.returncode != 0:
            print("   FAIL driver: " + (run.stderr.strip().splitlines() or ["?"])[-1])
            fails += 1
            continue
        try:
            lines = json.loads(run.stdout)
        except Exception:
            print("   FAIL could not parse driver output: " + run.stdout[-400:])
            fails += 1
            continue
        for line in lines:
            if line.startswith("FAIL"):
                fails += 1
            print("   " + line)
    print("\n%s (%d failure%s)" % ("ALL PASS" if not fails else "FAILURES",
                                   fails, "" if fails == 1 else "s"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
