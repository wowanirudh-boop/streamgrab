'use strict';

// Removes the StreamGrab native-messaging registration that the desktop app
// writes on start (and any leftovers from the old manual installer).
//
//   npm run uninstall-host

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { REG_KEYS } = require('../app/host-registration');

for (const [browser, key] of Object.entries(REG_KEYS)) {
  try { execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore' }); console.log(`Removed ${browser} registry key.`); }
  catch { /* not present */ }
}

const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Roaming');
for (const f of [
  path.join(appData, 'StreamGrab', 'com.streamgrab.host.json'),
  path.join(appData, 'StreamGrab', 'bridge.json')
]) { try { fs.unlinkSync(f); console.log('Deleted', f); } catch {} }

// Legacy location used by the old scripts/install-native-host.js.
const legacy = path.join(process.env.LOCALAPPDATA || '', 'StreamGrab');
if (legacy && fs.existsSync(legacy)) { fs.rmSync(legacy, { recursive: true, force: true }); console.log('Removed legacy', legacy); }

console.log('Done.');
