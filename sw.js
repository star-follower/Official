const CACHE_NAME = "star-follower-20260818-official-base-path";
const BASE_PATH = new URL("./", self.location.href).pathname;
const STATIC_ASSETS = [
  BASE_PATH,
  BASE_PATH + "star-icon.jpg",
  BASE_PATH + "manifest.json",
  BASE_PATH + "supabase-api.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(
        STATIC_ASSETS.map((asset) =>
          cache.add(asset).catch(() => null)
        )
      ))
      .catch(() => null)
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).catch(() => null)
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  try {
    // Never intercept cross-origin, API, Supabase, or CDN calls.
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith(BASE_PATH + "api/")
    ) return;
    if (url.hostname.includes("supabase") || url.hostname.includes("jsdelivr")) return;
    if (event.request.method !== "GET") return;

    event.respondWith(
      caches.match(event.request)
        .then((cached) => cached || fetch(event.request))
        .catch(() =>
          caches.match(BASE_PATH)
            .then((fallback) => fallback || new Response("", {
              status: 503,
              statusText: "Offline"
            }))
            .catch(() => new Response("", { status: 503, statusText: "Offline" }))
        )
    );
  } catch (e) {
    // A malformed request must not create an unhandled fetch rejection.
  }
});

self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
});
