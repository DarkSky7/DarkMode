# DarkMode 1.0.19 — a tuned site comes back dark without re-saving

Follow-up to 1.0.18, which fixed the reload path but required the user to press
Save once more after updating, because 1.0.17 had stored tuning rules **without**
adding the host to `darkHosts`.

Reading the real profile confirmed it was exactly that state: two tuning rules
for `quantamagazine.org` and no `darkHosts` entry at all — so the reloaded page
was never inverted, and a colour rule that records the colour seen on a
*darkened* page had nothing to match. That is "it didn't reassert … or
darken" in one sentence.

Now: **a host that has tuning rules is treated as a host that should be dark.**
On load, if rules exist for the host but it is not remembered, the tuner adds it
to `darkHosts` and switches the engine on before sweeping. No re-saving, no popup
visit, no user action required on any site tuned by an earlier version.

This is a deliberate product rule: rules exist because the page was tuned, and a
tuned page on its original light background is not the thing that was tuned. If
you want a site light again, remove its rules.

## Verification

`scripts/test-reload.py` now includes the exact case: a stored rule, an empty
`darkHosts`. Cold load at document start asserts the page is darkened, 153
elements are tagged, the paragraph is recoloured, and the repair was **persisted**
to storage rather than only applied to the current tab.

All three suites green: 23 (mock/inversion), 21 (live article), 16 (cold reload ×
3 variants).
