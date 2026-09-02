/* Everything the app actually does, with no idea how it was asked.

   Each function takes plain values and returns a plain result, so the same
   code runs behind a Vercel function and behind the little Express server
   used for local development. Errors carry a status so the transport can
   turn them into a response without knowing what went wrong. */

'use strict';

const crypto = require('crypto');
const store = require('./store');
const push = require('./push');

const KINDS = new Set(['missyou', 'hug', 'thinking', 'laugh', 'proud', 'night', 'text']);
const TEXT_MAX = 200;
const NAME_MAX = 40;

const id = () => crypto.randomBytes(9).toString('hex');
const now = () => Date.now();

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function cleanText(v) {
  const src = String(v == null ? '' : v);
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    /* drop C0 controls and DEL, keep everything else so other scripts and
       emoji travel through untouched */
    out += (c < 0x20 || c === 0x7f) ? ' ' : src[i];
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
}

function cleanName(v) {
  return cleanText(v).slice(0, NAME_MAX);
}

async function freshCode() {
  for (let i = 0; i < 200; i++) {
    const c = String(crypto.randomInt(100000, 1000000));
    /* claimed atomically, so two people registering at the same moment
       cannot walk away with the same six digits */
    if (await store.claimCode(c, 'pending')) return c;
  }
  throw fail(503, 'Could not allocate a code. Try again.');
}

async function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    code: user.code,
    online: await store.isOnline(user.id)
  };
}

/* ------------------------------------------------------------------ auth */

async function whoIs(token) {
  const uid = await store.userIdByToken(token);
  if (!uid) throw fail(401, 'Sign in again. That session is no longer valid.');
  const user = await store.getUser(uid);
  if (!user) throw fail(401, 'Sign in again. That session is no longer valid.');
  return user;
}

/* -------------------------------------------------------------- register */

async function register(name) {
  const clean = cleanName(name);
  if (!clean) throw fail(400, 'Enter a name so your friend knows who you are.');

  const uid = id();
  const code = await freshCode();
  const token = id() + id();
  const user = { id: uid, name: clean, code, token, friendId: null, createdAt: now() };

  /* the account first, then the pointers to it, so a token can never resolve
     to a user that was not written */
  await store.putUser(user);
  await store.cmd('SET', 'code:' + code, uid);
  await store.bindToken(token, uid);

  return { token, user: await publicUser(user) };
}

async function rename(user, name) {
  const clean = cleanName(name);
  if (!clean) throw fail(400, 'A name cannot be empty.');
  user.name = clean;
  await store.putUser(user);
  return { user: await publicUser(user) };
}

/* --------------------------------------------------------------- friends */

async function friendOf(user) {
  if (!user.friendId) return null;
  return publicUser(await store.getUser(user.friendId));
}

async function link(a, b) {
  a.friendId = b.id;
  b.friendId = a.id;
  await store.putUser(a);
  await store.putUser(b);
  await store.clearRequests(a.id);
  await store.clearRequests(b.id);
}

async function connect(user, rawCode) {
  const code = String(rawCode || '').replace(/\D/g, '');
  if (code.length !== 6) throw fail(400, 'A connection code is 6 digits.');
  if (code === user.code) throw fail(400, 'That is your own code.');
  if (user.friendId) throw fail(400, 'Disconnect from your current friend first.');

  const otherId = await store.userIdByCode(code);
  if (!otherId || otherId === 'pending') throw fail(404, 'No one is using that code.');

  const other = await store.getUser(otherId);
  if (!other) throw fail(404, 'No one is using that code.');
  if (other.friendId) throw fail(400, 'That person is already connected to someone.');

  /* they already asked you, so this is the acceptance */
  const theirs = await store.requestsFor(user.id, 'in');
  const mirror = theirs.find((r) => r.fromId === otherId);
  if (mirror) {
    await link(user, other);
    return { linked: true, friend: await publicUser(other) };
  }

  const mine = await store.requestsFor(user.id, 'out');
  if (mine.some((r) => r.toId === otherId)) return { linked: false, pending: true };

  const req = { id: id(), fromId: user.id, toId: otherId, createdAt: now() };
  await store.putRequest(req);
  await push.send(otherId, { id: req.id, kind: 'request', fromName: user.name, at: req.createdAt });
  return { linked: false, pending: true };
}

async function respond(user, requestId, accept) {
  const req = await store.getRequest(requestId);
  if (!req || req.toId !== user.id) throw fail(404, 'That request is no longer open.');

  if (!accept) {
    await store.dropRequest(req);
    return { friend: null };
  }

  const other = await store.getUser(req.fromId);
  if (!other) { await store.dropRequest(req); throw fail(404, 'That person is no longer here.'); }
  if (user.friendId || other.friendId) throw fail(400, 'One of you is already connected to someone.');

  await link(user, other);
  return { friend: await publicUser(other) };
}

async function unfriend(user) {
  const otherId = user.friendId;
  user.friendId = null;
  await store.putUser(user);
  if (otherId) {
    const other = await store.getUser(otherId);
    if (other) { other.friendId = null; await store.putUser(other); }
  }
  return { friend: null };
}

/* ----------------------------------------------------------------- notes */

async function sendNote(user, rawKind, rawText) {
  if (!user.friendId) throw fail(400, 'Connect with a friend first.');

  const kind = KINDS.has(rawKind) ? rawKind : 'missyou';
  const text = kind === 'text' ? cleanText(rawText) : '';
  if (kind === 'text' && !text) throw fail(400, 'Type something first.');

  const friend = await store.getUser(user.friendId);
  if (!friend) throw fail(400, 'Your friend is no longer here.');

  const evt = { id: id(), kind, fromId: user.id, fromName: user.name, at: now() };
  if (text) evt.text = text;

  /* queued first, always. Delivery is the queue being drained, not a
     separate thing that can succeed while the queue write fails. */
  await store.queueNote(friend.id, evt);
  await store.logActivity(user.id,   { id: evt.id, kind, text, dir: 'out', name: friend.name, at: evt.at });
  await store.logActivity(friend.id, { id: evt.id, kind, text, dir: 'in',  name: user.name,   at: evt.at });

  /* if they are not looking at the app, reach the phone itself */
  const online = await store.isOnline(friend.id);
  if (!online) await push.send(friend.id, evt);

  return { id: evt.id, kind, text, at: evt.at, delivered: online };
}

async function ack(user, ids) {
  const list = Array.isArray(ids) ? ids.slice(0, 50) : [];
  let removed = 0;
  for (const evtId of list) {
    if (await store.ackNote(user.id, String(evtId))) removed++;
  }
  return { removed };
}

/* ------------------------------------------------------------------ poll */

/* One call does everything a socket used to: says the caller is here, hands
   back anything waiting, and reports whether the friend is around. */
async function poll(user) {
  await store.touch(user.id);

  const [pending, friendUser, incoming] = await Promise.all([
    store.pendingFor(user.id),
    user.friendId ? store.getUser(user.friendId) : Promise.resolve(null),
    store.requestsFor(user.id, 'in')
  ]);

  const requests = [];
  for (const r of incoming) {
    const from = await store.getUser(r.fromId);
    requests.push({ id: r.id, from: from ? from.name : 'Someone', at: r.createdAt });
  }

  return {
    now: now(),
    friend: friendUser ? await publicUser(friendUser) : null,
    events: pending,
    requests,
    interval: 3000
  };
}

async function me(user) {
  const [friend, activity, incoming, outgoing, subs] = await Promise.all([
    friendOf(user),
    store.activityFor(user.id),
    store.requestsFor(user.id, 'in'),
    store.requestsFor(user.id, 'out'),
    store.subsFor(user.id)
  ]);

  const named = async (list, field) => {
    const out = [];
    for (const r of list) {
      const other = await store.getUser(field === 'from' ? r.fromId : r.toId);
      out.push({ id: r.id, [field]: other ? other.name : 'Someone', at: r.createdAt });
    }
    return out;
  };

  return {
    user: await publicUser(user),
    friend,
    activity,
    incoming: await named(incoming, 'from'),
    outgoing: await named(outgoing, 'to'),
    push: { enabled: push.enabled, devices: subs.length }
  };
}

async function signOut(user) {
  await store.dropToken(user.token);
  await store.goOffline(user.id);
  return { ok: true };
}

module.exports = {
  KINDS, TEXT_MAX,
  fail, cleanText, cleanName,
  whoIs, register, rename,
  connect, respond, unfriend, friendOf,
  sendNote, ack, poll, me, signOut,
  publicUser
};
