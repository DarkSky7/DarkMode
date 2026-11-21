# DarkMode 1.0.41 — the cart drawer that was not a div

Mike, on HomeDepot.com: *"after adding something to the cart, a right side view of
the cart is presented which is not being inverted. It would also be nice if the
text was pushed to cyan (instead of white)."*

The flyout is not a panel. It is

```html
<iframe id="thd-drawer-frame" src="/cart/atc?…">   499 x 1519, right edge
```

and content.css re-inverts **every** iframe (`html.cr-dark iframe{filter:invert(1)}`)
so that video players and payment embeds keep their true colours. That restore
cancelled the page filter for the drawer too, so the drawer sat in full light
theme beside a darkened page.

Measured in the user's own tab, same crop, one property changed:

| state | mean luminance of the drawer crop |
|---|---|
| as shipped (1.0.40) | **0.950** — a white panel |
| `filter:none` forced on that one frame | **0.043** |

So the page filter *does* reach iframe content. The restore was the only thing
hiding it.

## What changed

**A frame is now judged by its own pixels.** `tuner.js` already runs in every
frame (`all_frames: true`), and a same-origin frame can reach its container
through `window.frameElement` — no cross-document poking, no parent-side scan:

- **light frame inside an inverted page** → the frame marks its own container
  `data-cr-frame="dark"` (content.css drops the restore, the page filter darkens
  it), adds `html.cr-frame-dark` (content.css re-inverts media inside the frame,
  so product photos are photos and not film negatives), and tints its neutral ink
  with the accent.
- **genuinely dark frame** → left exactly as it was. A dark embedded app must not
  be inverted into a light one.
- **cross-origin frame** → `frameElement` is `null`, nothing runs. YouTube and
  payment embeds keep the old, correct true-colour behaviour.
- **unmeasurable frame** (no body, nothing painted) → left restored.

`invertDepth()` now hops the frame boundary, because a filter does not stop at
one: the page's `html{filter:invert(1)}` paints the iframe's content and the
iframe element's own filter cancels it. Without that hop every colour decision
inside a frame read parity 0 and would have been written un-complemented.

**The ink is written in complement space.** The drawer's `#202020` ink renders
white under the page filter, which is exactly what was asked to be cyan. Tagged
elements get `data-dm-fink`, and one stylesheet — written as the complement of
`#3e738b` (`#c18c74`) — paints them with the extension's accent. The predicate is
the same one the rest of the extension uses, so saturated ink keeps its meaning.
A tuning rule saved for the host wins over the built-in accent.

**The bright-fill ceiling and the photo dimmer do not run inside frames.** They
write inline `!important` values computed from the invert parity they measured,
and that parity flips the moment a frame is darkened — measured on the fixture:
the drawer's photo came out `brightness(0.82)` with no invert, i.e. a *dimmed
negative*, because `dimPhotos()` had marked it before the frame had its class.
Frames are served by the stylesheet (media restore) and the ink sweep instead.

## Proof

**Fixture** (throwaway Brave with the real extension, `--load-extension`, a
local page that inverts itself + a same-origin light panel):

| case | frame filter | marker | ink tagged | photo | crop mean lum | near-white |
|---|---|---|---|---|---|---|
| light frame, inverted page | `none` | `dark` | 6 of 6 | `invert(1)` (red stays red) | **0.020** | 0.14 % |
| dark frame, inverted page | `invert(1)` | — | 0 | — | 0.077 (its own theme) | — |
| light frame, page NOT dark | `none` | — | 0 | — | 0.973 (untouched) | — |

**Live, in Mike's Chromium 155 session**, on the real
`https://www.homedepot.com/cart/atc?…` drawer URL the add-to-cart flow itself
uses:

- `filter` on the frame: `none`, `data-cr-frame="dark"`, `html.cr-frame-dark`
- text owners tagged: **3 of 3**, computing `rgb(193,140,116)` = accent `#3e738b` on screen
- product photo: `filter: invert(1)` — a normal photo, not a negative
- drawer crop: mean luminance **0.064** (was 0.950), near-white 2.3 % (the photo's
  own white background)

## Not covered

A frame that navigates from a same-origin page to a **cross-origin** one keeps its
`data-cr-frame` marker until the frame element is removed — that content stays
darkened. Home Depot removes the drawer element when it closes, and the next
open runs the script again, so this is not reachable there; stated because it is
the one state this design cannot clean up after itself.
