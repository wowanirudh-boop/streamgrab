'use strict';

// Gives the extension a STABLE id by embedding a public key in its manifest.
// Chrome derives the extension id from that key, so we can pre-register the
// native host once and never ask the user to copy an id or run a command.
//
// Idempotent: if the manifest already has a key, we just print the id.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const manifestPath = path.join(__dirname, '..', 'extension', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

let derB64 = manifest.key;
if (!derB64) {
  const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  derB64 = publicKey.toString('base64');
  // Put "key" first-ish by rebuilding the object with a stable order.
  const ordered = {};
  for (const k of ['manifest_version', 'name', 'version', 'description', 'key']) {
    if (k === 'key') ordered.key = derB64;
    else if (k in manifest) ordered[k] = manifest[k];
  }
  for (const k of Object.keys(manifest)) if (!(k in ordered)) ordered[k] = manifest[k];
  fs.writeFileSync(manifestPath, JSON.stringify(ordered, null, 2) + '\n');
}

const der = Buffer.from(derB64, 'base64');
const hash = crypto.createHash('sha256').update(der).digest();
const id = hash.slice(0, 16).toString('hex').split('')
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join('');

console.log(id);
