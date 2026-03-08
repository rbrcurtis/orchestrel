// Service worker — network-first for all requests, no asset caching.
// Ensures fresh JS/CSS on every load while keeping PWA installability.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  // Clear any caches left by previous SW versions
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Let the browser handle everything normally (network-first, no cache)
  // This explicitly prevents any browser default SW caching behavior
  e.respondWith(fetch(e.request));
});
