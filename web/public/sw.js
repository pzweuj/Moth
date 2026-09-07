/* global self, caches, URL, fetch */

const VERSION = "__MOTH_BUILD_VERSION__";
const SHELL = `moth-shell-${VERSION}`;
const RUNTIME = `moth-runtime-${VERSION}`;
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.svg",
  /* __MOTH_PRECACHE_ASSETS__ */
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    // Cache Storage is shared by every app on an origin. Remove only Moth's
    // own versioned caches so a co-hosted application is never wiped during
    // an update.
    caches.keys().then((keys) => Promise.all(keys.filter((key) => (key.startsWith("moth-shell-") || key.startsWith("moth-runtime-")) && ![SHELL, RUNTIME].includes(key)).map((key) => caches.delete(key)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (!response.ok || response.type === "opaque") return response;
        const copy = response.clone();
        void caches.open(RUNTIME).then((cache) => cache.put(request, copy));
        return response;
      }).catch(() => caches.match("/index.html"));
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
