'use strict';

// StreamGrab background service worker.
//
//  1. Observe network traffic and detect streaming media (HLS/DASH/progressive).
//  2. For HLS, fetch the playlist and tell a MASTER playlist (the whole video,
//     with quality variants) apart from the VARIANT/segment playlists it points
//     to — so one video shows up as one item, not one-per-quality.
//  3. Capture request context (Referer/Cookie/User-Agent) for re-fetching.
//  4. Bridge to the desktop app over Chrome native messaging.

const HOST_NAME = 'com.streamgrab.host';

const MANIFEST_EXT = /\.(m3u8|mpd)(\?|#|$)/i;
const PROGRESSIVE_EXT = /\.(mp4|webm|m4v|mov|flv|mkv|avi)(\?|#|$)/i;
const MEDIA_CT = /(application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)|video\/(mp4|webm|x-flv|quicktime|x-matroska))/i;
const MASTER_NAME = /(master|index|playlist|manifest|main|chunklist)?\.?m3u8/i;
const MIN_PROGRESSIVE_BYTES = 300 * 1024;

// Sites whose video can't be sniffed off the wire but ARE handled by yt-dlp from
// the page URL (YouTube encrypts/splits its streams, etc.). For these we offer a
// "download this page's video" item instead of chasing network requests.
const SITE_PATTERNS = [
  /https?:\/\/(www\.)?youtube\.com\/(watch|shorts|live)/i,
  /https?:\/\/youtu\.be\//i,
  /https?:\/\/(www\.)?vimeo\.com\/\d+/i,
  /https?:\/\/(www\.)?dailymotion\.com\/video\//i,
  /https?:\/\/(www\.)?twitch\.tv\/(videos\/|\w+\/clip)/i,
  /https?:\/\/(twitter|x)\.com\/[^/]+\/status\//i,
  /https?:\/\/(www\.)?tiktok\.com\/@[^/]+\/video\//i,
  /https?:\/\/(www\.)?facebook\.com\/.*\/videos?\//i,
  /https?:\/\/(www\.)?instagram\.com\/(reel|p|tv)\//i
];
function matchesSite(url) { return SITE_PATTERNS.some((re) => re.test(url)); }
function siteName(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'YouTube';
  if (/vimeo\.com/i.test(url)) return 'Vimeo';
  if (/dailymotion\.com/i.test(url)) return 'Dailymotion';
  if (/twitch\.tv/i.test(url)) return 'Twitch';
  if (/(twitter|x)\.com/i.test(url)) return 'X';
  if (/tiktok\.com/i.test(url)) return 'TikTok';
  if (/facebook\.com/i.test(url)) return 'Facebook';
  if (/instagram\.com/i.test(url)) return 'Instagram';
  return 'Video';
}

/** @type {Map<number, Array>} tabId -> raw detected items */
const mediaByTab = new Map();
/** @type {Map<number, Array>} tabId -> cleaned items for display */
const presentedByTab = new Map();
/** @type {Map<string, object>} requestId -> captured request headers */
const reqHeaders = new Map();

// ---- native messaging ------------------------------------------------------

let port = null;
let linkReady = false;      // true only once a ping has round-tripped from the app
let pingWaiters = [];
let lastNativeError = '';   // surfaced in the popup so problems are visible
let appLaunching = 0;       // timestamp until which the host says the app is starting

// Small diagnostic trail of native-messaging events, shown in the popup and
// kept in chrome.storage.local so it survives service-worker restarts.
const NM_LOG_MAX = 40;
let nmLog = [];
chrome.storage.local.get('nmLog').then((r) => { if (Array.isArray(r.nmLog)) nmLog = r.nmLog.concat(nmLog).slice(-NM_LOG_MAX); }).catch(() => {});
function nmlog(...a) {
  const line = `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}`;
  nmLog.push(line);
  if (nmLog.length > NM_LOG_MAX) nmLog = nmLog.slice(-NM_LOG_MAX);
  chrome.storage.local.set({ nmLog }).catch(() => {});
}
nmlog('service worker started');

function connectApp() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
    nmlog('connectNative ok');
  } catch (e) {
    nmlog('connectNative threw:', e && e.message);
    lastNativeError = (e && e.message) || 'connectNative threw';
    port = null;
    return;
  }
  port.onMessage.addListener(onAppMessage);
  port.onDisconnect.addListener(() => {
    const e = chrome.runtime.lastError; // capture WHY (host not found / exited / forbidden)
    lastNativeError = (e && e.message) ? e.message : 'host disconnected';
    nmlog('disconnected:', lastNativeError);
    linkReady = false;
    port = null;
    const waiters = pingWaiters; pingWaiters = [];
    waiters.forEach((fn) => fn(false));
  });
  // Prove the whole chain (chrome -> host -> app) is actually alive.
  try { port.postMessage({ type: 'ping' }); } catch (e) { nmlog('ping post failed:', e && e.message); }
}

function ensureConnected() {
  if (!port) connectApp();
  return !!port;
}

// Resolves true only when a ping round-trips back from the running app — so we
// never claim "connected" just because a port object exists.
function verifyLink(timeout = 4000) {
  return new Promise((resolve) => {
    if (linkReady) return resolve(true);
    if (!ensureConnected()) return resolve(false);
    let done = false;
    let t = null;
    const startedAt = Date.now();
    const finish = (ok) => { if (done) return; done = true; clearTimeout(t); resolve(ok); };
    // The host may report that it is starting the app; keep waiting while it
    // does, but never longer than 35 s in total whatever happens.
    const arm = (ms) => {
      t = setTimeout(() => {
        const waited = Date.now() - startedAt;
        if (!done && port && Date.now() < appLaunching && waited < 35000) { arm(1000); return; }
        if (!done && !lastNativeError) lastNativeError = appLaunching ? 'StreamGrab did not start in time' : 'no reply from the app (host silent)';
        nmlog('verifyLink timed out after', waited + 'ms', '-', lastNativeError);
        finish(false);
      }, ms);
    };
    arm(timeout);
    pingWaiters.push(finish);
    try { port.postMessage({ type: 'ping' }); } catch (e) { nmlog('ping post failed:', e && e.message); }
  });
}

function sendToApp(type, payload) {
  if (!ensureConnected()) return false;
  try {
    port.postMessage({ type, payload });
    return true;
  } catch {
    port = null;
    linkReady = false;
    return false;
  }
}

function onAppMessage(msg) {
  nmlog('from host:', msg && msg.type, (msg && msg.state) || '');
  if (msg && msg.type === 'status' && msg.state === 'launching') {
    appLaunching = Date.now() + 30000;
    lastNativeError = 'starting StreamGrab…';
    return;
  }
  if (msg && msg.type === 'pong') {
    linkReady = true;
    appLaunching = 0;
    lastNativeError = '';
    const waiters = pingWaiters; pingWaiters = [];
    waiters.forEach((fn) => fn(true));
    return;
  }
  chrome.runtime.sendMessage({ type: 'app_event', event: msg }).catch(() => {});
}

// ---- detection -------------------------------------------------------------

function classify(url) {
  if (MANIFEST_EXT.test(url)) return /\.mpd/i.test(url) ? 'dash' : 'hls';
  if (PROGRESSIVE_EXT.test(url)) return 'progressive';
  return null;
}

function headerValue(headers, name) {
  if (!headers) return '';
  const h = headers.find((x) => x.name.toLowerCase() === name);
  return h ? (h.value || '') : '';
}

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const h = {
      referer: headerValue(details.requestHeaders, 'referer'),
      cookie: headerValue(details.requestHeaders, 'cookie'),
      userAgent: headerValue(details.requestHeaders, 'user-agent'),
      origin: headerValue(details.requestHeaders, 'origin')
    };
    reqHeaders.set(details.requestId, h);
    sampleFragment(details, h);
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);

// Signed streams (CloudFront etc.) often authorize segments and AES keys with
// a query string or cookies that differ from the manifest's. Watch how the
// page's own player requests them and remember a sample per stream, so the
// desktop app can replay exactly the same credentials.
const FRAGMENT_EXT = /\.(ts|m4s|aac|m4a|mp4|m4v|webm|cmfv|cmfa)(\?|#|$)/i;
const KEY_EXT = /\.key(\?|#|$)/i;

function sampleFragment(details, headers) {
  const tabId = details.tabId;
  if (tabId < 0) return;
  const isKey = KEY_EXT.test(details.url);
  if (!isKey && !FRAGMENT_EXT.test(details.url)) return;
  const list = mediaByTab.get(tabId);
  if (!list || !list.length) return;
  let u;
  try { u = new URL(details.url); } catch { return; }
  const dir = u.origin + u.pathname.replace(/[^/]*$/, '');
  const sample = { query: u.search.replace(/^\?/, ''), headers };
  let changed = false;
  for (const it of list) {
    if (it.kind !== 'hls' && it.kind !== 'dash') continue;
    const itDir = baseDirKey(it.url);
    if (!itDir.startsWith(u.origin)) continue;
    if (!(dir.startsWith(itDir) || itDir.startsWith(dir))) continue;
    const slot = isKey ? 'keySample' : 'fragmentSample';
    if (!it[slot] || it[slot].query !== sample.query) { it[slot] = sample; changed = true; }
  }
  if (changed) refresh(tabId);
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const ct = headerValue(details.responseHeaders, 'content-type');
    const len = parseInt(headerValue(details.responseHeaders, 'content-length'), 10) || 0;

    let kind = classify(details.url);
    if (!kind && MEDIA_CT.test(ct)) {
      kind = /mpegurl/i.test(ct) ? 'hls' : /dash/i.test(ct) ? 'dash' : 'progressive';
    }
    if (!kind) return;
    if (kind === 'progressive' && len && len < MIN_PROGRESSIVE_BYTES) return;

    record(details, kind, ct, len);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders']
);

function cleanup(details) { reqHeaders.delete(details.requestId); }
chrome.webRequest.onCompleted.addListener(cleanup, { urls: ['<all_urls>'] });
chrome.webRequest.onErrorOccurred.addListener(cleanup, { urls: ['<all_urls>'] });

async function record(details, kind, contentType, size) {
  const tabId = details.tabId;
  if (tabId < 0) return;

  // YouTube (googlevideo) chunks are noise — that video is handled via the page
  // URL by yt-dlp, so don't surface the raw stream fragments.
  try { if (/googlevideo\.com$/i.test(new URL(details.url).hostname)) return; } catch {}

  const list = mediaByTab.get(tabId) || [];
  if (list.some((m) => m.url === details.url)) return; // dedup

  let pageUrl = '';
  let pageTitle = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    pageUrl = tab.url || '';
    pageTitle = tab.title || '';
  } catch {}

  const item = {
    url: details.url,
    kind,
    // role: master | media | progressive | dash | unknown
    role: kind === 'progressive' ? 'progressive' : kind === 'dash' ? 'dash' : 'unknown',
    variants: [],
    resolution: '',
    contentType,
    size,
    pageUrl,
    pageTitle,
    headers: reqHeaders.get(details.requestId) || {},
    ts: Date.now()
  };

  list.unshift(item);
  mediaByTab.set(tabId, list.slice(0, 60));
  refresh(tabId);

  if (kind === 'hls') classifyHls(item, tabId);
}

// Fetch an HLS playlist and decide master vs variant. The extension has host
// permissions, so cross-origin fetch + read is allowed.
async function classifyHls(item, tabId) {
  try {
    const res = await fetch(item.url, { credentials: 'include' });
    const text = await res.text();
    if (/#EXT-X-STREAM-INF/i.test(text)) {
      item.role = 'master';
      item.variants = parseMaster(text, item.url);
      item.resolution = bestResolution(item.variants);
    } else if (/#EXTINF/i.test(text)) {
      item.role = 'media';
    }
  } catch {
    // Leave as 'unknown'; the grouping heuristic still collapses siblings.
  }
  refresh(tabId);
}

function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#EXT-X-STREAM-INF/i.test(lines[i].trim())) {
      const res = (lines[i].match(/RESOLUTION=(\d+x\d+)/i) || [])[1] || '';
      const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/i) || [])[1] || '0', 10);
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j++;
      let abs = lines[j] ? lines[j].trim() : '';
      try {
        const u = new URL(abs, baseUrl);
        // Signed manifests (CloudFront Policy/Signature…) keep their credentials
        // in the query string; relative variant names must inherit it, as the
        // page's player does.
        const base = new URL(baseUrl);
        if (!u.search && base.search && u.origin === base.origin) u.search = base.search;
        abs = u.href;
      } catch {}
      out.push({ resolution: res, bandwidth: bw, url: abs, height: res ? parseInt(res.split('x')[1], 10) : 0 });
    }
  }
  return out;
}

function bestResolution(variants) {
  const withH = variants.filter((v) => v.height);
  if (!withH.length) return '';
  return `${withH.reduce((a, b) => (b.height > a.height ? b : a)).height}p`;
}

// ---- presentation ----------------------------------------------------------

function baseDirKey(u) {
  try {
    const x = new URL(u);
    return x.origin + x.pathname.replace(/[^/]*$/, '');
  } catch { return u; }
}
function fileName(u) {
  try { return decodeURIComponent(new URL(u).pathname.split('/').pop() || ''); }
  catch { return u; }
}
function isMasterName(u) {
  const n = fileName(u);
  return /(master|index|playlist|manifest|main)/i.test(n);
}

// Collapse variant playlists into their master, and group leftover siblings so
// one video = one item.
function computePresented(tabId) {
  const items = mediaByTab.get(tabId) || [];

  const variantUrls = new Set();
  const masterDirs = new Set();
  for (const it of items) {
    if (it.role === 'master') {
      masterDirs.add(baseDirKey(it.url));
      for (const v of (it.variants || [])) variantUrls.add(v.url);
    }
  }

  const shown = [];
  const groupPrimary = new Map(); // dirKey -> chosen item (for unknown/media siblings)

  for (const it of items) {
    if (it.role === 'master' || it.role === 'dash' || it.role === 'progressive' || it.role === 'page') {
      shown.push(it);
      continue;
    }
    // media / unknown HLS playlists:
    if (variantUrls.has(it.url)) continue;            // child of a known master
    if (masterDirs.has(baseDirKey(it.url))) continue; // same folder as a master

    const key = baseDirKey(it.url);
    const prev = groupPrimary.get(key);
    if (!prev) {
      groupPrimary.set(key, it);
      shown.push(it);
    } else if (isMasterName(it.url) && !isMasterName(prev.url)) {
      shown[shown.indexOf(prev)] = it; // prefer the master-looking sibling
      groupPrimary.set(key, it);
    }
  }

  return shown.map((it) => toDisplay(it));
}

function fmtSize(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function toDisplay(it) {
  if (it.role === 'page') {
    return {
      url: it.url, kind: 'page', role: 'page',
      name: it.pageTitle || `${it.site} video`,
      quality: it.site || '', sizeText: '', variants: [],
      headers: {}, pageUrl: it.url, pageTitle: it.pageTitle
    };
  }

  let name;
  if (it.role === 'progressive') name = fileName(it.url) || it.pageTitle || 'Video';
  else name = it.pageTitle || fileName(it.url) || 'Video';

  return {
    url: it.url,
    kind: it.kind,
    role: it.role,
    name,
    // Show quality for streams, real byte size only for progressive files.
    quality: it.resolution || '',
    sizeText: it.role === 'progressive' ? fmtSize(it.size) : '',
    variants: it.variants || [],
    headers: it.headers,
    pageUrl: it.pageUrl,
    pageTitle: it.pageTitle,
    // How the page's player authorizes segments / AES keys (see sampleFragment).
    fragmentQuery: it.fragmentSample ? it.fragmentSample.query : '',
    fragmentHeaders: it.fragmentSample ? it.fragmentSample.headers : null,
    keyQuery: it.keySample ? it.keySample.query : ''
  };
}

function refresh(tabId) {
  const presented = computePresented(tabId);
  presentedByTab.set(tabId, presented);
  updateBadge(tabId, presented.length);
  chrome.tabs.sendMessage(tabId, { type: 'media_update', items: presented }).catch(() => {});
}

function updateBadge(tabId, n) {
  // Both reject with 'No tab with id' when the tab is already gone (closed,
  // prerendered, or discarded) - harmless, so swallow it.
  chrome.action.setBadgeBackgroundColor({ color: '#4c8dff' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
}

// Page-level detection for yt-dlp-supported sites (YouTube, etc.). Fires on
// load and on YouTube's in-page (SPA) navigations.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  const url = (tab && tab.url) || changeInfo.url || '';
  if (!url || !matchesSite(url)) return;
  addPageItem(tabId, url, (tab && tab.title) || '');
});

function addPageItem(tabId, url, title) {
  const list = mediaByTab.get(tabId) || [];
  const existing = list.find((i) => i.role === 'page');
  if (existing && existing.url === url) {
    if (title) existing.pageTitle = title;
    refresh(tabId);
    return;
  }
  const filtered = list.filter((i) => i.role !== 'page');
  filtered.unshift({
    url, kind: 'page', role: 'page', variants: [], resolution: '', size: 0,
    contentType: '', pageUrl: url, pageTitle: title, headers: {}, ts: Date.now(),
    site: siteName(url)
  });
  mediaByTab.set(tabId, filtered);
  refresh(tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  mediaByTab.delete(tabId);
  presentedByTab.delete(tabId);
});
chrome.webNavigation?.onCommitted?.addListener?.((d) => {
  if (d.frameId === 0) {
    mediaByTab.delete(d.tabId);
    presentedByTab.delete(d.tabId);
    updateBadge(d.tabId, 0);
  }
});

// ---- messaging from popup / content overlay --------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get_media') {
    const tabId = msg.tabId ?? sender.tab?.id;
    sendResponse({ items: presentedByTab.get(tabId) || [], appConnected: linkReady, lastError: lastNativeError });
    return false;
  }

  if (msg.type === 'get_status') {
    verifyLink().then((ok) => sendResponse({ appConnected: ok, lastError: lastNativeError, log: nmLog.slice(-12) }));
    return true;
  }

  if (msg.type === 'download') {
    const it = msg.item;
    nmlog('download click:', it && it.kind, String(it && it.url).slice(0, 80));
    verifyLink().then((ok) => {
      nmlog('download verifyLink ->', ok, ok ? '' : lastNativeError);
      if (!ok) return sendResponse({ ok: false, reason: 'not_connected', error: lastNativeError });
      const sent = sendToApp('download', {
        url: msg.variantUrl || it.url,      // a chosen quality, or let yt-dlp pick
        kind: it.kind,
        headers: it.headers,
        pageUrl: it.pageUrl,
        pageTitle: it.pageTitle || it.name,
        filename: null,
        size: 0,
        fragmentQuery: it.fragmentQuery || '',
        fragmentHeaders: it.fragmentHeaders || null,
        keyQuery: it.keyQuery || ''
      });
      sendResponse({ ok: sent });
    });
    return true;
  }
});

connectApp();
