/* Generates the VAPID key pair that identifies this server to push services.

   Writes vapid.json beside server.js. That file is the server's identity for
   push: keep it, do not commit it, and do not regenerate it casually. A new
   key pair invalidates every subscription anyone has already made, which means
   nobody gets a notification until they open the app again.

   Run: node tools/vapid-keys.js */

'use strict';

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const OUT = path.join(__dirname, '..', 'vapid.json');

if (fs.existsSync(OUT) && !process.argv.includes('--force')) {
  const cur = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  console.log('vapid.json already exists. Public key:');
  console.log('  ' + cur.publicKey);
  console.log('\nRegenerating would break every existing subscription.');
  console.log('Pass --force only if you mean that.');
  process.exit(0);
}

const keys = webpush.generateVAPIDKeys();
const subject = process.env.VAPID_SUBJECT || 'mailto:aemerg@example.com';

fs.writeFileSync(OUT, JSON.stringify({
  subject: subject,
  publicKey: keys.publicKey,
  privateKey: keys.privateKey
}, null, 2));

console.log('wrote ' + OUT);
console.log('  subject:    ' + subject);
console.log('  public key: ' + keys.publicKey);
console.log('\nSet VAPID_SUBJECT to a mailto: or https: address you control');
console.log('before deploying, then regenerate with --force.');
