# DarkMode — TODO / workstream tracker

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
