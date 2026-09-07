'use strict';

const listEl = document.getElementById('list');
const connEl = document.getElementById('conn');
const errEl = document.getElementById('err');

function showError(msg) {
  if (!msg) { errEl.classList.remove('show'); return; }
  errEl.innerHTML = `<b>Not connected to the app.</b><br>Reason: ${esc(msg)}`;
  errEl.classList.add('show');
}

function kindLabel(k) {
  return k === 'hls' ? 'HLS' : k === 'dash' ? 'DASH' : k === 'page' ? 'VIDEO' : 'MP4';
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function setConn(on, pending) {
  connEl.textContent = on ? '● app connected' : pending ? '◌ starting app…' : '○ app not running';
  connEl.className = 'conn ' + (on ? 'on' : pending ? '' : 'off');
}

function render(items) {
  if (!items.length) {
    listEl.innerHTML = `<div class="empty">No video detected on this tab yet.<br>
      Start playing a video, then reopen this popup.</div>`;
    return;
  }
  listEl.innerHTML = items.map((it, i) => {
    const tag = it.quality || it.sizeText || '';
    return `
    <div class="row">
      <span class="badge ${it.kind}">${kindLabel(it.kind)}</span>
      <div class="t">
        <div class="n" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="s">${esc(tag)}</div>
      </div>
      <button data-i="${i}">Download</button>
    </div>`;
  }).join('');

  listEl.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const it = items[Number(btn.dataset.i)];
      btn.textContent = 'Sending…';
      chrome.runtime.sendMessage({ type: 'download', item: it }, (res) => {
        btn.textContent = res && res.ok ? 'Sent ✓' : 'Failed';
        setTimeout(() => { btn.textContent = 'Download'; }, 2000);
        if (res) setConn(res.ok);
      });
    });
  });
}

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // List first (instant), then verify the app link (may take a while if the
  // native host has to start the app).
  chrome.runtime.sendMessage({ type: 'get_media', tabId: tab.id }, (res) => {
    if (!res) { setConn(false); showError('extension background not responding'); render([]); return; }
    render(res.items || []);
    setConn(res.appConnected, !res.appConnected);
    chrome.runtime.sendMessage({ type: 'get_status' }, (st) => {
      if (!st) return;
      setConn(st.appConnected);
      showError(st.appConnected ? '' : (st.lastError || 'app not running or unreachable'));
      if (!st.appConnected && st.log && st.log.length) {
        errEl.innerHTML += `<pre class="log">${esc(st.log.join('\n'))}</pre>`;
      }
    });
  });
})();
