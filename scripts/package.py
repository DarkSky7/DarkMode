#!/usr/bin/env python3
"""Package DarkMode for Chromium install: clean staging dir + reproducible zip.

Usage: python scripts/package.py [version]   (default: reads manifest.json)

Output:
  dist/DarkMode-<ver>/    <- point "Load unpacked" here (clean, no repo junk)
  dist/DarkMode-<ver>.zip <- archive copy (forward slashes, fixed timestamps)
"""
import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

FILES = [
    "manifest.json",
    "background.js",
    "content.js",
    "content.css",
    "popup.html",
    "popup.css",
    "popup.js",
]


def main() -> int:
    ver = sys.argv[1] if len(sys.argv) > 1 else json.loads((ROOT / "manifest.json").read_text())["version"]
    stage = DIST / f"DarkMode-{ver}"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    for f in FILES:
        shutil.copy2(ROOT / f, stage / f)
    print(f"staged {len(FILES)} files -> {stage}")

    zpath = DIST / f"DarkMode-{ver}.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for f in FILES:
            data = (stage / f).read_bytes()
            info = zipfile.ZipInfo(f"DarkMode-{ver}/{f}", date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)
    print(f"zip    -> {zpath}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
