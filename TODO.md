# DarkMode — TODO / workstream tracker

## 2026-11-11 — release automation (ends the manual devhub loop)

- [x] **`scripts/amo-release.py`** — four commands:
      `check` prints every AMO version and says whether the local manifest is
      already published (that is the "Version X already exists" error, without
      opening a browser); `verify` downloads the signed file and compares the
      payload to the build; `install` copies the signed file into every
      Firefox/Zen profile and names the ones locked by a running browser;
      `upload` does upload -> poll validation -> create version -> wait for
      signing -> verify, unattended.
- [ ] **`upload` needs an AMO API key** at `~/.ssh/amo-darkmode.env`
      (`AMO_JWT_ISSUER`, `AMO_JWT_SECRET`); mint it once at
      https://addons.mozilla.org/en-US/developers/addon/api/key/. Until then the
      other three commands already run the loop from this side.
- [x] **AMO re-serializes `manifest.json` while signing** — that, not an ad-hoc
      rebuild, is why the signed file shows `\u2014` where the local build has a
      literal em dash. Proven by comparing 1.0.14 (built before today's changes)
      and 1.0.16: parsed manifests equal, all other files byte-identical.
- [x] Zen honours `xpinstall.signatures.required=false` (community-verified), so
      unsigned sideloading is possible — but it disables signature checking for
      **every** extension in that profile, so AMO stays the default path.

## 2026-11-11 — 1.0.16: the tuner speaks RENDERED colour

Reported by Mike on quantamagazine.org: picked a red, got a **cyan swatch**, and
the heading text stayed white.

### Done
- [x] **Root cause of the mirror.** `content.css` puts `filter: invert(1)` on
      `html.cr-dark`. Two consequences, one cause: (a) every colour a rule wrote
      was inverted on the way out, so cyan intent rendered red; (b) the tuner
      panel is a child of `<html>`, so the page filter painted the panel as
      well — that is why the swatch showed the complement.
- [x] **Rules store intent, write the complement.** `invertDepth(el)` counts
      `invert(1)` in computed filters up the ancestor chain (media and
      `[data-cr-bgphoto]` subtrees carry a second invert and stay at net zero);
      `cssText()` complements per selector, so a restored photo is left alone.
      Intent — not the written value — is what is saved and exported.
- [x] **Panel + hover outline counter-inverted** (`syncUiFilter()`), so the UI
      is true colour and the swatch shows what will actually appear. A new line
      reports the transaction: `page inverted · writes #00ffff to render #ff0000`.
- [x] **Capture seeds the rendered colour**, not the computed one: a `#003366`
      paragraph on an inverted page now seeds `#ffcc99` — what the eye sees.
- [x] **Contrast measured in rendered space** (backdrop complemented when the
      element is under an odd invert) so the printed rgb() matches the screen.
      The ratio itself is invert-invariant, so the warning thresholds are
      unchanged.
- [x] **"This element only" no longer means "every <strong> on the page".**
      Classless, id-less elements fell back to their tag name; on the Quanta
      article `strong` matched 3 and the same fallback would hit dozens.
      `uniqueSelectorFor()` now climbs, testing after every step, taking the
      first path that matches exactly one element, with each ancestor
      contributing its first class (Quanta ships the article twice, mobile +
      desktop, so a purely positional path is not unique). Result on that page:
      `div.post__content > section.outer > div.flex-auto >
      div.post__content__section > div.post__content > h2:nth-of-type(1) >
      strong` → matches 1.
- [x] **Verified — `scripts/test-inversion.py`** (kept in the repo). Real Chrome,
      two mock pages (inverted / plain), 17 assertions + a pixel check:
      intent `#00ffff` → writes `#ff0000` → probe block renders
      `rgb(0, 255, 255)` sampled out of a headless screenshot. Plain page writes
      intent unchanged; even-depth subtree not complemented; panel
      counter-inverted only when the page is. Both the working tree and
      `--target dist/DarkMode-1.0.16` pass, 0 failures.
- [x] `addons-linter` on `dist/DarkMode-1.0.16.xpi`: 0 errors / 0 warnings /
      0 notices.

### Fixed after the Brave report (same version, not yet published)
- [x] **"The tuner could not load on this page" in Brave.** Reloading the
      extension strips content scripts from every open tab; `ensureContent()`
      re-injected `content.js` but NOT `tuner.js`, so the tuner's message
      listener never existed and its button stayed dead while "Darken this
      page" worked. It now injects every script the manifest declares
      (`tuner.js` is idempotent via `window.__dmTunerLoaded`).
- [x] **Popup race.** Clicking Tune before `refresh()` resolved left `tab` null
      and threw inside `askTab` with no visible error; `askTab` now resolves the
      tab itself and returns null cleanly if there is none.
- [x] **Guard so it cannot drift again:** `scripts/package.py` now runs
      `check_injection_parity()` and fails the build if popup.js stops
      mentioning a script the manifest declares. Verified red (removing the
      tuner line → exactly one FAIL naming tuner.js) then green.

### Open
- [ ] **Brave trial on a real site** (unpacked copy already 1.0.16:
      brave://extensions → DarkMode → Reload). Zen is still on signed 1.0.15.
- [ ] **Upload 1.0.16 to AMO** once the trial passes — notes ready in
      `amo-release-notes-1.0.16.md`. Upload `dist/DarkMode-1.0.16.xpi`.
- [ ] Not reproduced from Mike's report: text "stays white". The container case
      was tested and a rule on `.wysiwyg` DOES reach the heading
      (`rgb(26,26,26)` → `rgb(0,255,255)` computed), so if a colour still fails
      to land, capture the panel's info line (which element it picked) and the
      mirror line.
- [ ] Tune a real resistant site (Gmail is DENY-listed by design) and export the
      rules — that export is the starting point for a real palette instead of
      per-element choices.
- [ ] Global theme: flip `tuneRulesGlobal` on by promoting a host's rules; the
      application path already concatenates global + per-host.

## 2026-11-11 — 1.0.15: "tune in place" (point at an element, tune the class)

### Done
- [x] **`tuner.js`** — on-page panel in a shadow root (site CSS cannot touch it,
      no `innerHTML` anywhere: Trusted Types sites reject it).
- [x] **Picker** — hover outline via `elementFromPoint` + bounding rect (never
      computed style: a `display:none` ancestor leaves a descendant reporting
      `display:block`), Esc cancels, clicking the panel never captures itself.
- [x] **"The whole class" scope** — every class the element carries is listed
      with its live element count, sorted by count, so scope is chosen by
      observed blast radius instead of selector syntax. Plus "this element only"
      and a free-text selector.
- [x] **Live tuning** — text colour and background colour, applied through one
      `<style>` with `!important`, re-rendered on every change.
- [x] **Contrast readout against the measured backdrop** — walks ancestors for
      the first opaque background, prints the ratio and flags it:
      dark card `13.7:1 — good`; the same cyan on a light surface
      `1.2:1 — too low` in red. This is the cyan-on-white trap, shown at the
      moment of choosing rather than discovered later.
- [x] **Persistence** — rules as `{sel, color, bg}` under
      `tuneRulesByHost[host]`, with a `tuneRulesGlobal` list applied on every
      host and per-host rules layered last. A global theme is therefore the same
      rule list at wider scope, not a second mechanism. `Copy JSON` exports the
      merged set so proven rules can be baked into `content.css` defaults.
- [x] Popup button `🎯 Tune in place…` (popup closes, panel stays on the page).
- [x] `scripts/package.py` FILES list now includes `tuner.js` — caught by
      verifying the built archive, not by reading the script.
- [x] Verified in **Chrome and Zen** against a mock page: capture → `.hP → 4
      elements`, `#00ffff` applied to all four (`rgb(0,255,255)` computed), rule
      saved to `tuneRulesByHost`, contrast warnings both ways.
- [x] Built `dist/DarkMode-1.0.15.{zip,xpi}` (16 files, `tuner.js` inside both,
      manifest `content_js = [content.js, tuner.js]`), unpacked copies synced.

### Open
- [x] **Zen/Firefox install — done 2026-11-11 via AMO web upload, no API key.**
      `darkmode@landis.cc` was already on AMO (id **3066327**, author DarkSky,
      **listed**, slug **`darkmode-for-resistant-sites`**), so "upload a new
      version" was all that was needed — the API-key blocker in the note below
      was self-inflicted. 1.0.15 is signed and public (file 5239699, created
      2026-11-11T17:42Z). Live payload verified against
      `dist/DarkMode-1.0.15.xpi`: 16/16 entries identical, `META-INF/cose.sig`
      present, `background.scripts`, `tuner.js` 19,880 bytes.
      Installed: **Zen = 1.0.15 signed** (version + signature read back out of
      the profile xpi). Firefox was holding 1.0.7 open (sharing violation) so it
      could not be copied in; it updates itself from AMO.
      **Traps, next time:**
        * Upload `dist/DarkMode-<ver>.xpi`, **never** the `.zip` — the zip is the
          Chromium flavor (`background.service_worker`) and AMO's linter rejects
          it: `MANIFEST_FIELD_UNSUPPORTED`, 1 error, upload blocked.
        * Firefox's *"appears to be corrupt"* means **unsigned**, not damaged.
        * Developer-hub URLs are keyed by **slug**, not GUID:
          `/developers/addon/darkmode/` → "Oops! Not allowed";
          `/developers/addon/darkmode-for-resistant-sites/` → correct.
        * **CORRECTION (same day):** the `\u2014` difference is NOT drift. AMO
          re-serializes `manifest.json` while signing — 1.0.14, built before
          any of today's changes, shows the same escaped dash, and the parsed
          manifests are equal. `scripts/amo-release.py verify` now compares the
          manifest parsed and everything else byte-for-byte, and reports the
          signed file's payload as identical.
- [ ] Tune a real resistant site (Gmail is DENY-listed by design) and export the
      rules — that export is the starting point for a real palette instead of
      per-element choices.
- [ ] Global theme: flip `tuneRulesGlobal` on by promoting a host's rules; the
      application path already concatenates global + per-host.

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
