// Bump VERSION on any deploy-impacting change to refresh caches
const VERSION = 'gradiolite-sw-v2';
const PRECACHE = VERSION + '-precache';
const RUNTIME = VERSION + '-runtime';

// Compute scope-aware bases so this works on GitHub Pages project sites
// e.g., scope "/<repo>/assets/" → assetsBase "/<repo>/assets", projectBase "/<repo>"
const scopePath = new URL(self.registration.scope).pathname; // always ends with '/'
const assetsBase = scopePath.replace(/\/$/, '');
const projectBase = assetsBase.replace(/\/assets$/, '');

// Minimal pre-cache; runtime caching grabs CDN assets on first use
// Only precache URLs within this SW's scope (assets/*)
const PRECACHE_URLS = [
  `${assetsBase}/style.css`,
  `${assetsBase}/app.js`,
  `${assetsBase}/py-runner.js`,
  `${assetsBase}/config.json`,
  // Useful for JupyterLite REPL boot
  `${assetsBase}/_output/repl/index.html`
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(PRECACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  const currentCaches = [PRECACHE, RUNTIME];
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => {
        if (!currentCaches.includes(k)) return caches.delete(k);
      })))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;

  // For same-origin requests within this SW's scope (assets/*), use network-first
  if (url.origin === location.origin && url.pathname.startsWith(scopePath)) {
    event.respondWith(networkFirst(request));
    return;
  }

  // For other same-origin requests outside scope, we cannot intercept; fall through.

  // For cross-origin (CDNs), cache on first fetch (opaque allowed)
  event.respondWith(cacheFirstThenFetch(request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    const copy = response.clone();
    caches.open(RUNTIME).then((cache) => cache.put(request, copy));
    return response;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw e;
  }
}

function cacheFirstThenFetch(request) {
  return caches.match(request).then((cached) => {
    if (cached) return cached;
    return fetch(request, { mode: request.mode, credentials: request.credentials })
      .then((response) => {
        const copy = response.clone();
        caches.open(RUNTIME).then((cache) => cache.put(request, copy));
        return response;
      });
  });
}
