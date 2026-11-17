/* set-accent-colour.js -- rewrite EVERY stored light rule in this profile to the
 * current default ink colour.
 *
 * WHY (2026-11-16): changing DEFAULT_INK in tuner.js only affects rules created
 * AFTERWARDS. Rules already saved per host keep the old colour forever, so a
 * "dimmed the default" release would leave every site that had been tuned still
 * showing the previous accent -- and a DOM probe on a fresh page would look
 * correct while the tuned hosts were stale. This walks the whole rule map.
 *
 * Run in the EXTENSION world: --extension --world DarkMode
 * Usage: COLOR env is baked below; keep it identical to DEFAULT_INK in tuner.js.
 */
(async () => {
  const COLOR = '#3e738b';                 // == DEFAULT_INK in tuner.js
  const area = (a) => new Promise((res) => a.get(null, (v) => res(v || {})));
  const data = await area(chrome.storage.sync);
  const map = data.tuneRulesByHost || {};
  const globals = data.tuneRulesGlobal || [];
  const changed = [];

  for (const [host, rules] of Object.entries(map)) {
    for (const r of rules || []) {
      if (r && r.match === 'light' && r.color !== COLOR) {
        changed.push({ host, was: r.color, now: COLOR });
        r.color = COLOR;
      }
    }
  }
  for (const r of globals) {
    if (r && r.match === 'light' && r.color !== COLOR) {
      changed.push({ host: '(global)', was: r.color, now: COLOR });
      r.color = COLOR;
    }
  }

  await new Promise((res) => chrome.storage.sync.set({ tuneRulesByHost: map, tuneRulesGlobal: globals }, res));

  const check = await area(chrome.storage.sync);
  const after = {};
  for (const [h, rs] of Object.entries(check.tuneRulesByHost || {})) {
    after[h] = (rs || []).map((r) => r.match + ':' + (r.color || '-'));
  }
  return {
    color: COLOR,
    changed,
    unchanged: changed.length === 0,
    hosts: after,
    global: (check.tuneRulesGlobal || []).map((r) => r.match + ':' + (r.color || '-')),
    note: 'reload the page for the new colour to paint',
  };
})()
