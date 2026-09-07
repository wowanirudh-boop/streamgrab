'use strict';

// Quality choice shared by the popup and the in-page overlay.
//
// A choice is one of:  { kind: 'best' } | { kind: 'height', height: 720 } |
// { kind: 'audio' }.  In a <select> it is encoded as 'best' | 'h720' | 'audio'.
// The desktop app turns it into a yt-dlp format selector, so the same choice
// works for HLS masters, DASH manifests and page-level sites alike.
(function (root) {
  const LADDER = [2160, 1440, 1080, 720, 480, 360, 240, 144];

  function encode(q) {
    if (!q || q.kind === 'best') return 'best';
    if (q.kind === 'audio') return 'audio';
    return 'h' + q.height;
  }
  function parse(v) {
    if (!v || v === 'best') return { kind: 'best' };
    if (v === 'audio') return { kind: 'audio' };
    const m = /^h(\d+)$/.exec(v);
    return m ? { kind: 'height', height: parseInt(m[1], 10) } : { kind: 'best' };
  }

  // heights: the resolutions actually listed by the manifest (may be empty for
  // page-level sites, where the standard ladder is offered and yt-dlp picks
  // the best format at or below the chosen height).
  function options(heights) {
    const hs = [...new Set((heights || []).filter((h) => h > 0))].sort((a, b) => b - a);
    const list = hs.length ? hs : LADDER;
    const out = [{ value: 'best', label: hs.length ? `Best (${hs[0]}p)` : 'Best available' }];
    for (const h of list) out.push({ value: 'h' + h, label: h >= 2160 ? `${h}p 4K` : h >= 1080 ? `${h}p HD` : `${h}p` });
    out.push({ value: 'audio', label: 'Audio only (m4a)' });
    return out;
  }

  // Remember the last choice so the next video defaults to it.
  const KEY = 'defaultQuality';
  function remember(value) { try { chrome.storage.local.set({ [KEY]: value }); } catch {} }
  function recall() {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(KEY, (r) => resolve((r && r[KEY]) || 'best')); }
      catch { resolve('best'); }
    });
  }

  // Pick the stored default if this video offers it, else the closest lower
  // height, else Best.
  function pick(stored, opts) {
    if (opts.some((o) => o.value === stored)) return stored;
    const want = parse(stored);
    if (want.kind === 'height') {
      const lower = opts.map((o) => parse(o.value)).filter((q) => q.kind === 'height' && q.height <= want.height)
        .sort((a, b) => b.height - a.height)[0];
      if (lower) return encode(lower);
    }
    return 'best';
  }

  root.SG_QUALITY = { encode, parse, options, remember, recall, pick };
})(typeof window !== 'undefined' ? window : globalThis);
