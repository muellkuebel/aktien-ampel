const CACHE = "aktien-ampel-v1.28";
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
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        ASSETS.map(async (u) => {
          try {
            const res = await fetch(u, { cache: "reload" });
            if (res.ok) await cache.put(u, res);
          } catch (e) {}
        })
      );
      await self.skipWaiting();
    })()
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
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith("data.json")) {
    // Always network-first; never serve stale data when online
    event.respondWith(
      fetch(req, { cache: "no-store" })
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(url.origin + url.pathname, copy));
          return res;
        })
        .catch(() => caches.match(url.origin + url.pathname, { ignoreSearch: true }))
    );
    return;
  }

  // Seite und Code (HTML, JS, CSS, Manifest): network-first, Cache nur offline.
  const isCode = req.mode === "navigate" || /\.(html|js|css|webmanifest)$/i.test(url.pathname) || url.pathname.endsWith("/");
  if (isCode) {
    event.respondWith(
      fetch(req, { cache: "no-cache" })
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req.mode === "navigate" ? "./index.html" : req, copy));
          }
          return res;
        })
        .catch(async () =>
          (await caches.match(req, { ignoreSearch: true })) ||
          (req.mode === "navigate" ? caches.match("./index.html") : Response.error())
        )
    );
    return;
  }

  // Bilder/Logos: cache-first
  event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});
