'use strict';

// Wraps yt-dlp (+ ffmpeg for muxing, + aria2c for fast multi-connection HTTP).
// yt-dlp already understands HLS (.m3u8), DASH (.mpd), and plain progressive
// files, and can pull cookies straight from the browser, so it does the heavy
// lifting. We just build the right argument list and parse progress.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const log = require('../log');

const IS_WIN = process.platform === 'win32';

// In development the bundled tools live in <project>/bin. In a packaged build
// they're shipped as extraResources under process.resourcesPath/bin.
let BIN_DIR;
try {
  const { app } = require('electron');
  BIN_DIR = app && app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(__dirname, '..', '..', 'bin');
} catch {
  BIN_DIR = path.join(__dirname, '..', '..', 'bin');
}

// A progress-template line we control, so parsing is unambiguous.
const PROG_PREFIX = 'SGPROG';
const PROG_TEMPLATE =
  `${PROG_PREFIX}|%(progress._percent_str)s|%(progress._speed_str)s|` +
  `%(progress._eta_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|` +
  `%(progress.total_bytes_estimate)s`;

function resolveBin(name) {
  const exe = IS_WIN ? `${name}.exe` : name;
  const local = path.join(BIN_DIR, exe);
  if (fs.existsSync(local)) return local;
  return exe; // fall back to PATH
}

function hasBin(name) {
  const exe = IS_WIN ? `${name}.exe` : name;
  return fs.existsSync(path.join(BIN_DIR, exe));
}

class Downloader extends EventEmitter {
  constructor(item, settings) {
    super();
    this.item = item;
    this.settings = settings;
    this.proc = null;
    this.killed = false;
    this.lastFilepath = null;
  }

  buildArgs() {
    const s = this.settings;
    const outDir = s.downloadDir;
    try { fs.mkdirSync(outDir, { recursive: true }); } catch {}

    // Name the file after the page title when we have one: raw stream URLs
    // otherwise yield names like "index [index].mp4".
    const titleName = this.item.title && !/^https?:/i.test(this.item.title)
      ? sanitize(this.item.title).replace(/\s+/g, ' ').trim()
      : '';
    const outTemplate = this.item.filename
      ? path.join(outDir, sanitize(this.item.filename))
      : titleName
        ? path.join(outDir, `${titleName}.%(ext)s`)
        : path.join(outDir, '%(title).200B [%(id)s].%(ext)s');

    const args = [
      '--newline',
      '--no-color',
      '--no-playlist',
      '--restrict-filenames',
      '--concurrent-fragments', String(s.concurrentFragments || 8),
      // --print (below) implies --quiet, which hides progress; force it back on.
      '--progress',
      '--progress-template', PROG_TEMPLATE,
      '--ffmpeg-location', resolveBin('ffmpeg'),
      '-o', outTemplate,
      // Download AND print the final (post-mux/move) path on its own line.
      '--no-simulate',
      '--print', 'after_move:filepath',
      '--merge-output-format', 'mp4'
    ];

    // Signed CDN streams (CloudFront Policy/Signature, Sprout Video, Vimeo…) keep
    // credentials in query strings while manifests list variants and segments
    // as bare relative names. Carry the manifest's query to variant playlists,
    // and give fragments / AES keys whatever query the page's own player used
    // (sampled by the extension), falling back to the manifest's query.
    const ea = ['variant_query'];
    const fq = cleanQuery(this.item.fragmentQuery);
    ea.push(fq ? `fragment_query=${fq}` : 'fragment_query');
    const kq = cleanQuery(this.item.keyQuery);
    if (kq) ea.push(`key_query=${kq}`);
    args.push('--extractor-args', `generic:${ea.join(';')}`);

    // Replay the exact request context the browser used. If the player sent
    // cookies with segments but not with the manifest, use those.
    const h = { ...(this.item.headers || {}) };
    const fh = this.item.fragmentHeaders || {};
    if (!h.cookie && fh.cookie) h.cookie = fh.cookie;
    if (h.referer) args.push('--referer', h.referer);
    if (h.userAgent) args.push('--user-agent', h.userAgent);
    if (h.cookie) args.push('--add-header', `Cookie:${h.cookie}`);
    if (h.origin) args.push('--add-header', `Origin:${h.origin}`);

    // Prefer browser cookies for authenticated streams (more robust than a
    // single captured Cookie header). Disable in settings if it locks the DB.
    if (s.cookiesFromBrowser && !h.cookie) {
      args.push('--cookies-from-browser', s.cookiesFromBrowser);
    }

    // Fast multi-connection HTTP for progressive/direct files.
    if (s.useAria2 && hasBin('aria2c')) {
      args.push('--downloader', 'aria2c');
      args.push('--downloader-args', 'aria2c:-x16 -s16 -k1M');
    }

    if (log.isVerbose()) args.push('--verbose');

    args.push(this.item.url);
    return args;
  }

  start() {
    const bin = resolveBin('yt-dlp');
    const args = this.buildArgs();
    const tag = `[dl ${String(this.item.id || '').slice(0, 8)}]`;
    this.emit('state', 'downloading');

    log.info(tag, 'start', this.item.kind, this.item.url);
    log.info(tag, 'exe', bin, 'ffmpeg', hasBin('ffmpeg') ? 'bundled' : 'PATH', 'aria2c', hasBin('aria2c') ? 'bundled' : 'no');
    log.debug(tag, 'args', JSON.stringify(args));
    if (!fs.existsSync(bin) && !/[\\/]/.test(bin)) log.warn(tag, 'yt-dlp not in bin/, relying on PATH');

    try {
      this.proc = spawn(bin, args, { windowsHide: true });
    } catch (e) {
      log.error(tag, 'spawn threw', e.message);
      this.emit('failed', `Could not launch yt-dlp: ${e.message}`);
      return;
    }

    let stderrTail = '';
    const started = Date.now();

    this.proc.stdout.on('data', (buf) => {
      const t = buf.toString();
      log.debug(tag, 'stdout:', t.trimEnd());
      this.handleStdout(t);
    });
    this.proc.stderr.on('data', (buf) => {
      const t = buf.toString();
      stderrTail = (stderrTail + t).slice(-4000);
      // Errors/warnings are always logged; everything else only with --debug.
      for (const line of t.split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (/^(ERROR|WARNING)/i.test(line)) log.warn(tag, 'yt-dlp:', line.trim());
        else log.debug(tag, 'stderr:', line.trimEnd());
      }
    });

    this.proc.on('error', (e) => {
      log.error(tag, 'process error', e.code || '', e.message);
      if (e.code === 'ENOENT') {
        this.emit('failed', 'yt-dlp not found. Put yt-dlp.exe in the bin/ folder or on PATH.');
      } else {
        this.emit('failed', e.message);
      }
    });

    this.proc.on('close', (code) => {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (this.killed) { log.info(tag, 'canceled after', secs + 's'); return; }
      if (code === 0) {
        log.info(tag, 'completed in', secs + 's', '->', this.lastFilepath || '(no path printed)');
        this.emit('completed', this.lastFilepath);
      } else {
        const msg = firstError(stderrTail) || `yt-dlp exited with code ${code}`;
        log.error(tag, 'failed after', secs + 's', 'code', code, '-', msg);
        if (!log.isVerbose()) log.error(tag, 'stderr tail:', stderrTail.trim().split(/\r?\n/).slice(-8).join(' | '));
        this.emit('failed', msg);
      }
    });
  }

  handleStdout(text) {
    for (const line of text.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;

      if (l.startsWith(PROG_PREFIX + '|')) {
        const [, pct, speed, eta, done, total, totalEst] = l.split('|');
        const totalBytes = num(total) || num(totalEst) || 0;
        this.emit('progress', {
          percent: parsePct(pct),
          speed: clean(speed),
          eta: clean(eta),
          downloaded: num(done),
          size: totalBytes || this.item.size || 0
        });
        continue;
      }

      // Any non-progress line that resolves to an existing file is our result.
      if (looksLikePath(l)) {
        this.lastFilepath = l;
      }
    }
  }

  cancel() {
    this.killed = true;
    if (this.proc) {
      try {
        if (IS_WIN) spawn('taskkill', ['/pid', String(this.proc.pid), '/t', '/f']);
        else this.proc.kill('SIGTERM');
      } catch {}
    }
    this.emit('state', 'canceled');
  }
}

// ---- helpers ---------------------------------------------------------------

// yt-dlp splits extractor-args on ';' and ',', so a query containing either
// cannot be passed through safely; return '' to fall back to the manifest query.
function cleanQuery(q) {
  const s = String(q || '').replace(/^\?/, '').trim();
  return s && !/[;,]/.test(s) ? s : '';
}

function sanitize(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 200);
}
function parsePct(s) {
  const m = String(s).match(/([\d.]+)%/);
  return m ? Math.min(100, parseFloat(m[1])) : 0;
}
function num(s) {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}
function clean(s) {
  const t = String(s || '').trim();
  return t === 'NA' || t === '' ? '' : t;
}
function looksLikePath(l) {
  return /^[A-Za-z]:[\\/]/.test(l) || l.startsWith('/');
}
function firstError(stderr) {
  const line = String(stderr).split(/\r?\n/).reverse().find((x) => /error/i.test(x));
  return line ? line.replace(/^ERROR:\s*/i, '').trim() : '';
}

module.exports = { Downloader, resolveBin, hasBin };
