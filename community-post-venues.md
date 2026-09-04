# DarkMode — community venues (paste-ready)

Product home / bug tracker / downloads: https://github.com/DarkSky7/DarkMode
(never the fleet .cc sites). Distribution = AMO unlisted signing + GitHub
Releases hosting the signed xpi + Chromium load-unpacked instructions in README.

## r/firefoxaddons (Reddit)

Title: DarkMode — darkens the sites that resist dark mode (does nothing until you ask)

Body:
I made a tiny Firefox/Chromium extension for the annoying 5%: sites that
shrug off ordinary dark-mode extensions. Foxglove's docs were my test case —
its white background is the browser canvas behind a fully transparent page,
which element-level darkening can never reach, and even filter-based darkeners
miss because there's nothing to invert on the root.

DarkMode flips the rendered page across the color wheel instead: white→black,
black→white, red↔cyan, yellow↔blue (plain CSS `invert(1)`), with a white root
background so transparent-canvas pages go properly black (measured 86% of
pixels). Pictures are exempt — images/video/canvas are flipped back to natural.

It does nothing until you ask: click the toolbar icon to darken the current
page; tick "Always dark on <site>" to remember it (stored locally). Active
state reads "Disable Dark Mode override".

No accounts, no analytics, no remote code, no data collected. MPL-2.0.
Unlisted on AMO (signed xpi in GitHub Releases); Chromium users load unpacked.

Dev trap I hit that others might dodge: a forced background-color on the
filtered element gets inverted too — dark became a light wash, and removing it
entirely fixed nothing (transparent root). The answer is white, which inverts
to black. Also: Firefox MV3 wants background.scripts paired with
service_worker, and AMO requires the archive to contain manifest.json at the
root — a version-folder wrapper gets rejected.

## Mozilla Discourse (add-ons section)

Subject: DarkMode — color-wheel darkening for resistant sites

Same content, professional register: one paragraph on the mechanism
(rendered-page inversion + white root bg for transparent-canvas pages, media
exempt), the "does nothing until asked" contract, the privacy line (collects
nothing; settings local), MPL-2.0, AMO unlisted + GitHub Releases hosting.

## Discord (short, 3 messages)

1. Ship announcement: "DarkMode 1.0.1 is out — darkens sites that resist dark
   mode (foxglove.dev docs included). Does nothing until you ask; click the
   icon, or remember a site. AMO signed xpi + Chromium unpacked: repo link."
2. PSA: "If a site looks half-dark, it's the transparent-canvas case — the fix
   is in the engine (white root under invert). Load unpacked in Chromium for
   the same behavior."
3. Link to the repo / release.

## Fleet pages (optional, later)

If a fleet site ever carries a tools/software section, a one-line card:
"DarkMode — browser extension that darkens resistant sites" → GitHub Releases.
No bug reports on fleet sites (product home = its own repo).
