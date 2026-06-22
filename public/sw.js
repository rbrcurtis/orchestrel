// Service worker — network-first for all same-origin assets.
// Always tries the network so fresh code wins; falls back to cache only when offline.

const CACHE = 'orchestrel-v7';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // Only cache same-origin GET requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Skip tRPC/API calls (handled by React Query + IndexedDB)
  if (url.pathname.startsWith('/api/')) return;

  // Skip Vite HMR internals
  if (url.pathname.startsWith('/@') || url.pathname.startsWith('/__vite')) return;

  // Skip manifest (doesn't need caching, causes CORS errors behind CF Access)
  if (url.pathname === '/manifest.json') return;

  // Network-first: always try the network so fresh code wins; cache the
  // successful response and only fall back to cache when the network fails.
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      fetch(request)
        .then((res) => {
          if (res.ok && !res.redirected) cache.put(request, res.clone()).catch(() => {});
          return res;
        })
        .catch(() => cache.match(request).then((cached) => cached || Response.error())),
    ),
  );
});
