# Chrome Web Store listing (paste into the Developer Dashboard)

Reviewers install the extension on a clean machine, and shoppers decide from
the title, the first two lines and the screenshots. Everything below is written
for both. Never mention YouTube anywhere in the listing: the store rejects
downloaders that name it.

## Title and summary (come from manifest.json, 0.1.4)

- Title: StreamGrab - Video Downloader
- Summary: Download streaming video from any site: HLS (m3u8), DASH, MP4. One click, quality picker. Free Windows desktop app required.

## Category and language

- Category: Productivity > Tools (pick "Tools" if the dashboard offers it as a top-level category)
- Language: English
- Homepage URL: https://github.com/wowanirudh-boop/streamgrab-releases/releases/latest
- Support URL: https://github.com/wowanirudh-boop/streamgrab-releases/issues

## Description

StreamGrab downloads the streaming video you are watching. It detects HLS (.m3u8), DASH (.mpd) and direct MP4 streams on any page, shows a Download button over the player, and saves the video as a normal MP4 file through its free Windows desktop app.

REQUIRES THE FREE STREAMGRAB DESKTOP APP FOR WINDOWS
The extension only detects videos. The desktop app does the downloading. Get it either way:
- Download: https://github.com/wowanirudh-boop/streamgrab-releases/releases/latest
- Or from a terminal: winget install AnirudhSangubhotla.StreamGrab

HOW IT WORKS
1. Install the desktop app and open it once. It connects to Chrome by itself.
2. Play a video. A floating StreamGrab button appears over the player, and the toolbar popup lists everything detected on the tab.
3. Pick a resolution or audio-only, click Download. The app fetches the stream with multiple connections and saves an MP4.

WHAT YOU GET
- One-click download of streaming video (HLS, m3u8, DASH, MP4) from news sites, course platforms, conference sites, social feeds and personal video hosts
- Quality picker per video: 4K, 1080p, 720p, 480p, 360p or audio only
- Real download manager: progress, speed, ETA, stop, retry, open folder
- Fast multi-connection downloads (yt-dlp, aria2 and ffmpeg under the hood)
- Paste any video, page or .m3u8 URL straight into the app
- No account, no ads, no upload of your data anywhere. Everything runs on your PC.

WHAT IT DOES NOT DO
- DRM-protected services (Netflix, Disney+, Prime Video and similar) cannot be downloaded. Only clear streams and direct files work.
- Download only content you own or that permits it. Many sites' terms prohibit downloading; where you point this tool is your responsibility.

PERMISSIONS, EXPLAINED
- Read network requests on all sites: this is how video manifests and media files are detected.
- Native messaging: to talk to the StreamGrab desktop app on your PC.
- Tabs and storage: to keep the per-tab list of detected videos.

Windows 10/11, 64-bit. Works with Chrome, Edge, Brave and Vivaldi.

## Notes for the reviewer (test instructions)

This extension is a companion to a Windows desktop application and does nothing
useful on its own. To test:

1. On Windows, download and run the installer from
   https://github.com/wowanirudh-boop/streamgrab-releases/releases/latest
   (or run: winget install AnirudhSangubhotla.StreamGrab)
   and open StreamGrab once (it stays in the tray).
2. Install the extension, then open any page with a non-DRM video, for example a
   public MP4 or a news site clip, and start playback.
3. Click the toolbar icon: the popup shows "app connected" and lists the video.
   Click Download; the desktop app shows the download progressing.

Without the desktop app the popup shows a setup card with the download link
instead of any download controls. This is by design.

The installer is not yet code-signed, so Windows SmartScreen may show "Windows
protected your PC" on first run. Click "More info", then "Run anyway".

## Images (all in dist/store-assets)

- Screenshots, 1280x800, upload in this order: shot1.png (on-page button),
  shot2.png (quality picker), shot3.png (desktop app), shot4.png (three steps).
- Small promo tile, 440x280: tile.png
- Marquee promo tile, 1400x560: marquee.png

## Where to paste

- Description: Store listing tab, Description field.
- Test instructions: the dashboard's field for reviewer notes or test
  instructions (on the Privacy tab in the current dashboard). If you cannot find
  it, append the "Notes for the reviewer" section to the end of the description.
- Set the Homepage and Support URLs on the Store listing tab.
