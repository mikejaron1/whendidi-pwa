/* A release activates only after its essential offline shell is complete. */
importScripts('/js/version.js');
const CACHE_VERSION = `plotline-${self.CW_RELEASE}`;

const SHELL = [
  '/',
  '/app/',
  '/app/index.html',
  '/privacy.html',
  '/manifest.webmanifest',
  '/css/styles.css',
  '/js/config.js',
  '/js/db.js',
  '/js/import-export.js',
  '/js/stats.js',
  '/js/insights.js',
  '/js/goals.js',
  '/js/drive.js',
  '/js/app.js',
  '/vendor/chart.umd.min.js',
  '/js/version.js',
  '/js/ui.js',
  '/js/charts.js',
  '/js/model.js',
  '/js/report.js',
];
const OPTIONAL = ['/favicon.ico', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable.png'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(SHELL);
    await Promise.all(OPTIONAL.map((url) =>
      cache.add(url).catch((error) => console.warn('Optional offline asset unavailable', url, error))));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((name) => name !== CACHE_VERSION &&
        (name.startsWith('plotline-') || /^v\d+\.\d+\.\d+$/.test(name)))
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return;
  const pathname = url.pathname === '/app' ? '/app/' : url.pathname;
  if (!SHELL.includes(pathname) && !OPTIONAL.includes(pathname)) return;
  // Version-consistent cache-first assets avoid mixing old JS with new HTML.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(pathname);
    if (cached) return cached;
    const response = await fetch(req);
    return response;
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE_UPDATE') event.waitUntil(self.skipWaiting());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
    const app = clients.find((client) => new URL(client.url).pathname.startsWith('/app/'));
    if (app) return app.focus();
    return self.clients.openWindow('/app/');
  }));
});
