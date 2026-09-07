# bin/ — bundled tools

The engine looks in this folder first, then falls back to your system `PATH`.
The installer ships everything in here as `resources/bin`.

**Populate it with one command** (downloads from the official sources below):

```bash
npm run fetch-tools
```

`--force` re-downloads everything; `--only=aria2c,ffprobe` limits it.

| File          | Purpose                                              | Source |
|---------------|------------------------------------------------------|--------|
| `yt-dlp.exe`  | Manifest parsing, format selection, HLS/DASH, sites  | https://github.com/yt-dlp/yt-dlp/releases |
| `ffmpeg.exe`  | Muxing segments → mp4 (required by yt-dlp)           | https://www.gyan.dev/ffmpeg/builds/ (release-essentials) |
| `ffprobe.exe` | Media metadata for yt-dlp (same build as ffmpeg)     | same archive as ffmpeg |
| `aria2c.exe`  | Fast 16-connection HTTP for progressive/direct files | https://github.com/aria2/aria2/releases |

`ffmpeg.exe` and `ffprobe.exe` are pulled from the **same** archive so their
versions always match. `aria2c.exe` is optional: without it, direct files fall
back to yt-dlp's single-connection downloader (or disable `useAria2` in settings).

These binaries are intentionally **not** committed — see `.gitignore`.
