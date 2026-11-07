// Stand-in for the Workbox service worker that Create React App 5 generated for the 2023 app:
// precache the app shell + bundle, claim clients, answer navigations with the cached
// index.html (app-shell route) and other precached URLs cache-first. Like CRA it does not
// skipWaiting on its own (only on a SKIP_WAITING message).
const PRECACHE = "workbox-precache-v2-" + self.registration.scope;
const PRECACHE_URLS = ["/", "/index.html", "/static/js/main.legacy.js", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(PRECACHE).then((cache) => cache.addAll(PRECACHE_URLS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.mode === "navigate") {
    event.respondWith(caches.match("/index.html", { cacheName: PRECACHE }).then((hit) => hit || fetch(request)));
    return;
  }
  const url = new URL(request.url);
  if (url.origin === self.location.origin && PRECACHE_URLS.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname, { cacheName: PRECACHE }).then((hit) => hit || fetch(request)));
  }
});
