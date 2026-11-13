// Offline cache for the Production Report Calculator (scope: /calc/).
// v10: /calc/ is now the one-screen-at-a-time calculator (it was at /calc/try/, which now redirects here).
var CACHE = "draw-calc-v11";
var FILES = ["./", "./index.html", "/data/config.js", "/data/submit.js", "/data/fields.js", "/data/scan.js"];   // the tracker registers this too, so it works offline even if never opened
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  // drops the old calculator's caches and the old /calc/try/ caches
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf("draw-calc-") === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
// Network first (and past the browser's HTTP cache) so updates show up right away; fall back to the saved copy with no signal.
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then(function (r) {
    if (r && r.ok) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); }
    return r;
  }).catch(function () {
    return caches.match(e.request, { ignoreSearch: true }).then(function (m) { return m || caches.match("./index.html"); });
  }));
});
