// Leaderboard Service Worker
// Handles Web Push notifications and offline caching

const CACHE_NAME = 'leaderboard-v1';

// ── Push event ───────────────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;

  let data;
  try { data = event.data.json(); }
  catch { data = { title: 'Leaderboard', body: event.data.text() }; }

  const title   = data.title ?? 'Leaderboard';
  const options = {
    body:    data.body  ?? 'You have a new notification.',
    icon:    data.icon  ?? '/icons/icon-192.png',
    badge:   data.badge ?? '/icons/icon-192.png',
    tag:     data.tag   ?? 'leaderboard',
    data:    data.data  ?? {},
    vibrate: [200, 100, 200],
    actions: data.actions ?? [],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click ───────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const url = event.notification.data?.url ?? '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Focus existing window if open
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          if (client.postMessage) client.postMessage({ type: 'NOTIFICATION_CLICK', url });
          return;
        }
      }
      // Otherwise open a new window
      return clients.openWindow(url);
    })
  );
});

// ── Activate ─────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(clients.claim());
});

// ── Install ──────────────────────────────────────────────────────
self.addEventListener('install', () => {
  self.skipWaiting();
});
