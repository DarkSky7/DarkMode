#!/usr/bin/env python3
"""Verify a DarkMode release artifact before it is handed out.

A zip that unzips into DarkMode-1.0.9/manifest.json is rejected by Chrome; an
xpi whose manifest still says background.service_worker is rejected by Firefox.
Both have happened, so check the shape rather than the file name.

Usage: python scripts/verify-release.py [version]
"""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
REQUIRED = ["manifest.json", "content.js", "content.css", "background.js",
            "popup.html", "popup.css", "popup.js"]


def check(path: Path, flav: str, ver: str) -> list:
    problems = []
    if not path.is_file():
        return [f"{path.name}: MISSING"]
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if "manifest.json" not in names:
            problems.append(f"{path.name}: manifest.json is not at the archive root "
                            f"(found: {names[:3]})")
            return problems
        for req in REQUIRED:
            if req not in names:
                problems.append(f"{path.name}: missing {req}")
        man = json.loads(z.read("manifest.json"))
        if man.get("version") != ver:
            problems.append(f"{path.name}: manifest version {man.get('version')} != {ver}")
        bg = man.get("background") or {}
        if flav == "chromium":
            if "service_worker" not in bg:
                problems.append(f"{path.name}: Chromium flavor lacks background.service_worker")
            if "scripts" in bg:
                problems.append(f"{path.name}: Chromium flavor must not use background.scripts")
        else:
            if "scripts" not in bg:
                problems.append(f"{path.name}: Firefox flavor lacks background.scripts")
        if flav == "firefox":
            gecko = (man.get("browser_specific_settings") or {}).get("gecko") or {}
            if gecko.get("id") != "darkmode@landis.cc":
                problems.append(f"{path.name}: gecko id is {gecko.get('id')!r}")
        # content.js must match the repo byte for byte
        if z.read("content.js") != (ROOT / "content.js").read_bytes():
            problems.append(f"{path.name}: content.js differs from repo source")
        print(f"  {path.name}: {len(names)} files, manifest v{man.get('version')}, "
              f"background={list(bg.keys())}, sha256={hashlib.sha256(path.read_bytes()).hexdigest()[:16]}")
    return problems


def main() -> int:
    ver = sys.argv[1] if len(sys.argv) > 1 else \
        json.loads((ROOT / "manifest.json").read_text())["version"]
    print(f"verifying release {ver}")
    problems = []
    problems += check(DIST / f"DarkMode-{ver}.zip", "chromium", ver)
    problems += check(DIST / f"DarkMode-{ver}.xpi", "firefox", ver)
    stage = DIST / f"DarkMode-{ver}"
    if not stage.is_dir():
        problems.append(f"{stage.name}/: staged dir MISSING (Load unpacked target)")
    else:
        sv = json.loads((stage / "manifest.json").read_text()).get("version")
        if sv != ver:
            problems.append(f"{stage.name}/: staged manifest {sv} != {ver}")
        print(f"  {stage.name}/: staged, manifest v{sv}")
    if problems:
        print("FAIL")
        for p in problems:
            print("  -", p)
        return 1
    print("PASS - all artifacts are structurally valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
