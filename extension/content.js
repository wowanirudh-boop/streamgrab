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

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function applyFullscreen() {
  if (!panel) return;
  const fs = isFullscreen();
  panel.classList.toggle('sg-fs', fs);
  panel.classList.toggle('sg-open', open);
  if (!fs) { panel.classList.remove('sg-peek'); clearTimeout(peekTimer); }
}

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

function kindLabel(k) {
  return k === 'hls' ? 'HLS' : k === 'dash' ? 'DASH' : k === 'page' ? 'VIDEO' : 'MP4';
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
}

function renderList() {
  const list = panel.querySelector('.sg-list');
  list.hidden = !open;
  if (!open) return;
  list.innerHTML = items.map((it, i) => {
    const tag = it.quality ? it.quality : it.sizeText ? it.sizeText : '';
    return `
    <div class="sg-row">
      <div class="sg-meta">
        <span class="sg-badge sg-${it.kind}">${kindLabel(it.kind)}</span>
        <span class="sg-title" title="${escapeAttr(it.name)}">${escapeHtml(it.name)}</span>
        ${tag ? `<span class="sg-size">${escapeHtml(tag)}</span>` : ''}
      </div>
      <button class="sg-dl" data-i="${i}">Download</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.sg-dl').forEach((btn) => {
    btn.addEventListener('click', () => {
      const it = items[Number(btn.dataset.i)];
      // After the extension is reloaded/updated, scripts already injected into
      // open tabs are orphaned: chrome.runtime.id is gone and sendMessage throws
      // "Extension context invalidated". Tell the user instead of crashing.
      if (!chrome.runtime || !chrome.runtime.id) { orphaned(btn); return; }
      btn.textContent = 'Sending…';
      try {
        chrome.runtime.sendMessage({ type: 'download', item: it }, (res) => {
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
