# DarkMode 1.0.26 — mean saturation was the wrong test

**Root cause, measured on the live signed-in order page, inside the extension's own
isolated world** (`scripts/cdp-live-eval.mjs --extension`):

```
el   div.order-item-content-img        120x120  area 14400  no-repeat / contain
gates  area ✗ gradient ✗ vector ✗ text ✗ tile ✗ nested ✗      (all pass)
stats  sat 0.0055   distinct 21   spread 0.965   meanL 0.763   coverage 1.0
       photo false  lightArt false                    -> skipped, stayed inverted
```

Every gate passed and the sampler still refused it. `photo` required **mean
saturation ≥ 0.12**, and a gold fitting photographed on a **white** sweep is
mostly white pixels — the mean collapses to 0.0055 even though the image spreads
over 21 colour buckets and 0.965 luminance. *Every* product photo on a white
background reads as a flat plate under a mean. The metric was the bug.

## The fix

`photo` is now **mixed tonal content**, not colourfulness:

```
photo = spread >= 0.35 && distinct >= 8
```

- a product shot on white: spread 0.965, distinct 21 → **photograph**
- a saturated flat plate: spread 0.00, distinct 1 → still UI furniture
- an opaque white dial disc: spread 0.27, distinct 9 → still left inverted
- a dark wordmark on transparency: meanL 0.146 → still left inverted (the filter
  is what makes it a light logo on a dark header)
- a light wordmark cut out of its background: coverage 0.46, meanL 0.94 → restored

Greyscale photographs now restore too, which the saturation test could never do.

## Proven on the real page, not a fixture

Attached to the running Brave over CDP, reloaded the extension, navigated a fresh
tab to `aliexpress.com/p/order/index.html`:

```
engineMode invert | html filter invert(1)
imgs          199 total, net-depth histogram {"2": 199}     (all true colour)
bg-photo marked 13
inverted backgrounds 0                          (was every order row's thumbnail)
```

## Tooling added

- **`scripts/cdp-live-eval.mjs`** — run a probe against a LIVE tab in an
  already-running browser; `--extension` executes inside the extension's own
  isolated world, where its exposed handles and its `fetch` behave as they do in
  production. Content-script contexts report the PAGE origin with
  `auxData.type: "isolated"`, so the right world is found by probing for the
  handle, never by matching a name.
- **`scripts/probe-order-page.js`** — is the page darkened, are the images plain
  `<img>` / background-image / in a shadow root, did the shadow stylesheet get
  adopted, and the raw shape of one offending element.
- **`scripts/probe-bg-gate.js`** — replays `startBgPhotoFix`'s gates and prints
  the engine's own sampled numbers, so the failing gate is named by the engine.
- **`scripts/reload-extension.js`** — presses Reload on the unpacked extension in
  `chrome://extensions` over CDP. The DevTools protocol has no extension-reload
  call, the Reload button only exists with Developer mode on, and the list
  re-renders asynchronously after that toggle. Restarting the browser is the
  reliable route.

## Verification

`test-logo-a11y` **15/15** — now including a low-saturation photo on a white
sweep (the exact live case) alongside the flat plate, opaque disc, light
wordmark, plain `<img>` and shadow-root fixtures. `test-showstext` 17/17,
`test-inversion` ALL PASS, live `test-bgphoto` ALL PASS.

## Housekeeping this release exposed

Brave has **two copies of DarkMode installed and both enabled**:

| id | path |
|---|---|
| `engkmokfinknofjifodnakjedibbbahe` | `dist\DarkMode-current` |
| `lpelmfedjclfjoflgohgghbcmpfhabcl` | `dist\DarkMode-1.0.25` |

Two content scripts means every fix is applied twice, every sweep runs twice, and
"which version am I running" has two answers. One should be removed; the versioned
directory is the accident (a re-add from a versioned `dist` folder, which the sync
script's own header already warns about). `scripts/sync-to-brave.sh` correctly
syncs into both, because it reads the paths from Brave rather than guessing.

No new permissions, no new host access, no new network requests.
