# DarkMode 1.3.0 — the class can be wiped; the palette can reach an image

Two asks from Mike, 2026-11-30:

> Definitely chase the Wikipedia issue. In the most general way possible, can you try
> to make the white text over that footer image cyan as well?

## 1. Wikipedia was never the guard — the page deleted our marker

`en.wikipedia.org` rendered light with **no error anywhere**, and 1.1.1 behaved
identically, which is why this looked like "the already-dark guard misfires". It was
never the guard. A class-timeline probe from `document_start` settled it:

```
t=1ms    client-nojs vector-feature-… skin-theme-clientpref-day …   init
t=5ms    … skin-theme-clientpref-day … cr-dark                       mut   <- ours
t=9ms    client-js  vector-feature-… skin-theme-clientpref-day …      mut   <- page
```

Wikipedia adds `client-nojs` at parse time and then **replaces the entire `className`
string** with its `client-js …` set. Our marker was added at 5 ms and was gone at
9 ms. The page is light (`rgb(248,249,250)`, `color-scheme: normal`), so nothing was
wrong with the tone decision at all — the marker was simply deleted.

**Fix.** `apply()` sets `engineWanted = true` and installs a `MutationObserver` on
`<html class>`; if the marker disappears while the engine is still wanted it is
re-asserted (and the tuner re-swept, because media and background photos were computed
against a tree that lost its filter). `revert()` is the only thing that stops it, so
"turn off for this site" still wins. Re-assertions are logged (first three) so the next
occurrence is diagnosable instead of invisible.

Measured after the fix: `engineOn true`, **1139** accented, **0** near-white text owners
(was 0 accented, i.e. not darkened at all).

## 2. The palette over an image plate, in general

1.2.0 deliberately left image-plate ink alone: an image has no colour readable from CSS,
so any ink write is a guess. But a plate does not have to *stay* unmeasurable.

`content.js` already publishes the measured mean luminance (`data-cr-bgmean`) of every
opaque background-image plate. Alpha blending is linear in sRGB **values**, so the
luminance of a plate under a black inset scrim is exactly computable. That turns
"unknown plate" into "plate of known luminance" — all the ink engine ever needed.

The rule, with nothing site-specific in it:

1. Candidates are the palette itself, then tints of it blended toward white
   (25% / 50% / 72%) — **hue preserved, only lightness adapts**.
2. For each candidate, solve by bisection the **smallest** scrim alpha that reaches
   **4.5:1**. Take the first candidate whose alpha fits inside the cap (0.65).
3. If none does, use the cap with the best candidate, and if even that is below **3.0:1**
   paint nothing — the native contrast 1.2.0 established is better than a bad guess.
4. Apply the scrim as an inset `box-shadow` (black — an island has its page filter
   cancelled, so this is native space, not the inverted-context polarity `solveOverlay`
   handles) and write the ink on the island's text owners with `rememberBase` markers,
   so `__dmUnpaint()` and an accent toggle both revert it exactly.

### Measured

newtonpaisley.com footer band, pixel histograms:

| release | ink | plate | contrast |
|---|---|---|---|
| 1.1.1 | `#f4f7fa` | `#c7bbc7` | 1.71:1 |
| 1.2.0 | `#f2f2f2` (site's own) | `#384438` | 8.3:1 |
| 1.3.0 | `#63b6c2` (palette +25%) | `#151b15` | **7.5:1** |

In the live Chromium tab: ink `#77b4c0` on `#191d18` ≈ **7.3:1**, scrim α 0.573, fabric
still clearly visible.

Controlled two-plate fixture (`coverage 1.000` both):

- dark plate `meanL 0.148` + light ink → island, canvas **uses the exact palette**
  `rgb(47,158,174)` (it reaches 4.5 within the cap at α 0.604 — no tinting needed)
- light plate `meanL 0.927` + dark ink → **not** an island, unchanged path, no palette

Regression set unchanged: `lite.cnn.com` 112 accented / 0 near-white;
`python.org` 265 accented / 135 labelled / 17 pale; `w3.org` 149 accented.

## Packaging

`addons-linter` on `DarkMode-1.3.0-firefox.xpi`: **0 errors / 0 notices / 0 warnings**.
`dist/DarkMode-current` and `dist/DarkMode-1.0.25` synced to 1.3.0.
