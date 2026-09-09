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

// [#gid 129MiB/291MiB(44%) CN:16 DL:3.5MiB ETA:45s]  (ETA absent when done)
const ARIA_PROG = /\[#[0-9a-f]+\s+([\d.]+[KMGT]?i?B)\/([\d.]+[KMGT]?i?B)\((\d+)%\)(?:.*?DL:([\d.]+[KMGT]?i?B))?(?:.*?ETA:(\S+?))?\]/i;

function parseSize(s) {
  const m = String(s || '').match(/([\d.]+)\s*([KMGT]?)i?B/i);
  if (!m) return 0;
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2].toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

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
    // Every job gets a private working folder for its intermediate files
    // (.part, .fN.mp4 / .fN.m4a). Only the finished file is moved into outDir.
    // Without this, a failed attempt leaves e.g. "Title.f6.mp4" behind and the
    // next attempt with the same title sees "has already been downloaded",
    // skips the fetch and muxes the junk again. Same job id -> same folder, so
    // Stop/Retry still resumes .part files. Removed when the job finishes or
    // is deleted from the list (see queue.js). The folder is named by the first
    // 8 chars of the job id: unique enough, and 28 chars shorter than a full
    // UUID, which matters for the path budget below.
    const tmpDir = path.join(outDir, '.streamgrab-tmp', String(this.item.id || 'job').slice(0, 8));
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
    this.item.tmpDir = tmpDir;

    // Windows caps a full path at 260 chars (MAX_PATH) and yt-dlp/Python do
    // not opt out of it. Intermediate files live in tmpDir with suffixes added
    // to our name (".f401.mp4-Frag12.part", ".ytdl", ".temp.mp4"), so the name
    // must fit tmpDir + name + suffix. A tweet's text as the title (200 chars)
    // under "D:\...\Downloads\.streamgrab-tmp\<uuid>\" blew past it and failed
    // with "[Errno 2] No such file or directory: '...mp4.ytdl'".
    // Relative template: with -P (below) the final file lands in outDir.
    const budget = nameBudget(tmpDir);
    // A finished file with the same name is never reused: yt-dlp treats an
    // existing final file as "already downloaded", exits 0 and prints its
    // path, which looked like a download that did nothing. Like IDM, a second
    // download of the same video becomes "Title (1).mp4".
    const outTemplate = this.item.filename
      ? uniqueName(outDir, fitName(sanitize(this.item.filename), budget))
      : titleName
        ? `${uniqueStem(outDir, fitName(titleName, budget))}.%(ext)s`
        : `%(title).${Math.max(20, budget - 30)}B [%(id)s].%(ext)s`;

    const args = [
      '--newline',
      '--no-color',
      // yt-dlp's Windows build prints in the console code page (cp1252 here)
      // while we decode its output as UTF-8. With an accented title the
      // printed final path came back with U+FFFD in it, the app could not find
      // its own file and "Open" fell back to the folder, which read as "the
      // download vanished". PYTHONUTF8/PYTHONIOENCODING are ignored by the
      // frozen exe; --encoding is honoured (verified: "publié" -> c3 a9).
      '--encoding', 'utf-8',
      '--no-playlist',
      '--restrict-filenames',
      '--concurrent-fragments', String(s.concurrentFragments || 8),
      // --print (below) implies --quiet, which hides progress; force it back on.
      '--progress',
      '--progress-template', PROG_TEMPLATE,
      '--ffmpeg-location', resolveBin('ffmpeg'),
      '-P', `home:${outDir}`,
      '-P', `temp:${tmpDir}`,
      '-o', outTemplate,
      // Download AND print the final (post-mux/move) path on its own line.
      '--no-simulate',
      '--print', 'after_move:filepath'
    ];

    // Quality. yt-dlp's selector works the same for HLS masters, DASH
    // manifests and site extractors: best video at or below the chosen height
    // plus best audio, muxed; or the whole thing if it only comes combined.
    const q = this.item.quality || { kind: 'best' };
    // Format ranking: resolution, frame rate, SDR over HDR, then a plain
    // https file over HLS/DASH; everything else (codec, bitrate, language)
    // stays at yt-dlp's defaults, so YouTube picks are unchanged. The proto
    // step matters because extractors may invert it: X/Twitter declares
    // "proto:m3u8", so at 640x360 it took the 187 kbps HLS rendition over the
    // 832 kbps MP4 that IDM downloads - a 53 MB file for a 2-hour video,
    // fetched fragment by fragment. A single https file also lets aria2c
    // pull it with 16 connections. User -S fields outrank extractor ones.
    // (Checked: "br" before "proto" would push YouTube onto 28 Mbps HLS.)
    args.push('-S', 'res,fps,hdr:12,proto');
    if (q.kind === 'audio') {
      args.push('-f', 'bestaudio/best', '--extract-audio', '--audio-format', 'm4a', '--audio-quality', '0');
    } else {
      if (q.kind === 'height' && q.height) {
        const h = q.height;
        args.push('-f', `bestvideo*[height<=${h}]+bestaudio/best[height<=${h}]/bestvideo*+bestaudio/best`);
      }
      args.push('--merge-output-format', 'mp4');
    }

    // Signed CDN streams (CloudFront Policy/Signature, Sprout Video, Vimeo…) keep
    // credentials in query strings while manifests list variants and segments
    // as bare relative names. Only then carry the manifest's query to variant
    // playlists and segments. yt-dlp's variant_query/fragment_query MERGE the
    // manifest's params over the fragment's own, so on manifests whose
    // fragments already carry their own signed query (VK/okcdn DASH: BaseURL
    // "?type=5&sig=…") they would overwrite it and re-download the manifest
    // instead of media. So: never for DASH, and for HLS only when the
    // extension saw variants without a query of their own.
    const ea = [];
    const isDash = this.item.kind === 'dash' || /\.mpd(\?|#|$)/i.test(this.item.url);
    const bare = !isDash && !!this.item.variantsNeedQuery;
    if (bare) ea.push('variant_query');
    // Fragments / AES keys: whatever query the page's own player used
    // (sampled by the extension) wins; otherwise inherit only in the bare case.
    const fq = cleanQuery(this.item.fragmentQuery);
    if (fq) ea.push(`fragment_query=${fq}`);
    else if (bare) ea.push('fragment_query');
    const kq = cleanQuery(this.item.keyQuery);
    if (kq) ea.push(`key_query=${kq}`);
    if (ea.length) args.push('--extractor-args', `generic:${ea.join(';')}`);

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
    log.info(tag, 'exe', bin, 'ffmpeg', hasBin('ffmpeg') ? 'bundled' : 'PATH',
      'ffprobe', hasBin('ffprobe') ? 'bundled' : 'no', 'aria2c', hasBin('aria2c') ? 'bundled' : 'no');
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
        const fp = resolvePrintedPath(this.lastFilepath);
        if (fp !== this.lastFilepath) log.warn(tag, 'printed path did not exist; matched', fp);
        log.info(tag, 'completed in', secs + 's', '->', fp || '(no path printed)');
        removeTmp(this.item);
        this.emit('completed', fp);
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

      // aria2c (external downloader) prints its own progress, e.g.
      //   [#93de20 129MiB/291MiB(44%) CN:16 DL:3.5MiB ETA:45s]
      // yt-dlp's template is not applied to it, so parse it here. Otherwise
      // the UI sits at 0% for the whole transfer.
      const a = l.match(ARIA_PROG);
      if (a) {
        const downloaded = parseSize(a[1]);
        const size = parseSize(a[2]);
        this.emit('progress', {
          percent: parseInt(a[3], 10) || (size ? Math.min(100, (downloaded / size) * 100) : 0),
          speed: a[4] ? `${a[4]}/s` : '',
          eta: a[5] || '',
          downloaded,
          size: size || this.item.size || 0
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

// Delete a job's private working folder (intermediate files). Safe to call
// when it does not exist. Only ever touches "<downloadDir>/.streamgrab-tmp/<id>".
function removeTmp(item) {
  const d = item && item.tmpDir;
  if (!d || !/[\\/]\.streamgrab-tmp[\\/]/.test(d)) return;
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  // Drop the parent ".streamgrab-tmp" too once it is empty.
  try { fs.rmdirSync(path.dirname(d)); } catch {}
}

// yt-dlp splits extractor-args on ';' and ',', so a query containing either
// cannot be passed through safely; return '' to fall back to the manifest query.
function cleanQuery(q) {
  const s = String(q || '').replace(/^\?/, '').trim();
  return s && !/[;,]/.test(s) ? s : '';
}

function sanitize(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 200);
}

// Characters left for a file name (extension included) so that every path
// yt-dlp creates under `dir` stays inside Windows' MAX_PATH. The reserve
// covers the separator and the longest intermediate suffix yt-dlp appends
// (".f401.mp4-Frag1234.part" is 23 chars, ".mp4.ytdl" / ".temp.mp4" 9) with
// some slack; the floor keeps names readable under an absurdly deep folder.
const MAX_PATH = 260;
const NAME_RESERVE = 40;
function nameBudget(dir) {
  return Math.max(24, MAX_PATH - String(dir).length - NAME_RESERVE);
}

// "<stem>" -> "<stem> (n)" until no "<dir>/<stem>.<media ext>" exists.
const FINAL_EXTS = ['mp4', 'm4a', 'mkv', 'webm', 'mp3', 'mov'];
function uniqueStem(dir, stem) {
  const taken = (s) => FINAL_EXTS.some((e) => fs.existsSync(path.join(dir, `${s}.${e}`)));
  if (!taken(stem)) return stem;
  for (let n = 1; n < 1000; n++) { const s = `${stem} (${n})`; if (!taken(s)) return s; }
  return `${stem} (${Date.now()})`;
}
// Same for a full file name the user chose ("foo.mp4" -> "foo (1).mp4").
function uniqueName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const m = name.match(/^(.*?)(\.[A-Za-z0-9]{1,5})?$/);
  const stem = m[1], ext = m[2] || '';
  for (let n = 1; n < 1000; n++) { const s = `${stem} (${n})${ext}`; if (!fs.existsSync(path.join(dir, s))) return s; }
  return `${stem} (${Date.now()})${ext}`;
}

// A path that yt-dlp printed but that does not exist, containing U+FFFD
// (bytes we could not decode): match it against the directory listing with
// each U+FFFD as a one-character wildcard. Returns the input when nothing
// matches or nothing needs resolving. Also repairs paths saved by earlier
// versions in queue.json.
function resolvePrintedPath(p) {
  if (!p || !p.includes('�') || fs.existsSync(p)) return p;
  try {
    const dir = path.dirname(p);
    const re = new RegExp('^' + path.basename(p).split('�').map(escapeRe).join('.') + '$');
    const hit = fs.readdirSync(dir).find((n) => re.test(n));
    return hit ? path.join(dir, hit) : p;
  } catch { return p; }
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Trim `name` to at most `max` chars, preferring a word boundary, keeping a
// short trailing extension ("foo.mp4") intact and never ending in a dot or a
// space (both invalid on Windows). Names that already fit are unchanged.
function fitName(name, max) {
  const s = String(name);
  if (s.length <= max) return s;
  const extMatch = s.match(/\.[A-Za-z0-9]{1,5}$/);
  const ext = extMatch ? extMatch[0] : '';
  const stem = ext ? s.slice(0, -ext.length) : s;
  let cut = stem.slice(0, Math.max(1, max - ext.length));
  const sp = cut.lastIndexOf(' ');
  if (sp > cut.length * 0.6) cut = cut.slice(0, sp);
  cut = cut.replace(/[\s.]+$/, '') || 'video';
  return cut + ext;
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

module.exports = { Downloader, resolveBin, hasBin, removeTmp, fitName, nameBudget, uniqueStem, uniqueName, resolvePrintedPath };
