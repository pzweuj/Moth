/* global self, caches, URL, fetch, Response */

const VERSION = "__MOTH_BUILD_VERSION__";
const SHELL = `moth-shell-${VERSION}`;
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
    // own versioned shell caches so a co-hosted application is never wiped.
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("moth-shell-") && key !== SHELL).map((key) => caches.delete(key)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  const url = new URL(request.url);
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return;
  const navigation = request.mode === "navigate" || request.headers.get("accept")?.includes("text/html");
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)).catch(() => {
    if (navigation) return caches.match("/index.html");
    return new Response("需要连接服务器", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
