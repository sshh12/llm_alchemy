// Kill switch for the 2023 version of Infinite Alchemy.
//
// The old app registered a Workbox service worker at this exact URL that precached the
// old index.html and served it for every navigation. Browsers re-check this script on
// navigation, find this version, install it immediately, wipe the old caches, unregister,
// and reload any open tabs so returning players land on the new game (where their
// progress is restored from localStorage). The new app does not use a service worker.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      } catch (e) {
        // ignore
      }
      try {
        await self.registration.unregister();
      } catch (e) {
        // ignore
      }
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        try {
          client.navigate(client.url);
        } catch (e) {
          // ignore
        }
      }
    })(),
  );
});
