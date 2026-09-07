'use strict';

// Floating in-page overlay. Shows a pill when StreamGrab has detected a video on
// this page; expands into a list with a Download button per video.

let items = [];
let panel = null;
let open = false;

// Fullscreen behaviour: while the page (or the player) is fullscreen the pill
// stays hidden so it never covers the video. It appears briefly when the mouse
// moves (like the player's own controls), stays while hovered or while its list
// is open, and is raised above the bottom control bar. Outside fullscreen it
// is always visible, as before.
const FS_PEEK_MS = 2500;
let peekTimer = null;
let hovering = false;

// Two ways a player goes "fullscreen": the Fullscreen API (fires
// fullscreenchange) or CSS alone — the player pins itself over the whole
// viewport and no event fires at all. Cover both: API state, or a <video> /
// embedded player <iframe> whose box fills (nearly) the viewport. The latter
// is re-checked on resize and on a light poll while the pill is showing.
function playerCoversViewport() {
  const vw = window.innerWidth, vh = window.innerHeight;
  if (!vw || !vh) return false;
  for (const el of document.querySelectorAll('video, iframe')) {
    const r = el.getBoundingClientRect();
    if (r.width >= vw * 0.9 && r.height >= vh * 0.8) return true;
  }
  return false;
}

function isFullscreen() {
  if (document.fullscreenElement || document.webkitFullscreenElement) return true;
  return playerCoversViewport();
}

let lastFs = false;
function applyFullscreen() {
  if (!panel) return;
  const fs = isFullscreen();
  panel.classList.toggle('sg-fs', fs);
  panel.classList.toggle('sg-open', open);
  if (!fs) { panel.classList.remove('sg-peek'); clearTimeout(peekTimer); }
  lastFs = fs;
}

// CSS-only fullscreen has no event: poll cheaply (one rect read per video)
// while the pill is on screen, and re-check on resize.
let fsPoll = null;
function startFsPoll() {
  if (fsPoll) return;
  fsPoll = setInterval(() => {
    if (!panel || !items.length) { clearInterval(fsPoll); fsPoll = null; return; }
    if (isFullscreen() !== lastFs) applyFullscreen();
  }, 1000);
}
window.addEventListener('resize', () => { if (panel) applyFullscreen(); }, { passive: true });

function peek() {
  if (!panel || !isFullscreen() || !items.length) return;
  panel.classList.add('sg-peek');
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => {
    if (hovering) { peek(); return; }   // keep it while the mouse is on it
    panel.classList.remove('sg-peek');
  }, FS_PEEK_MS);
}

document.addEventListener('fullscreenchange', applyFullscreen);
document.addEventListener('webkitfullscreenchange', applyFullscreen);
document.addEventListener('mousemove', () => { if (panel && isFullscreen()) peek(); }, { passive: true });

function ensurePanel() {
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = 'streamgrab-overlay';
  panel.innerHTML = `
    <button class="sg-pill" title="StreamGrab: downloadable video found">
      <span class="sg-ico">⬇</span><span class="sg-count">0</span><span class="sg-word"> videos</span>
    </button>
    <div class="sg-list" hidden></div>`;
  document.documentElement.appendChild(panel);
  panel.querySelector('.sg-pill').addEventListener('click', () => { open = !open; renderList(); applyFullscreen(); });
  panel.addEventListener('mouseenter', () => { hovering = true; });
  panel.addEventListener('mouseleave', () => { hovering = false; if (isFullscreen()) peek(); });
  applyFullscreen();
  return panel;
}

// The badge shows what you GET (an MP4); the stream protocol goes in the tag.
function kindLabel(k) {
  return k === 'page' ? 'VIDEO' : k === 'segments' ? 'PARTS' : 'MP4';
}
function streamTag(it) {
  const proto = it.kind === 'hls' ? 'HLS' : it.kind === 'dash' ? 'DASH' : '';
  return [it.quality, it.sizeText, proto].filter(Boolean).join(' · ');
}

function render() {
  if (!items.length) {
    if (panel) panel.style.display = 'none';
    return;
  }
  ensurePanel();
  panel.style.display = 'block';
  panel.querySelector('.sg-count').textContent = items.length;
  panel.querySelector('.sg-word').textContent = items.length === 1 ? ' video' : ' videos';
  renderList();
  applyFullscreen();
  startFsPoll();
}

let storedQuality = 'best';
try { SG_QUALITY.recall().then((v) => { storedQuality = v; }); } catch {}

function qualitySelect(it, i) {
  if (it.noDownload || (it.heights && it.heights[0] === -1)) return '';
  const opts = SG_QUALITY.options(it.heights || []);
  const sel = SG_QUALITY.pick(storedQuality, opts);
  return `<select class="sg-q" data-q="${i}" title="Quality">${opts.map((o) =>
    `<option value="${o.value}"${o.value === sel ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>`;
}

function renderList() {
  const list = panel.querySelector('.sg-list');
  list.hidden = !open;
  if (!open) return;
  list.innerHTML = items.map((it, i) => {
    const tag = streamTag(it);
    const btn = it.noDownload
      ? `<button class="sg-dl sg-off" disabled title="${escapeAttr(it.hint || '')}">Parts only</button>`
      : `<button class="sg-dl" data-i="${i}">Download</button>`;
    return `
    <div class="sg-row" ${it.hint ? `title="${escapeAttr(it.hint)}"` : ''}>
      <div class="sg-meta">
        <span class="sg-badge sg-${it.kind}">${kindLabel(it.kind)}</span>
        <span class="sg-title" title="${escapeAttr(it.name)}">${escapeHtml(it.name)}</span>
        ${tag ? `<span class="sg-size">${escapeHtml(tag)}</span>` : ''}
      </div>
      <div class="sg-act">${qualitySelect(it, i)}${btn}</div>
    </div>`;
  }).join('');

  list.querySelectorAll('select.sg-q').forEach((sel) => {
    sel.addEventListener('change', () => { storedQuality = sel.value; SG_QUALITY.remember(sel.value); });
    // Keep the page's player from swallowing the clicks/keys on our select.
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('keydown', (e) => e.stopPropagation());
  });

  list.querySelectorAll('.sg-dl[data-i]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const it = items[Number(btn.dataset.i)];
      const sel = list.querySelector(`select.sg-q[data-q="${btn.dataset.i}"]`);
      const quality = SG_QUALITY.parse(sel ? sel.value : 'best');
      // After the extension is reloaded/updated, scripts already injected into
      // open tabs are orphaned: chrome.runtime.id is gone and sendMessage throws
      // "Extension context invalidated". Tell the user instead of crashing.
      if (!chrome.runtime || !chrome.runtime.id) { orphaned(btn); return; }
      btn.textContent = 'Sending…';
      try {
        chrome.runtime.sendMessage({ type: 'download', item: it, quality }, (res) => {
          if (chrome.runtime.lastError) { orphaned(btn); return; }
          btn.textContent = res && res.ok ? 'Sent ✓' : 'Open the app';
          btn.classList.toggle('sg-sent', !!(res && res.ok));
          setTimeout(() => { btn.textContent = 'Download'; btn.classList.remove('sg-sent'); }, 2500);
        });
      } catch {
        orphaned(btn);
      }
    });
  });
}

function orphaned(btn) {
  btn.textContent = 'Reload page';
  btn.title = 'StreamGrab was updated; reload this page to reconnect.';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'media_update') { items = msg.items || []; render(); }
});

try {
  chrome.runtime.sendMessage({ type: 'get_media' }, (res) => {
    if (chrome.runtime.lastError) return;
    if (res && res.items) { items = res.items; render(); }
  });
} catch {
  // orphaned script; nothing to do until the page reloads
}
