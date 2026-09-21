# Renders the Chrome Web Store screenshots and promo tiles into dist/store-assets
# with headless Chrome. Run: python scripts/build-store-assets.py
import sys, os, shutil, subprocess
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
A = os.path.join(PROJ, "dist", "store-assets")
os.makedirs(A, exist_ok=True)
shutil.copy(os.path.join(PROJ, "build", "icon.png"), os.path.join(A, "icon.png"))
shutil.copy(os.path.join(PROJ, "extension", "content.css"), os.path.join(A, "content.css"))

BASE = """<!doctype html><html><head><meta charset="utf-8"><style>
:root{--bg:#141821;--bg2:#1b202b;--bg3:#232a38;--line:#2c3444;--text:#e6e9ef;--muted:#8a93a6;--accent:#4c8dff;--green:#34c77b}
*{box-sizing:border-box} html,body{margin:0;width:%(w)spx;height:%(h)spx;overflow:hidden;background:#0f1320;color:var(--text);font:14px/1.4 "Segoe UI",system-ui,sans-serif}
.cap{position:absolute;left:0;right:0;top:0;height:118px;padding:26px 48px;background:linear-gradient(180deg,#0f1320 0%%,#0f1320 70%%,rgba(15,19,32,0) 100%%);z-index:5}
.cap h1{margin:0;font-size:34px;font-weight:800;letter-spacing:-.3px}
.cap h1 b{color:var(--accent)} .cap p{margin:6px 0 0;font-size:17px;color:var(--muted)}
.stage{position:absolute;left:48px;right:48px;top:128px;bottom:0;border-radius:14px 14px 0 0;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.6);border:1px solid #2a3140;border-bottom:none;background:var(--bg)}
.chrome{height:38px;background:#202531;display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid #2a3140}
.chrome i{width:12px;height:12px;border-radius:50%%;background:#3a4150;display:inline-block}
.chrome .url{flex:1;margin-left:10px;background:#141821;border-radius:8px;height:24px;color:var(--muted);font-size:12px;line-height:24px;padding:0 10px}
.chrome .ext{width:22px;height:22px;border-radius:5px;background:url(icon.png) center/cover}
%(extra)s
</style></head><body>%(body)s</body></html>"""

def page(name, w, h, extra, body):
    with open(os.path.join(A, name + ".html"), "w", encoding="utf-8") as f:
        f.write(BASE % dict(w=w, h=h, extra=extra, body=body))

# 1. overlay on a video page
video_body = """
<div class="cap"><h1>Find the video. <b>Click Download.</b></h1><p>StreamGrab spots HLS, DASH and MP4 streams on the page you are watching.</p></div>
<div class="stage">
 <div class="chrome"><i></i><i></i><i></i><span class="url">https://example-news.com/watch/city-marathon-highlights</span><span class="ext"></span></div>
 <div class="site">
  <div class="player"><div class="frame"></div><div class="play">&#9654;</div><div class="bar"><span></span></div></div>
  <h2>City marathon highlights: record crowd cheers runners to the finish</h2>
  <p class="meta">Sports &middot; 6 min &middot; 1080p</p>
 </div>
 <div id="streamgrab-overlay" class="sg-open">
  <button class="sg-pill"><span class="sg-ico">&#11015;</span><span class="sg-count">2</span><span class="sg-word"> videos</span></button>
  <div class="sg-list">
   <div class="sg-row"><div class="sg-meta"><span class="sg-badge sg-hls">MP4</span><span class="sg-title">city-marathon-highlights</span><span class="sg-size">1080p &middot; HLS</span></div>
     <div class="sg-act"><select class="sg-q"><option>1080p</option></select><button class="sg-dl">Download</button></div></div>
   <div class="sg-row"><div class="sg-meta"><span class="sg-badge sg-progressive">MP4</span><span class="sg-title">preview-clip.mp4</span><span class="sg-size">720p &middot; 18 MB</span></div>
     <div class="sg-act"><select class="sg-q"><option>720p</option></select><button class="sg-dl">Download</button></div></div>
  </div>
 </div>
</div>"""
video_extra = open(os.path.join(A, "content.css"), encoding="utf-8").read() + """
.site{padding:26px 40px;background:#fff;color:#1a1d24;height:100%}
.player{position:relative;width:100%;height:430px;border-radius:10px;overflow:hidden;background:#000}
.frame{position:absolute;inset:0;background:radial-gradient(ellipse at 30% 40%,#3b5bdb 0%,#1b2a6b 35%,#0b1230 70%,#05070f 100%)}
.frame:after{content:"";position:absolute;left:0;right:0;bottom:0;height:160px;background:linear-gradient(0deg,rgba(0,0,0,.6),transparent)}
.play{position:absolute;left:50%;top:50%;width:76px;height:76px;margin:-38px 0 0 -38px;border-radius:50%;background:rgba(255,255,255,.92);color:#111;font-size:30px;display:flex;align-items:center;justify-content:center;padding-left:6px}
.bar{position:absolute;left:18px;right:18px;bottom:18px;height:5px;background:rgba(255,255,255,.3);border-radius:3px}.bar span{display:block;width:38%;height:100%;background:#ff3b30;border-radius:3px}
.site h2{margin:18px 0 6px;font-size:22px;font-weight:700}.meta{color:#6b7280;margin:0}
#streamgrab-overlay{display:block !important;position:absolute;right:22px;bottom:22px}
#streamgrab-overlay .sg-list{display:block;width:430px}
#streamgrab-overlay .sg-title{max-width:210px}
"""
page("shot1", 1280, 800, video_extra, video_body)

# 2. popup with quality picker
popup_extra = """
.pop{position:absolute;left:50%;top:170px;width:340px;margin-left:-170px;background:var(--bg);border:1px solid var(--line);border-radius:10px;box-shadow:0 30px 80px rgba(0,0,0,.6);font-size:13px;transform:scale(1.55);transform-origin:top center}
header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line)}
.brand{font-weight:700;color:var(--accent)} .conn{margin-left:auto;font-size:11px;color:var(--green)}
.row{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid #232a38}
.badge{font-size:10px;font-weight:800;padding:2px 6px;border-radius:4px;background:#232a38;color:#8a93a6}
.hls{color:#7ec4ff}.progressive{color:#9be7a0}.dash{color:#c39bff}
.t{flex:1;min-width:0}.t .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.t .s{color:var(--muted);font-size:11px}
select.q{background:#232a38;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px;font:inherit;font-size:12px}
button{background:var(--accent);color:#fff;border:none;border-radius:6px;padding:5px 10px;font-weight:600}
footer{display:flex;justify-content:flex-end;padding:6px 12px;font-size:11px;color:var(--muted)}
.stage{display:none}
"""
popup_body = """
<div class="cap"><h1>Pick the <b>quality</b> you want.</h1><p>Resolution or audio-only, per video, from the toolbar popup or the on-page button.</p></div>
<div class="pop">
 <header><span class="brand">&#9654; StreamGrab</span><span class="conn">&#9679; app connected</span></header>
 <div class="row"><span class="badge hls">MP4</span><div class="t"><div class="n">Keynote: the future of open hardware</div><div class="s">1080p &middot; HLS stream</div></div><select class="q"><option>1080p</option></select><button>Download</button></div>
 <div class="row"><span class="badge dash">MP4</span><div class="t"><div class="n">Episode 12 &ndash; Deep sea robots</div><div class="s">720p &middot; DASH stream</div></div><select class="q"><option>Audio only</option></select><button>Download</button></div>
 <div class="row"><span class="badge progressive">MP4</span><div class="t"><div class="n">trailer-final.mp4</div><div class="s">1080p &middot; 42 MB</div></div><select class="q"><option>Best</option></select><button>Download</button></div>
 <footer>copy report</footer>
</div>"""
page("shot2", 1280, 800, popup_extra, popup_body)

# 3. desktop app
app_css = open(os.path.join(PROJ, "app", "renderer", "styles.css"), encoding="utf-8").read().replace("html, body { height: 100%; margin: 0; }", "")
app_extra = app_css + """
.stage{display:flex;flex-direction:column;background:var(--bg)}
body{display:block}
.stage main{flex:1}
.topbar .add{max-width:560px}
"""
app_body = """
<div class="cap"><h1>Downloads run in the <b>desktop app</b>.</h1><p>Multi-connection speed, progress, retry, and a folder that opens when it is done.</p></div>
<div class="stage">
 <header class="topbar"><div class="brand">&#9654; StreamGrab</div><div class="add"><input type="text" placeholder="Paste a video / page / .m3u8 URL and press Enter&hellip;"><select><option>Best</option></select><button>Download</button></div><div class="spacer"></div><label class="ghost toggle"><input type="checkbox" checked> Start with Windows</label><button class="ghost">&#128193; Downloads</button></header>
 <main><table class="downloads"><thead><tr><th class="c-name">Name</th><th class="c-kind">Type</th><th class="c-size">Size</th><th class="c-prog">Progress</th><th class="c-speed">Speed</th><th class="c-eta">ETA</th><th class="c-actions"></th></tr></thead>
 <tbody>
  <tr><td class="c-name"><div class="name">Keynote: the future of open hardware</div><div class="suburl">https://example-conf.org/talks/keynote-2026</div></td><td class="c-kind"><span class="badge hls">hls</span><div class="fmt">1080p</div></td><td class="c-size">612 MB</td><td class="c-prog"><div class="bar"><span style="width:63%"></span></div><div class="pct">63%</div></td><td class="c-speed">12.4 MB/s</td><td class="c-eta">0:18</td><td class="c-actions"><div class="row-actions"><button>Stop</button><button>&#10005;</button></div></td></tr>
  <tr><td class="c-name"><div class="name">Episode 12 &ndash; Deep sea robots</div><div class="suburl">https://example-tv.com/series/deep-sea/12</div></td><td class="c-kind"><span class="badge dash">dash</span><div class="fmt">Audio only</div></td><td class="c-size">38 MB</td><td class="c-prog"><div class="bar"><span style="width:21%"></span></div><div class="pct">21%</div></td><td class="c-speed">6.1 MB/s</td><td class="c-eta">0:05</td><td class="c-actions"><div class="row-actions"><button>Stop</button><button>&#10005;</button></div></td></tr>
  <tr><td class="c-name"><div class="name">City marathon highlights</div><div class="suburl">https://example-news.com/watch/city-marathon-highlights</div></td><td class="c-kind"><span class="badge hls">hls</span><div class="fmt">1080p</div></td><td class="c-size">245 MB</td><td class="c-prog"><span class="state-done">Done</span></td><td class="c-speed"></td><td class="c-eta"></td><td class="c-actions"><div class="row-actions"><button>Open</button><button>&#10005;</button></div></td></tr>
  <tr><td class="c-name"><div class="name">trailer-final.mp4</div><div class="suburl">https://cdn.example.com/media/trailer-final.mp4</div></td><td class="c-kind"><span class="badge progressive">progressive</span></td><td class="c-size">42 MB</td><td class="c-prog"><span class="state-done">Done</span></td><td class="c-speed"></td><td class="c-eta"></td><td class="c-actions"><div class="row-actions"><button>Open</button><button>&#10005;</button></div></td></tr>
 </tbody></table></main>
 <footer class="statusbar"><span class="dot">&#9679;</span><span>Chrome extension connected</span><span class="spacer"></span><span>2 active &middot; 2 done</span><button class="ghost small">Clear completed</button><button class="ghost small">Clear all</button></footer>
</div>"""
page("shot3", 1280, 800, app_extra, app_body)

# 4. how it works
how_extra = """
.stage{display:none}
.steps{position:absolute;left:48px;right:48px;top:190px;display:flex;gap:28px}
.step{flex:1;background:var(--bg2);border:1px solid var(--line);border-radius:16px;padding:30px 28px;min-height:440px;position:relative}
.num{width:44px;height:44px;border-radius:50%;background:var(--accent);color:#fff;font-weight:800;font-size:20px;display:flex;align-items:center;justify-content:center;margin-bottom:22px}
.step h3{margin:0 0 10px;font-size:24px}.step p{margin:0;color:var(--muted);font-size:16px;line-height:1.5}
.ico{position:absolute;right:26px;top:26px;width:56px;height:56px;border-radius:12px;background:url(icon.png) center/cover}
.pill{display:inline-flex;align-items:center;gap:6px;background:var(--accent);color:#fff;border-radius:999px;padding:9px 14px;font-weight:700;margin-top:26px;box-shadow:0 6px 20px rgba(0,0,0,.35)}
.mono{display:inline-block;margin-top:26px;background:#0f1320;border:1px solid var(--line);border-radius:8px;padding:8px 12px;font:14px Consolas,monospace;color:#cfe0ff}
.free{position:absolute;left:48px;bottom:34px;color:var(--muted);font-size:15px}
"""
how_body = """
<div class="cap"><h1>Three steps. <b>Free.</b></h1><p>The extension detects. The Windows desktop app downloads. No account, no ads.</p></div>
<div class="steps">
 <div class="step"><div class="ico"></div><div class="num">1</div><h3>Install the desktop app</h3><p>Download it from GitHub or install with winget. Open it once and it connects to Chrome by itself.</p><span class="mono">winget install AnirudhSangubhotla.StreamGrab</span></div>
 <div class="step"><div class="num">2</div><h3>Play a video</h3><p>On any site with a clear (non-DRM) stream. A floating button appears over the player when StreamGrab finds something it can save.</p><span class="pill">&#11015; 1 video</span></div>
 <div class="step"><div class="num">3</div><h3>Click Download</h3><p>Choose a resolution or audio-only. The app fetches the stream with multiple connections and saves a plain MP4 in your downloads folder.</p><span class="pill" style="background:#34c77b">Sent &#10003;</span></div>
</div>
<div class="free">Works with HLS (.m3u8), DASH (.mpd) and direct MP4 files. Not for DRM services such as Netflix or Disney+.</div>"""
page("shot4", 1280, 800, how_extra, how_body)

# 5. small promo tile 440x280
tile = """<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:440px;height:280px;overflow:hidden;background:radial-gradient(ellipse at 20% 20%,#1e2a4a 0%,#0f1320 60%);color:#e6e9ef;font:14px "Segoe UI",system-ui,sans-serif}
.ico{position:absolute;left:34px;top:60px;width:110px;height:110px;border-radius:24px;background:url(icon.png) center/cover;box-shadow:0 16px 40px rgba(0,0,0,.5)}
.t{position:absolute;left:170px;top:66px}
.t h1{margin:0;font-size:40px;font-weight:800;letter-spacing:-.5px}.t h1 b{color:#4c8dff}
.t p{margin:8px 0 0;font-size:16px;color:#aeb6c8;line-height:1.35;max-width:240px}
.pill{position:absolute;left:34px;bottom:34px;display:inline-flex;align-items:center;gap:6px;background:#4c8dff;color:#fff;border-radius:999px;padding:8px 14px;font-weight:700;font-size:14px;box-shadow:0 6px 20px rgba(0,0,0,.35)}
.tag{position:absolute;left:170px;bottom:44px;color:#8a93a6;font-size:12px;white-space:nowrap}
</style></head><body><div class="ico"></div><div class="t"><h1>Stream<b>Grab</b></h1><p>Download streaming video from any site. HLS, DASH, MP4.</p></div><span class="pill">&#11015; Download</span><span class="tag">Free &middot; Windows</span></body></html>"""
open(os.path.join(A, "tile.html"), "w", encoding="utf-8").write(tile)

# 6. marquee 1400x560
marq = """<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:1400px;height:560px;overflow:hidden;background:radial-gradient(ellipse at 15% 30%,#1e2a4a 0%,#0f1320 55%);color:#e6e9ef;font:14px "Segoe UI",system-ui,sans-serif}
.ico{position:absolute;left:90px;top:150px;width:200px;height:200px;border-radius:44px;background:url(icon.png) center/cover;box-shadow:0 30px 70px rgba(0,0,0,.55)}
.t{position:absolute;left:340px;top:150px;max-width:560px}
.t h1{margin:0;font-size:72px;font-weight:800;letter-spacing:-1px;line-height:1}.t h1 b{color:#4c8dff}
.t p{margin:18px 0 0;font-size:26px;color:#aeb6c8;line-height:1.35}
.t .sub{margin-top:22px;font-size:17px;color:#8a93a6}
.card{position:absolute;right:80px;top:110px;width:400px;background:#1b202b;border:1px solid #2c3444;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.6);overflow:hidden;font-size:15px}
.card header{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid #2c3444}
.card .brand{font-weight:700;color:#4c8dff}.card .conn{margin-left:auto;font-size:13px;color:#34c77b}
.row{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid #232a38}
.badge{font-size:11px;font-weight:800;padding:3px 7px;border-radius:4px;background:#232a38;color:#7ec4ff}.badge.p{color:#9be7a0}
.n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.n small{display:block;color:#8a93a6;font-size:12px}
.q{background:#232a38;border:1px solid #2c3444;border-radius:6px;padding:5px 8px;font-size:13px}
.b{background:#4c8dff;color:#fff;border-radius:6px;padding:7px 12px;font-weight:600}
.b.g{background:#34c77b}
</style></head><body><div class="ico"></div><div class="t"><h1>Stream<b>Grab</b></h1><p>Download streaming video from any site with one click.</p><div class="sub">HLS &middot; DASH &middot; MP4 &middot; Quality picker &middot; Free Windows desktop app</div></div>
<div class="card"><header><span class="brand">&#9654; StreamGrab</span><span class="conn">&#9679; app connected</span></header>
<div class="row"><span class="badge">MP4</span><div class="n">Keynote: the future of open hardware<small>1080p &middot; HLS stream</small></div><span class="q">1080p</span><span class="b">Download</span></div>
<div class="row"><span class="badge p">MP4</span><div class="n">trailer-final.mp4<small>1080p &middot; 42 MB</small></div><span class="q">Best</span><span class="b g">Sent &#10003;</span></div>
<div class="row"><span class="badge">MP4</span><div class="n">Episode 12 &ndash; Deep sea robots<small>720p &middot; DASH stream</small></div><span class="q">Audio only</span><span class="b">Download</span></div>
</div></body></html>"""
open(os.path.join(A, "marquee.html"), "w", encoding="utf-8").write(marq)

# render
CH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
UD = os.path.join(A, "chrome-profile")
os.makedirs(UD, exist_ok=True)
specs = [("shot1", 1280, 800), ("shot2", 1280, 800), ("shot3", 1280, 800), ("shot4", 1280, 800), ("tile", 440, 280), ("marquee", 1400, 560)]
for name, w, h in specs:
    out = os.path.join(A, name + ".png")
    src = "file:///" + os.path.join(A, name + ".html").replace("\\", "/")
    subprocess.run([CH, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
                    "--user-data-dir=" + UD, "--force-device-scale-factor=1",
                    "--window-size=%d,%d" % (w, h), "--screenshot=" + out, src],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90)
from PIL import Image
for name, w, h in specs:
    p = os.path.join(A, name + ".png")
    print(name, Image.open(p).size if os.path.exists(p) else "MISSING")
