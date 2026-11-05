# DarkMode 1.0.10 — AMO release notes (paste-ready)

Upload artifact: `dist/DarkMode-1.0.10.xpi` (sha256 `63e0cd4d58062627…`, 22,889 B)
Route: AMO Developer Hub → web UI → unlisted self-distribution (see `amo-submission.md`).

Supersedes the 1.0.9 notes — upload this one. If 1.0.9 was never submitted, 1.0.10
contains everything in it plus the fix below.

## Release notes field (paste as-is)

```
Fixes images that stayed inverted on sites that paint photos as CSS backgrounds.

DarkMode's invert engine restores pictures by re-inverting the img, video,
canvas and picture elements it finds. That covers most pages, but some sites
paint their banners and promo artwork as CSS background-image on a container
instead of using an img tag, and nothing was restoring those: the page filter
turned them into film negatives while every ordinary product photo beside them
looked correct. On aliexpress.us this was measured by comparing the pixels the
page rendered against the image file itself — a banner painting rgb(1,22,16)
over a source of rgb(252,252,252), exactly its complement. All 586 img elements
on that page were already correct, which is why only some images looked wrong.

Elements that paint a bitmap background are now detected and inverted a second
time, cancelling the page filter for them. Two conservative rules keep this from
causing new problems: small elements are ignored, so icons and sprites keep the
dark-page treatment they need, and repeating background tiles are left alone,
since those are meant to invert with the rest of the page. Elements already
restored are never marked twice, and images inside a restored container are not
inverted a third time.

Gradients are still not restored individually — the colours inside a gradient
cannot be corrected one by one, and inverting the whole element would drag its
text back to a light theme.
```

## Reviewer note

Every step here is a DOM measurement; the extension makes no network requests to
decide this. Selection is `background-image: url(...)`, no gradient, rendered
area >= 10,000 px², and not a repeating tile at natural size
(`background-repeat` other than `no-repeat` together with `background-size: auto`).
The element then gets a data attribute and a CSS rule inverts it; nested marked
elements are skipped so nothing is inverted twice. Images inside a restored
element are explicitly set back to `filter: none`, because the parent's inversion
has already cancelled the page filter for that subtree.

## Source of truth for "which copy is live"

Brave/Chromium load the absolute path recorded when the extension was added as
unpacked, stored in `<profile>/Secure Preferences`. Read it with
`python scripts/loaded-ext-paths.py` before believing a build has shipped; a build
that does not land in that directory is a no-op that still prints success.
`scripts/package.py` now copies each build into every registered path.
