# DarkMode — TODO / workstream tracker

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
