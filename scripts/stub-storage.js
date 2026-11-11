/* Simulates the extension's own storage as it exists on a RELOAD after the user
 * saved a tuning rule: the host is remembered (darkHosts) and one tone rule is
 * stored. Injected with Page.addScriptToEvaluateOnNewDocument, i.e. at
 * document_start, before content.js or tuner.js run — so the storage read is
 * genuinely asynchronous relative to their first sweep.
 *
 * Add ?dmstub=slow to the URL to make the storage callback land 150 ms late,
 * which is what a cold profile or a busy machine looks like.
 */
(function () {
  const HOST = 'quantamagazine.org';
  const SLOW = /[?&]dmstub=slow/.test(location.search);
  /* ?dmstub=noremember = the site was never added to darkHosts, i.e. the user
     saved a tuning rule but never remembered the site itself. */
  const NOMEMBER = /[?&]dmstub=noremember/.test(location.search);
  const store = {
    darkHosts: NOMEMBER ? {} : { 'quantamagazine.org': true },
    tuneRulesByHost: {
      'quantamagazine.org': [
        { id: 'rTEST1', match: 'color', from: '#e5e5e5', color: '#00ffff', bg: '' }
      ]
    },
    tuneRulesGlobal: []
  };
  window.__store = store;
  window.__readLog = [];

  function read(keys, cb) {
    const out = {};
    if (typeof keys === 'string') { out[keys] = store[keys]; }
    else if (Array.isArray(keys)) { keys.forEach((k) => { if (k in store) out[k] = store[k]; }); }
    else if (keys && typeof keys === 'object') {
      Object.keys(keys).forEach((k) => { out[k] = (k in store) ? store[k] : keys[k]; });
    } else { Object.assign(out, store); }
    window.__readLog.push(Object.keys(out).join(','));
    if (cb) {
      if (SLOW) setTimeout(() => cb(out), 150);
      else cb(out);
    }
    return Promise.resolve(out);
  }

  function write(obj, cb) {
    Object.assign(store, obj);
    window.__writeLog = (window.__writeLog || []).concat([Object.keys(obj).join(',')]);
    if (cb) cb();
    return Promise.resolve();
  }

  window.chrome = {
    storage: {
      sync: { get: read, set: write },
      onChanged: { addListener: function () {} }
    },
    runtime: {
      onMessage: { addListener: function () {} },
      sendMessage: function () { return Promise.resolve(); },
      lastError: null
    }
  };
  window.__DM_STUB = { host: HOST, slow: SLOW, remembered: !NOMEMBER };
})();
