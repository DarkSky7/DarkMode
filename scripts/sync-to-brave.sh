#!/usr/bin/env bash
# Sync the repo into the UNPACKED copy Brave actually loads.
#
# WHY THIS EXISTS (2026-10-28): Brave loads this extension from
#   D:\Programs\DarkMode\DarkMode
# which is a COPY, not the repo. Two versions of Gmail fixes (1.0.4 and 1.0.5)
# were committed here and never reached the browser, so the user kept seeing
# the old behaviour while the repo claimed a fix. Always run this after editing,
# then click Reload on DarkMode in brave://extensions (an unpacked extension's
# content scripts are re-read from disk only on extension reload).
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="${1:-/d/Programs/DarkMode/DarkMode}"

[ -d "$DST" ] || { echo "target not found: $DST" >&2; exit 1; }

FILES=(content.js content.css background.js popup.js popup.html popup.css manifest.json)
for f in "${FILES[@]}"; do
  cp "$SRC/$f" "$DST/$f"
done
if [ -d "$SRC/icons" ]; then cp -r "$SRC"/icons/* "$DST/icons/" 2>/dev/null || true; fi

echo "synced -> $DST"
echo -n "version: "; grep -m1 '"version"' "$DST/manifest.json"
for f in content.js content.css manifest.json; do
  diff -q "$SRC/$f" "$DST/$f" >/dev/null || { echo "MISMATCH after copy: $f" >&2; exit 1; }
done
echo "verify: byte-identical to repo"
echo "NOW: brave://extensions -> DarkMode -> Reload, then refresh Gmail"
