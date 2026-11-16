# DarkMode 1.0.25 — media inside shadow roots, and "small photo" vs "icon"

Reported next: *"ALL of the product images on that page are inverted in Brave,
where they're not inverted in Chromium."*

## First, the comparison is not measuring what it looks like

Chromium's profile has **no DarkMode extension installed** (only the store's
"Dark Mode Chrome" 0.0.3). So "not inverted in Chromium" is most likely "the page
is not darkened there" — not "the other browser handles it better". Measured on a
public AliExpress search page with the same engine injected into both browsers:

```
Chrome: cr-dark=true  img count=157  net-depth histogram {"2":157}
Brave:  cr-dark=true  img count=175  net-depth histogram {"2":175}
```

Identical. Every plain `<img>` came out at depth **2** (true colour) in both. So
this is not a Brave-vs-Chromium defect, and the remaining inversions on that page
are elements the engine deliberately or structurally cannot reach.

## The one that scales with the site, not the element: shadow DOM

A page stylesheet does not apply inside a shadow root. Every web component's
`<img>`, `<video>` and `<canvas>` therefore inherits the page filter and none of
our re-inversion — a photo negative that no page-level CSS can fix. Measured in
the new E2E fixture: the same `<img>` sits at **depth 1 inside an open shadow
root** and **depth 2 in the light DOM**.

Fixed by adopting a constructable stylesheet into every **open** shadow root,
gated on `:host-context(html.cr-dark)` so one rule tree serves every root and
stays inert when dark mode is off. Open roots are found by sweeping on mutation
plus a timer ladder (an `attachShadow()` on an already-inserted element fires no
mutation, so the ladder is load-bearing, not belt-and-braces). Closed roots
cannot be reached by design and stay inverted.

This is the likeliest explanation for "all the product images" on an order page
that is a component app, while the older search page — plain light DOM — is fine.

## Small photographs vs small icons

The bg-photo pass refused anything under 10,000 px² (≈100×100), assuming
"sprite/icon". An order-list thumbnail is 80×80 = 6,400. Size cannot tell a
thumbnail from an icon, so the discriminator is now content, from the 16×16
sample the engine already took:

- `photo` — many colour buckets, wide tonal range → restored from 2,500 px²
- `lightArt` — cut out of its background (opaque coverage 0.08–0.85) and mostly
  **light** ink → restored. Under the filter light ink turns dark and vanishes
  into the page; a dark glyph is left to invert, which is what makes it readable.
- everything else keeps the 10,000 px² bar and the old saturation test.

The Ambient Weather white-dial guard still holds: an opaque plate has coverage
1.0 and can never be `lightArt`. Measured on that dashboard after the change:
dial centre luminance **0.090** (0.904 with the white disc), no gauge/dial art
restored, no text-bearing element restored.

Incidentally measured on the real AliExpress header logo: meanL 0.146, coverage
0.207 — dark art cut out of transparency. It is *correctly* left inverted; the
filter turns it into a light wordmark on a dark header.

## Verification

`scripts/test-logo-a11y.py` — 14/14, real `content.css` + `content.js` in a real
Chrome:

- a11y-text background logo restored (depth 2); visible-text one not (depth 1)
- plain `<img>` photo → depth 2
- 80×80 photographic background → restored; 80×80 flat saturated plate → depth 1
- transparent-backed **light** wordmark → restored; opaque white/grey disc → depth 1
- `<img>` inside an **open shadow root** → depth 2

`test-showstext` 17/17, `test-inversion` ALL PASS, live `test-bgphoto` ALL PASS.

## Still unproven, and why

I could not reproduce the order-page inversion itself: that page needs a signed-in
session, and the public search page's images are all correct. The shadow-DOM fix
is measured against a fixture, not against your order page. If thumbnails are
still inverted after reloading, the diagnostic named for this is
`scripts/probe-bg-skipped.js` — it replays the pass's gates in order and prints
which one fired, with the element's own sampled numbers.

No new permissions, no new host access, no new network requests.
