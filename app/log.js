'use strict';

// Tiny file logger. When enabled, everything the app prints with console.*
// also lands in %APPDATA%\StreamGrab\app.log, plus structured lines from the
// download engine (arguments, yt-dlp stderr, exit codes).
//
// Release (packaged) builds do NOT write a log file at all unless started with
// --sg-debug, so the file never grows on end-user machines. Dev builds
// (npm start) always log, and --sg-debug makes the log verbose (full yt-dlp
// stderr) and opens DevTools.

const fs = require('fs');
const path = require('path');

let file = null;
let mirror = null;   // optional second copy (dev builds keep one in the project folder)
let verbose = false;
const orig = { log: console.log, warn: console.warn, error: console.error };

function fmt(args) {
  return args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

function write(level, args) {
  if (!file) return;
  const line = `[${new Date().toISOString()}] [${level}] ${fmt(args)}\n`;
  try { fs.appendFileSync(file, line); } catch {}
  if (mirror) { try { fs.appendFileSync(mirror, line); } catch {} }
}

function trim(p) {
  try {
    // Keep files small: start over when one grows past 2 MB.
    if (fs.statSync(p).size > 2 * 1024 * 1024) fs.unlinkSync(p);
  } catch {}
}

function init(dir, { enabled = true, verbose: v = false, mirrorPath = null } = {}) {
  verbose = !!v;
  if (!enabled) {
    // No file, console left untouched, debug() is a no-op. path() returns null
    // so the UI can hide its "Log" button.
    file = null;
    mirror = null;
    return;
  }
  file = path.join(dir, 'app.log');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  trim(file);
  if (mirrorPath) {
    mirror = mirrorPath;
    try { fs.mkdirSync(path.dirname(mirrorPath), { recursive: true }); } catch {}
    trim(mirrorPath);
  }
  console.log = (...a) => { write('INFO', a); orig.log(...a); };
  console.warn = (...a) => { write('WARN', a); orig.warn(...a); };
  console.error = (...a) => { write('ERROR', a); orig.error(...a); };
  write('INFO', ['--- app start ---', `verbose=${verbose}`, 'argv=', process.argv.join(' ')]);
}

module.exports = {
  init,
  isVerbose: () => verbose,
  path: () => file,          // null when file logging is off
  isEnabled: () => !!file,
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
  // Only written when --debug is on (never echoed to the console otherwise).
  debug: (...a) => { if (verbose && file) { write('DEBUG', a); orig.log(...a); } }
};
