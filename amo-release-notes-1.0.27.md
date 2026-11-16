# DarkMode 1.0.27 — replace white text with cyan, in one click

The other half of the request: *"getting it to replace white (esp. text) with a
selected color, cyan being a good default."*

The mechanism existed since 1.0.22 (`≈ everything light` threshold scope), but
measured on AliExpress search it reached **253 of 328** visible white-on-screen
text elements while the panel reported **"covers 282 of 282"** — a
complete-looking number over an incomplete job. Two causes, plus the wrong
default colour.

## What was excluded

**Alpha ink was treated as unmeasurable.** `rendersOf()` rejected any ink whose
alpha was below 0.999, and sites write `rgba(0,0,0,0.9)` for body copy, navigation
labels and form text constantly — 75 of the 328 were alpha ink. It is now
composited over its own backdrop (which is what the screen does) and measured from
that. Below 0.05 stays skipped: that is `background-clip: text` gradient text,
where repainting destroys the effect.

**Form controls were invisible.** The tuner's `ownsText()` accepted only an
element with a direct child text node, so `<input>`, `<textarea>` and `<select>`
were never counted, never tagged, never recoloured — the other 46, including the
search box and every quantity field. A control's visible text is not a text node;
it is painted by the widget. They are now first-class, and their ink is read from
`color` rather than `-webkit-text-fill-color`, which for a field is a UA default
that can disagree with what the widget shows.

## Cyan is the default

The colour knob was seeded with whatever colour the element already shows, so
"replace this white" started by writing white — a no-op until you noticed the
swatch. Near-white ink (WCAG luminance ≥ 0.60, i.e. `#cecdc9` and lighter) now
seeds **`#00ffff`**; anything darker keeps its own colour so nudging an accent
stays a nudge. The hex line reads `#e6e6e6 → #00ffff` so the original is still
visible.

## Measured on the live page, then on screen

`scripts/probe-tuner-white.js`, run in the extension's own isolated world against
`aliexpress.com/w/wholesale-water-cooling-filter`:

```
before   267 visible white-on-screen text elements
knob     #00ffff                                    (was #e6e6e6)
click    ≈ everything light -> cyan
after    267 / 267 recoloured · 0 still light
```

Then pixel truth from a CDP screenshot of that page: **29,258 cyan pixels**
across the full page height (cyan bounding box `63,34 → 1252,1805`).

## Verification

- `test-inversion` ALL PASS, now asserting both seed branches (near-white →
  cyan, mid-tone → its own rendered colour) on the inverted and plain harness
  pages
- `test-tone-live` ALL PASS (21 assertions against the live Quanta article)
- `test-bgphoto`, `test-showstext`, `test-logo-a11y` (15/15) ALL PASS

## Reading the panel honestly

Coverage now counts alpha ink and form controls, so its denominator is the job
that actually exists. It can still over-count elements hidden by a collapsed
ancestor (its visibility test does not walk up), which errs toward reporting work
left to do rather than claiming completion — the safe direction, but if a page
ever reports "N still light" for text you cannot see, that is why.
