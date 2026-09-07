'use strict';

// Populate bin/ with the bundled tools (yt-dlp, aria2c, ffmpeg, ffprobe) from
// their official release sources. The .exe files are gitignored, so a fresh
// clone runs `npm run fetch-tools` once. Existing files are kept unless
// --force is given; --only=<name,...> limits which tools to fetch.
//
//   node scripts/fetch-tools.js            # fetch whatever is missing
//   node scripts/fetch-tools.js --force    # re-download everything
//   node scripts/fetch-tools.js --only=aria2c,ffprobe

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin');
const FORCE = process.argv.includes('--force');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice(7).split(',').map((s) => s.trim()).filter(Boolean) : null;

// Each tool: where it comes from and, for zips, which file(s) to pull out.
// The ffmpeg + ffprobe pair comes from ONE archive so their versions match.
const TOOLS = [
  {
    name: 'yt-dlp',
    files: ['yt-dlp.exe'],
    url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  },
  {
    name: 'aria2c',
    files: ['aria2c.exe'],
    url: 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip',
    zip: true
  },
  {
    name: 'ffmpeg',
    files: ['ffmpeg.exe', 'ffprobe.exe'],
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    zip: true
  }
];

function fmt(bytes) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  const out = fs.createWriteStream(dest);
  let got = 0, lastPct = -1;
  for await (const chunk of res.body) {
    out.write(chunk);
    got += chunk.length;
    if (total) {
      const pct = Math.floor((got / total) * 10) * 10;
      if (pct !== lastPct) { process.stdout.write(`  ${pct}%\r`); lastPct = pct; }
    }
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  process.stdout.write('       \r');
  return got;
}

// Pull named files out of a zip, flattening any directory structure. Uses the
// OS's tar (Windows 10+ ships bsdtar, which reads zips) so no npm dependency.
function extract(zipPath, wanted, tmp) {
  // Prefer Windows' own bsdtar by absolute path: a Git-Bash/MSYS GNU tar on
  // PATH misreads "C:\..." as a remote host. Fall back to Expand-Archive.
  const winTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  let r;
  if (fs.existsSync(winTar)) {
    r = spawnSync(winTar, ['-xf', zipPath, '-C', tmp], { stdio: 'inherit' });
  }
  if (!r || r.status !== 0) {
    r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmp}' -Force`], { stdio: 'inherit' });
  }
  if (r.status !== 0) throw new Error(`could not extract ${zipPath}`);
  const found = {};
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (wanted.includes(e.name) && !found[e.name]) found[e.name] = p;
    }
  })(tmp);
  for (const w of wanted) if (!found[w]) throw new Error(`${w} not found inside ${path.basename(zipPath)}`);
  return found;
}

async function fetchTool(tool) {
  let missing = tool.files.filter((f) => FORCE || !fs.existsSync(path.join(BIN, f)));
  if (!missing.length) { console.log(`✓ ${tool.name}: already present (${tool.files.join(', ')})`); return; }
  // Files that ship together (ffmpeg + ffprobe) must stay the same version:
  // if any one is missing, refresh the whole set from the one archive.
  if (tool.zip && tool.files.length > 1) missing = tool.files;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-tools-'));
  try {
    console.log(`↓ ${tool.name}: ${tool.url}`);
    const dl = path.join(tmp, path.basename(new URL(tool.url).pathname));
    const bytes = await download(tool.url, dl);
    console.log(`  downloaded ${fmt(bytes)}`);

    if (tool.zip) {
      const paths = extract(dl, missing, tmp);
      for (const f of missing) {
        fs.copyFileSync(paths[f], path.join(BIN, f));
        console.log(`  → bin/${f} (${fmt(fs.statSync(path.join(BIN, f)).size)})`);
      }
    } else {
      fs.copyFileSync(dl, path.join(BIN, tool.files[0]));
      console.log(`  → bin/${tool.files[0]} (${fmt(bytes)})`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  if (process.platform !== 'win32') {
    console.error('fetch-tools currently targets Windows builds only.');
    process.exit(1);
  }
  fs.mkdirSync(BIN, { recursive: true });
  const list = ONLY ? TOOLS.filter((t) => ONLY.includes(t.name) || t.files.some((f) => ONLY.includes(f.replace(/\.exe$/, '')))) : TOOLS;
  let failed = 0;
  for (const t of list) {
    try { await fetchTool(t); }
    catch (e) { failed++; console.error(`✗ ${t.name}: ${e.message}`); }
  }
  console.log(failed ? `\n${failed} tool(s) failed.` : '\nAll tools ready in bin/.');
  process.exit(failed ? 1 : 0);
})();
