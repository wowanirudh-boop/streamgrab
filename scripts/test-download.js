'use strict';

// Diagnostic: mimic exactly what Chrome does — spawn the native host and send it
// a native-messaging-framed download message — to test host.js <-> app end to end
// without needing Chrome or the extension.

const { spawn } = require('child_process');
const path = require('path');

const hostPath = path.join(__dirname, '..', 'native-host', 'host.js');
const host = spawn(process.execPath, [hostPath], { stdio: ['pipe', 'pipe', 'inherit'] });

function send(obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  const h = Buffer.alloc(4);
  h.writeUInt32LE(buf.length, 0);
  host.stdin.write(h);
  host.stdin.write(buf);
}

let acc = Buffer.alloc(0);
host.stdout.on('data', (chunk) => {
  acc = Buffer.concat([acc, chunk]);
  while (acc.length >= 4) {
    const len = acc.readUInt32LE(0);
    if (acc.length < 4 + len) break;
    console.log('FROM APP -> ', acc.slice(4, 4 + len).toString());
    acc = acc.slice(4 + len);
  }
});
host.on('exit', (code) => console.log('[host exited with code', code + ']'));

setTimeout(() => {
  console.log('Sending download to host...');
  send({
    type: 'download',
    payload: {
      url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
      kind: 'hls',
      headers: {},
      pageTitle: 'BACKEND TEST',
      pageUrl: 'test'
    }
  });
}, 700);

setTimeout(() => { host.stdin.end(); process.exit(0); }, 3500);
