# StreamGrab

An IDM-style download manager with deep Chrome integration. A Chrome extension
sniffs streaming video (HLS `.m3u8`, DASH `.mpd`, and progressive `.mp4`/etc.),
shows a floating **⬇ Download** button on the page, and hands the job to an
Electron desktop app that downloads it fast with **yt-dlp + aria2 + ffmpeg**.

```
┌──────────────────────────┐  native messaging   ┌──────────────────────┐  TCP 127.0.0.1  ┌────────────────────────────┐
│  Chrome extension (MV3)   │  (JSON over stdio)  │  streamgrab-host.exe  │  (token auth)   │   StreamGrab desktop app    │
│  extension/              │ ◄────────────────► │  native-host/host.cs  │ ◄─────────────► │  app/  (yt-dlp/aria2/ffmpeg)│
│  • webRequest detector   │                     │  • relays messages    │                 │  • registers the host       │
│  • overlay + popup       │                     │  • starts the app if  │                 │  • tray, stays resident     │
└──────────────────────────┘                     │    it is not running  │                 └────────────────────────────┘
                                                 └──────────────────────┘
```

## How the link works (and why it is robust)

- **The desktop app owns the registration.** On every start it writes the
  native-messaging manifest to `%APPDATA%\StreamGrab\com.streamgrab.host.json`
  and the per-user registry keys for Chrome, Edge, Brave, Vivaldi and Chromium.
  Nothing to install by hand, no Node.js or compiler needed on the user's PC.
- **The host has no dependencies.** `native-host/host.cs` is compiled with the
  C# compiler that ships with Windows into a 10 KB `streamgrab-host.exe`.
- **The app is always reachable.** If the app is not running when Chrome opens
  the host, the host starts it (hidden) and connects once it is up. The app
  lives in the tray; closing the window hides it. "Start with Windows" is on
  by default in installed builds.
- **Per-run token.** The app writes `%APPDATA%\StreamGrab\bridge.json`
  (port, token, how to launch the app). The host reads it fresh on every
  connect attempt, so a restarted app is never rejected with a stale token.
- **Extension ids.** `app/host-registration.js` lists the allowed extension
  ids. The development id `mgpgijoaodikafklfkljijgedmmogddg` comes from the
  `key` in `extension/manifest.json`. See *Publishing* for the store id.

## Setup (development)

### 1. Prereqs
- [Node.js](https://nodejs.org/) 18+ (only for developing; end users need nothing).
- Run `npm run fetch-tools` to download `yt-dlp`, `ffmpeg`, `ffprobe` and `aria2c`
  into [`bin/`](bin/README.md) from their official sources.

### 2. Start the app
```bash
npm install
npm start
```
`npm start` compiles the native host if needed, registers it, and starts the
app. The footer shows **Chrome link ready** when everything is in place.

### 3. Load the extension
1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → select the [`extension/`](extension/) folder.
   Its id will be `mgpgijoaodikafklfkljijgedmmogddg` (fixed by the manifest key).

### 4. Try it
Play a non-DRM video (e.g. an HLS test stream). Click the floating
**⬇ Download** pill or the toolbar popup. If the app is not running, the
popup shows *starting app…* for a few seconds while the host launches it.

To remove the registration: `npm run uninstall-host`.

## Building the installer

```bash
npm run dist
```
Produces `dist-installer/StreamGrab Setup x.y.z.exe`. The installer bundles
`bin/*.exe` and the native host; the uninstaller removes the registry keys.

## Publishing the extension

`npm run build-store` writes a store-ready copy to `dist/store` **without** the
manifest `key` (the Web Store rejects it). The store then assigns its own id,
which the host must also allow:

1. Upload `dist/store` as a draft in the Chrome Web Store developer dashboard.
2. Copy the item id, add it to `EXTENSION_IDS` in `app/host-registration.js`,
   ship a new app build. (Users can also add ids under `extraExtensionIds` in
   `%APPDATA%\StreamGrab\settings.json` without a rebuild.)
3. Optional but recommended: copy the store's public key (dashboard →
   Package → *View public key*) into `extension/manifest.json` as `key`, so the
   unpacked and store versions share one id.

## Limitations (read these)

- **DRM (Widevine/PlayReady) is not supported** and never will be by this
  approach — Netflix/Disney+/etc. segments are encrypted. This works on clear
  (non-DRM) streams and direct files only.
- Detection state lives in the MV3 service worker, which Chrome may evict; a
  detected list can reset. (Persist to `chrome.storage.session` in v2.)
- Pause/resume is currently stop + retry (yt-dlp resumes partial files with
  `--continue`). True pause is a v2 item.
- Windows-first: the native host and its registration are Windows-only for now.

## Project layout

| Path | What it is |
|------|------------|
| `app/main.js` | Electron main: window, tray, IPC, host registration, bridge wiring |
| `app/bridge.js` | Local TCP server (newline JSON, token auth) the native host connects to |
| `app/host-registration.js` | Writes the native-messaging manifest + registry keys |
| `app/queue.js` | Download queue + concurrency |
| `app/engine/downloader.js` | yt-dlp/aria2/ffmpeg orchestration + progress parsing |
| `app/renderer/` | Desktop UI (download list, clear-completed / clear-all) |
| `PRD.md` | Product requirements: built MVP + V1/V2 roadmap |
| `extension/background.js` | webRequest detector + native-messaging client |
| `extension/content.js` | In-page overlay button |
| `extension/popup.*` | Toolbar popup list |
| `native-host/host.cs` | stdio ↔ TCP relay; launches the app when needed |
| `scripts/build-host.js` | Compiles the host with the Windows-bundled C# compiler |
| `scripts/uninstall-native-host.js` | Removes registry keys / manifest |
| `build/installer.nsh` | NSIS uninstall hook that removes the registration |

## Troubleshooting

- **A download failed**: the reason is shown under the row in the app, and in
  `%APPDATA%\StreamGrab\app.log` (footer **Log** button opens it). Every
  yt-dlp ERROR/WARNING line is logged. For the full yt-dlp output plus
  DevTools, run `npm run debug` (or start the installed app with `--sg-debug`).
- Popup says **Native host has exited**: read `%APPDATA%\StreamGrab\host.log`.
- Popup says **forbidden**: the extension id is not in `allowed_origins` of
  `%APPDATA%\StreamGrab\com.streamgrab.host.json` (see *Publishing*).
- Popup says **not found**: the app has never run on this machine; start it once.

## A note on use

Downloading is legitimate for content you own or that permits it. Many sites'
Terms of Service prohibit downloading, and some content is copyrighted — where
you point this tool is your responsibility.
