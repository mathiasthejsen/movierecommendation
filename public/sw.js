/* Service worker for the static GitHub Pages build.
 * Scope and cache paths derive from the registration scope, so it works under any base path
 * (e.g. https://<user>.github.io/movie-recommender/).
 */
const VERSION = "v6";
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

async function networkFirst(request, cacheName, fallbackToShell = true) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallbackToShell) return (await caches.match(BASE)) || Response.error();
    return new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "Content-Type": "application/json" } });
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
    .catch(() => cached || new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "Content-Type": "application/json" } }));
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
    // Freshness checks (meta.json?check=…) go straight to the network and aren't cached.
    if (url.search) return;
    // Network-first so meta, catalog and neighbour shards always come from the same daily build;
    // the cache is only used offline.
    event.respondWith(networkFirst(request, DATA, false));
  } else {
    event.respondWith(staleWhileRevalidate(request, SHELL));
  }
});

/* "It's a match" Web Push (sent by the notify-match Edge Function, encrypted per RFC 8291). */
function matchUrl(key) {
  return key ? `${BASE}watchlist/?tab=together&highlight=${encodeURIComponent(key)}` : `${BASE}watchlist/?tab=together`;
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "It's a match 🎉";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "Someone in your family wants to watch the same thing.",
      icon: `${BASE}icons/icon-192.png`,
      badge: `${BASE}icons/icon-192.png`,
      tag: data.tag || "match",
      renotify: true,
      data: { url: matchUrl(data.key) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || matchUrl(null), SCOPE).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((w) => new URL(w.url).pathname.startsWith(BASE));
      if (existing) {
        await existing.focus();
        if ("navigate" in existing) return existing.navigate(target);
        return undefined;
      }
      return self.clients.openWindow(target);
    })(),
  );
});