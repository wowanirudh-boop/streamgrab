'use strict';
// End-to-end detector test (npm run test-detect): throwaway Chrome + unpacked extension + a real
// HLS-fMP4 stream. Checks (1) the master playlist is detected with variants,
// (2) .mp4 fragments are NOT listed as videos, (3) after the service worker
// is killed the playlist is restored from chrome.storage.session, and
// (4) numbered .mp4 siblings with no playlist collapse into one PARTS row.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EXT_DIR = path.join(__dirname, '..', 'extension');
const EXT_ID = 'mgpgijoaodikafklfkljijgedmmogddg';
const PORT = 9333;
// hls.js demo page playing Apple's fMP4 example (segments are .mp4 files).
const STREAM = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8';
const PAGE = 'https://hlsjs.video-dev.org/demo/?src=' + encodeURIComponent(STREAM);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-chrome-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--headless=new', '--window-size=1280,800',
  'about:blank'
], { stdio: 'ignore' });

async function getJson(p) { return (await fetch(`http://127.0.0.1:${PORT}${p}`)).json(); }

(async () => {
  let ver = null;
  for (let i = 0; i < 40 && !ver; i++) { try { ver = await getJson('/json/version'); } catch { await sleep(500); } }
  if (!ver) throw new Error('debug port never came up');
  console.log('Chrome:', ver.Browser);

  const ws = new WebSocket(ver.webSocketDebuggerUrl, { maxPayload: 100 * 1024 * 1024 });
  let id = 0; const pending = new Map();
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params, sessionId) => new Promise((res) => { const mid = ++id; pending.set(mid, res); const msg = { id: mid, method, params: params || {} }; if (sessionId) msg.sessionId = sessionId; ws.send(JSON.stringify(msg)); });
  await new Promise((r) => ws.on('open', r));

  const lu = await send('Extensions.loadUnpacked', { path: EXT_DIR });
  if (!lu.result) throw new Error('loadUnpacked failed: ' + JSON.stringify(lu.error));
  console.log('extension loaded:', lu.result.id);

  async function findSw() {
    for (let i = 0; i < 40; i++) {
      const { result } = await send('Target.getTargets');
      const sw = result.targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
      if (sw) return sw;
      await sleep(250);
    }
    return null;
  }
  async function evalInSw(expr) {
    const sw = await findSw();
    if (!sw) throw new Error('no SW target');
    const att = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, att.result.sessionId);
    await send('Target.detachFromTarget', { sessionId: att.result.sessionId });
    if (r.result && r.result.exceptionDetails) throw new Error('SW eval threw: ' + JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  }

  const page = await send('Target.createTarget', { url: PAGE });
  console.log('opened page, waiting for playback…');
  await sleep(12000);

  const dump = `(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://hlsjs.video-dev.org/*' });
    const raw = (mediaByTab.get(tab.id) || []).map(i => ({ kind: i.kind, role: i.role, guessed: !!i.guessed, size: i.size, url: i.url.slice(-70) }));
    const presented = (presentedByTab.get(tab.id) || []).map(i => ({ kind: i.kind, role: i.role, name: i.name, quality: i.quality, sizeText: i.sizeText, variants: i.variants.length, noDownload: !!i.noDownload, heights: [...new Set(i.heights || [])].sort((a, b) => b - a) }));
    const stored = await chrome.storage.session.get('mediaByTab');
    const storedCount = Object.values(stored.mediaByTab || {}).reduce((a, l) => a + l.length, 0);
    return JSON.stringify({ tabId: tab.id, raw, presented, storedCount });
  })()`;

  const before = JSON.parse(await evalInSw(dump));
  console.log('\n=== BEFORE SW restart ===');
  console.log('raw seen:', before.raw.length, 'stored:', before.storedCount);
  before.raw.forEach((r) => console.log('  raw ', r.kind.padEnd(11), r.role.padEnd(11), r.guessed ? 'guessed' : '       ', String(r.size).padStart(9), r.url));
  before.presented.forEach((p) => console.log('  SHOW', p.kind.padEnd(11), p.role.padEnd(11), `variants=${p.variants}`, p.quality || p.sizeText, p.noDownload ? '(no download)' : '', '|', p.name));

  // Kill the worker (simulates Chrome's idle eviction) and let segment
  // traffic wake it up again.
  const sw1 = await findSw();
  await send('Target.closeTarget', { targetId: sw1.targetId });
  console.log('\nservice worker killed; waiting for it to be woken by traffic…');
  await sleep(6000);
  const after = JSON.parse(await evalInSw(dump));
  const sw2 = await findSw();
  console.log('=== AFTER SW restart (new target: ' + (sw2.targetId !== sw1.targetId) + ') ===');
  after.presented.forEach((p) => console.log('  SHOW', p.kind.padEnd(11), p.role.padEnd(11), `variants=${p.variants}`, p.quality || p.sizeText, p.noDownload ? '(no download)' : '', '|', p.name));

  // Unit-check the segment collapse with a synthetic tab.
  const collapse = await evalInSw(`(() => {
    const mk = (n) => ({ url: 'https://cdn.example/v/seg-' + n + '-v1-a1.mp4', key: 'k' + n, kind: 'progressive', role: 'progressive', variants: [], size: 700000, pageTitle: 'Synthetic', ts: Date.now() });
    mediaByTab.set(999999, [mk(1), mk(2), mk(3), mk(4), mk(5)]);
    const out = computePresented(999999).map(i => ({ kind: i.kind, role: i.role, sizeText: i.sizeText, noDownload: !!i.noDownload }));
    mediaByTab.delete(999999);
    return JSON.stringify(out);
  })()`);
  console.log('\n=== synthetic: 5 numbered .mp4 siblings, no playlist ===\n ', collapse);

  // Verdicts
  const masterBefore = before.presented.find((p) => p.role === 'master');
  const masterAfter = after.presented.find((p) => p.role === 'master');
  const fragShown = before.presented.filter((p) => p.role === 'progressive').length;
  const col = JSON.parse(collapse);
  const checks = [
    ['master playlist detected with variants', !!masterBefore && masterBefore.variants > 0],
    ['no .mp4 fragments listed as videos', fragShown === 0],
    ['exactly one row for the whole video (audio/subtitle playlists collapsed)', before.presented.length === 1],
    ['playlist survives service-worker restart', !!masterAfter && masterAfter.variants > 0],
    ['numbered siblings collapse to one PARTS row', col.length === 1 && col[0].role === 'segments' && col[0].noDownload],
    ['quality ladder exposed for the picker (heights from the master)', !!masterBefore && masterBefore.heights.length >= 3 && masterBefore.heights[0] === 1080]
  ];
  if (masterBefore) console.log('\nheights offered to the picker:', masterBefore.heights.join(', '));
  console.log('\n=== RESULTS ===');
  let fail = 0;
  for (const [name, ok] of checks) { console.log(ok ? 'PASS' : 'FAIL', name); if (!ok) fail++; }
  ws.close();
  chrome.kill();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); chrome.kill(); process.exit(1); });
