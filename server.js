/* Aemerg, run as an ordinary Node process.

   This exists so the app can be developed and run locally, and so it can be
   deployed to a host that runs a container rather than functions. It is a thin
   wrapper: every request is handed to the same handler Vercel calls, so there
   is one implementation and no chance of the two drifting apart. */

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');

const api = require('./lib/handler');
const push = require('./lib/push');
const store = require('./lib/store');

const PORT = process.env.PORT || 8787;
const PUBLIC = path.join(__dirname, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/* Gives the Vercel handler the small surface it expects from a response. */
function adapt(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    const body = JSON.stringify(obj);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
    return res;
  };
  return res;
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.statusCode = 403; res.end('no'); return; }

  fs.readFile(file, (err, data) => {
    if (err) {
      /* a deep link should still land on the app */
      if (!path.extname(file)) {
        fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => {
          if (e2) { res.statusCode = 404; res.end('not found'); return; }
          res.setHeader('Content-Type', TYPES['.html']);
          res.end(html);
        });
        return;
      }
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    if (path.basename(file) === 'sw.js') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/healthz' || url.pathname.startsWith('/api/')) {
    req.query = Object.fromEntries(url.searchParams.entries());
    if (url.pathname === '/healthz') req.url = '/api/healthz';
    Promise.resolve(api(req, adapt(res))).catch((err) => {
      console.error(err);
      if (!res.headersSent) adapt(res).status(500).json({ error: 'Something went wrong.' });
    });
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('Aemerg is running on port ' + PORT);
  console.log('  store: ' + store.where);
  console.log('  push:  ' + (push.enabled ? 'on' : 'off, run npm run keys'));
  if (!store.hosted) {
    console.log('');
    console.log('  Running on a local file. A deployment sets');
    console.log('  UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN instead.');
  }
});
