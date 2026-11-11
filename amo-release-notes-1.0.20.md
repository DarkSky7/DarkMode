# DarkMode 1.0.20 — your colour always wins

Small, and it fixes something visible in the live profile: a rule saved by an
older version can keep a few elements of a colour group at the old colour, even
though the new rule covers them.

Concretely: `quantamagazine.org` still carries a 1.0.16-era rule for a single
paragraph whose selector is
`div.post__content > section.outer > div.flex-auto > div.post__content__section > div.post__content > p:nth-of-type(7)`
— that is specificity **(0,5,6)**. The colour group's rule was emitted as
`:root [data-dm-tone="id"][data-dm-tone]`, **(0,3,0)**, so the old rule won and
one paragraph of a 153-element group kept the previous teal.

`!important` does not settle ties — specificity does, and the page (or an older
rule) can always be more specific. So the emitted selector now repeats the
attribute to reach **(0,8,0)**: seven extra `[data-dm-tone]` cost nothing at
match time, cannot change which elements match, and put the user's choice above
site rules that would otherwise win. A site can still outrank it with a
pathological selector, but nothing realistic does.

## Verification

`scripts/test-inversion.py` gains a pinned case: a page rule at (0,4,1) with
`!important` and a colour-group rule over the same element. Proven red-then-green
— with one extra repetition the element stays the site's colour
(`rgb(0, 51, 102)`); with seven it renders the chosen colour. Both the inverted
and the plain page are checked.

All three suites green: 25 (mock/inversion), 21 (live article), 16 (cold reload ×
3 variants).
