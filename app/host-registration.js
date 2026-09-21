'use strict';

// The desktop app owns the Chrome native-messaging registration. On every start
// it (re)writes the host manifest and the per-user registry keys, so the link
// keeps working after the app is moved, updated or reinstalled, and no separate
// install step, Node.js or compiler is ever needed on the user's machine.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOST_NAME = 'com.streamgrab.host';

// Extension ids allowed to talk to the host.
//  - The first is the development id, derived from the "key" in extension/manifest.json.
//  - Add the Chrome Web Store id here once the item is created (Developer
//    Dashboard -> item id). Better still: copy the store's public key into the
//    extension manifest "key" so the dev and store ids become identical.
const EXTENSION_IDS = [
  'mgpgijoaodikafklfkljijgedmmogddg', // unpacked/dev (from manifest "key")
  'haalabacafmjbflbdfkkaibahcnilnel'  // Chrome Web Store
];

const REG_KEYS = {
  Chrome: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  Edge: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
  Brave: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`,
  Vivaldi: `HKCU\\Software\\Vivaldi\\NativeMessagingHosts\\${HOST_NAME}`,
  Chromium: `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`
};

function reg(args) {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  execFileSync(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
}

/**
 * @param {{launcherPath: string, manifestPath: string, extraIds?: string[]}} opts
 * @returns {{ok: boolean, launcherExists: boolean, manifestPath: string, launcherPath: string,
 *            extensionIds: string[], browsers: Record<string, boolean>, error?: string}}
 */
function registerNativeHost({ launcherPath, manifestPath, extraIds = [] }) {
  const extensionIds = [...new Set([...EXTENSION_IDS, ...extraIds.filter((id) => /^[a-p]{32}$/.test(id))])];
  const result = {
    ok: false, launcherExists: fs.existsSync(launcherPath), manifestPath, launcherPath,
    extensionIds, browsers: {}
  };
  if (process.platform !== 'win32') {
    result.error = 'native host registration is Windows-only for now';
    return result;
  }

  const manifest = {
    name: HOST_NAME,
    description: 'StreamGrab native messaging host',
    path: launcherPath, // absolute; Chrome handles spaces in quoted paths fine
    type: 'stdio',
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`)
  };
  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  } catch (e) {
    result.error = `could not write manifest: ${e.message}`;
    return result;
  }

  let any = false;
  let lastErr = '';
  for (const [browser, key] of Object.entries(REG_KEYS)) {
    try {
      reg(['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f']);
      result.browsers[browser] = true;
      any = true;
    } catch (e) {
      result.browsers[browser] = false;
      lastErr = (e.stderr && e.stderr.toString().trim()) || e.message;
    }
  }
  result.ok = any && result.launcherExists;
  if (!result.launcherExists) result.error = `launcher not found: ${launcherPath}`;
  else if (!any) result.error = `could not write any registry key: ${lastErr}`;
  return result;
}

function unregisterNativeHost(manifestPath) {
  for (const key of Object.values(REG_KEYS)) {
    try { reg(['delete', key, '/f']); } catch {}
  }
  try { fs.unlinkSync(manifestPath); } catch {}
}

module.exports = { registerNativeHost, unregisterNativeHost, HOST_NAME, EXTENSION_IDS, REG_KEYS };
