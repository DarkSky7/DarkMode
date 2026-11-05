# DarkMode — TODO / workstream tracker

## 2026-11-05 — 1.0.11–1.0.13: Gmail repair step actually works now

### Done
- [x] **1.0.11 — the real Gmail bug.** The Gmail branch returns early at the
      DENY check, which sits ABOVE `const MEDIA_TAGS`. `const` is hoisted but not
      initialised, so every `fix()` call threw
      `ReferenceError: Cannot access 'MEDIA_TAGS' before initialization` into a
      silent `catch`. The stylesheet half still worked, so Gmail LOOKED handled
      while the measurement-driven normaliser had never repainted one surface
      (measured: 0 `[data-cr-surf]` markers). Fixed by moving every const a
      hoisted function can reach above the early returns, and by logging the
      swallowed exception instead of dropping it.
- [x] 1.0.12 — Gmail scan root `[role=main]` -> `body`: compose panes
      (`DIV.J-M.J-M-ayU`, 71,047 / 63,535 / 24,236 px) live outside the mail
      area and were never examined. `globalInk` stays false, so widening the scan
      does not widen what gets restyled.
- [x] 1.0.13 — `inkScopes`: containers that `content.css` darkens by CSS alone
      carry no marker, so their text was never lifted. The subject line `.hP`
      stayed rgb(31,31,31) on a rgb(17,17,17) panel (1.15:1). Ink scopes now
      include `.nH.a98.iY`, `.nH.btDi4d.rT5Apb`, `.nH.r4`.
- [x] Measured with a compose window open: white surfaces **13 -> 0**, 118 text
      elements, **0 below 3:1**, median 11.0, minimum 3.04 (the user's own accent
      cyan, deliberately untouched).

### Open
- [ ] The one remaining white surface seen on some loads is Google's one-bar
      search `FORM.gb_Rd.gb_4e` (24,812 px²) — it carries `data-cr-surf` but reads
      white, so something re-applies it. Re-check on a fresh load.
- [ ] Restore the tabs that `--restore-last-session` did not bring back (only 15
      of the prior session returned); session files backed up in
      `F:\tmp\msi\brave-session-20261105-final`.
- [ ] Resume/replace the tabs list from `History -> Recently closed`.

## 2026-11-05 — 1.0.10: background-image media no longer stays inverted

### Done
- [x] Invert engine now restores media painted as a CSS `background-image`.
      Fault measured on aliexpress.us by comparing rendered pixels to the image
      file: coupon rgb(1,22,16) vs source rgb(252,252,252); right promo
      rgb(14,19,29) vs rgb(248,248,248) — both exact complements, while all 586
      `<img>` elements were already correct. That is the "some photos are
      inverted" signature.
- [x] Guards: area >= 10,000 px² (icons/sprites keep dark treatment), repeating
      tile at natural size excluded (plates are meant to invert), gradients
      skipped, nested markers skipped, media inside a restored element set back
      to `filter: none` so it is not inverted a third time.
- [x] Verified: 4 elements marked, all `filter: invert(1)`, 0 small elements
      wrongly marked, 1.0.10 on every registered unpacked path.

### Open
- [ ] Pixel A/B for all marked elements. Two clips returned blank white in the
      harness (scrolled content), so only coupon and national-floor have clean
      pixel proof (d(true) 40 / 23 against d(neg) 707 / 326).
- [ ] CSS gradients still stay inverted — light gradient headers are not restored.

## 2026-11-05 — 1.0.9: repaint engine for image-heavy sites + tile plates

### Done
- [x] Second engine (`cr-repaint`): dark canvas + measurement-driven surface
      repaint, no CSS filter at all, media never recoloured. Needed because
      colour-wheel inversion turned a light-blue catalogue into brown and
      filtered all 104 garments.
- [x] Ink legibility by WCAG contrast against the real backdrop (was absolute
      luminance, which passed a saturated blue sitting at 2.89:1).
- [x] Stopped trusting `data-cr-ink` markers for idempotency — the app rewrote
      inline styles, markers survived, elements were skipped forever.
- [x] Only text-owning elements get a colour written (37,732 → 9,670 writes on
      the test page).
- [x] 1.0.9: light flat background-image plates are fetched, decoded, downsampled
      and cleared only when near-uniform AND light — jQuery UI header bars were
      painting opaque cyan over a background we had already darkened.
- [x] `scripts/package.py` now copies each build into every registered unpacked
      path; `scripts/loaded-ext-paths.py` reads them out of Secure Preferences;
      `scripts/verify-release.py` checks archive shape before release.

### Open
- [ ] AMO signing of 1.0.9: upload `dist/DarkMode-1.0.9.xpi`, notes ready in
      `amo-release-notes-1.0.9.md`. `signed/` still holds **1.0.3** — the Zen /
      Firefox distributed copy is three releases behind until this is done.
- [ ] Retire the duplicate unpacked entries in Brave (keep one). Each is a
      separate extension with its own "Always dark on <host>" setting.
- [ ] Delete `D:\Programs\DarkMode\DarkMode` — not registered by any browser.
- [ ] Generalise plate handling beyond flat tiles: CSS gradients are skipped
      entirely, so a light gradient header still stays light.

## 2026-09-04 — Kickoff (v0.1.0)

### Done
- [x] MV3 scaffold: manifest (storage + activeTab), background (allowlist in
      sync storage), content (document_start auto-apply for remembered hosts,
      popup-driven toggle), filter-inversion engine + media reversion
- [x] Popup: Darken/Lighten now + "Always dark on <host>" remember toggle
- [x] Local repo init + README + this tracker

### Next
- [ ] Mike test #1: foxglove.dev — Load unpacked, click icon, verify dark;
      tick "Always dark", reload, verify auto-dark (no flash)
- [ ] Test pass on a normal site (e.g. a news page) — ensure images look
      natural and toggle-back is clean
- [ ] Per-site engine mode (filter vs gentle) if Foxglove needs refinement —
      e.g. if inversion breaks fixed headers badly, add an element-override
      mode keyed per host
- [ ] Icons (16/32/48/128) so the toolbar shows a moon instead of the puzzle
- [ ] Push to `DarkSky7/DarkMode` (remote created; deploy key pending Mike)

### Open questions
- [ ] Should "Darken now" ALSO offer remember in one click (checkbox default)?
      Current: separate explicit opt-in (per the behavior contract).
