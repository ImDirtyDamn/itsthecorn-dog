/* Draw Rate Tracker phone app - service worker.
   Cache-first, versioned. The version is a hash of the app files, so any change
   to them makes a new cache and the old one is deleted on activate. */
var CACHE = "draw-rate-app-14ff802613";
var ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "/data/config.js",                 // master-log sender (shared with the full page and the calculator)
  "/data/submit.js"
];
var SHARED = ["/data/config.js", "/data/submit.js"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(ASSETS.map(function (u) { return new Request(u, { cache: "reload" }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf("draw-rate-app-") === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // the master-log sender lives outside the app folder: network first (stays current), saved copy with no signal
  if (SHARED.indexOf(url.pathname) >= 0) {
    e.respondWith(fetch(req).then(function (res) {
      if (res && res.ok && res.type === "basic") { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(url.pathname, copy); }); }
      return res;
    }).catch(function () { return caches.match(url.pathname, { ignoreSearch: true }); }));
    return;
  }
  var scope = new URL("./", self.location).pathname;
  if (url.pathname.indexOf(scope) !== 0 && req.mode !== "navigate") return;
  // pages below the app (the /app/scan/ tryout): network first, saved copy with no signal
  if (url.pathname.indexOf(scope) === 0 && url.pathname !== scope && url.pathname !== scope + "index.html" && /\/$|\.html$/.test(url.pathname)) {
    e.respondWith(fetch(req).then(function (res) {
      if (res && res.ok && res.type === "basic") { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () { return caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || caches.match("./index.html"); }); }));
    return;
  }
  e.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        if (req.mode === "navigate") {
          return cache.match("./index.html").then(function (shell) {
            return shell || fetch(req);
          });
        }
        return fetch(req).then(function (res) {
          if (res && res.ok && res.type === "basic") cache.put(req, res.clone());
          return res;
        });
      });
    })
  );
});
