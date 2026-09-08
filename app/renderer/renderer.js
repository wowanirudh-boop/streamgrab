'use strict';

const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');
const countsEl = document.getElementById('counts');
const urlInput = document.getElementById('url');

function fmtSize(bytes) {
  if (!bytes) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// One row = seven cells. Returned as [className, innerHTML] pairs so render()
// can update only the cells whose content changed.
function rowCells(it) {
  const kind = it.kind === 'auto' ? 'progressive' : it.kind;
  const barCls = ['bar'];
  if (it.state === 'done') barCls.push('done');
  else if (it.state === 'error') barCls.push('error');
  else if (it.state === 'canceled') barCls.push('canceled');

  let statusCol;
  if (it.state === 'error') statusCol = `<span class="state-error" title="${esc(it.error)}">Failed</span>`;
  else if (it.state === 'done') statusCol = `<span class="state-done">Done</span>`;
  else if (it.state === 'canceled') statusCol = `<span class="state-canceled">Canceled</span>`;
  else statusCol = `<div class="${barCls.join(' ')}"><span style="width:${it.percent || 0}%"></span></div>
                    <div class="pct">${(it.percent || 0).toFixed(0)}%</div>`;

  const actions = [];
  if (it.state === 'downloading' || it.state === 'queued')
    actions.push(`<button data-act="cancel" data-id="${it.id}">Stop</button>`);
  if (it.state === 'error' || it.state === 'canceled')
    actions.push(`<button data-act="retry" data-id="${it.id}">Retry</button>`);
  if (it.state === 'done')
    actions.push(`<button data-act="folder" data-id="${it.id}">Open</button>`);
  actions.push(`<button data-act="remove" data-id="${it.id}" title="Remove from list">✕</button>`);

  return [
    ['c-name', `
        <div class="name" title="${esc(it.title)}">${esc(it.title)}</div>
        <div class="suburl" title="${esc(it.pageUrl || it.url)}">${esc(it.pageUrl || it.url)}</div>
        ${it.state === 'error' ? `<div class="errmsg" title="${esc(it.error)}">${esc(it.error)}</div>` : ''}`],
    ['c-kind', `<span class="badge ${kind}">${kind}</span>${it.formatLabel ? `<div class="fmt">${esc(it.formatLabel)}</div>` : ''}`],
    ['c-size', fmtSize(it.size)],
    ['c-prog', statusCol],
    ['c-speed', esc(it.speed || (it.state === 'downloading' ? '…' : ''))],
    ['c-eta', esc(it.eta || '')],
    ['c-actions', `<div class="row-actions">${actions.join('')}</div>`]
  ];
}

// Rows are kept by job id and patched cell-by-cell. Rebuilding the whole
// table's innerHTML on every update (as this used to) meant that during a
// download, when progress updates arrive many times a second, the button
// under the pointer was replaced between mousedown and mouseup and the click
// hit nothing: "✕ does nothing" while something else was downloading.
/** @type {Map<string, {tr: HTMLTableRowElement, cells: string[]}>} */
const rowCache = new Map();

function render(items) {
  emptyEl.classList.toggle('show', items.length === 0);

  const seen = new Set();
  let prev = null; // last row placed, to keep DOM order == list order
  for (const it of items) {
    const cells = rowCells(it);
    let entry = rowCache.get(it.id);
    if (!entry) {
      const tr = document.createElement('tr');
      for (const [cls, html] of cells) {
        const td = document.createElement('td');
        td.className = cls;
        td.innerHTML = html;
        tr.appendChild(td);
      }
      entry = { tr, cells: cells.map((c) => c[1]) };
      rowCache.set(it.id, entry);
    } else {
      cells.forEach(([, html], i) => {
        if (entry.cells[i] !== html) {
          entry.tr.children[i].innerHTML = html;
          entry.cells[i] = html;
        }
      });
    }
    const expectedAt = prev ? prev.nextSibling : rowsEl.firstChild;
    if (expectedAt !== entry.tr) rowsEl.insertBefore(entry.tr, expectedAt);
    prev = entry.tr;
    seen.add(it.id);
  }
  for (const [id, entry] of rowCache) {
    if (!seen.has(id)) { entry.tr.remove(); rowCache.delete(id); }
  }

  const active = items.filter((i) => i.state === 'downloading').length;
  const done = items.filter((i) => i.state === 'done').length;
  countsEl.textContent = `${active} active · ${done} done · ${items.length} total`;

  const finished = items.filter((i) => ['done', 'error', 'canceled'].includes(i.state)).length;
  clearDoneBtn.disabled = finished === 0;
  clearAllBtn.disabled = items.length === 0;
  clearDoneBtn.textContent = finished ? `Clear completed (${finished})` : 'Clear completed';
}

rowsEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === 'cancel') await window.sg.cancel(id);
  else if (act === 'retry') await window.sg.retry(id);
  else if (act === 'remove') await window.sg.remove(id);
  else if (act === 'folder') await window.sg.openFolder(id);
});

function parseQuality(v) {
  if (v === 'audio') return { kind: 'audio' };
  const m = /^h(\d+)$/.exec(v || '');
  return m ? { kind: 'height', height: parseInt(m[1], 10) } : { kind: 'best' };
}

async function addUrl() {
  const url = urlInput.value.trim();
  if (!url) return;
  await window.sg.addUrl(url, parseQuality(document.getElementById('quality').value));
  urlInput.value = '';
}
document.getElementById('addBtn').addEventListener('click', addUrl);
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addUrl(); });

document.getElementById('dirBtn').addEventListener('click', async () => {
  const res = await window.sg.chooseDir();
  if (res.ok) document.getElementById('dirLabel').textContent = shortDir(res.dir);
});

function shortDir(dir) {
  if (!dir) return '…';
  const parts = dir.split(/[\\/]/);
  return parts.slice(-2).join('\\');
}

// Live updates
window.sg.onQueueUpdate(render);

document.getElementById('logBtn').addEventListener('click', () => window.sg.openLog());

const clearDoneBtn = document.getElementById('clearDoneBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
clearDoneBtn.addEventListener('click', async () => {
  await window.sg.clear('completed');
  render(await window.sg.getQueue());
});
clearAllBtn.addEventListener('click', async () => {
  if (!confirm('Cancel all downloads and clear the entire list?')) return;
  await window.sg.clear('all');
  render(await window.sg.getQueue());
});

const loginToggle = document.getElementById('loginToggle');
loginToggle.addEventListener('change', () => window.sg.setSettings({ launchAtLogin: loginToggle.checked }));

// Footer: is the bridge up and is the Chrome native host registered?
async function showBridgeInfo() {
  const info = await window.sg.bridgeInfo();
  const conn = document.getElementById('conn');
  const text = document.getElementById('connText');
  const host = info.host || {};
  // Release builds keep no log file unless started with --sg-debug.
  const logBtn = document.getElementById('logBtn');
  if (!info.logPath) {
    logBtn.disabled = true;
    logBtn.title = 'Logging is off in release builds. Start StreamGrab with --sg-debug to enable it.';
  }
  if (info.port && host.ok) {
    conn.style.color = '#34c77b';
    text.textContent = `Chrome link ready on 127.0.0.1:${info.port}${info.debug ? ' · DEBUG' : ''}`;
  } else if (info.port) {
    conn.style.color = '#ffb454';
    text.textContent = `Bridge on 127.0.0.1:${info.port} — host not registered: ${host.error || 'unknown'}`;
  } else {
    conn.style.color = '#ff5c6c';
    text.textContent = 'Bridge failed to start';
  }
}

(async function init() {
  const s = await window.sg.getSettings();
  document.getElementById('dirLabel').textContent = shortDir(s.downloadDir);
  loginToggle.checked = !!s.launchAtLogin;
  render(await window.sg.getQueue());
  showBridgeInfo();
})();
