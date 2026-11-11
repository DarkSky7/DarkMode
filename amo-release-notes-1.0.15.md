# AMO release notes — 1.0.15

Submitted 2026-11-11, signed and public as file 5239699 (created 2026-11-11T17:42Z).

## Release notes (text entered on AMO)

Adds Tune in place. Click the target button in the popup (or Ctrl+Alt+click an
element) and hover any element the darkener has skipped. The panel reports what
it is, the classes it carries, and how many elements each class covers, so you
can choose the scope to change: this element only, one class, or a typed
selector.

Text and background colours adjust live, with a contrast readout that flags
anything below 3:1 before it is saved. Tuned rules are stored per site, and any
site's rules can be promoted to a global list that applies everywhere. Copy JSON
exports the merged rule set so good choices can be baked into the extension's
defaults.

No new permissions, no new host access, no network requests.

## Notes to reviewers

All page interaction (panel, hover picker) is user-initiated; nothing runs until
the tune button is clicked.

## Facts verified before submitting

- Permissions unchanged from 1.0.14: `storage`, `activeTab`, `scripting`
  (manifest diff of 1.0.14 vs 1.0.15 lists only version, `tuner.js` in
  `content_scripts`, and the `background` reshuffle below).
- `addons-linter` on the uploaded artifact: **0 errors, 0 warnings, 0 notices**.
- Artifact must be the Firefox flavor (`.xpi`, `background.scripts`). The
  Chromium `.zip` uses `background.service_worker`, which AMO rejects with
  `MANIFEST_FIELD_UNSUPPORTED`.
- AMO devhub URL is slug-keyed: `/developers/addon/darkmode-for-resistant-sites/`.
