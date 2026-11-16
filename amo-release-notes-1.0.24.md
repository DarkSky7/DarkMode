# DarkMode 1.0.24 — small photographs get restored; small icons still do not

Follow-up to 1.0.23 on `aliexpress.com/p/order/index.html`. The logo fix was not
the whole report: a **product thumbnail** was still rendering as a negative.

## Proving it from the screenshot alone

Measured on the supplied crop (616×220, the fitting occupying 67×63 px):

- mean colour of the thumbnail region: **rgb(92, 121, 177)** — blue
- its complement: **rgb(163, 134, 78)** — brass
- the listing is a **gold** Barrow THKN-3/8-V4 fitting

A gold object rendering as its exact complement is `invert(1)` with no hue
rotation, i.e. inside the page filter and never re-inverted. Not a rendering
artefact, not the card's background — the photo itself.

## Why that one was missed

Two candidates, and the second one is measurable:

- A plain `<img>` is covered by the stylesheet's media rule. Proved in the E2E
  fixture: a plain `<img>` photo comes out at **net invert depth 2** (true
  colours). So a blue photo is not a plain `<img>`.
- A background-image had to clear an **area floor of 10,000 px² (≈100×100)**,
  below which the engine assumes "sprite/icon". An order-list thumbnail is
  **80×80 = 6,400** — refused, left inverted. Measured in the fixture: the 80×80
  photographic background rendered at **depth 1** before this release.

The floor was there for a real reason: restoring a flat dark icon to its
original colours on a dark page erases it. So the floor is not removed — the
discriminator is replaced with the one that actually separates a photo from an
icon.

## The change

`imageColourfulness()` now reports, from the same 16×16 sample it already took:

- `distinct` — how many quantised colour buckets are present
- `spread` — max − min luminance
- `photo` — `sat ≥ 0.12 && distinct ≥ 24 && spread ≥ 0.16`

A photograph spreads over many colours and a wide luminance range; flat UI art
(a plate, a badge, a glyph on a solid) uses a handful. The area floor drops to
**2,500 px² (50×50)** for backgrounds that sample as photographic, and stays at
**10,000 px²** for everything else. Every existing guard is unchanged: no
gradients, no SVG, no visible text, no repeating auto-sized tiles, no nested
markers.

## Verification

`scripts/test-logo-a11y.py` gained two fixtures and two assertions:

- 80×80 **photographic** background → restored, `data-cr-bgphoto=1`, depth 2
- 80×80 **flat saturated plate** → still inverted, depth 1, no marker
- plain `<img>` photo → depth 2 (the control that says "not an `<img>`")

Full suite green: `test-logo-a11y` 11/11, `test-showstext` 17/17,
`test-inversion` ALL PASS, `test-bgphoto` ALL PASS on the live Ambient Weather
dashboard (no gauge/dial art restored, no text-bearing element restored, dial
centre luminance 0.090).

No new permissions, no new host access, no new network requests — the sampling
reuses the fetch the engine already performed for larger backgrounds.
