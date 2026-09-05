#!/usr/bin/env python3
"""Package DarkMode for distribution: clean staging dir + reproducible zip/xpi.

Usage: python scripts/package.py [version]   (default: reads manifest.json)

Output (byte-identical zip == xpi, forward slashes, fixed timestamps):
  dist/DarkMode-<ver>/      <- point "Load unpacked" here (Chromium)
  dist/DarkMode-<ver>.zip   <- Chromium/archive distribution
  dist/DarkMode-<ver>.xpi   <- AMO (Firefox/Zen) — same bytes, .xpi name
Prints the MD5 of both packages (they must match).
"""
import hashlib
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
    "icons/icon16.png",
    "icons/icon32.png",
    "icons/icon48.png",
    "icons/icon128.png",
    "icons/sun16.png",
    "icons/sun32.png",
    "icons/sun48.png",
    "icons/sun128.png",
]


def main() -> int:
    ver = sys.argv[1] if len(sys.argv) > 1 else json.loads((ROOT / "manifest.json").read_text())["version"]
    stage = DIST / f"DarkMode-{ver}"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    for f in FILES:
        dst = stage / f
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / f, dst)
    print(f"staged {len(FILES)} files -> {stage}")

    def write_zip(path: Path):
        # AMO + about:debugging both require manifest.json at the ARCHIVE ROOT
        # (a version-prefix folder like "DarkMode-1.0.0/manifest.json" is
        # rejected: "The package file must be a ZIP of the extension's files
        # themselves"). Entries are the bare filenames; the staging FOLDER keeps
        # its versioned name only for Load-unpacked.
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            for f in FILES:
                data = (stage / f).read_bytes()
                info = zipfile.ZipInfo(f, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, data)

    zpath = DIST / f"DarkMode-{ver}.zip"
    xpath = DIST / f"DarkMode-{ver}.xpi"
    write_zip(zpath)
    shutil.copyfile(zpath, xpath)
    md5 = hashlib.md5(zpath.read_bytes()).hexdigest()
    print(f"zip -> {zpath}")
    print(f"xpi -> {xpath}")
    print(f"MD5  {md5}  (zip == xpi)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
