# DarkMode 1.0.22 — reach every piece of white text, and say what is left

Reported on `ambientweather.net/dashboard/…`: *"after selecting the numeric
Fahrenheit temperature, and selecting a color, a bunch of numeric text switched
(as it should), but lots of non-numeric text stayed white. We need a way to reach
more classes."*

## The default scope was the bug, not the reach

Picking that reading offered **`.fdp-val → 56 elements`** as the default and took
it. The numbers recoloured; the 73 labels outside that class did not. Two
mistakes produced it:

- **"Dominant colour" counted text the user cannot see.** `display:none`,
  off-screen and 0×0 nodes were counted like visible ones, so the accent
  `#f65719` "had" 167 elements (a dozen visible) and was declared dominant — the
  colour the user had actually picked was then *not* dominant, and the default
  fell through to a class.
- **A class beat a colour group at 50% coverage.** `.fdp-val` reaching 56 of the
  page's 129 light-text elements counted as good enough.

Now dominance is counted over **visible** text only, and a class is only
preferred when it reaches essentially the whole colour group (90%). Picking the
same reading gives `≈ all text #cecdc9 → 102 elements (dominant)`, and a plain
Save leaves **0 of 102** light-text elements unreached.

## Reaching more on purpose

- **`≈ everything light`** — a threshold rule (WCAG luminance ≥ 0.45) that covers
  every light shade at once, including text the site renders after the rule was
  saved. That is the answer to "more classes": one rule, no class list, invariant
  in the number of elements.
- **Coverage, in the panel** — `covers N of M light-text elements · K still
  light`, plus `⚡ Also cover everything light` when anything is left. The old
  panel reported what one scope reached and said nothing about what it left
  behind, so a half-finished page looked finished.
- **A later rule outranks an earlier one** where they overlap, so the wider rule
  wins over a narrower one saved before it.

## Reach fixed at the mechanics, not just the UI

- **Measure-then-tag.** The sweep measured and tagged in one pass, in document
  order, so tagging a parent repainted its children *before* they were measured
  and they no longer matched. Two `<sup>` unit markers were lost from a
  102-element group this way.
- **SVG text.** Dial and gauge labels paint with `fill` and ignore `color`; they
  are now measured by `fill` and painted with `fill` (scoped to `text` elements
  only, so icons inside a tagged span are untouched).
- **Gradient text** (`background-clip: text`) is counted and reported rather than
  silently skipped.

## Verification

- `scripts/test-reach.py` — two cold loads of the live dashboard. Baseline: 7,041
  neutral-white ink pixels across 54 text rects. After "everything light → cyan":
  **0 neutral-white pixels**, 9,876 cyan, coverage 104/104, and the default scope
  asserted to be a colour group rather than a class.
- `scripts/test-inversion.py` now also asserts an inheriting child is tagged with
  its parent, that a later light rule outranks an earlier exact rule, and that on
  a light page the threshold rule leaves dark ink alone.
- Existing suites green: 27 mock/inversion, 21 live article, 16 cold reload, 6
  dashboard.

No new permissions, no new host access, no network requests. Not on Gmail or any
site with a native dark theme (the deny list is unchanged).
