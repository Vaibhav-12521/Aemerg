/* The whole API, behind one entry point.

   Vercel gives each file under /api its own function and a Hobby project may
   have twelve; there are more routes than that, so they arrive through a
   single catch-all and are dispatched here. The same function is what the
   local server calls, so there is one implementation of every route. */

'use strict';

const core = require('./core');
const push = require('./push');
const store = require('./store');

function bearer(req) {
  const header = req.headers.authorization || '';
  const fromHeader = header.replace(/^Bearer\s+/i, '');
  if (fromHeader && fromHeader !== header) return fromHeader;
  return (req.query && req.query.token) || '';
}

async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  /* a runtime that did not parse it for us */
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return {}; }
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');

  /* Vercel's catch-all hands the segments over directly, which leaves no room
     for a rewritten path to be misread. Falling back to the URL keeps the
     local server, which has no such routing, working the same way. */
  const segments = req.query && req.query.path;
  const route = (Array.isArray(segments) ? segments.join('/') : (segments || ''))
    || url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');

  const method = req.method || 'GET';

  res.setHeader('Cache-Control', 'no-store');

  try {
    /* --- open routes --- */

    /* Health answers whatever the state, so there is always something to
       look at when the app is misbehaving. */
    if (route === 'healthz') {
      return res.status(200).json({
        ok: !store.ephemeral,
        store: store.hosted ? 'hosted' : store.ephemeral ? 'missing' : 'local',
        push: push.enabled,
        problem: store.ephemeral
          ? 'No key-value store is configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.'
          : undefined
      });
    }

    /* Everything else needs somewhere to keep what it is told. Answering
       normally here would mean handing out accounts that vanish on the next
       request, which is what being signed out at random actually is. */
    if (store.ephemeral) {
      return res.status(503).json({
        code: 'store-missing',
        error: 'This server has no database configured, so nothing can be saved. ' +
               'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN and redeploy.'
      });
    }

    if (route === 'push-key') {
      return res.status(200).json({ enabled: push.enabled, publicKey: push.publicKey });
    }

    if (route === 'register') {
      if (method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
      const b = await body(req);
      return res.status(200).json(await core.register(b.name));
    }

    /* --- everything below needs a session --- */

    const user = await core.whoIs(bearer(req));
    const b = method === 'GET' ? {} : await body(req);

    switch (route) {
      case 'me':
        return res.status(200).json(await core.me(user));

      case 'poll':
        return res.status(200).json(await core.poll(user));

      case 'send':
        return res.status(200).json(await core.sendNote(user, b.kind, b.text));

      case 'ack':
        return res.status(200).json(await core.ack(user, b.ids));

      case 'connect':
        return res.status(200).json(await core.connect(user, b.code));

      case 'respond':
        return res.status(200).json(await core.respond(user, b.requestId, b.accept));

      case 'name':
        return res.status(200).json(await core.rename(user, b.name));

      case 'unfriend':
        return res.status(200).json(await core.unfriend(user));

      case 'subscribe': {
        if (!push.enabled) return res.status(503).json({ error: 'Push is not set up on this server.' });
        const sub = b.subscription;
        if (!sub || !sub.endpoint || !sub.keys) {
          return res.status(400).json({ error: 'That subscription is not usable.' });
        }
        await store.addSub(user.id, { endpoint: sub.endpoint, keys: sub.keys, at: Date.now() });
        return res.status(200).json({ ok: true, devices: (await store.subsFor(user.id)).length });
      }

      case 'unsubscribe':
        await store.removeSub(user.id, String(b.endpoint || ''));
        return res.status(200).json({ ok: true, devices: (await store.subsFor(user.id)).length });

      case 'offline':
        await store.goOffline(user.id);
        return res.status(200).json({ ok: true });

      case 'signout':
        return res.status(200).json(await core.signOut(user));

      default:
        return res.status(404).json({ error: 'No such endpoint.' });
    }
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    if (status === 500) console.error(route + ':', err && err.stack ? err.stack : err);
    return res.status(status).json({
      error: (err && err.message) || 'Something went wrong. Try again.'
    });
  }
};
