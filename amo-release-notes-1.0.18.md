# DarkMode 1.0.18 — a saved tuning rule now survives a reload

Reported after 1.0.17 went public: *"I selected save for this host and reloaded
the page but it didn't reassert the foreground color change after the refresh …
or darken."* Both halves were real, and both are fixed.

## 1. The colour sweep never ran on a freshly loaded page

The mutation observer coalesced work by waiting 250 ms for the DOM to go quiet,
and **reset that timer on every mutation batch**. A news page never goes quiet.
On a genuine cold load of the Quanta article — content.css, content.js and
tuner.js injected at document start, exactly as the manifest declares them, then
a real navigation — the page kept mutating past the three-second mark, so:

    elements tagged after load : 0
    elements tagged by one manual sweep at the same instant : 193

Every earlier test missed this because it injected the scripts into an
already-loaded page, where a single immediate sweep sees the whole document. The
regression test now runs at document start (`scripts/test-reload.py`).

Fixes:
- The sweep timer is **coalescing, never resetting**: at most one sweep per
  120 ms, and no batch of work is ever dropped.
- Additional full sweeps on `DOMContentLoaded` and `load`, which cannot be
  starved.
- The colour baseline cache now knows which colour is the page's and which is
  ours: while an element carries our attribute its live colour is our paint, so
  the baseline is used; while it does not, the live colour is the site's and is
  re-measured. The first sweeps run during parsing — before the site's own
  stylesheet has been applied — so an early baseline was the browser default and
  then stuck forever (measured: 87 of ~200 elements tagged, and the article
  heading among the missing ones).

## 2. "Save for this host" did not remember the host

The tuning rule was stored, but the site was never added to `darkHosts`, so the
reloaded page was not inverted at all — and a colour rule records the colour the
eye saw on a **darkened** page, so on a light page it has nothing to match.

Saving a rule now also remembers the site, using the same `darkHosts` key the
darkening engine reads, and switches the engine on immediately if it is off. The
panel says which happened: *"site now darkened + remembered"* or *"site already
remembered"*.

If you saved a rule under 1.0.17, press **Save** once more after updating (or tick
"remember this site" in the popup) — the earlier version stored the rule without
the flag.

## Also

- Elements that own text but never paint it are excluded from the sweep. A
  `<script>` holds its source as a text node, and SVG `<title>` elements (28 of
  them on that page, one per icon) report a lowercase tag name, so the group
  count was inflated by invisible widgets. The reported count now means "pieces
  of text you can see".
- No new permissions, no new host access, no network requests. Same
  `storage` / `activeTab` / `scripting` set.

## Verification

- `scripts/test-reload.py` — three cold-load variants (normal, storage landing
  150 ms late, host not remembered): 15 assertions, including "every tagged
  element actually renders cyan" and "late-added content is tagged by the
  observer".
- `scripts/test-tone-live.py` — 21 assertions on the live article, now also
  pinning that saving persists both the rule and the remembered host.
- `scripts/test-inversion.py` — 23 assertions plus the rendered-pixel check.
