/* Operator app service worker.
   Privacy rule: dashboard pages and API responses are NEVER cached — they hold
   private conversations. Only static assets and an offline page are cached. */
'use strict';

const VERSION = 'sp-static-v2';
const PRECACHE = [
  '/offline.html',
  '/assets/app.css',
  '/assets/app.js',
  '/assets/inbox.js',
  '/assets/live.js',
  '/assets/icons/icon-192.png',
  '/assets/icons/badge-96.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') { return; }
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) { return; }

  // Pages: always from the network; offline page only when the network fails.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  // Static assets: serve cached copy, refresh it in the background.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.open(VERSION).then((cache) => cache.match(req).then((hit) => {
      const update = fetch(req).then((res) => { if (res.ok) { cache.put(req, res.clone()); } return res; });
      return hit || update;
    })));
  }
  // Everything else (API, widget API, manifest) goes straight to the network.
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = typeof data.title === 'string' ? data.title.slice(0, 120) : 'New message';
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === 'string' ? data.body.slice(0, 200) : '',
    icon: '/assets/icons/icon-192.png',
    badge: '/assets/icons/badge-96.png',
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    renotify: true,
    data: { url: typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//') ? data.url : '/' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data && event.notification.data.url || '/', self.location.origin);
  if (target.origin !== self.location.origin) { return; }
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
        return w.navigate(target.href).then((c) => (c || w).focus());
      }
    }
    return self.clients.openWindow(target.href);
  }));
});
