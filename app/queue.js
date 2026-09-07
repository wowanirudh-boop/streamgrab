'use strict';

// Download queue + engine manager. Holds the list of jobs the UI renders,
// runs up to MAX_CONCURRENT at a time, and re-emits engine events as queue
// updates. Kept intentionally small; persistence/pause-resume are v2.

const { EventEmitter } = require('events');
const crypto = require('crypto');
const { Downloader } = require('./engine/downloader');

const MAX_CONCURRENT = 3;

class Queue extends EventEmitter {
  constructor({ getSettings }) {
    super();
    this.getSettings = getSettings;
    this.items = [];      // ordered list of jobs
    this.runners = new Map(); // id -> Downloader
  }

  add(payload) {
    const item = {
      id: crypto.randomUUID(),
      url: payload.url,
      title: payload.pageTitle || payload.filename || guessTitle(payload.url),
      kind: payload.kind || 'auto',
      headers: payload.headers || {},
      // Credentials the page's player used for segments / AES keys (optional).
      fragmentQuery: payload.fragmentQuery || '',
      fragmentHeaders: payload.fragmentHeaders || null,
      keyQuery: payload.keyQuery || '',
      filename: payload.filename || null,
      pageUrl: payload.pageUrl || '',
      state: 'queued',     // queued | downloading | done | error | canceled
      percent: 0,
      speed: '',
      eta: '',
      size: payload.size || 0,
      downloaded: 0,
      filepath: null,
      error: null,
      addedAt: Date.now()
    };
    this.items.unshift(item);
    this.pump();
    return item;
  }

  pump() {
    const active = [...this.runners.keys()].length;
    if (active >= MAX_CONCURRENT) return;
    const next = this.items.find((i) => i.state === 'queued');
    if (!next) return;
    this.run(next);
    // Try to fill remaining slots.
    if (this.runners.size < MAX_CONCURRENT) this.pump();
  }

  run(item) {
    item.state = 'downloading';
    const runner = new Downloader(item, this.getSettings());
    this.runners.set(item.id, runner);

    runner.on('progress', (p) => {
      item.percent = p.percent;
      item.speed = p.speed;
      item.eta = p.eta;
      item.downloaded = p.downloaded;
      if (p.size) item.size = p.size;
      this.emit('progress', item);
      this.emit('update');
    });

    runner.on('completed', (filepath) => {
      item.state = 'done';
      item.percent = 100;
      item.speed = '';
      item.eta = '';
      item.filepath = filepath || null;
      this.runners.delete(item.id);
      this.emit('done', item);
      this.emit('update');
      this.pump();
    });

    runner.on('failed', (msg) => {
      item.state = 'error';
      item.error = msg;
      this.runners.delete(item.id);
      this.emit('error', item);
      this.emit('update');
      this.pump();
    });

    runner.on('state', (s) => {
      if (s === 'canceled') item.state = 'canceled';
      this.emit('update');
    });

    runner.start();
    this.emit('update');
  }

  cancel(id) {
    const runner = this.runners.get(id);
    if (runner) {
      runner.cancel();
      this.runners.delete(id);
    }
    const item = this.get(id);
    if (item && item.state !== 'done') item.state = 'canceled';
    this.pump();
  }

  retry(id) {
    const item = this.get(id);
    if (!item) return;
    item.state = 'queued';
    item.error = null;
    item.percent = 0;
    this.pump();
  }

  remove(id) {
    this.cancel(id);
    this.items = this.items.filter((i) => i.id !== id);
  }

  // Bulk clear. which='completed' drops finished rows (done/error/canceled) and
  // leaves anything still queued or downloading; which='all' cancels everything
  // first, then empties the list. Returns how many rows were removed.
  clear(which = 'completed') {
    const finished = new Set(['done', 'error', 'canceled']);
    let toRemove;
    if (which === 'all') {
      toRemove = this.items.slice();
    } else {
      toRemove = this.items.filter((i) => finished.has(i.state));
    }
    for (const it of toRemove) {
      const runner = this.runners.get(it.id);
      if (runner) { runner.cancel(); this.runners.delete(it.id); }
    }
    const removeIds = new Set(toRemove.map((i) => i.id));
    this.items = this.items.filter((i) => !removeIds.has(i.id));
    this.pump();
    return toRemove.length;
  }

  get(id) {
    return this.items.find((i) => i.id === id);
  }

  snapshot() {
    return this.items.map((i) => ({ ...i, headers: undefined, fragmentHeaders: undefined }));
  }
}

function guessTitle(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    return decodeURIComponent(last);
  } catch {
    return url;
  }
}

module.exports = { Queue };
