/*
 * sw.js — offline cache.
 *
 * The text engine and its language data are about 6 MB, so they are precached on
 * install: after the first visit the app opens and reads rotas with no signal at
 * all, which matters in a stockroom.
 */
var VERSION = 'v4';
var CACHE = 'shift-scanner-' + VERSION;

var PRECACHE = [
  './',
  'index.html',
  'css/styles.css',
  'js/grid.js',
  'js/warp.js',
  'js/ocr.js',
  'js/cloud.js',
  'js/ics.js',
  'js/app.js',
  'vendor/tesseract.min.js',
  'vendor/worker.min.js',
  // tesseract.js picks a core by feature detection. Nearly every current iPhone
  // gets the SIMD LSTM build, so only that one is precached; the plain LSTM
  // fallback is fetched and cached on demand by older devices.
  'vendor/tesseract-core-simd-lstm.wasm.js',
  'lang/eng.traineddata.gz',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // Add individually: one 404 should not void the whole install.
      return Promise.all(PRECACHE.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function (err) {
          console.warn('precache miss', url, err);
        });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  // Never cache calls to an AI provider the user configured.
  if (url.origin !== self.location.origin) return;

  /*
   * Two strategies, deliberately.
   *
   * The engine and language data are large and versioned by filename, so they are
   * cache-first — that is what makes the app work offline without re-downloading
   * ~6MB. Everything else (HTML, CSS, app JS) is network-first, falling back to
   * cache when offline.
   *
   * Cache-first for app code caused a genuinely confusing bug during development:
   * edits were served stale from cache long after the file on disk had changed,
   * and it would have done the same to users after every update.
   */
  var immutable = /\/(vendor|lang|icons)\//.test(url.pathname);

  if (immutable) {
    event.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) {
          if (res && res.status === 200 && res.type === 'basic') {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        });
      })
    );
    return;
  }

  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200 && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('index.html');
        throw new Error('offline');
      });
    })
  );
});
