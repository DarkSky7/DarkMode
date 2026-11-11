# DarkMode 1.0.17 — tune by text colour, not by class

## What's new

**"≈ all text #e5e5e5 → 208 elements".** When you pick an element, the tuner now
counts every text element on the page by the colour it actually renders, and
offers the colour group as a scope — alongside (or instead of) the element's
classes. Choosing it recolours the entire group with a single rule.

This exists because class scoping simply cannot express "the body text" on many
sites. On quantamagazine.org the article paragraphs are bare `<p>` elements with
no class at all, so the picker offered only "this element only" and a hand-typed
selector: pointing at a paragraph and choosing cyan recoloured **1 of 186** text
elements and left the other 185 white. Those 186 elements span `p`, `span`, `h2`,
`a`, `em`, `strong` and `h3`, and their only shared property is the colour they
render — which CSS cannot query. The extension measures it instead.

- The panel shows what the sweep found (`208 elements show #e5e5e5 · 8 text colours`).
- The scope menu gains `≈ all text #e5e5e5 → 208 elements (dominant)`, and also
  offers the page's dominant colour when the picked element isn't it.
- It becomes the default scope when the picked element's colour group is the
  dominant one and it is larger than any useful class on that element — i.e. when
  the class list is useless, which is the case this is for.
- Colours are grouped as the **eye** sees them, so a page that is colour-wheel
  inverted groups correctly, and elements inside restored-photo subtrees (which
  carry a second invert) are written differently so they don't double-invert.
- Ink painted with `-webkit-text-fill-color` is measured and moved too; ink that
  is transparent because it is a `background-clip: text` gradient is left alone.
- Rules persist as `{match:'color', from:'#e5e5e5', color:'#00ffff'}` beside the
  existing `{sel, color, bg}` rules, per host, and export in the same JSON.

## Implementation notes for review

- No new permissions, no new host access, no network requests. Same
  `storage` / `activeTab` / `scripting` set as before.
- Matching is done by tagging elements with `data-dm-tone="<ruleId><parity>"` and
  emitting one stylesheet rule per parity, instead of inline styles, so a rule is
  undone by removing the attribute and a colour change costs no DOM work.
- The emitted selectors use `:root` plus the attribute twice, specificity
  (0,3,0), so a site's own `!important` text rules cannot outrank the tuning.
- A `MutationObserver` re-tags content added after load (no attribute watching,
  so writing our own attribute cannot loop).
- All interaction remains user-initiated: nothing is applied until the user picks
  an element and saves a rule.

## Fixed

- Version numbers had drifted again: `content.js` was still reporting 1.0.14
  while the manifest said 1.0.16. The release tool now bumps and verifies all
  three version sites (manifest, popup, content script).
- Saving a rule in the first moments after page load could silently drop it: the
  storage read resolved after the save and replaced the rule array. Saves now
  await the storage read.

## Verification

- `scripts/test-inversion.py` — 23 assertions in real headless Chrome, including
  a new case for `-webkit-text-fill-color` ink, plus a pixel sample proving the
  inverted page paints cyan.
- `scripts/test-tone-live.py` — 20 assertions against the live Quanta article
  (one rule → 208 elements cyan; headings and inline spans follow; blue links are
  untouched; re-sweep idempotent; save/reload/remove round-trip).
