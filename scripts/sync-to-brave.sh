#!/usr/bin/env bash
# Sync the repo into every UNPACKED copy Brave actually loads.
#
# WHY THIS EXISTS (2026-10-28, rewritten 2026-11-05):
# Brave loads this extension from a directory that is NOT the repo. Two versions
# of the Gmail fix (1.0.4, 1.0.5) were committed and never reached the browser.
# The first script hard-coded one path (D:\Programs\DarkMode\DarkMode) and then
# THAT went stale too: by 1.0.9 the user had re-added the extension from
#   F:\Documents\GitHub\DarkMode\dist\DarkMode-1.0.8   <- VERSIONED directory
# so building "DarkMode-1.0.9" plus mirroring "DarkMode-current" changed nothing
# the browser read, and the known-stale-version symptom came straight back.
#
# So: STOP GUESSING. Read the paths out of Brave's own Secure Preferences and
# sync into each one. If none is found, fail loudly — a silent no-op here is
# indistinguishable from a successful sync.
#
# Usage: scripts/sync-to-brave.sh [extra-target-dir ...]
# Then: brave://extensions -> DarkMode -> Reload (content scripts are re-read
# from disk only on extension reload), then refresh the page.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"

# USER is not exported in this MSYS shell under `set -u`; derive it.
PROFILE_USER="${USER:-${USERNAME:-$(basename "$HOME")}}"
PROFILES=(
  "/c/Users/$PROFILE_USER/AppData/Local/BraveSoftware/Brave-Browser/User Data/Default"
)

# --- discover the unpacked targets Brave has registered -----------------------
TARGETS=()
while IFS= read -r line; do
  line="${line%$'\r'}"          # Windows python prints CRLF; a stray \r breaks -d
  [ -n "$line" ] && TARGETS+=("$line")
done < <(python "$SRC/scripts/loaded-ext-paths.py" "${PROFILES[@]}" || true)

TARGETS+=("$@")

if [ "${#TARGETS[@]}" -eq 0 ]; then
  echo "FATAL: no unpacked DarkMode target found in Brave's Secure Preferences." >&2
  echo "       Load it once via brave://extensions -> Developer mode -> Load unpacked," >&2
  echo "       or pass the directory explicitly: $0 <dir>" >&2
  exit 1
fi

# --- copy + verify each ------------------------------------------------------
# The file list is DERIVED FROM THE MANIFEST, never hand-maintained. The old
# hard-coded list omitted `tuner.js` — the whole "tune in place" feature — so
# every sync silently shipped a Brave copy without it, which is the same class
# of bug this script already got bitten by twice (see above). A manifest is the
# only authority on what an extension actually loads.
FILES=$(python - "$SRC/manifest.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1], encoding="utf-8"))
out = set()
bg = m.get("background") or {}
for k in ("scripts", "service_worker", "page"):
    v = bg.get(k)
    if isinstance(v, str):
        out.add(v)
    elif isinstance(v, list):
        out.update(v)
for cs in m.get("content_scripts", []):
    out.update(cs.get("js") or [])
    out.update(cs.get("css") or [])
popup = (m.get("action") or {}).get("default_popup")
if popup:
    out.add(popup)
for p in (m.get("icons") or {}).values():
    out.add(p)
for war in m.get("web_accessible_resources", []):
    res = war.get("resources") if isinstance(war, dict) else war
    for r in (res or []):
        if "*" not in r:
            out.add(r)
print(" ".join(sorted(out)))
PY
)
[ -n "$FILES" ] || { echo "FATAL: could not derive files from manifest.json" >&2; exit 1; }
read -ra FILEARR <<< "$FILES"
echo "files from manifest: ${FILEARR[*]}"

rc=0
for DST in "${TARGETS[@]}"; do
  [ -d "$DST" ] || { echo "skip (missing): $DST" >&2; continue; }
  bad=0
  for f in "${FILEARR[@]}"; do
    [ -f "$SRC/$f" ] || { echo "MISSING IN REPO: $f" >&2; bad=1; rc=1; continue; }
    mkdir -p "$DST/$(dirname "$f")"
    cp "$SRC/$f" "$DST/$f"
    diff -q "$SRC/$f" "$DST/$f" >/dev/null || { echo "MISMATCH: $DST/$f" >&2; bad=1; rc=1; }
  done
  if [ "$bad" -eq 0 ]; then
    printf 'synced -> %s  (version %s, %d files)\n' "$DST" \
      "$(python -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$DST/manifest.json")" \
      "${#FILEARR[@]}"
  fi
done

[ "$rc" -eq 0 ] || exit "$rc"
echo "verify: byte-identical to repo ($(grep -m1 '"version"' "$SRC/manifest.json"))"
echo "NOW: brave://extensions -> DarkMode -> Reload, then refresh the page"
