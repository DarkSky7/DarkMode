#!/usr/bin/env python3
"""Package DarkMode for distribution: clean staging dir + reproducible zip/xpi.

Chrome-family MV3 rejects `background.scripts`, Firefox 121+/Zen wants the dual
(scripts + service_worker) shape — so the package is split by flavor:

  manifest.json (canonical, repo + "Load unpacked") = Chromium: service_worker only
  dist/DarkMode-<ver>/        <- point Chromium "Load unpacked" here
  dist/DarkMode-<ver>.zip     <- Chromium / archive distribution
  dist/DarkMode-<ver>.xpi     <- Firefox / Zen / AMO — dual background shape

Usage: python scripts/package.py [version]   (default: reads manifest.json)
Prints the MD5 of each package (zip != xpi by design; flavors differ).
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


def firefox_manifest_bytes() -> bytes:
    """Firefox/Zen flavor: dual background (scripts + service_worker)."""
    m = json.loads((ROOT / "manifest.json").read_text())
    m["background"] = {"scripts": ["background.js"], "service_worker": "background.js"}
    return json.dumps(m, indent=2, ensure_ascii=False).encode("utf-8")


def write_zip(path: Path, manifest_override: bytes | None = None):
    # AMO + about:debugging both require manifest.json at the ARCHIVE ROOT
    # (a version-prefix folder like "DarkMode-1.0.0/manifest.json" is
    # rejected). Entries are the bare filenames.
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in FILES:
            data = (stage / f).read_bytes()
            if f == "manifest.json" and manifest_override is not None:
                data = manifest_override
            info = zipfile.ZipInfo(f, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)


def main() -> int:
    ver = sys.argv[1] if len(sys.argv) > 1 else json.loads((ROOT / "manifest.json").read_text())["version"]
    global stage
    stage = DIST / f"DarkMode-{ver}"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    for f in FILES:
        dst = stage / f
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / f, dst)
    # also stage the Firefox flavor manifest (handy for Zen load-unpacked)
    (stage / "manifest.firefox.json").write_bytes(firefox_manifest_bytes())
    print(f"staged {len(FILES)} files -> {stage}")

    zpath = DIST / f"DarkMode-{ver}.zip"   # Chromium
    xpath = DIST / f"DarkMode-{ver}.xpi"   # Firefox / Zen / AMO
    write_zip(zpath)
    write_zip(xpath, manifest_override=firefox_manifest_bytes())
    for p in (zpath, xpath):
        print(f"{p.name}: MD5 {hashlib.md5(p.read_bytes()).hexdigest()}  ({p.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
