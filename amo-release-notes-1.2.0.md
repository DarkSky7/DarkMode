# DarkMode 1.2.0 — contrast awareness: measure the plate, never guess it

Reported by Mike, 2026-11-30:

> the (roughly 10cm tall) page footer of newtonpaisley.com/introducing-paisley-paramecium/
> looks inverted to lite and the text is white thus low contrast. Is it possible to
> improve contrast awareness and abilities in the Dark Mode extension?

Yes. Two defects, both of the same shape — **the engine scored ink against a colour
nobody can see** — plus a missing ability: a natively dark region was being forced
into a light one.

## What was actually happening

The footer is a natively DARK region inside a light page:

- paint `#0f8979` under an **opaque** 2000x1200 background-image (tumbled fabric),
  measured `meanL 0.305`, `coverage 1.000`
- ink `#f2f2f2` — the site's own light-on-dark pairing, 3.85:1

Two independent mistakes then made it worse than the site ever was:

1. **`capSurface()` took the flat-fill branch.** A background-COLOR is invisible when
   an opaque image covers the box, so it capped a fill no pixel shows and recorded it
   (`data-dm-capt=172,84,96`, L 0.159) as the plate that labels sit on.
2. **`applyLabelFix()` then scored ink against that invisible fill** and wrote
   near-BLACK ink (complement of pale) — which the page's `invert(1)` renders
   near-WHITE. Measured rendered result: `#f4f7fa` (L 0.927) on the inverted, hence
   LIGHT, fabric (L 0.518) = **1.31–1.71:1**.

And the restore that would have kept it dark was vetoed twice: `showsText()` refuses
any element carrying visible text, and `repeats && autoSize` refuses decorative tiles.

## The fixes

- **`content.js` publishes the plate's measured tone** — `data-cr-bgmean`,
  `data-cr-bgcov` — for every url() background panel it can sample, including ones it
  will not restore. The ink engine reads a measurement instead of inferring a colour
  from an unrelated CSS property.
- **`capSurface()` no longer treats a flat fill behind an opaque image as the plate**
  (`coverage >= 0.9`), so it cannot cap an invisible layer or score ink against it.
- **`applyLabelFix()` refuses to paint on an unmeasurable plate.** The invert flips
  ink and plate together, so an authored pair keeps its contrast; where the plate is
  an image we cannot read, the correct edit is *none*.
- **New ability — dark-island preservation.** An element that carries visible text,
  paints an OPAQUE background-image, whose plate measures `meanL <= 0.40`, and whose
  own ink measures `>= 0.55` (designed light-on-dark) is counter-inverted so it keeps
  its native appearance: dark plate, light ink. The light-ink requirement is what
  preserves the Ambient Weather lesson — restoring an element whose ink is DARK still
  loses. `capSurface`, `applyLabelFix` and `sweepTone` all skip inside an island, and
  `revert()` clears the marker because it is a parity claim.
- Marking an island changes invert parity for a whole subtree, so the inline paint
  already written inside it is undone first (`__dmUnpaint`) and only then re-swept.

## Measured

newtonpaisley.com footer, 1400x1000, pixel histogram of the footer band:

| | dominant ink | dominant plate | contrast |
|---|---|---|---|
| 1.1.1 | `#f4f7fa` (L 0.927) | `#c7bbc7` (L 0.518) | **1.71:1** |
| 1.2.0 | `#f2f2f2` (L 0.888) | `#384438` (L 0.053) | **9.1:1** |

Near-white pixels in the band fell from 14,019 (2.96%) to 4,521 (0.96%); the remainder
is the site's own white artwork inside the fabric photograph.

Controlled two-polarity fixture (both plates opaque, `coverage 1.000`):

- dark plate `meanL 0.148` + light ink → island, ink stays `#f6f6f6`, L 0.922 — kept dark
- light plate `meanL 0.927` + dark ink → NOT an island, normal path, plate dimmed to L 0.003

No regressions on the reference set (1.1.1/1.1.0 baselines in brackets):

- `lite.cnn.com` 112 accented, 0 near-white (112 / 0)
- `python.org` 265 accented, 135 labelled, 16 capped, 17 pale (265 / 135 / 17 / 17)
- `w3.org` 149 accented, 17 labelled (149 / 17)
- `example.com` engine backs out, 0 painted (same)
- `bbc.com/news` 281 accented, 0 near-white; `github.com` 371 accented

## Known, unchanged, pre-existing

`en.wikipedia.org` is NOT darkened by either 1.1.1 or 1.2.0 with a dark OS preference
(`prefersDark: true`, body `rgb(248,249,250)`, `color-scheme: normal`). Verified by
stashing this change and re-measuring: same result. Separate issue, not this release.

## Packaging

`addons-linter` on `DarkMode-1.2.0-firefox.xpi`: **0 errors / 0 notices / 0 warnings**.
`dist/DarkMode-current` and `dist/DarkMode-1.0.25` (the folder Chromium loads) both
synced to 1.2.0; numbers above re-measured from `dist/DarkMode-1.2.0` itself.
