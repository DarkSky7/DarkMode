# DarkMode — darkener for the resistant cases

A browser extension that darkens by **CSS filter inversion** — the flip that
reaches inline styles, canvases and `color-scheme: light` lock-ins that polite
per-element darkening cannot — and then paints the resulting white/grey ink in a
**palette colour you choose** (cyan by default).

It also carries a per-site palette override and a switch for every automatic
decision, because the extension no longer waits to be asked.

## Behavior contract (changed in 1.1.0 — read this, it is not what 1.0.x said)

- **Dark by default.** Every page is darkened unless you say otherwise. This
  *replaces* the old "does nothing until asked" promise, at the owner's explicit
  request (2026-11-27): *"automatically going Dark Mode to previously unseen
  sites by default (violating our claim that it does nothing until asked)"*.
  `dmAuto: false` restores the old behaviour exactly.
- **A site counts as dark** if it was remembered (`darkHosts`), or if auto-dark
  is on and the site is not in `dmLightHosts`. A remembered site always wins over
  an exclusion; the DENY list (Gmail) wins over both.
- **A page that is already dark is handed back.** `toneNatural()` reads
  `color-scheme` (including `light dark` under a dark OS preference), then the
  page's own background, then its ink, and the guards back out at
  DOMContentLoaded and again after `load`. Darkening a dark page would fake the
  light look it came from.
- **One click, two meanings, labelled both ways.** With auto-dark on, the popup's
  checkbox reads *"Keep &lt;host&gt; light"* and writes `dmLightHosts`. With it off,
  the old *"Always dark on &lt;host&gt;"* meaning is back.
- **Per-visit toggles never persist**; a by-hand toggle also freezes every
  automatic decision for that tab.
- **Pieces are exempt from the invert** (`img / video / canvas / iframe / embed /
  object / svg image` are inverted back to natural colour), and a frame is judged
  by its own pixels (1.0.41).

## The palette (1.1.0)

Three storage keys, and their shape is the request:

- `dmInk` — the **master palette** ink. One colour for every site. Default
  `#2f9eae` (hue 188, 6.24:1 on near-black — unmistakably cyan without the
  eye-burning 15.8:1 of `#00ffff`).
- `dmAccent` — is the master palette applied at all (default **true**).
- `dmSiteInk` — `{ host: '#rrggbb' }`, the **per-site override**. Only a host
  that has an entry is ever written to, so a site override exists only if you
  made one. The key is the hostname with `www.` stripped (`w3.org`, not
  `www.w3.org`).

Precedence, lowest to highest: **master palette → site palette → your own saved
tone/selector rules.** The master rule is prepended to the rule list so a saved
rule always wins, and it is emitted first in the stylesheet.

What gets tinted: text whose ink is neutral and light (or neutral grey, or vivid
enough to read as glare — the predicates are `inkIsLight`, `inkIsNeutral`,
`inkIsGlare`), measured in *rendered* space. Ink on a **bright or saturated
plate** keeps its colour — cyan on a blue button is not an improvement — except
on a white plate, which the invert renders dark, so it is tinted. Labels on a
dimmed fill are offered the palette ink as a candidate and the 4.5:1 contrast
score decides.

Rules are scoped to `:root:is(.cr-dark,.cr-frame-dark)`, so "revert to light"
really does return the page to its own colours instead of leaving cyan ink on a
white page.

Measured 2026-11-27 on the installed 1.1.0 build (Chromium 140):

| page | auto-dark | accented elements | light-ink coverage | near-white pixels |
|---|---|---|---|---|
| lite.cnn.com | yes | 112 | 112 / 112, 0 left | 0.1% on, **88.3% off** |
| www.w3.org | yes | 149 | 66 / 66, 0 left | 17 left, all labels on dimmed fills where cyan fails 4.5:1 |
| example.com | **reverted** | 0 | — | `color-scheme: light dark` + dark OS preference ⇒ already dark |
| afuncan.com | **reverted** | 0 | — | body `rgb(8,6,24)` ⇒ already dark |
| www.rfc-editor.org | **reverted** | 0 | — | `color-scheme: dark` ⇒ already dark |

`accent` pixels are the exact cyan: 6.3% of the viewport on lite.cnn.com with the
engine on versus 0.0% with the class removed — the pixel proof, not a DOM claim.


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

### Iframes: restored by default, darkened when they ARE the page's own UI (1.0.41)

`iframe` is in the exempt list above, which is right for a video player or a
payment form and wrong for an app that ships its own **light** panel inside a
frame — the frame then renders light beside a darkened page. Home Depot's
"Added to Cart" flyout is exactly that (`<iframe id="thd-drawer-frame">`), and it
measured 0.950 mean luminance beside a 0.043 page.

So a frame is judged by its own pixels. `tuner.js` runs in every frame, and a
same-origin frame can reach its container via `window.frameElement`:

- **light frame, inverted page** → container gets `data-cr-frame="dark"`
  (content.css drops the restore so the page filter darkens it), the frame's
  `<html>` gets `cr-frame-dark` (media inside is re-inverted back to true colour),
  and its neutral ink is tinted with the accent — the drawer's white text is
  cyan, not white.
- **dark frame** → untouched; a dark app must not be inverted into a light one.
- **cross-origin frame** → `frameElement` is `null`, nothing runs; YouTube and
  payment embeds keep true colour.
- **unmeasurable frame** → left restored.

`invertDepth()` hops the frame boundary, because the page's `html` filter paints
the frame's content and the frame element's own filter cancels it; without the
hop every colour decision inside a frame would be written un-complemented. The
bright-fill ceiling and photo dimmer deliberately do **not** run in frames — they
write inline `!important` values keyed to a parity that flips when a frame is
darkened (measured: the photo came out `brightness(0.82)` with no invert, i.e. a
dimmed negative).

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

## Tuning in place (the "Tune in place" panel)

Point at any element on the inverted page and tune it without writing CSS. The
**apply** dropdown is the whole reach story — pick the scope that covers what you
mean, not the class you happened to click:

| Scope | What it tags |
|---|---|
| `this element only` | a single unique path |
| `≈ all text #xxxxxx` | every element rendering **that exact** colour |
| `≈ everything light` | every text element whose ink reads as light (WCAG luminance ≥ 0.45) — **widest reach**, and it keeps covering text the site adds later |
| `≈ all text <dominant>` | the colour most visible text uses |
| `.<class>` | one CSS class, with the element count it reaches |

Two things learned the hard way on `ambientweather.net` (1.0.22):

- **Dominance is counted over VISIBLE text only.** It used to include
  `display:none` and off-screen nodes, so an accent colour that 167 elements
  "had" and a dozen showed was called dominant; the picked colour was then not
  dominant and the default scope fell through to a single class (`.fdp-val`, 56
  of 129 light-text elements), so the numbers recoloured and every label stayed
  white.
- **The panel reports coverage.** After a save it says `covers N of M light-text
  elements · K still light`, with a `⚡ Also cover everything light` button. A
  rule that reaches half the page is now visible as such instead of looking
  finished.

Reach mechanics, all of which cost one stylesheet rule regardless of element
count: the sweep **measures every element before tagging any** (tagging a parent
repaints its children through inheritance, so a one-pass loop loses them); SVG
`<text>` is measured by `fill` and painted with `fill`; `background-clip: text`
gradients are counted and left alone rather than silently missed; and a later
rule outranks an earlier one where they overlap, so "everything light" actually
wins over a narrower rule saved before it.

## Dev notes

- Node for syntax checks: `/c/Users/Mike2/AppData/Local/hermes/node/node.exe`
  (`node --check content.js popup.js background.js`).
- On every edit bump BOTH `manifest.json` "version" and the in-script
  `VERSION` constants so `about:debugging` / the popup show an honest build.

### Measuring the palette on a live page (1.1.0)

`scripts/probe-darkmode-live.mjs` opens a **new** tab (never the user's), reads
what the installed build actually did, then also evaluates inside the
extension's **isolated world** — where `window.__dmTuner` exists. It reports
written vs rendered colour separately, the tag count, `coverage()`, and any
uncaught error from either world.

    node scripts/probe-darkmode-live.mjs --port 9222 --url https://lite.cnn.com/
    node scripts/probe-darkmode-live.mjs --port 9222 --url URL --set '{"dmInk":"#d98c00"}'
    node scripts/test-plate-guard.mjs  --port 9222 --url https://lite.cnn.com/
    node scripts/shot-darkmode-pair.mjs --port 9222 --url https://lite.cnn.com/
    python <browser-extension-authoring>/scripts/pngstat.py on.png off.png --accent 47,158,174

Four traps these scripts exist to avoid, all of which produced false results in
one session:

- **`window.__dmDarkMode`/`__dmTuner` is null in the page world** — the content
  script is an isolated world, so a page-realm probe "proving" the hook is
  missing proves nothing. Ask the isolated context by name.
- **`data-dm-ver` is written before the sweep**, so a page that threw inside
  `applyRules` looks loaded-but-un-tinted with no error visible. Capture
  `Runtime.exceptionThrown`.
- **A single `\d` inside the probe's template literal becomes `[/d+/]`**, and a
  residual audit then returns an empty list while seventeen elements are plain
  white. Parse with `[0-9.]` classes instead.
- **Plant BLACK ink to test the accent.** The page is inverted: site `#fff` ink
  renders black, so a synthetic white-on-white case "correctly" gets no accent
  and the test passes while testing nothing.

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

