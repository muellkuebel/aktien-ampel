const CACHE = "aktien-ampel-v1.20";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/favicon-32.png",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.endsWith("data.json")) {
    // Always network-first; never serve stale data when online
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then((res) => {
          const copy = res.clone();
          // Cache under stable key (no query) for offline fallback
          const stable = new Request(url.origin + url.pathname, { credentials: event.request.credentials });
          caches.open(CACHE).then((c) => c.put(stable, copy));
          return res;
        })
        .catch(() =>
          caches.match(url.origin + url.pathname).then((cached) => cached || caches.match(event.request))
        )
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
