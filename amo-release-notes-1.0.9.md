# DarkMode 1.0.9 — AMO release notes (paste-ready)

Upload artifact: `dist/DarkMode-1.0.9.xpi` (MD5 `c6447abd503c48a67802dcf3d5934ff0`, 21,367 B)
Route: AMO Developer Hub → web UI → unlisted self-distribution (see `amo-submission.md`).

Covers 1.0.8 and 1.0.9 together — 1.0.8 was built but never uploaded, so treat
these as the changes since 1.0.7.

## Release notes field (paste as-is)

```
Adds a second dark engine for sites where inverting colours is the wrong tool,
and stops light background tiles from covering it up.

Until now DarkMode worked by inverting the page's colours. That is fine for
text-heavy pages, but on image-heavy sites it is destructive: a page whose body
is a light blue becomes brown, and every photograph is run through the filter
too. Sites like that now get a repaint engine instead. The page keeps its own
colour relationships, the canvas is darkened, and each surface is repainted
individually by comparing it against the colour actually behind it. Images,
video, canvas and SVG are never filtered or recoloured, so photographs keep
their true colours.

Text legibility is now judged by real WCAG contrast against the backdrop rather
than by raw brightness. The old test called a saturated mid-blue "legible" at
2.89:1; coloured accents keep their hue and are lightened until they pass
instead of being flattened to grey.

Two problems that made earlier versions silently do nothing are fixed:

- A surface could stop being updated after the site re-rendered it. The
  extension now re-checks the rendered colour every pass instead of trusting a
  marker it left behind, so a repainted element is repaired rather than skipped
  forever.
- Themes such as jQuery UI paint a section with a background colour and then
  cover it with a repeating image tile. Darkening the colour had no visible
  effect because the tile sits on top. Each tile is now fetched, decoded and
  downsampled; if it is flat and light it is treated as a decorative plate and
  removed, revealing the dark surface underneath. If it is a photo or a
  pattern, or it cannot be read, it is left exactly as it is.

No new permissions are requested, and the extension still does nothing on a
site until you ask it to.
```

## Reviewer note

The plate check is the only place DarkMode fetches anything, and it only ever
requests background images the page has already loaded, on the site you have
already enabled DarkMode for. The image is decoded in memory, averaged to 16x16,
and discarded — nothing is stored, and no pixel data leaves the page. When a
fetch fails (cross-origin or blocked), the tile is left untouched and a warning
is logged rather than guessed at.

## Source of truth for "which copy is live"

Brave/Chromium do **not** load the repo root or `dist/DarkMode-<newest>`. They
load whatever absolute path was recorded when the extension was added as
unpacked, which is stored in `<profile>/Secure Preferences`. Read it with
`python scripts/loaded-ext-paths.py` before believing any build has shipped:
a build that does not land in that directory is a no-op that still prints
success. `scripts/package.py` now copies each build into every registered path.
