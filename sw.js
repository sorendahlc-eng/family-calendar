// Service Worker for Family Calendar
// Caches app shell (HTML/JS/CSS/fonts) so it loads offline after first visit.
// Google API calls are always network-first (live data only).

const CACHE_NAME = 'family-calendar-v2';

const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  'https://fonts.googleapis.com/icon?family=Material+Icons',
  'https://fonts.googleapis.com/css2?family=Roboto:wght@200;300;400;500;700&display=swap',
];

// Origins whose responses we never cache (always hit the network)
const NETWORK_ONLY_ORIGINS = [
  'accounts.google.com',
  'www.googleapis.com',
  'oauth2.googleapis.com',
];

// ── Install: cache the app shell ─────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// ── Activate: delete old caches ───────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: network-first for APIs, cache-first for app shell ──────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always go to the network for Google API / auth calls
  if (NETWORK_ONLY_ORIGINS.includes(url.hostname)) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Cache-first for everything else (app shell, fonts)
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Only cache successful same-origin or CORS responses
        if (response && response.status === 200 &&
            (response.type === 'basic' || response.type === 'cors')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
