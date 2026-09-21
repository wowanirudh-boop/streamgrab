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

1. Bump `version` in `extension/manifest.json` (the store rejects a version
   that is not higher than the published one), run `npm run build-store`, zip
   the *contents* of `dist/store` and upload the zip in the developer dashboard.
   The script copies every `.js/.css/.html` in `extension/` and fails if a file
   the manifest or a page references is missing (the 0.1.2 upload shipped
   without `quality.js` and was rejected as "does not work").
2. The store id (`haalabacafmjbflbdfkkaibahcnilnel`) is in `EXTENSION_IDS` in
   `app/host-registration.js`; any new id must be added there and shipped in
   a new app build. (Users can also add ids under `extraExtensionIds` in
   `%APPDATA%\StreamGrab\settings.json` without a rebuild.)
3. The reviewer installs the extension on a machine **without** the desktop
   app. The listing must say the app is required and link to it, and the
   reviewer notes must explain how to test; see `store-listing.md`. The
   popup shows a setup card with the download link when the app is missing.
4. The desktop app is distributed two ways, and the popup, the listing and
   `store-listing.md` mention both:
   - GitHub Releases on the public repo `wowanirudh-boop/streamgrab-releases`
     (the code repo stays private). After `npm run dist`, copy the installer to
     `StreamGrab-Setup.exe` and `gh release create vX.Y.Z StreamGrab-Setup.exe
     --repo wowanirudh-boop/streamgrab-releases`. The asset name must not
     change: the README there links `releases/latest/download/StreamGrab-Setup.exe`.
   - winget as `AnirudhSangubhotla.StreamGrab` (manifests under
     `manifests/a/AnirudhSangubhotla/StreamGrab/<version>` in
     `microsoft/winget-pkgs`). Each release needs a new-version PR with the
     version-pinned installer URL and its SHA-256; the NSIS uninstall
     ProductCode is `{43c9fd28-a257-5401-a49a-3475b27df382}`.
   The installer is not code-signed, so SmartScreen prompts on first run;
   the release notes and reviewer notes say so.

## Limitations (read these)

- **DRM (Widevine/PlayReady) is not supported** and never will be by this
  approach — Netflix/Disney+/etc. segments are encrypted. This works on clear
  (non-DRM) streams and direct files only.
- Detection state is kept in `chrome.storage.session`, so it survives Chrome
  evicting the MV3 service worker mid-playback, but it is cleared when the
  browser closes. If a video was playing before the extension was installed or
  reloaded, reload the page to detect it.
- Stream fragments seen without their playlist show as a single **PARTS** row
  that cannot be downloaded (a fragment is not a video). The popup's
  **copy report** link copies everything the detector saw on the tab, for
  diagnosing such a site.
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

- **A download failed**: the reason is shown under the row in the app. The
  installed (release) build keeps **no log file** so nothing grows on disk; to
  capture one, start it with `--sg-debug` and the footer **Log** button opens
  `%APPDATA%\StreamGrab\app.log` (full yt-dlp output, DevTools open). Dev runs
  via `npm start` always log; `npm run debug` makes them verbose.
- Popup says **Native host has exited**: read `%APPDATA%\StreamGrab\host.log`.
- Popup says **forbidden**: the extension id is not in `allowed_origins` of
  `%APPDATA%\StreamGrab\com.streamgrab.host.json` (see *Publishing*).
- Popup says **not found**: the app has never run on this machine; start it once.

## A note on use

Downloading is legitimate for content you own or that permits it. Many sites'
Terms of Service prohibit downloading, and some content is copyrighted — where
you point this tool is your responsibility.
