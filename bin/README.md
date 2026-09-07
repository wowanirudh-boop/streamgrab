# bin/ — bundled tools

Drop these Windows executables here. The engine looks in this folder first, then
falls back to your system `PATH`.

| File         | Purpose                                        | Get it from |
|--------------|------------------------------------------------|-------------|
| `yt-dlp.exe` | Manifest parsing, format selection, HLS/DASH   | https://github.com/yt-dlp/yt-dlp/releases (`yt-dlp.exe`) |
| `ffmpeg.exe` | Muxing segments → mp4 (required by yt-dlp)     | https://www.gyan.dev/ffmpeg/builds/ (grab `ffmpeg.exe` from the `bin` of a release-essentials build) |
| `aria2c.exe` | Fast 16-connection HTTP for progressive files  | https://github.com/aria2/aria2/releases |

Only `yt-dlp.exe` + `ffmpeg.exe` are strictly required. `aria2c.exe` is optional
(speed boost for direct files); without it, disable `useAria2` in settings or it
is simply skipped when absent.

These binaries are intentionally **not** committed — see `.gitignore`.
