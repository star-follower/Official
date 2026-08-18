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
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Never intercept API calls — let supabase-api.js handle them in the main thread
  const url = new URL(event.request.url);
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith(BASE_PATH + "api/")
  ) return;
  // Never intercept Supabase or CDN calls
  if (url.hostname.includes("supabase") || url.hostname.includes("jsdelivr")) return;
  // Only cache GET requests
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
