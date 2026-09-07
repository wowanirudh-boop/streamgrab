# PRD — StreamGrab

**Working name:** StreamGrab
**Version:** 1.1 — V1 work started (list clear, persistence, tools bundled)
**Author:** Anirudh (with Claude)
**Date:** 2026-09-07 (v1.0 · v1.1)

> This PRD was written *after* the MVP was built and used, not before. So the
> "MVP" section below describes what already exists and works, and the V1/V2
> sections describe where the product goes next. Everything here is grounded in
> the current code and in what actually happened when downloads were run — the
> known gaps come from the app's own logs, not from theory.
>
> There is no separate tech spec. The `README.md` carries the architecture and
> the wire protocol; this document states *what the product does and why*.

---

## 1. Problem Statement

Downloading video from the web is either impossible or annoying. The browser's
own "Save" does nothing for streaming video, because the video never arrives as
one file — it is a manifest (`.m3u8` / `.mpd`) that points at hundreds of small
segments the player stitches together in memory. Internet Download Manager (IDM)
solves part of this: it sniffs media on the wire and downloads it with many
parallel connections. But IDM only knows what it can see on the network, fails
on players that hide the manifest, has no understanding of the *site* it is on,
and handles authenticated, live, and multi-track streams poorly or not at all.

StreamGrab replaces that with a Chrome extension that detects video (including
video IDM misses) and hands it to a desktop app that downloads it fast with
**yt-dlp + aria2 + ffmpeg** — the combination that already understands thousands
of sites, HLS/DASH, format selection, and muxing. The goal is a download manager
that is not just as fast as IDM but **more capable** than it, everywhere that
capability — not raw speed — is what actually decides whether a download works.

## 2. Target User & Context

- A power user on **Windows** who downloads video from the web regularly:
  lecture and course platforms, conference and webinar recordings, sports and
  news clips, social video, and direct file links.
- Runs **Chrome** (or Edge/Brave/Vivaldi) as the daily browser. Comfortable
  installing a desktop app and an unpacked extension; not comfortable running
  command-line yt-dlp by hand for every download.
- Wants **one click from "I'm watching this" to "it's in my Downloads folder"**,
  at the best available quality, with the right audio and subtitles, and without
  babysitting the transfer.
- Downloads content they are entitled to download. Where they point the tool is
  their responsibility (see §4 and §9).

## 3. Goals

1. **Detect more than IDM does.** Anything IDM catches on the wire, plus video
   behind `blob:`/MediaSource players and yt-dlp-supported sites (YouTube, etc.)
   that never expose a downloadable manifest at all.
2. **One-click handoff.** From the floating in-page button or the toolbar popup
   to a running download, with no copy-paste of URLs and no manual setup.
3. **Make authenticated streams work.** Carry the browser session (cookies,
   referer, user-agent, per-segment credentials) through to the downloader so
   login-gated, non-DRM video downloads succeed where IDM's partial cookie
   handling fails.
4. **Give control IDM doesn't.** Choose resolution, audio language, and
   subtitles; record live streams; convert and trim after download — using the
   ffmpeg that is already bundled.
5. **Be fast and resilient.** Multi-connection downloading (aria2), proper
   resume, and a queue that survives an app restart.
6. **Stay reachable.** The app lives in the tray and is auto-started by the
   native host when Chrome needs it, so the extension is never talking to a dead
   endpoint.

## 4. Non-Goals

- **No DRM circumvention.** Widevine / PlayReady content (Netflix, Disney+, Prime
  Video, etc.) is explicitly out of scope, permanently. Those segments are
  encrypted and downloading them means defeating a technical protection measure,
  which is unlawful (DMCA §1201 and equivalents). IDM cannot do this either; it
  is not where the product competes. StreamGrab works on clear (non-DRM) streams
  and direct files only.
- **No general-purpose (non-video) download manager.** The product is
  video-first. Arbitrary file downloading (documents, archives) is a possible
  side effect of the direct-file path, not a goal, and gets no dedicated UX.
- **No piracy tooling.** No account-sharing, no paywall bypass beyond replaying
  the user's *own* authenticated session, no credential harvesting.
- **No mobile app.** Windows desktop + Chrome-family browsers only for now
  (macOS/Linux is a possible later port; the native host is Windows-specific
  today).
- **No cloud service or account.** Everything is local: local app, local bridge,
  local files. No sync, no telemetry, no server.
- **No transcoding farm.** ffmpeg post-processing is limited to fast,
  common operations (remux, extract audio, trim, embed metadata) — not a full
  re-encoding studio.

## 5. Scope Summary

| Phase | Theme | Features |
|---|---|---|
| **MVP** *(built)* | Detect → hand off → download | F1 Detection · F2 Handoff & bridge · F3 Download engine · F4 Download list UI · F5 Session capture (basic) |
| **V1** *(next)* | Beat IDM where it's weak | F6 List management & persistence · F7 Quality/track selection · F8 Session-aware auth · F9 Settings UI · F10 Pause/resume |
| **V2** *(later)* | Capabilities IDM lacks entirely | F11 blob:/MSE reconstruction · F12 Live-stream recording · F13 Post-processing · F14 Scheduler & bandwidth cap · F15 Torrent/Metalink · F16 Categories, clipboard monitor, batch import |
| **Out of scope** | — | Everything in §4 (DRM, mobile, cloud, piracy) |

## 6. User Stories

- *As a viewer*, when a video is playing in my tab, I see a **⬇ Download**
  button on the page and one click starts the download — I never touch a URL.
- *As a course student*, I can download a lecture that only plays after I log
  in, because the app reuses my browser session.
- *As someone who cares about quality*, I can pick **1080p** instead of whatever
  the player defaulted to, and get the English audio track with subtitles muxed
  in.
- *As a heavy user*, my download list doesn't fill up with junk — I can **clear
  completed** items, or clear everything, in one click, and the list I care
  about is still there after I restart the app.
- *As an impatient user*, big direct files download in many parallel
  connections, and if my connection drops the download **resumes** instead of
  starting over.
- *As someone recording a livestream*, I can capture a live HLS broadcast from
  now until I stop it (or on a schedule).

## 7. Functional Requirements

### MVP (built and in use)

**F1 — Detection (Chrome extension).**
- Detect HLS (`.m3u8`), DASH (`.mpd`), and progressive video (`.mp4/.webm/...`)
  via `webRequest`, by URL extension and by response `Content-Type`.
- For HLS, fetch the playlist and distinguish a **master** manifest (the whole
  video with quality variants) from **variant/segment** playlists, so one video
  shows as **one** item, not one-per-quality.
- Suppress noise: ignore tiny progressive responses (< 300 KB) and
  `googlevideo.com` fragment chunks (YouTube is handled via the page URL).
- **Page-level detection** for yt-dlp-supported sites that never expose a
  manifest (YouTube, Vimeo, Dailymotion, Twitch, X, TikTok, Facebook,
  Instagram): offer "download this page's video" from the tab URL.
- Surface detections as a **floating in-page pill** (expands to a per-video
  list) and a **toolbar popup**, with a badge count per tab.

**F2 — Handoff & bridge.**
- Chrome **native messaging** to a dependency-free C# host
  (`streamgrab-host.exe`) that relays JSON over stdio ↔ a local TCP bridge
  (token-authenticated, `127.0.0.1`).
- The host **launches the app** (hidden) if it isn't running and connects once
  it is up; it re-reads `bridge.json` each attempt to survive the startup race.
- The app **owns its registration**: on every start it writes the native-host
  manifest and per-user registry keys for Chrome/Edge/Brave/Vivaldi/Chromium.
  Nothing to install by hand.

**F3 — Download engine.**
- Wrap **yt-dlp** for manifest parsing, format selection, and HLS/DASH; **ffmpeg**
  for muxing to mp4; **aria2c** (when present) for fast multi-connection HTTP on
  direct files.
- Parse progress from a controlled `--progress-template` line (percent, speed,
  ETA, bytes) and report the final post-mux file path.
- Queue with **up to 3 concurrent** downloads; per-item states: queued /
  downloading / done / error / canceled.

**F4 — Download list UI (desktop app).**
- A table of downloads with name, type badge, size, progress bar, speed, ETA.
- Per-row actions: **Stop**, **Retry**, **Open** (reveal in folder), **remove**.
- Paste-a-URL box, choose-download-folder, start-with-Windows toggle, a status
  bar showing whether the Chrome link is ready, and a **Log** button.

**F5 — Session capture (basic).**
- Capture each media request's **Referer / Cookie / User-Agent / Origin** and
  replay them to yt-dlp.
- **Sample per-segment and AES-key requests** so signed-CDN streams (CloudFront
  policy/signature, etc.) whose segments carry different credentials than the
  manifest still download, by replaying the query the page's own player used.

### V1 (next — close the obvious gaps, start beating IDM)

**F6 — List management & persistence.** *(includes the named usability fix)*
- ✅ **Clear the list from the UI** *(built v1.1)*: "Clear completed" removes
  done / error / canceled rows and shows the count; "Clear all" cancels active
  downloads first, then empties the list, behind a confirm.
- ✅ **Persist the queue** *(built v1.1)* to `%APPDATA%\StreamGrab\queue.json`
  (debounced, atomic write; flushed on quit; newest 500 rows kept). The list —
  including completed history — survives an app restart. Downloads that were
  in flight at shutdown reappear as *Interrupted* with a **Retry**, which
  resumes the partial file; they are deliberately not auto-restarted on what
  may be a hidden autostart at login.
- Sort/filter the list (active first; filter by state).

**F7 — Quality & track selection.**
- Surface HLS/DASH **variants** in the popup/overlay so the user picks a
  resolution instead of yt-dlp guessing. (The variant URL is already captured in
  the background worker; this exposes it in the UI.)
- Choose **audio language** and **subtitle** tracks; mux the chosen tracks into
  the output with ffmpeg.
- A per-download "audio only" option (extract to m4a/mp3).

**F8 — Session-aware auth (make login-gated streams reliable).**
- Optionally read cookies directly from the browser profile
  (`--cookies-from-browser`) as a fallback when the captured `Cookie` header is
  insufficient — resolving `403 Forbidden` on sites that rotate or scope cookies
  per-request (observed on at least one real download).
- Preserve the exact request context end-to-end (already partially done in F5);
  make it robust for multi-origin manifests.

**F9 — Settings UI.**
- Expose what is currently JSON-file-only: concurrent-fragment count, aria2
  on/off, cookies-from-browser source, default download folder, concurrent
  download limit. No more hand-editing `settings.json`.

**F10 — Pause / resume.**
- True pause (suspend the transfer) and resume, replacing today's stop+retry.
  yt-dlp's `--continue` already resumes partial files; wire it to a Pause
  control and persist partial state.

### V2 (later — capabilities IDM does not have at all)

**F11 — blob:/MediaSource reconstruction.** Reconstruct a downloadable manifest
from the segment requests observed for players that feed video via `blob:` URLs
and MediaSource Extensions (where IDM sees nothing to grab).

**F12 — Live-stream recording.** Record a live HLS/DASH broadcast from a start
to a stop (manual or scheduled), assembling segments as they arrive.

**F13 — Post-processing.** ffmpeg-backed convert, trim/clip, extract audio,
embed thumbnail and metadata — as post-download steps on a finished item.

**F14 — Scheduler & bandwidth cap.** Schedule downloads for a time window;
global and per-download speed limits (IDM parity, plus scheduling that suits
live capture).

**F15 — Torrent / Metalink.** aria2 already supports BitTorrent and Metalink;
expose them (a capability IDM lacks entirely).

**F16 — Convenience.** Categories/folders by type, optional clipboard-URL
monitoring, and batch URL import.

## 8. Key UX Flows

1. **Detect → download (streaming).** Video plays → extension detects → pill
   shows "1 video" → click **Download** (optionally pick quality) → popup shows
   "Sent ✓" → the app (auto-started if needed) downloads and reveals the file.
2. **Detect → download (yt-dlp site).** Open a YouTube/Vimeo/etc. page → the
   page-level item appears → one click → yt-dlp pulls the best format from the
   page URL.
3. **Manual URL.** Paste any video/page/`.m3u8` URL into the app's box → Enter →
   it downloads with `kind: auto`.
4. **Housekeeping.** After a batch of downloads, click **Clear completed** to
   tidy the list; the still-running and still-wanted items remain, and the list
   is intact after the next app restart.

## 9. Constraints & Principles

- **No DRM, ever** (§4). This is a hard line, not a backlog item.
- **Local-only and dependency-light on the user's PC.** The native host needs no
  Node or compiler at runtime; the app ships its own yt-dlp/ffmpeg/aria2. No
  server, no account, no telemetry.
- **The app owns registration and stays reachable.** Whichever build ran last
  writes the manifest + registry keys; the host auto-starts the app.
- **Fail loudly and legibly.** Every yt-dlp ERROR/WARNING is logged; the failing
  reason is shown under the row and in `app.log`.
- **Windows-first.** Native host and registration are Windows-only for now.
- **Responsibility sits with the user.** Many sites' Terms prohibit downloading
  and much content is copyrighted; the tool does not police where it is pointed,
  and that choice is the user's.

## 10. Success Metrics

- **Detection rate:** of videos a user actually wants on supported sites, the
  share StreamGrab surfaces a download for (target: beats IDM on a fixed test
  set, especially blob:/MSE and yt-dlp-site cases).
- **Download success rate:** started downloads that finish with a playable file
  (track `403`/auth failures specifically — the F8 target is ~0 on the user's
  own authenticated content).
- **Clicks to download:** ≤ 1 from the in-page button for a detected video.
- **Speed:** direct-file throughput within parity of IDM with aria2 at 16
  connections.
- **Resilience:** queue and history survive an app restart; interrupted
  downloads resume rather than restart.

## 11. Risks & Open Questions

- ~~**aria2 not bundled today.**~~ *Resolved v1.1:* `npm run fetch-tools`
  (`scripts/fetch-tools.js`) pulls yt-dlp, aria2c 1.37.0, and a matching
  ffmpeg + ffprobe pair from their official sources into `bin/`; the installer
  ships them. Multi-connection direct-file downloads are now real.
- ~~**MV3 service-worker eviction** can drop the per-tab detection list.~~
  *Resolved v1.2:* detections persist in `chrome.storage.session` and are
  restored before any event is handled; verified by killing the worker
  mid-playback over CDP. This was the root cause of a real report (a site
  where IDM listed six HLS qualities but StreamGrab showed only eight small
  MP4 fragments: the master playlist had been lost to an eviction).
- **Cookie DB locking on Windows** when Chrome is running makes
  `--cookies-from-browser` unreliable; F8 must degrade gracefully to the
  captured header.
- **Web Store id** is not yet in the host's allow-list (needs a draft upload
  first); users can add ids via `extraExtensionIds` meanwhile.
- **Stale HKLM host key** from an earlier build points at a removed manifest;
  harmless while the HKCU key exists, but should be cleaned by the uninstaller.
- **Live capture (F12)** has no natural "size/ETA" and needs a different UI
  affordance than a progress bar.

## 12. Phasing

| Phase | Ships | Definition of done |
|---|---|---|
| **MVP** | Built | Detect + handoff + download + list, verified against real HLS/DASH/progressive and yt-dlp sites |
| **V1** | In progress | ✅ List clear · ✅ persistence · ✅ aria2+ffprobe bundled · ⬜ quality/track picker · ⬜ reliable auth · ⬜ settings UI · ⬜ pause/resume |
| **V2** | Later | blob:/MSE, live recording, post-processing, scheduler/bandwidth, torrent, convenience features |

## 13. Revision Log

- **v1.2 (2026-09-08)** — Detection hardening after a real site report.
  Detections persist across service-worker restarts; playlists are recognised
  by broader content-types, by `m3u8`/`.mpd` anywhere in the URL, and by
  body-sniffing ambiguous responses; byte-range (206) chunks collapse to one
  file with its true size; fragments of a known playlist are hidden and
  orphan numbered fragments collapse to one non-downloadable PARTS row;
  `EXT-X-MEDIA` audio/subtitle renditions fold into their master. Popup gains
  **copy report** for diagnosing sites. Also: overlay hides in fullscreen;
  release builds write no log file unless `--sg-debug`.
- **v1.1 (2026-09-07)** — V1 started. Built: clear-completed / clear-all in the
  UI; queue persistence to `queue.json` with interrupted-download recovery;
  `fetch-tools` script bundling aria2c and a matching ffmpeg/ffprobe pair.
  §11 aria2 risk closed.
- **v1.0 (2026-09-07)** — First PRD, written after the MVP shipped. Documents the
  built MVP as-is; sets DRM permanently out of scope; frames V1/V2 around
  out-capability-ing IDM where speed is not the deciding factor. Names the
  known gaps found in the code and logs (no list-clear, no persistence, aria2
  not bundled, no quality picker, no settings UI, auth 403s).
