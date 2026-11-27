# DarkMode 1.1.0 — the palette, and dark by default

Two changes that alter what the extension is, plus the machinery both needed.

## Dark by default (the contract changed on purpose)

Every page is now darkened unless you switch it off. This deliberately breaks the
old promise — "does nothing until asked" — at the owner's request:

> "I'd also like it to consider the possibility of automatically going Dark Mode
> to previously unseen sites by default (violating our claim that it does nothing
> until asked)."

The popup carries the switch (`Auto-dark sites I have not seen`), and the
remember checkbox inverts its meaning while it is on: *"Keep &lt;host&gt; light"*
writes a per-site exclusion (`dmLightHosts`) instead of a per-site inclusion.

### What had to be fixed for that to be safe

Turning the default on promoted two dormant holes in "is this page already
dark?" into every-page bugs:

- **`color-scheme: light dark` was not recognised.** That is how a modern site
  says "use my dark theme if the reader prefers dark"; under a dark OS
  preference it renders dark. Only an exact `color-scheme: dark` counted, so
  example.com (`html{color-scheme:light dark;background:light-dark(#eee,#222)}`)
  was inverted — white type onto #222 turned black-on-black.
- **Our own forced root background masked the page's.** `html.cr-dark`
  {`background:#fff`} is how the invert reaches the browser canvas, not a fact
  about the page. Reading it as "light" meant the guard that backs out of a
  natively-dark page could never fire once we had applied. It is now treated as
  inconclusive, and an ink sample decides.

Backing out happens earlier too: at `DOMContentLoaded` + 150 ms (a guess) and
again after `load` (the original guard). A darkening the user asked for is never
undone.

## The palette

- **Master palette** (`dmInk`, default `#2f9eae`): one ink colour for every site.
  Cyan is the current preference; the popup has a colour picker, so changing it
  is one control, not a rebuild.
- **Site palette** (`dmSiteInk[host]`): an override that is only created when you
  press Save on a site that needs one.
- **Switch** (`dmAccent`, default on): off means text keeps its own colour.

Precedence: master → site → your own saved tone/selector rules. The master rule
is prepended, so a saved rule always wins.

Why `#2f9eae` and not `#00ffff`: at 15.79:1 on a near-black page full-page cyan
text is exhausting (a conclusion already recorded in this repo from 1.0.16). Hue
188 with 6.24:1 is unmistakably cyan and clears AA. The master rule deliberately
does **not** force `font-weight: 600` — that crutch existed for the dimmer
`#3e738b` ink and would reflow text on sites nobody inspected.

### Coverage, measured on the installed build

| page | result |
|---|---|
| lite.cnn.com | auto-darked; 112 elements accented; coverage 112 / 112, 0 left |
| www.w3.org | auto-darked; 149 accented; 66 / 66 light-ink owners covered |
| example.com, afuncan.com, rfc-editor.org | correctly NOT darkened (already dark) |
| lite.cnn.com pixels | 6.3% exact-cyan with the engine on, 0.0% with it off; near-white 0.1% vs 88.3% |

The 17 elements still rendering near-white on w3.org are labels on fills that the
brightness ceiling dimmed to L ≤ 0.16, where cyan scores 1.7:1 and the pale ink
scores above 4.5:1. Contrast wins there on purpose.

## Also in this build

- **Ink on a bright or saturated plate is left alone.** Applying a palette to
  every site needs the guard that a hand-made per-element rule never did: a white
  label on a blue button stays white. Verified by `scripts/test-plate-guard.mjs`,
  which plants the three cases (canvas / saturated plate / white plate) and
  asserts tag-or-not-tag for each.
- **Labels on dimmed fills can take the palette**, and only if they still clear
  4.5:1. Ten w3.org elements rendered white before this because the inline label
  fix beat the stylesheet; they are still white, and now for the right reason.
- **Tone rules are scoped to the engine class**, so reverting to light returns the
  page's own colours instead of leaving cyan ink behind.
- **No sweep on a page we did not darken** (it only littered attributes).
- `scripts/probe-darkmode-live.mjs`, `test-plate-guard.mjs`,
  `shot-darkmode-pair.mjs` — the harness that produced every number above.

## Not changed

- Still a wheel invert with **no hue-rotate**; media still restored to true
  colour; frames still judged by their own pixels; Gmail still deny-listed
  because inverting its own accent turns it brown.
