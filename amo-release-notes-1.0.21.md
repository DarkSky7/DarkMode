# DarkMode 1.0.21 — dials and gauges darken; text on them stays readable

Reported on `ambientweather.net/dashboard/…`: *"with our dark mode enabled … a
white circle in the center of the windspeed dial and LOTS of text is in white."*

## One cause, both symptoms

The background-image restorer treated **any** element with a `url(...)` background
over 10,000 px² as a photograph worth preserving. "Preserving" means inverting the
element a second time, which cancels the page filter for its **whole subtree** —
image, and text alike. On that dashboard every widget's art is an SVG, so:

- `div.compass` — wind-circle.svg, 189×189 — was restored. Its white disc stayed
  **white** on a dark dashboard. Measured: the centre 80×80 window had mean
  luminance **0.904** (5,566 of 6,400 pixels above 0.85).
- `.gauge` and `.recharts-responsive-container` (clock-bkg-small.svg) were
  restored too, so the numbers and labels drawn on them inverted **relative to a
  background that did not** — which is the "lots of text is in white": white text
  on a preserved light disc.
- `a.header` — the station name, plus a 12px SVG carrot — was restored for the
  sake of the icon. `#313236` ink on a `#000000` page: contrast **1.64:1**,
  invisible.

## The rule now

An element may be restored only when restoring it cannot hurt:

1. **Never vector art.** An SVG background is a gauge, a dial, a clock face, a
   logo — UI furniture, not a photograph. There is nothing to preserve, and
   preserving it is what leaves a white disc on a dark page. Such elements now
   invert with the page.
2. **Never an element that contains text.** Text is the thing the filter exists
   to fix; restored text keeps the site's light-theme ink and disappears.
3. **Rasters must look photographic.** The image is decoded and sampled; if it is
   flat, or cannot be decoded at all, it is left inverted and a console warning
   names it. Never a silent restore.

After: the dial's centre window measures mean luminance **0.081**, the white
pixels are gone, and the station name renders `#cecdc9`.

Trade-off, stated plainly: a greyscale promo photo used as a background will now
invert (and look like a negative) rather than be preserved, because colourfulness
is what distinguishes a photo from a plate. Colourful photos behave as before.

## Verification

`scripts/test-bgphoto.py` — cold-loads the dashboard with the extension injected at
document start and asserts: no gauge/dial/clock art is restored, no element with
text is restored, the station name renders light, and **the dial's centre is dark by
pixel measurement** (mean luminance, not "looks fine"). No new permissions, no new
host access, no network requests beyond the background image already on the page.
