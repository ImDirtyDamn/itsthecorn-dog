/* One-time migration from /app/ to /draw/app/. Never touches localStorage. */
self.addEventListener("install", function (event) {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) {
        return key.indexOf("draw-rate-app-") === 0;
      }).map(function (key) { return caches.delete(key); }));
    }).then(function () {
      return self.registration.unregister();
    }).then(function () {
      return self.clients.claim();
    }).then(function () {
      return self.clients.matchAll({ type: "window", includeUncontrolled: true });
    }).then(function (clients) {
      return Promise.all(clients.map(function (client) {
        return client.navigate("https://itsthecorn.dog/draw/app/");
      }));
    })
  );
});
self.addEventListener("fetch", function (event) {
  if (event.request.mode === "navigate") {
    event.respondWith(Response.redirect("/draw/app/", 302));
  }
});
