/* cdp-eval.mjs — drive a real Chrome over CDP with no npm dependencies.
 *
 * Node 22+ ships a global WebSocket, so this needs nothing installed. It
 * launches headless Chrome on a free port, navigates, waits for load + settle,
 * publishes requested local files as window.__SRC[name] — which is how a real
 * content script gets injected into a LIVE https page, where file:// fetches
 * are blocked — then evaluates a test file and prints its return value as JSON.
 *
 *   node cdp-eval.mjs --url URL [--inject name=path]... --test test.js
 *                     [--settle 2000] [--width 1400] [--height 1000]
 *                     [--cold --page-script name=path]... [--shot out.png]
 *
 * --inject passes a file through window.__SRC for the test to use (page already
 * loaded). --cold instead launches on about:blank, registers --page-script
 * files with Page.addScriptToEvaluateOnNewDocument in the order given, and only
 * then navigates — which is the ONLY faithful way to reproduce document_start
 * behaviour (allowlist reads, first-sweep timing, storage races).
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const url = arg('url');
if (!url) { console.error('need --url'); process.exit(2); }
const settle = parseInt(arg('settle', '1800'), 10);
const width = parseInt(arg('width', '1400'), 10);
const height = parseInt(arg('height', '1000'), 10);
const testFile = arg('test');
const cold = argv.includes('--cold');
const injects = [];       // [name, path] -> window.__SRC[name]
const pageScripts = [];   // [name, path] -> document_start, in order
const styles = [];        // [name, path] -> <style> at document_start
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--inject' || argv[i] === '--page-script' || argv[i] === '--style') {
    const spec = argv[i + 1] || '';
    const eq = spec.indexOf('=');
    if (eq > 0) {
      const entry = [spec.slice(0, eq), spec.slice(eq + 1)];
      if (argv[i] === '--inject') injects.push(entry);
      else if (argv[i] === '--page-script') pageScripts.push(entry);
      else styles.push(entry);
    }
  }
}

const CHROME = process.env.DM_CHROME ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// Temp artifacts belong on F: on this box (never C:).
const TMPBASE = process.env.DM_TMP || 'F:\\tmp';
const profile = mkdtempSync(join(TMPBASE, 'dm-cdp-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-features=Translate,MediaRouter',
  '--remote-debugging-port=0',
  '--user-data-dir=' + profile,
  '--window-size=' + width + ',' + height,
  cold ? 'about:blank' : url,
], { stdio: ['ignore', 'ignore', 'pipe'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function portFromProfile() {
  const f = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150; i++) {
    // Chrome creates and writes this file in two steps; reading mid-write on
    // Windows throws EBUSY, which is not a failure.
    try {
      if (existsSync(f)) {
        const first = readFileSync(f, 'utf8').split('\n')[0];
        if (first) return parseInt(first, 10);
      }
    } catch (e) { /* still being written */ }
    await sleep(100);
  }
  throw new Error('chrome did not open a debugging port');
}

async function pageTarget(port, wantUrl) {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/list');
      const list = await r.json();
      const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      // Chrome can briefly expose an about:blank page target ahead of the one it
      // was launched with, so NEVER take pages[0] blindly — prefer an exact URL
      // match, then any real page, and only then a blank one.
      const norm = (u) => String(u || '').replace(/\/+$/, '');
      const page =
        pages.find((t) => norm(t.url) === norm(wantUrl)) ||
        pages.find((t) => t.url && t.url !== 'about:blank') ||
        pages.find((t) => norm(t.url) === 'about:blank' || t.url === 'about:blank') ||
        pages[0];
      if (page) return page;
    } catch (e) { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('no page target');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onopen = () => resolve({
      send(method, params) {
        const mid = ++id;
        ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        return new Promise((res, rej) => pending.set(mid, { res, rej }));
      },
      close() { try { ws.close(); } catch (e) {} },
    });
    ws.onerror = () => reject(new Error('ws error'));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
        else p.res(msg.result);
      }
    };
  });
}

async function evalIn(cdp, expression, awaitPromise = true) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true, userGesture: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('page exception: ' + ((d.exception && d.exception.description) || d.text));
  }
  return r.result.value;
}

let exitCode = 0;
try {
  const port = await portFromProfile();
  const target = await pageTarget(port, url);
  const cdp = await connect(target.webSocketDebuggerUrl);

  if (cold) {
    // Register BEFORE the document exists, in the order given, then navigate —
    // the same ordering the browser gives manifest content_scripts.
    //
    // addScriptToEvaluateOnNewDocument fires EARLIER than document_start: the
    // document can have no documentElement yet, and both content.js and tuner.js
    // create nodes on load (which throws on a null documentElement). A real
    // document_start content script always has documentElement, so gate on it —
    // without eval, in case the page's CSP blocks it.
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // CSS first: manifest content_scripts inject it alongside the JS, and
    // without it `html.cr-dark` has no filter at all — which silently makes the
    // page "not inverted" and the colour sweep match nothing.
    for (const [name, path] of styles) {
      const css = readFileSync(path, 'utf8');
      const boot = '(function(){var css=' + JSON.stringify(css) + ';' +
        'function go(){var s=document.createElement("style");s.textContent=css;' +
        '(document.head||document.documentElement).appendChild(s);}' +
        'if(document.documentElement){go();}else{var mo=new MutationObserver(function(){' +
        'if(document.documentElement){mo.disconnect();go();}});' +
        'mo.observe(document,{childList:true,subtree:true});}})();';
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: boot });
      console.error('registered style ' + name + ' at document_start');
    }
    for (const [name, path] of pageScripts) {
      const src = readFileSync(path, 'utf8');
      const guarded = '(function(){var run=function(){\n' + src + '\n};\n' +
        'if(document.documentElement){run();}else{' +
        'var mo=new MutationObserver(function(){if(document.documentElement){mo.disconnect();run();}});' +
        'mo.observe(document,{childList:true,subtree:true});}})();';
      const r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: guarded });
      console.error('registered ' + name + ' at document_start (' + (r && r.identifier) + ')');
    }
    await cdp.send('Page.navigate', { url });
  }

  for (let i = 0; i < 300; i++) {
    const ready = await evalIn(cdp, 'document.readyState', false).catch(() => 'loading');
    if (ready === 'complete') break;
    await sleep(100);
  }
  await sleep(settle);

  for (const [name, path] of injects) {
    const text = readFileSync(path, 'utf8');
    await evalIn(cdp, 'window.__SRC=window.__SRC||{};window.__SRC[' +
      JSON.stringify(name) + ']=' + JSON.stringify(text) + ';true', false);
  }

  if (testFile) {
    console.log(JSON.stringify(await evalIn(cdp, readFileSync(testFile, 'utf8')), null, 2));
  } else {
    console.log(JSON.stringify(await evalIn(cdp,
      '({title:document.title,els:document.querySelectorAll("*").length})', false)));
  }

  const shot = arg('shot');
  if (shot) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    (await import('node:fs')).writeFileSync(shot, Buffer.from(r.data, 'base64'));
    console.error('screenshot -> ' + shot);
  }
  cdp.close();
} catch (e) {
  console.error('DRIVER ERROR: ' + e.message);
  exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) {}
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(exitCode);
}
