/* Aemerg service worker.

   Caches the shell so the app opens instantly and still opens with no
   connection. It never caches /api/ or the WebSocket: presence and delivery
   must always be live, and a cached answer there would be a lie. */

'use strict';

var VERSION = 'aemerg-v1';

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
  if (url.pathname === '/ws') return;

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
