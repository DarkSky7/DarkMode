# DarkMode 1.0.14 — AMO release notes

Fixes product photos at online shops rendering as photographic negatives.

## The bug

Sites that serve responsive images wrap them as
`<picture><source …><img></picture>`. DarkMode re-inverts media so that a photo
under the page-wide `invert(1)` filter comes back to its true colours. That
re-invert rule listed **both** `img` and `picture`, so every responsive photo was
inverted twice on top of the page filter — three inverts in total, which is one
invert too many and therefore a negative:

    html invert(1)  +  picture invert(1)  +  img invert(1)  =  net 3  →  negative

Measured on shop.watercool.de: 8 of 10 visible product thumbnails carried a
`picture` parent and read net=3; the site logo, a plain `<img>`, read net=2 and
looked correct. That asymmetry — some photos fine, some negative — is the
signature of this bug.

Filters compose, so two inverts cancel. The `<img>` is the element that paints
inside a `<picture>`, so re-inverting the `img` alone is both necessary and
sufficient. `picture` has been removed from the list.

## Verified

Same image, same screen region, captured with and without the extension:

| state | pixels matching the undarkened page | mean luminance |
|---|---|---|
| 1.0.14 (fixed) | 100% | 214 (undarkened: 214) |
| old rule re-applied | 0% (100% exact complement) | 41 (undarkened: 214) |

Also measured live on shop.watercool.de 1.0.14: all 10 visible images net=2
(true colour), including the 8 that were net=3 before.

## Notes

- No change to page darkening, surfaces, text contrast or background-image
  handling. Media only.
- Plain `<img>`, `<video>`, `<canvas>`, `<iframe>` and `<object>` are unaffected
  and still correctly re-inverted.
