# DarkMode 1.0.13 — AMO release notes (paste-ready)

Upload artifact: `dist/DarkMode-1.0.13.xpi` (sha256 `c79fc5a026cf7e18…`, 23,744 B)
Route: AMO Developer Hub → web UI → unlisted self-distribution (see `amo-submission.md`).

Supersedes 1.0.9 and 1.0.10 — upload this one.

## Release notes field (paste as-is)

```
Gmail's leftover light panels are now actually repaired, and far more of them.

Gmail ships its own dark theme, so DarkMode leaves Gmail alone and only corrects
the surfaces Gmail's theme misses. That correction had never actually run. A
coding mistake meant the repair step failed on every pass and its error was
silently swallowed: the stylesheet half still worked, so Gmail looked handled
while the measurement half did nothing. Fixed, and such failures are now
reported in the console instead of disappearing.

With the repair running, the corrections now cover much more of the page:
  - the message card and the Reply / Forward row,
  - Gmail's compose panes, which live outside the main mail area and were never
    examined before,
  - and the text inside all of the above, which previously kept its original
    dark colour and could end up invisible on a panel this extension had just
    darkened.

Measured on a real conversation with a compose window open: white surfaces went
from 13 to 0, and of 118 text elements none now fall below 3:1 contrast (median
11:1, minimum 3.04:1). The remaining lower-contrast text is the user's own
accent colour, which DarkMode deliberately does not repaint.

Nothing about the Gmail refusal changed: DarkMode still never inverts Gmail,
because inverting a page that already has a dark theme turns the chosen accent
colour into a different hue.
```

## Reviewer note

The repair step selects surfaces by measured luminance, not by Gmail class names,
so it keeps working when Gmail renames things. It runs only when the page is
measured dark (`toneNatural`), and it lifts text colour only inside a surface it
has itself darkened — either one it repainted (marked `data-cr-surf`) or one the
stylesheet list below darkens by CSS alone:

    .nH.a98.iY      message card
    .nH.btDi4d.rT5Apb   Reply / Forward row
    .nH.r4          notice bar

Those three remain explicit because Gmail reuses `.nH` widely; the rest of the
page is handled by measurement. The scan root is now `body` rather than
`[role=main]` because compose panes are appended outside the mail area.

## Source of truth for "which copy is live"

Brave/Chromium load the absolute path recorded when the extension was added as
unpacked, stored in `<profile>/Secure Preferences`. Read it with
`python scripts/loaded-ext-paths.py`; a build that does not land in that
directory is a no-op that still prints success. `scripts/package.py` copies each
build into every registered path, and `scripts/verify-release.py` checks the
archive shape.
