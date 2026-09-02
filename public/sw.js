/* Aemerg service worker.

   Caches the shell so the app opens instantly and still opens with no
   connection. It never caches /api/: presence and delivery must always be
   live, and a cached answer there would be a lie. */

'use strict';

var VERSION = 'aemerg-v6';

var SHELL = [
  '/',
  '/index.html',
  '/theme.css',
  '/collage.js',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-64.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION)
      .then(function (c) { return c.addAll(SHELL); })
      .catch(function () { /* a missing file must not block the install */ })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k === VERSION ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (e) {
  if (e.data && e.data.t === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  if (url.origin !== self.location.origin) return;   /* fonts and CDNs: leave alone */
  if (url.pathname.indexOf('/api/') === 0) return;    /* always live */

  /* navigations: try the network so a deploy lands, fall back to the shell */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(function (res) {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put('/index.html', copy); });
          return res;
        })
        .catch(function () {
          return caches.match('/index.html').then(function (hit) {
            return hit || caches.match('/');
          });
        })
    );
    return;
  }

  /* static assets: cache first, refresh in the background */
  e.respondWith(
    caches.match(req).then(function (hit) {
      var live = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || live;
    })
  );
});

/* ---------------------------------------------------------------- push ---

   These two handlers are the only part of Aemerg that runs when the app is
   closed. The browser wakes the worker, hands it the payload, and it must
   show a notification: on most platforms a push that shows nothing is
   counted against the origin and can cost the permission. */

var KIND_SAYS = {
  missyou:  'misses you',
  hug:      'sent you a hug',
  thinking: 'is thinking of you',
  laugh:    'is laughing with you',
  proud:    'is proud of you',
  night:    'says good night',
  text:     'wrote to you',
  request:  'wants to connect with you'
};

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }

  var who = d.fromName || 'A friend';
  var says = KIND_SAYS[d.kind] || 'is thinking of you';
  var title = who + ' ' + says;
  var body = d.text || 'Open Aemerg to send one back.';

  e.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      /* a tag per note, so two notes stack rather than one replacing the other */
      tag: 'aemerg-' + (d.id || Date.now()),
      renotify: true,
      timestamp: d.at || Date.now(),
      vibrate: [80, 60, 80],
      data: { url: '/', id: d.id || '' }
    }).catch(function () {
      /* showing something is not optional: a push that displays nothing is
         counted against the origin and can cost the permission */
      return self.registration.showNotification('Aemerg', {
        body: 'Someone is thinking of you.',
        icon: '/icons/icon-192.png'
      });
    })
  );
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/';

  /* focus a tab that is already open rather than stacking new ones */
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (new URL(c.url).origin === self.location.origin) {
          return c.focus().then(function (f) {
            if (f && f.postMessage) f.postMessage({ t: 'opened-from-push' });
            return f;
          });
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

/* A subscription can be rotated by the browser. When that happens the old
   endpoint stops working, so re-subscribe and tell the server the new one. */
self.addEventListener('pushsubscriptionchange', function (e) {
  e.waitUntil(
    self.registration.pushManager.getSubscription()
      .then(function (existing) {
        if (existing) return existing;
        var key = e.oldSubscription && e.oldSubscription.options
          ? e.oldSubscription.options.applicationServerKey : null;
        if (!key) return null;
        return self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key
        });
      })
      .then(function (sub) {
        if (!sub) return;
        return self.clients.matchAll({ includeUncontrolled: true }).then(function (list) {
          list.forEach(function (c) { c.postMessage({ t: 'resubscribe' }); });
        });
      })
      .catch(function () {})
  );
});
