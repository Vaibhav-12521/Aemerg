/* Web Push: the only way to reach someone whose app is closed.

   The key pair identifies this server to the push services. It comes from
   environment variables in a deployment, or from vapid.json when running
   locally. Without it everything else still works and the app says push is
   off rather than failing quietly. */

'use strict';

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const store = require('./store');

let vapid = null;

try {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapid = {
      subject: process.env.VAPID_SUBJECT || 'mailto:singh12521vaibhav@gmail.com',
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY
    };
  } else {
    const file = path.join(__dirname, '..', 'vapid.json');
    if (fs.existsSync(file)) vapid = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
} catch (err) {
  console.error('could not read the push keys:', err.message);
}

if (vapid && vapid.publicKey && vapid.privateKey) {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
} else {
  vapid = null;
}

/* A push service answering 404 or 410 is telling us that device is gone for
   good, so the subscription is dropped rather than retried forever. */
async function send(uid, evt) {
  if (!vapid) return 0;

  const subs = await store.subsFor(uid);
  if (!subs.length) return 0;

  const payload = JSON.stringify({
    id: evt.id,
    kind: evt.kind,
    text: evt.text || '',
    fromName: evt.fromName,
    at: evt.at
  });

  let sent = 0;
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        payload,
        { TTL: 60 * 60 * 24 * 7, urgency: 'high' }
      );
      sent++;
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) await store.removeSub(uid, sub.endpoint);
      else console.error('push failed (' + code + '):', err && err.message);
    }
  }));
  return sent;
}

module.exports = {
  get enabled() { return !!vapid; },
  get publicKey() { return vapid ? vapid.publicKey : null; },
  send
};
