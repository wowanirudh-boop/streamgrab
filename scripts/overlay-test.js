'use strict';
// Overlay fullscreen test (npm run test-overlay): throwaway Chrome + unpacked extension + hls.js demo.
// 1. Pill visible while the player is a normal box.
// 2. Pin the <video> over the whole viewport with CSS alone (no Fullscreen
//    API event) -> pill must get .sg-fs (hidden) within ~1.5 s.
// 3. Mouse move -> .sg-peek (visible) ; 3 s later peek gone again.
// 4. Restore the video box -> .sg-fs removed.
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const WebSocket = require('ws');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EXT_DIR = path.join(__dirname, '..', 'extension');
const PORT = 9334;
const PAGE = 'https://hlsjs.video-dev.org/demo/?src=' + encodeURIComponent('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-chrome-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--headless=new', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
async function getJson(p) { return (await fetch(`http://127.0.0.1:${PORT}${p}`)).json(); }
(async () => {
  let ver = null;
  for (let i = 0; i < 40 && !ver; i++) { try { ver = await getJson('/json/version'); } catch { await sleep(500); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl, { maxPayload: 100 * 1024 * 1024 });
  let id = 0; const pending = new Map();
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params, sessionId) => new Promise((res) => { const mid = ++id; pending.set(mid, res); const msg = { id: mid, method, params: params || {} }; if (sessionId) msg.sessionId = sessionId; ws.send(JSON.stringify(msg)); });
  await new Promise((r) => ws.on('open', r));
  const lu = await send('Extensions.loadUnpacked', { path: EXT_DIR });
  if (!lu.result) throw new Error('loadUnpacked failed');
  const t = await send('Target.createTarget', { url: PAGE });
  const att = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
  const sid = att.result.sessionId;
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid); return r.result && r.result.result ? r.result.result.value : JSON.stringify(r); };
  await sleep(9000);
  const state = () => ev(`(() => { const p = document.getElementById('streamgrab-overlay'); return p ? { display: getComputedStyle(p).display, cls: p.className, opacity: getComputedStyle(p).opacity } : null; })()`);
  const s1 = await state();
  console.log('1. normal layout      :', JSON.stringify(s1));
  // CSS-only "fullscreen": pin the video over the viewport, no API call.
  await ev(`(() => { const v = document.querySelector('video'); Object.assign(v.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', zIndex: 2147483000, background: '#000' }); return v.getBoundingClientRect().width + 'x' + v.getBoundingClientRect().height + ' of ' + innerWidth + 'x' + innerHeight; })()`).then((r) => console.log('   video pinned to    :', r));
  await sleep(1800);
  const s2 = await state();
  console.log('2. css fullscreen     :', JSON.stringify(s2));
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 300 }, sid);
  await sleep(300);
  const s3 = await state();
  console.log('3. after mouse move   :', JSON.stringify(s3));
  await sleep(3200);
  const s4 = await state();
  console.log('4. 3 s later          :', JSON.stringify(s4));
  await ev(`(() => { const v = document.querySelector('video'); v.style.cssText = ''; return 'restored'; })()`);
  await sleep(1800);
  const s5 = await state();
  console.log('5. restored layout    :', JSON.stringify(s5));
  const checks = [
    ['pill shown normally (no sg-fs)', s1 && s1.display === 'block' && !/sg-fs/.test(s1.cls) && s1.opacity === '1'],
    ['CSS-only fullscreen hides the pill', s2 && /sg-fs/.test(s2.cls) && s2.opacity === '0'],
    ['mouse move peeks the pill', s3 && /sg-peek/.test(s3.cls) && s3.opacity === '1'],
    ['peek fades after ~2.5 s', s4 && /sg-fs/.test(s4.cls) && !/sg-peek/.test(s4.cls) && s4.opacity === '0'],
    ['leaving fullscreen shows it again', s5 && !/sg-fs/.test(s5.cls) && s5.opacity === '1']
  ];
  let fail = 0;
  console.log('\n=== RESULTS ===');
  for (const [n, ok] of checks) { console.log(ok ? 'PASS' : 'FAIL', n); if (!ok) fail++; }
  ws.close(); chrome.kill(); await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); chrome.kill(); process.exit(1); });
