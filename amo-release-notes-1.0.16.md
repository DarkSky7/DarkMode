# AMO release notes — 1.0.16

Not yet uploaded. Built and verified; awaiting a Brave trial on a real site.

## Release notes (paste into AMO)

Tune in place now speaks the colour you actually see on screen.

The darkener works by inverting the page's colours, so any colour written by a
tuner rule was inverted again on the way out: choosing cyan produced red. Rules
now store the intended colour and write its complement, measured per element
(a restored photo subtree carries two inverts and is left alone). The tuning
panel and the element outline are counter-inverted too, so the swatch shows the
colour that will really appear, and a line reports what is being written — for
example "page inverted · writes #00ffff to render #ff0000".

Fixed: "this element only" used the bare tag name for elements with no class or
id, so scoping a single heading silently restyled every element of that type.
It now builds a short path that matches exactly one element, verified before it
is used.

No new permissions, no new host access, no network requests.

## Notes to reviewers

All page interaction (panel, hover picker) is user-initiated; nothing runs until
the tune button is clicked. The new code reads computed styles and writes a
single injected stylesheet; it makes no network requests.

## Evidence

- `scripts/test-inversion.py` — real Chrome, mocked inverted page: intent
  `#00ffff` writes `#ff0000` and the probe block renders `rgb(0, 255, 255)`
  (pixel-sampled from a headless screenshot). Plain page writes intent
  unchanged; even-depth subtree not complemented; panel counter-inverted only
  when the page is.
- `scripts/test-inversion.py --target dist/DarkMode-1.0.16` — same suite against
  the packaged artifact, 17 assertions + pixel check, 0 failures.
- quantamagazine.org article rebuilt locally: "this element only" on a classless
  `<strong>` now resolves to
  `div.post__content > section.outer > div.flex-auto > div.post__content__section
  > div.post__content > h2:nth-of-type(1) > strong` and matches exactly 1 element
  (the old bare `strong` matched 3).
- `addons-linter`: 0 errors, 0 warnings, 0 notices.
