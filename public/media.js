// Question media (picture, video or sound fragment) given as links. Shared by the server, which stores only what
// cleanMedia() accepts, and the page, which uses the same rules to show a preview in the builder.
(function (root) {
  const TYPES = ['image', 'video', 'audio'];
  const MAX_SECONDS = 6 * 60 * 60;

  // "90", "1:30" or "1:02:03" -> seconds. Empty or invalid -> null.
  function parseTime(v) {
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), MAX_SECONDS) : null;
    if (typeof v !== 'string' || !v.trim()) return null;
    const parts = v.trim().split(':');
    if (parts.length > 3 || parts.some(p => !/^\d+$/.test(p))) return null;
    const secs = parts.reduce((acc, p) => acc * 60 + Number(p), 0);
    return Math.min(secs, MAX_SECONDS);
  }

  // 83 -> "1:23"
  function formatTime(s) {
    if (s == null) return '';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = n => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  function parseUrl(s) {
    try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u : null; } catch { return null; }
  }

  // YouTube video id from watch, youtu.be, shorts, embed and live links; plus a start time from t= if present.
  function youTube(url) {
    const u = parseUrl(url);
    if (!u) return null;
    const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      id = u.searchParams.get('v');
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
      if (!id && m) id = m[1];
    }
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    const t = u.searchParams.get('t') || u.searchParams.get('start');
    let start = null;
    if (t) {
      const hms = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
      if (hms && (hms[1] || hms[2] || hms[3])) start = (+hms[1] || 0) * 3600 + (+hms[2] || 0) * 60 + (+hms[3] || 0);
    }
    return { id, start };
  }

  const isAudioFile = url => /\.(mp3|ogg|oga|wav|m4a|aac|opus|flac)(\?|#|$)/i.test(url);
  const isVideoFile = url => /\.(mp4|webm|ogv|mov|m4v)(\?|#|$)/i.test(url);

  // Returns {type, url, start?, end?} or null when there is no usable media. Never throws.
  function cleanMedia(m) {
    if (!m || typeof m !== 'object' || !TYPES.includes(m.type)) return null;
    const url = typeof m.url === 'string' ? m.url.trim().slice(0, 600) : '';
    if (!parseUrl(url)) return null;
    if (m.type === 'image') return { type: 'image', url };
    const yt = youTube(url);
    if (!yt && !(m.type === 'audio' ? isAudioFile(url) || isVideoFile(url) : isVideoFile(url))) return null;
    let start = parseTime(m.start);
    if (start == null && yt && yt.start != null) start = yt.start;
    let end = parseTime(m.end);
    if (end != null && start != null && end <= start) end = null;
    const out = { type: m.type, url };
    if (start) out.start = start;
    if (end) out.end = end;
    return out;
  }

  const api = { TYPES, parseTime, formatTime, youTube, cleanMedia, isAudioFile, isVideoFile };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Media = api;
})(this);
