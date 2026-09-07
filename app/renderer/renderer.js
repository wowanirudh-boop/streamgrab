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

function render(items) {
  emptyEl.classList.toggle('show', items.length === 0);

  rowsEl.innerHTML = items.map((it) => {
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
    actions.push(`<button data-act="remove" data-id="${it.id}">✕</button>`);

    return `<tr>
      <td class="c-name">
        <div class="name" title="${esc(it.title)}">${esc(it.title)}</div>
        <div class="suburl" title="${esc(it.pageUrl || it.url)}">${esc(it.pageUrl || it.url)}</div>
        ${it.state === 'error' ? `<div class="errmsg" title="${esc(it.error)}">${esc(it.error)}</div>` : ''}
      </td>
      <td class="c-kind"><span class="badge ${kind}">${kind}</span></td>
      <td class="c-size">${fmtSize(it.size)}</td>
      <td class="c-prog">${statusCol}</td>
      <td class="c-speed">${esc(it.speed || (it.state === 'downloading' ? '…' : ''))}</td>
      <td class="c-eta">${esc(it.eta || '')}</td>
      <td class="c-actions"><div class="row-actions">${actions.join('')}</div></td>
    </tr>`;
  }).join('');

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

async function addUrl() {
  const url = urlInput.value.trim();
  if (!url) return;
  await window.sg.addUrl(url);
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
