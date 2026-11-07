# DarkMode — darkener for the resistant cases

A browser extension that **does nothing until asked**. On sites that shrug off
ordinary dark-mode extensions (inline styles, canvases, `color-scheme: light`
lock-in — e.g. **foxglove.dev**), click the toolbar icon and the page goes dark
via CSS filter inversion, which flips what polite per-element theming can't
reach. Optionally *remember* a site so it auto-darkens on future visits.

## Behavior contract

- **Inert by default.** No site is touched until the user asks. Installed and
  enabled ≠ anything happens.
- **Ask = click the toolbar icon** → "Darken this page" (one-shot, this tab).
  The popup shows the live state; the button toggles back.
- **Remember = check "Always dark on \<host\>"** in the popup. The host is
  stored in `storage.sync`; future visits auto-darken at `document_start`
  (no light flash). Uncheck to forget. Nothing is ever auto-added — only the
  user includes sites.
- Per-visit toggles never persist. Reload a non-remembered page → light again.

## Engine

Color-wheel inversion (`html.cr-dark { filter: invert(1) }`): white→black,
black→white, every hue → its complement (red↔cyan, yellow↔blue) — the flip
that reaches inline styles, canvases and `color-scheme: light` lock-ins that
polite per-element theming can't. **Pictures are exempt**: `img / video /
canvas / iframe / embed / object / svg image` are inverted back to natural
colors. No hue-rotate, no forced root background (user spec
2026-09-04 — a forced background under the filter would invert into a light
wash). Gated entirely on an `<html>` class the content script adds — the rules
are inert without it.

> **Do not add `picture` to that list (1.0.14).** Filters compose, so the page
> invert plus one re-invert cancel; two re-inverts do not. Responsive images are
> `<picture><source…><img></picture>` and the `<img>` is what paints, so listing
> both inverted those photos twice — net 3 — and every product thumbnail at a
> shop using `<picture>` rendered as a negative (measured shop.watercool.de:
> 8/10 thumbnails net=3 while the plain-`<img>` logo was correctly net=2).
> The `img` rule already covers every picture's painted child.

Known trade-offs of the filter tactic (accepted for the resistant case):
- `position: fixed` headers can misbehave (a filter on the root makes them
  behave like their containing block) — cosmetic on most pages.
- Canvas/webgl apps (e.g. embedded Studio) are inverted as a whole; hues land
  on complements, which is the requested wheel-flip behavior for a light app.
- Screenshots/screen-share of the page will capture the dark rendering.

## Install (daily Chromium — permanent)

`chromium://extensions` → Developer mode → **Load unpacked** → this repo dir
(`manifest.json` at root). Persists across restarts. Zen/Firefox:
`about:debugging#/runtime/this-firefox` → Load Temporary Add-on →
`manifest.json`.

## Dev notes

- Node for syntax checks: `/c/Users/Mike2/AppData/Local/hermes/node/node.exe`
  (`node --check content.js popup.js background.js`).
- On every edit bump BOTH `manifest.json` "version" and the in-script
  `VERSION` constants so `about:debugging` / the popup show an honest build.
- Test target #1: **foxglove.dev** (resists the stock Dark Mode extension).
  Load unpacked, click the icon on a foxglove.dev page, then tick "Always dark".

## INSTALL PATH + RELEASE STEPS (read before editing)

**The browser does NOT load this repo root, and it does not necessarily load the
newest `dist/` directory either.** The only reliable answer to "which copy is
live?" is the absolute path recorded when the extension was added as unpacked.
Chromium-family browsers store it in `<profile>/Secure Preferences`:

    python scripts/loaded-ext-paths.py      # prints every registered path

Read that BEFORE believing a release shipped. On 2026-11-05 this cost a whole
session: builds 1.0.8 and 1.0.9 were staged into `dist/DarkMode-1.0.8` and
`dist/DarkMode-1.0.9` and mirrored to `dist/DarkMode-current`, while Brave was
still loading `dist/DarkMode-1.0.8` — a *versioned* directory from the previous
release. Every command printed success; the user saw no change.

Canonical artifacts per release:

    dist/DarkMode-<version>/     <- "Load unpacked" target
    dist/DarkMode-<version>.zip  <- Chromium archive
    dist/DarkMode-<version>.xpi  <- Firefox / Zen / AMO
    dist/DarkMode-current/       <- stable mirror of the newest build

Release checklist — skip any step and a change ships "successfully" and does
nothing:

1. Bump the version in **all three** places. Miss `popup.js` and the popup
   cheerfully displays the OLD version while running the new code:
   - `manifest.json` → `version`
   - `content.js` → `const VERSION`
   - `popup.js` → `const VERSION`
2. Build: `python scripts/package.py`
   Stages `dist/DarkMode-<ver>/` + zip + xpi, mirrors `DarkMode-current`, **and
   copies the new files into every path `loaded-ext-paths.py` reports** — so the
   copy the browser reads is never left behind. It prints the paths it synced; if
   it prints no path, nothing is installed and the build has not shipped.
3. Verify the artifacts: `python scripts/verify-release.py`
   Checks manifest at archive root, version, Chromium vs Firefox background
   shape, gecko id, and that bundled `content.js` matches the repo.
4. In `brave://extensions`, **Reload** the DarkMode card (unpacked content
   scripts are re-read from disk only on extension reload), then refresh the page.
5. Keep exactly **one** unpacked entry registered. Duplicate entries are
   separate extensions with separate settings: each injects its own content
   script, and the "Always dark on <host>" tick you set on one does not apply to
   the others — which alone makes a correctly-installed build look inert.
6. Both browsers, not just one. `loaded-ext-paths.py` reads the paths the
   browsers actually registered (Brave **and** Chromium) and `package.py` copies
   into each. Chromium sat on 1.0.3 through eleven releases because only Brave
   was ever scanned; check the version each one reports, don't assume.
7. AMO (for Zen/Firefox): upload `dist/DarkMode-<ver>.xpi` to the listed channel.
   **An upload is not a signature.** The version sits at `file.status =
   unreviewed` with `signed_date = null`, and the file URL serves the UNSIGNED
   zip — no `META-INF/` at all, which Firefox refuses to install. The signature
   appears only after approval, which is Mozilla's schedule, not ours.
   `scripts/amo-watch-signature.py` polls for it, fetches the SIGNED xpi into
   `signed/`, refreshes `darkmode-latest.xpi`, and says one line when it lands
   (silent otherwise). Verify a downloaded xpi by its `META-INF/` entries before
   telling anyone it's installable.

History, so this isn't repeated: 1.0.4 and 1.0.5 were committed with no package
built and no popup bump, so the browser kept loading `dist/DarkMode-1.0.3` while
the repo claimed a fix — reported as "reload keeps showing 1.0.3". Two stale
registry entries then degraded to `path=None` in Secure Preferences and injected
nothing at all. Then 1.0.9 hit the same class of bug from a different direction
(a versioned load path, not a missing build).

`scripts/sync-to-brave.sh <dir>` syncs to the registered paths *plus* any extra
directory you pass. It exists for stray copies (historically
`D:\Programs\DarkMode\DarkMode`); nothing under `D:\Programs` is registered in
Brave any more, so that tree is dead weight and should be deleted rather than
kept in step.

