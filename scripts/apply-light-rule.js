/* apply-light-rule.js -- install the default "replace white & grey ink" rule for
 * the current host, the same rule object the panel's "≈ everything light" click
 * produces, without needing a click.
 *
 * WHY (2026-11-16): the rule set in storage.sync held a single-element selector
 * for aliexpress.com and NO light rule, so 290 visible white/grey text elements
 * were unrecoloured while the panel looked like it had been used. Writing the
 * rule directly is deterministic and prints the before/after state so nothing
 * already saved can be lost silently.
 *
 * Usage: cdp-live-eval.mjs --extension --probe scripts/apply-light-rule.js
 * Set COLOR env via the DEFAULT_COLOR const. Idempotent: re-running replaces the
 * existing light rule instead of appending a second one.
 */
(async () => {
  const DEFAULT_COLOR = '#00ffff';
  const MIN = 0.15;
  const host = location.host.replace(/^www\./, '');

  const area = (a) => new Promise((res) => a.get(null, (v) => res(v || {})));
  const data = await area(chrome.storage.sync);
  const map = data.tuneRulesByHost || {};
  const before = JSON.parse(JSON.stringify(map[host] || []));

  const shape = (r) => ({ id: r.id, match: r.match || 'sel', from: r.from, color: r.color, sel: r.sel ? String(r.sel).slice(0, 50) : undefined });
  const kept = before.filter((r) => r && r.match !== 'light');
  const rule = {
    id: 'rlight' + Math.floor(Math.random() * 1e6).toString(36),
    match: 'light',
    from: '',
    color: DEFAULT_COLOR,
    bg: '',
    min: MIN,
  };
  const after = kept.concat([rule]);
  map[host] = after;
  await new Promise((res) => chrome.storage.sync.set({ tuneRulesByHost: map }, res));

  const check = await area(chrome.storage.sync);
  const stored = (check.tuneRulesByHost || {})[host] || [];
  return {
    host,
    before: before.map(shape),
    after: stored.map(shape),
    persisted: stored.some((r) => r.match === 'light' && r.color === DEFAULT_COLOR),
    note: 'reload the page (or let the sweep run) to see it applied',
  };
})()
