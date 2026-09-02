/* The store.

   Everything lives in a hosted key-value service, reached over its REST API so
   there is no connection to hold open. That matters on a serverless host,
   where each request may run in a different process that lives for a second.

   The data is split across keys rather than kept as one document. Two requests
   arriving at once touch different keys, so neither can overwrite the other's
   work, and a note appended to a queue is one atomic push rather than a read,
   an edit and a write. */

'use strict';

const URL_  = (process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_REST_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN || '';

const hosted = !!(URL_ && TOKEN);

/* With no hosted store configured, fall back to a local one that speaks the
   same commands. That is for development and for running it on your own
   machine; a deployment sets the two variables and uses the real thing. */
/* A serverless host gives each request its own short-lived container with a
   read-only project directory. Falling back to a file there does not fail, it
   just quietly forgets everything between requests, which the user sees as
   being signed out at random. Better to refuse and say why. */
const serverless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ||
                      process.env.FUNCTIONS_WORKER_RUNTIME);
const ephemeral = !hosted && serverless;

const local = (hosted || ephemeral) ? null : require('./local');

/* Presence is a key that expires. A device says it is here every few seconds;
   when it stops saying so the key lapses and the friend sees offline without
   anyone having to notice a socket close.

   Kept just above the poll interval. A tab that was killed rather than closed
   politely cannot say it has gone, and every second the key outlives it is a
   second in which a note is held back from the phone instead of pushed. */
const PRESENCE_TTL = 10;

const K = {
  user:     (id)    => 'u:' + id,
  token:    (t)     => 'tok:' + t,
  code:     (c)     => 'code:' + c,
  pending:  (id)    => 'pend:' + id,
  activity: (id)    => 'act:' + id,
  subs:     (id)    => 'sub:' + id,
  seen:     (id)    => 'seen:' + id,
  request:  (rid)   => 'req:' + rid,
  inbox:    (id)    => 'rin:' + id,
  outbox:   (id)    => 'rout:' + id
};

async function call(body, endpoint) {
  const res = await fetch(URL_ + (endpoint || ''), {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('store responded ' + res.status + (text ? ': ' + text.slice(0, 160) : ''));
  }
  return res.json();
}

/* one command */
async function cmd(...parts) {
  if (local) return local.cmd(parts.map(String));
  const out = await call(parts.map(String));
  return out ? out.result : null;
}

/* several commands in one round trip */
async function pipe(commands) {
  if (!commands.length) return [];
  if (local) return local.pipe(commands.map((c) => c.map(String)));
  const out = await call(commands.map((c) => c.map(String)), '/pipeline');
  return (out || []).map((r) => (r ? r.result : null));
}

const readJson = (v) => {
  if (v === null || v === undefined) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
};

/* ------------------------------------------------------------------ users */

async function getUser(id) {
  if (!id) return null;
  return readJson(await cmd('GET', K.user(id)));
}

async function putUser(user) {
  await cmd('SET', K.user(user.id), JSON.stringify(user));
  return user;
}

async function userIdByToken(token) {
  if (!token) return null;
  return await cmd('GET', K.token(token));
}

async function userIdByCode(code) {
  if (!code) return null;
  return await cmd('GET', K.code(code));
}

/* Claims the code only if nobody holds it, so two people registering at the
   same instant cannot end up sharing one. */
async function claimCode(code, uid) {
  const got = await cmd('SET', K.code(code), uid, 'NX');
  return got !== null;
}

async function bindToken(token, uid) {
  await cmd('SET', K.token(token), uid);
}

async function dropToken(token) {
  if (token) await cmd('DEL', K.token(token));
}

/* ------------------------------------------------------------ presence */

async function touch(uid) {
  await cmd('SET', K.seen(uid), String(Date.now()), 'EX', PRESENCE_TTL);
}

async function isOnline(uid) {
  if (!uid) return false;
  return (await cmd('EXISTS', K.seen(uid))) === 1;
}

async function goOffline(uid) {
  await cmd('DEL', K.seen(uid));
}

/* ------------------------------------------------------- pending notes */

/* Appended whole. A note is never lost to a read-modify-write race because
   there is no read: the push is the whole operation. */
async function queueNote(uid, evt) {
  await pipe([
    ['RPUSH', K.pending(uid), JSON.stringify(evt)],
    ['LTRIM', K.pending(uid), '-200', '-1']
  ]);
}

async function pendingFor(uid) {
  const rows = await cmd('LRANGE', K.pending(uid), '0', '-1');
  return (rows || []).map(readJson).filter(Boolean);
}

/* Removing by value keeps this safe when two devices acknowledge at once:
   the second removal simply finds nothing to remove. */
async function ackNote(uid, evtId) {
  const rows = await cmd('LRANGE', K.pending(uid), '0', '-1');
  const hit = (rows || []).find((r) => {
    const e = readJson(r);
    return e && e.id === evtId;
  });
  if (!hit) return false;
  await cmd('LREM', K.pending(uid), '1', hit);
  return true;
}

/* ---------------------------------------------------------- activity */

async function logActivity(uid, entry) {
  await pipe([
    ['LPUSH', K.activity(uid), JSON.stringify(entry)],
    ['LTRIM', K.activity(uid), '0', '39']
  ]);
}

async function activityFor(uid) {
  const rows = await cmd('LRANGE', K.activity(uid), '0', '39');
  return (rows || []).map(readJson).filter(Boolean);
}

/* ------------------------------------------------ push subscriptions */

async function addSub(uid, sub) {
  const rows = await cmd('LRANGE', K.subs(uid), '0', '-1');
  const dupe = (rows || []).find((r) => {
    const s = readJson(r);
    return s && s.endpoint === sub.endpoint;
  });
  if (dupe) await cmd('LREM', K.subs(uid), '1', dupe);
  await pipe([
    ['RPUSH', K.subs(uid), JSON.stringify(sub)],
    ['LTRIM', K.subs(uid), '-12', '-1']
  ]);
}

async function subsFor(uid) {
  const rows = await cmd('LRANGE', K.subs(uid), '0', '-1');
  return (rows || []).map(readJson).filter(Boolean);
}

async function removeSub(uid, endpoint) {
  const rows = await cmd('LRANGE', K.subs(uid), '0', '-1');
  const hit = (rows || []).find((r) => {
    const s = readJson(r);
    return s && s.endpoint === endpoint;
  });
  if (hit) await cmd('LREM', K.subs(uid), '1', hit);
}

/* ------------------------------------------------- connection requests */

async function putRequest(req) {
  await pipe([
    ['SET', K.request(req.id), JSON.stringify(req)],
    ['SADD', K.inbox(req.toId), req.id],
    ['SADD', K.outbox(req.fromId), req.id]
  ]);
}

async function getRequest(rid) {
  if (!rid) return null;
  return readJson(await cmd('GET', K.request(rid)));
}

async function dropRequest(req) {
  await pipe([
    ['DEL', K.request(req.id)],
    ['SREM', K.inbox(req.toId), req.id],
    ['SREM', K.outbox(req.fromId), req.id]
  ]);
}

async function requestIds(uid, which) {
  const key = which === 'out' ? K.outbox(uid) : K.inbox(uid);
  return (await cmd('SMEMBERS', key)) || [];
}

async function requestsFor(uid, which) {
  const ids = await requestIds(uid, which);
  if (!ids.length) return [];
  const rows = await pipe(ids.map((id) => ['GET', K.request(id)]));
  return rows.map(readJson).filter(Boolean);
}

/* Called when two people link: every other request either of them had open
   is meaningless now. */
async function clearRequests(uid) {
  const inIds = await requestIds(uid, 'in');
  const outIds = await requestIds(uid, 'out');
  const all = inIds.concat(outIds);
  if (!all.length) return;
  const rows = await pipe(all.map((id) => ['GET', K.request(id)]));
  const ops = [];
  rows.map(readJson).filter(Boolean).forEach((r) => {
    ops.push(['DEL', K.request(r.id)]);
    ops.push(['SREM', K.inbox(r.toId), r.id]);
    ops.push(['SREM', K.outbox(r.fromId), r.id]);
  });
  if (ops.length) await pipe(ops);
}

module.exports = {
  hosted,
  ephemeral,
  where: hosted ? 'hosted key-value'
       : ephemeral ? 'NOT CONFIGURED'
       : ('local file ' + require('./local').file),
  cmd,
  getUser, putUser, userIdByToken, userIdByCode, claimCode, bindToken, dropToken,
  touch, isOnline, goOffline,
  queueNote, pendingFor, ackNote,
  logActivity, activityFor,
  addSub, subsFor, removeSub,
  putRequest, getRequest, dropRequest, requestsFor, clearRequests
};
