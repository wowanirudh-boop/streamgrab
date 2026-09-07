'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const { Bridge } = require('./bridge');
const { Queue } = require('./queue');
const { registerNativeHost } = require('./host-registration');

// Same userData folder (%APPDATA%\StreamGrab) in dev and packaged builds, so the
// native host always knows where bridge.json lives.
app.setName('StreamGrab');

const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'settings.json');
const START_HIDDEN = process.argv.includes('--hidden');
// --sg-debug: verbose app.log (full yt-dlp output) and DevTools open.
// (Not "--debug": Electron/Node intercept that as the legacy inspector flag.)
const DEBUG = process.argv.includes('--sg-debug') || !!process.env.STREAMGRAB_DEBUG;

const log = require('./log');
log.init(app.getPath('userData'), {
  // Release builds write no log file unless started with --sg-debug, so the
  // file never grows on end-user machines. Dev builds always log verbosely and
  // keep a second copy in the project folder (<project>/.dev/app.log).
  enabled: DEBUG || !app.isPackaged,
  verbose: DEBUG || !app.isPackaged,
  mirrorPath: app.isPackaged ? null : path.join(app.getAppPath(), '.dev', 'app.log')
});

let win = null;
let tray = null;
let bridge = null;
let queue = null;
let settings = null;
let hostStatus = null;
let quitting = false;

// Only one StreamGrab at a time. A second launch (user double-click, or the
// native host trying to start us while we are already up) just focuses us.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Exit right now: app.quit() is asynchronous and would let 'ready' run first,
  // which would overwrite bridge.json with a port that is about to close.
  app.exit(0);
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--hidden')) return; // host started us; stay where we are
    showWindow();
  });
}

function loadSettings() {
  const defaults = {
    downloadDir: app.getPath('downloads'),
    concurrentFragments: 8,
    useAria2: true,
    // '' by default: reading Chrome's cookie DB while Chrome is running often
    // fails on Windows (locked DB). The extension already forwards the request's
    // Cookie header, which covers most authenticated streams.
    cookiesFromBrowser: '',
    // Stay reachable from the extension: start with Windows (packaged builds only).
    launchAtLogin: true,
    // Extra extension ids (e.g. the Web Store id) allowed to reach the host.
    extraExtensionIds: []
  };
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH(), 'utf8'));
    return { ...defaults, ...raw };
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_PATH(), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Failed to save settings', e);
  }
}

function applyLoginItem() {
  if (!app.isPackaged) return; // never register a dev electron.exe as a login item
  try {
    app.setLoginItemSettings({ openAtLogin: !!settings.launchAtLogin, args: ['--hidden'] });
  } catch (e) {
    console.warn('setLoginItemSettings failed', e.message);
  }
}

// ---- native host registration ---------------------------------------------

function launcherPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'streamgrab-host.exe')
    : path.join(app.getAppPath(), 'native-host', 'streamgrab-host.exe');
}

function registerHost() {
  hostStatus = registerNativeHost({
    launcherPath: launcherPath(),
    manifestPath: path.join(app.getPath('userData'), 'com.streamgrab.host.json'),
    extraIds: settings.extraExtensionIds || []
  });
  if (hostStatus.ok) console.log('[host] registered', hostStatus.launcherPath);
  else console.warn('[host] registration problem:', hostStatus.error);
}

// ---- window / tray ---------------------------------------------------------

function iconImage() {
  const p = path.join(app.getAppPath(), 'build', 'icon.png');
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 620,
    minWidth: 720,
    minHeight: 420,
    title: 'StreamGrab',
    backgroundColor: '#141821',
    show: !START_HIDDEN,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (DEBUG) win.webContents.openDevTools({ mode: 'detach' });
  // Closing the window hides it; the app stays resident so the extension can
  // always reach it. Quit from the tray menu.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  tray = new Tray(iconImage());
  tray.setToolTip('StreamGrab');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open StreamGrab', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

function broadcastQueue() {
  const snapshot = queue.snapshot();
  if (win && !win.isDestroyed()) win.webContents.send('queue:update', snapshot);
}

function forwardToExtension(type, payload) {
  if (bridge) bridge.broadcast(type, payload);
}

app.whenReady().then(async () => {
  settings = loadSettings();
  applyLoginItem();
  registerHost();

  queue = new Queue({
    getSettings: () => settings,
    persistPath: path.join(app.getPath('userData'), 'queue.json')
  });
  const restored = queue.load();
  if (restored) log.info('[queue] restored', restored, 'item(s) from queue.json');
  queue.on('update', () => broadcastQueue());
  queue.on('progress', (item) => forwardToExtension('progress', publicItem(item)));
  queue.on('done', (item) => forwardToExtension('done', publicItem(item)));
  queue.on('error', (item) => forwardToExtension('error', publicItem(item)));

  bridge = new Bridge({
    configPath: path.join(app.getPath('userData'), 'bridge.json'),
    // How the native host starts us when we are not running.
    launch: app.isPackaged
      ? { exe: process.execPath, args: ['--hidden'] }
      : { exe: process.execPath, args: [app.getAppPath(), '--hidden'] }
  });
  bridge.on('download', (payload) => {
    log.info('[bridge] download request', payload && payload.kind, payload && payload.url,
      'page:', payload && payload.pageUrl,
      'fragmentQuery:', payload && payload.fragmentQuery ? String(payload.fragmentQuery).slice(0, 60) + '…' : '(none)',
      'keyQuery:', payload && payload.keyQuery ? 'yes' : '(none)',
      'fragmentCookie:', payload && payload.fragmentHeaders && payload.fragmentHeaders.cookie ? 'yes' : 'no');
    const item = queue.add(payload);
    broadcastQueue();
    forwardToExtension('accepted', publicItem(item));
  });
  queue.on('error', (item) => log.error('[queue] failed:', item.title, '-', item.error));
  bridge.on('media_detected', (payload) => {
    console.log('[detected]', payload && payload.kind, payload && payload.url);
  });
  bridge.on('ping', (_payload, client) => client.send({ type: 'pong' }));
  await bridge.start();

  createTray();
  createWindow();

  app.on('activate', () => showWindow());
});

function publicItem(item) {
  const { id, url, title, kind, state, percent, speed, eta, size, filepath, error, formatLabel } = item;
  return { id, url, title, kind, state, percent, speed, eta, size, filepath, error, formatLabel };
}

// ---- IPC from the renderer -------------------------------------------------

ipcMain.handle('queue:get', () => queue.snapshot());

ipcMain.handle('download:add', (_e, url, quality) => {
  if (!url || typeof url !== 'string') return { ok: false, error: 'No URL' };
  const item = queue.add({ url, kind: 'auto', pageUrl: url, quality: quality || null });
  broadcastQueue();
  return { ok: true, id: item.id };
});

ipcMain.handle('download:cancel', (_e, id) => { queue.cancel(id); broadcastQueue(); return { ok: true }; });
ipcMain.handle('download:remove', (_e, id) => { queue.remove(id); broadcastQueue(); return { ok: true }; });
ipcMain.handle('download:retry', (_e, id) => { queue.retry(id); broadcastQueue(); return { ok: true }; });
ipcMain.handle('download:clear', (_e, which) => { const n = queue.clear(which); broadcastQueue(); return { ok: true, cleared: n }; });

ipcMain.handle('item:open-folder', (_e, id) => {
  const item = queue.get(id);
  if (item && item.filepath && fs.existsSync(item.filepath)) {
    shell.showItemInFolder(item.filepath);
    return { ok: true };
  }
  if (item) { shell.openPath(settings.downloadDir); return { ok: true }; }
  return { ok: false };
});

ipcMain.handle('settings:get', () => settings);

ipcMain.handle('settings:set', (_e, patch) => {
  settings = { ...settings, ...patch };
  saveSettings();
  if ('launchAtLogin' in patch) applyLoginItem();
  if ('extraExtensionIds' in patch) registerHost();
  return settings;
});

ipcMain.handle('settings:choose-dir', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths[0]) return { ok: false };
  settings.downloadDir = res.filePaths[0];
  saveSettings();
  return { ok: true, dir: settings.downloadDir };
});

ipcMain.handle('bridge:info', () => ({
  port: bridge ? bridge.port : 0,
  host: hostStatus,
  packaged: app.isPackaged,
  debug: DEBUG,
  logPath: log.path()
}));

ipcMain.handle('log:open', () => {
  if (!log.path()) return { ok: false, error: 'File logging is off in release builds; start StreamGrab with --sg-debug.' };
  shell.openPath(log.path());
  return { ok: true };
});

// Stay resident when the last window closes (see tray "Quit").
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  quitting = true;
  if (queue) queue.flush();
  if (bridge) bridge.stop();
});
