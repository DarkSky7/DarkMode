# DarkMode 1.0.7 — Notes to reviewer (paste into AMO "Notes to reviewer")

Paste the block below into the **Notes to reviewer** field when uploading
`dist/DarkMode-1.0.7.xpi`. Keep it factual — it describes what the code does,
including the one place where it acts without an explicit click, because that
is the part a reviewer is most likely to query.

## Paste-ready

```
WHAT IT DOES
A dark-mode utility for sites that resist ordinary darkeners. It applies a CSS
filter invert(1) to the page, and counter-inverts images/video/canvas so media
keeps its natural colours. It is not an overlay or a content rewriter: no
element's text is harvested, altered or transmitted.

PERMISSIONS AND WHY
- storage: remembers which hostnames the user opted into (chrome.storage.sync).
  That map of hostnames is the only persisted state; it never leaves the
  browser profile.
- activeTab + scripting: needed to re-inject the content script into the
  current tab when the user clicks the toolbar icon or a remembered host is
  restored.
- content_scripts matches "<all_urls>": a darkener must be able to run on any
  site the user chooses. The script makes no network requests at all — there is
  no fetch/XHR/WebSocket/telemetry anywhere in the source, and no remote code is
  loaded or evaluated. All logic is local and readable in content.js,
  background.js, popup.js.

DEFAULT STATE
On a normal site the extension is inert: it adds no class, no style and no
filter until the user clicks "Darken this page" in the popup, or has previously
ticked "Always dark on <site>" for that host.

THE ONE AUTOMATIC CASE (please read)
mail.google.com is special-cased, and this release is where that behaviour was
introduced. Gmail ships its own dark theme, so inverting it is the wrong tool:
invert(1) maps the user's chosen accent colour to a different hue (measured:
rgb(123,200,206) renders as rgb(132,55,49), i.e. cyan becomes brown) while
ordinary dark text becomes white. Earlier versions produced a broken-looking
inbox when a user enabled the extension there.

So on mail.google.com the extension NEVER applies the invert. Instead, when —
and only when — the page itself already measures as dark (body background
luminance <= 0.28), it corrects the handful of containers Gmail's own dark theme
leaves white, by setting background-color/color inline on those elements. The
replacement colours are sampled from the page's own palette, not hard-coded.
Nothing is sent anywhere; no Gmail content is read or stored.

If you would prefer this behaviour to be opt-in as well, it can be gated behind
the same "remember this site" toggle — it is a one-line change, and we will
ship it that way if required.

DATA COLLECTION
None. Manifest declares data_collection_permissions.gecko.required = ["none"].
No analytics, no accounts, no servers, no remote endpoints of any kind.

KNOWN TRADE-OFF (listed, not hidden)
The filter approach can misbehave with position: fixed headers on some pages,
and page screenshots capture the darkened rendering.
```

## Suggested listing description edit (not reviewer-facing)

The public summary currently says *"Does nothing until asked"*, which is no
longer literally true because of the Gmail case. Add one honest sentence to the
detailed description:

```
Gmail is the one exception: it already has a dark theme, so DarkMode never
inverts it. Instead, it silently corrects the few panels Gmail's dark theme
leaves white, using colours taken from Gmail's own palette.
```

Keeping the description and the code in agreement matters more than the
marketing line.
