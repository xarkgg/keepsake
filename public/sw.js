/* Keepsake's offline shell. Account data is never precached. */
// The cache name is stamped at build time (see vite.config.ts). The literal is
// only a development fallback; it never ships because the version is replaced
// in dist/sw.js on every build, so a stale cache is retired automatically
// instead of waiting for someone to remember to bump it by hand.
const VERSION = "__KEEPSAKE_SW_VERSION__";
const SHELL = `keepsake-shell-${VERSION}`;
const RUNTIME = "keepsake-runtime-v1";
let accountGeneration = 0;
const SHELL_FILES = [
  "/",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL && key !== RUNTIME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, cacheName) {
  const generation = accountGeneration;
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (cacheName === RUNTIME && response.status === 401) {
      accountGeneration += 1;
      await caches.delete(RUNTIME);
    } else if (response.ok && generation === accountGeneration) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(SHELL);
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method !== "GET") {
    if (["/api/auth/login", "/api/auth/register", "/api/auth/logout", "/api/account"].includes(url.pathname)) {
      accountGeneration += 1;
      event.respondWith(caches.delete(RUNTIME).then(() => fetch(request)));
    }
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    // The account shell is the only server JSON worth caching; the Vault store
    // lives in IndexedDB and never touches the network at all.
    if (url.pathname === "/api/bootstrap") {
      event.respondWith(networkFirst(request, RUNTIME));
    }
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL).catch(() => caches.match("/")));
    return;
  }

  if (
    url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/favicon.ico" ||
    url.pathname === "/manifest.webmanifest"
  ) {
    event.respondWith(cacheFirst(request));
  }
});
