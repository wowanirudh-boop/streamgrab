'use strict';

const listEl = document.getElementById('list');
const connEl = document.getElementById('conn');
const errEl = document.getElementById('err');
const reportEl = document.getElementById('report');

function showError(msg) {
  if (!msg) { errEl.classList.remove('show'); return; }
  errEl.innerHTML = `<b>Not connected to the app.</b><br>Reason: ${esc(msg)}`;
  errEl.classList.add('show');
}

// The badge shows what you GET (an MP4), like IDM does; the stream protocol
// (HLS/DASH) is shown in the small line under the name.
function kindLabel(k) {
  return k === 'page' ? 'VIDEO' : k === 'segments' ? 'PARTS' : 'MP4';
}
function streamTag(it) {
  const proto = it.kind === 'hls' ? 'HLS stream' : it.kind === 'dash' ? 'DASH stream' : '';
  return [it.quality, it.sizeText, proto].filter(Boolean).join(' · ');
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function setConn(on, pending) {
  connEl.textContent = on ? '● app connected' : pending ? '◌ starting app…' : '○ app not running';
  connEl.className = 'conn ' + (on ? 'on' : pending ? '' : 'off');
}

// Quality <select> for one row. A single progressive file (heights [-1]) has
// nothing to choose; streams list what the manifest offers; page items get
// the standard ladder.
function qualitySelect(it, i, stored) {
  if (it.noDownload || (it.heights && it.heights[0] === -1)) return '';
  const opts = SG_QUALITY.options(it.heights || []);
  const sel = SG_QUALITY.pick(stored, opts);
  return `<select class="q" data-q="${i}" title="Quality">${opts.map((o) =>
    `<option value="${o.value}"${o.value === sel ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
}

async function render(items) {
  if (!items.length) {
    listEl.innerHTML = `<div class="empty">No video detected on this tab yet.<br>
      Start playing a video, then reopen this popup.</div>`;
    return;
  }
  const stored = await SG_QUALITY.recall();
  listEl.innerHTML = items.map((it, i) => {
    const tag = streamTag(it);
    const btn = it.noDownload
      ? `<button class="off" disabled title="${esc(it.hint || '')}">Parts only</button>`
      : `<button data-i="${i}">Download</button>`;
    return `
    <div class="row${it.noDownload ? ' dim' : ''}" ${it.hint ? `title="${esc(it.hint)}"` : ''}>
      <span class="badge ${it.kind}">${kindLabel(it.kind)}</span>
      <div class="t">
        <div class="n" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="s">${esc(tag)}</div>
      </div>
      ${qualitySelect(it, i, stored)}
      ${btn}
    </div>`;
  }).join('');

  listEl.querySelectorAll('select.q').forEach((sel) => {
    sel.addEventListener('change', () => SG_QUALITY.remember(sel.value));
  });

  listEl.querySelectorAll('button[data-i]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const it = items[Number(btn.dataset.i)];
      const sel = listEl.querySelector(`select.q[data-q="${btn.dataset.i}"]`);
      const quality = SG_QUALITY.parse(sel ? sel.value : 'best');
      btn.textContent = 'Sending…';
      chrome.runtime.sendMessage({ type: 'download', item: it, quality }, (res) => {
        btn.textContent = res && res.ok ? 'Sent ✓' : 'Failed';
        setTimeout(() => { btn.textContent = 'Download'; }, 2000);
        if (res) setConn(res.ok);
      });
    });
  });
}

// "Copy report": everything the detector saw on this tab, as JSON, for
// diagnosing a site where the right video is not being offered.
async function copyReport(tabId, tabUrl) {
  const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'get_media_raw', tabId }, r));
  const report = { page: tabUrl, when: new Date().toISOString(), ...(res || {}) };
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    reportEl.textContent = 'copied ✓';
  } catch {
    reportEl.textContent = 'copy failed';
  }
  setTimeout(() => { reportEl.textContent = 'copy report'; }, 1500);
}

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  reportEl.addEventListener('click', () => copyReport(tab.id, tab.url));
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
