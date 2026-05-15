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

const SHELL_VERSION = 'v2';
const CACHE_NAME = 'rxmanager-v1';
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
  '/',
  '/index.html',
  '/manifest.json',
  // Icons (pre-cache the most critical sizes)
  '/icons/icon-192.png',
  '/icons/icon-512.png',
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
        // addAll fails if any single URL fails — use individual adds
        // with catch so a missing icon doesn't abort the install
        return Promise.allSettled(
          SHELL_URLS.map(url =>
            cache.add(url).catch(err =>
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

  // ── 3. APP SHELL — cache-first, network fallback ──────────────
  // Serves the HTML file instantly from cache on every load.
  // If not cached yet (first visit), fetches from network and caches.
  // If both fail (offline, never visited) — returns a minimal offline page.
  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) {
          return cached;
        }

        // Not in cache — fetch from network and cache for next time
        return fetch(event.request)
          .then(response => {
            // Only cache successful, non-opaque responses from our own origin
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
            // Network failed and no cache — navigate requests get the app shell
            if (event.request.mode === 'navigate') {
              return caches.match('/index.html');
            }
            // For sub-resources (images, etc.) — just fail silently
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
