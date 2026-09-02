'use strict';

const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const crypto  = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const webpush = require('web-push');

const PORT = process.env.PORT || 8787;

/* Where the store lives. On a host with a mounted disk, point DATA_DIR at the
   mount (Render: /var/data) so accounts outlive a deploy. Left unset it sits
   beside server.js, which is right for running it locally. */
const DATA_DIR = process.env.DATA_DIR || __dirname;
const STORE = path.join(DATA_DIR, 'data.json');

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  console.error('cannot use DATA_DIR ' + DATA_DIR + ':', err.message);
}

const blank = { users: {}, codes: {}, requests: {}, pending: {}, activity: {}, subs: {} };
let db = blank;

try {
  if (fs.existsSync(STORE)) db = Object.assign({}, blank, JSON.parse(fs.readFileSync(STORE, 'utf8')));
} catch (err) {
  console.error('data.json unreadable, starting fresh:', err.message);
}

/* Writes go to a temp file and are renamed over the real one, so a crash
   mid-write can never leave a half-written data.json behind: either the old
   file survives intact or the new one replaces it whole.

   An account that exists only in memory is an account the user gets signed
   out of, so anything that creates or changes one saves immediately rather
   than waiting on the debounce. */

let saveTimer = null;
let dirty = false;

/* On Windows a rename over an existing file fails with EPERM or EBUSY while
   anything else holds a handle on it, which a virus scanner or the indexer
   will do at random. That is transient, so retry briefly; a save that is
   simply dropped is how an account goes missing and a user gets signed out. */

const napper = new Int32Array(new SharedArrayBuffer(4));
const nap = (ms) => { Atomics.wait(napper, 0, 0, ms); };

function renameWithRetry(from, to) {
  const backoff = [0, 5, 15, 40, 100, 250];
  let last;
  for (let i = 0; i < backoff.length; i++) {
    if (backoff[i]) nap(backoff[i]);
    try { fs.renameSync(from, to); return; } catch (err) {
      last = err;
      if (err.code !== 'EPERM' && err.code !== 'EACCES' && err.code !== 'EBUSY') throw err;
    }
  }
  throw last;
}

function writeNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  dirty = false;
  const tmp = STORE + '.tmp';
  const json = JSON.stringify(db, null, 2);
  try {
    fs.writeFileSync(tmp, json);
    renameWithRetry(tmp, STORE);
  } catch (err) {
    /* the atomic path is gone, so take the small risk of a direct write
       rather than the certain loss of dropping the save entirely */
    try {
      fs.writeFileSync(STORE, json);
      try { fs.unlinkSync(tmp); } catch (e) {}
    } catch (err2) {
      dirty = true;
      console.error('could not write data.json:', err2.message);
    }
  }
}

function save(immediate) {
  if (immediate) { writeNow(); return; }
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(writeNow, 150);
}

/* never lose the last few writes when the process goes down */
function flushAndExit(signal) {
  return () => {
    if (dirty) writeNow();
    process.exit(signal === 'SIGINT' ? 130 : 0);
  };
}
process.on('SIGINT',  flushAndExit('SIGINT'));
process.on('SIGTERM', flushAndExit('SIGTERM'));
process.on('exit', () => { if (dirty) writeNow(); });
process.on('uncaughtException', (err) => {
  console.error('uncaught:', err && err.stack ? err.stack : err);
  if (dirty) writeNow();
  process.exit(1);
});

/* Web Push. The key pair identifies this server to the push services; it
   lives in vapid.json, which is generated once by tools/vapid-keys.js and is
   not committed. Without it the app still works, it just cannot reach a
   closed browser, and it says so rather than failing quietly. */

const VAPID_FILE = path.join(__dirname, 'vapid.json');
let vapid = null;

try {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapid = {
      subject: process.env.VAPID_SUBJECT || 'mailto:singh12521vaibhav@gmail.com',
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY
    };
  } else if (fs.existsSync(VAPID_FILE)) {
    vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  }
} catch (err) {
  console.error('vapid.json unreadable:', err.message);
}

if (vapid && vapid.publicKey && vapid.privateKey) {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  console.log('push notifications are on');
} else {
  vapid = null;
  console.log('push notifications are off: run node tools/vapid-keys.js to turn them on');
}

const id  = () => crypto.randomBytes(9).toString('hex');
const now = () => Date.now();

function freshCode() {
  for (let i = 0; i < 500; i++) {
    const c = String(crypto.randomInt(100000, 1000000));
    if (!db.codes[c]) return c;
  }
  throw new Error('code space exhausted');
}

const KINDS = new Set(['missyou', 'hug', 'thinking', 'laugh', 'proud', 'night', 'text']);
const TEXT_MAX = 200;

/* Notes are stored and delivered as plain text and rendered with textContent,
   so no markup can travel through. Control characters are dropped and runs of
   whitespace collapsed, which also stops a wall of newlines being sent. */
function cleanText(v) {
  const src = String(v == null ? '' : v);
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    /* drop C0 controls and DEL, keep everything else so other scripts
       and emoji travel through untouched */
    out += (c < 0x20 || c === 0x7f) ? ' ' : src[i];
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
}

function userByToken(token) {
  if (!token) return null;
  return Object.keys(db.users).find((k) => db.users[k].token === token) || null;
}

const sockets = new Map();

const isOnline = (uid) => sockets.has(uid) && sockets.get(uid).size > 0;

function sendTo(uid, msg) {
  const set = sockets.get(uid);
  if (!set) return false;
  const text = JSON.stringify(msg);
  let sent = false;
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) { ws.send(text); sent = true; }
  }
  return sent;
}

function publicUser(uid) {
  const u = db.users[uid];
  if (!u) return null;
  return { id: u.id, name: u.name, code: u.code, online: isOnline(uid) };
}

function friendOf(uid) {
  const u = db.users[uid];
  return u && u.friendId ? publicUser(u.friendId) : null;
}

function announcePresence(uid) {
  const u = db.users[uid];
  if (!u || !u.friendId) return;
  sendTo(u.friendId, { t: 'presence', friendId: uid, online: isOnline(uid) });
}

function queue(uid, evt) {
  if (!db.pending[uid]) db.pending[uid] = [];
  db.pending[uid].push(evt);
  if (db.pending[uid].length > 200) db.pending[uid].splice(0, db.pending[uid].length - 200);
  save(true);
}

function flush(uid) {
  const list = db.pending[uid] || [];
  for (const evt of list) sendTo(uid, Object.assign({ t: 'missyou' }, evt));
}

function ack(uid, evtId) {
  const list = db.pending[uid];
  if (!list) return;
  const next = list.filter((e) => e.id !== evtId);
  if (next.length !== list.length) { db.pending[uid] = next; save(); }
}

/* One device is one subscription, keyed by its endpoint so re-subscribing
   on the same browser replaces rather than duplicates. */

function addSub(uid, sub) {
  if (!sub || !sub.endpoint) return false;
  if (!db.subs[uid]) db.subs[uid] = [];
  const list = db.subs[uid];
  const at = list.findIndex((s) => s.endpoint === sub.endpoint);
  const row = { endpoint: sub.endpoint, keys: sub.keys, at: now() };
  if (at > -1) list[at] = row; else list.push(row);
  if (list.length > 12) list.splice(0, list.length - 12);
  save(true);
  return true;
}

function removeSub(uid, endpoint) {
  const list = db.subs[uid];
  if (!list) return;
  const next = list.filter((s) => s.endpoint !== endpoint);
  if (next.length !== list.length) {
    if (next.length) db.subs[uid] = next; else delete db.subs[uid];
    save(true);
  }
}

/* Sent when the note could not be handed to a live socket, which is exactly
   the case the user cares about: their friend's app is closed. A push service
   answering 404 or 410 means that subscription is dead, so it is dropped. */

function pushTo(uid, evt) {
  if (!vapid) return;
  const list = db.subs[uid];
  if (!list || !list.length) return;

  const payload = JSON.stringify({
    id: evt.id,
    kind: evt.kind,
    text: evt.text || '',
    fromName: evt.fromName,
    at: evt.at
  });

  for (const sub of list.slice()) {
    webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, {
      TTL: 60 * 60 * 24 * 7,
      urgency: 'high'
    }).catch((err) => {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) removeSub(uid, sub.endpoint);
      else console.error('push failed (' + code + '):', err && err.message);
    });
  }
}

function logActivity(uid, entry) {
  if (!db.activity[uid]) db.activity[uid] = [];
  db.activity[uid].unshift(entry);
  db.activity[uid] = db.activity[uid].slice(0, 40);
  save();
}

const app = express();

/* Render terminates TLS and forwards, so the real protocol and client address
   arrive in headers rather than on the socket. */
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

/* Something for the host's health check to hit that does not touch the store */
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    push: !!vapid,
    users: Object.keys(db.users).length,
    online: sockets.size,
    uptime: Math.round(process.uptime())
  });
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

function auth(req, res, next) {
  const header = req.get('authorization') || '';
  const token  = header.replace(/^Bearer\s+/i, '') || req.query.token;
  const uid    = userByToken(token);
  if (!uid) return res.status(401).json({ error: 'Sign in again. That session is no longer valid.' });
  req.uid = uid;
  next();
}

app.post('/api/register', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Enter a name so your friend knows who you are.' });
  const uid  = id();
  const code = freshCode();
  db.users[uid] = { id: uid, name, code, token: id() + id(), friendId: null, createdAt: now() };
  db.codes[code] = uid;
  save(true);
  res.json({ token: db.users[uid].token, user: publicUser(uid) });
});

app.get('/api/push-key', (req, res) => {
  res.json({ enabled: !!vapid, publicKey: vapid ? vapid.publicKey : null });
});

app.post('/api/subscribe', auth, (req, res) => {
  if (!vapid) return res.status(503).json({ error: 'Push is not set up on this server.' });
  if (!addSub(req.uid, req.body && req.body.subscription)) {
    return res.status(400).json({ error: 'That subscription is not usable.' });
  }
  res.json({ ok: true, devices: (db.subs[req.uid] || []).length });
});

app.post('/api/unsubscribe', auth, (req, res) => {
  removeSub(req.uid, String((req.body && req.body.endpoint) || ''));
  res.json({ ok: true, devices: (db.subs[req.uid] || []).length });
});

app.get('/api/me', auth, (req, res) => {
  res.json({
    user:     publicUser(req.uid),
    friend:   friendOf(req.uid),
    incoming: Object.values(db.requests)
                    .filter((r) => r.toId === req.uid && r.status === 'open')
                    .map((r) => ({ id: r.id, from: db.users[r.fromId] ? db.users[r.fromId].name : 'Someone', at: r.createdAt })),
    outgoing: Object.values(db.requests)
                    .filter((r) => r.fromId === req.uid && r.status === 'open')
                    .map((r) => ({ id: r.id, to: db.users[r.toId] ? db.users[r.toId].name : 'Someone', at: r.createdAt })),
    activity: db.activity[req.uid] || [],
    push: { enabled: !!vapid, devices: (db.subs[req.uid] || []).length }
  });
});

app.post('/api/name', auth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'A name cannot be empty.' });
  db.users[req.uid].name = name;
  save();
  const f = db.users[req.uid].friendId;
  if (f) sendTo(f, { t: 'friend', friend: publicUser(req.uid) });
  res.json({ user: publicUser(req.uid) });
});

function link(a, b, requestId) {
  db.users[a].friendId = b;
  db.users[b].friendId = a;
  if (requestId && db.requests[requestId]) db.requests[requestId].status = 'accepted';

  for (const r of Object.values(db.requests)) {
    if (r.status === 'open' && (r.fromId === a || r.toId === a || r.fromId === b || r.toId === b)) {
      r.status = 'closed';
    }
  }
  save(true);
  sendTo(a, { t: 'friend', friend: publicUser(b) });
  sendTo(b, { t: 'friend', friend: publicUser(a) });
}

app.post('/api/connect', auth, (req, res) => {
  const code = String(req.body.code || '').replace(/\D/g, '');
  const me   = db.users[req.uid];
  if (code.length !== 6) return res.status(400).json({ error: 'A connection code is 6 digits.' });
  if (code === me.code)  return res.status(400).json({ error: 'That is your own code.' });

  const otherId = db.codes[code];
  if (!otherId)          return res.status(404).json({ error: 'No one is using that code.' });
  if (me.friendId)       return res.status(400).json({ error: 'Disconnect from your current friend first.' });
  if (db.users[otherId].friendId) {
    return res.status(400).json({ error: 'That person is already connected to someone.' });
  }

  const mirror = Object.values(db.requests)
    .find((r) => r.status === 'open' && r.fromId === otherId && r.toId === req.uid);
  if (mirror) {
    link(req.uid, otherId, mirror.id);
    return res.json({ linked: true, friend: friendOf(req.uid) });
  }

  const existing = Object.values(db.requests)
    .find((r) => r.status === 'open' && r.fromId === req.uid && r.toId === otherId);
  if (existing) return res.json({ linked: false, pending: true });

  const rid = id();
  db.requests[rid] = { id: rid, fromId: req.uid, toId: otherId, status: 'open', createdAt: now() };
  save();
  if (!sendTo(otherId, { t: 'request', request: { id: rid, from: me.name, at: now() } })) {
    pushTo(otherId, { id: rid, kind: 'request', fromName: me.name, at: now() });
  }
  res.json({ linked: false, pending: true });
});

app.post('/api/respond', auth, (req, res) => {
  const r = db.requests[String(req.body.requestId || '')];
  if (!r || r.status !== 'open' || r.toId !== req.uid) {
    return res.status(404).json({ error: 'That request is no longer open.' });
  }
  if (!req.body.accept) {
    r.status = 'declined';
    save();
    return res.json({ friend: null });
  }
  if (db.users[req.uid].friendId || db.users[r.fromId].friendId) {
    return res.status(400).json({ error: 'One of you is already connected to someone.' });
  }
  link(req.uid, r.fromId, r.id);
  res.json({ friend: friendOf(req.uid) });
});

app.post('/api/unfriend', auth, (req, res) => {
  const me = db.users[req.uid];
  const other = me.friendId;
  me.friendId = null;
  if (other && db.users[other]) {
    db.users[other].friendId = null;
    sendTo(other, { t: 'friend', friend: null });
  }
  save();
  res.json({ friend: null });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://localhost').searchParams.get('token');
  const uid = userByToken(token);
  if (!uid) { ws.close(4001, 'bad token'); return; }

  ws.uid = uid;
  ws.alive = true;
  if (!sockets.has(uid)) sockets.set(uid, new Set());
  sockets.get(uid).add(ws);

  ws.send(JSON.stringify({ t: 'ready', user: publicUser(uid), friend: friendOf(uid) }));
  announcePresence(uid);
  flush(uid);

  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (err) { return; }

    if (m.t === 'ack' && m.id) { ack(uid, m.id); return; }

    if (m.t === 'missyou') {
      const me = db.users[uid];
      if (!me.friendId) {
        ws.send(JSON.stringify({ t: 'error', text: 'Connect with a friend first.' }));
        return;
      }
      let kind = KINDS.has(m.kind) ? m.kind : 'missyou';
      let text = '';
      if (kind === 'text') {
        text = cleanText(m.text);
        if (!text) {
          ws.send(JSON.stringify({ t: 'error', text: 'Type something first.' }));
          return;
        }
      }
      const evt = { id: id(), kind, fromId: uid, fromName: me.name, at: now() };
      if (text) evt.text = text;
      queue(me.friendId, evt);
      const delivered = sendTo(me.friendId, Object.assign({ t: 'missyou' }, evt));
      /* nobody is holding a socket, so reach the closed app instead */
      if (!delivered) pushTo(me.friendId, evt);
      logActivity(uid,         { id: evt.id, kind, text, dir: 'out', name: db.users[me.friendId].name, at: evt.at });
      logActivity(me.friendId, { id: evt.id, kind, text, dir: 'in',  name: me.name,                    at: evt.at });
      ws.send(JSON.stringify({ t: 'sent', id: evt.id, kind, text, at: evt.at, delivered }));
    }
  });

  ws.on('close', () => {
    const set = sockets.get(uid);
    if (set) { set.delete(ws); if (!set.size) sockets.delete(uid); }
    announcePresence(uid);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 25000).unref();

server.listen(PORT, () => {
  console.log('Aemerg is running on port ' + PORT);
  console.log('  store: ' + STORE);
});
