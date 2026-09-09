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
// Playlists whose URL hides the extension (".../master.m3u8/...", "?file=x.m3u8",
// "/hls/stream", "/manifest") are confirmed by fetching them (see classifyManifest).
const MANIFEST_ANY = /m3u8|\.mpd\b/i;
const SNIFF_URL = /(hls|m3u|playlist|manifest|chunklist|mpd|dash)/i;
const SNIFF_CT = /^(text\/plain|application\/octet-stream|binary\/octet-stream|application\/json)?\s*(;|$)/i;
const SNIFF_MAX_BYTES = 2 * 1024 * 1024;
const PROGRESSIVE_EXT = /\.(mp4|webm|m4v|mov|flv|mkv|avi)(\?|#|$)/i;
const MEDIA_CT = /(application\/(vnd\.apple\.mpegurl|x-mpegurl|mpegurl|dash\+xml)|audio\/(mpegurl|x-mpegurl)|video\/(vnd\.mpeg\.dash\.mpd|mp4|webm|x-flv|quicktime|x-matroska))/i;
const MASTER_NAME = /(master|index|playlist|manifest|main|chunklist)?\.?m3u8/i;
const MIN_PROGRESSIVE_BYTES = 300 * 1024;
// Query params that only select a byte range of the same file (range requests
// from MediaSource players). Stripped so one file = one item, not one per chunk.
const RANGE_PARAMS = /^(range|bytes|byterange|start|end|offset)$/i;

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
  /https?:\/\/(www\.)?instagram\.com\/(reel|p|tv)\//i,
  // VK Video: signed okcdn DASH/HLS; yt-dlp's vk extractor handles the page.
  /https?:\/\/(www\.|m\.)?(vk\.com|vkvideo\.ru|vk\.ru)\/(video-?\d+_\d+|clip-?\d+_\d+)/i
];
function matchesSite(url) { return SITE_PATTERNS.some((re) => re.test(url)); }

// CDN hosts whose sniffed streams are redundant once a page item exists for
// the tab. An X status page autoplays and preloads dozens of timeline videos
// from video.twimg.com, each with its own HLS master and variant playlists:
// listing them gives 70+ identically-named rows, none of them obviously "the
// tweet's video". yt-dlp's twitter extractor gets it from the status URL, so
// only that page item is shown. (YouTube's googlevideo chunks are dropped at
// record time for the same reason.)
const SITE_CDNS = [
  { page: /https?:\/\/(twitter|x)\.com\/[^/]+\/status\//i, cdn: /(^|\.)twimg\.com$/i }
];
function redundantCdnFor(pageUrl) {
  const hit = SITE_CDNS.find((s) => s.page.test(pageUrl || ''));
  return hit ? hit.cdn : null;
}
function hostOf(u) {
  try { return new URL(u).hostname; } catch { return ''; }
}
function siteName(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'YouTube';
  if (/vimeo\.com/i.test(url)) return 'Vimeo';
  if (/dailymotion\.com/i.test(url)) return 'Dailymotion';
  if (/twitch\.tv/i.test(url)) return 'Twitch';
  if (/(twitter|x)\.com/i.test(url)) return 'X';
  if (/tiktok\.com/i.test(url)) return 'TikTok';
  if (/facebook\.com/i.test(url)) return 'Facebook';
  if (/instagram\.com/i.test(url)) return 'Instagram';
  if (/vk\.com|vkvideo\.ru|vk\.ru/i.test(url)) return 'VK';
  return 'Video';
}

/** @type {Map<number, Array>} tabId -> raw detected items */
const mediaByTab = new Map();
/** @type {Map<number, Array>} tabId -> cleaned items for display */
const presentedByTab = new Map();
/** @type {Map<string, object>} requestId -> captured request headers */
const reqHeaders = new Map();

// ---- detection state persistence ------------------------------------------
//
// Chrome evicts an idle MV3 service worker after ~30 s. A video's master
// playlist is fetched ONCE at page load; segments keep arriving for minutes.
// Without persistence, an eviction mid-playback loses the playlist and the
// popup ends up listing only the segments seen since the restart. So the raw
// per-tab list lives in chrome.storage.session (memory-backed, cleared when the
// browser closes) and is restored before any event is processed.
const restored = chrome.storage.session.get('mediaByTab').then((r) => {
  const saved = r && r.mediaByTab;
  if (saved && typeof saved === 'object') {
    for (const [tabId, list] of Object.entries(saved)) {
      if (Array.isArray(list) && list.length) mediaByTab.set(Number(tabId), list);
    }
    for (const tabId of mediaByTab.keys()) presentedByTab.set(tabId, computePresented(tabId));
  }
}).catch(() => {});

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    chrome.storage.session.set({ mediaByTab: Object.fromEntries(mediaByTab) }).catch(() => {});
  }, 250);
}

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

// Same file requested in byte-range chunks must collapse to one item.
function dedupKey(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (RANGE_PARAMS.test(k)) u.searchParams.delete(k);
    u.hash = '';
    return u.href;
  } catch { return url; }
}

// "bytes 0-699999/123456789" -> 123456789
function contentRangeTotal(headers) {
  const m = headerValue(headers, 'content-range').match(/\/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
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

async function sampleFragment(details, headers) {
  const tabId = details.tabId;
  if (tabId < 0) return;
  await restored;
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
    let len = parseInt(headerValue(details.responseHeaders, 'content-length'), 10) || 0;
    // A range chunk (206) reports only its own length; the file's real size is
    // the total in Content-Range.
    if (details.statusCode === 206) len = contentRangeTotal(details.responseHeaders) || len;

    let kind = classify(details.url);
    let guessed = false;
    if (!kind && MEDIA_CT.test(ct)) {
      kind = /mpegurl/i.test(ct) ? 'hls' : /dash|mpd/i.test(ct) ? 'dash' : 'progressive';
    }
    // Playlists served with a bland content-type and no extension in the URL
    // (".../master.m3u8/index", "?playlist=hls", "/stream/manifest"): take them
    // as candidates and let classifyManifest() confirm by reading the body.
    if (!kind && MANIFEST_ANY.test(details.url)) {
      kind = /\.mpd\b/i.test(details.url) ? 'dash' : 'hls';
      guessed = true;
    } else if (!kind && SNIFF_CT.test(ct) && SNIFF_URL.test(details.url) && (!len || len < SNIFF_MAX_BYTES)) {
      kind = 'hls';
      guessed = true;
    }
    if (!kind) return;
    if (kind === 'progressive' && len && len < MIN_PROGRESSIVE_BYTES) return;

    record(details, kind, ct, len, guessed);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders']
);

function cleanup(details) { reqHeaders.delete(details.requestId); }
chrome.webRequest.onCompleted.addListener(cleanup, { urls: ['<all_urls>'] });
chrome.webRequest.onErrorOccurred.addListener(cleanup, { urls: ['<all_urls>'] });

async function record(details, kind, contentType, size, guessed = false) {
  const tabId = details.tabId;
  if (tabId < 0) return;
  await restored;

  // YouTube (googlevideo) chunks are noise — that video is handled via the page
  // URL by yt-dlp, so don't surface the raw stream fragments.
  try { if (/googlevideo\.com$/i.test(new URL(details.url).hostname)) return; } catch {}

  const list = mediaByTab.get(tabId) || [];
  const key = dedupKey(details.url);
  const existing = list.find((m) => m.key === key || m.url === details.url);
  if (existing) {
    // Another range chunk of a file we already know: just learn its true size.
    if (size > (existing.size || 0)) { existing.size = size; refresh(tabId); }
    return;
  }

  let pageUrl = '';
  let pageTitle = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    pageUrl = tab.url || '';
    pageTitle = tab.title || '';
  } catch {}

  const item = {
    url: details.url,
    key,
    kind,
    // role: master | media | progressive | dash | unknown
    role: kind === 'progressive' ? 'progressive' : kind === 'dash' ? 'dash' : 'unknown',
    guessed,          // true = must be confirmed by reading the body
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
  mediaByTab.set(tabId, list.slice(0, 80));
  // Guessed candidates are not shown until the body confirms them.
  if (!guessed) refresh(tabId); else persist();

  if (kind === 'hls' || kind === 'dash') classifyManifest(item, tabId);
}

// Video representations of a DASH MPD: one entry per quality (no URL — the
// app selects by height through yt-dlp, which handles the audio pairing).
function parseMpdVariants(text) {
  const out = [];
  for (const m of text.matchAll(/<Representation\b([^>]*)>/gi)) {
    const attrs = m[1];
    const h = parseInt((attrs.match(/\bheight="(\d+)"/i) || [])[1] || '0', 10);
    if (!h) continue; // audio representations have no height
    const w = parseInt((attrs.match(/\bwidth="(\d+)"/i) || [])[1] || '0', 10);
    const bw = parseInt((attrs.match(/\bbandwidth="(\d+)"/i) || [])[1] || '0', 10);
    out.push({ resolution: w ? `${w}x${h}` : '', bandwidth: bw, url: '', height: h });
  }
  return out;
}

// Best height listed in a DASH MPD (Representation height="…" / maxHeight).
function dashResolution(text) {
  const hs = [...text.matchAll(/(?:maxHeight|height)="(\d+)"/gi)].map((m) => parseInt(m[1], 10)).filter(Boolean);
  return hs.length ? `${Math.max(...hs)}p` : '';
}

// Fetch a playlist and decide master vs variant (HLS), or confirm a guessed
// DASH manifest. The extension has host permissions, so cross-origin fetch +
// read is allowed. Guessed candidates whose body is not a playlist are dropped.
async function classifyManifest(item, tabId) {
  let text = null;
  try {
    const res = await fetch(item.url, { credentials: 'include' });
    text = await res.text();
  } catch {
    // Network/CORS failure: keep a real (.m3u8) item as 'unknown'; drop a guess.
    if (item.guessed) dropItem(tabId, item);
    refresh(tabId);
    return;
  }
  const head = text.slice(0, 4096);
  if (item.kind === 'dash') {
    if (!/<MPD[\s>]/i.test(head)) {
      if (item.guessed) dropItem(tabId, item);   // a real .mpd we couldn't read stays listed
      refresh(tabId);
      return;
    }
    item.variants = parseMpdVariants(text);
    item.resolution = dashResolution(text);
    item.guessed = false;
  } else if (/#EXT-X-STREAM-INF/i.test(text)) {
    item.role = 'master';
    item.variants = parseMaster(text, item.url);
    item.renditions = parseRenditions(text, item.url);
    item.resolution = bestResolution(item.variants);
    // Variants listed as bare names need the manifest's (signed) query carried
    // over; variants with their own query must be left alone (see downloader).
    item.variantsNeedQuery = item.variants.some((v) => v.inherited);
    item.guessed = false;
  } else if (/#EXTINF/i.test(text)) {
    item.role = 'media';
    item.guessed = false;
  } else if (item.guessed || !/^\s*#EXTM3U/i.test(head)) {
    // Not a playlist at all (JSON, HTML error page, ...).
    dropItem(tabId, item);
  }
  refresh(tabId);
}

function dropItem(tabId, item) {
  const list = mediaByTab.get(tabId);
  if (!list) return;
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
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
      let inherited = false;
      try {
        const u = new URL(abs, baseUrl);
        // Signed manifests (CloudFront Policy/Signature…) keep their credentials
        // in the query string; relative variant names must inherit it, as the
        // page's player does.
        const base = new URL(baseUrl);
        if (!u.search && base.search && u.origin === base.origin) { u.search = base.search; inherited = true; }
        abs = u.href;
      } catch {}
      out.push({ resolution: res, bandwidth: bw, url: abs, height: res ? parseInt(res.split('x')[1], 10) : 0, inherited });
    }
  }
  return out;
}

// Audio / subtitle / alternate-video renditions (#EXT-X-MEDIA ... URI="...")
// are separate playlists that belong to the same master; collect them so they
// collapse into it instead of showing up as extra "videos".
function parseRenditions(text, baseUrl) {
  const out = [];
  const base = new URL(baseUrl);
  for (const line of text.split(/\r?\n/)) {
    if (!/^#EXT-X-MEDIA:/i.test(line.trim())) continue;
    const m = line.match(/URI="([^"]+)"/i);
    if (!m) continue;
    try {
      const u = new URL(m[1], baseUrl);
      if (!u.search && base.search && u.origin === base.origin) u.search = base.search;
      out.push(u.href);
    } catch {}
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

// Segments of a fragmented stream (HLS-fMP4 / DASH) arrive as ".mp4"/".m4s"
// files that look progressive: "seg-12-v1-a1.mp4", "chunk_0034.mp4",
// "video_1080p_00017.m4s". Normalising digit runs gives siblings one key.
function segmentKey(u) {
  return baseDirKey(u) + fileName(u).replace(/\d+/g, '#');
}

// Collapse variant playlists into their master, and group leftover siblings so
// one video = one item.
function computePresented(tabId) {
  const raw = mediaByTab.get(tabId) || [];

  // With a page item for a site whose CDN we know, the sniffed streams from
  // that CDN are noise (see SITE_CDNS): the page item covers the video.
  const pageItem = raw.find((i) => i.role === 'page');
  const cdnRe = pageItem ? redundantCdnFor(pageItem.url) : null;
  const items = cdnRe ? raw.filter((i) => i.role === 'page' || !cdnRe.test(hostOf(i.url))) : raw;

  const variantUrls = new Set();
  const masterDirs = new Set();
  const playlistDirs = new Set(); // dirs of any playlist: segments there are not videos
  for (const it of items) {
    if (it.guessed) continue;
    if (it.role === 'master') {
      masterDirs.add(baseDirKey(it.url));
      for (const v of (it.variants || [])) { variantUrls.add(v.url); playlistDirs.add(baseDirKey(v.url)); }
      for (const r of (it.renditions || [])) { variantUrls.add(r); playlistDirs.add(baseDirKey(r)); }
    }
    if (it.role === 'master' || it.role === 'media' || it.role === 'dash' ||
        (it.role === 'unknown' && it.kind === 'hls')) playlistDirs.add(baseDirKey(it.url));
  }

  // Numbered-sibling groups among progressive items (3+ = a segmented stream).
  const segGroups = new Map();
  for (const it of items) {
    if (it.role !== 'progressive') continue;
    const k = segmentKey(it.url);
    segGroups.set(k, (segGroups.get(k) || 0) + 1);
  }

  const shown = [];
  const groupPrimary = new Map(); // dirKey -> chosen item (for unknown/media siblings)
  const segShown = new Set();     // segment groups already represented by one row

  for (const it of items) {
    if (it.guessed) continue; // unconfirmed candidate
    if (it.role === 'progressive') {
      // A fragment of a stream we already list via its playlist: hide it.
      if (playlistDirs.has(baseDirKey(it.url))) continue;
      const k = segmentKey(it.url);
      const n = segGroups.get(k) || 0;
      if (n >= 3) {
        // Fragments without a known playlist: one informational row, not N
        // bogus "videos" (the app cannot make a full video from a fragment).
        if (segShown.has(k)) continue;
        segShown.add(k);
        shown.push({ ...it, role: 'segments', segmentCount: n });
        continue;
      }
      shown.push(it);
      continue;
    }
    if (it.role === 'master' || it.role === 'dash' || it.role === 'page') {
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
  if (it.role === 'segments') {
    return {
      url: it.url, kind: 'segments', role: 'segments',
      name: it.pageTitle || fileName(it.url).replace(/\d+/g, '#'),
      quality: '', sizeText: `${it.segmentCount} parts`, variants: [],
      headers: {}, pageUrl: it.pageUrl, pageTitle: it.pageTitle,
      noDownload: true,
      hint: 'Only stream fragments were seen; the playlist was not detected. Reload the page and start playback again.'
    };
  }
  if (it.role === 'page') {
    return {
      url: it.url, kind: 'page', role: 'page',
      name: it.pageTitle || `${it.site} video`,
      quality: it.site || '', sizeText: '', variants: [], heights: [],
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
    // Resolutions the manifest actually offers, for the quality picker.
    // A single progressive file has exactly one quality: no ladder.
    heights: it.role === 'progressive' ? [-1] : (it.variants || []).map((v) => v.height).filter(Boolean),
    headers: it.headers,
    pageUrl: it.pageUrl,
    pageTitle: it.pageTitle,
    // How the page's player authorizes segments / AES keys (see sampleFragment).
    fragmentQuery: it.fragmentSample ? it.fragmentSample.query : '',
    fragmentHeaders: it.fragmentSample ? it.fragmentSample.headers : null,
    keyQuery: it.keySample ? it.keySample.query : '',
    variantsNeedQuery: !!it.variantsNeedQuery
  };
}

function refresh(tabId) {
  const presented = computePresented(tabId);
  presentedByTab.set(tabId, presented);
  updateBadge(tabId, presented.length);
  chrome.tabs.sendMessage(tabId, { type: 'media_update', items: presented }).catch(() => {});
  persist();
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

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await restored;
  mediaByTab.delete(tabId);
  presentedByTab.delete(tabId);
  persist();
});
chrome.webNavigation?.onCommitted?.addListener?.(async (d) => {
  if (d.frameId === 0) {
    await restored;
    mediaByTab.delete(d.tabId);
    presentedByTab.delete(d.tabId);
    updateBadge(d.tabId, 0);
    persist();
  }
});

// ---- messaging from popup / content overlay --------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get_media') {
    const tabId = msg.tabId ?? sender.tab?.id;
    restored.then(() => {
      if (!presentedByTab.has(tabId) && mediaByTab.has(tabId)) presentedByTab.set(tabId, computePresented(tabId));
      sendResponse({ items: presentedByTab.get(tabId) || [], appConnected: linkReady, lastError: lastNativeError });
    });
    return true;
  }

  // Everything the detector saw on this tab, for diagnosing a site that IDM
  // handles and we don't. Copied to the clipboard by the popup.
  if (msg.type === 'get_media_raw') {
    restored.then(() => {
      const raw = (mediaByTab.get(msg.tabId) || []).map((it) => ({
        url: it.url, kind: it.kind, role: it.role, guessed: !!it.guessed,
        contentType: it.contentType, size: it.size, variants: (it.variants || []).length,
        fragmentSample: !!it.fragmentSample, keySample: !!it.keySample, ts: new Date(it.ts).toISOString()
      }));
      sendResponse({ raw, presented: presentedByTab.get(msg.tabId) || [], log: nmLog.slice(-20) });
    });
    return true;
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
        // Always the master/manifest/page URL: the app selects the quality via
        // yt-dlp's format selector so audio pairing and muxing still work.
        url: it.url,
        quality: msg.quality || { kind: 'best' },
        kind: it.kind,
        headers: it.headers,
        pageUrl: it.pageUrl,
        pageTitle: it.pageTitle || it.name,
        filename: null,
        size: 0,
        fragmentQuery: it.fragmentQuery || '',
        fragmentHeaders: it.fragmentHeaders || null,
        keyQuery: it.keyQuery || '',
        variantsNeedQuery: !!it.variantsNeedQuery
      });
      sendResponse({ ok: sent });
    });
    return true;
  }
});

connectApp();
