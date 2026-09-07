'use strict';

// Local TCP bridge between the Electron app and the native-messaging host
// (native-host/host.cs). Chrome spawns the host; the host relays JSON both ways
// over this socket so the extension can reach the app.
//
// Protocol: newline-delimited JSON on 127.0.0.1. First line from a client must
// be {"type":"hello","token":<token>}; we answer {"type":"welcome"}.
//
// Security: bound strictly to 127.0.0.1 and gated by a random per-run token
// that is written to bridge.json in the app's userData folder (user-only).
// bridge.json also tells the host how to launch the app when it is not running.

const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULT_PORT = 47990;

class Bridge extends EventEmitter {
  /**
   * @param {{configPath: string, launch: {exe: string, args: string[]}}} opts
   */
  constructor({ configPath, launch }) {
    super();
    this.configPath = configPath;
    this.launch = launch;
    this.token = crypto.randomBytes(16).toString('hex');
    this.clients = new Set();
    this.port = 0;
  }

  /** Resolves to true once listening (falls back to an ephemeral port if 47990 is taken). */
  start() {
    return new Promise((resolve) => {
      const server = net.createServer((sock) => this.onConnection(sock));
      this.server = server;

      const listen = (port) => {
        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && port !== 0) {
            console.warn(`[bridge] port ${port} busy, using an ephemeral port`);
            listen(0);
          } else {
            console.error('[bridge] server error', err.message);
            resolve(false);
          }
        });
        server.listen(port, '127.0.0.1', () => {
          this.port = server.address().port;
          this.writeConfig();
          console.log(`[bridge] listening on 127.0.0.1:${this.port}`);
          resolve(true);
        });
      };
      listen(DEFAULT_PORT);
    });
  }

  onConnection(sock) {
    let authed = false;
    let buf = '';
    const client = {
      send: (obj) => { try { sock.write(JSON.stringify(obj) + '\n'); } catch {} }
    };

    sock.setNoDelay(true);
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch {
          if (!authed) { console.warn(`[bridge] non-JSON from :${sock.remotePort}: ${line.slice(0, 80)}`); sock.destroy(); return; }
          continue;
        }

        if (!authed) {
          if (msg.type === 'hello' && msg.token === this.token) {
            authed = true;
            this.clients.add(client);
            client.send({ type: 'welcome' });
            console.log(`[bridge] host connected from :${sock.remotePort}`);
          } else {
            console.warn(`[bridge] rejected client :${sock.remotePort} type=${msg.type} token=${String(msg.token || '').slice(0, 6)}... (mine ${this.token.slice(0, 6)}...)`);
            sock.destroy();
            return;
          }
          continue;
        }
        // Authenticated traffic from the extension (via the native host).
        this.emit(msg.type, msg.payload, client);
      }
    });
    sock.on('close', () => this.clients.delete(client));
    sock.on('error', () => this.clients.delete(client));
  }

  writeConfig() {
    const cfg = {
      port: this.port,
      token: this.token,
      pid: process.pid,
      exe: this.launch.exe,
      args: this.launch.args
    };
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2));
    } catch (e) {
      console.error('[bridge] could not write bridge.json', e.message);
    }
  }

  broadcast(type, payload) {
    for (const c of this.clients) c.send({ type, payload });
  }

  stop() {
    try { this.server && this.server.close(); } catch {}
    try { fs.unlinkSync(this.configPath); } catch {}
  }
}

module.exports = { Bridge, DEFAULT_PORT };
