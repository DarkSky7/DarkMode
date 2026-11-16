# DarkMode 1.0.23 — "has text" now means "shows text"

Reported in Brave on `aliexpress.com/p/order/index.html`: *"our Dark Mode
extension seems to be inverting the images."*

## The finding

`scripts/diag-images.js` on the order page returned exactly **one** inverted
visual out of the whole page:

```
why=BG-IN-TEXT-EL   net=1   text=10   size=98x31
paint=bg:https://ae-pic-a1.aliexpress-media.com/k
el=a.pc-header--logoImg--mDbiT4k
```

The AliExpress header logo. It paints the wordmark as a **background-image** and
carries a screen-reader `<span>AliExpress</span>` inside the anchor for
accessibility. `startBgPhotoFix` refused to restore it because its veto was
`(el.textContent || '').trim()` — text *nobody can see* counted as text, so the
element stayed inside the page filter and the logo rendered as a photo-negative
on every order page.

## The fix

`showsText()` replaces the textContent test and asks the renderer instead: does
any text node have a rect of at least 4×4 CSS px that intersects the element's
own border box, on an ancestor chain that is not hiding it? It walks the chain
from the text node up to the element and rejects the text when a clipped ancestor
leaves less than a quarter of the text rect inside its box.

Two details matter, and the test harness caught the second one before it shipped:

- `range.getClientRects()` returns the text's **own unclipped** rects, so an
  `sr-only` span (1×1 box, `overflow:hidden`, `clip:rect(0 0 0 0)`) still
  measures ~78×19 and looks perfectly visible. Geometry alone is not enough —
  the ancestor-clipping intersection test is what makes the sr-only recipes
  (`clip`, `clip-path: inset(50%)`, negative `text-indent`) read as hidden.
- What must still veto a restore is text a human can see. Restoring double-
  inverts the subtree, so visible ink returns to the site's light-theme colour —
  measured on Ambient Weather's `a.header`: #313236 on #000000, contrast 1.64:1.

## "Selecting a single element isn't helping" — now visible in the panel

Writing a rule is not the same as winning, and the panel used to give no way to
tell the two apart. It now measures the element's computed `color` and
`-webkit-text-fill-color` **after** the stylesheet is applied and prints one of:

- `✔ rule applied — element computes #00ffff`
- `✖ rule written but OVERRIDDEN — element still computes #1f1f1f`

Both real causes of this report were invisible from the old panel: a rule emitted
at the site's own specificity (1.0.22's `:is()` repetition) and ink the site
paints with `-webkit-text-fill-color` (1.0.22's second declaration).

## Also

- `scripts/diag-images.js` v2 prints a **census** before its findings — element
  count, `<img>`s present vs above the area floor, background-image elements,
  pseudo-element backgrounds, shadow roots, `scrollHeight` vs viewport. A
  `visuals: 1` finding cannot distinguish "the page is thin" from "the scan is
  blind" without it. It also walks open shadow roots, reports pseudo-element
  backgrounds, follows scrolling for 60 s to catch virtualised lists, and puts
  the whole result on the clipboard as JSON so nothing is lost to a screenshot.
- The popup reported `v1.0.21` on a 1.0.22 package: the version string was
  hand-typed. It now reads `chrome.runtime.getManifest().version`.

## Verification

- `scripts/test-showstext.py` (new) — extracts the **real** `parseColor` and
  `showsText` out of `content.js` and runs them in headless Chrome against every
  sr-only recipe (clip, clip-path, negative indent, `font-size:0`,
  `color:transparent`, `visibility:hidden`, `display:none`, `opacity:0`,
  off-box positioning) plus both visible-text cases: **13/13 assertions, and 3
  source assertions on the call site**. Its first run failed the `clip` and
  `clip-path` cases — that is the defect it existed to find.
- `scripts/test-inversion.py` — ALL PASS, now also asserting the panel confirms a
  landed rule and names the computed colour.
- `scripts/test-bgphoto.py` — ALL PASS against the live Ambient Weather
  dashboard: 3 text+image elements, none restored; dial centre luminance 0.086
  (0.904 with the old white disc); station name renders #cecdc9.

No new permissions, no new host access, no network requests.
