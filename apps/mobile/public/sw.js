/* AllWebMails service worker.
 * - Caches only the app itself (code, icons) so it opens quickly and offline. Mail and API responses are
 *   NEVER cached here: nothing private is left in the browser's storage.
 * - Shows push notifications ("New email received at …": mailbox address only, never sender or subject).
 */
const VERSION = 'awm-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/badge-96.png'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/readyz') || url.pathname.startsWith('/healthz')) return; // never cache data
  if (req.mode === 'navigate') {
    // App pages: always try the network first so updates arrive; fall back to the cached app when offline.
    ev.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put('/', copy)); }
      return res;
    }).catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/_expo/') || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    // Fingerprinted build files: cache first.
    ev.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
});

self.addEventListener('push', (ev) => {
  let p = {};
  try { p = ev.data ? ev.data.json() : {}; } catch (e) { p = {}; }
  const title = typeof p.title === 'string' ? p.title.slice(0, 200) : 'AllWebMails';
  ev.waitUntil(self.registration.showNotification(title, {
    body: typeof p.body === 'string' ? p.body.slice(0, 300) : undefined,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: typeof p.tag === 'string' ? p.tag : undefined,
    data: p.data && typeof p.data === 'object' ? p.data : {},
  }));
});

self.addEventListener('notificationclick', (ev) => {
  ev.notification.close();
  const data = ev.notification.data || {};
  ev.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const client = list.find((c) => new URL(c.url).origin === self.location.origin);
    if (client) {
      client.postMessage({ awmNotification: data });
      return client.focus();
    }
    const path = data.messageId ? `/message/${encodeURIComponent(data.messageId)}` : data.type === 'send_problem' ? '/outbox' : '/inbox';
    return self.clients.openWindow(path);
  }));
});
