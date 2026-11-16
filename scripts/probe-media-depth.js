/* probe-media-depth.js -- "why are the images inverted in THIS browser?"
 *
 * Same page, same injected engine, one browser at a time. Answers with numbers:
 *   - the net invert() depth histogram over every <img> (odd = rendering negative,
 *     even = true colour),
 *   - the host each image comes from (a CDN that will not answer our sampling
 *     fetch is the one class of failure that leaves EVERY background photo
 *     inverted while plain <img>s look right),
 *   - a live fetch of a few of those URLs, reported with its real outcome
 *     (CORS-served blob vs opaque vs thrown),
 *   - how many elements the bg-photo pass managed to mark.
 *
 * Reads no extension storage and mutates nothing. Returns an array of strings,
 * so cdp-eval prints it as JSON.
 */
(async function () {
  const out = [];
  const depth = (el) => {
    let n = 0, x = el;
    while (x && x.nodeType === 1) {
      if (/invert\(\s*(?:1|100%)\s*\)/.test(getComputedStyle(x).filter || '')) n++;
      x = x.parentElement;
    }
    return n;
  };

  out.push('env :: brave=' + (!!navigator.brave) + ' ua=' + navigator.userAgent.slice(0, 70));
  out.push('page :: ' + location.href.slice(0, 90) + ' host=' + location.hostname);
  out.push('html :: class="' + document.documentElement.className + '" filter=' +
           getComputedStyle(document.documentElement).filter +
           ' bodyBG=' + getComputedStyle(document.body || document.documentElement).backgroundColor);

  const imgs = [].slice.call(document.querySelectorAll('img'));
  const hist = {};
  const hosts = {};
  for (const im of imgs) {
    const d = depth(im);
    hist[d] = (hist[d] || 0) + 1;
    try {
      const h = new URL(im.currentSrc || im.src, location.href).host;
      hosts[h] = (hosts[h] || 0) + 1;
    } catch (e) {}
  }
  out.push('img count=' + imgs.length + ' :: net-depth histogram ' + JSON.stringify(hist));
  out.push('img hosts :: ' + JSON.stringify(hosts));

  const urls = [];
  for (const im of imgs) {
    const u = im.currentSrc || im.src;
    if (u && u.indexOf('data:') !== 0 && urls.indexOf(u) === -1) urls.push(u);
    if (urls.length >= 3) break;
  }
  for (const u of urls) {
    let verdict;
    try {
      const res = await fetch(u, { credentials: 'omit' });
      const blob = await res.blob();
      let bitmap = 'no';
      try { const bm = await createImageBitmap(blob); bitmap = bm.width + 'x' + bm.height; if (bm.close) bm.close(); }
      catch (e) { bitmap = 'THREW ' + e.message; }
      verdict = 'ok status=' + res.status + ' type=' + res.type + ' bytes=' + blob.size + ' bitmap=' + bitmap;
    } catch (e) {
      verdict = 'THREW ' + e.message;
    }
    out.push('sample-fetch ' + u.slice(-52) + ' :: ' + verdict);
  }

  const marks = document.querySelectorAll('[data-cr-bgphoto]');
  out.push('bg-photo elements marked=' + marks.length);
  const bgCandidates = [].slice.call(document.querySelectorAll('*')).filter(function (el) {
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    return cs.backgroundImage.indexOf('url(') !== -1 && b.width * b.height >= 2500;
  });
  const bgHist = {};
  for (const el of bgCandidates) {
    const d = depth(el);
    bgHist[d] = (bgHist[d] || 0) + 1;
  }
  out.push('bg-image elements >=2500px2 =' + bgCandidates.length + ' :: depth histogram ' +
           JSON.stringify(bgHist));
  return out;
})();
