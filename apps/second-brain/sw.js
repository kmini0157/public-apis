// Service worker: cache the app shell so the Second Brain opens offline.
// Only same-origin app files are cached; CDN libs and the embedding model
// are handled by the browser's own HTTP/transformers.js cache.

const CACHE = "second-brain-v3";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./js/app.js",
  "./js/db.js",
  "./js/embed.js",
  "./js/vec.js",
  "./js/extract.js",
  "./js/rag.js",
  "./js/voice.js",
  "./js/crypto.js",
  "./js/cluster.js",
  "./js/sync.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Only manage our own origin; let CDN/model/API requests hit the network.
  if (url.origin !== self.location.origin) return;
  // Stale-while-revalidate for app shell assets.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
