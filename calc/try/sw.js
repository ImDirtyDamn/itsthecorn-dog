// The calculator moved to /calc/. This worker replaces the old /calc/try/ offline copy:
// it deletes that cache, removes itself, and reloads open tabs so they land on the redirect to /calc/.
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf("draw-calc-try-") === 0; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.registration.unregister(); }).then(function () {
    return self.clients.matchAll({ type: "window" });
  }).then(function (cs) { cs.forEach(function (c) { try { c.navigate(c.url); } catch (x) {} }); }));
});
