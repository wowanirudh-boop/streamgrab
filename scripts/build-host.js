'use strict';

// Compiles native-host/host.cs into native-host/streamgrab-host.exe using the
// C# compiler that ships with every Windows install (.NET Framework 4.x).
// Idempotent: skips the build when the exe is newer than the source.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'native-host', 'host.cs');
const OUT = path.join(__dirname, '..', 'native-host', 'streamgrab-host.exe');

if (process.platform !== 'win32') {
  console.log('[build-host] not Windows, skipping native host build');
  process.exit(0);
}

if (fs.existsSync(OUT) && fs.statSync(OUT).mtimeMs >= fs.statSync(SRC).mtimeMs && !process.argv.includes('--force')) {
  console.log('[build-host] up to date:', OUT);
  process.exit(0);
}

const windir = process.env.WINDIR || 'C:\\Windows';
const csc = [
  path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
].find((p) => fs.existsSync(p));

if (!csc) {
  console.error('[build-host] csc.exe not found (needs .NET Framework 4.x, which ships with Windows).');
  process.exit(1);
}

execFileSync(csc, [
  '/nologo', '/optimize+', '/target:winexe', '/platform:anycpu',
  '/r:System.Web.Extensions.dll', '/r:System.Management.dll',
  `/out:${OUT}`, SRC
], { stdio: 'inherit' });
console.log('[build-host] built', OUT);
