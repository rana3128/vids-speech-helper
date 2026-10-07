// Pure parsing helpers shared by popup.js and content.js (and unit-testable in node).
globalThis.VAParse = (() => {
  const MAX_SPEECH = 800;

  // "01:17.0" | "1:02:03.4" | "77.5" -> seconds
  function parseClock(s) {
    if (s == null) return null;
    const parts = String(s).trim().split(':');
    if (!parts.length || parts.some((p) => p === '' || isNaN(Number(p)))) return null;
    return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
  }

  // "01:17.0/08:06.4" -> { current: 77, total: 486.4 }
  function parseTimer(text) {
    if (!text) return null;
    const [cur, tot] = String(text).split('/');
    const current = parseClock(cur);
    if (current == null) return null;
    return { current, total: tot != null ? parseClock(tot) : null };
  }

  function fmt(sec) {
    if (sec == null || isNaN(sec)) return '?';
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  }

  function validate(video) {
    const errors = [];
    const warnings = [];
    if (!video || !Array.isArray(video.scenes) || !video.scenes.length) {
      errors.push('No scenes found.');
      return { errors, warnings };
    }
    video.scenes.forEach((sc, i) => {
      if (typeof sc.start !== 'number' || isNaN(sc.start)) errors.push(`Scene ${i + 1}: "start" is not a number.`);
      if (typeof sc.speech !== 'string') errors.push(`Scene ${i + 1}: "speech" is not a string.`);
      else if (sc.speech.length > MAX_SPEECH) warnings.push(`Scene ${i + 1}: speech is ${sc.speech.length} chars (> ${MAX_SPEECH}).`);
      if (i > 0 && sc.start <= video.scenes[i - 1].start) errors.push(`Scene ${i + 1}: start ${sc.start} is not after scene ${i}'s start ${video.scenes[i - 1].start}.`);
    });
    if (video.scenes[0] && video.scenes[0].start !== 0) errors.push('The first scene must start at 0.');
    if (video.duration != null && video.scenes.at(-1).start >= video.duration) {
      errors.push(`Last scene start (${video.scenes.at(-1).start}) is not before duration (${video.duration}).`);
    }
    return { errors, warnings };
  }

  function parseJSON(text) {
    const raw = JSON.parse(text);
    return {
      title: raw.title || '',
      duration: typeof raw.duration === 'number' ? raw.duration : null,
      voice: raw.voice || 'Holt',
      scenes: (raw.scenes || []).map((s) => ({ start: Number(s.start), speech: String(s.speech ?? ''), title: s.title || '' }))
    };
  }

  // Legacy: "===== SCENE n — title (starts m:ss.ss) =====" followed by text.
  const HEADER_RE = /^=+\s*SCENE\s+(\d+)\s*[—–-]\s*(.*?)\s*\(starts\s+([\d:.]+)\)\s*=+\s*$/gim;

  function parseTxt(text) {
    const headers = [];
    let m;
    HEADER_RE.lastIndex = 0;
    while ((m = HEADER_RE.exec(text))) {
      headers.push({ n: Number(m[1]), title: m[2], start: parseClock(m[3]), from: m.index, bodyFrom: m.index + m[0].length });
    }
    const scenes = headers.map((h, i) => ({
      start: h.start,
      title: h.title,
      speech: text.slice(h.bodyFrom, i + 1 < headers.length ? headers[i + 1].from : text.length).trim()
    }));
    return { title: '', duration: null, voice: 'Holt', scenes };
  }

  function parseFile(name, text) {
    const trimmed = text.trim();
    if (/\.json$/i.test(name) || trimmed.startsWith('{')) return parseJSON(trimmed);
    return parseTxt(text);
  }

  function summary(video) {
    const longest = video.scenes.reduce((a, s) => Math.max(a, s.speech.length), 0);
    return { scenes: video.scenes.length, duration: video.duration, longest };
  }

  return { MAX_SPEECH, parseClock, parseTimer, fmt, validate, parseJSON, parseTxt, parseFile, summary };
})();

if (typeof module !== 'undefined') module.exports = globalThis.VAParse;
