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
polite per-element theming can't. **Pictures are exempt**: `img / picture /
video / canvas / iframe / embed / object / svg image` are inverted back to
natural colors. No hue-rotate, no forced root background (user spec
2026-09-04 — a forced background under the filter would invert into a light
wash). Gated entirely on an `<html>` class the content script adds — the rules
are inert without it.

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
