// Service worker — stale-while-revalidate for same-origin assets.
// Serves cached HTML/JS/CSS instantly on iOS PWA resume, then updates
// cache in the background. HMR still works (WebSocket, not fetch).

const CACHE = 'dispatcher-v2';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
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

  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const fresh = fetch(request).then((res) => {
        if (res.ok) cache.put(request, res.clone());
        return res;
      });
      if (cached) {
        fresh.catch(() => {}); // revalidate in background, swallow errors
        return cached;
      }
      return fresh;
    })
  );
});
