# DarkMode 1.0.7 — AMO release notes (paste-ready)

Upload artifact: `dist/DarkMode-1.0.7.xpi` (MD5 `e8b77cf39c9ae7fac4d424b4d3892033`, 15,795 B)
Route: AMO Developer Hub → web UI → unlisted self-distribution (see `amo-submission.md`).

## Release notes field (paste as-is)

```
Fixes Gmail's dark theme leaving bright white panels in place.

Gmail ships its own dark theme, but a few of its containers — the message
card, the Reply/Forward bar and the button row inside it — keep a white
background with dark text, which is glaring in an otherwise dark inbox. This
release repaints those surfaces, and lightens the text inside them, using
colours SAMPLED from the page's own dark theme rather than hard-coded greys,
so the patch matches whatever Gmail theme you have chosen.

DarkMode also now refuses to apply its colour-wheel invert to Gmail at all.
Inverting a page that already has a dark theme turns the user's chosen accent
colour into a different hue (cyan renders as brown) while plain dark text
turns white, so it produced a broken-looking inbox. Gmail is left to its own
theme, with only the leftover light surfaces corrected.

Also fixed: late-rendering regions were missed because the page observer was
attached before the document body existed; and the popup reported a stale
version number.

No new permissions. No remote code. Nothing changes on any site unless you
ask for it.
```

## Version/changelog note for the listing

- **1.0.7** — repaint Gmail's leftover light surfaces using the page's own
  sampled palette; refuse to invert Gmail; fix the late-render observer; fix the
  popup's version readout.
- **1.0.3** — first AMO build.

## After AMO signs it

1. Download the signed `.xpi` from AMO.
2. Save it as `signed/darkmode-1.0.7.xpi`, then refresh the convenience copy:
   `cp signed/darkmode-1.0.7.xpi signed/darkmode-latest.xpi`
3. Write checksums: `sha256sum signed/darkmode-1.0.7.xpi > signed/darkmode-1.0.7.xpi.sha256`
   and the same for `darkmode-latest.xpi`.
4. Zen: `about:addons` → gear → **Install Add-on From File** → pick the signed
   xpi (a `.xpi` cannot be installed by dragging into a normal tab).
5. Verify in Zen on Gmail: `about:debugging#/runtime/this-firefox` should list
   DarkMode 1.0.7, and the popup on `mail.google.com` should say it is not needed
   there (Gmail has its own theme).
