# DarkMode 1.1.1 — images stay in true colour when DarkMode backs out

A fix for a defect introduced by 1.1.0's "dark by default", visible on sites that
already have their own dark theme.

## What went wrong

On a page that is **already dark**, DarkMode still starts darkening at
document_start and then backs out (about 150 ms later) once it can see the page
is dark. Google's search results page is exactly this: dark grey
(`body{background:rgb(34,36,42)}`), own theme, no `color-scheme` declaration.

During that brief window the brightness passes had already run, and two of them
write inline styles rather than stylesheet rules:

- the photo dimmer wrote `filter: invert(1) brightness(0.82)` onto every large
  image, and
- the fill cap wrote `box-shadow` / `background-color` overlays onto bright
  panels.

Backing out removed the page-wide inversion but **left those inline styles
behind**. On Google that meant the whole image strip at the top rendered as
colour **negatives** on a dark page — measured: 47 images carrying
`filter: invert(1) brightness(0.82) !important`.

## What changed

- Every inline write now records the value it replaced, and backing out restores
  exactly that. Authored inline styles are preserved; nothing of ours survives.
- The brightness passes only run while DarkMode is the thing painting the
  darkness, so a page DarkMode decided not to touch is never modified at all.
- Same fix covers "disable Dark Mode override" on any page, not just the
  auto-dark case.

## Verified

- `google.com/search?q=aeolid+nudibranchs`: page untouched (natively dark), 18
  images at invert-depth 0, zero leftover inline filters, photos in natural
  colour (screenshot checked).
- `python.org` (DarkMode does darken it): while dark — 17 capped fills, 135 label
  inks, 1 dimmed photo; after backing out — **0** of each, zero leftover inline
  paint, no image or panel still styled by us.

## Not changed

Inversion behaviour, the palette, auto-dark and the per-site switches are
unchanged from 1.1.0.
