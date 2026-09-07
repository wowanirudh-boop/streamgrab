'use strict';

// Drives a Chrome instance over the DevTools Protocol: attaches to the
// StreamGrab extension's service worker and runs chrome.runtime.connectNative,
// capturing exactly what Chrome returns. Run against a Chrome started with
// --remote-debugging-port=9222.

const WebSocket = require('ws');
const EXT_ID = 'mgpgijoaodikafklfkljijgedmmogddg';
const PORT = 9222;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return res.json();
}

async function main() {
  // Wait for the debug endpoint.
  let ver = null;
  for (let i = 0; i < 30; i++) {
    try { ver = await getJson('/json/version'); break; } catch { await sleep(500); }
  }
  if (!ver) { console.log('Chrome debug port never came up'); process.exit(1); }
  console.log('Chrome:', ver.Browser);

  const ws = new WebSocket(ver.webSocketDebuggerUrl, { maxPayload: 100 * 1024 * 1024 });
  let id = 0;
  const pending = new Map();
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params, sessionId) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    const msg = { id: mid, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
  });
  await new Promise((r) => ws.on('open', r));

  // Find the extension service worker (wait for it to appear).
  let sw = null;
  for (let i = 0; i < 30; i++) {
    const { result } = await send('Target.getTargets');
    const infos = result.targetInfos;
    sw = infos.find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
    if (sw) break;
    if (i === 0) console.log('targets so far:\n  ' + infos.map((t) => `${t.type}  ${t.url}`).join('\n  '));
    await sleep(500);
  }
  if (!sw) { console.log('\nNo service worker target for the extension appeared.'); process.exit(2); }
  console.log('\nAttached to SW:', sw.url);

  const att = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  const sessionId = att.result.sessionId;

  const expr = `
  (async () => {
    const m = chrome.runtime.getManifest();
    const connect = await new Promise((resolve) => {
      try {
        const port = chrome.runtime.connectNative('com.streamgrab.host');
        let done = false;
        port.onMessage.addListener((x) => { if (!done) { done = true; resolve('SUCCESS reply: ' + JSON.stringify(x)); } });
        port.onDisconnect.addListener(() => { if (!done) { done = true; resolve('DISCONNECT: ' + (chrome.runtime.lastError && chrome.runtime.lastError.message)); } });
        try { port.postMessage({ type: 'ping' }); } catch (e) {}
        setTimeout(() => { if (!done) { done = true; resolve('TIMEOUT: port stayed open, no reply'); } }, 3000);
      } catch (e) { resolve('THROW: ' + e.message); }
    });
    return JSON.stringify({
      id: chrome.runtime.id,
      name: m.name,
      version: m.version,
      hasKey: !!m.key,
      permissions: m.permissions,
      connect
    }, null, 2);
  })()`;

  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  console.log('\n=== extension self-report + connectNative result ===');
  console.log(r.result && r.result.result ? r.result.result.value : JSON.stringify(r));
  process.exit(0);
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
