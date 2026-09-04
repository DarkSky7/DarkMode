# DarkMode — AMO submission (paste-ready)

Route: **AMO Developer Hub, web UI, UNLISTED self-distribution** (AMO signs;
we host the .xpi in GitHub Releases + fleet pages). Account: Michael Landis
(personal — matches the SSRN publishing identity). License: MPL-2.0.
Homepage/support: the product's own repo — `https://github.com/DarkSky7/DarkMode`.
**Decision (2026-09-04, Mike): Chrome Web Store NOT targeted — AMO unlisted
only (free, matches the Zen/Firefox install base).**

## Listing fields

- **Name:** DarkMode — resistant-site darkener
- **Summary (≤250 chars):**
  Does nothing until asked. Click the toolbar icon on sites that resist dark
  mode (inline styles, canvases, transparent-root pages like Foxglove docs) to
  darken them; optionally remember a site so it auto-darkens on future visits.
- **Detailed description:**
  DarkMode is for the resistant cases — sites that shrug off ordinary
  dark-mode extensions. Most darkeners politely override element styles;
  DarkMode instead flips the rendered page across the color wheel
  (white→black, black→white, red↔cyan, yellow↔blue) via a CSS filter, which
  reaches inline styles, canvases, `color-scheme: light` lock-ins, and pages
  whose white background is the browser canvas behind a transparent root.
  Pictures are exempt: images, video, canvases and embedded frames are flipped
  back to their natural colors.

  It does nothing until you ask:
  - Click the toolbar icon → **Darken this page** (this visit only).
  - Tick **Always dark on <site>** → the site auto-darkens on future visits
    (stored locally in browser sync storage; nothing is ever auto-added).
  - The active button reads **Disable Dark Mode override** — one click reverts.

  Settings are stored in the browser's own extension storage. No accounts, no
  servers, no remote code. Known trade-off of the filter tactic: `position:
  fixed` headers can misbehave on some pages; screenshots capture the dark
  rendering.
- **Categories:** Appearance (or "Photos, Music & Videos" if Appearance is
  unavailable in the chosen store region).
- **Homepage:** https://github.com/DarkSky7/DarkMode
- **Support URL:** https://github.com/DarkSky7/DarkMode/issues

## Privacy policy (ready-to-paste — collects nothing)

> DarkMode collects no data. It has no analytics, no tracking, no remote code,
> and no network requests of its own. The list of sites you choose to darken is
> stored locally in the browser's extension storage (synced only by the
> browser's own sync service, if you enable it) and is never transmitted
> anywhere by this extension.

## Version notes (1.0.0)

- First public release.
- Color-wheel inversion engine proven against the resistant case
  (foxglove.dev docs): forced white root background under `invert(1)` covers
  transparent-root pages (the v0.1.x lesson — measured 86% of pixels → black).
- On-demand injection so the icon works on tabs open before install/update.
- Remembered-site allowlist (storage.sync), per-visit toggle, active button =
  "Disable Dark Mode override".

## AMO submission steps (one-time + per version)

1. https://addons.mozilla.org/developers/ → register/sign in as the personal
   account → complete developer profile.
2. "Submit a New Add-on" → **"On your own"** (self-distribution; AMO signs,
   you host) → upload `dist/DarkMode-1.0.0.xpi`.
3. Paste fields above; privacy policy text above is required for the listing.
4. Await automated validation + (for unlisted) signing — no human review queue
   for unlisted. Download the signed .xpi from the version page.
5. Host the signed xpi in a GitHub Release + link from fleet pages.

## Packaging (local, reproducible)

```
python scripts/make-icons.py        # regenerate icons if ever needed
python scripts/package.py 1.0.0     # dist/DarkMode-1.0.0.{zip,xpi}, MD5 printed
```

zip and xpi are byte-identical (same staging, fixed timestamps) — verify with
`md5sum` before every upload, and re-render any page that references the hash.
