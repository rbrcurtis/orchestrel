// Service worker — network-first for all same-origin assets.
// Always fetches from server; falls back to cache only when offline.

const CACHE = 'orchestrel-v5';

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

  // Network-first, cache fallback for all assets
  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok && !res.redirected) {
          const cache = caches.open(CACHE).then((c) => c.put(request, res.clone()));
          cache.catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches
          .open(CACHE)
          .then((c) => c.match(request))
          .then((r) => r || Response.error()),
      ),
  );
});
