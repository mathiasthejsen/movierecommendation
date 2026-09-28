/* Service worker for the static GitHub Pages build.
 * Scope and cache paths derive from the registration scope, so it works under any base path
 * (e.g. https://<user>.github.io/movie-recommender/).
 */
const VERSION = "v2";
const SCOPE = new URL(self.registration.scope);
const BASE = SCOPE.pathname; // ends with "/"
const SHELL = `shell-${VERSION}`;
const STATIC = `static-${VERSION}`;
const DATA = `data-${VERSION}`;
const IMAGES = `images-${VERSION}`;
const MAX_IMAGES = 300;

const PRECACHE = [BASE, `${BASE}manifest.webmanifest`, `${BASE}icons/icon-192.png`, `${BASE}data/meta.json`, `${BASE}data/catalog.json`];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(PRECACHE).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  const keep = new Set([SHELL, STATIC, DATA, IMAGES]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return (await cache.match(request)) || (await caches.match(BASE)) || Response.error();
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok || res.type === "opaque") {
    const cache = await caches.open(cacheName);
    cache.put(request, res.clone());
    if (cacheName === IMAGES) trim(IMAGES, MAX_IMAGES);
  }
  return res;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.hostname === "image.tmdb.org") {
    event.respondWith(cacheFirst(request, IMAGES));
    return;
  }
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(BASE)) return; // Supabase, TMDB proxy, etc.

  if (request.mode === "navigate") {
    // The share target carries the shared text in the query string: never cache it.
    if (url.pathname.startsWith(`${BASE}share`)) return;
    event.respondWith(networkFirst(request, SHELL));
  } else if (url.pathname.startsWith(`${BASE}_next/static/`)) {
    event.respondWith(cacheFirst(request, STATIC));
  } else if (url.pathname.startsWith(`${BASE}data/`)) {
    event.respondWith(staleWhileRevalidate(request, DATA));
  } else {
    event.respondWith(staleWhileRevalidate(request, SHELL));
  }
});
