// Leaderboard Service Worker  (build 20261020av)
// Handles offline app-shell caching and Web Push notifications.
//
// CACHE STRATEGY
// ──────────────
// Precache: all essential app-shell assets are fetched and stored
// atomically during install. If any asset is unavailable the install
// fails and the previous working SW remains in control.
//
// Runtime cache: same-origin GET requests for known JS/CSS/image paths
// are served cache-first after the SW activates. Unknown paths, API
// routes, Cloudflare Worker requests and external origins pass straight
// through to the network and are never cached.
//
// SAFE UPDATE PROCESS
// ───────────────────
// skipWaiting() is intentionally NOT called. When a new SW is installed
// it waits in the 'waiting' state until all tabs running the old SW are
// closed. This prevents a new SW from claiming a tab mid-round and
// creating a mixed-version application. The user gets the update on
// their next fresh page load.
//
// The old SW's cache remains intact and usable until the new SW
// activates and deletes it as part of its own activate event. There is
// always exactly one complete, consistent cache in place.
//
// CLOUDFLARE WORKER
// ─────────────────
// All requests to leaderboardsync.sw-77d.workers.dev pass through
// without caching. Game-sharing and live-leaderboard data must always
// be fresh. Offline scoring works without Cloudflare; sharing requires
// internet access by design.

// ── Version — bump this string on every deployment ───────────────────
// Must match the build tag used in app.js, index.html and the ?v= tags.
const CACHE_NAME = 'leaderboard-v20261020av';

// ── App shell — every URL that must be available offline ─────────────
// All versioned ?v= query strings must exactly match index.html and
// the import() calls in app.js. If a URL here differs from what the
// page requests, the SW cache will be a miss and the browser fetches
// from the network (degraded offline, not broken).
const PRECACHE_URLS = [
  '/',                                  // navigation fallback
  '/index.html',                        // explicit fallback alias
  '/styles.css?v=20261015c',
  '/jsQR.min.js?v=1.4.0',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  // JS modules — versioned to guarantee consistency across files
  '/js/app.js?v=20261020av',
  '/js/qr.js',
  '/game.js?v=20260704l',
  '/db.js?v=20261020av',
  '/provider.js?v=20261020av',
  '/local.js?v=20261020av',
];

// ── Paths that must NEVER be cached ──────────────────────────────────
// Cloudflare Worker origin (game sharing, live leaderboard, scores).
const CLOUDFLARE_ORIGIN = 'https://leaderboardsync.sw-77d.workers.dev';

// Same-origin path prefixes that bypass the cache entirely.
const PASSTHROUGH_PREFIXES = [
  '/api/',      // Vercel serverless functions (push, guest, invite)
  '/live',      // live.html — depends on Cloudflare, useless offline
  '/view',      // view.html — Supabase-dependent, useless offline
  '/onboard',   // onboard.html — Supabase-dependent, useless offline
];

// ── Install — precache app shell atomically ───────────────────────────
// cache.addAll() is all-or-nothing: if any URL fails, the install
// fails and the previous working SW remains in control.
// skipWaiting() is deliberately absent — see safety notes above.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .catch(err => {
        console.error('[SW] Precache failed — install aborted, old SW remains active:', err);
        throw err; // re-throw so the install is marked failed
      })
  );
});

// ── Activate — delete stale caches, then claim new tabs only ─────────
// clients.claim() is called here (not in install) so existing tabs
// running an older version are NOT claimed mid-session. Only fresh
// tabs opened after this SW activates will be controlled by it.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      ))
      .then(() => clients.claim())
  );
});

// ── Fetch — cache-first for app shell, passthrough for everything else ─
self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle GET requests.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache external origins (Cloudflare, Google Fonts, CDNs).
  if (url.origin !== self.location.origin) return;

  // Never cache known passthrough paths.
  if (PASSTHROUGH_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) return;

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) {
        // Serve from cache immediately.
        return cached;
      }

      // Not in cache — fetch from network.
      return fetch(request).then(response => {
        // Only cache successful responses for known app-shell paths.
        // This prevents indiscriminate runtime caching of arbitrary routes.
        if (response.ok && isKnownAppAsset(url.pathname)) {
          caches.open(CACHE_NAME)
            .then(cache => cache.put(request, response.clone()))
            .catch(() => { /* best-effort — ignore cache write failures */ });
        }
        return response;
      }).catch(() => {
        // Network failed. For navigation requests return the cached app shell
        // so the user sees the app rather than a browser error page.
        if (request.mode === 'navigate') {
          return caches.match('/') || caches.match('/index.html');
        }
        // For non-navigation requests (JS modules etc.) let the error propagate.
        // The browser will report the failure; the app handles it.
      });
    })
  );
});

// ── isKnownAppAsset — allowlist for runtime cache writes ─────────────
// Returns true only for paths that belong to the app shell.
// Anything not recognised is NOT written to the runtime cache.
function isKnownAppAsset(pathname) {
  return (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname.startsWith('/js/') ||
    pathname.startsWith('/styles') ||
    pathname.startsWith('/game.js') ||
    pathname.startsWith('/db.js') ||
    pathname.startsWith('/provider.js') ||
    pathname.startsWith('/local.js') ||
    pathname.startsWith('/jsQR') ||
    pathname.startsWith('/manifest') ||
    pathname.endsWith('.png') ||
    pathname.endsWith('.svg')
  );
}

// ── Push event ───────────────────────────────────────────────────────
// Unchanged from previous implementation.
self.addEventListener('push', event => {
  if (!event.data) return;

  let data;
  try { data = event.data.json(); }
  catch { data = { title: 'Leaderboard', body: event.data.text() }; }

  const title   = data.title ?? 'Leaderboard';
  const options = {
    body:    data.body  ?? 'You have a new notification.',
    icon:    data.icon  ?? '/icon-192.png',
    badge:   data.badge ?? '/icon-192.png',
    tag:     data.tag   ?? 'leaderboard',
    data:    data.data  ?? {},
    vibrate: [200, 100, 200],
    actions: data.actions ?? [],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click ───────────────────────────────────────────────
// Unchanged from previous implementation.
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const url = event.notification.data?.url ?? '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          if (client.postMessage) client.postMessage({ type: 'NOTIFICATION_CLICK', url });
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});
