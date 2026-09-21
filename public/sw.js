// Service worker — stale-while-revalidate for all same-origin assets.
// Serves the cached copy immediately, then refetches in the background so the
// next load gets fresh code. Network is used only when nothing is cached.

const CACHE = 'orchestrel-v8';

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

  // Stale-while-revalidate: return the cached copy at once, and refresh the
  // cache in the background. A miss falls through to the network.
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const refresh = fetch(request)
        .then((res) => {
          if (res.ok && !res.redirected) cache.put(request, res.clone()).catch(() => {});
          return res;
        })
        .catch(() => undefined);
      if (cached) {
        e.waitUntil(refresh);
        return cached;
      }
      return (await refresh) || Response.error();
    }),
  );
});
