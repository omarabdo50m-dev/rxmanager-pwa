// ═══════════════════════════════════════════════════════════════
// RxManager Pro — Service Worker
// Phase 11 (app shell cache) + Phase 12 (smart fetch strategies)
//
// CACHE NAMES
//   rxmanager-shell-v1  → your HTML file + manifest + icons
//   rxmanager-cdn-v1    → Google Fonts, Phosphor Icons (CDN assets)
//
// FETCH STRATEGIES (by request type)
//   Supabase API calls  → Network ONLY, never cached (live data)
//   CDN assets          → Stale-While-Revalidate (serve instantly, update in background)
//   App shell (HTML)    → Cache-First, then network (offline-safe)
//
// TO UPDATE THE CACHE: bump SHELL_VERSION below (e.g. 'v2').
// The activate handler will delete the old cache automatically.
// ═══════════════════════════════════════════════════════════════

const SHELL_VERSION = 'v5';
const CACHE_NAME = 'rxmanager-shell-v5';
const PRECACHE_URLS = [
  '/rxmanager-pwa/',
  '/rxmanager-pwa/index.html',
  '/rxmanager-pwa/manifest.json',
];
const CDN_CACHE     = 'rxmanager-cdn-v1';

// Files that make up the app shell — cached on first install.
// These are the only files that need to load for the app to start.
// Supabase data is intentionally NOT here — it's always live.
const SHELL_URLS = [
  '/rxmanager-pwa/',
  '/rxmanager-pwa/index.html',
  '/rxmanager-pwa/manifest.json',
  '/rxmanager-pwa/icons/icon-192.png',
  '/rxmanager-pwa/icons/icon-512.png',
];

// CDN hostnames to apply stale-while-revalidate to
const CDN_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'unpkg.com',
];

// ── INSTALL ─────────────────────────────────────────────────────
// Cache the app shell. skipWaiting() activates the new SW
// immediately without waiting for existing tabs to close.
self.addEventListener('install', event => {
  console.log('[SW] Installing…');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Caching app shell');
        // Use fetch with cache:'no-store' so the install always gets the
        // live file, not a stale HTTP-cached copy. cache.add() would use
        // the HTTP cache and could store an outdated index.html.
        return Promise.allSettled(
          SHELL_URLS.map(url =>
            fetch(url, { cache: 'no-store' })
              .then(res => {
                if (res.ok) return cache.put(url, res);
              })
              .catch(err =>
                console.warn('[SW] Could not cache', url, err)
              )
          )
        );
      })
      .then(() => {
        console.log('[SW] Shell cached — skipping waiting');
        return self.skipWaiting();
      })
  );
});

// ── ACTIVATE ────────────────────────────────────────────────────
// Delete any old shell caches (previous SHELL_VERSION).
// CDN cache is kept across versions — fonts don't change.
self.addEventListener('activate', event => {
  console.log('[SW] Activating…');
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k.startsWith('rxmanager-shell-') && k !== CACHE_NAME)
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      ))
      .then(() => {
        console.log('[SW] Active — claiming clients');
        return self.clients.claim();
      })
  );
});

// ── FETCH ────────────────────────────────────────────────────────
// Three distinct strategies based on request origin:
//   1. Supabase → pass-through (never intercept)
//   2. CDN      → stale-while-revalidate
//   3. Own files → cache-first with network fallback
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // ── 1. SUPABASE — always network, never cache ─────────────────
  // Conditions, drugs, prescriptions must always be live.
  // RLS + version checking means stale data is dangerous here.
  if (url.hostname.includes('supabase.co')) {
    return; // Let the browser handle it normally
  }

  // ── 2. CDN ASSETS — stale-while-revalidate ────────────────────
  // Serve cached fonts/icons instantly, update in background.
  // This means fonts load on the first visit AND work offline after.
  if (CDN_HOSTS.some(h => url.hostname.includes(h))) {
    event.respondWith(
      caches.open(CDN_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          // Always try to fetch a fresh copy in the background
          const networkFetch = fetch(event.request)
            .then(response => {
              if (response.ok) {
                cache.put(event.request, response.clone());
              }
              return response;
            })
            .catch(() => {
              // Network failed — cached version still usable
              console.warn('[SW] CDN fetch failed, serving cache for', url.pathname);
            });

          // Return cached immediately if available, otherwise wait for network
          return cached || networkFetch;
        })
      )
    );
    return;
  }

  // ── 3. APP SHELL — split strategy ────────────────────────────
  //
  // HTML navigate requests → NETWORK-FIRST with cache fallback.
  //   The browser always tries to fetch a fresh index.html when online.
  //   This ensures the latest JS (including checkContentVersion fixes)
  //   is always loaded on mobile PWA where a hard-refresh is impossible.
  //   On failure (offline) → falls back to the cached shell.
  //
  // Sub-resources (images, icons, manifest) → CACHE-FIRST as before.
  //   These never change between app versions and don't need freshness.

  if (event.request.mode === 'navigate') {
    // HTML navigate: network-first, bypassing the HTTP cache entirely.
    // Without cache:'no-store', fetch() inside a SW can still return a
    // browser HTTP-cached copy — defeating the whole point.
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then(response => {
          // Store fresh copy in SW cache for offline fallback
          if (response.ok && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // Offline — serve SW-cached shell
          return caches.match(event.request)
            .then(cached => cached || caches.match('/rxmanager-pwa/index.html'));
        })
    );
    return;
  }

  // Sub-resources — cache-first, network fallback (unchanged)
  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) return cached;
        return fetch(event.request)
          .then(response => {
            if (
              response.ok &&
              response.type === 'basic' &&
              event.request.method === 'GET'
            ) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
            }
            return response;
          })
          .catch(() => {
            // Sub-resource failed offline — fail silently
          });
      })
  );
});

// ── MESSAGE HANDLER ──────────────────────────────────────────────
// Allows the app to send commands to the SW.
// Currently supports 'SKIP_WAITING' to force immediate activation.
// Call from app: navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' })
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('[SW] SKIP_WAITING received — activating now');
    self.skipWaiting();
  }
});
