#!/usr/bin/env python
"""Print the directories Brave actually loads this unpacked extension from.

Brave records unpacked-extension paths in <profile>/Secure Preferences. Reading
that file is the only reliable answer to "which copy is live?" — source trees,
dist/ mirrors and doc comments have all been wrong about it at least once.

Usage: loaded-ext-paths.py [profile-dir ...]
Prints one MSYS-style path per line (ready for cp in bash). Exits 1 if none.

MSYS NOTES (cost an hour if forgotten):
  * this runs under WINDOWS python, so an argument like /c/Users/... is not a
    valid path — it must be converted to C:\\Users\\... before open().
  * $HOME in this shell is the Hermes profile home, not the user profile, so
    ~ expansion is wrong here. USERPROFILE is the trustworthy base.
"""
import glob
import json
import os
import re
import sys

BRAVE_REL = os.path.join("AppData", "Local", "BraveSoftware", "Brave-Browser", "User Data")

# Chromium is a second, independent consumer of this extension (2026-11-05).
# It loads an unpacked copy from D:\Programs\DarkMode\DarkMode and sat on 1.0.3
# through ten releases because this script only ever scanned Brave — so a
# "shipped" fix was never in the browser the user was actually looking at.
# Roots are (absolute path, profile-glob) pairs; missing roots are skipped.
CHROMIUM_ROOTS = [
    r"D:\Programs\Chromium\User Data",
    os.path.join("AppData", "Local", "Chromium", "User Data"),
]


def msys_to_win(path):
    """'/c/Users/x' -> 'C:\\Users\\x'. Leaves native paths untouched."""
    m = re.match(r"^/([A-Za-z])/(.*)$", path)
    if m:
        return "%s:\\%s" % (m.group(1).upper(), m.group(2).replace("/", "\\"))
    return path


def win_to_msys(path):
    """'C:\\Users\\x' -> '/c/Users/x'."""
    q = path.replace("\\", "/")
    m = re.match(r"^([A-Za-z]):/(.*)$", q)
    return "/%s/%s" % (m.group(1).lower(), m.group(2)) if m else q


def dirs_from_prefs(prefs_path):
    try:
        with open(prefs_path, encoding="utf-8", errors="replace") as fh:
            data = json.load(fh)
    except Exception as exc:                      # noqa: BLE001 - report, don't die
        sys.stderr.write("cannot parse %s: %s\n" % (prefs_path, exc))
        return []
    settings = (data.get("extensions") or {}).get("settings") or {}
    out = []
    for entry in settings.values():
        path = entry.get("path") or ""
        if "DarkMode" not in path:
            continue
        if os.path.isfile(os.path.join(path, "manifest.json")):
            out.append(win_to_msys(path))
    return out


def default_profiles():
    base = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    roots = [os.path.join(base, BRAVE_REL)] + CHROMIUM_ROOTS
    out = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        out.extend(p for p in glob.glob(os.path.join(root, "*")) if os.path.isdir(p))
    return out


def main(argv):
    profiles = [msys_to_win(p) for p in argv[1:]] or default_profiles()
    found = []
    for prof in profiles:
        prefs = os.path.join(prof, "Secure Preferences")
        if os.path.isfile(prefs):
            found.extend(dirs_from_prefs(prefs))
    seen = []
    for p in found:                               # de-dup, keep order
        if p not in seen:
            seen.append(p)
    for p in seen:
        print(p)
    if not seen:
        sys.stderr.write("no unpacked DarkMode entry in: %s\n" % ", ".join(profiles))
    return 0 if seen else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
