// Offline support. Serves the app from cache, refreshing the cache in the
// background, so updates appear on the next launch. Bump CACHE when deploying
// to drop old files.
const CACHE = 'psd-whiteboard-v3';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/board.js',
  'js/camera.js',
  'js/config.js',
  'js/drive.js',
  'js/icons.js',
  'js/instruments.js',
  'js/media.js',
  'js/pdf.js',
  'js/pdfimport.js',
  'js/recorder.js',
  'js/store.js',
  'vendor/pdfjs/pdf.min.js',
  'vendor/pdfjs/pdf.worker.min.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const fresh = fetch(req, { cache: 'no-cache' }).then(async (res) => {
    if (res.ok) await (await caches.open(CACHE)).put(req, res.clone());
    return res;
  });
  e.waitUntil(fresh.catch(() => {}));
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => cached || fresh),
  );
});
